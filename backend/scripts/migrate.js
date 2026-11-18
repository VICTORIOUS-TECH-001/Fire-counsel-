// Applies the reviewed, additive migrations listed below to DATABASE_URL.
// Only files in APPLY are run (001_student_profiles.sql still needs separate
// review). 003 adds website publishing and document upload tables. Each migration is idempotent, so re-running is safe.
//
//   cd backend && npm run db:migrate
import "dotenv/config";
import { readFileSync } from "node:fs";
import { getPool } from "../src/config/database.js";

export const APPLY = ["002_ai_studio.sql", "003_site_and_documents.sql"];
export const EXPECTED_TABLES = [
  "ai_settings", "ai_prompts", "ai_user_limits", "ai_usage", "user_presence", "ai_conversations", "ai_messages", "schema_migrations",
  "site_content", "site_content_versions", "site_images", "uploaded_files"
];

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  const pool = getPool();
  const client = await pool.connect();
  const applied = [];
  try {
    for (const file of APPLY) {
      const sql = readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8");
      await client.query(sql);
      applied.push(file);
      console.log(`Applied ${file}`);
    }
    const { rows } = await client.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])
        ORDER BY table_name`, [EXPECTED_TABLES]);
    const tables = rows.map((r) => r.table_name);
    const missing = EXPECTED_TABLES.filter((name) => !tables.includes(name));
    console.log(`Tables present (${tables.length}/${EXPECTED_TABLES.length}): ${tables.join(", ")}`);
    if (process.env.GITHUB_ACTIONS === "true") {
      console.log(`::notice title=Database migration::Applied ${applied.join(", ")}. Tables present (${tables.length}/${EXPECTED_TABLES.length})${missing.length ? `; missing: ${missing.join(", ")}` : " — all ready"}.`);
    }
    if (missing.length) process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`Migration failed: ${error.message}`);
  if (process.env.GITHUB_ACTIONS === "true") console.log(`::error title=Database migration failed::${error.message}`);
  process.exit(1);
});
