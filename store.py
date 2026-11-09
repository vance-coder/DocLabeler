"""标注、baseline 与导入记录的文件存储。"""

from __future__ import annotations

import math
import re
import threading
from pathlib import Path
from typing import Any

import jsonio
import locks
import schema

STATUSES = ("draft", "done")
_CASE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_\-]{0,120}$")

_locks: dict[str, threading.Lock] = {}
_guard = threading.Lock()


class AnnotationError(ValueError):
    pass


class RevConflict(Exception):
    def __init__(self, current: dict | None):
        super().__init__("Annotation was changed in another window")
        self.current = current


def _lock_for(key: str) -> threading.Lock:
    with _guard:
        lock = _locks.get(key)
        if lock is None:
            lock = threading.Lock()
            _locks[key] = lock
        return lock


def _check_case_id(case_id: str) -> str:
    if not _CASE_ID_RE.fullmatch(case_id or ""):
        raise AnnotationError(f"Invalid case ID: {case_id!r}")
    return case_id


def annotation_path(project, case_id: str) -> Path:
    _check_case_id(case_id)
    return project.root / "annotations" / f"{case_id}.json"


def make_annotation(project, case: dict, schema_info: dict) -> dict:
    return {
        "case_id": case["case_id"],
        "source": case["source"],
        "schema_version": schema_info["version"],
        "values": schema.default_value(schema_info["schema"]),
        "notes": {},
        "confidence": {},
        "evidence": {},
        "status": "draft",
        "tags": [],
        "baseline_import_id": None,
        "rev": 0,
        "updated_at": None,
    }


def load_annotation(project, case_id: str) -> dict | None:
    data = jsonio.read_json(annotation_path(project, case_id))
    return data if isinstance(data, dict) else None


def list_annotations(project) -> dict[str, dict]:
    directory = project.root / "annotations"
    out: dict[str, dict] = {}
    if not directory.exists():
        return out
    for path in directory.glob("*.json"):
        # 单个写坏的文件不能让整个项目列表 / 指标接口 500；跳过它，其余照常展示。
        try:
            data = jsonio.read_json(path)
        except (OSError, ValueError):
            continue
        if isinstance(data, dict):
            out[path.stem] = data
    return out


def normalize_evidence(raw: Any) -> dict[str, dict]:
    """字段证据框：``{path: {bbox:[x,y,w,h], page, text}}``，bbox 为 0-1 归一化坐标。

    非法条目直接丢弃而不是抛错，导入 / 旧数据里混进脏坐标时不会拖垮整条标注。
    """
    out: dict[str, dict] = {}
    if not isinstance(raw, dict):
        return out
    for key, value in raw.items():
        if not isinstance(value, dict):
            continue
        bbox = value.get("bbox")
        if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
            continue
        try:
            x, y, w, h = (float(part) for part in bbox)
        except (TypeError, ValueError):
            continue
        if not all(math.isfinite(part) for part in (x, y, w, h)) or w <= 0 or h <= 0:
            continue
        # 负坐标先按越界量缩减宽高，否则 clamp 后框会被凭空放大。
        w = min(w + min(x, 0.0), 1.0)
        h = min(h + min(y, 0.0), 1.0)
        x = min(max(x, 0.0), 1.0)
        y = min(max(y, 0.0), 1.0)
        w = min(w, 1.0 - x)
        h = min(h, 1.0 - y)
        if w <= 0 or h <= 0:
            continue
        try:
            page = max(0, int(value.get("page") or 0))
        except (TypeError, ValueError):
            page = 0
        out[str(key)] = {
            "bbox": [round(x, 6), round(y, 6), round(w, 6), round(h, 6)],
            "page": page,
            "text": str(value.get("text") or "")[:2000],
        }
    return out


def _normalize_payload(payload: dict, current: dict | None) -> dict:
    values = payload.get("values")
    if not isinstance(values, dict):
        raise AnnotationError("Values must be an object")
    notes_in = payload.get("notes") or {}
    if not isinstance(notes_in, dict):
        raise AnnotationError("Notes must be an object")
    notes: dict[str, str] = {}
    for key, text in notes_in.items():
        if text is None:
            continue
        text = str(text)
        if text.strip():
            notes[str(key)] = text
    status = payload.get("status") or "draft"
    if status not in STATUSES:
        raise AnnotationError(f"Invalid status: {status}")
    confidence_in = payload.get(
        "confidence", (current or {}).get("confidence")
    )
    confidence: dict[str, float] = {}
    if isinstance(confidence_in, dict):
        for path, raw in confidence_in.items():
            try:
                number = float(raw)
            except (TypeError, ValueError):
                continue
            if not math.isfinite(number):
                continue
            confidence[str(path)] = max(0.0, min(1.0, number))
    tags_in = payload.get("tags") or []
    if isinstance(tags_in, str):
        tags_in = [t for t in re.split(r"[,，\s]+", tags_in) if t]
    if not isinstance(tags_in, list):
        raise AnnotationError("Tags must be an array")
    # 批量改状态 / 回退 / 导入等路径不带 evidence，此时保留已有证据，避免误删。
    evidence = normalize_evidence(
        payload.get("evidence", (current or {}).get("evidence"))
    )
    # 标签按大小写不敏感去重（Recheck / recheck 视为同一个），保留第一次出现的写法，
    # 避免批量打标签后筛选和导出里出现多个近似标签。
    tags: list[str] = []
    seen_tags: set[str] = set()
    for raw in tags_in:
        tag = str(raw).strip()
        if not tag:
            continue
        key = tag.casefold()
        if key in seen_tags:
            continue
        seen_tags.add(key)
        tags.append(tag)
    return {
        "values": values,
        "notes": notes,
        "confidence": confidence,
        "evidence": evidence,
        "status": status,
        "tags": tags,
        "baseline_import_id": payload.get(
            "baseline_import_id", (current or {}).get("baseline_import_id")
        ),
    }


