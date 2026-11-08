import { api, projectUrl } from "./api.js";
import { openModal } from "./modal.js";
import { toast } from "./util.js";

const FIELD_LIMIT = 50;
const NOTE_LIMIT = 50;

function mk(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function tag(text) {
  const node = mk("span", "notes-tag");
  node.textContent = text;
  return node;
}

function pill(text, kind) {
  const node = mk("span", `notes-pill ${kind}`);
  node.textContent = text;
  return node;
}

function status(text, isError = false) {
  const node = mk("div", `notes-status${isError ? " error" : ""}`);
  node.textContent = text;
  return node;
}

function emptyState(icon, text) {
  const box = mk("div", "empty-state");
  const iconNode = document.createElement("i");
  iconNode.className = `bi ${icon}`;
  iconNode.setAttribute("aria-hidden", "true");
  const message = document.createElement("p");
  message.textContent = text;
  box.appendChild(iconNode);
  box.appendChild(message);
  return box;
}

function copyText(text) {
  const fallback = () => {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } finally {
      area.remove();
    }
    if (!ok) throw new Error("Copy failed");
  };
  const done = () => toast("Prompt copied");
  const failed = () => toast("Copy failed", true);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, () => {
      try {
        fallback();
        done();
      } catch (error) {
        failed();
      }
    });
    return;
  }
  try {
    fallback();
    done();
  } catch (error) {
    failed();
  }
}

