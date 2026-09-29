"""Correction intent and literal, evidence-bound revisions (no model calls)."""
import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class CorrectionPlan(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)
    intent: Literal["request", "resolve", "cancel"] = "request"
    target_answer_id: int | None = Field(default=None, ge=0)
    original_text: str = Field(default="", max_length=4000)
    replacement_text: str = Field(default="", max_length=4000)
    scope: Literal["detail", "whole_answer"] = "detail"
    reason: Literal["slip", "asr", "knowledge", "unspecified"] = "unspecified"
    explanation: str = Field(default="", max_length=1000)


def explicit_correction(text: str) -> bool:
    # A negative answer, a quoted instruction, or an old mistake in a project
    # story is not by itself a retraction of this interview's answer.
    value = re.sub(r'[“「『"].*?[”」』"]', '', text)
    value = re.sub(r"(?:并没有|没有|并非|不是|没|不)(?:要|想|打算|需要)?(?:说错|讲错|更正|纠正)", "", value)
    return bool(re.search(
        r"(?:我(?:刚才|前面|之前)?(?:说错了|讲错了|记错了|口误了))|"
        r"(?:更正|纠正|修改|收回|撤回)(?:一下)?(?:我)?(?:刚才|前面|上一题|之前)(?:的)?(?:回答|说法|数字|表述)?|"
        r"(?:刚才|刚刚|前面|之前|上一题)(?:我)?(?:说的|回答的|那段|那句|那个数字|那个数据|的回答|的答案|的说法).{0,16}(?:不对|不准确|有误|说错|不算|作废|不是事实)|"
        r"(?:上一题|刚才那题|前面那题)(?:我)?(?:答错了|回答错了)|"
        r"(?:刚才|前面).{0,8}(?:识别错了|转写错了)|"
        r"(?:不对|口误)[，,。\s]*(?:应该是|准确地说|我说的是)", value)) and not bool(
            re.search(r"(?:当时|那时候|去年|以前).{0,6}我(?:说错了|讲错了|记错了)", value)
        )


def is_confirmation(text: str) -> bool:
    return re.sub(r'[\s，。！!,.]', '', text) in {
        "是", "对", "是的", "对的", "没错", "确认", "确认更正", "是这样", "就按这个更正", "就是这个意思",
    }


def is_cancellation(text: str) -> bool:
    return re.sub(r'[\s，。！!,.]', '', text) in {
        "取消更正", "不用更正", "保留原回答", "刚才没有说错", "我没有要更正", "不是要更正", "按原回答",
    }


def allows_whole_answer(text: str) -> bool:
    return bool(re.search(r"整(?:题|段|个回答)|全部(?:不算|作废)|重新回答|整个重答", text))


def validated_edit(plan: CorrectionPlan, answers: dict[int, str], text: str,
                   *, current_id: int | None = None, allow_whole: bool = False) -> tuple[int, str] | None:
    target = current_id if plan.target_answer_id == 0 else plan.target_answer_id
    if target not in answers or not plan.replacement_text or plan.replacement_text not in text:
        return None
    original = answers[target]
    if plan.scope == "whole_answer":
        return (target, plan.replacement_text) if allow_whole else None
    # An exact, unique span protects unrelated parts and repeated numerical facts.
    if not plan.original_text or original.count(plan.original_text) != 1:
        return None
    if plan.original_text == plan.replacement_text:
        return None
    return target, original.replace(plan.original_text, plan.replacement_text, 1)


def correction_question(plan: CorrectionPlan | None, variant: int = 0) -> str:
    if plan and plan.scope == "whole_answer" and plan.replacement_text:
        return "你希望用刚才重新说明的整段内容替换选中的那一轮回答，对吗？其他轮次的回答会继续保留。"
    if plan and plan.original_text and plan.replacement_text and max(len(plan.original_text), len(plan.replacement_text)) <= 90:
        return (
            f"我确认一下，你想把“{plan.original_text}”更正为“{plan.replacement_text}”，其余内容保持不变，对吗？",
            f"你的意思是，刚才的“{plan.original_text}”应改成“{plan.replacement_text}”，对吗？我会保留其他部分。",
            f"我们核对这一处：将“{plan.original_text}”改为“{plan.replacement_text}”，除此之外没有修改，是这样吗？",
        )[variant % 3]
    if plan and plan.reason == "asr":
        return "是刚才的语音识别与你的原意不一致吗？请指出识别错误的部分，并说一下你原本想表达的内容。"
    if plan and plan.reason == "knowledge":
        return "你想修正刚才哪一步的判断？请说一下修正后的结论，以及你这样调整的依据。"
    return (
        "你想更正刚才哪一部分？请把原来的说法和正确内容说明一下，其他回答会继续保留。",
        "可以更正。你指的是哪道题、哪句话？请补充准确的说法，我会按确认后的内容继续。",
        "我们先确认这处修改：哪些内容需要调整，正确的表述是什么？不用把整段经历重新讲一遍。",
    )[variant % 3]
