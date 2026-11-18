import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import { PGlite } from "@electric-sql/pglite";
import { generate, parseJsonReply, describeProviders } from "../src/services/ai/providers.js";
import { assertPublicUrl, checkLink, extractUrls, isPrivateAddress, termsFrom, verifySources } from "../src/services/ai/linkCheck.js";
import { composeSystem, loadPrompt, clearPromptCache, BUILT_IN_PROMPTS } from "../src/services/ai/prompts.js";
import { getAllowance, reserveUsage, finishUsage } from "../src/services/ai/quota.js";
import { validateAttachments } from "../src/services/ai/attachments.js";
import { createStudio } from "../src/services/ai/studio.js";
import { createAiRouter } from "../src/routes/ai.js";
import { createAdminAiRouter } from "../src/routes/adminAi.js";
import { createPresenceRouter } from "../src/routes/presence.js";
import { buildDocx, buildPdf, prepareMarkdown, documentFileName } from "../src/services/ai/documents.js";

const MIGRATION = readFileSync(new URL("../migrations/002_ai_studio.sql", import.meta.url), "utf8");
const COURSE_A = "11111111-1111-4111-8111-111111111111";
const COURSE_B = "22222222-2222-4222-8222-222222222222";
let db;
let pool;
let identities;

before(async () => {
  db = new PGlite();
  // Minimal models of the live catalog tables the AI reads (live schema has more columns).
  await db.exec(`
    CREATE TABLE universities (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, short_name text);
    CREATE TABLE courses (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), university_id uuid REFERENCES universities(id), course_code text, title text NOT NULL,
      academic_level text, semester text, is_published boolean DEFAULT false);
    CREATE TABLE course_topics (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), course_id uuid REFERENCES courses(id), title text NOT NULL, topic_order int DEFAULT 0, is_published boolean DEFAULT false);
    CREATE TABLE legal_cases (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), case_name text NOT NULL, citation text, ratio_decidendi text, verification_status text, created_at timestamptz DEFAULT NOW());
    CREATE TABLE past_questions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), course_id uuid REFERENCES courses(id), examination_year int, semester text,
      question_number text, question_text text NOT NULL, marks numeric, examination_duration_minutes int, provenance text DEFAULT 'verified_past_question',
      verification_status text DEFAULT 'pending', created_at timestamptz DEFAULT NOW());
  `);
  await db.exec(MIGRATION);
  await db.exec(MIGRATION); // idempotent re-run
  let tail = Promise.resolve();
  async function acquire() {
    let release;
    const previous = tail;
    tail = new Promise(resolve => { release = resolve; });
    await previous;
    return release;
  }
  const query = (text, values = []) => db.query(text, values);
  pool = {
    async query(text, values) { const release = await acquire(); try { return await query(text, values); } finally { release(); } },
    async connect() { const release = await acquire(); return { query, release }; }
  };
});
after(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec(`TRUNCATE ai_usage, ai_user_limits, ai_settings, ai_prompts, user_presence, ai_conversations, ai_messages, past_questions, course_topics, legal_cases, courses, universities CASCADE`);
  clearPromptCache();
  identities = {
    "user-a": { uid: "user-a", email: "a@example.invalid", name: "Student A", emailVerified: true, admin: false },
    "user-b": { uid: "user-b", email: "b@example.invalid", name: "Student B", emailVerified: true, admin: false },
    "unverified": { uid: "unverified", email: "u@example.invalid", emailVerified: false, admin: false },
    "admin": { uid: "admin", email: "admin@example.invalid", emailVerified: true, admin: true }
  };
});

const stubVerify = (req, res, next) => {
  const user = identities[(req.headers.authorization || "").replace(/^Bearer /, "")];
  if (!user) return res.status(401).json({ error: "Authentication required." });
  req.user = user;
  return next();
};

