import { escapeHtml, isPlainObject, isEmptyValue, joinPath } from "./util.js";

const TYPE_LABELS = {
  string: "Text",
  number: "Number",
  boolean: "Boolean",
  object: "Object",
  array: "Array",
};

const KIND_LABELS = { added: "Added", modified: "Modified", removed: "Removed" };

// ---------------------------------------------------------------------------
// Field note popover (single instance, appended to body to avoid clipping)
// ---------------------------------------------------------------------------
let activeNotePopover = null;

function closeNotePopover() {
  if (!activeNotePopover) return;
  const { el, cleanup } = activeNotePopover;
  activeNotePopover = null;
  cleanup();
  el.remove();
}

function openNotePopover(anchor, { path, value, label, onChange }) {
  if (activeNotePopover && activeNotePopover.anchor === anchor) {
    closeNotePopover();
    return;
  }
  closeNotePopover();

  const el = document.createElement("div");
  el.className = "note-popover";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", `Field note for ${label}`);

  const input = document.createElement("textarea");
  input.className = "note-input";
  input.placeholder = "Add a note for this field…";
  input.setAttribute("aria-label", `Field note for ${label}`);
  input.value = value;

  const hint = document.createElement("div");
  hint.className = "note-popover-hint";
  hint.textContent = "Saved with the annotation.";

  el.appendChild(input);
  el.appendChild(hint);
  document.body.appendChild(el);

  const ring = anchor.getBoundingClientRect();
  const width = 260;
  const gap = 8;
  const left = Math.min(
    Math.max(gap, ring.right - width),
    Math.max(gap, window.innerWidth - width - gap)
  );
  let top = ring.bottom + 6;
  if (top + el.offsetHeight > window.innerHeight - gap) {
    top = Math.max(gap, ring.top - el.offsetHeight - 6);
  }
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;

  input.addEventListener("input", () => onChange(input.value));

  const onKey = (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    closeNotePopover();
    anchor.focus();
  };
  const onPointer = (event) => {
    if (el.contains(event.target) || anchor.contains(event.target)) return;
    closeNotePopover();
  };
  const onScroll = (event) => {
    if (el.contains(event.target)) return;
    closeNotePopover();
  };
  const onResize = () => closeNotePopover();
  const timer = setTimeout(() => {
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("scroll", onScroll, true);
  }, 0);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", onResize);

  activeNotePopover = {
    el,
    anchor,
    path,
    cleanup: () => {
      clearTimeout(timer);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    },
  };

  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

export function renderForm(container, ctx) {
  closeNotePopover();
  container.innerHTML = "";
  const fieldEls = new Map();
  container._fieldMap = fieldEls;
  const local = {
    ...ctx,
    notes: ctx.notes || {},
    fieldEls,
    rerender: () => renderForm(container, ctx),
  };
  if (!local.schema || !(local.schema.children || []).length) {
    container.innerHTML = '<div class="muted" style="padding:12px 0">The schema has no fields yet. Click “Schema” in the top bar to add fields.</div>';
    if (typeof local.onRender === "function") local.onRender(container);
    return;
  }
  renderChildren(container, local.schema, local.values || {}, local, "");
  applyDiff(container, local.diffFields || [], local.onRevert);
  if (typeof local.onRender === "function") local.onRender(container);
}

function cloneValues(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    return value;
  }
}

function normalizeScalar(node, value) {
  if (node.type === "boolean") {
    return value === true ? true : value === false ? false : "";
  }
  return value === undefined || value === null ? "" : String(value);
}

function applyStructureChange(ctx, mutate, label) {
  const before = cloneValues(ctx.values);
  mutate();
  const after = cloneValues(ctx.values);
  ctx.rerender();
  ctx.onChange();
  if (typeof ctx.onStructureChange === "function") {
    ctx.onStructureChange({ before, after, label });
  }
}

function defaultFor(node) {
  if (node.type === "object") {
    const out = {};
    for (const child of node.children || []) out[child.label] = defaultFor(child);
    return out;
  }
  if (node.type === "array") return [];
  if (node.type === "boolean") return false;
  return "";
}

function ensureItemDefaults(node, item) {
  if (!isPlainObject(item)) return;
  for (const child of node.children || []) {
    if (!(child.label in item)) item[child.label] = defaultFor(child);
  }
}

function renderChildren(container, objectNode, obj, ctx, prefix) {
  for (const child of objectNode.children || []) {
    if (!(child.label in obj)) obj[child.label] = defaultFor(child);
    renderField(container, child, joinPath(prefix, child.label), obj, ctx);
  }
}

