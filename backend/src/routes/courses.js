// Public list of PUBLISHED courses. Administrators add and edit courses in the
// Admin Studio (Courses tab, stored in Neon); every student's "My courses"
// page reads this list, so a change appears for all users automatically.
import express from "express";
import { getPool } from "../config/database.js";

export function createCoursesRouter({ poolProvider = getPool, configured = () => Boolean(process.env.DATABASE_URL) } = {}) {
  const router = express.Router();
  router.get("/", async (_req, res) => {
    res.set("Cache-Control", "no-store");
    if (!configured()) return res.json({ data: [], database: "not_configured" });
    try {
      const result = await poolProvider().query(
        `SELECT c.id, c.course_code, c.title, LEFT(COALESCE(c.description, ''), 600) AS description,
                c.academic_level, c.semester, c.academic_session,
                COALESCE(u.short_name, u.name) AS university, c.updated_at
         FROM courses c
         LEFT JOIN universities u ON u.id = c.university_id
         WHERE c.is_published IS TRUE AND COALESCE(u.is_active, TRUE)
         ORDER BY c.course_code NULLS LAST, c.title
         LIMIT 300`
      );
      res.json({ data: result.rows });
    } catch (error) {
      if (error?.code === "42P01") return res.json({ data: [] });
      console.error("Course list failed:", error?.code || error?.name || "unknown");
      res.status(503).json({ error: "Courses are temporarily unavailable.", code: "DATABASE_UNAVAILABLE" });
    }
  });
  return router;
}
