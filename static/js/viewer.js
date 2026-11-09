export function createViewer({ stage, img, scaleLabel }) {
  const MIN_SCALE = 0.02;
  const MAX_SCALE = 20;
  const state = { scale: 1, fitScale: 1, rotate: 0, tx: 0, ty: 0 };
  let drag = null;
  let frame = 0;

  function clampScale(value) {
    return Math.min(Math.max(value, MIN_SCALE), MAX_SCALE);
  }

  function paint() {
    frame = 0;
    img.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.scale}) rotate(${state.rotate}deg)`;
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
    flush();
  }

  // Position of the pointer relative to the untransformed image center.
  // Scale and rotation both pivot on the image center, so the bounding rect
  // center only ever differs from the layout center by the current translate.
  function anchorPoint(event) {
    const stageRect = stage.getBoundingClientRect();
    const imgRect = img.getBoundingClientRect();
    const centerX = imgRect.left + imgRect.width / 2 - state.tx;
    const centerY = imgRect.top + imgRect.height / 2 - state.ty;
    return {
      x: event.clientX - stageRect.left - stage.clientLeft - centerX,
      y: event.clientY - stageRect.top - stage.clientTop - centerY,
    };
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

  img.addEventListener("load", fit);
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
  };
}
