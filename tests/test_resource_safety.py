"""Exercise resource failure paths without importing application configuration/data."""
from __future__ import annotations

import ast
import asyncio
from contextlib import contextmanager
import copy
import errno
import hashlib
import json
import logging
import os
from pathlib import Path
import shutil
import tempfile
import threading
from types import SimpleNamespace
import unittest
import uuid

from fastapi import HTTPException

from apps.server.app.coordination import Coordinator, CoordinationUnavailable


ROOT = Path(__file__).resolve().parents[1]
MAIN = ROOT / "apps/server/app/main.py"


def load_functions(names: set[str], namespace: dict) -> dict:
    """Compile the real functions while omitting routes, dependency defaults and app startup."""
    tree = ast.parse(MAIN.read_text(encoding="utf-8"))
    nodes = []
    found = set()
    for source in tree.body:
        if not isinstance(source, (ast.FunctionDef, ast.AsyncFunctionDef)) or source.name not in names:
            continue
        node = copy.deepcopy(source)
        found.add(node.name)
        node.decorator_list = [item for item in node.decorator_list
                               if isinstance(item, ast.Name) and item.id == "contextmanager"]
        # Endpoints receive explicit inputs in these tests. Do not evaluate Depends/File.
        node.args.defaults = [ast.Constant(None) for _ in node.args.defaults]
        nodes.append(node)
    if found != names:
        raise AssertionError(f"Missing real project functions: {sorted(names - found)}")
    future = ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0)
    exec(compile(ast.fix_missing_locations(ast.Module(body=[future, *nodes], type_ignores=[])),
                 str(MAIN), "exec"), namespace)
    return namespace


class StopBeforeDataAccess(RuntimeError):
    pass


class Slots:
    def __init__(self, failure: str = ""):
        self.failure = failure
        self.releases = 0

    def acquire(self, **_kwargs):
        if self.failure == "acquire":
            raise CoordinationUnavailable("synthetic Redis acquisition failure")
        return self.failure != "busy"

    def release(self):
        self.releases += 1
        if self.failure == "release":
            raise CoordinationUnavailable("synthetic Redis release failure")


class SharedRedisLocks:
    """A thread-safe Redis lock double shared by independent worker coordinators."""
    def __init__(self):
        self.values = {}
        self.mutex = threading.Lock()

    def set(self, key, value, *, nx, px):
        with self.mutex:
            if nx and key in self.values:
                return False
            self.values[key] = value
            return True

    def eval(self, script, _count, key, token, *_args):
        with self.mutex:
            if self.values.get(key) != token:
                return 0
            if "pexpire" not in script:
                del self.values[key]
            return 1


def worker_namespace(coordinator=None):
    def stop(*_args):
        raise StopBeforeDataAccess()

    namespace = {
        "contextmanager": contextmanager, "HTTPException": HTTPException,
        "threading": threading, "coordinator": coordinator or Coordinator(),
        "_operation_locks": {}, "_operation_locks_guard": threading.Lock(),
        "owned_interview": stop, "is_webm_upload": lambda _file: True,
        "rate_limit_document_preview": lambda *_args: None,
        "json": json, "uuid": uuid, "hashlib": hashlib,
        "shutil": shutil, "os": os, "errno": errno,
        "logger": logging.getLogger("resource-regression"),
        "MAX_RECORDING_BYTES": 800 * 1024 * 1024,
        "MAX_RECORDING_CHUNK_BYTES": 32 * 1024 * 1024,
        "MIN_FREE_DISK_BYTES": 0,
    }
    return load_functions({"operation_lock", "release_operation_lock", "operation_capacity",
                           "recording_quota_guard"}, namespace)


class MemoryUpload:
    def __init__(self, content):
        self.content = content

    async def read(self, _size):
        content, self.content = self.content, b""
        return content


def recording_worker(directory: Path, coordinator=None):
    namespace = worker_namespace(coordinator)
    namespace.update({
        "RECORDING_DIR": directory, "MAX_USER_RECORDING_BYTES": 100,
        "MAX_TOTAL_RECORDING_BYTES": 100, "_recording_write_slots": Slots(),
        "owned_interview": lambda interview_id, user, _db: SimpleNamespace(id=interview_id, user_id=user.id),
    })
    return load_functions({
        "interview_recording_path", "interview_recording_manifest_path", "recording_usage_bytes",
        "ensure_recording_quota", "archive_current_recording", "load_recording_manifest",
        "save_recording_manifest", "upload_interview_recording_chunk", "upload_interview_recording",
    }, namespace)


