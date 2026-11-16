import { createRequestScope } from "./request-scope.mjs";

const form = document.querySelector("#research-search-form");
const input = document.querySelector("#research-query");
const button = document.querySelector("#research-search-button");
const status = document.querySelector("#research-search-status");
const results = document.querySelector("#research-search-results");
let authClient;
let currentUser = null;
const searchScope = createRequestScope();

function setStatus(message, state = "") {
  status.textContent = message;
  status.dataset.state = state;
}

function addText(parent, tag, text, className = "") {
  const node = document.createElement(tag);
  node.textContent = text || "";
  if (className) node.className = className;
  parent.append(node);
  return node;
}

function resultCard(type, titleText, description, sourceId, fullText = "") {
  const article = document.createElement("article");
  article.className = "research-result-card";
  const header = document.createElement("header");
  addText(header, "h3", titleText || "Untitled source");
  addText(header, "span", type, "research-result-type");
  article.append(header);
  if (description) addText(article, "p", description);
  if (sourceId) addText(article, "p", `Verified source record: ${sourceId}`, "research-result-source");
  if (fullText) {
    const details = document.createElement("details");
    addText(details, "summary", "View source text");
    addText(details, "pre", fullText);
    article.append(details);
  }
  return article;
}

function renderSearchResults(data) {
  results.replaceChildren();
  const groups = [
    ["Course material", data.materials || [], (item) => resultCard(
      "material",
      item.title,
      [item.course_title, item.section_heading, item.page_number ? `Page ${item.page_number}` : ""].filter(Boolean).join(" · "),
      item.material_id,
      item.content
    )],
    ["Verified cases", data.cases || [], (item) => resultCard(
      "case",
      item.case_name,
      [item.citation, item.court, item.jurisdiction, item.year].filter(Boolean).join(" · "),
      item.id,
      item.ratio_decidendi || item.decision || item.material_facts
    )],
    ["Statutes", data.statutes || [], (item) => resultCard(
      "statute",
      `${item.title}${item.section_number ? ` · s ${item.section_number}` : ""}`,
      [item.jurisdiction, item.year, item.heading].filter(Boolean).join(" · "),
      item.statute_id || item.id,
      item.full_text
    )],
    ["Exact past questions", data.pastQuestions || [], (item) => resultCard(
      "verified past question",
      [item.question_number, item.examination_year, item.semester].filter(Boolean).join(" · ") || "Past question",
      item.course_title || "Verified archive record",
      item.id,
      item.question_text
    )],
    ["Verified case mnemonics", data.mnemonics || [], (item) => resultCard(
      "mnemonic",
      item.case_name || "Case memory aid",
      item.explanation,
      item.id,
      item.mnemonic
    )],
    ["Approved case memory summaries", data.summaries || [], (item) => resultCard(
      "approved memory summary",
      item.case_name || "Case memory summary",
      [item.citation, item.memory_trigger].filter(Boolean).join(" · "),
      item.id,
      [item.full_summary, item.revision_summary, item.exam_ready_summary, item.key_principle].filter(Boolean).join("\n\n")
    )],
    ["Verified marking rubrics", data.rubrics || [], (item) => resultCard(
      "marking rubric",
      item.title,
      [item.course_title, item.total_marks != null ? `${item.total_marks} marks` : ""].filter(Boolean).join(" · "),
      item.id,
      [item.question_text, item.instructions, ...(Array.isArray(item.criteria) ? item.criteria.map((criterion) => `${criterion.criterion} (${criterion.marks} marks)${criterion.description ? `: ${criterion.description}` : ""}`) : [])].filter(Boolean).join("\n\n")
    )]
  ];
  let count = 0;
  for (const [label, entries, makeCard] of groups) {
    if (!entries.length) continue;
    const heading = document.createElement("h3");
    heading.className = "research-results-heading";
    heading.textContent = `${label} · ${entries.length}`;
    results.append(heading);
    for (const item of entries) {
      results.append(makeCard(item));
      count++;
    }
  }
  if (!count) {
    const empty = document.createElement("div");
    empty.className = "server-material-empty";
    empty.textContent = "No verified source matches were found. Try a shorter topic, case citation or legal phrase.";
    results.append(empty);
  }
  return count;
}

async function search(event) {
  event.preventDefault();
  const isCurrent = searchScope.begin();
  results.replaceChildren();
  const query = input.value.trim();
  if (query.length < 3) {
    setStatus("Enter at least three characters to search.", "error");
    return;
  }
  if (!currentUser || !authClient) {
    setStatus("Sign in before searching approved Neon sources.", "error");
    return;
  }
  button.disabled = true;
  setStatus("Searching Neon for approved materials and verified legal sources. No AI provider is called.");
  try {
    const response = await authClient.apiRequest("/api/v1/research/search", {
      method: "POST",
      body: JSON.stringify({ query })
    });
    let body = {};
    try { body = await response.json(); } catch { /* use a safe fallback below */ }
    if (!isCurrent()) return;
    if (!response.ok) throw new Error(body.error || `Search is unavailable (${response.status}).`);
    const count = renderSearchResults(body.data || {});
    setStatus(`${count} source result${count === 1 ? "" : "s"}. Search was performed within FIRE COUNSEL; no prompt was sent to Gemini.`);
  } catch (error) {
    if (!isCurrent()) return;
    setStatus(error.message || "Neon source search could not be completed.", "error");
  } finally {
    if (isCurrent()) button.disabled = false;
  }
}

form.addEventListener("submit", search);

try {
  authClient = await import("./firebase/auth-client.mjs");
  authClient.onAuthStateChanged(authClient.firebaseAuth, (user) => {
    searchScope.invalidate();
    results.replaceChildren();
    button.disabled = false;
    currentUser = user;
    if (!user) setStatus("Sign in to search published and verified Neon sources.");
    else setStatus("Ready to search approved materials, cases, statutes and exact past questions.");
  }, () => {
    searchScope.invalidate();
    currentUser = null;
    results.replaceChildren();
    button.disabled = false;
    setStatus("Firebase Auth could not verify this session.", "error");
  });
} catch (error) {
  setStatus("Firebase client configuration is not available. No search request was sent.", "error");
  console.warn("Legal source search unavailable:", error.message);
}
