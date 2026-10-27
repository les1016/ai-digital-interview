from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import httpx
import jwt
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, func, select
from sqlalchemy.orm import sessionmaker

from apps.server.app import main


def valid_report_json() -> str:
    return json.dumps({
        "overall_score": 82,
        "summary": "回答有清晰的行动与结果证据。",
        "highlights": ["能够说明自己的具体行动"],
        "improvements": ["补充更多量化结果"],
        "dimensions": {
            "表达逻辑": {"score": 82, "evidence": "回答包含背景、行动和结果。"},
            "岗位匹配": {"score": 80, "evidence": "经历与目标岗位存在关联。"},
            "项目深度": {"score": 78, "evidence": "说明了个人职责。"},
            "问题解决": {"score": 84, "evidence": "解释了问题和调整方案。"},
            "沟通协作": {"score": 81, "evidence": "提到了沟通和反馈。"},
            "职业规划": {"score": 76, "evidence": "已有初步发展方向。"},
        },
        "recommended_roles": [{"role": "产品经理", "fit": 85, "reason": "具备项目推进经历。"}],
        "emotion_guidance": ["保持稳定坐姿并在回答前缓慢呼气。"],
        "action_plan": ["用 STAR 法重写项目经历"],
        "disclaimer": "本报告仅用于学习复盘。",
    }, ensure_ascii=False)


def valid_agent_json(action: str = "follow_up", question: str = "请说明你如何验证最终结果。") -> str:
    return json.dumps({
        "action": action,
        "reason": "当前回答已有项目背景，但验证结果的证据仍不充分。",
        "topic": "项目经历",
        "evidence_gap": "验证方法与量化结果",
        "answer_summary": "自己负责接口设计与测试，并完成了项目交付",
        "question": "" if action == "finish" else question,
    }, ensure_ascii=False)


class ApiRegressionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.temp_path = Path(cls.temporary.name)
        cls.upload_path = cls.temp_path / "uploads"
        cls.recording_path = cls.temp_path / "recordings"
        cls.document_path = cls.temp_path / "documents"
        cls.upload_path.mkdir()
        cls.recording_path.mkdir()
        cls.document_path.mkdir()
        cls.engine = create_engine(
            f"sqlite:///{cls.temp_path / 'test.db'}",
            connect_args={"check_same_thread": False},
        )
        event.listen(cls.engine, "connect", lambda connection, _: connection.execute("PRAGMA foreign_keys=ON"))
        cls.Session = sessionmaker(bind=cls.engine, autoflush=False, expire_on_commit=False)
        cls.engine_patch = patch.object(main, "engine", cls.engine)
        cls.session_patch = patch.object(main, "SessionLocal", cls.Session)
        cls.engine_patch.start()
        cls.session_patch.start()

        def test_db():
            db = cls.Session()
            try:
                yield db
            except Exception:
                db.rollback()
                raise
            finally:
                db.close()

        main.app.dependency_overrides[main.get_db] = test_db
        cls.upload_patch = patch.object(main, "UPLOAD_DIR", cls.upload_path)
        cls.recording_patch = patch.object(main, "RECORDING_DIR", cls.recording_path)
        cls.document_patch = patch.object(main, "DOCUMENT_DIR", cls.document_path)
        cls.upload_patch.start()
        cls.recording_patch.start()
        cls.document_patch.start()
        cls.client = TestClient(main.app)

    @classmethod
    def tearDownClass(cls):
        cls.client.close()
        main.app.dependency_overrides.clear()
        cls.upload_patch.stop()
        cls.recording_patch.stop()
        cls.document_patch.stop()
        cls.session_patch.stop()
        cls.engine_patch.stop()
        cls.engine.dispose()
        cls.temporary.cleanup()

    def setUp(self):
        main.Base.metadata.drop_all(self.engine)
        main.Base.metadata.create_all(self.engine)
        main._deepseek_client = None
        main._operation_locks.clear()
        main._auth_attempts.clear()
        main._document_preview_attempts.clear()
        main._http_event_buckets.clear()

    def register(self, username: str = "student001") -> tuple[dict, dict]:
        response = self.client.post("/api/auth/register", json={
            "username": username,
            "password": "safe-test-password",
            "display_name": "测试学生",
        })
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        return body, {"Authorization": f"Bearer {body['token']}"}

    def create_resume(self, headers: dict) -> int:
        response = self.client.post("/api/resumes/quick", headers=headers, json={
            "title": "测试简历",
            "school": "测试大学",
            "major": "软件工程",
            "degree": "本科",
            "graduation_year": "2027",
            "skills": "Python、SQL",
            "experiences": "负责实现并测试一个校园项目。",
            "target_role": "后端工程师",
            "self_intro": "喜欢解决具体问题。",
        })
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["id"]

    def start_interview(self, headers: dict, resume_id: int, request_id: str = "start-request-001") -> int:
        with patch.object(main, "deepseek_chat", return_value="请介绍一段最有代表性的项目经历。"):
            response = self.client.post("/api/interviews", headers=headers, json={
                "resume_id": resume_id,
                "target_role": "后端工程师",
                "request_id": request_id,
            })
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["id"]

    def test_avatar_tickets_are_short_lived_and_not_login_tokens(self):
        body, headers = self.register()
        response = self.client.post("/api/avatar/token", headers=headers)
        self.assertEqual(response.status_code, 200)
        token = response.json()["token"]
        avatar_headers = {"Authorization": f"Bearer {token}"}
        self.assertEqual(self.client.get("/api/avatar/identity", headers=avatar_headers).status_code, 200)
        self.assertEqual(self.client.get("/api/me", headers=avatar_headers).status_code, 401)
        self.assertEqual(self.client.get("/api/avatar/identity", headers=headers).status_code, 401)
        self.assertEqual(self.client.post("/api/avatar/token").status_code, 401)
        claims = jwt.decode(token, main.JWT_SECRET, algorithms=[main.ALGORITHM])
        self.assertEqual(claims["exp"] - claims["iat"], 120)

    def test_interruption_token_cannot_authenticate(self):
        body, headers = self.register()
        token = main.interruption_session_payload(body["user"]["id"], 1)["interruption_session_token"]
        self.assertEqual(self.client.get("/api/me", headers={"Authorization": f"Bearer {token}"}).status_code, 401)
        self.assertEqual(self.client.get("/api/me", headers=headers).status_code, 200)

    def test_registration_limit_aggregates_new_usernames(self):
        with patch.object(main, "AUTH_REGISTER_MAX_ATTEMPTS", 2):
            statuses = [self.client.post("/api/auth/register", json={
                "username": f"bulkuser{i}", "password": "test-password", "display_name": "Test",
            }).status_code for i in range(5)]
        self.assertEqual(statuses, [200, 200, 429, 429, 429])

    def test_delete_interrupted_interview_preserves_cooldown(self):
        body, headers = self.register()
        iid = self.start_interview(headers, self.create_resume(headers))
        for _ in range(main.FORCED_EXIT_THRESHOLD):
            session = main.interruption_session_payload(body["user"]["id"], iid)
            response = self.client.post(f"/api/interviews/{iid}/interruptions", headers=headers, json={
                "session_id": session["interruption_session_id"],
                "session_token": session["interruption_session_token"], "reason": "page_unload",
            })
            self.assertEqual(response.status_code, 200)
        response = self.client.delete(f"/api/interviews/{iid}", headers=headers)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.client.get(f"/api/interviews/{iid}", headers=headers).status_code, 404)
        status = self.client.get("/api/account/interruption-status", headers=headers).json()
        self.assertEqual(status["forced_exit_count"], main.FORCED_EXIT_THRESHOLD)
        self.assertGreater(status["cooldown_remaining_seconds"], 0)

    def test_operation_lock_old_reference_remains_exclusive(self):
        first = main.operation_lock("race")
        self.assertTrue(first.acquire(False))
        waiting = main.operation_lock("race")
        main.release_operation_lock("race", first)
        fresh = main.operation_lock("race")
        self.assertTrue(waiting.acquire(False))
        try:
            self.assertFalse(fresh.acquire(False))
        finally:
            waiting.release()

    def test_auth_requires_expiring_token_and_rejects_duplicates(self):
        body, headers = self.register()
        duplicate = self.client.post("/api/auth/register", json={
            "username": "student001",
            "password": "safe-test-password",
            "display_name": "另一个名字",
        })
        self.assertEqual(duplicate.status_code, 409)
        self.assertEqual(self.client.get("/api/me", headers=headers).status_code, 200)
        self.assertEqual(self.client.get("/api/me").status_code, 401)

        token_without_exp = jwt.encode({"sub": str(body["user"]["id"])}, main.JWT_SECRET, algorithm=main.ALGORITHM)
        invalid = self.client.get("/api/me", headers={"Authorization": f"Bearer {token_without_exp}"})
        self.assertEqual(invalid.status_code, 401)

    def test_repeated_failed_login_is_rate_limited(self):
        statuses = [
            self.client.post("/api/auth/login", json={
                "username": "missing-rate-limit-user",
                "password": "definitely-wrong",
            }).status_code
            for _ in range(main.AUTH_LOGIN_MAX_ATTEMPTS + 1)
        ]
        self.assertTrue(all(status == 401 for status in statuses[:-1]))
        self.assertEqual(statuses[-1], 429)

    def test_repeated_client_errors_are_deduplicated_even_with_random_404_paths(self):
        first, suppressed = main.http_event_log_decision("malicious-client", "GET", "/random-a", 404)
        second, _ = main.http_event_log_decision("malicious-client", "GET", "/random-b", 404)
        self.assertTrue(first)
        self.assertEqual(suppressed, 0)
        self.assertFalse(second)

    def test_sqlite_compat_schema_adds_columns_to_existing_local_database(self):
        legacy_dir = tempfile.TemporaryDirectory()
        self.addCleanup(legacy_dir.cleanup)
        legacy_db = Path(legacy_dir.name) / "legacy.db"
        legacy_engine = create_engine(f"sqlite:///{legacy_db}", connect_args={"check_same_thread": False})
        self.addCleanup(legacy_engine.dispose)
        with legacy_engine.begin() as connection:
            connection.exec_driver_sql(
                "CREATE TABLE users (id INTEGER PRIMARY KEY, username VARCHAR(64), display_name VARCHAR(80), password_hash VARCHAR(255))"
            )
            connection.exec_driver_sql(
                "CREATE TABLE resumes (id INTEGER PRIMARY KEY, user_id INTEGER, source VARCHAR(20), title VARCHAR(160), content TEXT)"
            )
            connection.exec_driver_sql(
                "CREATE TABLE interviews (id INTEGER PRIMARY KEY, user_id INTEGER, resume_id INTEGER)"
            )
            connection.exec_driver_sql(
                "INSERT INTO users (id, username, display_name, password_hash) VALUES (1, 'old', '旧用户', 'hash')"
            )
            connection.exec_driver_sql(
                "INSERT INTO resumes (id, user_id, source, title, content) VALUES (1, 1, 'quick', '旧简历', '内容')"
            )
            connection.exec_driver_sql(
                "INSERT INTO interviews (id, user_id, resume_id) VALUES (1, 1, 1)"
            )

        main.Base.metadata.create_all(legacy_engine)
        main.ensure_sqlite_compat_schema(legacy_engine)

        with legacy_engine.begin() as connection:
            interview_columns = {
                row[1] for row in connection.exec_driver_sql("PRAGMA table_info(interviews)").all()
            }
            user_columns = {
                row[1] for row in connection.exec_driver_sql("PRAGMA table_info(users)").all()
            }
            resume_columns = {
                row[1] for row in connection.exec_driver_sql("PRAGMA table_info(resumes)").all()
            }
            self.assertIn("status", interview_columns)
            self.assertIn("finished_at", interview_columns)
            self.assertIn("pause_used", interview_columns)
            self.assertIn("pause_deadline", interview_columns)
            self.assertIn("job_description", interview_columns)
            self.assertIn("role", user_columns)
            self.assertIn("file_path", resume_columns)
            status = connection.exec_driver_sql("SELECT status FROM interviews WHERE id = 1").scalar_one()
            started_at = connection.exec_driver_sql("SELECT started_at FROM interviews WHERE id = 1").scalar_one()
            role = connection.exec_driver_sql("SELECT role FROM users WHERE id = 1").scalar_one()
        self.assertEqual(status, "active")
        self.assertTrue(started_at)
        self.assertEqual(role, "student")

    def test_job_description_is_saved_and_used_as_interview_context(self):
        _, headers = self.register()
        resume_id = self.create_resume(headers)
        job_description = """产品经理（校园业务）
岗位职责：负责用户调研、需求分析与跨团队项目推进。
任职要求：熟悉 SQL 和数据分析，能够用量化结果验证方案。"""
        with patch.object(main, "deepseek_chat", return_value="请介绍一段与用户调研有关的经历。") as model:
            response = self.client.post("/api/interviews", headers=headers, json={
                "resume_id": resume_id,
                "target_role": "产品经理（校园业务）",
                "job_description": job_description,
                "request_id": "job-description-start",
            })
        self.assertEqual(response.status_code, 200, response.text)
        prompt = model.call_args.args[0][1]["content"]
        self.assertIn("用户调研", prompt)
        self.assertIn("量化结果", prompt)
        detail = self.client.get(f"/api/interviews/{response.json()['id']}", headers=headers)
        self.assertEqual(detail.status_code, 200, detail.text)
        self.assertEqual(detail.json()["job_description"], job_description)

    def test_resume_upload_limits_type_size_and_cleans_failed_files(self):
        _, headers = self.register()
        declared_too_large = self.client.post(
            "/api/resumes/upload",
            headers={
                **headers,
                "Content-Length": str(main.MAX_RESUME_FILE_BYTES + 1024 * 1024 + 1),
            },
        )
        self.assertEqual(declared_too_large.status_code, 413)

        fake_pdf = self.client.post(
            "/api/resumes/upload",
            headers=headers,
            files={"file": ("resume.pdf", b"not a real pdf", "application/pdf")},
        )
        self.assertEqual(fake_pdf.status_code, 422)
        self.assertEqual(list(self.upload_path.iterdir()), [])

        oversized = self.client.post(
            "/api/resumes/upload",
            headers=headers,
            files={"file": ("resume.txt", b"a" * (main.MAX_RESUME_FILE_BYTES + 1), "text/plain")},
        )
        self.assertEqual(oversized.status_code, 413)
        self.assertEqual(list(self.upload_path.iterdir()), [])

    def test_start_and_answer_are_idempotent_and_model_failure_rolls_back(self):
        _, headers = self.register()
        resume_id = self.create_resume(headers)
        request = {
            "resume_id": resume_id,
            "target_role": "后端工程师",
            "request_id": "same-start-request",
        }
        with patch.object(main, "deepseek_chat", return_value="第一个问题"):
            first = self.client.post("/api/interviews", headers=headers, json=request)
            repeated = self.client.post("/api/interviews", headers=headers, json=request)
        self.assertEqual(first.status_code, 200)
        self.assertEqual(repeated.json()["id"], first.json()["id"])
        self.assertIn("有急事，点右上方暂停", first.json()["question"])
        self.assertEqual(first.json()["opening_question"], "第一个问题")
        self.assertEqual(first.json()["briefing_policy"]["threshold"], main.FORCED_EXIT_THRESHOLD)
        self.assertIn("第三次冷却三十分钟", first.json()["question"])
        self.assertTrue(first.json()["interruption_session_id"])
        self.assertTrue(first.json()["interruption_session_token"])
        interview_id = first.json()["id"]

        with patch.object(main, "deepseek_chat") as model:
            blocked = self.client.post("/api/interviews", headers=headers, json={
                "resume_id": resume_id,
                "target_role": "另一个岗位",
                "request_id": "another-start-request",
            })
        self.assertEqual(blocked.status_code, 409)
        self.assertIn("未完成", blocked.json()["detail"])
        model.assert_not_called()

        answer = {"transcript": "我负责接口设计和测试。", "request_id": "answer-request-001"}
        with patch.object(main, "deepseek_chat", return_value=valid_agent_json()) as model:
            accepted = self.client.post(f"/api/interviews/{interview_id}/answers", headers=headers, json=answer)
            repeated = self.client.post(f"/api/interviews/{interview_id}/answers", headers=headers, json=answer)
        self.assertEqual(accepted.status_code, 200, accepted.text)
        self.assertEqual(repeated.json(), accepted.json())
        self.assertEqual(model.call_count, 1)
        self.assertEqual(accepted.json()["agent_decision"]["action"], "follow_up")
        self.assertEqual(accepted.json()["question"], "请说明你如何验证最终结果。")

        changed = self.client.post(f"/api/interviews/{interview_id}/answers", headers=headers, json={
            "transcript": "把同一个编号用于另一段内容。",
            "request_id": "answer-request-001",
        })
        self.assertEqual(changed.status_code, 409)

        with patch.object(main, "deepseek_chat", side_effect=HTTPException(502, "模拟模型失败")):
            failed = self.client.post(f"/api/interviews/{interview_id}/answers", headers=headers, json={
                "transcript": "这条回答不应半途落库。",
                "request_id": "answer-request-002",
            })
        self.assertEqual(failed.status_code, 502)

        with self.Session() as db:
            candidates = db.scalar(
                select(func.count()).select_from(main.InterviewMessage).where(
                    main.InterviewMessage.interview_id == interview_id,
                    main.InterviewMessage.speaker == "candidate",
                )
            )
            self.assertEqual(candidates, 1)
        self.assertEqual(main._operation_locks, {})

    def test_acknowledgment_intent_is_server_owned_and_persisted(self):
        _, headers = self.register()
        interview_id = self.start_interview(headers, self.create_resume(headers))
        cases = [
            ('acknowledge', '个人行动和结果清楚', 'acknowledge_ok_v1'),
            ('clarify', '需要澄清职责', 'none'),
            ('challenge', '前后说法矛盾', 'none'),
            ('acknowledge', '回答笼统，证据不足', 'none'),
            (None, '旧版模型未提供意图', 'none'),
        ]
        for index, (intent, reason, expected) in enumerate(cases):
            decision = json.loads(valid_agent_json('next_topic', '另一段经历中，你如何组织协作？'))
            decision.update(reason=reason, evidence_gap='后续探索协作方式')
            if intent: decision['response_intent'] = intent
            body = {'transcript':'我负责接口设计、联调和测试，并整理了测试结果。',
                    'request_id':f'cue-test-request-{index}'}
            with patch.object(main, 'deepseek_chat', return_value=json.dumps(decision, ensure_ascii=False)) as model:
                first = self.client.post(f'/api/interviews/{interview_id}/answers', headers=headers, json=body)
                repeated = self.client.post(f'/api/interviews/{interview_id}/answers', headers=headers, json=body)
            self.assertEqual(first.status_code, 200, first.text)
            self.assertEqual(first.json()['avatar_cue']['id'], expected)
            self.assertEqual(first.json(), repeated.json())
            self.assertEqual(model.call_count, 1)
        # The cue is metadata, not an extra scored turn in the transcript.
        record = self.client.get(f'/api/interviews/{interview_id}', headers=headers).json()
        self.assertFalse(any(item['content'] == '好的。' for item in record['messages']))
        denied = self.client.post(f'/api/interviews/{interview_id}/answers', json=body)
        self.assertIn(denied.status_code, [401,403])
        with patch.object(main, 'deepseek_chat') as model:
            invalid = self.client.post(f'/api/interviews/{interview_id}/answers', headers=headers,
                json={'transcript':'咳咳', 'request_id':'cue-invalid-request'})
        self.assertEqual(invalid.json()['avatar_cue']['id'], 'none')
        model.assert_not_called()

    def test_request_ids_are_required(self):
        _, headers = self.register()
        resume_id = self.create_resume(headers)
        missing_start_id = self.client.post("/api/interviews", headers=headers, json={
            "resume_id": resume_id,
            "target_role": "后端工程师",
        })
        self.assertEqual(missing_start_id.status_code, 422)

        interview_id = self.start_interview(headers, resume_id)
        missing_answer_id = self.client.post(f"/api/interviews/{interview_id}/answers", headers=headers, json={
            "transcript": "缺少请求编号。",
        })
        self.assertEqual(missing_answer_id.status_code, 422)

    def test_invalid_audio_text_cannot_extend_interview_indefinitely(self):
        _, headers = self.register()
        interview_id = self.start_interview(headers, self.create_resume(headers))

        first = self.client.post(f"/api/interviews/{interview_id}/answers", headers=headers, json={
            "transcript": "嗯嗯，咳咳。",
            "request_id": "invalid-answer-001",
        })
        repeated = self.client.post(f"/api/interviews/{interview_id}/answers", headers=headers, json={
            "transcript": "嗯嗯，咳咳。",
            "request_id": "invalid-answer-001",
        })
        second = self.client.post(f"/api/interviews/{interview_id}/no-input", headers=headers, json={
            "request_id": "invalid-answer-002",
        })
        third = self.client.post(f"/api/interviews/{interview_id}/answers", headers=headers, json={
            "transcript": "啊，咳。",
            "request_id": "invalid-answer-003",
        })

        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(repeated.json(), first.json())
        self.assertTrue(first.json()["invalid_answer"])
        self.assertEqual(second.json()["clarification_count"], 2)
        self.assertTrue(third.json()["should_finish"])
        with self.Session() as db:
            messages = main.interview_transcript(interview_id, db)
            self.assertEqual(sum(item.speaker == "candidate" for item in messages), 0)
            self.assertEqual(sum(item.kind == "clarification" for item in messages), 3)
            self.assertEqual(main.interview_question_count(messages), 1)
            self.assertEqual(db.get(main.Interview, interview_id).status, "invalid_ended")

    def test_pause_is_single_use_persistent_and_resumes_with_transition(self):
        _, headers = self.register()
        interview_id = self.start_interview(headers, self.create_resume(headers))
        request = {"request_id": "pause-request-001"}
        paused = self.client.post(f"/api/interviews/{interview_id}/pause", headers=headers, json=request)
        repeated = self.client.post(f"/api/interviews/{interview_id}/pause", headers=headers, json=request)
        denied = self.client.post(f"/api/interviews/{interview_id}/pause", headers=headers, json={
            "request_id": "pause-request-002",
        })

        self.assertEqual(paused.status_code, 200, paused.text)
        self.assertEqual(repeated.json(), paused.json())
        self.assertEqual(paused.json()["status"], "paused")
        self.assertTrue(paused.json()["pause_used"])
        self.assertGreater(paused.json()["pause_remaining_seconds"], 0)
        self.assertEqual(denied.status_code, 409)

        resumed = self.client.post(f"/api/interviews/{interview_id}/resume", headers=headers, json={
            "request_id": "resume-request-001",
        })
        self.assertEqual(resumed.status_code, 200, resumed.text)
        self.assertFalse(resumed.json()["expired"])
        self.assertIn("你回来了", resumed.json()["transition"])
        self.assertIn("我们继续刚才的问题", resumed.json()["transition"])
        self.assertNotIn("刚才我们谈到", resumed.json()["transition"])
        self.assertNotIn("有急事，暂停一次", resumed.json()["transition"])
        detail = self.client.get(f"/api/interviews/{interview_id}", headers=headers).json()
        self.assertEqual(detail["status"], "active")
        self.assertTrue(detail["pause_used"])
        self.assertTrue(any(item["kind"] == "transition" for item in detail["messages"]))

        denied_again = self.client.post(f"/api/interviews/{interview_id}/pause", headers=headers, json={
            "request_id": "pause-request-003",
        })
        self.assertEqual(denied_again.status_code, 409)

    def test_repeated_forced_exits_trigger_cooldown_but_one_disconnect_does_not(self):
        _, headers = self.register("cooldown-student")
        resume_id = self.create_resume(headers)
        interview_id = self.start_interview(headers, resume_id, "cooldown-start-request")

        with self.Session() as db:
            first_question = db.scalar(select(main.InterviewMessage).where(
                main.InterviewMessage.interview_id == interview_id,
                main.InterviewMessage.speaker == "interviewer",
            ))
            first_question.content = main.LEGACY_INTERVIEW_BRIEFINGS[0] + "请介绍一下你最有代表性的项目经历。"
            db.commit()
        legacy_resume = self.client.post(
            f"/api/interviews/{interview_id}/session/open",
            headers=headers,
            json={"request_id": "legacy-open-request"},
        )
        self.assertEqual(legacy_resume.status_code, 200)
        self.assertIn("第三次冷却三十分钟", legacy_resume.json()["question_override"])
        self.assertNotIn("开始前提醒你", legacy_resume.json()["question_override"])

        def session_payload(opened: dict, reason: str = "explicit_exit") -> dict:
            return {
                "session_id": opened["interruption_session_id"],
                "session_token": opened["interruption_session_token"],
                "reason": reason,
            }

        issued_sessions = [legacy_resume.json()]
        for number in range(1, main.FORCED_EXIT_THRESHOLD + 25):
            opened = self.client.post(
                f"/api/interviews/{interview_id}/session/open",
                headers=headers,
                json={"request_id": f"preissued-open-{number}"},
            )
            self.assertEqual(opened.status_code, 200)
            issued_sessions.append(opened.json())

        forged = self.client.post(
            f"/api/interviews/{interview_id}/interruptions",
            headers=headers,
            json={"session_id": "forged-session-id", "session_token": "x" * 32, "reason": "explicit_exit"},
        )
        self.assertEqual(forged.status_code, 403)
        oversized_beacon = self.client.post(
            f"/api/interviews/{interview_id}/interruptions/beacon",
            content=b"x" * 5000,
            headers={"Content-Type": "text/plain"},
        )
        self.assertEqual(oversized_beacon.status_code, 413)

        device_lost = self.client.post(
            f"/api/interviews/{interview_id}/interruptions/beacon",
            content=json.dumps(session_payload(issued_sessions[0], "device_lost")),
            headers={"Content-Type": "text/plain"},
        )
        self.assertEqual(device_lost.status_code, 200)
        self.assertFalse(device_lost.json()["recorded"])

        for number in range(1, main.FORCED_EXIT_THRESHOLD + 1):
            response = self.client.post(
                f"/api/interviews/{interview_id}/interruptions",
                headers=headers,
                json=session_payload(issued_sessions[number - 1]),
            )
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["forced_exit_count"], number)
            if number < main.FORCED_EXIT_THRESHOLD:
                self.assertEqual(response.json()["cooldown_remaining_seconds"], 0)

        self.assertGreater(response.json()["cooldown_remaining_seconds"], 0)
        self.assertTrue(response.json()["cooldown_until"].endswith("Z"))
        self.assertEqual(response.json()["pause_max_seconds"], main.INTERVIEW_PAUSE_MAX_SECONDS)
        duplicate = self.client.post(
            f"/api/interviews/{interview_id}/interruptions",
            headers=headers,
            json=session_payload(issued_sessions[0], "page_unload"),
        )
        self.assertTrue(duplicate.json()["duplicate"])
        self.assertEqual(duplicate.json()["forced_exit_count"], main.FORCED_EXIT_THRESHOLD)

        for number in range(25):
            ignored = self.client.post(
                f"/api/interviews/{interview_id}/interruptions",
                headers=headers,
                json=session_payload(issued_sessions[main.FORCED_EXIT_THRESHOLD + number]),
            )
            self.assertEqual(ignored.status_code, 200)
            self.assertFalse(ignored.json()["recorded"])
            self.assertTrue(ignored.json()["cooldown_active"])
        self.assertEqual(ignored.json()["forced_exit_count"], main.FORCED_EXIT_THRESHOLD)

        _, attacker_headers = self.register("cooldown-attacker")
        forbidden = self.client.post(
            f"/api/interviews/{interview_id}/interruptions",
            headers=attacker_headers,
            json=session_payload(issued_sessions[0]),
        )
        self.assertEqual(forbidden.status_code, 404)

        blocked_resume = self.client.post(
            f"/api/interviews/{interview_id}/session/open",
            headers=headers,
            json={"request_id": "cooldown-open-request"},
        )
        self.assertEqual(blocked_resume.status_code, 429)
        status = self.client.get("/api/account/interruption-status", headers=headers)
        self.assertEqual(status.status_code, 200)
        self.assertGreater(status.json()["cooldown_remaining_seconds"], 0)

    def test_resume_uses_saved_agent_summary_instead_of_truncated_answer(self):
        _, headers = self.register()
        interview_id = self.start_interview(headers, self.create_resume(headers))
        long_answer = "我负责国家电网实习项目的数据整理，并协调三名同学完成核验，最终提前两天提交了分析结果。" * 5
        with patch.object(main, "deepseek_chat", return_value=valid_agent_json()):
            answered = self.client.post(f"/api/interviews/{interview_id}/answers", headers=headers, json={
                "transcript": long_answer,
                "request_id": "summary-answer-request",
            })
        self.assertEqual(answered.status_code, 200, answered.text)
        paused = self.client.post(f"/api/interviews/{interview_id}/pause", headers=headers, json={
            "request_id": "summary-pause-request",
        })
        self.assertEqual(paused.status_code, 200, paused.text)
        resumed = self.client.post(f"/api/interviews/{interview_id}/resume", headers=headers, json={
            "request_id": "summary-resume-request",
        })
        transition = resumed.json()["transition"]
        self.assertIn("自己负责接口设计与测试，并完成了项目交付", transition)
        self.assertNotIn(long_answer[:40], transition)
        self.assertNotIn("……", transition)

    def test_expired_pause_closes_unanswered_interview(self):
        _, headers = self.register()
        interview_id = self.start_interview(headers, self.create_resume(headers))
        paused = self.client.post(f"/api/interviews/{interview_id}/pause", headers=headers, json={
            "request_id": "pause-expiry-request",
        })
        self.assertEqual(paused.status_code, 200, paused.text)
        with self.Session() as db:
            interview = db.get(main.Interview, interview_id)
            interview.pause_deadline = main.utcnow_naive() - main.timedelta(seconds=1)
            db.commit()

        resumed = self.client.post(f"/api/interviews/{interview_id}/resume", headers=headers, json={
            "request_id": "resume-expired-request",
        })
        self.assertEqual(resumed.status_code, 200, resumed.text)
        self.assertTrue(resumed.json()["expired"])
        self.assertFalse(resumed.json()["can_generate_report"])
        self.assertEqual(resumed.json()["status"], "pause_expired")

    def test_agent_can_finish_after_minimum_question_count(self):
        _, headers = self.register()
        interview_id = self.start_interview(headers, self.create_resume(headers))
        with self.Session() as db:
            for index in range(main.INTERVIEW_MIN_QUESTIONS - 1):
                db.add(main.InterviewMessage(
                    interview_id=interview_id,
                    speaker="interviewer",
                    kind="question",
                    content=f"补充正式问题 {index}",
                ))
            db.commit()

        with patch.object(main, "deepseek_chat", return_value=valid_agent_json("finish")) as model:
            response = self.client.post(f"/api/interviews/{interview_id}/answers", headers=headers, json={
                "transcript": "我已经完整说明了个人行动、协作过程和量化结果。",
                "request_id": "agent-finish-request",
            })
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(model.call_count, 1)
        self.assertTrue(response.json()["should_finish"])
        self.assertEqual(response.json()["agent_decision"]["action"], "finish")

    def test_invalid_report_shape_is_repaired_and_finish_is_idempotent(self):
        _, headers = self.register()
        interview_id = self.start_interview(headers, self.create_resume(headers))
        with patch.object(main, "deepseek_chat", return_value="下一题"):
            answer = self.client.post(f"/api/interviews/{interview_id}/answers", headers=headers, json={
                "transcript": "我完成了接口设计并补充了测试。",
                "request_id": "answer-before-report",
            })
        self.assertEqual(answer.status_code, 200)

        with patch.object(main, "deepseek_chat", return_value="报告如下：\n```json\n{}\n```\n请查收。") as model:
            report = self.client.post(f"/api/interviews/{interview_id}/finish", headers=headers)
            repeated = self.client.post(f"/api/interviews/{interview_id}/finish", headers=headers)
        self.assertEqual(report.status_code, 200, report.text)
        self.assertEqual(repeated.json()["report_id"], report.json()["report_id"])
        self.assertEqual(model.call_count, 1)
        self.assertEqual(set(main.CORE_REPORT_DIMENSIONS).difference(report.json()["dimensions"]), set())
        self.assertEqual(report.json()["generation_status"], "repaired")
        self.assertTrue(report.json()["generation_notice"])
        self.assertIn("模型报告结构异常", report.json()["disclaimer"])
        self.assertIn("样本较少", report.json()["summary"])
        self.assertTrue(report.json()["action_plan"])

    def test_valid_report_is_preserved_without_repair(self):
        _, headers = self.register()
        interview_id = self.start_interview(headers, self.create_resume(headers))
        with patch.object(main, "deepseek_chat", return_value="下一题"):
            answer = self.client.post(f"/api/interviews/{interview_id}/answers", headers=headers, json={
                "transcript": "我完成了接口设计并补充了测试。",
                "request_id": "valid-report-answer",
            })
        self.assertEqual(answer.status_code, 200)
        with patch.object(main, "deepseek_chat", return_value=valid_report_json()) as model:
            report = self.client.post(f"/api/interviews/{interview_id}/finish", headers=headers)
        self.assertEqual(report.status_code, 200, report.text)
        self.assertEqual(report.json()["overall_score"], 82)
        self.assertEqual(report.json()["target_match"]["target"], "后端工程师")
        self.assertEqual(report.json()["target_match"]["score"], 80)
        self.assertEqual(model.call_count, 1)

    def test_ready_to_finish_is_persisted_and_model_context_is_bounded(self):
        _, headers = self.register()
        interview_id = self.start_interview(headers, self.create_resume(headers))
        with self.Session() as db:
            for index in range(11):
                db.add(main.InterviewMessage(
                    interview_id=interview_id,
                    speaker="interviewer",
                    content=f"补充问题 {index}",
                ))
            db.commit()

        answer = self.client.post(
            f"/api/interviews/{interview_id}/answers",
            headers=headers,
            json={
                "transcript": "最后一道题的回答",
                "request_id": "ready-finish-answer",
            },
        )
        self.assertEqual(answer.status_code, 200, answer.text)
        self.assertTrue(answer.json()["should_finish"])
        detail = self.client.get(f"/api/interviews/{interview_id}", headers=headers)
        self.assertEqual(detail.json()["status"], "ready_to_finish")

        conversation = [
            {"speaker": "candidate", "content": f"{index}-" + "答" * 8_000}
            for index in range(30)
        ]
        conversation[-1]["content"] += "-LATEST-ANSWER"
        encoded = main.model_context(
            resume="简" * main.MAX_RESUME_TEXT_CHARS,
            target_role="测试岗位",
            conversation=conversation,
        )
        self.assertLessEqual(len(encoded), main.MAX_MODEL_CONTEXT_CHARS)
        self.assertIn("LATEST-ANSWER", encoded)

    def test_admin_can_read_but_cannot_modify_student_interview(self):
        student, student_headers = self.register()
        interview_id = self.start_interview(student_headers, self.create_resume(student_headers))
        with self.Session() as db:
            admin = main.User(
                username="admin001",
                display_name="管理员",
                password_hash=main.hash_password("safe-admin-password"),
                role="admin",
            )
            db.add(admin)
            db.commit()
            admin_headers = {"Authorization": f"Bearer {main.token_for(admin)}"}

        self.assertEqual(self.client.get(f"/api/interviews/{interview_id}", headers=admin_headers).status_code, 200)
        forbidden = self.client.post(f"/api/interviews/{interview_id}/behavior", headers=admin_headers, json={
            "sample_count": 1,
            "face_presence_ratio": 1,
            "centered_ratio": 1,
            "head_away_ratio": 0,
            "high_movement_ratio": 0,
            "blink_count": 0,
        })
        self.assertEqual(forbidden.status_code, 404)

        listing = self.client.get("/api/interviews", headers=student_headers)
        self.assertEqual(listing.status_code, 200)
        self.assertEqual(listing.json()[0]["resume_id"], self.create_resume_id_from_interview(interview_id))

    def test_admin_document_previews_are_bounded_authorized_and_not_persisted(self):
        student, student_headers = self.register("document-preview-student")
        resume_id = self.create_resume(student_headers)
        interview_id = self.start_interview(student_headers, resume_id, "document-preview-start")
        with self.Session() as db:
            interview = db.get(main.Interview, interview_id)
            interview.status = "completed"
            interview.finished_at = main.utcnow_naive()
            db.add(main.InterviewMessage(
                interview_id=interview_id,
                speaker="candidate",
                content="我负责校园项目的接口开发和测试，并按期完成交付。",
            ))
            db.add(main.InterviewReport(
                interview_id=interview_id,
                overall_score=82,
                payload_json=valid_report_json(),
            ))
            admin = main.User(
                username="document-preview-admin",
                display_name="预览管理员",
                password_hash=main.hash_password("safe-admin-password"),
                role="admin",
            )
            db.add(admin)
            db.commit()
            admin_headers = {"Authorization": f"Bearer {main.token_for(admin)}"}

        pdf_response = self.client.get(
            f"/api/admin/interviews/{interview_id}/document-preview?format=pdf",
            headers=admin_headers,
        )
        self.assertEqual(pdf_response.status_code, 200, pdf_response.text)
        self.assertTrue(pdf_response.content.startswith(b"%PDF"))
        self.assertEqual(pdf_response.headers["x-document-renderer"], "reportlab")
        self.assertEqual(pdf_response.headers["cache-control"], "private, no-store, max-age=0")

        def fake_word_preview(_source: Path, target: Path) -> str:
            target.write_bytes(b"%PDF-1.4\n" + b"test-word-preview" * 100)
            return "test-word"

        with patch.object(main, "convert_docx_to_pdf", side_effect=fake_word_preview):
            word_response = self.client.get(
                f"/api/admin/interviews/{interview_id}/document-preview?format=docx",
                headers=admin_headers,
            )
        self.assertEqual(word_response.status_code, 200, word_response.text)
        self.assertEqual(word_response.headers["x-document-format"], "docx")
        self.assertEqual(word_response.headers["x-document-renderer"], "test-word")

        self.assertEqual(
            self.client.get(
                f"/api/admin/interviews/{interview_id}/document-preview?format=pdf",
                headers=student_headers,
            ).status_code,
            403,
        )
        self.assertEqual(
            self.client.get(
                f"/api/admin/interviews/{interview_id}/document-preview?format=exe",
                headers=admin_headers,
            ).status_code,
            422,
        )
        with self.Session() as db:
            self.assertEqual(db.scalar(select(func.count()).select_from(main.InterviewDocument)), 0)
        self.assertEqual(list(self.document_path.iterdir()), [])

        main._document_preview_attempts.clear()
        with patch.object(main, "DOCUMENT_PREVIEW_RATE_MAX_REQUESTS", 1):
            first = self.client.get(
                f"/api/admin/interviews/{interview_id}/document-preview?format=pdf",
                headers=admin_headers,
            )
            limited = self.client.get(
                f"/api/admin/interviews/{interview_id}/document-preview?format=pdf",
                headers=admin_headers,
            )
        self.assertEqual(first.status_code, 200)
        self.assertEqual(limited.status_code, 429)

    def test_legacy_document_report_is_safely_bounded(self):
        legacy = json.loads(valid_report_json())
        legacy["dimensions"] = {"旧维度": {"score": 999, "evidence": "证" * 3_000}}
        legacy["highlights"] = ["亮" * 3_000 for _ in range(30)]
        bounded = main.document_report_payload(json.dumps(legacy, ensure_ascii=False), [])
        self.assertEqual(len(bounded["highlights"]), 10)
        self.assertTrue(all(len(item) <= 2_000 for item in bounded["highlights"]))
        self.assertEqual(bounded["dimensions"]["旧维度"]["score"], 100)
        self.assertLessEqual(len(bounded["dimensions"]["旧维度"]["evidence"]), 2_000)
        self.assertIn("conversation_summary", bounded)

    def test_admin_operations_exposes_checkpoint_logs_and_audited_intervention(self):
        with self.Session() as db:
            student = main.User(
                username="ops-student",
                display_name="断点测试学生",
                password_hash=main.hash_password("student-password"),
                role="student",
            )
            admin = main.User(
                username="ops-admin",
                display_name="运维管理员",
                password_hash=main.hash_password("admin-password"),
                role="admin",
            )
            db.add_all([student, admin]); db.flush()
            resume = main.Resume(user_id=student.id, source="quick-form", title="测试简历", content="测试内容")
            db.add(resume); db.flush()
            interview = main.Interview(
                user_id=student.id,
                resume_id=resume.id,
                target_role="测试工程师",
                status="paused",
                pause_used=True,
                paused_at=main.utcnow_naive(),
                pause_deadline=main.utcnow_naive() + main.timedelta(minutes=5),
            )
            db.add(interview); db.flush()
            db.add_all([
                main.InterviewMessage(interview_id=interview.id, speaker="interviewer", kind="question", content="请介绍一个项目。"),
                main.InterviewMessage(interview_id=interview.id, speaker="candidate", kind="answer", content="我负责接口测试。"),
            ])
            main.add_system_event(
                db, level="info", category="state", event="interview.paused",
                message="测试暂停事件", interview_id=interview.id, user_id=student.id,
            )
            db.commit()
            interview_id = interview.id
            admin_headers = {"Authorization": f"Bearer {main.token_for(admin)}"}
            student_headers = {"Authorization": f"Bearer {main.token_for(student)}"}

        runtime = self.client.get("/api/admin/runtime", headers=admin_headers)
        self.assertEqual(runtime.status_code, 200, runtime.text)
        checkpoint = next(item for item in runtime.json()["interviews"] if item["id"] == interview_id)
        self.assertEqual(checkpoint["status"], "paused")
        self.assertTrue(checkpoint["checkpoint"]["recoverable"])
        self.assertEqual(checkpoint["answer_count"], 1)

        events = self.client.get(
            f"/api/admin/events?interview_id={interview_id}&page=1&page_size=10",
            headers=admin_headers,
        )
        self.assertEqual(events.status_code, 200, events.text)
        self.assertEqual(events.json()["items"][0]["event"], "interview.paused")

        denied = self.client.post(
            f"/api/admin/interviews/{interview_id}/control",
            headers=student_headers,
            json={"action": "resume", "reason": "没有管理员权限"},
        )
        self.assertEqual(denied.status_code, 403)

        resumed = self.client.post(
            f"/api/admin/interviews/{interview_id}/control",
            headers=admin_headers,
            json={"action": "resume", "reason": "浏览器崩溃后人工确认恢复"},
        )
        self.assertEqual(resumed.status_code, 200, resumed.text)
        self.assertEqual(resumed.json()["status"], "active")
        audit = self.client.get(
            f"/api/admin/events?interview_id={interview_id}&category=intervention",
            headers=admin_headers,
        ).json()["items"][0]
        self.assertEqual(audit["event"], "admin.resume")
        self.assertEqual(audit["details"]["from"], "paused")
        self.assertEqual(audit["details"]["to"], "active")


    def test_recording_chunks_are_ordered_idempotent_and_finalized(self):
        _, headers = self.register()
        interview_id = self.start_interview(headers, self.create_resume(headers))
        base = f"/api/interviews/{interview_id}/recording/chunks?upload_id=upload-test-001"

        first = self.client.post(
            f"{base}&index=0&final=false",
            headers=headers,
            files={"file": ("part-0.webm", b"first-part", "video/webm;codecs=vp8,opus")},
        )
        self.assertEqual(first.status_code, 200, first.text)
        duplicate = self.client.post(
            f"{base}&index=0&final=false",
            headers=headers,
            files={"file": ("part-0.webm", b"first-part", "video/webm")},
        )
        self.assertEqual(duplicate.status_code, 200, duplicate.text)
        self.assertTrue(duplicate.json()["duplicate"])
        conflicting = self.client.post(
            f"{base}&index=0&final=false",
            headers=headers,
            files={"file": ("part-0.webm", b"different", "video/webm")},
        )
        self.assertEqual(conflicting.status_code, 409)

        final = self.client.post(
            f"{base}&index=1&final=true",
            headers=headers,
            files={"file": ("part-1.webm", b"last-part", "video/webm")},
        )
        self.assertEqual(final.status_code, 200, final.text)
        self.assertTrue(final.json()["completed"])
        recording = self.client.get(f"/api/interviews/{interview_id}/recording", headers=headers)
        self.assertEqual(recording.status_code, 200)
        self.assertEqual(recording.content, b"first-partlast-part")

        after_final = self.client.post(
            f"{base}&index=2&final=true",
            headers=headers,
            files={"file": ("part-2.webm", b"", "video/webm")},
        )
        self.assertEqual(after_final.status_code, 409)

        replacement_base = f"/api/interviews/{interview_id}/recording/chunks?upload_id=upload-test-002"
        replacement = self.client.post(
            f"{replacement_base}&index=0&final=true",
            headers=headers,
            files={"file": ("replacement.webm", b"replacement", "video/webm")},
        )
        self.assertEqual(replacement.status_code, 200, replacement.text)
        replaced_recording = self.client.get(f"/api/interviews/{interview_id}/recording", headers=headers)
        self.assertEqual(replaced_recording.content, b"replacement")
        archived_sessions = list(self.recording_path.glob(f"*-interview-{interview_id}.session-*.webm"))
        self.assertEqual([path.read_bytes() for path in archived_sessions], [b"first-partlast-part"])

        with self.Session() as db:
            interview = db.get(main.Interview, interview_id)
            main.interview_recording_manifest_path(interview).write_text("{broken", encoding="utf-8")
        recovered = self.client.post(
            f"/api/interviews/{interview_id}/recording/chunks?upload_id=upload-test-003&index=0&final=true",
            headers=headers,
            files={"file": ("recovered.webm", b"recovered", "video/webm")},
        )
        self.assertEqual(recovered.status_code, 200, recovered.text)
        recovered_recording = self.client.get(f"/api/interviews/{interview_id}/recording", headers=headers)
        self.assertEqual(recovered_recording.content, b"recovered")
        archived_contents = {
            path.read_bytes()
            for path in self.recording_path.glob(f"*-interview-{interview_id}.session-*.webm")
        }
        self.assertEqual(archived_contents, {b"first-partlast-part", b"replacement"})

        with patch.object(main, "MAX_RECORDING_CHUNK_BYTES", 4):
            rejected_replacement = self.client.post(
                f"/api/interviews/{interview_id}/recording/chunks?upload_id=upload-test-004&index=0&final=true",
                headers=headers,
                files={"file": ("too-large.webm", b"12345", "video/webm")},
            )
        self.assertEqual(rejected_replacement.status_code, 413)
        preserved = self.client.get(f"/api/interviews/{interview_id}/recording", headers=headers)
        self.assertEqual(preserved.content, b"recovered")

        lock_key = f"recording:{interview_id}"
        lock = main.operation_lock(lock_key)
        self.assertTrue(lock.acquire(blocking=False))
        try:
            blocked = self.client.post(
                f"/api/interviews/{interview_id}/recording",
                headers=headers,
                files={"file": ("full.webm", b"full-upload", "video/webm")},
            )
        finally:
            main.release_operation_lock(lock_key, lock)
        self.assertEqual(blocked.status_code, 409)
        unchanged = self.client.get(f"/api/interviews/{interview_id}/recording", headers=headers)
        self.assertEqual(unchanged.content, b"recovered")

        with patch.object(Path, "replace", side_effect=PermissionError("locked")):
            blocked_delete = self.client.delete(f"/api/interviews/{interview_id}", headers=headers)
        self.assertEqual(blocked_delete.status_code, 409)
        self.assertEqual(self.client.get(f"/api/interviews/{interview_id}", headers=headers).status_code, 200)
        self.assertEqual(
            self.client.get(f"/api/interviews/{interview_id}/recording", headers=headers).content,
            b"recovered",
        )

        deleted = self.client.delete(f"/api/interviews/{interview_id}", headers=headers)
        self.assertEqual(deleted.status_code, 200, deleted.text)
        self.assertEqual(self.client.get(f"/api/interviews/{interview_id}", headers=headers).status_code, 404)
        self.assertEqual(list(self.recording_path.glob(f"*-interview-{interview_id}.*")), [])

    def test_unexpected_deepseek_transport_error_maps_to_bad_gateway(self):
        class FailingClient:
            def __init__(self, *args, **kwargs):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def post(self, *_args, **_kwargs):
                raise httpx.RemoteProtocolError("connection closed")

        with patch.object(main, "deepseek_api_key", return_value="configured-test-key"), patch.object(httpx, "Client", FailingClient):
            with self.assertRaises(HTTPException) as caught:
                main.deepseek_chat([{"role": "user", "content": "测试"}])
        self.assertEqual(caught.exception.status_code, 502)

    def test_deepseek_usage_ledger_tracks_cache_pricing_and_budget_views(self):
        class SuccessfulResponse:
            headers = {"x-request-id": "provider-request-001"}

            @staticmethod
            def raise_for_status():
                return None

            @staticmethod
            def json():
                return {
                    "choices": [{"message": {"content": "请介绍你的项目成果。"}}],
                    "usage": {
                        "prompt_tokens": 1000,
                        "prompt_cache_hit_tokens": 100,
                        "prompt_cache_miss_tokens": 900,
                        "completion_tokens": 200,
                        "total_tokens": 1200,
                    },
                }

        class SuccessfulClient:
            def __init__(self):
                self.post_count = 0

            def post(self, *_args, **_kwargs):
                self.post_count += 1
                return SuccessfulResponse()

        body, headers = self.register("budget-ledger-student")
        client = SuccessfulClient()
        with (
            patch.object(main, "deepseek_api_key", return_value="configured-test-key"),
            patch.object(main, "_deepseek_client", client),
            patch.object(main, "DEEPSEEK_INPUT_CACHE_HIT_CNY_PER_MILLION", Decimal("0.02")),
            patch.object(main, "DEEPSEEK_INPUT_CACHE_MISS_CNY_PER_MILLION", Decimal("1")),
            patch.object(main, "DEEPSEEK_OUTPUT_CNY_PER_MILLION", Decimal("2")),
        ):
            result = main.deepseek_chat(
                [{"role": "user", "content": "开始面试"}],
                max_tokens=500,
                user_id=body["user"]["id"],
                operation="interview_start",
            )
            budget = self.client.get("/api/me/api-budget", headers=headers)

            with self.Session() as db:
                admin = main.User(
                    username="budget-ledger-admin",
                    display_name="成本管理员",
                    password_hash=main.hash_password("safe-admin-password"),
                    role="admin",
                )
                db.add(admin)
                db.commit()
                admin_headers = {"Authorization": f"Bearer {main.token_for(admin)}"}

            admin_costs = self.client.get("/api/admin/api-costs?days=7", headers=admin_headers)

        self.assertEqual(result, "请介绍你的项目成果。")
        self.assertEqual(client.post_count, 1)
        with self.Session() as db:
            usage = db.scalar(select(main.ApiUsage))
            self.assertEqual(usage.status, "completed")
            self.assertEqual(usage.prompt_tokens, 1000)
            self.assertEqual(usage.cache_hit_tokens, 100)
            self.assertEqual(usage.cache_miss_tokens, 900)
            self.assertEqual(usage.completion_tokens, 200)
            self.assertEqual(usage.actual_cost_micros, 1302)
            self.assertEqual(usage.provider_request_id, "provider-request-001")

        self.assertEqual(budget.status_code, 200, budget.text)
        self.assertEqual(budget.json()["user_daily_calls"]["used"], 1)
        self.assertEqual(budget.json()["user_daily_tokens"]["used"], 1200)
        self.assertEqual(self.client.get("/api/admin/api-costs", headers=headers).status_code, 403)
        self.assertEqual(admin_costs.status_code, 200, admin_costs.text)
        self.assertEqual(admin_costs.json()["by_operation"][0]["operation"], "interview_start")
        self.assertEqual(admin_costs.json()["recent"][0]["cache_hit_tokens"], 100)
        self.assertEqual(admin_costs.json()["recent"][0]["cost_cny"], 0.001302)

    def test_daily_call_limit_blocks_before_provider_request(self):
        class SuccessfulResponse:
            headers = {}

            @staticmethod
            def raise_for_status():
                return None

            @staticmethod
            def json():
                return {
                    "choices": [{"message": {"content": "下一题"}}],
                    "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
                }

        class CountingClient:
            def __init__(self):
                self.post_count = 0

            def post(self, *_args, **_kwargs):
                self.post_count += 1
                return SuccessfulResponse()

        body, _ = self.register("budget-limit-student")
        client = CountingClient()
        kwargs = {
            "max_tokens": 10,
            "user_id": body["user"]["id"],
            "operation": "interview_answer",
        }
        with (
            patch.object(main, "deepseek_api_key", return_value="configured-test-key"),
            patch.object(main, "_deepseek_client", client),
            patch.object(main, "DEEPSEEK_USER_DAILY_CALL_LIMIT", 1),
        ):
            self.assertEqual(main.deepseek_chat([{"role": "user", "content": "第一次"}], **kwargs), "下一题")
            with self.assertRaises(HTTPException) as caught:
                main.deepseek_chat([{"role": "user", "content": "第二次"}], **kwargs)

        self.assertEqual(caught.exception.status_code, 429)
        self.assertEqual(client.post_count, 1)
        with self.Session() as db:
            self.assertEqual(db.scalar(select(func.count()).select_from(main.ApiUsage)), 1)

    def create_resume_id_from_interview(self, interview_id: int) -> int:
        with self.Session() as db:
            return db.get(main.Interview, interview_id).resume_id


if __name__ == "__main__":
    unittest.main()
