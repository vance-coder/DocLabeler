from __future__ import annotations

import csv
import io
import json

from fastapi.testclient import TestClient

import importer
import store
from app import create_app


def _client(workspace) -> TestClient:
    return TestClient(create_app(workspace["workspace"]))


def _save(proj, case, info, values: dict | None = None, notes: dict | None = None) -> dict:
    ann = store.make_annotation(proj, case, info)
    if values:
        ann["values"].update(values)
    if notes:
        ann["notes"] = notes
    return store.save_annotation(proj, case, ann, info)


# --------------------------------------------------------------------------
# 批量更新
# --------------------------------------------------------------------------

def test_bulk_status_and_tags(project, workspace):
    proj, index, info = project
    client = _client(workspace)
    pid = proj.id
    case_ids = [case["case_id"] for case in index["cases"]]

    resp = client.post(
        f"/api/projects/{pid}/annotations/bulk",
        json={"case_ids": case_ids[:2] + ["missing_case"], "action": "status", "status": "done"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["updated"] == 2
    assert body["skipped"] == [
        {"case_id": "missing_case", "reason": "Case not found in this project"}
    ]
    assert all(item["status"] == "done" for item in body["cases"])
    assert body["cases"][0]["rev"] == 1
    assert body["cases"][0]["updated_at"]

    added = client.post(
        f"/api/projects/{pid}/annotations/bulk",
        json={"case_ids": [case_ids[0]], "action": "add_tags", "tags": ["a", "b", "a"]},
    )
    assert added.status_code == 200, added.text
    assert added.json()["cases"][0]["tags"] == ["a", "b"]

    removed = client.post(
        f"/api/projects/{pid}/annotations/bulk",
        json={"case_ids": [case_ids[0]], "action": "remove_tags", "tags": ["a", "zzz"]},
    )
    assert removed.status_code == 200, removed.text
    assert removed.json()["cases"][0]["tags"] == ["b"]

    detail = client.get(f"/api/projects/{pid}/annotations/{case_ids[0]}").json()["annotation"]
    assert detail["status"] == "done"
    assert detail["tags"] == ["b"]
    second = client.get(f"/api/projects/{pid}/annotations/{case_ids[1]}").json()["annotation"]
    assert second["status"] == "done"

    invalid = client.post(
        f"/api/projects/{pid}/annotations/bulk",
        json={"case_ids": [case_ids[0]], "action": "status", "status": "archived"},
    )
    assert invalid.status_code == 400


# --------------------------------------------------------------------------
# Revert
# --------------------------------------------------------------------------

def _seed_baseline(proj, index, info, case_id: str) -> None:
    csv_text = (
        "case_id,field_path,value,note\n"
        f"{case_id},doc_no,A-001,from header\n"
        f"{case_id},total,3040,check total\n"
    )
    importer.run_import(
        proj,
        index,
        info,
        [{"filename": "base.csv", "data": csv_text.encode("utf-8")}],
        "csv",
    )


def test_revert_all_restores_baseline(project, workspace):
    proj, index, info = project
    case = index["cases"][0]
    case_id = case["case_id"]
    _seed_baseline(proj, index, info, case_id)

    ann = store.load_annotation(proj, case_id)
    ann["values"]["doc_no"] = "CHANGED"
    ann["values"]["total"] = 9999
    ann["values"]["items"] = [{"description": "X", "amount": "1"}]
    store.save_annotation(proj, case, ann, info)

    client = _client(workspace)
    resp = client.post(
        f"/api/projects/{proj.id}/annotations/{case_id}/revert", json={"all": True}
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert "doc_no" in body["reverted"]
    assert "total" in body["reverted"]

    saved = body["annotation"]
    assert saved["values"]["doc_no"] == "A-001"
    assert saved["values"]["total"] == 3040
    assert "description" not in saved["values"]["items"][0]
    assert "amount" not in saved["values"]["items"][0]
    assert saved["notes"]["doc_no"] == "from header"
    assert saved["notes"]["total"] == "check total"


def test_revert_paths_reports_missing(project, workspace):
    proj, index, info = project
    case = index["cases"][0]
    case_id = case["case_id"]
    _seed_baseline(proj, index, info, case_id)

    ann = store.load_annotation(proj, case_id)
    ann["values"]["doc_no"] = "CHANGED"
    ann["values"]["items"] = [{"description": "X", "amount": "1"}]
    store.save_annotation(proj, case, ann, info)

    client = _client(workspace)
    resp = client.post(
        f"/api/projects/{proj.id}/annotations/{case_id}/revert",
        json={"paths": ["doc_no", "items[0].description"]},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["reverted"] == ["doc_no"]
    assert body["missing"] == ["items[0].description"]
    assert body["annotation"]["values"]["doc_no"] == "A-001"
    assert "description" not in body["annotation"]["values"]["items"][0]

    # 旧接口 {path} 仍然可用
    ann = store.load_annotation(proj, case_id)
    ann["values"]["total"] = 777
    store.save_annotation(proj, case, ann, info)
    legacy = client.post(
        f"/api/projects/{proj.id}/annotations/{case_id}/revert", json={"path": "total"}
    )
    assert legacy.status_code == 200, legacy.text
    assert legacy.json()["annotation"]["values"]["total"] == 3040


# --------------------------------------------------------------------------
# 旧合集迁移为标签
# --------------------------------------------------------------------------

def test_collections_migrated_to_tags(project, workspace):
    proj, index, info = project
    ids = [case["case_id"] for case in index["cases"]]
    directory = proj.root / "collections"
    directory.mkdir(parents=True, exist_ok=True)
    source = directory / "batch1.json"
    source.write_text(
        json.dumps({"name": "批次 1", "case_ids": ids[:2]}, ensure_ascii=False),
        encoding="utf-8",
    )

    client = _client(workspace)
    cases = client.get(f"/api/projects/{proj.id}/cases").json()["cases"]
    by_id = {case["case_id"]: case for case in cases}
    assert by_id[ids[0]]["annotation"]["tags"] == ["批次 1"]
    assert by_id[ids[1]]["annotation"]["tags"] == ["批次 1"]
    assert by_id[ids[2]]["annotation"] is None

    # 原文件归档，重复请求不会重复加标签
    assert not source.exists()
    assert (directory / "batch1.json.migrated").exists()
    again = client.get(f"/api/projects/{proj.id}/cases").json()["cases"]
    assert {case["case_id"]: case for case in again}[ids[0]]["annotation"]["tags"] == ["批次 1"]
    assert store.load_annotation(proj, ids[0])["tags"] == ["批次 1"]


# --------------------------------------------------------------------------
# 备注聚合
# --------------------------------------------------------------------------

def test_notes_summary_conflict_and_csv(project, workspace):
    proj, index, info = project
    first, second, third = index["cases"]
    _save(proj, first, info, notes={"doc_no": "Same Note", "total": "a"})
    _save(proj, second, info, notes={"doc_no": " same  note ", "total": "b"})
    _save(proj, third, info, notes={"doc_no": "Same Note", "total": "a"})

    client = _client(workspace)
    body = client.get(f"/api/projects/{proj.id}/notes/summary").json()
    assert body["total_notes"] == 6
    assert [field["field_path"] for field in body["fields"]] == ["doc_no", "total"]

    by_path = {field["field_path"]: field for field in body["fields"]}
    doc = by_path["doc_no"]
    assert doc["label"] == "doc_no"
    assert doc["type"] == "string"
    assert doc["count"] == 3
    assert doc["case_count"] == 3
    assert doc["conflict"] is False
    assert doc["variants"] == [
        {"note": "Same Note", "count": 2},
        {"note": " same  note ", "count": 1},
    ]
    assert [entry["case_id"] for entry in doc["notes"]] == sorted(
        [first["case_id"], second["case_id"], third["case_id"]]
    )

    total = by_path["total"]
    assert total["conflict"] is True
    assert total["variants"] == [{"note": "a", "count": 2}, {"note": "b", "count": 1}]

    csv_resp = client.get(f"/api/projects/{proj.id}/notes/summary.csv")
    assert csv_resp.status_code == 200
    assert csv_resp.headers["content-type"].startswith("text/csv")
    assert csv_resp.content.startswith(b"\xef\xbb\xbf")
    text = csv_resp.content.decode("utf-8-sig")
    rows = list(csv.DictReader(io.StringIO(text)))
    assert [row for row in rows if row["field_path"] == "doc_no"][0]["case_ids"].count(";") == 1
    assert {row["field_path"] for row in rows} == {"doc_no", "total"}
    assert len([row for row in rows if row["field_path"] == "doc_no"]) == 2


# --------------------------------------------------------------------------
# Prompt 草稿
# --------------------------------------------------------------------------

def test_prompt_sections_and_dedupe(project, workspace):
    proj, index, info = project
    first, second, third = index["cases"]
    _save(proj, first, info, values={"doc_no": "A-1"}, notes={"doc_no": "note one"})
    _save(proj, second, info, values={"doc_no": "A-1"}, notes={"doc_no": "note one"})
    _save(proj, third, info, values={"doc_no": "B-2"}, notes={"doc_no": "note two"})

    client = _client(workspace)
    body = client.get(f"/api/projects/{proj.id}/prompt").json()
    sections = {section["field_path"]: section for section in body["sections"]}
    assert "doc_no" in sections
    assert "items[].description" in sections

    doc = sections["doc_no"]
    assert doc["label"] == "doc_no"
    assert doc["type"] == "string"
    assert doc["required"] is False
    assert doc["description"] == ""
    assert doc["examples"] == ["A-1", "B-2"]
    assert doc["notes"] == ["note one", "note two"]
    assert doc["conflict"] is True

    text = body["text"]
    assert text.startswith(f"# {proj.name}")
    assert "## doc_no" in text
    assert "Path: doc_no" in text
    assert "Conflicting notes:" in text
    assert text.count("note one") == 2


# --------------------------------------------------------------------------
# LLM 复核闭环：baseline 导入、全局搜索、置信度与修正回流
# --------------------------------------------------------------------------

def _upload_csv(client, pid, text, mode="overwrite"):
    return client.post(
        f"/api/projects/{pid}/imports",
        data={"kind": "csv", "mode": mode},
        files={"files": ("rows.csv", text.encode("utf-8"), "text/csv")},
    )


def test_import_baseline_mode_keeps_edits(project, workspace):
    proj, index, info = project
    case = index["cases"][0]
    case_id = case["case_id"]
    client = _client(workspace)

    first = _upload_csv(client, proj.id, f"case_id,field_path,value\n{case_id},doc_no,A-001\n")
    assert first.status_code == 200, first.text

    ann = store.load_annotation(proj, case_id)
    ann["values"]["doc_no"] = "HUMAN"
    store.save_annotation(proj, case, ann, info)

    second = _upload_csv(
        client,
        proj.id,
        f"case_id,field_path,value\n{case_id},doc_no,A-002\n",
        mode="baseline",
    )
    assert second.status_code == 200, second.text
    stats = second.json()["stats"]
    assert stats["kept_values"] == 1
    assert stats["applied_fields"] == 0

    saved = store.load_annotation(proj, case_id)
    assert saved["values"]["doc_no"] == "HUMAN"
    baseline = store.load_baseline(proj, saved["baseline_import_id"], case_id)
    assert baseline["values"]["doc_no"] == "A-002"

    cases = client.get(f"/api/projects/{proj.id}/cases").json()["cases"]
    entry = next(item for item in cases if item["case_id"] == case_id)
    assert entry["annotation"]["diff_count"] >= 1


def test_search_index_covers_values_and_notes(project, workspace):
    proj, index, info = project
    case = index["cases"][0]
    _save(proj, case, info, values={"doc_no": "ZX-778"}, notes={"total": "金额待确认"})
    client = _client(workspace)
    resp = client.get(f"/api/projects/{proj.id}/search-index")
    assert resp.status_code == 200, resp.text
    entries = resp.json()["cases"][case["case_id"]]
    texts = [entry["text"] for entry in entries]
    assert "ZX-778" in texts
    assert "金额待确认" in texts
    note = next(entry for entry in entries if entry["kind"] == "note")
    assert note["path"] == "total"
    assert note["label"] == "total"


def test_confidence_flags_and_corrections_csv(project, workspace):
    proj, index, info = project
    case = index["cases"][0]
    case_id = case["case_id"]
    client = _client(workspace)

    text = (
        "case_id,field_path,value,confidence\n"
        f"{case_id},doc_no,A-001,0.42\n"
        f"{case_id},total,3040,97\n"
    )
    resp = _upload_csv(client, proj.id, text)
    assert resp.status_code == 200, resp.text
    assert resp.json()["stats"]["confidence"] == 2

    saved = store.load_annotation(proj, case_id)
    assert saved["confidence"]["doc_no"] == 0.42
    assert saved["confidence"]["total"] == 0.97

    cases = client.get(f"/api/projects/{proj.id}/cases").json()["cases"]
    entry = next(item for item in cases if item["case_id"] == case_id)
    assert entry["annotation"]["low_confidence"] == 1
    assert abs(entry["annotation"]["confidence_min"] - 0.42) < 1e-6

    saved["values"]["doc_no"] = "A-001-fixed"
    store.save_annotation(proj, case, saved, info)

    csv_resp = client.get(f"/api/projects/{proj.id}/corrections.csv")
    assert csv_resp.status_code == 200
    rows = list(
        csv.DictReader(io.StringIO(csv_resp.text.lstrip("\ufeff")))
    )
    by_field = {row["field_path"]: row for row in rows}
    assert by_field["doc_no"]["kind"] == "modified"
    assert by_field["doc_no"]["baseline_value"] == "A-001"
    assert by_field["doc_no"]["current_value"] == "A-001-fixed"
    assert by_field["doc_no"]["count"] == "1"
