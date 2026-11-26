// Background import of uploaded documents into the Neon library.
//
// The upload request returns at once (Render's proxy would cut a long request);
// this queue then reads the file (see extract.js) and saves the result in ONE
// transaction:
//   material          -> materials row + version + page-numbered chunks
//   material_version  -> new version (+ chunks) of an existing material
//   case              -> the judgment is stored as a material, and the AI fills
//                        the legal_cases fields (or only the empty fields of an
//                        existing case)
//   past_questions    -> the paper is stored as a material, and the AI splits
//                        it into past_questions rows for the question setter
import { createHash } from "node:crypto";
import { getPool } from "../../config/database.js";
import { ensureAdminUser } from "../../routes/adminDatabase.js";
import { parseJsonReply } from "../ai/providers.js";
import { adminExtractionEnv, generateAdmin as defaultGenerate } from "./adminProviders.js";
import { chunkPages, extractDocument, pagesToText, textToPages } from "./extract.js";

const STALE_MINUTES = 20;
const MAX_TEXT = 2_000_000;

const CASE_READER = `You read Nigerian and Commonwealth court judgments and law reports and fill a case record. Use ONLY the supplied text; leave a field empty ("") when the text does not state it. Never invent a citation.
Respond with JSON only:
{"case_name":"","citation":"","court":"","jurisdiction":"","year":null,"subject_area":"","material_facts":"","legal_issues":"","decision":"","ratio_decidendi":"","obiter_dicta":""}
material_facts, legal_issues, decision, ratio_decidendi and obiter_dicta should be clear summaries (one to three paragraphs each) in the court's own terms.`;

const PAPER_READER = `You split a university law examination paper into its questions. Copy each question's full text exactly (including the facts of problem questions and all sub-parts (a), (b)...). Do not answer or shorten anything. Put general instructions (rubric) only in "instructions".
Respond with JSON only:
{"examination_year":null,"semester":"","duration_minutes":null,"instructions":"","questions":[{"question_number":"1","question_text":"","marks":null}]}`;

const CASE_FIELDS = ["case_name", "citation", "court", "jurisdiction", "year", "subject_area", "material_facts", "legal_issues", "decision", "ratio_decidendi", "obiter_dicta"];
const FIELD_LIMITS = { case_name: 500, citation: 4_000, court: 255, jurisdiction: 255, subject_area: 255 };

const DEFAULT_TYPE = { material: "lecture_note", material_version: "lecture_note", case: "case_material", past_questions: "past_question" };
const MATERIAL_TYPES = new Set(["lecture_note", "textbook", "handout", "case_material", "statute", "past_question", "marking_scheme", "course_outline", "model_answer", "other"]);

class ImportError extends Error {
  constructor(message, code, status = 422) { super(message); this.code = code; this.status = /NOT_FOUND$/.test(code) ? 404 : status; }
}

const titleFrom = (name) => String(name || "Document").replace(/\.[a-z0-9]{1,5}$/i, "").replace(/[_]+/g, " ").trim().slice(0, 250) || "Document";
const textValue = (value, max = 30_000) => (typeof value === "string" ? value.trim().slice(0, max) : typeof value === "number" ? String(value) : "");

function cleanCase(parsed) {
  const out = {};
  for (const key of CASE_FIELDS) {
    if (key === "year") {
      const year = Number.parseInt(parsed?.year, 10);
      if (year >= 1000 && year <= 3000) out.year = year;
      continue;
    }
    const value = textValue(parsed?.[key], FIELD_LIMITS[key] || 30_000);
    if (value) out[key] = value;
  }
  return out;
}

