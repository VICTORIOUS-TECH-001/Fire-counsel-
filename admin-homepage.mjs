// A focused copy form over the existing Pages & JSON editor. This module
// performs no persistence or network writes: admin-site.mjs owns the protected
// Google/admin draft, preview, publish, reset and version-restore workflow.
import { heroCopy, aiCopy, learningPreview, updateHomepageCopy, DEFAULT_CASE_VIDEO_URL } from "./homepage-copy.mjs";

const editor = document.querySelector("#json-editor");
const fields = document.querySelector("#homepage-copy-fields");
const tools = document.querySelector("#homepage-tool-fields");
const status = document.querySelector("#homepage-copy-status");
const object = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
let toolCount = -1;
let writing = false;

function read() {
  const content = JSON.parse(editor.value);
  if (!object(content?.hero) || !object(content?.learning) || !Array.isArray(content.learning.cards)
    || content.learning.cards.length > 40 || content.learning.cards.some(card => !object(card))) {
    throw new Error("Keep hero and learning objects, with a learning.cards list of up to 40 tools.");
  }
  return content;
}

function field(caption, path, maxLength, multiline = false) {
  const label = document.createElement("label");
  label.append(document.createTextNode(caption));
  const input = document.createElement(multiline ? "textarea" : "input");
  input.dataset.homepagePath = path;
  input.maxLength = maxLength;
  if (multiline) { input.rows = 3; label.className = "homepage-copy-wide"; }
  else input.type = "text";
  if (path.endsWith(".href")) {
    input.spellcheck = false;
    input.placeholder = "./study.html, #section or https://…";
  }
  label.append(input);
  return label;
}

function buildTools(cards) {
  // Rebuild only if the JSON changes the list length. Typing never replaces
  // the focused input, its cursor, or the open/closed illustration details.
  if (toolCount === cards.length) return;
  toolCount = cards.length;
  tools.replaceChildren();
  if (!cards.length) {
    const note = document.createElement("p");
    note.className = "homepage-copy-note";
    note.textContent = "There are no learning tools in this draft. You can add tools using the JSON editor below.";
    tools.append(note);
  }
  cards.forEach((card, index) => {
    const path = `learning.cards.${index}`;
    const details = document.createElement("details");
    details.className = "homepage-copy-tool";
    details.open = index === 0;
    const summary = document.createElement("summary");
    summary.dataset.homepageSummary = String(index);
    details.append(summary);
    const grid = document.createElement("div");
    grid.className = "homepage-copy-grid";
    grid.append(field("Tool title", `${path}.title`, 2000), field("Small number", `${path}.number`, 2000),
      field("Tool description", `${path}.text`, 2000, true), field("Link destination", `${path}.href`, 300),
      field("Link wording", `${path}.linkLabel`, 2000));
    details.append(grid);
    const preview = document.createElement("details");
    preview.className = "homepage-preview-copy";
    const previewSummary = document.createElement("summary");
    previewSummary.textContent = "Illustration words";
    preview.append(previewSummary);
    const labels = document.createElement("div");
    labels.className = "homepage-copy-grid";
    labels.append(field("Floating badge", `${path}.preview.badge`, 2000));
    learningPreview(card, index).labels.forEach((_text, i) => {
      labels.append(field(`Preview label ${i + 1}`, `${path}.preview.labels.${i}`, 2000));
    });
    preview.append(labels);
    details.append(preview);
    tools.append(details);
  });
}

function sync() {
  const verified = document.querySelector("#admin-auth-status")?.dataset.state === "verified";
  const ready = verified && editor.dataset.homepageReady === "true";
  let content;
  try { content = read(); }
  catch {
    fields.disabled = true;
    status.textContent = !verified ? "Sign in as an administrator to edit these words."
      : !ready ? "Loading your saved draft and live website words…"
      : "Fix the JSON below before editing these fields. The last displayed words have not overwritten your JSON.";
    status.dataset.kind = ready ? "error" : "";
    return;
  }
  buildTools(content.learning.cards);
  const values = new Map();
  for (const [key, value] of Object.entries(heroCopy(content))) values.set(`hero.copy.${key}`, value);
  values.set("caseNotes.videoUrl", Object.hasOwn(content.caseNotes || {}, "videoUrl") ? content.caseNotes.videoUrl : DEFAULT_CASE_VIDEO_URL);
  const ai = aiCopy(content);
  for (const key of ["title", "intro", "closing", "buttonLabel"]) values.set(`aiSpotlight.${key}`, ai[key]);
  ai.chips.forEach((text, index) => values.set(`aiSpotlight.chips.${index}`, text));
  for (const key of ["eyebrow", "title", "accent", "intro", "previewLabel"]) {
    values.set(`learning.${key}`, content.learning[key] ?? (key === "previewLabel" ? "FIRE COUNSEL · TOOL PREVIEW" : ""));
  }
  content.learning.cards.forEach((card, index) => {
    const path = `learning.cards.${index}`;
    for (const key of ["title", "number", "text", "href", "linkLabel"]) {
      const fallback = key === "number" ? String(index + 1).padStart(2, "0") : key === "linkLabel" ? `Open ${card.title || "study tool"}` : "";
      values.set(`${path}.${key}`, card[key] ?? fallback);
    }
    const preview = learningPreview(card, index);
    values.set(`${path}.preview.badge`, preview.badge);
    preview.labels.forEach((text, i) => values.set(`${path}.preview.labels.${i}`, text));
    tools.querySelector(`[data-homepage-summary="${index}"]`).textContent = `${String(index + 1).padStart(2, "0")} · ${card.title || "Untitled tool"}`;
  });
  fields.querySelectorAll("[data-homepage-path]").forEach(input => {
    // Preserve the user's in-progress spaces/cursor; the JSON stores the
    // normalized plain-text version required by the existing content validator.
    if (!writing || input !== document.activeElement) input.value = values.get(input.dataset.homepagePath) ?? "";
  });
  fields.disabled = !ready;
  status.dataset.kind = "";
  status.textContent = !verified ? "Sign in as an administrator to edit these words."
    : !ready ? "Loading your saved draft and live website words…"
    : "These fields and the JSON editor share one draft. Nothing is saved or published until you choose an action below.";
}

fields.addEventListener("input", event => {
  const input = event.target.closest("[data-homepage-path]");
  if (!input || fields.disabled) return;
  try {
    const content = updateHomepageCopy(read(), input.dataset.homepagePath, input.value);
    editor.value = JSON.stringify(content, null, 2);
    writing = true;
    editor.dispatchEvent(new Event("input"));
    status.textContent = "Words updated in the JSON editor, not saved or published. Use Save draft or Preview below.";
    status.dataset.kind = "";
  } catch (error) {
    status.textContent = `The words could not be updated: ${error.message}`;
    status.dataset.kind = "error";
  } finally { writing = false; }
});
editor.addEventListener("input", sync);
document.addEventListener("fire-counsel:site-editor-ready", sync);
document.addEventListener("fire-counsel:admin-state", sync);
sync();
