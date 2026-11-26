import express from "express";
import { getPool } from "../config/database.js";
import { getAdminDatabaseCatalog, getAdminDataset } from "../config/databaseCatalog.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { createAdminRequestGate } from "../middleware/adminRateLimit.js";
import { verifyFirebaseToken } from "../middleware/verifyFirebaseToken.js";
import { chunkPages, textToPages } from "../services/documents/extract.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/;
const MATERIAL_TEXT_LIMIT = 700_000;

class HttpError extends Error {
  constructor(status, message, code = "REQUEST_FAILED") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function databaseIsConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

function requireDatabase(res, isConfigured) {
  if (isConfigured()) return true;
  res.status(503).json({ error: "Neon is not configured on this server.", code: "DATABASE_NOT_CONFIGURED" });
  return false;
}

function getDatasetOrThrow(key) {
  const dataset = getAdminDataset(key);
  if (!dataset) throw new HttpError(404, "Unknown database content area.", "UNKNOWN_DATASET");
  return dataset;
}

function validateField(field, value) {
  if (value === null || value === "") {
    if (field.required && value !== "") throw new HttpError(400, `${field.label} is required.`, "VALIDATION_ERROR");
    if (field.required && value === "") throw new HttpError(400, `${field.label} is required.`, "VALIDATION_ERROR");
    if (field.nullable === false) throw new HttpError(400, `${field.label} cannot be blank.`, "VALIDATION_ERROR");
    return null;
  }

  if (field.type === "text" || field.type === "textarea" || field.type === "url") {
    if (typeof value !== "string") throw new HttpError(400, `${field.label} must be text.`, "VALIDATION_ERROR");
    const result = field.type === "textarea" ? value : value.trim();
    if (field.required && !result.trim()) throw new HttpError(400, `${field.label} is required.`, "VALIDATION_ERROR");
    if (result.length > (field.maxLength || 40_000)) throw new HttpError(400, `${field.label} is too long.`, "VALIDATION_ERROR");
    if (field.type === "url" && result) {
      let url;
      try { url = new URL(result); } catch { throw new HttpError(400, `${field.label} must be a valid HTTP(S) URL.`, "VALIDATION_ERROR"); }
      if (!(["http:", "https:"].includes(url.protocol))) throw new HttpError(400, `${field.label} must use HTTP or HTTPS.`, "VALIDATION_ERROR");
    }
    return result;
  }

  if (field.type === "reference") {
    if (typeof value !== "string" || !UUID_RE.test(value)) throw new HttpError(400, `${field.label} must reference a valid record.`, "VALIDATION_ERROR");
    return value;
  }

  if (field.type === "select") {
    if (typeof value !== "string" || !field.options?.includes(value)) throw new HttpError(400, `Choose a valid ${field.label.toLowerCase()}.`, "VALIDATION_ERROR");
    return value;
  }

  if (field.type === "number") {
    const result = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(result) || (field.integer && !Number.isInteger(result))) throw new HttpError(400, `${field.label} must be a valid ${field.integer ? "whole number" : "number"}.`, "VALIDATION_ERROR");
    if (field.min != null && result < field.min) throw new HttpError(400, `${field.label} is below the allowed minimum.`, "VALIDATION_ERROR");
    if (field.max != null && result > field.max) throw new HttpError(400, `${field.label} is above the allowed maximum.`, "VALIDATION_ERROR");
    return result;
  }

  if (field.type === "boolean") {
    if (typeof value !== "boolean") throw new HttpError(400, `${field.label} must be true or false.`, "VALIDATION_ERROR");
    return value;
  }

  if (field.type === "date") {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) {
      throw new HttpError(400, `${field.label} must be a valid date.`, "VALIDATION_ERROR");
    }
    return value;
  }

  throw new HttpError(400, `Unsupported field type for ${field.label}.`, "VALIDATION_ERROR");
}

