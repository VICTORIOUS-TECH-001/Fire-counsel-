// Student workspace (study.html) settings: the built-in defaults, the icon
// set and the safe-link rules. Used by the student page (workspace.mjs) and
// the admin editor (admin-workspace.mjs). Admin changes are published to Firebase
// and archived in Neon as the "workspace" section, overriding these
// defaults for every student.

export const ICONS = {
  home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  courses: '<path d="M12 6.5C10 5 7 4.5 3 5v13c4-.5 7 0 9 1.5 2-1.5 5-2 9-1.5V5c-4-.5-7 0-9 1.5Z"/><path d="M12 6.5v13"/>',
  lecture: '<rect x="9" y="3" width="12" height="9" rx="1"/><path d="m12 9 3-3 2 2 2-2"/><circle cx="5" cy="7" r="2"/><path d="M2 21v-5a3 3 0 0 1 3-3h1l4 2M7 21v-6"/>',
  pdf: '<path d="M6 2h9l5 5v15H6z"/><path d="M14 2v6h6"/><path d="M8.5 17v-4h1.3a1.2 1.2 0 0 1 0 2.4H8.5M13 13v4h1a2 2 0 0 0 0-4zM18 13h-2v4M16 15h1.5"/>',
  case: '<path d="M12 3v18M7 21h10M5 7h14M12 4.5 5 7M12 4.5 19 7"/><path d="m5 7-3 6a3 3 0 0 0 6 0zM19 7l-3 6a3 3 0 0 0 6 0z"/>',
  statute: '<path d="M3 10h18L12 4zM5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 21h18M4 18h16"/>',
  dictionary: '<path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H20v15H5.5A1.5 1.5 0 0 0 4 19.5z"/><path d="M4 19.5A1.5 1.5 0 0 0 5.5 21H20v-3"/><path d="m9 13 2.5-6L14 13M10 11h3"/>',
  research: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.8-4.8"/>',
  exam: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1M8.5 12.5l2 2 4-4.5"/>',
  flashcards: '<rect x="3" y="7" width="13" height="14" rx="2" transform="rotate(-8 9.5 14)"/><path d="M10 4.2 18.8 3a2 2 0 0 1 2.2 1.7l1.5 10.9a2 2 0 0 1-1.7 2.3L19 18"/>',
  planner: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18M7.5 14h2M11 14h2M14.5 14h2M7.5 17.5h2M11 17.5h2"/>',
  ai: '<path d="M12 3c.5 3.8 2.2 5.5 6 6-3.8.5-5.5 2.2-6 6-.5-3.8-2.2-5.5-6-6 3.8-.5 5.5-2.2 6-6Z"/><path d="M19 15c.2 1.6.9 2.3 2.5 2.5-1.6.2-2.3.9-2.5 2.5-.2-1.6-.9-2.3-2.5-2.5 1.6-.2 2.3-.9 2.5-2.5ZM5 15.5c.2 1.2.7 1.7 1.8 1.8-1.1.2-1.6.7-1.8 1.9-.2-1.2-.7-1.7-1.8-1.9 1.1-.1 1.6-.6 1.8-1.8Z"/>',
  progress: '<path d="M4 20V10M10 20V4M16 20v-7M21 20H3"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  help: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="2.5" y="14" width="4" height="6" rx="1.5"/><rect x="17.5" y="14" width="4" height="6" rx="1.5"/><path d="M19.5 20c0 1-1.5 2-4.5 2h-2"/>',
  fire: '<path d="M12 2.5c.8 3-1.6 4.6-3 6.6C7.6 11 7 12.6 7 14.4a5 5 0 0 0 10 0c0-2.2-1-3.9-2.2-5.2-.2 1.5-.9 2.5-1.9 3 .6-3.4-.2-7-.9-9.7Z"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8"/><path d="M10.3 20a1.9 1.9 0 0 0 3.4 0"/>',
  library: '<path d="M4 4h4v16H4zM10 4h4v16h-4zM15.5 4.6l3.9-1 3.6 15.5-3.9.9z"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'
};

export const ICON_NAMES = {
  home: "Home", courses: "Book (courses)", lecture: "Lecture", pdf: "PDF", case: "Scales (cases)", statute: "Court building (statutes)",
  dictionary: "Dictionary", research: "Search", exam: "Exam checklist", flashcards: "Flashcards", planner: "Calendar",
  ai: "AI sparkle", progress: "Progress chart", settings: "Settings", help: "Help headset", fire: "Flame", bell: "Bell", library: "Library", link: "Link"
};

