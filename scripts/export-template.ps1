param(
  [string]$Destination = ""
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot

if ([string]::IsNullOrWhiteSpace($Destination)) {
  $version = (Get-Content -LiteralPath (Join-Path $projectRoot "VERSION") -Raw).Trim()
  $Destination = Join-Path (Split-Path -Parent $projectRoot) "chwi-ppo-v$version-release.zip"
}

$destinationPath = [System.IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $destinationPath) {
  throw "기존 파일을 덮어쓰지 않습니다: $destinationPath"
}

& node (Join-Path $PSScriptRoot "scan-sensitive-data.mjs")
if ($LASTEXITCODE -ne 0) {
  throw "민감정보 검사에 실패해 내보내기를 중단했습니다."
}

$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$stageRoot = Join-Path $tempRoot ("jop-template-export-" + [guid]::NewGuid().ToString("N"))
$stageProject = Join-Path $stageRoot "chwi-ppo"

function Copy-PublicItem {
  param([string]$RelativePath)

  $source = Join-Path $projectRoot $RelativePath
  if (-not (Test-Path -LiteralPath $source)) {
    throw "공개 파일이 없습니다: $RelativePath"
  }
  $parent = Split-Path -Parent (Join-Path $stageProject $RelativePath)
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
  Copy-Item -LiteralPath $source -Destination (Join-Path $stageProject $RelativePath) -Recurse
}

try {
  New-Item -ItemType Directory -Path $stageProject -Force | Out-Null

  @(
    ".gitignore",
    "AGENTS.md",
    "CLAUDE.md",
    "README.md",
    "LICENSE.md",
    "LICENSE_KO.md",
    "NOTICE.md",
    "assets",
    "VERSION",
    "package.json",
    "package-lock.json",
    "bin",
    "run-dashboard.cmd",
    "run-dashboard-dev.cmd",
    "update-chwi-ppo.cmd",
    ".agents",
    ".claude",
    ".codex",
    "docs",
    "schemas",
    "scripts",
    "data/opportunities.example.json",
    "data/discovery-snapshot.example.json",
    "data/search-criteria.example.json",
    "profile/README.md",
    "profile/PROFILE_TEMPLATE.md",
    "profile/experiences/_EXPERIENCE_TEMPLATE.md",
    "state/README.md",
    "companies/README.md",
    "companies/_템플릿",
    "dashboard/index.html",
    "dashboard/package.json",
    "dashboard/package-lock.json",
    "dashboard/tsconfig.json",
    "dashboard/vite.config.ts",
    "dashboard/standalone-shell.html",
    "dashboard/src"
  ) | ForEach-Object { Copy-PublicItem $_ }

  $releaseVersion = (Get-Content -LiteralPath (Join-Path $stageProject "VERSION") -Raw).Trim()
  $manifestFiles = Get-ChildItem -LiteralPath $stageProject -File -Recurse | Sort-Object FullName
  $manifestEntries = @($manifestFiles | ForEach-Object {
    $relative = $_.FullName.Substring($stageProject.TrimEnd("\").Length).TrimStart("\").Replace("\", "/")
    [ordered]@{
      path = $relative
      sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  })
  $manifest = [ordered]@{
    schemaVersion = 1
    version = $releaseVersion
    files = $manifestEntries
  }
  $manifestJson = $manifest | ConvertTo-Json -Depth 5
  [IO.File]::WriteAllText(
    (Join-Path $stageProject "release-manifest.json"),
    $manifestJson + [Environment]::NewLine,
    (New-Object Text.UTF8Encoding($false))
  )

  Compress-Archive -LiteralPath $stageProject -DestinationPath $destinationPath -CompressionLevel Optimal
  $archive = Get-Item -LiteralPath $destinationPath
  Write-Output "공개용 ZIP 생성: $($archive.FullName)"
  Write-Output "크기: $($archive.Length) bytes"
}
finally {
  if (Test-Path -LiteralPath $stageRoot) {
    $resolvedStage = [System.IO.Path]::GetFullPath($stageRoot)
    if (-not $resolvedStage.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "임시 경로가 시스템 임시 폴더 밖이라 삭제하지 않습니다: $resolvedStage"
    }
    Remove-Item -LiteralPath $resolvedStage -Recurse -Force
  }
}
