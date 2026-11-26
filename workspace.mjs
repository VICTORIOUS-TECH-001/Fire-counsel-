// Student workspace (study.html): applies the administrator's workspace
// settings (Admin → Student workspace, live in Firestore with a Neon fallback),
// and runs the dashboard's planner, progress, deadlines,
// notifications and the quick "Ask Fire Counsel AI" box.
// Personal planner tasks stay in this browser (localStorage) only.
import { mergeWorkspace, menuHTML, tilesHTML, linkAttrs, icon, escapeHTML, daysUntil, dueLabel, pageOf } from "./workspace-config.mjs";

const $ = (selector, root = document) => root.querySelector(selector);
const PLANNER_KEY = "fire-counsel-planner";
const CONFIG_CACHE_KEY = "fire-counsel-workspace";
const PREVIEW_KEY = "fire-counsel-workspace-preview";
const BELL_SEEN_KEY = "fire-counsel-bell-seen";
const TYPES = { assignment: "Assignment", test: "Test / CBT", reading: "Reading", exam: "Exam", other: "Other" };

let cfg = mergeWorkspace(null);
const isPreview = new URLSearchParams(location.search).get("preview") === "workspace";

const store = {
  read(key, fallback) { try { const value = JSON.parse(localStorage.getItem(key) || "null"); return value ?? fallback; } catch { return fallback; } },
  write(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ } }
};

function setText(id, value) { const node = document.getElementById(id); if (node) node.textContent = value; }
function setImage(id, src, alt = "") {
  const node = document.getElementById(id);
  if (!node) return;
  if (!src) { node.hidden = true; return; }
  node.hidden = false;
  if (node.getAttribute("src") !== src) node.src = src;
  node.alt = alt;
}
function showSection(id, on) { const node = document.getElementById(id); if (node) node.hidden = !on; }
function setLink(node, link) {
  if (!node) return;
  const page = pageOf(link);
  node.removeAttribute("data-go"); node.removeAttribute("target"); node.removeAttribute("rel");
  node.setAttribute("href", page ? `#${page}` : link);
  if (page) node.dataset.go = page;
  else if (/^https:/i.test(link)) { node.target = "_blank"; node.rel = "noopener noreferrer"; }
}

// ------------------------------------------------------------------ planner
const planner = {
  list() { const items = store.read(PLANNER_KEY, []); return Array.isArray(items) ? items.filter((item) => item && item.id && item.title && /^\d{4}-\d{2}-\d{2}$/.test(item.date)) : []; },
  save(items) { store.write(PLANNER_KEY, items.slice(0, 300)); }
};

function allDeadlines({ includeDone = false } = {}) {
  const admin = cfg.deadlines.items.map((item) => ({ ...item, from: "admin", days: daysUntil(item.date) })).filter((item) => item.days >= 0);
  const mine = planner.list().filter((item) => includeDone || !item.done).map((item) => ({ ...item, from: "me", days: daysUntil(item.date) }));
  return [...admin, ...mine].sort((a, b) => a.days - b.days || a.title.localeCompare(b.title));
}

function badgeClass(days) { return days < 0 ? "late" : days <= 3 ? "soon" : days <= 7 ? "week" : "later"; }
function dateBox(date) {
  const [y, m, d] = date.split("-").map(Number);
  const when = new Date(y, m - 1, d);
  return `<span class="ws-datebox" aria-hidden="true"><small>${escapeHTML(when.toLocaleString("en", { month: "short" }).toUpperCase())}</small><b>${d}</b></span>`;
}
function deadlineItem(item, { controls = false } = {}) {
  const title = item.link ? `<a ${linkAttrs(item.link)}>${escapeHTML(item.title)}</a>` : escapeHTML(item.title);
  const meta = item.from === "me" ? (TYPES[item.type] || "My task") : "From your administrator";
  const tools = controls ? `<span class="ws-task-tools"><label class="ws-check"><input type="checkbox" data-task-done="${escapeHTML(item.id)}" ${item.done ? "checked" : ""}><span>Done</span></label><button type="button" class="ws-task-delete" data-task-delete="${escapeHTML(item.id)}" aria-label="Delete ${escapeHTML(item.title)}">&times;</button></span>` : "";
  return `<li class="ws-deadline${item.done ? " is-done" : ""}">${dateBox(item.date)}<span class="ws-deadline-text"><strong>${title}</strong><small>${escapeHTML(meta)}</small></span><span class="ws-badge ws-badge-${item.done ? "done" : badgeClass(item.days)}">${item.done ? "Done" : escapeHTML(dueLabel(item.days))}</span>${tools}</li>`;
}

