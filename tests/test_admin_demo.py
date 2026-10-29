from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import json
import unittest

from fastapi import FastAPI, Header, HTTPException
from fastapi.testclient import TestClient

from apps.server.app.admin_demo import MAX_DEMO_SCRIPT_BYTES, install_admin_demo_routes


class AdminDemoTests(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.path = Path(self.temporary.name) / "private-demo.json"
        self.script = {
            "title": "虚构测试剧本", "candidate": "虚构候选人", "target_role": "后端工程师",
            "turns": [{"question": "请介绍项目。", "answer": "我负责虚构项目测试。", "answer_summary": "负责测试"}],
        }
        self.path.write_text(json.dumps(self.script, ensure_ascii=False), encoding="utf-8")

        def authenticate(authorization: str | None = Header(default=None)):
            if authorization not in {"Bearer synthetic-admin", "Bearer synthetic-student"}:
                raise HTTPException(401, "请先登录")
            return SimpleNamespace(role="admin" if authorization.endswith("admin") else "student")

        app = FastAPI()
        install_admin_demo_routes(app, authenticate, self.path)
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.temporary.cleanup()

    def test_only_authenticated_admin_can_read_and_response_is_not_cached(self):
        self.assertEqual(self.client.get("/api/admin/demo-script").status_code, 401)
        self.assertEqual(self.client.get("/api/admin/demo-script", headers={"Authorization": "Bearer synthetic-student"}).status_code, 403)
        response = self.client.get("/api/admin/demo-script", headers={"Authorization": "Bearer synthetic-admin"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), self.script)
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertEqual(response.headers["vary"], "Authorization")

    def test_unauthorized_request_does_not_open_private_file(self):
        self.path.unlink()
        self.assertEqual(self.client.get("/api/admin/demo-script").status_code, 401)
        self.assertEqual(self.client.get("/api/admin/demo-script", headers={"Authorization": "Bearer synthetic-student"}).status_code, 403)

    def test_missing_malformed_and_invalid_scripts_fail_without_private_details(self):
        for content in ("private-marker: invalid JSON", "[]", '{"turns":[]}', json.dumps({**self.script, "turns": [{"question": "Q"}]})):
            self.path.write_text(content, encoding="utf-8")
            response = self.client.get("/api/admin/demo-script", headers={"Authorization": "Bearer synthetic-admin"})
            self.assertEqual(response.status_code, 503)
            self.assertNotIn("private-marker", response.text)
            self.assertNotIn(str(self.path), response.text)
        self.path.unlink()
        self.assertEqual(self.client.get("/api/admin/demo-script", headers={"Authorization": "Bearer synthetic-admin"}).status_code, 503)

    def test_oversized_script_is_rejected(self):
        self.path.write_bytes(b" " * (MAX_DEMO_SCRIPT_BYTES + 1))
        response = self.client.get("/api/admin/demo-script", headers={"Authorization": "Bearer synthetic-admin"})
        self.assertEqual(response.status_code, 503)

    def test_browser_source_never_imports_private_script_and_dev_denies_direct_access(self):
        root = Path(__file__).resolve().parents[1]
        source = (root / "apps/web/src/AdminScriptedDemo.jsx").read_text(encoding="utf-8")
        self.assertNotIn("adminInterviewScript.json", source)
        self.assertIn("api('/admin/demo-script'", source)
        self.assertIn("cache: 'no-store'", source)
        config = (root / "apps/web/vite.config.js").read_text(encoding="utf-8")
        self.assertIn("**/adminInterviewScript.json", config)


if __name__ == "__main__":
    unittest.main()
