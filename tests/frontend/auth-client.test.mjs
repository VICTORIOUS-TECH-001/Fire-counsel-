import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { INSTALLATION_HEADER, needsStudentInstallation } from "../../installation.mjs";

const source = readFileSync(new URL("../../firebase/auth-client.mjs", import.meta.url), "utf8");
// Evaluate the actual helper code with an in-memory Firebase SDK, not the CDN.
// No provider, credentials, email service, browser server or network is used.
function client({ provider = "password" } = {}) {
  const calls = [];
  const requests = [];
  const user = {
    uid: "synthetic-uid", email: "student@example.invalid", providerData: [{ providerId: provider }],
    async getIdToken(refresh) { calls.push(["token", refresh]); return "synthetic-id-token"; },
    async getIdTokenResult() { return { claims: { admin: false } }; }
  };
  const auth = { currentUser: user };
  const sdk = {
    firebaseApp: {}, getAuth: () => auth,
    GoogleAuthProvider: class { setCustomParameters(parameters) { calls.push(["google-parameters", parameters.prompt]); } },
    EmailAuthProvider: { credential(email, password) { return { email, password }; } },
    async createUserWithEmailAndPassword(_auth, email, password) { calls.push(["register", email, password]); user.email = email; auth.currentUser = user; return { user }; },
    async updateProfile(account, values) { calls.push(["name", account.uid, values.displayName]); },
    async reauthenticateWithCredential(account, credential) { calls.push(["reauth-password", account.uid, credential.email, credential.password]); },
    async reauthenticateWithPopup(account) { calls.push(["reauth-google", account.uid]); },
    async verifyBeforeUpdateEmail(account, email) { calls.push(["verify-new-email", account.uid, email]); },
    async updatePassword(account, password) { calls.push(["update-password", account.uid, password]); },
    async sendEmailVerification(account) { calls.push(["verify-email", account.uid]); },
    async reload(account) { calls.push(["reload", account.uid]); },
    async signInWithEmailAndPassword(_auth, email, password) { calls.push(["signin", email, password]); },
    async sendPasswordResetEmail(_auth, email) { calls.push(["reset", email]); },
    async signInWithPopup() { calls.push(["google-popup"]); },
    async signInWithRedirect() { calls.push(["google-redirect"]); },
    TotpMultiFactorGenerator: {
      FACTOR_ID: "totp",
      assertionForSignIn(uid, code) { calls.push(["totp-assertion", uid, code]); return { uid, code }; }
    },
    getMultiFactorResolver() {
      return {
        hints: [{ factorId: "totp", uid: "factor-1", displayName: "Authenticator" }],
        async resolveSignIn(assertion) { calls.push(["resolve-mfa", assertion.code]); return { user }; }
      };
    },
    async signOut() { auth.currentUser = null; },
    getRedirectResult() {}, onAuthStateChanged() {}
  };
  const context = {
    ...Object.fromEntries(Object.keys(sdk).map(key => [key, (...args) => sdk[key](...args)])),
    // Classes/objects cannot be invoked through the generic async-function stub.
    GoogleAuthProvider: sdk.GoogleAuthProvider, EmailAuthProvider: sdk.EmailAuthProvider, firebaseApp: sdk.firebaseApp,
    TotpMultiFactorGenerator: sdk.TotpMultiFactorGenerator,
    getMultiFactorResolver: (...args) => sdk.getMultiFactorResolver(...args),
    URL, Headers, FormData,
    window: { location: { origin: "https://study.example" } },
    browserInstallation: async () => "a".repeat(43), INSTALLATION_HEADER, needsStudentInstallation,
    async fetch(url, options) { requests.push({ url: url.href, options }); return { ok: true }; }
  };
  const executable = source
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*"[^"]+";\s*/g, "")
    .replace(/export\s*\{[^}]*\};/g, "")
    .replace(/\bexport /g, "");
  const exports = ["registerWithEmail", "signInWithEmail", "signInWithGoogle", "beginMfaChallenge", "completeMfaChallenge", "hasPasswordProvider", "requestAccountEmailChange", "changeAccountPassword", "requestAccountVerification", "requestPasswordReset", "refreshAccount", "getApiAuthorizationHeader", "apiRequest", "hasAdminClaim"];
  vm.runInNewContext(`${executable}\nglobalThis.exports = { ${exports.join(",")} };`, context);
  return { ...context.exports, auth, user, sdk, context, calls, requests };
}

