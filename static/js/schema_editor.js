import { api, projectUrl } from "./api.js";
import { openModal } from "./modal.js";
import { toast } from "./util.js";

const TYPES = [
  ["string", "Text"],
  ["number", "Number"],
  ["boolean", "Boolean"],
  ["object", "Object"],
  ["array", "Array"],
];

function uid() {
  return "js_" + Math.random().toString(16).slice(2, 10);
}

function newNode(label, type) {
  const node = {
    id: uid(),
    label,
    type,
    required: false,
    description: "",
    enum: [],
  };
  if (type === "object") node.children = [];
  if (type === "array") node.item = newNode("item", "string");
  return node;
}

function mk(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function changeType(node, type) {
  node.type = type;
  if (type === "object") {
    node.children = node.children || [];
    delete node.item;
  } else if (type === "array") {
    node.item = node.item || newNode("item", "string");
    delete node.children;
  } else {
    delete node.children;
    delete node.item;
  }
}

export function openSchemaEditor({ projectId, schemaInfo, onSaved }) {
  const working = structuredClone(schemaInfo.schema);
  const modal = openModal({
    title: `Schema editor · current v${schemaInfo.version}`,
    wide: true,
  });

  const hint = mk("div", "muted");
  hint.style.marginBottom = "10px";
  hint.textContent =
    "Field names are keys in the annotation JSON and must be unique among siblings. Renaming migrates existing annotations; field ids stay the same.";
  modal.body.appendChild(hint);

  const message = mk("div", "schema-msg");
  modal.body.appendChild(message);

  const tree = mk("div");
  modal.body.appendChild(tree);

  function addButton(text, onClick, danger) {
    const btn = mk("button", "btn small ghost" + (danger ? " danger" : ""));
    btn.type = "button";
    btn.textContent = text;
    btn.addEventListener("click", onClick);
    return btn;
  }

  function renderNode(container, node, parentList, isRoot) {
    const wrap = mk("div", "schema-node" + (isRoot ? " root" : ""));
    const row = mk("div", "schema-row");

    if (isRoot) {
      const title = mk("strong");
      title.textContent = "Root object";
      row.appendChild(title);
      row.appendChild(
        addButton("+ Field", () => {
          node.children.push(newNode("New field", "string"));
          rerender();
        })
      );
    } else {
      const labelInput = mk("input", "label-input");
      labelInput.type = "text";
      labelInput.value = node.label;
      labelInput.placeholder = "Field name";
      labelInput.addEventListener("input", () => {
        node.label = labelInput.value;
      });
      row.appendChild(labelInput);

      const typeSelect = mk("select");
      for (const [value, text] of TYPES) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = text;
        typeSelect.appendChild(option);
      }
      typeSelect.value = node.type;
      typeSelect.addEventListener("change", () => {
        changeType(node, typeSelect.value);
        rerender();
      });
      row.appendChild(typeSelect);

      const required = mk("input");
      required.type = "checkbox";
      required.checked = Boolean(node.required);
      required.addEventListener("change", () => {
        node.required = required.checked;
      });
      const requiredLabel = mk("span", "muted");
      requiredLabel.textContent = "Required";
      const requiredWrap = mk("label", "radio-row");
      requiredWrap.style.margin = "0";
      requiredWrap.appendChild(required);
      requiredWrap.appendChild(requiredLabel);
      row.appendChild(requiredWrap);

      if (node.type === "string" || node.type === "number") {
        const enumInput = mk("input", "enum-input");
        enumInput.type = "text";
        enumInput.placeholder = "Enum, comma separated";
        enumInput.value = (node.enum || []).join(",");
        enumInput.addEventListener("input", () => {
          node.enum = enumInput.value
            .split(/[,，]/)
            .map((s) => s.trim())
            .filter(Boolean);
        });
        row.appendChild(enumInput);
      }

      const descInput = mk("input", "desc-input");
      descInput.type = "text";
      descInput.placeholder = "Field description";
      descInput.value = node.description || "";
      descInput.addEventListener("input", () => {
        node.description = descInput.value;
      });
      row.appendChild(descInput);

      const actions = mk("div", "schema-actions");
      if (node.type === "object") {
        actions.appendChild(
          addButton("+ Child field", () => {
            node.children.push(newNode("New field", "string"));
            rerender();
          })
        );
      }
      actions.appendChild(
        addButton(
          "Delete",
          () => {
            const index = parentList.indexOf(node);
            if (index >= 0) parentList.splice(index, 1);
            rerender();
          },
          true
        )
      );
      row.appendChild(actions);
    }

    wrap.appendChild(row);

    if (node.type === "object") {
      for (const child of node.children || []) {
        renderNode(wrap, child, node.children, false);
      }
      if (!(node.children || []).length) {
        const empty = mk("div", "muted");
        empty.style.padding = "2px 0";
        empty.textContent = "No child fields yet";
        wrap.appendChild(empty);
      }
    }

    if (node.type === "array") {
      const itemRow = mk("div", "schema-row");
      const itemLabel = mk("span", "muted");
      itemLabel.textContent = "Item type";
      itemRow.appendChild(itemLabel);

      const itemType = mk("select");
      for (const [value, text] of TYPES.filter(([v]) => v !== "array")) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = text;
        itemType.appendChild(option);
      }
      itemType.value = node.item.type;
      itemType.addEventListener("change", () => {
        node.item = newNode("item", itemType.value);
        rerender();
      });
      itemRow.appendChild(itemType);
      wrap.appendChild(itemRow);

      if (node.item.type === "object") {
        const inner = mk("div", "schema-node");
        for (const child of node.item.children || []) {
          renderNode(inner, child, node.item.children, false);
        }
        inner.appendChild(
          addButton("+ Item field", () => {
            node.item.children.push(newNode("New field", "string"));
            rerender();
          })
        );
        wrap.appendChild(inner);
      }
    }

    container.appendChild(wrap);
  }

  function rerender() {
    tree.innerHTML = "";
    renderNode(tree, working, null, true);
  }

  rerender();

  const cancel = mk("button", "btn");
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => modal.close());

  const save = mk("button", "btn primary");
  save.textContent = "Save";
  save.addEventListener("click", async () => {
    save.disabled = true;
    message.textContent = "";
    try {
      const res = await api.put(projectUrl(projectId, "/schema"), {
        schema: working,
        expected_version: schemaInfo.version,
      });
      const migrated = res.migration ? res.migration.migrated : 0;
      toast(`Schema updated to v${res.version}${migrated ? `, migrated ${migrated} annotations` : ""}`);
      modal.close();
      if (onSaved) onSaved(res);
    } catch (error) {
      message.textContent = error.message;
    } finally {
      save.disabled = false;
    }
  });

  modal.foot.appendChild(cancel);
  modal.foot.appendChild(save);
}
