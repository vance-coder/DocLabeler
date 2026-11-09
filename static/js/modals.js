import { api, projectUrl } from "./api.js";
import { openModal } from "./modal.js";
import { escapeHtml, toast } from "./util.js";

function mk(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function fieldRow(labelText, control, help) {
  const row = mk("div", "form-row");
  const label = mk("label");
  label.textContent = labelText;
  row.appendChild(label);
  row.appendChild(control);
  if (help) {
    const hint = mk("div", "help");
    hint.textContent = help;
    row.appendChild(hint);
  }
  return row;
}

function textInput(placeholder = "") {
  const input = mk("input");
  input.type = "text";
  input.placeholder = placeholder;
  return input;
}

// ---------------------------------------------------------------------------
// 新建项目
// ---------------------------------------------------------------------------
export function openCreateProjectModal({ onCreated }) {
  const modal = openModal({ title: "New project", wide: true });

  const name = textInput("e.g. Medical records");
  const imagesDir = textInput("Absolute path, or a path relative to the workspace");
  const description = textInput("Optional");

  const modeWrap = mk("div", "radio-row");
  modeWrap.innerHTML = `
    <label><input type="radio" name="schema-mode" value="empty" checked /> Empty schema</label>
    <label><input type="radio" name="schema-mode" value="example" /> Infer from example JSON</label>
    <label><input type="radio" name="schema-mode" value="json_schema" /> Import JSON Schema</label>
  `;

  const exampleArea = mk("textarea");
  exampleArea.placeholder = '{\n  "doc_no": "A-001",\n  "total": "3040",\n  "items": [{"description": "CT Brain", "amount": "3040"}]\n}';
  const exampleRow = fieldRow("Example JSON", exampleArea, "Arrays are inferred as repeatable groups. The sample only illustrates the structure.");
  exampleRow.style.display = "none";

  const schemaArea = mk("textarea");
  schemaArea.placeholder = '{"type":"object","properties":{...}}';
  const schemaRow = fieldRow("JSON Schema", schemaArea, "Supports type / properties / items / required / enum / description.");
  schemaRow.style.display = "none";

  modeWrap.addEventListener("change", () => {
    const mode = modeWrap.querySelector("input:checked").value;
    exampleRow.style.display = mode === "example" ? "" : "none";
    schemaRow.style.display = mode === "json_schema" ? "" : "none";
  });

  const message = mk("div", "schema-msg");
  modal.body.appendChild(fieldRow("Project name", name));
  modal.body.appendChild(fieldRow("Images folder", imagesDir, "The tool only reads this folder. Original images are never modified, moved, or deleted."));
  modal.body.appendChild(fieldRow("Description", description));
  modal.body.appendChild(fieldRow("Schema source", modeWrap));
  modal.body.appendChild(exampleRow);
  modal.body.appendChild(schemaRow);
  modal.body.appendChild(message);

  const cancel = mk("button", "btn");
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => modal.close());

  const submit = mk("button", "btn primary");
  submit.textContent = "Create project";
  submit.addEventListener("click", async () => {
    submit.disabled = true;
    message.textContent = "";
    const mode = modeWrap.querySelector("input:checked").value;
    try {
      const res = await api.post("/api/projects", {
        name: name.value.trim(),
        images_dir: imagesDir.value.trim(),
        description: description.value.trim(),
        schema_mode: mode,
        example_json: exampleArea.value,
        json_schema: schemaArea.value,
      });
      toast(`Project "${res.project.name}" created`);
      modal.close();
      if (onCreated) onCreated(res.project);
    } catch (error) {
      message.textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  });

  modal.foot.appendChild(cancel);
  modal.foot.appendChild(submit);
}

// ---------------------------------------------------------------------------
// 导入
// ---------------------------------------------------------------------------
const STAT_LABELS = {
  rows: "Rows",
  cases: "Matched cases",
  applied_fields: "Fields written",
  kept_values: "Values kept",
  confidence: "Confidence values",
  notes: "Notes written",
  skipped_fill: "Skipped (existing value)",
  unknown_case: "Unknown case",
  ambiguous_case: "Ambiguous ID (used first match)",
  unknown_field: "Unknown field",
  type_mismatch: "Type mismatch",
};

const ISSUE_LABELS = {
  unknown_case: "Unknown case",
  ambiguous_case: "Ambiguous ID",
  unknown_field: "Unknown field",
  type_mismatch: "Type mismatch",
};

export function openImportModal({ projectId, onDone }) {
  const modal = openModal({ title: "Import annotations", wide: true });

  const kind = mk("select");
  kind.innerHTML = `
    <option value="csv">CSV long table</option>
    <option value="excel">Excel long table</option>
    <option value="json">JSON (one file per case)</option>
  `;

  const mode = mk("select");
  mode.innerHTML = `
    <option value="overwrite">Overwrite current values</option>
    <option value="fill_empty">Fill empty fields only</option>
    <option value="baseline">Update baseline only (keep my edits)</option>
  `;

  const modeHelp = mk("div", "help");
  const syncModeHelp = () => {
    modeHelp.textContent =
      mode.value === "baseline"
        ? "New predictions become the comparison baseline. Current values and notes stay untouched, and the right panel shows you where the new predictions differ from your edits."
        : mode.value === "fill_empty"
        ? "Only empty fields are filled. Every imported value still becomes the baseline for comparison."
        : "All imported values replace the current ones. The previous values are kept as the baseline.";
  };
  mode.addEventListener("change", syncModeHelp);
  syncModeHelp();

  const fileInput = mk("input");
  fileInput.type = "file";
  fileInput.multiple = true;

  const accept = () => {
    fileInput.accept =
      kind.value === "csv" ? ".csv" : kind.value === "excel" ? ".xlsx,.xls" : ".json";
    if (kind.value === "json") mode.value = "overwrite";
  };
  kind.addEventListener("change", accept);
  accept();

  const help = mk("div", "help");
  help.innerHTML =
    "Long-format columns: <span class='mono'>case_id, field_path, value, note</span>; optional <span class='mono'>confidence</span> (0-1 or 0-100) flags low-confidence fields. field_path looks like <span class='mono'>items[0].amount</span>.";

  const result = mk("div");
  result.style.marginTop = "14px";

  modal.body.appendChild(fieldRow("File type", kind));
  modal.body.appendChild(fieldRow("Import mode", mode));
  modal.body.appendChild(modeHelp);
  modal.body.appendChild(fieldRow("Files", fileInput));
  modal.body.appendChild(help);
  modal.body.appendChild(result);

  const cancel = mk("button", "btn");
  cancel.textContent = "Close";
  cancel.addEventListener("click", () => modal.close());

  const submit = mk("button", "btn primary");
  submit.textContent = "Start import";
  submit.addEventListener("click", async () => {
    if (!fileInput.files.length) {
      toast("Select at least one file first", true);
      return;
    }
    submit.disabled = true;
    try {
      const form = new FormData();
      form.append("kind", kind.value);
      form.append("mode", mode.value);
      for (const file of fileInput.files) form.append("files", file);
      const report = await api.postForm(projectUrl(projectId, "/imports"), form);
      renderReport(report);
      toast(`Import complete: ${report.stats.applied_fields} fields written`);
      if (onDone) onDone(report);
    } catch (error) {
      toast(error.message, true);
      result.innerHTML = `<div class="schema-msg">${escapeHtml(error.message)}</div>`;
    } finally {
      submit.disabled = false;
    }
  });

  function renderReport(report) {
    const stats = report.stats || {};
    const cards = Object.entries(STAT_LABELS)
      .map(
        ([key, label]) =>
          `<div class="stat-card"><div class="num">${stats[key] ?? 0}</div><div class="label">${label}</div></div>`
      )
      .join("");
    const issues = report.issues || [];
    const rows = issues
      .slice(0, 300)
      .map(
        (issue) => `<tr>
          <td>${escapeHtml(issue.case_id || "-")}</td>
          <td class="mono">${escapeHtml(issue.field_path || "-")}</td>
          <td>${escapeHtml(ISSUE_LABELS[issue.type] || issue.type)}</td>
          <td>${escapeHtml(issue.message || "")}</td>
          <td>${issue.line ?? "-"}</td>
        </tr>`
      )
      .join("");
    result.innerHTML = `
      <div class="stat-grid">${cards}</div>
      <div class="muted" style="margin-bottom:6px">
        import_id: <span class="mono">${escapeHtml(report.import_id)}</span>
        ${issues.length ? `· ${issues.length} issues${issues.length > 300 ? " (showing first 300)" : ""}` : "· No issues"}
      </div>
      ${
        issues.length
          ? `<table class="data-table"><thead><tr><th>Case ID</th><th>Field path</th><th>Type</th><th>Message</th><th>Line</th></tr></thead><tbody>${rows}</tbody></table>`
          : ""
      }
    `;
  }

  modal.foot.appendChild(cancel);
  modal.foot.appendChild(submit);
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------
export function openExportModal({
  projectId,
  allCases,
  filteredCases,
  selectedCases,
  currentId,
  onDone,
}) {
  const modal = openModal({ title: "Export", wide: true });
  const totalCount = allCases.length;

  const scope = mk("div", "radio-row");
  scope.innerHTML = `
    <label><input type="radio" name="export-scope" value="all" checked /> All (${totalCount})</label>
    <label><input type="radio" name="export-scope" value="filtered" /> Current filter (${filteredCases.length})</label>
    <label><input type="radio" name="export-scope" value="selected" ${selectedCases.length ? "" : "disabled"} /> Selected (${selectedCases.length})</label>
    <label><input type="radio" name="export-scope" value="current" ${currentId ? "" : "disabled"} /> Current case only</label>
  `;

  const label = textInput("Optional, appended to the export folder name");
  const result = mk("div");
  result.style.marginTop = "14px";

  modal.body.appendChild(fieldRow("Scope", scope));
  modal.body.appendChild(fieldRow("Version label", label));
  modal.body.appendChild(
    fieldRow(
      "Contents",
      Object.assign(mk("div", "muted"), {
        textContent:
          "manifest.csv / manifest.json / schema.json / fields.csv / summary.csv / cases/<case_id>/{image.png,label.json,notes.csv}",
      })
    )
  );
  modal.body.appendChild(result);

  const cancel = mk("button", "btn");
  cancel.textContent = "Close";
  cancel.addEventListener("click", () => modal.close());

  const submit = mk("button", "btn primary");
  submit.textContent = "Start export";
  submit.addEventListener("click", async () => {
    submit.disabled = true;
    try {
      const picked = scope.querySelector("input:checked").value;
      let caseIds;
      if (picked === "filtered") caseIds = filteredCases.map((c) => c.case_id);
      else if (picked === "selected") caseIds = selectedCases.map((c) => c.case_id);
      else if (picked === "current") caseIds = [currentId];
      else caseIds = allCases.map((c) => c.case_id);

      const res = await api.post(projectUrl(projectId, "/exports"), {
        case_ids: caseIds,
        label: label.value.trim(),
      });
      toast(`Exported ${res.case_count} cases to exports/${res.version}`);
      result.innerHTML = `
        <div class="stat-grid">
          <div class="stat-card"><div class="num">${res.case_count}</div><div class="label">Cases</div></div>
        </div>
        <div class="muted" style="margin-bottom:8px">
          Export folder: <span class="mono">${escapeHtml(res.relative_dir)}</span>
        </div>
        <a class="btn" href="/api/projects/${encodeURIComponent(projectId)}/exports/${encodeURIComponent(res.version)}/manifest.csv" target="_blank"><i class="bi bi-download"></i> Download manifest.csv</a>
      `;
      if (onDone) onDone(res);
    } catch (error) {
      toast(error.message, true);
      result.innerHTML = `<div class="schema-msg">${escapeHtml(error.message)}</div>`;
    } finally {
      submit.disabled = false;
    }
  });

  modal.foot.appendChild(cancel);
  modal.foot.appendChild(submit);
}