async function serve(t, mount) {
  const app = express();
  app.use(express.json({ limit: "26mb" }));
  mount(app);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return (path, { token = "user-a", method = "GET", body } = {}) => fetch(`${base}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined
  });
}

function jsonResponse(status, data, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
}

// ---------------- providers ----------------

test("Gemini is primary: the key goes in a header and grounding links are returned", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return jsonResponse(200, { modelVersion: "gemini-2.5-flash-lite", candidates: [{ finishReason: "STOP", content: { parts: [{ text: "thinking", thought: true }, { text: "Answer" }] },
      groundingMetadata: { webSearchQueries: ["donoghue stevenson"], groundingChunks: [{ web: { uri: "https://redirect.example/abc", title: "bailii.org" } }] } }] });
  };
  const result = await generate({ search: true, system: "S", messages: [{ role: "user", text: "Q" }] }, { env: { GEMINI_API_KEY: "secret-key" }, fetchImpl });
  assert.equal(result.text, "Answer");
  assert.equal(result.provider, "gemini");
  assert.deepEqual(result.sources, [{ url: "https://redirect.example/abc", title: "bailii.org", origin: "google_search" }]);
  assert.match(calls[0].url, /gemini-2\.5-flash-lite:generateContent$/);
  assert.equal(calls[0].url.includes("secret-key"), false);
  assert.equal(calls[0].init.headers["x-goog-api-key"], "secret-key");
  assert.deepEqual(calls[0].body.tools, [{ google_search: {} }]);
  assert.equal(calls[0].body.system_instruction.parts[0].text, "S");
});

test("busy Gemini models fall through to the next model, then OpenRouter free models", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(url);
    if (url.includes("generativelanguage")) return jsonResponse(429, { error: { message: "quota" } });
    assert.equal(init.headers.Authorization, "Bearer or-key");
    assert.equal(JSON.parse(init.body).model, "openrouter/free");
    return jsonResponse(200, { model: "x-ai/grok-free", choices: [{ message: { content: "Fallback answer" }, finish_reason: "stop" }] });
  };
  const result = await generate({ messages: [{ role: "user", text: "Q" }] }, { env: { GEMINI_API_KEY: "g", OPENROUTER_API_KEY: "or-key", GEMINI_MODELS: "m1,m2" }, fetchImpl });
  assert.equal(result.provider, "openrouter");
  assert.equal(result.fallback, true);
  assert.equal(result.text, "Fallback answer");
  assert.equal(seen.length, 3);
});

test("web search never falls back to a provider without verifiable sources", async () => {
  const fetchImpl = async (url) => {
    assert.equal(url.includes("openrouter"), false);
    return jsonResponse(503, {});
  };
  await assert.rejects(generate({ search: true, messages: [{ role: "user", text: "Q" }] }, { env: { GEMINI_API_KEY: "g", OPENROUTER_API_KEY: "o" }, fetchImpl }), { code: "PROVIDER_UNAVAILABLE" });
  await assert.rejects(generate({ messages: [{ role: "user", text: "Q" }] }, { env: {}, fetchImpl }), { code: "AI_NOT_CONFIGURED" });
});

test("provider status never exposes keys and JSON replies tolerate code fences", () => {
  const status = JSON.stringify(describeProviders({ GEMINI_API_KEY: "very-secret", OPENROUTER_API_KEY: "also-secret" }));
  assert.equal(status.includes("secret"), false);
  assert.deepEqual(parseJsonReply("```json\n{\"a\":1}\n```"), { a: 1 });
  assert.deepEqual(parseJsonReply("Sure: {\"b\":2} done"), { b: 2 });
  assert.equal(parseJsonReply("nope"), null);
});

// ---------------- link checking ----------------

test("link checker refuses private and internal addresses", async () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.4", "169.254.169.254", "172.20.0.1", "::1", "fd00::1", "::ffff:127.0.0.1"]) assert.equal(isPrivateAddress(ip), true, ip);
  assert.equal(isPrivateAddress("8.8.8.8"), false);
  await assert.rejects(assertPublicUrl("http://localhost/"), /internal/);
  await assert.rejects(assertPublicUrl("https://evil.example/", async () => [{ address: "10.0.0.1" }]), /private/);
  await assert.rejects(assertPublicUrl("https://user:pw@site.example/", async () => [{ address: "8.8.8.8" }]), /credentials/);
  await assert.rejects(assertPublicUrl("https://site.example:8080/", async () => [{ address: "8.8.8.8" }]), /port/);
  await assert.rejects(assertPublicUrl("file:///etc/passwd"), /protocol/);
});

