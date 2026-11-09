"""上一轮 review 列出的六项「建议但没动」的落地回归测试：

1. 并发安全：schema / 迁移 / 批量写入是否都走项目锁，两个并发保存是否只有一个赢
2. /cases 性能：同一请求内 baseline meta 与规则是否只准备一次
3. metrics 口径：坏 baseline 容错、无真值版本跳过、字段改名后 confidence 重映射
4. 导出健壮性：临时目录原子发布、失败无残留、缺图与裁剪失败显式 warning
5. 前端见 tests/test_frontend_smoke.py（Node 侧加载 refreshProject / 徽标局部刷新）
"""

from __future__ import annotations

import json
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from PIL import Image

import diffing
import exporter
import jsonio
import locks
import projects
import scanner
import schema
import store
import validation
from app import create_app

EXAMPLE = {
    "doc_no": "A-001",
    "total": 3040,
    "issue_date": "2026-11-09",
    "items": [{"description": "CT Brain", "amount": "3040"}],
}


@pytest.fixture
def env(tmp_path):
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
            "name": "optimizations",
            "images_dir": str(images),
            "schema_mode": "example",
            "example_json": json.dumps(EXAMPLE),
        },
    )
    assert created.status_code == 200, created.text
    pid = created.json()["project"]["project_id"]
    case_ids = [c["case_id"] for c in client.get(f"/api/projects/{pid}/cases").json()["cases"]]
    assert len(case_ids) == 3
    return SimpleNamespace(
        client=client, pid=pid, case_ids=case_ids, ws=ws, images=images,
        proj=projects.load_project(ws, pid),
    )


def _csv(case_ids, conf="0.99"):
    header = "case_id,field_path,value,note,confidence,bbox,text,page"
    lines = [header]
    for i, cid in enumerate(case_ids):
        lines += [
            f"{cid},doc_no,A-{i + 1:03d},,{conf},,,",
            f"{cid},total,3040,,{conf},,,",
            f"{cid},issue_date,2026-11-09,,{conf},,,",
            f"{cid},items[0].description,CT Brain,,{conf},,,",
            f"{cid},items[0].amount,3040,,{conf},,,",
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


def _staging_dirs(proj):
    root = proj.root / "exports"
    if not root.is_dir():
        return []
    return [p for p in root.iterdir() if p.name.startswith(exporter.STAGING_PREFIX)]


# --------------------------------------------------------------------------
# 1. 并发安全
# --------------------------------------------------------------------------


def test_project_lock_is_shared_between_path_and_project(env):
    """Path 自带 .root（盘符），绝不能把路径当 Project 对象，否则锁会串 / 会合并。"""
    assert locks.project_lock(env.proj) is locks.project_lock(env.proj.root)
    assert locks.project_lock(env.proj) is locks.project_lock(str(env.proj.root))
    other = env.proj.root.parent / "another-project"
    assert locks.project_lock(env.proj) is not locks.project_lock(other)


def test_save_schema_is_guarded_by_project_lock(env):
    """持项目锁时，另一个线程的 save_schema 必须等待，不能再绕锁直写。"""
    root = env.proj.root
    started = threading.Event()
    done = threading.Event()
    outcome = {}

    def worker():
        started.set()
        try:
            schema.save_schema(root, schema.infer_from_example(EXAMPLE), expected_version=1)
            outcome["ok"] = True
        except Exception as exc:  # pragma: no cover - 仅用于失败时定位
            outcome["error"] = exc
        finally:
            done.set()

    with locks.project_lock(root):
        thread = threading.Thread(target=worker)
        thread.start()
        assert started.wait(2)
        assert not done.wait(0.3), "save_schema bypassed the project lock"
    thread.join(3)
    assert not thread.is_alive()
    assert outcome.get("ok"), outcome
    assert schema.load_schema(root)["version"] == 2


def test_migrate_annotations_is_guarded_by_project_lock(env):
    root = env.proj.root
    info = schema.load_schema(root)
    started = threading.Event()
    done = threading.Event()

    def worker():
        started.set()
        try:
            store.migrate_annotations(env.proj, info["schema"], info["schema"], info["version"])
        finally:
            done.set()

    with locks.project_lock(root):
        thread = threading.Thread(target=worker)
        thread.start()
        assert started.wait(2)
        assert not done.wait(0.3), "migrate_annotations bypassed the project lock"
    thread.join(3)
    assert not thread.is_alive()


def test_concurrent_schema_save_has_single_winner(env):
    """两个线程同时带 expected_version=1 保存：串行化后必然一个 200 语义、一个冲突。"""
    root = env.proj.root
    barrier = threading.Barrier(2)
    new_schema = schema.infer_from_example({**EXAMPLE, "extra": "x"})

    def save(_):
        barrier.wait(timeout=5)
        try:
            return schema.save_schema(root, new_schema, expected_version=1)
        except schema.SchemaVersionConflict:
            return None

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(save, range(2)))
    assert sum(result is not None for result in results) == 1
    assert schema.load_schema(root)["version"] == 2, "both writes must not land on v2"