function validatePayload(dataset, body, { partial = false } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Send a JSON object.", "VALIDATION_ERROR");
  const fields = new Map(dataset.fields.map((field) => [field.name, field]));
  const unknown = Object.keys(body).filter((key) => !fields.has(key));
  if (unknown.length) throw new HttpError(400, `Unsupported field: ${unknown[0]}.`, "VALIDATION_ERROR");

  const result = {};
  for (const field of dataset.fields) {
    if (!Object.hasOwn(body, field.name)) {
      if (!partial && field.required) throw new HttpError(400, `${field.label} is required.`, "VALIDATION_ERROR");
      continue;
    }
    result[field.name] = validateField(field, body[field.name]);
  }
  if (partial && Object.keys(result).length === 0) throw new HttpError(400, "Add at least one field to update.", "VALIDATION_ERROR");

  if (dataset.table === "material_authorities") {
    const caseId = result.case_id ?? null;
    const statuteSectionId = result.statute_section_id ?? null;
    if (partial) {
      // The caller validates the merged row after reading the current record.
    } else if (Boolean(caseId) === Boolean(statuteSectionId)) {
      throw new HttpError(400, "Choose exactly one case or statute section for this authority link.", "VALIDATION_ERROR");
    }
  }
  if (dataset.table === "materials") {
    if (result.publication_status === "published" && result.approval_status !== "approved") {
      throw new HttpError(400, "Approve a material before publishing it.", "VALIDATION_ERROR");
    }
  }
  return result;
}

function insertStatement(dataset, values, serverValues = {}) {
  const merged = { ...values, ...serverValues };
  const columns = Object.keys(merged);
  if (!columns.length || columns.some((column) => !IDENTIFIER_RE.test(column))) throw new HttpError(400, "No valid fields were provided.", "VALIDATION_ERROR");
  const placeholders = columns.map((_, index) => `$${index + 1}`);
  return {
    text: `INSERT INTO ${dataset.table} (${columns.join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING id`,
    values: columns.map((column) => merged[column])
  };
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, "\\$&");
}

function safeReadColumns(dataset) {
  return [...new Set(["id", ...dataset.fields.filter((field) => !field.virtual).map((field) => field.name)])];
}

