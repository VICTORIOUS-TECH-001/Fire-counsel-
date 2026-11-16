import assert from "node:assert/strict";
import test from "node:test";
import { createRequestScope } from "../../request-scope.mjs";

test("a new request invalidates the previous response without affecting independent scopes", () => {
  const scope = createRequestScope();
  const independent = createRequestScope().begin();
  const first = scope.begin();
  assert.equal(first(), true);
  const second = scope.begin();
  assert.equal(first(), false);
  assert.equal(second(), true);
  assert.equal(independent(), true);
});

test("a session change invalidates all outstanding response guards", () => {
  const scope = createRequestScope();
  const first = scope.capture();
  const second = scope.capture();
  scope.invalidate();
  assert.equal(first(), false);
  assert.equal(second(), false);
  assert.equal(scope.capture()(), true);
});