test("links are followed to the real page, verified by case name, and redirects to private hosts are blocked", async () => {
  const lookup = async (host) => [{ address: host === "metadata.example" ? "169.254.169.254" : "93.184.216.34" }];
  const fetchImpl = async (url) => {
    if (url.startsWith("https://redirect.example/")) return new Response(null, { status: 302, headers: { location: "https://lawpavilion.example/case" } });
    if (url === "https://lawpavilion.example/case") return new Response("<title>Carlill v Carbolic</title><p>Carlill v Carbolic Smoke Ball Co</p>", { status: 200, headers: { "content-type": "text/html" } });
    if (url === "https://other.example/") return new Response("<p>unrelated</p>", { status: 200, headers: { "content-type": "text/html" } });
    if (url === "https://blocked.example/") return new Response("", { status: 403 });
    if (url === "https://sneaky.example/") return new Response(null, { status: 301, headers: { location: "http://metadata.example/latest" } });
    return new Response("", { status: 404 });
  };
  const terms = termsFrom("Carlill v Carbolic Smoke Ball Co");
  assert.ok(terms.includes("carlill"));
  const results = await verifySources([
    { url: "https://redirect.example/x", title: "lawpavilion" }, { url: "https://other.example/" }, { url: "https://blocked.example/" },
    { url: "https://sneaky.example/" }, { url: "https://gone.example/" }, { url: "https://other.example/" }
  ], { terms, fetchImpl, lookup });
  assert.deepEqual(results.map(r => [r.url, r.status]), [
    ["https://lawpavilion.example/case", "verified"], ["https://other.example/", "reachable"], ["https://blocked.example/", "restricted"],
    ["https://sneaky.example/", "broken"], ["https://gone.example/", "broken"]
  ]);
  assert.deepEqual(extractUrls("See [x](https://a.example/p). and https://b.example/q, end"), ["https://a.example/p", "https://b.example/q"]);
  assert.equal((await checkLink("http://127.0.0.1/", { fetchImpl })).status, "broken");
});

// ---------------- prompts, uploads, quota ----------------

test("private prompts come from Neon and the public stand-in is used until one is uploaded", async () => {
  assert.equal(await loadPrompt(pool, "case_research"), null);
  assert.match(composeSystem("case_research", null), /Never invent a case/);
  assert.ok(composeSystem("case_research", null).includes(BUILT_IN_PROMPTS.case_research));
  await pool.query("INSERT INTO ai_prompts (kind, content) VALUES ('case_research', 'PRIVATE MASTER PROMPT TEXT FOR TESTING')");
  clearPromptCache();
  const custom = await loadPrompt(pool, "case_research");
  assert.equal(custom, "PRIVATE MASTER PROMPT TEXT FOR TESTING");
  const system = composeSystem("case_research", custom);
  assert.ok(system.includes("PRIVATE MASTER PROMPT"));
  assert.equal(system.includes(BUILT_IN_PROMPTS.case_research), false);
});

test("uploads accept photos, PDFs and text only, with size limits", () => {
  const files = validateAttachments([{ name: "page/1.jpg", mimeType: "image/jpeg", data: "data:image/jpeg;base64,/9j/4AAQ" }]);
  assert.equal(files[0].name, "page_1.jpg");
  assert.equal(files[0].data, "/9j/4AAQ");
  assert.throws(() => validateAttachments([{ mimeType: "application/x-msdownload", data: "AAAA" }]), { code: "UNSUPPORTED_FILE" });
  assert.throws(() => validateAttachments([{ mimeType: "application/pdf", data: "%%%" }]), { code: "VALIDATION_ERROR" });
  assert.throws(() => validateAttachments([{ mimeType: "application/pdf", data: "A".repeat(14_000_000) }]), { code: "FILE_TOO_LARGE" });
  assert.throws(() => validateAttachments(Array.from({ length: 7 }, () => ({ mimeType: "text/plain", data: "AAAA" }))), /at most 6/);
});

test("daily allowance: 20 chats and 3 case analyses by default, failures not counted, admin overrides and pause", async () => {
  for (let i = 0; i < 3; i += 1) await finishUsage(pool, await reserveUsage(pool, "user-a", "case"), "completed");
  await assert.rejects(reserveUsage(pool, "user-a", "case"), { code: "LIMIT_REACHED", status: 429 });
  const failed = await reserveUsage(pool, "user-a", "chat");
  await finishUsage(pool, failed, "failed");
  let allowance = await getAllowance(pool, "user-a");
  assert.equal(allowance.features.case.remaining, 0);
  assert.equal(allowance.features.chat.limit, 20);
  assert.equal(allowance.features.chat.used, 0);
  await pool.query("INSERT INTO ai_user_limits (firebase_uid, case_daily) VALUES ('user-a', 5)");
  await reserveUsage(pool, "user-a", "case");
  allowance = await getAllowance(pool, "user-a");
  assert.equal(allowance.features.case.limit, 5);
  assert.equal(allowance.features.case.custom, true);
  await pool.query("UPDATE ai_user_limits SET paused = true WHERE firebase_uid = 'user-a'");
  await assert.rejects(reserveUsage(pool, "user-a", "chat"), { code: "AI_PAUSED" });
  assert.ok(await reserveUsage(pool, "admin", "case", { isAdmin: true }));
});

test("parallel requests cannot go over the limit", async () => {
  await pool.query("INSERT INTO ai_settings (key, value) VALUES ('default_limits', '{\"chat\":2,\"case\":3,\"notes\":3,\"questions\":5}')");
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => reserveUsage(pool, "user-b", "chat")));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 2);
  assert.ok(results.filter(r => r.status === "rejected").every(r => r.reason.code === "LIMIT_REACHED"));
});

