from __future__ import annotations

from contextlib import closing
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from scripts import backup_data, restore_data


class BackupTests(unittest.TestCase):
    def test_backup_uses_sqlite_backup_and_excludes_secrets(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            data = root / "data"
            backups = root / "backups"
            (data / "uploads").mkdir(parents=True)
            (data / "recordings").mkdir()
            database = data / "ai_interview.db"
            with closing(sqlite3.connect(database)) as connection:
                connection.execute("CREATE TABLE sample (value TEXT)")
                connection.execute("INSERT INTO sample VALUES ('ok')")
                connection.commit()
            (data / "uploads" / "resume.txt").write_text("resume", encoding="utf-8")
            (data / "recordings" / "interview.webm").write_bytes(b"video")
            (data / ".jwt_secret").write_text("must-not-leak", encoding="utf-8")

            with (
                patch.object(backup_data, "ROOT", root),
                patch.object(backup_data, "DATA_DIR", data),
                patch.object(backup_data, "BACKUP_ROOT", backups),
                patch.object(backup_data, "ensure_service_stopped"),
                patch.object(backup_data, "configured_database_path", return_value=database),
            ):
                self.assertEqual(backup_data.main(), 0)

            created = [path for path in backups.iterdir() if path.is_dir()]
            self.assertEqual(len(created), 1)
            backup = created[0]
            with closing(sqlite3.connect(backup / "data" / "ai_interview.db")) as connection:
                self.assertEqual(connection.execute("SELECT value FROM sample").fetchone()[0], "ok")
            self.assertEqual((backup / "data" / "uploads" / "resume.txt").read_text(encoding="utf-8"), "resume")
            self.assertEqual((backup / "data" / "recordings" / "interview.webm").read_bytes(), b"video")
            self.assertFalse((backup / "data" / ".jwt_secret").exists())
            manifest = json.loads((backup / "manifest.json").read_text(encoding="utf-8"))
            self.assertFalse(manifest["contains_credentials"])
            self.assertTrue(manifest["contains_personal_data"])
            self.assertGreaterEqual(len(manifest["files"]), 3)

            with closing(sqlite3.connect(database)) as connection:
                connection.execute("UPDATE sample SET value = 'changed'")
                connection.commit()
            (data / "uploads" / "resume.txt").write_text("changed", encoding="utf-8")

            with (
                patch.object(restore_data, "ROOT", root),
                patch.object(restore_data, "DATA_DIR", data),
                patch.object(restore_data, "BACKUP_ROOT", backups),
                patch.object(restore_data, "ensure_service_stopped"),
                patch.object(restore_data, "configured_database_path", return_value=database),
            ):
                self.assertEqual(restore_data.main(str(backup)), 0)

            with closing(sqlite3.connect(database)) as connection:
                self.assertEqual(connection.execute("SELECT value FROM sample").fetchone()[0], "ok")
            self.assertEqual((data / "uploads" / "resume.txt").read_text(encoding="utf-8"), "resume")


if __name__ == "__main__":
    unittest.main()
