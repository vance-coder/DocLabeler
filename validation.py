"""声明式的跨字段校验规则。

规则挂在 schema 节点上（root 也支持），形如::

    "validation": [
      {"type": "sum", "target": "total", "source": "items[].amount",
       "tolerance": 0.01, "message": "明细合计与总金额不一致"},
      {"type": "regex", "path": "invoice_no", "pattern": "^INV-\\\\d{6}$"},
      {"type": "date", "path": "issue_date", "format": "YYYY-MM-DD"},
      {"type": "compare", "path": "end_date", "other": "start_date", "op": ">="},
      {"type": "checksum", "path": "card_no", "algorithm": "idcard"},
      {"type": "range", "path": "tax_rate", "min": 0, "max": 1},
      {"type": "length", "path": "doc_no", "min": 4, "max": 32}
    ]

路径使用字段 label，数组用 ``items[].amount`` 模板；``[]`` 会对每个实际下标
展开并逐项检查。规则只是提示，不阻止草稿保存。
"""

from __future__ import annotations

import math
import re
from datetime import datetime
from functools import lru_cache
from typing import Any

import schema

RULE_TYPES = ("regex", "date", "range", "length", "checksum", "sum", "compare")
DATE_FORMATS = {
    "YYYY-MM-DD": "%Y-%m-%d",
    "YYYY/MM/DD": "%Y/%m/%d",
    "YYYYMMDD": "%Y%m%d",
    "YYYY-MM-DD HH:MM:SS": "%Y-%m-%d %H:%M:%S",
    "YYYY/MM/DD HH:MM:SS": "%Y/%m/%d %H:%M:%S",
    "DD/MM/YYYY": "%d/%m/%Y",
    "MM/DD/YYYY": "%m/%d/%Y",
}
MAX_ERRORS = 100


class RuleError(schema.SchemaError):
    pass


def iter_nodes(node: dict, prefix: str = ""):
    """遍历全部节点（含 root），数组元素用 ``[]`` 模板表示。"""
    yield prefix, node
    for child in node.get("children") or []:
        path = schema.join_path(prefix, child["label"])
        yield from iter_nodes(child, path)
    item = node.get("item")
    if isinstance(item, dict):
        yield from iter_nodes(item, (prefix or "item") + "[]")


def has_rules(root: dict) -> bool:
    return any(node.get("validation") for _, node in iter_nodes(root))


def validate_rules(root: dict) -> None:
    """保存 schema 前校验规则写法，避免坏正则 / 缺参数在运行时才炸。"""
    for base_path, node in iter_nodes(root):
        for rule in node.get("validation") or []:
            kind = rule.get("type")
            if kind not in RULE_TYPES:
                raise RuleError(
                    f"{base_path or 'root'}: unsupported validation rule {kind!r}; "
                    f"expected one of {', '.join(RULE_TYPES)}"
                )
            path = str(rule.get("path") or base_path)
            if not path and kind != "sum":
                raise RuleError(f"{base_path or 'root'}: {kind} rule needs a path")
            if kind == "regex":
                pattern = str(rule.get("pattern") or "")
                if not pattern:
                    raise RuleError(f"{path}: regex rule needs a non-empty pattern")
                try:
                    re.compile(pattern)
                except re.error as exc:
                    raise RuleError(f"{path}: invalid regex: {exc}") from exc
            elif kind == "date":
                fmt = str(rule.get("format") or "YYYY-MM-DD")
                if fmt not in DATE_FORMATS:
                    raise RuleError(
                        f"{path}: unsupported date format {fmt!r}; "
                        f"expected one of {', '.join(DATE_FORMATS)}"
                    )
            elif kind == "checksum":
                algo = str(rule.get("algorithm") or "luhn")
                if algo not in ("luhn", "idcard"):
                    raise RuleError(f"{path}: unsupported checksum algorithm {algo!r}")
            elif kind == "sum":
                if not str(rule.get("source") or ""):
                    raise RuleError(f"{path}: sum rule needs a source path")
                if not str(rule.get("target") or path or ""):
                    raise RuleError(f"{path}: sum rule needs a target path")
            elif kind == "compare":
                if not str(rule.get("other") or ""):
                    raise RuleError(f"{path}: compare rule needs an other path")
                if str(rule.get("op") or ">=") not in ("==", "!=", ">", ">=", "<", "<="):
                    raise RuleError(f"{path}: invalid comparison operator")
            elif kind in ("range", "length"):
                for key in ("min", "max"):
                    raw = rule.get(key)
                    if raw is None or isinstance(raw, bool):
                        continue
                    try:
                        number = float(raw)
                    except (TypeError, ValueError):
                        raise RuleError(f"{path}: {key} must be a number")
                    if not math.isfinite(number) or (kind == "length" and number < 0):
                        raise RuleError(
                            f"{path}: {key} must be a finite"
                            f"{' non-negative' if kind == 'length' else ''} number"
                        )
                low, high = rule.get("min"), rule.get("max")
                if low is not None and high is not None and float(low) > float(high):
                    raise RuleError(f"{path}: min must not exceed max")


