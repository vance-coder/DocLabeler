"""DocLabeler 服务入口。"""

from __future__ import annotations

import argparse
import csv
import io
import json
import re
import webbrowser
from pathlib import Path
from typing import Any
from urllib.parse import unquote

import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

import diffing
import exporter
import imaging
import importer
import jsonio
import projects
import scanner
import schema
import store
from paths import is_safe_id, resolve_images_dir, safe_filename

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"


# --------------------------------------------------------------------------
# 备注聚合 / Prompt 草稿辅助
# --------------------------------------------------------------------------

def _norm_note(text: str) -> str:
    """冲突比较用：去掉所有空白并转小写。"""
    return "".join(str(text).split()).lower()


def _notes_by_field(project) -> dict[str, list[dict]]:
    grouped: dict[str, list[dict]] = {}
    for case_id, ann in store.list_annotations(project).items():
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


def _notes_summary(project, schema_info: dict) -> dict:
    grouped = _notes_by_field(project)
    fields: list[dict] = []
    total = 0
    for path, entries in grouped.items():
        total += len(entries)
        node = _node_for_path(schema_info["schema"], path)
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


def _prompt_payload(project, schema_info: dict) -> dict:
    grouped = _notes_by_field(project)
    annotations = store.list_annotations(project)
    flattened = [
        (case_id, schema.flatten_json((annotations[case_id].get("values") or {})))
        for case_id in sorted(annotations)
    ]

    sections: list[dict] = []
    for path, node in schema.iter_fields(schema_info["schema"]):
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

    lines = [f"# {project.name}", ""]
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


def _collection_path(project, name: str) -> Path:
    return project.root / "collections" / f"{safe_filename(name, max_len=60)}.json"


def _check_collection_name(name: str) -> str:
    name = unquote(str(name or "")).strip()
    if not name:
        raise HTTPException(status_code=400, detail="Collection name cannot be empty")
    if "/" in name or "\\" in name or ".." in name:
        raise HTTPException(status_code=400, detail="Invalid collection name")
    return name


