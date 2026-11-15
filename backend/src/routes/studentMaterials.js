import express from "express";
import { getPool } from "../config/database.js";
import { verifyFirebaseToken } from "../middleware/verifyFirebaseToken.js";
import { materialAccessSql } from "../services/materialAccess.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACCESS_FILTER = materialAccessSql("m", "account");

const SAFE_COLUMNS = `
  m.id, m.title, m.description, m.material_type, m.source_category,
  m.university_id, m.course_id, m.topic_id, m.access_scope, m.published_at,
  course.title AS course_title, topic.title AS topic_title,
  latest.version_number, latest.extraction_status
`;

function publicDatabaseError(error) {
  if (error?.message === "DATABASE_URL is not configured.") {
    return { status: 503, error: "Neon is not configured on this server.", code: "DATABASE_NOT_CONFIGURED" };
  }
  console.error("Student materials request failed:", error?.code || error?.name || "unknown");
  return { status: 503, error: "Course materials are temporarily unavailable.", code: "DATABASE_UNAVAILABLE" };
}

export function createStudentMaterialsRouter({
  poolProvider = getPool,
  verifyToken = verifyFirebaseToken,
  configured = () => Boolean(process.env.DATABASE_URL)
} = {}) {
  const router = express.Router();
  router.use(verifyToken);

  router.get("/", async (req, res) => {
    if (!configured()) return res.status(503).json({ error: "Neon is not configured on this server.", code: "DATABASE_NOT_CONFIGURED" });
    const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
    const offset = Math.min(100_000, Math.max(0, Number.parseInt(req.query.offset, 10) || 0));
    try {
      const result = await poolProvider().query(
        `SELECT ${SAFE_COLUMNS}
         FROM materials m
         JOIN app_users account ON account.firebase_uid = $1 AND account.account_status = 'active'
         LEFT JOIN courses course ON course.id = m.course_id
         LEFT JOIN course_topics topic ON topic.id = m.topic_id
         LEFT JOIN LATERAL (
           SELECT version.version_number, version.extraction_status
           FROM material_versions version
           WHERE version.material_id = m.id
           ORDER BY version.version_number DESC LIMIT 1
         ) latest ON TRUE
         WHERE ${ACCESS_FILTER}
         ORDER BY m.published_at DESC NULLS LAST, m.created_at DESC
         LIMIT $2 OFFSET $3`,
        [req.user.uid, limit, offset]
      );
      res.json({ data: result.rows, pagination: { limit, offset } });
    } catch (error) {
      const safe = publicDatabaseError(error);
      res.status(safe.status).json({ error: safe.error, code: safe.code });
    }
  });

  router.get("/:id", async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: "Material ID must be a UUID.", code: "VALIDATION_ERROR" });
    if (!configured()) return res.status(503).json({ error: "Neon is not configured on this server.", code: "DATABASE_NOT_CONFIGURED" });
    try {
      const result = await poolProvider().query(
        `SELECT ${SAFE_COLUMNS}, latest.extracted_text
         FROM materials m
         JOIN app_users account ON account.firebase_uid = $1 AND account.account_status = 'active'
         LEFT JOIN courses course ON course.id = m.course_id
         LEFT JOIN course_topics topic ON topic.id = m.topic_id
         LEFT JOIN LATERAL (
           SELECT version.version_number, version.extraction_status, version.extracted_text
           FROM material_versions version
           WHERE version.material_id = m.id
           ORDER BY version.version_number DESC LIMIT 1
         ) latest ON TRUE
         WHERE m.id = $2 AND ${ACCESS_FILTER}
         LIMIT 1`,
        [req.user.uid, req.params.id]
      );
      if (!result.rows.length) return res.status(404).json({ error: "Approved material not found or not available to this account.", code: "NOT_FOUND" });
      res.json({ data: result.rows[0] });
    } catch (error) {
      const safe = publicDatabaseError(error);
      res.status(safe.status).json({ error: safe.error, code: safe.code });
    }
  });

  return router;
}
