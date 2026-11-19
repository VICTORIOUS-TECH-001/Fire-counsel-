import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import express from "express";
import { createAdminSiteRouter } from "../src/routes/siteContent.js";
import { createFirebaseTokenVerifier } from "../src/middleware/verifyFirebaseToken.js";
import { DEFAULT_WORKSPACE } from "../../workspace-config.mjs";

const SITE = JSON.parse(readFileSync(new URL("../../data/site-content.json", import.meta.url), "utf8"));
const LIMITS = { eyebrow: 120, title: 120, accent: 120, body: 600, imageAlt: 200, imageCredit: 200, primaryLabel: 60, secondaryLabel: 60 };
const uid = "verified-admin-uid";
const claims = (provider, admin = true) => ({ uid, email: "synthetic@example.invalid", email_verified: true, admin, firebase: { sign_in_provider: provider } });

async function serve(t, { firestoreError = null, projectId = "fire-counsel" } = {}) {
  const writes = [], authCalls = [], docPaths = [];
  const timestamp = Object.freeze({ serverTimestamp: true });
  let databaseCalls = 0, neonCalls = 0, configuredCalls = 0;
  const verifier = createFirebaseTokenVerifier(() => ({
    async verifyIdToken(token, revoked) {
      authCalls.push([token, revoked]);
      const tokens = { admin: claims("google.com"), student: claims("google.com", false), password: claims("password"), custom: claims("custom"), anonymous: claims("anonymous") };
      if (!tokens[token]) throw Object.assign(new Error("Synthetic revoked token"), { code: "auth/id-token-revoked" });
      return tokens[token];
    }
  }));
  const router = createAdminSiteRouter({
    verifyToken: verifier,
    configured: () => { configuredCalls++; return false; },
    poolProvider: () => { neonCalls++; throw new Error("This publish must not access Neon"); },
    firestoreTimestamp: () => timestamp,
    firestoreProvider: () => {
      databaseCalls++;
      return { projectId, doc(path) {
        docPaths.push(path);
        return { async set(content) {
          if (firestoreError) throw firestoreError;
          writes.push(content);
        } };
      } };
    }
  });
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use("/api/v1/admin/site", router);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/v1/admin/site/firebase`;
  const request = (body, token = "admin") => fetch(url, { method: "POST", headers: {
    "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {})
  }, body: JSON.stringify(body) });
  return { writes, authCalls, timestamp, docPaths, request,
    post: (content, token = "admin") => request({ content, projectId: "fire-counsel" }, token),
    counts: () => ({ databaseCalls, neonCalls, configuredCalls }) };
}

function maximumContent() {
  const content = structuredClone(SITE);
  content.workspace = structuredClone(DEFAULT_WORKSPACE);
  content.navigation = Array.from({ length: 8 }, (_, i) => ({ label: `Page ${i + 1}`, href: `#page-${i + 1}` }));
  const slide = structuredClone(content.hero.slides[0]);
  for (const [key, limit] of Object.entries(LIMITS)) slide[key] = "😀".repeat(limit / 2);
  content.hero.slides = Array.from({ length: 12 }, () => ({ ...slide }));
  return content;
}

test("Firebase primary publish verifies Google/admin tokens before any storage or Neon access", async t => {
  const api = await serve(t);
  for (const [token, status, code] of [[null, 401], ["student", 403], ["password", 403, "GOOGLE_SIGN_IN_REQUIRED"], ["custom", 403, "GOOGLE_SIGN_IN_REQUIRED"], ["anonymous", 403, "GOOGLE_SIGN_IN_REQUIRED"], ["revoked", 401]]) {
    const response = await api.request({ content: SITE, projectId: "fire-counsel", admin: true, uid }, token);
    assert.equal(response.status, status, String(token));
    if (code) assert.equal((await response.json()).code, code);
  }
  assert.deepEqual(api.counts(), { databaseCalls: 0, neonCalls: 0, configuredCalls: 0 });
  assert.ok(api.authCalls.every(([, revoked]) => revoked === true));
});

