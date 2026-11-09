"""批量确认与抽样复核队列。

「一键确认」只对同时满足以下条件的 case 生效：有标注且未完成、最低置信度达阈值、
无人工修正差异、必填齐全、无跨字段校验错误。通过筛选的 case 里再按确定性的
hash 抽样保留一部分强制人工复核（打标签、保持 draft），其余标记为 done。

抽样用 ``sha1(project_id:case_id)``，预览与执行得到的是同一批，不会点两次变两批。
"""

from __future__ import annotations

import hashlib
from typing import Any

from fastapi import APIRouter, Request

import diffing
import locks
import scanner
import store
import validation
from . import deps

router = APIRouter()

DEFAULT_SAMPLE_TAG = "review-sample"


def _clamp(value: Any, fallback: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    if number != number:  # NaN
        return fallback
    return min(1.0, max(0.0, number))


def _options(payload: dict) -> dict:
    return {
        "threshold": _clamp(payload.get("threshold", 0.95), 0.95),
        "sample_rate": _clamp(payload.get("sample_rate", 0.1), 0.1),
        "require_clean": payload.get("require_clean", True) is not False,
        "require_required": payload.get("require_required", True) is not False,
        "sample_tag": (
            str(payload.get("sample_tag") or DEFAULT_SAMPLE_TAG).strip()[:40]
            or DEFAULT_SAMPLE_TAG
        ),
    }


def _sampled(project_id: str, case_id: str, rate: float) -> bool:
    if rate <= 0:
        return False
    digest = hashlib.sha1(f"{project_id}:{case_id}".encode("utf-8")).hexdigest()
    return int(digest[:8], 16) / 0xFFFFFFFF < min(rate, 1.0)


def _candidate_ids(idx: dict, payload: dict) -> list[str]:
    raw = payload.get("case_ids")
    # 显式传空数组表示「当前过滤结果为空」，绝不能退化成整个项目。
    if isinstance(raw, list):
        return [str(item) for item in raw][:5000]
    if raw is not None:
        return []
    return [str(item["case_id"]) for item in idx.get("cases", [])]


def _assess(proj, idx: dict, info: dict, payload: dict) -> dict:
    opts = _options(payload)
    by_id = scanner.index_map(idx)
    # 预览上千个 case 时，规则与 baseline 元数据都只准备一次。
    rules = validation.compile_rules(info["schema"])
    baseline_cache = diffing.BaselineCache(proj, info)
    candidate_ids = _candidate_ids(idx, payload)
    eligible: list[str] = []
    sampled: list[str] = []
    skipped: list[dict] = []

    for case_id in candidate_ids:
        item = by_id.get(case_id)
        if item is None:
            skipped.append({"case_id": case_id, "reason": "Case not found"})
            continue
        ann = store.load_annotation(proj, case_id)
        if not ann:
            skipped.append({"case_id": case_id, "reason": "No annotation yet"})
            continue
        if (ann.get("status") or "draft") == "done":
            skipped.append({"case_id": case_id, "reason": "Already done"})
            continue
        reasons: list[str] = []
        confidence = ann.get("confidence") or {}
        scores = []
        if isinstance(confidence, dict):
            for raw in confidence.values():
                try:
                    scores.append(float(raw))
                except (TypeError, ValueError):
                    continue
        if not scores:
            reasons.append("no confidence data")
        elif min(scores) < opts["threshold"]:
            reasons.append("below confidence threshold")
        if opts["require_clean"] and diffing.diff_for_case(proj, ann, info, baseline_cache)["fields"]:
            reasons.append("has corrected fields")
        if opts["require_required"] and validation.missing_required(
            info["schema"], ann.get("values") or {}
        ):
            reasons.append("required fields empty")
        if validation.evaluate_compiled(rules, ann.get("values") or {}):
            reasons.append("validation errors")
        if reasons:
            skipped.append({"case_id": case_id, "reason": "; ".join(reasons)})
            continue
        eligible.append(case_id)
        if _sampled(proj.id, case_id, opts["sample_rate"]):
            sampled.append(case_id)

    return {
        "options": opts,
        "eligible": eligible,
        "sampled": sampled,
        "skipped": skipped,
        "stats": {
            "candidates": len(candidate_ids),
            "eligible": len(eligible),
            "sampled": len(sampled),
            "to_confirm": len(eligible) - len(sampled),
            "skipped": len(skipped),
        },
    }


@router.post("/api/projects/{project_id}/review/preview")
def api_review_preview(project_id: str, payload: dict, request: Request) -> dict:
    proj = deps.project(request, project_id)
    idx = deps.index(proj)
    info = deps.schema_info(proj)
    return _assess(proj, idx, info, payload)


@router.post("/api/projects/{project_id}/review/apply")
def api_review_apply(project_id: str, payload: dict, request: Request) -> dict:
    proj = deps.project(request, project_id)
    # 整批确认是一个临界区：评估、逐条保存之间不能插入 schema 迁移或另一批导入，
    # 否则会按过期判断把已经不合格的 case 标成 done。
    with locks.project_lock(proj):
        return _apply_batch(proj, payload)


def _apply_batch(proj, payload: dict) -> dict:
    idx = deps.index(proj)
    info = deps.schema_info(proj)
    assessed = _assess(proj, idx, info, payload)
    by_id = scanner.index_map(idx)
    sampled_set = set(assessed["sampled"])
    tag = assessed["options"]["sample_tag"]

    confirmed: list[dict] = []
    kept_for_review: list[dict] = []
    skipped: list[dict] = list(assessed["skipped"])
    for case_id in assessed["eligible"]:
        item = by_id.get(case_id)
        ann = store.load_annotation(proj, case_id)
        if item is None or not ann:
            skipped.append({"case_id": case_id, "reason": "Case disappeared"})
            continue
        tags = [str(t) for t in (ann.get("tags") or [])]
        if case_id in sampled_set and tag not in tags:
            tags.append(tag)
        status = "draft" if case_id in sampled_set else "done"
        try:
            saved = store.save_annotation(
                proj,
                item,
                {
                    "values": ann.get("values") or {},
                    "notes": ann.get("notes") or {},
                    "confidence": ann.get("confidence") or {},
                    "evidence": ann.get("evidence") or {},
                    "status": status,
                    "tags": tags,
                    "baseline_import_id": ann.get("baseline_import_id"),
                },
                info,
                expected_rev=int(ann.get("rev") or 0),
            )
        except store.RevConflict:
            skipped.append(
                {"case_id": case_id, "reason": "Annotation changed in another window"}
            )
            continue
        except store.AnnotationError as exc:
            skipped.append({"case_id": case_id, "reason": str(exc)})
            continue
        entry = {
            "case_id": case_id,
            "rev": saved["rev"],
            "status": saved["status"],
            "tags": saved["tags"],
            "updated_at": saved["updated_at"],
        }
        if case_id in sampled_set:
            kept_for_review.append(entry)
        else:
            confirmed.append(entry)

    return {
        "confirmed": len(confirmed),
        "kept_for_review": len(kept_for_review),
        "sample_tag": tag,
        "skipped": skipped,
        "cases": confirmed + kept_for_review,
    }
