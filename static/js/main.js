import { api, projectUrl } from "./api.js";
import { debounce, escapeHtml, formatTime, toast } from "./util.js";
import { applyDiff, renderForm } from "./form.js";
import { createViewer } from "./viewer.js";
import { openSchemaEditor } from "./schema_editor.js";
import {
  openCreateProjectModal,
  openExportModal,
  openImportModal,
} from "./modals.js";

const view = document.getElementById("view");
const topCenter = document.getElementById("topbar-center");
const topActions = document.getElementById("topbar-actions");

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
};

let viewer = null;
const scheduleSave = debounce(() => {
  saveNow();
}, 1000);

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
  if (state.projectId !== projectId) {
    state.currentId = null;
    state.annotation = null;
    state.dirty = false;
  }
  state.projectId = projectId;
  try {
    const [detail, casesRes, projectsRes] = await Promise.all([
      api.get(projectUrl(projectId)),
      api.get(projectUrl(projectId, "/cases")),
      api.get("/api/projects"),
    ]);
    state.project = detail.project;
    state.schemaInfo = detail.schema;
    state.index = detail.index;
    state.cases = casesRes.cases;
    state.projects = projectsRes.projects || [];
    state.selected = new Set();
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
  const [detail, casesRes] = await Promise.all([
    api.get(projectUrl(projectId)),
    api.get(projectUrl(projectId, "/cases")),
  ]);
  state.project = detail.project;
  state.schemaInfo = detail.schema;
  state.index = detail.index;
  state.cases = casesRes.cases;
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

  topCenter.innerHTML = `
    <span class="switch-icon" title="Current project"><i class="bi bi-collection"></i></span>
    <select id="project-switch" title="Switch project" aria-label="Switch project">
      ${switchOptions}
    </select>
    <span class="workspace-path" title="${escapeHtml(state.project.images_dir)}"><i class="bi bi-folder2-open"></i><span>Images: ${escapeHtml(state.project.images_dir)}</span></span>
  `;
  topActions.innerHTML = `
    <button class="btn small" id="btn-schema" title="Edit schema"><i class="bi bi-diagram-3"></i><span class="btn-label">Schema</span></button>
    <button class="btn small" id="btn-import" title="Import annotations"><i class="bi bi-box-arrow-in-down"></i><span class="btn-label">Import</span></button>
    <button class="btn small" id="btn-export" title="Export annotations"><i class="bi bi-box-arrow-up"></i><span class="btn-label">Export</span></button>
    <button class="btn small" id="btn-rescan" title="Rescan image folder"><i class="bi bi-arrow-repeat"></i><span class="btn-label">Rescan</span></button>
    <a class="btn small ghost" href="#/" title="Back to projects"><i class="bi bi-grid"></i><span class="btn-label">Projects</span></a>
  `;

  view.innerHTML = `
    <div class="editor-wrap">
      <div class="workspace">
        <aside class="pane pane-left">
          <div class="panel-head">
            <strong><i class="bi bi-images"></i>Images</strong>
            <span class="count-badge" id="case-count"></span>
            <span class="flex-grow-1"></span>
            <button class="btn small ghost" id="btn-select-visible" title="Select all visible cases"><i class="bi bi-check2-square"></i><span class="btn-label">Select all</span></button>
          </div>
          <div class="filter-row" id="filter-row" role="group" aria-label="Filter cases"></div>
          <div class="list-scroll" id="case-list"></div>
        </aside>
        <aside class="pane pane-center">
          <div class="case-bar">
            <span class="source" id="case-source"></span>
            <span id="case-warning"></span>
          </div>
          <div class="viewer-stage" id="viewer-stage">
            <div class="stage-placeholder" id="stage-placeholder">
              <i class="bi bi-images" aria-hidden="true"></i>
              <span class="stage-text">Select a case to preview</span>
            </div>
            <div class="stage-loading" id="stage-loading" role="status" aria-live="polite" hidden>
              <span class="spinner" aria-hidden="true"></span>
              <span>Loading image…</span>
            </div>
            <img id="viewer-img" alt="Case image" />
          </div>
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
        </aside>
        <aside class="pane pane-right">
          <div class="form-toolbar">
            <select id="status-select" title="Annotation status" aria-label="Annotation status">
              <option value="draft">Draft</option>
              <option value="done">Done</option>
            </select>
            <input id="tags-input" placeholder="Tags, comma separated" aria-label="Tags" style="flex:1;min-width:120px" />
            <span class="save-state" id="save-state" role="status" aria-live="polite">Not loaded</span>
          </div>
          <div class="form-scroll" id="form-scroll"></div>
        </aside>
      </div>
      <section class="raw-panel">
        <details>
          <summary><i class="bi bi-braces"></i> Raw JSON (read-only)</summary>
          <pre id="raw-json"></pre>
        </details>
      </section>
    </div>
  `;

  document.getElementById("project-switch").addEventListener("change", (event) => {
    location.hash = `#/p/${event.target.value}`;
  });
  document.getElementById("btn-schema").addEventListener("click", openSchema);
  document.getElementById("btn-import").addEventListener("click", openImport);
  document.getElementById("btn-export").addEventListener("click", openExport);
  document.getElementById("btn-rescan").addEventListener("click", rescan);
  document.getElementById("btn-select-visible").addEventListener("click", () => {
    const visible = filteredCases().map((c) => c.case_id);
    const allSelected = visible.every((id) => state.selected.has(id));
    for (const id of visible) {
      if (allSelected) state.selected.delete(id);
      else state.selected.add(id);
    }
    renderCaseList();
  });

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

  document.getElementById("btn-fit").addEventListener("click", () => viewer.fit());
  document.getElementById("btn-reset").addEventListener("click", () => viewer.reset());
  document.getElementById("btn-zoom-in").addEventListener("click", () => viewer.zoomIn());
  document.getElementById("btn-zoom-out").addEventListener("click", () => viewer.zoomOut());
  document.getElementById("btn-rotate").addEventListener("click", () => viewer.rotate());
  document.getElementById("btn-prev").addEventListener("click", () => gotoRelative(-1));
  document.getElementById("btn-next").addEventListener("click", () => gotoRelative(1));

  document.getElementById("case-list").addEventListener("click", onCaseListClick);
}

