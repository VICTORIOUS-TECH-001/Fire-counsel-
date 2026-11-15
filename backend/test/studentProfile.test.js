import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import { PGlite } from "@electric-sql/pglite";
import { createStudentProfileRouter } from "../src/routes/studentProfile.js";
import { createStudentInstallationGate } from "../src/middleware/requireStudentInstallation.js";
import { createStudentMaterialsRouter } from "../src/routes/studentMaterials.js";
import { createResearchSearchRouter } from "../src/routes/researchSearch.js";
import { trustedProxyNetworks } from "../src/config/trustedProxy.js";
import { INSTALLATION_POLICY, safeGooglePhoto } from "../src/services/studentAccounts.js";

const A = "a".repeat(43);
const B = "b".repeat(43);
const policy = { installation_policy: INSTALLATION_POLICY };
let db;
let pool;
let identities;
let queries;

before(async () => {
  // Real PostgreSQL semantics in memory, not Neon or a network connection. Only
  // the known identity columns are modeled; live schema compatibility is a gate.
  db = new PGlite();
  await db.exec(`CREATE TABLE app_users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), firebase_uid text UNIQUE NOT NULL,
    email text UNIQUE NOT NULL, full_name text NOT NULL,
    account_status text NOT NULL DEFAULT 'active', updated_at timestamptz DEFAULT NOW()
  );`);
  await db.exec(readFileSync(new URL("../migrations/001_student_profiles.sql", import.meta.url), "utf8"));
  // PGlite uses one connection. This mutex models exclusive pg pool checkout
  // so simultaneous HTTP requests cannot accidentally share a transaction.
  let tail = Promise.resolve();
  async function acquire() {
    let release;
    const previous = tail;
    tail = new Promise(resolve => { release = resolve; });
    await previous;
    return release;
  }
  async function query(text, values = []) {
    queries.push({ text, values });
    return db.query(text, values);
  }
  pool = {
    async query(text, values) { const release = await acquire(); try { return await query(text, values); } finally { release(); } },
    async connect() { const release = await acquire(); return { query, release }; }
  };
});
after(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec("TRUNCATE app_users CASCADE");
  queries = [];
  identities = {
    "user-a": { uid: "user-a", email: "a@example.invalid", name: "Google Student A", emailVerified: true, photoUrl: "https://lh3.googleusercontent.com/synthetic-photo" },
    "user-b": { uid: "user-b", email: "b@example.invalid", name: "Google Student B", emailVerified: true }
  };
});

