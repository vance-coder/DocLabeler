"""代码审查后修复的回归测试。

每条对应一个曾经会静默改坏数据 / 误判结果的具体问题，防止以后改回去。
"""

from __future__ import annotations

import csv
import io
import json

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import create_app
import diffing
import importer
import jsonio
import schema
import store
import validation

EXAMPLE = {
    "doc_no": "A-001",
    "total": 3040,
    "issue_date": "2026-11-09",
    "items": [{"description": "CT Brain", "amount": "3040"}],
}
SCALAR_EXAMPLE = {"doc_no": "A-001", "codes": ["A"]}


def _make_env(tmp_path, example):
    ws = tmp_path / "ws"
    ws.mkdir()
    images = tmp_path / "images"
    images.mkdir()
    for name in ("A-001.png", "A-002.png", "B-001.png"):
        Image.new("RGB", (80, 60), (235, 235, 235)).save(images / name)
    client = TestClient(create_app(ws))
    created = client.post(
        "/api/projects",
        json={
            "name": "regression",
            "images_dir": str(images),
            "schema_mode": "example",
            "example_json": json.dumps(example),
        },
    )
    assert created.status_code == 200, created.text
    pid = created.json()["project"]["project_id"]
    case_ids = [c["case_id"] for c in client.get(f"/api/projects/{pid}/cases").json()["cases"]]
    assert len(case_ids) == 3
    return client, pid, case_ids, ws


@pytest.fixture
def env(tmp_path):
    return _make_env(tmp_path, EXAMPLE)


@pytest.fixture
def scalar_env(tmp_path):
    return _make_env(tmp_path, SCALAR_EXAMPLE)


def _csv(case_ids, *, bbox="0.10 0.10 0.30 0.08", conf="0.99", bad_third=True):
    header = "case_id,field_path,value,note,confidence,bbox,text,page"
    lines = [header]
    for i, cid in enumerate(case_ids):
        bad = bad_third and i == 2
        score = "0.50" if bad else conf
        doc_no = "bad" if bad else f"A-{i + 1:03d}"
        total = "9999" if bad else "3040"
        lines += [
            f"{cid},doc_no,{doc_no},,{score},{bbox},{doc_no},0",
            f"{cid},total,{total},,{score},,,",
            f"{cid},issue_date,2026-11-09,,{score},,,",
            f"{cid},items[0].description,CT Brain,,{score},,,",
            f"{cid},items[0].amount,3040,,{score},,,",
        ]
    return "\n".join(lines).encode("utf-8")


def _import(client, pid, data, mode="overwrite"):
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


def _put(client, pid, cid, ann, **overrides):
    payload = {
        "values": ann["values"],
        "notes": ann.get("notes") or {},
        "confidence": ann.get("confidence") or {},
        "evidence": ann.get("evidence") or {},
        "status": ann.get("status") or "draft",
        "tags": ann.get("tags") or [],
        "expected_rev": ann["rev"],
    }
    payload.update(overrides)
    res = client.put(f"/api/projects/{pid}/annotations/{cid}", json=payload)
    assert res.status_code == 200, res.text
    return res.json()["annotation"]


def _root(rules=None, children=None):
    return schema.normalize_schema(
        {
            "id": "root",
            "label": "root",
            "type": "object",
            "required": True,
            "children": children
            or [
                {"id": "f1", "label": "start_date", "type": "string"},
                {"id": "f2", "label": "end_date", "type": "string"},
            ],
            "validation": rules or [],
        }
    )


# --------------------------------------------------------------------------
# 数组路径：负下标 / 超大下标 / 删除顺序
# --------------------------------------------------------------------------


def test_negative_and_huge_array_index_rejected():
    for path in ("items[-1].amount", "items[99999999].amount"):
        with pytest.raises(schema.SchemaError):
            schema.parse_path(path)
    values = {"items": [{"amount": 1}]}
    assert schema.get_value(values, ["items", -1, "amount"]) is None
    diffing.delete_value(values, ["items", -1])
    assert len(values["items"]) == 1  # 负下标不得删掉最后一个元素


