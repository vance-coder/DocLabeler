/**
 * 帮助弹窗、全屏、全局快捷键与窗口事件。
 *
 * 从 main.js 拆分而来；状态见 state.js，跨模块调用统一走 actions。
 */
import { state, ui, actions, KEYS } from "./state.js";
import { debounce, toast } from "./util.js";
import { openModal } from "./modal.js";

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
    ["<kbd>p</kbd>", "Present the visible list"],
    ["<kbd>Space</kbd>", "Mark done and jump to the next pending case (rule errors → low confidence → edited → sampled)"],
    ["<kbd>b</kbd>", "Link a field to a region of the image"],
    ["<i class=\"bi bi-bounding-box\"></i> field button", "Locate in image · Shift+click redraw · Alt+click remove"],
    ["<kbd>Esc</kbd>", "Close presentation / dialog, or cancel box select"],
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
      localStorage.setItem(KEYS.autoAdvance, toggle.checked ? "1" : "0");
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
  const saved = await actions.saveNow(true, { advance: false });
  if (saved) actions.gotoNextUnlabeled();
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
  if (ui.evidenceEditor) return;
  const active = document.activeElement;
  const typing = isTypingTarget(active);
  const mod = event.ctrlKey || event.metaKey;

  if (mod && event.key.toLowerCase() === "s") {
    event.preventDefault();
    actions.saveNow(true, { advance: true });
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
    actions.gotoRelative(event.key === "ArrowLeft" ? -1 : 1);
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
    if (event.shiftKey) actions.redoEdit();
    else actions.undoEdit();
    return;
  }
  if (mod && !event.altKey && event.key.toLowerCase() === "y") {
    event.preventDefault();
    actions.redoEdit();
    return;
  }
  if (event.key === "?") {
    event.preventDefault();
    openHelpModal();
  } else if (event.key === "n") {
    event.preventDefault();
    actions.gotoNextUnlabeled();
  } else if (event.key === "f") {
    event.preventDefault();
    toggleFullscreen();
  } else if (event.key === "0") {
    event.preventDefault();
    if (ui.viewer) ui.viewer.fit();
  } else if (event.key === "p") {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    actions.openPresentation();
  } else if (event.key === "b") {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    actions.pickFieldForEvidence();
  } else if (event.key === " ") {
    // 焦点在按钮 / 链接 / summary / 分栏拖拽条上时，Space 是该控件的默认行为，
    // 不抢作全局快捷键（否则会误触「完成并下一张」）。
    if (
      active &&
      (active.tagName === "BUTTON" ||
        active.tagName === "A" ||
        active.tagName === "SUMMARY" ||
        active.getAttribute("role") === "separator")
    ) {
      return;
    }
    event.preventDefault();
    actions.markDoneAndAdvance();
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    actions.gotoRelative(-1);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    actions.gotoRelative(1);
  }
});

document.getElementById("btn-conflict-reload").addEventListener("click", actions.reloadFromConflict);
document.getElementById("btn-conflict-keep").addEventListener("click", actions.keepMine);
document.addEventListener("fullscreenchange", () => {
  if (ui.viewer) ui.viewer.fit();
});

const handleWindowResize = debounce(() => {
  actions.applyPaneLayout();
  actions.scheduleViewerFit();
}, 150);
window.addEventListener("resize", handleWindowResize);

window.addEventListener("beforeunload", (event) => {
  if (state.dirty) {
    event.preventDefault();
    event.returnValue = "";
  }
});

window.addEventListener("hashchange", actions.route);

Object.assign(actions, {
  openHelpModal,
  toggleFullscreen,
  focusNextField,
  saveAndNextUnlabeled,
  isTypingTarget,
});
