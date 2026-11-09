"""备注聚合、prompt 草稿、全局搜索索引与修正回流（corrections.csv）。"""

from __future__ import annotations

import csv
import io
import json
import re
from typing import Any

from fastapi import APIRouter, Request, Response

import diffing
import schema
import store
from . import deps

router = APIRouter()


# --------------------------------------------------------------------------
# 辅助
# --------------------------------------------------------------------------

def _template_path(path: str) -> str:
    """把 ``items[0].amount`` 归一成 schema 里的 ``items[].amount``。"""
    return re.sub(r"\[\d+\]", "[]", str(path or ""))


def _field_labels(schema_root: dict) -> dict[str, str]:
    return {path: node["label"] for path, node in schema.iter_fields(schema_root)}


def _csv_cell(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def _norm_note(text: str) -> str:
    """冲突比较用：去掉所有空白并转小写。"""
    return "".join(str(text).split()).lower()


def _notes_by_field(proj) -> dict[str, list[dict]]:
    grouped: dict[str, list[dict]] = {}
    for case_id, ann in store.list_annotations(proj).items():
        notes = ann.get("notes") or {}
        if not isinstance(notes, dict):
            continue
        for path, text in notes.items():
            text = str(text or "")
            if not text.strip():
                continue
            grouped.setdefault(str(path), []).append({"case_id": case_id, "note": text})
    for entries in grouped.values():
        entries.sort(key=lambda item: item["case_id"])
    return grouped


def _node_for_path(schema_root: dict, path: str) -> dict | None:
    try:
        return schema.find_node(schema_root, schema.parse_path(path))
    except schema.SchemaError:
        return None


def _notes_summary(proj, info: dict) -> dict:
    grouped = _notes_by_field(proj)
    fields: list[dict] = []
    total = 0
    for path, entries in grouped.items():
        total += len(entries)
        node = _node_for_path(info["schema"], path)
        label = node["label"] if node else path
        ftype = node["type"] if node else None

        variant_counts: dict[str, int] = {}
        for entry in entries:
            variant_counts[entry["note"]] = variant_counts.get(entry["note"], 0) + 1
        variants = [
            {"note": note, "count": count}
            for note, count in sorted(
                variant_counts.items(), key=lambda item: (-item[1], item[0])
            )
        ]
        fields.append(
            {
                "field_path": path,
                "label": label,
                "type": ftype,
                "count": len(entries),
                "case_count": len({entry["case_id"] for entry in entries}),
                "notes": entries,
                "variants": variants,
                "conflict": len({_norm_note(entry["note"]) for entry in entries}) >= 2,
            }
        )
    fields.sort(key=lambda item: (-item["count"], item["field_path"]))
    return {"total_notes": total, "fields": fields}


def _notes_csv_text(summary: dict) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["field_path", "note", "count", "case_ids"])
    for field in summary["fields"]:
        grouped: dict[str, list[str]] = {}
        for entry in field["notes"]:
            grouped.setdefault(entry["note"], []).append(entry["case_id"])
        for note, case_ids in sorted(
            grouped.items(), key=lambda item: (-len(item[1]), item[0])
        ):
            writer.writerow(
                [field["field_path"], note, len(case_ids), ";".join(sorted(case_ids))]
            )
    return "\ufeff" + buffer.getvalue()


def _template_regex(path: str) -> re.Pattern:
    """把 ``items[].amount`` 模板转成可匹配 ``items[0].amount`` 的正则。"""
    parts = path.split("[]")
    return re.compile("^" + r"\[\d+\]".join(re.escape(part) for part in parts) + "$")


def _prompt_payload(proj, info: dict) -> dict:
    grouped = _notes_by_field(proj)
    annotations = store.list_annotations(proj)
    flattened = [
        (case_id, schema.flatten_json((annotations[case_id].get("values") or {})))
        for case_id in sorted(annotations)
    ]

    sections: list[dict] = []
    for path, node in schema.iter_fields(info["schema"]):
        if node.get("type") not in schema.SCALAR_TYPES:
            continue
        pattern = _template_regex(path)

        examples: list[str] = []
        for _case_id, values in flattened:
            for flat_path, raw in values.items():
                if not pattern.match(flat_path):
                    continue
                if raw is None or isinstance(raw, (dict, list)):
                    continue
                text = str(raw)
                if text.strip() and text not in examples:
                    examples.append(text)

        notes: list[str] = []
        note_entries: list[dict] = []
        for note_path, entries in grouped.items():
            if pattern.match(note_path):
                note_entries.extend(entries)
        for entry in sorted(note_entries, key=lambda item: item["case_id"]):
            if entry["note"] not in notes:
                notes.append(entry["note"])

        sections.append(
            {
                "field_path": path,
                "label": node["label"],
                "type": node["type"],
                "description": node.get("description") or "",
                "required": bool(node.get("required")),
                "examples": examples[:3],
                "notes": notes[:8],
                "conflict": len({_norm_note(note) for note in notes}) >= 2,
            }
        )

    lines = [f"# {proj.name}", ""]
    for section in sections:
        lines.append(f"## {section['label']}")
        lines.append(f"Path: {section['field_path']}")
        lines.append(f"Type: {section['type']}")
        lines.append(f"Required: {'yes' if section['required'] else 'no'}")
        lines.append(f"Description: {section['description'] or '-'}")
        lines.append("")
        lines.append("Examples:")
        if section["examples"]:
            lines.extend(f"- {item}" for item in section["examples"])
        else:
            lines.append("- (none)")
        lines.append("")
        lines.append("Notes:")
        if section["notes"]:
            lines.extend(f"- {item}" for item in section["notes"])
        else:
            lines.append("- (none)")
        if section["conflict"]:
            lines.append("")
            lines.append("Conflicting notes:")
            lines.extend(f"- {item}" for item in section["notes"])
        lines.append("")
    return {"text": "\n".join(lines).strip() + "\n", "sections": sections}


