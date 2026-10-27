from __future__ import annotations

import threading
import unittest

from apps.server.app.coordination import Coordinator


class LocalCoordinationTests(unittest.TestCase):
    def test_local_lock_excludes_concurrent_holder_and_is_reusable(self):
        coordinator = Coordinator()
        lock = coordinator.lock("interview:1")
        self.assertTrue(lock.acquire(blocking=False))

        result = []

        def compete():
            result.append(lock.acquire(blocking=False))

        thread = threading.Thread(target=compete)
        thread.start()
        thread.join()
        self.assertEqual(result, [False])
        lock.release()
        self.assertTrue(lock.acquire(blocking=False))
        lock.release()

    def test_independent_same_name_budget_locks_exclude_each_other(self):
        coordinator = Coordinator()
        first = coordinator.lock("api-budget")
        second = coordinator.lock("api-budget")
        self.assertTrue(first.acquire(False))
        try:
            self.assertFalse(second.acquire(False))
        finally:
            first.release()
        self.assertTrue(second.acquire(False))
        second.release()

    def test_local_semaphore_rejects_overload(self):
        semaphore = Coordinator().semaphore("document", 2)
        self.assertTrue(semaphore.acquire(blocking=False))
        self.assertTrue(semaphore.acquire(blocking=False))
        self.assertFalse(semaphore.acquire(blocking=False))
        semaphore.release()
        self.assertTrue(semaphore.acquire(blocking=False))
        semaphore.release()
        semaphore.release()

    def test_local_rate_limit_can_be_cleared(self):
        coordinator = Coordinator()
        self.assertTrue(coordinator.rate_limit("login:user", 2, 60))
        self.assertTrue(coordinator.rate_limit("login:user", 2, 60))
        self.assertFalse(coordinator.rate_limit("login:user", 2, 60))
        coordinator.clear_rate_limit("login:user")
        self.assertTrue(coordinator.rate_limit("login:user", 2, 60))


if __name__ == "__main__":
    unittest.main()