function makeFieldRow(node, path, ctx, options = {}) {
  const row = document.createElement("div");
  row.className = "field";
  row.dataset.path = path;
  const note = ctx.notes ? ctx.notes[path] || "" : "";

  const head = document.createElement("div");
  head.className = "field-head";
  head.innerHTML = `
    ${options.indexLabel ? `<span class="type-tag">${escapeHtml(options.indexLabel)}</span>` : ""}
    <span class="field-label">${escapeHtml(node.label || "item")}</span>
    ${node.required ? '<span class="req" title="Required">*</span>' : ""}
    <span class="type-tag">${TYPE_LABELS[node.type] || node.type}</span>
    ${options.extraHead || ""}
    <button type="button" class="note-btn${String(note).trim() ? " has-note" : ""}" title="${String(note).trim() ? "Edit field note" : "Field note"}" aria-label="Field note for ${escapeHtml(node.label || "item")}" aria-haspopup="dialog"><i class="bi bi-sticky" aria-hidden="true"></i></button>
  `;
  if (options.removable) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn small ghost remove-btn";
    remove.textContent = "Remove";
    head.appendChild(remove);
  }
  row.appendChild(head);

  const diff = document.createElement("div");
  diff.className = "field-diff";
  row.appendChild(diff);

  const control = document.createElement("div");
  control.className = "field-control";
  row.appendChild(control);

  const msg = document.createElement("div");
  msg.className = "field-msg";
  row.appendChild(msg);

  const noteBtn = head.querySelector(".note-btn");
  noteBtn.addEventListener("click", () => {
    openNotePopover(noteBtn, {
      path,
      value: ctx.notes[path] || "",
      label: node.label || "item",
      onChange: (text) => {
        if (text.trim()) ctx.notes[path] = text;
        else delete ctx.notes[path];
        noteBtn.classList.toggle("has-note", Boolean(text.trim()));
        noteBtn.title = text.trim() ? "Edit field note" : "Field note";
        ctx.onChange();
      },
    });
  });

  ctx.fieldEls.set(path, { row, diffEl: diff, node });
  return row;
}

function renderField(container, node, path, parentObj, ctx) {
  const row = makeFieldRow(node, path, ctx);
  const control = row.querySelector(".field-control");

  if (node.type === "object") {
    if (!isPlainObject(parentObj[node.label])) parentObj[node.label] = {};
    const box = document.createElement("div");
    box.className = "object-box";
    control.appendChild(box);
    renderChildren(box, node, parentObj[node.label], ctx, path);
    container.appendChild(row);
    return;
  }

  if (node.type === "array") {
    const arr = Array.isArray(parentObj[node.label]) ? parentObj[node.label] : (parentObj[node.label] = []);
    const extra = document.createElement("button");
    extra.type = "button";
    extra.className = "btn small ghost";
    extra.innerHTML = '<i class="bi bi-plus-lg"></i>Add';
    extra.addEventListener("click", () => {
      applyStructureChange(
        ctx,
        () => {
          arr.push(defaultFor(node.item));
        },
        node.label || "array"
      );
    });
    row.querySelector(".field-head").insertBefore(extra, row.querySelector(".note-btn"));
    const box = document.createElement("div");
    box.className = "array-box";
    control.appendChild(box);

    if (!arr.length) {
      const empty = document.createElement("div");
      empty.className = "array-empty";
      empty.textContent = "No items yet";
      box.appendChild(empty);
    }

    arr.forEach((item, index) => {
      const itemPath = `${path}[${index}]`;
      if (node.item.type === "object") {
        ensureItemDefaults(node.item, item);
        const wrap = document.createElement("div");
        wrap.className = "array-item";
        const itemHead = document.createElement("div");
        itemHead.className = "array-item-head";
        itemHead.innerHTML = `<span>#${index + 1}</span>`;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "btn small ghost";
        remove.textContent = "Remove";
        remove.addEventListener("click", () => {
          applyStructureChange(
            ctx,
            () => {
              arr.splice(index, 1);
            },
            `${node.label || "array"}[${index + 1}]`
          );
        });
        itemHead.appendChild(remove);
        wrap.appendChild(itemHead);
        const inner = document.createElement("div");
        wrap.appendChild(inner);
        renderChildren(inner, node.item, item, ctx, itemPath);
        box.appendChild(wrap);
      } else {
        const itemRow = makeFieldRow(node.item, itemPath, ctx, {
          indexLabel: `#${index + 1}`,
          removable: true,
        });
        itemRow.querySelector(".remove-btn").addEventListener("click", () => {
          applyStructureChange(
            ctx,
            () => {
              arr.splice(index, 1);
            },
            `${node.label || "array"}[${index + 1}]`
          );
        });
        itemRow.querySelector(".field-control").appendChild(
          buildScalar(node.item, itemPath, item, (value) => {
            arr[index] = value;
          }, ctx)
        );
        box.appendChild(itemRow);
      }
    });

    container.appendChild(row);
    return;
  }

  control.appendChild(
    buildScalar(node, path, parentObj[node.label], (value) => {
      parentObj[node.label] = value;
    }, ctx)
  );
  container.appendChild(row);
}

