// Plain-language mapping of Firebase Auth error codes, shared by the sign-in
// page and the profile security forms. Setup problems always name the exact
// console location to fix; credential failures stay generic and never reveal
// which part failed.
export function authErrorText(error) {
  if (error?.code === "auth/operation-not-allowed") return "That sign-in provider is not enabled in Firebase Authentication yet. For Google, turn it on under Authentication → Sign-in method and choose a support email.";
  if (error?.code === "auth/unauthorized-domain") return "Add this website's exact hostname (no https://, port, or path) under Firebase Authentication → Settings → Authorized domains.";
  if (error?.code === "auth/app-not-authorized" || /referer.*not.*allow/i.test(error?.message || "")) return "This site is blocked by the Firebase Web API key restrictions. In Google Cloud → APIs & Services → Credentials, allow this URL on the browser key and allow the Identity Toolkit API.";
  if (error?.code === "auth/invalid-api-key" || /api-key-not-valid/i.test(`${error?.code || ""} ${error?.message || ""}`)) return "Firebase rejected the Web API key. Paste the apiKey from Project settings → Your apps → Config into firebase/firebase-config.mjs.";
  if (error?.code === "auth/account-exists-with-different-credential") return "That email already has a FIRE COUNSEL account with a different sign-in method. Sign in the original way, or use the same Google account that created it. Automatic linking is not enabled.";
  if (error?.code === "auth/multi-factor-auth-required") return "This account needs the 6-digit code from Google Authenticator.";
  if (["auth/invalid-verification-code", "auth/code-expired"].includes(error?.code)) return "That authenticator code was not accepted. Wait for the next code and try again.";
  if (["auth/popup-blocked", "auth/operation-not-supported-in-this-environment"].includes(error?.code)) return "The sign-in popup was blocked. Allow popups for this site, or retry. A framed preview uses Google redirect instead.";
  if (["auth/popup-closed-by-user", "auth/cancelled-popup-request"].includes(error?.code)) return "Google sign-in was closed before it finished. If Google said the app is in testing, add this Google account as a test user on the OAuth consent screen.";
  if (["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found"].includes(error?.code)) return "Email or password was not accepted.";
  if (error?.code === "auth/user-disabled") return "This Firebase account has been disabled. Contact the administrator; local study data in this browser is unaffected.";
  if (["auth/invalid-email", "auth/missing-email"].includes(error?.code)) return "Enter a valid email address.";
  if (error?.code === "auth/email-already-in-use") return "An account could not be created with those details. Try signing in or requesting a password reset instead.";
  if (error?.code === "auth/weak-password" || error?.code === "auth/password-does-not-meet-requirements") return "Choose a stronger password that meets this Firebase project's password policy.";
  if (error?.code === "auth/requires-recent-login") return "For your security, sign out and sign in again before changing account details.";
  if (error?.code === "auth/too-many-requests") return "Too many attempts. Wait a little before trying again.";
  if (error?.code === "auth/network-request-failed") return "Firebase could not be reached. Check the connection and try again.";
  return error?.message || "Sign-in could not be completed. Try again.";
}
