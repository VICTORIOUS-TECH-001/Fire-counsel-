import assert from "node:assert/strict";
import test from "node:test";
import { authErrorText } from "../../firebase/auth-errors.mjs";

test("auth error text covers the credential and session failure family", () => {
  for (const code of ["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found"]) {
    assert.equal(authErrorText({ code }), "Email or password was not accepted.");
  }
  assert.match(authErrorText({ code: "auth/user-disabled" }), /disabled/i);
  assert.match(authErrorText({ code: "auth/invalid-email" }), /valid email/i);
  assert.match(authErrorText({ code: "auth/missing-email" }), /valid email/i);
  assert.match(authErrorText({ code: "auth/requires-recent-login" }), /sign in again/i);
  assert.match(authErrorText({ code: "auth/too-many-requests" }), /Too many attempts/);
  assert.match(authErrorText({ code: "auth/network-request-failed" }), /could not be reached/i);
});

test("auth error text keeps the setup guidance for misconfiguration", () => {
  assert.match(authErrorText({ code: "auth/unauthorized-domain" }), /Authorized domains/);
  assert.match(authErrorText({ code: "auth/invalid-api-key" }), /firebase-config\.mjs/);
  assert.match(authErrorText({ code: "auth/operation-not-allowed" }), /not enabled/);
  assert.match(authErrorText({ code: "auth/popup-blocked" }), /popup/i);
  assert.match(authErrorText({ code: "auth/multi-factor-auth-required" }), /6-digit code/);
});

test("unknown errors fall back to their message without leaking internals", () => {
  assert.equal(authErrorText({ code: "auth/whatever", message: "Synthetic detail" }), "Synthetic detail");
  assert.equal(authErrorText({}), "Sign-in could not be completed. Try again.");
  assert.equal(authErrorText(null), "Sign-in could not be completed. Try again.");
});
