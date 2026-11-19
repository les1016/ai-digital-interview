"""Exercise ASR error responses without loading models or using real speech."""
import ast
import asyncio
import json
import logging
from pathlib import Path
import threading
import time
import unittest

try:
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer
    import numpy as np
except ImportError:
    web = None

SOURCE = Path(__file__).resolve().parents[1] / 'integrations/LiveTalking/server/asr_server.py'


@unittest.skipUnless(web is not None and SOURCE.exists(), 'Requires aiohttp, numpy and patched LiveTalking')
class ASRFailureTests(unittest.IsolatedAsyncioTestCase):
    def handler_namespace(self, infer):
        tree = ast.parse(SOURCE.read_text(encoding='utf-8'))
        nodes = [n for n in tree.body if isinstance(n, ast.AsyncFunctionDef) and n.name == 'asr_websocket_handler']
        namespace = dict(web=web, asyncio=asyncio, json=json, time=time, np=np,
                         logger=logging.getLogger('test.asr'), SAMPLE_RATE=16000,
                         MAX_AUDIO_BYTES=32000, ALLOWED_BROWSER_ORIGINS=set(),
                         ASR_APPOINTMENT_CONNECTIONS=set(),
                         _sensevoice_queue_slots=threading.BoundedSemaphore(1), _run_inference=infer)
        exec(compile(ast.Module(body=nodes, type_ignores=[]), str(SOURCE), 'exec'), namespace)
        return namespace

    async def test_model_failure_is_retryable_not_an_empty_answer(self):
        def unavailable(*args):
            raise RuntimeError('Synthetic model failure')

        namespace = self.handler_namespace(unavailable)
        app = web.Application()
        app.router.add_get('/asr', namespace['asr_websocket_handler'])
        async with TestClient(TestServer(app)) as client:
            for _ in range(2):
                ws = await client.ws_connect('/asr', protocols=['asr'])
                await ws.send_json({'is_speaking': True, 'mode': '2pass'})
                await ws.send_bytes(b'\0' * 1600)
                await ws.send_json({'is_speaking': False})
                payload = await ws.receive_json(timeout=3)
                self.assertEqual(payload['error'], 'asr_unavailable')
                self.assertTrue(payload['retryable'])
                self.assertTrue(payload['is_final'])
                await ws.close()

    async def test_appointment_cutoff_closes_asr_and_retains_slot_until_worker_completes(self):
        worker_started = threading.Event()
        worker_continue = threading.Event()

        def paused_worker(*args):
            worker_started.set()
            worker_continue.wait(6)
            return ('synthetic result', 0, .1)

        namespace = self.handler_namespace(paused_worker)
        deadline = time.time() + 1.5
        @web.middleware
        async def checked_in(request, handler):
            request['avatar_identity'] = {'appointment_id': 1, 'appointment_until': deadline}
            return await handler(request)

        app = web.Application(middlewares=[checked_in])
        app.router.add_get('/asr', namespace['asr_websocket_handler'])
        slots = namespace['_sensevoice_queue_slots']
        try:
            async with TestClient(TestServer(app)) as client:
                ws = await client.ws_connect('/asr', protocols=['asr'])
                self.assertEqual((await client.get('/asr')).status, 409)
                await ws.send_json({'is_speaking': True, 'mode': '2pass'})
                await ws.send_bytes(b'\0' * 1600)
                await ws.send_json({'is_speaking': False})
                self.assertTrue(await asyncio.to_thread(worker_started.wait, .7))
                msg = await ws.receive(timeout=3)
                self.assertEqual((msg.type, msg.data), (web.WSMsgType.CLOSE, 1008))
                self.assertEqual((await client.get('/asr')).status, 410)
                self.assertFalse(slots.acquire(blocking=False))
                worker_continue.set()
                self.assertTrue(await asyncio.to_thread(slots.acquire, True, 1))
                slots.release()
                self.assertFalse(namespace['ASR_APPOINTMENT_CONNECTIONS'])
        finally:
            worker_continue.set()
