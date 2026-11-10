/**
 * 编辑器骨架 HTML 与所有 DOM 事件绑定。
 *
 * 从 main.js 拆分而来；状态见 state.js，跨模块调用统一走 actions。
 */
import { state, ui, actions, dom, PANE, KEYS, writeFlag } from "./state.js";
import { copyText, debounce, escapeHtml, toast } from "./util.js";
import { createViewer } from "./viewer.js";

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
  const pending = state.cases.filter(
    (item) => !item.annotation || item.annotation.status !== "done"
  ).length;
  const progressLabel = `Done ${done} / ${total} · Pending ${pending}`;
  dom.topCenter.innerHTML = `
    <span class="switch-icon" title="Current project"><i class="bi bi-collection"></i></span>
    <select id="project-switch" title="Switch project" aria-label="Switch project">
      ${switchOptions}
    </select>
    <span class="workspace-path" title="${escapeHtml(state.project.images_dir)}"><i class="bi bi-folder2-open"></i><span>Images: ${escapeHtml(state.project.images_dir)}</span></span>
    <div class="topbar-progress" id="topbar-progress" role="status" aria-label="${progressLabel}" title="${progressLabel}">
      <span class="progress-text" id="progress-text">${progressLabel}</span>
      <span class="progress-track" aria-hidden="true"><span class="progress-fill" id="progress-fill" style="width:${total ? Math.round((done / total) * 100) : 0}%"></span></span>
    </div>
  `;
  dom.topActions.innerHTML = `
    <span class="global-save-state" id="global-save-state" role="status" aria-live="polite">Not loaded</span>
    <span class="topbar-divider" aria-hidden="true"></span>
    <button class="btn small icon-only" id="btn-next-unlabeled" title="Next unlabeled (n)" aria-label="Next unlabeled"><i class="bi bi-skip-forward"></i></button>
    <button class="btn small" id="btn-schema" title="Edit schema"><i class="bi bi-diagram-3"></i><span class="btn-label">Schema</span></button>
    <button class="btn small" id="btn-import" title="Import annotations"><i class="bi bi-box-arrow-in-down"></i><span class="btn-label">Import</span></button>
    <button class="btn small" id="btn-export" title="Export annotations"><i class="bi bi-box-arrow-up"></i><span class="btn-label">Export</span></button>
    <button class="btn small icon-only" id="btn-notes" title="Notes &amp; prompt" aria-label="Notes and prompt"><i class="bi bi-chat-square-text"></i></button>
    <button class="btn small icon-only" id="btn-review-queue" title="Batch confirm &amp; sampling queue" aria-label="Batch confirm and sampling queue"><i class="bi bi-check2-all"></i></button>
    <button class="btn small icon-only" id="btn-metrics" title="Prompt regression metrics" aria-label="Prompt regression metrics"><i class="bi bi-graph-up"></i></button>
    <button class="btn small" id="btn-rescan" title="Rescan image folder"><i class="bi bi-arrow-repeat"></i><span class="btn-label">Rescan</span></button>
    <a class="btn small ghost" href="#/" title="Back to projects"><i class="bi bi-grid"></i><span class="btn-label">Projects</span></a>
    <span class="topbar-divider" aria-hidden="true"></span>
    <button class="btn small icon-only" id="btn-help" title="Help and shortcuts (?)" aria-label="Help and shortcuts"><i class="bi bi-question-circle"></i></button>
  `;

  dom.view.innerHTML = `
    <div class="editor-wrap">
      <div class="workspace" id="workspace">
        <aside class="pane pane-left">
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
          <div class="filter-row tag-row" id="tag-row" role="group" aria-label="Filter by tag" hidden></div>
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
              <input id="bulk-tag-input" type="text" placeholder="Tag to add" aria-label="Tag" autocomplete="off" spellcheck="false" list="bulk-tag-options" />
              <datalist id="bulk-tag-options"></datalist>
              <button type="submit" class="btn small primary" id="btn-bulk-tag-apply">Add</button>
              <button type="button" class="btn small ghost" id="btn-bulk-tag-cancel">Cancel</button>
            </form>
          </div>
          <div class="list-scroll" id="case-list"></div>
        </aside>
        <div class="pane-resizer" data-resizer="left" role="separator" aria-orientation="vertical" aria-label="Resize case list" aria-valuemin="${PANE.LEFT_MIN}" aria-valuemax="${PANE.LEFT_MAX}" aria-valuenow="${ui.paneLayout.left}" tabindex="0"></div>
        <aside class="pane pane-center">
          <div class="case-bar">
            <span class="source" id="case-source"></span>
            <button type="button" class="btn small ghost icon-only" id="btn-copy-filename" title="Copy file name" aria-label="Copy file name" hidden>
              <i class="bi bi-clipboard" aria-hidden="true"></i>
            </button>
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
            <button class="btn" id="btn-present" title="Present current list (p)" aria-label="Present current list"><i class="bi bi-easel"></i></button>
            <button class="btn" id="btn-link-field" title="Link a field to an image region" aria-label="Link field to image region"><i class="bi bi-bounding-box"></i></button>
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
        <div class="pane-resizer" data-resizer="right" role="separator" aria-orientation="vertical" aria-label="Resize annotation panel" aria-valuemin="${PANE.RIGHT_MIN}" aria-valuemax="${PANE.RIGHT_MAX}" aria-valuenow="${ui.paneLayout.right}" tabindex="0"></div>
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
            <div class="tags-field">
              <span class="case-tags" id="case-tags"></span>
              <input id="tags-input" placeholder="+ tag" aria-label="Add tag" list="case-tag-options" autocomplete="off" spellcheck="false" />
              <datalist id="case-tag-options"></datalist>
            </div>
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
          <div class="validation-banner" id="validation-banner" hidden>
            <i class="bi bi-exclamation-octagon" aria-hidden="true"></i>
            <span id="validation-text"></span>
            <button type="button" class="btn small" id="btn-review-validation">Review</button>
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
            <input id="raw-search" type="search" placeholder="Find in JSON" aria-label="Find in JSON" autocomplete="off" spellcheck="false" value="${escapeHtml(ui.rawQuery)}" />
          </label>
          <button type="button" class="btn small ghost" id="btn-raw-copy" title="Copy JSON to clipboard">
            <i class="bi bi-clipboard" aria-hidden="true"></i><span class="btn-label">Copy</span>
          </button>
        </div>
        <pre id="raw-json" hidden></pre>
      </section>
    </div>
  `;

  if (ui.thumbObserver) {
    ui.thumbObserver.disconnect();
    ui.thumbObserver = null;
  }
  ui.thumbSignature = "";
  ui.lastThumbActive = null;

  document.getElementById("project-switch").addEventListener("change", (event) => {
    location.hash = `#/p/${event.target.value}`;
  });
  document.getElementById("btn-schema").addEventListener("click", actions.openSchema);
  document.getElementById("btn-import").addEventListener("click", actions.openImport);
  document.getElementById("btn-export").addEventListener("click", actions.openExport);
  document.getElementById("btn-rescan").addEventListener("click", actions.rescan);
  document.getElementById("btn-next-unlabeled").addEventListener("click", () => {
    actions.gotoNextUnlabeled();
  });
  document.getElementById("btn-help").addEventListener("click", actions.openHelpModal);
  document.getElementById("btn-notes").addEventListener("click", actions.openNotesPrompt);
  document.getElementById("btn-review-queue").addEventListener("click", actions.openReviewQueue);
  document.getElementById("btn-metrics").addEventListener("click", actions.openMetrics);
  document.getElementById("btn-undo").addEventListener("click", () => actions.undoEdit());
  document.getElementById("btn-redo").addEventListener("click", () => actions.redoEdit());

  const searchInput = document.getElementById("case-search");
  const searchClear = document.getElementById("btn-search-clear");

  const syncSearchControls = () => {
    searchClear.hidden = !state.search;
  };

  const runSearch = debounce(() => {
    actions.renderCaseList();
  }, 150);

  searchInput.addEventListener("input", () => {
    state.search = searchInput.value.trim();
    syncSearchControls();
    runSearch();
  });
  searchClear.addEventListener("click", () => {
    state.search = "";
    searchInput.value = "";
    searchClear.hidden = true;
    runSearch.cancel();
    actions.renderCaseList();
    searchInput.focus();
  });

  const selectVisible = () => {
    const visible = actions.filteredCases().map((c) => c.case_id);
    const allSelected = visible.length && visible.every((id) => state.selected.has(id));
    for (const id of visible) {
      if (allSelected) state.selected.delete(id);
      else state.selected.add(id);
    }
    actions.renderCaseList();
  };
  document.getElementById("btn-select-visible").addEventListener("click", selectVisible);

  document.getElementById("bulk-bar").addEventListener("click", actions.onBulkBarClick);
  document.getElementById("btn-bulk-clear").addEventListener("click", actions.clearSelection);
  document.getElementById("bulk-tag-row").addEventListener("submit", actions.onBulkTagSubmit);
  document.getElementById("btn-bulk-tag-cancel").addEventListener("click", actions.hideBulkTagRow);
  const bulkTagInput = document.getElementById("bulk-tag-input");
  bulkTagInput.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    actions.hideBulkTagRow();
  });

  const statusSelect = document.getElementById("status-select");
  statusSelect.addEventListener("change", () => {
    if (!state.annotation) return;
    state.annotation.status = statusSelect.value;
    actions.markDirty();
  });
  const tagsInput = document.getElementById("tags-input");
  tagsInput.addEventListener("focus", () => actions.fillCaseTagOptions());
  const addTagsFromInput = () => {
    const tags = tagsInput.value
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    tagsInput.value = "";
    if (!state.annotation || !tags.length) return;
    const current = state.annotation.tags || [];
    const seen = new Set(current.map((tag) => String(tag).toLowerCase()));
    let changed = false;
    for (const tag of tags) {
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      current.push(tag);
      changed = true;
    }
    if (!changed) return;
    state.annotation.tags = current;
    actions.renderCaseTags();
    actions.markDirty();
  };
  tagsInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    addTagsFromInput();
  });
  tagsInput.addEventListener("change", addTagsFromInput);

  const copyButton = document.getElementById("btn-copy-filename");
  copyButton.addEventListener("click", async () => {
    const item = state.cases.find((c) => c.case_id === state.currentId);
    if (!item) return;
    const name = String(item.source || "").split(/[\\/]/).pop();
    const ok = await copyText(name);
    toast(ok ? `Copied ${name}` : "Copy failed", !ok);
  });

  const stage = document.getElementById("viewer-stage");
  const image = document.getElementById("viewer-img");
  const scaleLabel = document.getElementById("scale-label");
  ui.viewer = createViewer({ stage, img: image, scaleLabel });
  actions.bindEvidenceViewer();
  image.addEventListener("load", () => actions.setStageState("image"));
  image.addEventListener("error", () => actions.setStageState("error"));
  actions.setStageState("empty");
  document.getElementById("btn-retry-image").addEventListener("click", () => {
    if (!state.imageUrl) return;
    actions.setStageState("loading");
    const separator = state.imageUrl.includes("?") ? "&" : "?";
    ui.viewer.load(`${state.imageUrl}${separator}retry=${Date.now()}`);
  });

  document.getElementById("btn-fit").addEventListener("click", () => ui.viewer.fit());
  document.getElementById("btn-reset").addEventListener("click", () => ui.viewer.reset());
  document.getElementById("btn-zoom-in").addEventListener("click", () => ui.viewer.zoomIn());
  document.getElementById("btn-zoom-out").addEventListener("click", () => ui.viewer.zoomOut());
  document.getElementById("btn-rotate").addEventListener("click", () => ui.viewer.rotate());
  document.getElementById("btn-prev").addEventListener("click", () => actions.gotoRelative(-1));
  document.getElementById("btn-next").addEventListener("click", () => actions.gotoRelative(1));
  document.getElementById("btn-present").addEventListener("click", actions.openPresentation);
  document.getElementById("btn-link-field").addEventListener("click", actions.pickFieldForEvidence);

  document.getElementById("case-list").addEventListener("click", actions.onCaseListClick);
  document.getElementById("thumb-strip").addEventListener("click", (event) => {
    const thumb = event.target.closest("[data-thumb]");
    if (thumb) actions.selectCase(thumb.dataset.thumb);
  });

  document.getElementById("only-changed").addEventListener("change", (event) => {
    actions.setOnlyChanged(event.target.checked);
  });
  document.getElementById("btn-revert-all").addEventListener("click", actions.revertAll);
  document.getElementById("btn-review-required").addEventListener("click", actions.reviewRequired);
  document.getElementById("btn-review-validation").addEventListener("click", actions.reviewValidation);

  document.getElementById("btn-collapse-right").addEventListener("click", () => {
    actions.setRightCollapsed(true);
  });
  document.getElementById("btn-expand-right").addEventListener("click", () => {
    actions.setRightCollapsed(false);
  });
  document.querySelectorAll(".pane-resizer").forEach(actions.initPaneResizer);

  const rawSearch = document.getElementById("raw-search");
  const runRawSearch = debounce(() => {
    ui.rawQuery = rawSearch.value;
    actions.renderRaw();
  }, 120);
  rawSearch.addEventListener("focus", () => {
    if (!ui.rawCollapsed) return;
    ui.rawCollapsed = false;
    writeFlag(KEYS.rawCollapsed, false);
    actions.applyRawCollapsed();
  });
  rawSearch.addEventListener("input", runRawSearch);
  document.getElementById("btn-raw-toggle").addEventListener("click", () => {
    ui.rawCollapsed = !ui.rawCollapsed;
    writeFlag(KEYS.rawCollapsed, ui.rawCollapsed);
    actions.applyRawCollapsed();
    if (!ui.rawCollapsed) actions.renderRaw();
  });
  document.getElementById("btn-raw-copy").addEventListener("click", actions.copyRawJson);

  actions.applyPaneLayout();
  actions.applyRawCollapsed();
  actions.observeStage(stage);
  actions.updateUndoButtons();
}

/** 右侧标签 chips：每个标签可单独删除，输入框只负责新增。 */
function renderCaseTags() {
  const container = document.getElementById("case-tags");
  if (!container) return;
  const tags = (state.annotation && state.annotation.tags) || [];
  container.innerHTML = tags
    .map(
      (tag, index) =>
        `<span class="case-tag">${escapeHtml(tag)}<button type="button" class="case-tag-remove" data-index="${index}" title="Remove ${escapeHtml(tag)}" aria-label="Remove ${escapeHtml(tag)}">×</button></span>`
    )
    .join("");
  container.querySelectorAll(".case-tag-remove").forEach((button) => {
    button.addEventListener("click", () => {
      if (!state.annotation) return;
      const rest = [...(state.annotation.tags || [])];
      rest.splice(Number(button.dataset.index), 1);
      state.annotation.tags = rest;
      renderCaseTags();
      actions.markDirty();
    });
  });
}

Object.assign(actions, {
  renderShell,
  renderCaseTags,
});
