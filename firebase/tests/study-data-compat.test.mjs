import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const appSource = readFileSync(new URL("../../app.js", import.meta.url), "utf8");
const serviceWorkerSource = readFileSync(new URL("../../sw.js", import.meta.url), "utf8");

test("student study storage keeps its existing IndexedDB identity and stores", () => {
  assert.match(appSource, /const DB_NAME = "lexmaster-ai-stage1";/);
  assert.match(appSource, /const DB_VERSION = 1;/);
  assert.match(appSource, /createObjectStore\("documents"/);
  assert.match(appSource, /createObjectStore\("cards"/);
  assert.match(appSource, /createObjectStore\("settings"/);
  assert.match(appSource, /const SESSION_KEY = "lexmaster-sessions";/);
  assert.doesNotMatch(appSource, /indexedDB\.deleteDatabase|localStorage\.clear\s*\(/);
});

test("service-worker cleanup only removes old FIRE COUNSEL app-shell caches", () => {
  assert.match(serviceWorkerSource, /const CACHE_NAME = "fire-counsel-shell-v10";/);
  assert.match(serviceWorkerSource, /key\.startsWith\(APP_CACHE_PREFIX\) && key !== CACHE_NAME/);
  assert.doesNotMatch(serviceWorkerSource, /indexedDB\.deleteDatabase|localStorage\.clear\s*\(/);
});

test("service worker bypasses authenticated API responses to prevent cross-account cache leaks", () => {
  assert.match(serviceWorkerSource, /url\.pathname === "\/api" \|\| url\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(serviceWorkerSource, /request\.headers\.has\("authorization"\)/);
});
