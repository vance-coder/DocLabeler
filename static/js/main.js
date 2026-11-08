import { api, projectUrl } from "./api.js";
import {
  debounce,
  escapeHtml,
  formatTime,
  isEmptyValue,
  isPlainObject,
  joinPath,
  toast,
} from "./util.js";
import { applyDiff, renderForm } from "./form.js";
import { createViewer } from "./viewer.js";
import { openSchemaEditor } from "./schema_editor.js";
import { openModal } from "./modal.js";
import {
  openCollectionNameModal,
  openCreateProjectModal,
  openExportModal,
  openImportModal,
} from "./modals.js";
import { openNotesPromptModal } from "./notes.js";

const view = document.getElementById("view");
const topCenter = document.getElementById("topbar-center");
const topActions = document.getElementById("topbar-actions");
const conflictBanner = document.getElementById("conflict-banner");

const AUTO_ADVANCE_KEY = "doclabeler.autoAdvance";
const PANES_KEY = "doclabeler.panes";
const RIGHT_COLLAPSED_KEY = "doclabeler.rightCollapsed";
const RAW_COLLAPSED_KEY = "doclabeler.rawCollapsed";
const ONLY_CHANGED_KEY = "doclabeler.onlyChanged";
const LEFT_TAB_KEY = "doclabeler.leftTab";
const COLLECTION_KEY = "doclabeler.collection";

const LEFT_MIN = 240;
const LEFT_MAX = 560;
const RIGHT_MIN = 360;
const RIGHT_MAX = 640;
const CENTER_MIN = 360;
const PANE_DIVIDERS = 10;
const DEFAULT_PANES = { left: 300, right: 430 };

function readAutoAdvance() {
  try {
    return localStorage.getItem(AUTO_ADVANCE_KEY) === "1";
  } catch (error) {
    return false;
  }
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function readFlag(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value === "1";
  } catch (error) {
    return fallback;
  }
}

function writeFlag(key, value) {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch (error) {
    /* storage may be unavailable */
  }
}

function readLeftTab() {
  try {
    return localStorage.getItem(LEFT_TAB_KEY) === "collections"
      ? "collections"
      : "images";
  } catch (error) {
    return "images";
  }
}

function writeLeftTab(tab) {
  try {
    localStorage.setItem(LEFT_TAB_KEY, tab);
  } catch (error) {
    /* storage may be unavailable */
  }
}

function readSavedCollection() {
  try {
    const raw = localStorage.getItem(COLLECTION_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data.name !== "string" || !data.name) return null;
    return {
      projectId: data.projectId || null,
      name: data.name,
    };
  } catch (error) {
    return null;
  }
}

function writeSavedCollection(name) {
  try {
    localStorage.setItem(
      COLLECTION_KEY,
      JSON.stringify({ projectId: state.projectId, name })
    );
  } catch (error) {
    /* storage may be unavailable */
  }
}

function clearSavedCollection() {
  try {
    localStorage.removeItem(COLLECTION_KEY);
  } catch (error) {
    /* storage may be unavailable */
  }
}

function readPanes() {
  let left = DEFAULT_PANES.left;
  let right = DEFAULT_PANES.right;
  try {
    const raw = JSON.parse(localStorage.getItem(PANES_KEY) || "null");
    if (raw && typeof raw.left === "number") left = clampNumber(raw.left, LEFT_MIN, LEFT_MAX);
    if (raw && typeof raw.right === "number") right = clampNumber(raw.right, RIGHT_MIN, RIGHT_MAX);
  } catch (error) {
    /* keep defaults */
  }
  return { left, right };
}

const paneLayout = readPanes();
let rightCollapsed = readFlag(RIGHT_COLLAPSED_KEY, false);
let rawCollapsed = readFlag(RAW_COLLAPSED_KEY, true);
let rawQuery = "";
let thumbObserver = null;
let thumbSignature = "";
let lastThumbActive = null;
let stageObserver = null;
let fitFrame = null;

const FILTERS = [
  { key: "all", label: "All" },
  { key: "modified", label: "Modified" },
  { key: "unlabeled", label: "Unlabeled" },
  { key: "done", label: "Done" },
  { key: "notes", label: "With notes" },
];

const state = {
  projects: [],
  projectId: null,
  project: null,
  schemaInfo: null,
  index: null,
  cases: [],
  filter: "all",
  selected: new Set(),
  currentId: null,
  annotation: null,
  values: null,
  diffFields: [],
  dirty: false,
  saving: false,
  pendingSave: false,
  search: "",
  autoAdvance: readAutoAdvance(),
  onlyChanged: readFlag(ONLY_CHANGED_KEY, false),
  bulkBusy: false,
  revertingAll: false,
  conflict: false,
  imageUrl: "",
  leftTab: readLeftTab(),
  collections: [],
  collectionName: null,
  collectionIds: [],
  collectionBusy: false,
};

let viewer = null;
let presentation = null;
const scheduleSave = debounce(() => {
  saveNow(false, { advance: false, auto: true });
}, 1000);

// ---------------------------------------------------------------------------
// Field-level undo/redo (per case, in memory only)
// ---------------------------------------------------------------------------
const HISTORY_LIMIT = 50;
const HISTORY_MERGE_MS = 800;
const history = {
  caseId: null,
  undo: [],
  redo: [],
  lastPath: null,
  lastAt: 0,
};

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
  renderFormArea();
  markDirty();
  scheduleSave();
  if (!state.conflict) saveNow(false, { advance: false });
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

function resetCollectionView({ keepTab = false } = {}) {
  state.collections = [];
  state.collectionName = null;
  state.collectionIds = [];
  state.selected = new Set();
  clearSavedCollection();
  if (!keepTab) {
    state.leftTab = "images";
    writeLeftTab("images");
  }
}

function collectionActive() {
  return state.leftTab === "collections" && Boolean(state.collectionName);
}

function collectionCases() {
  if (!state.collectionName) return [];
  const ids = new Set(state.collectionIds);
  return state.cases.filter((item) => ids.has(item.case_id));
}

function normalizeCollectionIds() {
  if (!state.collectionName) return;
  const known = new Set(state.cases.map((item) => item.case_id));
  state.collectionIds = state.collectionIds.filter((id) => known.has(id));
}

