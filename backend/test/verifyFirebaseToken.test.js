import test from "node:test";
import assert from "node:assert/strict";
import { createFirebaseTokenVerifier } from "../src/middleware/verifyFirebaseToken.js";

function responseMock() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

function requestMock(authorization) {
  return { headers: authorization ? { authorization } : {}, user: undefined };
}

test("rejects missing bearer tokens without initializing Firebase", async () => {
  let providerCalled = false;
  let nextCalled = false;
  const res = responseMock();
  const verify = createFirebaseTokenVerifier(() => { providerCalled = true; });

  await verify(requestMock(undefined), res, () => { nextCalled = true; });

  assert.equal(res.statusCode, 401);
  assert.equal(providerCalled, false);
  assert.equal(nextCalled, false);
});

test("fails closed when Firebase Admin credentials are unavailable", async () => {
  const res = responseMock();
  const verify = createFirebaseTokenVerifier(() => { throw new Error("not configured"); });

  await verify(requestMock("Bearer example-token"), res, () => {});

  assert.equal(res.statusCode, 503);
  assert.match(res.body.error, /unavailable/i);
});

test("trusts the admin claim only from a Firebase-verified decoded token", async () => {
  const res = responseMock();
  let nextCalled = false;
  let checkedRevocation;
  const auth = {
    async verifyIdToken(token, checkRevoked) {
      assert.equal(token, "example-token");
      checkedRevocation = checkRevoked;
      return {
        uid: "test-admin",
        email: "admin@example.invalid",
        email_verified: true,
        admin: true
      };
    }
  };
  const verify = createFirebaseTokenVerifier(() => auth);
  const req = requestMock("Bearer example-token");

  await verify(req, res, () => { nextCalled = true; });

  assert.equal(res.statusCode, null);
  assert.equal(checkedRevocation, true);
  assert.equal(nextCalled, true);
  assert.deepEqual(req.user, {
    uid: "test-admin",
    email: "admin@example.invalid",
    name: null,
    emailVerified: true,
    admin: true
  });
});

test("does not treat a string or request-body admin flag as an admin claim", async () => {
  const res = responseMock();
  const auth = { async verifyIdToken() { return { uid: "test-student", admin: "true" }; } };
  const verify = createFirebaseTokenVerifier(() => auth);
  const req = { ...requestMock("Bearer example-token"), body: { admin: true } };

  await verify(req, res, () => {});

  assert.equal(res.statusCode, null);
  assert.equal(req.user.admin, false);
});

test("rejects invalid or revoked Firebase tokens", async () => {
  const res = responseMock();
  const auth = { async verifyIdToken() { throw new Error("invalid token"); } };
  const verify = createFirebaseTokenVerifier(() => auth);

  await verify(requestMock("Bearer invalid-token"), res, () => {});

  assert.equal(res.statusCode, 401);
  assert.match(res.body.error, /invalid/i);
});
