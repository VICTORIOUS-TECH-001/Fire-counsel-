// Firebase owns all credentials; Neon owns only the editable student profile.
// The verified `admin: true` claim is the only source of admin permission.
import {
  EmailAuthProvider,
  GoogleAuthProvider,
  getAuth,
  getRedirectResult,
  onAuthStateChanged,
  onIdTokenChanged,
  reauthenticateWithCredential,
  reauthenticateWithPopup,
  reload,
  sendEmailVerification,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  TotpMultiFactorGenerator,
  getMultiFactorResolver,
  updatePassword,
  verifyBeforeUpdateEmail
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { firebaseApp, firebaseSetupError } from "./client.mjs";
import { browserInstallation, INSTALLATION_HEADER, needsStudentInstallation } from "../installation.mjs";

if (!firebaseApp) {
  throw new Error(firebaseSetupError() || "Firebase Web configuration is incomplete.");
}

export const firebaseAuth = getAuth(firebaseApp);
export { getRedirectResult, onAuthStateChanged, onIdTokenChanged, signOut };

let pendingMfaResolver = null;

export function beginMfaChallenge(error) {
  if (error?.code !== "auth/multi-factor-auth-required") return null;
  const resolver = getMultiFactorResolver(firebaseAuth, error);
  const hint = resolver.hints.find((item) => item.factorId === TotpMultiFactorGenerator.FACTOR_ID);
  if (!hint) throw new Error("This account's second factor is not a Google Authenticator (TOTP) code, so this page cannot finish sign-in.");
  pendingMfaResolver = resolver;
  return { displayName: hint.displayName || "Google Authenticator" };
}

export async function completeMfaChallenge(code) {
  if (!pendingMfaResolver) throw new Error("Start sign-in again, then enter the authenticator code.");
  const hint = pendingMfaResolver.hints.find((item) => item.factorId === TotpMultiFactorGenerator.FACTOR_ID);
  const assertion = TotpMultiFactorGenerator.assertionForSignIn(hint.uid, String(code).replace(/\s/g, ""));
  const result = await pendingMfaResolver.resolveSignIn(assertion);
  pendingMfaResolver = null;
  return result;
}

function currentAccount() {
  const user = firebaseAuth.currentUser;
  if (!user) throw new Error("Sign in with Firebase Auth before managing your account.");
  return user;
}

function assertSameAccount(user) {
  if (firebaseAuth.currentUser !== user) throw new Error("Your session changed. Please try again with the current account.");
}

export function hasPasswordProvider(user = firebaseAuth.currentUser) {
  return Boolean(user?.providerData?.some(provider => provider.providerId === "password"));
}

// UI check only; the API and Firebase rules independently require the verified
// token's provider. providerData is insufficient for accounts linked to both
// Google and a legacy password: it does not say how THIS session signed in.
export async function hasGoogleSession(user = firebaseAuth.currentUser) {
  if (!user) return false;
  const token = await user.getIdTokenResult();
  assertSameAccount(user);
  return token.claims.firebase?.sign_in_provider === "google.com";
}

export async function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  // Popups fail inside a cross-origin preview frame. Redirect stays on this page.
  const framed = typeof window !== "undefined" && window.top && window.top !== window;
  if (framed) {
    await signInWithRedirect(firebaseAuth, provider);
    return null;
  }
  try {
    return await signInWithPopup(firebaseAuth, provider);
  } catch (error) {
    if (["auth/popup-blocked", "auth/operation-not-supported-in-this-environment"].includes(error.code)) {
      await signInWithRedirect(firebaseAuth, provider);
      return null;
    }
    throw error;
  }
}

async function reauthenticateAccount(user, password) {
  if (hasPasswordProvider(user)) {
    if (!password) throw new Error("Enter your current Firebase password to confirm this change.");
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password));
  } else if (user.providerData?.some(provider => provider.providerId === "google.com")) {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    // Reauthentication must confirm this exact Firebase user, not sign in to a
    // different account. A blocked popup is an error, never a silent transfer.
    await reauthenticateWithPopup(user, provider);
  } else throw new Error("This sign-in provider does not support account changes here.");
  assertSameAccount(user);
}

export async function requestAccountEmailChange(email, password = "") {
  const user = currentAccount();
  await reauthenticateAccount(user, password);
  return verifyBeforeUpdateEmail(user, email.trim());
}

export async function changeAccountPassword(currentPassword, newPassword) {
  const user = currentAccount();
  if (!hasPasswordProvider(user)) throw new Error("Google manages your Google password. There is no Firebase password to display or change for this Google-only account.");
  await reauthenticateAccount(user, currentPassword);
  return updatePassword(user, newPassword);
}

export function requestAccountVerification() {
  return sendEmailVerification(currentAccount());
}

export async function refreshAccount() {
  const user = currentAccount();
  await reload(user);
  assertSameAccount(user);
  await user.getIdToken(true);
  assertSameAccount(user);
  return user;
}

export async function getApiAuthorizationHeader(forceRefresh = false) {
  const user = currentAccount();
  if (!(await hasGoogleSession(user))) {
    throw Object.assign(new Error("Sign in with Google to use FIRE COUNSEL."), { code: "auth/google-sign-in-required" });
  }
  const token = await user.getIdToken(forceRefresh);
  assertSameAccount(user);
  return { Authorization: `Bearer ${token}` };
}

// Display only. Every protected server route independently verifies the token.
export async function getDisplayRole() {
  const user = firebaseAuth.currentUser;
  if (!user) return "signed-out";
  const token = await user.getIdTokenResult();
  assertSameAccount(user);
  return token.claims.admin === true ? "admin" : "student";
}

// True when the current token carries the server-issued admin: true claim.
// Firestore/Storage rules re-check this claim on every direct client write;
// this helper only decides what the UI offers. A freshly granted claim needs
// getIdToken(true) first — the admin page does that after /api/v1/admin/claim.
export async function hasAdminClaim(user = firebaseAuth.currentUser) {
  if (!user) return false;
  const token = await user.getIdTokenResult();
  assertSameAccount(user);
  return token.claims.admin === true;
}

// Same-origin only: deployment must proxy/serve /api on this origin. Neither
// Firebase credentials nor the installation marker can be sent to another host.
export async function apiRequest(path, options = {}) {
  const url = new URL(path, window.location.origin);
  if (url.origin !== window.location.origin || !url.pathname.startsWith("/api/")) {
    throw new Error("API calls must use a same-origin /api/ path.");
  }
  const headers = new Headers(options.headers || {});
  if (options.auth !== false) {
    const user = currentAccount();
    const authorization = await getApiAuthorizationHeader();
    headers.set("Authorization", authorization.Authorization);
    if (needsStudentInstallation(url.pathname)) headers.set(INSTALLATION_HEADER, await browserInstallation());
    assertSameAccount(user);
  }
  if (options.body && !(options.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const { auth: _auth, ...fetchOptions } = options;
  return fetch(url, { ...fetchOptions, headers, credentials: "same-origin", mode: "same-origin", redirect: "error", cache: "no-store" });
}
