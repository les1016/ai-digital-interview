import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from pathlib import Path
from threading import Barrier
from types import SimpleNamespace

from fastapi import FastAPI, Header, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from apps.server.app.appointments import (
    appointment_for_interview, attach_interview, detach_interview, end_admission,
    get_admission, init_appointments, install_appointment_routes,
)


class AppointmentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        filename = (Path(self.tmp.name) / "isolated.sqlite3").as_posix()
        self.engine = create_engine(f"sqlite:///{filename}", connect_args={"timeout": 10})
        self.addCleanup(self.engine.dispose)
        init_appointments(self.engine)
        self.now = datetime(2026, 11, 19, 9, 51)
        # Keep the established UTC-based fixtures on an explicit deployment override.
        self.client = self.make_client(timezone_name="Europe/London")

    def make_client(self, **options):
        def get_db():
            with Session(self.engine) as db:
                yield db

        def current_user(x_test_user: int | None = Header(None)):
            if x_test_user is None:
                raise HTTPException(401)
            return SimpleNamespace(id=x_test_user)

        app = FastAPI()
        install_appointment_routes(app, current_user, get_db, clock=lambda: self.now, **options)
        client = TestClient(app)
        self.addCleanup(client.close)
        return client

    @staticmethod
    def h(user):
        return {"X-Test-User": str(user)}

    def calendar(self, user=1):
        reply = self.client.get("/api/appointments", headers=self.h(user))
        self.assertEqual(reply.status_code, 200)
        self.assertEqual(reply.headers["Cache-Control"], "private, no-store")
        return reply.json()

    def book(self, start="2026-11-19T10:00:00Z", user=1):
        return self.client.post("/api/appointments", json={"start_at": start}, headers=self.h(user))

    def mutate(self, booking, op, user=1):
        return self.client.post(f"/api/appointments/{booking}/{op}", headers=self.h(user))

    def test_auth_calendar_and_timestamp_validation(self):
        self.assertEqual(self.client.get("/api/appointments").status_code, 401)
        self.assertEqual(self.client.post("/api/appointments", json={"start_at": "2026-11-19T10:00Z"}).status_code, 401)
        initial = self.calendar()
        self.assertEqual(initial["timezone"], "Europe/London")
        self.assertEqual(initial["now"], "2026-11-19T09:51:00Z")
        self.assertIsNone(initial["active"])
        self.assertEqual(initial["slots"][0], {
            "start_at": "2026-11-19T10:00:00Z", "check_in_by": "2026-11-19T10:05:00Z", "available": True,
            "refill": False, "overnight": False,
        })
        self.assertEqual(initial["overnight"], {"start_hour": 0, "end_hour": 7, "daily_limit": 3, "remaining_today": 3})
        self.assertEqual(len(initial["slots"]), 336)
        for invalid in ["2026-11-19T10:00", 1795082400, "1795082400", "9999-12-31T23:59-10:00"]:
            with self.subTest(invalid=invalid):
                self.assertEqual(self.book(invalid).status_code, 422)
        for invalid in ["2026-11-19T10:15Z", "2026-11-19T09:30Z", "2026-11-26T10:00Z"]:
            with self.subTest(invalid=invalid):
                self.assertEqual(self.book(invalid).status_code, 409)

    def test_cancel_releases_slot_and_does_not_charge_quota(self):
        row = self.book().json()
        self.assertEqual(self.book("2026-11-19T10:30Z").status_code, 409)
        self.assertEqual(self.book("2026-11-19T11:00+01:00", user=2).status_code, 409)
        self.assertFalse(self.calendar(2)["slots"][0]["available"])
        self.assertIsNone(self.calendar(2)["active"])
        self.assertEqual(self.mutate(row["id"], "cancel", user=2).status_code, 404)
        self.assertEqual(self.mutate(row["id"], "check-in", user=2).status_code, 404)
        self.assertEqual(self.mutate(row["id"], "cancel").json()["status"], "cancelled")
        self.assertEqual(self.mutate(row["id"], "cancel").status_code, 200)
        self.assertTrue(self.calendar(2)["slots"][0]["available"])
        self.assertEqual(self.book(user=2).status_code, 201)
        self.assertEqual(self.book("2026-11-19T10:30Z").status_code, 201)
        self.assertEqual(self.calendar()["remaining_today"], 1)

    def test_exact_grace_deadline_and_no_show_release(self):
        row = self.book().json()
        self.assertEqual(self.mutate(row["id"], "check-in").status_code, 409)
        self.now = datetime(2026, 11, 19, 10, 0)
        self.assertEqual(self.mutate(row["id"], "cancel").status_code, 409)
        self.assertEqual(self.calendar()["active"]["status"], "booked")
        self.now = datetime(2026, 11, 19, 10, 5)
        self.assertEqual(self.mutate(row["id"], "check-in").status_code, 409)
        self.assertIsNone(self.calendar()["active"])
        self.assertEqual(self.calendar()["remaining_today"], 1)
        self.assertEqual(self.calendar()["remaining_7_days"], 3)
        self.assertFalse(self.calendar()["slots"][0]["available"])
        self.assertEqual(self.calendar()["slots"][1]["start_at"], "2026-11-19T10:30:00Z")
        self.assertEqual(self.book().status_code, 409)
        self.assertEqual(self.book("2026-11-19T10:30Z").status_code, 201)

    def test_missed_slot_is_reusable_without_delaying_next_slot(self):
        missed = self.book().json()
        self.now = datetime(2026, 11, 19, 10, 5)
        self.assertEqual(self.mutate(missed["id"], "check-in").status_code, 409)
        slot = self.calendar(2)["slots"][0]
        self.assertTrue(slot["available"])
        self.assertTrue(slot["refill"])
        self.assertEqual(slot["check_in_by"], "2026-11-19T10:10:00Z")
        statuses = self._race([("2026-11-19T10:00Z", user) for user in (2, 3, 4, 5)])
        self.assertEqual(statuses, [201, 409, 409, 409])
        winner = next((user, row) for user in (2, 3, 4, 5)
                      if (row := self.calendar(user)["active"]) is not None)
        self.now = datetime(2026, 11, 19, 10, 9, 59)
        started = self.mutate(winner[1]["id"], "check-in", user=winner[0])
        self.assertEqual(started.status_code, 200)
        self.assertEqual(started.json()["ends_at"], "2026-11-19T10:25:00Z")
        self.assertEqual(self.book("2026-11-19T10:30Z", user=6).status_code, 201)

    def test_refill_only_for_no_show_and_never_at_or_after_end_of_grace(self):
        self.now = datetime(2026, 11, 19, 10, 5)
        self.assertEqual(self.book().status_code, 409)
        self.assertEqual(self.calendar()["slots"][0]["start_at"], "2026-11-19T10:30:00Z")
        self.now = datetime(2026, 11, 19, 9, 59)
        self.assertEqual(self.book().status_code, 201)
        self.now = datetime(2026, 11, 19, 10, 5)
        refill = self.book(user=2)
        self.assertEqual(refill.status_code, 201)
        self.now = datetime(2026, 11, 19, 10, 10)
        self.assertEqual(self.mutate(refill.json()["id"], "check-in", user=2).status_code, 409)
        self.assertEqual(self.book(user=3).status_code, 409)
        self.assertIsNone(self.calendar(2)["active"])

    def test_check_in_idempotent_fixed_twenty_minutes_at_boundary(self):
        row = self.book().json()
        self.now = datetime(2026, 11, 19, 10, 4, 59, 999999)
        first = self.mutate(row["id"], "check-in").json()
        self.assertEqual(first["status"], "checked_in")
        self.assertEqual(first["started_at"], "2026-11-19T10:04:59.999999Z")
        self.assertEqual(first["ends_at"], "2026-11-19T10:24:59.999999Z")
        self.now += timedelta(minutes=1)
        self.assertEqual(self.mutate(row["id"], "check-in").json(), first)
        self.assertEqual(self.mutate(row["id"], "cancel").status_code, 409)
        self.assertEqual(self.calendar()["remaining_today"], 0)
        self.assertEqual(self.calendar()["remaining_7_days"], 2)
        self.now += timedelta(minutes=19)
        self.assertEqual(self.mutate(row["id"], "check-in").status_code, 409)
        self.assertIsNone(self.calendar()["active"])

    def test_finished_slot_cannot_be_resold(self):
        row = self.book().json()
        self.now = datetime(2026, 11, 19, 10, 0)
        self.assertEqual(self.mutate(row["id"], "check-in").status_code, 200)
        with Session(self.engine) as db, db.begin():
            attach_interview(db, row["id"], 1, 91, now=self.now)
            end_admission(db, 91, now=self.now)
        self.assertFalse(self.calendar(2)["slots"][0]["available"])
        self.assertEqual(self.book(user=2).status_code, 409)
        self.assertIsNone(self.calendar()["active"])

    def test_london_day_quota_uses_local_midnight_in_summer(self):
        self.now = datetime(2026, 7, 6, 22, 29)
        row = self.book("2026-07-06T23:30+01:00").json()
        self.now += timedelta(minutes=1)
        self.assertEqual(self.mutate(row["id"], "check-in").status_code, 200)
        self.now += timedelta(minutes=20)
        self.assertEqual(self.calendar()["remaining_today"], 0)
        self.assertEqual(self.book("2026-07-06T23:00Z").status_code, 201)
        self.now = datetime(2026, 7, 6, 23, 0)
        self.assertEqual(self.calendar()["remaining_today"], 1)

    def test_beijing_default_evening_can_book_next_day_midnight(self):
        self.client = self.make_client()
        self.now = datetime(2026, 11, 19, 15, 30)  # 23:30 in Beijing
        calendar = self.calendar()
        self.assertEqual(calendar["timezone"], "Asia/Shanghai")
        by_start = {slot["start_at"]: slot for slot in calendar["slots"]}
        self.assertFalse(by_start["2026-11-19T15:30:00Z"]["overnight"])
        midnight = by_start["2026-11-19T16:00:00Z"]
        self.assertTrue(midnight["available"])
        self.assertTrue(midnight["overnight"])
        reserved = self.book("2026-11-20T00:00:00+08:00")
        self.assertEqual(reserved.status_code, 201, reserved.text)
        row = reserved.json()
        self.assertEqual(row["start_at"], "2026-11-19T16:00:00Z")
        self.assertTrue(row["overnight"])
        self.assertEqual(self.mutate(row["id"], "check-in").status_code, 409)
        self.now = datetime(2026, 11, 19, 16)
        started = self.mutate(row["id"], "check-in")
        self.assertEqual(started.status_code, 200, started.text)
        self.assertEqual(started.json()["ends_at"], "2026-11-19T16:20:00Z")

    def test_beijing_default_daily_quotas_reset_at_16_utc(self):
        self.client = self.make_client()
        self._finish_at(datetime(2026, 11, 18, 16), overnight=True)  # 00:00 Beijing, 19 Nov
        self._finish_at(datetime(2026, 11, 19, 15, 30), overnight=False)  # 23:30 on the same day
        self.now = datetime(2026, 11, 19, 15, 59, 59)
        before = self.calendar()
        self.assertEqual(before["remaining_today"], 0)
        self.assertEqual(before["overnight"]["remaining_today"], 2)
        self.now += timedelta(seconds=1)
        after = self.calendar()
        self.assertEqual(after["remaining_today"], 1)
        self.assertEqual(after["overnight"]["remaining_today"], 3)
        self.assertEqual(after["remaining_7_days"], before["remaining_7_days"])

    def test_beijing_default_night_ends_at_07_local_time(self):
        self.client = self.make_client()
        self.now = datetime(2026, 11, 19, 22, 25)
        boundary = self.calendar()["slots"][:2]
        self.assertEqual([(slot["start_at"], slot["overnight"]) for slot in boundary], [
            ("2026-11-19T22:30:00Z", True),  # 06:30 Beijing next morning
            ("2026-11-19T23:00:00Z", False),  # 07:00 Beijing next morning
        ])

    def test_daily_barrier_and_rolling_window_boundary(self):
        for day in (19, 20, 21):
            self.now = datetime(2026, 11, day, 10)
            row = self.book(f"2026-11-{day}T10:00Z").json()
            self.assertEqual(self.mutate(row["id"], "check-in").status_code, 200)
            self.now += timedelta(minutes=20)
            self.assertEqual(self.book(f"2026-11-{day}T10:30Z").status_code, 409)
        self.now = datetime(2026, 11, 25, 10)
        self.assertEqual(self.calendar()["remaining_7_days"], 0)
        self.assertEqual(self.book("2026-11-25T10:30Z").status_code, 409)
        self.assertEqual(self.book("2026-11-26T10:00Z").status_code, 201)
        self.now = datetime(2026, 11, 26, 10)
        current = self.calendar()
        self.assertEqual(current["remaining_7_days"], 1)
        self.assertEqual(self.mutate(current["active"]["id"], "check-in").status_code, 200)
        self.assertEqual(self.calendar()["remaining_7_days"], 0)

    def _finish_at(self, when, *, overnight):
        self.now = when
        reserved = self.book(when.isoformat() + "Z")
        self.assertEqual(reserved.status_code, 201, reserved.text)
        self.assertEqual(reserved.json()["overnight"], overnight)
        self.assertEqual(self.calendar()["active"]["overnight"], overnight)
        checked_in = self.mutate(reserved.json()["id"], "check-in")
        self.assertEqual(checked_in.status_code, 200, checked_in.text)
        self.assertEqual(checked_in.json()["overnight"], overnight)
        self.now += timedelta(minutes=20)

    def test_overnight_cap_is_independent_of_daytime_and_resets_next_date(self):
        for hour, minute in [(0, 0), (0, 30), (1, 0)]:
            self._finish_at(datetime(2026, 11, 19, hour, minute), overnight=True)
        usage = self.calendar()
        self.assertEqual(usage["overnight"]["remaining_today"], 0)
        self.assertEqual(usage["remaining_today"], 1)
        self.assertEqual(usage["remaining_7_days"], 3)
        self.assertEqual(self.book("2026-11-19T06:30Z").status_code, 409)
        self._finish_at(datetime(2026, 11, 19, 7), overnight=False)
        self.assertEqual(self.calendar()["remaining_today"], 0)
        self.assertEqual(self.calendar()["remaining_7_days"], 2)
        self._finish_at(datetime(2026, 11, 20, 0), overnight=True)
        self.assertEqual(self.calendar()["overnight"]["remaining_today"], 2)
        self.assertEqual(self.calendar()["remaining_7_days"], 2)

    def test_daytime_rolling_exhaustion_does_not_block_overnight(self):
        for day in (16, 17, 18):
            self._finish_at(datetime(2026, 11, day, 7), overnight=False)
        self.now = datetime(2026, 11, 19, 6, 25)
        self.assertEqual(self.calendar()["remaining_7_days"], 0)
        today_slots = self.calendar()["slots"][:2]
        self.assertEqual([(row["overnight"], row["available"]) for row in today_slots], [(True, True), (False, False)])
        self._finish_at(datetime(2026, 11, 19, 6, 30), overnight=True)
        self.assertEqual(self.book("2026-11-19T07:00Z").status_code, 409)

    def test_london_dst_local_overnight_boundary_and_date(self):
        # Spring UTC offset is already +01:00 on 29 March at these times.
        self.now = datetime(2026, 3, 29, 5, 25)
        boundary = self.calendar()["slots"][:2]
        self.assertEqual([(x["start_at"], x["overnight"]) for x in boundary], [
            ("2026-03-29T05:30:00Z", True), ("2026-03-29T06:00:00Z", False),
        ])
        self._finish_at(datetime(2026, 3, 29, 5, 30), overnight=True)
        self._finish_at(datetime(2026, 3, 29, 6, 0), overnight=False)
        self.now = datetime(2026, 3, 29, 22, 59)
        self.assertEqual(self.calendar()["overnight"]["remaining_today"], 2)
        self.now += timedelta(minutes=1)
        self.assertEqual(self.calendar()["overnight"]["remaining_today"], 3)

    def test_fall_back_uses_two_distinct_utc_slots_on_one_local_quota_day(self):
        self.client = self.make_client(timezone_name="Europe/London", night_daily_limit=2)
        self._finish_at(datetime(2026, 10, 25, 0, 30), overnight=True)  # first local 01:30
        self._finish_at(datetime(2026, 10, 25, 1, 30), overnight=True)  # repeated local 01:30
        self.assertEqual(self.calendar()["overnight"]["remaining_today"], 0)
        self.assertEqual(self.book("2026-10-25T02:00Z").status_code, 409)

    def test_configurable_overnight_hours_and_validation(self):
        self.client = self.make_client(timezone_name="Europe/London", night_start_hour=1, night_end_hour=5, night_daily_limit=2)
        self.now = datetime(2026, 11, 19, 0, 28)
        calendar = self.calendar()
        self.assertEqual(calendar["overnight"], {"start_hour": 1, "end_hour": 5, "daily_limit": 2, "remaining_today": 2})
        slots = {x["start_at"]: x for x in calendar["slots"]}
        self.assertFalse(slots["2026-11-19T00:30:00Z"]["overnight"])
        self.assertTrue(slots["2026-11-19T01:00:00Z"]["overnight"])
        self.assertFalse(slots["2026-11-19T05:00:00Z"]["overnight"])
        for invalid in [dict(night_start_hour=-1), dict(night_start_hour=7), dict(night_end_hour=25), dict(night_daily_limit=0)]:
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                self.make_client(**invalid)
        self.client = self.make_client(night_end_hour=24)
        self.assertTrue(all(row["overnight"] for row in self.calendar()["slots"]))

    def test_attach_expiry_and_deletion_retain_quota(self):
        row = self.book().json()
        self.now = datetime(2026, 11, 19, 10)
        self.assertEqual(self.mutate(row["id"], "check-in").status_code, 200)
        with Session(self.engine) as db, db.begin():
            admission = get_admission(db, 1, self.now)
            self.assertIsNotNone(admission)
            self.assertEqual(admission.id, row["id"])
            attach_interview(db, admission, 1, 12, now=self.now)
        expiry = self.now + timedelta(minutes=20)
        with Session(self.engine) as db:
            self.assertIsNone(get_admission(db, 1, expiry))
            self.assertEqual(appointment_for_interview(db, 12).ends_at, expiry)
            with self.assertRaises(HTTPException) as rejected:
                attach_interview(db, row["id"], 1, 12, now=expiry)
            self.assertEqual(rejected.exception.status_code, 409)
        with Session(self.engine) as db, db.begin():
            detach_interview(db, 12, expiry)
        with Session(self.engine) as db:
            self.assertIsNone(appointment_for_interview(db, 12))
        self.assertEqual(self.calendar()["remaining_today"], 0)

    def _race(self, entries):
        barrier = Barrier(len(entries), timeout=10)

        def attempt(entry):
            barrier.wait()
            return self.book(*entry).status_code

        with ThreadPoolExecutor(max_workers=len(entries)) as pool:
            return sorted(pool.map(attempt, entries))

    def test_competing_bookings_for_one_slot(self):
        statuses = self._race([("2026-11-19T10:00Z", i) for i in range(1, 9)])
        self.assertEqual(statuses, [201] + [409] * 7)

    def test_competing_slots_for_one_user(self):
        statuses = self._race([("2026-11-19T10:00Z", 1), ("2026-11-19T10:30Z", 1)])
        self.assertEqual(statuses, [201, 409])


if __name__ == "__main__":
    unittest.main()
