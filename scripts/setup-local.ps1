$ErrorActionPreference = "Stop"
$processPath = [Environment]::GetEnvironmentVariable("Path", "Process")
[Environment]::SetEnvironmentVariable("PATH", $null, "Process")
[Environment]::SetEnvironmentVariable("Path", $processPath, "Process")
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

function Find-Uv {
    $localUv = Join-Path $ProjectRoot ".venv\Scripts\uv.exe"
    if (Test-Path -LiteralPath $localUv) { return $localUv }
    $command = Get-Command uv.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    throw "uv was not found. Install uv first: https://docs.astral.sh/uv/"
}

function Find-Node {
    if ($env:NODE_EXE -and (Test-Path -LiteralPath $env:NODE_EXE)) { return $env:NODE_EXE }
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $codexNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
    if (Test-Path -LiteralPath $codexNode) { return $codexNode }
    throw "Node.js was not found. Install Node.js 22 LTS first."
}

function Find-Pnpm {
    $command = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $codexPnpm = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd"
    if (Test-Path -LiteralPath $codexPnpm) { return $codexPnpm }
    throw "pnpm was not found. Install pnpm 11 first."
}

$UvExe = Find-Uv
$NodeExe = Find-Node
$PnpmExe = Find-Pnpm
$NodeVersionText = (& $NodeExe -p "process.versions.node").Trim()
if ([Version]$NodeVersionText -lt [Version]"22.12.0") {
    throw "Node.js 22.12.0 or newer is required. Current version: $NodeVersionText"
}
$PnpmVersionText = (& $PnpmExe --version).Trim()
if ($PnpmVersionText -ne "11.9.0") {
    throw "pnpm 11.9.0 is required by apps\web\package.json. Current version: $PnpmVersionText"
}

Push-Location $ProjectRoot
try {
    & $UvExe sync --frozen --inexact
    if ($LASTEXITCODE -ne 0) { throw "Python dependency installation failed." }

    Push-Location (Join-Path $ProjectRoot "apps\web")
    try {
        & $PnpmExe install --frozen-lockfile
        if ($LASTEXITCODE -ne 0) { throw "Frontend dependency installation failed." }
        & $NodeExe ".\node_modules\vite\bin\vite.js" build
        if ($LASTEXITCODE -ne 0) { throw "Frontend build failed." }
    } finally {
        Pop-Location
    }
} finally {
    Pop-Location
}

$LiveTalkingApp = Join-Path $ProjectRoot "integrations\LiveTalking\app.py"
if (-not (Test-Path -LiteralPath $LiveTalkingApp)) {
    Write-Warning "LiveTalking is not installed yet. Follow the setup instructions in README.md before starting an interview."
}

Write-Host "Local code environment is ready." -ForegroundColor Green
