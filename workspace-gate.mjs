// Workspace sign-in gate. The study workspace is never shown to a visitor who
// is not signed in: the shell stays hidden behind a lock screen until Firebase
// Auth confirms an account. A student who previously signed in on this browser
// keeps access to the local, offline study tools when the network is down; a
// fresh browser must sign in online at least once. Server data stays protected
// regardless — every API route requires a verified Firebase token, so skipping
// this screen never exposes anyone else's content.
export const WORKSPACE_SESSION_KEY = "fire-counsel-workspace-session-v1";

/**
 * Pure decision, kept separate so tests can drive it without a DOM.
 * @param {{user: object|null, authReady: boolean, hadSession: boolean}} state
 *   authReady is false when Firebase could not be loaded/verified (offline or
 *   misconfigured); hadSession means this browser signed in before.
 * @returns {"unlocked"|"locked"|"offline-unlocked"}
 */
export function resolveWorkspaceAccess({ user, authReady, hadSession }) {
  if (user) return "unlocked";
  if (authReady) return "locked";
  return hadSession ? "offline-unlocked" : "locked";
}

const MESSAGES = {
  locked: "Your study workspace is private. Sign in with your FIRE COUNSEL account to open it — there is no preview without an account.",
  offlineLocked: "You are offline and this browser has not unlocked the workspace before. Connect once and sign in; after that your local tools work offline.",
  offlineUnlocked: "Offline mode — your local study tools are available. Sign-in-only features wait for the connection."
};

function boot() {
  const body = document.body;
  const gate = document.querySelector("#ws-gate");
  const message = document.querySelector("#ws-gate-message");
  const status = document.querySelector("#ws-gate-status");
  const signin = document.querySelector("#ws-gate-signin");
  if (!gate || !message || !status || !signin) return;

  function apply(state) {
    body.dataset.wsAuth = state === "offline-unlocked" ? "unlocked" : state;
    if (state === "locked") {
      message.textContent = navigator.onLine === false ? MESSAGES.offlineLocked : MESSAGES.locked;
      status.textContent = "";
    } else if (state === "offline-unlocked") {
      status.textContent = "";
      const detail = document.querySelector("#connection-detail");
      if (detail) detail.textContent = MESSAGES.offlineUnlocked;
    }
  }

  function remember(user) {
    try { localStorage.setItem(WORKSPACE_SESSION_KEY, user.uid || "1"); } catch { /* private mode: lock again next visit */ }
  }
  function forget() {
    try { localStorage.removeItem(WORKSPACE_SESSION_KEY); } catch { /* ignore */ }
  }
  function hadSession() {
    try { return Boolean(localStorage.getItem(WORKSPACE_SESSION_KEY)); } catch { return false; }
  }

  (async () => {
    try {
      const authClient = await import("./firebase/auth-client.mjs");
      authClient.onAuthStateChanged(authClient.firebaseAuth, (user) => {
        if (user) { remember(user); apply("unlocked"); }
        else { forget(); apply("locked"); }
      }, () => {
        // Session could not be verified (usually offline).
        apply(resolveWorkspaceAccess({ user: null, authReady: false, hadSession: hadSession() }));
      });
    } catch {
      apply(resolveWorkspaceAccess({ user: null, authReady: false, hadSession: hadSession() }));
    }
  })();
}

if (typeof document !== "undefined" && document.querySelector("#ws-gate")) boot();
