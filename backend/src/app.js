import express from "express";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { checkDatabase, databaseErrorCode } from "./config/database.js";
import { verifyFirebaseToken } from "./middleware/verifyFirebaseToken.js";
import { requireAdmin } from "./middleware/requireAdmin.js";
import { createAdminDatabaseRouter } from "./routes/adminDatabase.js";
import { createStudentMaterialsRouter } from "./routes/studentMaterials.js";
import { createResearchSearchRouter } from "./routes/researchSearch.js";
import { createStudentProfileRouter } from "./routes/studentProfile.js";
import { trustedProxyNetworks } from "./config/trustedProxy.js";
import { createWebsiteHandler } from "./website.js";
import { createAiRouter } from "./routes/ai.js";
import { createAdminAiRouter } from "./routes/adminAi.js";
import { createPresenceRouter } from "./routes/presence.js";
import { describePastedKey, firebaseAdminStatus, getFirebaseAuth } from "./config/firebaseAdmin.js";

// Emails allowed to give themselves the admin claim once (set ADMIN_EMAILS in
// Render). The account must have a verified email. Nobody else can.
export function adminBootstrapEmails(env) {
  return new Set(String(env.ADMIN_EMAILS || "").split(",").map((email) => email.trim().toLowerCase()).filter((email) => /^[^\s@]+@[^\s@]+$/.test(email)));
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
  app.set("trust proxy", trustedProxyNetworks(env.TRUSTED_PROXY_CIDRS || ""));
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
  // AI uploads (photos/PDFs as base64) need a larger body than other routes.
  app.use(["/api/v1/ai/messages", "/api/v1/admin/ai/extract"], express.json({ limit: "26mb" }));
  app.use(["/api/v1/admin/ai/prompts"], express.json({ limit: "1mb" }));
  app.use(express.json({ limit: "2mb" }));
  // AI, presence and admin-AI routes poll often (job status, heartbeats), so
  // they get a looser per-connection limit plus per-account limits after sign-in.
  const pollingPaths = (req) => /^\/api\/v1\/(ai|presence|admin\/ai)(\/|$)/.test(req.path);
  app.use(rateLimit({
    skip: (req) => !pollingPaths(req),
    windowMs: 15 * 60 * 1000,
    limit: 1500,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    validate: { xForwardedForHeader: false }
  }));
  app.use(rateLimit({
    skip: pollingPaths,
    windowMs: 15 * 60 * 1000,
    limit: 100,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    // Empty proxy trust deliberately ignores forwarded IPs even when an ingress
    // sends them. Only the explicit IP/CIDR list above can affect req.ip.
    validate: { xForwardedForHeader: false }
  }));

  // Render's liveness probe must not require a live database or Firebase project.
  // This makes a staging deployment bootable without enabling external writes.
  app.get("/healthz", (_req, res) => {
    res.status(200).json({ service: "FIRE COUNSEL API", status: "ok" });
  });

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
        admin_emails: Boolean(String(env.ADMIN_EMAILS || "").trim())
      },
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
  }, requireAdmin, (req, res) => {
    res.json({ user: { uid: req.user.uid, email: req.user.email, role: "admin" } });
  });

  app.post("/api/v1/admin/claim", verifyFirebaseToken, async (req, res) => {
    if (req.user.admin) return res.json({ data: { admin: true } });
    if (!claimable(req.user)) return res.status(403).json({ error: "This account is not on the server's ADMIN_EMAILS list, or its email is not verified.", code: "ADMIN_CLAIM_DENIED" });
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

  app.use("/api/v1/presence", createPresenceRouter({ configured: () => Boolean(env.DATABASE_URL) }));
  app.use("/api/v1/ai", createAiRouter({ env, configured: () => Boolean(env.DATABASE_URL) }));
  app.use("/api/v1/admin/ai", createAdminAiRouter({ env, configured: () => Boolean(env.DATABASE_URL) }));

  const studentSetup = {
    configured: () => Boolean(env.DATABASE_URL),
    enabled: () => env.STUDENT_PROFILES_ENABLED === "true"
  };
  // Strictly allowlisted CRUD for administrator-managed Neon content.
  app.use("/api/v1/admin/database", createAdminDatabaseRouter({ configured: studentSetup.configured }));
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
      return res.status(413).json({ error: "Request body is too large (2 MiB for data, about 18 MB of files for AI uploads).", code: "BODY_TOO_LARGE" });
    }
    console.error("Unhandled API error:", error);
    return res.status(500).json({ error: "An unexpected server error occurred." });
  });

  return app;
}