# --------------------------------------------------------------------------
# 值处理
# --------------------------------------------------------------------------

def _is_empty(value: Any) -> bool:
    return value is None or value == "" or value == [] or value == {}


def _number(raw: Any) -> float | None:
    if isinstance(raw, bool) or raw is None:
        return None
    if isinstance(raw, (int, float)):
        return float(raw)
    text = str(raw).strip()
    for token in (",", "¥", "￥", "$", " ", "\u00a0"):
        text = text.replace(token, "")
    if not text:
        return None
    try:
        number = float(text)
    except ValueError:
        return None
    return number if math.isfinite(number) else None


def _date(raw: Any, fmt: str) -> datetime | None:
    text = str(raw).strip()
    if not text:
        return None
    if fmt == "YYYY-MM-DD":
        text = text.replace("年", "-").replace("月", "-").replace("日", "")
    try:
        return datetime.strptime(text, DATE_FORMATS[fmt])
    except ValueError:
        return None


def _luhn(text: str) -> bool:
    digits = [ch for ch in text if ch.isdigit()]
    if len(digits) < 8:
        return False
    total = 0
    for index, char in enumerate(reversed(digits)):
        value = int(char)
        if index % 2 == 1:
            value *= 2
            if value > 9:
                value -= 9
        total += value
    return total % 10 == 0


_IDCARD_WEIGHTS = (7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2)
_IDCARD_CHECK = "10X98765432"


def _idcard(text: str) -> bool:
    value = text.strip().upper()
    if len(value) != 18 or not value[:17].isdigit():
        return False
    total = sum(int(ch) * weight for ch, weight in zip(value[:17], _IDCARD_WEIGHTS))
    return _IDCARD_CHECK[total % 11] == value[17]


@lru_cache(maxsize=512)
def _template_regex(path: str) -> re.Pattern:
    # 规则模板在一次请求里被每个 case 反复展开，编译结果可安全复用。
    parts = str(path).split("[]")
    return re.compile("^" + r"\[\d+\]".join(re.escape(part) for part in parts) + "$")


def _index_key(path: str) -> tuple:
    # 按数组下标的数值排序，避免 items[10] 排在 items[2] 前面。
    parts = re.split(r"\[(\d+)\]", path)
    return tuple(
        (0, int(part)) if index % 2 else (1, part)
        for index, part in enumerate(parts)
    )


def _expand(template: str, flat: dict[str, Any]) -> list[str]:
    pattern = _template_regex(template)
    return sorted((path for path in flat if pattern.match(path)), key=_index_key)


def _counterpart(field_path: str, template: str) -> str:
    # 把 other 模板里的 [] 换成 field_path 同段的下标，做逐元素配对。
    out = template
    for index in re.findall(r"\[(\d+)\]", field_path):
        if "[]" not in out:
            break
        out = out.replace("[]", f"[{index}]", 1)
    return out


def _compare(left: Any, right: Any, op: str) -> bool:
    lnum, rnum = _number(left), _number(right)
    if lnum is not None and rnum is not None:
        a, b = lnum, rnum
    else:
        ldate = _date(left, "YYYY-MM-DD")
        rdate = _date(right, "YYYY-MM-DD")
        if ldate is not None and rdate is not None:
            a, b = ldate, rdate
        else:
            a, b = str(left), str(right)
    try:
        if op == "==":
            return a == b
        if op == "!=":
            return a != b
        if op == ">":
            return a > b
        if op == ">=":
            return a >= b
        if op == "<":
            return a < b
        return a <= b
    except TypeError:
        return False


def _error(path: str, kind: str, message: str) -> dict:
    return {"path": path, "rule": kind, "message": message}


# --------------------------------------------------------------------------
# 规则求值
# --------------------------------------------------------------------------

