export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function debounce(fn, ms) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(timer);
  wrapped.flush = (...args) => {
    clearTimeout(timer);
    fn(...args);
  };
  return wrapped;
}

let toastTimer = null;
export function toast(message, isError = false) {
  const node = document.getElementById("toast");
  if (!node) return;
  node.textContent = message;
  node.className = "toast show" + (isError ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.className = "toast" + (isError ? " error" : "");
  }, isError ? 4200 : 2200);
}

export function formatTime(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function escapeSeg(seg) {
  return String(seg)
    .replace(/\\/g, "\\\\")
    .replace(/\./g, "\\.")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

export function joinPath(prefix, label) {
  const seg = escapeSeg(label);
  return prefix ? `${prefix}.${seg}` : seg;
}

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isEmptyValue(value) {
  return value === null || value === undefined || value === "" ||
    (Array.isArray(value) && value.length === 0) ||
    (isPlainObject(value) && Object.keys(value).length === 0);
}
