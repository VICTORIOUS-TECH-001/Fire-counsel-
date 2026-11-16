import express from "express";
import { rateLimit } from "express-rate-limit";
import { getPool } from "../config/database.js";
import { verifyFirebaseToken } from "../middleware/verifyFirebaseToken.js";

// Signed-in pages send a heartbeat about once a minute. An account counts as
// "Active" in the admin list while its last heartbeat is recent.
export function createPresenceRouter({ poolProvider = getPool, verifyToken = verifyFirebaseToken, configured = () => Boolean(process.env.DATABASE_URL) } = {}) {
  const router = express.Router();
  router.use(verifyToken);
  router.use(rateLimit({ windowMs: 15 * 60_000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false, keyGenerator: (req) => `presence:${req.user.uid}`, validate: false }));
  router.post("/", async (req, res) => {
    if (!configured()) return res.status(204).end();
    const page = typeof req.body?.page === "string" && /^[a-z0-9-]{1,40}$/.test(req.body.page) ? req.body.page : null;
    try {
      await poolProvider().query(
        `INSERT INTO user_presence (firebase_uid, email, display_name, last_seen_at, last_page)
         VALUES ($1, $2, $3, NOW(), $4)
         ON CONFLICT (firebase_uid) DO UPDATE SET email = EXCLUDED.email, display_name = COALESCE(EXCLUDED.display_name, user_presence.display_name), last_seen_at = NOW(), last_page = EXCLUDED.last_page`,
        [req.user.uid, req.user.email, req.user.name ? String(req.user.name).slice(0, 120) : null, page]);
      res.status(204).end();
    } catch (error) {
      if (error?.code !== "42P01") console.error("Presence update failed:", error?.code || error?.message);
      res.status(204).end();
    }
  });
  return router;
}
