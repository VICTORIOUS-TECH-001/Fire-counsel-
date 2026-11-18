import { createRequestScope } from "./request-scope.mjs";
import { authErrorText } from "./firebase/auth-errors.mjs";

// Google is the only sign-in option. The session's token provider is checked
// as well, so a saved legacy password session cannot enable continuation.
// TOTP still appears when Firebase requires an enrolled second factor.
const $ = selector => document.querySelector(selector);
const message = $("#auth-message");
const googleButton = $("#google-signin-button");
const mfaForm = $("#mfa-form");
const signedInPanel = $("#signed-in-panel");
const continueButton = $("#continue-button");
const signOutButton = $("#sign-out-button");
const requestedNext = new URLSearchParams(location.search).get("next") || "study.html#dashboard";
const allowedNextFiles = new Set(["study.html", "admin.html", "index.html", "ai.html"]);
let authClient;
const sessionScope = createRequestScope();

function safeNextUrl(value) {
  try {
    const url = new URL(value, location.href);
    const file = url.pathname.split("/").filter(Boolean).at(-1) || "index.html";
    if (url.origin !== location.origin || !allowedNextFiles.has(file)) return new URL("./study.html#dashboard", location.href);
    return url;
  } catch { return new URL("./study.html#dashboard", location.href); }
}

const nextUrl = safeNextUrl(requestedNext);
const wantsAdmin = nextUrl.pathname.endsWith("/admin.html");
let continueUrl = nextUrl;
$("#manage-profile-link").hidden = wantsAdmin;
if (wantsAdmin) $("#auth-intro").textContent = "Sign in to an existing administrator account with Google. The server must verify the Firebase admin claim; Google sign-in and profile creation never grant administrator permission.";

function setMessage(text, kind = "") {
  message.textContent = text;
  message.dataset.kind = kind;
}

function showMfa(info) {
  googleButton.hidden = true;
  signedInPanel.hidden = true;
  mfaForm.hidden = false;
  $("#mfa-submit").disabled = false;
  $("#mfa-hint").textContent = `Enter the current 6-digit code from ${info.displayName}. Firebase Authentication with Identity Platform must have TOTP enabled, this email must be verified, and the account must already be enrolled. Codes change about every 30 seconds.`;
  setMessage(`Google accepted the first step. Finish with ${info.displayName}.`, "");
  $("#mfa-code").focus();
}

function hideMfa() {
  mfaForm.hidden = true;
  $("#mfa-code").value = "";
}

function handleAuthError(error) {
  if (error?.code === "auth/multi-factor-auth-required") {
    try {
      const info = authClient.beginMfaChallenge(error);
      if (info) {
        showMfa(info);
        return;
      }
    } catch (challengeError) {
      setMessage(authErrorText(challengeError), "error");
      return;
    }
  }
  setMessage(authErrorText(error), "error");
}

// Plain-language reason when the server cannot check sign-ins (text only, never keys).
function adminSetupProblem(status, body) {
  if (body?.code === "FIREBASE_ADMIN_KEY_REJECTED") return "Signed in, but Google rejected the server's Firebase Admin key. Create a new key in Firebase → Service accounts and paste it into FIREBASE_SERVICE_ACCOUNT_JSON on Render.";
  if (body?.code === "FIREBASE_ADMIN_NOT_READY") return `Signed in, but the server's Firebase Admin key (FIREBASE_SERVICE_ACCOUNT_JSON on Render) is not usable${body.reason ? ` (reason: ${body.reason})` : ""}. Open /api/health for details.`;
  return `Signed in, but the admin API could not verify permission (server reply ${status}). Live admin actions remain disabled.`;
}

