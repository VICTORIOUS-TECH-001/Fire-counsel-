import express from "express";
import { getPool } from "../config/database.js";
import { verifyFirebaseToken } from "../middleware/verifyFirebaseToken.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { createAdminProviderTestGate, createAdminRequestGate } from "../middleware/adminRateLimit.js";
import { AiError } from "../services/ai/providers.js";
import { describeAdminProviders, testAdminProvider } from "../services/documents/adminProviders.js";
import { createWorkstation, STATION_LIMITS } from "../services/documents/workstation.js";
import { createDocumentImporter } from "../services/documents/importer.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPES = new Set(["lecture_note", "textbook", "handout", "case_material", "statute", "past_question", "marking_scheme", "course_outline", "model_answer", "other"]);
const fail = (res, status, error, code) => res.status(status).json({ error, code });
function handle(res, error) {
  if (["42P01", "42703"].includes(error?.code)) return fail(res, 503, "The existing document-library tables are not ready. Review the Neon database migrations before saving. Your draft can still be downloaded.", "UPLOADS_SCHEMA_NOT_READY");
  if (error?.status && error?.code) return fail(res, error.status, error.message, error.code);
  console.error("Working Station request failed:", error?.code || error?.name);
  return fail(res, 500, "The operation could not be confirmed. Keep your draft and check Recent uploads before creating another save.", "STATION_FAILED");
}
function approval(body) {
  const bad = message => { throw new AiError(400, message, "VALIDATION_ERROR"); };
  if (!body || typeof body !== "object" || Array.isArray(body)) bad("Review and approve the text first.");
  for (const key of Object.keys(body)) if (!["approved", "acknowledge_incomplete", "text", "title", "purpose", "material_type", "course_id", "material_id", "publish"].includes(key)) bad(`Unknown approval field: ${key}.`);
  if (body.approved !== true) throw new AiError(400, "Explicit review approval is required before a database write.", "APPROVAL_REQUIRED");
  const text = typeof body.text === "string" ? body.text.replace(/\r\n?/g, "\n").trim() : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!text || text.length > STATION_LIMITS.text_characters * 2) bad("Review nonempty text within the 360,000-character result limit.");
  if (!title || title.length > 250 || /[\u0000-\u001f\u007f]/.test(title)) bad("Enter a document title from 1 to 250 characters.");
  const purpose = body.purpose || "material";
  if (!["material", "material_version"].includes(purpose)) bad("Choose a new library material or a new material version. Classic upload still handles structured cases and past-question imports.");
  const materialType = body.material_type || "lecture_note";
  if (!TYPES.has(materialType)) bad("Choose a valid library material type.");
  const options = { purpose, title, material_type: materialType, publish: body.publish === true };
  for (const field of ["course_id", "material_id"]) {
    if (body[field] == null || body[field] === "") continue;
    if (typeof body[field] !== "string" || !UUID.test(body[field])) bad(`Choose a valid ${field === "course_id" ? "course" : "material"}.`);
    options[field] = body[field];
  }
  if (purpose === "material_version" && !options.material_id) bad("Choose the material that should receive this new text version.");
  if (purpose === "material" && options.material_id) bad("A new material cannot specify an existing material id.");
  if (body.publish != null && typeof body.publish !== "boolean") bad("Publication must be an explicit yes/no choice.");
  const name = `${title.replace(/[\u0000-\u001f\u007f/\\]/g, "_").slice(0, 190)}.txt`;
  return { text, options, name };
}

export function createAdminWorkstationRouter({ env = process.env, poolProvider = getPool, verifyToken = verifyFirebaseToken,
  adminGate = requireAdmin, requestGate = createAdminRequestGate(), configured = () => Boolean(env.DATABASE_URL), workstation, importer, fetchImpl = fetch } = {}) {
  const router = express.Router();
  const station = workstation || createWorkstation({ env, fetchImpl });
  const library = importer || createDocumentImporter({ env, poolProvider, fetchImpl });
  router.use(verifyToken, adminGate, requestGate);
  router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

  router.get("/status", async (_req, res) => {
    let database = configured() ? "configured" : "not_configured";
    if (configured()) {
      try {
        await poolProvider().query("SELECT u.id, v.id, c.id FROM uploaded_files u, material_versions v, material_chunks c LIMIT 0");
        database = "ready";
      } catch (error) { database = ["42P01", "42703"].includes(error.code) ? "schema_not_ready" : "unavailable"; }
    }
    res.json({ data: { providers: describeAdminProviders(env), limits: STATION_LIMITS, database,
      persistence: "Drafts are temporary server memory, expire after one hour and are lost on restart. Nothing enters Neon until explicit approval. Download important drafts." } });
  });
  router.post("/providers/test", createAdminProviderTestGate(), async (req, res) => {
    try {
      if (!req.body || Array.isArray(req.body) || Object.keys(req.body).some(key => key !== "provider")) throw new AiError(400, "Send only the admin provider to test. Do not send keys or documents.", "VALIDATION_ERROR");
      res.json({ data: await testAdminProvider(req.body.provider, { env, fetchImpl }) });
    } catch (error) { handle(res, error); }
  });
  router.post("/jobs", (req, res) => {
    try { res.status(202).json({ data: station.start(req.user.uid, req.body) }); }
    catch (error) { handle(res, error); }
  });
  router.get("/jobs/:id", (req, res) => {
    try { res.json({ data: station.get(req.params.id, req.user.uid) }); }
    catch (error) { handle(res, error); }
  });
  router.delete("/jobs/:id", (req, res) => {
    try { station.cancel(req.params.id, req.user.uid); res.status(204).end(); }
    catch (error) { handle(res, error); }
  });
  router.post("/jobs/:id/save", async (req, res) => {
    try {
      const reviewed = approval(req.body);
      // Ownership/ready/approval checks happen before any database call.
      const saved = await station.save(req.params.id, req.user.uid, req.body, async job => {
        if (!configured()) throw new AiError(503, "Neon is not configured. Download the TXT; configure DATABASE_URL before approving a save.", "DATABASE_NOT_CONFIGURED");
        return library.saveReviewed({ id: job.id, actor: { uid: req.user.uid, email: req.user.email,
          name: req.user.name, emailVerified: req.user.emailVerified === true }, ...reviewed, warnings: [...job.result.warnings] });
      });
      res.json({ data: saved });
    } catch (error) { handle(res, error); }
  });
  return router;
}
