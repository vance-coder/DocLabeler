/**
 * case 搜索、过滤、分组列表与导航。
 *
 * 从 main.js 拆分而来；状态见 state.js，跨模块调用统一走 actions。
 */
import { state, ui, actions, FILTERS, LOW_CONFIDENCE, SAMPLE_TAG } from "./state.js";
import { api, projectUrl } from "./api.js";
import { escapeHtml, toast } from "./util.js";

// Filters 菜单的关闭逻辑只注册一次，避免每次重绘都叠加监听器。
document.addEventListener("click", (event) => {
  const menu = document.getElementById("filter-menu");
  if (!menu || menu.hidden) return;
  if (!event.target.closest(".filter-menu-wrap")) menu.hidden = true;
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  const menu = document.getElementById("filter-menu");
  if (menu && !menu.hidden) menu.hidden = true;
});

// ---------------------------------------------------------------------------
// 列表
// ---------------------------------------------------------------------------

function searchHitsFor(item, needle) {
  if (ui.searchHitCache.query !== needle) {
    ui.searchHitCache = { query: needle, map: new Map() };
  }
  if (ui.searchHitCache.map.has(item.case_id)) {
    return ui.searchHitCache.map.get(item.case_id);
  }
  const entries = state.searchIndex ? state.searchIndex[item.case_id] || [] : [];
  const hits = entries.filter((entry) => {
    if (String(entry.text || "").toLowerCase().includes(needle)) return true;
    if (String(entry.label || "").toLowerCase().includes(needle)) return true;
    return String(entry.path || "").toLowerCase().includes(needle);
  });
  ui.searchHitCache.map.set(item.case_id, hits);
  return hits;
}

function matchesSearch(item, query) {
  if (!query) return true;
  const needle = query.toLowerCase();
  if (String(item.case_id || "").toLowerCase().includes(needle)) return true;
  if (String(item.source || "").toLowerCase().includes(needle)) return true;
  return searchHitsFor(item, needle).length > 0;
}

function fieldHitsFor(item) {
  if (!state.search) return [];
  const needle = state.search.toLowerCase();
  if (
    String(item.case_id || "").toLowerCase().includes(needle) ||
    String(item.source || "").toLowerCase().includes(needle)
  ) {
    return [];
  }
  return searchHitsFor(item, needle);
}

async function loadSearchIndex(projectId) {
  try {
    const res = await api.get(projectUrl(projectId, "/search-index"));
    if (state.projectId !== projectId) return;
    state.searchIndex = res.cases || {};
    ui.searchHitCache = { query: "", map: new Map() };
    if (state.search) renderCaseList();
  } catch (error) {
    /* 全局搜索不可用时，仍可搜索 case ID 与路径 */
  }
}

function reloadSearchIndex() {
  // 保存后字段值 / 备注可能变了；索引存在时重新拉一次，避免搜到旧内容。
  if (!state.projectId || !state.searchIndex) return;
  actions.loadSearchIndex(state.projectId);
}

function caseMatchesFilter(item, key) {
  const annotation = item.annotation;
  switch (key) {
    case "pending":
      return !annotation || annotation.status !== "done";
    case "modified":
      return Boolean(annotation && annotation.diff_count > 0);
    case "unlabeled":
      return !annotation;
    case "low":
      return Boolean(annotation && annotation.low_confidence > 0);
    case "invalid":
      return Boolean(annotation && annotation.validation_errors > 0);
    case "sample":
      return Boolean(
        annotation &&
          Array.isArray(annotation.tags) &&
          annotation.tags.includes(SAMPLE_TAG)
      );
    case "done":
      return Boolean(annotation && annotation.status === "done");
    case "notes":
      return Boolean(annotation && annotation.notes_count > 0);
    default:
      return true;
  }
}

function searchIn(items) {
  return items.filter((item) => matchesSearch(item, state.search));
}

function filterIn(items) {
  return items.filter((item) => caseMatchesFilter(item, state.filter));
}

