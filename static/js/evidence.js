/**
 * 字段 ↔ 原文互定位。
 *
 * - 字段行的定位按钮：已有证据框时高亮并放大到该区域；没有时进入框选模式。
 * - 在图上拖框后可以给该区域补一段 OCR 文本，一次性回填字段值。
 * - 点击图上的框反查字段并滚动定位。
 *
 * evidence 结构：{ [field_path]: { bbox:[x,y,w,h] (0-1), page, text } }
 */
import { state, ui, actions } from "./state.js";
import { escapeHtml, toast } from "./util.js";
import { openModal } from "./modal.js";

function annotationEvidence() {
  if (!state.annotation) return {};
  if (!state.annotation.evidence || typeof state.annotation.evidence !== "object") {
    state.annotation.evidence = {};
  }
  return state.annotation.evidence;
}

function bindEvidenceViewer() {
  if (!ui.viewer) return;
  ui.viewer.setHandlers({
    onBox: (bbox, point) => handleBox(bbox, point),
    onPick: (path) => {
      actions.revealField(path, { scroll: true, focus: true });
      if (ui.viewer) ui.viewer.highlight(path);
    },
  });
}

function syncEvidence() {
  // 任何切 case / 切项目 / 重载标注都会走到这里，统一关掉证据编辑器，
  // 避免残留的弹窗闭包把旧字段文本写进新 case、并让快捷键全局失效。
  closeEvidenceEditor();
  ui.evidencePath = null;
  if (!ui.viewer) return;
  ui.viewer.setEvidence(annotationEvidence());
  ui.viewer.setSelectionMode(false);
}

function cancelBoxSelect() {
  if (ui.viewer) ui.viewer.setSelectionMode(false);
  ui.evidencePath = null;
  closeEvidenceEditor();
}

function startBoxSelect(path) {
  if (!state.annotation) {
    toast("Select a case first", true);
    return;
  }
  if (ui.rightCollapsed) actions.setRightCollapsed(false);
  ui.evidencePath = path;
  closeEvidenceEditor();
  if (ui.viewer) ui.viewer.setSelectionMode(true);
  toast("Drag a box over the value in the image");
}

function locateField(path, event = {}) {
  if (!state.annotation || !path) return;
  const evidence = annotationEvidence();
  if (event.altKey && evidence[path]) {
    delete evidence[path];
    actions.markDirty();
    syncEvidence();
    toast("Evidence removed");
    return;
  }
  if (event.shiftKey || !evidence[path]) {
    startBoxSelect(path);
    return;
  }
  if (ui.viewer && ui.viewer.highlight(path)) {
    actions.revealField(path, { scroll: true });
  }
}

function closeEvidenceEditor() {
  if (!ui.evidenceEditor) return;
  const { el, cleanup } = ui.evidenceEditor;
  ui.evidenceEditor = null;
  cleanup();
  el.remove();
}

