/**
 * 共享状态与依赖注册表。
 *
 * - state / ui：所有 UI 模块共享的可变状态；需要跨模块写入的绑定放在 ui 上。
 * - actions：各模块加载时把函数注册进来，跨模块调用一律 actions.xxx()。
 *   这样模块之间不必循环 import，也不会踩到 ESM 的初始化顺序问题。
 */

import { debounce } from "./util.js";

export const dom = {
  view: document.getElementById("view"),
  topCenter: document.getElementById("topbar-center"),
  topActions: document.getElementById("topbar-actions"),
  conflictBanner: document.getElementById("conflict-banner"),
};

export const KEYS = {
  autoAdvance: "doclabeler.autoAdvance",
  panes: "doclabeler.panes",
  rightCollapsed: "doclabeler.rightCollapsed",
  rawCollapsed: "doclabeler.rawCollapsed",
  onlyChanged: "doclabeler.onlyChanged",
};

export const PANE = {
  LEFT_MIN: 240,
  LEFT_MAX: 560,
  RIGHT_MIN: 360,
  RIGHT_MAX: 640,
  CENTER_MIN: 360,
  DIVIDERS: 10,
  DEFAULT: { left: 300, right: 430 },
};

export const FILTERS = [
  { key: "all", label: "All" },
  { key: "pending", label: "Pending" },
  { key: "modified", label: "Modified" },
  { key: "unlabeled", label: "Unlabeled" },
  { key: "low", label: "Low confidence" },
  { key: "invalid", label: "Rule errors" },
  { key: "sample", label: "Sample" },
  { key: "done", label: "Done" },
  { key: "notes", label: "With notes" },
];

export const LOW_CONFIDENCE = 0.8;
export const SAMPLE_TAG = "review-sample";

export function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

export function readFlag(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value === "1";
  } catch (error) {
    return fallback;
  }
}

export function writeFlag(key, value) {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch (error) {
    /* storage may be unavailable */
  }
}

function readAutoAdvance() {
  try {
    return localStorage.getItem(KEYS.autoAdvance) === "1";
  } catch (error) {
    return false;
  }
}

function readPanes() {
  let left = PANE.DEFAULT.left;
  let right = PANE.DEFAULT.right;
  try {
    const raw = JSON.parse(localStorage.getItem(KEYS.panes) || "null");
    if (raw && typeof raw.left === "number") {
      left = clampNumber(raw.left, PANE.LEFT_MIN, PANE.LEFT_MAX);
    }
    if (raw && typeof raw.right === "number") {
      right = clampNumber(raw.right, PANE.RIGHT_MIN, PANE.RIGHT_MAX);
    }
  } catch (error) {
    /* keep defaults */
  }
  return { left, right };
}

export const state = {
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
  // 正在保存时切 case / 切项目先在这里排队，等保存彻底结束再继续。
  saveWaiters: [],
  search: "",
  autoAdvance: readAutoAdvance(),
  onlyChanged: readFlag(KEYS.onlyChanged, false),
  bulkBusy: false,
  revertingAll: false,
  conflict: false,
  imageUrl: "",
  tagFilter: "",
  searchIndex: null,
  validationErrors: [],
  reviewPendingIds: [],
};

export const ui = {
  paneLayout: readPanes(),
  rightCollapsed: readFlag(KEYS.rightCollapsed, false),
  rawCollapsed: readFlag(KEYS.rawCollapsed, true),
  rawQuery: "",
  thumbObserver: null,
  thumbSignature: "",
  lastThumbActive: null,
  stageObserver: null,
  fitFrame: null,
  viewer: null,
  presentation: null,
  evidencePath: null,
  evidenceEditor: null,
  refreshToken: 0,
  searchHitCache: { query: "", map: new Map() },
};

export const history = {
  caseId: null,
  undo: [],
  redo: [],
  lastPath: null,
  lastAt: 0,
};

export const actions = {};

export const scheduleSave = debounce(() => {
  actions.saveNow(false, { advance: false, auto: true });
}, 1000);
