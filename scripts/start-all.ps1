param(
    [switch]$NoBrowser,
    [switch]$WebOnly
)

$ErrorActionPreference = "Stop"
$processPath = [Environment]::GetEnvironmentVariable("Path", "Process")
[Environment]::SetEnvironmentVariable("PATH", $null, "Process")
[Environment]::SetEnvironmentVariable("Path", $processPath, "Process")
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $PSScriptRoot "process-arguments.ps1")
$WslDistro = if ($env:WSL_DISTRO) { $env:WSL_DISTRO } else { "Ubuntu-22.04" }
$LogDir = Join-Path $ProjectRoot "logs"
$PidDir = Join-Path $LogDir "pids"
New-Item -ItemType Directory -Force -Path $LogDir, $PidDir | Out-Null

function Test-Port([int]$Port) {
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $pending = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
        if (-not $pending.AsyncWaitHandle.WaitOne(400)) { return $false }
        $client.EndConnect($pending)
        return $true
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

function Wait-Port([int]$Port, [int]$Seconds = 45) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Port $Port) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Wait-ApiHealth([int]$Seconds = 45) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $payload = Invoke-RestMethod -Uri "http://127.0.0.1:8000/api/health" -TimeoutSec 2
            if ($payload.status -eq "ok" -and $payload.database -eq "ok") { return $true }
        } catch {}
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Wait-WebHealth([int]$Seconds = 45) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-WebRequest -Uri "http://127.0.0.1:4173" -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -eq 200 -and $response.Content -match 'id="root"') { return $true }
        } catch {}
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Wait-ServiceHealth([string]$Uri, [string]$Service, [int]$Seconds = 45) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $payload = Invoke-RestMethod -Uri $Uri -TimeoutSec 2
            if ($payload.status -eq "ok" -and $payload.service -eq $Service) { return $true }
        } catch {}
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Write-PidMarker([string]$Path, [int]$ProcessId, [string]$Name, [string]$Marker) {
    $payload = [ordered]@{
        pid = $ProcessId
        name = $Name
        marker = $Marker
        started_at = (Get-Date).ToUniversalTime().ToString("o")
        project_root = $ProjectRoot
    }
    # Project paths may contain Chinese characters. ASCII corrupts ownership
    # markers and makes stop-all safely refuse to stop our own processes.
    $payload | ConvertTo-Json -Compress | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Find-Node {
    if ($env:NODE_EXE -and (Test-Path -LiteralPath $env:NODE_EXE)) { return $env:NODE_EXE }
    $globalNode = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($globalNode) { return $globalNode.Source }
    $codexNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
    if (Test-Path -LiteralPath $codexNode) { return $codexNode }
    throw "Node.js was not found. Run the setup script or install Node.js 22 LTS."
}

$PythonExe = Join-Path $ProjectRoot ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $PythonExe)) {
    throw "Project Python environment was not found: $PythonExe"
}
$NodeExe = Find-Node
$ViteJs = Join-Path $ProjectRoot "apps\web\node_modules\vite\bin\vite.js"
if (-not (Test-Path -LiteralPath $ViteJs)) {
    throw "Frontend dependencies are missing. Run the setup script first."
}

# A public copy must not silently connect to the private project's existing API.
if (Test-Port 8000) { Assert-LocalPortOwner 8000 (Join-Path $PidDir 'api.pid') $ProjectRoot 'api' 'app.main:app' }
if (Test-Port 4173) { Assert-LocalPortOwner 4173 (Join-Path $PidDir 'web.pid') $ProjectRoot 'web' 'vite.js preview' }
if (-not $WebOnly -and -not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'integrations\LiveTalking\app.py'))) {
    throw "LiveTalking is not installed. For source-code exploration, run scripts\start-all.ps1 -WebOnly; complete avatar setup before a full interview."
}
& $PythonExe -X utf8 (Join-Path $ProjectRoot "scripts\local_setup.py") --if-needed
if ($LASTEXITCODE -ne 0) { throw "Local configuration was cancelled or could not be completed. No services were started." }

if (-not (Test-Port 8000)) {
    $api = Start-Process -FilePath $PythonExe `
        -ArgumentList (ConvertTo-NativeArguments @('-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8000')) `
        -WorkingDirectory (Join-Path $ProjectRoot "apps\server") `
        -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $LogDir "api.log") `
        -RedirectStandardError (Join-Path $LogDir "api-error.log")
    Write-PidMarker (Join-Path $PidDir "api.pid") $api.Id "api" "app.main:app"
}

