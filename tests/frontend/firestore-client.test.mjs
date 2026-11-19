import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import * as schema from "../../firebase/content-schema.mjs";

const source = readFileSync(new URL("../../firebase/firestore-client.mjs", import.meta.url), "utf8");
const bundled = JSON.parse(readFileSync(new URL("../../data/site-content.json", import.meta.url), "utf8"));

// Exercise the actual client with an in-memory SDK. No Firebase credentials,
// CDN imports, emulator or network are involved in these client regressions.
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
  const context = {
    ...schema, firebaseApp: { options: { projectId: "fire-counsel" } }, firebaseSetupError: () => "",
    ...Object.fromEntries(Object.keys(sdk).map(key => [key, (...args) => sdk[key](...args)])),
    loadAuth: async () => ({ getAuth: () => auth }),
    setTimeout, clearTimeout
  };
  const executable = source
    .replace(/^import .* from "[^"]+";\s*$/gm, "")
    .replace(/await import\("https:\/\/www\.gstatic\.com\/firebasejs\/[^\"]+\/firebase-auth\.js"\)/g, "await loadAuth()")
    .replace(/\bexport /g, "");
  vm.runInNewContext(`${executable}\nglobalThis.exports = { loadPublicSiteContent, publishSiteContent, saveStudentPage, firestoreErrorText };`, context);
  return { ...context.exports, calls, sdk, user, auth, timestamp };
}
const plain = value => JSON.parse(JSON.stringify(value));

test("a published Firestore document round-trips without leaking write metadata into editor content", async () => {
  const api = client();
  assert.deepEqual(plain(await api.loadPublicSiteContent()), bundled);
  await api.publishSiteContent(bundled);
  const write = api.calls.find(call => call[0] === "write");
  assert.deepEqual(plain(write[1]), { collection: "siteContent", id: "public" });
  assert.equal(write[2].updatedAt, api.timestamp);
  assert.equal(write[2].updatedBy, api.user.uid);
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

test("publishing forces a fresh admin claim and refuses a missing claim before writing", async () => {
  const api = client();
  await api.publishSiteContent(bundled);
  assert.deepEqual(api.calls[0], ["token", true]);
  const student = client({ admin: false });
  await assert.rejects(student.publishSiteContent(bundled), /admin.*claim|Make me admin/i);
  assert.ok(!student.calls.some(call => call[0] === "write"));
});

test("direct writes require this session's Google provider, even for an admin", async () => {
  for (const provider of ["password", "custom", "anonymous", ""]) {
    const api = client({ provider });
    await assert.rejects(api.publishSiteContent(bundled), /Sign in.*Google/i);
    await assert.rejects(api.saveStudentPage(api.user.uid, { displayName: "Student" }), /Sign in.*Google/i);
    assert.ok(!api.calls.some(call => call[0] === "write"));
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
    assert.ok(!api.calls.some(call => call[0] === "write"));
  }
});

test("a student-page read completing after sign-out cannot write a previous-session page", async () => {
  const api = client({ admin: false, content: null });
  api.sdk.getDoc = async () => {
    api.auth.currentUser = null;
    return { exists: () => false };
  };
  await assert.rejects(api.saveStudentPage(api.user.uid, { displayName: "Student" }), /session changed/i);
  assert.ok(!api.calls.some(call => call[0] === "write"));
});

test("publish errors distinguish stale rules/project validation from a missing admin claim", async () => {
  const api = client();
  api.sdk.setDoc = async () => { throw Object.assign(new Error("denied"), { code: "permission-denied" }); };
  await assert.rejects(api.publishSiteContent(bundled), /rules.*project|project.*rules/i);
  const invalid = { ...bundled, brand: { ...bundled.brand, extra: true } };
  await assert.rejects(api.publishSiteContent(invalid), /brand.extra/);
});
