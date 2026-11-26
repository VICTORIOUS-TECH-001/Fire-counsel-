import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import PDFDocument from "pdfkit";
import { PGlite } from "@electric-sql/pglite";
import { chunkPages, extractDocument, needsOcr, ocrSpace, pagesToText, readPdfText, sniffType, splitMarkedPages, textToPages } from "../src/services/documents/extract.js";
import { createDocumentImporter } from "../src/services/documents/importer.js";
import { createAdminDocumentsRouter } from "../src/routes/adminDocuments.js";
import { createAdminWorkstationRouter } from "../src/routes/adminWorkstation.js";
import { createWorkstation } from "../src/services/documents/workstation.js";
import { createAdminSiteRouter, createPublicSiteHandlers, validateSiteContent } from "../src/routes/siteContent.js";
import { ensureAdminUser } from "../src/routes/adminDatabase.js";
import { createStudio, librarySearchTerms } from "../src/services/ai/studio.js";
import { createApp, proxyTrust } from "../src/app.js";

const MIGRATION = readFileSync(new URL("../migrations/003_site_and_documents.sql", import.meta.url), "utf8");
const ADMIN = { uid: "admin-uid", email: "admin@example.invalid", name: "Admin", emailVerified: true, admin: true };
const SITE = JSON.parse(readFileSync(new URL("../../data/site-content.json", import.meta.url), "utf8"));
let db;
let pool;

function makePdf(pages) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ autoFirstPage: false });
    const parts = [];
    doc.on("data", (part) => parts.push(part));
    doc.on("end", () => resolve(Buffer.concat(parts)));
    for (const text of pages) {
      doc.addPage();
      if (text) doc.fontSize(12).text(text); else doc.rect(50, 50, 200, 200).fill("#888");
    }
    doc.end();
  });
}

before(async () => {
  db = new PGlite();
  // Models of the live Neon tables (same columns, keys and checks as the live schema check reported).
  await db.exec(`
    CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT NOW());
    CREATE TABLE app_users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), firebase_uid varchar NOT NULL UNIQUE, email varchar NOT NULL UNIQUE,
      full_name varchar NOT NULL, account_status varchar DEFAULT 'active', created_at timestamptz DEFAULT NOW(), updated_at timestamptz DEFAULT NOW());
    CREATE TABLE universities (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name varchar NOT NULL, short_name varchar);
    CREATE TABLE courses (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), university_id uuid NOT NULL REFERENCES universities(id), course_code varchar,
      title varchar NOT NULL, academic_level varchar, semester varchar, is_published boolean DEFAULT false);
    CREATE TABLE course_topics (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), course_id uuid REFERENCES courses(id), title text, topic_order int DEFAULT 0, is_published boolean DEFAULT false);
    CREATE TABLE materials (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), university_id uuid, course_id uuid, topic_id uuid, uploaded_by uuid NOT NULL REFERENCES app_users(id),
      title varchar NOT NULL, description text, material_type varchar NOT NULL CHECK (material_type IN ('lecture_note','textbook','handout','case_material','statute','past_question','marking_scheme','course_outline','model_answer','other')),
      source_category varchar DEFAULT 'lecturer_material' CHECK (source_category IN ('lecturer_material','legal_authority','external_research','student_upload','platform_resource')),
      original_file_name text, file_storage_path text, file_mime_type varchar, file_size_bytes int8,
      access_scope varchar DEFAULT 'institution' CHECK (access_scope IN ('institution','platform','private')),
      approval_status varchar DEFAULT 'pending' CHECK (approval_status IN ('pending','approved','rejected','archived')),
      publication_status varchar DEFAULT 'draft' CHECK (publication_status IN ('draft','published','unpublished')),
      approved_by uuid, approved_at timestamptz, published_at timestamptz, created_at timestamptz DEFAULT NOW(), updated_at timestamptz DEFAULT NOW());
    CREATE TABLE material_versions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), material_id uuid NOT NULL REFERENCES materials(id) ON DELETE CASCADE, version_number int NOT NULL,
      file_storage_path text, extracted_text text, extraction_status varchar DEFAULT 'pending', uploaded_by uuid, created_at timestamptz DEFAULT NOW(), UNIQUE (material_id, version_number));
    CREATE TABLE material_chunks (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), material_id uuid NOT NULL REFERENCES materials(id) ON DELETE CASCADE, version_id uuid,
      chunk_number int NOT NULL, content text NOT NULL, page_number int, section_heading text, token_count int, metadata jsonb DEFAULT '{}'::jsonb, created_at timestamptz DEFAULT NOW(),
      UNIQUE (version_id, chunk_number));
    CREATE TABLE legal_cases (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), case_name varchar NOT NULL, citation text, court varchar, jurisdiction varchar DEFAULT 'Nigeria', year int,
      subject_area varchar, material_facts text, legal_issues text, decision text, ratio_decidendi text, obiter_dicta text, full_judgment_url text, source_material_id uuid,
      verification_status varchar DEFAULT 'unverified' CHECK (verification_status IN ('unverified','verified','disputed')), created_at timestamptz DEFAULT NOW(), updated_at timestamptz DEFAULT NOW());
    CREATE TABLE past_questions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), university_id uuid, course_id uuid, uploaded_by uuid, examination_year int, semester varchar,
      question_number varchar, question_text text NOT NULL, marks numeric, examination_duration_minutes int, source_material_id uuid,
      provenance varchar DEFAULT 'verified_past_question' CHECK (provenance IN ('verified_past_question','AI_practice','AI_prediction','lecturer_created')),
      verification_status varchar DEFAULT 'pending' CHECK (verification_status IN ('pending','verified','rejected')), created_at timestamptz DEFAULT NOW());
  `);
  await db.exec(MIGRATION);
  await db.exec(MIGRATION); // idempotent re-run
  let tail = Promise.resolve();
  const acquire = async () => { let release; const previous = tail; tail = new Promise((r) => { release = r; }); await previous; return release; };
  const query = (text, values = []) => db.query(text, values);
  pool = {
    async query(text, values) { const release = await acquire(); try { return await query(text, values); } finally { release(); } },
    async connect() { const release = await acquire(); return { query, release }; }
  };
});
after(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec("TRUNCATE uploaded_files, site_content, site_content_versions, site_images, past_questions, legal_cases, material_chunks, material_versions, materials, course_topics, courses, universities, app_users CASCADE");
});

