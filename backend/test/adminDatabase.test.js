import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import test from "node:test";
import { createAdminDatabaseRouter } from "../src/routes/adminDatabase.js";

const USER_ID = "123e4567-e89b-42d3-a456-426614174000";
const ROW_ID = "223e4567-e89b-42d3-a456-426614174000";
const UNIVERSITY_ID = "323e4567-e89b-42d3-a456-426614174000";
const OTHER_UNIVERSITY_ID = "423e4567-e89b-42d3-a456-426614174000";
const COURSE_ID = "523e4567-e89b-42d3-a456-426614174000";
const OTHER_COURSE_ID = "623e4567-e89b-42d3-a456-426614174000";
const TOPIC_ID = "723e4567-e89b-42d3-a456-426614174000";
const FACULTY_ID = "823e4567-e89b-42d3-a456-426614174000";

function makeFakePool(customQuery = () => undefined) {
  const queries = [];
  const runQuery = async (text, values = []) => {
    queries.push({ text, values });
    const customResult = await customQuery(text, values);
    if (customResult !== undefined) return customResult;
    if (text.includes("INSERT INTO app_users")) return { rows: [{ id: USER_ID, account_status: "active" }] };
    if (text.startsWith("INSERT INTO universities")) return { rows: [{ id: ROW_ID }] };
    if (text.startsWith("SELECT id, name, short_name, slug, country, website")) {
      return { rows: [{ id: ROW_ID, name: values[0] || "University of Test", slug: values[1] || "test-u" }] };
    }
    if (text.startsWith("UPDATE universities")) return { rows: [{ id: ROW_ID, name: "University of Test" }] };
    if (text.startsWith("SELECT id FROM universities")) return { rows: [{ id: ROW_ID }] };
    if (text.startsWith("SELECT COUNT(*)")) return { rows: [{ total: 1 }] };
    if (text.startsWith("SELECT id, LEFT")) return { rows: [{ id: ROW_ID, label: "University of Test" }] };
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
    return { rows: [] };
  };
  return {
    queries,
    async query(text, values) { return runQuery(text, values); },
    async connect() {
      return { query: runQuery, release() {} };
    }
  };
}

async function serveRouter(t, router) {
  const app = express();
  app.use(express.json());
  app.use("/db", router);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return `http://127.0.0.1:${server.address().port}/db`;
}

function makeRouter(pool, configured = () => true) {
  return createAdminDatabaseRouter({
    poolProvider: () => pool,
    configured,
    verifyToken(req, _res, next) {
      req.user = { uid: "firebase-admin-uid", email: "admin@example.invalid", name: "Test Admin", admin: true };
      next();
    }
  });
}

test("database catalog is an explicit content allowlist, not a raw Neon table browser", async (t) => {
  const base = await serveRouter(t, makeRouter(makeFakePool()));
  const response = await fetch(`${base}/catalog`);
  const body = await response.json();
  const names = body.data.map((entry) => entry.key);

  assert.equal(response.status, 200);
  assert.ok(names.includes("materials"));
  assert.ok(names.includes("past_questions"));
  assert.ok(names.includes("legal_cases"));
  assert.ok(!names.includes("app_users"));
  assert.ok(!names.includes("student_flash_cases"));
  assert.ok(!names.includes("material_chunks"));
  assert.ok(!names.includes("roles"));
});

test("admin create uses parameterized values and server-controlled Neon actor fields", async (t) => {
  const pool = makeFakePool();
  const base = await serveRouter(t, makeRouter(pool));
  const response = await fetch(`${base}/universities`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "University of Test", slug: "test-u", country: "Nigeria" })
  });
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.data.id, ROW_ID);
  const insert = pool.queries.find((query) => query.text.startsWith("INSERT INTO universities"));
  assert.ok(insert);
  assert.deepEqual(insert.values, ["University of Test", "test-u", "Nigeria"]);
  assert.doesNotMatch(insert.text, /University of Test|firebase-admin-uid/);
  const identityWrite = pool.queries.find(query => query.text.includes("INSERT INTO app_users"));
  assert.ok(identityWrite);
  // Resolving an administrator actor must not reset a self-edited profile from
  // an old Firebase displayName/email claim on each unrelated content write.
  const conflictUpdate = identityWrite.text.split("ON CONFLICT")[1];
  assert.doesNotMatch(conflictUpdate, /SET email|full_name\s*=/);
});

