import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import express from "express";
import { PDFDocument } from "pdf-lib";
import { adminExtractionEnv, adminProviderConfig, describeAdminProviders, generateAdmin, testAdminProvider } from "../src/services/documents/adminProviders.js";
import { createWorkstation, STATION_LIMITS, validateStationRequest } from "../src/services/documents/workstation.js";
import { createAdminWorkstationRouter } from "../src/routes/adminWorkstation.js";
import { createAdminAiRouter } from "../src/routes/adminAi.js";
import { createFirebaseTokenVerifier } from "../src/middleware/verifyFirebaseToken.js";
import { generate as studentGenerate } from "../src/services/ai/providers.js";

const account = "a".repeat(32);
const env = { ADMIN_CLOUDFLARE_ACCOUNT_ID: account, ADMIN_CLOUDFLARE_API_TOKEN: "private-admin-cf-token", ADMIN_GEMINI_API_KEY: "private-admin-gemini-key", GEMINI_API_KEY: "private-STUDENT-key", ADMIN_GEMINI_MODEL: "admin-model" };
const request = { system: "Document rules", messages: [{ role: "user", text: "Document text" }], maxTokens: 100 };
const response = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const actor = { uid: "admin-a", email: "a@example.invalid", admin: true, emailVerified: true };

async function serve(t, create) {
  const app = express();
  app.use(express.json({ limit: "26mb" }));
  const verifyToken = (req, res, next) => {
    const who = req.get("authorization");
    if (!who) return res.status(401).json({ error: "Authentication required" });
    req.user = who === "student" ? { uid: "student", admin: false } : { ...actor, uid: who };
    next();
  };
  app.use("/api/v1/admin/workstation", create({ verifyToken }));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  return (path = "", body, token = "admin-a", method = body ? "POST" : "GET") => fetch(`http://127.0.0.1:${server.address().port}/api/v1/admin/workstation${path}`, {
    method, headers: { ...(token ? { authorization: token } : {}), "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {})
  });
}

test("admin config never borrows a student/provider-alias credential and status exposes no keys or account id", async () => {
  const studentOnly = { GEMINI_API_KEY: "student-only", GROQ_API_KEY: "gsk_student", OPENROUTER_API_KEY: "student-router", OTHER_ADMIN_KEY: "AIzaUnrelated" };
  assert.equal(describeAdminProviders(studentOnly).configured, false);
  assert.equal(adminExtractionEnv(studentOnly).GEMINI_API_KEY, "");
  await assert.rejects(generateAdmin(request, { env: studentOnly, fetchImpl: () => assert.fail("must not call a student provider") }), { code: "ADMIN_AI_NOT_CONFIGURED" });
  const status = JSON.stringify(describeAdminProviders(env));
  for (const secret of [env.ADMIN_GEMINI_API_KEY, env.ADMIN_CLOUDFLARE_API_TOKEN, env.GEMINI_API_KEY, account]) assert.equal(status.includes(secret), false);
  assert.equal(adminProviderConfig(env).gemini.model, "admin-model");
  assert.equal(adminProviderConfig({ GEMINI_API_KEY: "same-key", ADMIN_GEMINI_API_KEY: "same-key" }).gemini.configured, false, "reusing the student key is refused");
  assert.equal(describeAdminProviders(env).isolation, "admin_only");
  // Isolation works in the other direction too: a student request cannot
  // discover/use either admin key when the student key is absent.
  await assert.rejects(studentGenerate(request, { env: { ADMIN_GEMINI_API_KEY: "admin-only", ADMIN_CLOUDFLARE_API_TOKEN: "cf-only" }, fetchImpl: () => assert.fail() }), { code: "AI_NOT_CONFIGURED" });
});

test("Cloudflare uses the fixed Workers AI REST endpoint and an admin Authorization header", async () => {
  const calls = [];
  const result = await generateAdmin(request, { env, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.headers.Authorization, `Bearer ${env.ADMIN_CLOUDFLARE_API_TOKEN}`);
    assert.equal(init.redirect, "error");
    assert.deepEqual(JSON.parse(init.body).messages, [{ role: "system", content: "Document rules" }, { role: "user", content: "Document text" }]);
    return response(200, { success: true, result: { response: "Corrected text", usage: { completion_tokens: 12 } } });
  } });
  assert.equal(result.provider, "cloudflare"); assert.equal(result.text, "Corrected text");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.startsWith(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/`));
  assert.equal(calls[0].url.includes(env.ADMIN_CLOUDFLARE_API_TOKEN), false);
});

test("Auto fallback uses ONLY the admin Gemini key; an explicitly selected provider does not silently switch", async () => {
  const keys = [];
  const fetchImpl = async (url, init) => {
    if (url.includes("cloudflare")) return response(429, { errors: [{ message: env.ADMIN_CLOUDFLARE_API_TOKEN }] });
    keys.push(init.headers["x-goog-api-key"]);
    assert.match(url, /admin-model:generateContent$/);
    assert.equal(init.redirect, "error", "admin keys must never follow an upstream redirect");
    assert.equal(JSON.parse(init.body).tools, undefined, "no web search charges");
    return response(200, { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "Admin result" }] } }] });
  };
  const result = await generateAdmin(request, { env, fetchImpl });
  assert.deepEqual(keys, [env.ADMIN_GEMINI_API_KEY]);
  assert.equal(result.fallback, true); assert.equal(result.warnings.length, 1);
  await assert.rejects(generateAdmin(request, { env, fetchImpl, provider: "cloudflare" }), { code: "ADMIN_PROVIDER_QUOTA" });
  assert.equal(keys.length, 1);
});

test("provider failures are redacted, and scan OCR requires admin Gemini rather than the student key", async () => {
  await assert.rejects(generateAdmin(request, { env, provider: "cloudflare", fetchImpl: async () => response(401, { error: `bad token ${env.ADMIN_CLOUDFLARE_API_TOKEN}` }) }), error => {
    assert.equal(error.code, "ADMIN_PROVIDER_AUTH"); assert.equal(error.message.includes(env.ADMIN_CLOUDFLARE_API_TOKEN), false); return true;
  });
  const vision = { messages: [{ role: "user", text: "Read it", attachments: [{ data: "AA==", mimeType: "application/pdf", name: "x.pdf" }] }] };
  await assert.rejects(generateAdmin(vision, { env: { GEMINI_API_KEY: "student-only" }, fetchImpl: () => assert.fail() }), { code: "ADMIN_OCR_REQUIRED" });
  const reply = await generateAdmin(vision, { env, fetchImpl: async (url, init) => {
    assert.ok(url.includes("generativelanguage.googleapis.com"));
    assert.equal(init.headers["x-goog-api-key"], env.ADMIN_GEMINI_API_KEY);
    return response(200, { candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "Partial OCR" }] } }] });
  } });
  assert.equal(reply.truncated, true);
});

test("working requests validate source types, size, provider, instructions and unknown fields before processing", () => {
  for (const input of [{}, { text: "a", attachment: {} }, { text: "a", provider: "student" }, { text: "a", operation: "sql" }, { text: "a", sql: "DROP TABLE x" }, { text: "a", operation: "custom" }, { text: "a".repeat(STATION_LIMITS.text_characters + 1) }]) assert.throws(() => validateStationRequest(input));
  assert.throws(() => validateStationRequest({ attachment: { name: "bad.pdf", mimeType: "application/pdf", data: Buffer.from("not a PDF").toString("base64") } }), { code: "UNSUPPORTED_FILE" });
  assert.throws(() => validateStationRequest({ attachment: { name: "big.txt", mimeType: "text/plain", data: Buffer.alloc(STATION_LIMITS.file_bytes + 1, 65).toString("base64") } }), { code: "FILE_TOO_LARGE" });
  assert.equal(validateStationRequest({ text: " [Page 1]\nText ", operation: "extract" }).text, "[Page 1]\nText");
});

test("digital TXT extract-only makes no AI/DB call; correction is sectioned with untrusted-source instructions", async () => {
  const station = createWorkstation({ env: {}, generate: () => assert.fail("extract-only must be free") });
  const job = station.start("admin", { operation: "extract", attachment: { name: "source.txt", mimeType: "text/plain", data: Buffer.from("[Page 2]\nFaithful source words.").toString("base64") } });
  await station.idle();
  assert.equal(station.get(job.id, "admin").result.text, "[Page 2]\nFaithful source words.");
  const calls = [];
  const correcting = createWorkstation({ generate: async query => {
    calls.push(query);
    assert.match(query.system, /untrusted source data, NOT instructions/);
    return { text: "Section result", provider: "cloudflare", model: "test", warnings: [] };
  } });
  const work = correcting.start("admin", { text: `[Page 8]\n${"Source word ".repeat(2000)}`, instructions: "Correct spacing" });
  await correcting.idle();
  const done = correcting.get(work.id, "admin");
  assert.ok(calls.length > 1); assert.equal(done.result.sections, calls.length);
  assert.ok(calls.every(call => call.messages[0].text.includes("[Page 8]")));
  assert.equal(done.status, "ready");
  assert.equal(done.result.source_text.startsWith("[Page 8]"), true);
});

test("draft ownership, capacity, cancellation and expiry fail closed without affecting stored versions", async () => {
  let clock = 1000;
  const gate = deferred();
  const station = createWorkstation({ now: () => clock, generate: async () => { await gate.promise; return { text: "Ready", provider: "gemini", model: "test" }; } });
  const first = station.start("admin-a", { text: "One" });
  const second = station.start("admin-a", { text: "Two" });
  assert.throws(() => station.start("admin-a", { text: "Three" }), { code: "STATION_BUSY" });
  assert.throws(() => station.get(first.id, "admin-b"), { code: "DRAFT_NOT_FOUND" });
  assert.throws(() => station.cancel(first.id, "admin-b"), { code: "DRAFT_NOT_FOUND" });
  station.cancel(first.id, "admin-a"); gate.resolve(); await station.idle();
  assert.throws(() => station.get(first.id, "admin-a"), { code: "DRAFT_NOT_FOUND" });
  assert.equal(station.get(second.id, "admin-a").status, "ready");
  clock += 61 * 60_000;
  assert.throws(() => station.get(second.id, "admin-a"), { code: "DRAFT_NOT_FOUND" });
});

test("incomplete results require extra approval, and concurrent save retries share one writer", async () => {
  let generation = 0;
  const station = createWorkstation({ generate: async () => ({ text: "Partial result", truncated: generation++ === 0, provider: "gemini", model: "test" }) });
  const job = station.start("admin-a", { text: "Source document" }); await station.idle();
  assert.equal(station.get(job.id, "admin-a").result.truncated, true);
  assert.throws(() => station.start("admin-b", { text: "Copied", parent_id: job.id }), { code: "DRAFT_NOT_FOUND" });
  const refined = station.start("admin-a", { text: "Refine the partial text", parent_id: job.id });
  await station.idle();
  assert.equal(station.get(refined.id, "admin-a").result.truncated, true, "a follow-up cannot silently erase missing-page warnings");
  let writes = 0; const gate = deferred();
  const writer = async () => { writes++; await gate.promise; return { version_number: 1 }; };
  await assert.rejects(station.save(job.id, "admin-a", {}, writer), { code: "APPROVAL_REQUIRED" });
  await assert.rejects(station.save(job.id, "admin-a", { approved: true }, writer), { code: "INCOMPLETE_REVIEW_REQUIRED" });
  assert.equal(writes, 0);
  const body = { approved: true, acknowledge_incomplete: true };
  const first = station.save(job.id, "admin-a", body, writer);
  const second = station.save(job.id, "admin-a", body, writer);
  gate.resolve(); assert.deepEqual(await first, await second); assert.equal(writes, 1);
  assert.deepEqual(await station.save(job.id, "admin-a", body, writer), { version_number: 1 });
  assert.equal(writes, 1);
  station.cancel(job.id, "admin-a"); // removes temporary draft only
  assert.throws(() => station.get(job.id, "admin-a"), { code: "DRAFT_NOT_FOUND" });
});

test("all station routes reject visitors/students and never access Neon without an explicit ready approval", async t => {
  const station = createWorkstation({ env: {} });
  let dbCalls = 0;
  const call = await serve(t, ({ verifyToken }) => createAdminWorkstationRouter({ verifyToken, env: {}, configured: () => false,
    workstation: station, poolProvider: () => { dbCalls++; assert.fail("no Neon write/read expected"); } }));
  for (const [path, method] of [["/status", "GET"], ["/jobs", "POST"], ["/jobs/not-owned", "GET"], ["/jobs/not-owned", "DELETE"], ["/jobs/not-owned/save", "POST"]]) {
    for (const [token, status] of [[null, 401], ["student", 403]]) assert.equal((await call(path, method === "POST" ? { text: "x" } : null, token, method)).status, status);
  }
  assert.equal((await call("/status")).status, 200);
  const created = await (await call("/jobs", { text: "Source text", operation: "extract" })).json(); await station.idle();
  assert.equal((await call(`/jobs/${created.data.id}`, null, "admin-b")).status, 404);
  assert.equal((await call(`/jobs/${created.data.id}/save`, { approved: false, text: "Reviewed", title: "T" })).status, 400);
  assert.equal((await call(`/jobs/${created.data.id}/save`, { approved: true, text: "Reviewed", title: "T", _actor: "spoof" })).status, 400);
  assert.equal((await call(`/jobs/${created.data.id}/save`, { approved: true, text: "Reviewed", title: "T" })).status, 503);
  assert.equal(dbCalls, 0);
});

test("the retained admin extraction helper cannot consume the student Gemini credential", async t => {
  const app = express(); app.use(express.json());
  app.use(createAdminAiRouter({ env: { GEMINI_API_KEY: "student-only" }, verifyToken: (req, _res, next) => { req.user = actor; next(); }, fetchImpl: () => assert.fail("student API key must not be sent") }));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => server.close());
  const res = await fetch(`http://127.0.0.1:${server.address().port}/extract`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ attachment: { name: "scan.jpg", mimeType: "image/jpeg", data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString("base64") } }) });
  assert.equal(res.status, 503); assert.equal((await res.json()).code, "OCR_NOT_CONFIGURED");
});