export function createDocumentImporter({
  poolProvider = getPool,
  env = process.env,
  generate = defaultGenerate,
  extract = extractDocument,
  fetchImpl
} = {}) {
  const queue = [];
  let running = false;
  let current = null;
  let idleWaiters = [];
  const gen = (request) => generate(request, { env, fetchImpl });

  async function setProgress(db, id, progress) {
    try { await db.query("UPDATE uploaded_files SET progress = $2, updated_at = NOW() WHERE id = $1", [id, String(progress).slice(0, 200)]); } catch { /* progress is cosmetic */ }
  }

  async function runTransaction(work) {
    const client = await poolProvider().connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* keep original */ }
      throw error;
    } finally {
      client.release();
    }
  }

  async function addVersion(client, { materialId, fileId, actorId, pages, fullText }) {
    const next = await client.query("SELECT COALESCE(MAX(version_number), 0) + 1 AS n FROM material_versions WHERE material_id = $1", [materialId]);
    const versionNumber = Number(next.rows[0].n);
    const version = await client.query(
      `INSERT INTO material_versions (material_id, version_number, file_storage_path, extracted_text, extraction_status, uploaded_by)
       VALUES ($1, $2, $3, $4, 'completed', $5) RETURNING id`,
      [materialId, versionNumber, fileId ? `neon:uploaded_files/${fileId}` : null, fullText.slice(0, MAX_TEXT), actorId]);
    const chunks = chunkPages(pages);
    for (let index = 0; index < chunks.length; index++) {
      await client.query(
        `INSERT INTO material_chunks (material_id, version_id, chunk_number, content, page_number, token_count, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [materialId, version.rows[0].id, index, chunks[index].content, chunks[index].page, Math.ceil(chunks[index].content.length / 4), JSON.stringify({ source: "upload", file_id: fileId || null })]);
    }
    return { version_id: version.rows[0].id, version_number: versionNumber, chunks: chunks.length };
  }

  async function createMaterial(client, { row, options, actorId, materialType, scope, category }) {
    let universityId = null;
    if (options.course_id) {
      const course = await client.query("SELECT id, university_id FROM courses WHERE id = $1", [options.course_id]);
      if (!course.rows.length) throw new ImportError("The chosen course no longer exists.", "COURSE_NOT_FOUND");
      universityId = course.rows[0].university_id;
    }
    const publish = options.publish !== false;
    const title = textValue(options.title, 250) || titleFrom(row.file_name);
    const result = await client.query(
      `INSERT INTO materials (university_id, course_id, topic_id, uploaded_by, title, material_type, source_category,
                              original_file_name, file_storage_path, file_mime_type, file_size_bytes, access_scope,
                              approval_status, publication_status, approved_by, approved_at, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16)
       RETURNING id, title`,
      [universityId, options.course_id || null, options.topic_id || null, actorId, title, materialType, category,
        row.file_name, `neon:uploaded_files/${row.id}`, row.mime_type, row.size_bytes, scope,
        publish ? "approved" : "pending", publish ? "published" : "draft", publish ? actorId : null, publish ? new Date() : null]);
    return result.rows[0];
  }

  /** Saves extracted text into the library according to the upload purpose. */
  async function saveToLibrary(row, fullText, aiInfo, transaction = null) {
    const options = row.options || {};
    const actor = options._actor || {};
    const pages = textToPages(fullText).filter((page) => page.text);
    if (!pages.length) throw new ImportError("There is no text to save.", "NO_TEXT");
    const purpose = row.purpose;
    const materialType = MATERIAL_TYPES.has(options.material_type) ? options.material_type : DEFAULT_TYPE[purpose];

    // AI reading of cases and papers happens before the transaction (it is slow).
    let caseFields = null;
    let paper = null;
    if (purpose === "case") {
      aiInfo.progress("Filling in the case details with AI…");
      try {
        const reply = await gen({ json: true, system: CASE_READER, messages: [{ role: "user", text: `JUDGMENT TEXT:\n${fullText.slice(0, 120_000)}` }], maxTokens: 8192, temperature: 0 });
        caseFields = cleanCase(parseJsonReply(reply.text) || {});
      } catch (error) {
        aiInfo.warnings.push(`The AI could not fill the case details (${error.code || "error"}); the judgment text was still saved. Fill the case fields by hand.`);
        caseFields = {};
      }
      if (!caseFields.case_name && !options.case_id) caseFields.case_name = textValue(options.title, 500) || titleFrom(row.file_name);
    }
    if (purpose === "past_questions") {
      aiInfo.progress("Splitting the paper into questions with AI…");
      const reply = await gen({ json: true, system: PAPER_READER, messages: [{ role: "user", text: `EXAMINATION PAPER:\n${fullText.slice(0, 120_000)}` }], maxTokens: 16384, temperature: 0 });
      paper = parseJsonReply(reply.text) || {};
      const questions = (Array.isArray(paper.questions) ? paper.questions : []).filter((q) => textValue(q?.question_text).length >= 5);
      if (!questions.length) throw new ImportError("The AI could not find any questions in this paper. Check that it is the right file, then retry.", "NO_QUESTIONS");
      paper.questions = questions.slice(0, 60);
    }

    aiInfo.progress("Saving to Neon…");
    const write = async (client) => {
      const actorId = await ensureAdminUser(client, actor);
      if (purpose === "material_version") {
        const material = await client.query("SELECT id, title FROM materials WHERE id = $1 FOR UPDATE", [options.material_id]);
        if (!material.rows.length) throw new ImportError("The material was deleted, so this version cannot be added.", "MATERIAL_NOT_FOUND");
        const version = await addVersion(client, { materialId: options.material_id, fileId: row.id, actorId, pages, fullText });
        await client.query("UPDATE materials SET updated_at = NOW() WHERE id = $1", [options.material_id]);
        return { material_id: options.material_id, title: material.rows[0].title, ...version };
      }

      const scope = purpose === "case" || !options.course_id ? "platform" : "institution";
      const category = purpose === "case" ? "legal_authority" : "lecturer_material";
      const material = await createMaterial(client, { row, options, actorId, materialType, scope, category });
      const version = await addVersion(client, { materialId: material.id, fileId: row.id, actorId, pages, fullText });
      const result = { material_id: material.id, title: material.title, ...version };

      if (purpose === "case") {
        if (options.case_id) {
          const existing = await client.query("SELECT * FROM legal_cases WHERE id = $1 FOR UPDATE", [options.case_id]);
          if (!existing.rows.length) throw new ImportError("The chosen case no longer exists.", "CASE_NOT_FOUND");
          const current = existing.rows[0];
          // Only fill empty fields: never overwrite what an admin typed.
          const fill = Object.entries(caseFields).filter(([key]) => current[key] == null || current[key] === "");
          const sets = ["source_material_id = $2", "updated_at = NOW()", ...fill.map(([key], index) => `${key} = $${index + 3}`)];
          await client.query(`UPDATE legal_cases SET ${sets.join(", ")} WHERE id = $1`, [options.case_id, material.id, ...fill.map(([, value]) => value)]);
          result.case_id = options.case_id;
          result.case_name = current.case_name;
          result.filled = fill.map(([key]) => key);
        } else {
          const keys = Object.keys(caseFields);
          const inserted = await client.query(
            `INSERT INTO legal_cases (${keys.join(", ")}, source_material_id, verification_status)
             VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}, $${keys.length + 1}, 'unverified') RETURNING id, case_name`,
            [...keys.map((key) => caseFields[key]), material.id]);
          result.case_id = inserted.rows[0].id;
          result.case_name = inserted.rows[0].case_name;
        }
      }

      if (purpose === "past_questions") {
        const course = await client.query("SELECT university_id FROM courses WHERE id = $1", [options.course_id]);
        const year = Number.parseInt(options.examination_year || paper.examination_year, 10);
        const semester = textValue(options.semester, 50) || textValue(paper.semester, 50) || null;
        const duration = Number.parseInt(paper.duration_minutes, 10);
        let count = 0;
        for (const [index, question] of paper.questions.entries()) {
          const marks = Number(question.marks);
          const text = textValue(question.question_text);
          await client.query(
            `INSERT INTO past_questions (university_id, course_id, uploaded_by, examination_year, semester, question_number, question_text, marks,
                                         examination_duration_minutes, source_material_id, provenance, verification_status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'verified_past_question', 'pending')`,
            [course.rows[0]?.university_id || null, options.course_id, actorId, year >= 1000 && year <= 3000 ? year : null, semester,
              textValue(question.question_number, 50) || String(index + 1),
              text,
              Number.isFinite(marks) && marks >= 0 ? marks : null, duration > 0 && duration <= 2000 ? duration : null, material.id]);
          count++;
        }
        result.questions = count;
        if (textValue(paper.instructions)) result.instructions = textValue(paper.instructions, 2_000);
      }
      return result;
    };
    return transaction ? write(transaction) : runTransaction(write);
  }

  async function processOne(id) {
    const db = poolProvider();
    const claimed = await db.query(
      `UPDATE uploaded_files SET status = 'processing', started_at = NOW(), updated_at = NOW(), attempts = attempts + 1,
              progress = 'Starting…', error_code = NULL, error_message = NULL
        WHERE id = $1 AND status = 'uploaded' RETURNING *`, [id]);
    const row = claimed.rows[0];
    if (!row) return;
    const warnings = Array.isArray(row.warnings) ? [...row.warnings] : [];
    current = id;
    try {
      // A retry after a save error reuses the text already read (no second OCR bill).
      let fullText = row.extracted_text;
      if (!fullText) {
        warnings.length = 0;
        const buffer = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data || []);
        if (!buffer.length) throw new ImportError("The original file was deleted, so it cannot be read again.", "FILE_DELETED");
        const extraction = await extract({ buffer, mimeType: row.mime_type, name: row.file_name }, { env: adminExtractionEnv(env), generate: (request) => gen(request), fetchImpl, onProgress: (text) => setProgress(db, id, text) });
        fullText = pagesToText(extraction.pages);
        warnings.push(...extraction.warnings);
        await db.query(
          `UPDATE uploaded_files SET extracted_text = $2, method = $3, page_count = $4, characters = $5, warnings = $6::jsonb, updated_at = NOW() WHERE id = $1`,
          [id, fullText.slice(0, MAX_TEXT), extraction.method, extraction.pageCount, extraction.characters, JSON.stringify(warnings)]);
      }
      if (row.options?.auto_save === false) {
        await db.query("UPDATE uploaded_files SET status = 'ready', progress = 'Text ready for review', finished_at = NOW(), updated_at = NOW() WHERE id = $1", [id]);
        return;
      }
      const result = await saveToLibrary(row, fullText, { warnings, progress: (text) => setProgress(db, id, text) });
      await db.query(
        `UPDATE uploaded_files SET status = 'saved', progress = 'Saved to the library', result = $2::jsonb, warnings = $3::jsonb, finished_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [id, JSON.stringify(result), JSON.stringify(warnings)]);
    } catch (error) {
      const code = error?.code && /^[A-Z_]{3,40}$/.test(error.code) ? error.code : "IMPORT_FAILED";
      const message = error?.status || error instanceof ImportError || code !== "IMPORT_FAILED"
        ? String(error.message).slice(0, 500)
        : "The document could not be saved. Tap Retry; if it fails again, check the file.";
      if (code === "IMPORT_FAILED") console.error("Document import failed:", error?.name, error?.message);
      await db.query(
        `UPDATE uploaded_files SET status = 'failed', progress = NULL, error_code = $2, error_message = $3, warnings = $4::jsonb, finished_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [id, code, message, JSON.stringify(warnings)]).catch(() => {});
    } finally {
      current = null;
    }
  }

  async function drain() {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        const id = queue.shift();
        try { await processOne(id); } catch (error) { console.error("Document queue error:", error?.message); }
      }
    } finally {
      running = false;
      const waiters = idleWaiters;
      idleWaiters = [];
      waiters.forEach((resolve) => resolve());
    }
  }

  return {
    enqueue(id) {
      if (!queue.includes(id)) queue.push(id);
      setImmediate(drain);
    },
    /** Atomic, idempotent approval from Counsel Working Station. The source
     * PDF/chat stays temporary; only the reviewed TXT and its versions/chunks
     * enter Neon. Material/version purposes never make another AI call. */
    async saveReviewed({ id, actor, text, options, name, warnings = [] }) {
      if (!["material", "material_version"].includes(options.purpose)) throw new ImportError("Choose a material or a new material version.", "VALIDATION_ERROR", 400);
      if (!text?.trim() || text.length > MAX_TEXT) throw new ImportError("Review a nonempty document within the text limit.", "VALIDATION_ERROR", 400);
      const buffer = Buffer.from(text, "utf8");
      return runTransaction(async (client) => {
        // Serializes budget checks and double approvals, including across API
        // processes. No model/network request runs while this lock is held.
        await client.query("LOCK TABLE uploaded_files IN SHARE ROW EXCLUSIVE MODE");
        const previous = await client.query("SELECT uploaded_by, status, result FROM uploaded_files WHERE id = $1", [id]);
        if (previous.rows.length) {
          const row = previous.rows[0];
          if (row.uploaded_by !== actor.uid || row.status !== "saved") throw new ImportError("That approval cannot be reused.", "APPROVAL_CONFLICT", 409);
          return { upload_id: id, ...row.result, already_saved: true };
        }
        const budget = Math.max(Number(env.FILE_STORAGE_LIMIT_MB) || 350, 1) * 1024 * 1024;
        const usage = await client.query(`SELECT (SELECT COALESCE(SUM(size_bytes), 0) FROM uploaded_files WHERE data IS NOT NULL)::bigint
          + (SELECT COALESCE(SUM(size_bytes), 0) FROM site_images)::bigint AS used`);
        if (Number(usage.rows[0].used) + buffer.length > budget) throw new ImportError("Neon file storage is full. Download the TXT and free space before saving.", "STORAGE_FULL", 507);
        const storedOptions = { ...options, _actor: actor, source: "counsel_working_station" };
        const inserted = await client.query(
          `INSERT INTO uploaded_files (id, purpose, file_name, mime_type, size_bytes, sha256, data, status, method, extracted_text, characters, options, uploaded_by, uploaded_by_email)
           VALUES ($1, $2, $3, 'text/plain', $4, $5, $6, 'ready', 'admin_workstation', $7, $8, $9::jsonb, $10, $11) RETURNING *`,
          [id, options.purpose, name, buffer.length, createHash("sha256").update(buffer).digest("hex"), buffer, text, text.length, JSON.stringify(storedOptions), actor.uid, actor.email || null]);
        const row = inserted.rows[0];
        const result = await saveToLibrary(row, text, { warnings, progress: () => {} }, client);
        await client.query(`UPDATE uploaded_files SET status = 'saved', progress = 'Reviewed text saved to the library', result = $2::jsonb,
          warnings = $3::jsonb, finished_at = NOW(), updated_at = NOW() WHERE id = $1`, [id, JSON.stringify(result), JSON.stringify(warnings)]);
        return { upload_id: id, ...result };
      });
    },
    /** Saves (possibly edited) text of a "ready" upload into the library. */
    async saveReady(row, text) {
      const warnings = [];
      const db = poolProvider();
      const result = await saveToLibrary(row, text, { warnings, progress: () => {} });
      await db.query(
        `UPDATE uploaded_files SET status = 'saved', progress = 'Saved to the library', extracted_text = $2, result = $3::jsonb, warnings = $4::jsonb, finished_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [row.id, text.slice(0, MAX_TEXT), JSON.stringify(result), JSON.stringify([...(row.warnings || []), ...warnings])]);
      return result;
    },
    /** Jobs cut off by a restart (Render sleeps/redeploys) are marked failed so they can be retried. */
    async markStale(db = poolProvider()) {
      await db.query(
        `UPDATE uploaded_files SET status = 'failed', progress = NULL, error_code = 'INTERRUPTED',
                error_message = 'The server restarted while reading this file. Tap Retry.', finished_at = NOW(), updated_at = NOW()
          WHERE status IN ('uploaded', 'processing') AND updated_at < NOW() - make_interval(mins => $1)
            AND NOT (id = ANY($2::uuid[]))`, [STALE_MINUTES, [...queue, current].filter(Boolean)]);
    },
    idle() { return running || queue.length ? new Promise((resolve) => idleWaiters.push(resolve)) : Promise.resolve(); },
    queued: () => queue.length + (running ? 1 : 0)
  };
}
