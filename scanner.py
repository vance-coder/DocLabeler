"""图片目录扫描与 case 索引。"""

from __future__ import annotations

import re
from pathlib import Path

from PIL import Image

import jsonio
import schema
from paths import WINDOWS_RESERVED

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".bmp", ".webp"}
_SANITIZE = re.compile(r"[^A-Za-z0-9]+")


class CaseIdConflict(Exception):
    """两个不同路径生成了同一个 case_id。"""

    def __init__(self, conflicts: dict[str, list[str]]):
        self.conflicts = conflicts
        detail = "; ".join(f"{cid} <- {', '.join(srcs)}" for cid, srcs in conflicts.items())
        super().__init__(f"Case ID conflict. Please adjust folder or file names: {detail}")


def case_id_from_source(rel: str) -> str:
    stem = rel.rsplit(".", 1)[0]
    s = _SANITIZE.sub("_", stem).strip("_")
    s = re.sub(r"_{2,}", "_", s)
    if not s:
        s = "case"
    if s.split(".")[0].upper() in WINDOWS_RESERVED:
        s = "case_" + s
    return s[:100]


def collect(images_dir: Path) -> dict:
    root = Path(images_dir).resolve()
    if not root.is_dir():
        raise FileNotFoundError(f"Image directory not found: {root}")

    found: list[tuple[str, Path]] = []
    for path in sorted(root.rglob("*"), key=lambda p: p.as_posix().lower()):
        if not path.is_file():
            continue
        if path.suffix.lower() in IMAGE_EXTS:
            found.append((path.relative_to(root).as_posix(), path))

    by_id: dict[str, list[str]] = {}
    for rel, _ in found:
        by_id.setdefault(case_id_from_source(rel), []).append(rel)
    conflicts = {cid: srcs for cid, srcs in by_id.items() if len(srcs) > 1}
    if conflicts:
        raise CaseIdConflict(conflicts)

    cases: list[dict] = []
    unsupported: list[dict] = []
    for rel, path in found:
        try:
            stat = path.stat()
            with Image.open(path) as im:
                frames = int(getattr(im, "n_frames", 1) or 1)
                size = list(im.size)
        except Exception as exc:  # 解码器缺失或文件损坏
            unsupported.append({"source": rel, "error": f"{type(exc).__name__}: {exc}"})
            continue
        warning = None
        if frames > 1:
            warning = f"Multi-page file. Only page 1 of {frames} is shown"
        cases.append(
            {
                "case_id": case_id_from_source(rel),
                "source": rel,
                "num_frames": frames,
                "warning": warning,
                "size_bytes": stat.st_size,
                "mtime_ns": stat.st_mtime_ns,
                "pixel_size": size,
            }
        )

    cases.sort(key=lambda c: c["case_id"])
    return {
        "generated_at": schema.now_iso(),
        "root": str(root),
        "count": len(cases),
        "cases": cases,
        "unsupported": unsupported,
    }


def scan(project) -> dict:
    index = collect(project.images_dir())
    jsonio.write_json(project.root / "cases_index.json", index)
    return index


def load_index(project) -> dict:
    index = jsonio.read_json(project.root / "cases_index.json")
    if not isinstance(index, dict) or "cases" not in index:
        index = scan(project)
    return index


def index_map(index: dict) -> dict[str, dict]:
    return {c["case_id"]: c for c in index.get("cases", [])}
