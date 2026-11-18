// App sign-in gate. Locked pages (the study workspace, the AI studio) never
// render for a visitor who is not signed in: the page stays hidden behind a
// lock screen until Firebase Auth confirms an account. A student who
// previously signed in on this browser keeps access to the local, offline
// study tools when the network is down; a fresh browser must sign in online at
// least once. Server data stays protected regardless — every API route
// requires a verified Firebase token, so skipping this screen never exposes
// anyone else's content.
export const AUTH_GATE_SESSION_KEY = "fire-counsel-auth-gate-v1";

/**
 * Pure decision, kept separate so tests can drive it without a DOM.
 * @param {{user: object|null, authReady: boolean, hadSession: boolean}} state
 *   authReady is false when Firebase could not be loaded/verified (offline or
 *   misconfigured); hadSession means this browser signed in before.
 * @returns {"unlocked"|"locked"|"offline-unlocked"}
 */
export function resolveGateAccess({ user, authReady, hadSession }) {
  if (user) return "unlocked";
  if (authReady) return "locked";
  return hadSession ? "offline-unlocked" : "locked";
}

const MESSAGES = {
  locked: "This page is private. Sign in with your FIRE COUNSEL Google account to open it — there is no preview without an account.",
  offlineLocked: "You are offline and this browser has not unlocked the app before. Connect once and sign in; after that your local tools work offline.",
  offlineUnlocked: "Offline mode — your local study tools are available. Sign-in-only features wait for the connection."
};

function boot() {
  const body = document.body;
  const gate = document.querySelector("#auth-gate");
  const message = document.querySelector("#auth-gate-message");
  const status = document.querySelector("#auth-gate-status");
  const signin = document.querySelector("#auth-gate-signin");
  if (!gate || !message || !status || !signin) return;

  // Send the student back to this page after signing in.
  const page = location.pathname.split("/").filter(Boolean).at(-1) || "study.html";
  signin.href = `./auth.html?next=${encodeURIComponent(page)}`;

  function apply(state) {
    body.dataset.authGate = state === "offline-unlocked" ? "unlocked" : state;
    if (state === "locked") {
      message.textContent = navigator.onLine === false ? MESSAGES.offlineLocked : MESSAGES.locked;
      status.textContent = "";
    } else if (state === "offline-unlocked") {
      status.textContent = "";
      const detail = document.getElementById("connection-detail");
      if (detail) detail.textContent = MESSAGES.offlineUnlocked;
    }
  }

  function remember(user) {
    try { localStorage.setItem(AUTH_GATE_SESSION_KEY, user.uid || "1"); } catch { /* private mode: lock again next visit */ }
  }
  function forget() {
    try { localStorage.removeItem(AUTH_GATE_SESSION_KEY); } catch { /* ignore */ }
  }
  function hadSession() {
    try { return Boolean(localStorage.getItem(AUTH_GATE_SESSION_KEY)); } catch { return false; }
  }

  (async () => {
    try {
      const authClient = await import("./firebase/auth-client.mjs");
      authClient.onAuthStateChanged(authClient.firebaseAuth, (user) => {
        if (user) { remember(user); apply("unlocked"); }
        else { forget(); apply("locked"); }
      }, () => {
        // Session could not be verified (usually offline).
        apply(resolveGateAccess({ user: null, authReady: false, hadSession: hadSession() }));
      });
    } catch {
      apply(resolveGateAccess({ user: null, authReady: false, hadSession: hadSession() }));
    }
  })();
}

if (typeof document !== "undefined" && document.querySelector("#auth-gate")) boot();
