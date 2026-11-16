import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../../sw.js", import.meta.url), "utf8");
const origin = "https://fire-counsel.example";
function worker({ network = async () => ({ status: 200, type: "basic", clone() { return this; } }) } = {}) {
  const events = {};
  const stored = new Map();
  const removed = [];
  const writes = [];
  let shell;
  const context = {
    URL, Set,
    self: { location: { origin, href: `${origin}/sw.js` },
      addEventListener(name, fn) { events[name] = fn; },
      skipWaiting() {}, clients: { claim() {} } },
    caches: {
      async open() { return {
        async addAll(paths) { shell = paths; },
        async put(key, value) { writes.push(key); stored.set(key, value); }
      }; },
      async keys() { return ["another-app-cache", "fire-counsel-shell-v1", vm.runInContext("CACHE_NAME", sandbox)]; },
      async delete(name) { removed.push(name); },
      async match(key) { return stored.get(key); }
    },
    fetch: network
  };
  const sandbox = vm.createContext(context);
  vm.runInContext(source, sandbox);
  function get(path, options = {}) {
    let response;
    const request = { url: new URL(path, origin).href, method: "GET", mode: "cors", cache: "default", headers: new Headers(), ...options };
    events.fetch({ request, respondWith(value) { response = value; } });
    return response;
  }
  async function lifecycle(name) {
    let work;
    events[name]({ waitUntil(value) { work = value; } });
    await work;
  }
  return { get, lifecycle, stored, removed, writes, get shell() { return shell; } };
}

test("the complete offline shell exists and includes the mounted student integration assets", async () => {
  const sw = worker();
  await sw.lifecycle("install");
  for (const file of sw.shell) assert.ok(existsSync(resolve(import.meta.dirname, "../..", file)), `${file} exists`);
  for (const module of ["./study-materials.mjs", "./research-search.mjs", "./student-profile.mjs", "./installation.mjs", "./request-scope.mjs", "./integrations.css", "./ai-studio.css", "./ai-studio.mjs", "./ai-markdown.mjs", "./presence.mjs"]) {
    assert.ok(sw.shell.includes(module));
  }
  assert.ok(!sw.shell.some(path => path.includes("config.local") || path.includes("admin.html")));
});

test("activation deletes only older FIRE COUNSEL shell caches", async () => {
  const sw = worker();
  await sw.lifecycle("activate");
  assert.deepEqual(sw.removed, ["fire-counsel-shell-v1"]);
});

test("API, authorization, Firebase config, admin and external requests bypass the cache", () => {
  const sw = worker();
  for (const path of ["/api", "/api/health", "/api/v1/me", "/admin.html", "/firebase/firebase-config.local.mjs", "/backend/.env", "https://other.example/site.js"]) {
    assert.equal(sw.get(path), undefined, path);
  }
  assert.equal(sw.get("/study.html", { headers: new Headers({ authorization: "Bearer synthetic-token" }) }), undefined);
  assert.equal(sw.get("/study.html", { method: "POST" }), undefined);
  assert.equal(sw.get("/study.html", { cache: "no-store" }), undefined);
});

test("offline study navigation returns the study page, not the homepage", async () => {
  const sw = worker({ network: async () => { throw new Error("offline"); } });
  sw.stored.set("/study.html", "study-page");
  sw.stored.set("/index.html", "home-page");
  assert.equal(await sw.get("/study.html?from=shortcut", { mode: "navigate" }), "study-page");
});

test("missing offline scripts fail instead of receiving HTML", async () => {
  const sw = worker({ network: async () => { throw new Error("offline"); } });
  sw.stored.set("/index.html", "home-page");
  await assert.rejects(sw.get("/app.js"), /offline/);
});

test("online navigation refreshes cached HTML and normalizes query-string cache keys", async () => {
  const sw = worker();
  sw.stored.set("/study.html", "old-page");
  const response = await sw.get("/study.html?shortcut=1", { mode: "navigate" });
  assert.equal(response.status, 200);
  assert.deepEqual(sw.writes, ["/study.html"]);
});

test("static shell assets use cache first and errors are not stored", async () => {
  const sw = worker({ network: async () => ({ status: 404 }) });
  sw.stored.set("/app.js", "cached-script");
  assert.equal(await sw.get("/app.js"), "cached-script");
  assert.equal((await sw.get("/styles.css")).status, 404);
  assert.equal(sw.writes.length, 0);
});
