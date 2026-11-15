import pg from "pg";

const { Pool } = pg;
let pool;

function secureConnectionString(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL.");
  }

  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("DATABASE_URL must use the PostgreSQL protocol.");
  }
  if (!url.hostname) throw new Error("DATABASE_URL must include a database host.");

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