async function serve(t, { enabled = true, configured = true, authTime, trusted = false, identityProvider, poolOverride } = {}) {
  const app = express();
  app.set("trust proxy", trustedProxyNetworks(trusted ? "127.0.0.1/32" : ""));
  app.use(express.json({ limit: "2mb" }));
  const options = {
    poolProvider: () => poolOverride || pool, enabled: () => enabled, configured: () => configured,
    verifyToken(req, res, next) {
      const uid = req.get("Authorization")?.replace("Bearer ", "");
      if (!identities[uid]) return res.status(401).json({ error: "Synthetic authentication required." });
      req.user = { uid, email: "stale-token@example.invalid", name: "Untrusted old name", emailVerified: identities[uid].emailVerified, authTime: authTime ?? Math.floor(Date.now() / 1000), admin: false };
      next();
    },
    identityProvider: identityProvider || (async uid => identities[uid])
  };
  app.use("/profile", createStudentProfileRouter(options));
  app.use("/materials", createStudentMaterialsRouter(options));
  app.use("/research", createResearchSearchRouter(options));
  app.get("/gate", options.verifyToken, createStudentInstallationGate(options), (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  return async (path = "/profile", { method = "GET", user = "user-a", installation = A, body, headers = {} } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: { Authorization: `Bearer ${user}`, ...(installation ? { "X-Fire-Counsel-Installation": installation } : {}), ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
}

test("Google-backed profile creation uses current Firebase identity, persists only a hash and touches no course/role/plan tables", async t => {
  const request = await serve(t);
  const response = await request("/profile", { method: "POST", body: policy });
  assert.equal(response.status, 201);
  assert.equal(response.body.data.full_name, "Google Student A");
  assert.equal(response.body.data.email, "a@example.invalid");
  assert.equal(response.body.data.email_verified, true);
  assert.equal(response.body.data.photo_url, identities["user-a"].photoUrl);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.body.data.installation.observed_ip, "127.0.0.1");
  const bindings = await db.query("SELECT * FROM student_account_installations");
  assert.match(bindings.rows[0].installation_hash, /^[a-f0-9]{64}$/);
  assert.notEqual(bindings.rows[0].installation_hash, A);
  assert.doesNotMatch(JSON.stringify(response.body), /installation_hash|password|firebase_uid/);
  assert.ok(queries.every(query => !/INSERT INTO (?:course|institution|role|user_role|permission|payment|entitlement)/i.test(query.text)));
  assert.deepEqual((await db.query("SELECT email, account_status FROM app_users")).rows, [{ email: "a@example.invalid", account_status: "active" }]);
});

test("repeated Google sign-in reuses the same profile and does not overwrite an edited name", async t => {
  const request = await serve(t);
  const first = await request("/profile", { method: "POST", body: policy });
  assert.equal((await request("/profile", { method: "PATCH", body: { full_name: "My chosen name" } })).status, 200);
  const next = await request("/profile", { method: "POST", body: policy });
  assert.equal(next.status, 200);
  assert.equal(next.body.data.id, first.body.data.id);
  assert.equal(next.body.data.full_name, "My chosen name");
  assert.equal(Number((await db.query("SELECT COUNT(*) FROM app_users")).rows[0].count), 1);
});

test("the same installation stays registered when its observed IP changes", async t => {
  const request = await serve(t, { trusted: true });
  const first = await request("/profile", { method: "POST", body: policy, headers: { "X-Forwarded-For": "192.0.2.10" } });
  const next = await request("/profile", { method: "POST", body: policy, headers: { "X-Forwarded-For": "198.51.100.20" } });
  assert.equal(first.status, 201);
  assert.equal(next.status, 200);
  assert.equal(next.body.data.installation.observed_ip, "198.51.100.20");
  assert.equal(next.body.data.installation.ip_source, "trusted_proxy");
  assert.equal(next.body.data.id, first.body.data.id);
});

test("a different installation cannot read, edit, sync, or rebind an existing profile even with the same IP", async t => {
  const request = await serve(t);
  await request("/profile", { method: "POST", body: policy });
  for (const [method, body] of [["GET", undefined], ["POST", policy], ["PATCH", { full_name: "Must not change" }]]) {
    const response = await request("/profile", { method, body, installation: B });
    assert.equal(response.status, 403);
    assert.equal(response.body.code, "INSTALLATION_MISMATCH");
    assert.equal(response.body.data, undefined);
  }
  assert.equal((await request()).body.data.full_name, "Google Student A");
});

test("another Firebase UID cannot access or transfer a profile by copying the installation token", async t => {
  const request = await serve(t);
  await request("/profile", { method: "POST", body: policy });
  assert.equal((await request("/profile", { user: "user-b" })).status, 404);
  assert.equal((await request("/profile", { user: "user-b", method: "PATCH", body: { full_name: "Steal profile" } })).status, 404);
  const separate = await request("/profile", { user: "user-b", installation: B, method: "POST", body: policy });
  assert.equal(separate.status, 201);
  assert.equal(separate.body.data.email, "b@example.invalid");
});

test("concurrent first registrations from different installations produce only one binding", async t => {
  const request = await serve(t);
  const responses = await Promise.all([
    request("/profile", { method: "POST", body: policy, installation: A }),
    request("/profile", { method: "POST", body: policy, installation: B })
  ]);
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 403]);
  assert.equal(Number((await db.query("SELECT COUNT(*) FROM student_account_installations")).rows[0].count), 1);
});

test("IP spoofing through arbitrary forwarded headers is ignored unless the actual proxy is explicitly trusted", async t => {
  const request = await serve(t);
  const response = await request("/profile", { method: "POST", body: policy, headers: { "X-Forwarded-For": "203.0.113.99", "X-Real-IP": "203.0.113.88" } });
  assert.equal(response.body.data.installation.observed_ip, "127.0.0.1");
  assert.equal(response.body.data.installation.ip_source, "connection_peer");
});

test("email changes are synced only from current Firebase Admin identity, not stale token email or JSON", async t => {
  const request = await serve(t);
  await request("/profile", { method: "POST", body: policy });
  assert.equal((await request("/profile", { method: "PATCH", body: { email: "forged@example.invalid" } })).status, 400);
  identities["user-a"].email = "verified-new@example.invalid";
  const response = await request("/profile", { method: "POST", body: policy });
  assert.equal(response.body.data.email, "verified-new@example.invalid");
  assert.equal((await db.query("SELECT email FROM app_users")).rows[0].email, "verified-new@example.invalid");
});

test("profile writes reject passwords, role/course/identity/status/IP fields and invalid names", async t => {
  const request = await serve(t);
  for (const body of [
    { ...policy, password: "do-not-store" }, { ...policy, admin: true }, { ...policy, role: "admin" },
    { ...policy, uid: "user-b" }, { ...policy, ip: "192.0.2.1" }, { ...policy, course_id: "arbitrary" },
    { ...policy, account_status: "active" }, { ...policy, full_name: " " },
    { ...policy, full_name: "x".repeat(121) }, { ...policy, full_name: "bad\nname" },
    [], { ...policy, full_name: {} }
  ]) assert.equal((await request("/profile", { method: "POST", body })).status, 400);
  assert.equal(Number((await db.query("SELECT COUNT(*) FROM app_users")).rows[0].count), 0);
});

test("installation and explicit policy acceptance are required before creating any profile", async t => {
  const request = await serve(t);
  assert.equal((await request("/profile", { method: "POST", body: policy, installation: null })).body.code, "INSTALLATION_REQUIRED");
  assert.equal((await request("/profile", { method: "POST", body: policy, installation: "short" })).status, 400);
  assert.equal((await request("/profile", { method: "POST", body: {} })).body.code, "INSTALLATION_POLICY_REQUIRED");
  assert.equal(Number((await db.query("SELECT COUNT(*) FROM app_users")).rows[0].count), 0);
});

test("a stale Firebase sign-in cannot claim an unbound profile and the attempted insert rolls back", async t => {
  const request = await serve(t, { authTime: Math.floor(Date.now() / 1000) - 600 });
  const response = await request("/profile", { method: "POST", body: policy });
  assert.equal(response.status, 401);
  assert.equal(response.body.code, "RECENT_SIGN_IN_REQUIRED");
  assert.equal(Number((await db.query("SELECT COUNT(*) FROM app_users")).rows[0].count), 0);
  assert.ok(queries.some(query => query.text === "ROLLBACK"));
});

test("suspended accounts cannot self-reactivate by signing in, syncing or changing a name", async t => {
  const request = await serve(t);
  await request("/profile", { method: "POST", body: policy });
  await db.exec("UPDATE app_users SET account_status = 'suspended'");
  for (const [method, body] of [["GET", undefined], ["POST", policy], ["PATCH", { full_name: "Reactivate" }]]) {
    const response = await request("/profile", { method, body });
    assert.equal(response.status, 403);
    assert.equal(response.body.code, "STUDENT_ACCOUNT_DISABLED");
  }
});

test("email collisions roll back rather than merge profiles or change a binding", async t => {
  const request = await serve(t);
  await request("/profile", { method: "POST", body: policy });
  identities["user-b"].email = identities["user-a"].email;
  const response = await request("/profile", { user: "user-b", installation: B, method: "POST", body: policy });
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "PROFILE_IDENTITY_CONFLICT");
  assert.equal(Number((await db.query("SELECT COUNT(*) FROM app_users")).rows[0].count), 1);
});