# --------------------------------------------------------------------------
# 路由
# --------------------------------------------------------------------------

@router.get("/api/projects/{project_id}/search-index")
def api_search_index(project_id: str, request: Request) -> dict:
    """返回每个 case 的可搜索字段值与备注，供前端做全局搜索。"""
    proj = deps.project(request, project_id)
    info = deps.schema_info(proj)
    labels = _field_labels(info["schema"])
    entries: dict[str, list[dict]] = {}
    for case_id, ann in store.list_annotations(proj).items():
        items: list[dict] = []
        for path, raw in schema.flatten_json(ann.get("values") or {}).items():
            if raw is None or isinstance(raw, (dict, list)):
                continue
            text = str(raw)
            if not text.strip():
                continue
            items.append(
                {
                    "path": path,
                    "label": labels.get(_template_path(path), ""),
                    "kind": "value",
                    "text": text,
                }
            )
        notes = ann.get("notes")
        if isinstance(notes, dict):
            for path, raw in notes.items():
                text = str(raw or "")
                if not text.strip():
                    continue
                items.append(
                    {
                        "path": str(path),
                        "label": labels.get(_template_path(str(path)), ""),
                        "kind": "note",
                        "text": text,
                    }
                )
        entries[case_id] = items
    return {"cases": entries}


@router.get("/api/projects/{project_id}/notes/summary")
def api_notes_summary(project_id: str, request: Request) -> dict:
    proj = deps.project(request, project_id)
    return _notes_summary(proj, deps.schema_info(proj))


@router.get("/api/projects/{project_id}/notes/summary.csv")
def api_notes_summary_csv(project_id: str, request: Request):
    proj = deps.project(request, project_id)
    text = _notes_csv_text(_notes_summary(proj, deps.schema_info(proj)))
    return Response(
        content=text,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="notes_summary.csv"'},
    )


@router.get("/api/projects/{project_id}/prompt")
def api_prompt(project_id: str, request: Request) -> dict:
    proj = deps.project(request, project_id)
    return _prompt_payload(proj, deps.schema_info(proj))


@router.get("/api/projects/{project_id}/corrections.csv")
def api_corrections_csv(project_id: str, request: Request):
    """按字段聚合「baseline(模型) vs 当前(人工)」的差异，用于回流提示词。"""
    proj = deps.project(request, project_id)
    info = deps.schema_info(proj)
    labels = _field_labels(info["schema"])

    buckets: dict[tuple, dict] = {}
    for case_id, ann in sorted(store.list_annotations(proj).items()):
        diff = diffing.diff_for_case(proj, ann, info)
        if not diff["has_baseline"]:
            continue
        notes = ann.get("notes") or {}
        for field in diff["fields"]:
            if field["kind"] == "added":
                # 当前值存在但本次 baseline 没有预测，通常不是模型错误，跳过
                continue
            path = _template_path(field["path"])
            key = (
                path,
                field["kind"],
                _csv_cell(field["old"]),
                _csv_cell(field["new"]),
            )
            bucket = buckets.setdefault(
                key,
                {
                    "path": path,
                    "kind": field["kind"],
                    "old": field["old"],
                    "new": field["new"],
                    "cases": [],
                    "notes": [],
                },
            )
            bucket["cases"].append(case_id)
            note = str(notes.get(field["path"]) or "").strip()
            if note and note not in bucket["notes"]:
                bucket["notes"].append(note)

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(
        [
            "field_path",
            "label",
            "kind",
            "baseline_value",
            "current_value",
            "count",
            "case_ids",
            "notes",
        ]
    )
    for bucket in sorted(buckets.values(), key=lambda item: (-len(item["cases"]), item["path"])):
        writer.writerow(
            [
                bucket["path"],
                labels.get(bucket["path"], ""),
                bucket["kind"],
                _csv_cell(bucket["old"]),
                _csv_cell(bucket["new"]),
                len(bucket["cases"]),
                ";".join(sorted(bucket["cases"])[:20]),
                " | ".join(bucket["notes"][:3]),
            ]
        )
    return Response(
        content="\ufeff" + buffer.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="corrections.csv"'},
    )