test("Firebase publishes the full 12-slide/8-link workspace and owns metadata without Neon", async t => {
  const api = await serve(t);
  const storage = maximumContent();
  const prefix = "https://firebasestorage.googleapis.com/v0/b/fire-counsel.firebasestorage.app/o/site%2Fslides%2Fimage.jpg?alt=media&token=";
  const image = prefix + "a".repeat(2048 - prefix.length);
  storage.brand.markImage = image;
  storage.hero.slides.forEach(slide => { slide.image = image; });
  for (const content of [structuredClone(SITE), maximumContent(), storage]) {
    const response = await api.post(content);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: { published: true, channel: "firestore" } });
    const stored = api.writes.at(-1);
    const { updatedAt, updatedBy, ...publicContent } = stored;
    assert.deepEqual(publicContent, content);
    assert.equal(updatedBy, uid);
    assert.equal(updatedAt, api.timestamp);
    assert.equal(content.updatedAt, undefined, "input is not mutated");
  }
  assert.deepEqual(api.docPaths, ["siteContent/public", "siteContent/public", "siteContent/public"]);
  assert.deepEqual(api.counts(), { databaseCalls: 3, neonCalls: 0, configuredCalls: 0 });
  assert.ok(api.authCalls.every(([, revoked]) => revoked === true));
});

test("server-side Firebase validation independently enforces every required field and whitelist", async t => {
  const api = await serve(t);
  const rejected = async content => {
    const response = await api.post(content);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "VALIDATION_ERROR");
  };
  for (const parts of [[], ["brand"], ["hero", "slides", 0], ["navigation", 0]]) {
    const section = parts.reduce((value, key) => value[key], SITE);
    for (const key of Object.keys(section)) {
      const content = structuredClone(SITE);
      const target = parts.reduce((value, part) => value[part], content);
      delete target[key];
      await rejected(content);
      target.unexpected = true;
      await rejected(content);
    }
    const extra = structuredClone(SITE);
    parts.reduce((value, key) => value[key], extra).unexpected = true;
    await rejected(extra);
  }
  await rejected({ ...SITE, hero: {} });
  await rejected({ ...SITE, hero: { ...SITE.hero, extra: true } });
  for (const autoplayMs of [null, "6500", false, 3999, 15001]) await rejected({ ...SITE, hero: { ...SITE.hero, autoplayMs } });
  for (const workspace of [null, [], "not a map", { notices: Array(41).fill("x") }, { welcome: { title: "x".repeat(2001) } }]) await rejected({ ...SITE, workspace });
  for (const field of ["updatedAt", "updatedBy"]) await rejected({ ...SITE, [field]: "forged" });
  const tooManySlides = maximumContent();
  tooManySlides.hero.slides.push({ ...tooManySlides.hero.slides[0] });
  await rejected(tooManySlides);
  const tooManyLinks = maximumContent();
  tooManyLinks.navigation.push({ label: "Extra", href: "#extra" });
  await rejected(tooManyLinks);
  for (const [key, value] of [["image", "https://evil.example/photo.png"], ["primaryHref", "javascript:alert(1)"], ["secondaryHref", "data:text/html,x"]]) {
    const content = structuredClone(SITE);
    content.hero.slides[0][key] = value;
    await rejected(content);
  }
  assert.deepEqual(api.counts(), { databaseCalls: 0, neonCalls: 0, configuredCalls: 0 });
});

