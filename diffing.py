"""当前标注与 baseline 的逐字段比较。"""

from __future__ import annotations

import json
from typing import Any

import schema
import store

KIND_LABELS = {"added": "Added", "modified": "Modified", "removed": "Removed"}


def _norm(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)


def _is_empty(value: Any) -> bool:
    return value is None or value == "" or value == [] or value == {}


def flatten(values: Any) -> dict[str, Any]:
    return schema.flatten_json(values if values is not None else {})


def compute_diff(current_values: Any, baseline_values: Any) -> list[dict]:
    current = flatten(current_values)
    baseline = flatten(baseline_values)
    items: list[dict] = []
    for path in sorted(set(current) | set(baseline)):
        if path not in baseline:
            # 表单默认值会补齐空字段，空值不算「新增」
            if _is_empty(current[path]):
                continue
            items.append({"path": path, "kind": "added", "old": None, "new": current[path]})
        elif path not in current:
            items.append({"path": path, "kind": "removed", "old": baseline[path], "new": None})
        elif _norm(current[path]) != _norm(baseline[path]):
            items.append(
                {"path": path, "kind": "modified", "old": baseline[path], "new": current[path]}
            )
    return items


def baseline_values(project, ann: dict, schema_info: dict) -> dict | None:
    import_id = ann.get("baseline_import_id")
    if not import_id:
        return None
    data = store.load_baseline(project, import_id, ann["case_id"])
    if not isinstance(data, dict):
        return None
    values = data.get("values") or {}
    meta = store.baseline_meta(project, import_id)
    src_version = int(
        data.get("schema_version") or meta.get("schema_version") or schema_info["version"]
    )
    if src_version != schema_info["version"]:
        old_root = schema.load_schema_version(project.root, src_version)
        if old_root is not None:
            values = schema.remap_values(old_root, schema_info["schema"], values)
    return values


def diff_for_case(project, ann: dict, schema_info: dict) -> dict:
    base = baseline_values(project, ann, schema_info)
    if base is None:
        return {"has_baseline": False, "fields": []}
    return {"has_baseline": True, "fields": compute_diff(ann.get("values") or {}, base)}


def delete_value(values: Any, segs: list[Any]) -> None:
    cur = values
    for seg in segs[:-1]:
        if isinstance(seg, int):
            if not isinstance(cur, list) or seg >= len(cur):
                return
            cur = cur[seg]
        else:
            if not isinstance(cur, dict) or seg not in cur:
                return
            cur = cur[seg]
    last = segs[-1]
    if isinstance(last, int):
        if isinstance(cur, list) and last < len(cur):
            cur.pop(last)
    elif isinstance(cur, dict):
        cur.pop(last, None)
