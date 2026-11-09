/**
 * 字段级 undo / redo（按 case 保存在内存中）。
 *
 * 从 main.js 拆分而来；状态见 state.js，跨模块调用统一走 actions。
 */
import { state, history, actions, scheduleSave } from "./state.js";

// ---------------------------------------------------------------------------
// Field-level undo/redo (per case, in memory only)
// ---------------------------------------------------------------------------
const HISTORY_LIMIT = 50;
const HISTORY_MERGE_MS = 800;

function cloneValues(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    return value;
  }
}

function resetHistory(caseId) {
  history.caseId = caseId || null;
  history.undo = [];
  history.redo = [];
  history.lastPath = null;
  history.lastAt = 0;
  updateUndoButtons();
}

function ensureHistoryCase() {
  if (history.caseId !== state.currentId) resetHistory(state.currentId);
}

function updateUndoButtons() {
  const undo = document.getElementById("btn-undo");
  const redo = document.getElementById("btn-redo");
  if (undo) undo.disabled = history.undo.length === 0;
  if (redo) redo.disabled = history.redo.length === 0;
}

function recordFieldCommit({ path, before, after }) {
  if (!state.currentId || !state.annotation || !path) return;
  if (before === after) return;
  ensureHistoryCase();
  const now = Date.now();
  const top = history.undo[history.undo.length - 1];
  const merge =
    top &&
    top.kind === "field" &&
    top.path === path &&
    history.lastPath === path &&
    now - history.lastAt <= HISTORY_MERGE_MS;
  if (merge) {
    top.after = after;
    if (top.before === top.after) history.undo.pop();
  } else {
    history.undo.push({ kind: "field", path, before, after });
    if (history.undo.length > HISTORY_LIMIT) history.undo.shift();
  }
  history.redo = [];
  history.lastPath = path;
  history.lastAt = now;
  updateUndoButtons();
}

function recordStructureChange({ before, after, label }) {
  if (!state.currentId || !state.annotation) return;
  ensureHistoryCase();
  history.undo.push({
    kind: "snapshot",
    before: cloneValues(before),
    after: cloneValues(after),
    label: label || "array",
  });
  if (history.undo.length > HISTORY_LIMIT) history.undo.shift();
  history.redo = [];
  history.lastPath = null;
  history.lastAt = 0;
  updateUndoButtons();
}

function parseFieldPath(path) {
  const parts = [];
  let buffer = "";
  let index = 0;
  const pushBuffer = () => {
    if (buffer) {
      parts.push(buffer);
      buffer = "";
    }
  };
  while (index < path.length) {
    const char = path[index];
    if (char === "\\") {
      if (index + 1 < path.length) {
        buffer += path[index + 1];
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }
    if (char === ".") {
      pushBuffer();
      index += 1;
      continue;
    }
    if (char === "[") {
      pushBuffer();
      let cursor = index + 1;
      let digits = "";
      while (cursor < path.length && path[cursor] !== "]") {
        digits += path[cursor];
        cursor += 1;
      }
      parts.push({ index: Number(digits) });
      index = cursor < path.length ? cursor + 1 : cursor;
      continue;
    }
    buffer += char;
    index += 1;
  }
  pushBuffer();
  return parts;
}

function getValueAtPath(values, path) {
  const parts = parseFieldPath(path);
  let node = values;
  for (const part of parts) {
    if (part && typeof part === "object") {
      if (!Array.isArray(node)) return undefined;
      node = node[part.index];
    } else {
      if (node === null || typeof node !== "object") return undefined;
      node = node[part];
    }
  }
  return node;
}

function setValueAtPath(values, path, value) {
  const parts = parseFieldPath(path);
  if (!parts.length) return false;
  let node = values;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (part && typeof part === "object") {
      if (!Array.isArray(node)) return false;
      node = node[part.index];
    } else {
      if (node === null || typeof node !== "object" || Array.isArray(node)) return false;
      node = node[part];
    }
    if (node === undefined || node === null) return false;
  }
  const last = parts[parts.length - 1];
  if (last && typeof last === "object") {
    if (!Array.isArray(node)) return false;
    node[last.index] = value;
    return true;
  }
  if (node === null || typeof node !== "object" || Array.isArray(node)) return false;
  node[last] = value;
  return true;
}

function applyHistoryEntry(entry, useBefore) {
  if (!entry) return false;
  if (entry.kind === "snapshot") {
    state.values = cloneValues(useBefore ? entry.before : entry.after);
    return true;
  }
  return setValueAtPath(state.values, entry.path, useBefore ? entry.before : entry.after);
}

function currentFormFocusPath() {
  const active = document.activeElement;
  const container = document.getElementById("form-scroll");
  if (!active || !container || !container.contains(active)) return "";
  const row = active.closest ? active.closest(".field") : null;
  return row ? row.dataset.path || "" : "";
}

function restoreFormFocus(path) {
  if (!path) return;
  const container = document.getElementById("form-scroll");
  const info = container && container._fieldMap ? container._fieldMap.get(path) : null;
  if (!info) return;
  const target = info.row.querySelector('input[type="text"], select');
  if (target) target.focus({ preventScroll: true });
}

function afterHistoryApply() {
  const focusPath = currentFormFocusPath();
  actions.renderFormArea();
  actions.markDirty();
  scheduleSave();
  if (!state.conflict) actions.saveNow(false, { advance: false });
  restoreFormFocus(focusPath);
  updateUndoButtons();
}

function undoEdit() {
  ensureHistoryCase();
  if (!state.currentId || !state.annotation || !state.values) return false;
  const entry = history.undo[history.undo.length - 1];
  if (!entry) return false;
  if (!applyHistoryEntry(entry, true)) return false;
  history.undo.pop();
  history.redo.push(entry);
  history.lastPath = null;
  history.lastAt = 0;
  afterHistoryApply();
  return true;
}

function redoEdit() {
  ensureHistoryCase();
  if (!state.currentId || !state.annotation || !state.values) return false;
  const entry = history.redo[history.redo.length - 1];
  if (!entry) return false;
  if (!applyHistoryEntry(entry, false)) return false;
  history.redo.pop();
  history.undo.push(entry);
  history.lastPath = null;
  history.lastAt = 0;
  afterHistoryApply();
  return true;
}

Object.assign(actions, {
  cloneValues,
  resetHistory,
  ensureHistoryCase,
  updateUndoButtons,
  recordFieldCommit,
  recordStructureChange,
  parseFieldPath,
  getValueAtPath,
  setValueAtPath,
  applyHistoryEntry,
  currentFormFocusPath,
  restoreFormFocus,
  afterHistoryApply,
  undoEdit,
  redoEdit,
});
