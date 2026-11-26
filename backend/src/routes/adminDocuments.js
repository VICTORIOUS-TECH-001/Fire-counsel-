// Admin document uploads (PDF, Word, photos, text) into the Neon library.
// The file is sent as the raw request body (no base64, so phones can send
// bigger files); details go in the query string. Reading happens in the
// background — poll GET /:id for progress.
import { createHash } from "node:crypto";
import express from "express";
import { getPool } from "../config/database.js";
import { verifyFirebaseToken } from "../middleware/verifyFirebaseToken.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { createAdminRequestGate } from "../middleware/adminRateLimit.js";
import { describeAdminProviders } from "../services/documents/adminProviders.js";
import { sniffType } from "../services/documents/extract.js";
import { createDocumentImporter } from "../services/documents/importer.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PURPOSES = new Set(["material", "case", "past_questions", "material_version"]);
const MATERIAL_TYPES = new Set(["lecture_note", "textbook", "handout", "case_material", "statute", "past_question", "marking_scheme", "course_outline", "model_answer", "other"]);
const LIST_COLUMNS = `id, purpose, file_name, mime_type, size_bytes, status, progress, method, page_count, characters, warnings, options, result,
  error_code, error_message, attempts, uploaded_by_email, created_at, updated_at, finished_at, (data IS NOT NULL) AS has_file`;

const fail = (res, status, error, code, extra = {}) => res.status(status).json({ error, code, ...extra });

function publicRow(row) {
  if (!row) return row;
  const { _actor, ...options } = row.options || {};
  const out = { ...row, options };
  delete out.data;
  delete out.extracted_text;
  if (row.extracted_text != null) out.text = row.extracted_text;
  return out;
}

function handle(res, error) {
  if (error?.code === "42P01" || error?.code === "42703") return fail(res, 503, "The upload tables are not in Neon yet. Run the \"Neon database migration\" workflow on GitHub once, then try again.", "UPLOADS_SCHEMA_NOT_READY");
  if (error?.message === "DATABASE_URL is not configured.") return fail(res, 503, "Neon is not configured on this server.", "DATABASE_NOT_CONFIGURED");
  if (error?.status && error?.code) return fail(res, error.status, error.message, error.code);
  console.error("Document upload request failed:", error?.code || error?.message);
  return fail(res, 500, "The upload request could not be completed. Try again.", "DATABASE_ERROR");
}

