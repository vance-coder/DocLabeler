from __future__ import annotations

import sys
from pathlib import Path

import pytest
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import projects  # noqa: E402
import scanner  # noqa: E402
import schema  # noqa: E402

EXAMPLE = {
    "doc_no": "A-001",
    "total": 3040,
    "items": [{"description": "CT Brain", "amount": "3040"}],
}


@pytest.fixture
def workspace(tmp_path):
    ws = tmp_path / "workspace"
    ws.mkdir()
    images = tmp_path / "images"
    (images / "batch1").mkdir(parents=True)
    (images / "batch2").mkdir(parents=True)
    for rel in ["batch1/A-001.png", "batch1/A-002.png", "batch2/B-001.png"]:
        Image.new("RGB", (80, 60), (235, 235, 235)).save(images / rel)
    return {"workspace": ws, "images": images}


@pytest.fixture
def project(workspace):
    proj = projects.create_project(
        workspace["workspace"],
        "测试项目",
        str(workspace["images"]),
        "for tests",
        schema.infer_from_example(EXAMPLE),
    )
    index = scanner.scan(proj)
    info = schema.load_schema(proj.root)
    return proj, index, info
