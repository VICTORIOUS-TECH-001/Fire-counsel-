import { createRequestScope } from "./request-scope.mjs";
import { authErrorText } from "./firebase/auth-errors.mjs";

const $ = selector => document.querySelector(selector);
const message = $("#auth-message");
const emailForm = $("#email-signin-form");
const googleButton = $("#google-signin-button");
const mfaForm = $("#mfa-form");
const divider = $("#auth-divider");
const signedInPanel = $("#signed-in-panel");
const continueButton = $("#continue-button");
const signOutButton = $("#sign-out-button");
const emailButton = $("#email-signin-button");
const forgotPasswordButton = $("#forgot-password-button");
const modeToggle = $("#auth-mode-toggle");
const requestedNext = new URLSearchParams(location.search).get("next") || "study.html#dashboard";
const allowedNextFiles = new Set(["study.html", "admin.html", "index.html", "ai.html"]);
let authClient;
let creatingAccount = false;
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
modeToggle.hidden = wantsAdmin;
$("#manage-profile-link").hidden = wantsAdmin;
if (wantsAdmin) $("#auth-intro").textContent = "Sign in to an existing administrator account. The server must verify the Firebase admin claim; registration, Google sign-in and profile creation never grant administrator permission.";

function setMessage(text, kind = "") {
  message.textContent = text;
  message.dataset.kind = kind;
}

function showMfa(info) {
  emailForm.hidden = true;
  divider.hidden = true;
  googleButton.hidden = true;
  signedInPanel.hidden = true;
  mfaForm.hidden = false;
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
      setMessage(body.error || "The server could not authorize this account on this browser installation. Local study is still available separately.", "error");
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
  emailForm.hidden = true;
  divider.hidden = true;
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

function setAccountMode(create) {
  creatingAccount = create && !wantsAdmin;
  for (const id of ["signup-name-row", "signup-confirm-row", "signup-hint"]) $(`#${id}`).hidden = !creatingAccount;
  $("#auth-name").disabled = !creatingAccount;
  $("#auth-password-confirm").disabled = !creatingAccount;
  $("#auth-password").value = "";
  $("#auth-password-confirm").value = "";
  $("#auth-password").autocomplete = creatingAccount ? "new-password" : "current-password";
  $("#auth-password").minLength = creatingAccount ? 8 : 6;
  $("#auth-title").textContent = creatingAccount ? "Your account starts here." : "Welcome back.";
  emailButton.textContent = creatingAccount ? "Create my Firebase account" : "Sign in with email";
  modeToggle.textContent = creatingAccount ? "Already have an account? Sign in" : "New here? Create a student account";
  forgotPasswordButton.hidden = creatingAccount;
}

try {
  authClient = await import("./firebase/auth-client.mjs");
} catch (error) {
  emailForm.hidden = true;
  divider.hidden = true;
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
  authClient.onAuthStateChanged(authClient.firebaseAuth, user => {
    sessionScope.invalidate();
    googleButton.disabled = false;
    continueButton.hidden = true;
    continueButton.disabled = true;
    $("#auth-password").value = "";
    $("#auth-password-confirm").value = "";
    if (user) showSignedIn(user);
    else if (mfaForm.hidden) {
      emailForm.hidden = false;
      divider.hidden = false;
      googleButton.hidden = false;
      signedInPanel.hidden = true;
      $("#signed-in-email").textContent = "";
      $("#auth-name").value = "";
      setMessage("Sign in with Google or email, or create a student account.");
    }
  }, error => handleAuthError(error));
}

modeToggle.addEventListener("click", () => setAccountMode(!creatingAccount));
emailForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (!authClient || emailButton.disabled) return;
  const email = $("#auth-email").value;
  const password = $("#auth-password").value;
  if (creatingAccount && password !== $("#auth-password-confirm").value) {
    setMessage("Your passwords do not match.", "error");
    return;
  }
  emailButton.disabled = true;
  modeToggle.disabled = true;
  googleButton.disabled = true;
  setMessage(creatingAccount ? "Creating your account securely with Firebase…" : "Signing in…");
  try {
    if (creatingAccount) await authClient.registerWithEmail(email, password, $("#auth-name").value);
    else await authClient.signInWithEmail(email, password);
  } catch (error) { handleAuthError(error); }
  finally {
    $("#auth-password").value = "";
    $("#auth-password-confirm").value = "";
    emailButton.disabled = false;
    modeToggle.disabled = false;
    googleButton.disabled = false;
  }
});

forgotPasswordButton.addEventListener("click", async () => {
  if (!authClient) return;
  const email = $("#auth-email").value.trim();
  if (!email) {
    setMessage("Enter your email address first, then request a reset link.", "error");
    $("#auth-email").focus();
    return;
  }
  const isCurrent = sessionScope.capture();
  forgotPasswordButton.disabled = true;
  setMessage("Requesting a password reset email…");
  try {
    await authClient.requestPasswordReset(email);
    if (isCurrent()) setMessage("If a Firebase account exists for that email, Firebase will send a password-reset link.", "ok");
  } catch (error) {
    if (!isCurrent()) return;
    if (error?.code === "auth/user-not-found") setMessage("If a Firebase account exists for that email, Firebase will send a password-reset link.", "ok");
    else setMessage("The password-reset request could not be completed. Check Firebase Auth setup and try again.", "error");
  } finally { forgotPasswordButton.disabled = false; }
});

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
