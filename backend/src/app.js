import express from "express";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { checkDatabase } from "./config/database.js";
import { verifyFirebaseToken } from "./middleware/verifyFirebaseToken.js";
import { requireAdmin } from "./middleware/requireAdmin.js";
import { createAdminDatabaseRouter } from "./routes/adminDatabase.js";
import { createStudentMaterialsRouter } from "./routes/studentMaterials.js";
import { createResearchSearchRouter } from "./routes/researchSearch.js";
import { createStudentProfileRouter } from "./routes/studentProfile.js";
import { trustedProxyNetworks } from "./config/trustedProxy.js";

export function createApp({ env = process.env, databaseCheck = checkDatabase } = {}) {
  const app = express();
  const allowedOrigins = (env.CORS_ORIGINS || "http://localhost:8080")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.disable("x-powered-by");
  app.set("trust proxy", trustedProxyNetworks(env.TRUSTED_PROXY_CIDRS || ""));
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
  app.use(express.json({ limit: "2mb" }));
  app.use(rateLimit({
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

    if (env.DATABASE_URL) {
      try {
        database = await databaseCheck() ? "connected" : "unavailable";
      } catch (error) {
        database = "unavailable";
        console.error("Database health check failed:", error.message);
      }
    }

    const healthy = database === "connected";
    return res.status(healthy ? 200 : 503).json({
      service: "FIRE COUNSEL API",
      status: healthy ? "ok" : "degraded",
      database,
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
  app.get("/api/v1/admin/me", verifyFirebaseToken, requireAdmin, (req, res) => {
    res.json({ user: { uid: req.user.uid, email: req.user.email, role: "admin" } });
  });

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
      return res.status(413).json({ error: "Request body exceeds the 2 MiB limit.", code: "BODY_TOO_LARGE" });
    }
    console.error("Unhandled API error:", error);
    return res.status(500).json({ error: "An unexpected server error occurred." });
  });

  return app;
}
