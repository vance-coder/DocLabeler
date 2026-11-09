"""Prompt / 模型迭代的回归对比指标。

把每次导入的模型预测（``.baseline/<import_id>/cases/*.json``）与当前人工修正后的
标注（``annotations/*.json``，视为真值）逐字段比较，产出：

- 整体准确率与四类错误（改错 / 漏抽 / 多抽 / 正确）
- 按字段准确率、按错误类型分布
- 按置信度分桶的校准情况（模型说有把握时是否真的对）
- 最差 case 列表，便于优先复核
- 各导入版本之间的字段准确率变化

历史 baseline 若与当前 schema 版本不同，会按不可变字段 id 重映射后再比较
（values 与 confidence 的路径 key 都要重映射，否则字段改名后校准会全落 unknown）。

真值口径：只有「既有该次导入的 baseline 预测、又有当前人工标注」的 case 才参与打分；
完全没有人工标注的 case 不算模型漏抽，也不会产生一个准确率为 0 的伪版本。
"""

from __future__ import annotations

import io
import csv
import re
from typing import Any

import jsonio
import schema
import store

BUCKETS = [
    {"key": "0-50", "label": "0–50%", "min": 0.0, "max": 0.5},
    {"key": "50-80", "label": "50–80%", "min": 0.5, "max": 0.8},
    {"key": "80-95", "label": "80–95%", "min": 0.8, "max": 0.95},
    {"key": "95-100", "label": "95–100%", "min": 0.95, "max": 1.01},
    {"key": "unknown", "label": "No score", "min": None, "max": None},
]

ERROR_KINDS = ("correct", "wrong", "missing", "extra")

TRUTH_DEFINITION = (
    "Ground truth is the current human-edited annotation. Only cases with both a "
    "baseline prediction and a human annotation are scored; unannotated cases are "
    "excluded instead of being counted as model errors."
)


def _template(path: str) -> str:
    return re.sub(r"\[\d+\]", "[]", str(path or ""))


def _field_labels(root: dict) -> dict[str, str]:
    return {path: node["label"] for path, node in schema.iter_fields(root)}


def _is_empty(value: Any) -> bool:
    return value is None or value == "" or value == [] or value == {}


def _number(text: str) -> float | None:
    cleaned = str(text).strip()
    for token in (",", "¥", "￥", "$", " ", "\u00a0"):
        cleaned = cleaned.replace(token, "")
    if not cleaned:
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None


def _norm(value: Any) -> str:
    """宽松归一化：数字字符串与数字等价，去掉首尾空白，布尔统一小写。"""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return f"{float(value):.10g}"
    text = str(value).strip()
    number = _number(text)
    return f"{number:.10g}" if number is not None else text


def _bucket_key(score: Any) -> str:
    if score is None:
        return "unknown"
    try:
        value = float(score)
    except (TypeError, ValueError):
        return "unknown"
    for bucket in BUCKETS:
        if bucket["min"] is not None and bucket["min"] <= value < bucket["max"]:
            return bucket["key"]
    return "unknown"


def _ratio(correct: int, total: int) -> float:
    return round(correct / total, 4) if total else 0.0


def _source_version(payload: dict, info: dict) -> int:
    try:
        return int(payload.get("schema_version") or info["version"])
    except (TypeError, ValueError):
        return info["version"]


def _remap_keys(old_root: dict | None, new_root: dict, raw: Any) -> dict:
    """confidence / evidence 这类「字段路径 -> 值」的映射随 schema 版本重映射。"""
    if not isinstance(raw, dict):
        return {}
    out: dict = {}
    for key, value in raw.items():
        text = str(key)
        try:
            segs = schema.parse_path(text)
        except schema.SchemaError:
            out[text] = value
            continue
        mapped = schema.remap_path(old_root, new_root, segs)
        out[schema.render_path(mapped) if mapped is not None else text] = value
    return out


