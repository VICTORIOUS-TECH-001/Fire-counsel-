import assert from "node:assert/strict";
import test from "node:test";
import { resolveGateAccess, AUTH_GATE_SESSION_KEY } from "../../auth-gate.mjs";

test("auth gate: a signed-in student always unlocks", () => {
  assert.equal(resolveGateAccess({ user: { uid: "u1" }, googleSession: true, authReady: true, hadSession: false }), "unlocked");
  assert.equal(resolveGateAccess({ user: { uid: "u1" }, googleSession: true, authReady: false, hadSession: false }), "unlocked");
});

test("auth gate: a definitively signed-out visitor is locked, even with a past session", () => {
  // Signed out online (auth answered null): always lock — this also covers an
  // explicit sign-out, which clears the offline-return marker.
  assert.equal(resolveGateAccess({ user: null, authReady: true, hadSession: false }), "locked");
  assert.equal(resolveGateAccess({ user: null, authReady: true, hadSession: true }), "locked");
});

test("auth gate: offline opens only for a browser that signed in before", () => {
  assert.equal(resolveGateAccess({ user: null, authReady: false, hadSession: true }), "offline-unlocked");
  assert.equal(resolveGateAccess({ user: null, authReady: false, hadSession: false }), "locked");
});

test("auth gate: session marker key is versioned", () => {
  assert.match(AUTH_GATE_SESSION_KEY, /^fire-counsel-auth-gate-v\d+$/);
});


test("auth gate: a saved non-Google session never unlocks, even with an offline marker", () => {
  assert.equal(resolveGateAccess({ user: { uid: "u1" }, googleSession: false, authReady: true, hadSession: true }), "locked");
  assert.equal(resolveGateAccess({ user: { uid: "u1" }, authReady: false, hadSession: true }), "locked");
});
