// Website publishing: primary Firestore content through the verified admin
// API; Neon keeps drafts, archives, public JSON fallback and slide photos.
//
//  Admin:   POST /api/v1/admin/site/firebase        validated primary publish
//           GET  /api/v1/admin/site                 Neon draft, fallback, versions
//           PUT  /api/v1/admin/site/draft           save the draft (not public)
//           POST /api/v1/admin/site/publish         Neon archive/fallback only
//           GET  /api/v1/admin/site/versions/:id    archive for browser Firebase restore
//           POST /api/v1/admin/site/versions/:id/restore  legacy Neon fallback only
//           POST /api/v1/admin/site/images          raw JPG/PNG/WEBP -> /media/<id>.<ext>
//  Public:  GET  /data/site-content.json            published content (falls back to the bundled file)
//           GET  /media/<id>.<ext>                  slideshow photos
import express from "express";
import { getPool } from "../config/database.js";
import { verifyFirebaseToken } from "../middleware/verifyFirebaseToken.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { FieldValue } from "firebase-admin/firestore";
import { getFirebaseFirestore } from "../config/firebaseAdmin.js";
import { validateSiteContent as validatePublicSiteContent } from "../../../firebase/content-schema.mjs";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_RE = new RegExp(`^${UUID}$`, "i");
const MEDIA_RE = new RegExp(`^(${UUID})\\.(jpg|png|webp)$`, "i");
const MAX_CONTENT_BYTES = 512 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const KEEP_VERSIONS = 50;
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

class SiteError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

function imageType(buffer) {
  if (!buffer?.length) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer[0] === 0x89 && buffer.subarray(1, 4).toString("latin1") === "PNG") return "image/png";
  if (buffer.subarray(0, 4).toString("latin1") === "RIFF" && buffer.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

/** Checks the homepage content has the parts site.js needs. Returns the content. */
export function validateSiteContent(content) {
  const fail = (message) => { throw new SiteError(400, message, "VALIDATION_ERROR"); };
  if (!content || typeof content !== "object" || Array.isArray(content)) fail("Website content must be a JSON object.");
  if (typeof content.brand?.name !== "string" || !content.brand.name.trim()) fail("brand.name (the site name) is required.");
  if (!Array.isArray(content.navigation)) fail("navigation must be a list of links.");
  if (!Array.isArray(content.hero?.slides) || !content.hero.slides.length) fail("hero.slides needs at least one slide.");
  if (!Array.isArray(content.learning?.cards)) fail("learning.cards must be a list.");
  // Student workspace (Admin → Student workspace). Optional; the student page
  // ignores anything it does not understand, but the shape must be sane.
  if (content.workspace != null) {
    const ws = content.workspace;
    if (typeof ws !== "object" || Array.isArray(ws)) fail("workspace must be an object.");
    for (const list of ["menu", "tiles", "notices"]) {
      if (ws[list] != null && (!Array.isArray(ws[list]) || ws[list].length > 40)) fail(`workspace.${list} must be a list of at most 40 items.`);
    }
    if (ws.deadlines?.items != null && (!Array.isArray(ws.deadlines.items) || ws.deadlines.items.length > 60)) fail("workspace.deadlines.items must be a list of at most 60 items.");
    if (/javascript:/i.test(JSON.stringify(ws))) fail("A workspace link uses javascript:, which is not allowed.");
  }
  const json = JSON.stringify(content);
  if (Buffer.byteLength(json) > MAX_CONTENT_BYTES) fail("Website content is larger than 512 KB. Upload photos with the photo button instead of pasting them.");
  if (/"data:[^"]{0,40};base64,/i.test(json)) fail("A photo is pasted into the content as text (data:…base64). Re-upload it with the slide photo button so it is stored properly.");
  return content;
}

function failResponse(res, error) {
  if (error instanceof SiteError) return res.status(error.status).json({ error: error.message, code: error.code });
  if (error?.code === "42P01") return res.status(503).json({ error: "The website tables are not in Neon yet. Run the \"Neon database migration\" workflow on GitHub once, then try again.", code: "SITE_SCHEMA_NOT_READY" });
  if (error?.message === "DATABASE_URL is not configured.") return res.status(503).json({ error: "Neon is not configured on this server.", code: "DATABASE_NOT_CONFIGURED" });
  console.error("Website content request failed:", error?.code || error?.message);
  return res.status(500).json({ error: "The website change could not be saved. Try again.", code: "SITE_SAVE_FAILED" });
}

