/**
 * Prompt / 模型迭代的回归对比面板。
 *
 * 数据来自每次导入的 baseline 快照与当前人工值（视为真值）：
 * 整体准确率、错误类型（改错 / 漏抽 / 多抽）、按字段准确率、置信度校准，
 * 以及任意两个导入版本之间的字段级变化。
 */
import { state, actions } from "./state.js";
import { api, projectUrl } from "./api.js";
import { openModal } from "./modal.js";
import { escapeHtml, toast } from "./util.js";

function pct(value) {
  return typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "—";
}

function pp(value) {
  const points = value * 100;
  const sign = points > 0 ? "+" : "";
  return `${sign}${points.toFixed(1)} pp`;
}

function deltaClass(value) {
  if (value > 0.0005) return "up";
  if (value < -0.0005) return "down";
  return "flat";
}

function fieldMap(run) {
  return new Map((run.by_field || []).map((field) => [field.path, field]));
}

function statCard(value, label) {
  return `<div class="stat-card"><div class="num">${escapeHtml(String(value))}</div><div class="label">${escapeHtml(label)}</div></div>`;
}

function section(title, extra) {
  const box = document.createElement("section");
  box.className = "metrics-section";
  const heading = document.createElement("h3");
  heading.textContent = title;
  box.appendChild(heading);
  if (extra) box.appendChild(extra);
  return box;
}

function renderOverview(target, data) {
  const runs = data.runs || [];
  const latest = runs[runs.length - 1];
  const best = runs.reduce(
    (top, run) => (!top || run.accuracy > top.accuracy ? run : top),
    null
  );
  const previous = runs.length > 1 ? runs[runs.length - 2] : null;
  const delta = latest && previous ? latest.accuracy - previous.accuracy : null;
  target.innerHTML = `<div class="stat-grid">
    ${statCard(runs.length, "Import runs")}
    ${statCard(data.case_count ?? 0, "Annotated cases")}
    ${statCard(latest ? pct(latest.accuracy) : "—", "Latest accuracy")}
    ${statCard(best ? pct(best.accuracy) : "—", "Best accuracy")}
    ${statCard(delta === null ? "—" : pp(delta), "vs previous")}
  </div>`;
}

function renderRunsTable(data) {
  const rows = (data.runs || [])
    .slice()
    .reverse()
    .map((run) => {
      const counts = run.counts || {};
      return `<tr>
        <td class="mono">${escapeHtml(run.import_id)}</td>
        <td>${escapeHtml(run.created_at || "-")}</td>
        <td>${escapeHtml(run.mode || "-")}</td>
        <td>${run.case_count}</td>
        <td>${run.field_count}</td>
        <td class="metrics-num">${pct(run.accuracy)}</td>
        <td>${counts.wrong || 0} / ${counts.missing || 0} / ${counts.extra || 0}</td>
      </tr>`;
    })
    .join("");
  return `<table class="data-table"><thead><tr>
      <th>Import</th><th>Created</th><th>Mode</th><th>Cases</th><th>Fields</th>
      <th>Accuracy</th><th>Wrong / Missing / Extra</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
}

function renderWorstFields(run) {
  const fields = (run.by_field || []).slice(0, 15);
  if (!fields.length) return `<div class="muted">No comparable fields in this run.</div>`;
  const rows = fields
    .map((field) => {
      const counts = field.counts || {};
      return `<tr>
        <td class="mono">${escapeHtml(field.path)}</td>
        <td>${escapeHtml(field.label)}</td>
        <td class="metrics-num">${pct(field.accuracy)}</td>
        <td>${field.total}</td>
        <td>${counts.wrong || 0} / ${counts.missing || 0} / ${counts.extra || 0}</td>
      </tr>`;
    })
    .join("");
  return `<table class="data-table"><thead><tr>
      <th>Field path</th><th>Label</th><th>Accuracy</th><th>Fields compared</th>
      <th>Wrong / Missing / Extra</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
}

function renderCalibration(run) {
  const buckets = run.calibration || [];
  const max = Math.max(1, ...buckets.map((bucket) => bucket.total));
  return buckets
    .map(
      (bucket) => `<div class="calibration-row">
        <span class="calibration-label">${escapeHtml(bucket.label)}</span>
        <span class="calibration-track"><span class="calibration-fill" style="width:${
          bucket.total ? Math.max(2, (bucket.total / max) * 100) : 0
        }%"></span></span>
        <span class="calibration-value">${bucket.total ? pct(bucket.accuracy) : "—"}</span>
        <span class="muted">${bucket.total} fields</span>
      </div>`
    )
    .join("");
}

