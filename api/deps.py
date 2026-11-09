"""路由层共享依赖：工作区解析、项目加载、schema / 索引 / case 校验与旧数据迁移。

所有路由模块只依赖本文件，避免入口文件再充当"公共函数堆放处"。
"""

from __future__ import annotations

from pathlib import Path

from fastapi import HTTPException, Request

import jsonio
import locks
import projects
import scanner
import schema
import store

LOW_CONFIDENCE = 0.8


def workspace(request: Request) -> Path:
    return request.app.state.workspace


def project(request: Request, project_id: str) -> projects.Project:
    try:
        return projects.load_project(workspace(request), project_id)
    except projects.ProjectNotFound:
        raise HTTPException(status_code=404, detail="Project not found")


def schema_info(proj) -> dict:
    try:
        return schema.load_schema(proj.root)
    except schema.SchemaError as exc:
        raise HTTPException(status_code=500, detail=str(exc))


def index(proj) -> dict:
    try:
        return scanner.load_index(proj)
    except scanner.CaseIdConflict as exc:
        raise HTTPException(
            status_code=409, detail={"message": str(exc), "conflicts": exc.conflicts}
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


def case(index_data: dict, case_id: str) -> dict:
    found = scanner.index_map(index_data).get(case_id)
    if found is None:
        raise HTTPException(status_code=404, detail=f"Case {case_id} not found")
    return found


def project_payload(proj) -> dict:
    meta = dict(proj.meta)
    images_dir = proj.images_dir()
    meta["images_dir_absolute"] = str(images_dir)
    meta["images_dir_exists"] = images_dir.is_dir()
    return meta


def index_summary(index_data: dict) -> dict:
    return {
        "generated_at": index_data.get("generated_at"),
        "count": index_data.get("count", 0),
        "root": index_data.get("root"),
        "unsupported": index_data.get("unsupported", []),
    }


def migrate_collections(proj, index_data: dict, info: dict) -> int:
    """把旧的 collections/*.json 转成同名标签，并把原文件归档为 *.migrated。

    /cases 每次请求都会走到这里，因此项目锁内做二次 marker 检查；标注写入统一
    走 ``store.save_annotation``（带 rev 乐观锁），不再直写文件绕过保存路径。
    """
    directory = proj.root / "collections"
    if not directory.is_dir():
        return 0
    marker = directory / ".tags-migrated"
    if marker.exists():
        return 0

    with locks.project_lock(proj):
        if marker.exists():
            return 0
        files = sorted(path for path in directory.glob("*.json") if path.is_file())
        if not files:
            return 0

        cases = {item["case_id"]: item for item in index_data.get("cases", [])}
        migrated = 0
        all_archived = True
        for path in files:
            try:
                data = jsonio.read_json(path)
            except (OSError, ValueError):
                all_archived = False
                continue
            if not isinstance(data, dict):
                all_archived = False
                continue
            name = str(data.get("name") or path.stem).strip()
            failed = False
            if name:
                for raw in data.get("case_ids") or []:
                    item = cases.get(str(raw))
                    if item is None:
                        continue
                    ann = store.load_annotation(proj, item["case_id"]) or store.make_annotation(
                        proj, item, info
                    )
                    tags = [str(tag) for tag in (ann.get("tags") or [])]
                    if name in tags:
                        continue
                    tags.append(name)
                    try:
                        store.save_annotation(
                            proj,
                            item,
                            {
                                "values": ann.get("values") or {},
                                "notes": ann.get("notes") or {},
                                "confidence": ann.get("confidence") or {},
                                "evidence": ann.get("evidence") or {},
                                "status": ann.get("status") or "draft",
                                "tags": tags,
                                "baseline_import_id": ann.get("baseline_import_id"),
                            },
                            info,
                            expected_rev=int(ann.get("rev") or 0),
                        )
                    except (store.RevConflict, store.AnnotationError):
                        # 只要有一个 case 没写成功，就保留原文件，下次重试；
                        # 否则改名 + 写 marker 会让这条 collection 永久丢失。
                        failed = True
                        break
                    migrated += 1
            if failed:
                all_archived = False
                continue
            try:
                path.rename(path.with_name(path.name + ".migrated"))
            except OSError:
                all_archived = False
        # 仅当所有文件都成功迁移并归档后才写 marker；读坏 / 归档失败的文件
        # 下一轮还会重试，不会因为 marker 存在而被跳过。
        if all_archived:
            jsonio.write_text(marker, schema.now_iso() + "\n")
    return migrated
