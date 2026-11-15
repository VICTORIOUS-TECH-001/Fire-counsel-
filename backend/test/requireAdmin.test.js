import test from "node:test";
import assert from "node:assert/strict";
import { requireAdmin } from "../src/middleware/requireAdmin.js";

function responseMock() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

test("requires an authenticated user before checking admin status", () => {
  const res = responseMock();
  let nextCalled = false;

  requireAdmin({ body: { admin: true } }, res, () => { nextCalled = true; });

  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

test("denies a signed-in student", () => {
  const res = responseMock();
  let nextCalled = false;

  requireAdmin({ user: { uid: "test-student", admin: false } }, res, () => { nextCalled = true; });

  assert.equal(res.statusCode, 403);
  assert.equal(nextCalled, false);
});

test("allows only a server-populated verified admin claim", () => {
  const res = responseMock();
  let nextCalled = false;

  requireAdmin({ user: { uid: "test-admin", admin: true } }, res, () => { nextCalled = true; });

  assert.equal(res.statusCode, null);
  assert.equal(nextCalled, true);
});