async function serve(t, router, mount) {
  const app = express();
  // Match the production JSON data limit, including reviewed Unicode TXT.
  app.use(express.json({ limit: "2mb" }));
  app.use(mount, router);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}${mount}`;
}
const allow = (req, _res, next) => { req.user = ADMIN; next(); };
const pass = (_req, _res, next) => next();

// ------------------------------------------------------------------ the PDF reader

test("digital PDFs are read locally, page by page, without AI", async () => {
  const pdf = await makePdf(["Donoghue v Stevenson [1932] AC 562. The neighbour principle requires reasonable care toward persons closely affected.", "Carlill v Carbolic Smoke Ball Co [1893] 1 QB 256 concerns unilateral offers and acceptance by conduct."]);
  assert.equal(sniffType(pdf, "anything.bin"), "application/pdf");
  const pages = await readPdfText(pdf);
  assert.equal(pages.length, 2);
  await assert.rejects(readPdfText(pdf, { maxPages: 1 }), { code: "DOCUMENT_TOO_LONG" });
  assert.match(pages[0].text, /Donoghue v Stevenson \[1932\] AC 562/);
  assert.equal(needsOcr(pages), false);
  const result = await extractDocument({ buffer: pdf, mimeType: "application/pdf", name: "cases.pdf" }, { env: {}, generate: async () => { throw new Error("AI must not be called"); } });
  assert.equal(result.method, "pdf_text");
  assert.equal(result.pageCount, 2);
  await assert.rejects(extractDocument({ buffer: Buffer.from("%PDF-1.4 broken"), mimeType: "application/pdf", name: "x.pdf" }, { env: {} }), (e) => e.code === "PDF_DAMAGED");
});

test("scanned PDFs go to AI OCR in page batches, and say clearly when no OCR is configured", async () => {
  const scan = await makePdf([null, null]);
  assert.equal(needsOcr(await readPdfText(scan)), true);
  const calls = [];
  const generate = async (request) => {
    calls.push(request);
    assert.equal(request.messages[0].attachments[0].mimeType, "application/pdf");
    return { text: "[Page 1]\nIn the Supreme Court of Nigeria\n[Page 2]\nJudgment delivered by the court", provider: "gemini", model: "test" };
  };
  const result = await extractDocument({ buffer: scan, mimeType: "application/pdf", name: "scan.pdf" }, { env: { GEMINI_API_KEY: "k" }, generate });
  assert.equal(calls.length, 1);
  assert.equal(result.method, "ai_ocr:gemini");
  assert.deepEqual(result.pages.map((p) => p.page), [1, 2]);
  await assert.rejects(
    extractDocument({ buffer: scan, mimeType: "application/pdf", name: "scan.pdf" }, { env: {}, generate: async () => { throw new Error("no key"); } }),
    (error) => error.code === "OCR_NOT_CONFIGURED" && /GEMINI_API_KEY/.test(error.message));
});

test("an OCR batch that silently omits a PDF page stays incomplete in Working Station", async () => {
  const scan = await makePdf([null, null]);
  const station = createWorkstation({
    env: { ADMIN_GEMINI_API_KEY: "admin-ocr", GEMINI_API_KEY: "student-only" },
    generate: async request => {
      assert.equal(request.messages[0].attachments[0].mimeType, "application/pdf");
      return { text: "[Page 1]\nOnly the first page was transcribed, despite a normal finish reason.", provider: "gemini", model: "test", truncated: false };
    }
  });
  const job = station.start(ADMIN.uid, { operation: "extract", attachment: { name: "two-pages.pdf", mimeType: "application/pdf", data: scan.toString("base64") } });
  await station.idle();
  const done = station.get(job.id, ADMIN.uid);
  assert.equal(done.status, "ready", done.error?.message);
  assert.equal(done.result.pages, 2);
  assert.equal(done.result.truncated, true);
  assert.ok(done.result.warnings.some(warning => /Page\(s\) 2 could not be read/.test(warning)));
  await assert.rejects(station.save(job.id, ADMIN.uid, { approved: true }, () => assert.fail()), { code: "INCOMPLETE_REVIEW_REQUIRED" });
});

test("a PDF with some scanned pages keeps its text pages and only sends the scans to the AI", async () => {
  const mixed = await makePdf(["Typed lecture page about consideration in contract law and the rule in Pinnel's case.", null, "Another typed page on promissory estoppel and Combe v Combe."]);
  const seen = [];
  const result = await extractDocument({ buffer: mixed, mimeType: "application/pdf", name: "m.pdf" }, {
    env: { GEMINI_API_KEY: "k" },
    generate: async (request) => { seen.push(request.messages[0].text); return { text: "[Page 2]\nHandwritten note: past consideration is no consideration.", provider: "gemini" }; }
  });
  assert.equal(seen.length, 1);
  assert.match(seen[0], /page 2 of the original/);
  assert.equal(result.method, "pdf_text+ai_ocr:gemini");
  assert.match(result.pages[1].text, /past consideration/);
  assert.match(result.pages[2].text, /Combe v Combe/);
});

test("OCR.space is used as the free fallback for small scans", async () => {
  const fetchImpl = async (url, options) => {
    assert.equal(url, "https://api.ocr.space/parse/image");
    assert.equal(options.headers.apikey, "ocr-key");
    return new Response(JSON.stringify({ ParsedResults: [{ ParsedText: "Page one text" }, { ParsedText: "Page two text" }] }), { status: 200 });
  };
  const pages = await ocrSpace({ data: Buffer.from("%PDF-1.4 tiny"), mimeType: "application/pdf", name: "a.pdf" }, { key: "ocr-key", fetchImpl });
  assert.deepEqual(pages, [{ page: 1, text: "Page one text" }, { page: 2, text: "Page two text" }]);
  await assert.rejects(ocrSpace({ data: Buffer.alloc(1024 * 1024 + 1), mimeType: "image/jpeg" }, { key: "k", fetchImpl }), (e) => e.code === "OCR_FILE_TOO_LARGE");
  const photo = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const result = await extractDocument({ buffer: photo, mimeType: "image/jpeg", name: "p.jpg" }, { env: { GEMINI_API_KEY: "k", OCR_SPACE_API_KEY: "ocr-key" }, generate: async () => { throw new Error("AI down"); }, fetchImpl });
  assert.equal(result.method, "ocr_space");
  assert.equal(result.warnings.length, 1);
});

test("page markers survive review, pasting and chunking", () => {
  const pages = [{ page: 3, text: "Alpha ".repeat(900) }, { page: 4, text: "Beta text" }];
  const text = pagesToText(pages);
  assert.match(text, /^\[Page 3\]/);
  assert.deepEqual(textToPages(text).map((p) => p.page), [3, 4]);
  const chunks = chunkPages(textToPages(text));
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((c) => c.content.length <= 3500));
  assert.deepEqual([...new Set(chunks.map((c) => c.page))], [3, 4]);
  assert.deepEqual(textToPages("plain pasted text"), [{ page: null, text: "plain pasted text" }]);
  assert.deepEqual(splitMarkedPages("no markers", 5, 2), [{ page: 5, text: "no markers" }]);
  assert.deepEqual(splitMarkedPages("[Page 1]\na\n[Page 2]\nb", 7, 2).map((p) => p.page), [7, 8], "model numbered from 1");
  assert.equal(sniffType(Buffer.from("hello"), "notes.txt"), "text/plain");
  assert.equal(sniffType(Buffer.from([0x50, 0x4b, 3, 4, 0]), "x.zip"), null);
  assert.deepEqual(librarySearchTerms("Explain remoteness of damage; DROP TABLE x'--"), ["remoteness", "damage", "drop", "table"]);
});

// ------------------------------------------------------------------ uploads -> Neon library

async function seedCourse() {
  const { rows: [uni] } = await pool.query("INSERT INTO universities (name, short_name) VALUES ('University of Lagos', 'UNILAG') RETURNING id");
  const { rows: [course] } = await pool.query("INSERT INTO courses (university_id, course_code, title, is_published) VALUES ($1, 'LAW 341', 'Law of Torts', true) RETURNING id", [uni.id]);
  return { universityId: uni.id, courseId: course.id };
}

async function waitFor(base, id) {
  for (let i = 0; i < 200; i++) {
    const body = await (await fetch(`${base}/${id}`)).json();
    if (["saved", "ready", "failed"].includes(body.data.status)) return body.data;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("upload did not finish");
}

const documentsRouter = (importer, env = {}) => createAdminDocumentsRouter({ poolProvider: () => pool, verifyToken: allow, adminGate: pass, configured: () => true, env, importer });

test("an uploaded lecture PDF becomes a published library material with page-numbered chunks the AI can find", async (t) => {
  const { courseId, universityId } = await seedCourse();
  const importer = createDocumentImporter({ poolProvider: () => pool, env: {}, generate: async () => { throw new Error("not needed"); } });
  const base = await serve(t, documentsRouter(importer), "/api/v1/admin/documents");
  const pdf = await makePdf(["Negligence: duty of care, breach and damage. Donoghue v Stevenson established the neighbour principle.", "Remoteness of damage: The Wagon Mound (No 1) replaced the directness test with reasonable foreseeability."]);

  const response = await fetch(`${base}?purpose=material&name=${encodeURIComponent("Torts week 3.pdf")}&course_id=${courseId}&material_type=lecture_note`, { method: "POST", headers: { "Content-Type": "application/pdf" }, body: pdf });
  assert.equal(response.status, 202);
  const created = (await response.json()).data;
  assert.equal(created.options._actor, undefined, "the uploader identity is never echoed");
  const done = await waitFor(base, created.id);
  assert.equal(done.status, "saved", done.error_message);
  assert.equal(done.method, "pdf_text");
  assert.match(done.text, /\[Page 2\]\nRemoteness of damage/);

  const again = await fetch(`${base}?purpose=material&name=copy.pdf&course_id=${courseId}`, { method: "POST", headers: { "Content-Type": "application/pdf" }, body: pdf });
  assert.equal(again.status, 409, "a double tap does not create a duplicate");
  assert.equal((await again.json()).code, "DUPLICATE_FILE");

  const { rows: [material] } = await pool.query("SELECT * FROM materials WHERE id = $1", [done.result.material_id]);
  assert.equal(material.title, "Torts week 3");
  assert.equal(material.course_id, courseId);
  assert.equal(material.university_id, universityId);
  assert.equal(material.access_scope, "institution");
  assert.equal(material.approval_status, "approved");
  assert.equal(material.publication_status, "published");
  assert.equal(material.file_storage_path, `neon:uploaded_files/${created.id}`);
  const { rows: chunks } = await pool.query("SELECT page_number FROM material_chunks WHERE material_id = $1 ORDER BY chunk_number", [material.id]);
  assert.deepEqual(chunks.map((c) => c.page_number), [1, 2]);
  const { rows: [user] } = await pool.query("SELECT email FROM app_users WHERE id = $1", [material.uploaded_by]);
  assert.equal(user.email, ADMIN.email);

  // The AI chat now receives the matching library passages, best page first.
  let prompt = "";
  const studio = createStudio({ db: pool, env: { GEMINI_API_KEY: "k" }, generate: async (request) => { prompt = request.messages.at(-1).text; return { text: "answer", provider: "gemini", model: "m" }; }, verify: async () => [] });
  const reply = await studio.run("chat", { text: "Explain remoteness of damage and foreseeability", options: { webSearch: false } });
  assert.match(prompt, /\[Library: Torts week 3, p\. 2\]/);
  assert.match(prompt, /Wagon Mound/);
  assert.ok(reply.meta.library_passages >= 1);
  const p1 = prompt.indexOf("p. 1]");
  assert.ok(p1 === -1 || prompt.indexOf("p. 2]") < p1, "the best-matching page comes first");

  // A second file can be added as a new version of the same material.
  const v2 = await fetch(`${base}?purpose=material_version&name=v2.txt&material_id=${material.id}`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "Updated lecture: Wagon Mound and the eggshell skull rule." });
  const v2done = await waitFor(base, (await v2.json()).data.id);
  assert.equal(v2done.result.version_number, 2);
  const list = await (await fetch(`${base}?material_id=${material.id}`)).json();
  assert.equal(list.data.length, 2, "original file and the new version both belong to it");

  // Download the original and delete it (library text stays).
  const file = await fetch(`${base}/${created.id}/file`);
  assert.equal(file.headers.get("content-type"), "application/pdf");
  assert.equal(Buffer.from(await file.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");
  assert.equal((await fetch(`${base}/${created.id}`, { method: "DELETE" })).status, 204);
  assert.equal((await fetch(`${base}/${created.id}/file`)).status, 404);
  assert.ok((await pool.query("SELECT COUNT(*)::int AS n FROM material_chunks WHERE material_id = $1", [material.id])).rows[0].n > 0);
});

test("a judgment PDF creates a case record linked to its full text; a past paper becomes questions for the setter", async (t) => {
  const { courseId } = await seedCourse();
  const generate = async (request) => {
    if (/court judgments/.test(request.system)) {
      return { text: JSON.stringify({ case_name: "Donoghue v Stevenson", citation: "[1932] AC 562", court: "House of Lords", jurisdiction: "United Kingdom", year: 1932, ratio_decidendi: "A manufacturer owes a duty of care to the ultimate consumer.", decision: "Appeal allowed" }), provider: "gemini", model: "m" };
    }
    return { text: JSON.stringify({ examination_year: 2023, semester: "First", duration_minutes: 180, questions: [{ question_number: "1", question_text: "Discuss the neighbour principle.", marks: 25 }, { question_number: "2", question_text: "Ade bought a bottle of ginger beer... Advise Ade.", marks: 25 }] }), provider: "gemini", model: "m" };
  };
  const importer = createDocumentImporter({ poolProvider: () => pool, env: { GEMINI_API_KEY: "k" }, generate });
  const base = await serve(t, documentsRouter(importer), "/api/v1/admin/documents");

  const judgment = await makePdf(["LORD ATKIN: The rule that you are to love your neighbour becomes in law you must not injure your neighbour. Appeal allowed."]);
  const caseUpload = (await (await fetch(`${base}?purpose=case&name=donoghue.pdf`, { method: "POST", headers: { "Content-Type": "application/pdf" }, body: judgment })).json()).data;
  const caseDone = await waitFor(base, caseUpload.id);
  assert.equal(caseDone.status, "saved", caseDone.error_message);
  const { rows: [legalCase] } = await pool.query("SELECT * FROM legal_cases WHERE id = $1", [caseDone.result.case_id]);
  assert.equal(legalCase.case_name, "Donoghue v Stevenson");
  assert.equal(legalCase.citation, "[1932] AC 562");
  assert.equal(legalCase.year, 1932);
  assert.equal(legalCase.verification_status, "unverified");
  const { rows: [caseMaterial] } = await pool.query("SELECT material_type, access_scope, source_category FROM materials WHERE id = $1", [legalCase.source_material_id]);
  assert.deepEqual(caseMaterial, { material_type: "case_material", access_scope: "platform", source_category: "legal_authority" });

  // Uploading a better copy to an existing case only fills its empty fields.
  await pool.query("UPDATE legal_cases SET court = 'HL (typed by admin)', obiter_dicta = NULL WHERE id = $1", [legalCase.id]);
  const copy = await makePdf(["Second report of the same judgment with headnote."]);
  const fillDone = await waitFor(base, (await (await fetch(`${base}?purpose=case&name=d2.pdf&case_id=${legalCase.id}`, { method: "POST", headers: { "Content-Type": "application/pdf" }, body: copy })).json()).data.id);
  assert.equal(fillDone.status, "saved", fillDone.error_message);
  assert.equal((await pool.query("SELECT court FROM legal_cases WHERE id = $1", [legalCase.id])).rows[0].court, "HL (typed by admin)");

  // Case analysis now quotes the stored judgment text.
  let brief = "";
  const studio = createStudio({ db: pool, env: { GEMINI_API_KEY: "k" }, generate: async (request) => { if (request.search) return { text: "notes from the supplied synthetic source", provider: "gemini", model: "m", sources: [{ url: "https://example.org/synthetic-judgment", title: "Synthetic search fixture" }] }; brief = request.messages.at(-1).text; return { text: "analysis", provider: "gemini", model: "m" }; }, verify: async () => [] });
  await studio.run("case", { text: "Donoghue v Stevenson", options: {} });
  assert.match(brief, /JUDGMENT TEXT FROM THE FIRE COUNSEL LIBRARY/);

  assert.equal((await fetch(`${base}?purpose=past_questions&name=paper.txt`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "1. Discuss." })).status, 400, "a course is required");
  const paper = (await (await fetch(`${base}?purpose=past_questions&name=paper.txt&course_id=${courseId}`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "LAW 341 2023 First Semester. 1. Discuss the neighbour principle. (25 marks) 2. Ade bought a bottle... Advise Ade. (25 marks)" })).json()).data;
  const paperDone = await waitFor(base, paper.id);
  assert.equal(paperDone.result.questions, 2, paperDone.error_message);
  const { rows: questions } = await pool.query("SELECT course_id, examination_year, semester, question_number, marks::int AS marks, examination_duration_minutes, provenance, verification_status FROM past_questions ORDER BY question_number");
  assert.equal(questions.length, 2);
  assert.deepEqual(questions[0], { course_id: courseId, examination_year: 2023, semester: "First", question_number: "1", marks: 25, examination_duration_minutes: 180, provenance: "verified_past_question", verification_status: "pending" });
});

test("uploads reject bad files, respect the storage budget; failed jobs can be retried; review-first uploads save edited text", async (t) => {
  let fail = true;
  const importer = createDocumentImporter({ poolProvider: () => pool, env: {}, extract: async () => {
    if (fail) { const e = new Error("The AI could not read this scan right now."); e.code = "OCR_FAILED"; e.status = 502; throw e; }
    return { pages: [{ page: 1, text: "Recovered text" }], pageCount: 1, method: "pdf_text", characters: 14, warnings: [] };
  } });
  const base = await serve(t, documentsRouter(importer, { FILE_STORAGE_LIMIT_MB: "1" }), "/api/v1/admin/documents");
  assert.equal((await fetch(`${base}?name=x.exe`, { method: "POST", body: Buffer.from("MZ binary") })).status, 415);
  assert.equal((await fetch(`${base}?purpose=other&name=x.txt`, { method: "POST", body: "text" })).status, 400);
  assert.equal((await fetch(`${base}?name=x.txt&course_id=11111111-1111-4111-8111-111111111111`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "text" })).status, 404);
  assert.equal((await fetch(`${base}?name=big.txt`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "a".repeat(1024 * 1024 + 10) })).status, 507);

  const upload = (await (await fetch(`${base}?name=scan.txt`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "scan" })).json()).data;
  const failed = await waitFor(base, upload.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error_code, "OCR_FAILED");
  assert.match(failed.error_message, /could not read this scan/);
  fail = false;
  assert.equal((await fetch(`${base}/${upload.id}/retry`, { method: "POST" })).status, 200);
  assert.equal((await waitFor(base, upload.id)).status, "saved");
  assert.equal((await fetch(`${base}/${upload.id}/retry`, { method: "POST" })).status, 409);
  const usage = (await (await fetch(`${base}/usage`)).json()).data;
  assert.equal(usage.budget_bytes, 1024 * 1024);
  assert.equal(usage.files, 1);

  const review = (await (await fetch(`${base}?name=review.txt&auto_save=0&title=Reviewed`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "review me" })).json()).data;
  assert.equal((await waitFor(base, review.id)).status, "ready");
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM materials WHERE title = 'Reviewed'")).rows[0].n, 0);
  const saved = await fetch(`${base}/${review.id}/save`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "[Page 1]\nCorrected by the admin" }) });
  assert.equal(saved.status, 200);
  const { rows: [chunk] } = await pool.query("SELECT c.content, c.page_number FROM material_chunks c JOIN materials m ON m.id = c.material_id WHERE m.title = 'Reviewed'");
  assert.deepEqual(chunk, { content: "Corrected by the admin", page_number: 1 });
});

test("an admin whose email already exists under an old Firebase account is linked, not blocked", async () => {
  await pool.query("INSERT INTO app_users (firebase_uid, email, full_name) VALUES ('old-uid', 'ADMIN@example.invalid', 'Old')");
  const client = await pool.connect();
  try {
    const id = await ensureAdminUser(client, ADMIN);
    const { rows } = await client.query("SELECT id, firebase_uid FROM app_users");
    assert.deepEqual(rows, [{ id, firebase_uid: "admin-uid" }]);
    await assert.rejects(ensureAdminUser(client, { ...ADMIN, uid: "other", emailVerified: false }), (e) => e.code === "ADMIN_EMAIL_NOT_VERIFIED");
  } finally { client.release(); }
});

// ------------------------------------------------------------------ website: preview -> publish

test("publishing updates the live homepage content immediately and can be undone", async (t) => {
  const site = createPublicSiteHandlers({ poolProvider: () => pool, configured: () => true, cacheMs: 60_000 });
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use("/api/v1/admin/site", createAdminSiteRouter({ poolProvider: () => pool, verifyToken: allow, adminGate: pass, configured: () => true, onPublish: site.invalidate }));
  app.get("/data/site-content.json", site.content, (_req, res) => res.json({ bundled: true }));
  app.get("/media/:file", site.media, (_req, res) => res.status(404).end());
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const json = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const live = async () => (await fetch(`${base}/data/site-content.json`)).json();

  assert.deepEqual(await live(), { bundled: true }, "bundled file until something is published");
  assert.throws(() => validateSiteContent({ brand: {} }), /brand\.name/);
  // The student workspace part is optional but must have a sane shape.
  assert.doesNotThrow(() => validateSiteContent({ ...SITE, workspace: { tiles: [{ title: "My Courses", link: "#subjects" }], deadlines: { items: [] } } }));
  assert.throws(() => validateSiteContent({ ...SITE, workspace: [] }), /workspace must be an object/);
  assert.throws(() => validateSiteContent({ ...SITE, workspace: { tiles: "x" } }), /workspace\.tiles/);
  assert.throws(() => validateSiteContent({ ...SITE, workspace: { menu: [{ label: "x", link: "javascript:alert(1)" }] } }), /javascript/);
  assert.equal((await fetch(`${base}/api/v1/admin/site/publish`, json("POST", { content: { ...SITE, hero: { slides: [] } } }))).status, 400);

  const draft = structuredClone(SITE);
  draft.brand.name = "FIRE COUNSEL DRAFT";
  assert.equal((await fetch(`${base}/api/v1/admin/site/draft`, json("PUT", { content: draft }))).status, 200);
  assert.deepEqual(await live(), { bundled: true }, "a draft is not public");
  assert.equal((await (await fetch(`${base}/api/v1/admin/site`)).json()).data.draft.content.brand.name, "FIRE COUNSEL DRAFT", "the preview reads the draft");

  const first = structuredClone(SITE);
  first.brand.name = "FIRE COUNSEL LIVE";
  const published = await (await fetch(`${base}/api/v1/admin/site/publish`, json("POST", { content: first, note: "New name" }))).json();
  assert.equal((await live()).brand.name, "FIRE COUNSEL LIVE", "visible at once despite the cache");

  const second = structuredClone(SITE);
  second.brand.name = "FIRE COUNSEL TYPO";
  await fetch(`${base}/api/v1/admin/site/publish`, json("POST", { content: second }));
  const state = (await (await fetch(`${base}/api/v1/admin/site`)).json()).data;
  assert.equal(state.versions.length, 2);
  assert.equal(state.draft.content.brand.name, "FIRE COUNSEL TYPO");
  const archived = await fetch(`${base}/api/v1/admin/site/versions/${published.data.version_id}`);
  assert.equal(archived.status, 200);
  assert.deepEqual((await archived.json()).data.content, first, "restore can read the exact archive before publishing to Firebase");
  assert.equal((await live()).brand.name, "FIRE COUNSEL TYPO", "reading a version never mutates the live content");
  for (const id of ["bad-id", "00000000-0000-4000-8000-000000000000"]) {
    assert.equal((await fetch(`${base}/api/v1/admin/site/versions/${id}`)).status, 404);
  }
  assert.equal((await fetch(`${base}/api/v1/admin/site/versions/${published.data.version_id}/restore`, { method: "POST" })).status, 200);
  assert.equal((await live()).brand.name, "FIRE COUNSEL LIVE");

  // Slideshow photos are stored in Neon and served from /media.
  const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
  const image = await (await fetch(`${base}/api/v1/admin/site/images?name=slide.png`, { method: "POST", headers: { "Content-Type": "image/png" }, body: png })).json();
  assert.match(image.data.url, /^\/media\/[0-9a-f-]{36}\.png$/);
  const media = await fetch(`${base}${image.data.url}`);
  assert.equal(media.headers.get("content-type"), "image/png");
  assert.match(media.headers.get("cache-control"), /immutable/);
  assert.deepEqual(Buffer.from(await media.arrayBuffer()), png);
  assert.equal((await fetch(`${base}/api/v1/admin/site/images`, { method: "POST", body: "<svg onload=alert(1)>" })).status, 415);
  assert.equal((await fetch(`${base}/api/v1/admin/site/publish`, json("POST", { content: { ...first, hero: { slides: [{ image: "data:image/png;base64,AAAA" }] } } }))).status, 400);
});

// ------------------------------------------------------------------ Render 502 / proxy fixes

test("server keeps idle connections longer than Render's proxy (prevents random 502s)", async () => {
  process.env.FIRE_COUNSEL_NO_LISTEN = "1";
  const { applyServerTimeouts, KEEP_ALIVE_TIMEOUT_MS } = await import("../src/server.js");
  const fake = applyServerTimeouts({});
  assert.equal(fake.keepAliveTimeout, KEEP_ALIVE_TIMEOUT_MS);
  assert.ok(KEEP_ALIVE_TIMEOUT_MS >= 120_000);
  assert.ok(fake.headersTimeout > fake.keepAliveTimeout);
});

test("on Render each visitor gets their own rate-limit bucket; forged headers are ignored", async (t) => {
  assert.equal(proxyTrust({}), false);
  assert.deepEqual(proxyTrust({ RENDER: "true" }), ["loopback", "linklocal", "uniquelocal"]);
  assert.deepEqual(proxyTrust({ RENDER: "true", TRUSTED_PROXY_CIDRS: "10.0.0.1" }), ["10.0.0.1"]);
  assert.ok(createApp({ env: { RENDER: "true" }, databaseCheck: async () => true }).get("trust proxy fn"));
  const app = express();
  app.set("trust proxy", proxyTrust({ RENDER: "true" }));
  app.get("/ip", (req, res) => res.json({ ip: req.ip }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  // A visitor forges an address; Render's proxy (private hop) appends the real one.
  const body = await (await fetch(`http://127.0.0.1:${server.address().port}/ip`, { headers: { "X-Forwarded-For": "9.9.9.9, 41.58.1.2, 10.1.2.3" } })).json();
  assert.equal(body.ip, "41.58.1.2");
});

