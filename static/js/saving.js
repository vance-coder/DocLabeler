/**
 * 自动保存、乐观锁冲突处理、差异刷新与字段回退。
 *
 * 从 main.js 拆分而来；状态见 state.js，跨模块调用统一走 actions。
 */
import { state, actions, scheduleSave } from "./state.js";
import { api, projectUrl } from "./api.js";
import { formatTime, toast } from "./util.js";
import { applyDiff } from "./form.js";

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
  const caseId = state.currentId;
  state.saving = true;
  state.dirty = false;
  scheduleSave.cancel();
  actions.setSaveState("saving", "Saving…");
  try {
    const res = await api.put(
      projectUrl(state.projectId, `/annotations/${encodeURIComponent(caseId)}`),
      {
        values: state.values,
        notes: state.annotation.notes || {},
        confidence: state.annotation.confidence || {},
        evidence: state.annotation.evidence || {},
        status: state.annotation.status || "draft",
        tags: state.annotation.tags || [],
        expected_rev: state.annotation.rev,
      }
    );
    // 保存期间如果已经切到别的 case / 项目，这个响应只属于旧 case，
    // 不能再覆盖 state.annotation，否则下一次保存会把旧数据写进新 case。
    if (state.currentId === caseId) {
      state.annotation = res.annotation;
      actions.hideConflictBanner();
      actions.setSaveState("saved", `Saved ${formatTime(res.annotation.updated_at)}`);
      updateCurrentSummary();
      await refreshDiff();
      actions.renderRaw();
      const missing = actions.updateRequiredBanner();
      if (missing.length && !(advance && state.autoAdvance)) {
        const active = document.activeElement;
        const typingInForm = Boolean(
          actions.isTypingTarget(active) && active.closest && active.closest("#form-scroll")
        );
        actions.revealField(missing[0], {
          focus: false,
          scroll: !(options.auto === true && typingInForm),
        });
      }
      if (advance && state.autoAdvance) actions.gotoNextUnlabeled({ silent: true });
      actions.reloadSearchIndex?.();
    }
    return true;
  } catch (error) {
    if (state.currentId === caseId) {
      if (error.status === 409) {
        state.conflict = true;
        state.dirty = true;
        actions.setSaveState("dirty", "Unsaved changes");
        actions.showConflictBanner();
      } else {
        state.dirty = true;
        actions.setSaveState("error", "Save failed");
        toast(error.message, true);
      }
    }
    return false;
  } finally {
    state.saving = false;
    if (state.pendingSave) {
      state.pendingSave = false;
      if (!state.conflict) saveNow(false, { advance: false });
    }
    // 先让后续保存把 state.saving 重新置位，再唤醒等待者；
    // 等待者用 while 循环复查，不会在两次保存之间插队。
    const waiters = state.saveWaiters.splice(0);
    waiters.forEach((resolve) => resolve());
  }
}

async function reloadAnnotation() {
  if (!state.currentId) return;
  const [annotationRes, diffRes] = await Promise.all([
    api.get(projectUrl(state.projectId, `/annotations/${encodeURIComponent(state.currentId)}`)),
    api.get(projectUrl(state.projectId, `/diff/${encodeURIComponent(state.currentId)}`)),
  ]);
  actions.applyAnnotation(annotationRes, diffRes);
  actions.syncMetaInputs();
  actions.renderFormArea();
  actions.renderRaw();
  actions.hideConflictBanner();
  // 重新加载标注后必须同步证据框与框选状态，否则 viewer 仍持有旧 annotation。
  actions.cancelBoxSelect();
  actions.syncEvidence();
  actions.setSaveState("saved", `Reloaded ${formatTime(state.annotation.updated_at)}`);
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
  actions.setSaveState("saving", "Saving…");
  try {
    const latest = await api.get(
      projectUrl(state.projectId, `/annotations/${encodeURIComponent(state.currentId)}`)
    );
    const res = await api.put(
      projectUrl(state.projectId, `/annotations/${encodeURIComponent(state.currentId)}`),
      {
        values: state.values,
        notes: state.annotation.notes || {},
        confidence: state.annotation.confidence || {},
        evidence: state.annotation.evidence || {},
        status: state.annotation.status || "draft",
        tags: state.annotation.tags || [],
        expected_rev: latest.annotation.rev,
      }
    );
    state.annotation = res.annotation;
    state.dirty = false;
    actions.hideConflictBanner();
    actions.syncMetaInputs();
    actions.setSaveState("saved", `Saved ${formatTime(res.annotation.updated_at)}`);
    updateCurrentSummary();
    await refreshDiff();
    actions.renderRaw();
    toast("Kept your local changes");
  } catch (error) {
    state.conflict = true;
    state.dirty = true;
    actions.setSaveState("dirty", "Unsaved changes");
    actions.showConflictBanner();
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
      actions.applyOnlyChanged(container);
    }
    actions.updateDiffBar();
    actions.updateRequiredBanner();
    actions.requestValidation();
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
    confidence_min: item.annotation ? item.annotation.confidence_min : null,
    low_confidence: item.annotation ? item.annotation.low_confidence : 0,
    validation_errors: state.validationErrors.length,
    evidence_count: Object.keys(state.annotation.evidence || {}).length,
  };
  actions.renderCaseList();
  actions.updateProgress();
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

Object.assign(actions, {
  saveNow,
  reloadAnnotation,
  reloadFromConflict,
  keepMine,
  refreshDiff,
  updateCurrentSummary,
  revertField,
});
