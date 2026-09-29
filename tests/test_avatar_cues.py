import unittest

from apps.server.app.avatar_cues import select_avatar_cue


def result(intent='acknowledge', action='next_topic', **kwargs):
    value = {'should_finish':False,'question':'下一段经历中，你如何与团队合作？',
             'agent_decision':{'response_intent':intent,'action':action,'reason':'已经讲清个人行动和结果','evidence_gap':'后续探索协作方式'}}
    value.update(kwargs)
    return value


class AvatarCueTests(unittest.TestCase):
    def test_normal_ack_and_constructive_followup(self):
        for action in ['next_topic','follow_up']:
            self.assertEqual(select_avatar_cue(result(action=action))['id'],'acknowledge_ok_v1')

    def test_doubt_and_unknown_fail_closed(self):
        for intent in ['clarify','challenge','neutral',None,'bogus']:
            self.assertEqual(select_avatar_cue(result(intent=intent))['id'],'none')
        for payload in [{},result(should_finish=True),result(invalid_answer=True),result(action='finish'),result(agent_decision=[]),result(question='')]:
            self.assertEqual(select_avatar_cue(payload)['id'],'none')

    def test_inconsistent_positive_label_is_vetoed(self):
        for text in ['回答含糊其辞','前后说法矛盾','证据不足，需要核实','没有说明个人职责','结果无法验证','你能证明这是自己完成的吗？']:
            payload=result()
            payload['agent_decision']['reason']=text
            self.assertEqual(select_avatar_cue(payload)['id'],'none',text)

    def test_plain_specific_followup_is_not_a_challenge(self):
        self.assertEqual(select_avatar_cue(result(action='follow_up',question='请具体介绍另一段协作经历。'))['id'],'acknowledge_ok_v1')


if __name__=='__main__': unittest.main()