def _remap_payload(
    project, info: dict, payload: dict, roots: dict[int, dict | None]
) -> tuple[dict, dict]:
    """返回 (values, confidence)，两者都对齐到当前 schema 版本。

    ``roots`` 按版本缓存历史 schema，一次 run 只按版本读盘一次。
    """
    values = payload.get("values") if isinstance(payload.get("values"), dict) else {}
    confidence = payload.get("confidence")
    confidence = confidence if isinstance(confidence, dict) else {}
    src_version = _source_version(payload, info)
    if src_version == info["version"]:
        return values, confidence
    if src_version not in roots:
        try:
            roots[src_version] = schema.load_schema_version(project.root, src_version)
        except (OSError, ValueError, schema.SchemaError):
            roots[src_version] = None
    old_root = roots[src_version]
    if old_root is None:
        return values, confidence
    return (
        schema.remap_values(old_root, info["schema"], values),
        _remap_keys(old_root, info["schema"], confidence),
    )


def _run_cases(project, import_id: str) -> tuple[dict[str, dict], list[str]]:
    """返回 (可用快照, 坏文件名列表)；单个损坏 JSON 不能让整个 /metrics 500。"""
    try:
        directory = store.baseline_dir(project, import_id) / "cases"
    except store.AnnotationError:
        return {}, []
    if not directory.is_dir():
        return {}, []
    out: dict[str, dict] = {}
    invalid: list[str] = []
    for path in sorted(directory.glob("*.json")):
        try:
            data = jsonio.read_json(path)
        except (OSError, ValueError):
            invalid.append(path.name)
            continue
        if isinstance(data, dict):
            out[path.stem] = data
        else:
            invalid.append(path.name)
    return out, invalid


def _list_runs(project) -> list[dict]:
    try:
        index = jsonio.read_json(project.root / "imports" / "index.json", {"imports": []})
    except (OSError, ValueError):
        index = {}
    raw_runs = (index or {}).get("imports") or []
    runs = [run for run in raw_runs if isinstance(run, dict)] if isinstance(raw_runs, list) else []
    runs = list(runs)
    baseline_root = project.root / ".baseline"
    known = {str(run.get("import_id")) for run in runs}
    if baseline_root.is_dir():
        try:
            directories = sorted(baseline_root.iterdir())
        except OSError:
            directories = []
        for directory in directories:
            if directory.is_dir() and directory.name not in known:
                try:
                    meta = jsonio.read_json(directory / "meta.json", {}) or {}
                except (OSError, ValueError):
                    meta = {}
                if not isinstance(meta, dict):
                    meta = {}
                runs.append(
                    {
                        "import_id": directory.name,
                        "created_at": meta.get("created_at"),
                        "mode": meta.get("mode"),
                        "files": meta.get("files") or [],
                        "schema_version": meta.get("schema_version"),
                    }
                )
    return [run for run in runs if run.get("import_id")]


