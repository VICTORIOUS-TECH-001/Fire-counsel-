import express from "express";
import { rateLimit } from "express-rate-limit";
import { getPool } from "../config/database.js";
import { verifyFirebaseToken } from "../middleware/verifyFirebaseToken.js";
import { AiError, aiConfig } from "../services/ai/providers.js";
import { createStudio } from "../services/ai/studio.js";
import { FEATURES, finishUsage, getAllowance, reserveUsage } from "../services/ai/quota.js";
import { attachmentSummary, validateAttachments } from "../services/ai/attachments.js";
import { buildDocx, buildPdf, documentFileName } from "../services/ai/documents.js";

const DEFAULT_FORMAT = { case: "pdf", notes: "docx", questions: "docx", chat: "pdf" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODES = Object.keys(FEATURES);
const MODE_TITLES = { chat: "Chat", case: "Case analysis", notes: "Exam-ready notes", questions: "Question set" };

export function publicAiError(res, error) {
  if (error instanceof AiError) return res.status(error.status).json({ error: error.message, code: error.code });
  if (error?.message === "DATABASE_URL is not configured.") return res.status(503).json({ error: "Neon is not configured on this server.", code: "DATABASE_NOT_CONFIGURED" });
  if (error?.code === "42P01" || error?.code === "42703") return res.status(503).json({ error: "The AI database tables are not installed yet. Run the database migration workflow.", code: "AI_SCHEMA_NOT_READY" });
  console.error("AI route failed:", error?.code || error?.name || "unknown", error?.message);
  return res.status(503).json({ error: "The AI service is temporarily unavailable. Please try again.", code: "AI_UNAVAILABLE" });
}

const messageRow = (row) => ({
  id: String(row.id), role: row.role, status: row.status, content: row.content,
  sources: row.sources || [], attachments: row.attachments || [], meta: row.meta || {},
  provider: row.provider, model: row.model, created_at: row.created_at
});

function cleanOptions(mode, raw = {}) {
  const options = {};
  if (mode === "chat") options.webSearch = raw.webSearch !== false;
  if (mode === "case" && typeof raw.caseQuery === "string") options.caseQuery = raw.caseQuery.trim().slice(0, 500);
  if (typeof raw.courseId === "string" && (raw.courseId === "auto" || UUID_RE.test(raw.courseId))) options.courseId = raw.courseId;
  if (mode === "notes") {
    options.allowResearch = raw.allowResearch === true;
    options.questionBank = raw.questionBank === true;
    if (typeof raw.topic === "string") options.topic = raw.topic.trim().slice(0, 300);
  }
  if (mode === "questions" && Number.isInteger(raw.count)) options.count = Math.min(Math.max(raw.count, 1), 20);
  return options;
}

/** Runs a limited number of AI jobs at once on this (small) server. */
function createJobQueue(max) {
  let running = 0;
  const waiting = [];
  const next = () => {
    if (running >= max || !waiting.length) return;
    running += 1;
    const job = waiting.shift();
    Promise.resolve().then(job).catch(() => {}).finally(() => { running -= 1; next(); });
  };
  return { push(job) { waiting.push(job); next(); }, get size() { return running + waiting.length; } };
}

export function createAiRouter({
  poolProvider = getPool,
  verifyToken = verifyFirebaseToken,
  env = process.env,
  studioFactory = createStudio,
  configured = () => Boolean(env.DATABASE_URL)
} = {}) {
  const router = express.Router();
  const queue = createJobQueue(Math.min(Math.max(Number(env.AI_MAX_CONCURRENT_JOBS) || 3, 1), 10));
  router.use(verifyToken);
  router.use(rateLimit({ windowMs: 15 * 60_000, limit: 600, standardHeaders: "draft-8", legacyHeaders: false, keyGenerator: (req) => `ai:${req.user.uid}`, validate: false }));
  router.use((req, res, next) => {
    if (!configured()) return res.status(503).json({ error: "Neon is not configured on this server.", code: "DATABASE_NOT_CONFIGURED" });
    return next();
  });

  router.get("/me", async (req, res) => {
    try {
      const config = aiConfig(env);
      const allowance = await getAllowance(poolProvider(), req.user.uid, { env, isAdmin: req.user.admin });
      res.json({ data: {
        configured: config.configured,
        web_search: config.gemini.configured,
        email_verified: req.user.emailVerified,
        admin: req.user.admin,
        allowance
      } });
    } catch (error) { publicAiError(res, error); }
  });

  router.get("/courses", async (req, res) => {
    try {
      const courses = await studioFactory({ db: poolProvider(), env }).listCourses();
      res.json({ data: courses.map((c) => ({ id: c.id, course_code: c.course_code, title: c.title, university: c.short_name || c.university || null })) });
    } catch (error) { publicAiError(res, error); }
  });

  router.get("/conversations", async (req, res) => {
    try {
      const mode = MODES.includes(req.query.mode) ? req.query.mode : null;
      const result = await poolProvider().query(
        `SELECT id, mode, title, updated_at FROM ai_conversations
          WHERE firebase_uid = $1 AND ($2::text IS NULL OR mode = $2) ORDER BY updated_at DESC LIMIT 50`, [req.user.uid, mode]);
      res.json({ data: result.rows });
    } catch (error) { publicAiError(res, error); }
  });

  router.get("/conversations/:id", async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "Conversation not found.", code: "NOT_FOUND" });
    try {
      const db = poolProvider();
      const conversation = await db.query("SELECT id, mode, title, course_id, created_at, updated_at FROM ai_conversations WHERE id = $1 AND firebase_uid = $2", [req.params.id, req.user.uid]);
      if (!conversation.rows[0]) return res.status(404).json({ error: "Conversation not found.", code: "NOT_FOUND" });
      // A server restart can interrupt a job; never leave it spinning forever.
      await db.query(`UPDATE ai_messages SET status = 'failed', content = 'This request was interrupted (the server restarted). Please send it again — it was not counted.', updated_at = NOW()
                       WHERE conversation_id = $1 AND status = 'pending' AND created_at < NOW() - interval '15 minutes'`, [req.params.id]);
      const messages = await db.query("SELECT * FROM ai_messages WHERE conversation_id = $1 ORDER BY id LIMIT 200", [req.params.id]);
      res.json({ data: { conversation: conversation.rows[0], messages: messages.rows.map(messageRow) } });
    } catch (error) { publicAiError(res, error); }
  });

  router.delete("/conversations/:id", async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "Conversation not found.", code: "NOT_FOUND" });
    try {
      const result = await poolProvider().query("DELETE FROM ai_conversations WHERE id = $1 AND firebase_uid = $2", [req.params.id, req.user.uid]);
      if (!result.rowCount) return res.status(404).json({ error: "Conversation not found.", code: "NOT_FOUND" });
      res.status(204).end();
    } catch (error) { publicAiError(res, error); }
  });

  // Download an answer as a document: case analyses default to the casebook
  // PDF, exam notes and question papers to Word. Either format can be chosen.
  router.get("/messages/:id/export", async (req, res) => {
    if (!/^\d{1,18}$/.test(req.params.id)) return res.status(404).json({ error: "Answer not found.", code: "NOT_FOUND" });
    try {
      const result = await poolProvider().query(
        `SELECT m.content, m.sources, m.status, m.role, m.model, m.created_at, c.mode, c.title
           FROM ai_messages m JOIN ai_conversations c ON c.id = m.conversation_id
          WHERE m.id = $1 AND c.firebase_uid = $2`, [req.params.id, req.user.uid]);
      const row = result.rows[0];
      if (!row || row.role !== "assistant" || row.status !== "done") return res.status(404).json({ error: "Answer not found.", code: "NOT_FOUND" });
      const format = ["pdf", "docx"].includes(req.query.format) ? req.query.format : DEFAULT_FORMAT[row.mode] || "pdf";
      const title = `${MODE_TITLES[row.mode]}: ${row.title}`.slice(0, 160);
      const input = { title, markdown: row.content, sources: row.sources || [], generatedAt: new Date(row.created_at) };
      const buffer = format === "pdf" ? await buildPdf({ ...input, profile: row.mode === "case" ? "casebook" : "notes" }) : await buildDocx(input);
      res.set({
        "Content-Type": format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${documentFileName(title, format)}"`,
        "Content-Length": String(buffer.length)
      });
      return res.end(buffer);
    } catch (error) { return publicAiError(res, error); }
  });

  router.post("/messages", async (req, res) => {
    const db = (() => { try { return poolProvider(); } catch (error) { return error; } })();
    if (db instanceof Error) return publicAiError(res, db);
    let usageId = null;
    try {
      if (!aiConfig(env).configured) throw new AiError(503, "The AI key is not configured on the server yet.", "AI_NOT_CONFIGURED");
      if (!req.user.emailVerified) throw new AiError(403, "Verify your email address before using Fire Counsel AI (check your inbox, then sign in again).", "EMAIL_NOT_VERIFIED");
      const mode = req.body?.mode;
      if (!MODES.includes(mode)) throw new AiError(400, "Choose chat, case, notes or questions.", "VALIDATION_ERROR");
      const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
      if (text.length > 60_000) throw new AiError(400, "Message is too long (maximum 60,000 characters).", "VALIDATION_ERROR");
      const attachments = validateAttachments(req.body?.attachments);
      if (!text && !attachments.length && !(mode === "case" && req.body?.options?.caseQuery)) throw new AiError(400, "Type a message or attach a file.", "VALIDATION_ERROR");
      const options = cleanOptions(mode, req.body?.options);

      let conversation;
      const conversationId = req.body?.conversation_id;
      if (conversationId != null) {
        if (typeof conversationId !== "string" || !UUID_RE.test(conversationId)) throw new AiError(404, "Conversation not found.", "NOT_FOUND");
        const found = await db.query("SELECT id, mode, title, course_id, created_at, updated_at FROM ai_conversations WHERE id = $1 AND firebase_uid = $2", [conversationId, req.user.uid]);
        conversation = found.rows[0];
        if (!conversation) throw new AiError(404, "Conversation not found.", "NOT_FOUND");
        if (conversation.mode !== mode) throw new AiError(400, "This conversation belongs to a different AI tool.", "VALIDATION_ERROR");
        const busy = await db.query("SELECT 1 FROM ai_messages WHERE conversation_id = $1 AND status = 'pending' AND created_at > NOW() - interval '15 minutes' LIMIT 1", [conversationId]);
        if (busy.rows.length) throw new AiError(409, "Fire Counsel AI is still working on your previous message in this conversation.", "BUSY");
      }

      usageId = await reserveUsage(db, req.user.uid, mode, { env, isAdmin: req.user.admin });

      if (!conversation) {
        const seed = (options.caseQuery || text || attachments[0]?.name || MODE_TITLES[mode]).replace(/\s+/g, " ").trim();
        const created = await db.query(
          "INSERT INTO ai_conversations (firebase_uid, mode, title, course_id) VALUES ($1, $2, $3, $4) RETURNING id, mode, title, course_id, created_at, updated_at",
          [req.user.uid, mode, seed.slice(0, 120) || MODE_TITLES[mode], UUID_RE.test(options.courseId || "") ? options.courseId : null]);
        conversation = created.rows[0];
      }
      const history = (await db.query(
        "SELECT role, content FROM ai_messages WHERE conversation_id = $1 AND status = 'done' ORDER BY id DESC LIMIT 12", [conversation.id]
      )).rows.reverse().map((row) => ({ role: row.role, text: row.content }));
      const userMessage = (await db.query(
        "INSERT INTO ai_messages (conversation_id, role, content, attachments, meta) VALUES ($1, 'user', $2, $3::jsonb, $4::jsonb) RETURNING *",
        [conversation.id, text || options.caseQuery || "", JSON.stringify(attachmentSummary(attachments)), JSON.stringify({ options })])).rows[0];
      const pending = (await db.query(
        "INSERT INTO ai_messages (conversation_id, role, status, meta) VALUES ($1, 'assistant', 'pending', $2::jsonb) RETURNING *",
        [conversation.id, JSON.stringify({ queued: queue.size > 0 })])).rows[0];
      await db.query("UPDATE ai_conversations SET updated_at = NOW() WHERE id = $1", [conversation.id]);

      const jobUsage = usageId;
      usageId = null;
      queue.push(async () => {
        try {
          const studio = studioFactory({ db, env });
          const result = await studio.run(mode, { history, text, attachments, options, isAdmin: req.user.admin });
          await db.query(
            "UPDATE ai_messages SET status = 'done', content = $2, sources = $3::jsonb, meta = $4::jsonb, provider = $5, model = $6, updated_at = NOW() WHERE id = $1",
            [pending.id, result.content, JSON.stringify(result.sources || []), JSON.stringify(result.meta || {}), result.provider, result.model]);
          // Asking the student to choose a course is not counted as a use.
          await finishUsage(db, jobUsage, result.needsCourse ? "failed" : "completed", { provider: result.provider, model: result.model });
        } catch (error) {
          const message = error instanceof AiError ? error.message : "Fire Counsel AI could not finish this request. Please try again — it was not counted.";
          if (!(error instanceof AiError)) console.error("AI job failed:", error?.name, error?.message);
          await db.query("UPDATE ai_messages SET status = 'failed', content = $2, meta = $3::jsonb, updated_at = NOW() WHERE id = $1",
            [pending.id, `${message}${error instanceof AiError ? " (This request was not counted.)" : ""}`, JSON.stringify({ code: error?.code || "AI_FAILED" })]).catch(() => {});
          await finishUsage(db, jobUsage, "failed").catch(() => {});
        }
      });

      res.status(202).json({ data: { conversation, messages: [messageRow(userMessage), messageRow(pending)] } });
    } catch (error) {
      if (usageId) await finishUsage(db, usageId, "failed").catch(() => {});
      publicAiError(res, error);
    }
  });

  return router;
}