function renderDeadlines() {
  const list = $("#ws-deadline-list");
  if (list) {
    const items = allDeadlines().slice(0, 4);
    list.innerHTML = items.length ? items.map((item) => deadlineItem(item)).join("")
      : `<li class="ws-empty">No deadlines yet. Add your own in the <a ${linkAttrs(`#planner`)}>Study Planner</a>.</li>`;
  }
  const mine = $("#planner-list");
  if (mine) {
    const items = planner.list().map((item) => ({ ...item, from: "me", days: daysUntil(item.date) }))
      .sort((a, b) => Number(a.done) - Number(b.done) || a.days - b.days);
    mine.innerHTML = items.length ? items.map((item) => deadlineItem(item, { controls: true })).join("")
      : `<li class="ws-empty">Nothing planned yet. Add your first deadline above.</li>`;
  }
  const admin = $("#planner-admin");
  if (admin) {
    const items = cfg.deadlines.items.map((item) => ({ ...item, from: "admin", days: daysUntil(item.date) })).filter((item) => item.days >= 0).sort((a, b) => a.days - b.days);
    admin.innerHTML = items.length ? items.map((item) => deadlineItem(item)).join("") : `<li class="ws-empty">No class deadlines have been posted.</li>`;
  }
  renderBell();
  renderProgress();
}

// ------------------------------------------------------------------ progress
function count(id) { return Number(document.getElementById(id)?.textContent) || 0; }
function progressValues() {
  return { cards: count("stat-cards"), sessions: count("stat-sessions"), files: count("stat-materials"), tasks: planner.list().filter((item) => item.done).length };
}
function progressHTML() {
  const values = progressValues();
  const items = cfg.progress.items.map((item) => ({ ...item, value: values[item.key] || 0 }));
  const percent = items.length ? Math.round(items.reduce((sum, item) => sum + Math.min(1, item.value / item.goal), 0) / items.length * 100) : 0;
  const checks = items.map((item) => {
    const done = item.value >= item.goal;
    return `<li class="${done ? "is-done" : item.value ? "is-started" : ""}"><span class="ws-tick" aria-hidden="true">${done ? "✓" : ""}</span><span>${escapeHTML(item.label)}</span><small>${Math.min(item.value, 99_999)} / ${item.goal}</small></li>`;
  }).join("");
  return `<div class="ws-ring" style="--p:${percent}" role="img" aria-label="${percent}% of your study goals"><span>${percent}%</span></div><ul class="ws-checks">${checks}</ul>`
    + `<div class="ws-cheer"><span aria-hidden="true">${icon("progress")}</span><strong>${escapeHTML(percent >= 100 ? "Goals reached!" : cfg.progress.cheer)}</strong><small>${escapeHTML(percent >= 100 ? "Excellent work. Set yourself a new target." : cfg.progress.cheerText)}</small></div>`;
}
function renderProgress() {
  const html = progressHTML();
  const dash = $("#ws-progress-body");
  if (dash) dash.innerHTML = html;
  const page = $("#planner-progress-body");
  if (page) page.innerHTML = html;
}

