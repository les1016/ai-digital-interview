$ErrorActionPreference = "Continue"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $PSScriptRoot "process-arguments.ps1")
$PidDir = Join-Path $ProjectRoot "logs\pids"
$WslDistro = if ($env:WSL_DISTRO) { $env:WSL_DISTRO } else { "Ubuntu-22.04" }

$windowsMarkers = @{
    "api" = "app.main:app"
    "web" = "vite.js preview"
    "wsl-launcher" = "start-livetalking.sh"
    "cosyvoice-wsl-launcher" = "start-cosyvoice.sh"
}

function Read-PidMarker([string]$Path, [string]$Name, [string]$ExpectedMarker) {
    $raw = (Get-Content -LiteralPath $Path -Raw -Encoding UTF8).Trim()
    if ($raw -match "^\d+$") {
        return [pscustomobject]@{
            Pid = [int]$raw
            Name = $Name
            Marker = $ExpectedMarker
            Legacy = $true
            ProjectRoot = $null
        }
    }
    try {
        $payload = $raw | ConvertFrom-Json
    } catch {
        Write-Warning "Skipped unreadable $Name PID marker: $Path"
        return $null
    }
    if ($payload.name -ne $Name -or $payload.marker -ne $ExpectedMarker) {
        Write-Warning "Skipped mismatched $Name PID marker: $Path"
        return $null
    }
    $markerRoot = [string]$payload.project_root
    # Linux services write /mnt/<drive>/...; compare the same Windows path.
    if ($markerRoot -match '^/mnt/([a-zA-Z])/(.*)$') {
        $markerRoot = $Matches[1].ToUpperInvariant() + ':\' + $Matches[2].Replace('/', '\')
    }
    if ($markerRoot -and $markerRoot -ne $ProjectRoot) {
        Write-Warning "Skipped $Name PID marker for another project: $($payload.project_root)"
        return $null
    }
    if (-not ($payload.pid -as [int])) {
        Write-Warning "Skipped invalid $Name PID marker: $Path"
        return $null
    }
    return [pscustomobject]@{
        Pid = [int]$payload.pid
        Name = [string]$payload.name
        Marker = [string]$payload.marker
        Legacy = $false
        ProjectRoot = [string]$payload.project_root
    }
}

foreach ($name in @("api", "web", "wsl-launcher", "cosyvoice-wsl-launcher")) {
    $pidFile = Join-Path $PidDir "$name.pid"
    if (Test-Path -LiteralPath $pidFile) {
        $marker = Read-PidMarker $pidFile $name $windowsMarkers[$name]
        if ($marker) {
            $savedPid = $marker.Pid
            $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $savedPid" -ErrorAction SilentlyContinue
            if ($processInfo -and (Test-ManagedCommandLine $processInfo.CommandLine $marker.Marker)) {
                & taskkill.exe /PID $savedPid /T 2>$null | Out-Null
                Start-Sleep -Milliseconds 800
                if (Get-Process -Id $savedPid -ErrorAction SilentlyContinue) {
                    & taskkill.exe /PID $savedPid /T /F 2>$null | Out-Null
                }
                Remove-Item -LiteralPath $pidFile -Force
            } elseif ($processInfo) {
                Write-Warning "Skipped stale $name PID $savedPid because it belongs to another process."
            } else {
                Remove-Item -LiteralPath $pidFile -Force
            }
        }
    }
}

$linuxMarkers = @{
    "livetalking" = "app.py --transport webrtc"
    "cosyvoice" = "server.py --port 50000"
}

foreach ($serviceName in @("livetalking", "cosyvoice")) {
    $linuxPidFile = Join-Path $ProjectRoot "logs\$serviceName.pid"
    if (Test-Path -LiteralPath $linuxPidFile) {
        $marker = Read-PidMarker $linuxPidFile $serviceName $linuxMarkers[$serviceName]
        if ($marker) {
            $linuxPid = $marker.Pid
            $arguments = (& "$env:WINDIR\System32\wsl.exe" -d $WslDistro -- ps -p $linuxPid -o args= 2>$null) -join " "
            if ($arguments.Contains($marker.Marker)) {
                & "$env:WINDIR\System32\wsl.exe" -d $WslDistro -- kill $linuxPid 2>$null
                Start-Sleep -Milliseconds 800
                $stillRunning = (& "$env:WINDIR\System32\wsl.exe" -d $WslDistro -- ps -p $linuxPid -o pid= 2>$null) -join ""
                if ($stillRunning.Trim()) {
                    & "$env:WINDIR\System32\wsl.exe" -d $WslDistro -- kill -9 $linuxPid 2>$null
                }
                Remove-Item -LiteralPath $linuxPidFile -Force
            } elseif ($arguments) {
                Write-Warning "Skipped stale $serviceName Linux PID $linuxPid because it belongs to another process."
            } else {
                Remove-Item -LiteralPath $linuxPidFile -Force
            }
        }
    }
}

Write-Host "AI Digital Interview local services have been stopped."
