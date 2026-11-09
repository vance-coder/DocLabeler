"""Schema 读取、保存（含历史标注迁移）与推断 / 导入。"""

from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException, Request

import locks
import schema
import store
import validation
from . import deps

router = APIRouter()


@router.get("/api/projects/{project_id}/schema")
def api_get_schema(project_id: str, request: Request) -> dict:
    return deps.schema_info(deps.project(request, project_id))


@router.put("/api/projects/{project_id}/schema")
def api_put_schema(project_id: str, payload: dict, request: Request) -> dict:
    proj = deps.project(request, project_id)
    node = payload.get("schema")
    if not isinstance(node, dict):
        raise HTTPException(status_code=400, detail="Missing schema")
    # schema 指针切换与历史标注迁移必须是同一临界区：否则中间插入的单条保存
    # 会用旧 schema 写回，或者被迁移结果覆盖。项目锁由 schema.save_schema 重入。
    with locks.project_lock(proj):
        try:
            validation.validate_rules(schema.normalize_schema(node))
            result = schema.save_schema(
                proj.root, node, expected_version=payload.get("expected_version")
            )
        except schema.SchemaVersionConflict as exc:
            raise HTTPException(status_code=409, detail=str(exc))
        except schema.SchemaError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        migration = store.migrate_annotations(
            proj, result["previous"], result["schema"], result["version"]
        )
    return {
        "version": result["version"],
        "schema": result["schema"],
        "migration": migration,
    }


@router.post("/api/projects/{project_id}/schema/infer")
def api_infer_schema(project_id: str, payload: dict, request: Request) -> dict:
    deps.project(request, project_id)
    raw = payload.get("example_json")
    try:
        example = json.loads(raw) if isinstance(raw, str) else raw
        return {"schema": schema.infer_from_example(example)}
    except (json.JSONDecodeError, schema.SchemaError) as exc:
        raise HTTPException(status_code=400, detail=f"Failed to parse example: {exc}")


@router.post("/api/projects/{project_id}/schema/import")
def api_import_schema(project_id: str, payload: dict, request: Request) -> dict:
    deps.project(request, project_id)
    raw = payload.get("json_schema")
    try:
        js = json.loads(raw) if isinstance(raw, str) else raw
        return {"schema": schema.from_json_schema(js)}
    except (json.JSONDecodeError, schema.SchemaError) as exc:
        raise HTTPException(status_code=400, detail=f"Failed to parse JSON Schema: {exc}")