// ---------------- studio pipelines ----------------

async function seedCourses() {
  const uni = (await pool.query("INSERT INTO universities (name, short_name) VALUES ('University of Lagos', 'UNILAG') RETURNING id")).rows[0].id;
  await pool.query(`INSERT INTO courses (id, university_id, course_code, title, is_published) VALUES ($1, $3, 'LAW 201', 'Law of Contract', true), ($2, $3, 'LAW 203', 'Law of Torts', true)`, [COURSE_A, COURSE_B, uni]);
  await pool.query("INSERT INTO courses (university_id, course_code, title, is_published) VALUES ($1, 'LAW 999', 'Hidden draft course', false)", [uni]);
  await pool.query("INSERT INTO course_topics (course_id, title, is_published) VALUES ($1, 'Offer and acceptance', true), ($2, 'Negligence', true)", [COURSE_A, COURSE_B]);
}

function scriptedGenerate(script) {
  const requests = [];
  const fn = async (request) => {
    requests.push(request);
    const step = script.shift();
    assert.ok(step, "unexpected extra AI call");
    return typeof step === "function" ? step(request) : { text: "", sources: [], searchQueries: [], provider: "gemini", model: "test-model", truncated: false, ...step };
  };
  fn.requests = requests;
  return fn;
}

test("question setter detects the course, uses only that course's past questions, and asks when unsure", async () => {
  await seedCourses();
  await pool.query(`INSERT INTO past_questions (course_id, examination_year, semester, question_number, question_text, marks, examination_duration_minutes) VALUES
    ($1, 2023, 'First', '1', 'CONTRACT PAST QUESTION: Ade offered to sell his car...', 20, 180),
    ($2, 2023, 'First', '1', 'TORT PAST QUESTION: Bola slipped in a shop...', 25, 120)`, [COURSE_A, COURSE_B]);
  const generateOk = scriptedGenerate([
    (request) => {
      assert.ok(request.json);
      assert.match(request.messages[0].text, /LAW 201/);
      assert.equal(request.messages[0].text.includes("Hidden draft course"), false);
      return { text: JSON.stringify({ course_id: COURSE_A, confidence: 0.92, reason: "Offer and acceptance" }) };
    },
    { text: "# Practice paper" }
  ]);
  const result = await createStudio({ db: pool, generate: generateOk, verify: async () => [] }).run("questions", { text: "Notes on offer, acceptance and consideration in contract law.", options: { courseId: "auto" } });
  assert.equal(result.meta.course.id, COURSE_A);
  assert.equal(result.meta.past_questions, 1);
  const brief = generateOk.requests[1].messages.at(-1).text;
  assert.match(brief, /CONTRACT PAST QUESTION/);
  assert.equal(brief.includes("TORT PAST QUESTION"), false);
  assert.match(brief, /marks used: 20/);

  const generateUnsure = scriptedGenerate([{ text: JSON.stringify({ course_id: COURSE_B, confidence: 0.4, reason: "Could be contract or tort", alternatives: [COURSE_A] }) }]);
  const unsure = await createStudio({ db: pool, generate: generateUnsure }).run("questions", { text: "Notes on damages and remoteness of loss.", options: { courseId: "auto" } });
  assert.equal(unsure.needsCourse, true);
  assert.deepEqual(unsure.meta.candidates.map(c => c.id), [COURSE_B, COURSE_A]);
});

test("question setter works before any past questions are stored", async () => {
  await seedCourses();
  const gen = scriptedGenerate([{ text: "# Paper" }]);
  const result = await createStudio({ db: pool, generate: gen }).run("questions", { text: "Some notes about negligence and duty of care.", options: { courseId: COURSE_B } });
  assert.equal(result.meta.past_questions, 0);
  assert.match(gen.requests[0].messages.at(-1).text, /none are stored for this course yet/);
});

