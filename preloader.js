// FIRE COUNSEL page preloader. Fills the bar while the page loads, then fades
// the flame away. The first page of a visit shows it a little longer (about a
// second) so it does not just flash; later pages only briefly. It never
// blocks the page: it is removed when the page has loaded, or after a few
// seconds at the most.
(() => {
  "use strict";
  const el = document.getElementById("fc-preloader");
  if (!el) return;
  const started = performance.now();
  let seen = false;
  try {
    seen = sessionStorage.getItem("fc-preloader-seen") === "1";
    sessionStorage.setItem("fc-preloader-seen", "1");
  } catch { /* private mode: treat as the first page */ }
  const minimum = seen ? 300 : 1100;
  let progress = 0.12;
  let done = false;
  const show = (value) => el.style.setProperty("--fc-pre-p", String(value));
  show(progress);
  const tick = setInterval(() => { progress += (0.9 - progress) * 0.12; show(progress); }, 140);
  const status = el.querySelector(".fc-pre-status");
  function finish() {
    if (done) return;
    done = true;
    clearInterval(tick);
    show(1);
    if (status) status.textContent = "Ready";
    const wait = Math.max(0, minimum - (performance.now() - started));
    setTimeout(() => {
      el.classList.add("fc-pre-done");
      el.setAttribute("aria-hidden", "true");
      setTimeout(() => el.remove(), 650);
    }, wait);
  }
  if (document.readyState === "complete") finish();
  else window.addEventListener("load", finish, { once: true });
  document.addEventListener("DOMContentLoaded", () => { progress = Math.max(progress, 0.6); show(progress); setTimeout(finish, 3500); }, { once: true });
  setTimeout(finish, 8000);
})();