async function validateRelationships(db, dataset, values, { normalize = true, recordId = null } = {}) {
  const normalized = { ...values };
  const getOne = async (sql, params, label) => {
    const result = await db.query(sql, params);
    if (!result.rows[0]) throw new HttpError(400, `${label} does not exist in Neon.`, "RELATION_VALIDATION_ERROR");
    return result.rows[0];
  };

  if (dataset.table === "courses") {
    const universityId = values.university_id;
    if (values.faculty_id) {
      const faculty = await getOne("SELECT university_id FROM faculties WHERE id = $1", [values.faculty_id], "Faculty");
      if (faculty.university_id !== universityId) throw new HttpError(400, "The selected faculty belongs to a different university.", "RELATION_VALIDATION_ERROR");
    }
    if (values.department_id) {
      const department = await getOne(
        `SELECT department.faculty_id, faculty.university_id
         FROM departments department JOIN faculties faculty ON faculty.id = department.faculty_id
         WHERE department.id = $1`,
        [values.department_id],
        "Department"
      );
      if (department.university_id !== universityId) throw new HttpError(400, "The selected department belongs to a different university.", "RELATION_VALIDATION_ERROR");
      if (values.faculty_id && department.faculty_id !== values.faculty_id) throw new HttpError(400, "The selected department does not belong to the selected faculty.", "RELATION_VALIDATION_ERROR");
    }
  }

  if (dataset.table === "course_topics" && values.parent_topic_id) {
    const parent = await getOne("SELECT course_id FROM course_topics WHERE id = $1", [values.parent_topic_id], "Parent topic");
    if (parent.course_id !== values.course_id) throw new HttpError(400, "A parent topic must belong to the same course.", "RELATION_VALIDATION_ERROR");
    if (recordId) {
      const cycle = await db.query(
        `WITH RECURSIVE ancestors AS (
           SELECT id, parent_topic_id FROM course_topics WHERE id = $1
           UNION
           SELECT topic.id, topic.parent_topic_id FROM course_topics topic
           JOIN ancestors ON topic.id = ancestors.parent_topic_id
         ) SELECT EXISTS (SELECT 1 FROM ancestors WHERE id = $2) AS creates_cycle`,
        [values.parent_topic_id, recordId]
      );
      if (cycle.rows[0]?.creates_cycle) throw new HttpError(400, "A topic cannot be placed beneath one of its own descendants.", "RELATION_VALIDATION_ERROR");
    }
  }

  if (dataset.table === "materials") {
    let effectiveCourseId = values.course_id || null;
    let effectiveUniversityId = values.university_id || null;
    let topicCourseId = null;
    if (effectiveCourseId) {
      const course = await getOne("SELECT university_id FROM courses WHERE id = $1", [effectiveCourseId], "Course");
      if (effectiveUniversityId && course.university_id !== effectiveUniversityId) throw new HttpError(400, "The selected course belongs to a different university.", "RELATION_VALIDATION_ERROR");
      if (!effectiveUniversityId) effectiveUniversityId = course.university_id;
    }
    if (values.topic_id) {
      const topic = await getOne("SELECT course_id FROM course_topics WHERE id = $1", [values.topic_id], "Topic");
      topicCourseId = topic.course_id;
      if (effectiveCourseId && topicCourseId !== effectiveCourseId) throw new HttpError(400, "The selected topic does not belong to the selected course.", "RELATION_VALIDATION_ERROR");
      if (!effectiveCourseId) {
        effectiveCourseId = topicCourseId;
        const course = await getOne("SELECT university_id FROM courses WHERE id = $1", [topicCourseId], "Topic course");
        if (effectiveUniversityId && course.university_id !== effectiveUniversityId) throw new HttpError(400, "The selected topic belongs to a course in a different university.", "RELATION_VALIDATION_ERROR");
        if (!effectiveUniversityId) effectiveUniversityId = course.university_id;
      }
    }
    const effectiveAccessScope = values.access_scope === undefined
      ? (recordId ? null : "institution")
      : values.access_scope;
    if (effectiveAccessScope === "institution" && !effectiveUniversityId) throw new HttpError(400, "Institution-scoped materials need a university or a course with a university.", "RELATION_VALIDATION_ERROR");
    if (normalize) {
      if (!values.course_id && effectiveCourseId) normalized.course_id = effectiveCourseId;
      if (!values.university_id && effectiveUniversityId) normalized.university_id = effectiveUniversityId;
    }
  }

  if (dataset.table === "past_questions" && values.course_id) {
    const course = await getOne("SELECT university_id FROM courses WHERE id = $1", [values.course_id], "Course");
    if (values.university_id && course.university_id !== values.university_id) throw new HttpError(400, "The selected course belongs to a different university.", "RELATION_VALIDATION_ERROR");
    if (normalize && !values.university_id) normalized.university_id = course.university_id;
  }

  if (dataset.table === "marking_rubrics" && values.question_id) {
    const question = await getOne("SELECT course_id FROM past_questions WHERE id = $1", [values.question_id], "Past question");
    if (values.course_id && question.course_id && values.course_id !== question.course_id) throw new HttpError(400, "The selected question belongs to a different course.", "RELATION_VALIDATION_ERROR");
    if (normalize && !values.course_id && question.course_id) normalized.course_id = question.course_id;
  }

  return normalized;
}

// Returns the app_users.id for the signed-in administrator, creating the row on
// first write. If the same (verified) email already belongs to an older
// Firebase account (e.g. the account was recreated), that row is relinked
// instead of failing with a unique-email conflict.
export async function ensureAdminUser(db, user) {
  if (!user?.uid || !user?.email) throw new HttpError(403, "This Firebase administrator needs an email-backed account to write Neon content.", "ADMIN_PROFILE_REQUIRED");
  const email = String(user.email).trim();
  const fullName = String(user.name || email).slice(0, 255);
  const found = await db.query(
    `SELECT id, firebase_uid, account_status FROM app_users
      WHERE firebase_uid = $1 OR lower(email) = lower($2)
      ORDER BY (firebase_uid = $1) DESC LIMIT 1`,
    [user.uid, email]
  );
  let actor = found.rows[0];
  if (actor && actor.firebase_uid !== user.uid) {
    if (user.emailVerified !== true) throw new HttpError(403, "Verify this administrator email in Firebase first: an older account already uses it in Neon.", "ADMIN_EMAIL_NOT_VERIFIED");
    const relinked = await db.query("UPDATE app_users SET firebase_uid = $1 WHERE id = $2 RETURNING id, account_status", [user.uid, actor.id]);
    actor = relinked.rows[0];
  } else if (!actor) {
    const created = await db.query(
      `INSERT INTO app_users (firebase_uid, email, full_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (firebase_uid) DO UPDATE
         SET firebase_uid = app_users.firebase_uid
       RETURNING id, account_status`,
      [user.uid, email, fullName]
    );
    actor = created.rows[0];
  }
  if (!actor?.id || (actor.account_status && actor.account_status !== "active")) throw new HttpError(403, "This Neon account is not active for administrator writes.", "ADMIN_ACCOUNT_DISABLED");
  return actor.id;
}