function buildScalar(node, path, value, setValue, ctx) {
  const entry = ctx.fieldEls.get(path);
  let input;

  if (node.enum && node.enum.length) {
    input = document.createElement("select");
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "(Not selected)";
    input.appendChild(empty);
    const options = [...node.enum];
    if (value !== undefined && value !== null && value !== "" && !options.includes(String(value))) {
      options.push(String(value));
    }
    for (const opt of options) {
      const option = document.createElement("option");
      option.value = opt;
      option.textContent = opt;
      input.appendChild(option);
    }
    input.value = value === undefined || value === null ? "" : String(value);
  } else if (node.type === "boolean") {
    input = document.createElement("select");
    input.innerHTML = `
      <option value="">(Not set)</option>
      <option value="true">Yes</option>
      <option value="false">No</option>
    `;
    input.value = value === true ? "true" : value === false ? "false" : "";
  } else {
    input = document.createElement("input");
    input.type = "text";
    input.value = value === undefined || value === null ? "" : String(value);
    if (node.type === "number") input.inputMode = "decimal";
  }

  let committed = normalizeScalar(node, value);

  const readInputValue = () => {
    if (node.type === "boolean") {
      return input.value === "" ? "" : input.value === "true";
    }
    return input.value;
  };

  const commitValue = () => {
    const next = readInputValue();
    if (next === committed) return;
    const before = committed;
    committed = next;
    if (typeof ctx.onValueCommit === "function") {
      ctx.onValueCommit({ path, before, after: next });
    }
  };

  const validate = () => {
    const problem = validateValue(node, input.value);
    if (entry) {
      entry.row.classList.toggle("invalid", Boolean(problem));
      const msg = entry.row.querySelector(".field-msg");
      if (msg) msg.textContent = problem || "";
    }
    input.classList.toggle("invalid", Boolean(problem));
    input.setAttribute("aria-invalid", String(Boolean(problem)));
  };

  input.addEventListener("input", () => {
    updateValue();
    validate();
    ctx.onChange();
    commitValue();
  });
  input.addEventListener("change", () => {
    updateValue();
    validate();
    ctx.onChange();
    commitValue();
  });

  function updateValue() {
    if (node.type === "boolean") {
      setValue(input.value === "" ? "" : input.value === "true");
    } else {
      setValue(input.value);
    }
  }

  validate();
  return input;
}

function validateValue(node, raw) {
  const value = node.type === "boolean" ? raw : String(raw ?? "");
  const empty = value === "" || value === undefined;
  if (node.required && empty) return "Required";
  if (node.type === "number" && !empty && Number.isNaN(Number(value))) return "Must be a number";
  if (node.enum && node.enum.length && !empty && !node.enum.includes(value)) {
    return `Must be one of: ${node.enum.join(" / ")}`;
  }
  return "";
}

function displayValue(value) {
  if (value === null || value === undefined) return "(empty)";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function applyDiff(container, fields, onRevert) {
  const map = container._fieldMap || new Map();
  for (const info of map.values()) {
    info.diffEl.innerHTML = "";
    if (info.row) {
      info.row.classList.remove("diff-added", "diff-modified", "diff-removed");
    }
  }
  for (const field of fields || []) {
    const info = map.get(field.path);
    if (!info) continue;
    if (info.row) info.row.classList.add(`diff-${field.kind}`);
    const line = document.createElement("div");
    line.className = `diff-line ${field.kind}`;
    const kind = document.createElement("span");
    kind.className = "kind";
    kind.textContent = KIND_LABELS[field.kind] || field.kind;
    line.appendChild(kind);
    if (field.kind !== "added") {
      const old = document.createElement("span");
      old.className = "old-val";
      old.textContent = `Old: ${displayValue(field.old)}`;
      old.title = displayValue(field.old);
      line.appendChild(old);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn small ghost revert";
      btn.textContent = "Revert";
      btn.addEventListener("click", () => onRevert && onRevert(field.path));
      line.appendChild(btn);
    }
    info.diffEl.appendChild(line);
  }
}

export function updateFieldNotes(container, notes) {
  const map = container._fieldMap || new Map();
  for (const [path, info] of map.entries()) {
    const text = notes[path] || "";
    const btn = info.row.querySelector(".note-btn");
    if (btn) btn.classList.toggle("has-note", Boolean(String(text).trim()));
    if (
      activeNotePopover &&
      activeNotePopover.path === path &&
      !activeNotePopover.el.contains(document.activeElement)
    ) {
      const input = activeNotePopover.el.querySelector(".note-input");
      if (input) input.value = text;
    }
  }
}