export function createAdminDocumentsRouter({
  poolProvider = getPool,
  verifyToken = verifyFirebaseToken,
  adminGate = requireAdmin,
  requestGate = createAdminRequestGate(),
  configured = () => Boolean(process.env.DATABASE_URL),
  env = process.env,
  importer = null
} = {}) {
  const router = express.Router();
  const jobs = importer || createDocumentImporter({ poolProvider, env });
  const maxFileBytes = Math.min(Math.max(Number(env.DOCUMENT_MAX_FILE_MB) || 25, 1), 60) * 1024 * 1024;
  const budgetBytes = Math.max(Number(env.FILE_STORAGE_LIMIT_MB) || 350, 1) * 1024 * 1024;
  let staleChecked = 0;

  router.use(verifyToken, adminGate, requestGate);
  router.use((_req, res, next) => (configured() ? next() : fail(res, 503, "Neon is not configured on this server.", "DATABASE_NOT_CONFIGURED")));

  async function usedBytes(db) {
    const { rows } = await db.query(
      `SELECT (SELECT COALESCE(SUM(size_bytes), 0) FROM uploaded_files WHERE data IS NOT NULL)::bigint
            + (SELECT COALESCE(SUM(size_bytes), 0) FROM site_images)::bigint AS used,
              (SELECT COUNT(*) FROM uploaded_files WHERE data IS NOT NULL)::int AS files`);
    return { used: Number(rows[0].used), files: rows[0].files };
  }

  async function sweepStale(db) {
    if (Date.now() - staleChecked < 60_000) return;
    staleChecked = Date.now();
    try { await jobs.markStale(db); } catch { /* listing still works */ }
  }

  router.get("/usage", async (_req, res) => {
    try {
      const { used, files } = await usedBytes(poolProvider());
      res.json({ data: {
        used_bytes: used, budget_bytes: budgetBytes, files, max_file_bytes: maxFileBytes,
        ocr: { ai: describeAdminProviders(env).gemini.configured, admin_only: true, ocr_space: Boolean(String(env.OCR_SPACE_API_KEY || "").trim()) },
        queue: jobs.queued?.() || 0
      } });
    } catch (error) { handle(res, error); }
  });

  router.get("/", async (req, res) => {
    try {
      const db = poolProvider();
      await sweepStale(db);
      const where = [];
      const values = [];
      if (PURPOSES.has(req.query.purpose)) { values.push(req.query.purpose); where.push(`purpose = $${values.length}`); }
      const materialId = UUID_RE.test(req.query.material_id || "") ? req.query.material_id : null;
      if (materialId) { values.push(materialId); where.push(`(options->>'material_id' = $${values.length} OR result->>'material_id' = $${values.length})`); }
      const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 30, 1), 100);
      values.push(limit);
      const { rows } = await db.query(`SELECT ${LIST_COLUMNS} FROM uploaded_files ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT $${values.length}`, values);
      res.json({ data: rows.map(publicRow) });
    } catch (error) { handle(res, error); }
  });

  // Query: purpose, name, course_id, topic_id, material_type, title, publish=0,
  // material_id, case_id, semester, examination_year, auto_save=0, allow_duplicate=1.
  router.post("/", express.raw({ type: () => true, limit: maxFileBytes }), async (req, res) => {
    try {
      const q = req.query;
      const purpose = PURPOSES.has(q.purpose) ? q.purpose : q.purpose == null ? "material" : null;
      if (!purpose) return fail(res, 400, "Choose what this file is: material, case, past_questions or material_version.", "VALIDATION_ERROR");
      const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!buffer.length) return fail(res, 400, "Choose a file to upload.", "VALIDATION_ERROR");
      const name = String(q.name || "document").replace(/[\u0000-\u001f\u007f/\\]/g, "_").trim().slice(0, 200) || "document";
      const mimeType = sniffType(buffer, name, String(req.get("content-type") || "").split(";")[0].trim().toLowerCase());
      if (!mimeType) return fail(res, 415, "Upload a PDF, Word (.docx), photo (JPG, PNG, WEBP) or .txt file.", "UNSUPPORTED_FILE");

      const options = {};
      for (const key of ["course_id", "topic_id", "material_id", "case_id"]) {
        if (q[key] == null || q[key] === "") continue;
        if (!UUID_RE.test(q[key])) return fail(res, 400, `${key} is not a valid id.`, "VALIDATION_ERROR");
        options[key] = q[key];
      }
      if (q.material_type) {
        if (!MATERIAL_TYPES.has(q.material_type)) return fail(res, 400, "Unknown material type.", "VALIDATION_ERROR");
        options.material_type = q.material_type;
      }
      if (typeof q.title === "string" && q.title.trim()) options.title = q.title.trim().slice(0, 250);
      if (typeof q.semester === "string" && q.semester.trim()) options.semester = q.semester.trim().slice(0, 50);
      const year = Number.parseInt(q.examination_year, 10);
      if (year >= 1000 && year <= 3000) options.examination_year = year;
      if (q.publish === "0" || q.publish === "false") options.publish = false;
      if (q.auto_save === "0" || q.auto_save === "false") options.auto_save = false;
      if (purpose === "past_questions" && !options.course_id) return fail(res, 400, "Choose the course this past-question paper belongs to.", "VALIDATION_ERROR");
      if (purpose === "material_version" && !options.material_id) return fail(res, 400, "Open the material first, then upload its new version.", "VALIDATION_ERROR");

      const db = poolProvider();
      const checks = [
        ["course_id", "courses", "The chosen course was not found.", "COURSE_NOT_FOUND"],
        ["topic_id", "course_topics", "The chosen topic was not found.", "NOT_FOUND"],
        ["material_id", "materials", "The chosen material was not found.", "MATERIAL_NOT_FOUND"],
        ["case_id", "legal_cases", "The chosen case was not found.", "CASE_NOT_FOUND"]
      ];
      for (const [key, table, message, code] of checks) {
        if (!options[key]) continue;
        const found = await db.query(`SELECT 1 FROM ${table} WHERE id = $1`, [options[key]]);
        if (!found.rows.length) return fail(res, 404, message, code);
      }

      const { used } = await usedBytes(db);
      if (used + buffer.length > budgetBytes) {
        return fail(res, 507, `File storage is full (${Math.round(used / 1048576)} of ${Math.round(budgetBytes / 1048576)} MB used). Delete original files you no longer need (the library text stays), or raise FILE_STORAGE_LIMIT_MB in Render.`, "STORAGE_FULL");
      }
      const sha256 = createHash("sha256").update(buffer).digest("hex");
      if (q.allow_duplicate !== "1") {
        const dup = await db.query(
          `SELECT ${LIST_COLUMNS} FROM uploaded_files WHERE sha256 = $1 AND purpose = $2 AND status <> 'failed'
             AND COALESCE(options->>'material_id', '') = COALESCE($3, '') ORDER BY created_at DESC LIMIT 1`,
          [sha256, purpose, options.material_id || null]);
        if (dup.rows.length) return fail(res, 409, "This exact file was already uploaded for this purpose.", "DUPLICATE_FILE", { data: publicRow(dup.rows[0]) });
      }

      options._actor = { uid: req.user.uid, email: req.user.email, name: req.user.name || null, emailVerified: req.user.emailVerified === true };
      const { rows } = await db.query(
        `INSERT INTO uploaded_files (purpose, file_name, mime_type, size_bytes, sha256, data, options, uploaded_by, uploaded_by_email, progress)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, 'Waiting to be read…') RETURNING ${LIST_COLUMNS}`,
        [purpose, name, mimeType, buffer.length, sha256, buffer, JSON.stringify(options), req.user.uid, req.user.email || null]);
      jobs.enqueue(rows[0].id);
      res.status(202).json({ data: publicRow(rows[0]) });
    } catch (error) { handle(res, error); }
  });

  router.get("/:id", async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return fail(res, 404, "Upload not found.", "NOT_FOUND");
    try {
      const { rows } = await poolProvider().query(`SELECT ${LIST_COLUMNS}, extracted_text FROM uploaded_files WHERE id = $1`, [req.params.id]);
      if (!rows.length) return fail(res, 404, "Upload not found.", "NOT_FOUND");
      res.json({ data: publicRow(rows[0]) });
    } catch (error) { handle(res, error); }
  });

  router.post("/:id/retry", async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return fail(res, 404, "Upload not found.", "NOT_FOUND");
    try {
      const reread = req.query.reread === "1";
      const { rows } = await poolProvider().query(
        `UPDATE uploaded_files SET status = 'uploaded', progress = 'Waiting to be read…', error_code = NULL, error_message = NULL,
                extracted_text = CASE WHEN $2 THEN NULL ELSE extracted_text END, updated_at = NOW()
          WHERE id = $1 AND status = 'failed' AND (data IS NOT NULL OR (extracted_text IS NOT NULL AND NOT $2)) RETURNING ${LIST_COLUMNS}`,
        [req.params.id, reread]);
      if (!rows.length) return fail(res, 409, "Only failed uploads whose file is still stored can be retried.", "NOT_RETRYABLE");
      jobs.enqueue(req.params.id);
      res.json({ data: publicRow(rows[0]) });
    } catch (error) { handle(res, error); }
  });

  // Save the (optionally corrected) text of an upload made with auto_save=0.
  router.post("/:id/save", async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return fail(res, 404, "Upload not found.", "NOT_FOUND");
    try {
      const { rows } = await poolProvider().query("SELECT * FROM uploaded_files WHERE id = $1", [req.params.id]);
      const row = rows[0];
      if (!row) return fail(res, 404, "Upload not found.", "NOT_FOUND");
      if (row.status !== "ready") return fail(res, 409, "Only uploads waiting for review can be saved.", "NOT_READY");
      const text = typeof req.body?.text === "string" && req.body.text.trim() ? req.body.text.replace(/\r\n/g, "\n") : row.extracted_text;
      if (!text?.trim()) return fail(res, 400, "There is no text to save.", "VALIDATION_ERROR");
      const result = await jobs.saveReady(row, text);
      res.json({ data: { id: row.id, status: "saved", result } });
    } catch (error) { handle(res, error); }
  });

  router.get("/:id/file", async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return fail(res, 404, "Upload not found.", "NOT_FOUND");
    try {
      const { rows } = await poolProvider().query("SELECT file_name, mime_type, data FROM uploaded_files WHERE id = $1", [req.params.id]);
      if (!rows.length || !rows[0].data) return fail(res, 404, "The original file is not stored any more.", "NOT_FOUND");
      res.set("Content-Type", rows[0].mime_type);
      res.set("Content-Disposition", `attachment; filename="${rows[0].file_name.replace(/[^\w .-]/g, "_")}"`);
      res.set("X-Content-Type-Options", "nosniff");
      res.send(Buffer.isBuffer(rows[0].data) ? rows[0].data : Buffer.from(rows[0].data));
    } catch (error) { handle(res, error); }
  });

  // Frees space: deletes the original file (the saved library text stays).
  // ?remove=1 also removes the upload from this list.
  router.delete("/:id", async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return fail(res, 404, "Upload not found.", "NOT_FOUND");
    try {
      const db = poolProvider();
      const sql = req.query.remove === "1"
        ? "DELETE FROM uploaded_files WHERE id = $1 AND status NOT IN ('uploaded', 'processing') RETURNING id"
        : "UPDATE uploaded_files SET data = NULL, updated_at = NOW() WHERE id = $1 AND status NOT IN ('uploaded', 'processing') RETURNING id";
      const { rows } = await db.query(sql, [req.params.id]);
      if (!rows.length) {
        const exists = await db.query("SELECT status FROM uploaded_files WHERE id = $1", [req.params.id]);
        if (!exists.rows.length) return fail(res, 404, "Upload not found.", "NOT_FOUND");
        return fail(res, 409, "Wait until this file has finished reading.", "NOT_DELETABLE");
      }
      res.status(204).end();
    } catch (error) { handle(res, error); }
  });

  router.use((error, _req, res, next) => {
    if (error?.type === "entity.too.large") return fail(res, 413, `This file is larger than ${Math.round(maxFileBytes / 1048576)} MB. Split the PDF or compress it.`, "FILE_TOO_LARGE");
    return next(error);
  });

  return router;
}
