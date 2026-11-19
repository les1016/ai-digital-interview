from datetime import timedelta, timezone
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import jwt
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from apps.server.app import main
from apps.server.app.appointments import Appointment, init_appointments
from test_api import valid_agent_json, valid_report_json


class AppointmentIntegrationTests(unittest.TestCase):
    def setUp(self):
        tmp = self.enterContext(tempfile.TemporaryDirectory())
        engine = create_engine(f"sqlite:///{Path(tmp) / 'appointment-integration.db'}",
                               connect_args={"check_same_thread": False})
        self.addCleanup(engine.dispose)
        self.Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
        main.Base.metadata.create_all(engine)
        init_appointments(engine)
        self.enterContext(patch.object(main, "SessionLocal", self.Session))
        self.enterContext(patch.object(main, "APPOINTMENTS_REQUIRED", True))
        self.enterContext(patch.object(main, "RECORDING_DIR", Path(tmp)))
        self.enterContext(patch.object(main, "DOCUMENT_DIR", Path(tmp)))
        self.client = TestClient(main.app)
        self.addCleanup(self.client.close)
        self.now = main.utcnow_naive()
        self.end = self.now + timedelta(minutes=17)
        with self.Session() as db:
            student = main.User(username="booking-test", display_name="测试用户", password_hash="not-used")
            admin = main.User(username="booking-admin", display_name="测试管理员", password_hash="not-used", role="admin")
            db.add_all([student, admin])
            db.flush()
            resume = main.Resume(user_id=student.id, source="quick", title="虚构简历", content="合成面试测试资料")
            db.add(resume)
            db.commit()
            self.user_id = student.id
            self.resume_id = resume.id
            self.headers = {"Authorization": f"Bearer {main.token_for(student)}"}
            self.admin = {"Authorization": f"Bearer {main.token_for(admin)}"}

    def admission(self):
        with self.Session() as db:
            slot = self.now.replace(minute=(self.now.minute // 30) * 30, second=0, microsecond=0)
            row = Appointment(user_id=self.user_id, start_at=slot, check_in_by=slot + timedelta(minutes=5),
                              status="checked_in", started_at=self.now - timedelta(minutes=3), ends_at=self.end)
            db.add(row)
            db.commit()
            return row.id

    def start(self, suffix="one"):
        return self.client.post("/api/interviews", headers=self.headers,
                                json={"resume_id": self.resume_id, "request_id": f"booking-start-{suffix}"})

    def answer(self, iid):
        return self.client.post(f"/api/interviews/{iid}/answers", headers=self.headers,
                                json={"transcript": "我先核对需求，再写测试验证实现。", "request_id": "booking-answer-1"})

    def test_no_reservation_cannot_start_or_get_real_avatar_and_admin_preview_is_separate(self):
        with patch.object(main, "deepseek_chat") as model:
            self.assertEqual(self.start().status_code, 409)
            model.assert_not_called()
        self.assertEqual(self.client.post("/api/avatar/token", headers=self.headers).status_code, 403)
        self.assertEqual(self.client.post("/api/avatar/token?preview=true", headers=self.headers).status_code, 403)
        self.assertEqual(self.client.post("/api/avatar/token", headers=self.admin).status_code, 403)
        preview = self.client.post("/api/avatar/token?preview=true", headers=self.admin)
        self.assertEqual(preview.status_code, 200)
        claims = jwt.decode(preview.json()["token"], main.JWT_SECRET, algorithms=[main.ALGORITHM])
        self.assertTrue(claims["avatar_preview"])
        self.assertNotIn("appointment_id", claims)

    def test_bound_ticket_and_one_interview_per_admission_then_stop_at_deadline(self):
        appt = self.admission()
        token_response = self.client.post("/api/avatar/token", headers=self.headers)
        self.assertEqual(token_response.status_code, 200)
        token = token_response.json()["token"]
        claims = jwt.decode(token, main.JWT_SECRET, algorithms=[main.ALGORITHM])
        self.assertEqual(claims["appointment_id"], appt)
        self.assertEqual(claims["appointment_until"], int(self.end.replace(tzinfo=timezone.utc).timestamp()))
        self.assertLessEqual(claims["exp"] - claims["iat"], 30)
        scoped = {"Authorization": f"Bearer {token}"}
        self.assertEqual(self.client.get("/api/avatar/identity", headers=scoped).json()["appointment_id"], appt)
        with patch.object(main, "deepseek_chat", return_value="请介绍你最近的项目。") as model:
            started = self.start()
            self.assertEqual(started.status_code, 200, started.text)
            iid = started.json()["id"]
            self.assertEqual(self.start().json()["id"], iid)
            self.assertEqual(self.start("two").status_code, 409)
            self.assertEqual(model.call_count, 1)
        with self.Session() as db:
            row = db.get(Appointment, appt)
            self.assertEqual(row.interview_id, iid)
            row.ends_at = self.now - timedelta(seconds=1)
            db.commit()
        with patch.object(main, "deepseek_chat") as model:
            self.assertEqual(self.answer(iid).status_code, 409)
            model.assert_not_called()
        for action in ("session/open", "pause", "resume", "no-input"):
            response = self.client.post(f"/api/interviews/{iid}/{action}", headers=self.headers,
                                        json={"request_id": "expired-test-identifier"})
            self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(self.client.get("/api/avatar/identity", headers=scoped).status_code, 403)
        self.assertEqual(self.client.get(f"/api/interviews/{iid}", headers=self.headers).json()["status"], "expired")

    def test_answer_submitted_before_cutoff_is_preserved_without_next_question(self):
        appt = self.admission()
        with patch.object(main, "deepseek_chat", return_value="请介绍你最近的项目。"):
            iid = self.start().json()["id"]

        def crossing_cutoff(*_args, **_kwargs):
            nonlocal mock_now
            mock_now = self.end
            return valid_agent_json()

        mock_now = self.now
        with patch.object(main, "deepseek_chat", side_effect=crossing_cutoff), \
             patch.object(main, "utcnow_naive", side_effect=lambda: mock_now):
            result = self.answer(iid)
        self.assertEqual(result.status_code, 200, result.text)
        self.assertTrue(result.json()["should_finish"])
        with self.Session() as db:
            rows = list(db.scalars(select(main.InterviewMessage).where(main.InterviewMessage.interview_id == iid)))
            self.assertEqual([(r.speaker, r.kind) for r in rows], [("interviewer", "question"), ("candidate", "answer")])
            db.get(Appointment, appt).ends_at = self.now - timedelta(seconds=1)
            db.commit()
        with patch.object(main, "deepseek_chat", return_value=valid_report_json()):
            finished = self.client.post(f"/api/interviews/{iid}/finish", headers=self.headers)
        self.assertEqual(finished.status_code, 200, finished.text)
        with self.Session() as db:
            row = db.get(Appointment, appt)
            self.assertEqual(row.status, "finished")
            self.assertIsNotNone(row.started_at)

    def test_model_returning_after_admission_expires_does_not_create_a_session(self):
        appt = self.admission()

        def expire_during_start(*_args, **_kwargs):
            with self.Session() as db:
                db.get(Appointment, appt).ends_at = self.now - timedelta(seconds=1)
                db.commit()
            return "请介绍你最近的项目。"

        with patch.object(main, "deepseek_chat", side_effect=expire_during_start):
            response = self.start()
        self.assertEqual(response.status_code, 409, response.text)
        with self.Session() as db:
            self.assertIsNone(db.scalar(select(main.Interview)))
            self.assertIsNone(db.get(Appointment, appt).interview_id)