function scopedCases() {
  return collectionActive() ? collectionCases() : state.cases;
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------
async function route() {
  const hash = location.hash || "#/";
  const matched = hash.match(/^#\/p\/([^/?#]+)/);
  if (matched) {
    await openProject(decodeURIComponent(matched[1]));
  } else {
    await renderProjects();
  }
}

async function renderProjects() {
  if (presentation) closePresentation();
  if (state.dirty) {
    try {
      await saveNow(true);
    } catch (error) {
      /* 保持原样 */
    }
  }
  state.projectId = null;
  state.currentId = null;
  state.annotation = null;
  state.dirty = false;
  state.search = "";
  state.imageUrl = "";
  resetCollectionView();
  hideConflictBanner();
  topCenter.innerHTML = "";
  topActions.innerHTML = "";
  if (viewer) {
    viewer = null;
  }
  try {
    const data = await api.get("/api/projects");
    state.projects = data.projects;
    topCenter.innerHTML = `<span class="workspace-path" title="${escapeHtml(data.workspace)}"><i class="bi bi-hdd-network"></i><span>Workspace: ${escapeHtml(data.workspace)}</span></span>`;
    const cards = data.projects
      .map(
        (project) => `
        <article class="project-card" data-id="${escapeHtml(project.project_id)}">
          <div class="project-card-head">
            <span class="project-icon"><i class="bi bi-folder2"></i></span>
            <h3>${escapeHtml(project.name)}</h3>
          </div>
          <div class="desc">${escapeHtml(project.description || "(No description)")}</div>
          <div class="path"><i class="bi bi-images"></i>${escapeHtml(project.images_dir)}</div>
          <div class="meta-row">
            <span class="meta-pill"><i class="bi bi-card-image"></i>${project.case_count} images</span>
            <span class="meta-pill">schema v${project.schema_version ?? "-"}</span>
            <span class="meta-pill">${project.field_count || 0} fields</span>
          </div>
        </article>`
      )
      .join("");
    view.innerHTML = `
      <div class="projects-page">
        <div class="page-head">
          <div>
            <h1>Projects</h1>
            <div class="hint">Each project has its own image folder and schema. Annotations stay isolated.</div>
          </div>
          <button class="btn primary" id="btn-new-project"><i class="bi bi-plus-lg"></i> New project</button>
        </div>
        ${
          data.projects.length
            ? `<div class="project-grid">${cards}</div>`
            : `<div class="empty-hint"><i class="bi bi-folder-plus"></i><div>No projects yet. Click “New project” to get started.</div></div>`
        }
      </div>
    `;
    document.getElementById("btn-new-project").addEventListener("click", () => {
      openCreateProjectModal({
        onCreated: (project) => {
          location.hash = `#/p/${project.project_id}`;
        },
      });
    });
    view.querySelectorAll(".project-card").forEach((card) => {
      card.addEventListener("click", () => {
        location.hash = `#/p/${card.dataset.id}`;
      });
    });
  } catch (error) {
    renderError("Failed to load projects", error);
  }
}

function renderError(title, error) {
  hideConflictBanner();
  const detail = error && error.detail;
  const conflicts = detail && detail.conflicts ? detail.conflicts : null;
  const conflictHtml = conflicts
    ? `<ul class="mono">${Object.entries(conflicts)
        .map(
          ([caseId, sources]) =>
            `<li>${escapeHtml(caseId)} ← ${sources.map(escapeHtml).join(" , ")}</li>`
        )
        .join("")}</ul>`
    : "";
  view.innerHTML = `
    <div class="projects-page">
      <div class="page-head">
        <div>
          <h1>${escapeHtml(title)}</h1>
          <div class="hint">${escapeHtml((error && error.message) || "")}</div>
        </div>
        <a class="btn" href="#/"><i class="bi bi-arrow-left"></i> Back to projects</a>
      </div>
      ${conflictHtml}
      <div class="empty-hint"><i class="bi bi-exclamation-triangle" aria-hidden="true"></i><div>Fix the image folder or file names, then click Rescan.</div></div>
    </div>
  `;
  topCenter.innerHTML = "";
  topActions.innerHTML = `<a class="btn" href="#/"><i class="bi bi-arrow-left"></i> Back to projects</a>`;
}

// ---------------------------------------------------------------------------
// 打开项目
// ---------------------------------------------------------------------------
async function openProject(projectId) {
  if (presentation) closePresentation();
  const projectChanged = state.projectId !== null && state.projectId !== projectId;
  if (projectChanged) resetCollectionView();
  if (state.projectId !== projectId) {
    state.currentId = null;
    state.annotation = null;
    state.dirty = false;
    state.search = "";
    state.imageUrl = "";
  }
  hideConflictBanner();
  state.projectId = projectId;
  try {
    const [detail, casesRes, projectsRes, collectionsRes] = await Promise.all([
      api.get(projectUrl(projectId)),
      api.get(projectUrl(projectId, "/cases")),
      api.get("/api/projects"),
      api
        .get(projectUrl(projectId, "/collections"))
        .catch(() => ({ collections: [] })),
    ]);
    state.project = detail.project;
    state.schemaInfo = detail.schema;
    state.index = detail.index;
    state.cases = casesRes.cases;
    state.projects = projectsRes.projects || [];
    state.collections = collectionsRes.collections || [];
    state.selected = new Set();

    if (!projectChanged) {
      const saved = readSavedCollection();
      if (saved) {
        const exists = state.collections.some((item) => item.name === saved.name);
        if (saved.projectId === projectId && exists) {
          try {
            const collection = await api.get(
              projectUrl(projectId, `/collections/${encodeURIComponent(saved.name)}`)
            );
            state.collectionName = saved.name;
            state.collectionIds = Array.isArray(collection.case_ids)
              ? collection.case_ids
              : [];
            state.leftTab = readLeftTab();
          } catch (error) {
            clearSavedCollection();
            state.leftTab = "images";
            writeLeftTab("images");
          }
        } else {
          clearSavedCollection();
          state.leftTab = "images";
          writeLeftTab("images");
        }
      } else {
        state.leftTab = readLeftTab();
      }
    } else {
      state.leftTab = "images";
    }
    normalizeCollectionIds();

    renderShell();
    renderCaseList();
    const target =
      state.currentId && state.cases.some((c) => c.case_id === state.currentId)
        ? state.currentId
        : filteredCases()[0]?.case_id;
    if (target) await selectCase(target);
    else renderEmptyCase("This project has no images. Check the image folder and rescan.");
  } catch (error) {
    renderError("Failed to open project", error);
  }
}

async function refreshProject() {
  const projectId = state.projectId;
  const [detail, casesRes, collectionsRes] = await Promise.all([
    api.get(projectUrl(projectId)),
    api.get(projectUrl(projectId, "/cases")),
    api
      .get(projectUrl(projectId, "/collections"))
      .catch(() => ({ collections: state.collections })),
  ]);
  state.project = detail.project;
  state.schemaInfo = detail.schema;
  state.index = detail.index;
  state.cases = casesRes.cases;
  state.collections = collectionsRes.collections || [];
  normalizeCollectionIds();
  renderShell();
  renderCaseList();
  if (state.currentId && state.cases.some((c) => c.case_id === state.currentId)) {
    await selectCase(state.currentId);
  } else if (filteredCases()[0]) {
    await selectCase(filteredCases()[0].case_id);
  } else {
    renderEmptyCase("No cases in the current filter.");
  }
}

// ---------------------------------------------------------------------------
// 骨架
// ---------------------------------------------------------------------------
function renderShell() {
  const options = state.projects.length
    ? state.projects
    : [{ project_id: state.projectId, name: state.project.name }];
  const switchOptions = options
    .map(
      (project) =>
        `<option value="${escapeHtml(project.project_id)}" ${
          project.project_id === state.projectId ? "selected" : ""
        }>${escapeHtml(project.name)}</option>`
    )
    .join("");

  const total = state.cases.length;
  const done = state.cases.filter(
    (item) => item.annotation && item.annotation.status === "done"
  ).length;
  topCenter.innerHTML = `
    <span class="switch-icon" title="Current project"><i class="bi bi-collection"></i></span>
    <select id="project-switch" title="Switch project" aria-label="Switch project">
      ${switchOptions}
    </select>
    <span class="workspace-path" title="${escapeHtml(state.project.images_dir)}"><i class="bi bi-folder2-open"></i><span>Images: ${escapeHtml(state.project.images_dir)}</span></span>
    <div class="topbar-progress" id="topbar-progress" role="status" aria-label="Done ${done} of ${total} cases" title="Done ${done} of ${total} cases">
      <span class="progress-text" id="progress-text">Done ${done} / ${total}</span>
      <span class="progress-track" aria-hidden="true"><span class="progress-fill" id="progress-fill" style="width:${total ? Math.round((done / total) * 100) : 0}%"></span></span>
    </div>
  `;
  topActions.innerHTML = `
    <span class="global-save-state" id="global-save-state" role="status" aria-live="polite">Not loaded</span>
    <span class="topbar-divider" aria-hidden="true"></span>
    <button class="btn small icon-only" id="btn-next-unlabeled" title="Next unlabeled (n)" aria-label="Next unlabeled"><i class="bi bi-skip-forward"></i></button>
    <button class="btn small" id="btn-schema" title="Edit schema"><i class="bi bi-diagram-3"></i><span class="btn-label">Schema</span></button>
    <button class="btn small" id="btn-import" title="Import annotations"><i class="bi bi-box-arrow-in-down"></i><span class="btn-label">Import</span></button>
    <button class="btn small" id="btn-export" title="Export annotations"><i class="bi bi-box-arrow-up"></i><span class="btn-label">Export</span></button>
    <button class="btn small icon-only" id="btn-notes" title="Notes &amp; prompt" aria-label="Notes and prompt"><i class="bi bi-chat-square-text"></i></button>
    <button class="btn small" id="btn-rescan" title="Rescan image folder"><i class="bi bi-arrow-repeat"></i><span class="btn-label">Rescan</span></button>
    <a class="btn small ghost" href="#/" title="Back to projects"><i class="bi bi-grid"></i><span class="btn-label">Projects</span></a>
    <span class="topbar-divider" aria-hidden="true"></span>
    <button class="btn small icon-only" id="btn-help" title="Help and shortcuts (?)" aria-label="Help and shortcuts"><i class="bi bi-question-circle"></i></button>
  `;

  view.innerHTML = `
    <div class="editor-wrap">
      <div class="workspace" id="workspace">
        <aside class="pane pane-left">
          <div class="filter-row left-tabs" id="left-tabs" role="tablist" aria-label="Left panel view">
            <button type="button" class="chip${state.leftTab === "images" ? " active" : ""}" id="tab-images" data-left-tab="images" role="tab" aria-selected="${state.leftTab === "images"}" aria-controls="panel-images" tabindex="${state.leftTab === "images" ? "0" : "-1"}"><i class="bi bi-images" aria-hidden="true"></i>Images</button>
            <button type="button" class="chip${state.leftTab === "collections" ? " active" : ""}" id="tab-collections" data-left-tab="collections" role="tab" aria-selected="${state.leftTab === "collections"}" aria-controls="panel-collections" tabindex="${state.leftTab === "collections" ? "0" : "-1"}"><i class="bi bi-collection" aria-hidden="true"></i>Collections</button>
          </div>
          <div class="left-tab-panel" id="panel-images" role="tabpanel" aria-labelledby="tab-images" ${state.leftTab === "images" ? "" : "hidden"}>
            <div class="panel-head">
              <strong><i class="bi bi-images"></i>Images</strong>
              <span class="count-badge" id="case-count"></span>
              <span class="flex-grow-1"></span>
              <button class="btn small ghost" id="btn-select-visible" title="Select all visible cases"><i class="bi bi-check2-square"></i><span class="btn-label">Select all</span></button>
              <div class="case-search">
                <i class="bi bi-search" aria-hidden="true"></i>
                <input id="case-search" type="text" placeholder="Search cases…" aria-label="Search cases" autocomplete="off" spellcheck="false" value="${escapeHtml(state.search)}" />
                <button type="button" class="search-clear" id="btn-search-clear" title="Clear search" aria-label="Clear search" ${state.search ? "" : "hidden"}><i class="bi bi-x-lg" aria-hidden="true"></i></button>
              </div>
            </div>
            <div class="filter-row" id="filter-row" role="group" aria-label="Filter cases"></div>
            <div class="bulk-bar" id="bulk-bar" role="region" aria-label="Bulk actions" hidden>
              <div class="bulk-head">
                <span id="bulk-count">0 selected</span>
                <span class="flex-grow-1"></span>
                <button type="button" class="btn small ghost" id="btn-bulk-clear">Clear</button>
              </div>
              <div class="bulk-actions">
                <button type="button" class="btn small" data-bulk-action="status" data-bulk-status="done">Mark done</button>
                <button type="button" class="btn small" data-bulk-action="status" data-bulk-status="draft">Mark draft</button>
                <button type="button" class="btn small" data-bulk-action="tag" data-bulk-mode="add">Add tag</button>
                <button type="button" class="btn small" data-bulk-action="tag" data-bulk-mode="remove">Remove tag</button>
              </div>
              <form class="bulk-tag-row" id="bulk-tag-row" hidden>
                <input id="bulk-tag-input" type="text" placeholder="Tag to add" aria-label="Tag" autocomplete="off" spellcheck="false" />
                <button type="submit" class="btn small primary" id="btn-bulk-tag-apply">Add</button>
                <button type="button" class="btn small ghost" id="btn-bulk-tag-cancel">Cancel</button>
              </form>
            </div>
            <div class="list-scroll" id="case-list"></div>
          </div>
          <div class="left-tab-panel" id="panel-collections" role="tabpanel" aria-labelledby="tab-collections" ${state.leftTab === "collections" ? "" : "hidden"}>
            <div class="panel-head">
              <strong class="collection-heading" id="collection-heading"><i class="bi bi-collection"></i>Collections</strong>
              <span class="count-badge" id="collection-count"></span>
              <span class="flex-grow-1"></span>
              <button type="button" class="btn small ghost" id="btn-collection-new" title="Create a collection from selected cases"><i class="bi bi-plus-lg" aria-hidden="true"></i><span class="btn-label">New collection</span></button>
              <button type="button" class="btn small ghost" id="btn-collection-clear" title="Leave this collection" hidden><i class="bi bi-x-lg" aria-hidden="true"></i><span class="btn-label">Clear</span></button>
            </div>
            <div class="collection-list-view" id="collections-list-view">
              <div class="list-scroll" id="collections-list"></div>
            </div>
            <div class="collection-detail" id="collection-detail-view" hidden>
              <div class="collection-toolbar" id="collection-actions" role="group" aria-label="Collection actions">
                <button type="button" class="btn small" id="btn-collection-add" title="Add selected cases to this collection"><i class="bi bi-plus-circle" aria-hidden="true"></i>Add selected</button>
                <button type="button" class="btn small" id="btn-collection-remove" title="Remove selected cases from this collection"><i class="bi bi-dash-circle" aria-hidden="true"></i>Remove selected</button>
                <button type="button" class="btn small ghost" id="btn-collection-select-visible" title="Select all visible cases"><i class="bi bi-check2-square" aria-hidden="true"></i>Select all</button>
                <button type="button" class="btn small ghost" id="btn-collection-present" title="Present collection (p)"><i class="bi bi-easel" aria-hidden="true"></i>Present</button>
              </div>
              <div class="case-search collection-search">
                <i class="bi bi-search" aria-hidden="true"></i>
                <input id="collection-search" type="text" placeholder="Search in collection…" aria-label="Search in collection" autocomplete="off" spellcheck="false" value="${escapeHtml(state.search)}" />
                <button type="button" class="search-clear" id="btn-collection-search-clear" title="Clear search" aria-label="Clear search" ${state.search ? "" : "hidden"}><i class="bi bi-x-lg" aria-hidden="true"></i></button>
              </div>
              <div class="filter-row" id="collection-filter-row" role="group" aria-label="Filter collection cases"></div>
              <div class="bulk-bar" id="collection-bulk-bar" role="region" aria-label="Collection bulk actions" hidden>
                <div class="bulk-head">
                  <span id="collection-bulk-count">0 selected</span>
                  <span class="flex-grow-1"></span>
                  <button type="button" class="btn small ghost" id="btn-collection-bulk-clear">Clear</button>
                </div>
                <div class="bulk-actions">
                  <button type="button" class="btn small" data-bulk-action="status" data-bulk-status="done">Mark done</button>
                  <button type="button" class="btn small" data-bulk-action="status" data-bulk-status="draft">Mark draft</button>
                  <button type="button" class="btn small" data-bulk-action="tag" data-bulk-mode="add">Add tag</button>
                  <button type="button" class="btn small" data-bulk-action="tag" data-bulk-mode="remove">Remove tag</button>
                </div>
                <form class="bulk-tag-row" id="collection-bulk-tag-row" hidden>
                  <input id="collection-bulk-tag-input" type="text" placeholder="Tag to add" aria-label="Tag" autocomplete="off" spellcheck="false" />
                  <button type="submit" class="btn small primary" id="btn-collection-bulk-tag-apply">Add</button>
                  <button type="button" class="btn small ghost" id="btn-collection-bulk-tag-cancel">Cancel</button>
                </form>
              </div>
              <div class="list-scroll" id="collection-case-list"></div>
            </div>
          </div>
        </aside>
        <div class="pane-resizer" data-resizer="left" role="separator" aria-orientation="vertical" aria-label="Resize case list" aria-valuemin="${LEFT_MIN}" aria-valuemax="${LEFT_MAX}" aria-valuenow="${paneLayout.left}" tabindex="0"></div>
        <aside class="pane pane-center">
          <div class="case-bar">
            <span class="source" id="case-source"></span>
            <span id="case-warning"></span>
          </div>
          <div class="viewer-stage" id="viewer-stage">
            <div class="stage-placeholder" id="stage-placeholder">
              <i class="bi bi-images stage-icon" aria-hidden="true"></i>
              <span class="stage-text">Select a case to preview</span>
              <button type="button" class="btn small" id="btn-retry-image" hidden><i class="bi bi-arrow-clockwise" aria-hidden="true"></i>Retry</button>
            </div>
            <div class="stage-loading" id="stage-loading" role="status" aria-live="polite" hidden>
              <div class="stage-skeleton" aria-hidden="true"></div>
              <div class="load-track" aria-hidden="true"><span class="load-bar"></span></div>
              <span>Loading image…</span>
            </div>
            <img id="viewer-img" alt="Case image" />
          </div>
          <div class="thumb-strip" id="thumb-strip" aria-label="Case thumbnails" hidden></div>
          <div class="viewer-toolbar">
            <button class="btn" id="btn-prev" title="Previous (←)" aria-label="Previous"><i class="bi bi-chevron-left"></i></button>
            <button class="btn" id="btn-next" title="Next (→)" aria-label="Next"><i class="bi bi-chevron-right"></i></button>
            <span class="sep"></span>
            <button class="btn" id="btn-fit" title="Fit to screen" aria-label="Fit to screen"><i class="bi bi-arrows-fullscreen"></i></button>
            <button class="btn" id="btn-zoom-out" title="Zoom out" aria-label="Zoom out"><i class="bi bi-dash-lg"></i></button>
            <span class="scale" id="scale-label">100%</span>
            <button class="btn" id="btn-zoom-in" title="Zoom in" aria-label="Zoom in"><i class="bi bi-plus-lg"></i></button>
            <button class="btn" id="btn-rotate" title="Rotate 90°" aria-label="Rotate 90 degrees"><i class="bi bi-arrow-clockwise"></i></button>
            <button class="btn" id="btn-reset" title="Reset view" aria-label="Reset view"><i class="bi bi-arrow-counterclockwise"></i></button>
          </div>
          <button type="button" class="btn small pane-expand-btn" id="btn-expand-right" title="Expand annotation panel" aria-label="Expand annotation panel" hidden>
            <i class="bi bi-chevron-double-left" aria-hidden="true"></i><span class="btn-label">Annotate</span>
          </button>
        </aside>
        <div class="pane-resizer" data-resizer="right" role="separator" aria-orientation="vertical" aria-label="Resize annotation panel" aria-valuemin="${RIGHT_MIN}" aria-valuemax="${RIGHT_MAX}" aria-valuenow="${paneLayout.right}" tabindex="0"></div>
        <aside class="pane pane-right">
          <div class="form-toolbar">
            <button type="button" class="btn small ghost icon-only" id="btn-collapse-right" title="Collapse annotation panel" aria-label="Collapse annotation panel">
              <i class="bi bi-chevron-double-right" aria-hidden="true"></i>
            </button>
            <button type="button" class="btn small ghost icon-only" id="btn-undo" title="Undo (Ctrl/⌘+Z)" aria-label="Undo" disabled>
              <i class="bi bi-arrow-counterclockwise" aria-hidden="true"></i>
            </button>
            <button type="button" class="btn small ghost icon-only" id="btn-redo" title="Redo (Ctrl/⌘+Shift+Z)" aria-label="Redo" disabled>
              <i class="bi bi-arrow-clockwise" aria-hidden="true"></i>
            </button>
            <select id="status-select" title="Annotation status" aria-label="Annotation status">
              <option value="draft">Draft</option>
              <option value="done">Done</option>
            </select>
            <input id="tags-input" placeholder="Tags, comma separated" aria-label="Tags" style="flex:1;min-width:120px" />
            <span class="save-state" id="save-state" role="status" aria-live="polite">Not loaded</span>
          </div>
          <div class="diff-bar" id="diff-bar" hidden>
            <span class="diff-count" id="diff-count-text">No changes</span>
            <span class="flex-grow-1"></span>
            <label class="diff-toggle" title="Show only fields that differ from the baseline">
              <input type="checkbox" id="only-changed" ${state.onlyChanged ? "checked" : ""} />
              <span>Only changed</span>
            </label>
            <button type="button" class="btn small ghost" id="btn-revert-all" title="Revert all fields to the baseline" disabled>
              <i class="bi bi-arrow-counterclockwise" aria-hidden="true"></i>Revert all
            </button>
          </div>
          <div class="required-banner" id="required-banner" hidden>
            <i class="bi bi-exclamation-circle" aria-hidden="true"></i>
            <span id="required-text"></span>
            <button type="button" class="btn small" id="btn-review-required">Review</button>
          </div>
          <div class="form-scroll" id="form-scroll"></div>
        </aside>
      </div>
      <section class="raw-panel" id="raw-panel">
        <div class="raw-head">
          <button type="button" class="raw-toggle" id="btn-raw-toggle" aria-expanded="false" aria-controls="raw-json">
            <i class="bi bi-chevron-right raw-chevron" aria-hidden="true"></i>
            <i class="bi bi-braces" aria-hidden="true"></i>
            <span>Raw JSON (read-only)</span>
          </button>
          <span class="raw-spacer"></span>
          <span class="raw-match-count" id="raw-match-count" hidden></span>
          <label class="raw-search" title="Find in JSON">
            <i class="bi bi-search" aria-hidden="true"></i>
            <input id="raw-search" type="search" placeholder="Find in JSON" aria-label="Find in JSON" autocomplete="off" spellcheck="false" value="${escapeHtml(rawQuery)}" />
          </label>
          <button type="button" class="btn small ghost" id="btn-raw-copy" title="Copy JSON to clipboard">
            <i class="bi bi-clipboard" aria-hidden="true"></i><span class="btn-label">Copy</span>
          </button>
        </div>
        <pre id="raw-json" hidden></pre>
      </section>
    </div>
  `;

  if (thumbObserver) {
    thumbObserver.disconnect();
    thumbObserver = null;
  }
  thumbSignature = "";
  lastThumbActive = null;

  document.getElementById("project-switch").addEventListener("change", (event) => {
    location.hash = `#/p/${event.target.value}`;
  });
  document.getElementById("btn-schema").addEventListener("click", openSchema);
  document.getElementById("btn-import").addEventListener("click", openImport);
  document.getElementById("btn-export").addEventListener("click", openExport);
  document.getElementById("btn-rescan").addEventListener("click", rescan);
  document.getElementById("btn-next-unlabeled").addEventListener("click", () => {
    gotoNextUnlabeled();
  });
  document.getElementById("btn-help").addEventListener("click", openHelpModal);
  document.getElementById("btn-notes").addEventListener("click", openNotesPrompt);
  document.getElementById("btn-undo").addEventListener("click", () => undoEdit());
  document.getElementById("btn-redo").addEventListener("click", () => redoEdit());

  const searchFields = [
    {
      input: document.getElementById("case-search"),
      clear: document.getElementById("btn-search-clear"),
    },
    {
      input: document.getElementById("collection-search"),
      clear: document.getElementById("btn-collection-search-clear"),
    },
  ].filter((field) => field.input && field.clear);

  const syncSearchControls = () => {
    searchFields.forEach((field) => {
      field.clear.hidden = !state.search;
    });
  };

  const runSearch = debounce(() => {
    renderCaseList();
  }, 150);

  searchFields.forEach((field) => {
    field.input.addEventListener("input", () => {
      state.search = field.input.value.trim();
      searchFields.forEach((other) => {
        if (other.input !== field.input) other.input.value = field.input.value;
      });
      syncSearchControls();
      runSearch();
    });
    field.clear.addEventListener("click", () => {
      state.search = "";
      searchFields.forEach((other) => {
        other.input.value = "";
        other.clear.hidden = true;
      });
      runSearch.cancel();
      renderCaseList();
      field.input.focus();
    });
  });

  const selectVisible = () => {
    const visible = filteredCases().map((c) => c.case_id);
    const allSelected = visible.length && visible.every((id) => state.selected.has(id));
    for (const id of visible) {
      if (allSelected) state.selected.delete(id);
      else state.selected.add(id);
    }
    renderCaseList();
  };
  document.getElementById("btn-select-visible").addEventListener("click", selectVisible);
  document
    .getElementById("btn-collection-select-visible")
    .addEventListener("click", selectVisible);

  [document.getElementById("bulk-bar"), document.getElementById("collection-bulk-bar")]
    .filter(Boolean)
    .forEach((bar) => bar.addEventListener("click", onBulkBarClick));
  document.getElementById("btn-bulk-clear").addEventListener("click", clearSelection);
  document
    .getElementById("btn-collection-bulk-clear")
    .addEventListener("click", clearSelection);
  [document.getElementById("bulk-tag-row"), document.getElementById("collection-bulk-tag-row")]
    .filter(Boolean)
    .forEach((row) => row.addEventListener("submit", onBulkTagSubmit));
  [document.getElementById("btn-bulk-tag-cancel"), document.getElementById("btn-collection-bulk-tag-cancel")]
    .filter(Boolean)
    .forEach((button) => button.addEventListener("click", hideBulkTagRow));
  [document.getElementById("bulk-tag-input"), document.getElementById("collection-bulk-tag-input")]
    .filter(Boolean)
    .forEach((input) => {
      input.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        hideBulkTagRow();
      });
    });

  document.querySelectorAll("#left-tabs [data-left-tab]").forEach((tab) => {
    tab.addEventListener("click", () => setLeftTab(tab.dataset.leftTab));
    tab.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const tabs = [...document.querySelectorAll("#left-tabs [data-left-tab]")];
      const index = tabs.indexOf(tab);
      const next = tabs[(index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
      if (next) {
        next.focus();
        setLeftTab(next.dataset.leftTab);
      }
    });
  });

  document.getElementById("btn-collection-new").addEventListener("click", createCollectionFromSelection);
  document.getElementById("btn-collection-clear").addEventListener("click", () => exitCollection());
  document.getElementById("btn-collection-add").addEventListener("click", addSelectedToCollection);
  document.getElementById("btn-collection-remove").addEventListener("click", removeSelectedFromCollection);
  document.getElementById("btn-collection-present").addEventListener("click", openPresentation);
  document.getElementById("collections-list").addEventListener("click", (event) => {
    const remove = event.target.closest("[data-collection-delete]");
    if (remove) {
      event.stopPropagation();
      deleteCollection(remove.dataset.collectionDelete);
      return;
    }
    const row = event.target.closest("[data-collection]");
    if (row) enterCollection(row.dataset.collection);
  });
  document.getElementById("collection-case-list").addEventListener("click", onCaseListClick);

  const statusSelect = document.getElementById("status-select");
  statusSelect.addEventListener("change", () => {
    if (!state.annotation) return;
    state.annotation.status = statusSelect.value;
    markDirty();
  });
  const tagsInput = document.getElementById("tags-input");
  tagsInput.addEventListener("change", () => {
    if (!state.annotation) return;
    state.annotation.tags = tagsInput.value
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    markDirty();
  });

  const stage = document.getElementById("viewer-stage");
  const image = document.getElementById("viewer-img");
  const scaleLabel = document.getElementById("scale-label");
  viewer = createViewer({ stage, img: image, scaleLabel });
  image.addEventListener("load", () => setStageState("image"));
  image.addEventListener("error", () => setStageState("error"));
  setStageState("empty");
  document.getElementById("btn-retry-image").addEventListener("click", () => {
    if (!state.imageUrl) return;
    setStageState("loading");
    const separator = state.imageUrl.includes("?") ? "&" : "?";
    viewer.load(`${state.imageUrl}${separator}retry=${Date.now()}`);
  });

  document.getElementById("btn-fit").addEventListener("click", () => viewer.fit());
  document.getElementById("btn-reset").addEventListener("click", () => viewer.reset());
  document.getElementById("btn-zoom-in").addEventListener("click", () => viewer.zoomIn());
  document.getElementById("btn-zoom-out").addEventListener("click", () => viewer.zoomOut());
  document.getElementById("btn-rotate").addEventListener("click", () => viewer.rotate());
  document.getElementById("btn-prev").addEventListener("click", () => gotoRelative(-1));
  document.getElementById("btn-next").addEventListener("click", () => gotoRelative(1));

  document.getElementById("case-list").addEventListener("click", onCaseListClick);
  document.getElementById("thumb-strip").addEventListener("click", (event) => {
    const thumb = event.target.closest("[data-thumb]");
    if (thumb) selectCase(thumb.dataset.thumb);
  });

  document.getElementById("only-changed").addEventListener("change", (event) => {
    setOnlyChanged(event.target.checked);
  });
  document.getElementById("btn-revert-all").addEventListener("click", revertAll);
  document.getElementById("btn-review-required").addEventListener("click", reviewRequired);

  document.getElementById("btn-collapse-right").addEventListener("click", () => {
    setRightCollapsed(true);
  });
  document.getElementById("btn-expand-right").addEventListener("click", () => {
    setRightCollapsed(false);
  });
  document.querySelectorAll(".pane-resizer").forEach(initPaneResizer);

  const rawSearch = document.getElementById("raw-search");
  const runRawSearch = debounce(() => {
    rawQuery = rawSearch.value;
    renderRaw();
  }, 120);
  rawSearch.addEventListener("focus", () => {
    if (!rawCollapsed) return;
    rawCollapsed = false;
    writeFlag(RAW_COLLAPSED_KEY, false);
    applyRawCollapsed();
  });
  rawSearch.addEventListener("input", runRawSearch);
  document.getElementById("btn-raw-toggle").addEventListener("click", () => {
    rawCollapsed = !rawCollapsed;
    writeFlag(RAW_COLLAPSED_KEY, rawCollapsed);
    applyRawCollapsed();
    if (!rawCollapsed) renderRaw();
  });
  document.getElementById("btn-raw-copy").addEventListener("click", copyRawJson);

  applyPaneLayout();
  applyRawCollapsed();
  applyLeftTab();
  renderCollectionPanel();
  observeStage(stage);
  updateUndoButtons();
}