export function createPublicSiteHandlers({ poolProvider = getPool, configured = () => Boolean(process.env.DATABASE_URL), cacheMs = 30_000 } = {}) {
  let cache = null;
  let cacheAt = 0;
  return {
    invalidate() { cache = null; cacheAt = 0; },
    async content(req, res, next) {
      if (!configured()) return next();
      try {
        if (!cache || Date.now() - cacheAt > cacheMs) {
          const { rows } = await poolProvider().query("SELECT content, updated_at FROM site_content WHERE slot = 'published'");
          cache = rows[0] ? { body: JSON.stringify(rows[0].content), updatedAt: rows[0].updated_at } : { body: null };
          cacheAt = Date.now();
        }
        if (!cache.body) return next();
        res.set("Cache-Control", "no-cache");
        res.set("X-Content-Type-Options", "nosniff");
        res.type("application/json").send(cache.body);
      } catch {
        // Missing tables or a sleeping database: serve the bundled file instead.
        return next();
      }
    },
    async media(req, res, next) {
      const match = MEDIA_RE.exec(req.params.file || "");
      if (!match || !configured()) return next();
      try {
        const { rows } = await poolProvider().query("SELECT mime_type, data FROM site_images WHERE id = $1", [match[1]]);
        if (!rows.length) return res.status(404).type("text/plain").send("Not found");
        res.set("Cache-Control", "public, max-age=31536000, immutable");
        res.set("X-Content-Type-Options", "nosniff");
        res.set("Cross-Origin-Resource-Policy", "same-site");
        res.type(rows[0].mime_type);
        return res.send(Buffer.isBuffer(rows[0].data) ? rows[0].data : Buffer.from(rows[0].data));
      } catch {
        return res.status(503).type("text/plain").send("Image temporarily unavailable");
      }
    }
  };
}

