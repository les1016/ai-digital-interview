from __future__ import annotations

from collections import defaultdict, deque
import os
import secrets
import threading
import time
import weakref
from typing import Any


class CoordinationUnavailable(RuntimeError):
    pass


class LeaseLock:
    """A process-local lock optionally backed by a renewable Redis lease."""

    _RELEASE_SCRIPT = """
    if redis.call('get', KEYS[1]) == ARGV[1] then
      return redis.call('del', KEYS[1])
    end
    return 0
    """
    _RENEW_SCRIPT = """
    if redis.call('get', KEYS[1]) == ARGV[1] then
      return redis.call('pexpire', KEYS[1], ARGV[2])
    end
    return 0
    """

    def __init__(self, client: Any | None, key: str, lease_seconds: int) -> None:
        self._client = client
        self._key = key
        self._lease_ms = max(5, lease_seconds) * 1000
        self._local = threading.Lock()
        self._token: str | None = None
        self._renew_stop: threading.Event | None = None
        self._renew_thread: threading.Thread | None = None

    def acquire(self, blocking: bool = True, timeout: float = -1) -> bool:
        started = time.monotonic()
        if timeout is None:
            timeout = -1
        while True:
            if not self._local.acquire(blocking=False):
                if not blocking:
                    return False
            else:
                token = secrets.token_urlsafe(24)
                try:
                    acquired = self._client is None or bool(
                        self._client.set(self._key, token, nx=True, px=self._lease_ms)
                    )
                except Exception as exc:
                    self._local.release()
                    raise CoordinationUnavailable("Redis lock acquisition failed") from exc
                if acquired:
                    self._token = token
                    if self._client is not None:
                        self._start_renewal()
                    return True
                self._local.release()

            if not blocking:
                return False
            if timeout >= 0 and time.monotonic() - started >= timeout:
                return False
            time.sleep(0.025)

    def _start_renewal(self) -> None:
        stop = threading.Event()
        self._renew_stop = stop

        def renew() -> None:
            interval = max(1.0, self._lease_ms / 3000)
            while not stop.wait(interval):
                token = self._token
                if not token:
                    return
                try:
                    renewed = self._client.eval(
                        self._RENEW_SCRIPT, 1, self._key, token, self._lease_ms
                    )
                except Exception:
                    return
                if not renewed:
                    return

        self._renew_thread = threading.Thread(
            target=renew,
            name=f"redis-lease-{self._key[-32:]}",
            daemon=True,
        )
        self._renew_thread.start()

    def release(self) -> None:
        if not self._local.locked():
            raise RuntimeError("release unlocked lock")
        stop, thread = self._renew_stop, self._renew_thread
        if stop:
            stop.set()
        if thread and thread is not threading.current_thread():
            thread.join(timeout=1)
        token = self._token
        self._token = None
        self._renew_stop = None
        self._renew_thread = None
        try:
            if self._client is not None and token:
                self._client.eval(self._RELEASE_SCRIPT, 1, self._key, token)
        finally:
            self._local.release()

    def locked(self) -> bool:
        return self._local.locked()


