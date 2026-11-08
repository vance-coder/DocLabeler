from __future__ import annotations

from fastapi.testclient import TestClient

from app import create_app


def test_api_flow(workspace):
    client = TestClient(create_app(workspace["workspace"]))

    assert client.get("/api/health").status_code == 200
    assert client.get("/").status_code == 200

    created = client.post(
        "/api/projects",
        json={
            "name": "接口项目",
            "images_dir": str(workspace["images"]),
            "schema_mode": "example",
            "example_json": '{"doc_no": "a", "total": 1, "items": [{"amount": "2"}]}',
        },
    )
    assert created.status_code == 200, created.text
    project_id = created.json()["project"]["project_id"]

    cases = client.get(f"/api/projects/{project_id}/cases").json()
    assert len(cases["cases"]) == 3
    case_id = cases["cases"][0]["case_id"]

    detail = client.get(f"/api/projects/{project_id}/annotations/{case_id}").json()
    assert detail["annotation"]["rev"] == 0
    assert "doc_no" in detail["values"]

    values = detail["values"]
    values["doc_no"] = "D-1"
    saved = client.put(
        f"/api/projects/{project_id}/annotations/{case_id}",
        json={
            "values": values,
            "notes": {"doc_no": "来自页眉"},
            "status": "done",
            "tags": ["门诊"],
            "expected_rev": 0,
        },
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["annotation"]["rev"] == 1
    assert saved.json()["annotation"]["status"] == "done"

    stale = client.put(
        f"/api/projects/{project_id}/annotations/{case_id}",
        json={"values": values, "notes": {}, "status": "draft", "tags": [], "expected_rev": 0},
    )
    assert stale.status_code == 409

    preview = client.get(f"/api/projects/{project_id}/preview/{case_id}")
    assert preview.status_code == 200
    assert preview.headers["content-type"] == "image/png"

    exported = client.post(
        f"/api/projects/{project_id}/exports", json={"case_ids": [case_id], "label": "api"}
    )
    assert exported.status_code == 200, exported.text
    version = exported.json()["version"]
    manifest = client.get(f"/api/projects/{project_id}/exports/{version}/manifest.csv")
    assert manifest.status_code == 200
    assert case_id in manifest.text


def test_schema_conflict(workspace):
    client = TestClient(create_app(workspace["workspace"]))
    created = client.post(
        "/api/projects",
        json={"name": "版本冲突", "images_dir": str(workspace["images"]), "schema_mode": "empty"},
    )
    project_id = created.json()["project"]["project_id"]
    current = client.get(f"/api/projects/{project_id}/schema").json()
    working = current["schema"]
    working["children"].append(
        {
            "id": "fld_test",
            "label": "新字段",
            "type": "string",
            "required": False,
            "enum": [],
            "description": "",
        }
    )
    first = client.put(
        f"/api/projects/{project_id}/schema",
        json={"schema": working, "expected_version": current["version"]},
    )
    assert first.status_code == 200, first.text

    stale = client.put(
        f"/api/projects/{project_id}/schema",
        json={"schema": working, "expected_version": current["version"]},
    )
    assert stale.status_code == 409
