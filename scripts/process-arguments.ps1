# Start-Process joins ArgumentList into one string on Windows. Apply native
# argument escaping so spaces, quotes and trailing backslashes survive.
function ConvertTo-NativeArguments([AllowEmptyCollection()][string[]]$Values) {
    $quoted = foreach ($value in $Values) {
        $escaped = [regex]::Replace([string]$value, '(\\*)"', '$1$1\"')
        $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
        '"' + $escaped + '"'
    }
    return ($quoted -join ' ')
}

function Test-ManagedCommandLine([string]$CommandLine, [string]$Marker) {
    # Accept both legacy unquoted arguments and new quoted native arguments.
    if (-not $CommandLine -or -not $Marker) { return $false }
    return $CommandLine.Replace('"', '').Contains($Marker)
}

function Assert-LocalPortOwner([int]$Port, [string]$MarkerPath, [string]$ProjectRoot, [string]$Name, [string]$ExpectedMarker) {
    try {
        $marker = Get-Content -LiteralPath $MarkerPath -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json
        if ($marker.project_root -ne $ProjectRoot -or $marker.name -ne $Name -or $marker.marker -ne $ExpectedMarker) { throw 'Other project marker' }
        $savedPid = [int]$marker.pid
        if ($savedPid -le 0) { throw 'Invalid process marker' }
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $savedPid" -ErrorAction Stop
        if (-not (Test-ManagedCommandLine $process.CommandLine $ExpectedMarker)) { throw 'Stale marker' }
        $created = ([datetime]$process.CreationDate).ToUniversalTime()
        $recorded = ([datetime]$marker.started_at).ToUniversalTime()
        if ([math]::Abs(($created - $recorded).TotalSeconds) -gt 15) { throw 'Reused process id' }
        $owners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique)
        if ($owners.Count -eq 0) { throw 'No listening process' }
        foreach ($owner in $owners) {
            $candidate = [int]$owner
            $matched = $false
            for ($depth = 0; $depth -lt 6; $depth++) {
                if ($candidate -eq $savedPid) { $matched = $true; break }
                $ancestor = Get-CimInstance Win32_Process -Filter "ProcessId = $candidate" -ErrorAction Stop
                if (-not $ancestor -or $ancestor.ParentProcessId -le 0 -or $ancestor.ParentProcessId -eq $candidate) { break }
                $candidate = [int]$ancestor.ParentProcessId
            }
            if (-not $matched) { throw 'Port belongs to another process tree' }
        }
    } catch {
        throw "Port $Port is occupied by an unverified process or another project. Stop that project from its own launcher first. No process was stopped automatically."
    }
}
