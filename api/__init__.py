"""HTTP 路由包：按领域拆分的 APIRouter 集合。"""

from __future__ import annotations

from fastapi import FastAPI

from . import (
    notes,
    routes_annotations,
    routes_io,
    routes_metrics,
    routes_projects,
    routes_review,
    routes_schema,
)

ROUTERS = (
    routes_projects.router,
    routes_schema.router,
    routes_annotations.router,
    routes_review.router,
    routes_metrics.router,
    notes.router,
    routes_io.router,
)


def include_routers(app: FastAPI) -> None:
    """按固定顺序挂载全部路由（与拆分前的注册顺序一致）。"""
    for router in ROUTERS:
        app.include_router(router)
