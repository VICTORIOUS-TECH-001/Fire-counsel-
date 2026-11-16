import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../src/app.js";

async function serve(t, options = {}) {
  const server = createApp({ env: {}, ...options }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test("liveness is independent of Firebase and Neon configuration", async t => {
  const base = await serve(t, { databaseCheck: () => { throw new Error("must not be called"); } });
  const response = await fetch(`${base}/healthz`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "ok");
  assert.equal(response.headers.get("x-powered-by"), null);
});

test("readiness accurately reports unconfigured Neon and is never cacheable", async t => {
  const base = await serve(t);
  const response = await fetch(`${base}/api/health`);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).database, "not_configured");
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("readiness reports success only when a configured database check succeeds", async t => {
  const base = await serve(t, { env: { DATABASE_URL: "synthetic-not-used" }, databaseCheck: async () => true });
  const response = await fetch(`${base}/api/health`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).database, "connected");
});

for (const outcome of [false, new Error("synthetic database outage")]) {
  test(`readiness reports unavailable for ${outcome === false ? "a failed query" : "a connection error"}`, async t => {
    const base = await serve(t, { env: { DATABASE_URL: "synthetic-not-used" }, databaseCheck: async () => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    } });
    const response = await fetch(`${base}/api/health`);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).database, "unavailable");
  });
}

test("CORS uses exact approved origins, not wildcard or suffix matches", async t => {
  const base = await serve(t, { env: { CORS_ORIGINS: "https://study.example, https://admin.example" } });
  const good = await fetch(`${base}/api/health`, { headers: { Origin: "https://study.example" } });
  assert.equal(good.headers.get("access-control-allow-origin"), "https://study.example");
  for (const origin of ["https://study.example.attacker.invalid", "https://other.example", "null"]) {
    const response = await fetch(`${base}/api/health`, { headers: { Origin: origin } });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  }
});

test("every protected route rejects anonymous requests before database access", async t => {
  const base = await serve(t);
  for (const path of ["/api/v1/me", "/api/v1/admin/me", "/api/v1/admin/database/catalog", "/api/v1/admin/database/materials", "/api/v1/materials", "/api/v1/profile"]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 401, path);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  const response = await fetch(`${base}/api/v1/research/search`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"query":"synthetic"}' });
  assert.equal(response.status, 401);
});

test("malformed JSON returns 400 instead of a misleading internal server error", async t => {
  const base = await serve(t);
  const response = await fetch(`${base}/api/v1/research/search`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{invalid" });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "INVALID_JSON");
});

test("oversized JSON returns 413 and never reaches a protected route", async t => {
  const base = await serve(t);
  const response = await fetch(`${base}/api/v1/research/search`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: "x".repeat(2 * 1024 * 1024) }) });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).code, "BODY_TOO_LARGE");
});

test("unimplemented uploads, account changes and payment routes stay absent", async t => {
  const base = await serve(t);
  for (const path of ["/api/v1/uploads", "/api/v1/admin/accounts", "/api/v1/payments"]) {
    const response = await fetch(`${base}${path}`, { method: "POST" });
    assert.equal(response.status, 404, path);
  }
});

test("AI, presence and admin AI routes require a Firebase sign-in", async t => {
  const base = await serve(t);
  for (const [method, path] of [["POST", "/api/v1/ai/messages"], ["GET", "/api/v1/ai/me"], ["POST", "/api/v1/presence"], ["GET", "/api/v1/admin/ai/status"], ["POST", "/api/v1/admin/claim"]]) {
    const response = await fetch(`${base}${path}`, { method });
    assert.equal(response.status, 401, path);
  }
});

test("AI message uploads may exceed the normal 2 MiB body limit but stay capped", async t => {
  const base = await serve(t);
  const big = JSON.stringify({ text: "x".repeat(3 * 1024 * 1024) });
  const ai = await fetch(`${base}/api/v1/ai/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: big });
  assert.equal(ai.status, 401, "large AI body reaches authentication");
  const other = await fetch(`${base}/api/v1/profile`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: big });
  assert.equal(other.status, 413);
});

test("approved cross-origin student API calls may send the installation header", async t => {
  const base = await serve(t, { env: { CORS_ORIGINS: "https://study.example" } });
  const response = await fetch(`${base}/api/v1/profile`, { method: "OPTIONS", headers: {
    Origin: "https://study.example", "Access-Control-Request-Method": "PATCH",
    "Access-Control-Request-Headers": "authorization,content-type,x-fire-counsel-installation"
  } });
  assert.equal(response.status, 204);
  assert.match(response.headers.get("access-control-allow-headers"), /X-Fire-Counsel-Installation/);
});