test("email registration sends credentials only to Firebase and uses the name as displayName", async () => {
  const api = client();
  await api.registerWithEmail(" student@example.invalid ", "synthetic-new-password", " Student Name ");
  assert.deepEqual(api.calls, [["register", "student@example.invalid", "synthetic-new-password"], ["name", "synthetic-uid", "Student Name"]]);
  assert.equal(api.requests.length, 0);
});

test("registration validates names before creating an identity and explains a partial name-update failure", async () => {
  const api = client();
  await assert.rejects(api.registerWithEmail("x@example.invalid", "synthetic", " "), /Enter a name/);
  assert.equal(api.calls.length, 0);
  api.sdk.updateProfile = async () => { throw new Error("synthetic name failure"); };
  await assert.rejects(api.registerWithEmail("x@example.invalid", "synthetic", "Student"), /Firebase created your account.*do not register again/);
  assert.equal(api.auth.currentUser, api.user);
});

test("password changes reauthenticate the current Firebase user and never call a profile/API route", async () => {
  const api = client();
  await api.changeAccountPassword("synthetic-current", "synthetic-new");
  assert.deepEqual(api.calls, [["reauth-password", "synthetic-uid", "student@example.invalid", "synthetic-current"], ["update-password", "synthetic-uid", "synthetic-new"]]);
  assert.equal(api.requests.length, 0);
});

test("Google-only accounts cannot display, invent or change a Firebase password", async () => {
  const api = client({ provider: "google.com" });
  assert.equal(api.hasPasswordProvider(), false);
  await assert.rejects(api.changeAccountPassword("anything", "new"), /Google manages your Google password/);
  assert.equal(api.calls.length, 0);
});

test("email changes verify before update and reauthenticate with the appropriate Firebase provider", async () => {
  const password = client();
  await password.requestAccountEmailChange(" new@example.invalid ", "synthetic-current");
  assert.equal(password.calls[0][0], "reauth-password");
  assert.deepEqual(password.calls[1], ["verify-new-email", "synthetic-uid", "new@example.invalid"]);
  const google = client({ provider: "google.com" });
  await google.requestAccountEmailChange("new@example.invalid");
  assert.deepEqual(google.calls, [["google-parameters", "select_account"], ["reauth-google", "synthetic-uid"], ["verify-new-email", "synthetic-uid", "new@example.invalid"]]);
  assert.equal(google.requests.length, 0);
});

test("failed reauthentication or an account switch cannot apply a sensitive change", async () => {
  const api = client();
  api.sdk.reauthenticateWithCredential = async () => { throw new Error("not accepted"); };
  await assert.rejects(api.changeAccountPassword("bad", "new"), /not accepted/);
  assert.ok(!api.calls.some(call => call[0] === "update-password"));
  api.sdk.reauthenticateWithCredential = async () => { api.auth.currentUser = null; };
  await assert.rejects(api.requestAccountEmailChange("new@example.invalid", "old"), /session changed/);
  assert.ok(!api.calls.some(call => call[0] === "verify-new-email"));
});

test("verification and password-reset emails are explicit Firebase actions, not Neon writes", async () => {
  const api = client();
  await api.requestAccountVerification();
  await api.requestPasswordReset(" student@example.invalid ");
  assert.deepEqual(api.calls, [["verify-email", "synthetic-uid"], ["reset", "student@example.invalid"]]);
  assert.equal(api.requests.length, 0);
});

test("refresh reloads Firebase and forces a new token before profile email sync", async () => {
  const api = client();
  await api.refreshAccount();
  assert.deepEqual(api.calls, [["reload", "synthetic-uid"], ["token", true]]);
});