function tagCounts(items) {
  const counts = new Map();
  for (const item of items) {
    const tags =
      item.annotation && Array.isArray(item.annotation.tags) ? item.annotation.tags : [];
    for (const tag of new Set(tags)) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function matchesTag(item) {
  if (!state.tagFilter) return true;
  const tags =
    item.annotation && Array.isArray(item.annotation.tags) ? item.annotation.tags : [];
  return tags.includes(state.tagFilter);
}

function searchedCases() {
  return searchIn(state.cases).filter(matchesTag);
}

function filteredCases() {
  return filterIn(searchedCases());
}

function listEmptyHtml(icon, text) {
  return `<div class="empty-state list-empty"><i class="bi ${icon}" aria-hidden="true"></i><p>${escapeHtml(text)}</p></div>`;
}

// 3 个状态常驻；其余过滤收进 Filters 菜单，选中后菜单按钮上显示当前条件。
const PRIMARY_FILTERS = new Set(["all", "pending", "done"]);

function renderFilterChips(filterRow, base) {
  if (!filterRow) return;
  const counts = new Map(
    FILTERS.map((filter) => [
      filter.key,
      base.filter((item) => caseMatchesFilter(item, filter.key)).length,
    ])
  );
  const advanced = FILTERS.filter((filter) => !PRIMARY_FILTERS.has(filter.key));
  const activeAdvanced = advanced.find((filter) => filter.key === state.filter);

  const stateChips = FILTERS.filter((filter) => PRIMARY_FILTERS.has(filter.key))
    .map((filter) => {
      const label = filter.key === "pending" ? "To review" : filter.label;
      return `<button type="button" class="chip${state.filter === filter.key ? " active" : ""}" data-filter="${filter.key}" aria-pressed="${state.filter === filter.key}">${escapeHtml(label)} <span class="chip-count">${counts.get(filter.key) || 0}</span></button>`;
    })
    .join("");

  const triggerLabel = activeAdvanced
    ? `<i class="bi bi-funnel" aria-hidden="true"></i>${escapeHtml(activeAdvanced.label)}<span class="chip-count">${counts.get(activeAdvanced.key) || 0}</span>`
    : `<i class="bi bi-funnel" aria-hidden="true"></i>Filters`;

  const menu = advanced
    .map((filter) => {
      const active = state.filter === filter.key;
      return `<button type="button" data-filter="${filter.key}" class="${active ? "active" : ""}" aria-pressed="${active}"><span>${escapeHtml(filter.label)}</span><span class="chip-count">${counts.get(filter.key) || 0}</span></button>`;
    })
    .join("");

  filterRow.innerHTML = `${stateChips}
    <div class="filter-menu-wrap">
      <button type="button" class="chip filter-trigger${activeAdvanced ? " active" : ""}" id="filter-trigger" aria-haspopup="true" aria-expanded="false">${triggerLabel}</button>
      <div class="filter-menu" id="filter-menu" hidden>${menu}</div>
    </div>`;

  filterRow.querySelectorAll("[data-filter]").forEach((chip) => {
    chip.addEventListener("click", () => {
      state.filter = chip.dataset.filter;
      renderCaseList();
    });
  });

  const trigger = filterRow.querySelector("#filter-trigger");
  const menuEl = filterRow.querySelector("#filter-menu");
  if (trigger && menuEl) {
    trigger.addEventListener("click", () => {
      menuEl.hidden = !menuEl.hidden;
      trigger.setAttribute("aria-expanded", String(!menuEl.hidden));
    });
  }
}

function groupedCasesHtml(visible) {
  const groups = new Map();
  for (const item of visible) {
    const folder = item.folder && item.folder !== "." ? item.folder : "Root";
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push(item);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([folder, items]) => {
      const rows = items.map(caseRowHtml).join("");
      return `<details class="folder-group" open>
        <summary>${escapeHtml(folder)} <span class="muted">${items.length}</span></summary>
        <div class="list-group list-group-flush">${rows}</div>
      </details>`;
    })
    .join("");
}

function renderTagChips(items) {
  const row = document.getElementById("tag-row");
  if (!row) return;
  const counts = tagCounts(items);
  if (!counts.length) {
    row.hidden = true;
    row.innerHTML = "";
    state.tagFilter = "";
    return;
  }
  if (state.tagFilter && !counts.some(([tag]) => tag === state.tagFilter)) {
    state.tagFilter = "";
  }
  row.hidden = false;
  row.innerHTML = counts
    .map(
      ([tag, count]) =>
        `<button type="button" class="chip tag-chip${state.tagFilter === tag ? " active" : ""}" data-tag="${escapeHtml(tag)}" aria-pressed="${state.tagFilter === tag}"><i class="bi bi-tag" aria-hidden="true"></i>${escapeHtml(tag)} <span class="chip-count">${count}</span></button>`
    )
    .join("");
  row.querySelectorAll("[data-tag]").forEach((chip) => {
    chip.addEventListener("click", () => {
      const tag = chip.dataset.tag;
      state.tagFilter = state.tagFilter === tag ? "" : tag;
      renderCaseList();
    });
  });
}

// 大目录（几万张图）时只渲染前 N 行：浏览器不会被几万个 DOM 节点卡死，
// 仍然可以用搜索 / 过滤定位，上一张、下一张也能遍历全部 case。
const MAX_ROWS = 1000;

function renderImagesCaseList() {
  const list = document.getElementById("case-list");
  if (!list) return;
  const searched = searchIn(state.cases);
  renderTagChips(searched);
  const base = searched.filter(matchesTag);
  renderFilterChips(document.getElementById("filter-row"), base);
  let visible = filterIn(base);
  if (state.filter === "low") {
    visible = [...visible].sort((a, b) => {
      const left =
        a.annotation && typeof a.annotation.confidence_min === "number"
          ? a.annotation.confidence_min
          : 1;
      const right =
        b.annotation && typeof b.annotation.confidence_min === "number"
          ? b.annotation.confidence_min
          : 1;
      return left - right;
    });
  } else if (state.filter === "pending") {
    visible = [...visible].sort((a, b) => reviewPriority(b) - reviewPriority(a));
  }
  const count = document.getElementById("case-count");
  if (count) count.textContent = `${visible.length}/${state.cases.length}`;

  let emptyState = listEmptyHtml("bi-funnel", "No cases match this filter.");
  if (!state.cases.length) {
    emptyState = listEmptyHtml(
      "bi-images",
      "No images in this project."
    );
  } else if (state.search && !searched.length) {
    emptyState = listEmptyHtml(
      "bi-search",
      `No cases match “${state.search}”.`
    );
  } else if (state.tagFilter && !base.length) {
    emptyState = listEmptyHtml(
      "bi-tag",
      `No cases tagged “${state.tagFilter}”.`
    );
  }
  const shown = visible.length > MAX_ROWS ? visible.slice(0, MAX_ROWS) : visible;
  let html = groupedCasesHtml(shown) || emptyState;
  if (visible.length > MAX_ROWS) {
    html += `<div class="list-more-note">Showing first ${MAX_ROWS} of ${visible.length} cases — use search or filters to narrow down.</div>`;
  }
  list.innerHTML = html;
}

function renderCaseList() {
  renderImagesCaseList();
  actions.updateBulkBar();
  actions.renderThumbs();
}

// 单独抽出徽标 HTML：校验结果返回后只需替换这一行的徽标，
// 不必整表重绘（整表重绘会打断多选、列表滚动与缩略图 observer）。
function caseBadgesHtml(item) {
  const annotation = item.annotation;
  const badges = [];
  if (annotation && annotation.diff_count > 0) {
    badges.push(
      `<span class="badge" title="${annotation.diff_count} modified fields"><i class="bi bi-pencil-square"></i>${annotation.diff_count}</span>`
    );
  }
  if (annotation && annotation.notes_count > 0) {
    badges.push(
      `<span class="badge note" title="${annotation.notes_count} notes"><i class="bi bi-sticky"></i>${annotation.notes_count}</span>`
    );
  }
  const tags = annotation && Array.isArray(annotation.tags) ? annotation.tags : [];
  if (tags.length) {
    badges.push(
      `<span class="badge tag" title="${escapeHtml(tags.join(", "))}"><i class="bi bi-tag"></i>${tags.length}</span>`
    );
  }
  if (annotation && annotation.validation_errors > 0) {
    badges.push(
      `<span class="badge rule" title="${annotation.validation_errors} cross-field rule errors"><i class="bi bi-exclamation-octagon"></i>${annotation.validation_errors}</span>`
    );
  }
  if (annotation && annotation.evidence_count > 0) {
    badges.push(
      `<span class="badge evidence" title="${annotation.evidence_count} fields linked to image regions"><i class="bi bi-bounding-box"></i>${annotation.evidence_count}</span>`
    );
  }
  if (
    annotation &&
    Array.isArray(annotation.tags) &&
    annotation.tags.includes(SAMPLE_TAG)
  ) {
    badges.push(
      `<span class="badge sample" title="Sampled for manual review"><i class="bi bi-shuffle"></i>sample</span>`
    );
  }
  if (
    annotation &&
    typeof annotation.confidence_min === "number" &&
    annotation.confidence_min < LOW_CONFIDENCE
  ) {
    const percent = Math.round(annotation.confidence_min * 100);
    badges.push(
      `<span class="badge conf" title="Lowest model confidence ${percent}%${annotation.low_confidence ? ` · ${annotation.low_confidence} field(s) below ${Math.round(LOW_CONFIDENCE * 100)}%` : ""}"><i class="bi bi-exclamation-triangle"></i>${percent}%</span>`
    );
  }
  return badges;
}

// 过滤 chip 的计数跟着局部更新，避免「Rule errors N」与实际数据不一致。
function refreshFilterCounts() {
  const filterRow = document.getElementById("filter-row");
  if (!filterRow) return;
  const base = searchedCases().filter(matchesTag);
  filterRow.querySelectorAll("[data-filter]").forEach((chip) => {
    const number = chip.querySelector(".chip-count");
    if (number) {
      number.textContent = String(
        base.filter((item) => caseMatchesFilter(item, chip.dataset.filter)).length
      );
    }
  });
}

function updateCaseValidationBadge(caseId, count) {
  const item = state.cases.find((entry) => entry.case_id === caseId);
  if (!item) return;
  if (!item.annotation) item.annotation = {};
  item.annotation.validation_errors = Number(count) || 0;

  // invalid 过滤下，计数增减会改变列表成员，必须整表重绘；其它过滤只改当前行。
  if (state.filter === "invalid") {
    actions.renderCaseList();
    return;
  }
  const list = document.getElementById("case-list");
  let row = null;
  if (list) {
    try {
      row = list.querySelector(`.case-item[data-case="${CSS.escape(caseId)}"]`);
    } catch (error) {
      row = null;
    }
  }
  if (row) {
    row.querySelectorAll(".badge").forEach((badge) => badge.remove());
    const anchor = row.querySelector(".case-name");
    if (anchor) anchor.insertAdjacentHTML("afterend", caseBadgesHtml(item).join(""));
  }
  refreshFilterCounts();
}

function caseRowHtml(item) {
  const annotation = item.annotation;
  const source = String(item.source || "");
  const normalized = source.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  const fileName = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  const dirPath = slash > 0 ? normalized.slice(0, slash) : "";
  const displayName = fileName || item.case_id;
  const fullTitle = `${item.case_id} · ${source}`;
  const dotClass =
    annotation && annotation.status === "done"
      ? "dot done"
      : annotation && annotation.diff_count > 0
      ? "dot diff"
      : "dot";
  const dotTitle =
    annotation && annotation.status === "done"
      ? "Done"
      : annotation && annotation.diff_count > 0
      ? "Modified"
      : "Unlabeled";
  const badges = caseBadgesHtml(item);
  const hits = fieldHitsFor(item);
  const hitHtml = hits.length
    ? `<span class="case-hits">${hits
        .slice(0, 2)
        .map(
          (hit) =>
            `<button type="button" class="case-hit" data-hit-case="${escapeHtml(item.case_id)}" data-hit-path="${escapeHtml(hit.path)}" title="${escapeHtml(`${hit.kind === "note" ? "Note" : "Value"}: ${hit.text}`)}">${escapeHtml(hit.label || hit.path)}</button>`
        )
        .join("")}${
        hits.length > 2 ? `<span class="case-hit-more">+${hits.length - 2}</span>` : ""
      }</span>`
    : "";
  return `<div class="case-item list-group-item${item.case_id === state.currentId ? " active" : ""}" data-case="${escapeHtml(item.case_id)}">
    <input type="checkbox" data-check="${escapeHtml(item.case_id)}" ${state.selected.has(item.case_id) ? "checked" : ""} aria-label="Select case" />
    <span class="${dotClass}" title="${dotTitle}"></span>
    <span class="case-name" title="${escapeHtml(fullTitle)}">
      <span class="case-file">${escapeHtml(displayName)}</span>
      ${dirPath ? `<span class="case-dir">${escapeHtml(dirPath)}</span>` : ""}
      ${hitHtml}
    </span>
    ${badges.join("")}
  </div>`;
}

function onCaseListClick(event) {
  const hit = event.target.closest("[data-hit-path]");
  if (hit) {
    event.preventDefault();
    actions.jumpToCaseField(hit.dataset.hitCase, hit.dataset.hitPath);
    return;
  }
  const checkbox = event.target.closest("[data-check]");
  if (checkbox) {
    const id = checkbox.dataset.check;
    if (state.selected.has(id)) state.selected.delete(id);
    else state.selected.add(id);
    renderCaseList();
    return;
  }
  const item = event.target.closest("[data-case]");
  if (item) actions.selectCase(item.dataset.case);
}

function gotoRelative(delta) {
  const visible = filteredCases();
  if (!visible.length) return;
  const index = visible.findIndex((item) => item.case_id === state.currentId);
  const next = visible[index + delta];
  if (next) actions.selectCase(next.case_id);
}

// 复核队列：校验错误 > 低置信度 > 人工改过 > 抽样强制人工
function reviewPriority(item) {
  const annotation = item.annotation || {};
  const tags = Array.isArray(annotation.tags) ? annotation.tags : [];
  return (
    (annotation.validation_errors > 0 ? 8 : 0) +
    (annotation.low_confidence > 0 ? 4 : 0) +
    (annotation.diff_count > 0 ? 2 : 0) +
    (tags.includes(SAMPLE_TAG) ? 1 : 0)
  );
}

function pendingCases() {
  return filteredCases()
    .filter((item) => !item.annotation || item.annotation.status !== "done")
    .sort((a, b) => reviewPriority(b) - reviewPriority(a));
}

function gotoNextPending(options = {}) {
  const queue = pendingCases();
  if (!queue.length) {
    if (!options.silent) toast("All cases in this view are reviewed");
    return false;
  }
  const index = queue.findIndex((item) => item.case_id === state.currentId);
  const next = queue[(index + 1) % queue.length];
  if (!next || next.case_id === state.currentId) {
    if (!options.silent) toast("This is the only pending case in this view");
    return false;
  }
  actions.selectCase(next.case_id);
  return true;
}

function gotoNextUnlabeled(options = {}) {
  const visible = filteredCases();
  if (!visible.length) {
    if (!options.silent) toast("No cases in the current view", true);
    return false;
  }
  const start = visible.findIndex((item) => item.case_id === state.currentId);
  for (let step = 1; step <= visible.length; step += 1) {
    const item = visible[(start + step + visible.length) % visible.length];
    if (!item.annotation && item.case_id !== state.currentId) {
      actions.selectCase(item.case_id);
      return true;
    }
  }
  if (!options.silent) {
    toast(
      state.search || state.filter !== "all"
        ? "No unlabeled cases in the current view"
        : "All cases are labeled"
    );
  }
  return false;
}

async function markDoneAndAdvance() {
  if (!state.currentId || !state.annotation) return;
  if (state.conflict) {
    toast("Resolve the save conflict first", true);
    return;
  }
  state.annotation.status = "done";
  const select = document.getElementById("status-select");
  if (select) select.value = "done";
  actions.markDirty();
  const saved = await actions.saveNow(true, { advance: false });
  if (saved) gotoNextPending({ silent: true });
}

Object.assign(actions, {
  searchHitsFor,
  matchesSearch,
  fieldHitsFor,
  loadSearchIndex,
  reloadSearchIndex,
  caseMatchesFilter,
  searchIn,
  filterIn,
  tagCounts,
  matchesTag,
  searchedCases,
  filteredCases,
  listEmptyHtml,
  renderFilterChips,
  groupedCasesHtml,
  renderTagChips,
  renderImagesCaseList,
  renderCaseList,
  caseRowHtml,
  caseBadgesHtml,
  refreshFilterCounts,
  updateCaseValidationBadge,
  onCaseListClick,
  gotoRelative,
  reviewPriority,
  pendingCases,
  gotoNextPending,
  gotoNextUnlabeled,
  markDoneAndAdvance,
});