export function createAdminSiteRouter({
  poolProvider = getPool,
  verifyToken = verifyFirebaseToken,
  adminGate = requireAdmin,
  configured = () => Boolean(process.env.DATABASE_URL),
  onPublish = () => {},
  firestoreProvider = getFirebaseFirestore,
  firestoreTimestamp = () => FieldValue.serverTimestamp()
} = {}) {
  const router = express.Router();
  router.use(verifyToken, adminGate);

  // Full 12-slide/8-link validation exceeds Firestore's 1000-expression rule
  // budget. Validate the complete shared schema here, behind verified Google
  // tokens and admin claims, and deny ALL browser writes in the deployed rules.
  // This primary publish is deliberately independent of the Neon archive.
  router.post("/firebase", async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).some(key => !["content", "projectId"].includes(key))
      || typeof body.projectId !== "string" || !body.projectId) {
      return res.status(400).json({ error: "Supply content and the matching Firebase projectId only.", code: "VALIDATION_ERROR" });
    }
    const check = validatePublicSiteContent(body.content);
    if (!check.ok) return res.status(400).json({ error: check.errors[0], code: "VALIDATION_ERROR" });
    if (Buffer.byteLength(JSON.stringify(body.content)) > MAX_CONTENT_BYTES) {
      return res.status(413).json({ error: "Website content must stay under 512 KB. Upload photos instead of embedding them.", code: "CONTENT_TOO_LARGE" });
    }
    try {
      const db = firestoreProvider();
      if (db.projectId !== body.projectId) {
        return res.status(409).json({ error: "The API and website use different Firebase projects. Match FIREBASE_PROJECT_ID and the service account to the website's fire-counsel project.", code: "FIREBASE_PROJECT_MISMATCH" });
      }
      await db.doc("siteContent/public").set({
        ...body.content,
        updatedAt: firestoreTimestamp(),
        updatedBy: req.user.uid
      });
      return res.json({ data: { published: true, channel: "firestore" } });
    } catch (error) {
      const code = String(error?.code || "").toLowerCase();
      if (["7", "permission-denied", "5", "not-found"].includes(code)) {
        return res.status(503).json({ error: "The server could not write Firestore. Check service-account IAM access, the Firestore API and the (default) database in the matching Firebase project. Browser rules do not grant the Admin SDK access.", code: "FIRESTORE_ACCESS_DENIED" });
      }
      if (code.startsWith("firebase-admin/") || code.startsWith("app/") || ["16", "unauthenticated"].includes(code)) {
        return res.status(503).json({ error: "The server's Firebase Admin credentials are not usable. Check FIREBASE_SERVICE_ACCOUNT_JSON and FIREBASE_PROJECT_ID privately in Render; /api/health shows local setup diagnostics.", code: "FIREBASE_ADMIN_NOT_READY" });
      }
      // Never reflect SDK messages/details: they can contain private request or
      // credential data. An unavailable/ambiguous response is not a rollback.
      return res.status(503).json({ error: "Firebase publishing was not confirmed. Check Firestore availability and reload the live content before trying again.", code: "FIREBASE_PUBLISH_UNCONFIRMED" });
    }
  });

  router.use((req, res, next) => {
    if (!configured()) return res.status(503).json({ error: "Neon is not configured on this server.", code: "DATABASE_NOT_CONFIGURED" });
    return next();
  });
  const who = (req) => String(req.user?.email || req.user?.uid || "admin").slice(0, 200);

  async function publish(content, note, req) {
    const client = await poolProvider().connect();
    try {
      await client.query("BEGIN");
      const json = JSON.stringify(content);
      for (const slot of ["published", "draft"]) {
        await client.query(
          `INSERT INTO site_content (slot, content, updated_by) VALUES ($1, $2::jsonb, $3)
           ON CONFLICT (slot) DO UPDATE SET content = EXCLUDED.content, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
          [slot, json, who(req)]);
      }
      const version = await client.query(
        "INSERT INTO site_content_versions (content, note, published_by) VALUES ($1::jsonb, $2, $3) RETURNING id, created_at",
        [json, note, who(req)]);
      await client.query(
        `DELETE FROM site_content_versions WHERE id IN (
           SELECT id FROM site_content_versions ORDER BY created_at DESC OFFSET $1)`, [KEEP_VERSIONS]);
      await client.query("COMMIT");
      onPublish();
      return { version_id: version.rows[0].id, published_at: version.rows[0].created_at };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* keep original */ }
      throw error;
    } finally {
      client.release();
    }
  }

  router.get("/", async (_req, res) => {
    try {
      const db = poolProvider();
      const [slots, versions] = await Promise.all([
        db.query("SELECT slot, content, updated_at, updated_by FROM site_content"),
        db.query("SELECT id, note, published_by, created_at FROM site_content_versions ORDER BY created_at DESC LIMIT 20")
      ]);
      const bySlot = Object.fromEntries(slots.rows.map((row) => [row.slot, row]));
      res.json({ data: { draft: bySlot.draft || null, published: bySlot.published || null, versions: versions.rows } });
    } catch (error) { failResponse(res, error); }
  });

  router.put("/draft", async (req, res) => {
    try {
      const content = validateSiteContent(req.body?.content);
      const { rows } = await poolProvider().query(
        `INSERT INTO site_content (slot, content, updated_by) VALUES ('draft', $1::jsonb, $2)
         ON CONFLICT (slot) DO UPDATE SET content = EXCLUDED.content, updated_by = EXCLUDED.updated_by, updated_at = NOW()
         RETURNING updated_at`, [JSON.stringify(content), who(req)]);
      res.json({ data: { saved: true, updated_at: rows[0].updated_at } });
    } catch (error) { failResponse(res, error); }
  });

  router.post("/publish", async (req, res) => {
    try {
      let content = req.body?.content;
      if (content == null) {
        const { rows } = await poolProvider().query("SELECT content FROM site_content WHERE slot = 'draft'");
        if (!rows.length) throw new SiteError(400, "There is no saved draft to publish yet.", "VALIDATION_ERROR");
        content = rows[0].content;
      }
      validateSiteContent(content);
      const note = typeof req.body?.note === "string" && req.body.note.trim() ? req.body.note.trim().slice(0, 200) : null;
      res.json({ data: await publish(content, note, req) });
    } catch (error) { failResponse(res, error); }
  });

  // Read an archive before the browser restores it to the primary Firestore
  // channel. A Neon-only restore would be hidden by an existing live document.
  router.get("/versions/:id", async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "Version not found.", code: "NOT_FOUND" });
    try {
      const { rows } = await poolProvider().query("SELECT content, created_at FROM site_content_versions WHERE id = $1", [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: "Version not found.", code: "NOT_FOUND" });
      return res.json({ data: rows[0] });
    } catch (error) { return failResponse(res, error); }
  });

  router.post("/versions/:id/restore", async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "Version not found.", code: "NOT_FOUND" });
    try {
      const { rows } = await poolProvider().query("SELECT content, created_at FROM site_content_versions WHERE id = $1", [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: "Version not found.", code: "NOT_FOUND" });
      const when = new Date(rows[0].created_at).toISOString().slice(0, 16).replace("T", " ");
      res.json({ data: await publish(rows[0].content, `Restored the version from ${when} UTC`, req) });
    } catch (error) { failResponse(res, error); }
  });

  router.post("/images", express.raw({ type: () => true, limit: MAX_IMAGE_BYTES }), async (req, res) => {
    try {
      const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const type = imageType(buffer);
      if (!type) return res.status(415).json({ error: "Upload a JPG, PNG or WEBP photo.", code: "UNSUPPORTED_FILE" });
      const name = String(req.query.name || "").replace(/[^\w .-]/g, "_").slice(0, 120) || null;
      const { rows } = await poolProvider().query(
        "INSERT INTO site_images (file_name, mime_type, size_bytes, data, uploaded_by) VALUES ($1, $2, $3, $4, $5) RETURNING id",
        [name, type, buffer.length, buffer, who(req)]);
      res.status(201).json({ data: { id: rows[0].id, url: `/media/${rows[0].id}.${EXT[type]}`, size: buffer.length } });
    } catch (error) { failResponse(res, error); }
  });

  router.use((error, _req, res, next) => {
    if (error?.type === "entity.too.large") return res.status(413).json({ error: "This photo is larger than 8 MB.", code: "FILE_TOO_LARGE" });
    return next(error);
  });

  return router;
}
