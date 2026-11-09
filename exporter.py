"""导出标注集：目录结构、manifest、宽表 CSV、字段说明。"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import os
import re
import shutil
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any

import imaging
import jsonio
import locks
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


STAGING_PREFIX = ".staging-"


def _version_base(label: str) -> str:
    base = datetime.now().strftime("%Y%m%d-%H%M%S")
    if label:
        base += "-" + safe_filename(label, "export", 40)
    return base


def _staging_dir(project, label: str) -> tuple[str, Path]:
    """在 exports/ 下开一个隐藏临时目录；产物写完后才整体发布。

    这样中途失败（缺图、磁盘满、CSV 写失败）不会留下看起来像正常导出的半成品目录。
    """
    base = _version_base(label)
    root = project.root / "exports"
    root.mkdir(parents=True, exist_ok=True)
    path = Path(tempfile.mkdtemp(prefix=f"{STAGING_PREFIX}{base}-", dir=str(root)))
    return base, path


def _publish(project, staging: Path, base: str) -> tuple[str, Path]:
    """把 staging 原子重命名为最终版本目录；同名被占用时自动换后缀。"""
    with locks.project_lock(project):
        root = project.root / "exports"
        version = base
        final = root / version
        n = 2
        while final.exists():
            version = f"{base}-{n}"
            final = root / version
            n += 1
        if version != base:
            # manifest.json 里的版本号必须和最终目录名一致。
            meta_path = staging / "manifest.json"
            meta = jsonio.read_json(meta_path, {}) or {}
            meta["version"] = version
            jsonio.write_json(meta_path, meta)
        try:
            os.replace(staging, final)
        except BaseException:
            shutil.rmtree(staging, ignore_errors=True)
            raise
        return version, final


def _write_csv(path: Path, headers: list[str], rows: list[dict]) -> None:
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=headers, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({k: row.get(k, "") for k in headers})


def _crop_name(field_path: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9_-]+", "_", str(field_path)).strip("_")
    return safe_filename(slug, "field", 80)


def export_cases(
    project,
    case_ids: list[str],
    index: dict,
    schema_info: dict,
    label: str = "",
    include_crops: bool = True,
) -> dict:
    """对外入口：隐藏临时目录写完 -> 原子发布；任何失败都清理临时目录。"""
    base, staging = _staging_dir(project, label)
    try:
        result = _build_export(
            project, case_ids, index, schema_info, include_crops, base, staging
        )
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    version, final = _publish(project, staging, base)
    result["version"] = version
    result["export_dir"] = str(final)
    result["relative_dir"] = f"exports/{version}"
    return result


def _build_export(
    project,
    case_ids: list[str],
    index: dict,
    schema_info: dict,
    include_crops: bool,
    version: str,
    export_dir: Path,
) -> dict:
    by_id = {c["case_id"]: c for c in index.get("cases", [])}
    selected = [by_id[c] for c in case_ids if c in by_id]
    if not selected:
        raise ValueError("No cases to export")

    (export_dir / "cases").mkdir(parents=True, exist_ok=True)
    exported_at = schema.now_iso()
    root = schema_info["schema"]

    manifest_rows: list[dict] = []
    manifest_cases: list[dict] = []
    wide_rows: list[dict] = []
    evidence_rows: list[dict] = []
    used_dirs: set[str] = set()
    warnings: list[dict] = []

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
        exported_image = ""
        source_sha = ""
        exported_sha = ""
        try:
            imaging.export_png(src, image_path)
            source_sha = sha256_file(src)
            exported_sha = sha256_file(image_path)
            exported_image = f"cases/{dir_name}/image.png"
        except (OSError, ValueError) as exc:
            # 原图缺失 / 无权限 / 非图片：保留标注数据，明确记一条 warning，
            # 不再让整个导出 500 并留下半成品目录。
            warnings.append(
                {
                    "case_id": case_id,
                    "kind": "image",
                    "field_path": "",
                    "message": f"Original image unavailable, exported label only: {exc}",
                }
            )

        ann = store.load_annotation(project, case_id) or store.make_annotation(
            project, case, schema_info
        )
        values = ann.get("values") if isinstance(ann.get("values"), dict) else {}
        notes = ann.get("notes") or {}
        evidence = store.normalize_evidence(ann.get("evidence"))

        jsonio.write_json(
            case_dir / "label.json",
            {
                "case_id": case_id,
                "source": case["source"],
                "schema_version": schema_info["version"],
                "values": values,
                "notes": notes,
                "evidence": evidence,
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

        case_evidence_rows: list[dict] = []
        if evidence:
            for field_path, box in sorted(evidence.items()):
                crop_file = ""
                if include_crops:
                    name = _crop_name(field_path)
                    used = {entry["crop_file"] for entry in case_evidence_rows}
                    candidate = f"crops/{name}.png"
                    suffix = 2
                    while candidate in used:
                        candidate = f"crops/{name}-{suffix}.png"
                        suffix += 1
                    try:
                        imaging.export_crop(
                            src, case_dir / candidate, box["bbox"], page=box.get("page", 0)
                        )
                        crop_file = candidate
                    except (OSError, ValueError) as exc:
                        crop_file = ""
                        try:
                            (case_dir / candidate).unlink(missing_ok=True)
                        except OSError:
                            pass
                        warnings.append(
                            {
                                "case_id": case_id,
                                "kind": "crop",
                                "field_path": field_path,
                                "message": str(exc),
                            }
                        )
                entry = {
                    "case_id": case_id,
                    "field_path": field_path,
                    "bbox": ",".join(f"{part:g}" for part in box["bbox"]),
                    "page": box.get("page", 0),
                    "text": box.get("text", ""),
                    "crop_file": crop_file,
                }
                case_evidence_rows.append(entry)
                evidence_rows.append(
                    {**entry, "crop_file": f"cases/{dir_name}/{crop_file}" if crop_file else ""}
                )
            _write_csv(
                case_dir / "evidence.csv",
                ["case_id", "field_path", "bbox", "page", "text", "crop_file"],
                case_evidence_rows,
            )

        row = {
            "case_id": case_id,
            "source": case["source"],
            "source_abs": str(src.resolve()),
            "exported_image": exported_image,
            "sha256": source_sha,
            "exported_sha256": exported_sha,
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
                "evidence_file": (
                    f"cases/{dir_name}/evidence.csv" if case_evidence_rows else None
                ),
                "crop_count": sum(1 for entry in case_evidence_rows if entry["crop_file"]),
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

    if evidence_rows:
        _write_csv(
            export_dir / "evidence.csv",
            ["case_id", "field_path", "bbox", "page", "text", "crop_file"],
            evidence_rows,
        )

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
        "evidence_count": len(evidence_rows),
        "crop_count": sum(1 for entry in evidence_rows if entry["crop_file"]),
        "warnings": warnings,
        "cases": manifest_cases,
    }
    jsonio.write_json(export_dir / "manifest.json", meta)

    return {
        "version": version,
        "export_dir": str(export_dir),
        "relative_dir": f"exports/{version}",
        "case_count": len(manifest_cases),
        "evidence_count": len(evidence_rows),
        "crop_count": meta["crop_count"],
        "warning_count": len(warnings),
        "warnings": warnings,
        "manifest": manifest_rows,
    }


def list_exports(project) -> list[dict]:
    root = project.root / "exports"
    if not root.exists():
        return []
    out = []
    for directory in sorted(root.iterdir(), reverse=True):
        # 崩溃残留的 staging 目录不是一次有效导出，不展示给用户。
        if not directory.is_dir() or directory.name.startswith(STAGING_PREFIX):
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