def test_revert_deletes_scalar_array_items_in_numeric_order(scalar_env):
    client, pid, case_ids, _ = scalar_env
    cid = case_ids[0]
    csv_data = (
        "case_id,field_path,value,confidence\n"
        f"{cid},doc_no,A-001,0.99\n"
        f"{cid},codes[0],A,0.99\n"
    ).encode("utf-8")
    _import(client, pid, csv_data)

    ann = _annotation(client, pid, cid)
    values = ann["values"]
    values["codes"] = [f"C{i}" for i in range(12)]
    ann = _put(client, pid, cid, ann, values=values)
    assert len(ann["values"]["codes"]) == 12

    # baseline 只有 codes[0]="A"，其余 11 项都是新增；
    # revert 应恢复第 0 项并把新增项全部删掉，一个都不许残留。
    paths = [f"codes[{i}]" for i in range(12)]
    res = client.post(
        f"/api/projects/{pid}/annotations/{cid}/revert",
        json={"paths": paths},
    )
    assert res.status_code == 200, res.text
    assert res.json()["annotation"]["values"]["codes"] == ["A"]


# --------------------------------------------------------------------------
# 非有限数值
# --------------------------------------------------------------------------


def test_non_finite_numbers_are_rejected_everywhere(tmp_path):
    for raw in ("nan", "inf", "-inf", "NaN", "Infinity"):
        ok, _, _ = schema.coerce_value({"type": "number"}, raw)
        assert not ok, raw
        assert importer._parse_confidence(raw) is None, raw
        assert validation._number(raw) is None, raw
    assert importer._parse_bbox("nan 0.1 0.2 0.1") is None
    assert store.normalize_evidence({"x": {"bbox": [float("nan"), 0.1, 0.2, 0.1]}}) == {}
    with pytest.raises(ValueError):
        jsonio.write_json(tmp_path / "bad.json", {"v": float("nan")})


# --------------------------------------------------------------------------
# 规则：数组模板 compare 配对、数值下标排序、规则参数守卫
# --------------------------------------------------------------------------


def test_compare_rule_pairs_array_items_by_index():
    root = schema.normalize_schema(
        {
            "id": "root", "label": "root", "type": "object", "required": True,
            "children": [
                {
                    "id": "items", "label": "items", "type": "array",
                    "item": {
                        "id": "it", "label": "item", "type": "object",
                        "children": [
                            {"id": "s", "label": "start_date", "type": "string"},
                            {"id": "e", "label": "end_date", "type": "string"},
                        ],
                    },
                }
            ],
            "validation": [
                {"type": "compare", "path": "items[].end_date",
                 "other": "items[].start_date", "op": ">="}
            ],
        }
    )
    validation.validate_rules(root)
    values = {"items": [
        {"start_date": "2026-01-01", "end_date": "2026-02-01"},
        {"start_date": "2026-03-01", "end_date": "2026-01-01"},  # 唯一错误项
        {"start_date": "2026-01-01", "end_date": "2026-12-01"},
    ]}
    errors = validation.evaluate(root, values)
    assert [e["path"] for e in errors] == ["items[1].end_date"], errors

    flat = {f"items[{i}].amount": i for i in range(12)}
    assert validation._expand("items[].amount", flat)[10] == "items[10].amount"


def test_validate_rules_rejects_bad_parameters(env):
    client, pid, _, _ = env
    current = client.get(f"/api/projects/{pid}/schema").json()
    bad_rules = [
        [{"type": "range", "path": "total", "min": "abc"}],
        [{"type": "length", "path": "doc_no", "max": "x"}],
        [{"type": "regex", "path": "doc_no", "pattern": ""}],
        [{"type": "range", "path": "total", "min": 10, "max": 1}],
        [{"type": "length", "path": "doc_no", "min": -1}],
    ]
    for rules in bad_rules:
        with pytest.raises(validation.RuleError):
            validation.validate_rules(_root(rules))
        working = current["schema"]
        working["validation"] = rules
        res = client.put(f"/api/projects/{pid}/schema", json={"schema": working})
        assert res.status_code == 400, (rules, res.text)


# --------------------------------------------------------------------------
# 批量确认：空过滤结果绝不退化成整个项目
# --------------------------------------------------------------------------


def test_empty_case_ids_never_falls_back_to_whole_project(env):
    client, pid, case_ids, _ = env
    _import(client, pid, _csv(case_ids, bad_third=False))

    empty = client.post(
        f"/api/projects/{pid}/review/preview",
        json={"case_ids": [], "threshold": 0.95, "sample_rate": 0.0},
    )
    assert empty.status_code == 200, empty.text
    assert empty.json()["stats"]["candidates"] == 0
    assert empty.json()["stats"]["eligible"] == 0

    applied = client.post(
        f"/api/projects/{pid}/review/apply",
        json={"case_ids": [], "threshold": 0.95, "sample_rate": 0.0},
    )
    assert applied.status_code == 200, applied.text
    assert applied.json()["confirmed"] == 0
    for cid in case_ids:
        assert _annotation(client, pid, cid)["status"] == "draft"

    # 不传 case_ids 仍然是「整个项目」
    all_cases = client.post(
        f"/api/projects/{pid}/review/preview",
        json={"threshold": 0.95, "sample_rate": 0.0},
    ).json()
    assert all_cases["stats"]["eligible"] == 3


