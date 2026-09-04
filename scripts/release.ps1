#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$Version = "",
  [string]$Notes = "",
  [switch]$DryRun
)

# 새 릴리스를 한 번에 만든다.
#   1) 작업 트리·브랜치·gh 로그인 확인
#   2) 민감정보·스킬·에이전트·예시 데이터 검사
#   3) VERSION, package.json, dashboard/package.json, package-lock, README 배지 갱신
#   4) 커밋 → main 푸시
#   5) export-template.ps1로 릴리스 ZIP 생성
#   6) gh release create (태그 + ZIP 자산)
# -DryRun: 3)과 5)까지 해 보고 파일을 되돌린다. 커밋·푸시·릴리스는 하지 않는다.

$ErrorActionPreference = "Stop"
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$repoSlug = "choconyam/chwi-ppo"

function Fail {
  param([string]$Message)
  Write-Error "[release] $Message"
  exit 1
}

# Windows PowerShell 5.1은 $ErrorActionPreference = Stop 상태에서 외부 명령의 stderr를 리디렉션하면
# 경고 한 줄에도 스크립트를 멈춘다. 외부 명령은 이 함수로 감싸 exit code만 본다.
function Invoke-Native {
  param(
    [string]$Exe,
    [string[]]$Arguments
  )
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $lines = @(& $Exe @Arguments 2>&1 | ForEach-Object { "$_" })
    $script:LastNativeExit = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previous
  }
  return $lines
}

function Invoke-Git {
  param([string[]]$GitArgs)
  $output = Invoke-Native "git" (@("-C", $projectRoot) + $GitArgs)
  if ($script:LastNativeExit -ne 0) {
    Fail ("git " + ($GitArgs -join " ") + " 실패`n" + ($output -join "`n"))
  }
  return ($output -join "`n").Trim()
}

function Invoke-Node {
  param([string[]]$NodeArgs)
  $output = Invoke-Native "node" $NodeArgs
  $output | ForEach-Object { Write-Host $_ }
  if ($script:LastNativeExit -ne 0) {
    Fail ("node " + ($NodeArgs -join " ") + " 실패")
  }
}

# ---- 0. 도구 확인 -----------------------------------------------------------
foreach ($tool in @("git", "node", "gh")) {
  if ($null -eq (Get-Command $tool -ErrorAction SilentlyContinue)) {
    Fail "$tool 을(를) 찾을 수 없습니다. 설치 후 다시 실행하세요."
  }
}
Invoke-Native "gh" @("auth", "status") | Out-Null
if ($script:LastNativeExit -ne 0) {
  Fail "gh 로그인이 필요합니다. 'gh auth login'을 먼저 실행하세요."
}

# ---- 1. 버전 입력 -----------------------------------------------------------
$currentVersion = (Get-Content -LiteralPath (Join-Path $projectRoot "VERSION") -Raw).Trim().TrimStart("v")
if ([string]::IsNullOrWhiteSpace($Version)) {
  $Version = Read-Host "새 버전 (현재 v$currentVersion, 예: 1.0.1)"
}
$Version = $Version.Trim().TrimStart("v")
if ($Version -notmatch "^\d+\.\d+\.\d+$") {
  Fail "버전 형식이 잘못됐습니다: $Version (예: 1.0.1)"
}
$tag = "v$Version"

# ---- 2. 저장소 상태 확인 ------------------------------------------------------
$branch = Invoke-Git @("rev-parse", "--abbrev-ref", "HEAD")
if ($branch -ne "main") {
  Fail "main 브랜치에서만 릴리스합니다. 현재: $branch"
}
$dirty = Invoke-Git @("status", "--porcelain", "--untracked-files=no")
if (-not [string]::IsNullOrWhiteSpace($dirty)) {
  Fail "커밋되지 않은 변경이 있습니다. 먼저 커밋하거나 되돌리세요.`n$dirty"
}
Invoke-Git @("fetch", "--quiet", "--tags", "origin") | Out-Null
$behind = Invoke-Git @("rev-list", "--count", "HEAD..origin/main")
if ($behind -ne "0") {
  Fail "origin/main이 로컬보다 앞서 있습니다. 'git pull --ff-only' 후 다시 실행하세요."
}
$existingTag = Invoke-Git @("tag", "--list", $tag)
if (-not [string]::IsNullOrWhiteSpace($existingTag)) {
  Fail "태그 $tag 이(가) 이미 있습니다."
}
Invoke-Native "gh" @("release", "view", $tag, "-R", $repoSlug) | Out-Null
if ($script:LastNativeExit -eq 0) {
  Fail "릴리스 $tag 이(가) GitHub에 이미 있습니다."
}