test("scan-only Working Station uses the admin key once and surfaces a truncated OCR reply for mandatory review", async () => {
  let calls = 0;
  const station = createWorkstation({ env, fetchImpl: async (url, init) => {
    calls++;
    assert.ok(url.includes("generativelanguage.googleapis.com"));
    assert.equal(init.headers["x-goog-api-key"], env.ADMIN_GEMINI_API_KEY);
    return response(200, { candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "[Page 1]\nPartially transcribed words." }] } }] });
  } });
  const job = station.start("admin-a", { operation: "extract", attachment: { name: "page.jpg", mimeType: "image/jpeg", data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString("base64") } });
  await station.idle();
  const done = station.get(job.id, "admin-a");
  assert.equal(done.status, "ready", done.error?.message);
  assert.equal(done.result.method, "ai_ocr:gemini");
  assert.equal(done.result.truncated, true);
  assert.equal(calls, 1, "extract-only does not run another correction request");
  await assert.rejects(station.save(job.id, "admin-a", { approved: true }, () => assert.fail()), { code: "INCOMPLETE_REVIEW_REQUIRED" });
});


test("admin setting states explain missing/blank/reused credentials without leaking a value", () => {
  assert.equal(describeAdminProviders({}).gemini.setting_state, "missing");
  assert.equal(describeAdminProviders({ ADMIN_GEMINI_API_KEY: ' \"\" ' }).gemini.setting_state, "empty");
  assert.equal(describeAdminProviders({ GEMINI_API_KEY: "student-key", ADMIN_GEMINI_API_KEY: '\u200B"Bearer student-key"\uFEFF' }).gemini.setting_state, "same_as_student");
  assert.equal(describeAdminProviders({ ADMIN_GEMINI_API_KEY: "bad embedded whitespace" }).gemini.setting_state, "invalid_format");
  const settings = describeAdminProviders({ ADMIN_CLOUDFLARE_ACCOUNT_ID: "https://wrong-worker.example", ADMIN_CLOUDFLARE_API_TOKEN: "bad token" });
  assert.equal(settings.cloudflare.configured, false);
  assert.equal(settings.cloudflare.account_state, "invalid_format");
  assert.equal(settings.cloudflare.token_state, "invalid_format");
  assert.doesNotMatch(JSON.stringify(settings), /wrong-worker|bad token/);
});

