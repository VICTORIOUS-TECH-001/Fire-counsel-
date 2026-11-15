// Browser-only Firebase initializer for the static PWA.
// The Firebase SDK is loaded from Google's versioned CDN because this repo has
// no frontend build step. Importing this module initializes the local client app.
import { getApps, initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { firebaseConfig } from "./firebase-config.local.mjs";

const defaultApp = getApps().find((app) => app.name === "[DEFAULT]");
export const firebaseApp = defaultApp || initializeApp(firebaseConfig);

// Analytics may be unavailable (for example, in a browser that blocks it).
// Load it only after an explicit consent/privacy review and caller request.
export async function createFirebaseAnalytics() {
  const analyticsSdk = await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-analytics.js");
  if (!(await analyticsSdk.isSupported())) return null;
  return analyticsSdk.getAnalytics(firebaseApp);
}
