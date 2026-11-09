/**
 * 图片查看器：缩放 / 平移 / 旋转，并叠加字段证据框（evidence overlay）。
 *
 * overlay 与 <img> 使用完全相同的尺寸和 transform，因此无论缩放、平移还是旋转，
 * 归一化 bbox（0-1）都能自动贴合原图；框选时把屏幕坐标逆变换回原图坐标。
 */
export function createViewer({ stage, img, scaleLabel }) {
  const MIN_SCALE = 0.02;
  const MAX_SCALE = 20;
  const state = { scale: 1, fitScale: 1, rotate: 0, tx: 0, ty: 0 };
  let drag = null;
  let frame = 0;
  let handlers = { onBox: null, onPick: null };
  let evidenceMap = {};
  let activePath = null;
  let selectionMode = false;
  let dragBox = null;

  const layer = document.createElement("div");
  layer.className = "evidence-layer";
  layer.setAttribute("aria-hidden", "true");
  stage.appendChild(layer);

  const draft = document.createElement("div");
  draft.className = "evidence-draft";
  draft.hidden = true;
  layer.appendChild(draft);

  function clampScale(value) {
    return Math.min(Math.max(value, MIN_SCALE), MAX_SCALE);
  }

  function syncLayer() {
    const width = img.naturalWidth;
    const height = img.naturalHeight;
    layer.hidden = !width || !height;
    if (!width || !height) return;
    layer.style.width = `${width}px`;
    layer.style.height = `${height}px`;
    layer.style.marginLeft = `${-width / 2}px`;
    layer.style.marginTop = `${-height / 2}px`;
    layer.style.transform = img.style.transform;
  }

  function paint() {
    frame = 0;
    img.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.scale}) rotate(${state.rotate}deg)`;
    syncLayer();
    const percent = state.fitScale ? Math.round((state.scale / state.fitScale) * 100) : 100;
    scaleLabel.textContent = `${percent}%`;
  }

  // Coalesce pointer/wheel updates into one paint per frame so dragging and
  // zooming stay smooth even when the browser fires events faster than 60Hz.
  function apply() {
    if (frame) return;
    frame = requestAnimationFrame(paint);
  }

  function flush() {
    if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    paint();
  }

  function fit() {
    if (!img.naturalWidth) return;
    const width = Math.max(stage.clientWidth - 48, 60);
    const height = Math.max(stage.clientHeight - 48, 60);
    const scale = Math.min(width / img.naturalWidth, height / img.naturalHeight);
    state.fitScale = scale > 0 ? scale : 1;
    state.scale = state.fitScale;
    state.rotate = 0;
    state.tx = 0;
    state.ty = 0;
    activePath = null;
    renderBoxes();
    flush();
  }

  // Position of the pointer relative to the untransformed image center.
  // Scale and rotation both pivot on the image center, so the bounding rect
  // center only ever differs from the layout center by the current translate.
  function anchorPoint(event) {
    const imgRect = img.getBoundingClientRect();
    // clientX 与 imgRect.left 同为视口坐标，不能再减 stage 的偏移，
    // 否则缩放锚点会横向漂移一个左栏宽度。
    const centerX = imgRect.left + imgRect.width / 2 - state.tx;
    const centerY = imgRect.top + imgRect.height / 2 - state.ty;
    return { x: event.clientX - centerX, y: event.clientY - centerY };
  }

  /** 屏幕坐标 -> 原图归一化坐标 (0-1)，逆变换 translate / scale / rotate。 */
  function imagePoint(event) {
    const imgRect = img.getBoundingClientRect();
    let dx = event.clientX - (imgRect.left + imgRect.width / 2);
    let dy = event.clientY - (imgRect.top + imgRect.height / 2);
    dx /= state.scale || 1;
    dy /= state.scale || 1;
    const angle = (-state.rotate * Math.PI) / 180;
    const rx = dx * Math.cos(angle) - dy * Math.sin(angle);
    const ry = dx * Math.sin(angle) + dy * Math.cos(angle);
    return {
      u: (rx + img.naturalWidth / 2) / img.naturalWidth,
      v: (ry + img.naturalHeight / 2) / img.naturalHeight,
    };
  }

  function clampUnit(value) {
    return Math.min(1, Math.max(0, value));
  }

  function boxRect(start, end) {
    const u1 = clampUnit(start.u);
    const v1 = clampUnit(start.v);
    const u2 = clampUnit(end.u);
    const v2 = clampUnit(end.v);
    return [Math.min(u1, u2), Math.min(v1, v2), Math.abs(u2 - u1), Math.abs(v2 - v1)];
  }

  function paintDraft(bbox) {
    if (!bbox || bbox[2] < 0.002 || bbox[3] < 0.002) {
      draft.hidden = true;
      return;
    }
    draft.hidden = false;
    draft.style.left = `${bbox[0] * img.naturalWidth}px`;
    draft.style.top = `${bbox[1] * img.naturalHeight}px`;
    draft.style.width = `${bbox[2] * img.naturalWidth}px`;
    draft.style.height = `${bbox[3] * img.naturalHeight}px`;
  }

  function renderBoxes() {
    layer.querySelectorAll(".evidence-box").forEach((node) => node.remove());
    const width = img.naturalWidth;
    const height = img.naturalHeight;
    if (!width || !height) return;
    for (const [path, box] of Object.entries(evidenceMap)) {
      if (!box || !Array.isArray(box.bbox) || box.bbox.length !== 4) continue;
      const [x, y, w, h] = box.bbox;
      const node = document.createElement("div");
      node.className = `evidence-box${path === activePath ? " active" : ""}`;
      node.dataset.path = path;
      node.style.left = `${x * width}px`;
      node.style.top = `${y * height}px`;
      node.style.width = `${w * width}px`;
      node.style.height = `${h * height}px`;
      const parts = [path];
      if (box.text) parts.push(box.text);
      if (box.page) parts.push(`page ${Number(box.page) + 1}`);
      node.title = parts.join(" · ");
      const label = document.createElement("span");
      label.className = "evidence-box-label";
      label.textContent = String(path).split(".").pop();
      node.appendChild(label);
      node.addEventListener("click", (event) => {
        event.stopPropagation();
        if (handlers.onPick) handlers.onPick(path);
      });
      layer.appendChild(node);
    }
  }

  function setEvidence(map) {
    evidenceMap = map && typeof map === "object" ? map : {};
    activePath = null;
    syncLayer();
    renderBoxes();
  }

  function highlight(path) {
    const box = evidenceMap[path];
    if (!box || !img.naturalWidth) return false;
    activePath = path;
    renderBoxes();
    const [x, y, w, h] = box.bbox;
    const width = img.naturalWidth;
    const height = img.naturalHeight;
    const target = Math.min(
      (stage.clientWidth * 0.6) / Math.max(w * width, 1),
      (stage.clientHeight * 0.6) / Math.max(h * height, 1),
      MAX_SCALE
    );
    state.scale = clampScale(Math.max(target, MIN_SCALE));
    state.rotate = 0;
    const centerX = (x + w / 2 - 0.5) * width;
    const centerY = (y + h / 2 - 0.5) * height;
    state.tx = -centerX * state.scale;
    state.ty = -centerY * state.scale;
    flush();
    return true;
  }

  function setSelectionMode(enabled) {
    selectionMode = Boolean(enabled);
    stage.classList.toggle("evidence-select", selectionMode);
    if (!selectionMode) {
      dragBox = null;
      draft.hidden = true;
    }
  }

  function zoomTo(next, anchor) {
    const ratio = next / state.scale;
    if (!Number.isFinite(ratio) || ratio === 1) return;
    // Keep the content under the anchor fixed while the scale changes.
    state.tx = anchor.x * (1 - ratio) + state.tx * ratio;
    state.ty = anchor.y * (1 - ratio) + state.ty * ratio;
    state.scale = next;
    apply();
  }

  img.addEventListener("load", () => {
    fit();
    renderBoxes();
  });
  img.addEventListener("dragstart", (event) => event.preventDefault());
  stage.addEventListener("selectstart", (event) => event.preventDefault());

  stage.addEventListener(
    "wheel",
    (event) => {
      if (!img.naturalWidth) return;
      event.preventDefault();
      if (!event.deltaY) return;
      // Trackpad pinch gestures arrive as ctrl+wheel with small deltas.
      const intensity = event.ctrlKey ? 0.01 : 0.0015;
      const next = clampScale(state.scale * Math.exp(-event.deltaY * intensity));
      zoomTo(next, anchorPoint(event));
    },
    { passive: false }
  );

  stage.addEventListener("dblclick", fit);

  stage.addEventListener("pointerdown", (event) => {
    if (!img.naturalWidth) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (event.target.closest && event.target.closest(".evidence-box")) return;
    if (selectionMode) {
      dragBox = { id: event.pointerId, start: imagePoint(event) };
      paintDraft(null);
      if (stage.setPointerCapture) {
        try {
          stage.setPointerCapture(event.pointerId);
        } catch (error) {
          /* pointer capture may fail on synthetic events */
        }
      }
      return;
    }
    drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      tx: state.tx,
      ty: state.ty,
    };
    stage.classList.add("dragging");
    if (stage.setPointerCapture) {
      try {
        stage.setPointerCapture(event.pointerId);
      } catch (error) {
        /* pointer capture may fail on synthetic events */
      }
    }
  });

  stage.addEventListener("pointermove", (event) => {
    if (dragBox && event.pointerId === dragBox.id) {
      paintDraft(boxRect(dragBox.start, imagePoint(event)));
      return;
    }
    if (!drag || event.pointerId !== drag.id) return;
    let source = event;
    if (typeof event.getCoalescedEvents === "function") {
      const events = event.getCoalescedEvents();
      if (events && events.length) source = events[events.length - 1];
    }
    state.tx = drag.tx + (source.clientX - drag.x);
    state.ty = drag.ty + (source.clientY - drag.y);
    apply();
  });

  const endDrag = (event) => {
    if (dragBox && (!event || event.pointerId === undefined || event.pointerId === dragBox.id)) {
      const start = dragBox.start;
      const end = event ? imagePoint(event) : start;
      const bbox = boxRect(start, end);
      dragBox = null;
      draft.hidden = true;
      if (stage.releasePointerCapture && event && stage.hasPointerCapture && stage.hasPointerCapture(event.pointerId)) {
        stage.releasePointerCapture(event.pointerId);
      }
      if (bbox[2] >= 0.002 && bbox[3] >= 0.002 && handlers.onBox) {
        handlers.onBox(bbox, {
          clientX: event ? event.clientX : 0,
          clientY: event ? event.clientY : 0,
        });
      }
      return;
    }
    if (!drag) return;
    if (event && event.pointerId !== undefined && event.pointerId !== drag.id) return;
    if (stage.releasePointerCapture && stage.hasPointerCapture && stage.hasPointerCapture(drag.id)) {
      stage.releasePointerCapture(drag.id);
    }
    drag = null;
    stage.classList.remove("dragging");
  };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);

  return {
    load(url) {
      img.src = url;
    },
    clear() {
      img.removeAttribute("src");
      state.scale = 1;
      state.fitScale = 1;
      state.rotate = 0;
      state.tx = 0;
      state.ty = 0;
      evidenceMap = {};
      activePath = null;
      setSelectionMode(false);
      renderBoxes();
      flush();
    },
    fit,
    reset: fit,
    zoomIn: () => {
      state.scale = clampScale(state.scale * 1.2);
      apply();
    },
    zoomOut: () => {
      state.scale = clampScale(state.scale / 1.2);
      apply();
    },
    rotate: () => {
      state.rotate = (state.rotate + 90) % 360;
      apply();
    },
    setHandlers(next) {
      handlers = { ...handlers, ...(next || {}) };
    },
    setEvidence,
    highlight,
    setSelectionMode,
    clearHighlight() {
      activePath = null;
      renderBoxes();
    },
    isSelecting: () => selectionMode,
  };
}
