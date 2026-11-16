// Daily AI allowances. Defaults: 20 chats and 3 case analyses per day; admins
// can change the defaults and give any account more or less (or pause it).
// Reservation is atomic per account so parallel requests cannot exceed a limit.
import { AiError } from "./providers.js";

export const FEATURES = Object.freeze({
  chat: { column: "chat_daily", default: 20, label: "AI chat messages" },
  case: { column: "case_daily", default: 3, label: "Case analyses" },
  notes: { column: "notes_daily", default: 3, label: "Exam-ready notes" },
  questions: { column: "questions_daily", default: 5, label: "Question sets" }
});

export const timezone = (env = process.env) => (/^[A-Za-z_]+\/[A-Za-z_]+$/.test(env.AI_TIMEZONE || "") ? env.AI_TIMEZONE : "Africa/Lagos");
const dayStart = "(date_trunc('day', NOW() AT TIME ZONE $2) AT TIME ZONE $2)";

export async function getDefaultLimits(db) {
  const limits = Object.fromEntries(Object.entries(FEATURES).map(([key, feature]) => [key, feature.default]));
  const result = await db.query("SELECT value FROM ai_settings WHERE key = 'default_limits'");
  const saved = result.rows[0]?.value || {};
  for (const key of Object.keys(FEATURES)) {
    if (Number.isInteger(saved[key]) && saved[key] >= 0) limits[key] = saved[key];
  }
  return limits;
}

export async function getAllowance(db, uid, { env = process.env, isAdmin = false } = {}) {
  const [defaults, overrides, usage] = await Promise.all([
    getDefaultLimits(db),
    db.query("SELECT * FROM ai_user_limits WHERE firebase_uid = $1", [uid]),
    db.query(
      `SELECT feature, count(*)::int AS used FROM ai_usage
        WHERE firebase_uid = $1 AND status IN ('started', 'completed') AND created_at >= ${dayStart}
        GROUP BY feature`, [uid, timezone(env)])
  ]);
  const override = overrides.rows[0] || {};
  const used = Object.fromEntries(usage.rows.map((row) => [row.feature, row.used]));
  const features = {};
  for (const [key, feature] of Object.entries(FEATURES)) {
    const custom = override[feature.column];
    const limit = isAdmin ? null : (Number.isInteger(custom) ? custom : defaults[key]);
    const count = used[key] || 0;
    features[key] = { label: feature.label, limit, used: count, remaining: limit == null ? null : Math.max(limit - count, 0), custom: Number.isInteger(custom) };
  }
  return { paused: !isAdmin && override.paused === true, unlimited: isAdmin, timezone: timezone(env), features };
}

/** Atomically checks the allowance and records a started request. */
export async function reserveUsage(pool, uid, feature, { env = process.env, isAdmin = false } = {}) {
  if (!FEATURES[feature] && feature !== "extract") throw new AiError(400, "Unknown AI feature.", "VALIDATION_ERROR");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`ai:${uid}`]);
    // A crashed/restarted server can leave a request "started"; release it.
    await client.query("UPDATE ai_usage SET status = 'failed', finished_at = NOW() WHERE firebase_uid = $1 AND status = 'started' AND created_at < NOW() - interval '20 minutes'", [uid]);
    if (!isAdmin && feature !== "extract") {
      const allowance = await getAllowance(client, uid, { env });
      if (allowance.paused) throw new AiError(403, "AI access is paused for this account. Contact the FIRE COUNSEL administrator.", "AI_PAUSED");
      const state = allowance.features[feature];
      if (state.limit != null && state.used >= state.limit) {
        throw new AiError(429, `You have used all ${state.limit} ${state.label.toLowerCase()} for today. Your allowance resets at midnight (${allowance.timezone}).`, "LIMIT_REACHED");
      }
    }
    const inserted = await client.query("INSERT INTO ai_usage (firebase_uid, feature) VALUES ($1, $2) RETURNING id", [uid, feature]);
    await client.query("COMMIT");
    return inserted.rows[0].id;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* keep original error */ }
    throw error;
  } finally {
    client.release();
  }
}

export async function finishUsage(db, id, status, { provider = null, model = null } = {}) {
  if (!id) return;
  await db.query("UPDATE ai_usage SET status = $2, provider = $3, model = $4, finished_at = NOW() WHERE id = $1", [id, status, provider, model]);
}

export function validateLimit(value, label) {
  if (value === null || value === "" || value === undefined) return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 100_000) {
    throw new AiError(400, `${label} must be a whole number from 0 to 100000, or empty to use the default.`, "VALIDATION_ERROR");
  }
  return number;
}
