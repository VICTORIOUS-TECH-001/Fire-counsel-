// Read-only check that the admin "Database data" panel matches the live Neon
// schema. For every allowlisted content table it compares the catalog fields
// with the real columns and runs the panel's own list query inside a read-only
// transaction. Prints only table/column names and Postgres error codes.
//
//   cd backend && node scripts/check-admin-schema.js
import "dotenv/config";
import { getPool } from "../src/config/database.js";
import { ADMIN_DATABASE_CATALOG } from "../src/config/databaseCatalog.js";

const annotate = (title, lines) => {
  if (process.env.GITHUB_ACTIONS !== "true") return;
  const escaped = lines.join("\n").replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  console.log(`::notice title=${title}::${escaped}`);
};

async function main() {
  const pool = getPool();
  const client = await pool.connect();
  const report = [];
  const detail = [];
  try {
    await client.query("BEGIN READ ONLY");
    const { rows: cols } = await client.query(`
      SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default
        FROM information_schema.columns WHERE table_schema = 'public'
       ORDER BY table_name, ordinal_position`);
    const { rows: checks } = await client.query(`
      SELECT rel.relname AS table_name, con.conname, pg_get_constraintdef(con.oid) AS def
        FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace ns ON ns.oid = rel.relnamespace
       WHERE ns.nspname = 'public' AND con.contype = 'c'`);
    const byTable = new Map();
    for (const c of cols) {
      if (!byTable.has(c.table_name)) byTable.set(c.table_name, new Map());
      byTable.get(c.table_name).set(c.column_name, c);
    }

    for (const [key, dataset] of Object.entries(ADMIN_DATABASE_CATALOG)) {
      const live = byTable.get(dataset.table);
      if (!live) { report.push(`${key}: TABLE MISSING (${dataset.table})`); continue; }
      const fields = dataset.fields.filter((f) => !f.virtual).map((f) => f.name);
      const missing = fields.filter((name) => !live.has(name));
      const required = [...live.values()]
        .filter((c) => c.is_nullable === "NO" && c.column_default == null && c.column_name !== "id" && !fields.includes(c.column_name))
        .map((c) => c.column_name);
      let list = "ok";
      try {
        await client.query("SAVEPOINT s");
        const columns = [...new Set(["id", ...fields.filter((f) => live.has(f))])].join(", ");
        await client.query(`SELECT ${columns} FROM ${dataset.table} ORDER BY ${dataset.orderBy} LIMIT 1`);
        await client.query(`SELECT ${["id", ...fields].join(", ")} FROM ${dataset.table} ORDER BY ${dataset.orderBy} LIMIT 1`);
        await client.query("RELEASE SAVEPOINT s");
      } catch (error) {
        list = `FAILS ${error.code || ""} ${String(error.message).slice(0, 160)}`;
        await client.query("ROLLBACK TO SAVEPOINT s");
      }
      const parts = [`${key}: list ${list}`];
      if (missing.length) parts.push(`missing columns: ${missing.join(", ")}`);
      if (required.length) parts.push(`NOT NULL without default and not in form: ${required.join(", ")}`);
      report.push(parts.join(" | "));

      const types = [...live.values()].map((c) => `${c.column_name}:${c.udt_name}${c.is_nullable === "NO" ? "!" : ""}${c.column_default != null ? "=" + String(c.column_default).slice(0, 40) : ""}`);
      const tableChecks = checks.filter((c) => c.table_name === dataset.table).map((c) => c.def.slice(0, 220));
      detail.push(`${dataset.table}: ${types.join(", ")}${tableChecks.length ? `\n  checks: ${tableChecks.join(" ; ")}` : ""}`);
    }
    await client.query("ROLLBACK");
  } finally {
    client.release();
    await pool.end();
  }
  console.log(report.join("\n"));
  console.log("\n" + detail.join("\n"));
  annotate("Admin schema check", report);
  // Annotations are size-limited; split the column detail into several.
  for (let i = 0; i < detail.length; i += 4) annotate(`Columns ${i / 4 + 1}`, detail.slice(i, i + 4));
}

main().catch((error) => {
  console.error(`Schema check failed: ${error.code || ""} ${error.message}`);
  annotate("Admin schema check failed", [`${error.code || ""} ${error.message}`]);
  process.exit(1);
});
