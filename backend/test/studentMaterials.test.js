import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import test from "node:test";
import { createStudentMaterialsRouter } from "../src/routes/studentMaterials.js";

const MATERIAL_ID = "323e4567-e89b-42d3-a456-426614174000";

async function serveRouter(t, router) {
  const app = express();
  app.use("/materials", router);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return `http://127.0.0.1:${server.address().port}/materials`;
}

function makeRouter(pool, rows = [{ id: MATERIAL_ID, title: "Contract Law Notes" }], configured = () => true) {
  return createStudentMaterialsRouter({
    configured,
    poolProvider: () => pool,
    verifyToken(req, _res, next) {
      req.user = { uid: "student-firebase-uid", email: "student@example.invalid", admin: false };
      next();
    }
  });
}

test("student material reads require approved/published scope and course eligibility", async (t) => {
  const queries = [];
  const pool = { async query(text, values) { queries.push({ text, values }); return { rows: [{ id: MATERIAL_ID, title: "Contract Law Notes" }] }; } };
  const base = await serveRouter(t, makeRouter(pool));
  const response = await fetch(base);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data[0].title, "Contract Law Notes");
  assert.equal(queries[0].values[0], "student-firebase-uid");
  assert.match(queries[0].text, /approval_status = 'approved'/);
  assert.match(queries[0].text, /publication_status = 'published'/);
  assert.match(queries[0].text, /institution_memberships/);
  assert.match(queries[0].text, /course_enrollments/);
  assert.match(queries[0].text, /student_upload/);
  assert.doesNotMatch(queries[0].text, /file_storage_path|embedding/);
});

test("student cannot retrieve a material outside their allowed scopes", async (t) => {
  const pool = { async query() { return { rows: [] }; } };
  const base = await serveRouter(t, makeRouter(pool, []));
  const response = await fetch(`${base}/${MATERIAL_ID}`);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).code, "NOT_FOUND");
});

test("student content reads fail closed when Neon is not configured", async (t) => {
  let queryCalled = false;
  const pool = { async query() { queryCalled = true; return { rows: [] }; } };
  const base = await serveRouter(t, makeRouter(pool, [], () => false));
  const response = await fetch(base);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "DATABASE_NOT_CONFIGURED");
  assert.equal(queryCalled, false);
});
