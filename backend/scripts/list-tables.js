// Read-only Neon connection check: lists public tables, column counts and
// estimated row counts, and compares them to the 27-table schema documented in
// DATABASE_SCHEMA.md. Reads DATABASE_URL from backend/.env (never commit it).
//
//   cd backend && npm run db:tables
import "dotenv/config";
import { getPool } from "../src/config/database.js";

const EXPECTED_TABLES = [
  "app_users", "case_memory_summaries", "case_mnemonics", "course_enrollments",
  "course_topics", "courses", "departments", "faculties", "institution_memberships",
  "legal_cases", "marking_criteria", "marking_rubrics", "material_authorities",
  "material_chunks", "material_versions", "materials", "past_questions", "permissions",
  "question_topic_links", "role_permissions", "roles", "statute_sections", "statutes",
  "student_flash_cases", "topic_learning_objectives", "universities", "user_roles"
];

function describeTarget(raw) {
  try {
    const url = new URL(raw);
    return `${url.username || "?"}@${url.hostname}${url.pathname}`;
  } catch {
    return "(invalid DATABASE_URL)";
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set. Create backend/.env with:\nDATABASE_URL=postgresql://neondb_owner:<password>@<host>/neondb?sslmode=require");
    process.exit(1);
  }
  if (process.env.DATABASE_URL.includes("****")) {
    console.error("DATABASE_URL still contains the masked password (****). Copy the real password from Neon (\"Show password\").");
    process.exit(1);
  }

  console.log(`Connecting to ${describeTarget(process.env.DATABASE_URL)} ...`);
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("SET default_transaction_read_only = on");
    const { rows: [info] } = await client.query(
      "SELECT current_database() AS db, current_user AS usr, split_part(version(), ' on ', 1) AS version"
    );
    console.log(`Connected: database=${info.db} user=${info.usr} (${info.version})\n`);

    const { rows } = await client.query(`
      SELECT t.table_name,
             (SELECT count(*) FROM information_schema.columns c
               WHERE c.table_schema = t.table_schema AND c.table_name = t.table_name)::int AS columns,
             GREATEST(COALESCE(s.n_live_tup, 0), 0)::bigint AS est_rows
        FROM information_schema.tables t
        LEFT JOIN pg_stat_user_tables s
          ON s.schemaname = t.table_schema AND s.relname = t.table_name
       WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
       ORDER BY t.table_name`);

    console.table(rows.map((r, i) => ({ "#": i + 1, table: r.table_name, columns: r.columns, est_rows: Number(r.est_rows) })));

    const live = new Set(rows.map((r) => r.table_name));
    const missing = EXPECTED_TABLES.filter((t) => !live.has(t));
    const extra = [...live].filter((t) => !EXPECTED_TABLES.includes(t));
    const totalColumns = rows.reduce((sum, r) => sum + r.columns, 0);
    console.log(`\n${rows.length} public tables, ${totalColumns} columns (documented: 27 tables, 232 columns).`);
    console.log(missing.length ? `Missing vs documented schema: ${missing.join(", ")}` : "All 27 documented tables are present.");
    if (extra.length) console.log(`Extra tables not in documented schema: ${extra.join(", ")}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`Connection failed: ${error.message}`);
  process.exit(1);
});
