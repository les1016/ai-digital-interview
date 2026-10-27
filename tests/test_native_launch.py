import json
from datetime import datetime, timezone
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(os.name == "nt" and shutil.which("powershell.exe"), "Windows PowerShell native launch test")
class NativeLaunchTests(unittest.TestCase):
    def test_own_listening_process_is_accepted(self):
        with tempfile.TemporaryDirectory(prefix="port owner ") as temporary:
            root = Path(temporary)
            shutil.copyfile(ROOT / "scripts/process-arguments.ps1", root / "process-arguments.ps1")
            child_code = "import socket,sys; s=socket.socket(); s.bind(('127.0.0.1',0)); s.listen(); print(s.getsockname()[1],flush=True); sys.stdin.read(1); s.close()"
            with subprocess.Popen([sys.executable, "-c", child_code, "app.main:app"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) as child:
                try:
                    port = int(child.stdout.readline().strip())
                    marker = {"pid": child.pid, "name": "api", "marker": "app.main:app", "started_at": datetime.now(timezone.utc).isoformat(), "project_root": str(root)}
                    (root / "api.pid").write_text(json.dumps(marker), encoding="utf-8")
                    script = '''param([int]$Port)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'process-arguments.ps1')
Assert-LocalPortOwner $Port (Join-Path $PSScriptRoot 'api.pid') $PSScriptRoot 'api' 'app.main:app'
Write-Output 'verified'
'''
                    path = root / "check-owner.ps1"
                    path.write_text(script, encoding="utf-8-sig")
                    result = subprocess.run([shutil.which("powershell.exe"), "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(path), "-Port", str(port)], capture_output=True, timeout=15)
                    self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
                    self.assertIn(b"verified", result.stdout)
                finally:
                    child.stdin.write("q\n")
                    child.stdin.flush()
                    child.wait(timeout=5)

    def test_native_argument_round_trip_with_spaces_quotes_and_backslashes(self):
        arguments = ["a b", "中文目录", 'a"b', "end\\", "spaces and end\\", "", "--flag", "x&echo unexpected", 'one\\"two']
        with tempfile.TemporaryDirectory(prefix="launch path with spaces ") as temporary:
            root = Path(temporary)
            (root / "arguments.json").write_text(json.dumps(arguments, ensure_ascii=False), encoding="utf-8")
            shutil.copyfile(ROOT / "scripts/process-arguments.ps1", root / "process-arguments.ps1")
            script = r'''param([string]$Python)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'process-arguments.ps1')
$values = Get-Content (Join-Path $PSScriptRoot 'arguments.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$arguments = @('-c', 'import sys,json; print(json.dumps(sys.argv[1:],ensure_ascii=True))') + $values
$process = Start-Process -FilePath $Python -ArgumentList (ConvertTo-NativeArguments $arguments) -WindowStyle Hidden -PassThru -Wait -RedirectStandardOutput (Join-Path $PSScriptRoot 'argv.json') -RedirectStandardError (Join-Path $PSScriptRoot 'error.txt')
if ($process.ExitCode -ne 0) { throw 'Test child failed' }
if (-not (Test-ManagedCommandLine '"D:\sample path\vite.js" "preview" "--host" "127.0.0.1"' 'vite.js preview')) { throw 'Quoted marker not accepted' }
if (-not (Test-ManagedCommandLine 'D:\sample\vite.js preview --port 4173' 'vite.js preview')) { throw 'Legacy marker not accepted' }
if (Test-ManagedCommandLine 'D:\sample\other.js build' 'vite.js preview') { throw 'Incorrect marker accepted' }
'''
            path = root / "verify.ps1"
            path.write_text(script, encoding="utf-8-sig")
            result = subprocess.run([shutil.which("powershell.exe"), "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(path), "-Python", sys.executable], capture_output=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
            self.assertEqual(json.loads((root / "argv.json").read_text(encoding="utf-8-sig")), arguments)

    @unittest.skipUnless(shutil.which("wsl.exe"), "Requires WSL")
    def test_wsl_script_launch_preserves_options_and_unicode_path(self):
        result = subprocess.run(["wsl.exe", "--list", "--quiet"], capture_output=True, timeout=20)
        if "Ubuntu-22.04" not in result.stdout.decode("utf-16-le", errors="ignore"):
            self.skipTest("Requires Ubuntu-22.04")
        with tempfile.TemporaryDirectory(prefix="wsl launch 中文 ") as directory:
            root = Path(directory)
            shell = root / "probe.sh"
            shell.write_text("#!/bin/bash\nset -euo pipefail\nprintf 'wsl-probe-ok'\n", encoding="utf-8", newline="\n")
            linux_path = "/mnt/" + str(shell)[0].lower() + str(shell)[2:].replace("\\", "/")
            shutil.copyfile(ROOT / "scripts/process-arguments.ps1", root / "process-arguments.ps1")
            script = root / "probe.ps1"
            script.write_text('''param([string]$LinuxPath)
. (Join-Path $PSScriptRoot 'process-arguments.ps1')
$p = Start-Process wsl.exe -ArgumentList (ConvertTo-WslArguments 'Ubuntu-22.04' $LinuxPath) -WindowStyle Hidden -PassThru -Wait -RedirectStandardOutput (Join-Path $PSScriptRoot 'result.txt') -RedirectStandardError (Join-Path $PSScriptRoot 'error.txt')
exit $p.ExitCode
''', encoding="utf-8-sig")
            result = subprocess.run(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script), "-LinuxPath", linux_path], capture_output=True, timeout=30)
            self.assertEqual(result.returncode, 0, (root / "error.txt").read_text(errors="replace"))
            self.assertIn("wsl-probe-ok", (root / "result.txt").read_text(errors="replace"))
        for name in ("start-livetalking.sh", "start-cosyvoice.sh"):
            self.assertNotIn(b"\r\n", (ROOT / "scripts" / name).read_bytes())

    def test_other_project_port_is_refused_without_killing_any_process(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            shutil.copyfile(ROOT / "scripts/process-arguments.ps1", root / "process-arguments.ps1")
            script = '''$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'process-arguments.ps1')
try { Assert-LocalPortOwner 8000 (Join-Path $PSScriptRoot 'missing.pid') $PSScriptRoot 'api' 'app.main:app' } catch { Write-Output 'refused'; exit 0 }
throw 'Missing ownership marker accepted'
'''
            path = root / "check-owner.ps1"
            path.write_text(script, encoding="utf-8-sig")
            result = subprocess.run([shutil.which("powershell.exe"), "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(path)], capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0)
            self.assertIn(b"refused", result.stdout)


if __name__ == "__main__":
    unittest.main()
