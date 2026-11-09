"""四项新功能的端到端测试：证据框 / 复核队列 / 校验规则 / 指标回归。

全部通过 TestClient 走真实 HTTP 路由，覆盖「导入预测 → 人工修正 → 批量确认 →
导出 → 指标对比」这条日常主链路。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import create_app

EXAMPLE = {
    "doc_no": "A-001",
    "total": 3040,
    "issue_date": "2026-11-09",
    "items": [{"description": "CT Brain", "amount": "3040"}],
}

RULES = [
    {
        "type": "sum",
        "target": "total",
        "source": "items[].amount",
        "tolerance": 0.01,
        "message": "明细合计与总金额不一致",
    },
    {"type": "regex", "path": "doc_no", "pattern": r"^[A-Z]-\d{3}$"},
    {"type": "date", "path": "issue_date", "format": "YYYY-MM-DD"},
]


@pytest.fixture
def env(tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    images = tmp_path / "images"
    (images / "batch1").mkdir(parents=True)
    for name in ("A-001.png", "A-002.png", "B-001.png"):
        Image.new("RGB", (80, 60), (235, 235, 235)).save(images / "batch1" / name)

    client = TestClient(create_app(ws))
    created = client.post(
        "/api/projects",
        json={
            "name": "E2E",
            "images_dir": str(images),
            "schema_mode": "example",
            "example_json": json.dumps(EXAMPLE),
        },
    )
    assert created.status_code == 200, created.text
    pid = created.json()["project"]["project_id"]
    case_ids = [c["case_id"] for c in client.get(f"/api/projects/{pid}/cases").json()["cases"]]
    assert len(case_ids) == 3
    return client, pid, case_ids, ws


def _add_rules(client, pid, rules=RULES):
    current = client.get(f"/api/projects/{pid}/schema").json()
    working = current["schema"]
    working["validation"] = rules
    res = client.put(
        f"/api/projects/{pid}/schema",
        json={"schema": working, "expected_version": current["version"]},
    )
    assert res.status_code == 200, res.text
    return res.json()


def _csv(case_ids, *, bad_third=True):
    """三张单据的预测；第三张故意给出错值和低置信度，用于验证跳过逻辑。"""
    header = "case_id,field_path,value,note,confidence,bbox,text,page"
    lines = [header]
    for i, cid in enumerate(case_ids):
        bad = bad_third and i == 2
        conf = "0.50" if bad else "0.99"
        doc_no = "bad" if bad else f"A-{i + 1:03d}"
        total = "9999" if bad else "3040"
        lines += [
            f"{cid},doc_no,{doc_no},,{conf},0.10 0.10 0.30 0.08,{doc_no},0",
            f"{cid},total,{total},,{conf},0.50 0.10 0.20 0.08,{total},0",
            f"{cid},issue_date,2026-11-09,,{conf},,,",
            f"{cid},items[0].description,CT Brain,,{conf},,,",
            f"{cid},items[0].amount,3040,,{conf},,,",
        ]
    return "\n".join(lines).encode("utf-8")


def _import(client, pid, data: bytes, mode: str = "overwrite"):
    res = client.post(
        f"/api/projects/{pid}/imports",
        data={"kind": "csv", "mode": mode},
        files={"files": ("pred.csv", data, "text/csv")},
    )
    assert res.status_code == 200, res.text
    return res.json()


def _annotation(client, pid, cid):
    res = client.get(f"/api/projects/{pid}/annotations/{cid}")
    assert res.status_code == 200, res.text
    return res.json()["annotation"]


# --------------------------------------------------------------------------
# #1 字段 <-> 原文互定位
# --------------------------------------------------------------------------


def test_evidence_import_save_and_export_crops(env):
    client, pid, case_ids, ws = env
    cid = case_ids[0]

    report = _import(client, pid, _csv(case_ids))
    assert report["stats"]["evidence"] >= 2, report["stats"]

    ann = _annotation(client, pid, cid)
    evidence = ann["evidence"]
    assert "doc_no" in evidence and "total" in evidence
    assert evidence["doc_no"]["bbox"] == [0.1, 0.1, 0.3, 0.08]
    assert evidence["doc_no"]["text"] == "A-001"
    assert evidence["doc_no"]["page"] == 0

    # 越界框在服务端被 clamp；不带 evidence 的写入不应抹掉已有框
    payload = {
        "values": ann["values"],
        "notes": {},
        "confidence": ann["confidence"],
        "evidence": {
            **evidence,
            "issue_date": {"bbox": [0.9, 0.9, 0.5, 0.5], "page": 2, "text": "2026"},
        },
        "status": "draft",
        "tags": [],
        "expected_rev": ann["rev"],
    }
    saved = client.put(f"/api/projects/{pid}/annotations/{cid}", json=payload)
    assert saved.status_code == 200, saved.text
    box = saved.json()["annotation"]["evidence"]["issue_date"]["bbox"]
    assert all(0 <= v <= 1 for v in box)
    assert box[0] + box[2] <= 1.0001 and box[1] + box[3] <= 1.0001

    payload.pop("evidence")  # 模拟不带该字段的旧写入路径
    payload["expected_rev"] = saved.json()["annotation"]["rev"]
    kept = client.put(f"/api/projects/{pid}/annotations/{cid}", json=payload)
    assert kept.status_code == 200, kept.text
    assert "doc_no" in kept.json()["annotation"]["evidence"]

    res = client.post(
        f"/api/projects/{pid}/exports",
        json={"case_ids": [cid], "label": "evidence", "include_crops": True},
    )
    assert res.status_code == 200, res.text
    assert res.json()["crop_count"] >= 1
    export_dir = Path(res.json()["export_dir"])
    assert (export_dir / "evidence.csv").exists()
    crops = list(export_dir.rglob("crops/*.png"))
    assert crops, "no field crops written"
    with Image.open(crops[0]) as crop:
        assert crop.size[0] > 0 and crop.size[1] > 0

    # 关掉裁剪时不应产出图片
    plain = client.post(
        f"/api/projects/{pid}/exports",
        json={"case_ids": [cid], "label": "nocrop", "include_crops": False},
    )
    assert plain.status_code == 200, plain.text
    assert plain.json()["crop_count"] == 0


# --------------------------------------------------------------------------
# #2 批量确认与抽样队列
# --------------------------------------------------------------------------


def test_review_queue_preview_apply_and_sampling(env):
    client, pid, case_ids, _ = env
    _add_rules(client, pid)
    _import(client, pid, _csv(case_ids))

    preview = client.post(
        f"/api/projects/{pid}/review/preview",
        json={"threshold": 0.95, "sample_rate": 0.0},
    )
    assert preview.status_code == 200, preview.text
    data = preview.json()
    assert data["stats"]["eligible"] == 2, data["stats"]
    assert set(data["eligible"]) == set(case_ids[:2])
    skipped_reasons = " ".join(x["reason"] for x in data["skipped"])
    assert "below confidence threshold" in skipped_reasons
    assert "validation errors" in skipped_reasons

    applied = client.post(
        f"/api/projects/{pid}/review/apply",
        json={"threshold": 0.95, "sample_rate": 0.0},
    )
    assert applied.status_code == 200, applied.text
    assert applied.json()["confirmed"] == 2
    for cid in case_ids[:2]:
        assert _annotation(client, pid, cid)["status"] == "done"

    again = client.post(
        f"/api/projects/{pid}/review/preview",
        json={"threshold": 0.95, "sample_rate": 0.0},
    ).json()
    assert again["stats"]["eligible"] == 0
    assert any("Already done" in x["reason"] for x in again["skipped"])


def test_review_sampling_is_deterministic_and_keeps_draft(env):
    client, pid, case_ids, _ = env
    _import(client, pid, _csv(case_ids, bad_third=False))

    first = client.post(
        f"/api/projects/{pid}/review/preview",
        json={"threshold": 0.95, "sample_rate": 1.0},
    ).json()
    second = client.post(
        f"/api/projects/{pid}/review/preview",
        json={"threshold": 0.95, "sample_rate": 1.0},
    ).json()
    assert first["sampled"] == second["sampled"]
    assert len(first["sampled"]) == 3

    applied = client.post(
        f"/api/projects/{pid}/review/apply",
        json={"threshold": 0.95, "sample_rate": 1.0, "sample_tag": "must-check"},
    )
    assert applied.status_code == 200, applied.text
    assert applied.json()["kept_for_review"] == 3
    for cid in case_ids:
        ann = _annotation(client, pid, cid)
        assert "must-check" in ann["tags"]
        assert ann["status"] == "draft"


# --------------------------------------------------------------------------
# #3 跨字段校验规则
# --------------------------------------------------------------------------


def test_validation_rules_live_eval_and_schema_guard(env):
    client, pid, case_ids, _ = env
    _add_rules(client, pid)

    good = {
        "doc_no": "A-001",
        "total": 3040,
        "issue_date": "2026-11-09",
        "items": [{"description": "CT Brain", "amount": "3040"}],
    }
    bad = {
        "doc_no": "bad",
        "total": 9999,
        "issue_date": "2026-13-40",
        "items": [{"description": "CT Brain", "amount": "3040"}],
    }
    ok = client.post(f"/api/projects/{pid}/validate", json={"values": good})
    assert ok.status_code == 200, ok.text
    assert ok.json()["count"] == 0 and ok.json()["has_rules"] is True

    errors = client.post(f"/api/projects/{pid}/validate", json={"values": bad})
    assert errors.status_code == 200, errors.text
    assert errors.json()["count"] == 3, errors.json()["errors"]
    kinds = {e["rule"] for e in errors.json()["errors"]}
    assert kinds == {"regex", "date", "sum"}, kinds

    # 坏规则在保存 schema 时就要被拒，而不是运行时炸
    rejected = client.put(
        f"/api/projects/{pid}/schema",
        json={"schema": {"id": "r", "label": "r", "type": "object",
                          "children": [], "validation": [{"type": "regex", "path": "doc_no",
                                                          "pattern": "["}]}},
    )
    assert rejected.status_code == 400, rejected.text

    _import(client, pid, _csv(case_ids))
    cases = client.get(f"/api/projects/{pid}/cases").json()["cases"]
    by_id = {c["case_id"]: c for c in cases}
    assert by_id[case_ids[0]]["annotation"]["validation_errors"] == 0
    assert by_id[case_ids[2]]["annotation"]["validation_errors"] >= 1


# --------------------------------------------------------------------------
# #4 prompt 迭代回归对比
# --------------------------------------------------------------------------


def test_metrics_compare_two_prompt_versions(env):
    client, pid, case_ids, _ = env
    _add_rules(client, pid)

    v1 = _import(client, pid, _csv(case_ids))
    # 人工修正第三张错误预测，作为真值
    for cid in case_ids:
        ann = _annotation(client, pid, cid)
        values = ann["values"]
        values["doc_no"] = "A-001"
        values["total"] = 3040
        values["issue_date"] = "2026-11-09"
        client.put(
            f"/api/projects/{pid}/annotations/{cid}",
            json={
                "values": values,
                "notes": {},
                "confidence": ann["confidence"],
                "evidence": ann["evidence"],
                "status": "draft",
                "tags": [],
                "expected_rev": ann["rev"],
            },
        )

    # v2 预测全部正确，且用 baseline 模式不覆盖人工值
    v2 = _import(client, pid, _csv(case_ids, bad_third=False), mode="baseline")
    assert v2["import_id"] != v1["import_id"]
    assert _annotation(client, pid, case_ids[0])["values"]["doc_no"] == "A-001"

    result = client.get(f"/api/projects/{pid}/metrics")
    assert result.status_code == 200, result.text
    data = result.json()
    assert len(data["runs"]) == 2, data.keys()
    by_import = {r["import_id"]: r for r in data["runs"]}
    assert by_import[v2["import_id"]]["accuracy"] > by_import[v1["import_id"]]["accuracy"]
    for run in data["runs"]:
        assert run["by_field"] and run["calibration"]
        assert sum(run["counts"].values()) > 0

    csv_res = client.get(f"/api/projects/{pid}/metrics.csv")
    assert csv_res.status_code == 200
    assert csv_res.headers["content-type"].startswith("text/csv")
    assert v1["import_id"] in csv_res.text and v2["import_id"] in csv_res.text


# --------------------------------------------------------------------------
# 全部 GET 路由冒烟（防止拆分 / 新增路由把旧接口带崩）
# --------------------------------------------------------------------------


def test_all_get_endpoints_smoke(env):
    client, pid, case_ids, _ = env
    cid = case_ids[0]
    _import(client, pid, _csv(case_ids))
    exported = client.post(f"/api/projects/{pid}/exports", json={"label": "smoke"})
    assert exported.status_code == 200, exported.text
    version = exported.json()["version"]

    paths = [
        "/api/health",
        "/api/projects",
        f"/api/projects/{pid}",
        f"/api/projects/{pid}/cases",
        f"/api/projects/{pid}/schema",
        f"/api/projects/{pid}/imports",
        f"/api/projects/{pid}/exports",
        f"/api/projects/{pid}/notes/summary",
        f"/api/projects/{pid}/notes/summary.csv",
        f"/api/projects/{pid}/prompt",
        f"/api/projects/{pid}/corrections.csv",
        f"/api/projects/{pid}/search-index",
        f"/api/projects/{pid}/annotations/{cid}",
        f"/api/projects/{pid}/diff/{cid}",
        f"/api/projects/{pid}/preview/{cid}",
        f"/api/projects/{pid}/exports/{version}/manifest.csv",
        f"/api/projects/{pid}/metrics",
        f"/api/projects/{pid}/metrics.csv",
        "/",
        "/static/js/main.js",
    ]
    for path in paths:
        res = client.get(path)
        assert res.status_code == 200, f"{path} -> {res.status_code}: {res.text[:200]}"
