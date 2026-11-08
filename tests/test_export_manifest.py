from __future__ import annotations

import csv
import hashlib
import json
from pathlib import Path

import exporter
import store


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def test_export_manifest_complete(project):
    proj, index, info = project
    case_ids = [case["case_id"] for case in index["cases"]]

    first = index["cases"][0]
    ann = store.make_annotation(proj, first, info)
    ann["values"]["doc_no"] = "A-001"
    ann["values"]["items"] = [{"description": "CT Brain", "amount": "3040"}]
    ann["notes"] = {"doc_no": "编号来自页眉"}
    store.save_annotation(proj, first, ann, info)

    result = exporter.export_cases(proj, case_ids, index, info, label="unit")
    out = Path(result["export_dir"])
    assert result["case_count"] == len(case_ids)

    with open(out / "manifest.csv", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    assert len(rows) == len(case_ids)

    sources = {case["source"] for case in index["cases"]}
    for row in rows:
        assert row["source"] in sources
        assert row["schema_version"] == str(info["version"])
        assert row["exported_at"]
        assert row["case_id"]

        source_abs = Path(row["source_abs"])
        assert source_abs.exists()
        assert sha256_file(source_abs) == row["sha256"]

        image_path = out / row["exported_image"]
        assert image_path.exists()
        assert image_path.suffix == ".png"
        assert sha256_file(image_path) == row["exported_sha256"]

        case_dir = image_path.parent
        assert (case_dir / "label.json").exists()
        assert (case_dir / "notes.csv").exists()

    assert (out / "schema.json").exists()
    assert (out / "fields.csv").exists()
    assert (out / "summary.csv").exists()

    with open(out / "summary.csv", encoding="utf-8-sig", newline="") as handle:
        summary = list(csv.DictReader(handle))
    assert len(summary) == len(case_ids)
    assert "doc_no" in summary[0]
    assert "notes" in summary[0]


def test_export_manifest_json_traceable(project):
    proj, index, info = project
    result = exporter.export_cases(proj, [index["cases"][0]["case_id"]], index, info)
    out = Path(result["export_dir"])
    meta = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    assert meta["case_count"] == 1
    assert Path(meta["cases"][0]["source_abs"]).exists()
    assert meta["cases"][0]["source"] == index["cases"][0]["source"]