# --------------------------------------------------------------------------
# 2. /cases 性能
# --------------------------------------------------------------------------


def test_cases_request_prepares_baseline_and_rules_once(env, monkeypatch):
    _import(env.client, env.pid, _csv(env.case_ids))
    meta_calls: list[str] = []
    rule_calls: list[int] = []
    original_meta = store.baseline_meta
    original_rules = validation.compile_rules

    def counting_meta(project, import_id):
        meta_calls.append(str(import_id))
        return original_meta(project, import_id)

    def counting_rules(root):
        rule_calls.append(1)
        return original_rules(root)

    monkeypatch.setattr(store, "baseline_meta", counting_meta)
    monkeypatch.setattr(validation, "compile_rules", counting_rules)

    res = env.client.get(f"/api/projects/{env.pid}/cases")
    assert res.status_code == 200, res.text
    assert len(res.json()["cases"]) == 3
    # 三个 case 属于同一次导入：meta 只读一次；规则只编译一次。
    assert len(meta_calls) == 1, meta_calls
    assert len(rule_calls) == 1, rule_calls


def test_baseline_cache_skips_corrupt_snapshot(env):
    """单个写坏的 baseline JSON 不能让 /cases 或 /diff 500。"""
    _import(env.client, env.pid, _csv(env.case_ids))
    run_dir = next(p for p in (env.proj.root / ".baseline").iterdir() if p.is_dir())
    snapshot = next((run_dir / "cases").glob("*.json"))
    snapshot.write_text("{not json", encoding="utf-8")

    res = env.client.get(f"/api/projects/{env.pid}/cases")
    assert res.status_code == 200, res.text
    assert len(res.json()["cases"]) == 3
    cid = snapshot.stem
    diff = env.client.get(f"/api/projects/{env.pid}/diff/{cid}")
    assert diff.status_code == 200, diff.text


# --------------------------------------------------------------------------
# 3. metrics 口径
# --------------------------------------------------------------------------


def test_metrics_tolerates_bad_files_and_reports_skipped_runs(env):
    report = _import(env.client, env.pid, _csv(env.case_ids))
    baseline_root = env.proj.root / ".baseline"
    run_dir = baseline_root / report["import_id"]
    snapshot = next((run_dir / "cases").glob("*.json"))
    snapshot.write_text("{broken", encoding="utf-8")

    # 没有任何快照的空版本
    (baseline_root / "empty-run").mkdir()
    (baseline_root / "empty-run" / "cases").mkdir()
    # 有预测但没有人工真值的版本
    orphan = baseline_root / "orphan-run"
    (orphan / "cases").mkdir(parents=True)
    jsonio.write_json(
        orphan / "cases" / "ghost.json",
        {"values": {"doc_no": "X"}, "schema_version": 1, "confidence": {"doc_no": 0.9}},
    )
    jsonio.write_json(orphan / "meta.json", {"import_id": "orphan-run"})

    res = env.client.get(f"/api/projects/{env.pid}/metrics")
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["truth_definition"]
    assert data["runs"], data["skipped_runs"]
    skipped = {item["import_id"]: item["reason"] for item in data["skipped_runs"]}
    assert "no baseline cases" in skipped.get("empty-run", "")
    assert "ground truth" in skipped.get("orphan-run", "")
    assert not any(run["import_id"] == "orphan-run" for run in data["runs"])
    # 其余两个 case 仍能正常打分，坏文件被计数而不是拖垮接口
    assert data["runs"][0]["invalid_file_count"] == 1
    assert data["runs"][0]["truth_case_count"] >= 2


