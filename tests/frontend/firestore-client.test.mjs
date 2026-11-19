import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import * as schema from "../../firebase/content-schema.mjs";

const source = readFileSync(new URL("../../firebase/firestore-client.mjs", import.meta.url), "utf8");
const bundled = JSON.parse(readFileSync(new URL("../../data/site-content.json", import.meta.url), "utf8"));

// Exercise the actual client with in-memory SDK/API boundaries. No real
// Firebase credentials, CDN imports, emulator or network are involved.
function client({ admin = true, provider = "google.com", content = bundled } = {}) {
  const calls = [];
  const user = {
    uid: "synthetic-admin",
    async getIdTokenResult(refresh) {
      calls.push(["token", refresh]);
      return { claims: { admin, firebase: { sign_in_provider: provider } } };
    }
  };
  const auth = { currentUser: user };
  let stored = content == null ? null : { ...structuredClone(content), updatedAt: { seconds: 1000 }, updatedBy: user.uid };
  const timestamp = { syntheticServerTimestamp: true };
  const sdk = {
    getFirestore: () => ({}),
    doc: (_db, collection, id) => ({ collection, id }),
    serverTimestamp: () => timestamp,
    async getDoc() { return { exists: () => stored !== null, data: () => stored }; },
    async setDoc(reference, data) { calls.push(["write", reference, data]); stored = data; }
  };
  const api = {
    async apiRequest(path, options) {
      const body = JSON.parse(options.body);
      calls.push(["publish", path, options.method, body]);
      stored = { ...structuredClone(body.content), updatedAt: timestamp, updatedBy: user.uid };
      return { ok: true, status: 200, json: async () => ({ data: { published: true } }) };
    }
  };
  const context = {
    ...schema, firebaseApp: { options: { projectId: "fire-counsel" } }, firebaseSetupError: () => "",
    ...Object.fromEntries(Object.keys(sdk).map(key => [key, (...args) => sdk[key](...args)])),
    loadAuth: async () => ({ getAuth: () => auth }), loadApi: async () => api,
    setTimeout, clearTimeout
  };
  const executable = source
    .replace(/^import .* from "[^"]+";\s*$/gm, "")
    .replace(/await import\("https:\/\/www\.gstatic\.com\/firebasejs\/[^\"]+\/firebase-auth\.js"\)/g, "await loadAuth()")
    .replace('await import("./auth-client.mjs")', "await loadApi()")
    .replace(/\bexport /g, "");
  vm.runInNewContext(`${executable}\nglobalThis.exports = { loadPublicSiteContent, publishSiteContent, saveStudentPage, firestoreErrorText };`, context);
  return { ...context.exports, calls, sdk, api, user, auth, timestamp };
}
const plain = value => JSON.parse(JSON.stringify(value));
const sentWrite = api => api.calls.some(call => ["write", "publish"].includes(call[0]));

test("published Firestore content round-trips through the admin API without client-owned metadata or direct writes", async () => {
  const api = client();
  assert.deepEqual(plain(await api.loadPublicSiteContent()), bundled);
  await api.publishSiteContent(bundled);
  const publish = api.calls.find(call => call[0] === "publish");
  assert.deepEqual(plain(publish), ["publish", "/api/v1/admin/site/firebase", "POST", { content: bundled, projectId: "fire-counsel" }]);
  assert.ok(!api.calls.some(call => call[0] === "write"), "homepage browser writes must remain closed");
  assert.deepEqual(plain(await api.loadPublicSiteContent()), bundled);
});

test("public content loading still rejects unknown fields, broken content and missing documents", async () => {
  assert.equal(await client({ content: { ...bundled, secrets: {} } }).loadPublicSiteContent(), null);
  assert.equal(await client({ content: { ...bundled, hero: {} } }).loadPublicSiteContent(), null);
  assert.equal(await client({ content: null }).loadPublicSiteContent(), null);
  const unavailable = client();
  unavailable.sdk.getDoc = async () => { throw new Error("unavailable"); };
  assert.equal(await unavailable.loadPublicSiteContent(), null);
});

test("publishing forces a fresh admin claim and refuses a missing claim before sending anything", async () => {
  const api = client();
  await api.publishSiteContent(bundled);
  assert.deepEqual(api.calls[0], ["token", true]);
  const student = client({ admin: false });
  await assert.rejects(student.publishSiteContent(bundled), /admin.*claim|Make me admin/i);
  assert.equal(sentWrite(student), false);
});

test("publishing and student writes require this session's Google provider, even for an admin", async () => {
  for (const provider of ["password", "custom", "anonymous", ""]) {
    const api = client({ provider });
    await assert.rejects(api.publishSiteContent(bundled), /Sign in.*Google/i);
    await assert.rejects(api.saveStudentPage(api.user.uid, { displayName: "Student" }), /Sign in.*Google/i);
    assert.equal(sentWrite(api), false);
  }
});

test("sign-out or an account switch during a token refresh cannot publish", async () => {
  for (const switched of [null, { uid: "other" }]) {
    const api = client();
    api.user.getIdTokenResult = async () => {
      api.auth.currentUser = switched;
      return { claims: { admin: true, firebase: { sign_in_provider: "google.com" } } };
    };
    await assert.rejects(api.publishSiteContent(bundled), /session changed/i);
    assert.equal(sentWrite(api), false);
  }
});

test("a student-page read completing after sign-out cannot write a previous-session page", async () => {
  const api = client({ admin: false, content: null });
  api.sdk.getDoc = async () => {
    api.auth.currentUser = null;
    return { exists: () => false };
  };
  await assert.rejects(api.saveStudentPage(api.user.uid, { displayName: "Student" }), /session changed/i);
  assert.equal(sentWrite(api), false);
});

test("publish errors retain actionable server setup guidance and reject bad input before the API", async () => {
  const api = client();
  api.api.apiRequest = async () => ({ ok: false, status: 503, json: async () => ({ error: "Check service-account IAM in the matching Firebase project." }) });
  await assert.rejects(api.publishSiteContent(bundled), /service-account IAM.*matching Firebase project/);
  const invalid = { ...bundled, brand: { ...bundled.brand, extra: true } };
  await assert.rejects(api.publishSiteContent(invalid), /brand.extra/);
});

test("a missing or malformed publish acknowledgement is never reported as a confirmed live write", async () => {
  for (const json of [async () => null, async () => [], async () => "not an acknowledgement", async () => ({}), async () => ({ data: { published: false } }), async () => { throw new Error("invalid JSON"); }]) {
    const api = client();
    api.api.apiRequest = async () => ({ ok: true, status: 200, json });
    await assert.rejects(api.publishSiteContent(bundled), /did not confirm.*publishing/i);
    assert.equal(sentWrite(api), false);
  }
});

test("a changed session during a publish reply cannot be accepted into the new session", async () => {
  const api = client();
  api.api.apiRequest = async () => ({ ok: true, status: 200, json: async () => {
    api.auth.currentUser = { uid: "other" };
    return { data: { published: true } };
  } });
  await assert.rejects(api.publishSiteContent(bundled), /session changed/i);
});