# --------------------------------------------------------------------------
# 导入：baseline / fill_empty 不得覆盖人工证据框与置信度
# --------------------------------------------------------------------------


def test_baseline_reimport_preserves_human_evidence_and_confidence(env):
    client, pid, case_ids, _ = env
    cid = case_ids[0]
    _import(client, pid, _csv(case_ids))

    ann = _annotation(client, pid, cid)
    human_box = [0.5, 0.5, 0.2, 0.1]
    ann = _put(
        client, pid, cid, ann,
        evidence={**ann["evidence"], "doc_no": {"bbox": human_box, "page": 0, "text": "人工框选"}},
        confidence={**ann["confidence"], "doc_no": 0.77},
    )

    _import(client, pid, _csv(case_ids, bbox="0.20 0.20 0.10 0.05", conf="0.50"),
            mode="baseline")
    after = _annotation(client, pid, cid)
    assert after["evidence"]["doc_no"]["bbox"] == human_box
    assert after["evidence"]["doc_no"]["text"] == "人工框选"
    assert after["confidence"]["doc_no"] == 0.77
    assert after["values"]["doc_no"] == "A-001"


def test_fill_empty_skipped_fields_keep_human_evidence(env):
    client, pid, case_ids, _ = env
    cid = case_ids[0]
    _import(client, pid, _csv(case_ids))

    ann = _annotation(client, pid, cid)
    human_box = [0.4, 0.4, 0.3, 0.1]
    ann = _put(
        client, pid, cid, ann,
        evidence={**ann["evidence"], "doc_no": {"bbox": human_box, "page": 0, "text": "人工框选"}},
        confidence={**ann["confidence"], "doc_no": 0.66},
    )

    report = _import(client, pid, _csv(case_ids, bbox="0.20 0.20 0.10 0.05", conf="0.50"),
                     mode="fill_empty")
    assert report["stats"]["skipped_fill"] > 0
    after = _annotation(client, pid, cid)
    assert after["evidence"]["doc_no"]["bbox"] == human_box
    assert after["confidence"]["doc_no"] == 0.66


# --------------------------------------------------------------------------
# 证据框：负坐标 clamp 时不得把框放大
# --------------------------------------------------------------------------


def test_negative_bbox_does_not_enlarge_the_box():
    box = store.normalize_evidence({"f": {"bbox": [-0.5, 0.0, 1.0, 0.1]}})["f"]["bbox"]
    assert box[0] == 0.0
    assert box[2] == pytest.approx(0.5)  # 右边仍在 0.5，而不是被拉到 1.0
    assert box[0] + box[2] <= 0.5 + 1e-6


# --------------------------------------------------------------------------
# 宽表导入：没有 field_path 时按 schema 路径 / 标签匹配（summary.csv 可回灌）
# --------------------------------------------------------------------------


def _wide_csv(case_id, source, *, status="done", notes=None, items=None):
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(
        ["case_id", "source", "status", "doc_no", "total", "issue_date", "items", "notes"]
    )
    writer.writerow(
        [
            case_id,
            source,
            status,
            "W-001",
            3040,
            "2026-11-09",
            json.dumps(items if items is not None else [{"description": "CT", "amount": "3040"}]),
            json.dumps(notes or {"total": "wide note"}),
        ]
    )
    writer.writerow(["", "", "", "", "", "", "", ""])
    return buffer.getvalue().encode("utf-8")


def test_wide_csv_import_without_field_path(env):
    client, pid, case_ids, _ = env
    cid = case_ids[0]
    report = _import(client, pid, _wide_csv(cid, "A-001.png"))
    assert report["stats"]["type_mismatch"] == 0
    assert report["stats"]["unknown_field"] == 0
    assert report["stats"]["cases"] == 1

    ann = _annotation(client, pid, cid)
    assert ann["values"]["doc_no"] == "W-001"
    assert ann["values"]["total"] == 3040
    assert ann["values"]["items"][0]["description"] == "CT"
    assert ann["notes"]["total"] == "wide note"
    assert ann["status"] == "done"


