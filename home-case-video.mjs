import { caseVideoUrl } from "./homepage-media.mjs";

const mounted = new WeakMap();

// Native video.loop supplies the repeating playback, not a JS timer. The
// original image/poster remains usable if scripts, network or decoding fail.
export function mountCaseVideo(container, { content, host = globalThis.window, doc = globalThis.document } = {}) {
  mounted.get(container)?.destroy();
  const video = container?.querySelector("video"), image = container?.querySelector("img");
  if (!video || !image || !host || !doc) return null;
  const source = caseVideoUrl(content), motion = host.matchMedia?.("(prefers-reduced-motion: reduce)");
  const connection = host.navigator?.connection, removers = [];
  let disposed = false, activePage = true, inView = !host.IntersectionObserver;
  let attached = false, hasPlayed = false, failed = false, blocked = false, userPaused = false, wantsPlayback = false, pending = false, revision = 0;
  video.muted = true; video.defaultMuted = true;
  video.loop = true; video.playsInline = true; video.controls = false; video.preload = "none";
  video.inert = true; video.disablePictureInPicture = true; video.disableRemotePlayback = true;
  video.poster = image.getAttribute("src");

  const visible = () => !disposed && activePage && inView && !doc.hidden;
  const permitted = () => visible() && !failed && !blocked && !motion?.matches && !connection?.saveData;
  function state(value, show = hasPlayed && !failed && !blocked && !motion?.matches && !connection?.saveData) {
    container.dataset.videoState = value;
    container.dataset.videoVisible = String(Boolean(show));
    // This is decorative motion, not an interactive player, even while playing.
    video.setAttribute("aria-hidden", "true");
    video.tabIndex = -1;
    if (show) image.setAttribute("aria-hidden", "true");
    else image.removeAttribute("aria-hidden");
  }
  function pause() {
    revision++; pending = false; wantsPlayback = false;
    video.pause();
  }
  function sync() {
    if (disposed) return;
    if (!source || failed || blocked) { pause(); state(failed ? "error" : blocked ? "blocked" : "disabled", false); return; }
    video.autoplay = !motion?.matches && !connection?.saveData;
    if (!permitted()) {
      pause();
      state(motion?.matches ? "reduced" : connection?.saveData ? "data-saver" : "paused");
      return;
    }
    if (!attached) {
      attached = true; video.src = source; video.load(); state("loading");
    }
    if (userPaused) { state("paused"); return; }
    if (pending || !video.paused) return;
    const current = ++revision;
    pending = true; wantsPlayback = true;
    // Some mobile/battery policies block autoplay. Keep the photo rather than
    // revealing a native play button or leaving an unhandled rejection.
    try {
      Promise.resolve(video.play()).then(() => {
        if (disposed || current !== revision) return;
        pending = false;
        if (!permitted()) { pause(); state("paused"); }
      }, () => {
        if (disposed || current !== revision) return;
        rejectAutoplay();
      });
    } catch { rejectAutoplay(); }
  }
  function rejectAutoplay() {
    blocked = true; video.autoplay = false; pause(); state("blocked", false);
  }
  function listen(target, type, callback) {
    target?.addEventListener?.(type, callback);
    removers.push(() => target?.removeEventListener?.(type, callback));
  }
  // A few media implementations still accept programmatic focus on an inert
  // video. Never leave keyboard focus on this hidden, non-interactive surface.
  listen(video, "focus", () => video.blur());
  listen(video, "playing", () => {
    if (!permitted()) { pause(); state("paused"); return; }
    hasPlayed = true; userPaused = false; wantsPlayback = true; state("playing");
  });
  listen(video, "pause", () => {
    // Automatic lifecycle pauses must not be mistaken for the user's choice.
    if (wantsPlayback && visible() && video.paused) { userPaused = true; wantsPlayback = false; state("paused"); }
  });
  listen(video, "error", () => { failed = true; pause(); state("error", false); });
  listen(doc, "visibilitychange", sync);
  listen(host, "pagehide", () => { activePage = false; sync(); });
  listen(host, "pageshow", () => { activePage = true; sync(); });
  if (motion?.addEventListener) listen(motion, "change", sync);
  else if (motion?.addListener) { motion.addListener(sync); removers.push(() => motion.removeListener(sync)); }
  listen(connection, "change", sync);
  const observer = host.IntersectionObserver ? new host.IntersectionObserver(entries => {
    inView = entries.some(entry => entry.isIntersecting); sync();
  }, { threshold: .01 }) : null;
  observer?.observe(container);
  const control = { destroy() {
    if (disposed) return;
    disposed = true; pause(); observer?.disconnect(); removers.forEach(remove => remove());
    video.removeAttribute("src"); video.load(); state("stopped", false);
    if (mounted.get(container) === control) mounted.delete(container);
  } };
  mounted.set(container, control);
  state("idle", false); sync();
  return control;
}