$WebRoot = Join-Path $ProjectRoot "apps\web"
$DistIndex = Join-Path $WebRoot "dist\index.html"
$WebBuildInputs = @(
    (Join-Path $WebRoot "index.html"),
    (Join-Path $WebRoot "package.json"),
    (Join-Path $WebRoot "pnpm-lock.yaml"),
    (Join-Path $WebRoot "vite.config.js"),
    (Join-Path $ProjectRoot ".env")
) + @(
    Get-ChildItem -LiteralPath (Join-Path $WebRoot "src") -Recurse -File -ErrorAction SilentlyContinue |
        ForEach-Object { $_.FullName }
) + @(
    Get-ChildItem -LiteralPath (Join-Path $WebRoot "public") -Recurse -File -ErrorAction SilentlyContinue |
        ForEach-Object { $_.FullName }
)
$BuildRequired = -not (Test-Path -LiteralPath $DistIndex)
if (-not $BuildRequired) {
    $distTime = (Get-Item -LiteralPath $DistIndex).LastWriteTimeUtc
    $BuildRequired = $null -ne ($WebBuildInputs | Where-Object {
        (Test-Path -LiteralPath $_) -and (Get-Item -LiteralPath $_).LastWriteTimeUtc -gt $distTime
    } | Select-Object -First 1)
}
if ($BuildRequired) {
    Push-Location $WebRoot
    try {
        & $NodeExe $ViteJs build
        if ($LASTEXITCODE -ne 0) { throw "Frontend build failed." }
    } finally {
        Pop-Location
    }
}

if (-not (Test-Port 4173)) {
    $web = Start-Process -FilePath $NodeExe `
        -ArgumentList (ConvertTo-NativeArguments @($ViteJs, 'preview', '--host', '127.0.0.1', '--port', '4173', '--strictPort')) `
        -WorkingDirectory (Join-Path $ProjectRoot "apps\web") `
        -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $LogDir "web.log") `
        -RedirectStandardError (Join-Path $LogDir "web-error.log")
    Write-PidMarker (Join-Path $PidDir "web.pid") $web.Id "web" "vite.js preview"
}

$CosyModel = Join-Path $ProjectRoot "integrations\CosyVoice\pretrained_models\CosyVoice2-0.5B\cosyvoice.yaml"
$cosyConfigured = (-not $WebOnly) -and (Test-Path -LiteralPath $CosyModel)
if ($cosyConfigured -and -not (Test-Port 50000)) {
    $drive = $ProjectRoot.Substring(0, 1).ToLowerInvariant()
    $pathPart = $ProjectRoot.Substring(2).Replace("\", "/")
    $wslCosyScript = "/mnt/$drive$pathPart/scripts/start-cosyvoice.sh"
    $cosy = Start-Process -FilePath "$env:WINDIR\System32\wsl.exe" `
        -ArgumentList (ConvertTo-WslArguments $WslDistro $wslCosyScript) `
        -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $LogDir "cosyvoice-launch.log") `
        -RedirectStandardError (Join-Path $LogDir "cosyvoice-launch-error.log")
    Write-PidMarker (Join-Path $PidDir "cosyvoice-wsl-launcher.pid") $cosy.Id "cosyvoice-wsl-launcher" "start-cosyvoice.sh"
}

# Launch the avatar immediately. CosyVoice is optional and must never delay the
# core web/API or the avatar process from starting.
if (-not $WebOnly -and -not (Test-Port 8010)) {
    $drive = $ProjectRoot.Substring(0, 1).ToLowerInvariant()
    $pathPart = $ProjectRoot.Substring(2).Replace("\", "/")
    $wslScript = "/mnt/$drive$pathPart/scripts/start-livetalking.sh"
    $avatar = Start-Process -FilePath "$env:WINDIR\System32\wsl.exe" `
        -ArgumentList (ConvertTo-WslArguments $WslDistro $wslScript) `
        -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $LogDir "livetalking-launch.log") `
        -RedirectStandardError (Join-Path $LogDir "livetalking-launch-error.log")
    Write-PidMarker (Join-Path $PidDir "wsl-launcher.pid") $avatar.Id "wsl-launcher" "start-livetalking.sh"
}

$apiReady = Wait-ApiHealth 30
$webReady = Wait-WebHealth 30
$avatarReady = $false
if (-not $WebOnly) { $avatarReady = Wait-ServiceHealth "http://127.0.0.1:8010/healthz" "livetalking" 120 }
$cosyReady = $false
if ($cosyConfigured) {
    # EdgeTTS remains available, so only perform a short health probe here.
    $cosyReady = Wait-ServiceHealth "http://127.0.0.1:50000/healthz" "cosyvoice" 10
}

Write-Host ""
Write-Host "AI Digital Interview startup status" -ForegroundColor Cyan
Write-Host "  Backend API : $(if ($apiReady) {'ready'} else {'failed; see logs\api-error.log'})"
Write-Host "  Web app     : $(if ($webReady) {'http://127.0.0.1:4173'} else {'failed; see logs\web-error.log'})"
Write-Host "  Avatar      : $(if ($WebOnly) {'not started (WebOnly); real-time avatar/voice interview unavailable'} elseif ($avatarReady) {'ready'} else {'slow or failed; see logs\livetalking.log'})"
Write-Host "  Local TTS   : $(if ($cosyReady) {'CosyVoice ready'} elseif ($cosyConfigured) {'failed; EdgeTTS fallback'} else {'not installed; EdgeTTS fallback'})"

if (-not $apiReady -or -not $webReady -or (-not $WebOnly -and -not $avatarReady)) {
    throw "One or more required services failed their identity health check. See the log paths above."
}

if ($webReady -and -not $NoBrowser) {
    Start-Process "http://127.0.0.1:4173"
}
