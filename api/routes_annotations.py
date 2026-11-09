"""标注读写、批量操作、差异查询与单字段 / 整体回退。"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request

import diffing
import locks
import scanner
import schema
import store
from . import deps

router = APIRouter()


@router.get("/api/projects/{project_id}/annotations/{case_id}")
def api_get_annotation(project_id: str, case_id: str, request: Request) -> dict:
    proj = deps.project(request, project_id)
    idx = deps.index(proj)
    item = deps.case(idx, case_id)
    info = deps.schema_info(proj)
    ann = store.load_annotation(proj, case_id) or store.make_annotation(proj, item, info)
    return {
        "annotation": ann,
        "values": schema.merge_defaults(info["schema"], ann.get("values")),
        "schema_version": info["version"],
    }


@router.put("/api/projects/{project_id}/annotations/{case_id}")
def api_put_annotation(project_id: str, case_id: str, payload: dict, request: Request) -> dict:
    proj = deps.project(request, project_id)
    idx = deps.index(proj)
    item = deps.case(idx, case_id)
    info = deps.schema_info(proj)
    try:
        saved = store.save_annotation(
            proj, item, payload, info, expected_rev=payload.get("expected_rev")
        )
    except store.RevConflict as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "Annotation was changed in another window. Please refresh.",
                "annotation": exc.current,
            },
        )
    except store.AnnotationError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"annotation": saved, "schema_version": info["version"]}


@router.post("/api/projects/{project_id}/annotations/bulk")
def api_bulk_annotations(project_id: str, payload: dict, request: Request) -> dict:
    proj = deps.project(request, project_id)
    # 批量改状态 / 标签期间不允许 schema 迁移或导入插入，保持整批一致。
    with locks.project_lock(proj):
        return _bulk(proj, payload)


def _bulk(proj, payload: dict) -> dict:
    idx = deps.index(proj)
    info = deps.schema_info(proj)

    case_ids = payload.get("case_ids")
    if not isinstance(case_ids, list) or not case_ids:
        raise HTTPException(status_code=400, detail="case_ids must be a non-empty array")
    action = str(payload.get("action") or "")
    if action not in ("status", "add_tags", "remove_tags"):
        raise HTTPException(status_code=400, detail="Invalid bulk action")

    status: str | None = None
    tags: list[str] = []
    if action == "status":
        status = str(payload.get("status") or "")
        if status not in store.STATUSES:
            raise HTTPException(status_code=400, detail=f"Invalid status: {status}")
    else:
        raw_tags = payload.get("tags")
        if not isinstance(raw_tags, list):
            raise HTTPException(status_code=400, detail="tags must be an array")
        for tag in raw_tags:
            text = str(tag).strip()
            if text and text not in tags:
                tags.append(text)

    by_id = scanner.index_map(idx)
    updated: list[dict] = []
    skipped: list[dict] = []
    for raw_case_id in case_ids:
        case_id = str(raw_case_id)
        item = by_id.get(case_id)
        if item is None:
            skipped.append({"case_id": case_id, "reason": "Case not found in this project"})
            continue
        ann = store.load_annotation(proj, case_id) or store.make_annotation(proj, item, info)
        current_tags = [str(t) for t in (ann.get("tags") or [])]
        new_status = ann.get("status") or "draft"
        if action == "status":
            new_status = status or new_status
        elif action == "add_tags":
            for tag in tags:
                if tag not in current_tags:
                    current_tags.append(tag)
        else:
            # 标签保存时按大小写不敏感去重，删除也按同样规则匹配。
            remove_keys = {tag.casefold() for tag in tags}
            current_tags = [tag for tag in current_tags if tag.casefold() not in remove_keys]
        try:
            saved = store.save_annotation(
                proj,
                item,
                {
                    "values": ann.get("values") or {},
                    "notes": ann.get("notes") or {},
                    "evidence": ann.get("evidence") or {},
                    "status": new_status,
                    "tags": current_tags,
                    "baseline_import_id": ann.get("baseline_import_id"),
                },
                info,
                expected_rev=int(ann.get("rev") or 0),
            )
        except store.RevConflict:
            skipped.append(
                {
                    "case_id": case_id,
                    "reason": "Annotation was changed in another window",
                }
            )
            continue
        except store.AnnotationError as exc:
            skipped.append({"case_id": case_id, "reason": str(exc)})
            continue
        updated.append(
            {
                "case_id": case_id,
                "rev": saved["rev"],
                "status": saved["status"],
                "tags": saved["tags"],
                "updated_at": saved["updated_at"],
            }
        )
    return {"updated": len(updated), "skipped": skipped, "cases": updated}


@router.get("/api/projects/{project_id}/diff/{case_id}")
def api_diff(project_id: str, case_id: str, request: Request) -> dict:
    proj = deps.project(request, project_id)
    idx = deps.index(proj)
    item = deps.case(idx, case_id)
    info = deps.schema_info(proj)
    ann = store.load_annotation(proj, case_id) or store.make_annotation(proj, item, info)
    return diffing.diff_for_case(proj, ann, info)


@router.post("/api/projects/{project_id}/annotations/{case_id}/revert")
def api_revert(project_id: str, case_id: str, payload: dict, request: Request) -> dict:
    proj = deps.project(request, project_id)
    idx = deps.index(proj)
    item = deps.case(idx, case_id)
    info = deps.schema_info(proj)
    ann = store.load_annotation(proj, case_id)
    if not ann:
        raise HTTPException(status_code=400, detail="This case has no annotation yet")
    baseline = diffing.baseline_values(proj, ann, info)
    if baseline is None:
        raise HTTPException(status_code=400, detail="This case has no baseline")

    values = ann.get("values") or {}
    revert_all = bool(payload.get("all"))
    raw_paths: list[str] = []
    if revert_all:
        raw_paths = [f["path"] for f in diffing.compute_diff(values, baseline)]
    else:
        if isinstance(payload.get("paths"), list):
            raw_paths.extend(str(path) for path in payload["paths"])
        if payload.get("path") is not None:
            raw_paths.append(str(payload.get("path") or ""))
    if not raw_paths:
        raise HTTPException(status_code=400, detail="Missing path or paths")

    reverted: list[str] = []
    missing: list[str] = []
    restores: list[tuple[str, list[Any], Any]] = []
    deletions: list[tuple[str, list[Any]]] = []
    seen: set[str] = set()
    for path in raw_paths:
        if path in seen:
            continue
        seen.add(path)
        try:
            segs = schema.parse_path(path)
        except schema.SchemaError:
            missing.append(path)
            continue
        if not segs:
            missing.append(path)
            continue
        old = schema.get_value(baseline, segs)
        if old is None:
            deletions.append((path, segs))
        else:
            restores.append((path, segs, old))

    for path, segs, old in restores:
        schema.set_value(values, segs, old)
        reverted.append(path)
    # 按数值下标倒序删除；字符串倒序会让 items[9] 排在 items[10] 前面。
    def _deletion_key(entry):
        return tuple(seg if isinstance(seg, int) else -1 for seg in entry[1])

    for path, segs in sorted(deletions, key=_deletion_key, reverse=True):
        diffing.delete_value(values, segs)
        if revert_all:
            reverted.append(path)
        else:
            missing.append(path)

    saved = store.save_annotation(
        proj,
        item,
        {
            "values": values,
            "notes": ann.get("notes") or {},
            "evidence": ann.get("evidence") or {},
            "status": ann.get("status") or "draft",
            "tags": ann.get("tags") or [],
            "baseline_import_id": ann.get("baseline_import_id"),
        },
        info,
        expected_rev=payload.get("expected_rev"),
    )
    return {"annotation": saved, "reverted": reverted, "missing": missing}