function renderComparisonTable(runs, fromIndex, toIndex) {
  const from = runs[fromIndex];
  const to = runs[toIndex];
  if (!from || !to) return `<div class="muted">Select two runs to compare.</div>`;
  const a = fieldMap(from);
  const b = fieldMap(to);
  const paths = [...new Set([...a.keys(), ...b.keys()])];
  const rows = paths
    .map((path) => {
      const before = a.get(path);
      const after = b.get(path);
      const fromValue = before ? before.accuracy : 0;
      const toValue = after ? after.accuracy : 0;
      return { path, label: (after || before).label, fromValue, toValue, delta: toValue - fromValue };
    })
    .sort((left, right) => left.delta - right.delta || left.path.localeCompare(right.path))
    .slice(0, 40)
    .map(
      (row) => `<tr>
        <td class="mono">${escapeHtml(row.path)}</td>
        <td>${escapeHtml(row.label)}</td>
        <td class="metrics-num">${pct(row.fromValue)}</td>
        <td class="metrics-num">${pct(row.toValue)}</td>
        <td class="metrics-num delta ${deltaClass(row.delta)}">${pp(row.delta)}</td>
      </tr>`
    )
    .join("");
  return `<table class="data-table"><thead><tr>
      <th>Field path</th><th>Label</th><th>${escapeHtml(from.import_id)}</th>
      <th>${escapeHtml(to.import_id)}</th><th>Change</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
}

function openMetrics() {
  const modal = openModal({ title: "Prompt regression metrics", wide: true });
  const body = modal.body;
  const loading = document.createElement("div");
  loading.className = "muted";
  loading.textContent = "Loading metrics…";
  body.appendChild(loading);

  const overview = document.createElement("div");
  const comparison = section("Version comparison");
  const comparisonBody = document.createElement("div");
  comparison.appendChild(comparisonBody);
  const worst = section("Worst fields (latest run)");
  const worstBody = document.createElement("div");
  worst.appendChild(worstBody);
  const calibration = section("Confidence calibration (latest run)");
  const calibrationBody = document.createElement("div");
  calibration.appendChild(calibrationBody);
  const runsSection = section("All import runs");
  const runsBody = document.createElement("div");
  runsSection.appendChild(runsBody);
  for (const node of [overview, comparison, worst, calibration, runsSection]) {
    node.hidden = true;
    body.appendChild(node);
  }

  const download = document.createElement("a");
  download.className = "btn";
  download.textContent = "Download metrics.csv";
  download.href = projectUrl(state.projectId, "/metrics.csv");
  download.setAttribute("target", "_blank");
  download.hidden = true;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "btn primary";
  close.textContent = "Close";
  close.addEventListener("click", () => modal.close());
  modal.foot.appendChild(download);
  modal.foot.appendChild(close);

  api
    .get(projectUrl(state.projectId, "/metrics"))
    .then((data) => {
      loading.remove();
      const runs = data.runs || [];
      if (!runs.length) {
        const empty = document.createElement("div");
        empty.className = "empty-state";
        const skipped = Array.isArray(data.skipped_runs) ? data.skipped_runs.length : 0;
        empty.innerHTML = skipped
          ? `<i class="bi bi-graph-up" aria-hidden="true"></i><p>${skipped} baseline import(s) cannot be scored yet. Only cases with both a prediction and a human-corrected annotation count as ground truth — label those cases first.</p>`
          : `<i class="bi bi-graph-up" aria-hidden="true"></i><p>No baseline imports yet. Import model predictions once, correct them, then import the next prompt version to compare.</p>`;
        body.appendChild(empty);
        return;
      }
      if (Array.isArray(data.skipped_runs) && data.skipped_runs.length) {
        const note = document.createElement("div");
        note.className = "muted";
        note.style.marginBottom = "8px";
        note.textContent = `${data.skipped_runs.length} import(s) skipped: no human ground truth for their cases.`;
        body.appendChild(note);
      }
      renderOverview(overview, data);
      const latest = runs[runs.length - 1];
      worstBody.innerHTML = renderWorstFields(latest);
      calibrationBody.innerHTML = renderCalibration(latest);
      runsBody.innerHTML = renderRunsTable(data);

      const controls = document.createElement("div");
      controls.className = "metrics-controls";
      const fromSelect = document.createElement("select");
      const toSelect = document.createElement("select");
      for (const [index, run] of runs.entries()) {
        for (const select of [fromSelect, toSelect]) {
          const option = document.createElement("option");
          option.value = String(index);
          option.textContent = `${run.import_id} · ${pct(run.accuracy)}`;
          select.appendChild(option);
        }
      }
      fromSelect.value = String(Math.max(0, runs.length - 2));
      toSelect.value = String(runs.length - 1);
      const labelFrom = document.createElement("span");
      labelFrom.className = "muted";
      labelFrom.textContent = "Baseline";
      const labelTo = document.createElement("span");
      labelTo.className = "muted";
      labelTo.textContent = "Compare to";
      const arrow = document.createElement("span");
      arrow.className = "muted";
      arrow.textContent = "→";
      const help = document.createElement("div");
      help.className = "help";
      help.textContent = "Sorted by the biggest regressions first. Accuracy treats the current human-corrected values as ground truth.";
      controls.appendChild(labelFrom);
      controls.appendChild(fromSelect);
      controls.appendChild(arrow);
      controls.appendChild(labelTo);
      controls.appendChild(toSelect);
      comparison.insertBefore(controls, comparisonBody);
      comparison.insertBefore(help, comparisonBody);

      const table = document.createElement("div");
      const redraw = () => {
        table.innerHTML = renderComparisonTable(
          runs,
          Number(fromSelect.value),
          Number(toSelect.value)
        );
      };
      fromSelect.addEventListener("change", redraw);
      toSelect.addEventListener("change", redraw);
      redraw();
      comparisonBody.appendChild(table);

      for (const node of [overview, comparison, worst, calibration, runsSection]) {
        node.hidden = false;
      }
      download.hidden = false;
    })
    .catch((error) => {
      loading.textContent = `Failed to load metrics: ${error.message}`;
      toast(error.message, true);
    });
}

Object.assign(actions, {
  openMetrics,
});
