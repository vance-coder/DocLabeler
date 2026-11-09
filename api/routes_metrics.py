"""跨字段校验即时求值、模型迭代回归指标与 CSV 导出。"""

from __future__ import annotations

from fastapi import APIRouter, Request, Response

import metrics
import validation
from . import deps

router = APIRouter()


@router.post("/api/projects/{project_id}/validate")
def api_validate(project_id: str, payload: dict, request: Request) -> dict:
    """对一组（尚未保存的）values 求规则错误，供表单做即时提示。"""
    info = deps.schema_info(deps.project(request, project_id))
    errors = validation.evaluate(info["schema"], payload.get("values") or {})
    return {"errors": errors, "count": len(errors), "has_rules": validation.has_rules(info["schema"])}


@router.get("/api/projects/{project_id}/metrics")
def api_metrics(project_id: str, request: Request) -> dict:
    proj = deps.project(request, project_id)
    return metrics.compute(proj, deps.schema_info(proj))


@router.get("/api/projects/{project_id}/metrics.csv")
def api_metrics_csv(project_id: str, request: Request):
    proj = deps.project(request, project_id)
    result = metrics.compute(proj, deps.schema_info(proj))
    return Response(
        content=metrics.csv_text(result),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="metrics.csv"'},
    )
