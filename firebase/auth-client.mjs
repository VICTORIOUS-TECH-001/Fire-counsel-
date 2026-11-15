// Firebase Auth helpers for student/admin browser pages.
// The same Firebase account can be a student or admin; the server-authorized
// `admin` custom claim is the only source of admin permission.
import {
  GoogleAuthProvider,
  getAuth,
  getRedirectResult,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { firebaseApp } from "./client.mjs";

export const firebaseAuth = getAuth(firebaseApp);
export { getRedirectResult, onAuthStateChanged, signOut };

export function requestPasswordReset(email) {
  return sendPasswordResetEmail(firebaseAuth, email.trim());
}

export function signInWithEmail(email, password) {
  return signInWithEmailAndPassword(firebaseAuth, email.trim(), password);
}

export async function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });

  try {
    return await signInWithPopup(firebaseAuth, provider);
  } catch (error) {
    // Redirect sign-in works in browsers that block popups, including some PWA
    // and mobile contexts. Firebase returns to this page after authorization.
    if (["auth/popup-blocked", "auth/operation-not-supported-in-this-environment"].includes(error.code)) {
      await signInWithRedirect(firebaseAuth, provider);
      return null;
    }
    throw error;
  }
}

export async function getApiAuthorizationHeader(forceRefresh = false) {
  const user = firebaseAuth.currentUser;
  if (!user) throw new Error("Sign in with Firebase Auth before calling the API.");
  return { Authorization: `Bearer ${await user.getIdToken(forceRefresh)}` };
}

// The frontend may use this claim for display only. Backend routes must verify
// the ID token and admin claim independently with Firebase Admin.
export async function getDisplayRole() {
  const user = firebaseAuth.currentUser;
  if (!user) return "signed-out";
  const token = await user.getIdTokenResult();
  return token.claims.admin === true ? "admin" : "student";
}

// Same-origin only: deployment must proxy/serve /api on this origin. This keeps
// browser code free of localhost URLs and prevents arbitrary token exfiltration.
export async function apiRequest(path, options = {}) {
  const url = new URL(path, window.location.origin);
  if (url.origin !== window.location.origin || !url.pathname.startsWith("/api/")) {
    throw new Error("API calls must use a same-origin /api/ path.");
  }

  const headers = new Headers(options.headers || {});
  if (options.auth !== false) {
    const authorization = await getApiAuthorizationHeader();
    headers.set("Authorization", authorization.Authorization);
  }
  if (options.body && !(options.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const { auth: _auth, ...fetchOptions } = options;
  return fetch(url, { ...fetchOptions, headers, credentials: "same-origin" });
}