function openEvidenceEditor(bbox, point, path) {
  closeEvidenceEditor();
  const evidence = annotationEvidence();
  const existing = evidence[path] || {};
  const container = document.getElementById("form-scroll");
  const info = container && container._fieldMap ? container._fieldMap.get(path) : null;
  const nodeType = info && info.node ? info.node.type : "";
  const canFill = nodeType === "string" || nodeType === "number";
  const currentValue = canFill ? actions.getValueAtPath(state.values, path) : "";

  const el = document.createElement("div");
  el.className = "evidence-editor";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", `Link image region to ${path}`);
  el.innerHTML = `
    <div class="evidence-editor-head"><i class="bi bi-bounding-box"></i><span>${escapeHtml(path)}</span></div>
    <label class="evidence-editor-label" for="evidence-text">Text in this region (optional)</label>
    <input id="evidence-text" type="text" autocomplete="off" spellcheck="false"
      placeholder="Type what you read, then press Enter to fill the field"
      value="${escapeHtml(existing.text || (currentValue == null ? "" : String(currentValue)))}" />
    <div class="evidence-editor-hint">${
      canFill
        ? "Enter keeps the region and writes the text into this field."
        : "This field is structured; only the region will be saved."
    }</div>
    <div class="evidence-editor-actions">
      <button type="button" class="btn small ghost" data-evidence="cancel">Cancel</button>
      <button type="button" class="btn small" data-evidence="box">Box only</button>
      <button type="button" class="btn small primary" data-evidence="fill">${canFill ? "Save &amp; fill" : "Save region"}</button>
    </div>
  `;
  document.body.appendChild(el);

  const width = 320;
  const left = Math.min(
    Math.max(8, (point && point.clientX ? point.clientX : window.innerWidth / 2) - width / 2),
    Math.max(8, window.innerWidth - width - 8)
  );
  const top = Math.min(
    Math.max(8, (point && point.clientY ? point.clientY : window.innerHeight / 2) + 12),
    Math.max(8, window.innerHeight - el.offsetHeight - 8)
  );
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;

  const input = el.querySelector("#evidence-text");
  const submit = (fill) => {
    const text = input.value.trim();
    evidence[path] = {
      bbox: bbox.map((part) => Math.round(part * 100000) / 100000),
      page: Number(existing.page) || 0,
      text,
    };
    if (fill && canFill && text) {
      actions.setValueAtPath(state.values, path, text);
      actions.renderFormArea();
    }
    closeEvidenceEditor();
    actions.markDirty();
    syncEvidence();
    if (ui.viewer) ui.viewer.highlight(path);
    toast(fill && canFill && text ? "Region linked and field filled" : "Region linked to field");
  };

  const onKey = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeEvidenceEditor();
      return;
    }
    if (event.key === "Enter" && document.activeElement === input) {
      event.preventDefault();
      submit(true);
    }
  };
  const onPointer = (event) => {
    if (el.contains(event.target)) return;
    closeEvidenceEditor();
  };
  const timer = setTimeout(() => {
    document.addEventListener("pointerdown", onPointer, true);
  }, 0);
  document.addEventListener("keydown", onKey, true);
  el.addEventListener("click", (event) => {
    const button = event.target.closest("[data-evidence]");
    if (!button) return;
    const kind = button.dataset.evidence;
    if (kind === "cancel") closeEvidenceEditor();
    else if (kind === "box") submit(false);
    else submit(true);
  });

  ui.evidenceEditor = {
    el,
    cleanup: () => {
      clearTimeout(timer);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointer, true);
    },
  };
  input.focus();
  input.select();
}

function handleBox(bbox, point) {
  const path = ui.evidencePath;
  if (!ui.viewer) return;
  ui.viewer.setSelectionMode(false);
  if (!path || !state.annotation) {
    toast("Select a field first, then draw its region", true);
    return;
  }
  ui.evidencePath = null;
  openEvidenceEditor(bbox, point, path);
}

// 框选过程中按 Esc 退出；捕获阶段优先于弹窗的 Esc 处理。
document.addEventListener(
  "keydown",
  (event) => {
    if (event.key !== "Escape") return;
    if (ui.evidenceEditor) {
      event.stopPropagation();
      closeEvidenceEditor();
      return;
    }
    if (ui.evidencePath && ui.viewer && ui.viewer.isSelecting()) {
      event.preventDefault();
      event.stopPropagation();
      cancelBoxSelect();
      toast("Box select cancelled");
    }
  },
  true
);

function pickFieldForEvidence() {
  if (!state.annotation) {
    toast("Select a case first", true);
    return;
  }
  const container = document.getElementById("form-scroll");
  const map = container && container._fieldMap;
  if (!map || !map.size) {
    toast("This schema has no fields yet", true);
    return;
  }
  const paths = [...map.entries()]
    .filter(([, info]) => info.node && ["string", "number"].includes(info.node.type))
    .map(([path]) => path);
  if (!paths.length) {
    toast("No text or number fields to link", true);
    return;
  }
  const modal = openModal({ title: "Link a field to the image" });
  const hint = document.createElement("p");
  hint.className = "muted";
  hint.textContent = "Pick a field, then drag a box over its value in the image.";
  modal.body.appendChild(hint);
  const list = document.createElement("div");
  list.className = "evidence-field-list";
  list.innerHTML = paths
    .map(
      (path) =>
        `<button type="button" class="btn small" data-evidence-path="${escapeHtml(path)}"><i class="bi bi-bounding-box"></i>${escapeHtml(path)}</button>`
    )
    .join("");
  list.addEventListener("click", (event) => {
    const button = event.target.closest("[data-evidence-path]");
    if (!button) return;
    modal.close();
    startBoxSelect(button.dataset.evidencePath);
  });
  modal.body.appendChild(list);
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => modal.close());
  modal.foot.appendChild(cancel);
}

Object.assign(actions, {
  bindEvidenceViewer,
  syncEvidence,
  cancelBoxSelect,
  startBoxSelect,
  locateField,
  pickFieldForEvidence,
  closeEvidenceEditor,
  handleBox,
});
