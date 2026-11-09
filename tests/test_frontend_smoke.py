"""前端模块自检：用系统 Node 真实加载全部 ES modules（无浏览器）。

覆盖本轮新增的 refreshProject 失败兜底与校验徽标局部刷新；没有 node 时跳过。
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest


def test_frontend_modules_and_new_actions():
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not available")
    script = Path(__file__).with_name("frontend_smoke.mjs")
    proc = subprocess.run(
        [node, str(script)],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode == 0, f"{proc.stdout}\n{proc.stderr}"
    assert "frontend smoke OK" in proc.stdout, proc.stdout