// ---------------------------------------------------------------------------
// 列表
// ---------------------------------------------------------------------------
function filteredCases() {
  return state.cases.filter((item) => {
    const annotation = item.annotation;
    switch (state.filter) {
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
  });
}

function renderCaseList() {
  const filterRow = document.getElementById("filter-row");
  const list = document.getElementById("case-list");
  if (!filterRow || !list) return;

  filterRow.innerHTML = FILTERS.map(
    (filter) =>
      `<button type="button" class="chip${state.filter === filter.key ? " active" : ""}" data-filter="${filter.key}" aria-pressed="${state.filter === filter.key}">${filter.label}</button>`
  ).join("");
  filterRow.querySelectorAll("[data-filter]").forEach((chip) => {
    chip.addEventListener("click", () => {
      state.filter = chip.dataset.filter;
      renderCaseList();
    });
  });

  const visible = filteredCases();
  const count = document.getElementById("case-count");
  if (count) count.textContent = `${visible.length}/${state.cases.length}`;

  const groups = new Map();
  for (const item of visible) {
    const folder = item.folder && item.folder !== "." ? item.folder : "Root";
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push(item);
  }

  const html = [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([folder, items]) => {
      const rows = items.map(caseRowHtml).join("");
      return `<details class="folder-group" open>
        <summary>${escapeHtml(folder)} <span class="muted">${items.length}</span></summary>
        <div class="list-group list-group-flush">${rows}</div>
      </details>`;
    })
    .join("");

  const emptyState = state.cases.length
    ? '<div class="empty-state list-empty"><i class="bi bi-funnel" aria-hidden="true"></i><p>No cases match this filter.</p></div>'
    : '<div class="empty-state list-empty"><i class="bi bi-images" aria-hidden="true"></i><p>No images in this project.</p></div>';

  list.innerHTML = html || emptyState;
}

function caseRowHtml(item) {
  const annotation = item.annotation;
  const source = String(item.source || "");
  const normalized = source.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  const fileName = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  const dirPath = slash > 0 ? normalized.slice(0, slash + 1) : "";
  const displayName = fileName || item.case_id;
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
  return `<div class="case-item list-group-item${item.case_id === state.currentId ? " active" : ""}" data-case="${escapeHtml(item.case_id)}">
    <input type="checkbox" data-check="${escapeHtml(item.case_id)}" ${state.selected.has(item.case_id) ? "checked" : ""} aria-label="Select case" />
    <span class="${dotClass}" title="${dotTitle}"></span>
    <span class="case-name" title="${escapeHtml(item.source || item.case_id)}">
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

// ---------------------------------------------------------------------------
// 选中 case
// ---------------------------------------------------------------------------
async function selectCase(caseId) {
  if (state.dirty && state.currentId && state.currentId !== caseId) {
    try {
      await saveNow(true);
    } catch (error) {
      return;
    }
  }
  state.currentId = caseId;
  try {
    const [annotationRes, diffRes] = await Promise.all([
      api.get(projectUrl(state.projectId, `/annotations/${encodeURIComponent(caseId)}`)),
      api.get(projectUrl(state.projectId, `/diff/${encodeURIComponent(caseId)}`)),
    ]);
    applyAnnotation(annotationRes, diffRes);
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

  document.getElementById("status-select").value = state.annotation.status || "draft";
  document.getElementById("tags-input").value = (state.annotation.tags || []).join(", ");

  renderFormArea();
  renderRaw();
  setSaveState(
    state.annotation.updated_at ? "saved" : "",
    state.annotation.updated_at
      ? `Saved ${formatTime(state.annotation.updated_at)}`
      : "Not saved yet"
  );
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
  });
}

function renderRaw() {
  const node = document.getElementById("raw-json");
  if (node) {
    node.textContent = state.annotation ? JSON.stringify(state.annotation, null, 2) : "";
  }
}

function setStageState(kind) {
  const stage = document.getElementById("viewer-stage");
  const loading = document.getElementById("stage-loading");
  const placeholder = document.getElementById("stage-placeholder");
  if (stage) stage.classList.toggle("image-error", kind === "error");
  if (loading) loading.hidden = kind !== "loading";
  if (!placeholder) return;
  placeholder.hidden = kind === "image" || kind === "loading";
  const icon = placeholder.querySelector(".bi");
  const text = placeholder.querySelector(".stage-text");
  if (kind === "error") {
    if (icon) icon.className = "bi bi-exclamation-triangle";
    if (text) text.textContent = "Image failed to load";
  } else {
    if (icon) icon.className = "bi bi-images";
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
  const raw = document.getElementById("raw-json");
  if (raw) raw.textContent = "";
  state.annotation = null;
  state.values = null;
  state.diffFields = [];
}

function markDirty() {
  if (!state.annotation) return;
  state.dirty = true;
  setSaveState("dirty", "Unsaved changes");
  scheduleSave();
}

function setSaveState(kind, text) {
  const node = document.getElementById("save-state");
  if (!node) return;
  node.className = `save-state ${kind}`;
  node.textContent = text;
}

// ---------------------------------------------------------------------------
// 保存
// ---------------------------------------------------------------------------
async function saveNow(force = false) {
  if (!state.currentId || !state.annotation || !state.values) return;
  if (!state.dirty && !force) return;
  if (state.saving) {
    state.pendingSave = true;
    return;
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
    setSaveState("saved", `Saved ${formatTime(res.annotation.updated_at)}`);
    updateCurrentSummary();
    await refreshDiff();
    renderRaw();
  } catch (error) {
    if (error.status === 409) {
      toast("This case was changed in another window. Reloading…", true);
      setSaveState("error", "Save conflict");
      await reloadAnnotation();
    } else {
      state.dirty = true;
      setSaveState("error", "Save failed");
      toast(error.message, true);
    }
  } finally {
    state.saving = false;
    if (state.pendingSave) {
      state.pendingSave = false;
      saveNow();
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
  renderFormArea();
  renderRaw();
  setSaveState("saved", `Reloaded ${formatTime(state.annotation.updated_at)}`);
  updateCurrentSummary();
}

async function refreshDiff() {
  if (!state.currentId) return;
  try {
    const diff = await api.get(
      projectUrl(state.projectId, `/diff/${encodeURIComponent(state.currentId)}`)
    );
    state.diffFields = diff.fields || [];
    const container = document.getElementById("form-scroll");
    if (container) applyDiff(container, state.diffFields, revertField);
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
}

async function revertField(path) {
  if (!state.currentId || !state.annotation) return;
  try {
    if (state.dirty) await saveNow(true);
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
  openExportModal({
    projectId: state.projectId,
    allCases: state.cases,
    filteredCases: filteredCases(),
    selectedCases: state.cases.filter((item) => state.selected.has(item.case_id)),
    currentId: state.currentId,
    onDone: (res) => {
      toast(`Export complete: ${res.case_count} cases`);
    },
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
// 键盘
// ---------------------------------------------------------------------------
document.addEventListener("keydown", (event) => {
  if (!state.projectId) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    saveNow(true);
    return;
  }
  const active = document.activeElement;
  const typing =
    active &&
    (["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName) || active.isContentEditable);
  if (typing) return;
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    gotoRelative(-1);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    gotoRelative(1);
  }
});

window.addEventListener("beforeunload", (event) => {
  if (state.dirty) {
    event.preventDefault();
    event.returnValue = "";
  }
});

window.addEventListener("hashchange", route);
route();