test("server text validation keeps strict types, exact UTF-16 bounds and rejects control characters", async t => {
  const api = await serve(t);
  for (const [key, limit] of Object.entries(LIMITS)) {
    for (const invalid of [null, false, 1, [], {}, "x".repeat(limit + 1), "bad\ntext", "bad\0text"]) {
      const content = structuredClone(SITE);
      content.hero.slides[0][key] = invalid;
      assert.equal((await api.post(content)).status, 400, `${key}: ${JSON.stringify(invalid).slice(0, 40)}`);
    }
    const atBound = structuredClone(SITE);
    atBound.hero.slides[0][key] = "😀".repeat(limit / 2);
    assert.equal((await api.post(atBound)).status, 200, `${key}: emoji at bound`);
    atBound.hero.slides[0][key] += "😀";
    assert.equal((await api.post(atBound)).status, 400, `${key}: oversized emoji`);
    atBound.hero.slides[0][key] = "e\u0301".repeat(limit / 2);
    assert.equal((await api.post(atBound)).status, 200, `${key}: combining characters at bound`);
    atBound.hero.slides[0][key] += "e\u0301";
    assert.equal((await api.post(atBound)).status, 400, `${key}: oversized combining characters`);
  }
  const emptyTitle = structuredClone(SITE);
  emptyTitle.hero.slides[0].title = " ";
  assert.equal((await api.post(emptyTitle)).status, 400);
  for (const label of [null, false, 1, [], {}, "", "x".repeat(61), "😀".repeat(31)]) {
    const content = structuredClone(SITE);
    content.navigation[0].label = label;
    assert.equal((await api.post(content)).status, 400);
  }
  const label = structuredClone(SITE);
  label.navigation[0].label = "😀".repeat(30);
  assert.equal((await api.post(label)).status, 200);
  for (const key of ["image", "primaryHref", "secondaryHref"]) {
    for (const invalid of [null, false, 1, [], {}]) {
      const content = structuredClone(SITE);
      content.hero.slides[0][key] = invalid;
      assert.equal((await api.post(content)).status, 400);
    }
  }
  assert.equal(api.counts().neonCalls, 0);
});

test("Firebase publishing rejects forged request identity and a mismatched project before writing", async t => {
  const api = await serve(t, { projectId: "different-project" });
  const mismatch = await api.post(SITE);
  assert.equal(mismatch.status, 409);
  assert.equal((await mismatch.json()).code, "FIREBASE_PROJECT_MISMATCH");
  assert.deepEqual(api.docPaths, []);
  for (const body of [{ content: SITE }, { content: SITE, projectId: "fire-counsel", updatedBy: "attacker" }, { content: SITE, projectId: "fire-counsel", path: "accounts/other" }]) {
    const response = await api.request(body);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "VALIDATION_ERROR");
  }
  assert.deepEqual(api.writes, []);
});

test("Firebase content has a byte cap in addition to the shared character/depth limits", async t => {
  const api = await serve(t);
  const content = structuredClone(SITE);
  content.workspace = { menu: Array(15).fill("€".repeat(2000)), notices: Array(40).fill("€".repeat(2000)), tiles: Array(40).fill("€".repeat(2000)) };
  assert.ok(JSON.stringify(content).length < 200000);
  assert.ok(Buffer.byteLength(JSON.stringify(content)) > 512 * 1024);
  const response = await api.post(content);
  assert.equal(response.status, 413);
  assert.equal((await response.json()).code, "CONTENT_TOO_LARGE");
  assert.deepEqual(api.writes, []);
  assert.equal(api.counts().databaseCalls, 0);
});

test("Firestore write failures are actionable, secret-free and never fall back to Neon", async t => {
  for (const [code, expected] of [[7, "FIRESTORE_ACCESS_DENIED"], [5, "FIRESTORE_ACCESS_DENIED"], [16, "FIREBASE_ADMIN_NOT_READY"], ["firebase-admin/missing_key", "FIREBASE_ADMIN_NOT_READY"], [14, "FIREBASE_PUBLISH_UNCONFIRMED"]]) {
    const api = await serve(t, { firestoreError: Object.assign(new Error("synthetic-private-credential-details"), { code, details: "synthetic-private-details" }) });
    const response = await api.post(SITE);
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.code, expected);
    assert.doesNotMatch(JSON.stringify(body), /synthetic-private/);
    assert.equal(api.counts().neonCalls, 0);
    assert.deepEqual(api.writes, []);
  }
});
