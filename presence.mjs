// Lets the administrator see who is active. While a signed-in page is open
// and visible, it tells the server "still here" about once a minute. Only the
// time and page name are stored; nothing about study work is sent.
const page = document.body?.dataset.presencePage || (location.pathname.includes("admin") ? "admin" : "study");
let timer = null;
let authClient = null;
let user = null;

async function beat() {
  if (!user || document.visibilityState !== "visible") return;
  try {
    await authClient.apiRequest("/api/v1/presence", { method: "POST", body: JSON.stringify({ page }) });
  } catch { /* offline or API not deployed: try again next minute */ }
}

function schedule() {
  clearInterval(timer);
  timer = null;
  if (!user) return;
  beat();
  timer = setInterval(beat, 60_000);
}

try {
  authClient = await import("./firebase/auth-client.mjs");
  authClient.onAuthStateChanged(authClient.firebaseAuth, (nextUser) => {
    user = nextUser;
    schedule();
  });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") beat(); });
} catch { /* sign-in not configured on this copy of the site */ }