// ------------------------------------------------------------------ Counsel Working Station approvals

const stationPost = body => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
async function stationSetup(t, { env = {}, generate } = {}) {
  const station = createWorkstation({ env, generate });
  const importer = createDocumentImporter({ poolProvider: () => pool, env, generate: () => assert.fail("approval must never start another AI call") });
  const router = createAdminWorkstationRouter({ poolProvider: () => pool, verifyToken: allow, configured: () => true, env, workstation: station, importer });
  const base = await serve(t, router, "/api/v1/admin/workstation");
  async function process(body) {
    const response = await fetch(`${base}/jobs`, stationPost(body));
    assert.equal(response.status, 202);
    const { data } = await response.json(); await station.idle();
    return (await (await fetch(`${base}/jobs/${data.id}`)).json()).data;
  }
  return { base, station, process };
}

test("Working Station reads a PDF and only an explicit approval atomically stores the reviewed TXT, version and page chunks", async t => {
  const { courseId } = await seedCourse();
  let calls = 0;
  const { base, process } = await stationSetup(t, { generate: async query => {
    calls++;
    assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM uploaded_files")).rows[0].n, 0, "processing stores no original file or unapproved text");
    assert.match(query.messages[0].text, /Correct OCR/);
    return { text: "[Page 1]\nAI corrected text for administrator review.", provider: "cloudflare", model: "test" };
  } });
  const pdf = await makePdf(["This is a sufficiently long source PDF page with a digital text layer and a legal citation [1932] AC 562."]);
  const done = await process({ operation: "correct", instructions: "Correct OCR", attachment: { name: "source.pdf", mimeType: "application/pdf", data: pdf.toString("base64") } });
  assert.equal(done.status, "ready"); assert.match(done.result.source_text, /\[1932\] AC 562/);
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM materials")).rows[0].n, 0);
  const body = { approved: true, text: "[Page 1]\nHuman-reviewed final text with [1932] AC 562.", title: "Reviewed judgment", course_id: courseId, material_type: "case_material", publish: false };
  assert.equal((await fetch(`${base}/jobs/${done.id}/save`, stationPost({ ...body, approved: false }))).status, 400);
  const [first, second] = await Promise.all([fetch(`${base}/jobs/${done.id}/save`, stationPost(body)), fetch(`${base}/jobs/${done.id}/save`, stationPost(body))]);
  assert.equal(first.status, 200); assert.equal(second.status, 200);
  const saved = (await first.json()).data;
  assert.equal(saved.version_number, 1); assert.equal(calls, 1);
  const { rows: [file] } = await pool.query("SELECT * FROM uploaded_files");
  assert.equal(file.id, done.id); assert.equal(file.file_name, "Reviewed judgment.txt");
  assert.equal(file.mime_type, "text/plain"); assert.equal(Buffer.from(file.data).toString("utf8"), body.text);
  assert.equal(file.status, "saved"); assert.equal(file.extracted_text, body.text);
  assert.equal(JSON.stringify(file.options).includes("Correct OCR"), false, "chat instructions are not persisted");
  const { rows: [material] } = await pool.query("SELECT * FROM materials");
  assert.equal(material.publication_status, "draft"); assert.equal(material.approval_status, "pending"); assert.equal(material.course_id, courseId);
  assert.equal((await pool.query("SELECT extracted_text FROM material_versions")).rows[0].extracted_text, body.text);
  const { rows: [chunk] } = await pool.query("SELECT page_number, content FROM material_chunks");
  assert.equal(chunk.page_number, 1); assert.match(chunk.content, /Human-reviewed/);
  assert.equal((await fetch(`${base}/jobs/${done.id}/save`, stationPost(body))).status, 200);
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM uploaded_files")).rows[0].n, 1);
});

