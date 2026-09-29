from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
from scripts import local_setup as setup
from app.passwords import verify_password


class LocalSetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.key = "sk-" + "test" * 8
        self.password = "SamplePassword" + "9827"

    def configure(self, **changes):
        fields = dict(key=self.key, username="demo_admin", password=self.password, confirmation=self.password, environ={})
        fields.update(changes)
        return setup.configure(self.root, **fields)

    def test_first_run_saves_key_and_compatible_hash_not_password(self):
        (self.root / ".env").write_text("HTTPS_PROXY=http://localhost:1234\n", encoding="utf-8")
        self.assertEqual(setup.setup_status(self.root, {}), {"key_configured": False, "admin_configured": False})
        result = self.configure()
        self.assertTrue(result["admin_created"])
        self.assertTrue(all(setup.setup_status(self.root, {}).values()))
        content = (self.root / ".env").read_text()
        self.assertIn("HTTPS_PROXY=http://localhost:1234", content)
        self.assertIn(self.key, content)
        self.assertNotIn(self.password, content)
        with closing(sqlite3.connect(self.root / "data/ai_interview.db")) as connection:
            encoded = connection.execute("SELECT password_hash FROM users").fetchone()[0]
            self.assertTrue(verify_password(self.password, encoded))
            self.assertNotEqual(encoded, self.password)

    def test_existing_admin_never_reset_or_duplicated(self):
        self.configure()
        before = (self.root / "data/ai_interview.db").read_bytes()
        result = self.configure(key="", username="attacker", password="wrong", confirmation="wrong")
        self.assertFalse(result["admin_created"])
        self.assertEqual(before, (self.root / "data/ai_interview.db").read_bytes())

    def test_api_can_read_bootstrapped_admin_and_create_remaining_tables(self):
        from sqlalchemy import create_engine, select
        from sqlalchemy.orm import Session
        from app import main
        self.configure()
        engine = create_engine(f"sqlite:///{self.root / 'data/ai_interview.db'}")
        try:
            main.Base.metadata.create_all(engine)
            with Session(engine) as session:
                user = session.scalar(select(main.User).where(main.User.username == "demo_admin"))
                self.assertEqual(user.role, "admin")
                self.assertTrue(main.verify_password(self.password, user.password_hash))
                self.assertIsNotNone(user.created_at.year)
        finally:
            engine.dispose()

    def test_invalid_input_writes_nothing(self):
        for changes in ({"key": "https://example.com"}, {"key": "sk-" + "a" * 30 + "\nJWT_SECRET=bad"}, {"password": "123456"}, {"confirmation": "different"}):
            with self.assertRaises(setup.SetupError):
                self.configure(**changes)
            self.assertFalse((self.root / ".env").exists())
            self.assertFalse((self.root / "data").exists())

    def test_environment_override_is_not_silently_ignored(self):
        with self.assertRaises(setup.SetupError):
            self.configure(environ={"DEEPSEEK_API_KEY": "external-key"})

    def test_passwords_that_login_would_trim_are_rejected_before_writing(self):
        for password in (" " + self.password, self.password + "\u3000", self.password + "\n", "LongPassword\t1234"):
            with self.subTest(password_case=len(password)):
                with self.assertRaises(setup.SetupError):
                    self.configure(password=password, confirmation=password)
                self.assertFalse((self.root / ".env").exists())
                self.assertFalse((self.root / "data").exists())

    def test_middle_spaces_in_password_are_preserved(self):
        password = "Valid Middle Space 2026!"
        self.configure(password=password, confirmation=password)
        with closing(sqlite3.connect(self.root / "data/ai_interview.db")) as connection:
            encoded = connection.execute("SELECT password_hash FROM users").fetchone()[0]
            self.assertTrue(verify_password(password, encoded))

    def test_refuses_custom_or_production_database(self):
        for environ in ({"DATABASE_URL": "postgresql://example"}, {"APP_ENV": "production"}):
            with self.assertRaises(setup.SetupError):
                self.configure(environ=environ)
        self.assertFalse((self.root / "data").exists())

    def test_permission_failure_does_not_write_credentials(self):
        with patch.object(setup, "protect_file", side_effect=setup.SetupError("ACL failed")):
            with self.assertRaises(setup.SetupError):
                self.configure()
        self.assertEqual(list(self.root.iterdir()), [])

    def test_existing_student_is_not_promoted(self):
        (self.root / "data").mkdir()
        with closing(sqlite3.connect(self.root / "data/ai_interview.db")) as connection:
            connection.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, password_hash TEXT, role TEXT, created_at TEXT)")
            connection.execute("INSERT INTO users VALUES(1, 'demo_admin', 'Test', 'hash', 'student', '2026-01-01')")
            connection.commit()
        with self.assertRaises(setup.SetupError):
            self.configure()
        with closing(sqlite3.connect(self.root / "data/ai_interview.db")) as connection:
            self.assertEqual(connection.execute("SELECT role FROM users").fetchone()[0], "student")
        self.assertFalse((self.root / ".env").exists())

    def test_env_failure_after_admin_creation_can_be_retried(self):
        with patch.object(setup.os, "replace", side_effect=OSError("simulated disk error")):
            with self.assertRaises(OSError):
                self.configure()
        self.assertTrue(setup.has_admin(self.root / "data/ai_interview.db"))
        self.assertFalse((self.root / ".env").exists())
        self.assertFalse(self.configure()["admin_created"])
        self.assertTrue(all(setup.setup_status(self.root, {}).values()))

    def test_duplicate_key_assignments_removed(self):
        text = setup.updated_env("DEEPSEEK_API_KEY=old\nexport DEEPSEEK_API_KEY=older\nOTHER=keep\n", self.key)
        self.assertEqual(text.count("DEEPSEEK_API_KEY="), 1)
        self.assertIn("OTHER=keep", text)

    def test_locked_configuration_does_not_overwrite(self):
        (self.root / ".setup.lock").touch()
        with self.assertRaises(setup.SetupError):
            self.configure()
        self.assertFalse((self.root / ".env").exists())


if __name__ == "__main__":
    unittest.main()
