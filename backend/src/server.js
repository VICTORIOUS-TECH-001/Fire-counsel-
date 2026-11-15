import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { checkDatabase } from "./config/database.js";
import { verifyFirebaseToken } from "./middleware/verifyFirebaseToken.js";

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
app.use(express.json({ limit: "1mb" }));
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-8",
  legacyHeaders: false
}));

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

app.get("/api/v1/me", verifyFirebaseToken, (req, res) => {
  res.json({ user: req.user });
});

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

app.listen(port, () => {
  console.log(`FIRE COUNSEL API listening on port ${port}`);
});
