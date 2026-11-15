import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const read = path => readFileSync(resolve(root, path), "utf8");
const pages = ["index.html", "study.html", "admin.html", "auth.html"];
const integrations = [
  ["study.html", ["study-materials.mjs", "research-search.mjs", "student-profile.mjs"]],
  ["admin.html", ["admin-auth.mjs", "admin-database.mjs"]],
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

test("disabled provider/publishing controls cannot collect secrets or imply live quotas", () => {
  const html = read("admin.html");
  for (const id of ["provider-key", "save-provider-key", "publish-site"]) {
    assert.match(html, new RegExp(`<[^>]*id="${id}"[^>]*\\bdisabled\\b`));
  }
  assert.match(html, /LOCAL DRAFT · NOT ENFORCED/);
  assert.match(html, /SAMPLE ACCOUNTS · NOT REAL USERS/);
});

test("browser API helper enforces same-origin calls and does not embed a backend localhost URL", () => {
  const source = read("firebase/auth-client.mjs");
  assert.match(source, /url\.origin !== window\.location\.origin/);
  assert.match(source, /url\.pathname\.startsWith\("\/api\/"\)/);
  assert.doesNotMatch(source, /https?:\/\/(?:localhost|127\.0\.0\.1)/);
});
