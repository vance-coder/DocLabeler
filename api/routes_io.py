"""已有标注导入（JSON / CSV / Excel）与结果导出。"""

from __future__ import annotations

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse

import exporter
import importer
import jsonio
import locks
from paths import is_safe_id
from . import deps

router = APIRouter()


@router.get("/api/projects/{project_id}/imports")
def api_list_imports(project_id: str, request: Request) -> dict:
    proj = deps.project(request, project_id)
    data = jsonio.read_json(proj.root / "imports" / "index.json", {"imports": []})
    return data if isinstance(data, dict) else {"imports": []}


@router.get("/api/projects/{project_id}/imports/{import_id}")
def api_import_report(project_id: str, import_id: str, request: Request) -> dict:
    proj = deps.project(request, project_id)
    if not is_safe_id(import_id):
        raise HTTPException(status_code=400, detail="Invalid import ID")
    report = jsonio.read_json(proj.root / "imports" / "reports" / f"{import_id}.json")
    if not isinstance(report, dict):
        raise HTTPException(status_code=404, detail="Import report not found")
    return report


@router.post("/api/projects/{project_id}/imports")
async def api_import(
    project_id: str,
    request: Request,
    kind: str = Form("csv"),
    mode: str = Form("overwrite"),
    files: list[UploadFile] = File(...),
) -> dict:
    proj = deps.project(request, project_id)
    # 上传内容读取是异步 IO，放在锁外；写入阶段整体串行，避免导入与 schema
    # 保存 / 其它导入交错，导致标注与 baseline 记录的是不同 schema 版本。
    uploads = []
    for upload in files:
        data = await upload.read()
        uploads.append({"filename": upload.filename or "upload", "data": data})
    with locks.project_lock(proj):
        idx = deps.index(proj)
        info = deps.schema_info(proj)
        try:
            return importer.run_import(proj, idx, info, uploads, kind, mode)
        except importer.ImportFailed as exc:
            raise HTTPException(status_code=400, detail=str(exc))


@router.get("/api/projects/{project_id}/exports")
def api_list_exports(project_id: str, request: Request) -> dict:
    return {"exports": exporter.list_exports(deps.project(request, project_id))}


@router.post("/api/projects/{project_id}/exports")
def api_export(project_id: str, payload: dict, request: Request) -> dict:
    proj = deps.project(request, project_id)
    idx = deps.index(proj)
    info = deps.schema_info(proj)
    case_ids = payload.get("case_ids")
    # 与批量确认保持同一语义：显式传空数组 = 当前过滤结果为空，
    # 绝不退化成「导出整个项目」；只有不传该字段才是全项目导出。
    if case_ids is None:
        case_ids = [c["case_id"] for c in idx.get("cases", [])]
    try:
        return exporter.export_cases(
            proj,
            list(case_ids),
            idx,
            info,
            str(payload.get("label") or ""),
            include_crops=payload.get("include_crops", True) is not False,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except OSError as exc:
        # 磁盘 / 权限问题给出明确 400 与原因，而不是 500；临时目录已由导出层清理。
        raise HTTPException(status_code=400, detail=f"Export failed: {exc}")


@router.get("/api/projects/{project_id}/exports/{version}/manifest.csv")
def api_download_manifest(project_id: str, version: str, request: Request):
    proj = deps.project(request, project_id)
    if not is_safe_id(version):
        raise HTTPException(status_code=400, detail="Invalid export version")
    path = proj.root / "exports" / version / "manifest.csv"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Manifest not found")
    return FileResponse(path, media_type="text/csv", filename=f"{version}-manifest.csv")
