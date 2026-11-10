/**
 * 只读 JSON、舞台状态、保存状态与进度条。
 *
 * 从 main.js 拆分而来；状态见 state.js，跨模块调用统一走 actions。
 */
import { state, ui, actions, dom, scheduleSave } from "./state.js";
import { escapeHtml, toast } from "./util.js";

function rawJsonText() {
  return state.annotation ? JSON.stringify(state.annotation, null, 2) : "";
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightJson(text, query) {
  const pattern = new RegExp(escapeRegExp(query), "gi");
  let html = "";
  let last = 0;
  let count = 0;
  let match = pattern.exec(text);
  while (match) {
    html += escapeHtml(text.slice(last, match.index));
    html += `<mark>${escapeHtml(match[0])}</mark>`;
    last = match.index + match[0].length;
    count += 1;
    if (!match[0].length) pattern.lastIndex += 1;
    match = pattern.exec(text);
  }
  html += escapeHtml(text.slice(last));
  return { html, count };
}

function setRawMatchCount(count, active) {
  const node = document.getElementById("raw-match-count");
  if (!node) return;
  node.hidden = !active;
  node.classList.toggle("no-match", active && count === 0);
  node.textContent = active
    ? count
      ? `${count} match${count === 1 ? "" : "es"}`
      : "No matches"
    : "";
}

function renderRaw() {
  const node = document.getElementById("raw-json");
  if (!node) return;
  const text = rawJsonText();
  if (!ui.rawQuery) {
    node.textContent = text;
    setRawMatchCount(0, false);
    return;
  }
  const result = highlightJson(text, ui.rawQuery);
  node.innerHTML = result.html;
  setRawMatchCount(result.count, true);
}

function applyRawCollapsed() {
  const panel = document.getElementById("raw-panel");
  const toggle = document.getElementById("btn-raw-toggle");
  const pre = document.getElementById("raw-json");
  if (panel) panel.classList.toggle("collapsed", ui.rawCollapsed);
  if (pre) pre.hidden = ui.rawCollapsed;
  if (toggle) {
    toggle.setAttribute("aria-expanded", String(!ui.rawCollapsed));
    const chevron = toggle.querySelector(".raw-chevron");
    if (chevron) {
      chevron.className = `bi ${
        ui.rawCollapsed ? "bi-chevron-right" : "bi-chevron-down"
      } raw-chevron`;
    }
  }
}

function fallbackCopy(text) {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "-1000px";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } finally {
    area.remove();
  }
  if (!ok) throw new Error("Copy failed");
}

async function copyRawJson() {
  const text = rawJsonText();
  if (!text) {
    toast("Nothing to copy", true);
    return;
  }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      fallbackCopy(text);
    }
    toast("JSON copied");
  } catch (error) {
    try {
      fallbackCopy(text);
      toast("JSON copied");
    } catch (fallbackError) {
      toast("Copy failed", true);
    }
  }
}

function setStageState(kind) {
  const stage = document.getElementById("viewer-stage");
  const loading = document.getElementById("stage-loading");
  const placeholder = document.getElementById("stage-placeholder");
  const retry = document.getElementById("btn-retry-image");
  if (stage) stage.classList.toggle("image-error", kind === "error");
  if (loading) loading.hidden = kind !== "loading";
  if (retry) retry.hidden = kind !== "error";
  if (!placeholder) return;
  placeholder.hidden = kind === "image" || kind === "loading";
  const icon = placeholder.querySelector(".stage-icon");
  const text = placeholder.querySelector(".stage-text");
  if (kind === "error") {
    if (icon) icon.className = "bi bi-exclamation-triangle stage-icon";
    if (text) text.textContent = "Image failed to load";
  } else {
    if (icon) icon.className = "bi bi-images stage-icon";
    if (text) text.textContent = "Select a case to preview";
  }
}