test("explicit admin connection probes are one small request to exactly the selected admin provider", async () => {
  for (const provider of ["cloudflare", "gemini"]) {
    const calls = [];
    const result = await testAdminProvider(provider, { env, fetchImpl: async (url, init) => {
      calls.push(url);
      const payload = JSON.parse(init.body);
      assert.equal(init.redirect, "error");
      assert.equal(payload.tools, undefined);
      assert.equal(payload.contents?.[0]?.parts?.some(p => p.inline_data), provider === "gemini" ? false : undefined);
      assert.equal(JSON.stringify(payload).includes("Document text"), false);
      if (provider === "gemini") {
        assert.match(url, /generativelanguage/);
        assert.equal(init.headers["x-goog-api-key"], env.ADMIN_GEMINI_API_KEY);
        assert.ok(payload.generationConfig.maxOutputTokens <= 512);
        return response(200, { candidates: [{ content: { parts: [{ text: "READY" }] } }] });
      }
      assert.match(url, /api.cloudflare.com/);
      assert.equal(init.headers.Authorization, `Bearer ${env.ADMIN_CLOUDFLARE_API_TOKEN}`);
      assert.ok(payload.max_tokens <= 32);
      return response(200, { success: true, result: { response: "READY" } });
    } });
    assert.equal(calls.length, 1);
    assert.equal(result.ok, true);
    assert.equal(result.provider, provider);
    assert.equal(result.check, "live_provider_request");
    assert.equal(Object.hasOwn(result, "text"), false, "do not return upstream text in diagnostics");
    for (const secret of [env.ADMIN_GEMINI_API_KEY, env.GEMINI_API_KEY, env.ADMIN_CLOUDFLARE_API_TOKEN, account]) assert.equal(JSON.stringify(result).includes(secret), false);
  }
  let requests = 0;
  await assert.rejects(testAdminProvider("cloudflare", { env, fetchImpl: async url => { requests++; assert.match(url, /cloudflare/); return response(401, {}); } }), { code: "ADMIN_PROVIDER_AUTH" });
  assert.equal(requests, 1, "a failed selected-provider probe must not fall back to the other key");
  await assert.rejects(testAdminProvider("auto", { env, fetchImpl: () => assert.fail() }), { code: "VALIDATION_ERROR" });
  await assert.rejects(testAdminProvider("gemini", { env: { GEMINI_API_KEY: "student-only" }, fetchImpl: () => assert.fail() }), { code: "ADMIN_AI_NOT_CONFIGURED" });
});

