import express from "express";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { checkDatabase, databaseErrorCode } from "./config/database.js";
import { verifyFirebaseToken } from "./middleware/verifyFirebaseToken.js";
import { requireAdmin } from "./middleware/requireAdmin.js";
import { createAdminAbuseGate, createAdminRequestGate, isAdminApi, rateLimitReply } from "./middleware/adminRateLimit.js";
import { createAdminDatabaseRouter } from "./routes/adminDatabase.js";
import { createCoursesRouter } from "./routes/courses.js";
import { createStudentMaterialsRouter } from "./routes/studentMaterials.js";
import { createResearchSearchRouter } from "./routes/researchSearch.js";
import { createStudentProfileRouter } from "./routes/studentProfile.js";
import { trustedProxyNetworks } from "./config/trustedProxy.js";
import { createWebsiteHandler } from "./website.js";
import { createAiRouter } from "./routes/ai.js";
import { createAdminAiRouter } from "./routes/adminAi.js";
import { describeProviders } from "./services/ai/providers.js";
import { createPresenceRouter } from "./routes/presence.js";
import { describePastedKey, firebaseAdminStatus, getFirebaseAuth } from "./config/firebaseAdmin.js";
import { createAdminDocumentsRouter } from "./routes/adminDocuments.js";
import { createAdminWorkstationRouter } from "./routes/adminWorkstation.js";
import { createAdminSiteRouter, createPublicSiteHandlers } from "./routes/siteContent.js";

// Emails allowed to give themselves the admin claim once (set ADMIN_EMAILS in
// Render). The account must have a verified email. Nobody else can.
export function adminBootstrapEmails(env) {
  return new Set(String(env.ADMIN_EMAILS || "").split(",").map((email) => email.trim().toLowerCase()).filter((email) => /^[^\s@]+@[^\s@]+$/.test(email)));
}

// Which proxies may set the visitor address (X-Forwarded-For). An explicit
// TRUSTED_PROXY_CIDRS list always wins. On Render (RENDER=true is set
// automatically) the platform proxy connects from a private address, so trust
// private/loopback hops only: Express then uses the first public address that
// Render's proxy appended, which visitors cannot forge. Without this, every
// visitor shared one rate-limit bucket and admins were throttled.
export function proxyTrust(env = process.env) {
  if (String(env.TRUSTED_PROXY_CIDRS || "").trim()) return trustedProxyNetworks(env.TRUSTED_PROXY_CIDRS);
  if (String(env.RENDER || "").trim().toLowerCase() === "true") return ["loopback", "linklocal", "uniquelocal"];
  return false;
}

