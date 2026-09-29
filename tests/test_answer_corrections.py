"""Offline regression coverage: no provider calls and no production records."""
import json
import unittest
from unittest.mock import patch
from sqlalchemy import select
import test_api as fixtures
from apps.server.app import main
from apps.server.app.answer_corrections import CorrectionPlan, explicit_correction, validated_edit


class IntentTests(unittest.TestCase):
    def test_explicit_self_corrections(self):
        for text in ['我说错了', '我刚才说错了，应该是三个人', '更正一下上一题的数字',
                     '刚才说的那段不准确', '刚才识别错了，是三个月', '不对，应该是六周']:
            with self.subTest(text=text):
                self.assertTrue(explicit_correction(text))

    def test_negative_story_and_quoted_words_are_not_corrections(self):
        for text in ['我没有做过运维', '这个方案不对，所以我做了调整', '当时我说错了，后来向客户道歉',
                     '同学说“我说错了”，我们重新讨论', '我没有说错了还不承认的习惯', '我不想更正刚才的回答']:
            with self.subTest(text=text):
                self.assertFalse(explicit_correction(text))

    def test_literal_edits_are_scoped(self):
        plan = CorrectionPlan(target_answer_id=3, original_text='五人', replacement_text='三人')
        self.assertEqual(validated_edit(plan, {3: '五人团队，我负责后端'}, '三人'), (3, '三人团队，我负责后端'))
        self.assertIsNone(validated_edit(plan, {4: '五人'}, '三人'))
        self.assertIsNone(validated_edit(plan, {3: '五人和五人'}, '三人'))
        self.assertIsNone(validated_edit(plan, {3: '五人'}, '没有给出新内容'))
        whole = plan.model_copy(update={'scope': 'whole_answer'})
        self.assertIsNone(validated_edit(whole, {3: '五人'}, '三人'))