// ------------------------------------------------------------------ notifications
function bellItems() {
  const soon = allDeadlines().filter((item) => item.days <= 7);
  return [
    ...cfg.notices.map((text) => ({ kind: "notice", text })),
    ...soon.map((item) => ({ kind: "deadline", text: `${item.title} — ${dueLabel(item.days)}` }))
  ];
}
const bellSignature = (items) => items.map((item) => item.text).join("|");
function renderBell() {
  const items = bellItems();
  const counter = $("#ws-bell-count");
  const unseen = items.length && bellSignature(items) !== store.read(BELL_SEEN_KEY, "");
  if (counter) { counter.textContent = String(Math.min(items.length, 9)); counter.hidden = !unseen; }
  const panel = $("#ws-bell-panel");
  if (panel) {
    panel.innerHTML = `<strong class="ws-bell-title">Notifications</strong>` + (items.length
      ? `<ul>${items.map((item) => `<li class="ws-bell-${item.kind}"><span aria-hidden="true">${item.kind === "notice" ? "📣" : "⏰"}</span>${escapeHTML(item.text)}</li>`).join("")}</ul>`
      : `<p>You are all caught up.</p>`) + `<a ${linkAttrs(`#planner`)}>Open my study planner &rarr;</a>`;
  }
}
function toggleBell(open) {
  const button = $("#ws-bell");
  const panel = $("#ws-bell-panel");
  if (!button || !panel) return;
  const next = open ?? panel.hidden;
  panel.hidden = !next;
  button.setAttribute("aria-expanded", String(next));
  if (next) { store.write(BELL_SEEN_KEY, bellSignature(bellItems())); const counter = $("#ws-bell-count"); if (counter) counter.hidden = true; }
}

// ------------------------------------------------------------------ apply settings
function markActive() {
  const page = location.hash.slice(1) || "dashboard";
  document.querySelectorAll("#student-nav .nav-link").forEach((link) => link.classList.toggle("active", link.dataset.page === page));
}

function apply(next) {
  cfg = mergeWorkspace(next);
  setText("ws-brand-name", cfg.brand.name);
  setText("ws-brand-tagline", cfg.brand.tagline);
  setImage("ws-logo", cfg.brand.logo);
  setText("ws-top-brand-name", cfg.brand.name);
  setText("ws-top-brand-tagline", cfg.brand.tagline);
  setImage("ws-top-logo", cfg.brand.logo);
  const search = $("#global-search");
  if (search) search.placeholder = cfg.search.placeholder;

  const nav = $("#student-nav");
  if (nav) {
    const current = $("#course-nav-count")?.textContent || "";
    nav.innerHTML = menuHTML(cfg, current);
    markActive();
  }
  const tiles = $("#ws-tiles");
  if (tiles) tiles.innerHTML = tilesHTML(cfg);

  setText("ws-welcome-title", cfg.welcome.title);
  setText("ws-welcome-accent", cfg.welcome.accent);
  setText("ws-welcome-tagline", cfg.welcome.tagline);
  setText("ws-welcome-label", cfg.welcome.buttonLabel);
  setLink($("#ws-welcome-button"), cfg.welcome.buttonLink);
  $("#ws-welcome-button").hidden = !cfg.welcome.buttonLabel;
  setImage("ws-hero-img", cfg.welcome.image, cfg.welcome.imageAlt);

  showSection("ws-ai-card", cfg.ai.show);
  setText("ws-ai-title", cfg.ai.title);
  setText("ws-ai-subtitle", cfg.ai.subtitle);
  setText("ws-ai-intro", cfg.ai.intro);
  setText("ws-ai-footer", cfg.ai.footer);
  const ask = $("#ws-ai-input");
  if (ask) ask.placeholder = cfg.ai.placeholder;

  showSection("ws-quote", cfg.quote.show);
  setText("ws-quote-text", cfg.quote.text);
  setText("ws-quote-brand", cfg.quote.brand);
  setText("ws-quote-subline", cfg.quote.subline);
  setImage("ws-quote-img", cfg.quote.image);

  showSection("ws-progress", cfg.progress.show);
  setText("ws-progress-heading", cfg.progress.title);
  showSection("ws-deadlines", cfg.deadlines.show);
  setText("ws-deadlines-heading", cfg.deadlines.title);
  showSection("student-courses", cfg.courses.show);
  setText("ws-courses-heading", cfg.courses.title);
  document.querySelector(".ws-bottom")?.classList.toggle("is-single", cfg.progress.show !== cfg.deadlines.show);
  document.querySelector(".ws-grid")?.classList.toggle("no-side", !cfg.ai.show && !cfg.quote.show);

  showSection("ws-help", cfg.help.show);
  setText("ws-help-title", cfg.help.title);
  setText("ws-help-subtitle", cfg.help.subtitle);
  setLink($("#ws-help"), cfg.help.link);
  renderDeadlines();
}