export function openNotesPromptModal({ projectId, onJumpToCase }) {
  const modal = openModal({ title: "Notes & prompt", wide: true });
  modal.backdrop.classList.add("notes-modal");

  const tabs = mk("div", "notes-tabs");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "Notes and prompt views");
  tabs.innerHTML = `
    <button type="button" class="notes-tab active" id="notes-tab-notes" data-tab="notes" role="tab" aria-selected="true" aria-controls="notes-panel">Notes by field</button>
    <button type="button" class="notes-tab" id="notes-tab-prompt" data-tab="prompt" role="tab" aria-selected="false" aria-controls="prompt-panel" tabindex="-1">Prompt draft</button>
  `;

  const notesPanel = mk("div", "notes-panel");
  notesPanel.id = "notes-panel";
  notesPanel.setAttribute("role", "tabpanel");
  notesPanel.setAttribute("aria-labelledby", "notes-tab-notes");

  const promptPanel = mk("div", "notes-panel");
  promptPanel.id = "prompt-panel";
  promptPanel.setAttribute("role", "tabpanel");
  promptPanel.setAttribute("aria-labelledby", "notes-tab-prompt");
  promptPanel.hidden = true;

  modal.body.appendChild(tabs);
  modal.body.appendChild(notesPanel);
  modal.body.appendChild(promptPanel);

  let activeTab = "notes";
  let summary = null;
  let summaryLoading = false;
  let summaryError = "";
  let showAllFields = false;
  const expandedNotes = new Set();

  let prompt = null;
  let promptLoading = false;
  let promptError = "";
  let promptLoaded = false;
  let showAllSections = false;

  function renderNotes() {
    notesPanel.innerHTML = "";
    if (summaryLoading) {
      notesPanel.appendChild(status("Loading notes…"));
      return;
    }
    if (summaryError) {
      notesPanel.appendChild(status(summaryError, true));
      return;
    }
    if (!summary) return;

    const fields = summary.fields || [];
    const total = summary.total_notes || 0;

    const head = mk("div", "notes-summary");
    const icon = document.createElement("i");
    icon.className = "bi bi-chat-square-text";
    icon.setAttribute("aria-hidden", "true");
    const text = mk("span");
    text.textContent = `${total} note${total === 1 ? "" : "s"} across ${
      fields.length
    } field${fields.length === 1 ? "" : "s"}`;
    head.appendChild(icon);
    head.appendChild(text);
    notesPanel.appendChild(head);

    if (!fields.length) {
      notesPanel.appendChild(
        emptyState(
          "bi-chat-square",
          "No field notes yet. Add a note with the sticky-note button on any field."
        )
      );
      return;
    }

    const limit = showAllFields ? fields.length : Math.min(FIELD_LIMIT, fields.length);
    const cards = mk("div", "notes-cards");
    fields.slice(0, limit).forEach((field) => {
      cards.appendChild(renderFieldCard(field));
    });
    notesPanel.appendChild(cards);

    if (fields.length > limit) {
      const more = mk("div", "notes-more");
      const button = mk("button", "btn small");
      button.type = "button";
      button.dataset.showAllFields = "1";
      button.textContent = `Show all ${fields.length} fields`;
      more.appendChild(button);
      notesPanel.appendChild(more);
    }
  }

  function renderFieldCard(field) {
    const card = mk("article", "notes-card");

    const head = mk("div", "notes-card-head");
    const label = mk("span", "notes-card-label");
    label.textContent = field.label || field.field_path;
    head.appendChild(label);
    if (field.type) head.appendChild(tag(field.type));
    if (field.conflict) head.appendChild(pill("Conflict", "danger"));
    const count = mk("span", "notes-count");
    const noteCount = field.count || 0;
    const caseCount = field.case_count || 0;
    count.textContent = `${noteCount} note${noteCount === 1 ? "" : "s"} · ${caseCount} case${
      caseCount === 1 ? "" : "s"
    }`;
    head.appendChild(count);
    card.appendChild(head);

    const path = mk("div", "notes-path mono");
    path.textContent = field.field_path;
    card.appendChild(path);

    const notes = field.notes || [];
    const expanded = expandedNotes.has(field.field_path);
    const limit = expanded ? notes.length : Math.min(NOTE_LIMIT, notes.length);
    const list = mk("ul", "notes-list");
    notes.slice(0, limit).forEach((entry) => {
      const item = mk("li", "notes-item");
      const jump = mk("button", "notes-case");
      jump.type = "button";
      jump.dataset.caseId = entry.case_id;
      jump.dataset.fieldPath = field.field_path;
      jump.textContent = entry.case_id;
      jump.title = `Open case ${entry.case_id}`;
      const note = mk("span", "notes-text");
      note.textContent = entry.note;
      item.appendChild(jump);
      item.appendChild(note);
      list.appendChild(item);
    });
    card.appendChild(list);

    if (notes.length > limit) {
      const more = mk("div", "notes-more");
      const button = mk("button", "btn small ghost");
      button.type = "button";
      button.dataset.expandNotes = field.field_path;
      button.textContent = `Show all ${notes.length} notes`;
      more.appendChild(button);
      card.appendChild(more);
    }

    const variants = field.variants || [];
    if (variants.length) {
      const details = document.createElement("details");
      details.className = "notes-variants";
      const summaryNode = document.createElement("summary");
      summaryNode.textContent = `Variants (${variants.length})`;
      details.appendChild(summaryNode);
      const variantList = mk("ul", "notes-variant-list");
      variants.forEach((variant) => {
        const item = mk("li", "notes-variant");
        const value = mk("span", "notes-variant-text");
        value.textContent = variant.note;
        const times = mk("span", "notes-variant-count");
        times.textContent = `×${variant.count}`;
        item.appendChild(value);
        item.appendChild(times);
        variantList.appendChild(item);
      });
      details.appendChild(variantList);
      card.appendChild(details);
    }

    return card;
  }

  function renderPrompt() {
    promptPanel.innerHTML = "";
    if (promptLoading) {
      promptPanel.appendChild(status("Loading prompt…"));
      return;
    }
    if (promptError) {
      promptPanel.appendChild(status(promptError, true));
      return;
    }
    if (!prompt) return;

    const sections = prompt.sections || [];

    const toolbar = mk("div", "prompt-toolbar");
    const info = mk("span", "prompt-info");
    info.textContent = `${sections.length} section${sections.length === 1 ? "" : "s"}`;
    toolbar.appendChild(info);
    toolbar.appendChild(mk("span", "prompt-spacer"));

    const copy = mk("button", "btn small");
    copy.type = "button";
    copy.innerHTML = '<i class="bi bi-clipboard" aria-hidden="true"></i>Copy';
    copy.title = "Copy the prompt text";
    copy.addEventListener("click", () => copyText(prompt.text || ""));
    toolbar.appendChild(copy);

    const refresh = mk("button", "btn small ghost");
    refresh.type = "button";
    refresh.innerHTML = '<i class="bi bi-arrow-repeat" aria-hidden="true"></i>Refresh';
    refresh.title = "Rebuild the prompt from the latest annotations";
    refresh.addEventListener("click", () => loadPrompt(true));
    toolbar.appendChild(refresh);

    promptPanel.appendChild(toolbar);

    if (!sections.length) {
      promptPanel.appendChild(
        emptyState("bi-magic", "No prompt sections yet. Add schema fields and examples first.")
      );
    } else {
      const limit = showAllSections
        ? sections.length
        : Math.min(FIELD_LIMIT, sections.length);
      const grid = mk("div", "prompt-sections");
      sections.slice(0, limit).forEach((section) => {
        grid.appendChild(renderPromptCard(section));
      });
      promptPanel.appendChild(grid);
      if (sections.length > limit) {
        const more = mk("div", "notes-more");
        const button = mk("button", "btn small");
        button.type = "button";
        button.dataset.showAllSections = "1";
        button.textContent = `Show all ${sections.length} sections`;
        more.appendChild(button);
        promptPanel.appendChild(more);
      }
    }

    const pre = mk("pre", "prompt-text");
    pre.textContent = prompt.text || "";
    promptPanel.appendChild(pre);
  }

  function renderPromptCard(section) {
    const card = mk("article", "prompt-card");
    const head = mk("div", "prompt-card-head");
    const label = mk("span", "prompt-card-label");
    label.textContent = section.label || section.field_path;
    head.appendChild(label);
    if (section.type) head.appendChild(tag(section.type));
    if (section.required) head.appendChild(pill("Required", "warning"));
    if (section.conflict) head.appendChild(pill("Conflict", "danger"));
    const count = mk("span", "notes-count");
    let noteCount = (section.notes || []).length;
    if (summary && Array.isArray(summary.fields)) {
      const match = summary.fields.find((field) => field.field_path === section.field_path);
      if (match && typeof match.count === "number") noteCount = match.count;
    }
    count.textContent = `${noteCount} note${noteCount === 1 ? "" : "s"}`;
    head.appendChild(count);
    card.appendChild(head);

    const path = mk("div", "notes-path mono");
    path.textContent = section.field_path;
    card.appendChild(path);

    if (section.description) {
      const desc = mk("div", "prompt-desc");
      desc.textContent = section.description;
      card.appendChild(desc);
    }

    const examples = section.examples || [];
    if (examples.length) {
      const chips = mk("div", "prompt-chips");
      examples.forEach((value) => {
        const chip = mk("span", "prompt-chip mono");
        chip.textContent = value;
        chip.title = value;
        chips.appendChild(chip);
      });
      card.appendChild(chips);
    }

    return card;
  }

  function setTab(name) {
    activeTab = name;
    tabs.querySelectorAll("[data-tab]").forEach((button) => {
      const on = button.dataset.tab === name;
      button.classList.toggle("active", on);
      button.setAttribute("aria-selected", String(on));
      button.tabIndex = on ? 0 : -1;
    });
    notesPanel.hidden = name !== "notes";
    promptPanel.hidden = name !== "prompt";
    if (name === "notes") {
      renderNotes();
    } else if (!promptLoaded) {
      loadPrompt(false);
    } else {
      renderPrompt();
    }
  }

  async function loadSummary() {
    summaryLoading = true;
    summaryError = "";
    renderNotes();
    try {
      summary = await api.get(projectUrl(projectId, "/notes/summary"));
    } catch (error) {
      summaryError = error.message;
    } finally {
      summaryLoading = false;
      renderNotes();
      if (activeTab === "prompt" && prompt) renderPrompt();
    }
  }

  async function loadPrompt(force) {
    if (promptLoaded && !force) return;
    promptLoading = true;
    promptError = "";
    renderPrompt();
    try {
      prompt = await api.get(projectUrl(projectId, "/prompt"));
      promptLoaded = true;
      showAllSections = false;
      if (typeof force === "boolean" && force) toast("Prompt refreshed");
    } catch (error) {
      promptError = error.message;
    } finally {
      promptLoading = false;
      if (activeTab === "prompt") renderPrompt();
    }
  }

  tabs.addEventListener("click", (event) => {
    const button = event.target.closest("[data-tab]");
    if (button) setTab(button.dataset.tab);
  });
  tabs.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const buttons = [...tabs.querySelectorAll("[data-tab]")];
    const index = buttons.findIndex((button) => button.dataset.tab === activeTab);
    const next =
      buttons[(index + (event.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length];
    if (next) {
      next.focus();
      setTab(next.dataset.tab);
    }
  });

  notesPanel.addEventListener("click", (event) => {
    const jump = event.target.closest("[data-case-id]");
    if (jump) {
      modal.close();
      if (typeof onJumpToCase === "function") {
        onJumpToCase(jump.dataset.caseId, jump.dataset.fieldPath);
      }
      return;
    }
    const expand = event.target.closest("[data-expand-notes]");
    if (expand) {
      expandedNotes.add(expand.dataset.expandNotes);
      renderNotes();
      return;
    }
    if (event.target.closest("[data-show-all-fields]")) {
      showAllFields = true;
      renderNotes();
    }
  });

  promptPanel.addEventListener("click", (event) => {
    if (event.target.closest("[data-show-all-sections]")) {
      showAllSections = true;
      renderPrompt();
    }
  });

  const exportLink = document.createElement("a");
  exportLink.className = "btn";
  exportLink.href = projectUrl(projectId, "/notes/summary.csv");
  exportLink.setAttribute("download", "");
  exportLink.title = "Download the notes summary as CSV";
  exportLink.innerHTML = '<i class="bi bi-download" aria-hidden="true"></i>Export CSV';

  const close = mk("button", "btn primary");
  close.type = "button";
  close.textContent = "Close";
  close.addEventListener("click", () => modal.close());

  modal.foot.appendChild(exportLink);
  modal.foot.appendChild(mk("span", "notes-foot-spacer"));
  modal.foot.appendChild(close);

  setTab("notes");
  loadSummary();
}
