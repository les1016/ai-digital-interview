"""Disposable fresh-install HTTP smoke test. Called only by test_public_smoke.

No production data or provider calls. Parent copies only allowlisted server/setup
sources to a new directory; this process binds one ephemeral loopback port.
"""
import json
import socket
import sys
import threading
import time
from pathlib import Path


def main():
    root = Path.cwd().resolve()
    if not (root / ".fresh-install-smoke-fixture").is_file():
        raise RuntimeError("Smoke worker requires a disposable fixture directory")
    sys.path.insert(0, str(root))
    from scripts.local_setup import configure, setup_status
    import httpx
    import uvicorn
    original_connect = socket.socket.connect
    external_attempts = []

    def loopback_only(sock, address):
        if not isinstance(address, tuple) or address[0] not in {"127.0.0.1", "::1"}:
            external_attempts.append(True)
            raise RuntimeError("External network disabled during smoke test")
        return original_connect(sock, address)

    socket.socket.connect = loopback_only
    assert not any(setup_status(root, {}).values())
    key = "sk-" + "offline" * 6
    password = "Public Example 2026!"
    created = configure(root, key=key, username="example_admin", password=password, confirmation=password, environ={})
    assert created["admin_created"]
    assert all(setup_status(root, {}).values())
    # Normal import/startup after the setup window creates the admin and .env.
    from app.main import app, BASE_DIR, deepseek_api_key
    assert BASE_DIR.resolve() == root
    assert deepseek_api_key() == key
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    server = uvicorn.Server(uvicorn.Config(app, log_level="error", access_log=False))
    thread = threading.Thread(target=server.run, kwargs={"sockets": [listener]}, daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + 15
        with httpx.Client(base_url=f"http://127.0.0.1:{listener.getsockname()[1]}", trust_env=False, timeout=2) as client:
            while not server.started and thread.is_alive() and time.monotonic() < deadline:
                time.sleep(.05)
            assert server.started, "Fresh API startup failed"
            assert client.get("/api/health").json()["database"] == "ok"
            wrong = client.post("/api/auth/login", json={"username": "example_admin", "password": "not-correct"})
            assert wrong.status_code == 401
            login = client.post("/api/auth/login", json={"username": "example_admin", "password": password})
            assert login.status_code == 200
            admin = login.json()
            assert admin["user"]["role"] == "admin"
            headers = {"Authorization": "Bearer " + admin["token"]}
            assert client.get("/api/me", headers=headers).json()["username"] == "example_admin"
            assert client.get("/api/admin/overview", headers=headers).status_code == 200
            assert client.get("/api/admin/overview").status_code == 401
            student = client.post("/api/auth/register", json={"username": "example_student", "password": "Example Student 2026!", "display_name": "虚构测试学生"})
            assert student.status_code == 200
            assert client.get("/api/admin/overview", headers={"Authorization": "Bearer " + student.json()["token"]}).status_code == 403
            for origin in ("http://127.0.0.1:4173", "http://127.0.0.1:5173"):
                preflight = client.options("/api/auth/login", headers={"Origin": origin, "Access-Control-Request-Method": "POST"})
                assert preflight.headers.get("access-control-allow-origin") == origin
            again = configure(root, key="", password="ignored", environ={})
            assert not again["admin_created"]
            assert client.post("/api/auth/login", json={"username": "example_admin", "password": password}).status_code == 200
        assert not external_attempts
        print(json.dumps({"fresh_api_started": True, "admin_login": True, "student_denied_admin": True, "repeat_setup_preserved_admin": True, "external_calls": 0}))
    finally:
        server.should_exit = True
        thread.join(10)
        listener.close()
        socket.socket.connect = original_connect
        assert not thread.is_alive(), "Disposable test server failed to stop"


if __name__ == "__main__":
    main()
