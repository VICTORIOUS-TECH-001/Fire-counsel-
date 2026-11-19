import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const read = path => readFileSync(resolve(root, path), "utf8");
const pages = ["index.html", "study.html", "admin.html", "auth.html", "ai.html", "student.html"];
const integrations = [
  ["study.html", ["study-materials.mjs", "research-search.mjs", "student-profile.mjs", "student-page.mjs", "presence.mjs", "workspace.mjs", "auth-gate.mjs"]],
  ["ai.html", ["ai-studio.mjs", "research-search.mjs", "presence.mjs", "auth-gate.mjs"]],
  ["admin.html", ["admin-auth.mjs", "admin-database.mjs", "admin-ai.mjs", "admin-courses.mjs", "admin-workspace.mjs", "admin-site.mjs", "admin-uploads.mjs", "presence.mjs"]],
  ["auth.html", ["auth-page.mjs"]],
  ["student.html", ["student-page-view.mjs"]]
];

for (const [page, modules] of integrations) {
  test(`${page} loads its integration modules with every required DOM target`, () => {
    const html = read(page);
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
    for (const module of modules) {
      assert.ok(html.includes(`type="module" src="./${module}"`), `${module} is mounted`);
      for (const match of read(module).matchAll(/["']#([a-z][a-z-]+)["']/g)) {
        assert.ok(ids.has(match[1]), `${module}: #${match[1]} exists in ${page}`);
      }
    }
  });
}

for (const page of pages) {
  test(`${page} has unique IDs and all local script/style/image assets`, () => {
    const html = read(page);
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    assert.equal(new Set(ids).size, ids.length, "no duplicate IDs");
    for (const match of html.matchAll(/<(?:script|link|img)\b[^>]*(?:src|href)="([^"#]+)"/g)) {
      const url = match[1].split(/[?#]/)[0];
      if (/^https?:/.test(url)) continue;
      assert.ok(existsSync(resolve(root, url)), `${url} exists`);
    }
  });
}

test("all six pages load shared centered branding after their page styles, including static and dynamic footers", () => {
  for (const page of pages) {
    const head = read(page).split("</head>")[0];
    const styles = [...head.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*>/g)].map(match => match[0]);
    assert.match(styles.at(-1), /href="\.\/branding\.css"/, `${page}: branding rules are loaded last`);
    assert.match(read(page), /fc-brand-lockup/, `${page}: the shared lockup is mounted`);
  }
  assert.match(read("site.js"), /footer-mark fc-brand-lockup/, "published JSON/footer rendering keeps the shared lockup");
  assert.match(read("workspace.mjs"), /setImage\("ws-top-logo", cfg\.brand\.logo\)/, "mobile and sidebar logos use the same published setting");
  for (const server of ["backend/src/website.js", "tools/dev_server.py"]) assert.match(read(server), /"branding\.css"/, `${server} serves the shared stylesheet`);
});

test("every admin navigation item has exactly one panel, with one initially visible", () => {
  const html = read("admin.html");
  const panels = [...html.matchAll(/<section\b[^>]*id="panel-([^"]+)"[^>]*>/g)];
  const tabs = [...html.matchAll(/data-panel="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(panels.map(match => match[1]).sort(), tabs.sort());
  assert.equal(panels.filter(match => !/\bhidden\b/.test(match[0])).length, 1);
  assert.ok(tabs.includes("database"));
});

test("admin AI panels never collect API keys and no longer show sample accounts or local quota drafts", () => {
  const html = read("admin.html");
  const admin = read("admin.js");
  assert.match(html, /<[^>]*id="publish-site"[^>]*\bdisabled\b/);
  assert.doesNotMatch(html, /id="provider-key"|type="password"/, "keys are set in Render, never typed into the page");
  assert.match(html, /GEMINI_API_KEY/);
  assert.match(html, /OPENROUTER_API_KEY/);
  assert.doesNotMatch(html, /SAMPLE ACCOUNTS|LOCAL DRAFT · NOT ENFORCED/);
  assert.doesNotMatch(admin, /DEMO_USERS|quota-preview/);
  const module = read("admin-ai.mjs");
  assert.doesNotMatch(module, /localStorage|sessionStorage/);
  assert.match(module, /\/api\/v1\/admin\/ai\/users/);
});

test("student AI studio talks only to the same-origin AI API and renders answers safely", async () => {
  const source = read("ai-studio.mjs");
  assert.doesNotMatch(source, /generativelanguage|openrouter\.ai\/api|localhost|AIza[0-9A-Za-z_-]{20}|sk-or-/i);
  assert.match(source, /\/api\/v1\/ai\/messages/);
  const { renderMarkdown, safeHref } = await import(resolve(root, "ai-markdown.mjs"));
  const html = renderMarkdown("**b** <script>alert(1)</script> [x](javascript:alert(1)) [ok](https://example.org/a)\n\n| a |\n|---|\n| <img src=x onerror=alert(1)> |");
  assert.doesNotMatch(html, /<script|<img|javascript:/i);
  assert.match(html, /<a href="https:\/\/example\.org\/a" target="_blank" rel="noopener noreferrer">ok<\/a>/);
  assert.match(html, /<table>/);
  assert.equal(safeHref("data:text/html,x"), null);
});

test("browser API helper enforces same-origin calls and does not embed a backend localhost URL", () => {
  const source = read("firebase/auth-client.mjs");
  assert.match(source, /url\.origin !== window\.location\.origin/);
  assert.match(source, /url\.pathname\.startsWith\("\/api\/"\)/);
  assert.doesNotMatch(source, /https?:\/\/(?:localhost|127\.0\.0\.1)/);
});

test("the AI page lists every function and links back from the study space", () => {
  const html = read("ai.html");
  for (const task of ["mnemonics", "flashcards", "summary", "irac", "explain", "library", "compare", "statute", "essay", "mock", "marker"]) {
    assert.match(html, new RegExp(`data-ai-task="${task}"`), `${task} is listed`);
  }
  for (const mode of ["chat", "case", "notes", "questions"]) assert.match(html, new RegExp(`data-ai-mode="${mode}"`));
  for (const tab of ["Must-Try", "What's New", "Advanced"]) assert.ok(html.includes(tab), tab);
  assert.match(html, /data-toggle-read="true"/, "read-aloud toggle is offered");
  assert.match(html, /id="fc-exam-timer"/, "mock exams have a countdown");
  assert.match(html, /auth\.html\?next=ai\.html/);
  const study = read("study.html");
  assert.match(study, /href="\.\/ai\.html"/);
  assert.doesNotMatch(study, /ai-studio\.mjs/);
  // Every chat task offered in the page is accepted by the server.
  const studio = read("backend/src/services/ai/studio.js");
  for (const match of html.matchAll(/data-ai-task="([a-z]+)"/g)) assert.match(studio, new RegExp(`\\b${match[1]}: \\{ label:`), `${match[1]} exists on the server`);
});

test("every page shows the FIRE COUNSEL fire preloader first, and the student workspace is fully wired", () => {
  for (const page of pages) {
    const html = read(page);
    const head = html.slice(0, html.indexOf("</head>"));
    assert.match(head, /<link[^>]*href="\.\/preloader\.css"/, `${page} loads the preloader styles in <head>`);
    const body = html.slice(html.indexOf("<body"));
    assert.ok(body.indexOf('id="fc-preloader"') < 300, `${page}: the preloader is the first thing in <body>`);
    assert.match(body, /class="fc-pre-fire"/, `${page}: the burning flame is shown`);
    assert.match(body, /<script src="\.\/preloader\.js"><\/script>/, `${page}: the preloader script runs`);
  }
  const css = read("preloader.css");
  assert.match(css, /fcPreFailsafe[^}]*10s|10s forwards/, "the preloader hides itself even without JavaScript");
  assert.match(css, /prefers-reduced-motion/);
  const study = read("study.html");
  assert.match(study, /<link href="\.\/workspace\.css" rel="stylesheet"\/>/);
  for (const id of ["ws-tiles", "ws-ai-form", "ws-deadline-list", "ws-progress-body", "planner-page", "student-nav", "course-nav-count", "today-label", "active-course-select", "dashboard-subjects"]) {
    assert.match(study, new RegExp(`id="${id}"`), `${id} exists`);
  }
  for (const file of ["preloader.css", "preloader.js", "workspace.css", "workspace.mjs", "workspace-config.mjs", "admin-workspace.mjs"]) {
    assert.match(read("backend/src/website.js"), new RegExp(`"${file.replace(".", "\\.")}"`), `${file} is served by the API server`);
    assert.match(read("tools/dev_server.py"), new RegExp(`"${file.replace(".", "\\.")}"`), `${file} is served by the dev server`);
  }
});

test("workspace settings keep only safe links and fall back to the built-in design", async () => {
  const { mergeWorkspace, safeLink, menuHTML, tilesHTML, DEFAULT_WORKSPACE } = await import(resolve(root, "workspace-config.mjs"));
  assert.equal(safeLink("javascript:alert(1)"), "#dashboard");
  assert.equal(safeLink("//evil.example/x"), "#dashboard");
  assert.equal(safeLink("http://insecure.example"), "#dashboard");
  assert.equal(safeLink("https://nigerialii.org"), "https://nigerialii.org");
  assert.equal(safeLink("./ai.html?mode=case"), "./ai.html?mode=case");
  const defaults = mergeWorkspace(null);
  assert.equal(defaults.tiles.length, DEFAULT_WORKSPACE.tiles.length);
  const custom = mergeWorkspace({ welcome: { title: "Hello <b>class</b>" }, tiles: [{ icon: "nope", title: "<img src=x onerror=alert(1)>", link: "javascript:x" }], menu: [{ label: "Library", link: "#library" }, { label: "PDFs", link: "#library" }, { label: "AI", link: "./ai.html" }], deadlines: { items: [{ date: "2026-12-01", title: "CBT" }, { date: "soon", title: "bad" }] }, notices: ["Hi", 5, ""] });
  assert.equal(custom.welcome.title, "Hello <b>class</b>", "text is kept as text (it is escaped when shown)");
  assert.equal(custom.welcome.accent, DEFAULT_WORKSPACE.welcome.accent, "missing fields use the defaults");
  const tiles = tilesHTML(custom);
  assert.doesNotMatch(tiles, /<img|javascript:/);
  assert.match(tiles, /data-go="dashboard"/);
  const menu = menuHTML(custom, "6");
  assert.equal((menu.match(/data-page="library"/g) || []).length, 1, "only the first link to a section is the highlighted one");
  assert.match(menu, /data-go="library"/);
  assert.match(menu, /id="course-nav-count" hidden>6</, "the course counter always exists");
  assert.deepEqual(custom.deadlines.items.map((item) => item.title), ["CBT"]);
  assert.deepEqual(custom.notices, ["Hi"]);
});
