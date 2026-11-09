"""当前标注与 baseline 的逐字段比较。"""

from __future__ import annotations

import json
from typing import Any

import schema
import store

KIND_LABELS = {"added": "Added", "modified": "Modified", "removed": "Removed"}


class BaselineCache:
    """一次请求内复用 baseline 元数据 / 快照 / 历史 schema。

    同一批 case 往往来自同一次导入：``meta.json``、``schemas/vN.json`` 这些文件
    以前每个 case 都要重读一遍。缓存后一次列表请求只按 import_id / version 读一次，
    case 快照本身也只按 (import_id, case_id) 读一次。
    """

    def __init__(self, project, schema_info: dict):
        self.project = project
        self.info = schema_info
        self._metas: dict[str, dict] = {}
        self._roots: dict[int, dict | None] = {}
        self._cases: dict[tuple[str, str], dict | None] = {}

    def meta(self, import_id: str) -> dict:
        key = str(import_id)
        if key not in self._metas:
            try:
                self._metas[key] = store.baseline_meta(self.project, key)
            except (OSError, ValueError, store.AnnotationError):
                self._metas[key] = {}
        return self._metas[key]

    def schema_root(self, version: int):
        if version not in self._roots:
            try:
                self._roots[version] = schema.load_schema_version(self.project.root, version)
            except (OSError, ValueError, schema.SchemaError):
                self._roots[version] = None
        return self._roots[version]

    def case(self, import_id: str, case_id: str) -> dict | None:
        key = (str(import_id), str(case_id))
        if key not in self._cases:
            try:
                data = store.load_baseline(self.project, key[0], key[1])
            except (OSError, ValueError, store.AnnotationError):
                data = None
            self._cases[key] = data if isinstance(data, dict) else None
        return self._cases[key]


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


def baseline_values(
    project, ann: dict, schema_info: dict, cache: BaselineCache | None = None
) -> dict | None:
    import_id = ann.get("baseline_import_id")
    if not import_id:
        return None
    helper = cache or BaselineCache(project, schema_info)
    data = helper.case(str(import_id), str(ann.get("case_id") or ""))
    if not isinstance(data, dict):
        return None
    values = data.get("values") or {}
    meta = helper.meta(str(import_id))
    try:
        src_version = int(
            data.get("schema_version") or meta.get("schema_version") or schema_info["version"]
        )
    except (TypeError, ValueError):
        src_version = schema_info["version"]
    if src_version != schema_info["version"]:
        old_root = helper.schema_root(src_version)
        if old_root is not None:
            values = schema.remap_values(old_root, schema_info["schema"], values)
    return values


def diff_for_case(
    project, ann: dict, schema_info: dict, cache: BaselineCache | None = None
) -> dict:
    base = baseline_values(project, ann, schema_info, cache)
    if base is None:
        return {"has_baseline": False, "fields": []}
    return {"has_baseline": True, "fields": compute_diff(ann.get("values") or {}, base)}


def delete_value(values: Any, segs: list[Any]) -> None:
    cur = values
    for seg in segs[:-1]:
        if isinstance(seg, int):
            if not isinstance(cur, list) or seg < 0 or seg >= len(cur):
                return
            cur = cur[seg]
        else:
            if not isinstance(cur, dict) or seg not in cur:
                return
            cur = cur[seg]
    last = segs[-1]
    if isinstance(last, int):
        if isinstance(cur, list) and 0 <= last < len(cur):
            cur.pop(last)
    elif isinstance(cur, dict):
        cur.pop(last, None)
