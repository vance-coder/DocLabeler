/**
 * 无浏览器的前端模块自检：用最小 DOM stub 真实加载全部 ES modules，
 * 再验证本轮新增的两处交互逻辑（刷新失败兜底、校验徽标局部刷新）。
 *
 * 由 tests/test_frontend_smoke.py 通过 node 调用；不需要 Playwright。
 */

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const base = path.resolve(here, "../static/js");
const url = (name) => pathToFileURL(path.join(base, name)).href;

function mkEl() {
  return {
    style: {}, dataset: {}, children: [], innerHTML: "", textContent: "", value: "",
    checked: false, disabled: false, hidden: false, files: [], parentElement: null,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, removeEventListener() {},
    appendChild(child) { return child; },
    append(child) { return child; },
    prepend(child) { return child; },
    insertBefore(child) { return child; },
    insertAdjacentHTML() {},
    remove() {}, setAttribute() {}, getAttribute() { return null; },
    removeAttribute() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    focus() {}, blur() {}, scrollIntoView() {}, click() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 };
    },
    closest() { return null; }, contains() { return false; },
    get offsetParent() { return null; },
    get offsetWidth() { return 100; },
  };
}

const cache = new Map();
globalThis.document = {
  getElementById(id) {
    if (!cache.has(id)) cache.set(id, mkEl());
    return cache.get(id);
  },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  createElement() { return mkEl(); },
  createDocumentFragment() { return mkEl(); },
  addEventListener() {}, removeEventListener() {},
  body: mkEl(), head: mkEl(), documentElement: mkEl(), activeElement: mkEl(),
  hidden: false, fullscreenElement: null,
};
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {}, clear() {} };
globalThis.sessionStorage = globalThis.localStorage;
Object.defineProperty(globalThis, "navigator", {
  value: { clipboard: { writeText() {} }, userAgent: "node" }, configurable: true,
});
globalThis.location = {
  pathname: "/", hash: "", search: "", href: "http://127.0.0.1/", assign() {}, reload() {},
};
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.CSS = { escape: (text) => String(text) };
globalThis.Image = class {};
globalThis.HTMLElement = class {};
globalThis.Event = class {};
globalThis.CustomEvent = class {};
globalThis.alert = () => {};
globalThis.confirm = () => false;
globalThis.window = globalThis;
globalThis.fetch = () => Promise.reject(new Error("network disabled in headless check"));

const { actions, state, ui } = await import(url("state.js"));
// main.js 末尾会自动 route()，这里换成 no-op，避免自检触发网络与整页渲染。
actions.route = () => {};
await import(url("main.js"));

const required = [
  "refreshProject", "showRefreshError", "clearRefreshError",
  "updateCaseValidationBadge", "refreshFilterCounts", "caseBadgesHtml",
];
for (const name of required) {
  if (typeof actions[name] !== "function") {
    throw new Error(`missing action: ${name}`);
  }
}

// 1) 刷新失败：不抛 unhandled rejection，返回 false，且保留旧数据。
state.projectId = "demo";
state.cases = [{ case_id: "c1", source: "c1.png", annotation: { validation_errors: 0 } }];
state.currentId = "c1";
const before = JSON.stringify(state.cases);
const ok = await actions.refreshProject();
if (ok !== false) throw new Error("refreshProject should return false on failure");
if (JSON.stringify(state.cases) !== before) {
  throw new Error("refreshProject must not overwrite state on failure");
}

// 2) 校验徽标：只替换当前行的 badges HTML，不整表重绘。
let inserted = "";
const anchor = { insertAdjacentHTML: (_position, html) => { inserted = html; } };
const row = mkEl();
row.querySelectorAll = () => [];
row.querySelector = () => anchor;
document.getElementById("case-list").querySelector = () => row;
let rendered = 0;
actions.renderCaseList = () => { rendered += 1; };
actions.updateCaseValidationBadge("c1", 2);
if (state.cases[0].annotation.validation_errors !== 2) {
  throw new Error("validation badge did not update the case summary");
}
if (rendered !== 0) throw new Error("badge update must not re-render the whole list");
if (!inserted.includes('class="badge rule"') || !inserted.includes(">2<")) {
  throw new Error(`rule badge was not rendered locally: ${inserted}`);
}

// 3) invalid 过滤下成员会变化，此时允许整表重绘。
state.filter = "invalid";
actions.updateCaseValidationBadge("c1", 0);
if (rendered !== 1) throw new Error("invalid filter should trigger a full list render");

// 4) 列表分批渲染：首屏 60 行、点按钮追加一批、过滤变化回到首屏、
//    跳到远处的 case 时自动把渲染上限扩到能包含它。
state.search = "";
state.tagFilter = "";
state.filter = "all";
state.cases = Array.from({ length: 250 }, (_, i) => ({
  case_id: `c${i}`, source: `c${i}.png`, annotation: null,
}));
const listEl = document.getElementById("case-list");
listEl.querySelector = () => null;
const rowCount = () => (listEl.innerHTML.match(/class="case-item/g) || []).length;

actions.renderImagesCaseList();
if (rowCount() !== 60) throw new Error(`first paint should be 60 rows, got ${rowCount()}`);
if (!listEl.innerHTML.includes("data-more-rows")) {
  throw new Error("remaining cases must expose a show-more control");
}
actions.showMoreCases({ force: true });
if (rowCount() !== 160) throw new Error(`show more should be 160 rows, got ${rowCount()}`);

state.currentId = "c200";
if (!actions.revealActiveCase()) throw new Error("active case outside the window must be revealed");
if (ui.listLimit < 201) throw new Error(`render limit did not cover active case: ${ui.listLimit}`);
state.currentId = null;

state.filter = "pending";
actions.renderImagesCaseList();
if (rowCount() !== 60) throw new Error(`filter change should reset to 60 rows, got ${rowCount()}`);

console.log(`frontend smoke OK; ${Object.keys(actions).length} actions registered`);
