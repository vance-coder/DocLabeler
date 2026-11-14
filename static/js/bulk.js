/**
 * 多选批量改状态 / 打标签。
 *
 * 从 main.js 拆分而来；状态见 state.js，跨模块调用统一走 actions。
 */
import { state, ui, actions } from "./state.js";
import { api, projectUrl } from "./api.js";
import { escapeHtml, toast } from "./util.js";
import { openModal } from "./modal.js";

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

// ---------------------------------------------------------------------------
// 项目级标签管理：全 case 改名 / 删除
// ---------------------------------------------------------------------------

// 与后端同口径：大小写不敏感匹配；改名后去重保留先出现的写法（合并到已有标签）。
function transformTags(list, action, tag, newTag) {
  const key = tag.toLowerCase();
  const tags = (Array.isArray(list) ? list : []).map((t) => String(t));
  if (action === "delete") return tags.filter((t) => t.toLowerCase() !== key);
  const seen = new Set();
  const out = [];
  for (const t of tags.map((t) => (t.toLowerCase() === key ? newTag : t))) {
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

function tagRowHtml(tag, count, mode) {
  const head = `<span class="tag-manager-name" title="${escapeHtml(tag)}"><i class="bi bi-tag" aria-hidden="true"></i>${escapeHtml(tag)}</span><span class="chip-count">${count}</span><span class="flex-grow-1"></span>`;
  if (mode === "rename") {
    return `${head}<input type="text" value="${escapeHtml(tag)}" aria-label="New tag name" autocomplete="off" spellcheck="false" /><button type="button" class="btn small primary" data-tag-action="apply-rename">Apply</button><button type="button" class="btn small ghost" data-tag-action="cancel">Cancel</button>`;
  }
  if (mode === "delete") {
    return `${head}<span class="tag-manager-confirm">Delete from ${count} case${count === 1 ? "" : "s"}?</span><button type="button" class="btn small danger" data-tag-action="apply-delete">Confirm</button><button type="button" class="btn small ghost" data-tag-action="cancel">Cancel</button>`;
  }
  return `${head}<button type="button" class="btn small" data-tag-action="rename">Rename</button><button type="button" class="btn small danger" data-tag-action="delete">Delete</button>`;
}

function openTagManager() {
  const counts = actions.tagCounts(state.cases);
  if (!counts.length) {
    toast("No tags in this project");
    return;
  }
  const modal = openModal({ title: "Manage tags" });
  let busy = false;
  const setBusy = (value) => {
    busy = value;
    modal.body.querySelectorAll("button, input").forEach((node) => {
      node.disabled = value;
    });
  };
  modal.body.innerHTML = `
    <p class="muted" style="margin:0 0 10px">Rename or delete a tag across every case in this project. Renaming to an existing tag merges them.</p>
    <div class="tag-manager-list">${counts
      .map(
        ([tag, count]) =>
          `<div class="tag-manager-row" data-tag="${escapeHtml(tag)}" data-count="${count}">${tagRowHtml(tag, count, null)}</div>`
      )
      .join("")}</div>`;

  const rerender = (row, mode) => {
    row.innerHTML = tagRowHtml(row.dataset.tag, Number(row.dataset.count) || 0, mode);
    const input = row.querySelector("input");
    if (input) {
      input.focus();
      input.select();
    }
  };

  const runManage = async (row, payload) => {
    setBusy(true);
    try {
      const res = await api.post(projectUrl(state.projectId, "/tags/manage"), payload);
      const key = payload.tag.toLowerCase();
      for (const item of state.cases) {
        if (item.annotation && Array.isArray(item.annotation.tags)) {
          item.annotation.tags = transformTags(
            item.annotation.tags,
            payload.action,
            payload.tag,
            payload.new_tag
          );
        }
      }
      if (state.tagFilter && state.tagFilter.toLowerCase() === key) {
        state.tagFilter = payload.action === "rename" ? payload.new_tag : "";
      }
      const affectedCurrent =
        state.annotation &&
        Array.isArray(state.annotation.tags) &&
        state.annotation.tags.some((t) => String(t).toLowerCase() === key);
      modal.close();
      actions.renderCaseList();
      // 后端已 bump rev，当前 case 受影响时重拉，避免下次保存 409。
      if (affectedCurrent) await actions.reloadAnnotation();
      const skipped = (res.skipped || []).length;
      toast(
        `${payload.action === "rename" ? "Renamed" : "Deleted"} tag on ${res.updated || 0} case${res.updated === 1 ? "" : "s"}` +
          (skipped ? ` · ${skipped} skipped` : "")
      );
    } catch (error) {
      toast(error.message, true);
      setBusy(false);
    }
  };

  modal.body.addEventListener("click", (event) => {
    const button = event.target.closest("[data-tag-action]");
    if (!button || busy) return;
    const row = button.closest(".tag-manager-row");
    if (!row) return;
    const tag = row.dataset.tag;
    const count = Number(row.dataset.count) || 0;
    const action = button.dataset.tagAction;
    if (action === "rename" || action === "delete") rerender(row, action);
    else if (action === "cancel") rerender(row, null);
    else if (action === "apply-rename") {
      const input = row.querySelector("input");
      const newTag = input ? input.value.trim() : "";
      if (!newTag) {
        toast("Enter a new tag name", true);
        if (input) input.focus();
        return;
      }
      if (newTag.toLowerCase() === tag.toLowerCase()) {
        toast("New name is the same tag", true);
        return;
      }
      runManage(row, { action: "rename", tag, new_tag: newTag });
    } else if (action === "apply-delete") {
      runManage(row, { action: "delete", tag });
    }
  });
  modal.body.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || busy) return;
    const input = event.target.closest(".tag-manager-row input");
    if (!input) return;
    event.preventDefault();
    const apply = input.closest(".tag-manager-row").querySelector('[data-tag-action="apply-rename"]');
    if (apply) apply.click();
  });
  const close = document.createElement("button");
  close.type = "button";
  close.className = "btn";
  close.textContent = "Close";
  close.addEventListener("click", modal.close);
  modal.foot.appendChild(close);
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
  openTagManager,
});
