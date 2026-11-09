/**
 * 路由、项目列表与项目的打开 / 刷新。
 *
 * 从 main.js 拆分而来；状态见 state.js，跨模块调用统一走 actions。
 */
import { state, ui, actions, dom } from "./state.js";
import { api, projectUrl } from "./api.js";
import { escapeHtml, toast } from "./util.js";
import { openCreateProjectModal } from "./modals.js";

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
  if (ui.presentation) actions.closePresentation();
  while (state.saving) {
    await new Promise((resolve) => state.saveWaiters.push(resolve));
  }
  if (state.dirty && state.currentId) {
    const saved = await actions.saveNow(true, { advance: false });
    if (!saved) {
      // 保存失败 / 有冲突时留在原项目，绝不静默清空未保存的标注。
      if (state.projectId) location.hash = `#/p/${state.projectId}`;
      return;
    }
  }
  state.projectId = null;
  state.currentId = null;
  state.annotation = null;
  state.dirty = false;
  state.search = "";
  state.imageUrl = "";
  state.tagFilter = "";
  state.selected = new Set();
  actions.hideConflictBanner();
  dom.topCenter.innerHTML = "";
  dom.topActions.innerHTML = "";
  if (ui.viewer) {
    ui.viewer = null;
  }
  try {
    const data = await api.get("/api/projects");
    state.projects = data.projects;
    dom.topCenter.innerHTML = `<span class="workspace-path" title="${escapeHtml(data.workspace)}"><i class="bi bi-hdd-network"></i><span>Workspace: ${escapeHtml(data.workspace)}</span></span>`;
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
    dom.view.innerHTML = `
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
    dom.view.querySelectorAll(".project-card").forEach((card) => {
      card.addEventListener("click", () => {
        location.hash = `#/p/${card.dataset.id}`;
      });
    });
  } catch (error) {
    renderError("Failed to load projects", error);
  }
}

function renderError(title, error) {
  actions.hideConflictBanner();
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
  dom.view.innerHTML = `
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
  dom.topCenter.innerHTML = "";
  dom.topActions.innerHTML = `<a class="btn" href="#/"><i class="bi bi-arrow-left"></i> Back to projects</a>`;
}

// ---------------------------------------------------------------------------
// 打开项目
// ---------------------------------------------------------------------------
async function openProject(projectId) {
  if (ui.presentation) actions.closePresentation();
  // 切项目前必须等正在进行的保存结束，并确保未保存的改动落盘；
  // 否则直接 reset 状态会把当前项目的修改静默丢掉。
  while (state.saving) {
    await new Promise((resolve) => state.saveWaiters.push(resolve));
  }
  if (state.dirty && state.projectId && state.projectId !== projectId) {
    const saved = await actions.saveNow(true, { advance: false });
    if (!saved) {
      location.hash = `#/p/${state.projectId}`;
      return;
    }
  }
  if (state.projectId !== projectId) {
    state.currentId = null;
    state.annotation = null;
    state.dirty = false;
    state.search = "";
    state.imageUrl = "";
    state.tagFilter = "";
    state.searchIndex = null;
    ui.searchHitCache = { query: "", map: new Map() };
  }
  actions.hideConflictBanner();
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

    actions.renderShell();
    actions.renderCaseList();
    actions.loadSearchIndex(projectId);
    const target =
      state.currentId && state.cases.some((c) => c.case_id === state.currentId)
        ? state.currentId
        : actions.filteredCases()[0]?.case_id;
    if (target) await actions.selectCase(target);
    else actions.renderEmptyCase("This project has no images. Check the image folder and rescan.");
  } catch (error) {
    renderError("Failed to open project", error);
  }
}

// 刷新失败时保留旧数据，并在顶栏给一个可点击的重试入口。
// 否则「弹窗提示保存 / 导入成功」+「unhandled rejection」会让界面停在旧数据却看似成功。
function showRefreshError(error) {
  const message = (error && error.message) || String(error || "Unknown error");
  toast(`Refresh failed: ${message}. The view still shows the previous data.`, true);
  const bar = dom.topActions;
  if (!bar) return;
  let button = bar.querySelector("[data-retry-refresh]");
  if (!button) {
    button = document.createElement("button");
    button.type = "button";
    button.className = "btn warning";
    button.dataset.retryRefresh = "1";
    button.innerHTML = '<i class="bi bi-arrow-clockwise"></i> Retry refresh';
    button.addEventListener("click", () => {
      actions.refreshProject();
    });
    bar.prepend(button);
  }
  button.title = message;
}

function clearRefreshError() {
  const bar = dom.topActions;
  const button = bar && bar.querySelector("[data-retry-refresh]");
  if (button) button.remove();
}

async function refreshProject() {
  const projectId = state.projectId;
  const token = (ui.refreshToken || 0) + 1;
  ui.refreshToken = token;
  try {
    const [detail, casesRes] = await Promise.all([
      api.get(projectUrl(projectId)),
      api.get(projectUrl(projectId, "/cases")),
    ]);
    // 导入 / 改 schema / rescan 连着触发时，过期响应不能覆盖较新的数据。
    if (ui.refreshToken !== token || state.projectId !== projectId) return false;
    state.project = detail.project;
    state.schemaInfo = detail.schema;
    state.index = detail.index;
    state.cases = casesRes.cases;
    actions.renderShell();
    clearRefreshError();
    actions.renderCaseList();
    actions.loadSearchIndex(projectId);
    if (state.currentId && state.cases.some((c) => c.case_id === state.currentId)) {
      await actions.selectCase(state.currentId);
    } else if (actions.filteredCases()[0]) {
      await actions.selectCase(actions.filteredCases()[0].case_id);
    } else {
      actions.renderEmptyCase("No cases in the current filter.");
    }
    return true;
  } catch (error) {
    showRefreshError(error);
    return false;
  }
}

Object.assign(actions, {
  route,
  renderProjects,
  renderError,
  openProject,
  showRefreshError,
  clearRefreshError,
  refreshProject,
});