test("admin rejects unknown fields and unknown database tables", async (t) => {
  const pool = makeFakePool();
  const base = await serveRouter(t, makeRouter(pool));
  const badField = await fetch(`${base}/materials`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Note", material_type: "handout", file_storage_path: "arbitrary/path" })
  });
  assert.equal(badField.status, 400);
  assert.equal((await badField.json()).code, "VALIDATION_ERROR");

  const badResource = await fetch(`${base}/app_users`);
  assert.equal(badResource.status, 404);
  assert.equal(pool.queries.length, 0);
});

test("database mutations fail closed when the local Neon URL is not configured", async (t) => {
  const pool = makeFakePool();
  const base = await serveRouter(t, makeRouter(pool, () => false));
  const response = await fetch(`${base}/universities`);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "DATABASE_NOT_CONFIGURED");
  assert.equal(pool.queries.length, 0);
});

test("course creation rejects a faculty from another university", async (t) => {
  const pool = makeFakePool(async (text) => {
    if (text === "SELECT university_id FROM faculties WHERE id = $1") return { rows: [{ university_id: OTHER_UNIVERSITY_ID }] };
    return undefined;
  });
  const base = await serveRouter(t, makeRouter(pool));
  const response = await fetch(`${base}/courses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ university_id: UNIVERSITY_ID, faculty_id: FACULTY_ID, title: "Contract law" })
  });

  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "RELATION_VALIDATION_ERROR");
  assert.equal(pool.queries.some((query) => query.text.startsWith("INSERT INTO courses")), false);
});

test("material creation verifies course references and derives its university", async (t) => {
  const pool = makeFakePool(async (text) => {
    if (text === "SELECT university_id FROM courses WHERE id = $1") return { rows: [{ university_id: UNIVERSITY_ID }] };
    if (text.startsWith("INSERT INTO materials")) return { rows: [{ id: ROW_ID }] };
    if (text.startsWith("SELECT id, university_id, course_id, topic_id, title")) {
      return { rows: [{ id: ROW_ID, university_id: UNIVERSITY_ID, course_id: COURSE_ID, title: "Contract notes" }] };
    }
    if (text.startsWith("SELECT id, version_number, extracted_text, extraction_status")) return { rows: [] };
    return undefined;
  });
  const base = await serveRouter(t, makeRouter(pool));
  const response = await fetch(`${base}/materials`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Contract notes", material_type: "handout", course_id: COURSE_ID, access_scope: "institution" })
  });

  assert.equal(response.status, 201);
  const insert = pool.queries.find((query) => query.text.startsWith("INSERT INTO materials"));
  assert.ok(insert.text.includes("university_id"));
  assert.ok(insert.values.includes(UNIVERSITY_ID));
});

test("material updates preserve a course-derived university when the input clears it", async (t) => {
  const current = {
    id: ROW_ID,
    university_id: UNIVERSITY_ID,
    course_id: COURSE_ID,
    topic_id: null,
    title: "Contract notes",
    description: null,
    material_type: "handout",
    source_category: "lecturer_material",
    access_scope: "institution",
    approval_status: "pending",
    publication_status: "draft"
  };
  const pool = makeFakePool(async (text) => {
    if (text === "SELECT university_id FROM courses WHERE id = $1") return { rows: [{ university_id: UNIVERSITY_ID }] };
    if (text.startsWith("SELECT id, university_id, course_id, topic_id, title")) return { rows: [{ ...current }] };
    if (text.startsWith("SELECT id, version_number, extracted_text, extraction_status")) return { rows: [] };
    if (text.startsWith("UPDATE materials SET")) return { rows: [{ id: ROW_ID }] };
    return undefined;
  });
  const base = await serveRouter(t, makeRouter(pool));
  const response = await fetch(`${base}/materials/${ROW_ID}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ university_id: null })
  });

  assert.equal(response.status, 200);
  const update = pool.queries.find((query) => query.text.startsWith("UPDATE materials SET"));
  assert.ok(update);
  assert.equal(update.values[0], UNIVERSITY_ID);
});

test("material rejects a topic from a different course before writing", async (t) => {
  const pool = makeFakePool(async (text) => {
    if (text === "SELECT university_id FROM courses WHERE id = $1") return { rows: [{ university_id: UNIVERSITY_ID }] };
    if (text === "SELECT course_id FROM course_topics WHERE id = $1") return { rows: [{ course_id: OTHER_COURSE_ID }] };
    return undefined;
  });
  const base = await serveRouter(t, makeRouter(pool));
  const response = await fetch(`${base}/materials`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Mismatched", material_type: "handout", university_id: UNIVERSITY_ID, course_id: COURSE_ID, topic_id: TOPIC_ID, access_scope: "institution" })
  });

  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "RELATION_VALIDATION_ERROR");
  assert.equal(pool.queries.some((query) => query.text.startsWith("INSERT INTO materials")), false);
  assert.equal(pool.queries.some((query) => query.text.includes("INSERT INTO app_users")), false);
});

