from __future__ import annotations

from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class ScriptRegressionTests(unittest.TestCase):
    def test_windows_start_stop_scripts_use_identity_pid_markers(self):
        start_script = (ROOT / "scripts" / "start-all.ps1").read_text(encoding="utf-8")
        stop_script = (ROOT / "scripts" / "stop-all.ps1").read_text(encoding="utf-8")

        self.assertIn("function Write-PidMarker", start_script)
        self.assertIn("ConvertTo-Json -Compress", start_script)
        self.assertIn("project_root = $ProjectRoot", start_script)
        self.assertIn('"app.main:app"', start_script)
        self.assertIn('"vite.js preview"', start_script)

        self.assertIn("function Read-PidMarker", stop_script)
        self.assertIn('$raw -match "^\\d+$"', stop_script)
        self.assertIn("$markerRoot -and $markerRoot -ne $ProjectRoot", stop_script)
        self.assertIn("-Encoding UTF8", start_script)
        self.assertNotIn("-Encoding ascii", start_script)
        self.assertIn("-Raw -Encoding UTF8", stop_script)
        self.assertIn("^/mnt/([a-zA-Z])/(.*)$", stop_script)
        self.assertIn("Skipped stale $name PID", stop_script)

    def test_wsl_start_scripts_write_identity_pid_markers(self):
        livetalking = (ROOT / "scripts" / "start-livetalking.sh").read_text(encoding="utf-8")
        cosyvoice = (ROOT / "scripts" / "start-cosyvoice.sh").read_text(encoding="utf-8")

        self.assertIn('"name":"livetalking"', livetalking)
        self.assertIn('"marker":"app.py --transport webrtc"', livetalking)
        self.assertIn('"project_root":"%s"', livetalking)

        self.assertIn('"name":"cosyvoice"', cosyvoice)
        self.assertIn('"marker":"server.py --port 50000"', cosyvoice)
        self.assertIn('"project_root":"%s"', cosyvoice)


if __name__ == "__main__":
    unittest.main()
