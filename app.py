"""DocLabeler 服务入口：只负责装配应用与启动。

HTTP 路由按领域拆分在 :mod:`api` 包中，共享依赖见 ``api/deps.py``。
"""

from __future__ import annotations

import argparse
import webbrowser
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from api import include_routers

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"


def create_app(workspace: Path) -> FastAPI:
    workspace = Path(workspace).resolve()
    workspace.mkdir(parents=True, exist_ok=True)
    (workspace / "projects").mkdir(parents=True, exist_ok=True)

    app = FastAPI(title="DocLabeler")
    app.state.workspace = workspace
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
    include_routers(app)

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
