"""导入已有标注：JSON / CSV / Excel 长表，并生成 baseline 快照与报告。"""

from __future__ import annotations

import csv
import io
import json
import math
import re
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

import jsonio
import schema
import store
from paths import safe_filename

HEADER_ALIASES = {
    "case": "case_id",
    "caseid": "case_id",
    "id": "case_id",
    "case_no": "case_id",
    "path": "field_path",
    "field": "field_path",
    "fieldpath": "field_path",
    "字段": "field_path",
    "字段路径": "field_path",
    "值": "value",
    "备注": "note",
    "score": "confidence",
    "prob": "confidence",
    "probability": "confidence",
    "conf": "confidence",
    "置信度": "confidence",
    "置信分数": "confidence",
    "box": "bbox",
    "框": "bbox",
    "坐标": "bbox",
    "text": "evidence_text",
    "ocr_text": "evidence_text",
    "evidence_text": "evidence_text",
    "ocr": "evidence_text",
    "page": "page",
    "页": "page",
    "source": "source",
    "file": "source",
    "filename": "source",
    "image": "source",
    "文件": "source",
    "图片": "source",
}


class ImportFailed(ValueError):
    pass


def new_import_id() -> str:
    return "imp_" + datetime.now().strftime("%Y%m%d_%H%M%S") + "_" + uuid.uuid4().hex[:4]


def _norm_header(name: str) -> str:
    raw = (name or "").strip().lower()
    compact = raw.replace(" ", "_")
    return HEADER_ALIASES.get(compact) or HEADER_ALIASES.get(raw) or compact


