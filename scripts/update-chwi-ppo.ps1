#Requires -Version 5.1
[CmdletBinding()]
param(
  [switch]$Auto,
  [switch]$Force,
  [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$updateRoot = Join-Path $projectRoot ".updates"
$statePath = Join-Path $updateRoot "state.json"
$logPath = Join-Path $updateRoot "update.log"
$lockPath = Join-Path $updateRoot "update.lock"
$installedManifestPath = Join-Path $updateRoot "installed-manifest.json"
$repoSlug = "choconyam/chwi-ppo"
$releaseApi = "https://api.github.com/repos/$repoSlug/releases/latest"
$checkIntervalHours = 24
$lockStream = $null

New-Item -ItemType Directory -Path $updateRoot -Force | Out-Null

function Write-UpdateLog {
  param([string]$Message)
  $line = "{0} {1}" -f ([DateTimeOffset]::Now.ToString("o")), $Message
  Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
}

function Save-UpdateState {
  param(
    [string]$Status,
    [string]$CurrentVersion,
    [string]$LatestVersion,
    [string]$Message
  )

  $state = [ordered]@{
    lastCheckedAt = [DateTimeOffset]::Now.ToString("o")
    lastStatus = $Status
    currentVersion = $CurrentVersion
    latestVersion = $LatestVersion
    message = $Message
  }
  $json = $state | ConvertTo-Json -Depth 4
  [IO.File]::WriteAllText($statePath, $json + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
}

function Get-InstalledVersion {
  $versionPath = Join-Path $projectRoot "VERSION"
  if (-not (Test-Path -LiteralPath $versionPath)) {
    return [version]"0.0.0"
  }

  $text = (Get-Content -LiteralPath $versionPath -Raw).Trim().TrimStart("v")
  try {
    return [version]$text
  }
  catch {
    throw "Invalid VERSION value: $text"
  }
}

function Test-AutoCheckDue {
  if (-not $Auto -or $Force -or -not (Test-Path -LiteralPath $statePath)) {
    return $true
  }

  try {
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    $lastChecked = [DateTimeOffset]::Parse([string]$state.lastCheckedAt)
    return (([DateTimeOffset]::Now - $lastChecked).TotalHours -ge $checkIntervalHours)
  }
  catch {
    return $true
  }
}

function Get-SafePath {
  param(
    [string]$BasePath,
    [string]$RelativePath
  )

  $normalized = $RelativePath.Replace("/", [IO.Path]::DirectorySeparatorChar)
  if ([IO.Path]::IsPathRooted($normalized)) {
    throw "Absolute paths are not allowed in the release manifest: $RelativePath"
  }

  $baseFull = [IO.Path]::GetFullPath($BasePath).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  $candidate = [IO.Path]::GetFullPath((Join-Path $BasePath $normalized))
  if (-not $candidate.StartsWith($baseFull, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Path escapes the update root: $RelativePath"
  }
  return $candidate
}

function Test-ManagedPath {
  param([string]$RelativePath)

  $path = $RelativePath.Replace("\", "/")
  if ($path.StartsWith("./", [StringComparison]::Ordinal)) {
    $path = $path.Substring(2)
  }
  $exactPaths = @(
    ".gitignore",
    ".codex/config.toml",
    "AGENTS.md",
    "CLAUDE.md",
    "README.md",
    "package.json",
    "run-dashboard.cmd",
    "run-dashboard-dev.cmd",
    "update-chwi-ppo.cmd",
    "update-chwippo.cmd",
    "update-donbeolja.cmd",
    "VERSION",
    "data/opportunities.example.json",
    "profile/README.md",
    "profile/PROFILE_TEMPLATE.md",
    "profile/experiences/_EXPERIENCE_TEMPLATE.md",
    "state/README.md",
    "companies/README.md"
  )
  if ($exactPaths -contains $path) {
    return $true
  }

  $prefixes = @(
    ".agents/",
    ".claude/",
    ".codex/agents/",
    "dashboard/",
    "docs/",
    "schemas/",
    "scripts/"
  )
  foreach ($prefix in $prefixes) {
    if ($path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
      return $true
    }
  }
  if ($path.StartsWith("companies/_", [StringComparison]::OrdinalIgnoreCase)) {
    return $true
  }
  return $false
}

function Test-PreserveExisting {
  param([string]$RelativePath)
  $path = $RelativePath.Replace("\", "/")
  return ($path -eq ".gitignore" -or $path -eq ".codex/config.toml")
}

function Get-ReleaseMetadata {
  $headers = @{
    "Accept" = "application/vnd.github+json"
    "User-Agent" = "Chwi-ppo-Updater"
    "X-GitHub-Api-Version" = "2022-11-28"
  }
  return Invoke-RestMethod -Uri $releaseApi -Headers $headers -Method Get -UseBasicParsing
}

function Test-IsChwiPpoClone {
  $gitCommand = Get-Command git -ErrorAction SilentlyContinue
  if ($null -eq $gitCommand -or -not (Test-Path -LiteralPath (Join-Path $projectRoot ".git"))) {
    return $false
  }

  $origin = (& git -C $projectRoot remote get-url origin 2>$null | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) {
    return $false
  }
  return ($origin -match "github\.com[:/]choconyam/(?:chwi-ppo|chwippo|donbeolja)(?:\.git)?/?$")
}

function Update-GitClone {
  param([version]$LatestVersion)

  $dirty = (& git -C $projectRoot status --porcelain --untracked-files=no 2>$null | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) {
    throw "Could not inspect the Git working tree."
  }
  if (-not [string]::IsNullOrWhiteSpace($dirty)) {
    throw "Tracked files have local changes. Commit or restore them before updating."
  }

  Write-Host "[Chwi-ppo] Updating the Git clone with fast-forward only..."
  & git -C $projectRoot pull --ff-only
  if ($LASTEXITCODE -ne 0) {
    throw "git pull --ff-only failed."
  }

  $updatedVersion = Get-InstalledVersion
  if ($updatedVersion -lt $LatestVersion) {
    throw "Git update completed, but VERSION is still older than the latest release."
  }
  return $updatedVersion
}

function Get-AssetDigest {
  param($Asset)

  if (-not ($Asset.PSObject.Properties.Name -contains "digest")) {
    throw "The GitHub release asset does not provide a SHA-256 digest."
  }
  $digest = [string]$Asset.digest
  if ($digest -notmatch "^sha256:([0-9a-fA-F]{64})$") {
    throw "The GitHub release asset has an invalid SHA-256 digest."
  }
  return $Matches[1].ToLowerInvariant()
}

function Restore-Backup {
  param(
    [string]$BackupRoot,
    [System.Collections.Generic.List[string]]$CreatedFiles
  )

  foreach ($created in $CreatedFiles) {
    if (Test-Path -LiteralPath $created -PathType Leaf) {
      Remove-Item -LiteralPath $created -Force
    }
  }

  if (Test-Path -LiteralPath $BackupRoot) {
    Get-ChildItem -LiteralPath $BackupRoot -File -Recurse | ForEach-Object {
      $relative = $_.FullName.Substring($BackupRoot.TrimEnd("\").Length).TrimStart("\")
      $target = Get-SafePath -BasePath $projectRoot -RelativePath $relative
      New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
      Copy-Item -LiteralPath $_.FullName -Destination $target -Force
    }
  }
}

function Update-ReleaseInstall {
  param(
    $Release,
    [version]$LatestVersion
  )

  $expectedName = "chwi-ppo-v$($LatestVersion.ToString())-release.zip"
  $asset = @($Release.assets) | Where-Object { [string]$_.name -eq $expectedName } | Select-Object -First 1
  if ($null -eq $asset) {
    $asset = @($Release.assets) | Where-Object { [string]$_.name -match "^(?:chwi-ppo|chwippo|donbeolja)-v.+-release\.zip$" } | Select-Object -First 1
  }
  if ($null -eq $asset) {
    throw "No Chwi-ppo release ZIP was found for v$LatestVersion."
  }

  $expectedDigest = Get-AssetDigest -Asset $asset
  $tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("chwi-ppo-update-" + [guid]::NewGuid().ToString("N"))
  $zipPath = Join-Path $tempRoot "release.zip"
  $extractRoot = Join-Path $tempRoot "extracted"
  $backupRoot = Join-Path $updateRoot ("backups\{0}-v{1}-to-v{2}" -f (Get-Date -Format "yyyyMMdd-HHmmss"), (Get-InstalledVersion), $LatestVersion)
  $createdFiles = New-Object "System.Collections.Generic.List[string]"
  $backupCreated = $false

  try {
    New-Item -ItemType Directory -Path $extractRoot -Force | Out-Null
    Write-Host "[Chwi-ppo] Downloading $($asset.name)..."
    Invoke-WebRequest -Uri ([string]$asset.browser_download_url) -Headers @{ "User-Agent" = "Chwi-ppo-Updater" } -OutFile $zipPath -UseBasicParsing

    $actualDigest = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualDigest -ne $expectedDigest) {
      throw "Release ZIP SHA-256 verification failed."
    }

    Expand-Archive -LiteralPath $zipPath -DestinationPath $extractRoot -Force
    $manifestFiles = @(Get-ChildItem -LiteralPath $extractRoot -Filter "release-manifest.json" -File -Recurse)
    if ($manifestFiles.Count -ne 1) {
      throw "The release must contain exactly one release-manifest.json."
    }

    $releaseRoot = Split-Path -Parent $manifestFiles[0].FullName
    $manifest = Get-Content -LiteralPath $manifestFiles[0].FullName -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([version]([string]$manifest.version).TrimStart("v") -ne $LatestVersion) {
      throw "Release manifest version does not match the GitHub release."
    }

    $newPaths = New-Object "System.Collections.Generic.HashSet[string]" ([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in @($manifest.files)) {
      $relative = ([string]$entry.path).Replace("\", "/")
      if (-not (Test-ManagedPath -RelativePath $relative)) {
        throw "Release manifest contains an unmanaged path: $relative"
      }
      [void]$newPaths.Add($relative)
      $source = Get-SafePath -BasePath $releaseRoot -RelativePath $relative
      if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Release file is missing: $relative"
      }
      $fileDigest = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($fileDigest -ne ([string]$entry.sha256).ToLowerInvariant()) {
        throw "Release file hash verification failed: $relative"
      }
    }

    $oldPaths = @()
    $previousManifestPath = $installedManifestPath
    if (-not (Test-Path -LiteralPath $previousManifestPath)) {
      $previousManifestPath = Join-Path $projectRoot "release-manifest.json"
    }
    if (Test-Path -LiteralPath $previousManifestPath) {
      try {
        $oldManifest = Get-Content -LiteralPath $previousManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $oldPaths = @($oldManifest.files | ForEach-Object { ([string]$_.path).Replace("\", "/") })
      }
      catch {
        Write-UpdateLog "Installed manifest could not be read; obsolete files will not be removed."
      }
    }

    foreach ($relative in $oldPaths) {
      if ($newPaths.Contains($relative) -or -not (Test-ManagedPath -RelativePath $relative) -or (Test-PreserveExisting -RelativePath $relative)) {
        continue
      }
      $target = Get-SafePath -BasePath $projectRoot -RelativePath $relative
      if (Test-Path -LiteralPath $target -PathType Leaf) {
        $backup = Get-SafePath -BasePath $backupRoot -RelativePath $relative
        New-Item -ItemType Directory -Path (Split-Path -Parent $backup) -Force | Out-Null
        Copy-Item -LiteralPath $target -Destination $backup -Force
        $backupCreated = $true
        Remove-Item -LiteralPath $target -Force
      }
    }

    foreach ($entry in @($manifest.files)) {
      $relative = ([string]$entry.path).Replace("\", "/")
      $source = Get-SafePath -BasePath $releaseRoot -RelativePath $relative
      $target = Get-SafePath -BasePath $projectRoot -RelativePath $relative
      if ((Test-PreserveExisting -RelativePath $relative) -and (Test-Path -LiteralPath $target)) {
        continue
      }

      if (Test-Path -LiteralPath $target -PathType Leaf) {
        $backup = Get-SafePath -BasePath $backupRoot -RelativePath $relative
        New-Item -ItemType Directory -Path (Split-Path -Parent $backup) -Force | Out-Null
        Copy-Item -LiteralPath $target -Destination $backup -Force
        $backupCreated = $true
      }
      else {
        $createdFiles.Add($target)
      }

      New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
      $temporaryTarget = "$target.update-$PID"
      Copy-Item -LiteralPath $source -Destination $temporaryTarget -Force
      Move-Item -LiteralPath $temporaryTarget -Destination $target -Force
    }

    Copy-Item -LiteralPath $manifestFiles[0].FullName -Destination $installedManifestPath -Force
    Copy-Item -LiteralPath $manifestFiles[0].FullName -Destination (Join-Path $projectRoot "release-manifest.json") -Force
    if (-not $backupCreated -and (Test-Path -LiteralPath $backupRoot)) {
      Remove-Item -LiteralPath $backupRoot -Recurse -Force
    }
  }
  catch {
    Restore-Backup -BackupRoot $backupRoot -CreatedFiles $createdFiles
    throw
  }
  finally {
    if (Test-Path -LiteralPath $tempRoot) {
      $systemTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
      $resolvedTemp = [IO.Path]::GetFullPath($tempRoot)
      if ($resolvedTemp.StartsWith($systemTemp, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
      }
    }
  }

  return Get-InstalledVersion
}

if (-not (Test-AutoCheckDue)) {
  Write-Output "[Chwi-ppo] Update check skipped; checked within the last $checkIntervalHours hours."
  exit 0
}

try {
  $lockStream = [IO.File]::Open($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
}
catch {
  if ($Auto) {
    Write-Output "[Chwi-ppo] Another update check is already running."
    exit 0
  }
  Write-Error "Another Chwi-ppo update is already running."
  exit 1
}

try {
  $currentVersion = Get-InstalledVersion
  Write-Output "[Chwi-ppo] Current version: v$currentVersion"
  $release = Get-ReleaseMetadata
  $latestVersion = [version](([string]$release.tag_name).Trim().TrimStart("v"))
  Write-Output "[Chwi-ppo] Latest version: v$latestVersion"

  if ($latestVersion -le $currentVersion) {
    $message = "Already up to date."
    Save-UpdateState -Status "up-to-date" -CurrentVersion $currentVersion.ToString() -LatestVersion $latestVersion.ToString() -Message $message
    Write-UpdateLog $message
    Write-Output "[Chwi-ppo] $message"
    exit 0
  }

  if ($CheckOnly) {
    $message = "Update available: v$currentVersion -> v$latestVersion"
    Save-UpdateState -Status "available" -CurrentVersion $currentVersion.ToString() -LatestVersion $latestVersion.ToString() -Message $message
    Write-UpdateLog $message
    Write-Output "[Chwi-ppo] $message"
    exit 0
  }

  if (Test-IsChwiPpoClone) {
    $updatedVersion = Update-GitClone -LatestVersion $latestVersion
    $method = "git fast-forward"
  }
  else {
    $updatedVersion = Update-ReleaseInstall -Release $release -LatestVersion $latestVersion
    $method = "verified release ZIP"
  }

  $message = "Updated to v$updatedVersion using $method. Personal profile, company files, opportunity data, and application state were not replaced."
  Save-UpdateState -Status "updated" -CurrentVersion $updatedVersion.ToString() -LatestVersion $latestVersion.ToString() -Message $message
  Write-UpdateLog $message
  Write-Output "[Chwi-ppo] $message"
}
catch {
  $installed = Get-InstalledVersion
  $message = $_.Exception.Message
  Save-UpdateState -Status "failed" -CurrentVersion $installed.ToString() -LatestVersion "" -Message $message
  Write-UpdateLog "Update failed: $message"
  Write-UpdateLog ("Stack: " + $_.ScriptStackTrace)
  if ($Auto) {
    Write-Warning "[Chwi-ppo] Update check failed; dashboard startup will continue. $message"
    exit 0
  }
  Write-Error "[Chwi-ppo] Update failed. $message"
  exit 1
}
finally {
  if ($null -ne $lockStream) {
    $lockStream.Dispose()
  }
  if (Test-Path -LiteralPath $lockPath) {
    Remove-Item -LiteralPath $lockPath -Force
  }
}
