/**
 * 演示模式（只读逐张浏览当前列表）。
 *
 * 从 main.js 拆分而来；状态见 state.js，跨模块调用统一走 actions。
 */
import { state, ui, actions, FILTERS } from "./state.js";
import { api, projectUrl } from "./api.js";
import { escapeHtml, joinPath, isPlainObject, toast } from "./util.js";

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
  if (!ui.presentation) return;
  const { stage, loading, error } = ui.presentation.refs;
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
    `Presentation: ${ui.presentation.name}`
  );
  overlay.innerHTML = `
    <header class="presentation-head">
      <div class="presentation-title">
        <i class="bi bi-easel" aria-hidden="true"></i>
        <span class="presentation-name">${escapeHtml(ui.presentation.name)}</span>
        <span class="presentation-progress" id="presentation-progress">· 1 / ${
          ui.presentation.items.length
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

  ui.presentation.el = overlay;
  ui.presentation.refs = { stage, image, loading, error, fields, prev, next, close };

  image.addEventListener("load", () => {
    if (!ui.presentation || image.getAttribute("src") !== ui.presentation.imageUrl) return;
    setPresentationImageState("ready");
  });
  image.addEventListener("error", () => {
    if (!ui.presentation || image.getAttribute("src") !== ui.presentation.imageUrl) return;
    setPresentationImageState("error");
  });
  prev.addEventListener("click", () => movePresentation(-1));
  next.addEventListener("click", () => movePresentation(1));
  close.addEventListener("click", closePresentation);
  retry.addEventListener("click", () => {
    if (ui.presentation) loadPresentationImage(true);
  });
}

function loadPresentationImage(forceRetry = false) {
  if (!ui.presentation) return;
  const caseId = ui.presentation.items[ui.presentation.index];
  if (!caseId) return;
  const base = projectUrl(
    ui.presentation.projectId,
    `/preview/${encodeURIComponent(caseId)}?w=2400`
  );
  ui.presentation.imageUrl = forceRetry
    ? `${base}&retry=${Date.now()}`
    : base;
  setPresentationImageState("loading");
  ui.presentation.refs.image.src = ui.presentation.imageUrl;
}

async function renderPresentationSlide() {
  if (!ui.presentation) return;
  const caseId = ui.presentation.items[ui.presentation.index];
  const item = state.cases.find((entry) => entry.case_id === caseId);
  if (!item) return;
  const progress = document.getElementById("presentation-progress");
  if (progress) {
    progress.textContent = `· ${ui.presentation.index + 1} / ${ui.presentation.items.length}`;
  }
  ui.presentation.refs.prev.disabled = ui.presentation.index <= 0;
  ui.presentation.refs.next.disabled =
    ui.presentation.index >= ui.presentation.items.length - 1;

  loadPresentationImage(false);
  ui.presentation.refs.fields.innerHTML =
    '<div class="pres-loading">Loading annotation…</div>';

  const projectId = ui.presentation.projectId;
  const index = ui.presentation.index;
  try {
    let data = ui.presentation.cache.get(caseId);
    if (!data) {
      data = await api.get(
        projectUrl(projectId, `/annotations/${encodeURIComponent(caseId)}`)
      );
      ui.presentation.cache.set(caseId, data);
    }
    if (
      !ui.presentation ||
      ui.presentation.projectId !== projectId ||
      ui.presentation.index !== index ||
      ui.presentation.items[index] !== caseId
    ) {
      return;
    }
    ui.presentation.refs.fields.innerHTML = presentationFieldsHtml(item, data);
  } catch (error) {
    if (!ui.presentation || ui.presentation.index !== index) return;
    ui.presentation.refs.fields.innerHTML = `<div class="pres-empty-block">Failed to load annotation: ${escapeHtml(
      error.message
    )}</div>`;
  }
}

function movePresentation(delta) {
  if (!ui.presentation) return;
  const index = ui.presentation.index + delta;
  if (index < 0 || index >= ui.presentation.items.length) return;
  ui.presentation.index = index;
  renderPresentationSlide();
}

function closePresentation() {
  if (!ui.presentation) return;
  const restore = document.getElementById("btn-present");
  document.removeEventListener("keydown", onPresentationKey, true);
  ui.presentation.el.remove();
  ui.presentation = null;
  if (restore && restore.offsetParent !== null) {
    restore.focus({ preventScroll: true });
  }
}

function onPresentationKey(event) {
  if (!ui.presentation) return;
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

function currentScopeLabel() {
  if (state.tagFilter) return `Tag: ${state.tagFilter}`;
  if (state.search) return `Search: ${state.search}`;
  const filter = FILTERS.find((item) => item.key === state.filter);
  return filter && filter.key !== "all" ? filter.label : "All cases";
}

function openPresentation() {
  if (ui.presentation) return;
  const items = actions.filteredCases().map((item) => item.case_id);
  if (!items.length) {
    toast("No cases to present", true);
    return;
  }
  const currentIndex = Math.max(0, items.indexOf(state.currentId));
  ui.presentation = {
    name: currentScopeLabel(),
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
  ui.presentation.refs.close.focus({ preventScroll: true });
}

Object.assign(actions, {
  formatPresentationValue,
  presentationNoteHtml,
  presentationFieldHtml,
  presentationMetaHtml,
  presentationNotesHtml,
  presentationFieldsHtml,
  setPresentationImageState,
  buildPresentationOverlay,
  loadPresentationImage,
  renderPresentationSlide,
  movePresentation,
  closePresentation,
  onPresentationKey,
  currentScopeLabel,
  openPresentation,
});