test("case analysis combines database records, live research and checked links in the private prompt format", async () => {
  await pool.query("INSERT INTO legal_cases (case_name, citation, ratio_decidendi, verification_status) VALUES ('Carlill v Carbolic Smoke Ball Co', '[1893] 1 QB 256', 'An advertisement can be an offer', 'verified')");
  await pool.query("INSERT INTO ai_prompts (kind, content) VALUES ('case_research', 'MASTER CASE RESEARCH PROMPT (private)')");
  const gen = scriptedGenerate([
    (request) => { assert.equal(request.search, true); return { text: "Research notes", sources: [{ url: "https://redirect.example/1", title: "lawteacher" }], searchQueries: ["carlill"] }; },
    (request) => {
      assert.match(request.system, /MASTER CASE RESEARCH PROMPT/);
      const brief = request.messages.at(-1).text;
      assert.match(brief, /\[1893\] 1 QB 256/);
      assert.match(brief, /https:\/\/real\.example\/carlill \(CHECKED/);
      assert.equal(brief.includes("https://dead.example"), false);
      return { text: "## Carlill\nSee https://real.example/carlill and https://invented.example/x" };
    }
  ]);
  const verify = async (sources) => sources.map(s => s.url === "https://redirect.example/1"
    ? { url: "https://real.example/carlill", title: "lawteacher", origin: "google_search", status: "verified" }
    : s.url === "https://invented.example/x" ? { url: s.url, origin: "answer", status: "broken" } : { url: "https://dead.example", status: "broken" });
  const result = await createStudio({ db: pool, generate: gen, verify }).run("case", { text: "Carlill v Carbolic Smoke Ball Co" });
  assert.equal(result.meta.database_matches, 1);
  assert.deepEqual(result.sources.map(s => [s.url, s.status]), [["https://real.example/carlill", "verified"], ["https://invented.example/x", "broken"]]);
});

test("exam notes need real material and use only it unless research is authorised", async () => {
  const studio = createStudio({ db: pool, generate: scriptedGenerate([{ text: "# Notes" }]) });
  await assert.rejects(studio.run("notes", { text: "short" }), { code: "VALIDATION_ERROR" });
  const gen = scriptedGenerate([{ text: "# Notes" }]);
  await createStudio({ db: pool, generate: gen }).run("notes", { text: "Lecture notes. ".repeat(30), options: { topic: "Offer" } });
  assert.equal(gen.requests.length, 1);
  assert.equal(gen.requests[0].search, undefined);
  assert.match(gen.requests[0].messages[0].text, /EXTERNAL RESEARCH AUTHORISED: NO/);
});

// ---------------- student routes ----------------

async function waitForMessage(request, conversationId) {
  for (let i = 0; i < 50; i += 1) {
    const body = await (await request(`/api/v1/ai/conversations/${conversationId}`)).json();
    const last = body.data.messages.at(-1);
    if (last.status !== "pending") return last;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("job did not finish");
}

test("students send AI messages as background jobs, see results, and cannot read others' conversations", async t => {
  const runs = [];
  const studioFactory = () => ({ run: async (mode, input) => { runs.push({ mode, input }); return { content: `Answer to ${input.text}`, sources: [{ url: "https://a.example", status: "verified" }], provider: "gemini", model: "m", meta: {} }; }, listCourses: async () => [] });
  const request = await serve(t, app => app.use("/api/v1/ai", createAiRouter({ poolProvider: () => pool, verifyToken: stubVerify, env: { GEMINI_API_KEY: "k" }, studioFactory, configured: () => true })));

  const me = await (await request("/api/v1/ai/me")).json();
  assert.equal(me.data.allowance.features.chat.limit, 20);
  assert.equal(me.data.allowance.features.case.limit, 3);

  const sent = await request("/api/v1/ai/messages", { method: "POST", body: { mode: "chat", text: "What is consideration?", attachments: [{ name: "n.txt", mimeType: "text/plain", data: Buffer.from("notes").toString("base64") }] } });
  assert.equal(sent.status, 202);
  const { data } = await sent.json();
  assert.equal(data.messages[1].status, "pending");
  const done = await waitForMessage(request, data.conversation.id);
  assert.equal(done.status, "done");
  assert.equal(done.content, "Answer to What is consideration?");
  assert.equal(runs[0].input.attachments[0].mimeType, "text/plain");
  const stored = await pool.query("SELECT attachments FROM ai_messages WHERE role = 'user'");
  assert.equal(JSON.stringify(stored.rows[0].attachments).includes("data"), false, "file contents are not stored");
  assert.equal((await pool.query("SELECT status FROM ai_usage")).rows[0].status, "completed");

  assert.equal((await request(`/api/v1/ai/conversations/${data.conversation.id}`, { token: "user-b" })).status, 404);
  assert.equal((await request("/api/v1/ai/messages", { token: "user-b", method: "POST", body: { mode: "chat", text: "hi", conversation_id: data.conversation.id } })).status, 404);
  assert.equal((await request("/api/v1/ai/messages", { method: "POST", body: { mode: "case", text: "x", conversation_id: data.conversation.id } })).status, 400);
  const pdf = await request(`/api/v1/ai/messages/${done.id}/export`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get("content-type"), "application/pdf");
  assert.match(pdf.headers.get("content-disposition"), /attachment; filename="Chat-What-is-consideration\.pdf"/);
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");
  const word = await request(`/api/v1/ai/messages/${done.id}/export?format=docx`);
  assert.equal(word.status, 200);
  assert.equal(Buffer.from(await word.arrayBuffer()).subarray(0, 2).toString(), "PK");
  assert.equal((await request(`/api/v1/ai/messages/${done.id}/export`, { token: "user-b" })).status, 404, "other students cannot download");
  assert.equal((await request(`/api/v1/ai/messages/${data.messages[0].id}/export`)).status, 404, "only AI answers export");
  const list = await (await request("/api/v1/ai/conversations")).json();
  assert.equal(list.data.length, 1);
  assert.equal((await request(`/api/v1/ai/conversations/${data.conversation.id}`, { token: "user-b", method: "DELETE" })).status, 404);
  assert.equal((await request(`/api/v1/ai/conversations/${data.conversation.id}`, { method: "DELETE" })).status, 204);
});

test("AI routes enforce verified email, limits, and do not count failed jobs", async t => {
  let fail = true;
  const studioFactory = () => ({ run: async () => { if (fail) throw new Error("boom"); return { content: "ok", sources: [], provider: "gemini", model: "m", meta: {} }; } });
  const request = await serve(t, app => app.use("/api/v1/ai", createAiRouter({ poolProvider: () => pool, verifyToken: stubVerify, env: { GEMINI_API_KEY: "k" }, studioFactory, configured: () => true })));
  assert.equal((await request("/api/v1/ai/messages", { token: "unverified", method: "POST", body: { mode: "chat", text: "hi" } })).status, 403);
  assert.equal((await request("/api/v1/ai/messages", { method: "POST", body: { mode: "bogus", text: "hi" } })).status, 400);
  const first = await (await request("/api/v1/ai/messages", { method: "POST", body: { mode: "case", text: "Donoghue v Stevenson" } })).json();
  const failed = await waitForMessage(request, first.data.conversation.id);
  assert.equal(failed.status, "failed");
  assert.match(failed.content, /not counted/);
  assert.equal(failed.content.includes("boom"), false, "internal errors are not shown");
  fail = false;
  for (let i = 0; i < 3; i += 1) {
    const r = await (await request("/api/v1/ai/messages", { method: "POST", body: { mode: "case", text: `Case ${i}` } })).json();
    await waitForMessage(request, r.data.conversation.id);
  }
  const blocked = await request("/api/v1/ai/messages", { method: "POST", body: { mode: "case", text: "Case 4" } });
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).code, "LIMIT_REACHED");
  assert.equal((await request("/api/v1/ai/messages", { token: "admin", method: "POST", body: { mode: "case", text: "Admin case" } })).status, 202);
});