# ---- 3. 검사 --------------------------------------------------------------
Write-Host "[release] 검사 실행..."
Invoke-Node @((Join-Path $projectRoot "scripts\scan-sensitive-data.mjs"))
Invoke-Node @((Join-Path $projectRoot "scripts\check-skill-sync.mjs"))
Invoke-Node @((Join-Path $projectRoot "scripts\check-agent-sync.mjs"))
Invoke-Node @((Join-Path $projectRoot "scripts\validate-opportunities.mjs"), (Join-Path $projectRoot "data\opportunities.example.json"))

# ---- 4. 버전 갱신 -----------------------------------------------------------
Write-Host "[release] 버전 갱신 v$currentVersion → $tag"
Invoke-Node @((Join-Path $projectRoot "scripts\bump-version.mjs"), $Version)

if ($DryRun) {
  Write-Host "[release] DryRun: ZIP만 만들어 보고 변경을 되돌립니다."
}

# ---- 5. 릴리스 ZIP -----------------------------------------------------------
$zipDir = Join-Path ([IO.Path]::GetTempPath()) ("chwi-ppo-release-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $zipDir -Force | Out-Null
$zipPath = Join-Path $zipDir "chwi-ppo-$tag-release.zip"

try {
  $exportOutput = Invoke-Native "powershell.exe" @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $projectRoot "scripts\export-template.ps1"), "-Destination", $zipPath)
  $exportOutput | ForEach-Object { Write-Host $_ }
  if ($script:LastNativeExit -ne 0 -or -not (Test-Path -LiteralPath $zipPath)) {
    if ($DryRun) { Invoke-Git @("checkout", "--", ".") | Out-Null }
    Fail "릴리스 ZIP 생성에 실패했습니다."
  }
  $zipHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
  Write-Host "[release] SHA-256: $zipHash"

  if ($DryRun) {
    Invoke-Git @("checkout", "--", ".") | Out-Null
    Write-Host "[release] DryRun 완료. 파일을 되돌렸고 커밋·푸시·릴리스는 하지 않았습니다."
    exit 0
  }

  # ---- 6. 커밋·푸시 ---------------------------------------------------------
  Invoke-Git @("add", "VERSION", "package.json", "dashboard/package.json", "dashboard/package-lock.json", "README.md") | Out-Null
  Invoke-Git @("commit", "--quiet", "-m", "release: $tag") | Out-Null
  Invoke-Git @("push", "origin", "main") | Out-Null
  Write-Host "[release] main 푸시 완료"

  # ---- 7. GitHub 릴리스 -------------------------------------------------------
  if ([string]::IsNullOrWhiteSpace($Notes)) {
    $previousTag = ""
    $described = Invoke-Native "git" @("-C", $projectRoot, "describe", "--tags", "--abbrev=0", "HEAD^")
    if ($script:LastNativeExit -eq 0) { $previousTag = ($described -join "").Trim() }
    $log = ""
    if (-not [string]::IsNullOrWhiteSpace($previousTag)) {
      $log = (Invoke-Native "git" @("-C", $projectRoot, "log", "--pretty=format:- %s", "$previousTag..HEAD^") -join "`n").Trim()
    }
    $Notes = "chwi-ppo $tag"
    if (-not [string]::IsNullOrWhiteSpace($log)) {
      $Notes += "`n`n변경 사항`n`n$log"
    }
    $Notes += "`n`n첨부된 ZIP을 받아 압축을 풀고 AGENTS.md가 있는 폴더를 Codex 또는 Claude Code에서 엽니다. 이미 쓰고 있다면 run-dashboard.cmd 실행 시 자동으로 갱신됩니다."
  }
  $notesPath = Join-Path $zipDir "notes.md"
  [IO.File]::WriteAllText($notesPath, $Notes + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))

  $createOutput = Invoke-Native "gh" @("release", "create", $tag, $zipPath, "-R", $repoSlug, "--target", "main", "--title", "chwi-ppo $tag", "--notes-file", $notesPath, "--latest")
  $createOutput | ForEach-Object { Write-Host $_ }
  if ($script:LastNativeExit -ne 0) {
    Fail "gh release create 실패. 커밋과 푸시는 이미 반영됐으므로 릴리스만 다시 만드세요."
  }

  # ---- 8. 검증 --------------------------------------------------------------
  $asset = (Invoke-Native "gh" @("release", "view", $tag, "-R", $repoSlug, "--json", "assets", "--jq", '.assets[0] | .name + " " + .digest')) -join ""
  Write-Host "[release] 자산: $asset"
  if ($asset -notmatch "sha256:$zipHash") {
    Write-Warning "[release] GitHub이 보고한 digest가 로컬 SHA-256과 다릅니다. 릴리스 페이지를 확인하세요."
  }
  Invoke-Git @("fetch", "--quiet", "--tags", "origin") | Out-Null
  Write-Host "[release] 완료: https://github.com/$repoSlug/releases/tag/$tag"
}
finally {
  if (Test-Path -LiteralPath $zipDir) {
    Remove-Item -LiteralPath $zipDir -Recurse -Force
  }
}
