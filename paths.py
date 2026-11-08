"""路径与文件名安全工具。"""

from __future__ import annotations

import re
from pathlib import Path

WINDOWS_RESERVED = {"CON", "PRN", "AUX", "NUL"} | {
    f"COM{i}" for i in range(1, 10)
} | {f"LPT{i}" for i in range(1, 10)}

_INVALID_FILENAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


class PathSecurityError(ValueError):
    """路径越界或非法。"""


def resolve_inside(base: Path, target: str | Path) -> Path:
    """把 target 解析到 base 之内，越界直接报错。"""
    base = Path(base).resolve()
    p = Path(target).expanduser()
    if not p.is_absolute():
        p = base / p
    p = p.resolve()
    if p != base and base not in p.parents:
        raise PathSecurityError(f"Path is outside the allowed directory: {target}")
    return p


def resolve_images_dir(workspace: Path, images_dir: str) -> Path:
    """images_dir 允许绝对路径或相对 workspace 的路径，必须存在且是目录。"""
    raw = (images_dir or "").strip()
    if not raw:
        raise ValueError("Image directory cannot be empty")
    p = Path(raw).expanduser()
    if not p.is_absolute():
        p = Path(workspace) / p
    p = p.resolve()
    if not p.exists():
        raise ValueError(f"Image directory not found: {p}")
    if not p.is_dir():
        raise ValueError(f"Image directory is not a folder: {p}")
    return p


def safe_filename(name: str, fallback: str = "item", max_len: int = 80) -> str:
    """把任意字符串转成可用作文件名/目录名的片段。"""
    s = _INVALID_FILENAME.sub("_", str(name or "")).strip().strip(".")
    s = re.sub(r"\s+", "_", s)
    s = s[:max_len]
    if not s:
        s = fallback
    if s.split(".")[0].upper() in WINDOWS_RESERVED:
        s = f"_{s}"
    return s


def is_safe_id(value: str) -> bool:
    """项目 id / import id / 版本号等只允许安全字符。"""
    return bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", value or "")) and ".." not in value