test("admin provider probes require Google/admin verification, have their own small limit and never access Neon", async t => {
  let requests = 0;
  const call = await serve(t, ({ verifyToken }) => createAdminWorkstationRouter({ verifyToken, env, configured: () => false,
    poolProvider: () => assert.fail("diagnostic must not query or mutate Neon"),
    fetchImpl: async () => { requests++; return response(200, { success: true, result: { response: "READY" } }); } }));
  for (const [token, status] of [[null, 401], ["student", 403]]) assert.equal((await call("/providers/test", { provider: "cloudflare" }, token)).status, status);
  assert.equal(requests, 0);
  assert.equal((await call("/status")).status, 200);
  assert.equal(requests, 0, "status must never spend provider quota");
  for (let n = 0; n < 6; n++) assert.equal((await call("/providers/test", { provider: "cloudflare" })).status, 200);
  const limited = await call("/providers/test", { provider: "cloudflare" });
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).code, "ADMIN_TEST_RATE_LIMIT");
  assert.ok(Number(limited.headers.get("Retry-After")) > 0);
  assert.equal(requests, 6);
  assert.equal((await call("/providers/test", { provider: "cloudflare", key: "do-not-accept-keys" }, "admin-b")).status, 400);
  assert.equal(requests, 6);
  assert.equal((await call("/providers/test", { provider: "cloudflare" }, "admin-b")).status, 200, "test budgets are per verified administrator");
});