def create_app(workspace: Path) -> FastAPI:
    workspace = Path(workspace).resolve()
    workspace.mkdir(parents=True, exist_ok=True)
    (workspace / "projects").mkdir(parents=True, exist_ok=True)

    app = FastAPI(title="DocLabeler")
    app.state.workspace = workspace
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

    # ------------------------------------------------------------------
    # 内部工具
    # ------------------------------------------------------------------
    def _project(project_id: str) -> projects.Project:
        try:
            return projects.load_project(workspace, project_id)
        except projects.ProjectNotFound:
            raise HTTPException(status_code=404, detail="Project not found")

    def _schema_info(project) -> dict:
        try:
            return schema.load_schema(project.root)
        except schema.SchemaError as exc:
            raise HTTPException(status_code=500, detail=str(exc))

    def _index(project) -> dict:
        try:
            return scanner.load_index(project)
        except scanner.CaseIdConflict as exc:
            raise HTTPException(
                status_code=409, detail={"message": str(exc), "conflicts": exc.conflicts}
            )
        except FileNotFoundError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    def _case(project, index: dict, case_id: str) -> dict:
        case = scanner.index_map(index).get(case_id)
        if case is None:
            raise HTTPException(status_code=404, detail=f"Case {case_id} not found")
        return case

    # ------------------------------------------------------------------
    # 项目
    # ------------------------------------------------------------------
    @app.get("/api/health")
    def health() -> dict:
        return {"ok": True, "workspace": str(workspace)}

    @app.get("/api/projects")
    def api_list_projects() -> dict:
        return {"projects": projects.list_projects(workspace), "workspace": str(workspace)}

    @app.post("/api/projects")
    def api_create_project(payload: dict) -> dict:
        name = str(payload.get("name") or "").strip()
        images_dir = str(payload.get("images_dir") or "").strip()
        description = str(payload.get("description") or "")
        mode = str(payload.get("schema_mode") or "empty")

        if not name:
            raise HTTPException(status_code=400, detail="Project name cannot be empty")
        try:
            resolved = resolve_images_dir(workspace, images_dir)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

        try:
            scanner.collect(resolved)
        except scanner.CaseIdConflict as exc:
            raise HTTPException(
                status_code=409, detail={"message": str(exc), "conflicts": exc.conflicts}
            )

        try:
            if mode == "example":
                raw = payload.get("example_json") or ""
                example = json.loads(raw) if isinstance(raw, str) else raw
                schema_root = schema.infer_from_example(example)
            elif mode == "json_schema":
                raw = payload.get("json_schema") or ""
                js = json.loads(raw) if isinstance(raw, str) else raw
                schema_root = schema.from_json_schema(js)
            else:
                schema_root = schema.empty_schema()
        except (json.JSONDecodeError, schema.SchemaError) as exc:
            raise HTTPException(status_code=400, detail=f"Failed to parse schema: {exc}")

        try:
            project = projects.create_project(
                workspace, name, images_dir, description, schema_root
            )
        except projects.ProjectError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

        try:
            index = scanner.scan(project)
        except scanner.CaseIdConflict as exc:
            raise HTTPException(
                status_code=409, detail={"message": str(exc), "conflicts": exc.conflicts}
            )
        return {
            "project": _project_payload(project),
            "index": _index_summary(index),
            "schema": schema.load_schema(project.root),
        }

    def _project_payload(project) -> dict:
        meta = dict(project.meta)
        images_dir = project.images_dir()
        meta["images_dir_absolute"] = str(images_dir)
        meta["images_dir_exists"] = images_dir.is_dir()
        return meta

    def _index_summary(index: dict) -> dict:
        return {
            "generated_at": index.get("generated_at"),
            "count": index.get("count", 0),
            "root": index.get("root"),
            "unsupported": index.get("unsupported", []),
        }

    @app.get("/api/projects/{project_id}")
    def api_get_project(project_id: str) -> dict:
        project = _project(project_id)
        index = _index(project)
        return {
            "project": _project_payload(project),
            "schema": _schema_info(project),
            "index": _index_summary(index),
        }

    @app.post("/api/projects/{project_id}/rescan")
    def api_rescan(project_id: str) -> dict:
        project = _project(project_id)
        try:
            index = scanner.scan(project)
        except scanner.CaseIdConflict as exc:
            raise HTTPException(
                status_code=409, detail={"message": str(exc), "conflicts": exc.conflicts}
            )
        except FileNotFoundError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        return {"index": _index_summary(index)}

    # ------------------------------------------------------------------
    # case 列表
    # ------------------------------------------------------------------
    @app.get("/api/projects/{project_id}/cases")
    def api_cases(project_id: str, refresh: int = 0) -> dict:
        project = _project(project_id)
        index = scanner.scan(project) if refresh else _index(project)
        info = _schema_info(project)
        annotations = store.list_annotations(project)

        rows = []
        for case in index.get("cases", []):
            entry: dict[str, Any] = {
                "case_id": case["case_id"],
                "source": case["source"],
                "num_frames": case.get("num_frames", 1),
                "warning": case.get("warning"),
                "folder": str(Path(case["source"]).parent.as_posix()),
                "annotation": None,
            }
            ann = annotations.get(case["case_id"])
            if ann:
                diff = diffing.diff_for_case(project, ann, info)
                entry["annotation"] = {
                    "status": ann.get("status") or "draft",
                    "tags": ann.get("tags") or [],
                    "updated_at": ann.get("updated_at"),
                    "notes_count": len(
                        [v for v in (ann.get("notes") or {}).values() if str(v).strip()]
                    ),
                    "has_baseline": diff["has_baseline"],
                    "diff_count": len(diff["fields"]),
                }
            rows.append(entry)
        return {
            "cases": rows,
            "index": _index_summary(index),
            "schema_version": info["version"],
        }

    # ------------------------------------------------------------------
    # 预览
    # ------------------------------------------------------------------
    @app.get("/api/projects/{project_id}/preview/{case_id}")
    def api_preview(project_id: str, case_id: str, w: int = 1800):
        project = _project(project_id)
        index = _index(project)
        case = _case(project, index, case_id)
        width = max(400, min(int(w), 4000))
        try:
            path = imaging.ensure_preview(project, case, width)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Preview failed: {exc}")
        return FileResponse(path, media_type="image/png", headers={"Cache-Control": "no-cache"})

    # ------------------------------------------------------------------
    # schema
    # ------------------------------------------------------------------
    @app.get("/api/projects/{project_id}/schema")
    def api_get_schema(project_id: str) -> dict:
        project = _project(project_id)
        return _schema_info(project)

    @app.put("/api/projects/{project_id}/schema")
    def api_put_schema(project_id: str, payload: dict) -> dict:
        project = _project(project_id)
        node = payload.get("schema")
        if not isinstance(node, dict):
            raise HTTPException(status_code=400, detail="Missing schema")
        try:
            result = schema.save_schema(
                project.root, node, expected_version=payload.get("expected_version")
            )
        except schema.SchemaVersionConflict as exc:
            raise HTTPException(status_code=409, detail=str(exc))
        except schema.SchemaError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        migration = store.migrate_annotations(
            project, result["previous"], result["schema"], result["version"]
        )
        return {
            "version": result["version"],
            "schema": result["schema"],
            "migration": migration,
        }

    @app.post("/api/projects/{project_id}/schema/infer")
    def api_infer_schema(project_id: str, payload: dict) -> dict:
        _project(project_id)
        raw = payload.get("example_json")
        try:
            example = json.loads(raw) if isinstance(raw, str) else raw
            return {"schema": schema.infer_from_example(example)}
        except (json.JSONDecodeError, schema.SchemaError) as exc:
            raise HTTPException(status_code=400, detail=f"Failed to parse example: {exc}")

    @app.post("/api/projects/{project_id}/schema/import")
    def api_import_schema(project_id: str, payload: dict) -> dict:
        _project(project_id)
        raw = payload.get("json_schema")
        try:
            js = json.loads(raw) if isinstance(raw, str) else raw
            return {"schema": schema.from_json_schema(js)}
        except (json.JSONDecodeError, schema.SchemaError) as exc:
            raise HTTPException(status_code=400, detail=f"Failed to parse JSON Schema: {exc}")

    # ------------------------------------------------------------------
    # 标注
    # ------------------------------------------------------------------
    @app.get("/api/projects/{project_id}/annotations/{case_id}")
    def api_get_annotation(project_id: str, case_id: str) -> dict:
        project = _project(project_id)
        index = _index(project)
        case = _case(project, index, case_id)
        info = _schema_info(project)
        ann = store.load_annotation(project, case_id) or store.make_annotation(
            project, case, info
        )
        return {
            "annotation": ann,
            "values": schema.merge_defaults(info["schema"], ann.get("values")),
            "schema_version": info["version"],
        }

    @app.put("/api/projects/{project_id}/annotations/{case_id}")
    def api_put_annotation(project_id: str, case_id: str, payload: dict) -> dict:
        project = _project(project_id)
        index = _index(project)
        case = _case(project, index, case_id)
        info = _schema_info(project)
        try:
            saved = store.save_annotation(
                project, case, payload, info, expected_rev=payload.get("expected_rev")
            )
        except store.RevConflict as exc:
            raise HTTPException(
                status_code=409,
                detail={"message": "Annotation was changed in another window. Please refresh.", "annotation": exc.current},
            )
        except store.AnnotationError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        return {"annotation": saved, "schema_version": info["version"]}

    @app.post("/api/projects/{project_id}/annotations/bulk")
    def api_bulk_annotations(project_id: str, payload: dict) -> dict:
        project = _project(project_id)
        index = _index(project)
        info = _schema_info(project)

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

        by_id = scanner.index_map(index)
        updated: list[dict] = []
        skipped: list[dict] = []
        for raw_case_id in case_ids:
            case_id = str(raw_case_id)
            case = by_id.get(case_id)
            if case is None:
                skipped.append({"case_id": case_id, "reason": "Case not found in this project"})
                continue
            ann = store.load_annotation(project, case_id) or store.make_annotation(
                project, case, info
            )
            current_tags = [str(t) for t in (ann.get("tags") or [])]
            new_status = ann.get("status") or "draft"
            if action == "status":
                new_status = status or new_status
            elif action == "add_tags":
                for tag in tags:
                    if tag not in current_tags:
                        current_tags.append(tag)
            else:
                current_tags = [tag for tag in current_tags if tag not in tags]
            try:
                saved = store.save_annotation(
                    project,
                    case,
                    {
                        "values": ann.get("values") or {},
                        "notes": ann.get("notes") or {},
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

    @app.get("/api/projects/{project_id}/diff/{case_id}")
    def api_diff(project_id: str, case_id: str) -> dict:
        project = _project(project_id)
        index = _index(project)
        case = _case(project, index, case_id)
        info = _schema_info(project)
        ann = store.load_annotation(project, case_id) or store.make_annotation(
            project, case, info
        )
        return diffing.diff_for_case(project, ann, info)

    @app.post("/api/projects/{project_id}/annotations/{case_id}/revert")
    def api_revert(project_id: str, case_id: str, payload: dict) -> dict:
        project = _project(project_id)
        index = _index(project)
        case = _case(project, index, case_id)
        info = _schema_info(project)
        ann = store.load_annotation(project, case_id)
        if not ann:
            raise HTTPException(status_code=400, detail="This case has no annotation yet")
        baseline = diffing.baseline_values(project, ann, info)
        if baseline is None:
            raise HTTPException(status_code=400, detail="This case has no baseline")

        values = ann.get("values") or {}
        revert_all = bool(payload.get("all"))
        raw_paths: list[str] = []
        if revert_all:
            raw_paths = [item["path"] for item in diffing.compute_diff(values, baseline)]
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
        # 删除数组下标时从后往前处理，避免 pop 造成的下标位移
        for path, segs in sorted(deletions, key=lambda item: item[0], reverse=True):
            diffing.delete_value(values, segs)
            if revert_all:
                reverted.append(path)
            else:
                missing.append(path)

        saved = store.save_annotation(
            project,
            case,
            {
                "values": values,
                "notes": ann.get("notes") or {},
                "status": ann.get("status") or "draft",
                "tags": ann.get("tags") or [],
                "baseline_import_id": ann.get("baseline_import_id"),
            },
            info,
            expected_rev=payload.get("expected_rev"),
        )
        return {"annotation": saved, "reverted": reverted, "missing": missing}

    # ------------------------------------------------------------------
    # Collections
    # ------------------------------------------------------------------
    @app.get("/api/projects/{project_id}/collections")
    def api_list_collections(project_id: str) -> dict:
        project = _project(project_id)
        directory = project.root / "collections"
        items: list[dict] = []
        if directory.exists():
            for path in directory.glob("*.json"):
                data = jsonio.read_json(path)
                if not isinstance(data, dict):
                    continue
                items.append(
                    {
                        "name": data.get("name") or path.stem,
                        "count": len(data.get("case_ids") or []),
                        "updated_at": data.get("updated_at"),
                    }
                )
        items.sort(key=lambda item: str(item["name"]))
        return {"collections": items}

    @app.get("/api/projects/{project_id}/collections/{name}")
    def api_get_collection(project_id: str, name: str) -> dict:
        project = _project(project_id)
        name = _check_collection_name(name)
        data = jsonio.read_json(_collection_path(project, name))
        if not isinstance(data, dict):
            raise HTTPException(status_code=404, detail="Collection not found")
        return {
            "name": data.get("name") or name,
            "case_ids": list(data.get("case_ids") or []),
            "updated_at": data.get("updated_at"),
        }

    @app.put("/api/projects/{project_id}/collections/{name}")
    def api_put_collection(project_id: str, name: str, payload: dict) -> dict:
        project = _project(project_id)
        name = _check_collection_name(name)
        index = _index(project)

        raw_ids = payload.get("case_ids")
        if not isinstance(raw_ids, list):
            raise HTTPException(status_code=400, detail="case_ids must be an array")
        case_ids: list[str] = []
        for raw in raw_ids:
            case_id = str(raw)
            if case_id and case_id not in case_ids:
                case_ids.append(case_id)

        known = set(scanner.index_map(index))
        unknown = [case_id for case_id in case_ids if case_id not in known]
        if unknown:
            raise HTTPException(
                status_code=400,
                detail={"message": "Unknown case IDs", "unknown": unknown},
            )

        path = _collection_path(project, name)
        existing = jsonio.read_json(path)
        now = schema.now_iso()
        created_at = (
            existing.get("created_at")
            if isinstance(existing, dict) and existing.get("created_at")
            else now
        )
        record = {
            "name": name,
            "case_ids": case_ids,
            "created_at": created_at,
            "updated_at": now,
        }
        jsonio.write_json(path, record)
        return {"name": name, "case_ids": case_ids, "updated_at": now}

    @app.delete("/api/projects/{project_id}/collections/{name}")
    def api_delete_collection(project_id: str, name: str) -> dict:
        project = _project(project_id)
        name = _check_collection_name(name)
        path = _collection_path(project, name)
        if not path.exists():
            raise HTTPException(status_code=404, detail="Collection not found")
        path.unlink()
        return {"deleted": True}

    # ------------------------------------------------------------------
    # 备注聚合 / Prompt 草稿
    # ------------------------------------------------------------------
    @app.get("/api/projects/{project_id}/notes/summary")
    def api_notes_summary(project_id: str) -> dict:
        project = _project(project_id)
        return _notes_summary(project, _schema_info(project))

    @app.get("/api/projects/{project_id}/notes/summary.csv")
    def api_notes_summary_csv(project_id: str):
        project = _project(project_id)
        text = _notes_csv_text(_notes_summary(project, _schema_info(project)))
        return Response(
            content=text,
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": 'attachment; filename="notes_summary.csv"'},
        )

    @app.get("/api/projects/{project_id}/prompt")
    def api_prompt(project_id: str) -> dict:
        project = _project(project_id)
        return _prompt_payload(project, _schema_info(project))

    # ------------------------------------------------------------------
    # 导入
    # ------------------------------------------------------------------
    @app.get("/api/projects/{project_id}/imports")
    def api_list_imports(project_id: str) -> dict:
        project = _project(project_id)
        data = jsonio.read_json(project.root / "imports" / "index.json", {"imports": []})
        return data if isinstance(data, dict) else {"imports": []}

    @app.get("/api/projects/{project_id}/imports/{import_id}")
    def api_import_report(project_id: str, import_id: str) -> dict:
        project = _project(project_id)
        if not is_safe_id(import_id):
            raise HTTPException(status_code=400, detail="Invalid import ID")
        report = jsonio.read_json(
            project.root / "imports" / "reports" / f"{import_id}.json"
        )
        if not isinstance(report, dict):
            raise HTTPException(status_code=404, detail="Import report not found")
        return report

    @app.post("/api/projects/{project_id}/imports")
    async def api_import(
        project_id: str,
        kind: str = Form("csv"),
        mode: str = Form("overwrite"),
        files: list[UploadFile] = File(...),
    ) -> dict:
        project = _project(project_id)
        index = _index(project)
        info = _schema_info(project)
        uploads = []
        for upload in files:
            data = await upload.read()
            uploads.append({"filename": upload.filename or "upload", "data": data})
        try:
            return importer.run_import(project, index, info, uploads, kind, mode)
        except importer.ImportFailed as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    # ------------------------------------------------------------------
    # 导出
    # ------------------------------------------------------------------
    @app.get("/api/projects/{project_id}/exports")
    def api_list_exports(project_id: str) -> dict:
        project = _project(project_id)
        return {"exports": exporter.list_exports(project)}

    @app.post("/api/projects/{project_id}/exports")
    def api_export(project_id: str, payload: dict) -> dict:
        project = _project(project_id)
        index = _index(project)
        info = _schema_info(project)
        case_ids = payload.get("case_ids")
        if not case_ids:
            case_ids = [c["case_id"] for c in index.get("cases", [])]
        try:
            return exporter.export_cases(
                project, list(case_ids), index, info, str(payload.get("label") or "")
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    @app.get("/api/projects/{project_id}/exports/{version}/manifest.csv")
    def api_download_manifest(project_id: str, version: str):
        project = _project(project_id)
        if not is_safe_id(version):
            raise HTTPException(status_code=400, detail="Invalid export version")
        path = project.root / "exports" / version / "manifest.csv"
        if not path.exists():
            raise HTTPException(status_code=404, detail="Manifest not found")
        return FileResponse(path, media_type="text/csv", filename=f"{version}-manifest.csv")

    # ------------------------------------------------------------------
    # 页面
    # ------------------------------------------------------------------
    @app.get("/")
    def index_page():
        return FileResponse(STATIC_DIR / "index.html")

    return app


def main() -> None:
    parser = argparse.ArgumentParser(description="DocLabeler local document field labeling tool")
    parser.add_argument("--workspace", required=True, help="Workspace root directory")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--open", action="store_true", help="Open the browser after starting")
    args = parser.parse_args()

    app = create_app(Path(args.workspace))
    url = f"http://{args.host}:{args.port}"
    print(f"DocLabeler started: {url}")
    print(f"Workspace root: {Path(args.workspace).resolve()}")
    if args.open:
        webbrowser.open(url)
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


app = None


if __name__ == "__main__":
    main()