test("AI routes explain when the server has no AI key", async t => {
  const request = await serve(t, app => app.use("/api/v1/ai", createAiRouter({ poolProvider: () => pool, verifyToken: stubVerify, env: {}, configured: () => true })));
  const response = await request("/api/v1/ai/messages", { method: "POST", body: { mode: "chat", text: "hi" } });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "AI_NOT_CONFIGURED");
});

// ---------------- admin routes and presence ----------------

test("admin AI studio: admin only, private prompts, default limits, per-user limits and active/offline badges", async t => {
  const authProvider = () => ({
    listUsers: async () => ({ users: [
      { uid: "user-a", email: "a@example.invalid", displayName: "Student A", emailVerified: true, metadata: {}, providerData: [{ providerId: "google.com" }] },
      { uid: "user-b", email: "b@example.invalid", emailVerified: true, metadata: {}, providerData: [] }
    ] }),
    getUser: async (uid) => { if (!["user-a", "user-b"].includes(uid)) { const e = new Error("missing"); e.code = "auth/user-not-found"; throw e; } return { uid }; }
  });
  const request = await serve(t, app => {
    app.use("/api/v1/presence", createPresenceRouter({ poolProvider: () => pool, verifyToken: stubVerify, configured: () => true }));
    app.use("/api/v1/admin/ai", createAdminAiRouter({ poolProvider: () => pool, verifyToken: stubVerify, authProvider, env: { GEMINI_API_KEY: "secret-gemini" }, configured: () => true }));
  });
  assert.equal((await request("/api/v1/admin/ai/status")).status, 403);

  const status = await request("/api/v1/admin/ai/status", { token: "admin" });
  const statusText = await status.text();
  assert.equal(statusText.includes("secret-gemini"), false);
  assert.equal(JSON.parse(statusText).data.schema_ready, true);

  assert.equal((await request("/api/v1/admin/ai/prompts/case_research", { token: "admin", method: "PUT", body: { content: "short" } })).status, 400);
  assert.equal((await request("/api/v1/admin/ai/prompts/case_research", { token: "admin", method: "PUT", body: { content: "My private master case research prompt text." } })).status, 200);
  assert.equal((await request("/api/v1/admin/ai/prompts/case_research")).status, 403);
  const prompt = await (await request("/api/v1/admin/ai/prompts/case_research", { token: "admin" })).json();
  assert.equal(prompt.data.custom, true);
  assert.equal(await loadPrompt(pool, "case_research"), "My private master case research prompt text.");

  const limits = await request("/api/v1/admin/ai/limits", { token: "admin", method: "PUT", body: { chat: 30, case: 4, notes: "", questions: 5 } });
  assert.deepEqual((await limits.json()).data, { chat: 30, case: 4, notes: 3, questions: 5 });
  assert.equal((await request("/api/v1/admin/ai/limits", { token: "admin", method: "PUT", body: { chat: -1 } })).status, 400);

  assert.equal((await request("/api/v1/admin/ai/users/user-b/limits", { token: "admin", method: "PUT", body: { case: 10, paused: false, note: "Exam week" } })).status, 200);
  assert.equal((await request("/api/v1/admin/ai/users/nobody/limits", { token: "admin", method: "PUT", body: { case: 1 } })).status, 404);
  assert.equal((await getAllowance(pool, "user-b")).features.case.limit, 10);
  assert.equal((await getAllowance(pool, "user-a")).features.chat.limit, 30);

  assert.equal((await request("/api/v1/presence", { method: "POST", body: { page: "study" } })).status, 204);
  const users = (await (await request("/api/v1/admin/ai/users", { token: "admin" })).json()).data;
  assert.equal(users.total, 2);
  assert.equal(users.online, 1);
  assert.deepEqual(users.users.map(u => [u.uid, u.online]), [["user-a", true], ["user-b", false]]);
  assert.equal(users.users[1].limits.case, 10);
  assert.equal(users.users[1].note, "Exam week");
  const search = (await (await request("/api/v1/admin/ai/users?q=student%20a", { token: "admin" })).json()).data;
  assert.deepEqual(search.users.map(u => u.uid), ["user-a"]);
});

