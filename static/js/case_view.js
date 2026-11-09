/**
 * 选中 case、表单渲染、必填校验与差异条。
 *
 * 从 main.js 拆分而来；状态见 state.js，跨模块调用统一走 actions。
 */
import { state, ui, actions, dom, scheduleSave, KEYS, writeFlag } from "./state.js";
import { api, projectUrl } from "./api.js";
import { escapeHtml, formatTime, isPlainObject, isEmptyValue, joinPath, toast, debounce } from "./util.js";
import { renderForm, applyValidation } from "./form.js";

// ---------------------------------------------------------------------------
// 选中 case
// ---------------------------------------------------------------------------
async function selectCase(caseId) {
  // 正在保存时先等待，避免旧 case 的保存响应落到新 case 上。
  while (state.saving) {
    await new Promise((resolve) => state.saveWaiters.push(resolve));
  }
  if (state.dirty && state.currentId && state.currentId !== caseId) {
    const saved = await actions.saveNow(true, { advance: false });
    if (!saved) return;
  }
  const previousId = state.currentId;
  try {
    const [annotationRes, diffRes] = await Promise.all([
      api.get(projectUrl(state.projectId, `/annotations/${encodeURIComponent(caseId)}`)),
      api.get(projectUrl(state.projectId, `/diff/${encodeURIComponent(caseId)}`)),
    ]);
    // 两个请求都成功后才切换 currentId；失败时表单与列表仍属于原来的 case，
    // 否则自动保存会把上一个 case 的值写到新的 caseId 上。
    state.currentId = caseId;
    applyAnnotation(annotationRes, diffRes);
    actions.hideConflictBanner();
    renderCase();
    actions.renderCaseList();
  } catch (error) {
    state.currentId = previousId;
    actions.renderCaseList();
    toast(error.message, true);
  }
}

function applyAnnotation(annotationRes, diffRes) {
  state.annotation = annotationRes.annotation;
  state.annotation.notes = state.annotation.notes || {};
  state.values = annotationRes.values;
  state.diffFields = (diffRes && diffRes.fields) || [];
  state.dirty = false;
  // 切 case 时清掉上一个 case 的规则错误与横幅，等待新的 /validate 结果。
  state.validationErrors = [];
  actions.updateValidationBanner(0, "");
  actions.resetHistory(state.currentId);
}

function renderCase() {
  const item = state.cases.find((c) => c.case_id === state.currentId);
  if (!item) {
    actions.renderEmptyCase("No case selected");
    return;
  }
  if (ui.viewer) {
    const imageUrl = projectUrl(
      state.projectId,
      `/preview/${encodeURIComponent(item.case_id)}?w=2000`
    );
    state.imageUrl = imageUrl;
    const image = document.getElementById("viewer-img");
    if (!image || image.getAttribute("src") !== imageUrl) actions.setStageState("loading");
    ui.viewer.load(imageUrl);
  }
  const sourceNode = document.getElementById("case-source");
  sourceNode.innerHTML = `<i class="bi bi-file-earmark-image"></i><span>${escapeHtml(item.source)}</span>`;
  sourceNode.title = item.source;
  const warning = document.getElementById("case-warning");
  warning.textContent = item.warning || "";
  warning.className = item.warning ? "warning" : "";

  syncMetaInputs();

  renderFormArea();
  actions.renderRaw();
  actions.setSaveState(
    state.annotation.updated_at ? "saved" : "",
    state.annotation.updated_at
      ? `Saved ${formatTime(state.annotation.updated_at)}`
      : "Not saved yet"
  );
  actions.syncEvidence();
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
    confidence: state.annotation.confidence || {},
    evidence: state.annotation.evidence || {},
    diffFields: state.diffFields,
    onChange: actions.markDirty,
    onRevert: actions.revertField,
    onValueCommit: actions.recordFieldCommit,
    onStructureChange: actions.recordStructureChange,
    onLocate: actions.locateField,
    onValidate: requestValidation,
    onRender: () => {
      applyOnlyChanged(container);
      updateRequiredBanner();
    },
  });
}

// ---------------------------------------------------------------------------
// 跨字段校验：规则只在后端求值，前端防抖请求，保证表单与列表用的是同一套逻辑
// ---------------------------------------------------------------------------
const requestValidation = debounce(async () => {
  if (!state.projectId || !state.values) return;
  const projectId = state.projectId;
  const caseId = state.currentId;
  try {
    const res = await api.post(projectUrl(projectId, "/validate"), {
      values: state.values,
    });
    // 快速连切 case 时丢弃旧响应，别把上一个 case 的错误贴到当前表单。
    if (state.projectId !== projectId || state.currentId !== caseId) return;
    applyValidationErrors(res.errors || []);
  } catch (error) {
    /* 校验接口失败不打断标注 */
  }
}, 300);

function applyValidationErrors(errors) {
  state.validationErrors = errors || [];
  const container = document.getElementById("form-scroll");
  const grouped = container ? applyValidation(container, errors) : new Map();
  const first = (errors || []).find((error) => grouped.has(error.path));
  updateValidationBanner(state.validationErrors.length, first ? first.path : "");
  // 结果一回来就局部刷新当前 case 的 rule-error 徽标与过滤计数，
  // 不必等保存 / 切 case 触发整表重绘。
  actions.updateCaseValidationBadge(state.currentId, state.validationErrors.length);
  return grouped;
}

function updateValidationBanner(count, firstPath) {
  const banner = document.getElementById("validation-banner");
  if (!banner) return;
  const text = document.getElementById("validation-text");
  banner.hidden = !count;
  if (text) {
    text.textContent = `${count} cross-field rule error${count === 1 ? "" : "s"}`;
  }
  const button = document.getElementById("btn-review-validation");
  if (button) button.disabled = !firstPath;
  banner.dataset.firstPath = firstPath || "";
}

function reviewValidation() {
  const banner = document.getElementById("validation-banner");
  const path = banner ? banner.dataset.firstPath : "";
  if (!path) {
    toast("No rule errors in this case");
    return;
  }
  if (state.onlyChanged) setOnlyChanged(false);
  revealField(path, { focus: true, scroll: true });
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
  writeFlag(KEYS.onlyChanged, state.onlyChanged);
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
    const saved = await actions.saveNow(true, { advance: false });
    if (!saved) return;
  }
  state.revertingAll = true;
  updateDiffBar();
  actions.setSaveState("saving", "Reverting…");
  try {
    const res = await api.post(
      projectUrl(
        state.projectId,
        `/annotations/${encodeURIComponent(state.currentId)}/revert`
      ),
      { all: true, expected_rev: state.annotation.rev }
    );
    await actions.reloadAnnotation();
    const reverted = Array.isArray(res.reverted) ? res.reverted.length : 0;
    const missing = Array.isArray(res.missing) ? res.missing.length : 0;
    toast(
      `Reverted ${reverted} field${reverted === 1 ? "" : "s"}` +
        (missing ? ` · ${missing} missing` : "")
    );
  } catch (error) {
    actions.setSaveState("error", "Revert failed");
    toast(error.message, true);
  } finally {
    state.revertingAll = false;
    updateDiffBar();
  }
}

Object.assign(actions, {
  selectCase,
  applyAnnotation,
  renderCase,
  syncMetaInputs,
  renderFormArea,
  scalarIsMissing,
  collectMissingRequired,
  missingRequiredPaths,
  updateRequiredBanner,
  revealField,
  reviewRequired,
  requestValidation,
  applyValidationErrors,
  updateValidationBanner,
  reviewValidation,
  setOnlyChanged,
  applyOnlyChanged,
  updateDiffBar,
  revertAll,
});
