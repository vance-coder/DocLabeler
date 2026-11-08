"""导出标注集：目录结构、manifest、宽表 CSV、字段说明。"""

from __future__ import annotations

import csv
import hashlib
import io
import json
from datetime import datetime
from pathlib import Path
from typing import Any

import imaging
import jsonio
import schema
import store
from paths import safe_filename

MANIFEST_FIELDS = [
    "case_id",
    "source",
    "source_abs",
    "exported_image",
    "sha256",
    "exported_sha256",
    "schema_version",
    "exported_at",
]


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _new_version_dir(project, label: str) -> tuple[str, Path]:
    base = datetime.now().strftime("%Y%m%d-%H%M%S")
    if label:
        base += "-" + safe_filename(label, "export", 40)
    version = base
    root = project.root / "exports"
    n = 2
    while (root / version).exists():
        version = f"{base}-{n}"
        n += 1
    path = root / version
    path.mkdir(parents=True)
    return version, path


def _write_csv(path: Path, headers: list[str], rows: list[dict]) -> None:
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=headers, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({k: row.get(k, "") for k in headers})


def export_cases(
    project,
    case_ids: list[str],
    index: dict,
    schema_info: dict,
    label: str = "",
) -> dict:
    by_id = {c["case_id"]: c for c in index.get("cases", [])}
    selected = [by_id[c] for c in case_ids if c in by_id]
    if not selected:
        raise ValueError("No cases to export")

    version, export_dir = _new_version_dir(project, label)
    (export_dir / "cases").mkdir(parents=True, exist_ok=True)
    exported_at = schema.now_iso()
    root = schema_info["schema"]

    manifest_rows: list[dict] = []
    manifest_cases: list[dict] = []
    wide_rows: list[dict] = []
    used_dirs: set[str] = set()

    for case in selected:
        case_id = case["case_id"]
        dir_name = safe_filename(case_id, "case", 80)
        if dir_name in used_dirs:
            n = 2
            while f"{dir_name}-{n}" in used_dirs:
                n += 1
            dir_name = f"{dir_name}-{n}"
        used_dirs.add(dir_name)
        case_dir = export_dir / "cases" / dir_name
        case_dir.mkdir(parents=True, exist_ok=True)

        src = project.images_dir() / case["source"]
        image_path = case_dir / "image.png"
        imaging.export_png(src, image_path)

        ann = store.load_annotation(project, case_id) or store.make_annotation(
            project, case, schema_info
        )
        values = ann.get("values") if isinstance(ann.get("values"), dict) else {}
        notes = ann.get("notes") or {}

        jsonio.write_json(
            case_dir / "label.json",
            {
                "case_id": case_id,
                "source": case["source"],
                "schema_version": schema_info["version"],
                "values": values,
                "notes": notes,
                "status": ann.get("status") or "draft",
                "tags": ann.get("tags") or [],
                "updated_at": ann.get("updated_at"),
                "exported_at": exported_at,
            },
        )
        _write_csv(
            case_dir / "notes.csv",
            ["field_path", "note"],
            [{"field_path": k, "note": v} for k, v in notes.items()],
        )

        row = {
            "case_id": case_id,
            "source": case["source"],
            "source_abs": str(src.resolve()),
            "exported_image": f"cases/{dir_name}/image.png",
            "sha256": sha256_file(src),
            "exported_sha256": sha256_file(image_path),
            "schema_version": schema_info["version"],
            "exported_at": exported_at,
        }
        manifest_rows.append(row)
        manifest_cases.append(
            {
                **row,
                "status": ann.get("status") or "draft",
                "label_file": f"cases/{dir_name}/label.json",
                "notes_file": f"cases/{dir_name}/notes.csv",
            }
        )

        wide = schema.wide_row(root, values)
        wide["case_id"] = case_id
        wide["source"] = case["source"]
        wide["status"] = ann.get("status") or "draft"
        wide["notes"] = json.dumps(notes, ensure_ascii=False)
        wide_rows.append(wide)

    _write_csv(export_dir / "manifest.csv", MANIFEST_FIELDS, manifest_rows)

    columns = schema.wide_columns(root)
    wide_headers = ["case_id", "source", "status"] + [path for path, _, _ in columns] + ["notes"]
    _write_csv(export_dir / "summary.csv", wide_headers, wide_rows)

    jsonio.write_json(
        export_dir / "schema.json",
        {"version": schema_info["version"], "schema": root},
    )

    fields_rows = []
    for path, node in schema.iter_fields(root):
        fields_rows.append(
            {
                "field_path": path,
                "id": node.get("id"),
                "label": node.get("label"),
                "type": node.get("type"),
                "required": "true" if node.get("required") else "false",
                "enum": ",".join(node.get("enum") or []),
                "description": node.get("description") or "",
            }
        )
    _write_csv(
        export_dir / "fields.csv",
        ["field_path", "id", "label", "type", "required", "enum", "description"],
        fields_rows,
    )

    meta = {
        "version": version,
        "exported_at": exported_at,
        "project_id": project.id,
        "project_name": project.name,
        "images_dir": str(project.images_dir()),
        "schema_version": schema_info["version"],
        "case_count": len(manifest_cases),
        "cases": manifest_cases,
    }
    jsonio.write_json(export_dir / "manifest.json", meta)

    return {
        "version": version,
        "export_dir": str(export_dir),
        "relative_dir": f"exports/{version}",
        "case_count": len(manifest_cases),
        "manifest": manifest_rows,
    }


def list_exports(project) -> list[dict]:
    root = project.root / "exports"
    if not root.exists():
        return []
    out = []
    for directory in sorted(root.iterdir(), reverse=True):
        if not directory.is_dir():
            continue
        meta = jsonio.read_json(directory / "manifest.json", {}) or {}
        out.append(
            {
                "version": directory.name,
                "exported_at": meta.get("exported_at"),
                "case_count": meta.get("case_count", 0),
                "schema_version": meta.get("schema_version"),
            }
        )
    return out
