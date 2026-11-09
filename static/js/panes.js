/**
 * 三栏宽度拖拽、折叠与查看器自适应。
 *
 * 从 main.js 拆分而来；状态见 state.js，跨模块调用统一走 actions。
 */
import { ui, actions, PANE, KEYS, clampNumber, writeFlag } from "./state.js";

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
  const dividers = ui.rightCollapsed ? PANE.DIVIDERS / 2 : PANE.DIVIDERS;
  if (side === "left") {
    const max = Math.min(
      PANE.LEFT_MAX,
      width - (ui.rightCollapsed ? 0 : ui.paneLayout.right) - PANE.CENTER_MIN - dividers
    );
    return { min: PANE.LEFT_MIN, max: Math.max(PANE.LEFT_MIN, max) };
  }
  const max = Math.min(
    PANE.RIGHT_MAX,
    width - ui.paneLayout.left - PANE.CENTER_MIN - dividers
  );
  return { min: PANE.RIGHT_MIN, max: Math.max(PANE.RIGHT_MIN, max) };
}

function normalizePaneLayout() {
  if (!isWideLayout()) return;
  const workspace = workspaceNode();
  if (!workspace || !workspace.clientWidth) return;
  const left = paneLimits("left");
  ui.paneLayout.left = clampNumber(ui.paneLayout.left, left.min, left.max);
  const right = paneLimits("right");
  ui.paneLayout.right = clampNumber(ui.paneLayout.right, right.min, right.max);
}

function savePaneLayout() {
  try {
    localStorage.setItem(
      KEYS.panes,
      JSON.stringify({
        left: Math.round(ui.paneLayout.left),
        right: Math.round(ui.paneLayout.right),
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
  workspace.style.setProperty("--dl-left-w", `${Math.round(ui.paneLayout.left)}px`);
  workspace.style.setProperty("--dl-right-w", `${Math.round(ui.paneLayout.right)}px`);
  workspace.classList.toggle("right-collapsed", ui.rightCollapsed);

  const expand = document.getElementById("btn-expand-right");
  if (expand) expand.hidden = !(ui.rightCollapsed && isWideLayout());
  const collapse = document.getElementById("btn-collapse-right");
  if (collapse) collapse.hidden = !isWideLayout();

  document.querySelectorAll(".pane-resizer").forEach((handle) => {
    const side = handle.dataset.resizer;
    handle.setAttribute(
      "aria-valuenow",
      String(Math.round(side === "left" ? ui.paneLayout.left : ui.paneLayout.right))
    );
  });
  scheduleViewerFit();
}

function setRightCollapsed(collapsed) {
  ui.rightCollapsed = Boolean(collapsed);
  writeFlag(KEYS.rightCollapsed, ui.rightCollapsed);
  applyPaneLayout();
  scheduleViewerFit();
  if (!isWideLayout()) return;
  const target = document.getElementById(
    ui.rightCollapsed ? "btn-expand-right" : "btn-collapse-right"
  );
  if (target) target.focus({ preventScroll: true });
}

function initPaneResizer(handle) {
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !isWideLayout()) return;
    if (handle.dataset.resizer === "right" && ui.rightCollapsed) return;
    event.preventDefault();
    const side = handle.dataset.resizer;
    const startX = event.clientX;
    const startValue = side === "left" ? ui.paneLayout.left : ui.paneLayout.right;
    document.body.classList.add("pane-resizing");

    const move = (moveEvent) => {
      const limits = paneLimits(side);
      const delta = moveEvent.clientX - startX;
      const raw = side === "left" ? startValue + delta : startValue - delta;
      if (side === "left") {
        ui.paneLayout.left = clampNumber(raw, limits.min, limits.max);
      } else {
        ui.paneLayout.right = clampNumber(raw, limits.min, limits.max);
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
        ? ui.paneLayout.left + (event.key === "ArrowRight" ? step : -step)
        : ui.paneLayout.right + (event.key === "ArrowLeft" ? step : -step);
    if (side === "left") {
      ui.paneLayout.left = clampNumber(next, limits.min, limits.max);
    } else {
      ui.paneLayout.right = clampNumber(next, limits.min, limits.max);
    }
    applyPaneLayout();
    savePaneLayout();
  });
}

function scheduleViewerFit() {
  if (ui.fitFrame) return;
  ui.fitFrame = requestAnimationFrame(() => {
    ui.fitFrame = null;
    const image = document.getElementById("viewer-img");
    if (ui.viewer && image && image.naturalWidth) ui.viewer.fit();
  });
}

function observeStage(stage) {
  if (ui.stageObserver) {
    ui.stageObserver.disconnect();
    ui.stageObserver = null;
  }
  if (!("ResizeObserver" in window) || !stage) return;
  ui.stageObserver = new ResizeObserver(() => scheduleViewerFit());
  ui.stageObserver.observe(stage);
}

Object.assign(actions, {
  isWideLayout,
  workspaceNode,
  paneLimits,
  normalizePaneLayout,
  savePaneLayout,
  applyPaneLayout,
  setRightCollapsed,
  initPaneResizer,
  scheduleViewerFit,
  observeStage,
});
