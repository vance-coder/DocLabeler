/**
 * 多选批量改状态 / 打标签。
 *
 * 从 main.js 拆分而来；状态见 state.js，跨模块调用统一走 actions。
 */
import { state, ui, actions } from "./state.js";
import { api, projectUrl } from "./api.js";
import { escapeHtml, toast } from "./util.js";

// ---------------------------------------------------------------------------
// Bulk actions
// ---------------------------------------------------------------------------
function bulkBar() {
  return document.getElementById("bulk-bar");
}

function updateBulkBar() {
  const bar = bulkBar();
  if (!bar) return;
  const count = state.selected.size;
  bar.hidden = count === 0;
  const label = document.getElementById("bulk-count");
  if (label) label.textContent = `${count} selected`;
  if (!count) hideBulkTagRow();
  setBulkBusy(state.bulkBusy);
}

function setBulkBusy(busy) {
  const bar = bulkBar();
  if (!bar) return;
  bar.classList.toggle("busy", busy);
  bar.querySelectorAll("button, input").forEach((node) => {
    node.disabled = busy;
  });
}

function hideBulkTagRow() {
  document.querySelectorAll(".bulk-tag-row").forEach((row) => {
    row.hidden = true;
    row.dataset.mode = "";
  });
}

function tagsOf(item) {
  return item.annotation && Array.isArray(item.annotation.tags) ? item.annotation.tags : [];
}

/** 已有标签补全：Add 时排除所选图片都已有的标签，Remove 时只保留都有的标签。 */
function fillTagOptions(mode) {
  const options = document.getElementById("bulk-tag-options");
  if (!options) return;
  const selected = state.cases.filter((item) => state.selected.has(item.case_id));
  const counts = new Map();
  for (const item of selected) {
    for (const tag of new Set(tagsOf(item))) {
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }
  const total = selected.length;
  const tags = [...counts.entries()]
    .filter(([, count]) => (mode === "remove" ? count === total : count < total))
    .map(([tag]) => tag)
    .sort((a, b) => a.localeCompare(b));
  options.innerHTML = tags
    .map((tag) => `<option value="${escapeHtml(tag)}"></option>`)
    .join("");
}

/** 单张图片的标签补全：项目里已用过、且当前 case 还没有的标签。 */
function fillCaseTagOptions() {
  const options = document.getElementById("case-tag-options");
  if (!options) return;
  const current = new Set(
    ((state.annotation && state.annotation.tags) || []).map((tag) => String(tag).toLowerCase())
  );
  const tags = new Set();
  for (const item of state.cases) {
    for (const tag of tagsOf(item)) tags.add(tag);
  }
  options.innerHTML = [...tags]
    .filter((tag) => !current.has(tag.toLowerCase()))
    .sort((a, b) => a.localeCompare(b))
    .map((tag) => `<option value="${escapeHtml(tag)}"></option>`)
    .join("");
}

function activeBulkTagRow() {
  return document.getElementById("bulk-tag-row");
}

function showBulkTagRow(mode) {
  if (!state.selected.size) return;
  const row = activeBulkTagRow();
  if (!row) return;
  const input = row.querySelector("input");
  const apply = row.querySelector('button[type="submit"]');
  if (!input || !apply) return;
  row.dataset.mode = mode === "remove" ? "remove" : "add";
  row.hidden = false;
  fillTagOptions(row.dataset.mode);
  input.placeholder = row.dataset.mode === "remove" ? "Tag to remove" : "Tag to add";
  apply.textContent = row.dataset.mode === "remove" ? "Remove" : "Add";
  input.value = "";
  input.focus();
}

function onBulkBarClick(event) {
  const button = event.target.closest("[data-bulk-action]");
  if (!button) return;
  const action = button.dataset.bulkAction;
  if (action === "status") {
    runBulk({ action: "status", status: button.dataset.bulkStatus });
  } else if (action === "tag") {
    showBulkTagRow(button.dataset.bulkMode);
  }
}

function onBulkTagSubmit(event) {
  event.preventDefault();
  if (state.bulkBusy) return;
  const row = event.currentTarget;
  const input = row.querySelector("input");
  if (!input) return;
  const tags = [
    ...new Set(
      input.value
        .split(/[,，\s]+/)
        .map((tag) => tag.trim())
        .filter(Boolean)
    ),
  ];
  if (!tags.length) {
    toast("Enter a tag name", true);
    input.focus();
    return;
  }
  runBulk({
    action: row.dataset.mode === "remove" ? "remove_tags" : "add_tags",
    tags,
  });
}

function clearSelection() {
  state.selected.clear();
  actions.renderCaseList();
}

async function runBulk(payload) {
  if (state.bulkBusy || !state.selected.size || !state.projectId) return;
  if (state.dirty) {
    const saved = await actions.saveNow(true, { advance: false });
    if (!saved) return;
  }
  const caseIds = [...state.selected];
  if (!caseIds.length) {
    toast("No cases selected", true);
    return;
  }
  state.bulkBusy = true;
  setBulkBusy(true);
  try {
    const res = await api.post(
      projectUrl(state.projectId, "/annotations/bulk"),
      { case_ids: caseIds, ...payload }
    );
    const updatedById = new Map(
      (res.cases || []).map((item) => [item.case_id, item])
    );
    for (const item of state.cases) {
      const updated = updatedById.get(item.case_id);
      if (!updated) continue;
      const previous = item.annotation || {};
      item.annotation = {
        ...previous,
        status: updated.status,
        tags: updated.tags || [],
        updated_at: updated.updated_at,
        notes_count: previous.notes_count || 0,
        has_baseline: Boolean(previous.has_baseline),
        diff_count: previous.diff_count || 0,
      };
    }
    state.selected.clear();
    hideBulkTagRow();
    actions.renderCaseList();
    actions.updateProgress();
    if (updatedById.has(state.currentId)) {
      await actions.reloadAnnotation();
    }
    const updated = res.updated || 0;
    const skipped = (res.skipped || []).length;
    toast(
      `Updated ${updated} case${updated === 1 ? "" : "s"}` +
        (skipped ? ` · ${skipped} skipped` : "")
    );
  } catch (error) {
    toast(error.message, true);
  } finally {
    state.bulkBusy = false;
    setBulkBusy(false);
  }
}

Object.assign(actions, {
  bulkBar,
  updateBulkBar,
  setBulkBusy,
  hideBulkTagRow,
  fillCaseTagOptions,
  activeBulkTagRow,
  showBulkTagRow,
  onBulkBarClick,
  onBulkTagSubmit,
  clearSelection,
  runBulk,
});
