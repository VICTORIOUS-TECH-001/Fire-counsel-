import express from "express";
import { getPool } from "../config/database.js";
import { verifyFirebaseToken } from "../middleware/verifyFirebaseToken.js";
import { materialAccessSql } from "../services/materialAccess.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MATERIAL_ACCESS = materialAccessSql("m", "account");

function normalizeOptionalId(value, label) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    const error = new Error(`${label} must be a valid record ID.`);
    error.status = 400;
    error.code = "VALIDATION_ERROR";
    throw error;
  }
  return value;
}

function publicError(error) {
  if (error.status) return { status: error.status, error: error.message, code: error.code };
  if (error.message === "DATABASE_URL is not configured.") return { status: 503, error: "Neon is not configured on this server.", code: "DATABASE_NOT_CONFIGURED" };
  console.error("Verified source search failed:", error?.code || error?.name || "unknown");
  return { status: 503, error: "Verified source search is temporarily unavailable.", code: "SEARCH_UNAVAILABLE" };
}

export function createResearchSearchRouter({
  poolProvider = getPool,
  verifyToken = verifyFirebaseToken,
  configured = () => Boolean(process.env.DATABASE_URL)
} = {}) {
  const router = express.Router();
  router.use(verifyToken);

  router.post("/search", async (req, res) => {
    const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
    if (query.length < 3 || query.length > 500) {
      return res.status(400).json({ error: "Search query must be between 3 and 500 characters.", code: "VALIDATION_ERROR" });
    }
    if (!configured()) return res.status(503).json({ error: "Neon is not configured on this server.", code: "DATABASE_NOT_CONFIGURED" });

    try {
      const courseId = normalizeOptionalId(req.body?.course_id, "Course");
      const universityId = normalizeOptionalId(req.body?.university_id, "University");
      const db = poolProvider();
      const params = [req.user.uid, query, courseId, universityId];

      const materials = await db.query(
        `SELECT m.id AS material_id, m.title, course.title AS course_title,
                chunk.chunk_number, chunk.page_number, chunk.section_heading, chunk.content,
                ts_rank_cd(to_tsvector('english', COALESCE(m.title, '') || ' ' || chunk.content), websearch_to_tsquery('english', $2)) AS score
         FROM materials m
         JOIN app_users account ON account.firebase_uid = $1 AND account.account_status = 'active'
         JOIN material_chunks chunk ON chunk.material_id = m.id
         LEFT JOIN courses course ON course.id = m.course_id
         WHERE ${MATERIAL_ACCESS}
           AND to_tsvector('english', COALESCE(m.title, '') || ' ' || chunk.content) @@ websearch_to_tsquery('english', $2)
           AND ($3::uuid IS NULL OR m.course_id = $3 OR m.course_id IS NULL)
           AND ($4::uuid IS NULL OR m.university_id = $4 OR m.university_id IS NULL)
         ORDER BY score DESC LIMIT 8`,
        params
      );

      const cases = await db.query(
        `SELECT case_record.id, case_record.case_name, case_record.citation, case_record.court,
                case_record.jurisdiction, case_record.year, case_record.material_facts,
                case_record.legal_issues, case_record.decision, case_record.ratio_decidendi,
                case_record.obiter_dicta, case_record.source_material_id
         FROM legal_cases case_record
         JOIN app_users account ON account.firebase_uid = $1 AND account.account_status = 'active'
         WHERE case_record.verification_status = 'verified'
           AND to_tsvector('english', concat_ws(' ', case_record.case_name, case_record.citation,
               case_record.material_facts, case_record.legal_issues, case_record.decision,
               case_record.ratio_decidendi, case_record.obiter_dicta)) @@ websearch_to_tsquery('english', $2)
           AND (case_record.source_material_id IS NULL OR EXISTS (
             SELECT 1 FROM materials m WHERE m.id = case_record.source_material_id AND ${MATERIAL_ACCESS}
               AND ($3::uuid IS NULL OR m.course_id = $3 OR m.course_id IS NULL)
               AND ($4::uuid IS NULL OR m.university_id = $4 OR m.university_id IS NULL)
           ))
         ORDER BY ts_rank_cd(to_tsvector('english', concat_ws(' ', case_record.case_name,
             case_record.citation, case_record.material_facts, case_record.legal_issues,
             case_record.ratio_decidendi)), websearch_to_tsquery('english', $2)) DESC
         LIMIT 6`,
        params
      );

      const statutes = await db.query(
        `SELECT statute.id AS statute_id, statute.title, statute.jurisdiction, statute.year,
                statute.source_url, section.id AS section_id, section.section_number,
                section.heading, section.full_text, section.legal_effect, section.amendment_note
         FROM statutes statute
         JOIN statute_sections section ON section.statute_id = statute.id
         JOIN app_users account ON account.firebase_uid = $1 AND account.account_status = 'active'
         WHERE statute.verification_status = 'verified'
           AND to_tsvector('english', concat_ws(' ', statute.title, statute.short_title,
               section.section_number, section.heading, section.full_text, section.legal_effect,
               section.amendment_note)) @@ websearch_to_tsquery('english', $2)
           AND (statute.source_material_id IS NULL OR EXISTS (
             SELECT 1 FROM materials m WHERE m.id = statute.source_material_id AND ${MATERIAL_ACCESS}
               AND ($3::uuid IS NULL OR m.course_id = $3 OR m.course_id IS NULL)
               AND ($4::uuid IS NULL OR m.university_id = $4 OR m.university_id IS NULL)
           ))
         ORDER BY ts_rank_cd(to_tsvector('english', concat_ws(' ', statute.title,
             section.section_number, section.full_text)), websearch_to_tsquery('english', $2)) DESC
         LIMIT 6`,
        params
      );

      const pastQuestions = await db.query(
        `SELECT question.id, question.question_number, question.examination_year,
                question.semester, question.question_text, question.marks,
                course.title AS course_title, question.course_id, question.university_id
         FROM past_questions question
         JOIN app_users account ON account.firebase_uid = $1 AND account.account_status = 'active'
         LEFT JOIN courses course ON course.id = question.course_id
         WHERE question.verification_status = 'verified'
           AND question.provenance = 'verified_past_question'
           AND to_tsvector('english', question.question_text) @@ websearch_to_tsquery('english', $2)
           AND ($3::uuid IS NULL OR question.course_id = $3 OR question.course_id IS NULL)
           AND ($4::uuid IS NULL OR question.university_id = $4 OR question.university_id IS NULL)
           AND (question.course_id IS NULL OR EXISTS (
             SELECT 1 FROM course_enrollments enrollment WHERE enrollment.user_id = account.id
               AND enrollment.course_id = question.course_id AND enrollment.enrollment_status IN ('active', 'completed')
           ))
           AND (question.university_id IS NULL OR EXISTS (
             SELECT 1 FROM institution_memberships membership WHERE membership.user_id = account.id
               AND membership.university_id = question.university_id AND membership.membership_status = 'active'
           ))
           AND (question.source_material_id IS NULL OR EXISTS (
             SELECT 1 FROM materials m WHERE m.id = question.source_material_id AND ${MATERIAL_ACCESS}
           ))
         ORDER BY ts_rank_cd(to_tsvector('english', question.question_text), websearch_to_tsquery('english', $2)) DESC
         LIMIT 5`,
        params
      );

      const mnemonics = await db.query(
        `SELECT mnemonic.id, mnemonic.case_id, mnemonic.mnemonic, mnemonic.explanation,
                case_record.case_name, case_record.citation
         FROM case_mnemonics mnemonic
         JOIN legal_cases case_record ON case_record.id = mnemonic.case_id
         JOIN app_users account ON account.firebase_uid = $1 AND account.account_status = 'active'
         WHERE mnemonic.is_verified = TRUE
           AND case_record.verification_status = 'verified'
           AND to_tsvector('english', concat_ws(' ', mnemonic.mnemonic, mnemonic.explanation,
               case_record.case_name, case_record.citation)) @@ websearch_to_tsquery('english', $2)
           AND (case_record.source_material_id IS NULL OR EXISTS (
             SELECT 1 FROM materials m WHERE m.id = case_record.source_material_id AND ${MATERIAL_ACCESS}
               AND ($3::uuid IS NULL OR m.course_id = $3 OR m.course_id IS NULL)
               AND ($4::uuid IS NULL OR m.university_id = $4 OR m.university_id IS NULL)
           ))
         ORDER BY ts_rank_cd(to_tsvector('english', concat_ws(' ', mnemonic.mnemonic,
             mnemonic.explanation, case_record.case_name)), websearch_to_tsquery('english', $2)) DESC
         LIMIT 5`,
        params
      );

      const summaries = await db.query(
        `SELECT summary.id, summary.case_id, summary.full_summary, summary.revision_summary,
                summary.exam_ready_summary, summary.memory_trigger, summary.key_principle,
                case_record.case_name, case_record.citation
         FROM case_memory_summaries summary
         JOIN legal_cases case_record ON case_record.id = summary.case_id
         JOIN app_users account ON account.firebase_uid = $1 AND account.account_status = 'active'
         WHERE summary.review_status = 'approved'
           AND case_record.verification_status = 'verified'
           AND to_tsvector('english', concat_ws(' ', summary.full_summary, summary.revision_summary,
               summary.exam_ready_summary, summary.memory_trigger, summary.key_principle,
               case_record.case_name, case_record.citation)) @@ websearch_to_tsquery('english', $2)
           AND (case_record.source_material_id IS NULL OR EXISTS (
             SELECT 1 FROM materials m WHERE m.id = case_record.source_material_id AND ${MATERIAL_ACCESS}
               AND ($3::uuid IS NULL OR m.course_id = $3 OR m.course_id IS NULL)
               AND ($4::uuid IS NULL OR m.university_id = $4 OR m.university_id IS NULL)
           ))
         ORDER BY ts_rank_cd(to_tsvector('english', concat_ws(' ', summary.full_summary,
             summary.key_principle, case_record.case_name)), websearch_to_tsquery('english', $2)) DESC
         LIMIT 5`,
        params
      );

      const rubrics = await db.query(
        `SELECT rubric.id, rubric.title, rubric.total_marks, rubric.instructions,
                question.id AS question_id, question.question_text, course.title AS course_title,
                criteria.items AS criteria
         FROM marking_rubrics rubric
         JOIN past_questions question ON question.id = rubric.question_id
         JOIN app_users account ON account.firebase_uid = $1 AND account.account_status = 'active'
         LEFT JOIN courses course ON course.id = rubric.course_id
         LEFT JOIN LATERAL (
           SELECT json_agg(json_build_object('criterion', criterion.criterion,
                    'description', criterion.description, 'marks', criterion.marks_available)
                    ORDER BY criterion.criterion_order) AS items
           FROM marking_criteria criterion WHERE criterion.rubric_id = rubric.id
         ) criteria ON TRUE
         WHERE question.verification_status = 'verified'
           AND question.provenance = 'verified_past_question'
           AND to_tsvector('english', concat_ws(' ', rubric.title, rubric.instructions,
               question.question_text)) @@ websearch_to_tsquery('english', $2)
           AND ($3::uuid IS NULL OR rubric.course_id = $3 OR question.course_id = $3
                OR (rubric.course_id IS NULL AND question.course_id IS NULL))
           AND (COALESCE(rubric.course_id, question.course_id) IS NULL OR EXISTS (
             SELECT 1 FROM course_enrollments enrollment WHERE enrollment.user_id = account.id
               AND enrollment.course_id = COALESCE(rubric.course_id, question.course_id)
               AND enrollment.enrollment_status IN ('active', 'completed')
           ))
           AND (question.university_id IS NULL OR EXISTS (
             SELECT 1 FROM institution_memberships membership WHERE membership.user_id = account.id
               AND membership.university_id = question.university_id AND membership.membership_status = 'active'
           ))
           AND (question.source_material_id IS NULL OR EXISTS (
             SELECT 1 FROM materials m WHERE m.id = question.source_material_id AND ${MATERIAL_ACCESS}
           ))
         ORDER BY ts_rank_cd(to_tsvector('english', concat_ws(' ', rubric.title,
             rubric.instructions, question.question_text)), websearch_to_tsquery('english', $2)) DESC
         LIMIT 5`,
        params
      );

      res.json({
        data: {
          materials: materials.rows,
          cases: cases.rows,
          statutes: statutes.rows,
          pastQuestions: pastQuestions.rows,
          mnemonics: mnemonics.rows,
          summaries: summaries.rows,
          rubrics: rubrics.rows
        },
        pipeline: { retrieval: "neon-full-text", aiGeneration: "disabled-pending-provider-review", externalProviderCalled: false }
      });
    } catch (error) {
      const safe = publicError(error);
      res.status(safe.status).json({ error: safe.error, code: safe.code });
    }
  });

  return router;
}
