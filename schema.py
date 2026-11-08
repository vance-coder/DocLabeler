"""Schema 读写、推断、校验、路径处理与历史快照。

约定：
- values 的 object key 使用字段 label（用户在界面看到的名字），
  字段 id 不可变，仅用于在 schema 版本之间对齐节点。
- field_path 由 label 组成，数组下标写成 ``items[0].amount``。
- label 中的 ``.`` ``[`` ``]`` ``\\`` 在路径中转义。
- 每次保存 schema 都追加 ``schemas/v<version>.json``，用于重映射历史标注。
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

import jsonio

FIELD_TYPES = ("string", "number", "boolean", "object", "array")
SCALAR_TYPES = ("string", "number", "boolean")


class SchemaError(ValueError):
    pass


class SchemaVersionConflict(Exception):
    def __init__(self, current: int):
        super().__init__(f"Schema version conflict. The server is at version {current}")
        self.current = current


def now_iso() -> str:
    return datetime.now().astimezone().replace(microsecond=0).isoformat()


def new_id(prefix: str = "fld") -> str:
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


# --------------------------------------------------------------------------
# 构造与校验
# --------------------------------------------------------------------------

def make_field(
    label: str,
    ftype: str = "string",
    required: bool = False,
    description: str = "",
    enum: Iterable[str] | None = None,
) -> dict:
    node: dict[str, Any] = {
        "id": new_id(),
        "label": label,
        "type": ftype,
        "required": required,
        "description": description,
        "enum": [str(x) for x in (enum or [])],
    }
    if ftype == "object":
        node["children"] = []
    elif ftype == "array":
        node["item"] = make_field("item", "string")
    return node


def empty_schema() -> dict:
    return {"id": "root", "label": "root", "type": "object", "required": True, "children": []}


def normalize_node(node: dict) -> dict:
    if not isinstance(node, dict):
        raise SchemaError("Schema node must be an object")
    ftype = node.get("type")
    if ftype not in FIELD_TYPES:
        raise SchemaError(f"Unsupported field type: {ftype!r}")
    out: dict[str, Any] = {
        "id": str(node.get("id") or new_id()),
        "label": "" if node.get("label") is None else str(node.get("label")),
        "type": ftype,
        "required": bool(node.get("required", False)),
        "description": str(node.get("description") or ""),
        "enum": [str(x) for x in (node.get("enum") or [])],
    }
    if ftype == "object":
        out["children"] = [normalize_node(c) for c in (node.get("children") or [])]
    elif ftype == "array":
        item = node.get("item")
        if not isinstance(item, dict):
            raise SchemaError("Array field must provide an item definition")
        out["item"] = normalize_node(item)
    return out


def normalize_schema(node: dict) -> dict:
    out = normalize_node(node)
    if out["type"] != "object":
        raise SchemaError("Schema root must be an object")
    return out


def _validate_node(node: dict, path: str) -> None:
    label = node.get("label", "")
    if not isinstance(label, str) or not label.strip():
        raise SchemaError(f"{path or 'root'}: Field label cannot be empty")
    if any(ord(ch) < 32 for ch in label):
        raise SchemaError(f"{path}: Field label cannot contain control characters")
    ftype = node.get("type")
    if ftype not in FIELD_TYPES:
        raise SchemaError(f"{path}: Unsupported field type {ftype}")
    if node.get("enum") and ftype not in SCALAR_TYPES:
        raise SchemaError(f"{path}: Only scalar fields support enums")
    if ftype == "object":
        children = node.get("children") or []
        seen: set[str] = set()
        for child in children:
            cid = child.get("id")
            if not cid:
                raise SchemaError(f"{path}: Child field is missing an id")
            clabel = child.get("label", "")
            if clabel in seen:
                raise SchemaError(f"{path}: Duplicate sibling field label \"{clabel}\". Labels must be unique because values are keyed by label")
            seen.add(clabel)
            _validate_node(child, f"{path}.{clabel}" if path else clabel)
    elif ftype == "array":
        item = node.get("item")
        if not isinstance(item, dict):
            raise SchemaError(f"{path}: Array field is missing item")
        _validate_node(item, f"{path}[]")


def validate_schema(node: dict) -> None:
    _validate_node(node, "")


def init_schema(project_root: Path, root: dict | None = None) -> dict:
    """创建项目时写入 v1 快照与当前指针。"""
    node = normalize_schema(root or empty_schema())
    validate_schema(node)
    version = 1
    payload = {"version": version, "updated_at": now_iso(), "schema": node}
    jsonio.write_json(project_root / "schema.json", payload)
    jsonio.write_json(
        project_root / "schemas" / f"v{version}.json",
        {"version": version, "created_at": now_iso(), "schema": node},
    )
    return {"version": version, "schema": node}


def load_schema(project_root: Path) -> dict:
    data = jsonio.read_json(project_root / "schema.json")
    if not isinstance(data, dict):
        raise SchemaError("Project is missing schema.json")
    node = normalize_schema(data.get("schema") or data)
    return {"version": int(data.get("version") or 1), "schema": node}


def load_schema_version(project_root: Path, version: int) -> dict | None:
    data = jsonio.read_json(project_root / "schemas" / f"v{int(version)}.json")
    if not isinstance(data, dict):
        return None
    return normalize_schema(data.get("schema") or data)


def save_schema(project_root: Path, new_schema: dict, expected_version: int | None = None) -> dict:
    current = load_schema(project_root)
    if expected_version is not None and int(expected_version) != current["version"]:
        raise SchemaVersionConflict(current["version"])

    node = normalize_schema(new_schema)
    validate_schema(node)

    version = current["version"] + 1
    jsonio.write_json(
        project_root / "schemas" / f"v{version}.json",
        {"version": version, "created_at": now_iso(), "schema": node},
    )
    jsonio.write_json(
        project_root / "schema.json",
        {"version": version, "updated_at": now_iso(), "schema": node},
    )
    return {
        "version": version,
        "schema": node,
        "previous": current["schema"],
        "previous_version": current["version"],
    }


# --------------------------------------------------------------------------
# 从示例 JSON / JSON Schema 推断
# --------------------------------------------------------------------------

def _infer_node(value: Any, label: str) -> dict:
    if isinstance(value, bool):
        return make_field(label, "boolean")
    if isinstance(value, (int, float)):
        return make_field(label, "number")
    if isinstance(value, str):
        return make_field(label, "string")
    if isinstance(value, dict):
        node = make_field(label, "object")
        node["children"] = [_infer_node(v, str(k)) for k, v in value.items()]
        return node
    if isinstance(value, list):
        node = make_field(label, "array")
        first = next((v for v in value if v is not None), None)
        node["item"] = _infer_node(first, "item") if first is not None else make_field("item", "string")
        return node
    return make_field(label, "string")


def infer_from_example(example: Any) -> dict:
    if not isinstance(example, dict):
        raise SchemaError("Example JSON must be an object ({...}). Wrap arrays in a named field")
    root = empty_schema()
    root["children"] = [_infer_node(v, str(k)) for k, v in example.items()]
    return root


def _json_schema_type(js: dict) -> str:
    t = js.get("type")
    if isinstance(t, list):
        t = next((x for x in t if x != "null"), "string")
    if t is None:
        if "properties" in js:
            t = "object"
        elif "items" in js:
            t = "array"
        elif "enum" in js:
            t = "string"
        else:
            t = "string"
    if t not in FIELD_TYPES:
        raise SchemaError(f"Unsupported JSON Schema type: {t}")
    return t


def _from_json_schema_node(js: dict, label: str, required: bool) -> dict:
    if "$ref" in js:
        raise SchemaError("$ref is not supported yet")
    t = _json_schema_type(js)
    node = make_field(
        label,
        t,
        required=required,
        description=str(js.get("description") or ""),
        enum=[str(x) for x in (js.get("enum") or [])],
    )
    if t == "object":
        props = js.get("properties") or {}
        req = set(js.get("required") or [])
        node["children"] = [
            _from_json_schema_node(v, str(k), k in req) for k, v in props.items()
        ]
    elif t == "array":
        items = js.get("items") or {}
        if isinstance(items, list):
            items = items[0] if items else {}
        node["item"] = _from_json_schema_node(items, "item", False)
    return node


def from_json_schema(js: dict) -> dict:
    if not isinstance(js, dict):
        raise SchemaError("JSON Schema must be an object")
    node = _from_json_schema_node(js, "root", True)
    if node["type"] != "object":
        node = empty_schema()
    return node


# --------------------------------------------------------------------------
# 默认值
# --------------------------------------------------------------------------

def default_value(node: dict) -> Any:
    t = node.get("type")
    if t == "object":
        return {c["label"]: default_value(c) for c in (node.get("children") or [])}
    if t == "array":
        return []
    if t == "boolean":
        return False
    return ""


def merge_defaults(node: dict, values: Any) -> Any:
    """让新增字段在表单里有输入框，同时保留原始数据。"""
    t = node.get("type")
    if t == "object":
        src = values if isinstance(values, dict) else {}
        out = {c["label"]: merge_defaults(c, src.get(c["label"])) for c in (node.get("children") or [])}
        for k, v in src.items():
            if k not in out:
                out[k] = v
        return out
    if t == "array":
        return list(values) if isinstance(values, list) else []
    if t == "boolean":
        return bool(values) if isinstance(values, bool) else False
    return "" if values is None else values


# --------------------------------------------------------------------------
# 字段路径
# --------------------------------------------------------------------------

def esc_seg(seg: str) -> str:
    return (
        seg.replace("\\", "\\\\")
        .replace(".", "\\.")
        .replace("[", "\\[")
        .replace("]", "\\]")
    )


def join_path(prefix: str, label: str) -> str:
    seg = esc_seg(label)
    return f"{prefix}.{seg}" if prefix else seg


def render_path(segs: Iterable[Any]) -> str:
    out = ""
    for s in segs:
        if isinstance(s, int):
            out += f"[{s}]"
        else:
            out = join_path(out, str(s)) if out else esc_seg(str(s))
    return out


def parse_path(path: str) -> list[Any]:
    segs: list[Any] = []
    buf: list[str] = []
    i, n = 0, len(path)
    while i < n:
        ch = path[i]
        if ch == "\\" and i + 1 < n:
            buf.append(path[i + 1])
            i += 2
            continue
        if ch == ".":
            if buf:
                segs.append("".join(buf))
                buf = []
            i += 1
            continue
        if ch == "[":
            if buf:
                segs.append("".join(buf))
                buf = []
            j = path.find("]", i)
            if j == -1:
                raise SchemaError(f"Invalid field path: {path}")
            try:
                segs.append(int(path[i + 1 : j]))
            except ValueError:
                raise SchemaError(f"Invalid array index: {path}")
            i = j + 1
            continue
        buf.append(ch)
        i += 1
    if buf:
        segs.append("".join(buf))
    return segs


def find_node(root: dict, segs: Iterable[Any]) -> dict | None:
    node: dict | None = root
    for seg in segs:
        if node is None:
            return None
        if isinstance(seg, int):
            if node.get("type") != "array":
                return None
            node = node.get("item")
        else:
            if node.get("type") != "object":
                return None
            node = next(
                (c for c in (node.get("children") or []) if c.get("label") == seg), None
            )
    return node


def find_node_by_label(root: dict, label: str) -> dict | None:
    return next((c for c in (root.get("children") or []) if c.get("label") == label), None)


def get_value(values: Any, segs: list[Any]) -> Any:
    cur = values
    for seg in segs:
        if isinstance(seg, int):
            if not isinstance(cur, list) or seg >= len(cur):
                return None
            cur = cur[seg]
        else:
            if not isinstance(cur, dict) or seg not in cur:
                return None
            cur = cur[seg]
    return cur


def set_value(values: Any, segs: list[Any], value: Any) -> None:
    if not segs:
        raise SchemaError("Field path is empty")
    cur = values
    for idx, seg in enumerate(segs[:-1]):
        nxt = segs[idx + 1]
        if isinstance(seg, int):
            if not isinstance(cur, list):
                raise SchemaError("Path structure mismatch: expected an array")
            while len(cur) <= seg:
                cur.append({} if isinstance(nxt, str) else [])
            if cur[seg] is None:
                cur[seg] = {} if isinstance(nxt, str) else []
            cur = cur[seg]
        else:
            if not isinstance(cur, dict):
                raise SchemaError("Path structure mismatch: expected an object")
            if not isinstance(cur.get(seg), (dict, list)):
                cur[seg] = {} if isinstance(nxt, str) else []
            cur = cur[seg]
    last = segs[-1]
    if isinstance(last, int):
        if not isinstance(cur, list):
            raise SchemaError("Path structure mismatch: expected an array")
        while len(cur) <= last:
            cur.append(None)
        cur[last] = value
    else:
        if not isinstance(cur, dict):
            raise SchemaError("Path structure mismatch: expected an object")
        cur[last] = value


def flatten_json(value: Any, segs: tuple = ()) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if isinstance(value, dict):
        for k, v in value.items():
            out.update(flatten_json(v, segs + (str(k),)))
    elif isinstance(value, list):
        for i, v in enumerate(value):
            out.update(flatten_json(v, segs + (i,)))
    else:
        out[render_path(segs)] = value
    return out


# --------------------------------------------------------------------------
# 新旧 schema 之间的重映射（按不可变 id 对齐）
# --------------------------------------------------------------------------

def remap_values(old_node: dict | None, new_node: dict, value: Any) -> Any:
    if not isinstance(new_node, dict):
        return value
    ntype = new_node.get("type")
    if ntype == "object" and isinstance(value, dict):
        old_children = {c.get("id"): c for c in ((old_node or {}).get("children") or [])}
        out: dict[str, Any] = {}
        consumed: set[str] = set()
        for child in new_node.get("children") or []:
            oc = old_children.get(child.get("id"))
            if oc is not None and oc.get("label") in value:
                out[child["label"]] = remap_values(oc, child, value[oc["label"]])
                consumed.add(oc["label"])
            elif child["label"] in value:
                out[child["label"]] = remap_values(oc, child, value[child["label"]])
                consumed.add(child["label"])
        for k, v in value.items():
            if k not in consumed:
                out[k] = v
        return out
    if ntype == "array" and isinstance(value, list):
        old_item = (old_node or {}).get("item")
        new_item = new_node.get("item")
        return [remap_values(old_item, new_item, v) for v in value]
    return value


def remap_path(old_node: dict | None, new_node: dict, segs: list[Any]) -> list[Any] | None:
    if not segs:
        return []
    head = segs[0]
    if isinstance(head, int):
        if (new_node or {}).get("type") == "array":
            sub = remap_path((old_node or {}).get("item"), new_node.get("item") or {}, segs[1:])
        else:
            sub = remap_path(old_node, new_node, segs[1:])
        return None if sub is None else [head] + sub

    if (new_node or {}).get("type") == "object":
        old_children = (old_node or {}).get("children") or []
        new_children = new_node.get("children") or []
        old_child = next((c for c in old_children if c.get("label") == head), None)
        new_child = None
        if old_child is not None:
            new_child = next(
                (c for c in new_children if c.get("id") == old_child.get("id")), None
            )
        if new_child is None:
            new_child = next((c for c in new_children if c.get("label") == head), None)
        if new_child is None:
            return None
        sub = remap_path(old_child, new_child, segs[1:])
        return None if sub is None else [new_child["label"]] + sub

    sub = remap_path(old_node, new_node, segs[1:])
    return None if sub is None else [head] + sub


def remap_notes(
    old_node: dict | None, new_node: dict, notes: dict[str, str]
) -> tuple[dict[str, str], list[str]]:
    """返回重映射后的备注与变成孤儿的备注 key。"""
    out: dict[str, str] = {}
    orphans: list[str] = []
    for key, text in (notes or {}).items():
        try:
            segs = parse_path(key)
        except SchemaError:
            out[key] = text
            continue
        mapped = remap_path(old_node, new_node, segs)
        if mapped is None:
            orphans.append(key)
            out[key] = text
        else:
            out[render_path(mapped)] = text
    return out, orphans


# --------------------------------------------------------------------------
# 表单/导出辅助
# --------------------------------------------------------------------------

def iter_fields(node: dict, prefix: str = ""):
    """遍历所有字段节点，数组元素用 ``[]`` 模板表示。"""
    for child in node.get("children") or []:
        path = join_path(prefix, child["label"])
        yield path, child
        if child["type"] == "object":
            yield from iter_fields(child, path)
        elif child["type"] == "array":
            item = child.get("item") or {}
            if item.get("type") == "object":
                yield from iter_fields(item, path + "[]")


def wide_columns(node: dict, prefix: str = "") -> list[tuple[str, str, dict]]:
    """宽表列：数组整体作为一列（JSON 字符串），其余按叶子字段展开。"""
    out: list[tuple[str, str, dict]] = []
    for child in node.get("children") or []:
        path = join_path(prefix, child["label"])
        if child["type"] == "object":
            out.extend(wide_columns(child, path))
        else:
            out.append((path, child["label"], child))
    return out


def wide_row(node: dict, values: dict, prefix: str = "") -> dict[str, Any]:
    row: dict[str, Any] = {}
    for child in node.get("children") or []:
        path = join_path(prefix, child["label"])
        raw = values.get(child["label"]) if isinstance(values, dict) else None
        if child["type"] == "object":
            row.update(wide_row(child, raw if isinstance(raw, dict) else {}, path))
        elif child["type"] == "array":
            row[path] = json.dumps(raw if raw is not None else [], ensure_ascii=False)
        else:
            row[path] = "" if raw is None else raw
    return row


TRUE_WORDS = {"true", "1", "yes", "y", "是", "有", "对"}
FALSE_WORDS = {"false", "0", "no", "n", "否", "无", "不"}


def coerce_value(node: dict, raw: Any) -> tuple[bool, Any, str | None]:
    """按 schema 类型转换导入值，返回 (ok, value, error)。"""
    t = node.get("type")
    if t == "object" or t == "array":
        return False, None, "This field is structured and cannot be assigned directly"
    if raw is None:
        raw = ""
    if t == "string":
        value = raw if isinstance(raw, str) else str(raw)
        value = value.strip()
        enum = node.get("enum") or []
        if enum and value and value not in enum:
            return False, None, f"Value \"{value}\" is not in enum {enum}"
        return True, value, None
    if t == "number":
        text = str(raw).strip().replace(",", "")
        if text == "":
            return True, "", None
        try:
            num = float(text)
        except ValueError:
            return False, None, f"\"{raw}\" is not a number"
        return True, int(num) if num.is_integer() else num, None
    if t == "boolean":
        text = str(raw).strip().lower()
        if text == "":
            return True, False, None
        if text in TRUE_WORDS:
            return True, True, None
        if text in FALSE_WORDS:
            return True, False, None
        return False, None, f"\"{raw}\" is not a valid boolean"
    return False, None, f"Unknown type {t}"