test("student API requests use a persisted installation header and no-store while admin/identity calls do not", async () => {
  const api = client();
  await api.apiRequest("/api/v1/profile", { method: "PATCH", body: JSON.stringify({ full_name: "Student" }) });
  await api.apiRequest("/api/v1/materials/one");
  await api.apiRequest("/api/v1/research/search", { method: "POST", body: '{"query":"synthetic"}' });
  await api.apiRequest("/api/v1/admin/me");
  await api.apiRequest("/api/v1/me");
  for (const { options } of api.requests.slice(0, 3)) {
    assert.equal(options.headers.get(INSTALLATION_HEADER), "a".repeat(43));
    assert.equal(options.headers.get("Authorization"), "Bearer synthetic-id-token");
    assert.equal(options.cache, "no-store");
    assert.equal(options.credentials, "same-origin");
    assert.equal(options.mode, "same-origin");
    assert.equal(options.redirect, "error");
  }
  assert.ok(api.requests.slice(3).every(({ options }) => !options.headers.has(INSTALLATION_HEADER)));
});

test("the API helper refuses foreign origins/non-API paths before obtaining any token", async () => {
  const api = client();
  for (const path of ["https://attacker.invalid/api/v1/profile", "//attacker.invalid/api/v1/profile", "/study.html", "/api/../backend/.env"]) await assert.rejects(api.apiRequest(path), /same-origin \/api\//);
  assert.equal(api.calls.length, 0);
  assert.equal(api.requests.length, 0);
});

test("a token or installation response that arrives after sign-out cannot send a previous-session API request", async () => {
  const api = client();
  api.user.getIdToken = async () => { api.auth.currentUser = null; return "old-token"; };
  await assert.rejects(api.apiRequest("/api/v1/profile"), /session changed/);
  assert.equal(api.requests.length, 0);
  api.auth.currentUser = api.user;
  api.user.getIdToken = async () => "token";
  api.context.browserInstallation = async () => { api.auth.currentUser = null; return "a".repeat(43); };
  await assert.rejects(api.apiRequest("/api/v1/profile"), /session changed/);
  assert.equal(api.requests.length, 0);
});

test("only blocked/unsupported Google sign-in popups use redirect fallback", async () => {
  const api = client();
  api.sdk.signInWithPopup = async () => { throw Object.assign(new Error("blocked"), { code: "auth/popup-blocked" }); };
  assert.equal(await api.signInWithGoogle(), null);
  assert.ok(api.calls.some(call => call[0] === "google-redirect"));
  const denied = client();
  denied.sdk.signInWithPopup = async () => { throw Object.assign(new Error("provider denied"), { code: "auth/operation-not-allowed" }); };
  await assert.rejects(denied.signInWithGoogle(), /provider denied/);
  assert.ok(!denied.calls.some(call => call[0] === "google-redirect"));
});

test("Google Authenticator completes only a pending TOTP challenge", async () => {
  const api = client();
  assert.equal(api.beginMfaChallenge({ code: "auth/wrong-password" }), null);
  const challenge = api.beginMfaChallenge({ code: "auth/multi-factor-auth-required" });
  assert.equal(challenge.displayName, "Authenticator");
  await api.completeMfaChallenge(" 123 456 ");
  assert.deepEqual(api.calls.filter(call => call[0] === "totp-assertion" || call[0] === "resolve-mfa"), [
    ["totp-assertion", "factor-1", "123456"],
    ["resolve-mfa", "123456"]
  ]);
  await assert.rejects(api.completeMfaChallenge("123456"), /Start sign-in again/);
});

test("hasAdminClaim reads the token claim and never trusts a signed-out session", async () => {
  const api = client();
  assert.equal(await api.hasAdminClaim(), false);
  api.user.getIdTokenResult = async () => ({ claims: { admin: true } });
  assert.equal(await api.hasAdminClaim(), true);
  api.auth.currentUser = null;
  assert.equal(await api.hasAdminClaim(null), false);
  assert.equal(await api.hasAdminClaim(), false);
});