async function runTransaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* keep the original failure */ }
    throw error;
  } finally {
    client.release();
  }
}

function splitMaterialText(text, maxChars = 4_000) {
  const source = String(text || "").trim();
  if (!source) return [];
  const chunks = [];
  let position = 0;
  while (position < source.length) {
    let end = Math.min(position + maxChars, source.length);
    if (end < source.length) {
      const boundary = source.lastIndexOf(" ", end);
      if (boundary > position + Math.floor(maxChars * 0.65)) end = boundary;
    }
    chunks.push(source.slice(position, end).trim());
    position = end;
    while (source[position] === " ") position++;
  }
  return chunks.filter(Boolean);
}

async function addMaterialVersion(client, { materialId, contentText, actorId }) {
  if (typeof contentText !== "string" || !contentText.trim()) return null;
  if (contentText.length > MATERIAL_TEXT_LIMIT) throw new HttpError(400, "Pasted material text exceeds the 700,000 character limit.", "VALIDATION_ERROR");
  const material = await client.query("SELECT id FROM materials WHERE id = $1 FOR UPDATE", [materialId]);
  if (!material.rows.length) throw new HttpError(404, "Material not found.", "NOT_FOUND");
  const next = await client.query("SELECT COALESCE(MAX(version_number), 0) + 1 AS version_number FROM material_versions WHERE material_id = $1", [materialId]);
  const versionNumber = Number(next.rows[0]?.version_number || 1);
  const version = await client.query(
    `INSERT INTO material_versions (material_id, version_number, extracted_text, extraction_status, uploaded_by)
     VALUES ($1, $2, $3, 'completed', $4)
     RETURNING id, material_id, version_number, extraction_status`,
    [materialId, versionNumber, contentText.trim(), actorId]
  );
  // Text copied from the document reader keeps its "[Page N]" markers, so each
  // chunk remembers its page for AI citations.
  const pages = textToPages(contentText);
  const chunks = pages.some((page) => page.page != null)
    ? chunkPages(pages)
    : splitMaterialText(contentText).map((content) => ({ page: null, content }));
  for (let index = 0; index < chunks.length; index++) {
    await client.query(
      `INSERT INTO material_chunks (material_id, version_id, chunk_number, content, page_number)
       VALUES ($1, $2, $3, $4, $5)`,
      [materialId, version.rows[0].id, index, chunks[index].content, chunks[index].page]
    );
  }
  return { ...version.rows[0], chunk_count: chunks.length };
}

async function getRecord(db, dataset, id) {
  const columns = safeReadColumns(dataset).join(", ");
  const result = await db.query(`SELECT ${columns} FROM ${dataset.table} WHERE id = $1`, [id]);
  if (!result.rows.length) throw new HttpError(404, "Record not found.", "NOT_FOUND");
  const record = result.rows[0];
  if (dataset.table === "materials") {
    const latest = await db.query(
      `SELECT id, version_number, extracted_text, extraction_status
       FROM material_versions WHERE material_id = $1 ORDER BY version_number DESC LIMIT 1`,
      [id]
    );
    record.latest_version = latest.rows[0] || null;
  }
  return record;
}