export const icon = (name, extra = "") => `<svg viewBox="0 0 24 24" aria-hidden="true" ${extra}>${ICONS[name] || ICONS.link}</svg>`;

// Places a menu item or tile can open. Admins can also type their own link.
export const DESTINATIONS = [
  ["#dashboard", "Dashboard (home of the workspace)"],
  ["#subjects", "My courses"],
  ["#library", "Study library (approved lecture materials, saved PDFs)"],
  ["#ai-chat", "Research desk (search trusted sources)"],
  ["#memory", "Flashcards"],
  ["#exams", "Examination centre (past questions, focus timer)"],
  ["#planner", "Study planner & progress"],
  ["#profile", "My profile & settings"],
  ["./ai.html", "Fire Counsel AI — chat"],
  ["./ai.html?mode=case", "Fire Counsel AI — case analysis"],
  ["./ai.html?mode=notes", "Fire Counsel AI — exam-ready notes"],
  ["./ai.html?mode=questions", "Fire Counsel AI — question setter"],
  ["./ai.html?task=statute", "Fire Counsel AI — explain a section or statute"],
  ["./ai.html?task=mock", "Fire Counsel AI — timed mock exam"],
  ["./ai.html?task=marker", "Fire Counsel AI — mark my answer"],
  ["./ai.html?task=compare", "Fire Counsel AI — compare cases"],
  ["./ai.html?q=Define%20this%20legal%20term%20and%20give%20an%20example%3A%20", "Fire Counsel AI — legal dictionary"],
  ["./index.html", "Public home page"]
];

export const STUDENT_PAGES = ["dashboard", "ai-chat", "subjects", "library", "memory", "exams", "planner", "profile"];

export const DEFAULT_WORKSPACE = Object.freeze({
  brand: { name: "FIRE COUNSEL", tagline: "Study • Research • Excel", logo: "./assets/images/fire-counsel-brand.jpg" },
  search: { placeholder: "Search cases, statutes, notes…" },
  welcome: {
    title: "Welcome to FIRE COUNSEL,",
    accent: "Your Complete Law Student Workspace",
    tagline: "Study smarter. Research deeper. Achieve greater.",
    buttonLabel: "Explore Your Workspace",
    buttonLink: "#subjects",
    image: "./assets/images/workspace-hero.jpg",
    imageAlt: "Lady Justice, a gavel and law books in a library"
  },
  menu: [
    { icon: "home", label: "Dashboard", link: "#dashboard", show: true },
    { icon: "courses", label: "My Courses", link: "#subjects", show: true },
    { icon: "lecture", label: "Lecture Room", link: "#library", show: true },
    { icon: "pdf", label: "PDF Reader", link: "#library", show: true },
    { icon: "case", label: "Case Briefing", link: "./ai.html?mode=case", show: true },
    { icon: "statute", label: "Statute Explorer", link: "./ai.html?task=statute", show: true },
    { icon: "dictionary", label: "Legal Dictionary", link: "./ai.html?q=Define%20this%20legal%20term%20and%20give%20an%20example%3A%20", show: true },
    { icon: "research", label: "Research Desk", link: "#ai-chat", show: true },
    { icon: "exam", label: "Examination Centre", link: "#exams", show: true },
    { icon: "flashcards", label: "Flashcards", link: "#memory", show: true },
    { icon: "planner", label: "Study Planner", link: "#planner", show: true },
    { icon: "ai", label: "AI Tutor", link: "./ai.html", show: true },
    { icon: "progress", label: "My Progress", link: "#planner", show: true },
    { icon: "settings", label: "Settings", link: "#profile", show: true }
  ],
  tiles: [
    { icon: "courses", title: "My Courses", subtitle: "Manage your courses", link: "#subjects", show: true },
    { icon: "lecture", title: "Lecture Room", subtitle: "Access lecture materials", link: "#library", show: true },
    { icon: "pdf", title: "PDF Reader", subtitle: "Read your saved PDFs", link: "#library", show: true },
    { icon: "case", title: "Case Briefing", subtitle: "Analyse landmark cases", link: "./ai.html?mode=case", show: true },
    { icon: "statute", title: "Statute Explorer", subtitle: "Nigerian & international laws", link: "./ai.html?task=statute", show: true },
    { icon: "dictionary", title: "Legal Dictionary", subtitle: "Find legal terms", link: "./ai.html?q=Define%20this%20legal%20term%20and%20give%20an%20example%3A%20", show: true },
    { icon: "research", title: "Research Desk", subtitle: "Search authorities", link: "#ai-chat", show: true },
    { icon: "exam", title: "Examination Centre", subtitle: "Past questions & CBT", link: "#exams", show: true },
    { icon: "flashcards", title: "Flashcards", subtitle: "Memorise key concepts", link: "#memory", show: true, wide: true },
    { icon: "planner", title: "Study Planner", subtitle: "Plan your study", link: "#planner", show: true, wide: true }
  ],
  ai: {
    show: true,
    title: "FIRE COUNSEL AI",
    subtitle: "Your Intelligent Law Tutor",
    intro: "Ask me any legal question… I'll help you with accurate and reliable legal insights.",
    placeholder: "Type your question…",
    footer: "Powered by Gemini"
  },
  quote: {
    show: true,
    text: "Dream Big, Study Hard, Graduate Great!",
    brand: "FIRE COUNSEL",
    subline: "Your Legal Success Partner",
    image: "./assets/images/workspace-quote.jpg"
  },
  progress: {
    show: true,
    title: "Your Academic Progress",
    cheer: "Keep going!",
    cheerText: "You're on track to achieve your goals.",
    items: [
      { key: "cards", label: "Flashcards created", goal: 20 },
      { key: "sessions", label: "Focus sessions completed", goal: 10 },
      { key: "files", label: "Notes & files saved", goal: 5 },
      { key: "tasks", label: "Planner tasks done", goal: 5 }
    ]
  },
  deadlines: {
    show: true,
    title: "Upcoming Deadlines",
    items: []
  },
  notices: [],
  courses: { show: true, title: "Continue studying" },
  help: { show: true, title: "Need Help?", subtitle: "Chat with FIRE COUNSEL", link: "./ai.html" }
});

