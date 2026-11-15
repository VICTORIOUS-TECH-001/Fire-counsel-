import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import test from "node:test";
import { createResearchSearchRouter } from "../src/routes/researchSearch.js";

const COURSE_ID = "423e4567-e89b-42d3-a456-426614174000";

async function serveRouter(t, router) {
  const app = express();
  app.use(express.json());
  app.use("/research", router);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return `http://127.0.0.1:${server.address().port}/research/search`;
}

function makeRouter(pool, configured = () => true) {
  return createResearchSearchRouter({
    configured,
    installationGate: (_req, _res, next) => next(),
    poolProvider: () => pool,
    verifyToken(req, _res, next) {
      req.user = { uid: "student-firebase-uid", email: "student@example.invalid", admin: false };
      next();
    }
  });
}

test("verified source search uses Neon-only retrieval and returns structured legal sources", async (t) => {
  const queries = [];
  const pool = { async query(text, values) { queries.push({ text, values }); return { rows: [] }; } };
  const url = await serveRouter(t, makeRouter(pool));
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "contract formation offer acceptance", course_id: COURSE_ID })
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.data, { materials: [], cases: [], statutes: [], pastQuestions: [], mnemonics: [], summaries: [], rubrics: [] });
  assert.equal(body.pipeline.externalProviderCalled, false);
  assert.equal(body.pipeline.aiGeneration, "disabled-pending-provider-review");
  assert.equal(queries.length, 7);
  for (const query of queries) {
    assert.equal(query.values[0], "student-firebase-uid");
    assert.equal(query.values[1], "contract formation offer acceptance");
    assert.match(query.text, /verified|approved/);
    assert.doesNotMatch(query.text, /embedding|file_storage_path/);
  }
});

test("source search validates query and optional course identifiers before querying Neon", async (t) => {
  let queryCalled = false;
  const pool = { async query() { queryCalled = true; return { rows: [] }; } };
  const url = await serveRouter(t, makeRouter(pool));
  const shortQuery = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "hi" })
  });
  assert.equal(shortQuery.status, 400);
  const badCourse = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "contract law", course_id: "not-a-uuid" })
  });
  assert.equal(badCourse.status, 400);
  assert.equal(queryCalled, false);
});

test("source search fails closed when Neon is not configured", async (t) => {
  let queryCalled = false;
  const pool = { async query() { queryCalled = true; return { rows: [] }; } };
  const url = await serveRouter(t, makeRouter(pool, () => false));
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "contract law" })
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "DATABASE_NOT_CONFIGURED");
  assert.equal(queryCalled, false);
});
