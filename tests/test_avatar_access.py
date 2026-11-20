"""Exercise the production middleware over HTTP without loading GPU models."""
import ast
import asyncio
from contextlib import closing
import json
import logging
import os
import sqlite3
import sys
import tempfile
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Dict, Optional
import unittest
from unittest.mock import patch

try:
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer
except ImportError:
    web = None

ROOT = Path(__file__).resolve().parents[1]
ROUTES = ROOT / 'integrations/LiveTalking/server/routes.py'
RTC = ROUTES.with_name('rtc_manager.py')
SESSION_MANAGER = ROUTES.with_name('session_manager.py')


@unittest.skipUnless(web is not None and ROUTES.exists(), 'Requires aiohttp and patched LiveTalking checkout')
class AvatarAccessTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.sessions = {}
        tree = ast.parse(ROUTES.read_text(encoding='utf-8'))
        nodes = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                 and node.name in {'avatar_identity_scope', 'local_avatar_identity', 'authenticated_avatar_user', 'avatar_access_control'}]
        self.namespace = {'web': web, 'json': json, 'time': time, 'asyncio': asyncio,
                          'get_session': lambda request, sid: self.sessions.get(sid)}
        exec(compile(ast.Module(body=nodes, type_ignores=[]), str(ROUTES), 'exec'), self.namespace)

        async def identity(request):
            value = request.headers.get('Authorization')
            deadline = int(time.time()) + 90
            identities = {
                'Bearer owner': {'id': 1, 'role': 'student', 'appointment_id': 11, 'appointment_until': deadline},
                'Bearer other': {'id': 2, 'role': 'student', 'appointment_id': 22, 'appointment_until': deadline},
                'Bearer different-appointment': {'id': 1, 'role': 'student', 'appointment_id': 32, 'appointment_until': deadline},
                'Bearer expired': {'id': 1, 'role': 'student', 'appointment_id': 11, 'appointment_until': deadline - 100},
                'Bearer admin': {'id': 3, 'role': 'admin', 'avatar_preview': True},
                'Bearer booked-admin': {'id': 3, 'role': 'admin', 'appointment_id': 33, 'appointment_until': deadline},
                'Bearer old-student': {'id': 1, 'role': 'student'},
            }
            if value not in identities:
                raise web.HTTPUnauthorized()
            return web.json_response(identities[value])

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
                claims = {"sub": "1", "exp": now + timedelta(seconds=120), "iat": now, "purpose": "avatar", "role": "student",
                          "appointment_id": 11, "appointment_until": int(now.timestamp()) + 90}
                claims.update(changes)
                return jwt.encode(claims, secret, algorithm="HS256")
            with patch.dict(os.environ, {"INTERVIEW_AUTH_MODE": "local-ticket", "INTERVIEW_PROJECT_ROOT": str(root),
                                         "APP_ENV": "development", "DATABASE_URL": "", "JWT_SECRET": ""}):
                # Match dotenv precedence when no environment signing override exists.
                os.environ.pop("JWT_SECRET")
                verify = self.namespace["local_avatar_identity"]
                self.assertEqual(verify(token()), {"id": 1, "role": "student", "appointment_id": 11,
                                                   "appointment_until": int(now.timestamp()) + 90})
                with self.assertRaises(web.HTTPForbidden):
                    verify(token(appointment_id=None, appointment_until=None))
                for invalid in [token(purpose="interview_interruption"), token(purpose="access"),
                                token(exp=now + timedelta(minutes=5)),
                                token(appointment_id=True), token(appointment_id=None), token(avatar_preview=True),
                                token(exp=now - timedelta(seconds=1)), token() + "tampered"]:
                    with self.assertRaises(web.HTTPUnauthorized):
                        verify(invalid)
                os.environ["APP_ENV"] = "production"
                with self.assertRaises(RuntimeError):
                    verify(token())

    async def test_admin_routes_require_admin(self):
        for token, expected in [(None, 401), ('owner', 403), ('booked-admin', 403), ('admin', 200)]:
            headers = {'Authorization': 'Bearer ' + token} if token else {}
            response = await self.client.get('/api/admin/sessions', headers=headers)
            self.assertEqual(response.status, expected)

    async def test_offer_binds_owner_and_rejects_cross_user_control(self):
        response = await self.client.post('/offer', headers={'Authorization': 'Bearer owner'},
                                          json={'sdp': 'test', 'type': 'offer'})
        self.assertEqual(response.status, 200)
        for token, expected in [('other', 403), ('different-appointment', 403), ('owner', 200),
                                ('expired', 200), ('booked-admin', 403), ('admin', 200)]:
            response = await self.client.post('/api/session/close',
                headers={'Authorization': 'Bearer ' + token}, json={'sessionid': 'session-1'})
            self.assertEqual(response.status, expected)

    async def test_student_cannot_override_avatar_parameters(self):
        response = await self.client.post('/offer', headers={'Authorization': 'Bearer owner'},
            json={'sdp': 'test', 'type': 'offer', 'avatar_id': 'arbitrary'})
        self.assertEqual(response.status, 403)
        self.assertFalse(self.sessions)

    async def test_new_connection_and_speech_require_a_live_booked_scope(self):
        for token, expected in [('old-student', 403), ('expired', 410)]:
            headers = {'Authorization': 'Bearer ' + token}
            offer = await self.client.post('/offer', headers=headers, json={'sdp': 'test', 'type': 'offer'})
            self.assertEqual(offer.status, expected)
            speech = await self.client.post('/human', headers=headers,
                                            json={'sessionid': 'session-1', 'type': 'echo'})
            self.assertEqual(speech.status, expected)
            ws = await self.client.get('/api/asr', headers=headers)
            self.assertEqual(ws.status, expected)

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


