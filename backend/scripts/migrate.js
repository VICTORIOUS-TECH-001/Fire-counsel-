// Applies the reviewed, additive migrations listed below to DATABASE_URL.
// Only files in APPLY are run (001_student_profiles.sql still needs separate
// review). Each migration is idempotent, so re-running is safe.
//
//   cd backend && npm run db:migrate
import "dotenv/config";
import { readFileSync } from "node:fs";
import { getPool } from "../src/config/database.js";

export const APPLY = ["002_ai_studio.sql"];

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
        WHERE table_schema = 'public' AND table_name IN
          ('ai_settings','ai_prompts','ai_user_limits','ai_usage','user_presence','ai_conversations','ai_messages','schema_migrations')
        ORDER BY table_name`);
    const tables = rows.map((r) => r.table_name);
    console.log(`AI tables present: ${tables.join(", ")}`);
    if (process.env.GITHUB_ACTIONS === "true") {
      console.log(`::notice title=Database migration::Applied ${applied.join(", ")}. AI tables present (${tables.length}/8): ${tables.join(", ")}`);
    }
    if (tables.length !== 8) process.exitCode = 1;
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