test("delete requires explicit confirmation and deactivates a university instead of cascading", async (t) => {
  const pool = makeFakePool();
  const base = await serveRouter(t, makeRouter(pool));
  const noConfirm = await fetch(`${base}/universities/${ROW_ID}`, { method: "DELETE" });
  assert.equal(noConfirm.status, 400);
  assert.equal((await noConfirm.json()).code, "CONFIRMATION_REQUIRED");

  const response = await fetch(`${base}/universities/${ROW_ID}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirm: true })
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.data.deactivated, true);
  assert.ok(pool.queries.some((query) => query.text.startsWith("UPDATE universities SET is_active")));
});

test("pasted text versions and ordered chunks commit in one locked transaction", async (t) => {
  const versionId = "923e4567-e89b-42d3-a456-426614174000";
  const pool = makeFakePool(async (text) => {
    if (text === "SELECT id FROM materials WHERE id = $1 FOR UPDATE") return { rows: [{ id: ROW_ID }] };
    if (text.startsWith("SELECT COALESCE(MAX(version_number)")) return { rows: [{ version_number: 8 }] };
    if (text.startsWith("INSERT INTO material_versions")) return { rows: [{ id: versionId, material_id: ROW_ID, version_number: 8, extraction_status: "completed" }] };
    return undefined;
  });
  const content = "Reviewed staging legal text. ".repeat(400).trim();
  const base = await serveRouter(t, makeRouter(pool));
  const response = await fetch(`${base}/materials/${ROW_ID}/versions`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ extracted_text: content })
  });
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(body.data.version_number, 8);
  const chunks = pool.queries.filter(query => query.text.startsWith("INSERT INTO material_chunks"));
  assert.equal(chunks.length, body.data.chunk_count);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.map(query => query.values[3]).join(" "), content);
  chunks.forEach((query, index) => {
    assert.deepEqual(query.values.slice(0, 3), [ROW_ID, versionId, index]);
    assert.ok(query.values[3].length <= 4000);
  });
  const insert = pool.queries.find(query => query.text.startsWith("INSERT INTO material_versions"));
  assert.deepEqual(insert.values, [ROW_ID, 8, content, USER_ID]);
  assert.equal(pool.queries[0].text, "BEGIN");
  assert.equal(pool.queries.at(-1).text, "COMMIT");
  assert.ok(pool.queries.some(query => query.text.endsWith("FOR UPDATE")));
});

test("a failed material chunk rolls back the version and releases its connection", async (t) => {
  const pool = makeFakePool(async (text) => {
    if (text === "SELECT id FROM materials WHERE id = $1 FOR UPDATE") return { rows: [{ id: ROW_ID }] };
    if (text.startsWith("INSERT INTO material_versions")) return { rows: [{ id: COURSE_ID }] };
    if (text.startsWith("INSERT INTO material_chunks")) throw new Error("synthetic chunk failure");
    return undefined;
  });
  let released = false;
  const connect = pool.connect;
  pool.connect = async () => ({ ...await connect(), release() { released = true; } });
  const base = await serveRouter(t, makeRouter(pool));
  const response = await fetch(`${base}/materials/${ROW_ID}/versions`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ extracted_text: "Synthetic staging material" })
  });
  assert.equal(response.status, 500);
  assert.equal((await response.json()).code, "DATABASE_ERROR");
  assert.equal(pool.queries.at(-1).text, "ROLLBACK");
  assert.equal(pool.queries.some(query => query.text === "COMMIT"), false);
  assert.equal(released, true);
});

test("invalid text-version input is rejected without opening a database transaction", async (t) => {
  const pool = makeFakePool();
  const base = await serveRouter(t, makeRouter(pool));
  for (const [id, body] of [["invalid-id", { extracted_text: "test" }], [ROW_ID, { extracted_text: "  " }], [ROW_ID, { extracted_text: 123 }]]) {
    const response = await fetch(`${base}/materials/${id}/versions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, 400);
  }
  assert.equal(pool.queries.length, 0);
});
