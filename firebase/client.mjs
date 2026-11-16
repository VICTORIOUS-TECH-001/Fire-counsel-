// Browser-only Firebase initializer for the static PWA.
// The Firebase SDK is loaded from Google's versioned CDN because this repo has
// no frontend build step. Importing this module initializes the local client app.
import { getApps, initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { firebaseConfig } from "./firebase-config.mjs";

export function firebaseSetupError(config = firebaseConfig) {
  if (!config?.apiKey || String(config.apiKey).startsWith("REPLACE_")) {
    return "Firebase Web API key is still the placeholder in firebase/firebase-config.mjs. Open Firebase Console → Project settings → Your apps → Config, copy apiKey into that file, and publish it. Do not paste a service-account key.";
  }
  for (const field of ["authDomain", "projectId", "appId"]) {
    if (!config[field]) return `Firebase Web config is missing ${field}.`;
  }
  return "";
}

const setupError = firebaseSetupError();
const defaultApp = getApps().find((app) => app.name === "[DEFAULT]");
export const firebaseApp = setupError
  ? null
  : (defaultApp || initializeApp(firebaseConfig));

// Analytics may be unavailable (for example, in a browser that blocks it).
// Load it only after an explicit consent/privacy review and caller request.
export async function createFirebaseAnalytics() {
  if (!firebaseApp) return null;
  const analyticsSdk = await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-analytics.js");
  if (!(await analyticsSdk.isSupported())) return null;
  return analyticsSdk.getAnalytics(firebaseApp);
}