def upload(namespace, interview_id, content, *, chunked=True):
    file = MemoryUpload(content)
    if chunked:
        return asyncio.run(namespace["upload_interview_recording_chunk"](
            interview_id, "synthetic-upload-001", 0, file, True, SimpleNamespace(id=1), None))
    return asyncio.run(namespace["upload_interview_recording"](
        interview_id, file, SimpleNamespace(id=1), None))


class ResourceFailureTests(unittest.TestCase):
    def test_all_recording_and_document_endpoints_release_lock_on_redis_slot_failures(self):
        cases = [
            ("upload_interview_recording_chunk", "recording:1", True,
             (1, "synthetic-upload-001", 0, None, False, None, None)),
            ("upload_interview_recording", "recording:1", True, (1, None, None, None)),
            ("create_interview_document", "document:1:pdf", False,
             (1, SimpleNamespace(format="pdf"), None, None)),
            ("preview_unexported_interview_document", "document-preview:1:pdf", False,
             (1, None, "pdf", None, SimpleNamespace(get=lambda *_args: (_ for _ in ()).throw(StopBeforeDataAccess())))),
        ]
        for name, key, asynchronous, args in cases:
            for failure in ("acquire", "release"):
                with self.subTest(endpoint=name, failure=failure):
                    namespace = worker_namespace()
                    slots = Slots(failure)
                    namespace.update(_recording_write_slots=slots, _document_preview_slots=slots)
                    load_functions({name}, namespace)
                    with self.assertRaises((CoordinationUnavailable, StopBeforeDataAccess)):
                        value = namespace[name](*args)
                        if asynchronous:
                            asyncio.run(value)
                    # Check actual lock reuse, not merely dictionary removal.
                    lock = namespace["operation_lock"](key)
                    self.assertTrue(lock.acquire(blocking=False))
                    namespace["release_operation_lock"](key, lock)
                    self.assertEqual(slots.releases, 0 if failure == "acquire" else 1)

    def test_busy_capacity_releases_operation_without_releasing_unacquired_slot(self):
        namespace = worker_namespace()
        slots = Slots("busy")
        with self.assertRaises(HTTPException) as caught:
            with namespace["operation_capacity"]("recording:1", slots,
                                                  busy_message="busy", overload_message="overload"):
                self.fail("A busy slot must not enter the operation")
        self.assertEqual(caught.exception.status_code, 429)
        self.assertEqual(slots.releases, 0)
        lock = namespace["operation_lock"]("recording:1")
        self.assertTrue(lock.acquire(blocking=False))
        namespace["release_operation_lock"]("recording:1", lock)