def _decode(data: bytes) -> str:
    for enc in ("utf-8-sig", "utf-8", "gbk", "latin-1"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    raise ImportFailed("Unable to detect file encoding")


def _table_layout(raw_headers: list[str], label: str) -> tuple[list[str], bool]:
    """识别长表 / 宽表，返回 (归一化表头, 是否宽表)。

    长表必须同时有 ``field_path`` 与 ``value``；否则按宽表处理：一行一个 case，
    列名直接对应 schema 的字段路径或标签（导出目录里的 summary.csv 即可回灌）。
    宽表行保留原始表头，避免 ``text`` / ``path`` 这类列名被长表别名改写。
    """
    headers = [_norm_header(name) for name in raw_headers]
    wide = not ("field_path" in headers and "value" in headers)
    if wide and "case_id" not in headers and "source" not in headers:
        raise ImportFailed(
            f"{label} needs either field_path + value columns (long format), "
            "or case_id / source columns (wide format)"
        )
    return headers, wide


def parse_csv(data: bytes) -> list[dict]:
    text = _decode(data)
    reader = csv.reader(io.StringIO(text))
    rows = list(reader)
    if not rows:
        raise ImportFailed("CSV file is empty")
    raw_headers = [str(name or "").strip() for name in rows[0]]
    normalized, wide = _table_layout(raw_headers, "CSV")
    keys = raw_headers if wide else normalized
    out: list[dict] = []
    for line_no, raw_row in enumerate(rows[1:], start=2):
        if not any(str(c).strip() for c in raw_row):
            continue
        row = {keys[i]: (raw_row[i] if i < len(raw_row) else "") for i in range(len(keys))}
        row["_line"] = line_no
        if wide:
            row["_wide"] = True
        out.append(row)
    return out


def parse_excel(data: bytes) -> list[dict]:
    try:
        from openpyxl import load_workbook
    except ImportError as exc:  # pragma: no cover
        raise ImportFailed("openpyxl is not installed, cannot read Excel files") from exc

    wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    ws = wb.worksheets[0]
    rows: list[list[Any]] = []
    for row in ws.iter_rows(values_only=True):
        rows.append(list(row))
    if not rows:
        raise ImportFailed("Excel worksheet is empty")
    raw_headers = [str(name).strip() if name is not None else "" for name in rows[0]]
    normalized, wide = _table_layout(raw_headers, "Excel")
    keys = raw_headers if wide else normalized
    out: list[dict] = []
    for line_no, raw_row in enumerate(rows[1:], start=2):
        if not any(str(c).strip() for c in raw_row if c is not None):
            continue
        row = {
            keys[i]: ("" if i >= len(raw_row) or raw_row[i] is None else str(raw_row[i]))
            for i in range(len(keys))
        }
        row["_line"] = line_no
        if wide:
            row["_wide"] = True
        out.append(row)
    wb.close()
    return out


def _flatten_notes(notes: Any) -> dict[str, str]:
    if not isinstance(notes, dict):
        return {}
    out: dict[str, str] = {}
    for path, text in notes.items():
        if text is None or not str(text).strip():
            continue
        if isinstance(text, dict):
            for sub_path, sub_text in schema.flatten_json(text).items():
                if sub_text is not None and str(sub_text).strip():
                    out[f"{path}.{sub_path}".lstrip(".")] = str(sub_text)
        else:
            out[str(path)] = str(text)
    return out


def parse_json_case(filename: str, data: bytes) -> dict:
    text = _decode(data)
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ImportFailed(f"{filename}: Failed to parse JSON ({exc})") from exc
    if not isinstance(payload, dict):
        raise ImportFailed(f"{filename}: JSON root must be an object")

    case_id = payload.get("case_id") or payload.get("id")
    values = payload.get("values") if isinstance(payload.get("values"), dict) else None
    notes = payload.get("notes")
    confidence = payload.get("confidence") if isinstance(payload.get("confidence"), dict) else {}
    evidence = payload.get("evidence") if isinstance(payload.get("evidence"), dict) else {}
    if values is None:
        reserved = {
            "case_id",
            "id",
            "source",
            "schema_version",
            "status",
            "tags",
            "notes",
            "confidence",
            "evidence",
            "rev",
            "updated_at",
        }
        values = {k: v for k, v in payload.items() if k not in reserved}
        notes = notes if notes is not None else payload.get("notes")
    return {
        "case_id": str(case_id) if case_id else None,
        "filename_stem": Path(filename).stem,
        "values": schema.flatten_json(values or {}),
        "notes": _flatten_notes(notes),
        "confidence": schema.flatten_json(confidence),
        "evidence": evidence,
    }


def _parse_bbox(raw: Any) -> dict | None:
    """接受 ``x,y,w,h`` 归一化坐标（0-1，也兼容 0-100）。"""
    text = str(raw or "").strip()
    if not text:
        return None
    parts = [part for part in re.split(r"[,;\s]+", text) if part]
    if len(parts) != 4:
        return None
    try:
        numbers = [float(part) for part in parts]
    except ValueError:
        return None
    if all(math.isfinite(n) for n in numbers) and all(n > 1 for n in numbers):
        numbers = [number / 100 for number in numbers]
    return store.normalize_evidence({"box": {"bbox": numbers}}).get("box")


def _is_empty(value: Any) -> bool:
    return value is None or value == "" or value == [] or value == {}


def _parse_confidence(raw: Any) -> float | None:
    """接受 0-1 或 0-100 的置信度，统一成 0-1；无法解析时返回 None。"""
    if raw is None:
        return None
    text = str(raw).strip().rstrip("%")
    if not text:
        return None
    try:
        value = float(text)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(value):
        return None
    if value > 1:
        value = value / 100 if value <= 100 else 1.0
    return max(0.0, min(1.0, value))


def _coerce_import_value(node: dict, raw: Any) -> tuple[bool, Any, str | None]:
    """宽表里的数组列以 JSON 字符串表示；其余类型沿用 schema.coerce_value。"""
    if node.get("type") == "array":
        if isinstance(raw, str):
            text = raw.strip()
            if not text:
                return True, [], None
            try:
                raw = json.loads(text)
            except json.JSONDecodeError as exc:
                return False, None, f"Array must be valid JSON ({exc.msg})"
        if not isinstance(raw, list):
            return False, None, "Array must be a JSON array"
        return True, raw, None
    return schema.coerce_value(node, raw)


def run_import(
    project,
    index: dict,
    schema_info: dict,
    uploads: list[dict],
    kind: str,
    mode: str = "overwrite",
) -> dict:
    """uploads: [{"filename": str, "data": bytes}]。"""
    if mode not in ("overwrite", "fill_empty", "baseline"):
        raise ImportFailed("Import mode must be overwrite, fill_empty, or baseline")
    if kind not in ("csv", "excel", "json"):
        raise ImportFailed("Import kind must be csv, excel, or json")

    import_id = new_import_id()
    root = schema_info["schema"]
    # 宽表列名 -> (field_path, segments, node)。完整路径优先，标签兜底；
    # 同名标签指向多个字段时视为歧义，宁可报 unknown_field 也不猜一个。
    wide_map: dict[str, tuple[str, list, dict]] = {}
    wide_ambiguous: set[str] = set()
    for wide_path, wide_label, wide_node in schema.wide_columns(root):
        try:
            wide_segs = schema.parse_path(wide_path)
        except schema.SchemaError:
            continue
        for key in {
            wide_path.lower(),
            wide_label.lower(),
            wide_path.rsplit(".", 1)[-1].lower(),
        }:
            existing = wide_map.get(key)
            if existing is not None and existing[0] != wide_path:
                wide_ambiguous.add(key)
            else:
                wide_map.setdefault(key, (wide_path, wide_segs, wide_node))
    for key in wide_ambiguous:
        wide_map.pop(key, None)
    by_id = {c["case_id"]: c for c in index.get("cases", [])}
    by_source: dict[str, str] = {}
    by_source_noext: dict[str, str] = {}
    for case in index.get("cases", []):
        source = case["source"].replace("\\", "/").lower()
        by_source[source] = case["case_id"]
        by_source_noext[source.rsplit(".", 1)[0]] = case["case_id"]
    grouped: dict[str, dict] = {}
    issues: list[dict] = []
    stats = {
        "rows": 0,
        "cases": 0,
        "applied_fields": 0,
        "kept_values": 0,
        "confidence": 0,
        "notes": 0,
        "evidence": 0,
        "skipped_fill": 0,
        "unknown_case": 0,
        "ambiguous_case": 0,
        "unknown_field": 0,
        "type_mismatch": 0,
    }

    def _tokens(text: str) -> set[str]:
        return {t.lower() for t in re.split(r"[^A-Za-z0-9]+", str(text)) if t}

    by_id_lower = {cid.lower(): cid for cid in by_id}
    token_index: dict[str, list[str]] = {}
    for case in index.get("cases", []):
        for token in _tokens(case["source"]) | _tokens(case["case_id"]):
            bucket = token_index.setdefault(token, [])
            if case["case_id"] not in bucket:
                bucket.append(case["case_id"])

    resolved_cache: dict[str, str | None] = {}

    def resolve_case(raw: str) -> str | None:
        """精确 case_id 优先；否则按路径/文件名的完整片段匹配。

        多命中时取列表排序后的第一张（scanner 已按 source 排序），并记一条
        ambiguous_case 报告，便于事后核对。
        """
        key = str(raw or "").strip()
        if not key:
            return None
        if key in resolved_cache:
            return resolved_cache[key]
        if key in by_id:
            resolved_cache[key] = key
            return key
        if key.lower() in by_id_lower:
            resolved = by_id_lower[key.lower()]
            resolved_cache[key] = resolved
            return resolved

        normalized = key.replace("\\", "/").lower()
        while normalized.startswith("./"):
            normalized = normalized[2:]
        if normalized in by_source:
            resolved = by_source[normalized]
            resolved_cache[key] = resolved
            return resolved
        if normalized in by_source_noext:
            resolved = by_source_noext[normalized]
            resolved_cache[key] = resolved
            return resolved

        probe = key.replace("\\", "/")
        if "." in probe.rsplit("/", 1)[-1]:
            probe = probe.rsplit(".", 1)[0]
        tokens = sorted(_tokens(probe))
        candidates: list[str] = []
        if tokens:
            ordered = [c["case_id"] for c in index.get("cases", [])]
            per_token = [set(token_index.get(t, [])) for t in tokens]
            common = set.intersection(*per_token) if per_token else set()
            pool = common or set().union(*per_token)
            candidates = [cid for cid in ordered if cid in pool]

        if not candidates and "/" in probe:
            # 绝对路径或带无关目录时，退回用文件名部分匹配
            return resolve_case(probe.rsplit("/", 1)[-1])

        if not candidates:
            resolved_cache[key] = None
            return None

        chosen = candidates[0]
        resolved_cache[key] = chosen
        if len(candidates) > 1:
            stats["ambiguous_case"] += 1
            issues.append(
                {
                    "case_id": key,
                    "field_path": None,
                    "type": "ambiguous_case",
                    "message": (
                        f"{key} matched {len(candidates)} cases; using the first one ({chosen})"
                    ),
                    "candidates": candidates[:20],
                }
            )
        return chosen

    def add_group(case_id: str) -> dict:
        return grouped.setdefault(
            case_id,
            {
                "values": [],
                "notes": [],
                "confidence": {},
                "evidence": {},
                "baseline": {},
                "baseline_notes": {},
                "baseline_evidence": {},
                "status": "",
            },
        )

    def ingest_wide_row(filename: str, row: dict) -> None:
        """宽表一行 = 一个 case；列名按 schema 路径 / 标签匹配。"""
        stats["rows"] += 1
        line = row.get("_line")
        values_by_key: dict[str, Any] = {}
        for key, value in row.items():
            if not key or str(key).startswith("_"):
                continue
            values_by_key[str(key).strip().lower()] = value
        raw_case = str(values_by_key.get("case_id") or "").strip()
        raw_source = str(values_by_key.get("source") or "").strip()
        raw_key = raw_case or raw_source
        if not raw_key:
            stats["unknown_case"] += 1
            issues.append(
                {
                    "case_id": None,
                    "field_path": None,
                    "type": "unknown_case",
                    "message": f"{filename} line {line}: Missing case ID / source",
                    "line": line,
                }
            )
            return
        case_id = resolve_case(raw_key)
        if not case_id:
            stats["unknown_case"] += 1
            issues.append(
                {
                    "case_id": raw_key,
                    "field_path": None,
                    "type": "unknown_case",
                    "message": (
                        f"{raw_key} is not in the current project's image list "
                        "(no exact case ID or matching path token)"
                    ),
                    "line": line,
                }
            )
            return
        group = add_group(case_id)
        for header, value in values_by_key.items():
            if header in ("case_id", "source", "status", "notes"):
                continue
            entry = wide_map.get(header)
            if entry is None:
                stats["unknown_field"] += 1
                issues.append(
                    {
                        "case_id": case_id,
                        "field_path": header,
                        "type": "unknown_field",
                        "message": (
                            "This column matches more than one schema field; use its full path"
                            if header in wide_ambiguous
                            else "No schema field matches this column"
                        ),
                        "line": line,
                    }
                )
                continue
            field_path = entry[0]
            group["values"].append(
                {"case_id": case_id, "field_path": field_path, "value": value, "line": line}
            )
        raw_notes = str(values_by_key.get("notes") or "").strip()
        if raw_notes:
            try:
                notes_obj = json.loads(raw_notes)
            except json.JSONDecodeError:
                notes_obj = None
            if isinstance(notes_obj, dict):
                for note_path, note_text in notes_obj.items():
                    if note_text is None or not str(note_text).strip():
                        continue
                    group["notes"].append(
                        {
                            "case_id": case_id,
                            "field_path": str(note_path),
                            "note": str(note_text),
                        }
                    )
            else:
                issues.append(
                    {
                        "case_id": case_id,
                        "field_path": "notes",
                        "type": "unknown_field",
                        "message": "The notes column must be a JSON object of {path: text}",
                        "line": line,
                    }
                )
        status = str(values_by_key.get("status") or "").strip()
        if status:
            group["status"] = status

    # ---------- 解析为按 case 分组 ----------
    for upload in uploads:
        filename = upload["filename"]
        data = upload["data"]
        if kind == "json":
            parsed = parse_json_case(filename, data)
            raw_case_id = parsed["case_id"]
            case_id = resolve_case(raw_case_id) if raw_case_id else None
            if not case_id:
                case_id = resolve_case(parsed["filename_stem"])
            if not case_id:
                stats["unknown_case"] += 1
                issues.append(
                    {
                        "case_id": raw_case_id,
                        "field_path": None,
                        "type": "unknown_case",
                        "message": (
                            f"{filename}: No matching case found "
                            f"(ID: {raw_case_id or 'n/a'}, file stem: {parsed['filename_stem']})"
                        ),
                        "line": None,
                    }
                )
                continue
            group = add_group(case_id)
            for path, value in parsed["values"].items():
                group["values"].append({"case_id": case_id, "field_path": path, "value": value, "line": None})
            for path, conf in parsed["confidence"].items():
                group["confidence"][path] = conf
            for path, note in parsed["notes"].items():
                group["notes"].append({"case_id": case_id, "field_path": path, "note": note})
            for path, box in parsed["evidence"].items():
                normalized = store.normalize_evidence({path: box}).get(path)
                if normalized:
                    group["evidence"][path] = normalized
            continue

        rows = parse_csv(data) if kind == "csv" else parse_excel(data)
        for row in rows:
            if row.get("_wide"):
                ingest_wide_row(filename, row)
                continue
            stats["rows"] += 1
            raw_case_id = str(row.get("case_id") or "").strip()
            if not raw_case_id:
                stats["unknown_case"] += 1
                issues.append(
                    {
                        "case_id": None,
                        "field_path": row.get("field_path"),
                        "type": "unknown_case",
                        "message": f"{filename} line {row.get('_line')}: Missing case ID",
                        "line": row.get("_line"),
                    }
                )
                continue
            case_id = resolve_case(raw_case_id)
            if not case_id:
                stats["unknown_case"] += 1
                issues.append(
                    {
                        "case_id": raw_case_id,
                        "field_path": row.get("field_path"),
                        "type": "unknown_case",
                        "message": (
                            f"{raw_case_id} is not in the current project's image list "
                            "(no exact case ID or matching path token)"
                        ),
                        "line": row.get("_line"),
                    }
                )
                continue
            group = add_group(case_id)
            group["values"].append(
                {
                    "case_id": case_id,
                    "field_path": str(row.get("field_path") or "").strip(),
                    "value": row.get("value"),
                    "line": row.get("_line"),
                }
            )
            confidence = str(row.get("confidence") or "").strip()
            if confidence:
                group["confidence"][str(row.get("field_path") or "").strip()] = confidence
            box = _parse_bbox(row.get("bbox"))
            if box:
                box["text"] = str(row.get("evidence_text") or "").strip()[:2000]
                try:
                    box["page"] = max(0, int(row.get("page") or 0))
                except (TypeError, ValueError):
                    box["page"] = 0
                group["evidence"][str(row.get("field_path") or "").strip()] = box
            note = str(row.get("note") or "")
            if note.strip():
                group["notes"].append(
                    {"case_id": case_id, "field_path": str(row.get("field_path") or "").strip(), "note": note}
                )

    # ---------- 写入 ----------
    baseline_dir = store.baseline_dir(project, import_id)
    (baseline_dir / "sources").mkdir(parents=True, exist_ok=True)
    for upload in uploads:
        name = safe_filename(upload["filename"], "source.dat")
        (baseline_dir / "sources" / name).write_bytes(upload["data"])

    touched: list[str] = []
    for case_id, group in grouped.items():
        case = by_id[case_id]
        ann = store.load_annotation(project, case_id) or store.make_annotation(
            project, case, schema_info
        )
        values = ann.get("values") if isinstance(ann.get("values"), dict) else {}
        notes = dict(ann.get("notes") or {})
        confidence = (
            dict(ann.get("confidence") or {})
            if isinstance(ann.get("confidence"), dict)
            else {}
        )
        evidence = store.normalize_evidence(ann.get("evidence"))
        baseline_confidence: dict[str, float] = {}

        for item in group["values"]:
            path = item["field_path"]
            if not path:
                stats["unknown_field"] += 1
                issues.append(
                    {
                        "case_id": case_id,
                        "field_path": path,
                        "type": "unknown_field",
                        "message": "Field path is empty",
                        "line": item.get("line"),
                    }
                )
                continue
            try:
                segs = schema.parse_path(path)
            except schema.SchemaError as exc:
                stats["unknown_field"] += 1
                issues.append(
                    {
                        "case_id": case_id,
                        "field_path": path,
                        "type": "unknown_field",
                        "message": str(exc),
                        "line": item.get("line"),
                    }
                )
                continue
            node = schema.find_node(root, segs)
            if node is None:
                stats["unknown_field"] += 1
                issues.append(
                    {
                        "case_id": case_id,
                        "field_path": path,
                        "type": "unknown_field",
                        "message": "This field path does not exist in the current schema",
                        "line": item.get("line"),
                    }
                )
                continue
            ok, value, error = _coerce_import_value(node, item.get("value"))
            if not ok:
                stats["type_mismatch"] += 1
                issues.append(
                    {
                        "case_id": case_id,
                        "field_path": path,
                        "type": "type_mismatch",
                        "message": error,
                        "value": item.get("value"),
                        "line": item.get("line"),
                    }
                )
                continue
            # baseline 始终记录导入值，作为差异比较的参照（即使 fill_empty 未写入当前标注）
            schema.set_value(group["baseline"], segs, value)
            box = group["evidence"].get(path)
            if box:
                group["baseline_evidence"][path] = box
            parsed_confidence = _parse_confidence(group["confidence"].get(path))
            if parsed_confidence is not None:
                baseline_confidence[path] = parsed_confidence
                stats["confidence"] += 1
            if mode == "baseline":
                # 只刷新 baseline 快照；人工修正过的值、备注、证据框、置信度都保持不动
                stats["kept_values"] += 1
                continue
            if mode == "fill_empty" and not _is_empty(schema.get_value(values, segs)):
                stats["skipped_fill"] += 1
                continue
            # 只有真正写入当前值时才同步证据框与置信度，
            # 避免「值被跳过、证据却被预测覆盖」的不一致。
            if box:
                evidence[path] = box
            if parsed_confidence is not None:
                confidence[path] = parsed_confidence
            schema.set_value(values, segs, value)
            stats["applied_fields"] += 1

        for item in group["notes"]:
            path = item["field_path"]
            if not path:
                continue
            try:
                segs = schema.parse_path(path)
            except schema.SchemaError:
                continue
            if schema.find_node(root, segs) is None:
                continue
            group["baseline_notes"][path] = item["note"]
            if mode == "baseline":
                continue
            if mode == "fill_empty" and str(notes.get(path) or "").strip():
                # 人工备注优先：值和备注都只在为空时补，预测不能覆盖人工结论。
                continue
            notes[path] = item["note"]
            stats["notes"] += 1

        stats["evidence"] += len(group["baseline_evidence"])

        if _is_empty(group["baseline"]) and not group["baseline_notes"]:
            continue

        status = ann.get("status") or "draft"
        group_status = str(group.get("status") or "").strip()
        if group_status:
            if group_status in store.STATUSES:
                status = group_status
            else:
                issues.append(
                    {
                        "case_id": case_id,
                        "field_path": "status",
                        "type": "invalid_status",
                        "message": f"Unknown status: {group_status}",
                        "line": None,
                    }
                )

        saved = store.save_annotation(
            project,
            case,
            {
                "values": values,
                "notes": notes,
                "confidence": confidence,
                "evidence": evidence,
                "status": status,
                "tags": ann.get("tags") or [],
                "baseline_import_id": import_id,
            },
            schema_info,
            expected_rev=None,
        )
        store.write_baseline(
            project,
            import_id,
            case_id,
            {
                "case_id": case_id,
                "source": case["source"],
                "schema_version": schema_info["version"],
                "imported_at": schema.now_iso(),
                "values": group["baseline"],
                "notes": group["baseline_notes"],
                "confidence": baseline_confidence,
                "evidence": group["baseline_evidence"],
            },
        )
        touched.append(case_id)
        _ = saved

    stats["cases"] = len(touched)

    meta = {
        "import_id": import_id,
        "kind": kind,
        "mode": mode,
        "created_at": schema.now_iso(),
        "schema_version": schema_info["version"],
        "files": [u["filename"] for u in uploads],
        "stats": stats,
    }
    jsonio.write_json(baseline_dir / "meta.json", meta)

    report = {"import_id": import_id, "kind": kind, "mode": mode, "created_at": meta["created_at"], "stats": stats, "issues": issues}
    jsonio.write_json(baseline_dir / "report.json", report)
    jsonio.write_json(project.root / "imports" / "reports" / f"{import_id}.json", report)

    index_path = project.root / "imports" / "index.json"
    imports = jsonio.read_json(index_path, {"imports": []}) or {"imports": []}
    imports.setdefault("imports", []).append(
        {
            "import_id": import_id,
            "kind": kind,
            "mode": mode,
            "created_at": meta["created_at"],
            "schema_version": meta["schema_version"],
            "files": meta["files"],
            "stats": stats,
        }
    )
    jsonio.write_json(index_path, imports)
    return report
