import assert from "node:assert/strict";
import { after, test } from "node:test";
import { getPool } from "../src/config/database.js";

let pool;
const previousDatabaseUrl = process.env.DATABASE_URL;

test("Neon database pool requires PostgreSQL and enforces TLS certificate validation", () => {
  delete process.env.DATABASE_URL;
  assert.throws(() => getPool(), /DATABASE_URL is not configured/);

  process.env.DATABASE_URL = "https://example.invalid/database";
  assert.throws(() => getPool(), /must use the PostgreSQL protocol/);

  process.env.DATABASE_URL = "postgresql://user:password@db.example.invalid/database?sslmode=require";
  pool = getPool();
  assert.equal(pool.options.ssl.rejectUnauthorized, true);
  assert.equal(pool.options.max, 5);
  assert.equal(pool.options.connectionTimeoutMillis, 10_000);
});

after(async () => {
  if (pool) await pool.end();
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
});
