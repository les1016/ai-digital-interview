param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$PythonExe = Join-Path $ProjectRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $PythonExe)) { throw 'Run setup-local.ps1 first.' }
if (-not $OutputDirectory) {
    if (-not (Test-Path -LiteralPath 'D:\')) { throw 'D: is unavailable. Specify -OutputDirectory explicitly.' }
    $OutputDirectory = Join-Path 'D:\Codex\public-source' ('ai-interview-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
}
& $PythonExe -X utf8 (Join-Path $ProjectRoot 'scripts\public_release.py') --output $OutputDirectory
if ($LASTEXITCODE -ne 0) { throw 'Export blocked. Review the privacy check results; nothing was uploaded.' }
& $PythonExe -X utf8 (Join-Path $ProjectRoot 'scripts\public_release.py') --check-tree $OutputDirectory
if ($LASTEXITCODE -ne 0) { throw 'Final scan failed. Do not upload the output.' }
Write-Host "Source-only snapshot created: $OutputDirectory" -ForegroundColor Green
Write-Host 'No files were uploaded. Models, credentials and user data remain in the original project.'
