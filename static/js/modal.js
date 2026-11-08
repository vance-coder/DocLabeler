import { escapeHtml } from "./util.js";

export function openModal({ title, wide = false, onClose }) {
  const root = document.getElementById("modal-root");
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal${wide ? " wide" : ""}" role="dialog" aria-modal="true">
      <div class="modal-head">
        <h2>${escapeHtml(title)}</h2>
        <button type="button" class="btn-close close" aria-label="Close"></button>
      </div>
      <div class="modal-body"></div>
      <div class="modal-foot"></div>
    </div>
  `;
  const body = backdrop.querySelector(".modal-body");
  const foot = backdrop.querySelector(".modal-foot");
  const closeBtn = backdrop.querySelector(".close");

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
    if (onClose) onClose();
  };
  const onKey = (event) => {
    if (event.key === "Escape") close();
  };

  closeBtn.addEventListener("click", close);
  backdrop.addEventListener("mousedown", (event) => {
    if (event.target === backdrop) close();
  });
  document.addEventListener("keydown", onKey);
  root.appendChild(backdrop);

  return { backdrop, body, foot, close };
}