async function verifyServerAccess(user) {
  const isCurrent = sessionScope.capture();
  const userLabel = user.email || "your Firebase account";
  if (wantsAdmin) {
    try {
      const response = await authClient.apiRequest("/api/v1/admin/me");
      if (!isCurrent()) return null;
      if (!response.ok) {
        let body = {};
        try { body = await response.json(); } catch { /* not JSON */ }
        if (!isCurrent()) return null;
        if (response.status === 403 && body.code === "ADMIN_CLAIM_AVAILABLE") {
          setMessage(`Signed in as ${userLabel}. Open the admin page and press "Make this account the administrator" once.`, "ok");
          return { label: "Open admin page", url: nextUrl };
        }
        setMessage(response.status === 403
          ? `Signed in as ${userLabel}, but the server did not grant this account admin permission.`
          : adminSetupProblem(response.status, body), "error");
        return null;
      }
      setMessage(`Server verified administrator access for ${userLabel}.`, "ok");
      return { label: "Open admin preview", url: nextUrl };
    } catch {
      if (isCurrent()) setMessage("Firebase sign-in succeeded, but the API is not connected on this origin. Admin access is not verified; only the local preview is available.", "error");
      return null;
    }
  }

  try {
    const response = await authClient.apiRequest("/api/v1/profile");
    let body = {};
    try { body = await response.json(); } catch { /* use the connection fallback */ }
    if (!isCurrent()) return null;
    if (response.ok && body.data) {
      setMessage(`Signed in as ${userLabel}. Your student profile is ready.`, "ok");
      return { label: "Continue to study", url: nextUrl };
    }
    if (response.status === 404 && body.code === "PROFILE_NOT_CREATED") {
      setMessage(`Signed in as ${userLabel}. Confirm your prefilled student profile next. No course or payment is needed.`, "ok");
      return { label: "Set up my student profile", url: new URL("./study.html#profile", location.href) };
    }
    if (response.status === 401 || response.status === 403) {
      setMessage(body.error || "The server could not authorize this account on this browser installation.", "error");
      return null;
    }
    setMessage(`Firebase sign-in succeeded for ${userLabel}; student profiles are not ready on this server. Your local study space is still available.`);
  } catch (error) {
    if (!isCurrent()) return null;
    setMessage(`Firebase sign-in succeeded for ${userLabel}, but its student profile could not be checked. ${error.message || "Local study remains available."}`, "error");
  }
  return { label: "Continue to local study", url: nextUrl };
}

function showSignedIn(user) {
  const isCurrent = sessionScope.capture();
  googleButton.hidden = true;
  hideMfa();
  signedInPanel.hidden = false;
  $("#signed-in-email").textContent = user.email || "Signed-in Firebase account";
  continueButton.hidden = true;
  continueButton.disabled = true;
  verifyServerAccess(user).then(result => {
    if (!result || !isCurrent()) return;
    continueUrl = result.url;
    continueButton.textContent = result.label;
    continueButton.hidden = false;
    continueButton.disabled = false;
  }).catch(() => {});
}

try {
  authClient = await import("./firebase/auth-client.mjs");
} catch (error) {
  googleButton.hidden = true;
  mfaForm.hidden = true;
  setMessage(error?.message || "Firebase client configuration could not load. Put the Web API key in firebase/firebase-config.mjs, then reload.", "error");
  console.warn("Firebase Auth setup unavailable:", error?.message || error);
}
if (authClient) {
  try {
    await authClient.getRedirectResult(authClient.firebaseAuth);
  } catch (error) {
    handleAuthError(error);
  }
  authClient.onIdTokenChanged(authClient.firebaseAuth, async user => {
    sessionScope.invalidate();
    const isCurrent = sessionScope.capture();
    continueButton.hidden = true;
    continueButton.disabled = true;
    signedInPanel.hidden = true;
    $("#signed-in-email").textContent = "";
    if (!user) {
      googleButton.disabled = false;
      if (mfaForm.hidden) {
        googleButton.hidden = false;
        setMessage("Sign in with your Google account to open FIRE COUNSEL.");
      }
      return;
    }
    googleButton.hidden = true;
    setMessage("Checking your Google sign-in…");
    try {
      const googleSession = await authClient.hasGoogleSession(user);
      if (!isCurrent()) return;
      if (googleSession) showSignedIn(user);
      else {
        hideMfa();
        googleButton.hidden = false;
        setMessage("This saved session did not sign in with Google. Continue with Google to open FIRE COUNSEL.", "error");
      }
    } catch (error) {
      if (!isCurrent()) return;
      googleButton.hidden = false;
      handleAuthError(error);
    } finally {
      if (isCurrent()) googleButton.disabled = false;
    }
  }, error => {
    sessionScope.invalidate();
    signedInPanel.hidden = true;
    continueButton.hidden = true;
    continueButton.disabled = true;
    handleAuthError(error);
  });
}

googleButton.addEventListener("click", async () => {
  if (!authClient || googleButton.disabled) return;
  googleButton.disabled = true;
  setMessage("Opening Google sign-in…");
  try { await authClient.signInWithGoogle(); }
  catch (error) { handleAuthError(error); }
  finally { googleButton.disabled = false; }
});

mfaForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (!authClient) return;
  const button = $("#mfa-submit");
  button.disabled = true;
  setMessage("Checking the authenticator code…");
  try {
    await authClient.completeMfaChallenge($("#mfa-code").value);
    hideMfa();
  } catch (error) {
    handleAuthError(error);
    button.disabled = false;
  }
});

continueButton.addEventListener("click", () => { if (!continueButton.disabled) location.assign(continueUrl.href); });
signOutButton.addEventListener("click", async () => {
  if (!authClient) return;
  try { await authClient.signOut(authClient.firebaseAuth); }
  catch (error) { setMessage(authErrorText(error), "error"); }
});
