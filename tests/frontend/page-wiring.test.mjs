import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const read = path => readFileSync(resolve(root, path), "utf8");
const pages = ["index.html", "study.html", "admin.html", "auth.html"];
const integrations = [
  ["study.html", ["study-materials.mjs", "research-search.mjs", "student-profile.mjs", "ai-studio.mjs", "presence.mjs"]],
  ["admin.html", ["admin-auth.mjs", "admin-database.mjs", "admin-ai.mjs", "presence.mjs"]],
  ["auth.html", ["auth-page.mjs"]]
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