// ---------------------------------------------------------------------------
// 列表
// ---------------------------------------------------------------------------
function matchesSearch(item, query) {
  if (!query) return true;
  const needle = query.toLowerCase();
  return (
    String(item.case_id || "").toLowerCase().includes(needle) ||
    String(item.source || "").toLowerCase().includes(needle)
  );
}

function caseMatchesFilter(item, key) {
  const annotation = item.annotation;
  switch (key) {
    case "modified":
      return Boolean(annotation && annotation.diff_count > 0);
    case "unlabeled":
      return !annotation;
    case "done":
      return Boolean(annotation && annotation.status === "done");
    case "notes":
      return Boolean(annotation && annotation.notes_count > 0);
    default:
      return true;
  }
}

function searchIn(items) {
  return items.filter((item) => matchesSearch(item, state.search));
}

function filterIn(items) {
  return items.filter((item) => caseMatchesFilter(item, state.filter));
}

function searchedCases() {
  return searchIn(scopedCases());
}

function filteredCases() {
  return filterIn(searchedCases());
}

function listEmptyHtml(icon, text) {
  return `<div class="empty-state list-empty"><i class="bi ${icon}" aria-hidden="true"></i><p>${escapeHtml(text)}</p></div>`;
}

function renderFilterChips(filterRow, base) {
  if (!filterRow) return;
  filterRow.innerHTML = FILTERS.map((filter) => {
    const chipCount = base.filter((item) => caseMatchesFilter(item, filter.key)).length;
    return `<button type="button" class="chip${state.filter === filter.key ? " active" : ""}" data-filter="${filter.key}" aria-pressed="${state.filter === filter.key}">${escapeHtml(filter.label)} <span class="chip-count">${chipCount}</span></button>`;
  }).join("");
  filterRow.querySelectorAll("[data-filter]").forEach((chip) => {
    chip.addEventListener("click", () => {
      state.filter = chip.dataset.filter;
      renderCaseList();
    });
  });
}

