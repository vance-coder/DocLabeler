async function handle(res) {
  const type = res.headers.get("content-type") || "";
  let data = null;
  if (type.includes("application/json")) {
    data = await res.json();
  } else {
    data = await res.text();
  }
  if (!res.ok) {
    const detail = data && data.detail;
    let message;
    if (typeof detail === "string") message = detail;
    else if (detail && typeof detail.message === "string") message = detail.message;
    else if (Array.isArray(detail)) message = detail.map((d) => d.msg || JSON.stringify(d)).join("; ");
    else message = res.statusText || `HTTP ${res.status}`;
    const error = new Error(message);
    error.status = res.status;
    error.detail = detail;
    error.data = data;
    throw error;
  }
  return data;
}

export const api = {
  get: (url) => fetch(url).then(handle),
  post: (url, body) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    }).then(handle),
  put: (url, body) =>
    fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    }).then(handle),
  postForm: (url, formData) =>
    fetch(url, { method: "POST", body: formData }).then(handle),
};

export function projectUrl(projectId, suffix = "") {
  return `/api/projects/${encodeURIComponent(projectId)}${suffix}`;
}
