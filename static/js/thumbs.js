/**
 * 底部缩略图条（懒加载 + 自动滚动到当前项）。
 *
 * 从 main.js 拆分而来；状态见 state.js，跨模块调用统一走 actions。
 */
import { state, ui, actions } from "./state.js";
import { projectUrl } from "./api.js";
import { escapeHtml } from "./util.js";

// ---------------------------------------------------------------------------
// Thumbnail strip
// ---------------------------------------------------------------------------

function thumbPreviewUrl(caseId) {
  return projectUrl(
    state.projectId,
    `/preview/${encodeURIComponent(caseId)}?w=240`
  );
}

function thumbDotClass(annotation) {
  if (annotation && annotation.status === "done") return "thumb-dot done";
  if (annotation && annotation.diff_count > 0) return "thumb-dot diff";
  return "thumb-dot";
}

function loadThumb(img) {
  const src = img && img.dataset ? img.dataset.src : "";
  if (!src) return;
  img.removeAttribute("data-src");
  img.src = src;
}

function ensureThumbVisible() {
  const strip = document.getElementById("thumb-strip");
  if (!strip || strip.hidden) return;
  const active = strip.querySelector(".thumb.active");
  if (!active) return;
  const stripRect = strip.getBoundingClientRect();
  const rect = active.getBoundingClientRect();
  if (rect.left >= stripRect.left + 4 && rect.right <= stripRect.right - 4) return;
  const delta = rect.left - stripRect.left - (strip.clientWidth - rect.width) / 2;
  strip.scrollTo({ left: strip.scrollLeft + delta, behavior: "smooth" });
}

// 缩略图条同样限流：几万张图时不为每张都建 DOM 和观察器。
const MAX_THUMBS = 1000;

function renderThumbs() {
  const strip = document.getElementById("thumb-strip");
  if (!strip) return;
  const all = actions.filteredCases();
  const visible = all.length > MAX_THUMBS ? all.slice(0, MAX_THUMBS) : all;
  const show = visible.length > 1 && Boolean(state.projectId);

  if (!show) {
    if (ui.thumbObserver) {
      ui.thumbObserver.disconnect();
      ui.thumbObserver = null;
    }
    strip.hidden = true;
    strip.innerHTML = "";
    ui.thumbSignature = "";
    ui.lastThumbActive = null;
    return;
  }

  const signature = visible
    .map((item) => {
      const annotation = item.annotation;
      const status = annotation ? annotation.status || "draft" : "unlabeled";
      const diff = annotation && annotation.diff_count > 0 ? "d" : "";
      return `${item.case_id}:${status}:${diff}`;
    })
    .join("|");

  const activeChanged = ui.lastThumbActive !== state.currentId;
  if (signature === ui.thumbSignature) {
    strip.querySelectorAll(".thumb").forEach((thumb) => {
      const active = thumb.dataset.thumb === state.currentId;
      thumb.classList.toggle("active", active);
      thumb.setAttribute("aria-current", active ? "true" : "false");
    });
    if (activeChanged) {
      ensureThumbVisible();
      ui.lastThumbActive = state.currentId;
    }
    return;
  }

  if (ui.thumbObserver) {
    ui.thumbObserver.disconnect();
    ui.thumbObserver = null;
  }
  strip.hidden = false;
  strip.innerHTML = visible
    .map((item) => {
      const active = item.case_id === state.currentId;
      const label = item.source || item.case_id;
      return `<button type="button" class="thumb${active ? " active" : ""}" data-thumb="${escapeHtml(item.case_id)}" title="${escapeHtml(label)}" aria-label="Show ${escapeHtml(label)}" aria-current="${active ? "true" : "false"}">
        <img alt="" data-src="${escapeHtml(thumbPreviewUrl(item.case_id))}" />
        <span class="${thumbDotClass(item.annotation)}" aria-hidden="true"></span>
      </button>`;
    })
    .join("");

  const images = [...strip.querySelectorAll("img[data-src]")];
  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          loadThumb(entry.target);
          observer.unobserve(entry.target);
        }
      },
      { root: strip, rootMargin: "0px 320px" }
    );
    images.forEach((img) => observer.observe(img));
    ui.thumbObserver = observer;
  } else {
    images.forEach(loadThumb);
  }

  ui.thumbSignature = signature;
  ensureThumbVisible();
  ui.lastThumbActive = state.currentId;
}

Object.assign(actions, {
  thumbPreviewUrl,
  thumbDotClass,
  loadThumb,
  ensureThumbVisible,
  renderThumbs,
});