function groupedCasesHtml(visible) {
  const groups = new Map();
  for (const item of visible) {
    const folder = item.folder && item.folder !== "." ? item.folder : "Root";
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push(item);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([folder, items]) => {
      const rows = items.map(caseRowHtml).join("");
      return `<details class="folder-group" open>
        <summary>${escapeHtml(folder)} <span class="muted">${items.length}</span></summary>
        <div class="list-group list-group-flush">${rows}</div>
      </details>`;
    })
    .join("");
}

function renderImagesCaseList() {
  const list = document.getElementById("case-list");
  if (!list) return;
  const base = searchIn(state.cases);
  renderFilterChips(document.getElementById("filter-row"), base);
  const visible = filterIn(base);
  const count = document.getElementById("case-count");
  if (count) count.textContent = `${visible.length}/${state.cases.length}`;

  let emptyState = listEmptyHtml("bi-funnel", "No cases match this filter.");
  if (!state.cases.length) {
    emptyState = listEmptyHtml(
      "bi-images",
      "No images in this project."
    );
  } else if (state.search && !base.length) {
    emptyState = listEmptyHtml(
      "bi-search",
      `No cases match “${state.search}”.`
    );
  }
  list.innerHTML = groupedCasesHtml(visible) || emptyState;
}

function renderCollectionCaseList() {
  const list = document.getElementById("collection-case-list");
  if (!list) return;
  if (!state.collectionName) {
    list.innerHTML = "";
    return;
  }
  const items = collectionCases();
  const base = searchIn(items);
  renderFilterChips(document.getElementById("collection-filter-row"), base);
  const visible = filterIn(base);

  let emptyState = listEmptyHtml(
    "bi-funnel",
    "No cases match this filter."
  );
  if (!items.length) {
    emptyState = listEmptyHtml(
      "bi-collection",
      "This collection is empty. Use Add selected to include cases."
    );
  } else if (state.search && !base.length) {
    emptyState = listEmptyHtml(
      "bi-search",
      `No cases match “${state.search}”.`
    );
  }
  list.innerHTML = visible.map(caseRowHtml).join("") || emptyState;
}

function renderCaseList() {
  renderImagesCaseList();
  renderCollectionCaseList();
  updateBulkBar();
  renderThumbs();
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------
function applyLeftTab() {
  const imagesPanel = document.getElementById("panel-images");
  const collectionsPanel = document.getElementById("panel-collections");
  if (imagesPanel) imagesPanel.hidden = state.leftTab !== "images";
  if (collectionsPanel) collectionsPanel.hidden = state.leftTab !== "collections";
  document.querySelectorAll("#left-tabs [data-left-tab]").forEach((tab) => {
    const active = tab.dataset.leftTab === state.leftTab;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  });
}

function setLeftTab(tab, { persist = true } = {}) {
  state.leftTab = tab === "collections" ? "collections" : "images";
  if (persist) writeLeftTab(state.leftTab);
  applyLeftTab();
  renderCollectionPanel();
  renderCaseList();
}

function renderCollectionsList() {
  const list = document.getElementById("collections-list");
  if (!list) return;
  if (!state.collections.length) {
    list.innerHTML = listEmptyHtml(
      "bi-collection",
      "No collections yet. Select cases in the Images tab, then click New collection."
    );
    return;
  }
  list.innerHTML = state.collections
    .map(
      (collection) => `<div class="collection-item">
        <button type="button" class="collection-open" data-collection="${escapeHtml(collection.name)}" aria-label="Open collection ${escapeHtml(collection.name)}">
          <span class="collection-icon" aria-hidden="true"><i class="bi bi-collection"></i></span>
          <span class="collection-name" title="${escapeHtml(collection.name)}">${escapeHtml(collection.name)}</span>
          <span class="collection-count">${Number(collection.count) || 0}</span>
        </button>
        <button type="button" class="collection-delete" data-collection-delete="${escapeHtml(collection.name)}" title="Delete collection" aria-label="Delete collection ${escapeHtml(collection.name)}"><i class="bi bi-trash3" aria-hidden="true"></i></button>
      </div>`
    )
    .join("");
}

function renderCollectionPanel() {
  const heading = document.getElementById("collection-heading");
  if (!heading) return;
  const active = Boolean(state.collectionName);
  const count = document.getElementById("collection-count");
  const newButton = document.getElementById("btn-collection-new");
  const clearButton = document.getElementById("btn-collection-clear");
  const listView = document.getElementById("collections-list-view");
  const detailView = document.getElementById("collection-detail-view");
  const addButton = document.getElementById("btn-collection-add");
  const removeButton = document.getElementById("btn-collection-remove");
  const presentButton = document.getElementById("btn-collection-present");
  const selectButton = document.getElementById("btn-collection-select-visible");

  if (active) {
    heading.innerHTML = `<i class="bi bi-collection"></i><span class="collection-heading-text">Collection: <span class="collection-heading-name">${escapeHtml(state.collectionName)}</span></span>`;
    if (count) count.textContent = String(collectionCases().length);
  } else {
    heading.innerHTML = `<i class="bi bi-collection"></i><span class="collection-heading-text">Collections</span>`;
    if (count) count.textContent = String(state.collections.length);
  }
  if (newButton) newButton.hidden = active;
  if (clearButton) clearButton.hidden = !active;
  if (listView) listView.hidden = active;
  if (detailView) detailView.hidden = !active;

  const busy = state.collectionBusy;
  const hasCases = collectionCases().length > 0;
  if (addButton) addButton.disabled = busy;
  if (removeButton) removeButton.disabled = busy;
  if (selectButton) selectButton.disabled = busy;
  if (presentButton) {
    presentButton.disabled = busy || !hasCases;
    presentButton.title = hasCases
      ? "Present collection (p)"
      : "This collection has no cases";
  }
  renderCollectionsList();
}

async function loadCollections() {
  const projectId = state.projectId;
  if (!projectId) return;
  const res = await api.get(projectUrl(projectId, "/collections"));
  if (state.projectId !== projectId) return;
  state.collections = res.collections || [];
}

async function enterCollection(name, { selectFirst = true } = {}) {
  if (!state.projectId || !name) return;
  const projectId = state.projectId;
  try {
    const collection = await api.get(
      projectUrl(projectId, `/collections/${encodeURIComponent(name)}`)
    );
    if (state.projectId !== projectId) return;
    state.collectionName = collection.name || name;
    state.collectionIds = Array.isArray(collection.case_ids)
      ? collection.case_ids
      : [];
    normalizeCollectionIds();
    state.selected = new Set();
    state.leftTab = "collections";
    writeLeftTab("collections");
    writeSavedCollection(state.collectionName);
    applyLeftTab();
    renderCollectionPanel();
    renderCaseList();

    if (
      selectFirst &&
      (!state.currentId || !state.collectionIds.includes(state.currentId))
    ) {
      const first = filteredCases()[0];
      if (first) await selectCase(first.case_id);
      else renderEmptyCase("No cases in this collection match the current filters.");
    }
  } catch (error) {
    toast(error.message, true);
    try {
      await loadCollections();
      renderCollectionPanel();
    } catch (loadError) {
      /* keep the current panel state */
    }
  }
}

function exitCollection({ keepTab = true } = {}) {
  state.collectionName = null;
  state.collectionIds = [];
  state.selected = new Set();
  clearSavedCollection();
  if (!keepTab) {
    state.leftTab = "images";
    writeLeftTab("images");
  }
  applyLeftTab();
  renderCollectionPanel();
  renderCaseList();
}

function createCollectionFromSelection() {
  if (!state.projectId) return;
  if (!state.selected.size) {
    toast("Select cases in the Images tab first", true);
    return;
  }
  const caseIds = state.cases
    .filter((item) => state.selected.has(item.case_id))
    .map((item) => item.case_id);
  openCollectionNameModal({
    title: "New collection",
    submitLabel: "Create collection",
    onConfirm: async (name) => {
      const res = await api.put(
        projectUrl(state.projectId, `/collections/${encodeURIComponent(name)}`),
        { case_ids: caseIds }
      );
      await loadCollections();
      renderCollectionPanel();
      toast(
        `Collection "${res.name}" created with ${res.case_ids.length} case${
          res.case_ids.length === 1 ? "" : "s"
        }`
      );
    },
  });
}

async function saveCollectionIds(nextIds, successMessage) {
  if (state.collectionBusy || !state.projectId || !state.collectionName) return false;
  const projectId = state.projectId;
  const name = state.collectionName;
  state.collectionBusy = true;
  renderCollectionPanel();
  try {
    const res = await api.put(
      projectUrl(projectId, `/collections/${encodeURIComponent(name)}`),
      { case_ids: nextIds }
    );
    if (state.projectId !== projectId) return false;
    state.collectionIds = Array.isArray(res.case_ids) ? res.case_ids : nextIds;
    state.selected = new Set();
    await loadCollections();
    writeSavedCollection(name);
    renderCollectionPanel();
    renderCaseList();
    toast(successMessage);
    return true;
  } catch (error) {
    const unknown = error.detail && Array.isArray(error.detail.unknown)
      ? error.detail.unknown
      : [];
    toast(
      unknown.length
        ? `${error.message}: ${unknown.join(", ")}`
        : error.message,
      true
    );
    return false;
  } finally {
    state.collectionBusy = false;
    if (state.projectId === projectId) renderCollectionPanel();
  }
}

function addSelectedToCollection() {
  if (!state.collectionName) return;
  if (!state.selected.size) {
    toast("Select cases first", true);
    return;
  }
  const next = [...state.collectionIds];
  const seen = new Set(next);
  let added = 0;
  for (const item of state.cases) {
    if (!state.selected.has(item.case_id) || seen.has(item.case_id)) continue;
    next.push(item.case_id);
    seen.add(item.case_id);
    added += 1;
  }
  if (!added) {
    toast("Selected cases are already in this collection");
    return;
  }
  saveCollectionIds(
    next,
    `Added ${added} case${added === 1 ? "" : "s"} to this collection`
  );
}

function removeSelectedFromCollection() {
  if (!state.collectionName) return;
  if (!state.selected.size) {
    toast("Select cases first", true);
    return;
  }
  const next = state.collectionIds.filter((id) => !state.selected.has(id));
  const removed = state.collectionIds.length - next.length;
  if (!removed) {
    toast("No selected cases in this collection", true);
    return;
  }
  saveCollectionIds(
    next,
    `Removed ${removed} case${removed === 1 ? "" : "s"} from this collection`
  );
}

async function deleteCollection(name) {
  if (!state.projectId || !name) return;
  if (!window.confirm(`Delete collection "${name}"? Cases and annotations are not affected.`)) {
    return;
  }
  const projectId = state.projectId;
  try {
    await api.del(
      projectUrl(projectId, `/collections/${encodeURIComponent(name)}`)
    );
    if (state.projectId !== projectId) return;
    const wasActive = state.collectionName === name;
    if (wasActive) {
      state.collectionName = null;
      state.collectionIds = [];
      state.selected = new Set();
      clearSavedCollection();
      state.leftTab = "images";
      writeLeftTab("images");
    }
    await loadCollections();
    applyLeftTab();
    renderCollectionPanel();
    renderCaseList();
    toast(`Collection "${name}" deleted`);
  } catch (error) {
    toast(error.message, true);
  }
}


function caseRowHtml(item) {
  const annotation = item.annotation;
  const source = String(item.source || "");
  const normalized = source.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  const fileName = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  const dirPath = slash > 0 ? normalized.slice(0, slash) : "";
  const displayName = fileName || item.case_id;
  const fullTitle = `${item.case_id} · ${source}`;
  const dotClass =
    annotation && annotation.status === "done"
      ? "dot done"
      : annotation && annotation.diff_count > 0
      ? "dot diff"
      : "dot";
  const dotTitle =
    annotation && annotation.status === "done"
      ? "Done"
      : annotation && annotation.diff_count > 0
      ? "Modified"
      : "Unlabeled";
  const badges = [];
  if (annotation && annotation.diff_count > 0) {
    badges.push(
      `<span class="badge" title="${annotation.diff_count} modified fields"><i class="bi bi-pencil-square"></i>${annotation.diff_count}</span>`
    );
  }
  if (annotation && annotation.notes_count > 0) {
    badges.push(
      `<span class="badge note" title="${annotation.notes_count} notes"><i class="bi bi-sticky"></i>${annotation.notes_count}</span>`
    );
  }
  const tags = annotation && Array.isArray(annotation.tags) ? annotation.tags : [];
  if (tags.length) {
    badges.push(
      `<span class="badge tag" title="${escapeHtml(tags.join(", "))}"><i class="bi bi-tag"></i>${tags.length}</span>`
    );
  }
  return `<div class="case-item list-group-item${item.case_id === state.currentId ? " active" : ""}" data-case="${escapeHtml(item.case_id)}">
    <input type="checkbox" data-check="${escapeHtml(item.case_id)}" ${state.selected.has(item.case_id) ? "checked" : ""} aria-label="Select case" />
    <span class="${dotClass}" title="${dotTitle}"></span>
    <span class="case-name" title="${escapeHtml(fullTitle)}">
      <span class="case-file">${escapeHtml(displayName)}</span>
      ${dirPath ? `<span class="case-dir">${escapeHtml(dirPath)}</span>` : ""}
    </span>
    ${badges.join("")}
  </div>`;
}

function onCaseListClick(event) {
  const checkbox = event.target.closest("[data-check]");
  if (checkbox) {
    const id = checkbox.dataset.check;
    if (state.selected.has(id)) state.selected.delete(id);
    else state.selected.add(id);
    renderCaseList();
    return;
  }
  const item = event.target.closest("[data-case]");
  if (item) selectCase(item.dataset.case);
}

function gotoRelative(delta) {
  const visible = filteredCases();
  if (!visible.length) return;
  const index = visible.findIndex((item) => item.case_id === state.currentId);
  const next = visible[index + delta];
  if (next) selectCase(next.case_id);
}

function gotoNextUnlabeled(options = {}) {
  const visible = filteredCases();
  if (!visible.length) {
    if (!options.silent) toast("No cases in the current view", true);
    return false;
  }
  const start = visible.findIndex((item) => item.case_id === state.currentId);
  for (let step = 1; step <= visible.length; step += 1) {
    const item = visible[(start + step + visible.length) % visible.length];
    if (!item.annotation && item.case_id !== state.currentId) {
      selectCase(item.case_id);
      return true;
    }
  }
  if (!options.silent) {
    toast(
      state.search || state.filter !== "all"
        ? "No unlabeled cases in the current view"
        : "All cases are labeled"
    );
  }
  return false;
}

// ---------------------------------------------------------------------------
// Thumbnail strip
// ---------------------------------------------------------------------------
function thumbPreviewUrl(caseId) {
  return projectUrl(
    state.projectId,
    `/preview/${encodeURIComponent(caseId)}?w=240`
  );
}

function thumbDotClass(annotation) {
  if (annotation && annotation.status === "done") return "thumb-dot done";
  if (annotation && annotation.diff_count > 0) return "thumb-dot diff";
  return "thumb-dot";
}

function loadThumb(img) {
  const src = img && img.dataset ? img.dataset.src : "";
  if (!src) return;
  img.removeAttribute("data-src");
  img.src = src;
}

function ensureThumbVisible() {
  const strip = document.getElementById("thumb-strip");
  if (!strip || strip.hidden) return;
  const active = strip.querySelector(".thumb.active");
  if (!active) return;
  const stripRect = strip.getBoundingClientRect();
  const rect = active.getBoundingClientRect();
  if (rect.left >= stripRect.left + 4 && rect.right <= stripRect.right - 4) return;
  const delta = rect.left - stripRect.left - (strip.clientWidth - rect.width) / 2;
  strip.scrollTo({ left: strip.scrollLeft + delta, behavior: "smooth" });
}

function renderThumbs() {
  const strip = document.getElementById("thumb-strip");
  if (!strip) return;
  const visible = filteredCases();
  const show = visible.length > 1 && Boolean(state.projectId);

  if (!show) {
    if (thumbObserver) {
      thumbObserver.disconnect();
      thumbObserver = null;
    }
    strip.hidden = true;
    strip.innerHTML = "";
    thumbSignature = "";
    lastThumbActive = null;
    return;
  }

  const signature = visible
    .map((item) => {
      const annotation = item.annotation;
      const status = annotation ? annotation.status || "draft" : "unlabeled";
      const diff = annotation && annotation.diff_count > 0 ? "d" : "";
      return `${item.case_id}:${status}:${diff}`;
    })
    .join("|");

  const activeChanged = lastThumbActive !== state.currentId;
  if (signature === thumbSignature) {
    strip.querySelectorAll(".thumb").forEach((thumb) => {
      const active = thumb.dataset.thumb === state.currentId;
      thumb.classList.toggle("active", active);
      thumb.setAttribute("aria-current", active ? "true" : "false");
    });
    if (activeChanged) {
      ensureThumbVisible();
      lastThumbActive = state.currentId;
    }
    return;
  }

  if (thumbObserver) {
    thumbObserver.disconnect();
    thumbObserver = null;
  }
  strip.hidden = false;
  strip.innerHTML = visible
    .map((item) => {
      const active = item.case_id === state.currentId;
      const label = item.source || item.case_id;
      return `<button type="button" class="thumb${active ? " active" : ""}" data-thumb="${escapeHtml(item.case_id)}" title="${escapeHtml(label)}" aria-label="Show ${escapeHtml(label)}" aria-current="${active ? "true" : "false"}">
        <img alt="" data-src="${escapeHtml(thumbPreviewUrl(item.case_id))}" />
        <span class="${thumbDotClass(item.annotation)}" aria-hidden="true"></span>
      </button>`;
    })
    .join("");

  const images = [...strip.querySelectorAll("img[data-src]")];
  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          loadThumb(entry.target);
          observer.unobserve(entry.target);
        }
      },
      { root: strip, rootMargin: "0px 320px" }
    );
    images.forEach((img) => observer.observe(img));
    thumbObserver = observer;
  } else {
    images.forEach(loadThumb);
  }

  thumbSignature = signature;
  ensureThumbVisible();
  lastThumbActive = state.currentId;
}

