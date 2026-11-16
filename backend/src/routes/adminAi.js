import express from "express";
import { getPool } from "../config/database.js";
import { getFirebaseAuth } from "../config/firebaseAdmin.js";
import { verifyFirebaseToken } from "../middleware/verifyFirebaseToken.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { AiError, describeProviders, generate as defaultGenerate } from "../services/ai/providers.js";
import { createStudio } from "../services/ai/studio.js";
import { BUILT_IN_PROMPTS, PROMPT_KINDS, clearPromptCache } from "../services/ai/prompts.js";
import { FEATURES, getDefaultLimits, timezone, validateLimit } from "../services/ai/quota.js";
import { validateAttachments } from "../services/ai/attachments.js";
import { publicAiError } from "./ai.js";

const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const LIMIT_COLUMNS = Object.fromEntries(Object.entries(FEATURES).map(([key, feature]) => [key, feature.column]));

export function createAdminAiRouter({
  poolProvider = getPool,
  verifyToken = verifyFirebaseToken,
  authProvider = getFirebaseAuth,
  env = process.env,
  generate = defaultGenerate,
  studioFactory = createStudio,
  configured = () => Boolean(env.DATABASE_URL)
} = {}) {
  const router = express.Router();
  router.use(verifyToken, requireAdmin);
  const onlineSeconds = Math.min(Math.max(Number(env.PRESENCE_ONLINE_SECONDS) || 150, 30), 3600);

  router.get("/status", async (req, res) => {
    const providers = describeProviders(env);
    const data = { providers, database: configured() ? "configured" : "not_configured", schema_ready: false, prompts: [], limits: null, today: {}, timezone: timezone(env) };
    if (!configured()) return res.json({ data });
    try {
      const db = poolProvider();
      const [prompts, limits, today] = await Promise.all([
        db.query("SELECT kind, char_length(content) AS length, updated_at, updated_by FROM ai_prompts"),
        getDefaultLimits(db),
        db.query(`SELECT feature, count(*) FILTER (WHERE status <> 'failed')::int AS used, count(*) FILTER (WHERE status = 'failed')::int AS failed
                    FROM ai_usage WHERE created_at >= (date_trunc('day', NOW() AT TIME ZONE $1) AT TIME ZONE $1) GROUP BY feature`, [timezone(env)])
      ]);
      const saved = new Map(prompts.rows.map((row) => [row.kind, row]));
      data.schema_ready = true;
      data.prompts = Object.entries(PROMPT_KINDS).map(([kind, label]) => ({ kind, label, custom: saved.has(kind), length: saved.get(kind)?.length || BUILT_IN_PROMPTS[kind].length, updated_at: saved.get(kind)?.updated_at || null }));
      data.limits = limits;
      data.today = Object.fromEntries(today.rows.map((row) => [row.feature, { used: row.used, failed: row.failed }]));
      res.json({ data });
    } catch (error) {
      if (error?.code === "42P01") return res.json({ data });
      publicAiError(res, error);
    }
  });

  router.post("/test", async (req, res) => {
    try {
      const result = await generate({ messages: [{ role: "user", text: "Reply with exactly this sentence: FIRE COUNSEL AI is connected." }], maxTokens: 64, temperature: 0 }, { env });
      let search = null;
      if (req.body?.search === true) {
        try {
          const grounded = await generate({ search: true, messages: [{ role: "user", text: "Find the official website of the Supreme Court of Nigeria. Reply in one sentence." }], maxTokens: 256 }, { env });
          search = { ok: true, model: grounded.model, sources: grounded.sources.length };
        } catch (error) {
          search = { ok: false, error: error.message };
        }
      }
      res.json({ data: { ok: true, provider: result.provider, model: result.model, reply: result.text.slice(0, 200), fallback: Boolean(result.fallback), search } });
    } catch (error) { publicAiError(res, error); }
  });

  router.get("/prompts/:kind", async (req, res) => {
    if (!PROMPT_KINDS[req.params.kind]) return res.status(404).json({ error: "Unknown prompt.", code: "NOT_FOUND" });
    try {
      const result = await poolProvider().query("SELECT content, updated_at FROM ai_prompts WHERE kind = $1", [req.params.kind]);
      res.json({ data: { kind: req.params.kind, custom: Boolean(result.rows[0]), content: result.rows[0]?.content || BUILT_IN_PROMPTS[req.params.kind], updated_at: result.rows[0]?.updated_at || null } });
    } catch (error) { publicAiError(res, error); }
  });

  router.put("/prompts/:kind", async (req, res) => {
    if (!PROMPT_KINDS[req.params.kind]) return res.status(404).json({ error: "Unknown prompt.", code: "NOT_FOUND" });
    const content = typeof req.body?.content === "string" ? req.body.content.replace(/\r\n/g, "\n").trim() : "";
    if (content.length < 20 || content.length > 200_000) return res.status(400).json({ error: "The prompt must be between 20 and 200,000 characters.", code: "VALIDATION_ERROR" });
    try {
      await poolProvider().query(
        `INSERT INTO ai_prompts (kind, content, updated_by) VALUES ($1, $2, $3)
         ON CONFLICT (kind) DO UPDATE SET content = EXCLUDED.content, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
        [req.params.kind, content, req.user.email || req.user.uid]);
      clearPromptCache();
      res.json({ data: { kind: req.params.kind, custom: true, length: content.length } });
    } catch (error) { publicAiError(res, error); }
  });

  router.delete("/prompts/:kind", async (req, res) => {
    if (!PROMPT_KINDS[req.params.kind]) return res.status(404).json({ error: "Unknown prompt.", code: "NOT_FOUND" });
    try {
      await poolProvider().query("DELETE FROM ai_prompts WHERE kind = $1", [req.params.kind]);
      clearPromptCache();
      res.status(204).end();
    } catch (error) { publicAiError(res, error); }
  });

  router.put("/limits", async (req, res) => {
    try {
      const value = {};
      for (const [key, feature] of Object.entries(FEATURES)) {
        const limit = validateLimit(req.body?.[key], feature.label);
        value[key] = limit == null ? feature.default : limit;
      }
      await poolProvider().query(
        `INSERT INTO ai_settings (key, value, updated_by) VALUES ('default_limits', $1::jsonb, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
        [JSON.stringify(value), req.user.email || req.user.uid]);
      res.json({ data: value });
    } catch (error) { publicAiError(res, error); }
  });

  router.get("/users", async (req, res) => {
    let auth;
    try { auth = authProvider(); } catch { return res.status(503).json({ error: "Firebase Admin is not configured, so the account list is unavailable.", code: "FIREBASE_NOT_CONFIGURED" }); }
    try {
      const firebaseUsers = [];
      let pageToken;
      for (let page = 0; page < 5; page += 1) {
        const result = await auth.listUsers(1000, pageToken);
        firebaseUsers.push(...result.users);
        pageToken = result.pageToken;
        if (!pageToken) break;
      }
      const db = poolProvider();
      const tz = timezone(env);
      const [presence, usage, limits, defaults] = await Promise.all([
        db.query("SELECT firebase_uid, last_seen_at, last_page, EXTRACT(EPOCH FROM (NOW() - last_seen_at))::int AS seconds_ago FROM user_presence"),
        db.query(`SELECT firebase_uid, feature, count(*)::int AS used FROM ai_usage
                   WHERE status <> 'failed' AND created_at >= (date_trunc('day', NOW() AT TIME ZONE $1) AT TIME ZONE $1) GROUP BY firebase_uid, feature`, [tz]),
        db.query("SELECT * FROM ai_user_limits"),
        getDefaultLimits(db)
      ]);
      const presenceMap = new Map(presence.rows.map((row) => [row.firebase_uid, row]));
      const limitMap = new Map(limits.rows.map((row) => [row.firebase_uid, row]));
      const usageMap = new Map();
      for (const row of usage.rows) {
        if (!usageMap.has(row.firebase_uid)) usageMap.set(row.firebase_uid, {});
        usageMap.get(row.firebase_uid)[row.feature] = row.used;
      }
      const query = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase().slice(0, 100) : "";
      const users = firebaseUsers.map((user) => {
        const seen = presenceMap.get(user.uid);
        const override = limitMap.get(user.uid) || {};
        return {
          uid: user.uid,
          email: user.email || null,
          name: user.displayName || null,
          disabled: user.disabled === true,
          email_verified: user.emailVerified === true,
          admin: user.customClaims?.admin === true,
          providers: (user.providerData || []).map((p) => p.providerId).filter(Boolean),
          created_at: user.metadata?.creationTime || null,
          last_sign_in: user.metadata?.lastSignInTime || null,
          last_seen_at: seen?.last_seen_at || null,
          last_page: seen?.last_page || null,
          online: Boolean(seen && seen.seconds_ago <= onlineSeconds),
          usage_today: usageMap.get(user.uid) || {},
          limits: Object.fromEntries(Object.entries(LIMIT_COLUMNS).map(([key, column]) => [key, Number.isInteger(override[column]) ? override[column] : null])),
          paused: override.paused === true,
          note: override.note || null
        };
      }).filter((user) => !query || [user.email, user.name, user.uid].some((value) => value && value.toLowerCase().includes(query)))
        .sort((a, b) => (b.online - a.online) || String(b.last_seen_at || b.last_sign_in || "").localeCompare(String(a.last_seen_at || a.last_sign_in || "")) || String(a.email).localeCompare(String(b.email)));
      res.json({ data: { users, total: users.length, online: users.filter((u) => u.online).length, defaults, online_window_seconds: onlineSeconds, truncated: Boolean(pageToken) } });
    } catch (error) { publicAiError(res, error); }
  });

  router.put("/users/:uid/limits", async (req, res) => {
    if (!UID_RE.test(req.params.uid)) return res.status(404).json({ error: "Account not found.", code: "NOT_FOUND" });
    try {
      try { await authProvider().getUser(req.params.uid); } catch (error) {
        if (error?.code === "auth/user-not-found") return res.status(404).json({ error: "Account not found.", code: "NOT_FOUND" });
        throw error;
      }
      const values = {};
      for (const [key, feature] of Object.entries(FEATURES)) values[feature.column] = validateLimit(req.body?.[key], feature.label);
      const paused = req.body?.paused === true;
      const note = typeof req.body?.note === "string" && req.body.note.trim() ? req.body.note.trim().slice(0, 280) : null;
      await poolProvider().query(
        `INSERT INTO ai_user_limits (firebase_uid, chat_daily, case_daily, notes_daily, questions_daily, paused, note, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (firebase_uid) DO UPDATE SET chat_daily = EXCLUDED.chat_daily, case_daily = EXCLUDED.case_daily, notes_daily = EXCLUDED.notes_daily,
           questions_daily = EXCLUDED.questions_daily, paused = EXCLUDED.paused, note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
        [req.params.uid, values.chat_daily, values.case_daily, values.notes_daily, values.questions_daily, paused, note, req.user.email || req.user.uid]);
      res.json({ data: { uid: req.params.uid, limits: { chat: values.chat_daily, case: values.case_daily, notes: values.notes_daily, questions: values.questions_daily }, paused, note } });
    } catch (error) { publicAiError(res, error); }
  });

  // Turn an uploaded PDF/photo of course material into text for the admin to
  // review before saving it as a material version.
  router.post("/extract", async (req, res) => {
    try {
      const [file] = validateAttachments(req.body?.attachment ? [req.body.attachment] : []);
      if (!file) throw new AiError(400, "Choose a PDF, photo or text file.", "VALIDATION_ERROR");
      const result = await studioFactory({ db: poolProvider(), env, generate }).extractText(file);
      res.json({ data: result });
    } catch (error) { publicAiError(res, error); }
  });

  return router;
}