function normalizeDbError(error) {
  if (error instanceof HttpError) return error;
  if (error?.code === "23505") return new HttpError(409, "A record with that unique value already exists.", "CONFLICT");
  if (error?.code === "23503") return new HttpError(409, "A linked record is missing or still has dependent records.", "RELATION_CONFLICT");
  if (error?.code === "23514" || error?.code === "22P02" || error?.code === "22007" || error?.code === "22003") return new HttpError(400, "The data does not match the Neon schema constraints.", "SCHEMA_VALIDATION_ERROR");
  if (error?.message === "DATABASE_URL is not configured.") return new HttpError(503, "Neon is not configured on this server.", "DATABASE_NOT_CONFIGURED");
  console.error("Admin database request failed:", error?.code || error?.name || "unknown");
  return new HttpError(500, "The database operation could not be completed.", "DATABASE_ERROR");
}

function handleError(res, error) {
  const safe = normalizeDbError(error);
  return res.status(safe.status || 500).json({ error: safe.message, code: safe.code });
}

export function createAdminDatabaseRouter({
  poolProvider = getPool,
  verifyToken = verifyFirebaseToken,
  adminGate = requireAdmin,
  requestGate = createAdminRequestGate(),
  configured = databaseIsConfigured
} = {}) {
  const router = express.Router();
  router.use(verifyToken, adminGate, requestGate);

  router.get("/catalog", (_req, res) => {
    res.json({ data: getAdminDatabaseCatalog(), database: "Neon" });
  });

  router.get("/options/:resource", async (req, res) => {
    if (!requireDatabase(res, configured)) return;
    try {
      const dataset = getDatasetOrThrow(req.params.resource);
      const labels = {
        universities: "name", faculties: "name", departments: "name", courses: "title",
        course_topics: "title", topic_learning_objectives: "objective", materials: "title",
        legal_cases: "case_name", case_mnemonics: "mnemonic", statutes: "title",
        statute_sections: "section_number", past_questions: "question_text",
        marking_rubrics: "title", marking_criteria: "criterion", material_authorities: "reference_note"
      };
      const labelColumn = labels[req.params.resource];
      const limit = Math.min(500, Math.max(1, Number.parseInt(req.query.limit, 10) || 250));
      const q = String(req.query.q || "").trim().slice(0, 150);
      const values = [];
      let where = "";
      if (q) {
        values.push(`%${escapeLike(q)}%`);
        where = `WHERE ${labelColumn}::text ILIKE $1 ESCAPE '\\'`;
      }
      values.push(limit);
      const queryLimit = `$${values.length}`;
      const result = await poolProvider().query(
        `SELECT id, LEFT(COALESCE(${labelColumn}::text, ''), 180) AS label FROM ${dataset.table} ${where} ORDER BY ${dataset.orderBy} LIMIT ${queryLimit}`,
        values
      );
      res.json({ data: result.rows });
    } catch (error) { handleError(res, error); }
  });

  router.get("/:resource", async (req, res) => {
    if (!requireDatabase(res, configured)) return;
    try {
      const dataset = getDatasetOrThrow(req.params.resource);
      const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
      const offset = Math.min(1_000_000, Math.max(0, Number.parseInt(req.query.offset, 10) || 0));
      const q = String(req.query.q || "").trim().slice(0, 150);
      const values = [];
      let where = "";
      if (q && dataset.searchColumns.length) {
        values.push(`%${escapeLike(q)}%`);
        const match = dataset.searchColumns.map((column) => `COALESCE(${column}::text, '') ILIKE $1 ESCAPE '\\'`).join(" OR ");
        where = `WHERE (${match})`;
      }
      const count = await poolProvider().query(`SELECT COUNT(*)::int AS total FROM ${dataset.table} ${where}`, values);
      values.push(limit, offset);
      const columns = safeReadColumns(dataset).join(", ");
      const rows = await poolProvider().query(
        `SELECT ${columns} FROM ${dataset.table} ${where} ORDER BY ${dataset.orderBy} LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values
      );
      res.json({ data: rows.rows, pagination: { total: count.rows[0]?.total || 0, limit, offset } });
    } catch (error) { handleError(res, error); }
  });

  router.get("/materials/:id/versions", async (req, res) => {
    if (!requireDatabase(res, configured)) return;
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: "Record ID must be a UUID.", code: "VALIDATION_ERROR" });
    try {
      const result = await poolProvider().query(
        `SELECT id, material_id, version_number, extracted_text, extraction_status, created_at
         FROM material_versions WHERE material_id = $1 ORDER BY version_number DESC LIMIT 50`,
        [req.params.id]
      );
      res.json({ data: result.rows });
    } catch (error) { handleError(res, error); }
  });

  router.post("/materials/:id/versions", async (req, res) => {
    if (!requireDatabase(res, configured)) return;
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: "Material ID must be a UUID.", code: "VALIDATION_ERROR" });
    const contentText = req.body?.extracted_text;
    if (typeof contentText !== "string" || !contentText.trim()) return res.status(400).json({ error: "Paste the material text before saving a version.", code: "VALIDATION_ERROR" });
    try {
      const result = await runTransaction(poolProvider(), async (client) => {
        const actorId = await ensureAdminUser(client, req.user);
        return addMaterialVersion(client, { materialId: req.params.id, contentText, actorId });
      });
      return res.status(201).json({ data: result });
    } catch (error) { return handleError(res, error); }
  });

  router.get("/:resource/:id", async (req, res) => {
    if (!requireDatabase(res, configured)) return;
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: "Record ID must be a UUID.", code: "VALIDATION_ERROR" });
    try {
      const dataset = getDatasetOrThrow(req.params.resource);
      const data = await getRecord(poolProvider(), dataset, req.params.id);
      res.json({ data });
    } catch (error) { handleError(res, error); }
  });

  router.post("/:resource", async (req, res) => {
    if (!requireDatabase(res, configured)) return;
    try {
      const dataset = getDatasetOrThrow(req.params.resource);
      const values = validatePayload(dataset, req.body);
      const contentText = dataset.table === "materials" ? values.content_text : null;
      delete values.content_text;
      const result = await runTransaction(poolProvider(), async (client) => {
        const normalizedValues = await validateRelationships(client, dataset, values, { normalize: true });
        const actorId = await ensureAdminUser(client, req.user);
        const serverValues = {};
        if (dataset.creatorColumn) serverValues[dataset.creatorColumn] = actorId;
        if (dataset.table === "materials" && values.approval_status === "approved") {
          serverValues.approved_by = actorId;
          serverValues.approved_at = new Date().toISOString();
        }
        if (dataset.table === "materials" && values.publication_status === "published") serverValues.published_at = new Date().toISOString();
        if (dataset.table === "legal_cases" && values.verification_status === "verified") {
          serverValues.verified_by = actorId;
          serverValues.verified_at = new Date().toISOString();
        }
        const statement = insertStatement(dataset, normalizedValues, serverValues);
        const inserted = await client.query(statement.text, statement.values);
        const record = await getRecord(client, dataset, inserted.rows[0].id);
        if (dataset.table === "materials" && contentText?.trim()) {
          record.latest_version = await addMaterialVersion(client, { materialId: inserted.rows[0].id, contentText, actorId });
        }
        return record;
      });
      res.status(201).json({ data: result });
    } catch (error) { handleError(res, error); }
  });

  router.patch("/:resource/:id", async (req, res) => {
    if (!requireDatabase(res, configured)) return;
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: "Record ID must be a UUID.", code: "VALIDATION_ERROR" });
    try {
      const dataset = getDatasetOrThrow(req.params.resource);
      const values = validatePayload(dataset, req.body, { partial: true });
      const contentText = dataset.table === "materials" ? values.content_text : null;
      delete values.content_text;
      const result = await runTransaction(poolProvider(), async (client) => {
        const current = await getRecord(client, dataset, req.params.id);
        const merged = { ...current, ...values };
        const normalized = await validateRelationships(client, dataset, merged, { normalize: true, recordId: req.params.id });
        if (dataset.table === "material_authorities" && Boolean(normalized.case_id) === Boolean(normalized.statute_section_id)) {
          throw new HttpError(400, "Choose exactly one case or statute section for this authority link.", "VALIDATION_ERROR");
        }
        if (dataset.table === "materials" && normalized.publication_status === "published" && normalized.approval_status !== "approved") {
          throw new HttpError(400, "Approve a material before publishing it.", "VALIDATION_ERROR");
        }
        const actorId = await ensureAdminUser(client, req.user);
        const serverValues = {};
        if (dataset.table === "materials" && values.approval_status === "approved") {
          serverValues.approved_by = actorId;
          serverValues.approved_at = new Date().toISOString();
        }
        if (dataset.table === "materials" && values.publication_status === "published" && current.publication_status !== "published") {
          serverValues.published_at = new Date().toISOString();
        }
        if (dataset.table === "legal_cases" && values.verification_status === "verified") {
          serverValues.verified_by = actorId;
          serverValues.verified_at = new Date().toISOString();
        }
        const updateValues = { ...values, ...serverValues };
        for (const field of dataset.fields) {
          if (!field.virtual && normalized[field.name] !== merged[field.name]) {
            updateValues[field.name] = normalized[field.name];
          }
        }
        const columns = Object.keys(updateValues);
        if (columns.some((column) => !IDENTIFIER_RE.test(column))) throw new HttpError(400, "Invalid field name.", "VALIDATION_ERROR");
        if (columns.length) {
          const assignments = columns.map((column, index) => `${column} = $${index + 1}`).join(", ");
          const updated = await client.query(
            `UPDATE ${dataset.table} SET ${assignments}${dataset.table === "materials" || dataset.table === "legal_cases" || dataset.table === "courses" || dataset.table === "universities" || dataset.table === "statutes" ? ", updated_at = NOW()" : ""} WHERE id = $${columns.length + 1} RETURNING id`,
            [...columns.map((column) => updateValues[column]), req.params.id]
          );
          if (!updated.rows.length) throw new HttpError(404, "Record not found.", "NOT_FOUND");
        }
        if (dataset.table === "materials" && contentText?.trim()) await addMaterialVersion(client, { materialId: req.params.id, contentText, actorId });
        return getRecord(client, dataset, req.params.id);
      });
      res.json({ data: result });
    } catch (error) { handleError(res, error); }
  });

  router.delete("/:resource/:id", async (req, res) => {
    if (!requireDatabase(res, configured)) return;
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: "Record ID must be a UUID.", code: "VALIDATION_ERROR" });
    if (req.body?.confirm !== true) return res.status(400).json({ error: "Confirm the deletion before continuing.", code: "CONFIRMATION_REQUIRED" });
    try {
      const dataset = getDatasetOrThrow(req.params.resource);
      const db = poolProvider();
      if (dataset.softDelete?.column) {
        const labelColumn = dataset.softDelete.labelColumn;
        const touchUpdatedAt = ["universities", "courses", "materials"].includes(dataset.table) ? ", updated_at = NOW()" : "";
        const result = await db.query(
          `UPDATE ${dataset.table} SET ${dataset.softDelete.column} = $1${touchUpdatedAt} WHERE id = $2 RETURNING id, ${labelColumn}`,
          [dataset.softDelete.value, req.params.id]
        );
        if (!result.rows.length) throw new HttpError(404, "Record not found.", "NOT_FOUND");
        console.info("admin_content_deactivate", JSON.stringify({ uid: req.user.uid, dataset: req.params.resource, id: req.params.id }));
        return res.json({ data: { deleted: false, deactivated: true, record: result.rows[0] } });
      }
      const labelColumn = dataset.softDelete?.labelColumn;
      const returning = labelColumn ? `id, ${labelColumn}` : "id";
      const result = await db.query(`DELETE FROM ${dataset.table} WHERE id = $1 RETURNING ${returning}`, [req.params.id]);
      if (!result.rows.length) throw new HttpError(404, "Record not found.", "NOT_FOUND");
      console.info("admin_content_delete", JSON.stringify({ uid: req.user.uid, dataset: req.params.resource, id: req.params.id }));
      res.json({ data: { deleted: true, record: result.rows[0], warning: dataset.deleteWarning } });
    } catch (error) { handleError(res, error); }
  });

  return router;
}
