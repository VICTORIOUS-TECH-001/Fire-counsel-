import "dotenv/config";
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

const app = express();
const port = Number(process.env.PORT || 4000);
const allowedOrigins = (process.env.CORS_ORIGINS || "http://localhost:8080")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.disable("x-powered-by");
app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    // Requests without an Origin header include health checks and server-to-server calls.
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Origin is not allowed by CORS."));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json({ limit: "2mb" }));
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-8",
  legacyHeaders: false
}));

// Render's liveness probe must not require a live database or Firebase project.
// This makes a staging deployment bootable without enabling external writes.
app.get("/healthz", (_req, res) => {
  res.status(200).json({ service: "FIRE COUNSEL API", status: "ok" });
});

app.get("/api/health", async (_req, res) => {
  let database = "not_configured";

  if (process.env.DATABASE_URL) {
    try {
      await checkDatabase();
      database = "connected";
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

// Strictly allowlisted CRUD for administrator-managed Neon content.
app.use("/api/v1/admin/database", createAdminDatabaseRouter());
app.use("/api/v1/materials", createStudentMaterialsRouter());
app.use("/api/v1/research", createResearchSearchRouter());

app.use((req, res) => {
  res.status(404).json({ error: "Route not found." });
});

app.use((error, _req, res, _next) => {
  if (error.message === "Origin is not allowed by CORS.") {
    return res.status(403).json({ error: "This origin is not allowed." });
  }
  console.error("Unhandled API error:", error);
  return res.status(500).json({ error: "An unexpected server error occurred." });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`FIRE COUNSEL API listening on port ${port}`);
});