class LeaseSemaphore:
    """A bounded semaphore shared by workers through expiring Redis entries."""

    _ACQUIRE_SCRIPT = """
    redis.call('zremrangebyscore', KEYS[1], '-inf', ARGV[1])
    if redis.call('zcard', KEYS[1]) >= tonumber(ARGV[2]) then
      return 0
    end
    redis.call('zadd', KEYS[1], ARGV[3], ARGV[4])
    redis.call('pexpire', KEYS[1], ARGV[5])
    return 1
    """

    def __init__(self, client: Any | None, key: str, limit: int, lease_seconds: int) -> None:
        self._client = client
        self._key = key
        self._limit = max(1, limit)
        self._lease_ms = max(5, lease_seconds) * 1000
        self._local = threading.BoundedSemaphore(self._limit) if client is None else None
        self._tokens = threading.local()

    def acquire(self, blocking: bool = True, timeout: float | None = None) -> bool:
        if self._local is not None:
            if not blocking:
                return self._local.acquire(blocking=False)
            return self._local.acquire(timeout=timeout) if timeout is not None else self._local.acquire()

        started = time.monotonic()
        while True:
            now_ms = int(time.time() * 1000)
            token = secrets.token_urlsafe(24)
            try:
                acquired = bool(self._client.eval(
                    self._ACQUIRE_SCRIPT,
                    1,
                    self._key,
                    now_ms,
                    self._limit,
                    now_ms + self._lease_ms,
                    token,
                    self._lease_ms,
                ))
            except Exception as exc:
                raise CoordinationUnavailable("Redis semaphore acquisition failed") from exc
            if acquired:
                stack = getattr(self._tokens, "stack", None)
                if stack is None:
                    stack = []
                    self._tokens.stack = stack
                stack.append(token)
                return True
            if not blocking:
                return False
            if timeout is not None and time.monotonic() - started >= timeout:
                return False
            time.sleep(0.05)

    def release(self) -> None:
        if self._local is not None:
            self._local.release()
            return
        stack = getattr(self._tokens, "stack", None)
        if not stack:
            raise RuntimeError("release un-acquired semaphore")
        token = stack.pop()
        try:
            self._client.zrem(self._key, token)
        except Exception as exc:
            raise CoordinationUnavailable("Redis semaphore release failed") from exc


class Coordinator:
    def __init__(self, redis_url: str = "", namespace: str = "ai-interview") -> None:
        self.namespace = namespace.strip(":") or "ai-interview"
        self._client: Any | None = None
        self._local_windows: dict[str, deque[float]] = defaultdict(deque)
        self._local_windows_lock = threading.Lock()
        self._locks = weakref.WeakValueDictionary()
        self._locks_guard = threading.Lock()
        if redis_url:
            try:
                import redis
            except ImportError as exc:
                raise CoordinationUnavailable(
                    "REDIS_URL is configured but the redis package is not installed"
                ) from exc
            self._client = redis.Redis.from_url(
                redis_url,
                decode_responses=True,
                socket_connect_timeout=3,
                socket_timeout=3,
                health_check_interval=30,
            )

    @classmethod
    def from_env(cls) -> "Coordinator":
        return cls(
            os.getenv("REDIS_URL", "").strip(),
            os.getenv("REDIS_NAMESPACE", "ai-interview").strip(),
        )

    @property
    def distributed(self) -> bool:
        return self._client is not None

    def _key(self, kind: str, name: str) -> str:
        return f"{self.namespace}:{kind}:{name}"

    def ping(self) -> bool:
        return self._client is None or bool(self._client.ping())

    def lock(self, name: str, lease_seconds: int = 180) -> LeaseLock:
        with self._locks_guard:
            key = self._key("lock", name)
            lock = self._locks.get(key)
            if lock is None:
                lock = LeaseLock(self._client, key, lease_seconds)
                self._locks[key] = lock
            return lock

    def semaphore(self, name: str, limit: int, lease_seconds: int = 180) -> LeaseSemaphore:
        return LeaseSemaphore(
            self._client,
            self._key("semaphore", name),
            limit,
            lease_seconds,
        )

    def rate_limit(self, name: str, limit: int, window_seconds: int) -> bool:
        key = self._key("rate", name)
        if self._client is not None:
            try:
                pipeline = self._client.pipeline(transaction=True)
                pipeline.incr(key)
                pipeline.expire(key, max(1, window_seconds), nx=True)
                count, _ = pipeline.execute()
                return int(count) <= limit
            except Exception as exc:
                raise CoordinationUnavailable("Redis rate limiter failed") from exc

        now = time.monotonic()
        cutoff = now - window_seconds
        with self._local_windows_lock:
            attempts = self._local_windows[key]
            while attempts and attempts[0] < cutoff:
                attempts.popleft()
            allowed = len(attempts) < limit
            attempts.append(now)
            return allowed

    def clear_rate_limit(self, name: str) -> None:
        key = self._key("rate", name)
        if self._client is not None:
            try:
                self._client.delete(key)
            except Exception as exc:
                raise CoordinationUnavailable("Redis rate limiter reset failed") from exc
            return
        with self._local_windows_lock:
            self._local_windows.pop(key, None)

