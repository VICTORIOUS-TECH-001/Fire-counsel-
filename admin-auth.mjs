import { createRequestScope } from "./request-scope.mjs";

const $ = (selector) => document.querySelector(selector);
const title = $("#admin-auth-title");
const message = $("#admin-auth-message");
const statusCard = $("#admin-auth-status");
const signInLink = $("#admin-auth-link");
const signOutButton = $("#admin-signout");
let authClient;
const sessionScope = createRequestScope();

function setStatus(state, heading, detail) {
  statusCard.dataset.state = state;
  title.textContent = heading;
  message.textContent = detail;
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
      setStatus("verified", "Server verified administrator access", `${user.email || "Signed-in user"}. Database editing additionally requires a healthy Neon connection. AI, uploads, quotas and account adjustments remain disabled.`);
      return;
    }
    if (response.status === 403) {
      setStatus("denied", "This account is not an administrator", "A trusted project owner must grant the Firebase admin custom claim. The browser cannot grant itself access.");
      return;
    }
    setStatus("offline", "Admin API is not ready", "Firebase sign-in succeeded, but the same-origin API did not verify admin access. No live admin action is enabled.");
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
  setStatus("offline", "Firebase client configuration is missing", "Copy firebase/firebase-config.example.mjs to the ignored local config file and add the Web API key.");
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
