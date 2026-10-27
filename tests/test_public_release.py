import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from scripts import public_release as release


class PublicReleaseTests(unittest.TestCase):
    def test_only_exact_reviewed_preview_bytes_are_allowed(self):
        for name in release.REVIEWED_PREVIEWS:
            blob = (release.ROOT / name).read_bytes()
            self.assertFalse(release.inspect_bytes(name, blob))
            self.assertTrue(release.inspect_bytes(name, blob + b"changed"))
            self.assertTrue(release.inspect_bytes(name, b"fake png"))
            self.assertTrue(release.inspect_bytes("docs/images/unreviewed.png", blob))
            self.assertTrue(release.inspect_bytes(name.upper(), blob))

    def test_export_manifest_hashes_canonical_lf_text(self):
        import hashlib
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "source"
            (root / "release").mkdir(parents=True)
            (root / "main.py").write_bytes(b"print('ok')\r\n")
            (root / "release/public-files.json").write_text(json.dumps([
                {"source": "main.py", "target": "main.py"}
            ]))
            destination = Path(folder) / "public"
            self.assertTrue(release.export(root, destination)["ok"])
            content = (destination / "main.py").read_bytes()
            self.assertEqual(content, b"print('ok')\n")
            manifest = json.loads((destination / "PUBLIC_RELEASE_MANIFEST.json").read_text())
            self.assertEqual(manifest["sha256"]["main.py"], hashlib.sha256(content).hexdigest())

    def test_nonexistent_scan_root_never_passes(self):
        with tempfile.TemporaryDirectory() as folder:
            self.assertFalse(release.check_tree(Path(folder) / "does-not-exist")["ok"])

    def test_sensitive_inputs_blocked_without_echo(self):
        samples = {"provider": "sk-" + "abc123" * 7, "jwt": "eyJ" + "a" * 20 + "." + "b" * 25 + "." + "c" * 25,
                   "mail": "student" + "@" + "gmail.com", "phone": "138" + "0" * 8,
                   "computer": "C:" + "/Users/" + "test-person" + "/secret.txt"}
        for value in samples.values():
            findings = release.inspect_bytes("app.py", value.encode())
            self.assertTrue(findings)
            self.assertNotIn(value, json.dumps(findings))

    def test_private_files_and_binary_blocked(self):
        for name in (".env", ".env.local", "data/users.db-wal", "api/key.txt", "apps/web/dist/index.js", "avatar.mp4", "private.key", "API/key.txt", "DATA/records.json", ".ENV.LOCAL", "apps/web/DIST/index.js"):
            self.assertTrue(release.inspect_bytes(name, b"test"))
        self.assertTrue(release.inspect_bytes("app.py", b"\x00\xff"))

    def test_directory_read_failure_never_reports_clean(self):
        def denied_walk(*args, **kwargs):
            kwargs["onerror"](PermissionError("Do not print private exception data"))
            return iter(())
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(release.os, "walk", side_effect=denied_walk):
                report = release.check_tree(Path(folder))
                self.assertFalse(report["ok"])
                self.assertEqual(report["issues"][0]["rule"], "unreadable-directory")
                self.assertNotIn("private exception", json.dumps(report))

    def test_known_private_value_caught_even_if_not_a_key(self):
        value = "Known Private Candidate"
        self.assertTrue(release.inspect_bytes("app.json", value.encode(), {value}))
        self.assertFalse(release.inspect_bytes(".env.example", b"DEEPSEEK_API_KEY=\nADMIN_USERNAME=admin\n"))
        self.assertFalse(release.inspect_bytes(".env.example", b"DEEPSEEK_API_KEY=\nDEEPSEEK_MAX_CONCURRENT=8\nJWT_SECRET=CHANGE_TO_RANDOM_VALUE\n"))

    def test_path_escape_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            for name in ("../outside", "nested/../../outside", "C:/outside", "/outside", "a\\b"):
                with self.assertRaises(release.ReleaseError):
                    release.safe_path(Path(folder), name)

    def test_junction_guard_is_fail_closed(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(Path, "is_junction", return_value=True, create=True):
                with self.assertRaises(release.ReleaseError):
                    release.safe_path(Path(folder), "app.py")

    def test_export_only_whitelist_replaces_whole_demo_and_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "source"
            (root / "release").mkdir(parents=True)
            (root / "api").mkdir()
            key = "sk-" + "private" * 6
            (root / "api/api.txt").write_text(key)
            (root / "release/demo.json").write_text('{"candidate":"fictional sample"}')
            (root / "release/public-files.json").write_text(json.dumps([{"source": "release/demo.json", "target": "apps/web/src/data/adminInterviewScript.json"}]))
            target = Path(folder) / "public"
            result = release.export(root, target)
            self.assertTrue(result["ok"])
            self.assertFalse((target / "api").exists())
            self.assertEqual(json.loads((target / "apps/web/src/data/adminInterviewScript.json").read_text())["candidate"], "fictional sample")
            self.assertTrue(release.check_tree(target)["ok"])
            with self.assertRaises(release.ReleaseError):
                release.export(root, target)

    def test_failed_scan_creates_no_output(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "source"
            (root / "release").mkdir(parents=True)
            (root / "bad.py").write_text("sk-" + "secret" * 6)
            (root / "release/public-files.json").write_text(json.dumps([{"source": "bad.py", "target": "bad.py"}]))
            target = Path(folder) / "public"
            self.assertFalse(release.export(root, target)["ok"])
            self.assertFalse(target.exists())

    def test_symlink_rejected_when_supported(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "original.py").write_text("safe")
            try:
                (root / "linked.py").symlink_to(root / "original.py")
            except OSError:
                self.skipTest("OS disallows unprivileged symlinks")
            with self.assertRaises(release.ReleaseError):
                release.safe_path(root, "linked.py")
            self.assertFalse(release.check_tree(root)["ok"])


if __name__ == "__main__":
    unittest.main()
