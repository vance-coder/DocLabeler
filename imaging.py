"""图片预览：EXIF 校正、PNG 转换与磁盘缓存。"""

from __future__ import annotations

import hashlib
import os
import tempfile
from pathlib import Path

from PIL import Image, ImageOps

DEFAULT_MAX_SIDE = 1800


def source_image(project, case: dict) -> Path:
    return project.images_dir() / case["source"]


def preview_key(case: dict, stat, max_side: int) -> str:
    raw = f"{case['source']}|{stat.st_mtime_ns}|{stat.st_size}|{max_side}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:20]


def ensure_preview(project, case: dict, max_side: int = DEFAULT_MAX_SIDE) -> Path:
    src = source_image(project, case)
    stat = src.stat()
    out = project.root / ".cache" / "preview" / f"{preview_key(case, stat, max_side)}.png"
    if out.exists() and out.stat().st_size > 0:
        return out

    out.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(src) as im:
        if getattr(im, "n_frames", 1) > 1:
            im.seek(0)
        frame = ImageOps.exif_transpose(im)
        frame.thumbnail((max_side, max_side), Image.LANCZOS)
        if frame.mode not in ("RGB", "RGBA"):
            frame = frame.convert("RGBA" if "A" in frame.mode else "RGB")

        fd, tmp = tempfile.mkstemp(dir=str(out.parent), prefix="preview-", suffix=".png")
        os.close(fd)
        try:
            frame.save(tmp, "PNG")
            os.replace(tmp, out)
        except BaseException:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise
    return out


def export_crop(
    src: Path,
    dest: Path,
    bbox: list[float],
    page: int = 0,
    padding: float = 0.02,
) -> None:
    """按归一化 bbox 裁剪字段区域，供版面 / 字段识别模型训练使用。

    bbox 为 ``[x, y, w, h]``，取值 0-1，相对 EXIF 校正后的整幅图；
    ``padding`` 按图片短边向外扩一点，避免文字贴边被切掉。
    """
    if len(bbox) != 4:
        raise ValueError("bbox must contain four numbers")
    x, y, w, h = (float(part) for part in bbox)
    if w <= 0 or h <= 0:
        raise ValueError("bbox width and height must be positive")
    dest.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(src) as im:
        frame_index = max(0, int(page or 0))
        if frame_index:
            try:
                im.seek(frame_index)
            except EOFError:
                im.seek(0)
        elif getattr(im, "n_frames", 1) > 1:
            im.seek(0)
        frame = ImageOps.exif_transpose(im)
        if frame.mode not in ("RGB", "RGBA"):
            frame = frame.convert("RGBA" if "A" in frame.mode else "RGB")
        width, height = frame.size
        pad_x = padding * width
        pad_y = padding * height
        left = max(0, int(x * width - pad_x))
        top = max(0, int(y * height - pad_y))
        right = min(width, int((x + w) * width + pad_x))
        bottom = min(height, int((y + h) * height + pad_y))
        if right <= left or bottom <= top:
            raise ValueError("bbox falls outside the image")
        frame.crop((left, top, right, bottom)).save(dest, "PNG")


def export_png(src: Path, dest: Path) -> None:
    """导出用：保持原始分辨率，做 EXIF 校正后存 PNG。"""
    dest.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(src) as im:
        if getattr(im, "n_frames", 1) > 1:
            im.seek(0)
        frame = ImageOps.exif_transpose(im)
        if frame.mode not in ("RGB", "RGBA"):
            frame = frame.convert("RGBA" if "A" in frame.mode else "RGB")
        fd, tmp = tempfile.mkstemp(dir=str(dest.parent), prefix="export-", suffix=".png")
        os.close(fd)
        try:
            frame.save(tmp, "PNG")
            os.replace(tmp, dest)
        except BaseException:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise
