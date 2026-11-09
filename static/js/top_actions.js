/**
 * 顶栏弹窗入口、字段跳转与重新扫描。
 *
 * 从 main.js 拆分而来；状态见 state.js，跨模块调用统一走 actions。
 */
import { state, actions } from "./state.js";
import { api, projectUrl } from "./api.js";
import { toast } from "./util.js";
import { openSchemaEditor } from "./schema_editor.js";
import { openImportModal, openExportModal } from "./modals.js";
import { openNotesPromptModal } from "./notes.js";

// ---------------------------------------------------------------------------
// 顶部操作
// ---------------------------------------------------------------------------
function openSchema() {
  openSchemaEditor({
    projectId: state.projectId,
    schemaInfo: state.schemaInfo,
    onSaved: async () => {
      state.dirty = false;
      await actions.refreshProject();
    },
  });
}

function openImport() {
  openImportModal({
    projectId: state.projectId,
    onDone: async () => {
      await actions.refreshProject();
    },
  });
}

function openExport() {
  const baseCases = state.cases;
  openExportModal({
    projectId: state.projectId,
    allCases: baseCases,
    filteredCases: actions.filteredCases(),
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
    await actions.selectCase(caseId);
  }
  if (!state.currentId || state.currentId !== caseId) return;
  const container = document.getElementById("form-scroll");
  const info = container && container._fieldMap ? container._fieldMap.get(fieldPath) : null;
  if (state.onlyChanged && (!info || info.row.offsetParent === null)) {
    actions.setOnlyChanged(false);
  }
  requestAnimationFrame(() => {
    actions.revealField(fieldPath, { scroll: true });
  });
}

async function rescan() {
  try {
    await api.post(projectUrl(state.projectId, "/rescan"), {});
    toast("Image folder rescanned");
    await actions.refreshProject();
  } catch (error) {
    actions.renderError("Rescan failed", error);
  }
}

Object.assign(actions, {
  openSchema,
  openImport,
  openExport,
  openNotesPrompt,
  jumpToCaseField,
  rescan,
});
