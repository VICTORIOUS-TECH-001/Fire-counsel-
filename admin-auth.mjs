import { createRequestScope } from "./request-scope.mjs";

const $ = (selector) => document.querySelector(selector);
const title = $("#admin-auth-title");
const message = $("#admin-auth-message");
const statusCard = $("#admin-auth-status");
const signInLink = $("#admin-auth-link");
const signOutButton = $("#admin-signout");
const claimButton = $("#admin-claim");
let authClient;
const sessionScope = createRequestScope();

function setStatus(state, heading, detail) {
  statusCard.dataset.state = state;
  title.textContent = heading;
  message.textContent = detail;
  if (claimButton && state !== "claimable") claimButton.hidden = true;
  // Other admin panels (AI studio, users) load their data once verified.
  document.dispatchEvent(new CustomEvent("fire-counsel:admin-state", { detail: { state } }));
}

async function verifyAdmin(user) {
  const isCurrent = sessionScope.capture();
  signInLink.hidden = true;
  signOutButton.hidden = false;
  setStatus("checking", "Checking administrator permission…", user.email || "Checking this Firebase account with the API.");

  try {
    const response = await authClient.apiRequest("/api/v1/admin/me");
    if (!isCurrent()) return;
    if (response.ok) {
      setStatus("verified", "Server verified administrator access", `${user.email || "Signed-in user"}. You can edit database content, AI settings, prompts and user limits.`);
      return;
    }
    let body = {};
    try { body = await response.json(); } catch { /* not JSON */ }
    if (!isCurrent()) return;
    if (response.status === 403 && body.code === "ADMIN_CLAIM_AVAILABLE") {
      setStatus("claimable", "This account can become the administrator", `${user.email} is on the server's ADMIN_EMAILS list. Press the button once to turn on administrator access for this account.`);
      claimButton.hidden = false;
      return;
    }
    if (response.status === 403) {
      setStatus("denied", "This account is not an administrator", "To make it one, add this email to ADMIN_EMAILS in Render (Environment), wait for the restart, then reload this page. The browser cannot grant itself access.");
      return;
    }
    if (body.code === "FIREBASE_ADMIN_KEY_REJECTED") {
      setStatus("offline", "Firebase Admin key rejected", "Google rejected the server's key. In Firebase → Project settings → Service accounts, generate a new private key and paste the whole file into FIREBASE_SERVICE_ACCOUNT_JSON on Render.");
      return;
    }
    if (body.code === "FIREBASE_ADMIN_NOT_READY") {
      setStatus("offline", "Firebase Admin key not usable", `FIREBASE_SERVICE_ACCOUNT_JSON on Render needs fixing${body.reason ? ` (reason: ${body.reason})` : ""}. Open /api/health for details.`);
      return;
    }
    setStatus("offline", "Admin API is not ready", `Firebase sign-in succeeded, but the same-origin API did not verify admin access (server reply ${response.status}). No live admin action is enabled.`);
  } catch {
    if (!isCurrent()) return;
    setStatus("offline", "Admin API is not connected", "Firebase sign-in succeeded, but /api/v1/admin/me is unavailable on this origin. The panel remains a local preview.");
  }
}

try {
  authClient = await import("./firebase/auth-client.mjs");
  authClient.onAuthStateChanged(authClient.firebaseAuth, (user) => {
    sessionScope.invalidate();
    if (user) verifyAdmin(user).catch(() => {});
    else {
      signInLink.hidden = false;
      signOutButton.hidden = true;
      setStatus("signed-out", "Admin permission not verified", "Sign in to check the server-issued administrator claim. Local drafts remain local.");
    }
  }, (error) => {
    sessionScope.invalidate();
    signInLink.hidden = false;
    signOutButton.hidden = true;
    setStatus("offline", "Firebase Auth could not load", error.message || "Check the local Firebase configuration.");
  });
} catch (error) {
  signInLink.hidden = false;
  signOutButton.hidden = true;
  setStatus("offline", "Firebase client configuration is missing", error?.message || "Put the Firebase Web API key in firebase/firebase-config.mjs and reload.");
  console.warn("Admin sign-in unavailable:", error.message);
}

signOutButton.addEventListener("click", async () => {
  if (!authClient) return;
  try {
    await authClient.signOut(authClient.firebaseAuth);
  } catch (error) {
    setStatus("offline", "Could not sign out", error.message || "Try again.");
  }
});

claimButton?.addEventListener("click", async () => {
  if (!authClient?.firebaseAuth.currentUser) return;
  claimButton.disabled = true;
  try {
    const response = await authClient.apiRequest("/api/v1/admin/claim", { method: "POST" });
    let body = {};
    try { body = await response.json(); } catch { /* not JSON */ }
    if (!response.ok) throw new Error(body.error || `The server refused (${response.status}).`);
    // Fetch a fresh token so it carries the new admin claim.
    await authClient.firebaseAuth.currentUser.getIdToken(true);
    await verifyAdmin(authClient.firebaseAuth.currentUser);
  } catch (error) {
    setStatus("denied", "Could not turn on administrator access", error.message || "Try again.");
  } finally {
    claimButton.disabled = false;
  }
});
