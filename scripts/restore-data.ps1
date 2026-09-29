param(
    [Parameter(Mandatory = $true)]
    [string]$BackupPath
)

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$PythonExe = Join-Path $ProjectRoot ".venv\Scripts\python.exe"

if (-not (Test-Path -LiteralPath $PythonExe)) {
    throw "Project Python environment is missing. Run the setup script first."
}

& $PythonExe (Join-Path $ProjectRoot "scripts\restore_data.py") $BackupPath
if ($LASTEXITCODE -ne 0) {
    throw "Data restore failed."
}
