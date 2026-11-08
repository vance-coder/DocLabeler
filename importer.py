"""导入已有标注：JSON / CSV / Excel 长表，并生成 baseline 快照与报告。"""

from __future__ import annotations

import csv
import io
import json
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


def parse_csv(data: bytes) -> list[dict]:
    text = _decode(data)
    reader = csv.reader(io.StringIO(text))
    rows = list(reader)
    if not rows:
        raise ImportFailed("CSV file is empty")
    headers = [_norm_header(h) for h in rows[0]]
    for need in ("case_id", "field_path", "value"):
        if need not in headers:
            raise ImportFailed(f"CSV is missing required column: {need}")
    out: list[dict] = []
    for line_no, raw_row in enumerate(rows[1:], start=2):
        if not any(str(c).strip() for c in raw_row):
            continue
        row = {headers[i]: (raw_row[i] if i < len(raw_row) else "") for i in range(len(headers))}
        row["_line"] = line_no
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
    headers = [_norm_header(str(h) if h is not None else "") for h in rows[0]]
    for need in ("case_id", "field_path", "value"):
        if need not in headers:
            raise ImportFailed(f"Excel is missing required column: {need}")
    out: list[dict] = []
    for line_no, raw_row in enumerate(rows[1:], start=2):
        if not any(str(c).strip() for c in raw_row if c is not None):
            continue
        row = {
            headers[i]: ("" if i >= len(raw_row) or raw_row[i] is None else str(raw_row[i]))
            for i in range(len(headers))
        }
        row["_line"] = line_no
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
    if values is None:
        reserved = {"case_id", "id", "source", "schema_version", "status", "tags", "notes", "rev", "updated_at"}
        values = {k: v for k, v in payload.items() if k not in reserved}
        notes = notes if notes is not None else payload.get("notes")
    return {
        "case_id": str(case_id) if case_id else None,
        "filename_stem": Path(filename).stem,
        "values": schema.flatten_json(values or {}),
        "notes": _flatten_notes(notes),
    }


def _is_empty(value: Any) -> bool:
    return value is None or value == "" or value == [] or value == {}


def run_import(
    project,
    index: dict,
    schema_info: dict,
    uploads: list[dict],
    kind: str,
    mode: str = "overwrite",
) -> dict:
    """uploads: [{"filename": str, "data": bytes}]。"""
    if mode not in ("overwrite", "fill_empty"):
        raise ImportFailed("Import mode must be overwrite or fill_empty")
    if kind not in ("csv", "excel", "json"):
        raise ImportFailed("Import kind must be csv, excel, or json")

    import_id = new_import_id()
    root = schema_info["schema"]
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
        "notes": 0,
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
            case_id, {"values": [], "notes": [], "baseline": {}, "baseline_notes": {}}
        )

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
            for path, note in parsed["notes"].items():
                group["notes"].append({"case_id": case_id, "field_path": path, "note": note})
            continue

        rows = parse_csv(data) if kind == "csv" else parse_excel(data)
        for row in rows:
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
            ok, value, error = schema.coerce_value(node, item.get("value"))
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
            if mode == "fill_empty" and not _is_empty(schema.get_value(values, segs)):
                stats["skipped_fill"] += 1
                continue
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
            notes[path] = item["note"]
            group["baseline_notes"][path] = item["note"]
            stats["notes"] += 1

        if _is_empty(group["baseline"]) and not group["baseline_notes"]:
            continue

        saved = store.save_annotation(
            project,
            case,
            {
                "values": values,
                "notes": notes,
                "status": ann.get("status") or "draft",
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
