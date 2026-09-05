param(
  [string]$InputFile = "",
  [string]$OutputFile = ""
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot

if ([string]::IsNullOrWhiteSpace($InputFile)) {
  $actual = Join-Path $projectRoot "data/opportunities.json"
  $sample = Join-Path $projectRoot "data/opportunities.example.json"
  $InputFile = if (Test-Path -LiteralPath $actual) { $actual } else { $sample }
}

if ([string]::IsNullOrWhiteSpace($OutputFile)) {
  $OutputFile = Join-Path $projectRoot "career-dashboard.html"
}

$inputPath = [System.IO.Path]::GetFullPath($InputFile)
$outputPath = [System.IO.Path]::GetFullPath($OutputFile)
$shellPath = Join-Path $projectRoot "dashboard/standalone-shell.html"

if (-not (Test-Path -LiteralPath $shellPath)) {
  throw "Standalone shell is missing. A maintainer must run the dashboard build once."
}

$json = [System.IO.File]::ReadAllText($inputPath, [System.Text.Encoding]::UTF8)
$null = $json | ConvertFrom-Json
$safeJson = $json.Replace("</script", "<\/script")
$shell = [System.IO.File]::ReadAllText($shellPath, [System.Text.Encoding]::UTF8)
$pattern = '(?s)(<script[^>]*id="opportunity-data"[^>]*>).*?(</script>)'
$matchCount = [regex]::Matches($shell, $pattern).Count

if ($matchCount -ne 1) {
  throw "Expected one opportunity-data block; found $matchCount."
}

$result = [regex]::Replace(
  $shell,
  $pattern,
  { param($match) $match.Groups[1].Value + $safeJson + $match.Groups[2].Value },
  1
)

$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($outputPath)) | Out-Null
[System.IO.File]::WriteAllText($outputPath, $result, $utf8)
Write-Output "Dashboard generated: $outputPath"
