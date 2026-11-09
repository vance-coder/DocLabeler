/**
 * 批量确认与抽样复核队列。
 *
 * 预览与执行走同一个后端算法（确定性 hash 抽样），所以「预览里看到的」就是
 * 「点确认后发生的」；抽样命中的 case 保留 draft 并打标签，进入人工队列。
 */
import { state, actions, SAMPLE_TAG } from "./state.js";
import { api, projectUrl } from "./api.js";
import { openModal } from "./modal.js";
import { escapeHtml, toast } from "./util.js";

function mk(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function optionRow(labelText, control, help) {
  const row = mk("div", "form-row");
  row.appendChild(mk("label", "", labelText));
  row.appendChild(control);
  if (help) row.appendChild(mk("div", "help", help));
  return row;
}

function checkbox(labelText, checked) {
  const label = mk("label", "review-check");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  label.appendChild(input);
  label.appendChild(document.createTextNode(" " + labelText));
  label.input = input;
  return label;
}

function numberInput(value, step, min, max) {
  const input = document.createElement("input");
  input.type = "number";
  input.value = String(value);
  input.step = String(step);
  input.min = String(min);
  input.max = String(max);
  return input;
}

function reasonSummary(skipped) {
  const counts = new Map();
  for (const entry of skipped || []) {
    const reason = entry.reason || "unknown";
    counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function renderPreview(target, res) {
  const stats = res.stats || {};
  const cards = [
    ["Candidates", stats.candidates ?? 0],
    ["Eligible", stats.eligible ?? 0],
    ["Will confirm", stats.to_confirm ?? 0],
    ["Sampled for review", stats.sampled ?? 0],
    ["Skipped", stats.skipped ?? 0],
  ]
    .map(
      ([label, value]) =>
        `<div class="stat-card"><div class="num">${value}</div><div class="label">${escapeHtml(label)}</div></div>`
    )
    .join("");
  const reasons = reasonSummary(res.skipped)
    .slice(0, 8)
    .map(
      ([reason, count]) =>
        `<tr><td>${escapeHtml(reason)}</td><td>${count}</td></tr>`
    )
    .join("");
  const sampleIds = (res.sampled || []).slice(0, 12);
  target.innerHTML = `
    <div class="stat-grid">${cards}</div>
    <div class="muted" style="margin:10px 0 6px">Threshold ${Math.round(
      (res.options?.threshold ?? 0) * 100
    )}% · sample ${Math.round((res.options?.sample_rate ?? 0) * 100)}% ·
      tag <span class="mono">${escapeHtml(res.options?.sample_tag || SAMPLE_TAG)}</span></div>
    ${reasons ? `<table class="data-table"><thead><tr><th>Skip reason</th><th>Cases</th></tr></thead><tbody>${reasons}</tbody></table>` : ""}
    ${
      sampleIds.length
        ? `<div class="muted" style="margin-top:10px">Sampled cases (kept for manual review):</div>
           <div class="mono" style="margin-top:4px">${sampleIds.map(escapeHtml).join(", ")}${
             (res.sampled || []).length > sampleIds.length ? " …" : ""
           }</div>`
        : ""
    }
  `;
}

async function syncReviewResult(res) {
  const byId = new Map((res.cases || []).map((item) => [item.case_id, item]));
  for (const item of state.cases) {
    const updated = byId.get(item.case_id);
    if (!updated) continue;
    const previous = item.annotation || {};
    item.annotation = {
      ...previous,
      status: updated.status,
      tags: updated.tags || [],
      updated_at: updated.updated_at,
    };
  }
  actions.renderCaseList();
  actions.updateProgress();
  if (byId.has(state.currentId)) await actions.reloadAnnotation();
}

function openReviewQueue() {
  const modal = openModal({ title: "Batch confirm & sampling queue", wide: true });
  const intro = mk(
    "p",
    "muted",
    "Auto-confirm predictions that are high-confidence, untouched, complete and rule-clean. A deterministic sample is kept for mandatory human review."
  );
  intro.style.margin = "0 0 12px";
  modal.body.appendChild(intro);

  const scope = document.createElement("select");
  scope.innerHTML = `
    <option value="filter">Current filter (${actions.filteredCases().length} cases)</option>
    <option value="all">All cases in project (${state.cases.length})</option>
  `;
  const threshold = numberInput(0.95, 0.01, 0, 1);
  const rate = numberInput(10, 1, 0, 100);
  const clean = checkbox("No corrected fields", true);
  const required = checkbox("All required fields filled", true);
  const tag = mk("input");
  tag.type = "text";
  tag.value = SAMPLE_TAG;

  modal.body.appendChild(optionRow("Scope", scope));
  modal.body.appendChild(
    optionRow("Minimum confidence", threshold, "0–1. Fields without a confidence score are never auto-confirmed.")
  );
  modal.body.appendChild(
    optionRow("Manual sample (%)", rate, "Deterministic per case: the same sample is kept on preview and apply.")
  );
  const flags = mk("div", "review-flags");
  flags.appendChild(clean);
  flags.appendChild(required);
  modal.body.appendChild(optionRow("Extra checks", flags, "Cross-field rule errors always disqualify a case."));
  modal.body.appendChild(optionRow("Sample tag", tag));

  const message = mk("div", "schema-msg");
  modal.body.appendChild(message);
  const result = mk("div", "review-result");
  modal.body.appendChild(result);

  const payload = () => {
    const body = {
      threshold: Number(threshold.value),
      sample_rate: Number(rate.value) / 100,
      require_clean: clean.input.checked,
      require_required: required.input.checked,
      sample_tag: tag.value.trim() || SAMPLE_TAG,
    };
    // "All" 不传 case_ids；"filter" 一定传明文列表（含空列表），
    // 后端据此区分「当前过滤为空」与「整个项目」。
    if (scope.value === "filter") {
      body.case_ids = actions.filteredCases().map((item) => item.case_id);
    }
    return body;
  };

  let previewed = false;
  let previewPayload = "";
  const preview = mk("button", "btn");
  preview.textContent = "Preview";
  preview.addEventListener("click", async () => {
    preview.disabled = true;
    message.textContent = "";
    try {
      const res = await api.post(projectUrl(state.projectId, "/review/preview"), payload());
      renderPreview(result, res);
      previewed = true;
      previewPayload = JSON.stringify(payload());
    } catch (error) {
      message.textContent = error.message;
    } finally {
      preview.disabled = false;
    }
  });

  const apply = mk("button", "btn primary");
  apply.textContent = "Confirm eligible cases";
  apply.addEventListener("click", async () => {
    if (!previewed) {
      message.textContent = "Run a preview first.";
      return;
    }
    if (previewPayload !== JSON.stringify(payload())) {
      message.textContent = "Options changed. Run a preview again.";
      previewed = false;
      return;
    }
    if (state.dirty) {
      const saved = await actions.saveNow(true, { advance: false });
      if (!saved) return;
    }
    apply.disabled = true;
    message.textContent = "";
    try {
      const res = await api.post(projectUrl(state.projectId, "/review/apply"), payload());
      await syncReviewResult(res);
      renderPreview(result, {
        stats: {
          candidates: res.confirmed + res.kept_for_review,
          eligible: res.confirmed + res.kept_for_review,
          to_confirm: res.confirmed,
          sampled: res.kept_for_review,
          skipped: (res.skipped || []).length,
        },
        options: { threshold: Number(threshold.value), sample_rate: Number(rate.value) / 100, sample_tag: res.sample_tag },
        sampled: (res.cases || []).filter((item) => item.status !== "done").map((item) => item.case_id),
        skipped: res.skipped,
      });
      toast(`Confirmed ${res.confirmed} · kept ${res.kept_for_review} for review`);
      message.textContent = `Done. Use the “Sample” filter to review the kept cases.`;
    } catch (error) {
      message.textContent = error.message;
    } finally {
      apply.disabled = false;
    }
  });

  const close = mk("button", "btn");
  close.textContent = "Close";
  close.addEventListener("click", () => modal.close());
  modal.foot.appendChild(close);
  modal.foot.appendChild(preview);
  modal.foot.appendChild(apply);
}

Object.assign(actions, {
  openReviewQueue,
});