// ---------------------------------------------------------------------------
// Bulk actions
// ---------------------------------------------------------------------------
function bulkBars() {
  return ["bulk-bar", "collection-bulk-bar"]
    .map((id) => document.getElementById(id))
    .filter(Boolean);
}

function updateBulkBar() {
  const bars = bulkBars();
  if (!bars.length) return;
  const count = state.selected.size;
  bars.forEach((bar) => {
    bar.hidden = count === 0;
  });
  const labels = ["bulk-count", "collection-bulk-count"]
    .map((id) => document.getElementById(id))
    .filter(Boolean);
  labels.forEach((label) => {
    label.textContent = `${count} selected`;
  });
  if (!count) hideBulkTagRow();
  setBulkBusy(state.bulkBusy);
}

function setBulkBusy(busy) {
  bulkBars().forEach((bar) => {
    bar.classList.toggle("busy", busy);
    bar.querySelectorAll("button, input").forEach((node) => {
      node.disabled = busy;
    });
  });
}

function hideBulkTagRow() {
  document.querySelectorAll(".bulk-tag-row").forEach((row) => {
    row.hidden = true;
    row.dataset.mode = "";
  });
}

function activeBulkTagRow() {
  return document.getElementById(
    collectionActive() && state.leftTab === "collections"
      ? "collection-bulk-tag-row"
      : "bulk-tag-row"
  );
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
  renderCaseList();
}

async function runBulk(payload) {
  if (state.bulkBusy || !state.selected.size || !state.projectId) return;
  if (state.dirty) {
    const saved = await saveNow(true, { advance: false });
    if (!saved) return;
  }
  const allowed = collectionActive()
    ? new Set(collectionCases().map((item) => item.case_id))
    : null;
  const caseIds = [...state.selected].filter((id) => !allowed || allowed.has(id));
  if (!caseIds.length) {
    toast("No selected cases in this collection", true);
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
    renderCaseList();
    updateProgress();
    if (updatedById.has(state.currentId)) {
      await reloadAnnotation();
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
// Pane layout
// ---------------------------------------------------------------------------
function isWideLayout() {
  return window.matchMedia("(min-width: 1201px)").matches;
}

function workspaceNode() {
  return document.getElementById("workspace");
}

function paneLimits(side) {
  const workspace = workspaceNode();
  const width = workspace ? workspace.clientWidth : 0;
  const dividers = rightCollapsed ? PANE_DIVIDERS / 2 : PANE_DIVIDERS;
  if (side === "left") {
    const max = Math.min(
      LEFT_MAX,
      width - (rightCollapsed ? 0 : paneLayout.right) - CENTER_MIN - dividers
    );
    return { min: LEFT_MIN, max: Math.max(LEFT_MIN, max) };
  }
  const max = Math.min(
    RIGHT_MAX,
    width - paneLayout.left - CENTER_MIN - dividers
  );
  return { min: RIGHT_MIN, max: Math.max(RIGHT_MIN, max) };
}

function normalizePaneLayout() {
  if (!isWideLayout()) return;
  const workspace = workspaceNode();
  if (!workspace || !workspace.clientWidth) return;
  const left = paneLimits("left");
  paneLayout.left = clampNumber(paneLayout.left, left.min, left.max);
  const right = paneLimits("right");
  paneLayout.right = clampNumber(paneLayout.right, right.min, right.max);
}

function savePaneLayout() {
  try {
    localStorage.setItem(
      PANES_KEY,
      JSON.stringify({
        left: Math.round(paneLayout.left),
        right: Math.round(paneLayout.right),
      })
    );
  } catch (error) {
    /* storage may be unavailable */
  }
}

function applyPaneLayout() {
  const workspace = workspaceNode();
  if (!workspace) return;
  normalizePaneLayout();
  workspace.style.setProperty("--dl-left-w", `${Math.round(paneLayout.left)}px`);
  workspace.style.setProperty("--dl-right-w", `${Math.round(paneLayout.right)}px`);
  workspace.classList.toggle("right-collapsed", rightCollapsed);

  const expand = document.getElementById("btn-expand-right");
  if (expand) expand.hidden = !(rightCollapsed && isWideLayout());
  const collapse = document.getElementById("btn-collapse-right");
  if (collapse) collapse.hidden = !isWideLayout();

  document.querySelectorAll(".pane-resizer").forEach((handle) => {
    const side = handle.dataset.resizer;
    handle.setAttribute(
      "aria-valuenow",
      String(Math.round(side === "left" ? paneLayout.left : paneLayout.right))
    );
  });
  scheduleViewerFit();
}

function setRightCollapsed(collapsed) {
  rightCollapsed = Boolean(collapsed);
  writeFlag(RIGHT_COLLAPSED_KEY, rightCollapsed);
  applyPaneLayout();
  scheduleViewerFit();
  if (!isWideLayout()) return;
  const target = document.getElementById(
    rightCollapsed ? "btn-expand-right" : "btn-collapse-right"
  );
  if (target) target.focus({ preventScroll: true });
}

function initPaneResizer(handle) {
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !isWideLayout()) return;
    if (handle.dataset.resizer === "right" && rightCollapsed) return;
    event.preventDefault();
    const side = handle.dataset.resizer;
    const startX = event.clientX;
    const startValue = side === "left" ? paneLayout.left : paneLayout.right;
    document.body.classList.add("pane-resizing");

    const move = (moveEvent) => {
      const limits = paneLimits(side);
      const delta = moveEvent.clientX - startX;
      const raw = side === "left" ? startValue + delta : startValue - delta;
      if (side === "left") {
        paneLayout.left = clampNumber(raw, limits.min, limits.max);
      } else {
        paneLayout.right = clampNumber(raw, limits.min, limits.max);
      }
      applyPaneLayout();
    };
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      document.body.classList.remove("pane-resizing");
      savePaneLayout();
      scheduleViewerFit();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  });

  handle.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    if (!isWideLayout()) return;
    event.preventDefault();
    event.stopPropagation();
    const side = handle.dataset.resizer;
    const limits = paneLimits(side);
    const step = 16;
    const next =
      side === "left"
        ? paneLayout.left + (event.key === "ArrowRight" ? step : -step)
        : paneLayout.right + (event.key === "ArrowLeft" ? step : -step);
    if (side === "left") {
      paneLayout.left = clampNumber(next, limits.min, limits.max);
    } else {
      paneLayout.right = clampNumber(next, limits.min, limits.max);
    }
    applyPaneLayout();
    savePaneLayout();
  });
}

