// Shared sign-in screen for the study workspace and AI studio. This is a UI
// gate, not the security boundary: API tokens and direct Firebase writes are
// independently checked on the server. A browser that signed in with Google
// before may still open its local study tools when Firebase cannot be reached.
export const AUTH_GATE_SESSION_KEY = "fire-counsel-auth-gate-v2";

/** A known non-Google session never unlocks, even with a past offline marker. */
export function resolveGateAccess({ user, googleSession = false, authReady, hadSession }) {
  if (user) return googleSession ? "unlocked" : "locked";
  if (authReady) return "locked";
  return hadSession ? "offline-unlocked" : "locked";
}

const MESSAGES = {
  locked: "This page is private. Sign in with your FIRE COUNSEL Google account to open it — there is no preview without an account.",
  offlineLocked: "Sign-in is unavailable and this browser has not unlocked the app with Google before. Connect and sign in once; after that your local tools work offline.",
  offlineUnlocked: "Offline mode — your local study tools are available. Sign-in-only features wait for the connection."
};

function boot() {
  const body = document.body;
  const gate = document.querySelector("#auth-gate");
  const message = document.querySelector("#auth-gate-message");
  const status = document.querySelector("#auth-gate-status");
  const signin = document.querySelector("#auth-gate-signin");
  if (!gate || !message || !status || !signin) return;

  // Static hosts may canonicalize /ai.html to /ai (and /study.html to /study).
  const file = location.pathname.split("/").filter(Boolean).at(-1);
  const page = file === "ai" || file === "ai.html" ? "ai.html" : "study.html";
  signin.href = `./auth.html?next=${encodeURIComponent(page)}`;
  let revision = 0;

  function apply(state) {
    body.dataset.authGate = state === "offline-unlocked" ? "unlocked" : state;
    if (state === "locked") {
      message.textContent = navigator.onLine === false ? MESSAGES.offlineLocked : MESSAGES.locked;
    } else if (state === "offline-unlocked") {
      const detail = document.getElementById("connection-detail");
      if (detail) detail.textContent = MESSAGES.offlineUnlocked;
    }
    status.textContent = state === "pending" ? "Checking Google sign-in…" : "";
  }

  function remember(user) {
    try { localStorage.setItem(AUTH_GATE_SESSION_KEY, user.uid); } catch { /* private mode: lock again next visit */ }
  }
  function forget() {
    try { localStorage.removeItem(AUTH_GATE_SESSION_KEY); } catch { /* ignore */ }
  }
  function hadSession(user = null) {
    try {
      const uid = localStorage.getItem(AUTH_GATE_SESSION_KEY);
      return Boolean(uid && (!user || uid === user.uid));
    } catch { return false; }
  }
  function unavailable(user = null) {
    apply(resolveGateAccess({ user: null, authReady: false, hadSession: hadSession(user) }));
  }

  (async () => {
    try {
      const authClient = await import("./firebase/auth-client.mjs");
      authClient.onIdTokenChanged(authClient.firebaseAuth, async user => {
        const current = ++revision;
        if (!user) { forget(); apply("locked"); return; }
        apply("pending");
        try {
          const googleSession = await authClient.hasGoogleSession(user);
          if (current !== revision) return; // A late token cannot undo sign-out.
          if (googleSession) remember(user); else forget();
          apply(resolveGateAccess({ user, googleSession, authReady: true, hadSession: false }));
        } catch {
          if (current === revision) unavailable(user);
        }
      }, () => { revision++; unavailable(); });
    } catch { unavailable(); }
  })();
}

if (typeof document !== "undefined" && document.querySelector("#auth-gate")) boot();
