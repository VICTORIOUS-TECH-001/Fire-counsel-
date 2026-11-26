import assert from "node:assert/strict";
import { test } from "node:test";
import { adminResponse, retryAfterMs, statusRetryDelay } from "../../admin-network.mjs";

const response = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

test("admin status errors distinguish API throttling/availability and preserve only safe JSON fields", async () => {
  const html = new Response("<html>ingress unavailable secret upstream text</html>", { status: 503, headers: { "Content-Type": "text/html" } });
  await assert.rejects(adminResponse(html), error => {
    assert.equal(error.status, 503);
    assert.match(error.message, /API service is temporarily unavailable/);
    assert.doesNotMatch(error.message, /html|secret upstream/);
    assert.equal(statusRetryDelay(error, 1), 2000);
    return true;
  });
  await assert.rejects(adminResponse(response(429, { code: "ADMIN_READ_RATE_LIMIT", error: "Status checks limited", retry_after_seconds: 30 }, { "Retry-After": "45" })), error => {
    assert.equal(error.code, "ADMIN_READ_RATE_LIMIT");
    assert.equal(error.retryAfterMs, 45000);
    assert.equal(statusRetryDelay(error, 1), 45000, "never check before server deadline");
    return true;
  });
  for (const body of [null, [], "gateway reply"]) await assert.rejects(adminResponse(response(429, body)), error => {
    assert.equal(error.status, 429); assert.match(error.message, /does not establish Gemini quota/); return true;
  });
  await assert.rejects(adminResponse(response(503, { code: "ADMIN_PROVIDER_AUTH", error: "Google rejected the admin credential" })), error => {
    assert.equal(error.message, "Google rejected the admin credential"); return true;
  });
});

test("Retry-After seconds and HTTP dates are respected without a shortened provider hold", () => {
  const now = Date.UTC(2026, 10, 18);
  assert.equal(retryAfterMs(response(429, {}, { "Retry-After": "12" }), {}, now), 12000);
  assert.equal(retryAfterMs(response(503, {}, { "Retry-After": new Date(now + 90000).toUTCString() }), {}, now), 90000);
  assert.equal(retryAfterMs(response(429, {}), { retry_after_seconds: 20 }, now), 20000);
  assert.equal(retryAfterMs(response(429, {}, { "Retry-After": "invalid" }), {}, now), 0);
  assert.equal(statusRetryDelay({ status: 429, retryAfterMs: 3600000 }, 1), null, "long holds require manual follow-up");
});

test("status recovery is bounded, never retries auth/missing jobs, and response parsing never fetches", async () => {
  const fetch = globalThis.fetch;
  globalThis.fetch = () => assert.fail("response helpers must never send/replay a request");
  try {
    for (const status of [429, 502, 503, 504]) {
      assert.deepEqual([1, 2, 3, 4, 5].map(n => statusRetryDelay({ status }, n)), [2000, 5000, 10000, 20000, 30000]);
      assert.equal(statusRetryDelay({ status }, 6), null);
    }
    for (const status of [400, 401, 403, 404, 409, 413, 422, 500]) assert.equal(statusRetryDelay({ status }, 1), null);
    assert.equal(statusRetryDelay(new TypeError("network unavailable"), 1), 2000);
    assert.equal(statusRetryDelay(Object.assign(new Error("timeout"), { name: "TimeoutError" }), 1), 2000);
    assert.deepEqual(await adminResponse(response(200, { data: { ok: true } })), { data: { ok: true } });
    assert.deepEqual(await adminResponse(new Response(null, { status: 204 })), {});
    await assert.rejects(adminResponse(response(200, {})), { code: "INCOMPLETE_REPLY" });
    await assert.rejects(adminResponse(response(200, { data: null })), { code: "INCOMPLETE_REPLY" });
  } finally { globalThis.fetch = fetch; }
});
