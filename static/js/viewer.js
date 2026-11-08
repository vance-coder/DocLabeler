export function createViewer({ stage, img, scaleLabel }) {
  const state = { scale: 1, fitScale: 1, rotate: 0, tx: 0, ty: 0 };
  let drag = null;

  function apply() {
    img.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.scale}) rotate(${state.rotate}deg)`;
    const percent = state.fitScale ? Math.round((state.scale / state.fitScale) * 100) : 100;
    scaleLabel.textContent = `${percent}%`;
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
    apply();
  }

  img.addEventListener("load", fit);

  stage.addEventListener(
    "wheel",
    (event) => {
      if (!img.naturalWidth) return;
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
      state.scale = Math.min(Math.max(state.scale * factor, 0.05), 16);
      apply();
    },
    { passive: false }
  );

  stage.addEventListener("dblclick", fit);

  stage.addEventListener("pointerdown", (event) => {
    if (!img.naturalWidth) return;
    drag = { x: event.clientX, y: event.clientY, tx: state.tx, ty: state.ty };
    stage.classList.add("dragging");
    stage.setPointerCapture(event.pointerId);
  });
  stage.addEventListener("pointermove", (event) => {
    if (!drag) return;
    state.tx = drag.tx + (event.clientX - drag.x);
    state.ty = drag.ty + (event.clientY - drag.y);
    apply();
  });
  const endDrag = () => {
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
      apply();
    },
    fit,
    reset: fit,
    zoomIn: () => {
      state.scale = Math.min(state.scale * 1.2, 16);
      apply();
    },
    zoomOut: () => {
      state.scale = Math.max(state.scale / 1.2, 0.05);
      apply();
    },
    rotate: () => {
      state.rotate = (state.rotate + 90) % 360;
      apply();
    },
  };
}
