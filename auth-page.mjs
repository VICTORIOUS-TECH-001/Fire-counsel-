const $ = (selector) => document.querySelector(selector);
const message = $("#auth-message");
const emailForm = $("#email-signin-form");
const googleButton = $("#google-signin-button");
const divider = $("#auth-divider");
const signedInPanel = $("#signed-in-panel");
const continueButton = $("#continue-button");
const signOutButton = $("#sign-out-button");
const emailButton = $("#email-signin-button");
const forgotPasswordButton = $("#forgot-password-button");
const requestedNext = new URLSearchParams(location.search).get("next") || "study.html#dashboard";
const allowedNextFiles = new Set(["study.html", "admin.html", "index.html"]);
let authClient;

function safeNextUrl(value) {
  try {
    const url = new URL(value, location.href);
    const file = url.pathname.split("/").filter(Boolean).at(-1) || "index.html";
    if (url.origin !== location.origin || !allowedNextFiles.has(file)) return new URL("./study.html#dashboard", location.href);
    return url;
  } catch {
    return new URL("./study.html#dashboard", location.href);
  }
}

const nextUrl = safeNextUrl(requestedNext);
const wantsAdmin = nextUrl.pathname.endsWith("/admin.html");

function setMessage(text, kind = "") {
  message.textContent = text;
  message.dataset.kind = kind;
}

function authErrorText(error) {
  if (error?.code === "auth/operation-not-allowed") return "That sign-in provider is not enabled in Firebase Authentication yet.";
  if (error?.code === "auth/unauthorized-domain") return "Add this website's domain to Firebase Authentication → Settings → Authorized domains.";
  if (["auth/popup-blocked", "auth/operation-not-supported-in-this-environment"].includes(error?.code)) return "The sign-in popup was blocked. Allow popups or retry; the page will use redirect sign-in where supported.";
  if (error?.code === "auth/invalid-credential" || error?.code === "auth/wrong-password" || error?.code === "auth/user-not-found") return "Email or password was not accepted.";
  return error?.message || "Sign-in could not be completed. Try again.";
}

async function verifyServerAccess(user) {
  const userLabel = user.email || "your Firebase account";
  if (wantsAdmin) {
    try {
      const response = await authClient.apiRequest("/api/v1/admin/me");
      if (!response.ok) {
        setMessage(response.status === 403
          ? `Signed in as ${userLabel}, but the server did not grant this account admin permission.`
          : "Signed in, but the admin API could not verify permission. Live admin actions remain disabled.", "error");
        return false;
      }
      setMessage(`Server verified administrator access for ${userLabel}.`, "ok");
      return true;
    } catch {
      setMessage("Firebase sign-in succeeded, but the API is not connected on this origin. Admin access is not verified; only the local preview is available.", "error");
      return false;
    }
  }

  try {
    const response = await authClient.apiRequest("/api/v1/me");
    if (response.ok) {
      const data = await response.json();
      setMessage(`Signed in as ${userLabel}. Server role: ${data.user?.role || "student"}.`, "ok");
    } else {
      setMessage(`Firebase sign-in succeeded for ${userLabel}; the backend is not configured yet. Your local study space is still available.`, "");
    }
  } catch {
    setMessage(`Firebase sign-in succeeded for ${userLabel}; the backend is not connected on this origin. Your local study space is still available.`, "");
  }
  return true;
}

function showSignedIn(user) {
  emailForm.hidden = true;
  divider.hidden = true;
  googleButton.hidden = true;
  signedInPanel.hidden = false;
  $("#signed-in-email").textContent = user.email || "Signed-in Firebase account";
  continueButton.hidden = true;
  continueButton.disabled = true;
  verifyServerAccess(user).then((allowed) => {
    if (!allowed) return;
    continueButton.hidden = false;
    continueButton.disabled = false;
    continueButton.textContent = wantsAdmin ? "Open admin preview" : "Continue to study";
  }).catch(() => {});
}

try {
  authClient = await import("./firebase/auth-client.mjs");
  await authClient.getRedirectResult(authClient.firebaseAuth);
  emailForm.hidden = false;
  divider.hidden = false;
  googleButton.hidden = false;
  setMessage("Use your Firebase email/password account or continue with Google.");

  authClient.onAuthStateChanged(authClient.firebaseAuth, (user) => {
    if (user) {
      showSignedIn(user);
    } else {
      emailForm.hidden = false;
      divider.hidden = false;
      googleButton.hidden = false;
      signedInPanel.hidden = true;
      setMessage("Use your Firebase email/password account or continue with Google.");
    }
  }, (error) => setMessage(authErrorText(error), "error"));
} catch (error) {
  emailForm.hidden = true;
  divider.hidden = true;
  googleButton.hidden = true;
  setMessage("Firebase client configuration is missing or could not load. Create firebase/firebase-config.local.mjs from the example, then reload.", "error");
  console.warn("Firebase Auth setup unavailable:", error.message);
}

emailForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!authClient) return;
  emailButton.disabled = true;
  setMessage("Signing in…");
  try {
    await authClient.signInWithEmail($("#auth-email").value, $("#auth-password").value);
  } catch (error) {
    setMessage(authErrorText(error), "error");
  } finally {
    emailButton.disabled = false;
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
  forgotPasswordButton.disabled = true;
  setMessage("Requesting a password reset email…");
  try {
    await authClient.requestPasswordReset(email);
    setMessage("If a Firebase account exists for that email, Firebase will send a password-reset link.", "ok");
  } catch (error) {
    if (error?.code === "auth/unauthorized-domain") setMessage("Add this website's domain to Firebase Authentication → Settings → Authorized domains.", "error");
    else setMessage("The password-reset request could not be completed. Check Firebase Auth setup and try again.", "error");
  } finally {
    forgotPasswordButton.disabled = false;
  }
});

googleButton.addEventListener("click", async () => {
  if (!authClient) return;
  googleButton.disabled = true;
  setMessage("Opening Google sign-in…");
  try {
    await authClient.signInWithGoogle();
  } catch (error) {
    setMessage(authErrorText(error), "error");
    googleButton.disabled = false;
  }
});

continueButton.addEventListener("click", () => {
  if (!continueButton.disabled) location.assign(nextUrl.href);
});

signOutButton.addEventListener("click", async () => {
  if (!authClient) return;
  try {
    await authClient.signOut(authClient.firebaseAuth);
    signedInPanel.hidden = true;
    emailForm.hidden = false;
    divider.hidden = false;
    googleButton.hidden = false;
    setMessage("You have signed out.");
  } catch (error) {
    setMessage(authErrorText(error), "error");
  }
});