def test_metrics_remaps_confidence_after_field_rename(env):
    _import(env.client, env.pid, _csv(env.case_ids))
    current = env.client.get(f"/api/projects/{env.pid}/schema").json()
    working = current["schema"]
    for child in working["children"]:
        if child["label"] == "doc_no":
            child["label"] = "invoice_no"  # 保留不可变 id
    updated = env.client.put(
        f"/api/projects/{env.pid}/schema",
        json={"schema": working, "expected_version": current["version"]},
    )
    assert updated.status_code == 200, updated.text

    data = env.client.get(f"/api/projects/{env.pid}/metrics").json()
    assert data["runs"]
    buckets = {bucket["key"]: bucket for bucket in data["runs"][0]["calibration"]}
    assert buckets["95-100"]["total"] >= 1, buckets
    assert buckets["unknown"]["total"] == 0, "confidence keys must follow renamed fields"


# --------------------------------------------------------------------------
# 4. 导出健壮性
# --------------------------------------------------------------------------


def test_missing_image_is_a_warning_not_a_500_and_no_partial_export(env):
    for image in env.images.glob("*.png"):
        image.unlink()

    res = env.client.post(f"/api/projects/{env.pid}/exports", json={"label": "missing"})
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["warning_count"] >= len(env.case_ids)
    assert data["warnings"] and all(w["kind"] == "image" for w in data["warnings"])
    assert not _staging_dirs(env.proj), "staging directory was not published/cleaned"

    final = Path(data["export_dir"])
    assert final.is_dir() and final.name == data["version"]
    meta = jsonio.read_json(final / "manifest.json")
    assert len(meta["warnings"]) == data["warning_count"]
    assert meta["version"] == data["version"]
    exported = env.client.get(f"/api/projects/{env.pid}/exports").json()["exports"]
    assert any(item["version"] == data["version"] for item in exported)


def test_export_empty_case_ids_does_not_export_whole_project(env):
    """当前过滤为空时传 []，不能被当成「导出整个项目」（与批量确认同语义）。"""
    res = env.client.post(f"/api/projects/{env.pid}/exports", json={"case_ids": []})
    assert res.status_code == 400, res.text
    assert "No cases to export" in str(res.json()["detail"])
    assert not _staging_dirs(env.proj)
    assert not [p for p in (env.proj.root / "exports").iterdir() if p.is_dir()]


def test_export_failure_cleans_staging_and_list_exports_ignores_leftovers(env, monkeypatch):
    def boom(*args, **kwargs):
        raise RuntimeError("disk full")

    monkeypatch.setattr(exporter, "_write_csv", boom)
    with pytest.raises(RuntimeError):
        exporter.export_cases(
            env.proj,
            env.case_ids[:1],
            scanner.load_index(env.proj),
            schema.load_schema(env.proj.root),
        )
    assert not _staging_dirs(env.proj), "failed export left a staging directory"
    final_dirs = [p for p in (env.proj.root / "exports").iterdir() if p.is_dir()]
    assert not final_dirs, "failed export published a partial version"

    # 崩溃残留的 staging 目录不出现在导出列表里
    (env.proj.root / "exports" / ".staging-leftover").mkdir()
    listed = env.client.get(f"/api/projects/{env.pid}/exports").json()["exports"]
    assert not any(item["version"].startswith(exporter.STAGING_PREFIX) for item in listed)


def test_validation_evaluate_compiled_matches_original(env):
    """预编译规则与旧 evaluate 结果一致，避免性能优化改变判定。"""
    current = env.client.get(f"/api/projects/{env.pid}/schema").json()
    root = schema.normalize_schema(current["schema"])
    root["validation"] = [{"type": "regex", "path": "doc_no", "pattern": r"^[A-Z]-\d{3}$"}]
    values = {"doc_no": "bad", "total": 1, "issue_date": "x", "items": []}
    compiled = validation.compile_rules(root)
    assert validation.evaluate(root, values) == validation.evaluate_compiled(compiled, values)
    assert validation.evaluate(root, values, compiled)[0]["rule"] == "regex"
    assert diffing.BaselineCache(env.proj, schema.load_schema(env.proj.root)) is not None
