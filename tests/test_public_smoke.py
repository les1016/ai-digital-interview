import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from scripts import public_release

ROOT = Path(__file__).resolve().parents[1]


class FreshInstallTests(unittest.TestCase):
    def test_allowlisted_sources_bootstrap_real_http_api_without_provider_calls(self):
        # A separate process prevents imported app globals from pointing at a
        # real project database or inheriting other tests' dependency overrides.
        files = public_release.collect(ROOT)
        with tempfile.TemporaryDirectory(prefix="interview fresh install ") as temporary:
            root = Path(temporary)
            for name, content in files.items():
                if name.startswith("apps/server/app/") or name in {"scripts/local_setup.py", "tests/public_smoke_worker.py"}:
                    path = root / name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(content)
            (root / ".fresh-install-smoke-fixture").touch()
            # Keep only OS/runtime environment, never service credentials/config.
            allowed = {"SYSTEMROOT", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP", "TMPDIR", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOME", "LANG", "LC_ALL"}
            env = {key: value for key, value in os.environ.items() if key.upper() in allowed}
            env["PYTHONUTF8"] = "1"
            result = subprocess.run([sys.executable, "-B", str(root / "tests/public_smoke_worker.py")], cwd=root, env=env, capture_output=True, text=True, encoding="utf-8", timeout=40)
            self.assertEqual(result.returncode, 0, result.stderr[-3500:])
            report = json.loads(result.stdout.strip().splitlines()[-1])
            self.assertTrue(report["fresh_api_started"])
            self.assertTrue(report["admin_login"])
            self.assertTrue(report["student_denied_admin"])
            self.assertEqual(report["external_calls"], 0)


if __name__ == "__main__":
    unittest.main()
