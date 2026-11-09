"""项目、case 列表与图片预览路由。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

import diffing
import imaging
import projects
import scanner
import schema
import store
import validation
from paths import resolve_images_dir
from . import deps

router = APIRouter()


@router.get("/api/health")
def health(request: Request) -> dict:
    return {"ok": True, "workspace": str(deps.workspace(request))}


@router.post("/api/fs/pick-folder")
def pick_folder(payload: dict, request: Request) -> dict:
    """在服务所在机器上弹出系统文件夹选择框。

    浏览器出于安全限制不会把本地绝对路径交给网页，因此「选择文件夹」只能由
    本地后端打开系统对话框。取消时返回空字符串。

    对话框放在独立子进程里运行，避免 Tk 的事件循环和 uvicorn 的线程池纠缠。
    """
    import os
    import subprocess
    import sys

    initial = str(payload.get("initial") or "").strip() or str(deps.workspace(request))
    code = (
        "import os, tkinter as tk\n"
        "from tkinter import filedialog\n"
        "root = tk.Tk()\n"
        "root.withdraw()\n"
        "root.attributes('-topmost', True)\n"
        "print(filedialog.askdirectory(parent=root, "
        "initialdir=os.environ.get('DOCLABELER_INITIAL') or None, "
        "title='Select images folder', mustexist=True) or '')\n"
        "root.destroy()\n"
    )
    env = dict(os.environ, DOCLABELER_INITIAL=initial)
    try:
        result = subprocess.run(
            [sys.executable, "-c", code],
            capture_output=True,
            text=True,
            timeout=600,
            env=env,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise HTTPException(status_code=500, detail=f"Folder picker failed: {exc}") from exc
    if result.returncode != 0:
        raise HTTPException(
            status_code=500,
            detail=f"Folder picker failed: {result.stderr.strip() or result.returncode}",
        )
    return {"path": result.stdout.strip()}


@router.get("/api/projects")
def api_list_projects(request: Request) -> dict:
    ws = deps.workspace(request)
    return {"projects": projects.list_projects(ws), "workspace": str(ws)}


@router.post("/api/projects")
def api_create_project(payload: dict, request: Request) -> dict:
    name = str(payload.get("name") or "").strip()
    images_dir = str(payload.get("images_dir") or "").strip()
    description = str(payload.get("description") or "")
    mode = str(payload.get("schema_mode") or "empty")

    if not name:
        raise HTTPException(status_code=400, detail="Project name cannot be empty")
    try:
        resolved = resolve_images_dir(deps.workspace(request), images_dir)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    try:
        prepared = scanner.collect(resolved)
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
        proj = projects.create_project(
            deps.workspace(request), name, images_dir, description, schema_root
        )
    except projects.ProjectError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    try:
        idx = scanner.scan(proj, prepared)
    except scanner.CaseIdConflict as exc:
        raise HTTPException(
            status_code=409, detail={"message": str(exc), "conflicts": exc.conflicts}
        )
    return {
        "project": deps.project_payload(proj),
        "index": deps.index_summary(idx),
        "schema": schema.load_schema(proj.root),
    }


@router.get("/api/projects/{project_id}")
def api_get_project(project_id: str, request: Request) -> dict:
    proj = deps.project(request, project_id)
    return {
        "project": deps.project_payload(proj),
        "schema": deps.schema_info(proj),
        "index": deps.index_summary(deps.index(proj)),
    }


@router.post("/api/projects/{project_id}/rescan")
def api_rescan(project_id: str, request: Request) -> dict:
    proj = deps.project(request, project_id)
    try:
        idx = scanner.scan(proj)
    except scanner.CaseIdConflict as exc:
        raise HTTPException(
            status_code=409, detail={"message": str(exc), "conflicts": exc.conflicts}
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"index": deps.index_summary(idx)}


@router.get("/api/projects/{project_id}/cases")
def api_cases(project_id: str, request: Request, refresh: int = 0) -> dict:
    proj = deps.project(request, project_id)
    idx = scanner.scan(proj) if refresh else deps.index(proj)
    info = deps.schema_info(proj)
    deps.migrate_collections(proj, idx, info)
    annotations = store.list_annotations(proj)
    # 一次请求内只编译一次规则、只按 import 版本读一次 baseline 元数据。
    rules = validation.compile_rules(info["schema"])
    baseline_cache = diffing.BaselineCache(proj, info)

    rows = []
    for item in idx.get("cases", []):
        entry: dict[str, Any] = {
            "case_id": item["case_id"],
            "source": item["source"],
            "num_frames": item.get("num_frames", 1),
            "warning": item.get("warning"),
            "folder": str(Path(item["source"]).parent.as_posix()),
            "annotation": None,
        }
        ann = annotations.get(item["case_id"])
        if ann:
            diff = diffing.diff_for_case(proj, ann, info, baseline_cache)
            confidence = ann.get("confidence")
            scores = (
                [float(value) for value in confidence.values()]
                if isinstance(confidence, dict)
                else []
            )
            entry["annotation"] = {
                "status": ann.get("status") or "draft",
                "tags": ann.get("tags") or [],
                "updated_at": ann.get("updated_at"),
                "notes_count": len(
                    [v for v in (ann.get("notes") or {}).values() if str(v).strip()]
                ),
                "has_baseline": diff["has_baseline"],
                "diff_count": len(diff["fields"]),
                "confidence_min": min(scores) if scores else None,
                "low_confidence": len(
                    [score for score in scores if score < deps.LOW_CONFIDENCE]
                ),
                "validation_errors": len(
                    validation.evaluate_compiled(rules, ann.get("values") or {})
                ),
                "evidence_count": len(
                    store.normalize_evidence(ann.get("evidence"))
                ),
            }
        rows.append(entry)
    return {
        "cases": rows,
        "index": deps.index_summary(idx),
        "schema_version": info["version"],
    }


@router.get("/api/projects/{project_id}/preview/{case_id}")
def api_preview(project_id: str, case_id: str, request: Request, w: int = 1800):
    proj = deps.project(request, project_id)
    idx = deps.index(proj)
    item = deps.case(idx, case_id)
    width = max(400, min(int(w), 4000))
    try:
        path = imaging.ensure_preview(proj, item, width)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Preview failed: {exc}")
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "no-cache"})