def _evaluate_rule(base_path: str, rule: dict, flat: dict[str, Any]) -> list[dict]:
    kind = str(rule.get("type") or "")
    message = str(rule.get("message") or "")
    path = str(rule.get("path") or base_path)
    errors: list[dict] = []

    if kind == "sum":
        target = str(rule.get("target") or path)
        source = str(rule.get("source") or "")
        targets = _expand(target, flat)
        sources = _expand(source, flat)
        try:
            tolerance = abs(float(rule.get("tolerance", 0.01)))
        except (TypeError, ValueError):
            tolerance = 0.01
        for target_path in targets:
            expected = _number(flat.get(target_path))
            if expected is None:
                continue
            parts = [_number(flat[p]) for p in sources]
            parts = [part for part in parts if part is not None]
            actual = sum(parts)
            if not parts or abs(actual - expected) > tolerance:
                errors.append(
                    _error(
                        target_path,
                        kind,
                        message or (
                            f"Sum of {source} is {actual:g}, expected {expected:g}"
                        ),
                    )
                )
        return errors

    for field_path in _expand(path, flat):
        value = flat.get(field_path)
        if _is_empty(value):
            continue
        if kind == "regex":
            pattern = str(rule.get("pattern") or "")
            try:
                matched = bool(re.search(pattern, str(value)))
            except re.error:
                continue
            if not matched:
                errors.append(
                    _error(field_path, kind, message or f"Does not match {pattern}")
                )
        elif kind == "date":
            fmt = str(rule.get("format") or "YYYY-MM-DD")
            if fmt not in DATE_FORMATS or _date(value, fmt) is None:
                errors.append(
                    _error(field_path, kind, message or f"Not a valid date ({fmt})")
                )
        elif kind == "range":
            number = _number(value)
            low = _number(rule.get("min")) if rule.get("min") is not None else None
            high = _number(rule.get("max")) if rule.get("max") is not None else None
            if number is None or (low is not None and number < low) or (
                high is not None and number > high
            ):
                errors.append(
                    _error(field_path, kind, message or f"Out of range [{rule.get('min')}, {rule.get('max')}]")
                )
        elif kind == "length":
            size = len(str(value))
            try:
                low = int(rule.get("min")) if rule.get("min") is not None else None
            except (TypeError, ValueError):
                low = None
            try:
                high = int(rule.get("max")) if rule.get("max") is not None else None
            except (TypeError, ValueError):
                high = None
            if (low is not None and size < low) or (high is not None and size > high):
                errors.append(
                    _error(field_path, kind, message or f"Length {size} is out of range")
                )
        elif kind == "checksum":
            algo = str(rule.get("algorithm") or "luhn")
            ok = _idcard(str(value)) if algo == "idcard" else _luhn(str(value))
            if not ok:
                errors.append(
                    _error(field_path, kind, message or f"Checksum failed ({algo})")
                )
        elif kind == "compare":
            op = str(rule.get("op") or ">=")
            other_template = str(rule.get("other") or "")
            # 数组模板按同下标配对，不能用 other_paths[0] 去比所有元素。
            other_path = (
                _counterpart(field_path, other_template)
                if "[]" in other_template
                else other_template
            )
            other = flat.get(other_path)
            if _is_empty(other) or not _compare(value, other, op):
                errors.append(
                    _error(field_path, kind, message or f"Must be {op} {rule.get('other')}")
                )
    return errors


def compile_rules(root: dict) -> list[tuple[str, dict]]:
    """把「节点路径 + 规则」一次性展开，供批量 case 复用（避免每 case 遍历整棵树）。"""
    return [
        (base_path, rule)
        for base_path, node in iter_nodes(root)
        for rule in (node.get("validation") or [])
    ]


def evaluate_compiled(compiled: list[tuple[str, dict]], values: Any) -> list[dict]:
    """用预编译规则求值；空规则直接返回，无需 flatten。"""
    if not compiled:
        return []
    flat = schema.flatten_json(values if values is not None else {})
    errors: list[dict] = []
    for base_path, rule in compiled:
        errors.extend(_evaluate_rule(base_path, rule, flat))
        if len(errors) >= MAX_ERRORS:
            return errors[:MAX_ERRORS]
    return errors


def evaluate(
    root: dict, values: Any, compiled: list[tuple[str, dict]] | None = None
) -> list[dict]:
    """返回 ``[{path, rule, message}]``，最多 100 条。

    兼容单条调用；批量场景传 ``compiled=compile_rules(root)`` 可跳过重复遍历。
    """
    return evaluate_compiled(compile_rules(root) if compiled is None else compiled, values)


def missing_required(root: dict, values: Any) -> list[str]:
    """返回为空的必填字段路径（与前端 collectMissingRequired 保持一致）。"""
    out: list[str] = []

    def walk(node: dict, obj: Any, prefix: str) -> None:
        data = obj if isinstance(obj, dict) else {}
        for child in node.get("children") or []:
            path = schema.join_path(prefix, child["label"])
            value = data.get(child["label"])
            ctype = child.get("type")
            if ctype == "object":
                before = len(out)
                walk(child, value if isinstance(value, dict) else {}, path)
                if child.get("required") and _is_empty(value) and len(out) == before:
                    out.append(path)
            elif ctype == "array":
                items = value if isinstance(value, list) else []
                if child.get("required") and not items:
                    out.append(path)
                item = child.get("item") or {}
                for index, entry in enumerate(items):
                    item_path = f"{path}[{index}]"
                    if item.get("type") == "object":
                        walk(item, entry if isinstance(entry, dict) else {}, item_path)
                    elif item.get("required") and _is_empty(entry):
                        out.append(item_path)
            elif child.get("required") and _is_empty(value):
                out.append(path)

    walk(root, values, "")
    return out