def save_annotation(
    project,
    case: dict,
    payload: dict,
    schema_info: dict,
    expected_rev: int | None = None,
) -> dict:
    case_id = _check_case_id(case["case_id"])
    # 固定锁序：项目锁 -> case 锁。迁移 / 导入期间持项目锁，单条保存不会插进来
    # 覆盖迁移结果；反过来（先 case 锁再项目锁）会与迁移路径死锁。
    with locks.project_lock(project), _lock_for(f"{project.id}:{case_id}"):
        current = load_annotation(project, case_id)
        current_rev = int((current or {}).get("rev") or 0)
        if expected_rev is not None and int(expected_rev) != current_rev:
            raise RevConflict(current)
        clean = _normalize_payload(payload, current)
        saved = {
            "case_id": case_id,
            "source": case["source"],
            "schema_version": schema_info["version"],
            "values": clean["values"],
            "notes": clean["notes"],
            "confidence": clean["confidence"],
            "evidence": clean["evidence"],
            "status": clean["status"],
            "tags": clean["tags"],
            "baseline_import_id": clean["baseline_import_id"],
            "rev": current_rev + 1,
            "updated_at": schema.now_iso(),
        }
        jsonio.write_json(annotation_path(project, case_id), saved)
        return saved


def migrate_annotations(
    project, old_root: dict, new_root: dict, new_version: int
) -> dict:
    """schema 变更后，按不可变 id 把历史 values key 与备注路径迁到新 schema。

    整个迁移持项目锁，每个 case 再走与 ``save_annotation`` 相同的 case 锁，
    避免「用户正在保存」与「schema 迁移」交错，导致其中一方的写入被静默覆盖。
    """
    migrated = 0
    orphans: list[dict] = []
    with locks.project_lock(project):
        for case_id, ann in list_annotations(project).items():
            with _lock_for(f"{project.id}:{case_id}"):
                # 项目锁已排除本进程内其它写入，list_annotations 读到的就是最新值。
                values = schema.remap_values(old_root, new_root, ann.get("values") or {})
                notes, lost = schema.remap_notes(old_root, new_root, ann.get("notes") or {})
                evidence: dict[str, dict] = {}
                for key, box in (ann.get("evidence") or {}).items():
                    try:
                        segs = schema.parse_path(str(key))
                    except schema.SchemaError:
                        evidence[str(key)] = box
                        continue
                    mapped = schema.remap_path(old_root, new_root, segs)
                    evidence[schema.render_path(mapped) if mapped is not None else str(key)] = box
                # confidence 的 key 也是字段路径；字段改名 / 移动后必须一起迁移，
                # 否则低置信度标记会全部失配。
                confidence: dict[str, float] = {}
                for key, score in (ann.get("confidence") or {}).items():
                    try:
                        segs = schema.parse_path(str(key))
                    except schema.SchemaError:
                        confidence[str(key)] = score
                        continue
                    mapped = schema.remap_path(old_root, new_root, segs)
                    confidence[schema.render_path(mapped) if mapped is not None else str(key)] = score
                updated = dict(ann)
                updated.update(
                    {
                        "values": values,
                        "notes": notes,
                        "confidence": confidence,
                        "evidence": evidence,
                        "schema_version": new_version,
                        "rev": int(ann.get("rev") or 0) + 1,
                        "updated_at": schema.now_iso(),
                    }
                )
                jsonio.write_json(project.root / "annotations" / f"{case_id}.json", updated)
            migrated += 1
            for key in lost:
                orphans.append({"case_id": case_id, "field_path": key})
    return {"migrated": migrated, "orphans": orphans}


# --------------------------------------------------------------------------
# baseline
# --------------------------------------------------------------------------

def baseline_dir(project, import_id: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_\-]*", import_id or ""):
        raise AnnotationError(f"Invalid import ID: {import_id!r}")
    return project.root / ".baseline" / import_id


def load_baseline(project, import_id: str, case_id: str) -> dict | None:
    data = jsonio.read_json(baseline_dir(project, import_id) / "cases" / f"{_check_case_id(case_id)}.json")
    return data if isinstance(data, dict) else None


def baseline_meta(project, import_id: str) -> dict:
    data = jsonio.read_json(baseline_dir(project, import_id) / "meta.json", {})
    return data if isinstance(data, dict) else {}


def write_baseline(project, import_id: str, case_id: str, payload: dict) -> None:
    jsonio.write_json(
        baseline_dir(project, import_id) / "cases" / f"{_check_case_id(case_id)}.json",
        payload,
    )