test("student materials and source-search routes enforce the binding before running any content SQL", async t => {
  const request = await serve(t);
  await request("/profile", { method: "POST", body: policy });
  queries = [];
  for (const [path, method, body] of [["/materials", "GET", undefined], ["/materials/323e4567-e89b-42d3-a456-426614174000", "GET", undefined], ["/research/search", "POST", { query: "synthetic legal topic" }]]) {
    const response = await request(path, { method, body, installation: B });
    assert.equal(response.status, 403);
    assert.equal(response.body.code, "INSTALLATION_MISMATCH");
  }
  assert.ok(queries.every(query => !/FROM materials|FROM legal_cases|FROM statutes/.test(query.text)));
});

test("unverified email can own a basic profile but cannot access protected student content", async t => {
  const request = await serve(t);
  identities["user-a"].emailVerified = false;
  assert.equal((await request("/profile", { method: "POST", body: policy })).status, 201);
  const response = await request("/gate");
  assert.equal(response.status, 403);
  assert.equal(response.body.code, "EMAIL_VERIFICATION_REQUIRED");
  identities["user-a"].emailVerified = true;
  assert.equal((await request("/gate")).status, 200);
});

test("profile routes fail closed when not configured/enabled and reject anonymous callers", async t => {
  const unconfigured = await serve(t, { configured: false });
  assert.equal((await unconfigured()).body.code, "DATABASE_NOT_CONFIGURED");
  const disabled = await serve(t, { enabled: false });
  assert.equal((await disabled()).body.code, "STUDENT_PROFILES_DISABLED");
  assert.equal((await disabled("/profile", { user: "unknown" })).status, 401);
  assert.equal(queries.length, 0);
});

test("proxy configuration never accepts wildcard, global trust, names or hop counts", () => {
  for (const value of ["*", "true", "1", "loopback", "0.0.0.0/0", "::/0", "127.0.0.1/33", "::1/129", "example.com"]) assert.throws(() => trustedProxyNetworks(value));
  assert.deepEqual(trustedProxyNetworks("127.0.0.1/32, ::1/128"), ["127.0.0.1/32", "::1/128"]);
  assert.equal(trustedProxyNetworks(""), false);
});

