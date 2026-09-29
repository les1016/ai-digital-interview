param(
    [Parameter(Mandatory = $true)][string]$InputPath,
    [Parameter(Mandatory = $true)][string]$OutputPath
)

$ErrorActionPreference = "Stop"
$word = $null
$document = $null
$ownedWordProcessId = $null

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class WordWindowProcess {
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@

try {
    $inputFile = (Resolve-Path -LiteralPath $InputPath).Path
    $outputFile = [System.IO.Path]::GetFullPath($OutputPath)
    $outputDirectory = [System.IO.Path]::GetDirectoryName($outputFile)
    [System.IO.Directory]::CreateDirectory($outputDirectory) | Out-Null

    $word = New-Object -ComObject Word.Application
    [uint32]$wordProcessId = 0
    [void][WordWindowProcess]::GetWindowThreadProcessId([IntPtr]$word.Hwnd, [ref]$wordProcessId)
    if ($wordProcessId -gt 0) { $ownedWordProcessId = [int]$wordProcessId }
    $word.Visible = $false
    $word.DisplayAlerts = 0
    $word.AutomationSecurity = 3
    $document = $word.Documents.Open($inputFile, $false, $true)
    $document.ExportAsFixedFormat($outputFile, 17)

    if (-not (Test-Path -LiteralPath $outputFile)) {
        throw "Microsoft Word did not create the PDF output."
    }
} finally {
    if ($null -ne $document) {
        try { $document.Close(0) } catch {}
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($document)
    }
    if ($null -ne $word) {
        try { $word.Quit(0) } catch {}
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($word)
    }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
    if ($null -ne $ownedWordProcessId) {
        $ownedProcess = Get-Process -Id $ownedWordProcessId -ErrorAction SilentlyContinue
        if ($null -ne $ownedProcess) {
            try { [void]$ownedProcess.WaitForExit(3000) } catch {}
            if (-not $ownedProcess.HasExited) {
                Stop-Process -Id $ownedWordProcessId -Force -ErrorAction SilentlyContinue
            }
        }
    }
}
