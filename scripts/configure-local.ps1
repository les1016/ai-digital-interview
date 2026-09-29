$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$PythonExe = Join-Path $ProjectRoot ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $PythonExe)) {
    throw "Run setup-local.ps1 first to install the project Python environment."
}
& $PythonExe (Join-Path $ProjectRoot "scripts\local_setup.py")
exit $LASTEXITCODE
