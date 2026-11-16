// Firebase owns all credentials; Neon owns only the editable student profile.
// The verified `admin: true` claim is the only source of admin permission.
import {
  EmailAuthProvider,
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  getAuth,
  getRedirectResult,
  onAuthStateChanged,
  reauthenticateWithCredential,
  reauthenticateWithPopup,
  reload,
  sendEmailVerification,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  sendPasswordResetEmail,
  updatePassword,
  updateProfile,
  verifyBeforeUpdateEmail
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { firebaseApp } from "./client.mjs";
import { browserInstallation, INSTALLATION_HEADER, needsStudentInstallation } from "../installation.mjs";

export const firebaseAuth = getAuth(firebaseApp);
export { getRedirectResult, onAuthStateChanged, signOut };

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

export function requestPasswordReset(email) {
  return sendPasswordResetEmail(firebaseAuth, email.trim());
}

export function signInWithEmail(email, password) {
  return signInWithEmailAndPassword(firebaseAuth, email.trim(), password);
}

export async function registerWithEmail(email, password, name) {
  const fullName = name.trim();
  if (!fullName || fullName.length > 120 || /[\u0000-\u001f\u007f]/.test(fullName)) throw new Error("Enter a name from 1 to 120 characters, without control characters.");
  const result = await createUserWithEmailAndPassword(firebaseAuth, email.trim(), password);
  assertSameAccount(result.user);
  try {
    await updateProfile(result.user, { displayName: fullName });
  } catch {
    // Firebase account creation cannot be rolled back by a failed name update.
    // Never delete an account or encourage a duplicate registration here.
    throw new Error("Firebase created your account, but could not save its initial name. Open your student profile to set your name; do not register again.");
  }
  return result;
}

export async function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
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