export function createApp({ env = process.env, databaseCheck = checkDatabase } = {}) {
  const app = express();
  const allowedOrigins = (env.CORS_ORIGINS || "http://localhost:8080")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  // Render sets RENDER_EXTERNAL_URL to the service's public https URL. When the
  // same service also hosts the website, its own pages must be allowed to call it.
  if (env.RENDER_EXTERNAL_URL) {
    try {
      const ownOrigin = new URL(env.RENDER_EXTERNAL_URL).origin;
      if (!allowedOrigins.includes(ownOrigin)) allowedOrigins.push(ownOrigin);
    } catch {
      // Ignore a malformed value; explicit CORS_ORIGINS still applies.
    }
  }
  // Accept "true" however it was typed into a dashboard (quotes, spaces, TRUE).
  const serveWebsite = /^\s*["']?\s*(true|1|yes)\s*["']?\s*$/i.test(String(env.SERVE_WEBSITE ?? ""));

  app.disable("x-powered-by");
  app.set("trust proxy", proxyTrust(env));
  const databaseConfigured = () => Boolean(env.DATABASE_URL);
  // Published homepage content and slideshow photos live in Neon. When nothing
  // is published (or Neon is asleep/unset) the bundled data file is served.
  const site = createPublicSiteHandlers({ configured: databaseConfigured });
  app.get("/media/:file", site.media);
  if (serveWebsite) app.get("/data/site-content.json", site.content);
  // Optional: serve the allowlisted public website from the same origin so its
  // same-origin /api/ calls reach this server (e.g. one Render web service).
  if (serveWebsite) app.use(createWebsiteHandler({ root: env.WEBSITE_ROOT || undefined }));
  app.use(helmet());
  // Authenticated responses and readiness must never enter shared/browser caches.
  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.use(cors({
    origin(origin, callback) {
      // Requests without an Origin header include health checks and server-to-server calls.
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("Origin is not allowed by CORS."));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Fire-Counsel-Installation"]
  }));
  // Render's process-liveness probe must run BEFORE body parsing and all
  // traffic limiters. Otherwise repeated probes consume the 100/15-minute API
  // allowance, return 429, and cause a healthy instance to be restarted. Keep
  // this cheap GET/HEAD route independent of Firebase, Neon and AI providers.
  app.get("/healthz", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.status(200).json({ service: "FIRE COUNSEL API", status: "ok" });
  });

  // AI uploads (photos/PDFs as base64) need a larger body than other routes.
  app.use(["/api/v1/ai/messages", "/api/v1/admin/ai/extract", "/api/v1/admin/workstation/jobs"], express.json({ limit: "26mb" }));
  app.use(["/api/v1/admin/ai/prompts", "/api/v1/admin/ai/instructions"], express.json({ limit: "1mb" }));
  app.use(express.json({ limit: "2mb" }));
  // Admin polling has a shared verified-UID allowance across routers, separate
  // from admin writes and the existing student AI/presence IP allowance. Keep a
  // pre-auth IP guard for denied/unknown requests; no caller-supplied UID counts.
  app.use(createAdminAbuseGate());
  const adminRequestGate = createAdminRequestGate();
  const pollingPaths = (req) => /^\/api\/v1\/(ai|presence)(\/|$)/.test(req.path);
  app.use(rateLimit({
    skip: (req) => isAdminApi(req) || !pollingPaths(req),
    windowMs: 15 * 60 * 1000,
    limit: 1500,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    validate: { xForwardedForHeader: false },
    handler: rateLimitReply("API_RATE_LIMIT", "API requests are temporarily limited. Wait for Retry-After; this is not a provider quota test.")
  }));
  app.use(rateLimit({
    skip: (req) => isAdminApi(req) || pollingPaths(req),
    windowMs: 15 * 60 * 1000,
    limit: 100,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    // Empty proxy trust deliberately ignores forwarded IPs even when an ingress
    // sends them. Only the explicit IP/CIDR list above can affect req.ip.
    validate: { xForwardedForHeader: false },
    handler: rateLimitReply("API_RATE_LIMIT", "API requests are temporarily limited. Wait for Retry-After; this is not a provider quota test.")
  }));

  // Human-facing database readiness/setup diagnostics, NOT the Render restart
  // probe. This performs a Neon query and retains the normal API protections.
  app.get("/api/health", async (_req, res) => {
    let database = "not_configured";
    let databaseError;

    if (env.DATABASE_URL) {
      try {
        database = await databaseCheck() ? "connected" : "unavailable";
      } catch (error) {
        database = "unavailable";
        databaseError = databaseErrorCode(error);
        console.error(`Database health check failed (${databaseError}):`, error.message);
      }
    }

    const healthy = database === "connected";
    const firebaseAdmin = firebaseAdminStatus(env);
    const firebaseKeyPasted = Boolean(String(env.FIREBASE_SERVICE_ACCOUNT_JSON || "").trim());
    const aiKeys = describeProviders(env);
    const aiKeyNotes = [["groq", aiKeys.groq], ["deepseek", aiKeys.deepseek], ["tavily", aiKeys.tavily], ["brave", aiKeys.brave], ["serpapi", aiKeys.serpapi]]
      .filter(([, info]) => info.key_name && (info.warning || !/^(GROQ_API_KEY|DEEPSEEK_API_KEY|TAVILY_API_KEY|BRAVE_SEARCH_API_KEY|SERPAPI_API_KEY)$/.test(info.key_name)))
      .map(([provider, info]) => ({ provider, setting_name: info.key_name, ...(info.warning ? { problem: info.warning } : {}) }));
    return res.status(healthy ? 200 : 503).json({
      service: "FIRE COUNSEL API",
      status: healthy ? "ok" : "degraded",
      database,
      ...(databaseError ? { database_error: databaseError } : {}),
      // Secret-free reason the Firebase Admin key cannot be used (sign-in checks fail).
      ...(firebaseKeyPasted && !firebaseAdmin.ok ? {
        firebase_admin_error: firebaseAdmin.code,
        // Counts and yes/no only: shows whether the paste is cut off or the wrong file.
        firebase_admin_check: describePastedKey(env.FIREBASE_SERVICE_ACCOUNT_JSON)
      } : {}),
      // Setup checklist (yes/no only, never values) so the dashboard
      // settings can be checked from a phone browser.
      setup: {
        website: serveWebsite,
        firebase_admin_key: firebaseAdmin.ok,
        gemini_key: Boolean(String(env.GEMINI_API_KEY || "").trim()),
        openrouter_key: Boolean(String(env.OPENROUTER_API_KEY || "").trim()),
        groq_key: aiKeys.groq.configured,
        deepseek_key: aiKeys.deepseek.configured,
        serpapi_key: aiKeys.serpapi.configured,
        tavily_key: aiKeys.tavily.configured,
        brave_search_key: aiKeys.brave.configured,
        ai_writer_key: aiKeys.configured,
        web_search_key: aiKeys.search.configured,
        admin_emails: Boolean(String(env.ADMIN_EMAILS || "").trim())
      },
      // This is a runtime-presence check, NOT a call to any AI/search provider. missing =
      // no such variable in this process; empty = saved but blank after cleanup.
      // Aliases may still configure a provider; setup above reflects that.
      config_diagnostics_version: 2,
      web_search: { check: "presence_only", configured: aiKeys.search.configured, provider_order: aiKeys.search.order },
      ai_key_check: {
        kind: "presence_only",
        groq: aiKeys.groq.runtime_setting,
        tavily: aiKeys.tavily.runtime_setting,
        brave: aiKeys.brave.runtime_setting,
        deepseek: aiKeys.deepseek.runtime_setting,
        serpapi: aiKeys.serpapi.runtime_setting
      },
      // Which Render setting name was found and, if the key looks wrong, why
      // (names and hints only — never the key itself).
      ...(aiKeyNotes.length ? { ai_key_notes: aiKeyNotes } : {}),
      // Compare with Render's latest successful LIVE deploy, not just a build.
      ...(/^[a-f0-9]{40}$/i.test(String(env.RENDER_GIT_COMMIT || "")) ? { render_commit: env.RENDER_GIT_COMMIT } : {}),
      // Render sets this automatically: shows WHICH service's Environment
      // page the keys must be added to.
      ...(env.RENDER_SERVICE_NAME ? { render_service: String(env.RENDER_SERVICE_NAME).slice(0, 100) } : {}),
      timestamp: new Date().toISOString()
    });
  });

  // Student and administrator sign-in use Firebase Auth on the client. Every API
  // request must present its Firebase ID token; role data is derived server-side.
  app.get("/api/v1/me", verifyFirebaseToken, (req, res) => {
    res.json({
      user: {
        uid: req.user.uid,
        email: req.user.email,
        emailVerified: req.user.emailVerified,
        role: req.user.admin ? "admin" : "student"
      }
    });
  });

  // This route intentionally has no client-controlled role parameter. Only a
  // Firebase Admin-verified custom claim can pass requireAdmin.
  const bootstrap = adminBootstrapEmails(env);
  const claimable = (user) => Boolean(user && !user.admin && user.emailVerified && user.email && bootstrap.has(user.email.toLowerCase()));
  app.get("/api/v1/admin/me", verifyFirebaseToken, (req, res, next) => {
    if (claimable(req.user)) return res.status(403).json({ error: "Administrator permission required.", code: "ADMIN_CLAIM_AVAILABLE" });
    return next();
  }, requireAdmin, adminRequestGate, (req, res) => {
    res.json({ user: { uid: req.user.uid, email: req.user.email, role: "admin" } });
  });

  // Bootstrap is the deliberate exception to requireAdmin: eligibility is
  // derived from the verified Google email plus this service's allowlist, before
  // granting this UID any request allowance. No role/email in the body is used.
  app.post("/api/v1/admin/claim", verifyFirebaseToken, (req, res, next) => {
    if (req.user.admin || claimable(req.user)) return next();
    return res.status(403).json({ error: "This account is not on the server's ADMIN_EMAILS list, or its email is not verified.", code: "ADMIN_CLAIM_DENIED" });
  }, adminRequestGate, async (req, res) => {
    if (req.user.admin) return res.json({ data: { admin: true } });
    try {
      const auth = getFirebaseAuth();
      const record = await auth.getUser(req.user.uid);
      await auth.setCustomUserClaims(req.user.uid, { ...(record.customClaims || {}), admin: true });
      console.log(`Admin claim granted to ${req.user.email} via ADMIN_EMAILS.`);
      return res.json({ data: { admin: true, refresh_token: true } });
    } catch (error) {
      console.error("Admin claim failed:", error?.code || error?.message);
      return res.status(503).json({ error: "Could not update the Firebase account. Check the Firebase Admin key in Render.", code: "ADMIN_CLAIM_FAILED" });
    }
  });

  app.use("/api/v1/courses", createCoursesRouter({ configured: databaseConfigured }));
  app.use("/api/v1/presence", createPresenceRouter({ configured: () => Boolean(env.DATABASE_URL) }));
  app.use("/api/v1/ai", createAiRouter({ env, configured: () => Boolean(env.DATABASE_URL) }));
  app.use("/api/v1/admin/ai", createAdminAiRouter({ env, requestGate: adminRequestGate, configured: () => Boolean(env.DATABASE_URL) }));
  app.use("/api/v1/admin/workstation", createAdminWorkstationRouter({ env, requestGate: adminRequestGate, configured: databaseConfigured }));
  app.use("/api/v1/admin/documents", createAdminDocumentsRouter({ env, requestGate: adminRequestGate, configured: databaseConfigured }));
  app.use("/api/v1/admin/site", createAdminSiteRouter({ requestGate: adminRequestGate, configured: databaseConfigured, onPublish: site.invalidate }));

  const studentSetup = {
    configured: () => Boolean(env.DATABASE_URL),
    enabled: () => env.STUDENT_PROFILES_ENABLED === "true"
  };
  // Strictly allowlisted CRUD for administrator-managed Neon content.
  app.use("/api/v1/admin/database", createAdminDatabaseRouter({ requestGate: adminRequestGate, configured: studentSetup.configured }));
  app.use("/api/v1/profile", createStudentProfileRouter(studentSetup));
  app.use("/api/v1/materials", createStudentMaterialsRouter(studentSetup));
  app.use("/api/v1/research", createResearchSearchRouter(studentSetup));

  app.use((req, res) => {
    res.status(404).json({ error: "Route not found." });
  });

  app.use((error, _req, res, _next) => {
    if (error.message === "Origin is not allowed by CORS.") {
      return res.status(403).json({ error: "This origin is not allowed." });
    }
    if (error.type === "entity.parse.failed") {
      return res.status(400).json({ error: "Request body must be valid JSON.", code: "INVALID_JSON" });
    }
    if (error.type === "entity.too.large") {
      return res.status(413).json({ error: "Request body is too large (2 MiB for ordinary data, about 18 MB of files for AI chat, 8 MB for Working Station, 25 MB per Classic document upload).", code: "BODY_TOO_LARGE" });
    }
    console.error("Unhandled API error:", error);
    return res.status(500).json({ error: "An unexpected server error occurred." });
  });

  return app;
}
