"""Exercise the production middleware over HTTP without loading GPU models."""
import ast
from contextlib import closing
import json
import os
import sqlite3
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

try:
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer
except ImportError:
    web = None

ROOT = Path(__file__).resolve().parents[1]
ROUTES = ROOT / 'integrations/LiveTalking/server/routes.py'


@unittest.skipUnless(web is not None and ROUTES.exists(), 'Requires aiohttp and patched LiveTalking checkout')
class AvatarAccessTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.sessions = {}
        tree = ast.parse(ROUTES.read_text(encoding='utf-8'))
        nodes = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                 and node.name in {'local_avatar_identity', 'authenticated_avatar_user', 'avatar_access_control'}]
        self.namespace = {'web': web, 'json': json,
                          'get_session': lambda request, sid: self.sessions.get(sid)}
        exec(compile(ast.Module(body=nodes, type_ignores=[]), str(ROUTES), 'exec'), self.namespace)

        async def identity(request):
            value = request.headers.get('Authorization')
            identities = {'Bearer owner': (1, 'student'), 'Bearer other': (2, 'student'),
                          'Bearer admin': (3, 'admin')}
            if value not in identities:
                raise web.HTTPUnauthorized()
            uid, role = identities[value]
            return web.json_response({'id': uid, 'role': role})

        auth = web.Application()
        auth.router.add_get('/api/me', identity)
        self.auth_server = TestServer(auth)
        await self.auth_server.start_server()
        self.env = patch.dict(os.environ, {'INTERVIEW_AUTH_URL': str(self.auth_server.make_url('/api/me'))})
        self.env.start()

        async def offer(request):
            self.sessions['session-1'] = SimpleNamespace()
            return web.json_response({'sessionid': 'session-1'})

        async def ok(request):
            return web.json_response({'ok': True})

        async def socket(request):
            ws = web.WebSocketResponse(protocols=('asr',))
            await ws.prepare(request)
            await ws.send_str('authorized')
            await ws.close()
            return ws

        app = web.Application(middlewares=[self.namespace['avatar_access_control']])
        app.router.add_post('/offer', offer)
        app.router.add_post('/human', ok)
        app.router.add_post('/api/session/close', ok)
        app.router.add_get('/api/admin/sessions', ok)
        app.router.add_get('/api/asr', socket)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        self.env.stop()
        await self.auth_server.close()

    async def test_local_identity_validates_ticket_scope_signature_and_lifetime(self):
        import jwt
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "data").mkdir()
            secret = "local-test-signing-key-at-least-32-chars"
            (root / ".env").write_text("JWT_SECRET=" + secret + "\n", encoding="utf-8")
            with closing(sqlite3.connect(root / "data/ai_interview.db")) as db:
                db.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, role TEXT)")
                db.execute("INSERT INTO users VALUES (1, 'student')")
                db.commit()
            now = datetime.now(timezone.utc)
            def token(**changes):
                claims = {"sub": "1", "exp": now + timedelta(seconds=120), "iat": now, "purpose": "avatar", "role": "student"}
                claims.update(changes)
                return jwt.encode(claims, secret, algorithm="HS256")
            with patch.dict(os.environ, {"INTERVIEW_AUTH_MODE": "local-ticket", "INTERVIEW_PROJECT_ROOT": str(root),
                                         "APP_ENV": "development", "DATABASE_URL": "", "JWT_SECRET": ""}):
                # Match dotenv precedence when no environment signing override exists.
                os.environ.pop("JWT_SECRET")
                verify = self.namespace["local_avatar_identity"]
                self.assertEqual(verify(token()), {"id": 1, "role": "student"})
                for invalid in [token(purpose="interview_interruption"), token(purpose="access"),
                                token(exp=now + timedelta(minutes=5)),
                                token(exp=now - timedelta(seconds=1)), token() + "tampered"]:
                    with self.assertRaises(web.HTTPUnauthorized):
                        verify(invalid)
                os.environ["APP_ENV"] = "production"
                with self.assertRaises(RuntimeError):
                    verify(token())

    async def test_admin_routes_require_admin(self):
        for token, expected in [(None, 401), ('owner', 403), ('admin', 200)]:
            headers = {'Authorization': 'Bearer ' + token} if token else {}
            response = await self.client.get('/api/admin/sessions', headers=headers)
            self.assertEqual(response.status, expected)

    async def test_offer_binds_owner_and_rejects_cross_user_control(self):
        response = await self.client.post('/offer', headers={'Authorization': 'Bearer owner'},
                                          json={'sdp': 'test', 'type': 'offer'})
        self.assertEqual(response.status, 200)
        for token, expected in [('other', 403), ('owner', 200), ('admin', 200)]:
            response = await self.client.post('/api/session/close',
                headers={'Authorization': 'Bearer ' + token}, json={'sessionid': 'session-1'})
            self.assertEqual(response.status, expected)

    async def test_student_cannot_override_avatar_parameters(self):
        response = await self.client.post('/offer', headers={'Authorization': 'Bearer owner'},
            json={'sdp': 'test', 'type': 'offer', 'avatar_id': 'arbitrary'})
        self.assertEqual(response.status, 403)
        self.assertFalse(self.sessions)

    async def test_websocket_authentication(self):
        response = await self.client.get('/api/asr')
        self.assertEqual(response.status, 401)
        ws = await self.client.ws_connect('/api/asr', protocols=['asr', 'auth.owner'])
        self.assertEqual(ws.protocol, 'asr')
        self.assertEqual((await ws.receive()).data, 'authorized')
        await ws.close()

    async def test_auth_service_failure_denies_access(self):
        await self.auth_server.close()
        response = await self.client.get('/api/admin/sessions', headers={'Authorization': 'Bearer admin'})
        self.assertEqual(response.status, 503)
