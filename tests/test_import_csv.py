from __future__ import annotations

import json

import diffing
import importer
import schema
import store


def test_csv_long_table_import(project):
    proj, index, info = project
    case_id = index["cases"][0]["case_id"]
    csv_text = (
        "case_id,field_path,value,note\n"
        f"{case_id},doc_no,D-001,\n"
        f"{case_id},total,3040,合计与明细一致\n"
        f"{case_id},items[0].description,CT Brain,\n"
        f"{case_id},items[0].amount,3040,\n"
        f"{case_id},not_exists,x,\n"
        f"{case_id},total,abc,\n"
    )

    report = importer.run_import(
        proj,
        index,
        info,
        [{"filename": "labels.csv", "data": csv_text.encode("utf-8")}],
        "csv",
        "overwrite",
    )

    assert report["stats"]["rows"] == 6
    assert report["stats"]["unknown_field"] == 1
    assert report["stats"]["type_mismatch"] == 1
    assert report["stats"]["notes"] == 1

    ann = store.load_annotation(proj, case_id)
    assert ann["values"]["doc_no"] == "D-001"
    assert ann["values"]["total"] == 3040
    assert ann["values"]["items"][0]["description"] == "CT Brain"
    assert ann["notes"]["total"] == "合计与明细一致"
    assert ann["baseline_import_id"] == report["import_id"]

    baseline = store.load_baseline(proj, report["import_id"], case_id)
    assert baseline["values"]["doc_no"] == "D-001"
    assert baseline["schema_version"] == info["version"]

    # 修改后应能对比出差异，并带原值
    ann["values"]["total"] = 9999
    diff = diffing.compute_diff(ann["values"], baseline["values"])
    modified = {item["path"]: item for item in diff if item["kind"] == "modified"}
    assert modified["total"]["old"] == 3040
    assert modified["total"]["new"] == 9999


def test_fill_empty_keeps_baseline_for_skipped_fields(project):
    proj, index, info = project
    case_id = index["cases"][0]["case_id"]
    case = index["cases"][0]

    ann = store.make_annotation(proj, case, info)
    ann["values"]["total"] = "3200"
    store.save_annotation(proj, case, ann, info)

    csv_text = (
        "case_id,field_path,value,note\n"
        f"{case_id},total,3040,\n"
        f"{case_id},doc_no,A-001,\n"
    )
    report = importer.run_import(
        proj,
        index,
        info,
        [{"filename": "labels.csv", "data": csv_text.encode("utf-8")}],
        "csv",
        "fill_empty",
    )

    # fill_empty 不覆盖当前值，但 baseline 仍要记录导入值，供差异比较
    saved = store.load_annotation(proj, case_id)
    assert saved["values"]["total"] == "3200"
    assert saved["values"]["doc_no"] == "A-001"
    assert report["stats"]["skipped_fill"] == 1

    baseline = store.load_baseline(proj, report["import_id"], case_id)
    assert baseline["values"]["total"] == 3040

    diff = diffing.compute_diff(saved["values"], baseline["values"])
    modified = {item["path"]: item for item in diff if item["kind"] == "modified"}
    assert modified["total"]["old"] == 3040
    assert modified["total"]["new"] == "3200"
    # 表单默认值的空串不应被当成「新增」
    assert not [item for item in diff if item["kind"] == "added" and item["new"] == ""]


def test_import_matches_case_id_by_path_token(project):
    proj, index, info = project
    csv_text = (
        "case_id,field_path,value,note\n"
        "A,total,111,\n"
        "B,doc_no,B-001,\n"
    )
    report = importer.run_import(
        proj,
        index,
        info,
        [{"filename": "labels.csv", "data": csv_text.encode("utf-8")}],
        "csv",
        "overwrite",
    )

    assert report["stats"]["unknown_case"] == 0
    assert report["stats"]["applied_fields"] == 2
    # A 同时命中 A-001 / A-002，取排序第一张并记录歧义
    assert report["stats"]["ambiguous_case"] == 1
    ambiguous = [i for i in report["issues"] if i["type"] == "ambiguous_case"]
    assert ambiguous and ambiguous[0]["case_id"] == "A"
    assert "batch1_A_001" in ambiguous[0]["candidates"]

    assert store.load_annotation(proj, "batch1_A_001")["values"]["total"] == 111
    assert store.load_annotation(proj, "batch2_B_001")["values"]["doc_no"] == "B-001"


def test_import_accepts_full_id_extension_and_source_path(project):
    proj, index, info = project
    csv_text = (
        "case_id,field_path,value,note\n"
        "batch1_A_001,doc_no,ONE,\n"
        "batch1/A-002.png,doc_no,TWO,\n"
        "batch2_B_001.png,doc_no,THREE,\n"
    )
    report = importer.run_import(
        proj,
        index,
        info,
        [{"filename": "labels.csv", "data": csv_text.encode("utf-8")}],
        "csv",
        "overwrite",
    )

    assert report["stats"]["unknown_case"] == 0
    assert report["stats"]["ambiguous_case"] == 0
    assert store.load_annotation(proj, "batch1_A_001")["values"]["doc_no"] == "ONE"
    assert store.load_annotation(proj, "batch1_A_002")["values"]["doc_no"] == "TWO"
    assert store.load_annotation(proj, "batch2_B_001")["values"]["doc_no"] == "THREE"


def test_import_report_written(project):
    proj, index, info = project
    case_id = index["cases"][0]["case_id"]
    csv_text = f"case_id,field_path,value,note\n{case_id},doc_no,OK,\n"

    report = importer.run_import(
        proj,
        index,
        info,
        [{"filename": "a.csv", "data": csv_text.encode("utf-8-sig")}],
        "csv",
    )
    report_path = proj.root / "imports" / "reports" / f"{report['import_id']}.json"
    assert report_path.exists()
    on_disk = json.loads(report_path.read_text(encoding="utf-8"))
    assert on_disk["stats"]["applied_fields"] == 1

    index_path = proj.root / "imports" / "index.json"
    listed = json.loads(index_path.read_text(encoding="utf-8"))
    assert listed["imports"][0]["import_id"] == report["import_id"]


def test_rename_label_migrates_annotations(project):
    proj, index, info = project
    case_id = index["cases"][0]["case_id"]

    ann = store.make_annotation(proj, index["cases"][0], info)
    ann["values"]["doc_no"] = "X-1"
    ann["values"]["items"] = [{"description": "CT", "amount": "10"}]
    ann["notes"] = {"items[0].description": "描述备注"}
    store.save_annotation(proj, index["cases"][0], ann, info)

    working = json.loads(json.dumps(info["schema"]))
    items = next(child for child in working["children"] if child["label"] == "items")
    description = next(child for child in items["item"]["children"] if child["label"] == "description")
    description["label"] = "说明"

    result = schema.save_schema(proj.root, working)
    assert result["version"] == info["version"] + 1
    migration = store.migrate_annotations(
        proj, result["previous"], result["schema"], result["version"]
    )
    assert migration["migrated"] == 1

    saved = store.load_annotation(proj, case_id)
    assert saved["values"]["items"][0]["说明"] == "CT"
    assert "description" not in saved["values"]["items"][0]
    assert saved["notes"]["items[0].说明"] == "描述备注"
    assert saved["schema_version"] == result["version"]