function scheduleViewerFit() {
  if (fitFrame) return;
  fitFrame = requestAnimationFrame(() => {
    fitFrame = null;
    const image = document.getElementById("viewer-img");
    if (viewer && image && image.naturalWidth) viewer.fit();
  });
}

function observeStage(stage) {
  if (stageObserver) {
    stageObserver.disconnect();
    stageObserver = null;
  }
  if (!("ResizeObserver" in window) || !stage) return;
  stageObserver = new ResizeObserver(() => scheduleViewerFit());
  stageObserver.observe(stage);
}

// ---------------------------------------------------------------------------
// 选中 case
// ---------------------------------------------------------------------------
async function selectCase(caseId) {
  if (state.dirty && state.currentId && state.currentId !== caseId) {
    const saved = await saveNow(true, { advance: false });
    if (!saved) return;
  }
  state.currentId = caseId;
  try {
    const [annotationRes, diffRes] = await Promise.all([
      api.get(projectUrl(state.projectId, `/annotations/${encodeURIComponent(caseId)}`)),
      api.get(projectUrl(state.projectId, `/diff/${encodeURIComponent(caseId)}`)),
    ]);
    applyAnnotation(annotationRes, diffRes);
    hideConflictBanner();
    renderCase();
    renderCaseList();
  } catch (error) {
    toast(error.message, true);
  }
}

function applyAnnotation(annotationRes, diffRes) {
  state.annotation = annotationRes.annotation;
  state.annotation.notes = state.annotation.notes || {};
  state.values = annotationRes.values;
  state.diffFields = (diffRes && diffRes.fields) || [];
  state.dirty = false;
  resetHistory(state.currentId);
}

function renderCase() {
  const item = state.cases.find((c) => c.case_id === state.currentId);
  if (!item) {
    renderEmptyCase("No case selected");
    return;
  }
  if (viewer) {
    const imageUrl = projectUrl(
      state.projectId,
      `/preview/${encodeURIComponent(item.case_id)}?w=2000`
    );
    state.imageUrl = imageUrl;
    const image = document.getElementById("viewer-img");
    if (!image || image.getAttribute("src") !== imageUrl) setStageState("loading");
    viewer.load(imageUrl);
  }
  const sourceNode = document.getElementById("case-source");
  sourceNode.innerHTML = `<i class="bi bi-file-earmark-image"></i><span>${escapeHtml(item.source)}</span>`;
  sourceNode.title = item.source;
  const warning = document.getElementById("case-warning");
  warning.textContent = item.warning || "";
  warning.className = item.warning ? "warning" : "";

  syncMetaInputs();

  renderFormArea();
  renderRaw();
  setSaveState(
    state.annotation.updated_at ? "saved" : "",
    state.annotation.updated_at
      ? `Saved ${formatTime(state.annotation.updated_at)}`
      : "Not saved yet"
  );
}

function syncMetaInputs() {
  if (!state.annotation) return;
  const statusSelect = document.getElementById("status-select");
  if (statusSelect) statusSelect.value = state.annotation.status || "draft";
  const tagsInput = document.getElementById("tags-input");
  if (tagsInput) tagsInput.value = (state.annotation.tags || []).join(", ");
}

function renderFormArea() {
  const container = document.getElementById("form-scroll");
  if (!container) return;
  renderForm(container, {
    schema: state.schemaInfo.schema,
    values: state.values,
    notes: state.annotation.notes || {},
    diffFields: state.diffFields,
    onChange: markDirty,
    onRevert: revertField,
    onValueCommit: recordFieldCommit,
    onStructureChange: recordStructureChange,
    onRender: () => {
      applyOnlyChanged(container);
      updateRequiredBanner();
    },
  });
}

function scalarIsMissing(node, value) {
  if (node.type === "boolean") {
    return value === "" || value === null || value === undefined;
  }
  return value === null || value === undefined || String(value) === "";
}

function collectMissingRequired(node, values, prefix, out) {
  const object = isPlainObject(values) ? values : {};
  for (const child of node.children || []) {
    const path = joinPath(prefix, child.label || "");
    const value = object[child.label];
    if (child.type === "object") {
      const before = out.length;
      collectMissingRequired(
        child,
        isPlainObject(value) ? value : {},
        path,
        out
      );
      if (child.required && isEmptyValue(value) && out.length === before) {
        out.push(path);
      }
    } else if (child.type === "array") {
      const items = Array.isArray(value) ? value : [];
      if (child.required && items.length === 0) out.push(path);
      const itemNode = child.item || {};
      items.forEach((item, index) => {
        const itemPath = `${path}[${index}]`;
        if (itemNode.type === "object") {
          collectMissingRequired(
            itemNode,
            isPlainObject(item) ? item : {},
            itemPath,
            out
          );
        } else if (itemNode.required && scalarIsMissing(itemNode, item)) {
          out.push(itemPath);
        }
      });
    } else if (child.required && scalarIsMissing(child, value)) {
      out.push(path);
    }
  }
  return out;
}

function missingRequiredPaths() {
  if (!state.schemaInfo || !state.schemaInfo.schema || !state.values) return [];
  return collectMissingRequired(state.schemaInfo.schema, state.values, "", []);
}

function updateRequiredBanner(paths) {
  const list = paths || missingRequiredPaths();
  const banner = document.getElementById("required-banner");
  if (!banner) return list;
  const text = document.getElementById("required-text");
  if (!state.annotation || !list.length) {
    banner.hidden = true;
    return list;
  }
  banner.hidden = false;
  if (text) {
    const count = list.length;
    text.textContent = `${count} required field${count === 1 ? "" : "s"} ${
      count === 1 ? "is" : "are"
    } empty`;
  }
  return list;
}

function revealField(path, options = {}) {
  const container = document.getElementById("form-scroll");
  if (!container || !path) return false;
  const info = container._fieldMap ? container._fieldMap.get(path) : null;
  let row = info ? info.row : null;
  if (!row) {
    try {
      row = container.querySelector(`.field[data-path="${CSS.escape(path)}"]`);
    } catch (error) {
      row = null;
    }
  }
  if (!row || row.offsetParent === null) return false;
  if (options.scroll !== false) {
    row.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  row.classList.remove("required-flash");
  void row.offsetWidth;
  row.classList.add("required-flash");
  clearTimeout(row._requiredFlashTimer);
  row._requiredFlashTimer = setTimeout(() => {
    row.classList.remove("required-flash");
  }, 1600);
  if (options.focus) {
    const target =
      row.querySelector(".field-control input, .field-control select, .field-control textarea") ||
      row.querySelector("input, select, textarea, button");
    if (target) target.focus({ preventScroll: true });
  }
  return true;
}

function reviewRequired() {
  const paths = updateRequiredBanner();
  if (!paths.length) {
    toast("No required fields are empty");
    return;
  }
  if (state.onlyChanged) setOnlyChanged(false);
  revealField(paths[0], { focus: true, scroll: true });
}

function setOnlyChanged(value) {
  state.onlyChanged = Boolean(value);
  writeFlag(ONLY_CHANGED_KEY, state.onlyChanged);
  const toggle = document.getElementById("only-changed");
  if (toggle) toggle.checked = state.onlyChanged;
  applyOnlyChanged(document.getElementById("form-scroll"));
  updateDiffBar();
}

function applyOnlyChanged(container) {
  if (!container) return;
  container.classList.toggle("only-changed", state.onlyChanged);
  let empty = container.querySelector(".only-changed-empty");
  if (!empty) {
    empty = document.createElement("div");
    empty.className = "empty-state only-changed-empty";
    const icon = document.createElement("i");
    icon.className = "bi bi-check2-circle";
    icon.setAttribute("aria-hidden", "true");
    const text = document.createElement("p");
    text.textContent = "No changed fields in this case.";
    empty.appendChild(icon);
    empty.appendChild(text);
    container.appendChild(empty);
  }
  const map = container._fieldMap;
  const hasFields = Boolean(map && map.size);
  const hasVisibleDiff = Boolean(
    map && (state.diffFields || []).some((field) => map.has(field.path))
  );
  empty.hidden = !(state.onlyChanged && (!hasFields || !hasVisibleDiff));
  updateDiffBar();
}

function updateDiffBar() {
  const bar = document.getElementById("diff-bar");
  if (!bar) return;
  bar.hidden = !state.annotation;
  const count = (state.diffFields || []).length;
  const label = document.getElementById("diff-count-text");
  if (label) {
    label.textContent = count
      ? `${count} field${count === 1 ? "" : "s"} changed`
      : "No changes";
    label.classList.toggle("empty", count === 0);
  }
  const revert = document.getElementById("btn-revert-all");
  if (revert) {
    revert.disabled = !state.annotation || count === 0 || state.revertingAll;
  }
  const toggle = document.getElementById("only-changed");
  if (toggle) toggle.checked = state.onlyChanged;
}

async function revertAll() {
  if (!state.currentId || !state.annotation || state.revertingAll) return;
  if (!state.diffFields.length) {
    toast("No changes to revert");
    return;
  }
  if (state.dirty) {
    const saved = await saveNow(true, { advance: false });
    if (!saved) return;
  }
  state.revertingAll = true;
  updateDiffBar();
  setSaveState("saving", "Reverting…");
  try {
    const res = await api.post(
      projectUrl(
        state.projectId,
        `/annotations/${encodeURIComponent(state.currentId)}/revert`
      ),
      { all: true, expected_rev: state.annotation.rev }
    );
    await reloadAnnotation();
    const reverted = Array.isArray(res.reverted) ? res.reverted.length : 0;
    const missing = Array.isArray(res.missing) ? res.missing.length : 0;
    toast(
      `Reverted ${reverted} field${reverted === 1 ? "" : "s"}` +
        (missing ? ` · ${missing} missing` : "")
    );
  } catch (error) {
    setSaveState("error", "Revert failed");
    toast(error.message, true);
  } finally {
    state.revertingAll = false;
    updateDiffBar();
  }
}

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
  if (!rawQuery) {
    node.textContent = text;
    setRawMatchCount(0, false);
    return;
  }
  const result = highlightJson(text, rawQuery);
  node.innerHTML = result.html;
  setRawMatchCount(result.count, true);
}

