"""Conservative, server-owned avatar cues; no extra LLM request.

An acknowledgment is reception, never an assessment of factual correctness.
Missing/legacy decisions fail closed. The intent comes from the same interview
decision as the question, never from a client-provided animation identifier.
"""
import re

ACKNOWLEDGE_CUE = "acknowledge_ok_v1"
_DOUBT = re.compile(
    r"含糊|模糊|笼统|蒙混|回避|存疑|夸大|真实性|前后.{0,4}矛盾|自相矛盾|"
    r"(?:不够|还不|尚不)(?:具体|清楚|明确|充分)|"
    r"(?:没有|尚未|未能)(?:说明|说清|解释|提供)|"
    r"(?:证据|依据)(?:不足|缺失|不充分)|缺乏.{0,6}(?:依据|证据)|"
    r"(?:无法|难以|不能)(?:核实|验证|确认|判断)|"
    r"(?:能否|如何|怎么|你能)(?:证明|核实)|真的(?:是你|由你)|"
    r"unclear|vague|contradict|unverif|insufficient evidence",
    re.IGNORECASE,
)


def select_avatar_cue(result: dict) -> dict:
    """Deliberately prefer a missed nod over affirmation during a challenge."""
    if result.get("invalid_answer") or result.get("should_finish"):
        return {"id": "none", "reason": "invalid_or_finished"}
    decision = result.get("agent_decision")
    if not isinstance(decision, dict):
        return {"id": "none", "reason": "missing_decision"}
    if decision.get("response_intent") != "acknowledge":
        return {"id": "none", "reason": "non_acknowledging_intent"}
    if decision.get("action") not in {"follow_up", "next_topic"}:
        return {"id": "none", "reason": "non_continuing_action"}
    # Backstop for inconsistent model output. These are explicit doubt markers,
    # not a blanket ban on asking '具体' or on ordinary constructive follow-ups.
    evidence = " ".join(str(decision.get(k) or "") for k in ("reason", "evidence_gap"))
    question = str(result.get("question") or "")
    if not question.strip() or _DOUBT.search(evidence + " " + question):
        return {"id": "none", "reason": "doubt_or_missing_question"}
    return {"id": ACKNOWLEDGE_CUE, "reason": "normal_acknowledgment"}