// ---------------- documents ----------------

test("documents: footnotes, links and verification table make it into the PDF and Word files", async () => {
  const markdown = "# Case\n\n**Carlill** [1893] 1 QB 256.[^1] See [BAILII](https://www.bailii.org/x) and [bad](javascript:alert(1)).\n\n> Tip\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n[^1]: Court of Appeal, BAILII.";
  const prepared = prepareMarkdown(markdown);
  assert.deepEqual([...prepared.footnotes.keys()], ["1"]);
  const pdf = await buildPdf({ title: "Case analysis", markdown, sources: [{ url: "https://www.bailii.org/x", title: "BAILII", status: "verified" }] });
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  const raw = pdf.toString("latin1");
  assert.match(raw, /\/URI \(https:\/\/www\.bailii\.org\/x\)/);
  assert.equal(raw.includes("javascript:"), false, "unsafe links are dropped");
  const word = await buildDocx({ title: "Notes", markdown });
  assert.equal(word.subarray(0, 2).toString(), "PK");
  assert.equal(documentFileName("Case analysis: Carlill v. Carbolic!", "pdf"), "Case-analysis-Carlill-v-Carbolic.pdf");
});

// ---------------- reliability: model health, time limits, progress, deadlines ----------------

test("a missing or hanging model is skipped for the next request, but never refused outright", async () => {
  const { resetProviderHealth, providerHealth } = await import("../src/services/ai/providers.js");
  resetProviderHealth();
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(url.match(/models\/([^:]+)/)[1]);
    if (url.includes("/m1:")) return jsonResponse(404, { error: { message: "not found" } });
    if (url.includes("/slow:")) return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("timeout", "TimeoutError"))));
    return jsonResponse(200, { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "ok" }] } }] });
  };
  const env = { GEMINI_API_KEY: "g", GEMINI_MODELS: "m1,slow,m3" };
  const first = await generate({ messages: [{ role: "user", text: "Q" }], timeoutMs: 50 }, { env, fetchImpl });
  assert.equal(first.text, "ok");
  assert.deepEqual(seen, ["m1", "slow", "m3"]);
  assert.deepEqual(providerHealth().map((item) => [item.model, item.code]).sort(), [["m1", "MODEL_UNAVAILABLE"], ["slow", "PROVIDER_TIMEOUT"]]);
  seen.length = 0;
  await generate({ messages: [{ role: "user", text: "Q" }], timeoutMs: 50 }, { env, fetchImpl });
  assert.deepEqual(seen, ["m3"], "known-bad models are skipped");
  // When every model is marked bad they are still all tried.
  seen.length = 0;
  await assert.rejects(generate({ messages: [{ role: "user", text: "Q" }], timeoutMs: 50 }, { env: { GEMINI_API_KEY: "g", GEMINI_MODELS: "m1,slow" }, fetchImpl }), { code: "PROVIDER_TIMEOUT" });
  assert.deepEqual(seen, ["m1", "slow"]);
  resetProviderHealth();
});

