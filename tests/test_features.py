from __future__ import annotations

import csv
import io
from urllib.parse import quote

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
# Collections
# --------------------------------------------------------------------------

def test_collections_crud(project, workspace):
    proj, index, info = project
    client = _client(workspace)
    pid = proj.id
    ids = [case["case_id"] for case in index["cases"]]
    encoded = quote("批次 1", safe="")
    url = f"/api/projects/{pid}/collections/{encoded}"

    assert client.get(f"/api/projects/{pid}/collections").json() == {"collections": []}

    created = client.put(url, json={"case_ids": ids[:2]})
    assert created.status_code == 200, created.text
    body = created.json()
    assert body["name"] == "批次 1"
    assert body["case_ids"] == ids[:2]
    assert body["updated_at"]

    listed = client.get(f"/api/projects/{pid}/collections").json()["collections"]
    assert listed == [
        {"name": "批次 1", "count": 2, "updated_at": body["updated_at"]}
    ]

    fetched = client.get(url).json()
    assert fetched["name"] == "批次 1"
    assert fetched["case_ids"] == ids[:2]

    updated = client.put(url, json={"case_ids": [ids[0]]})
    assert updated.status_code == 200, updated.text
    assert updated.json()["case_ids"] == [ids[0]]

    bad = client.put(url, json={"case_ids": [ids[0], "nope"]})
    assert bad.status_code == 400
    assert bad.json()["detail"]["unknown"] == ["nope"]

    rejected = client.put(
        f"/api/projects/{pid}/collections/{quote('bad..name', safe='')}",
        json={"case_ids": []},
    )
    assert rejected.status_code == 400
    assert client.put(f"/api/projects/{pid}/collections/%20", json={"case_ids": []}).status_code == 400

    assert client.delete(url).json() == {"deleted": True}
    assert client.get(url).status_code == 404
    assert client.delete(url).status_code == 404


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