@unittest.skipUnless(web is not None and RTC.exists(), 'Requires aiohttp and patched LiveTalking checkout')
class RTCScopeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.build_entered = asyncio.Event()
        self.build_continue = asyncio.Event()
        self.build_continue.set()
        self.session_items = {}
        self.connection_block = False
        self.peer_count = 0
        self.player_count = 0
        self.stop_count = 0

        async def create(params):
            self.build_entered.set()
            await self.build_continue.wait()
            self.session_items['rtc-1'] = SimpleNamespace()
            return 'rtc-1'

        class PC:
            def __init__(pc, **kw):
                self.peer_count += 1
                pc.connectionState = 'new'

            def on(self, name, cb):
                self.cb = cb

            def addTrack(self, track):
                pass

            def getTransceivers(self):
                return [None, SimpleNamespace(setCodecPreferences=lambda _: None)]

            async def setRemoteDescription(pc, offer):
                if self.connection_block:
                    await asyncio.Event().wait()

            async def createAnswer(self):
                return SimpleNamespace(sdp='answer', type='answer')

            async def setLocalDescription(self, answer):
                self.localDescription = answer
                self.connectionState = 'connected'

            async def close(self):
                self.connectionState = 'closed'
                await self.cb()

        def player(avatar):
            self.player_count += 1

            def stop():
                self.stop_count += 1
            return SimpleNamespace(audio=None, video=None, stop=stop)

        self.modules = patch.dict(sys.modules, {'server.webrtc': SimpleNamespace(HumanPlayer=player)})
        self.modules.start()
        self.addCleanup(self.modules.stop)
        tree = ast.parse(RTC.read_text(encoding='utf-8'))
        nodes = [node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'RTCManager']
        namespace = dict(web=web, time=time, asyncio=asyncio, os=os, Dict=Dict,
                         logger=logging.getLogger('test.avatar.rtc'), RTCPeerConnection=PC,
                         RTCSessionDescription=SimpleNamespace, RTCConfiguration=SimpleNamespace,
                         RTCIceServer=SimpleNamespace,
                         RTCRtpSender=SimpleNamespace(getCapabilities=lambda _: SimpleNamespace(codecs=[])),
                         MaxSessionError=type('MaxSessionError', (Exception,), {}),
                         session_manager=SimpleNamespace(create_session=create, get_session=self.session_items.get,
                                                         remove_session=self.session_items.pop))
        exec(compile(ast.Module(body=nodes, type_ignores=[]), str(RTC), 'exec'), namespace)
        self.namespace = namespace
        self.manager = namespace['RTCManager'](SimpleNamespace(stun='stun:127.0.0.1:9'))

    def request(self, deadline, *, appointment_id=90):
        class Request(dict):
            async def json(self):
                return {'sdp': 'fixture offer', 'type': 'offer'}
        identity = {'id': 1, 'role': 'student', 'appointment_id': appointment_id,
                    'appointment_until': deadline} if appointment_id is not None else {
                        'id': 1, 'role': 'admin', 'avatar_preview': True}
        return Request(avatar_identity=identity)

    def install_threaded_session_manager(self, builder):
        # Run production capacity accounting/cancellation without importing avatar models.
        tree = ast.parse(SESSION_MANAGER.read_text(encoding='utf-8'))
        nodes = [node for node in tree.body if not isinstance(node, (ast.Import, ast.ImportFrom))]
        scope = dict(asyncio=asyncio, uuid=uuid, Dict=Dict, Optional=Optional,
                     BaseAvatar=SimpleNamespace, logger=logging.getLogger('test.avatar.capacity'))
        exec(compile(ast.Module(body=nodes, type_ignores=[]), str(SESSION_MANAGER), 'exec'), scope)
        manager = scope['session_manager']
        manager.init_builder(builder)
        self.namespace.update(session_manager=manager, MaxSessionError=scope['MaxSessionError'])
        self.session_items = manager.sessions

    def assert_released(self):
        self.assertFalse(self.session_items)
        self.assertFalse(self.manager.appointment_claims)
        self.assertFalse(self.manager.connections)
        self.assertFalse(self.manager.pcs)

    async def test_one_offer_even_while_initializing_then_expiry_releases_resources(self):
        self.build_continue.clear()
        setup = asyncio.create_task(self.manager.handle_offer(self.request(time.time() + 1.0)))
        await asyncio.wait_for(self.build_entered.wait(), 1)
        with self.assertRaises(web.HTTPConflict):
            await self.manager.handle_offer(self.request(time.time() + 10))
        self.build_continue.set()
        self.assertEqual((await setup).status, 200)
        self.assertEqual(self.session_items['rtc-1'].appointment_id, 90)
        for _ in range(30):
            await asyncio.sleep(.05)
            if not self.session_items:
                break
        self.assertEqual(self.stop_count, 1)
        self.assert_released()

    async def test_offer_negotiation_cannot_keep_resources_after_deadline(self):
        self.connection_block = True
        with self.assertRaises(web.HTTPGone):
            await self.manager.handle_offer(self.request(time.time() + .15))
        self.assertEqual(self.stop_count, 1)
        self.assert_released()

    async def test_offer_initialization_times_out_but_worker_stays_counted_until_exit(self):
        loop = asyncio.get_running_loop()
        release_worker = threading.Event()
        worker_ended = threading.Event()

        def builder(session_id, params):
            loop.call_soon_threadsafe(self.build_entered.set)
            if not release_worker.wait(8):
                raise RuntimeError('Test did not unblock the avatar constructor')
            worker_ended.set()
            return SimpleNamespace()

        self.install_threaded_session_manager(builder)
        offer = asyncio.create_task(self.manager.handle_offer(self.request(time.time() + 1)))
        try:
            await asyncio.wait_for(self.build_entered.wait(), 2)
            with self.assertRaises(web.HTTPGone):
                # The test's guard timeout must not cancel the actual offer.
                await asyncio.wait_for(asyncio.shield(offer), 3)
            self.assertFalse(worker_ended.is_set())
            self.assertFalse(self.manager.appointment_claims)
            self.assertEqual(list(self.session_items.values()), [None])
            self.assertEqual((self.peer_count, self.player_count), (0, 0))

            different_offer = self.request(time.time() + 10, appointment_id=91)
            busy_response = await self.manager.handle_offer(different_offer)
            self.assertEqual(json.loads(busy_response.text)['code'], -1)
            self.assertEqual(list(self.session_items.values()), [None])
            self.assertFalse(self.manager.appointment_claims)
        finally:
            release_worker.set()
            await asyncio.gather(offer, return_exceptions=True)

        async with asyncio.timeout(3):
            while self.session_items:
                await asyncio.sleep(.01)
        self.assertTrue(worker_ended.is_set())
        self.assertEqual((self.peer_count, self.player_count), (0, 0))
        self.assert_released()
        other = await self.manager.handle_offer(self.request(time.time() + 10, appointment_id=91))
        payload = json.loads(other.text)
        self.assertEqual(other.status, 200)
        self.assertEqual(self.session_items[payload['sessionid']].appointment_id, 91)
        self.assertTrue(await self.manager.close_session(payload['sessionid']))
        self.assert_released()

    async def test_offer_initialization_checks_elapsed_deadline_before_creating_peer(self):
        wall_time = 100.0
        self.namespace['time'] = SimpleNamespace(time=lambda: wall_time)
        create = self.namespace['session_manager'].create_session

        async def late_create(params):
            nonlocal wall_time
            session_id = await create(params)
            wall_time = 101.0  # Simulate completion exactly at the cutoff without a timer tick.
            return session_id

        self.namespace['session_manager'].create_session = late_create
        with self.assertRaises(web.HTTPGone):
            await self.manager.handle_offer(self.request(101.0))
        self.assertEqual((self.peer_count, self.player_count), (0, 0))
        self.assert_released()

    async def test_offer_initialization_does_not_relabel_own_timeout_as_expiration(self):
        async def failing_create(params):
            raise TimeoutError('avatar builder timeout')

        self.namespace['session_manager'].create_session = failing_create
        with self.assertRaisesRegex(TimeoutError, 'avatar builder timeout'):
            await self.manager.handle_offer(self.request(time.time() + 10))
        self.assert_released()

    async def test_offer_initialization_without_appointment_remains_unbounded(self):
        self.build_continue.clear()
        offer = asyncio.create_task(self.manager.handle_offer(self.request(None, appointment_id=None)))
        try:
            await asyncio.wait_for(self.build_entered.wait(), 2)
            self.assertFalse(offer.done())
            self.assertFalse(self.manager.appointment_claims)
        finally:
            self.build_continue.set()
            response = await asyncio.wait_for(offer, 2)
        self.assertEqual(response.status, 200)
        self.assertIsNone(self.session_items['rtc-1'].appointment_id)
        self.assertTrue(await self.manager.close_session('rtc-1'))
        self.assert_released()

    async def test_explicit_close_releases_scope_and_allows_reconnect_before_deadline(self):
        request = self.request(time.time() + 10)
        self.assertEqual((await self.manager.handle_offer(request)).status, 200)
        self.assertTrue(await self.manager.close_session('rtc-1'))
        self.assert_released()
        self.assertEqual((await self.manager.handle_offer(request)).status, 200)
        self.assertTrue(await self.manager.close_session('rtc-1'))
        self.assert_released()
        self.assertEqual(self.stop_count, 2)

    async def test_scoped_offer_receives_local_webrtc_video_without_gpu(self):
        try:
            from aiortc import AudioStreamTrack, VideoStreamTrack, RTCPeerConnection, RTCConfiguration, RTCIceServer, RTCSessionDescription
            from aiortc.rtcrtpsender import RTCRtpSender
        except ImportError:
            self.skipTest('Requires aiortc')

        self.namespace.update(RTCPeerConnection=RTCPeerConnection, RTCConfiguration=RTCConfiguration,
                              RTCIceServer=RTCIceServer, RTCSessionDescription=RTCSessionDescription,
                              RTCRtpSender=RTCRtpSender)

        def player(avatar):
            audio, video = AudioStreamTrack(), VideoStreamTrack()
            def stop():
                video.stop()
                audio.stop()
                self.stop_count += 1
            return SimpleNamespace(audio=audio, video=video, stop=stop)

        sys.modules['server.webrtc'].HumanPlayer = player
        client = RTCPeerConnection(configuration=RTCConfiguration(iceServers=[]))
        client.addTransceiver('audio', direction='recvonly')
        client.addTransceiver('video', direction='recvonly')
        tracks = {}
        client.on('track', lambda track: tracks.update({track.kind: track}))

        class Offer(dict):
            async def json(self):
                return {'sdp': client.localDescription.sdp, 'type': 'offer'}

        try:
            await client.setLocalDescription(await client.createOffer())
            response = await self.manager.handle_offer(Offer(avatar_identity={
                'id': 1, 'role': 'student', 'appointment_id': 90, 'appointment_until': time.time() + 15,
            }))
            payload = json.loads(response.text)
            await client.setRemoteDescription(RTCSessionDescription(sdp=payload['sdp'], type=payload['type']))
            frame = await asyncio.wait_for(tracks['video'].recv(), 6)
            self.assertGreater(frame.width, 0)
            self.assertTrue(await self.manager.close_session(payload['sessionid']))
            self.assert_released()
        finally:
            await client.close()
            await self.manager.shutdown()
