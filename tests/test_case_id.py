from __future__ import annotations

import pytest
from PIL import Image

import scanner


def test_case_id_from_source_basic():
    assert scanner.case_id_from_source("2024/10/14/A-001.png") == "2024_10_14_A_001"
    assert scanner.case_id_from_source("batch 1/扫描件 001.JPG") == "batch_1_001"
    assert scanner.case_id_from_source("a--b__c.tiff") == "a_b_c"
    assert scanner.case_id_from_source("根目录.png") == "case"


def test_case_id_conflict_raises(tmp_path):
    root = tmp_path / "images"
    (root / "a").mkdir(parents=True)
    Image.new("RGB", (20, 20)).save(root / "a" / "b.png")
    Image.new("RGB", (20, 20)).save(root / "a_b.png")

    with pytest.raises(scanner.CaseIdConflict) as exc:
        scanner.collect(root)
    assert "a_b" in exc.value.conflicts
    assert len(exc.value.conflicts["a_b"]) == 2


def test_case_id_windows_reserved(tmp_path):
    root = tmp_path / "images"
    root.mkdir()
    Image.new("RGB", (20, 20)).save(root / "CON.png")
    index = scanner.collect(root)
    assert index["cases"][0]["case_id"] == "case_CON"