function renderEmptyCase(message) {
  if (ui.viewer) ui.viewer.clear();
  setStageState("empty");
  const source = document.getElementById("case-source");
  if (source) {
    source.textContent = "";
    source.title = "";
  }
  const copyButton = document.getElementById("btn-copy-filename");
  if (copyButton) copyButton.hidden = true;
  const tagChips = document.getElementById("case-tags");
  if (tagChips) tagChips.innerHTML = "";
  const tagsInput = document.getElementById("tags-input");
  if (tagsInput) tagsInput.value = "";
  const warning = document.getElementById("case-warning");
  if (warning) {
    warning.textContent = "";
    warning.className = "";
  }
  const form = document.getElementById("form-scroll");
  if (form) {
    form.innerHTML = `<div class="empty-state"><i class="bi bi-card-image" aria-hidden="true"></i><p>${escapeHtml(message)}</p></div>`;
  }
  state.annotation = null;
  state.values = null;
  state.diffFields = [];
  state.imageUrl = "";
  actions.resetHistory(null);
  renderRaw();
  actions.updateRequiredBanner([]);
  actions.updateValidationBanner(0, "");
  actions.updateDiffBar();
  actions.syncEvidence();
  syncGlobalFromEmpty();
}

function syncGlobalFromEmpty() {
  const node = document.getElementById("save-state");
  if (node) {
    node.className = "save-state";
    node.textContent = "Not loaded";
  }
  const globalNode = document.getElementById("global-save-state");
  if (globalNode) {
    globalNode.className = "global-save-state";
    globalNode.textContent = "Not loaded";
  }
}

function markDirty() {
  if (!state.annotation) return;
  state.dirty = true;
  setSaveState("dirty", "Unsaved changes");
  actions.updateRequiredBanner();
  if (state.conflict) return;
  scheduleSave();
}

function globalSaveText(kind, text) {
  if (kind === "saved") {
    const matched = /(\d{2}:\d{2}:\d{2})\s*$/.exec(text || "");
    return matched ? `Saved ${matched[1]}` : "Saved";
  }
  return text || "Not loaded";
}

function setSaveState(kind, text) {
  const node = document.getElementById("save-state");
  if (node) {
    node.className = `save-state ${kind}`;
    node.textContent = text;
  }
  const globalNode = document.getElementById("global-save-state");
  if (globalNode) {
    globalNode.className = `global-save-state ${kind}`;
    globalNode.textContent = globalSaveText(kind, text);
  }
}

function updateProgress() {
  const total = state.cases.length;
  const done = state.cases.filter(
    (item) => item.annotation && item.annotation.status === "done"
  ).length;
  const pending = state.cases.filter(
    (item) => !item.annotation || item.annotation.status !== "done"
  ).length;
  const label = `Done ${done} / ${total} · Pending ${pending}`;
  const text = document.getElementById("progress-text");
  if (text) text.textContent = label;
  const fill = document.getElementById("progress-fill");
  if (fill) fill.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
  const wrap = document.getElementById("topbar-progress");
  if (wrap) {
    wrap.title = label;
    wrap.setAttribute("aria-label", label);
  }
}

function showConflictBanner() {
  if (!dom.conflictBanner) return;
  dom.conflictBanner.hidden = false;
  document.body.classList.add("has-banner");
}

function hideConflictBanner() {
  state.conflict = false;
  if (!dom.conflictBanner) return;
  dom.conflictBanner.hidden = true;
  document.body.classList.remove("has-banner");
}

Object.assign(actions, {
  rawJsonText,
  escapeRegExp,
  highlightJson,
  setRawMatchCount,
  renderRaw,
  applyRawCollapsed,
  fallbackCopy,
  copyRawJson,
  setStageState,
  renderEmptyCase,
  syncGlobalFromEmpty,
  markDirty,
  globalSaveText,
  setSaveState,
  updateProgress,
  showConflictBanner,
  hideConflictBanner,
});