function applyRawCollapsed() {
  const panel = document.getElementById("raw-panel");
  const toggle = document.getElementById("btn-raw-toggle");
  const pre = document.getElementById("raw-json");
  if (panel) panel.classList.toggle("collapsed", rawCollapsed);
  if (pre) pre.hidden = rawCollapsed;
  if (toggle) {
    toggle.setAttribute("aria-expanded", String(!rawCollapsed));
    const chevron = toggle.querySelector(".raw-chevron");
    if (chevron) {
      chevron.className = `bi ${
        rawCollapsed ? "bi-chevron-right" : "bi-chevron-down"
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
  if (viewer) viewer.clear();
  setStageState("empty");
  const source = document.getElementById("case-source");
  if (source) {
    source.textContent = "";
    source.title = "";
  }
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
  resetHistory(null);
  renderRaw();
  updateRequiredBanner([]);
  updateDiffBar();
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
  updateRequiredBanner();
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
  const text = document.getElementById("progress-text");
  if (text) text.textContent = `Done ${done} / ${total}`;
  const fill = document.getElementById("progress-fill");
  if (fill) fill.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
  const wrap = document.getElementById("topbar-progress");
  if (wrap) {
    wrap.title = `Done ${done} of ${total} cases`;
    wrap.setAttribute("aria-label", `Done ${done} of ${total} cases`);
  }
}

function showConflictBanner() {
  if (!conflictBanner) return;
  conflictBanner.hidden = false;
  document.body.classList.add("has-banner");
}

function hideConflictBanner() {
  state.conflict = false;
  if (!conflictBanner) return;
  conflictBanner.hidden = true;
  document.body.classList.remove("has-banner");
}

// ---------------------------------------------------------------------------
// 保存
// ---------------------------------------------------------------------------
async function saveNow(force = false, options = {}) {
  const advance = options.advance === true;
  if (!state.currentId || !state.annotation || !state.values) return false;
  if (state.conflict) {
    if (force) toast("Resolve the save conflict first", true);
    return false;
  }
  if (!state.dirty && !force) return false;
  if (state.saving) {
    state.pendingSave = true;
    return false;
  }
  state.saving = true;
  state.dirty = false;
  scheduleSave.cancel();
  setSaveState("saving", "Saving…");
  try {
    const res = await api.put(
      projectUrl(state.projectId, `/annotations/${encodeURIComponent(state.currentId)}`),
      {
        values: state.values,
        notes: state.annotation.notes || {},
        status: state.annotation.status || "draft",
        tags: state.annotation.tags || [],
        expected_rev: state.annotation.rev,
      }
    );
    state.annotation = res.annotation;
    hideConflictBanner();
    setSaveState("saved", `Saved ${formatTime(res.annotation.updated_at)}`);
    updateCurrentSummary();
    await refreshDiff();
    renderRaw();
    const missing = updateRequiredBanner();
    if (missing.length && !(advance && state.autoAdvance)) {
      const active = document.activeElement;
      const typingInForm = Boolean(
        isTypingTarget(active) && active.closest && active.closest("#form-scroll")
      );
      revealField(missing[0], {
        focus: false,
        scroll: !(options.auto === true && typingInForm),
      });
    }
    if (advance && state.autoAdvance) gotoNextUnlabeled({ silent: true });
    return true;
  } catch (error) {
    if (error.status === 409) {
      state.conflict = true;
      state.dirty = true;
      setSaveState("dirty", "Unsaved changes");
      showConflictBanner();
    } else {
      state.dirty = true;
      setSaveState("error", "Save failed");
      toast(error.message, true);
    }
    return false;
  } finally {
    state.saving = false;
    if (state.pendingSave) {
      state.pendingSave = false;
      if (!state.conflict) saveNow(false, { advance: false });
    }
  }
}

async function reloadAnnotation() {
  if (!state.currentId) return;
  const [annotationRes, diffRes] = await Promise.all([
    api.get(projectUrl(state.projectId, `/annotations/${encodeURIComponent(state.currentId)}`)),
    api.get(projectUrl(state.projectId, `/diff/${encodeURIComponent(state.currentId)}`)),
  ]);
  applyAnnotation(annotationRes, diffRes);
  syncMetaInputs();
  renderFormArea();
  renderRaw();
  hideConflictBanner();
  setSaveState("saved", `Reloaded ${formatTime(state.annotation.updated_at)}`);
  updateCurrentSummary();
}

async function reloadFromConflict() {
  try {
    await reloadAnnotation();
    toast("Loaded the latest version");
  } catch (error) {
    toast(error.message, true);
  }
}

async function keepMine() {
  if (!state.currentId || !state.annotation) return;
  setSaveState("saving", "Saving…");
  try {
    const latest = await api.get(
      projectUrl(state.projectId, `/annotations/${encodeURIComponent(state.currentId)}`)
    );
    const res = await api.put(
      projectUrl(state.projectId, `/annotations/${encodeURIComponent(state.currentId)}`),
      {
        values: state.values,
        notes: state.annotation.notes || {},
        status: state.annotation.status || "draft",
        tags: state.annotation.tags || [],
        expected_rev: latest.annotation.rev,
      }
    );
    state.annotation = res.annotation;
    state.dirty = false;
    hideConflictBanner();
    syncMetaInputs();
    setSaveState("saved", `Saved ${formatTime(res.annotation.updated_at)}`);
    updateCurrentSummary();
    await refreshDiff();
    renderRaw();
    toast("Kept your local changes");
  } catch (error) {
    state.conflict = true;
    state.dirty = true;
    setSaveState("dirty", "Unsaved changes");
    showConflictBanner();
    toast(error.message, true);
  }
}

async function refreshDiff() {
  if (!state.currentId) return;
  try {
    const diff = await api.get(
      projectUrl(state.projectId, `/diff/${encodeURIComponent(state.currentId)}`)
    );
    state.diffFields = diff.fields || [];
    const container = document.getElementById("form-scroll");
    if (container) {
      applyDiff(container, state.diffFields, revertField);
      applyOnlyChanged(container);
    }
    updateDiffBar();
    updateRequiredBanner();
    updateCurrentSummary();
  } catch (error) {
    /* 差异刷新失败不影响保存 */
  }
}

function updateCurrentSummary() {
  const item = state.cases.find((c) => c.case_id === state.currentId);
  if (!item || !state.annotation) return;
  const notes = state.annotation.notes || {};
  item.annotation = {
    status: state.annotation.status || "draft",
    tags: state.annotation.tags || [],
    updated_at: state.annotation.updated_at,
    notes_count: Object.values(notes).filter((value) => String(value).trim()).length,
    has_baseline: item.annotation ? item.annotation.has_baseline : false,
    diff_count: state.diffFields.length,
  };
  renderCaseList();
  updateProgress();
}

async function revertField(path) {
  if (!state.currentId || !state.annotation) return;
  try {
    if (state.dirty) {
      const saved = await saveNow(true, { advance: false });
      if (!saved) return;
    }
    await api.post(
      projectUrl(
        state.projectId,
        `/annotations/${encodeURIComponent(state.currentId)}/revert`
      ),
      { path, expected_rev: state.annotation.rev }
    );
    await reloadAnnotation();
    toast("Field reverted");
  } catch (error) {
    toast(error.message, true);
  }
}

// ---------------------------------------------------------------------------
// 顶部操作
// ---------------------------------------------------------------------------
function openSchema() {
  openSchemaEditor({
    projectId: state.projectId,
    schemaInfo: state.schemaInfo,
    onSaved: async () => {
      state.dirty = false;
      await refreshProject();
    },
  });
}

function openImport() {
  openImportModal({
    projectId: state.projectId,
    onDone: async () => {
      await refreshProject();
    },
  });
}

function openExport() {
  const baseCases = collectionActive() ? collectionCases() : state.cases;
  openExportModal({
    projectId: state.projectId,
    allCases: baseCases,
    filteredCases: filteredCases(),
    selectedCases: baseCases.filter((item) => state.selected.has(item.case_id)),
    currentId: state.currentId,
    onDone: (res) => {
      toast(`Export complete: ${res.case_count} cases`);
    },
  });
}

function openNotesPrompt() {
  if (!state.projectId) return;
  openNotesPromptModal({
    projectId: state.projectId,
    onJumpToCase: jumpToCaseField,
  });
}

async function jumpToCaseField(caseId, fieldPath) {
  if (!caseId) return;
  if (caseId !== state.currentId) {
    await selectCase(caseId);
  }
  if (!state.currentId || state.currentId !== caseId) return;
  const container = document.getElementById("form-scroll");
  const info = container && container._fieldMap ? container._fieldMap.get(fieldPath) : null;
  if (state.onlyChanged && (!info || info.row.offsetParent === null)) {
    setOnlyChanged(false);
  }
  requestAnimationFrame(() => {
    revealField(fieldPath, { scroll: true });
  });
}

async function rescan() {
  try {
    await api.post(projectUrl(state.projectId, "/rescan"), {});
    toast("Image folder rescanned");
    await refreshProject();
  } catch (error) {
    renderError("Rescan failed", error);
  }
}

// ---------------------------------------------------------------------------
// Presentation mode
// ---------------------------------------------------------------------------
function formatPresentationValue(value) {
  if (value === null || value === undefined || String(value) === "") {
    return { text: "(empty)", empty: true };
  }
  if (typeof value === "boolean") {
    return { text: value ? "Yes" : "No", empty: false };
  }
  if (typeof value === "object") {
    return { text: JSON.stringify(value), empty: false };
  }
  return { text: String(value), empty: false };
}

function presentationNoteHtml(note) {
  if (!note || !String(note).trim()) return "";
  return `<div class="pres-note">${escapeHtml(note)}</div>`;
}

function presentationFieldHtml(node, value, path, notes) {
  const label = escapeHtml(node.label || "item");
  const required = node.required
    ? '<span class="pres-req" title="Required" aria-label="Required">*</span>'
    : "";
  const head = `<div class="pres-field-head"><span class="pres-label">${label}</span>${required}</div>`;
  const note = presentationNoteHtml(notes[path]);

  if (node.type === "object") {
    const object = isPlainObject(value) ? value : {};
    const children = (node.children || [])
      .map((child) =>
        presentationFieldHtml(
          child,
          object[child.label],
          joinPath(path, child.label),
          notes
        )
      )
      .join("");
    return `<div class="pres-field">${head}<div class="pres-children">${
      children || '<div class="pres-value pres-empty">(empty)</div>'
    }</div>${note}</div>`;
  }

  if (node.type === "array") {
    const items = Array.isArray(value) ? value : [];
    let body;
    if (!items.length) {
      body = '<div class="pres-value pres-empty">(empty)</div>';
    } else {
      body = `<div class="pres-children pres-array">${items
        .map((item, index) => {
          const itemPath = `${path}[${index}]`;
          const itemNote = presentationNoteHtml(notes[itemPath]);
          if (node.item && node.item.type === "object") {
            const object = isPlainObject(item) ? item : {};
            const children = (node.item.children || [])
              .map((child) =>
                presentationFieldHtml(
                  child,
                  object[child.label],
                  joinPath(itemPath, child.label),
                  notes
                )
              )
              .join("");
            return `<div class="pres-array-item"><div class="pres-array-index">#${index + 1}</div><div class="pres-children">${
              children || '<div class="pres-value pres-empty">(empty)</div>'
            }</div>${itemNote}</div>`;
          }
          const formatted = formatPresentationValue(item);
          return `<div class="pres-array-item"><span class="pres-array-index">#${index + 1}</span><span class="pres-value${
            formatted.empty ? " pres-empty" : ""
          }">${escapeHtml(formatted.text)}</span>${itemNote}</div>`;
        })
        .join("")}</div>`;
    }
    return `<div class="pres-field">${head}${body}${note}</div>`;
  }

  const formatted = formatPresentationValue(value);
  return `<div class="pres-field">${head}<div class="pres-value${
    formatted.empty ? " pres-empty" : ""
  }">${escapeHtml(formatted.text)}</div>${note}</div>`;
}

function presentationMetaHtml(item, annotation) {
  const status = annotation.status === "done" ? "Done" : "Draft";
  const tags = Array.isArray(annotation.tags) ? annotation.tags : [];
  return `<div class="pres-meta">
    <div class="pres-meta-row"><span class="pres-key">Case ID</span><span class="pres-val mono">${escapeHtml(item.case_id)}</span></div>
    <div class="pres-meta-row"><span class="pres-key">Source</span><span class="pres-val mono">${escapeHtml(item.source || "")}</span></div>
    <div class="pres-meta-row"><span class="pres-key">Status</span><span class="pres-val"><span class="pres-status ${
      annotation.status === "done" ? "done" : "draft"
    }">${status}</span></span></div>
    ${
      tags.length
        ? `<div class="pres-meta-row"><span class="pres-key">Tags</span><span class="pres-val">${tags
            .map((tag) => `<span class="pres-tag">${escapeHtml(tag)}</span>`)
            .join("")}</span></div>`
        : ""
    }
    ${
      item.warning
        ? `<div class="pres-meta-row"><span class="pres-key">Warning</span><span class="pres-val pres-warning">${escapeHtml(item.warning)}</span></div>`
        : ""
    }
  </div>`;
}

function presentationNotesHtml(notes) {
  const entries = Object.entries(notes || {}).filter(([, text]) =>
    String(text || "").trim()
  );
  if (!entries.length) return "";
  return `<div class="pres-section">
    <div class="pres-section-title">Notes</div>
    <ul class="pres-notes">${entries
      .map(
        ([path, text]) =>
          `<li><div class="pres-note-path mono">${escapeHtml(path)}</div><div>${escapeHtml(text)}</div></li>`
      )
      .join("")}</ul>
  </div>`;
}

function presentationFieldsHtml(item, data) {
  const schema = state.schemaInfo && state.schemaInfo.schema;
  const values = data.values || {};
  const annotation = data.annotation || {};
  const notes = annotation.notes || {};
  const children = (schema && schema.children) || [];
  const fields = children.length
    ? children
        .map((child) =>
          presentationFieldHtml(
            child,
            values[child.label],
            joinPath("", child.label),
            notes
          )
        )
        .join("")
    : '<div class="pres-empty-block">No schema fields.</div>';
  return `${presentationMetaHtml(item, annotation)}
    <div class="pres-section"><div class="pres-section-title">Fields</div>${fields}</div>
    ${presentationNotesHtml(notes)}`;
}

function setPresentationImageState(kind) {
  if (!presentation) return;
  const { stage, loading, error } = presentation.refs;
  stage.classList.toggle("image-error", kind === "error");
  loading.hidden = kind !== "loading";
  error.hidden = kind !== "error";
}

function buildPresentationOverlay() {
  const overlay = document.createElement("div");
  overlay.className = "presentation-layer";
  overlay.id = "presentation-layer";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute(
    "aria-label",
    `Presentation: ${presentation.name}`
  );
  overlay.innerHTML = `
    <header class="presentation-head">
      <div class="presentation-title">
        <i class="bi bi-easel" aria-hidden="true"></i>
        <span class="presentation-name">${escapeHtml(presentation.name)}</span>
        <span class="presentation-progress" id="presentation-progress">· 1 / ${
          presentation.items.length
        }</span>
      </div>
      <div class="presentation-actions">
        <button type="button" class="btn small" id="btn-presentation-prev" title="Previous (←)" aria-label="Previous case"><i class="bi bi-chevron-left" aria-hidden="true"></i></button>
        <button type="button" class="btn small" id="btn-presentation-next" title="Next (→)" aria-label="Next case"><i class="bi bi-chevron-right" aria-hidden="true"></i></button>
        <button type="button" class="btn small" id="btn-presentation-close" title="Close (Esc)" aria-label="Close presentation">Close</button>
      </div>
    </header>
    <div class="presentation-body">
      <section class="viewer-stage presentation-stage" id="presentation-stage" aria-label="Case image">
        <div class="stage-loading" id="presentation-loading" role="status" aria-live="polite" hidden>
          <div class="stage-skeleton" aria-hidden="true"></div>
          <div class="load-track" aria-hidden="true"><span class="load-bar"></span></div>
          <span>Loading image…</span>
        </div>
        <div class="stage-placeholder" id="presentation-error" hidden>
          <i class="bi bi-image-alt" aria-hidden="true"></i>
          <span class="stage-text">Image failed to load.</span>
          <button type="button" class="btn small" id="btn-presentation-retry"><i class="bi bi-arrow-clockwise" aria-hidden="true"></i>Retry</button>
        </div>
        <img id="presentation-img" alt="Case image" />
      </section>
      <aside class="presentation-fields" id="presentation-fields" aria-label="Read-only annotation"></aside>
    </div>
  `;
  document.body.appendChild(overlay);

  const stage = overlay.querySelector("#presentation-stage");
  const image = overlay.querySelector("#presentation-img");
  const loading = overlay.querySelector("#presentation-loading");
  const error = overlay.querySelector("#presentation-error");
  const fields = overlay.querySelector("#presentation-fields");
  const prev = overlay.querySelector("#btn-presentation-prev");
  const next = overlay.querySelector("#btn-presentation-next");
  const close = overlay.querySelector("#btn-presentation-close");
  const retry = overlay.querySelector("#btn-presentation-retry");

  presentation.el = overlay;
  presentation.refs = { stage, image, loading, error, fields, prev, next, close };

  image.addEventListener("load", () => {
    if (!presentation || image.getAttribute("src") !== presentation.imageUrl) return;
    setPresentationImageState("ready");
  });
  image.addEventListener("error", () => {
    if (!presentation || image.getAttribute("src") !== presentation.imageUrl) return;
    setPresentationImageState("error");
  });
  prev.addEventListener("click", () => movePresentation(-1));
  next.addEventListener("click", () => movePresentation(1));
  close.addEventListener("click", closePresentation);
  retry.addEventListener("click", () => {
    if (presentation) loadPresentationImage(true);
  });
}

function loadPresentationImage(forceRetry = false) {
  if (!presentation) return;
  const caseId = presentation.items[presentation.index];
  if (!caseId) return;
  const base = projectUrl(
    presentation.projectId,
    `/preview/${encodeURIComponent(caseId)}?w=2400`
  );
  presentation.imageUrl = forceRetry
    ? `${base}&retry=${Date.now()}`
    : base;
  setPresentationImageState("loading");
  presentation.refs.image.src = presentation.imageUrl;
}

async function renderPresentationSlide() {
  if (!presentation) return;
  const caseId = presentation.items[presentation.index];
  const item = state.cases.find((entry) => entry.case_id === caseId);
  if (!item) return;
  const progress = document.getElementById("presentation-progress");
  if (progress) {
    progress.textContent = `· ${presentation.index + 1} / ${presentation.items.length}`;
  }
  presentation.refs.prev.disabled = presentation.index <= 0;
  presentation.refs.next.disabled =
    presentation.index >= presentation.items.length - 1;

  loadPresentationImage(false);
  presentation.refs.fields.innerHTML =
    '<div class="pres-loading">Loading annotation…</div>';

  const projectId = presentation.projectId;
  const index = presentation.index;
  try {
    let data = presentation.cache.get(caseId);
    if (!data) {
      data = await api.get(
        projectUrl(projectId, `/annotations/${encodeURIComponent(caseId)}`)
      );
      presentation.cache.set(caseId, data);
    }
    if (
      !presentation ||
      presentation.projectId !== projectId ||
      presentation.index !== index ||
      presentation.items[index] !== caseId
    ) {
      return;
    }
    presentation.refs.fields.innerHTML = presentationFieldsHtml(item, data);
  } catch (error) {
    if (!presentation || presentation.index !== index) return;
    presentation.refs.fields.innerHTML = `<div class="pres-empty-block">Failed to load annotation: ${escapeHtml(
      error.message
    )}</div>`;
  }
}

function movePresentation(delta) {
  if (!presentation) return;
  const index = presentation.index + delta;
  if (index < 0 || index >= presentation.items.length) return;
  presentation.index = index;
  renderPresentationSlide();
}

function closePresentation() {
  if (!presentation) return;
  const restore = document.getElementById("btn-collection-present");
  document.removeEventListener("keydown", onPresentationKey, true);
  presentation.el.remove();
  presentation = null;
  if (restore && restore.offsetParent !== null) {
    restore.focus({ preventScroll: true });
  }
}

function onPresentationKey(event) {
  if (!presentation) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closePresentation();
    return;
  }
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    event.stopPropagation();
    movePresentation(event.key === "ArrowLeft" ? -1 : 1);
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = [
    ...presentation.el.querySelectorAll(
      'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    ),
  ].filter((node) => node.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function openPresentation() {
  if (presentation || state.collectionBusy) return;
  if (!collectionActive()) {
    toast("Open a collection first", true);
    return;
  }
  const items = filteredCases().map((item) => item.case_id);
  if (!items.length) {
    toast("No cases to present", true);
    return;
  }
  const currentIndex = Math.max(0, items.indexOf(state.currentId));
  presentation = {
    name: state.collectionName,
    projectId: state.projectId,
    items,
    index: currentIndex,
    cache: new Map(),
    imageUrl: "",
    el: null,
    refs: null,
  };
  buildPresentationOverlay();
  document.addEventListener("keydown", onPresentationKey, true);
  renderPresentationSlide();
  presentation.refs.close.focus({ preventScroll: true });
}



// ---------------------------------------------------------------------------
// Help, shortcuts and fullscreen
// ---------------------------------------------------------------------------
function openHelpModal() {
  const modal = openModal({ title: "Help and shortcuts" });
  const rows = [
    ["<kbd>←</kbd> <kbd>→</kbd>", "Previous / next case"],
    ["<kbd>Alt</kbd> + <kbd>←</kbd> / <kbd>→</kbd>", "Previous / next case while typing"],
    ["<kbd>n</kbd>", "Next unlabeled case"],
    ["<kbd>Enter</kbd>", "Move to the next editable field"],
    ["<kbd>Ctrl</kbd> / <kbd>⌘</kbd> + <kbd>S</kbd>", "Save"],
    ["<kbd>Ctrl</kbd> / <kbd>⌘</kbd> + <kbd>Enter</kbd>", "Save and next unlabeled"],
    ["<kbd>Ctrl</kbd> / <kbd>⌘</kbd> + <kbd>Z</kbd>", "Undo the last field edit"],
    ["<kbd>Ctrl</kbd> / <kbd>⌘</kbd> + <kbd>Shift</kbd> + <kbd>Z</kbd>", "Redo the last undone edit"],
    ["<kbd>f</kbd>", "Toggle image fullscreen"],
    ["<kbd>0</kbd>", "Fit image to window"],
    ["<kbd>p</kbd>", "Present the open collection"],
    ["<kbd>Esc</kbd>", "Close presentation or dialog"],
    ["<kbd>?</kbd>", "Open this help"],
  ];
  modal.body.innerHTML = `
    <p class="muted" style="margin:0 0 10px">Work faster with these shortcuts.</p>
    <table class="shortcut-table"><tbody>
      ${rows
        .map(([keys, text]) => `<tr><td>${keys}</td><td>${text}</td></tr>`)
        .join("")}
    </tbody></table>
    <label class="help-toggle" for="auto-advance-toggle">
      <input type="checkbox" id="auto-advance-toggle" ${state.autoAdvance ? "checked" : ""} />
      <span>After a manual save, jump to the next unlabeled case</span>
    </label>
    <div class="muted" style="margin-top:6px;font-size:11px">This preference is stored in this browser.</div>
  `;
  const toggle = modal.body.querySelector("#auto-advance-toggle");
  toggle.addEventListener("change", () => {
    state.autoAdvance = toggle.checked;
    try {
      localStorage.setItem(AUTO_ADVANCE_KEY, toggle.checked ? "1" : "0");
    } catch (error) {
      /* storage may be unavailable */
    }
    toast(toggle.checked ? "Auto-advance enabled" : "Auto-advance disabled");
  });
  const close = document.createElement("button");
  close.type = "button";
  close.className = "btn primary";
  close.textContent = "Close";
  close.addEventListener("click", () => modal.close());
  modal.foot.appendChild(close);
}

function toggleFullscreen() {
  const target = document.querySelector(".pane-center");
  if (!target) return;
  if (document.fullscreenElement) {
    if (document.exitFullscreen) document.exitFullscreen();
    return;
  }
  if (target.requestFullscreen) {
    target.requestFullscreen().catch(() => {
      toast("Fullscreen is not available", true);
    });
  } else {
    toast("Fullscreen is not available", true);
  }
}

function focusNextField(active) {
  const scope = document.getElementById("form-scroll");
  if (!scope || !scope.contains(active)) return;
  const fields = [...scope.querySelectorAll('input[type="text"], select')].filter(
    (element) => !element.disabled && element.offsetParent !== null
  );
  if (!fields.length) return;
  const index = fields.indexOf(active);
  const next = fields[index + 1] || fields[0];
  next.focus();
  if (next.tagName === "INPUT" && next.select) next.select();
}

async function saveAndNextUnlabeled() {
  const saved = await saveNow(true, { advance: false });
  if (saved) gotoNextUnlabeled();
}

function isTypingTarget(element) {
  return Boolean(
    element &&
      (["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName) ||
        element.isContentEditable)
  );
}

// ---------------------------------------------------------------------------
// 键盘
// ---------------------------------------------------------------------------
document.addEventListener("keydown", (event) => {
  if (document.querySelector(".presentation-layer")) return;
  if (document.querySelector(".modal-backdrop")) return;
  const active = document.activeElement;
  const typing = isTypingTarget(active);
  const mod = event.ctrlKey || event.metaKey;

  if (mod && event.key.toLowerCase() === "s") {
    event.preventDefault();
    saveNow(true, { advance: true });
    return;
  }
  if (mod && event.key === "Enter") {
    event.preventDefault();
    saveAndNextUnlabeled();
    return;
  }
  if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
    if (!state.projectId) return;
    event.preventDefault();
    gotoRelative(event.key === "ArrowLeft" ? -1 : 1);
    return;
  }
  if (!state.projectId) return;
  if (typing) {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      (active.tagName === "INPUT" || active.tagName === "SELECT") &&
      active.closest("#form-scroll")
    ) {
      event.preventDefault();
      focusNextField(active);
    }
    return;
  }
  if (mod && !event.altKey && event.key.toLowerCase() === "z") {
    event.preventDefault();
    if (event.shiftKey) redoEdit();
    else undoEdit();
    return;
  }
  if (mod && !event.altKey && event.key.toLowerCase() === "y") {
    event.preventDefault();
    redoEdit();
    return;
  }
  if (event.key === "?") {
    event.preventDefault();
    openHelpModal();
  } else if (event.key === "n") {
    event.preventDefault();
    gotoNextUnlabeled();
  } else if (event.key === "f") {
    event.preventDefault();
    toggleFullscreen();
  } else if (event.key === "0") {
    event.preventDefault();
    if (viewer) viewer.fit();
  } else if (event.key === "p") {
    if (!collectionActive() || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    openPresentation();
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    gotoRelative(-1);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    gotoRelative(1);
  }
});

document.getElementById("btn-conflict-reload").addEventListener("click", reloadFromConflict);
document.getElementById("btn-conflict-keep").addEventListener("click", keepMine);
document.addEventListener("fullscreenchange", () => {
  if (viewer) viewer.fit();
});

const handleWindowResize = debounce(() => {
  applyPaneLayout();
  scheduleViewerFit();
}, 150);
window.addEventListener("resize", handleWindowResize);

window.addEventListener("beforeunload", (event) => {
  if (state.dirty) {
    event.preventDefault();
    event.returnValue = "";
  }
});

window.addEventListener("hashchange", route);
route();