def test_wide_csv_can_resolve_case_by_source_column(env):
    client, pid, case_ids, _ = env
    cid = case_ids[1]
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["source", "doc_no"])
    writer.writerow(["A-002.png", "S-002"])
    report = _import(client, pid, buffer.getvalue().encode("utf-8"))
    assert report["stats"]["cases"] == 1
    assert _annotation(client, pid, cid)["values"]["doc_no"] == "S-002"


# --------------------------------------------------------------------------
# fill_empty：人工备注不能被导入备注覆盖
# --------------------------------------------------------------------------


def test_fill_empty_does_not_overwrite_human_notes(env):
    client, pid, case_ids, _ = env
    cid = case_ids[0]
    _import(client, pid, _csv(case_ids))
    ann = _annotation(client, pid, cid)
    ann = _put(client, pid, cid, ann, notes={**ann["notes"], "doc_no": "人工备注"})

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["case_id", "field_path", "value", "note"])
    writer.writerow([cid, "doc_no", "A-001", "模型备注"])
    _import(client, pid, buffer.getvalue().encode("utf-8"), mode="fill_empty")

    assert _annotation(client, pid, cid)["notes"]["doc_no"] == "人工备注"


# --------------------------------------------------------------------------
# schema 迁移：confidence 的字段路径也要一起迁移
# --------------------------------------------------------------------------


def test_schema_migration_remaps_confidence(tmp_path):
    root = tmp_path / "proj"
    (root / "annotations").mkdir(parents=True)
    jsonio.write_json(
        root / "annotations" / "A-001.json",
        {
            "case_id": "A-001",
            "source": "A-001.png",
            "schema_version": 1,
            "values": {"total": 10},
            "notes": {},
            "confidence": {"total": 0.4},
            "evidence": {"total": {"bbox": [0.1, 0.1, 0.1, 0.1], "page": 0, "text": ""}},
            "status": "draft",
            "tags": [],
            "baseline_import_id": None,
            "rev": 1,
            "updated_at": None,
        },
    )

    def _schema(label):
        return schema.normalize_schema(
            {
                "id": "root",
                "label": "root",
                "type": "object",
                "required": True,
                "children": [{"id": "f1", "label": label, "type": "number"}],
            }
        )

    class FakeProject:
        id = "p1"

        def __init__(self, project_root):
            self.root = project_root

    store.migrate_annotations(FakeProject(root), _schema("total"), _schema("amount"), 2)
    updated = jsonio.read_json(root / "annotations" / "A-001.json")
    assert updated["confidence"] == {"amount": 0.4}
    assert updated["evidence"]["amount"]["bbox"] == [0.1, 0.1, 0.1, 0.1]


# --------------------------------------------------------------------------
# collection 迁移：写标签失败时不得改名 / 写 marker，否则标签永久丢失
# --------------------------------------------------------------------------


def test_collection_migration_keeps_file_when_save_fails(env, monkeypatch):
    client, pid, case_ids, ws = env
    import projects
    import scanner
    from api import deps as api_deps

    proj = projects.load_project(ws, pid)
    collections = proj.root / "collections"
    collections.mkdir(parents=True, exist_ok=True)
    jsonio.write_json(
        collections / "batch.json", {"name": "batch", "case_ids": [case_ids[0]]}
    )

    def boom(*args, **kwargs):
        raise store.RevConflict(None)

    monkeypatch.setattr(store, "save_annotation", boom)
    api_deps.migrate_collections(proj, scanner.load_index(proj), schema.load_schema(proj.root))

    assert (collections / "batch.json").exists()
    assert not (collections / "batch.json.migrated").exists()
    assert not (collections / ".tags-migrated").exists()


def test_tags_are_deduped_case_insensitively(env):
    client, pid, case_ids, _ = env
    ann = _annotation(client, pid, case_ids[0])
    saved = _put(
        client,
        pid,
        case_ids[0],
        ann,
        tags=["Recheck", "recheck", " Recheck ", "blur", "BLUR"],
    )
    assert saved["tags"] == ["Recheck", "blur"]


def test_bulk_remove_tags_is_case_insensitive(env):
    client, pid, case_ids, _ = env
    ann = _annotation(client, pid, case_ids[0])
    _put(client, pid, case_ids[0], ann, tags=["Recheck", "blur"])
    res = client.post(
        f"/api/projects/{pid}/annotations/bulk",
        json={"case_ids": [case_ids[0]], "action": "remove_tags", "tags": ["RECHECK"]},
    )
    assert res.status_code == 200, res.text
    assert _annotation(client, pid, case_ids[0])["tags"] == ["blur"]


