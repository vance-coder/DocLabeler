"""DocLabeler 服务入口。"""

from __future__ import annotations

import argparse
import json
import webbrowser
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
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
from paths import is_safe_id, resolve_images_dir

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"


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

        path = str(payload.get("path") or "")
        try:
            segs = schema.parse_path(path)
        except schema.SchemaError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

        values = ann.get("values") or {}
        old = schema.get_value(baseline, segs)
        if old is None:
            diffing.delete_value(values, segs)
        else:
            schema.set_value(values, segs, old)

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
        return {"annotation": saved}

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
