import assert from "node:assert/strict";
import test from "node:test";
import { browserInstallation, INSTALLATION_KEY, needsStudentInstallation } from "../../installation.mjs";

function storage(values = []) {
  const data = new Map(values);
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
}
const random = { getRandomValues(bytes) { assert.equal(bytes.length, 32); return bytes.fill(235); } };

test("installation creation persists a random 32-byte base64url marker under its own key", async () => {
  const saved = storage([["lexmaster-sessions", "7"]]);
  const id = await browserInstallation({ storage: saved, random });
  assert.match(id, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(saved.data.get(INSTALLATION_KEY), id);
  assert.equal(saved.data.get("lexmaster-sessions"), "7");
  assert.equal(saved.data.size, 2);
});

test("the same saved installation survives reloads and sign-out without being regenerated", async () => {
  const saved = storage([[INSTALLATION_KEY, "a".repeat(43)]]);
  const noRandom = { getRandomValues() { throw new Error("must not generate another installation"); } };
  assert.equal(await browserInstallation({ storage: saved, random: noRandom }), "a".repeat(43));
});

test("corrupted installation data fails closed without replacing it or clearing other storage", async () => {
  const saved = storage([[INSTALLATION_KEY, "damaged"], ["lexmaster-sessions", "7"]]);
  await assert.rejects(browserInstallation({ storage: saved, random }), /Persistent browser storage/);
  assert.equal(saved.data.get(INSTALLATION_KEY), "damaged");
  assert.equal(saved.data.get("lexmaster-sessions"), "7");
});

test("unavailable or unwritable storage never falls back to a temporary device marker", async () => {
  for (const saved of [
    { getItem() { throw new Error("blocked"); } },
    { getItem() { return null; }, setItem() { throw new Error("quota"); } },
    { getItem() { return null; }, setItem() {} }
  ]) await assert.rejects(browserInstallation({ storage: saved, random }), /Persistent browser storage/);
});

test("Web Locks serialize first-installation creation across concurrent tabs when supported", async () => {
  let tail = Promise.resolve();
  const calls = [];
  const locks = { request(name, callback) { calls.push(name); const result = tail.then(callback); tail = result.catch(() => {}); return result; } };
  const saved = storage();
  const values = await Promise.all(Array.from({ length: 8 }, () => browserInstallation({ storage: saved, random, locks })));
  assert.equal(new Set(values).size, 1);
  assert.deepEqual(calls, Array(8).fill(INSTALLATION_KEY));
});

test("only protected student profile/material/research API paths require installation metadata", () => {
  for (const path of ["/api/v1/profile", "/api/v1/profile/", "/api/v1/materials", "/api/v1/materials/one", "/api/v1/research/search"]) assert.equal(needsStudentInstallation(path), true, path);
  for (const path of ["/api/v1/me", "/api/v1/admin/me", "/api/health", "/api/v1/profiles", "/firebase/auth-client.mjs", "/study.html"]) assert.equal(needsStudentInstallation(path), false, path);
});