class RecordingQuotaTests(unittest.TestCase):
    def test_crash_recovery_uses_the_same_quota_commit_lock(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            trash = directory / ".trash" / "interview-1-recover"
            trash.mkdir(parents=True)
            source = trash / "user-1-interview-1.webm"
            source.write_bytes(b"a" * 90)
            namespace = recording_worker(directory)
            namespace["Interview"] = object
            load_functions({"reconcile_recording_trash"}, namespace)
            database = SimpleNamespace(get=lambda *_: True)
            with namespace["recording_quota_guard"]():
                with self.assertRaises(HTTPException) as busy:
                    namespace["reconcile_recording_trash"](database)
                self.assertEqual(busy.exception.status_code, 429)
                self.assertTrue(source.exists())
            namespace["reconcile_recording_trash"](database)
            self.assertFalse(source.exists())
            self.assertEqual(namespace["recording_usage_bytes"](), 90)
            self.assertEqual((directory / source.name).read_bytes(), b"a" * 90)

    def test_quarantined_recordings_keep_their_quota_until_erased(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            trash = directory / ".trash" / "interview-1-crash-recovery"
            trash.mkdir(parents=True)
            quarantined = trash / "user-1-interview-1.webm"
            quarantined.write_bytes(b"a" * 90)
            namespace = recording_worker(directory)
            self.assertEqual(namespace["recording_usage_bytes"](), 90)
            self.assertEqual(namespace["recording_usage_bytes"](1), 90)
            self.assertEqual(namespace["recording_usage_bytes"](2), 0)
            with self.assertRaises(HTTPException) as denied:
                upload(namespace, 2, b"b" * 20, chunked=True)
            self.assertEqual(denied.exception.status_code, 507)
            quarantined.unlink()
            self.assertTrue(upload(namespace, 2, b"b" * 20, chunked=True)["saved"])

    def test_chunk_workers_serialize_commit_and_reject_retry_above_quota(self):
        self.check_independent_workers_serialize_commit(chunked=True)

    def test_full_upload_workers_serialize_commit_and_reject_retry_above_quota(self):
        self.check_independent_workers_serialize_commit(chunked=False)

    def check_independent_workers_serialize_commit(self, *, chunked):
        shared_redis = SharedRedisLocks()
        workers = [Coordinator(namespace="quota-regression") for _ in range(2)]
        for worker in workers:
            worker._client = shared_redis
        with tempfile.TemporaryDirectory(prefix="recording-quota-") as temporary:
            directory = Path(temporary)
            original = directory / "user-1-interview-1.webm"
            original.write_bytes(b"a" * 70)
            namespaces = [recording_worker(directory, worker) for worker in workers]
            checking = threading.Event()
            continue_first = threading.Event()
            first_result = []
            actual_check = namespaces[0]["ensure_recording_quota"]

            def pause_at_final_check(*args, **kwargs):
                actual_check(*args, **kwargs)
                checking.set()
                if not continue_first.wait(timeout=5):
                    raise RuntimeError("Test did not release final quota check")

            namespaces[0]["ensure_recording_quota"] = pause_at_final_check

            def first_upload():
                try:
                    first_result.append(upload(namespaces[0], 2, b"b" * 20, chunked=chunked))
                except Exception as error:
                    first_result.append(error)

            first = threading.Thread(target=first_upload)
            first.start()
            try:
                self.assertTrue(checking.wait(timeout=3), "Upload never reached the protected final check")
                # A busy distributed lock must return 429 immediately; blocking here would
                # stall an async worker. A timer only prevents a broken implementation hanging tests.
                rescue = threading.Timer(1, continue_first.set)
                rescue.start()
                try:
                    with self.assertRaises(HTTPException) as busy:
                        upload(namespaces[1], 3, b"c" * 20, chunked=chunked)
                    self.assertEqual(busy.exception.status_code, 429)
                    self.assertFalse(continue_first.is_set(), "Busy quota guard blocked the worker")
                finally:
                    rescue.cancel()
            finally:
                continue_first.set()
                first.join(timeout=4)
            self.assertFalse(first.is_alive())
            self.assertEqual(len(first_result), 1)
            self.assertIsInstance(first_result[0], dict, first_result)
            self.assertTrue(first_result[0]["saved"])
            with self.assertRaises(HTTPException) as denied:
                upload(namespaces[1], 3, b"c" * 20, chunked=chunked)
            self.assertEqual(denied.exception.status_code, 507)
            self.assertEqual(namespaces[0]["recording_usage_bytes"](), 90)
            self.assertEqual(original.read_bytes(), b"a" * 70)
            self.assertFalse((directory / "user-1-interview-3.webm").exists())
            self.assertFalse(shared_redis.values, "All acquired worker leases must be released")

    def test_quota_rejection_preserves_original_for_both_upload_paths(self):
        for chunked in (False, True):
            with self.subTest(chunked=chunked), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                original = directory / "user-1-interview-1.webm"
                original.write_bytes(b"original" * 10)
                namespace = recording_worker(directory)
                # Full replacement frees the original; a new chunk session archives it.
                proposed = b"b" * (110 if not chunked else 40)
                with self.assertRaises(HTTPException) as denied:
                    upload(namespace, 1, proposed, chunked=chunked)
                self.assertEqual(denied.exception.status_code, 507)
                self.assertEqual(original.read_bytes(), b"original" * 10)
                self.assertEqual(list(directory.glob("*.tmp")), [])
                self.assertEqual(list(directory.glob("*.session-*.webm")), [])


if __name__ == "__main__":
    unittest.main()