async function loadConfig() {
  if (isPreview) {
    const preview = store.read(PREVIEW_KEY, null);
    if (preview) {
      apply(preview);
      const banner = document.createElement("div");
      banner.className = "ws-preview-banner";
      banner.setAttribute("role", "status");
      banner.textContent = "PREVIEW — students do not see these changes until you press “Publish to all students” in the admin studio.";
      $(".views")?.prepend(banner);
      return;
    }
  }
  const cached = store.read(CONFIG_CACHE_KEY, null);
  if (cached) apply(cached);
  try {
    let content = null;
    try {
      const { loadPublicSiteContent } = await import("./firebase/firestore-client.mjs");
      content = await loadPublicSiteContent();
    } catch { /* offline/unconfigured: use the same Neon/bundled fallback as the homepage */ }
    if (!content) {
      const response = await fetch("./data/site-content.json", { cache: "no-cache" });
      if (!response.ok) return;
      content = await response.json();
    }
    const workspace = content && typeof content === "object" ? content.workspace || null : null;
    store.write(CONFIG_CACHE_KEY, workspace);
    if (JSON.stringify(workspace) !== JSON.stringify(cached)) apply(workspace);
  } catch { /* offline: keep the cached or built-in settings */ }
}

// ------------------------------------------------------------------ events
document.addEventListener("click", (event) => {
  const done = event.target.closest("[data-task-done]");
  if (done) {
    const items = planner.list().map((item) => (item.id === done.dataset.taskDone ? { ...item, done: done.checked } : item));
    planner.save(items);
    renderDeadlines();
    return;
  }
  const remove = event.target.closest("[data-task-delete]");
  if (remove) {
    planner.save(planner.list().filter((item) => item.id !== remove.dataset.taskDelete));
    renderDeadlines();
    return;
  }
  if (event.target.closest("#ws-bell")) { toggleBell(); return; }
  if (!event.target.closest("#ws-bell-panel")) toggleBell(false);
  else if (event.target.closest("a")) toggleBell(false);
});
document.addEventListener("keydown", (event) => { if (event.key === "Escape") toggleBell(false); });

$("#planner-form")?.addEventListener("submit", (event) => {
  event.preventDefault();
  const title = $("#planner-title").value.trim();
  const date = $("#planner-date").value;
  if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
  const id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  planner.save([...planner.list(), { id, title: title.slice(0, 120), date, type: TYPES[$("#planner-type").value] ? $("#planner-type").value : "other", done: false, createdAt: Date.now() }]);
  event.target.reset();
  renderDeadlines();
  $("#planner-title").focus();
});

$("#ws-ai-form")?.addEventListener("submit", (event) => {
  event.preventDefault();
  const question = $("#ws-ai-input").value.trim();
  location.href = question ? `./ai.html?q=${encodeURIComponent(question.slice(0, 2000))}` : "./ai.html";
});

// Enter in the top search box runs a trusted-source search for the words.
$("#global-search")?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  const query = event.target.value.trim();
  if (query.length < 3) return;
  event.preventDefault();
  const field = $("#research-query");
  const form = $("#research-search-form");
  if (!field || !form) return;
  event.target.value = "";
  event.target.dispatchEvent(new Event("input"));
  location.hash = "ai-chat";
  field.value = query.slice(0, 500);
  if (form.requestSubmit) form.requestSubmit(); else form.dispatchEvent(new Event("submit", { cancelable: true }));
});

// Progress follows the counters the study tools keep up to date.
const observer = new MutationObserver(() => renderProgress());
for (const id of ["stat-cards", "stat-sessions", "stat-materials"]) {
  const node = document.getElementById(id);
  if (node) observer.observe(node, { childList: true, characterData: true, subtree: true });
}
// student-profile.mjs derives the account controls from Google Auth, not Neon readiness.
document.addEventListener("fire-counsel:page", () => toggleBell(false));
window.addEventListener("storage", (event) => { if (event.key === PLANNER_KEY) renderDeadlines(); });
// Deadlines count days, so refresh them when the student comes back later.
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") renderDeadlines(); });

const dateField = $("#planner-date");
if (dateField) { const now = new Date(); dateField.min = `${now.getFullYear() - 1}-01-01`; }
renderDeadlines();
loadConfig();