test("Gemini auth, model, quota and outage replies remain distinct and redact all upstream detail", async () => {
  for (const [status, code, http] of [[401, "ADMIN_PROVIDER_AUTH", 503], [403, "ADMIN_PROVIDER_AUTH", 503], [404, "ADMIN_MODEL_UNAVAILABLE", 503],
    [429, "ADMIN_PROVIDER_QUOTA", 429], [402, "ADMIN_PROVIDER_QUOTA", 429], [503, "ADMIN_PROVIDER_UNAVAILABLE", 502]]) {
    await assert.rejects(testAdminProvider("gemini", { env, fetchImpl: async () => response(status, { error: { message: `private upstream ${env.ADMIN_GEMINI_API_KEY} ${env.GEMINI_API_KEY}` } }) }), error => {
      assert.equal(error.code, code); assert.equal(error.status, http);
      assert.doesNotMatch(error.message, /private upstream|private-admin|private-STUDENT/);
      return true;
    });
  }
});

test("photo and fully scanned PDF jobs preserve classified admin-provider errors instead of generic OCR failures", async () => {
  const pdf = await PDFDocument.create(); pdf.addPage();
  const attachments = [
    { name: "photo.jpg", mimeType: "image/jpeg", data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString("base64") },
    { name: "scan.pdf", mimeType: "application/pdf", data: Buffer.from(await pdf.save()).toString("base64") }
  ];
  for (const attachment of attachments) {
    let requests = 0;
    const station = createWorkstation({ env, fetchImpl: async (_url, init) => {
      requests++; assert.equal(init.headers["x-goog-api-key"], env.ADMIN_GEMINI_API_KEY);
      return response(429, { error: { message: "quota" } });
    } });
    const job = station.start("admin-a", { attachment, operation: "extract" }); await station.idle();
    const failed = station.get(job.id, "admin-a");
    assert.equal(failed.status, "failed");
    assert.equal(failed.error.code, "ADMIN_PROVIDER_QUOTA");
    assert.match(failed.error.message, /admin Google project's limits/);
    assert.equal(requests, 1);
  }
});

test("an explicit Cloudflare probe bounds a stalled response body even when transport ignores AbortSignal", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  let signal;
  const never = new Promise(() => {});
  const pending = testAdminProvider("cloudflare", { env: { ...env, ADMIN_AI_TIMEOUT_MS: 240000 }, fetchImpl: async (_url, init) => {
    signal = init.signal; return { ok: true, json: () => never };
  } });
  const checked = assert.rejects(pending, { code: "ADMIN_PROVIDER_TIMEOUT", status: 504 });
  await Promise.resolve();
  t.mock.timers.tick(20000);
  await checked;
  assert.equal(signal.aborted, true);
});


test("provider tests use the real revoked-token/Google verifier before accepting an admin UID", async t => {
  let providerCalls = 0;
  const checked = [];
  const verifyToken = createFirebaseTokenVerifier(() => ({ async verifyIdToken(token, revoked) {
    checked.push({ token, revoked });
    return { uid: "verified-admin", admin: true, firebase: { sign_in_provider: token === "password-session" ? "password" : "google.com" } };
  } }));
  const call = await serve(t, () => createAdminWorkstationRouter({ env, verifyToken, configured: () => false,
    poolProvider: () => assert.fail("provider tests do not need Neon"),
    fetchImpl: async () => { providerCalls++; return response(200, { success: true, result: { response: "READY" } }); } }));
  const denied = await call("/providers/test", { provider: "cloudflare" }, "Bearer password-session");
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, "GOOGLE_SIGN_IN_REQUIRED");
  assert.equal(providerCalls, 0);
  assert.equal((await call("/providers/test", { provider: "cloudflare" }, "Bearer google-session")).status, 200);
  assert.equal(providerCalls, 1);
  assert.deepEqual(checked, [{ token: "password-session", revoked: true }, { token: "google-session", revoked: true }]);
});
