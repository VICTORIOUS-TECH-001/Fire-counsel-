import pg from "pg";

const { Pool } = pg;
let pool;

// Forgive the usual copy-paste mistakes in the Render/Neon dashboards:
// surrounding quotes or spaces, a leading "psql", or a "DATABASE_URL=" prefix.
export function normalizeDatabaseUrl(raw) {
  let value = String(raw ?? "").trim();
  value = value.replace(/^(?:export\s+)?DATABASE_URL\s*=\s*/i, "").trim();
  value = value.replace(/^psql\s+/i, "").trim();
  while (/^(['"`]).*\1$/s.test(value)) value = value.slice(1, -1).trim();
  return value;
}

// A short, secret-free reason for /api/health and the logs.
export function databaseErrorCode(error) {
  const code = error?.code;
  const message = String(error?.message || "");
  if (/hidden password/.test(message)) return "password_hidden_copy_again";
  if (/valid PostgreSQL URL|PostgreSQL protocol|database host/.test(message)) return "invalid_url";
  if (code === "28P01" || code === "28000" || /password authentication failed/i.test(message)) return "wrong_password_or_user";
  if (code === "3D000") return "database_not_found";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "host_not_found";
  if (code === "ECONNREFUSED") return "connection_refused";
  if (code === "ETIMEDOUT" || /timeout/i.test(message)) return "timeout";
  if (/certificate|self[- ]signed|SSL|TLS/i.test(message)) return "tls_error";
  if (/endpoint.*(disabled|suspended)|compute.*(quota|limit)/i.test(message)) return "neon_endpoint_disabled";
  return "connection_failed";
}

function secureConnectionString(raw) {
  let url;
  try {
    url = new URL(normalizeDatabaseUrl(raw));
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL.");
  }

  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("DATABASE_URL must use the PostgreSQL protocol.");
  }
  if (!url.hostname) throw new Error("DATABASE_URL must include a database host.");
  if (/^\*+$/.test(decodeURIComponent(url.password || ""))) {
    throw new Error("DATABASE_URL contains the hidden password (****). In Neon tap \"Show password\" before copying.");
  }

  // Require TLS certificate and hostname validation even if a copied Neon URL
  // was generated with the weaker `sslmode=require` setting.
  url.searchParams.set("sslmode", "verify-full");
  return url.toString();
}

export function getPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not configured.");
  }

  if (!pool) {
    pool = new Pool({
      connectionString: secureConnectionString(process.env.DATABASE_URL),
      ssl: { rejectUnauthorized: true },
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: "fire-counsel-api"
    });

    pool.on("error", (error) => {
      console.error("Unexpected PostgreSQL pool error:", error.message);
    });
  }

  return pool;
}

export async function checkDatabase() {
  const client = await getPool().connect();
  try {
    const result = await client.query("SELECT 1 AS connected");
    return result.rows[0]?.connected === 1;
  } finally {
    client.release();
  }
}
