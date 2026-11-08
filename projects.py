"""项目与工作区管理。"""

from __future__ import annotations

import re
import secrets
from dataclasses import dataclass
from pathlib import Path

import jsonio
import schema
from paths import is_safe_id, resolve_images_dir

PROJECT_SUBDIRS = (
    "annotations",
    ".baseline",
    "collections",
    "exports",
    ".cache/preview",
    "schemas",
    "imports/reports",
)


class ProjectNotFound(Exception):
    pass


class ProjectError(ValueError):
    pass


@dataclass
class Project:
    workspace: Path
    root: Path
    meta: dict

    @property
    def id(self) -> str:
        return self.meta["project_id"]

    @property
    def name(self) -> str:
        return self.meta.get("name") or self.id

    def images_dir(self) -> Path:
        raw = (self.meta.get("images_dir") or "").strip()
        p = Path(raw).expanduser()
        if not p.is_absolute():
            p = self.workspace / p
        return p.resolve()

    def ensure_dirs(self) -> None:
        for sub in PROJECT_SUBDIRS:
            (self.root / sub).mkdir(parents=True, exist_ok=True)


def _slug(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return (s[:32].strip("-") or "project")


def projects_root(workspace: Path) -> Path:
    return Path(workspace) / "projects"


def create_project(
    workspace: Path,
    name: str,
    images_dir: str,
    description: str = "",
    schema_root: dict | None = None,
) -> Project:
    workspace = Path(workspace).resolve()
    name = (name or "").strip()
    if not name:
        raise ProjectError("Project name cannot be empty")
    resolved = resolve_images_dir(workspace, images_dir)

    root = projects_root(workspace)
    root.mkdir(parents=True, exist_ok=True)
    project_id = f"{_slug(name)}-{secrets.token_hex(2)}"
    while (root / project_id).exists():
        project_id = f"{_slug(name)}-{secrets.token_hex(2)}"

    project_dir = root / project_id
    project_dir.mkdir(parents=True)
    for sub in PROJECT_SUBDIRS:
        (project_dir / sub).mkdir(parents=True, exist_ok=True)

    meta = {
        "project_id": project_id,
        "name": name,
        "images_dir": images_dir.strip(),
        "description": (description or "").strip(),
        "images_dir_absolute": str(resolved),
        "created_at": schema.now_iso(),
    }
    jsonio.write_json(project_dir / "project.json", meta)
    schema.init_schema(project_dir, schema_root)
    return load_project(workspace, project_id)


def load_project(workspace: Path, project_id: str) -> Project:
    if not is_safe_id(project_id):
        raise ProjectNotFound(f"Invalid project ID: {project_id}")
    root = projects_root(workspace) / project_id
    meta = jsonio.read_json(root / "project.json")
    if not isinstance(meta, dict):
        raise ProjectNotFound(f"Project not found: {project_id}")
    project = Project(workspace=Path(workspace).resolve(), root=root, meta=meta)
    project.ensure_dirs()
    return project


def list_projects(workspace: Path) -> list[dict]:
    base = projects_root(workspace)
    if not base.exists():
        return []
    out: list[dict] = []
    for directory in sorted(base.iterdir()):
        if not directory.is_dir():
            continue
        meta = jsonio.read_json(directory / "project.json")
        if not isinstance(meta, dict):
            continue
        try:
            info = schema.load_schema(directory)
            schema_version = info["version"]
            field_count = len(list(schema.iter_fields(info["schema"])))
        except Exception:
            schema_version, field_count = None, 0
        index = jsonio.read_json(directory / "cases_index.json", {}) or {}
        out.append(
            {
                "project_id": meta.get("project_id", directory.name),
                "name": meta.get("name", directory.name),
                "images_dir": meta.get("images_dir", ""),
                "description": meta.get("description", ""),
                "created_at": meta.get("created_at", ""),
                "schema_version": schema_version,
                "field_count": field_count,
                "case_count": int(index.get("count") or 0),
            }
        )
    return out
