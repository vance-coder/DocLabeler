"""标注、baseline 与导入记录的文件存储。"""

from __future__ import annotations

import re
import threading
from pathlib import Path

import jsonio
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
        data = jsonio.read_json(path)
        if isinstance(data, dict):
            out[path.stem] = data
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
            confidence[str(path)] = max(0.0, min(1.0, number))
    tags_in = payload.get("tags") or []
    if isinstance(tags_in, str):
        tags_in = [t for t in re.split(r"[,，\s]+", tags_in) if t]
    if not isinstance(tags_in, list):
        raise AnnotationError("Tags must be an array")
    return {
        "values": values,
        "notes": notes,
        "confidence": confidence,
        "status": status,
        "tags": [str(t).strip() for t in tags_in if str(t).strip()],
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
    with _lock_for(f"{project.id}:{case_id}"):
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
    """schema 变更后，按不可变 id 把历史 values key 与备注路径迁到新 schema。"""
    migrated = 0
    orphans: list[dict] = []
    for case_id, ann in list_annotations(project).items():
        values = schema.remap_values(old_root, new_root, ann.get("values") or {})
        notes, lost = schema.remap_notes(old_root, new_root, ann.get("notes") or {})
        ann["values"] = values
        ann["notes"] = notes
        ann["schema_version"] = new_version
        ann["rev"] = int(ann.get("rev") or 0) + 1
        ann["updated_at"] = schema.now_iso()
        jsonio.write_json(project.root / "annotations" / f"{case_id}.json", ann)
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
