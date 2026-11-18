import assert from "node:assert/strict";
import test from "node:test";
import { resolveWorkspaceAccess, WORKSPACE_SESSION_KEY } from "../../workspace-gate.mjs";

test("workspace gate: a signed-in student always unlocks", () => {
  assert.equal(resolveWorkspaceAccess({ user: { uid: "u1" }, authReady: true, hadSession: false }), "unlocked");
  assert.equal(resolveWorkspaceAccess({ user: { uid: "u1" }, authReady: false, hadSession: false }), "unlocked");
});

test("workspace gate: a definitively signed-out visitor is locked, even with a past session", () => {
  // Signed out online (auth answered null): always lock — this also covers an
  // explicit sign-out, which clears the offline-return marker.
  assert.equal(resolveWorkspaceAccess({ user: null, authReady: true, hadSession: false }), "locked");
  assert.equal(resolveWorkspaceAccess({ user: null, authReady: true, hadSession: true }), "locked");
});

test("workspace gate: offline opens only for a browser that signed in before", () => {
  assert.equal(resolveWorkspaceAccess({ user: null, authReady: false, hadSession: true }), "offline-unlocked");
  assert.equal(resolveWorkspaceAccess({ user: null, authReady: false, hadSession: false }), "locked");
});

test("workspace gate: session marker key is versioned", () => {
  assert.match(WORKSPACE_SESSION_KEY, /^fire-counsel-workspace-session-v\d+$/);
});