test("an existing unbound profile is registered without replacing its own edited name", async t => {
  const inserted = await db.query("INSERT INTO app_users (firebase_uid, email, full_name) VALUES ($1, $2, $3) RETURNING id", ["user-a", "a@example.invalid", "Existing chosen name"]);
  const request = await serve(t);
  const response = await request("/profile", { method: "POST", body: policy });
  assert.equal(response.status, 201);
  assert.equal(response.body.data.id, inserted.rows[0].id);
  assert.equal(response.body.data.full_name, "Existing chosen name");
  assert.equal(Number((await db.query("SELECT COUNT(*) FROM app_users")).rows[0].count), 1);
});

test("a mismatched or missing Firebase identity cannot create or expose a profile", async t => {
  let identity = identities["user-a"];
  const request = await serve(t, { identityProvider: async () => identity });
  identity = { ...identity, uid: "user-b" };
  assert.equal((await request("/profile", { method: "POST", body: policy })).body.code, "EMAIL_ACCOUNT_REQUIRED");
  assert.equal(Number((await db.query("SELECT COUNT(*) FROM app_users")).rows[0].count), 0);
  identity = identities["user-a"];
  await request("/profile", { method: "POST", body: policy });
  identity = { ...identity, email: null };
  const response = await request();
  assert.equal(response.status, 403);
  assert.equal(response.body.data, undefined);
});

test("a missing profile migration fails closed and rolls back the attempted app_users insertion", async t => {
  const request = await serve(t);
  await db.exec("ALTER TABLE student_account_installations RENAME TO temporarily_unavailable_installations");
  try {
    const response = await request("/profile", { method: "POST", body: policy });
    assert.equal(response.status, 503);
    assert.equal(response.body.code, "PROFILE_SCHEMA_NOT_READY");
    assert.equal(Number((await db.query("SELECT COUNT(*) FROM app_users")).rows[0].count), 0);
  } finally {
    await db.exec("ALTER TABLE temporarily_unavailable_installations RENAME TO student_account_installations");
  }
});

test("a failed metadata write rolls back both the profile and first-installation binding", async t => {
  const failing = {
    query: (...args) => pool.query(...args),
    async connect() {
      const client = await pool.connect();
      return {
        release: () => client.release(),
        async query(text, values) {
          if (text.includes("SET last_seen_at")) throw Object.assign(new Error("synthetic metadata outage"), { code: "SYNTHETIC_FAILURE" });
          return client.query(text, values);
        }
      };
    }
  };
  const request = await serve(t, { poolOverride: failing });
  const response = await request("/profile", { method: "POST", body: policy });
  assert.equal(response.status, 503);
  assert.equal(response.body.code, "PROFILE_UNAVAILABLE");
  assert.equal(Number((await db.query("SELECT COUNT(*) FROM app_users")).rows[0].count), 0);
  assert.equal(Number((await db.query("SELECT COUNT(*) FROM student_account_installations")).rows[0].count), 0);
  assert.ok(queries.some(query => query.text === "ROLLBACK"));
});

test("only HTTPS Google-hosted avatar URLs are returned; arbitrary uploads and external image URLs are not accepted", () => {
  assert.equal(safeGooglePhoto("https://lh3.googleusercontent.com/synthetic-photo"), "https://lh3.googleusercontent.com/synthetic-photo");
  for (const value of [null, "javascript:alert(1)", "data:image/png;base64,anything", "http://lh3.googleusercontent.com/photo", "https://attacker.invalid/photo", "https://lh3.googleusercontent.com.attacker.invalid/photo", "https://user:password@lh3.googleusercontent.com/photo", "https://lh3.googleusercontent.com:444/photo"]) assert.equal(safeGooglePhoto(value), null);
});

test("new basic profiles do not depend on an admin-approval account default, and existing statuses are never reset", async t => {
  await db.exec("ALTER TABLE app_users ALTER COLUMN account_status SET DEFAULT 'pending'");
  try {
    const request = await serve(t);
    const response = await request("/profile", { method: "POST", body: policy });
    assert.equal(response.status, 201);
    assert.equal((await db.query("SELECT account_status FROM app_users")).rows[0].account_status, "active");
    await db.exec("UPDATE app_users SET account_status = 'suspended'");
    assert.equal((await request("/profile", { method: "POST", body: policy })).status, 403);
    assert.equal((await db.query("SELECT account_status FROM app_users")).rows[0].account_status, "suspended");
  } finally {
    await db.exec("ALTER TABLE app_users ALTER COLUMN account_status SET DEFAULT 'active'");
  }
});
