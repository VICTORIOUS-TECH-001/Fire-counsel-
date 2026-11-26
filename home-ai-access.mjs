// Promotional links only. The destination's existing Google/offline UI gate
// and independent server token/Premium checks remain the access boundaries.
export const AI_DESTINATION = "./ai.html";
export const AI_SIGNIN = "./auth.html?next=ai.html";

export function resolveAIEntry(client, { signal } = {}) {
  return new Promise((resolve, reject) => {
    let unsubscribe, settled = false, cleanupPending = false, revision = 0;
    function finish(destination, error) {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", cancel);
      if (unsubscribe) unsubscribe(); else cleanupPending = true;
      if (error) reject(error); else resolve(destination);
    }
    const cancel = () => finish(null, new DOMException("AI entry check cancelled.", "AbortError"));
    if (signal?.aborted) { cancel(); return; }
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      // Wait for persistence restoration. A cached currentUser/providerData or
      // a local marker never proves how the current session authenticated.
      unsubscribe = client.onIdTokenChanged(client.firebaseAuth, user => {
        const current = ++revision;
        if (!user) { finish(AI_SIGNIN); return; }
        Promise.resolve().then(() => client.hasGoogleSession(user)).then(google => {
          finish(google && current === revision && client.firebaseAuth.currentUser === user ? AI_DESTINATION : AI_SIGNIN);
        }, error => finish(null, error));
      }, error => finish(null, error));
      // Firebase is asynchronous; supporting a synchronous notification also
      // keeps cancellation/cleanup correct with other implementations.
      if (cleanupPending) unsubscribe?.();
    } catch (error) { finish(null, error); }
  });
}

function boot(section) {
  const status = section.querySelector("#home-ai-entry-status");
  let pending = null;
  section.addEventListener("click", async event => {
    const link = event.target.closest("a[data-ai-entry]");
    // Modified/new-tab links keep native navigation to the already gated page.
    if (!link || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (pending) return;
    const controller = new AbortController();
    pending = controller;
    section.setAttribute("aria-busy", "true");
    status.textContent = "Checking Google sign-in…";
    let destination = AI_DESTINATION;
    // Bound a stalled SDK/network read, not a delay before navigation. On any
    // unavailable check, the unchanged app gate handles its own offline policy.
    let abortCheck;
    const cancelled = new Promise((_resolve, reject) => {
      abortCheck = () => reject(new DOMException("AI entry check cancelled.", "AbortError"));
      controller.signal.addEventListener("abort", abortCheck, { once: true });
    });
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      if (navigator.onLine !== false) {
        destination = await Promise.race([
          import("./firebase/auth-client.mjs").then(client => resolveAIEntry(client, { signal: controller.signal })),
          cancelled
        ]);
      }
    } catch { /* Never unlock here; the destination checks Google/offline state. */ }
    finally { clearTimeout(timeout); controller.signal.removeEventListener("abort", abortCheck); }
    if (pending !== controller) return; // pagehide cancelled a stale navigation
    pending = null;
    section.removeAttribute("aria-busy");
    status.textContent = destination === AI_SIGNIN ? "Sign in with Google to open Fire Counsel AI." : "Opening Fire Counsel AI…";
    location.assign(destination);
  });
  window.addEventListener("pagehide", () => { pending?.abort(); pending = null; });
  window.addEventListener("pageshow", () => { section.removeAttribute("aria-busy"); status.textContent = ""; });
}

if (typeof document !== "undefined") {
  const section = document.querySelector("#home-ai");
  if (section) boot(section);
}