test("Working Station preserves earlier material versions, and a failed approval rolls back every write", async t => {
  const { base, process } = await stationSetup(t);
  const first = await process({ operation: "extract", text: "[Page 1]\nOriginal preserved text." });
  const body = { approved: true, text: first.result.text, title: "Course notes", publish: true };
  const created = (await (await fetch(`${base}/jobs/${first.id}/save`, stationPost(body))).json()).data;
  const next = await process({ operation: "extract", text: "[Page 1]\nUpdated reviewed text." });
  const saved = await fetch(`${base}/jobs/${next.id}/save`, stationPost({ ...body, text: next.result.text, purpose: "material_version", material_id: created.material_id }));
  assert.equal(saved.status, 200); assert.equal((await saved.json()).data.version_number, 2);
  const { rows } = await pool.query("SELECT version_number, extracted_text FROM material_versions WHERE material_id = $1 ORDER BY version_number", [created.material_id]);
  assert.deepEqual(rows.map(row => row.extracted_text), [first.result.text, next.result.text]);
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM materials")).rows[0].n, 1);
  const rejected = await process({ operation: "extract", text: "This draft should not enter the database." });
  const invalid = await fetch(`${base}/jobs/${rejected.id}/save`, stationPost({ ...body, text: rejected.result.text, course_id: "11111111-1111-4111-8111-111111111111" }));
  assert.equal(invalid.status, 404);
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM uploaded_files WHERE id = $1", [rejected.id])).rows[0].n, 0, "upload insert rolled back with the failed library write");
  assert.equal((await (await fetch(`${base}/jobs/${rejected.id}`)).json()).data.status, "ready", "draft remains available for corrected approval");
});

test("Working Station enforces the existing Neon storage budget before approval", async t => {
  const { base, process } = await stationSetup(t, { env: { FILE_STORAGE_LIMIT_MB: "1" } });
  const job = await process({ operation: "extract", text: "Small working draft" });
  const response = await fetch(`${base}/jobs/${job.id}/save`, stationPost({ approved: true, title: "Too large", text: "漢".repeat(359_000) }));
  assert.equal(response.status, 507);
  assert.equal((await response.json()).code, "STORAGE_FULL");
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM uploaded_files")).rows[0].n, 0);
});