test("admin AI test reports every model separately", async t => {
  const { resetProviderHealth } = await import("../src/services/ai/providers.js");
  resetProviderHealth();
  const fetchImpl = async (url) => {
    if (url.includes("/bad:")) return jsonResponse(404, { error: { message: "model gone" } });
    if (url.includes("openrouter")) return jsonResponse(200, { model: "free-model", choices: [{ message: { content: "FIRE COUNSEL AI is connected." } }] });
    return jsonResponse(200, { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "FIRE COUNSEL AI is connected." }] } }] });
  };
  const env = { GEMINI_API_KEY: "g", OPENROUTER_API_KEY: "o", GEMINI_MODELS: "bad,good" };
  const request = await serve(t, app => app.use("/api/v1/admin/ai", createAdminAiRouter({ poolProvider: () => pool, verifyToken: stubVerify, env, fetchImpl, configured: () => true })));
  const body = await (await request("/api/v1/admin/ai/test", { token: "admin", method: "POST", body: {} })).json();
  assert.equal(body.data.ok, true);
  assert.equal(body.data.model, "good");
  assert.deepEqual(body.data.models.map((item) => [item.model, item.ok]), [["bad", false], ["good", true], ["free-model", true]]);
  assert.match(body.data.models[0].error, /model not available/);
  const status = await (await request("/api/v1/admin/ai/status", { token: "admin" })).json();
  assert.deepEqual(status.data.skipped_models.map((item) => item.model), ["bad"]);
  resetProviderHealth();
});

test("chat tasks shape the answer, and the studio reports progress stages", async () => {
  const requests = [];
  const stages = [];
  const studio = createStudio({ db: pool, env: {}, generate: async (request) => { requests.push(request); return { text: "**FAT** mnemonic", sources: [], provider: "gemini", model: "m" }; }, verify: async () => [] });
  const result = await studio.run("chat", { text: "Elements of a valid contract", options: { webSearch: false, task: "mnemonics" }, onProgress: (stage) => stages.push(stage) });
  assert.match(requests.at(-1).system, /TASK — MNEMONICS/);
  assert.equal(requests.at(-1).timeoutMs, 100_000, "chat uses a short writer time limit");
  assert.equal(result.meta.task, "mnemonics");
  assert.deepEqual(stages, ["library", "writing", "finishing"]);
});

test("AI jobs show live progress, stop at the deadline without counting, and ignore late answers", async t => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const seenOptions = [];
  const studioFactory = () => ({ run: async (mode, input) => {
    seenOptions.push(input.options);
    input.onProgress("searching");
    await gate;
    return { content: "late answer", sources: [], provider: "gemini", model: "m", meta: {} };
  } });
  const request = await serve(t, app => app.use("/api/v1/ai", createAiRouter({ poolProvider: () => pool, verifyToken: stubVerify, env: { GEMINI_API_KEY: "k", AI_CHAT_DEADLINE_MS: "1200" }, studioFactory, configured: () => true })));
  const sent = await (await request("/api/v1/ai/messages", { method: "POST", body: { mode: "chat", text: "Explain estoppel", options: { task: "explain", webSearch: false } } })).json();
  const id = sent.data.conversation.id;
  let stage = null;
  for (let i = 0; i < 50 && !stage; i += 1) {
    const body = await (await request(`/api/v1/ai/conversations/${id}`)).json();
    stage = body.data.messages.at(-1).meta.stage || null;
    if (!stage) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(stage, "searching");
  assert.equal(seenOptions[0].task, "explain");
  let last;
  for (let i = 0; i < 100; i += 1) {
    last = (await (await request(`/api/v1/ai/conversations/${id}`)).json()).data.messages.at(-1);
    if (last.status !== "pending") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(last.status, "failed");
  assert.match(last.content, /took too long.*not counted/);
  release();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const after = (await (await request(`/api/v1/ai/conversations/${id}`)).json()).data.messages.at(-1);
  assert.equal(after.status, "failed", "a late answer does not overwrite the failure");
  assert.equal((await pool.query("SELECT status FROM ai_usage ORDER BY id DESC LIMIT 1")).rows[0].status, "failed");
  // Unknown tasks are dropped.
  await request("/api/v1/ai/messages", { method: "POST", body: { mode: "chat", text: "hi", options: { task: "hack" } } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(seenOptions.at(-1).task, undefined);
});