export const PROGRESS_KEYS = { cards: "Flashcards created", sessions: "Focus sessions completed", files: "Notes & files saved", tasks: "Planner tasks done" };

const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);
const text = (value, fallback, max = 300) => (typeof value === "string" ? value.slice(0, max) : fallback);

/** Only links inside this site, page sections and https links are allowed. */
export function safeLink(value, fallback = "#dashboard") {
  const link = String(value ?? "").trim();
  if (!link) return fallback;
  if (/^#[a-z][a-z-]*$/i.test(link)) return link;
  if (/^\.?\/(?!\/)[^\s"'<>\\]*$/.test(link)) return link;
  if (/^https:\/\/[^\s"'<>\\]+$/i.test(link)) return link;
  return fallback;
}

/** Same rules for pictures, plus uploaded admin photos (/media/...). */
export function safeImage(value, fallback = "") {
  const link = String(value ?? "").trim();
  if (/^\.?\/(?!\/)[^\s"'<>\\()]*\.(?:jpe?g|png|webp|svg)$/i.test(link)) return link;
  if (/^https:\/\/[^\s"'<>\\()]+$/i.test(link)) return link;
  return fallback;
}

/** Page name for "#name" links to a workspace section, otherwise null. */
export function pageOf(link) {
  const match = /^#([a-z-]+)$/.exec(String(link || ""));
  return match && STUDENT_PAGES.includes(match[1]) ? match[1] : null;
}

function mergeSection(base, value, max = {}) {
  const out = { ...base };
  if (!isObject(value)) return out;
  for (const [key, fallback] of Object.entries(base)) {
    if (typeof fallback === "boolean") out[key] = typeof value[key] === "boolean" ? value[key] : fallback;
    else if (typeof fallback === "string") out[key] = text(value[key], fallback, max[key] || 300);
  }
  return out;
}

const cleanItem = (item, defaults) => ({
  icon: ICONS[item?.icon] ? item.icon : defaults.icon,
  label: text(item?.label, "", 60),
  title: text(item?.title, "", 60),
  subtitle: text(item?.subtitle, "", 90),
  link: safeLink(item?.link, defaults.link),
  show: item?.show !== false,
  wide: Boolean(item?.wide)
});

/** Admin settings over the defaults; anything missing or invalid uses the default. */
export function mergeWorkspace(value) {
  const base = DEFAULT_WORKSPACE;
  const cfg = isObject(value) ? value : {};
  const out = {
    brand: mergeSection(base.brand, cfg.brand),
    search: mergeSection(base.search, cfg.search),
    welcome: mergeSection(base.welcome, cfg.welcome),
    ai: mergeSection(base.ai, cfg.ai, { intro: 400 }),
    quote: mergeSection(base.quote, cfg.quote),
    courses: mergeSection(base.courses, cfg.courses),
    help: mergeSection(base.help, cfg.help),
    progress: { ...mergeSection(base.progress, cfg.progress), items: base.progress.items.map((item) => ({ ...item })) },
    deadlines: { ...mergeSection(base.deadlines, cfg.deadlines), items: [] },
    notices: [],
    menu: base.menu.map((item) => ({ ...item })),
    tiles: base.tiles.map((item) => ({ ...item }))
  };
  out.brand.logo = safeImage(out.brand.logo, base.brand.logo);
  out.welcome.image = safeImage(out.welcome.image, "");
  out.welcome.buttonLink = safeLink(out.welcome.buttonLink, base.welcome.buttonLink);
  out.quote.image = safeImage(out.quote.image, "");
  out.help.link = safeLink(out.help.link, base.help.link);
  if (Array.isArray(cfg.menu)) out.menu = cfg.menu.slice(0, 24).map((item) => cleanItem(item, { icon: "link", link: "#dashboard" })).filter((item) => item.label);
  if (Array.isArray(cfg.tiles)) out.tiles = cfg.tiles.slice(0, 24).map((item) => cleanItem(item, { icon: "link", link: "#dashboard" })).filter((item) => item.title);
  if (Array.isArray(cfg.progress?.items)) {
    const items = cfg.progress.items.filter((item) => PROGRESS_KEYS[item?.key]).slice(0, 6)
      .map((item) => ({ key: item.key, label: text(item.label, PROGRESS_KEYS[item.key], 60) || PROGRESS_KEYS[item.key], goal: Math.min(Math.max(Math.round(Number(item.goal)) || 1, 1), 10_000) }));
    if (items.length) out.progress.items = items;
  }
  if (Array.isArray(cfg.deadlines?.items)) {
    out.deadlines.items = cfg.deadlines.items.slice(0, 40)
      .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(String(item?.date || "")) && text(item?.title, "").trim())
      .map((item) => ({ date: item.date, title: text(item.title, "", 120), link: item.link ? safeLink(item.link, "") : "" }));
  }
  if (Array.isArray(cfg.notices)) out.notices = cfg.notices.map((note) => text(note, "", 300).trim()).filter(Boolean).slice(0, 10);
  return out;
}

/** Days from today (local time) to a YYYY-MM-DD date. */
export function daysUntil(date, now = new Date()) {
  const [y, m, d] = String(date).split("-").map(Number);
  const target = new Date(y, m - 1, d);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - today) / 86_400_000);
}

export function dueLabel(days) {
  if (days < 0) return days === -1 ? "1 day late" : `${-days} days late`;
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return `${days} days left`;
}

export const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[ch]);
const external = (link) => (/^https:/i.test(link) ? ' target="_blank" rel="noopener noreferrer"' : "");
const ARROW = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

/** Sidebar links. The first link to each workspace section gets data-page
 *  (used for the highlighted item); the course counter always exists. */
export function menuHTML(cfg, courseCount = "") {
  const used = new Set();
  let counted = false;
  const links = cfg.menu.filter((item) => item.show).map((item) => {
    const page = pageOf(item.link);
    let attrs;
    if (page && !used.has(page)) { used.add(page); attrs = `data-page="${page}" href="#${page}"`; }
    else if (page) attrs = `data-go="${page}" href="#${page}"`;
    else attrs = `href="${escapeHTML(item.link)}"${external(item.link)}`;
    let badge = "";
    if (page === "subjects" && !counted) { counted = true; badge = `<span class="nav-count" id="course-nav-count">${escapeHTML(courseCount)}</span>`; }
    return `<a class="nav-link" ${attrs}><span class="nav-icon">${icon(item.icon)}</span><span class="nav-text">${escapeHTML(item.label)}</span>${badge}</a>`;
  });
  if (!counted) links.push(`<span class="nav-count" id="course-nav-count" hidden>${escapeHTML(courseCount)}</span>`);
  return links.join("");
}

/** Dashboard tool tiles. */
export function tilesHTML(cfg) {
  return cfg.tiles.filter((tile) => tile.show).map((tile) => {
    const page = pageOf(tile.link);
    const attrs = page ? `data-go="${page}" href="#${page}"` : `href="${escapeHTML(tile.link)}"${external(tile.link)}`;
    return `<a class="ws-tile${tile.wide ? " ws-tile-wide" : ""}" ${attrs}><span class="ws-tile-icon">${icon(tile.icon)}</span><span class="ws-tile-text"><strong>${escapeHTML(tile.title)}</strong><small>${escapeHTML(tile.subtitle)}</small></span><span class="ws-tile-go">${ARROW}</span></a>`;
  }).join("");
}

/** Attributes for a single link (buttons, "View all", help card). */
export function linkAttrs(link) {
  const page = pageOf(link);
  return page ? `data-go="${page}" href="#${page}"` : `href="${escapeHTML(link)}"${external(link)}`;
}
