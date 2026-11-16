import { createRequestScope } from "./request-scope.mjs";

const $ = selector => document.querySelector(selector);
const message = $("#auth-message");
const emailForm = $("#email-signin-form");
const googleButton = $("#google-signin-button");
const divider = $("#auth-divider");
const signedInPanel = $("#signed-in-panel");
const continueButton = $("#continue-button");
const signOutButton = $("#sign-out-button");
const emailButton = $("#email-signin-button");
const forgotPasswordButton = $("#forgot-password-button");
const modeToggle = $("#auth-mode-toggle");
const requestedNext = new URLSearchParams(location.search).get("next") || "study.html#dashboard";
const allowedNextFiles = new Set(["study.html", "admin.html", "index.html"]);
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

function authErrorText(error) {
  if (error?.code === "auth/operation-not-allowed") return "That sign-in provider is not enabled in Firebase Authentication yet.";
  if (error?.code === "auth/unauthorized-domain") return "Add this website's domain to Firebase Authentication → Settings → Authorized domains.";
  if (["auth/popup-blocked", "auth/operation-not-supported-in-this-environment"].includes(error?.code)) return "The sign-in popup was blocked. Allow popups or retry; the page will use redirect sign-in where supported.";
  if (["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found"].includes(error?.code)) return "Email or password was not accepted.";
  if (error?.code === "auth/email-already-in-use") return "An account could not be created with those details. Try signing in or requesting a password reset instead.";
  if (error?.code === "auth/weak-password" || error?.code === "auth/password-does-not-meet-requirements") return "Choose a stronger password that meets this Firebase project's password policy.";
  if (error?.code === "auth/too-many-requests") return "Too many attempts. Wait a little before trying again.";
  return error?.message || "Sign-in could not be completed. Try again.";
}

async function verifyServerAccess(user) {
  const isCurrent = sessionScope.capture();
  const userLabel = user.email || "your Firebase account";
  if (wantsAdmin) {
    try {
      const response = await authClient.apiRequest("/api/v1/admin/me");
      if (!isCurrent()) return null;
      if (!response.ok) {
        setMessage(response.status === 403
          ? `Signed in as ${userLabel}, but the server did not grant this account admin permission.`
          : "Signed in, but the admin API could not verify permission. Live admin actions remain disabled.", "error");
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
  await authClient.getRedirectResult(authClient.firebaseAuth);
  authClient.onAuthStateChanged(authClient.firebaseAuth, user => {
    sessionScope.invalidate();
    googleButton.disabled = false;
    continueButton.hidden = true;
    continueButton.disabled = true;
    $("#auth-password").value = "";
    $("#auth-password-confirm").value = "";
    if (user) showSignedIn(user);
    else {
      emailForm.hidden = false;
      divider.hidden = false;
      googleButton.hidden = false;
      signedInPanel.hidden = true;
      $("#signed-in-email").textContent = "";
      $("#auth-name").value = "";
      setMessage("Sign in with Google or email, or create a student account.");
    }
  }, error => setMessage(authErrorText(error), "error"));
} catch (error) {
  emailForm.hidden = true;
  divider.hidden = true;
  googleButton.hidden = true;
  setMessage("Firebase client configuration is missing or could not load. Create firebase/firebase-config.local.mjs from the example, then reload.", "error");
  console.warn("Firebase Auth setup unavailable:", error.message);
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
  } catch (error) { setMessage(authErrorText(error), "error"); }
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
  catch (error) { setMessage(authErrorText(error), "error"); googleButton.disabled = false; }
});

continueButton.addEventListener("click", () => { if (!continueButton.disabled) location.assign(continueUrl.href); });
signOutButton.addEventListener("click", async () => {
  if (!authClient) return;
  try { await authClient.signOut(authClient.firebaseAuth); }
  catch (error) { setMessage(authErrorText(error), "error"); }
});