class CorrectionApiTests(unittest.TestCase):
    setUpClass = classmethod(fixtures.ApiRegressionTests.setUpClass.__func__)
    tearDownClass = classmethod(fixtures.ApiRegressionTests.tearDownClass.__func__)
    register = fixtures.ApiRegressionTests.register
    create_resume = fixtures.ApiRegressionTests.create_resume
    start_interview = fixtures.ApiRegressionTests.start_interview

    def setUp(self):
        fixtures.ApiRegressionTests.setUp(self)
        _, self.headers = self.register()
        self.iid = self.start_interview(self.headers, self.create_resume(self.headers))
        self.seq = 0

    def record(self):
        response = self.client.get(f'/api/interviews/{self.iid}', headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def answer(self, text, plan=None, request_id=None, raw=None):
        self.seq += 1
        decision = json.loads(fixtures.valid_agent_json(question='你提到五人团队，能说明如何分工吗？'))
        decision['correction'] = plan
        with patch.object(main, 'deepseek_chat', return_value=raw or json.dumps(decision, ensure_ascii=False)) as model:
            result = self.client.post(f'/api/interviews/{self.iid}/answers', headers=self.headers,
                json={'transcript': text, 'request_id': request_id or f'correction-test-{self.seq}'})
        self.assertEqual(result.status_code, 200, result.text)
        return result.json(), model

    def base_answer(self):
        self.answer('我们是五人团队，我负责后端接口和自动化测试。')
        return next(m['id'] for m in self.record()['messages'] if m['speaker'] == 'candidate')

    def propose(self, target, **extra):
        return {'intent': 'request', 'target_answer_id': target, 'original_text': '五人',
                'replacement_text': '三人', 'reason': 'slip', **extra}

    def test_cross_turn_confirmation_is_local_idempotent_and_preserves_raw(self):
        target = self.base_answer()
        proposed, _ = self.answer('我刚才说错了，团队其实是三人。', self.propose(target))
        self.assertEqual(proposed['question_count'], 2)
        self.assertEqual(proposed['avatar_cue']['id'], 'none')
        self.assertTrue(proposed['correction']['can_confirm'])
        pending_record = self.record()
        self.assertIsNotNone(pending_record['pending_correction'])
        self.assertEqual(self.client.post(f'/api/interviews/{self.iid}/finish', headers=self.headers).status_code, 409)
        confirmed, model = self.answer('确认更正', request_id='confirm-repeatable')
        model.assert_not_called()
        repeat, model = self.answer('确认更正', request_id='confirm-repeatable')
        model.assert_not_called()
        self.assertEqual(confirmed, repeat)
        record = self.record()
        self.assertIsNone(record['pending_correction'])
        self.assertEqual(len(record['corrections']), 1)
        original = next(m for m in record['messages'] if m['id'] == target)
        self.assertIn('五人', original['content'])
        self.assertIn('三人', original['effective_content'])
        self.assertNotIn('五人', original['effective_content'])
        self.assertIn('后端接口和自动化测试', original['effective_content'])

    def test_report_next_question_and_export_use_confirmed_evidence(self):
        target = self.base_answer()
        self.answer('我说错了，团队是三人', self.propose(target))
        self.answer('对')
        _, model = self.answer('我负责接口，另一位负责前端，第三位负责验收。')
        context = model.call_args.args[0][1]['content']
        self.assertIn('三人', context)
        self.assertNotIn('五人', context)
        with patch.object(main, 'deepseek_chat', return_value=fixtures.valid_report_json()) as model:
            response = self.client.post(f'/api/interviews/{self.iid}/finish', headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        context = model.call_args.args[0][1]['content']
        # The mocked next question repeats old text after the correction; that is
        # not silently repaired. Real model context must already exclude old facts.
        self.assertNotIn('五人', json.loads(context.split('\n', 1)[1])['conversation'][1]['content'])
        summary = response.json()['conversation_summary']
        self.assertIn('三人', json.dumps(summary, ensure_ascii=False))
        with self.Session() as db:
            rows = main.effective_transcript(self.iid, db)
            report = db.scalar(select(main.InterviewReport).where(main.InterviewReport.interview_id == self.iid))
            document = main.document_report_payload(report.payload_json, rows)
            self.assertIn('三人', json.dumps(document['conversation_summary'], ensure_ascii=False))

    def test_ambiguous_request_asks_scope_and_never_wipes_answers(self):
        target = self.base_answer()
        result, _ = self.answer('我刚才说错了', raw='not-json')
        self.assertFalse(result['correction']['can_confirm'])
        self.assertEqual(result['question_count'], 2)
        proposal, _ = self.answer('上一题的五人应该是三人', self.propose(target, intent='resolve'))
        self.assertTrue(proposal['correction']['can_confirm'])
        self.assertEqual(proposal['correction']['status'], 'pending')
        result, model = self.answer('保留原回答')
        model.assert_not_called()
        self.assertEqual(result['correction']['status'], 'cancelled')
        with self.Session() as db:
            self.assertIn('五人', next(x.content for x in main.effective_transcript(self.iid, db) if x.id == target))

    def test_new_objection_invalidates_previous_proposal(self):
        target = self.base_answer()
        self.answer('我说错了，团队是三人', self.propose(target))
        updated, _ = self.answer('不是这句话，是别的内容')
        self.assertFalse(updated['correction']['can_confirm'])
        result, model = self.answer('对')
        model.assert_not_called()
        self.assertEqual(result['correction']['status'], 'pending')

    def test_intra_answer_correction_retains_unrelated_facts(self):
        result, _ = self.answer('我们是五人团队，我说错了，实际是三人。我负责后端。', self.propose(0))
        self.assertTrue(result['correction']['can_confirm'])
        target = result['correction']['target_answer_id']
        self.answer('确认更正')
        original = next(m for m in self.record()['messages'] if m['id'] == target)
        self.assertNotIn('五人', original['effective_content'])
        self.assertIn('我负责后端', original['effective_content'])

    def test_foreign_target_and_model_invented_replacement_rejected(self):
        target = self.base_answer()
        result, _ = self.answer('我说错了，团队是三人', self.propose(target + 9999))
        self.assertFalse(result['correction']['can_confirm'])
        result, _ = self.answer('应该是三人', self.propose(target, replacement_text='九人'))
        self.assertFalse(result['correction']['can_confirm'])
        _, stranger = self.register('other-student')
        response = self.client.post(f'/api/interviews/{self.iid}/answers', headers=stranger,
            json={'transcript': '确认更正', 'request_id': 'unauthorized-confirm'})
        self.assertEqual(response.status_code, 404)

    def test_whole_answer_requires_explicit_scope(self):
        target = self.base_answer()
        result, _ = self.answer('我说错了，团队是三人', self.propose(target, scope='whole_answer'))
        self.assertFalse(result['correction']['can_confirm'])
        result, _ = self.answer('我要重新回答整题：我负责前端。', self.propose(target, intent='resolve',
            scope='whole_answer', original_text='', replacement_text='我负责前端。'))
        self.assertTrue(result['correction']['can_confirm'])
        self.answer('确认更正')
        with self.Session() as db:
            self.assertEqual(next(x.content for x in main.effective_transcript(self.iid, db) if x.id == target), '我负责前端。')

    def test_second_correction_builds_on_confirmed_version(self):
        target = self.base_answer()
        self.answer('我说错了，是三人', self.propose(target))
        self.answer('确认更正')
        self.answer('更正一下上一题，准确人数是四人', self.propose(target, original_text='三人', replacement_text='四人'))
        self.answer('确认更正')
        with self.Session() as db:
            content = next(x.content for x in main.effective_transcript(self.iid, db) if x.id == target)
            self.assertIn('四人', content)
            self.assertNotIn('三人', content)

    def test_restore_pause_and_closed_session_confirmation(self):
        target = self.base_answer()
        result, _ = self.answer('我说错了，是三人', self.propose(target))
        session = self.client.post(f'/api/interviews/{self.iid}/session/open', headers=self.headers,
            json={'request_id': 'restored-session'}).json()
        self.assertEqual(session['question_override'], result['question'])
        with self.Session() as db:
            transition = main.resume_transition(main.interview_transcript(self.iid, db), self.iid, db)
            self.assertIn('还没有确认', transition)
            interview = db.get(main.Interview, self.iid)
            interview.status = 'pause_expired'
            db.commit()
        result, model = self.answer('确认更正')
        model.assert_not_called()
        self.assertTrue(result['should_finish'])
        self.assertEqual(self.record()['status'], 'pause_expired')

    def test_api_ledger_can_write_before_answer_transaction(self):
        def simulate_provider(*args, **kwargs):
            with self.Session() as db:
                db.add(main.InterviewMessage(interview_id=self.iid, speaker='interviewer', kind='test', content='ledger-write-test'))
                db.commit()
            return fixtures.valid_agent_json()
        with patch.object(main, 'deepseek_chat', side_effect=simulate_provider):
            response = self.client.post(f'/api/interviews/{self.iid}/answers', headers=self.headers,
                json={'transcript': '我负责后端接口开发。', 'request_id': 'ledger-does-not-lock'})
        self.assertEqual(response.status_code, 200, response.text)

    def test_ordinary_negative_does_not_start_correction(self):
        result, _ = self.answer('我没有这项经验，但愿意学习。')
        self.assertNotIn('correction_handled', result)
        self.assertEqual(self.record()['corrections'], [])

    def test_silence_after_bare_retraction_does_not_create_fake_report_evidence(self):
        self.answer('我说错了')
        for i in range(main.MAX_CONSECUTIVE_INVALID_ANSWERS):
            response = self.client.post(f'/api/interviews/{self.iid}/no-input', headers=self.headers,
                json={'request_id': f'no-input-correction-{i}'})
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()['can_generate_report'])
        result, model = self.answer('保留原回答')
        model.assert_not_called()
        self.assertFalse(result['can_generate_report'])
        self.assertTrue(result['should_finish'])

    def test_delete_removes_correction_audit(self):
        target = self.base_answer()
        self.answer('我说错了，是三人', self.propose(target))
        result = self.client.delete(f'/api/interviews/{self.iid}', headers=self.headers)
        self.assertEqual(result.status_code, 200, result.text)
        with self.Session() as db:
            self.assertEqual(main.correction_rows(self.iid, db), [])


if __name__ == '__main__':
    unittest.main()