def _evaluate_run(
    project,
    info: dict,
    run: dict,
    annotations: dict,
    baseline_cases: dict,
    invalid_files: list[str],
) -> dict:
    import_id = str(run["import_id"])
    labels = _field_labels(info["schema"])
    counts = {kind: 0 for kind in ERROR_KINDS}
    by_field: dict[str, dict] = {}
    calibration: dict[str, dict] = {
        bucket["key"]: {"correct": 0, "total": 0} for bucket in BUCKETS
    }
    case_stats: list[dict] = []
    roots: dict[int, dict | None] = {}
    truth_case_count = 0
    unannotated_case_count = 0
    invalid_case_count = 0

    def bump(field_path: str, kind: str, score: Any) -> None:
        counts[kind] += 1
        entry = by_field.setdefault(
            field_path,
            {"path": field_path, **{k: 0 for k in ERROR_KINDS}},
        )
        entry[kind] += 1
        bucket = _bucket_key(score)
        calibration[bucket]["total"] += 1
        if kind == "correct":
            calibration[bucket]["correct"] += 1

    for case_id, predicted in sorted(baseline_cases.items()):
        truth_ann = annotations.get(case_id)
        if not isinstance(truth_ann, dict):
            # 「还没人工标」不等于「模型全错」，不计入分母。
            unannotated_case_count += 1
            continue
        try:
            predicted_values, confidence = _remap_payload(project, info, predicted, roots)
            predicted_flat = schema.flatten_json(predicted_values)
            truth_flat = schema.flatten_json(truth_ann.get("values") or {})
        except (TypeError, ValueError, schema.SchemaError):
            invalid_case_count += 1
            continue
        truth_case_count += 1
        case_correct = 0
        case_total = 0
        for path in sorted(set(predicted_flat) | set(truth_flat)):
            before = predicted_flat.get(path)
            after = truth_flat.get(path)
            before_empty = _is_empty(before)
            after_empty = _is_empty(after)
            if before_empty and after_empty:
                continue
            score = confidence.get(path)
            if before_empty:
                kind = "missing"
            elif after_empty:
                kind = "extra"
            elif _norm(before) == _norm(after):
                kind = "correct"
            else:
                kind = "wrong"
            bump(_template(path), kind, score)
            case_total += 1
            if kind == "correct":
                case_correct += 1
        if case_total:
            case_stats.append(
                {
                    "case_id": case_id,
                    "accuracy": _ratio(case_correct, case_total),
                    "total": case_total,
                    "errors": case_total - case_correct,
                }
            )

    total = sum(counts.values())
    fields = []
    for entry in by_field.values():
        field_total = sum(entry[kind] for kind in ERROR_KINDS)
        fields.append(
            {
                "path": entry["path"],
                "label": labels.get(entry["path"], entry["path"]),
                "total": field_total,
                "correct": entry["correct"],
                "accuracy": _ratio(entry["correct"], field_total),
                "counts": {kind: entry[kind] for kind in ERROR_KINDS},
            }
        )
    fields.sort(key=lambda item: (item["accuracy"], -item["total"], item["path"]))

    buckets = []
    for bucket in BUCKETS:
        data = calibration[bucket["key"]]
        buckets.append(
            {
                "key": bucket["key"],
                "label": bucket["label"],
                "total": data["total"],
                "correct": data["correct"],
                "accuracy": _ratio(data["correct"], data["total"]),
            }
        )

    return {
        "import_id": import_id,
        "created_at": run.get("created_at"),
        "mode": run.get("mode"),
        "files": run.get("files") or [],
        "schema_version": run.get("schema_version"),
        "case_count": len(case_stats),
        "predicted_case_count": len(baseline_cases),
        "truth_case_count": truth_case_count,
        "unannotated_case_count": unannotated_case_count,
        "invalid_case_count": invalid_case_count,
        "invalid_file_count": len(invalid_files),
        "truth_definition": TRUTH_DEFINITION,
        "field_count": total,
        "accuracy": _ratio(counts["correct"], total),
        "counts": dict(counts),
        "by_field": fields,
        "calibration": buckets,
        "worst_cases": sorted(
            case_stats, key=lambda item: (item["accuracy"], -item["errors"])
        )[:10],
    }


def compute(project, info: dict) -> dict:
    """返回全部「可评分」导入版本的指标；无真值 / 无快照的版本列入 skipped_runs。"""
    runs = _list_runs(project)
    annotations = store.list_annotations(project)
    results: list[dict] = []
    skipped_runs: list[dict] = []
    for run in runs:
        import_id = str(run["import_id"])
        cases, invalid_files = _run_cases(project, import_id)
        if not cases:
            skipped_runs.append(
                {"import_id": import_id, "reason": "no baseline cases", "invalid_file_count": len(invalid_files)}
            )
            continue
        stats = _evaluate_run(project, info, run, annotations, cases, invalid_files)
        if not stats["field_count"]:
            skipped_runs.append(
                {
                    "import_id": import_id,
                    "reason": "no human ground truth for these cases",
                    "predicted_case_count": stats["predicted_case_count"],
                    "truth_case_count": stats["truth_case_count"],
                }
            )
            continue
        results.append(stats)
    return {
        "has_data": bool(results),
        "schema_version": info["version"],
        "truth_definition": TRUTH_DEFINITION,
        "run_count": len(results),
        "case_count": len(annotations),
        "skipped_runs": skipped_runs,
        "runs": results,
    }


def csv_text(result: dict) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(
        [
            "import_id",
            "created_at",
            "mode",
            "field_path",
            "label",
            "total",
            "correct",
            "wrong",
            "missing",
            "extra",
            "accuracy",
        ]
    )
    for run in result.get("runs") or []:
        for field in run["by_field"]:
            counts = field["counts"]
            writer.writerow(
                [
                    run["import_id"],
                    run.get("created_at") or "",
                    run.get("mode") or "",
                    field["path"],
                    field["label"],
                    field["total"],
                    counts["correct"],
                    counts["wrong"],
                    counts["missing"],
                    counts["extra"],
                    field["accuracy"],
                ]
            )
    return "\ufeff" + buffer.getvalue()
