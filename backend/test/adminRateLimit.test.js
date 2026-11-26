import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import express from "express";
import { createAdminAbuseGate, createAdminRequestGate } from "../src/middleware/adminRateLimit.js";
import { requireAdmin } from "../src/middleware/requireAdmin.js";

async function serve(t, { abuseLimit = 300, readLimit = 2, writeLimit = 1 } = {}) {
  const app = express(); app.use(express.json());
  app.use(createAdminAbuseGate({ limit: abuseLimit }));
  app.use("/api/v1/admin", (req, res, next) => {
    // Synthetic token-verifier boundary only. In production the UID/claim is
    // set by the existing revoked-token/Google Firebase verifier, not a header.
    const token = req.get("authorization");
    if (!["one", "two", "student"].includes(token)) return res.status(401).json({ error: "Sign in" });
    req.user = { uid: token, admin: token !== "student" }; next();
  }, requireAdmin, createAdminRequestGate({ readLimit, writeLimit }));
  let writes = 0;
  app.all(["/api/v1/admin/documents", "/api/v1/admin/workstation/jobs/id"], (req, res) => {
    if (req.method === "POST") writes++;
    res.json({ data: { ok: true } });
  });
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { get writes() { return writes; }, async call(path = "/documents", method = "GET", token = "one", body) {
    return fetch(`http://127.0.0.1:${server.address().port}/api/v1/admin${path}`, { method,
      headers: { ...(token ? { Authorization: token } : {}), "Content-Type": "application/json", "X-Forwarded-For": "192.0.2.123" },
      ...(body ? { body: JSON.stringify(body) } : {}) });
  } };
}

test("status polling cannot exhaust admin writes or another account behind the same IP", async t => {
  const api = await serve(t, { abuseLimit: 1 });
  assert.equal((await api.call()).status, 200);
  assert.equal((await api.call("/workstation/jobs/id")).status, 200, "shared read allowance across routers");
  const throttled = await api.call();
  assert.equal(throttled.status, 429);
  const error = await throttled.json();
  assert.equal(error.code, "ADMIN_READ_RATE_LIMIT");
  assert.ok(Number(throttled.headers.get("Retry-After")) > 0);
  assert.equal(throttled.headers.get("Cache-Control"), "no-store");
  assert.equal((await api.call("/documents", "POST", "one", { uid: "forged" })).status, 200, "polling cannot spend mutation allowance");
  assert.equal((await api.call("/documents", "POST", "one", { uid: "two" })).status, 429, "body UID cannot change the verified-account bucket");
  assert.equal((await api.call("/documents", "GET", "two")).status, 200, "other account unaffected by same-IP success/read throttle");
  assert.equal((await api.call("/documents", "POST", "two")).status, 200);
  assert.equal(api.writes, 2);
});

test("anonymous/forged/student requests remain denied and failed-auth IP protection cannot be bypassed", async t => {
  const api = await serve(t, { abuseLimit: 2 });
  assert.equal((await api.call("/documents", "POST", null, { uid: "one", admin: true })).status, 401);
  assert.equal((await api.call("/documents", "POST", "student", { uid: "one", admin: true })).status, 403);
  const blocked = await api.call("/documents", "POST", "forged-token", { uid: "one", admin: true });
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).code, "ADMIN_AUTH_RATE_LIMIT");
  assert.ok(Number(blocked.headers.get("Retry-After")) > 0);
  assert.equal(api.writes, 0);
});

test("UID gate fails closed if accidentally mounted without verified identity", async t => {
  const app = express(); app.use(createAdminRequestGate());
  app.get("/", (_req, res) => res.json({ data: "must not run" }));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/?uid=one&admin=true`);
  assert.equal(response.status, 401);
});


test("HEAD shares the GET bucket and DELETE shares the mutation bucket", async t => {
  const api = await serve(t, { readLimit: 1, writeLimit: 1 });
  assert.equal((await api.call()).status, 200);
  assert.equal((await api.call("/documents", "HEAD")).status, 429);
  assert.equal((await api.call("/documents", "POST")).status, 200);
  assert.equal((await api.call("/documents", "DELETE")).status, 429);
});
