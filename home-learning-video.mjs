import { safeCaseVideoUrl } from "./homepage-media.mjs";

// Fixed public background for the learning section only. The case-library
// clip and all published content keep their existing configuration.
export const LEARNING_VIDEO_URL = "https://pub-8f421f9b11d64c18bb8a952d99a77e62.r2.dev/home%20page%20vedio%20%20(1).mp4";
const mounted = new WeakMap();

export function mountLearningVideo(section, { host = globalThis.window, doc = globalThis.document } = {}) {
  mounted.get(section)?.destroy();
  const video = section?.querySelector(".learning-background-video");
  if (!video || typeof video.play !== "function" || !host || !doc) return null;
  const source = safeCaseVideoUrl(LEARNING_VIDEO_URL), motion = host.matchMedia?.("(prefers-reduced-motion: reduce)");
  const connection = host.navigator?.connection, removers = [];
  let disposed = false, pageActive = true, inView = !host.IntersectionObserver;
  let attached = false, hasPlayed = false, failed = false, blocked = false, userPaused = false;
  let pending = false, wantsPlayback = false, revision = 0;
  video.muted = true; video.defaultMuted = true; video.loop = true; video.playsInline = true;
  video.controls = false; video.inert = true; video.tabIndex = -1; video.preload = "none";
  video.disablePictureInPicture = true; video.disableRemotePlayback = true;
  video.setAttribute("aria-hidden", "true");

  function visible() {
    if (disposed || !pageActive || doc.hidden || !inView) return false;
    // Scroll/media-query notifications can arrive before the observer updates.
    // Never attach a new background on a stale offscreen intersection.
    const rect = section.getBoundingClientRect?.();
    return !rect || (rect.bottom > 0 && rect.top < host.innerHeight);
  }
  const permitted = () => visible() && !failed && !blocked && !motion?.matches && !connection?.saveData;
  function state(value, show = hasPlayed && pageActive && !doc.hidden && !failed && !blocked && !motion?.matches && !connection?.saveData) {
    section.dataset.videoState = value;
    section.dataset.videoVisible = String(Boolean(show));
  }
  function pause() {
    revision++; pending = false; wantsPlayback = false;
    video.pause();
  }
  function rejectAutoplay() {
    blocked = true; video.autoplay = false; pause(); state("blocked", false);
  }
  function sync() {
    if (disposed) return;
    if (!source || failed || blocked) { pause(); state(failed ? "error" : blocked ? "blocked" : "disabled", false); return; }
    video.autoplay = !motion?.matches && !connection?.saveData && !userPaused;
    if (!permitted()) {
      pause(); state(motion?.matches ? "reduced" : connection?.saveData ? "data-saver" : "paused"); return;
    }
    if (!attached) { attached = true; video.src = source; video.load(); state("loading", false); }
    if (userPaused) { state("paused"); return; }
    if (pending || !video.paused) return;
    const current = ++revision;
    pending = true; wantsPlayback = true;
    try {
      Promise.resolve(video.play()).then(() => {
        if (disposed) { video.pause(); return; }
        if (current !== revision) { if (!permitted()) pause(); return; }
        pending = false;
        if (!permitted()) { pause(); state("paused"); }
      }, () => { if (!disposed && current === revision) rejectAutoplay(); });
    } catch { rejectAutoplay(); }
  }
  function listen(target, type, callback, options) {
    target?.addEventListener?.(type, callback, options);
    removers.push(() => target?.removeEventListener?.(type, callback, options));
  }
  // No invisible keyboard stop or native play surface, including on media
  // implementations which still allow programmatic focus on inert elements.
  listen(video, "focus", () => video.blur());
  listen(video, "playing", () => {
    if (!permitted()) { pause(); state("paused"); return; }
    hasPlayed = true; userPaused = false; wantsPlayback = true; state("playing");
  });
  listen(video, "pause", () => {
    if (wantsPlayback && visible() && video.paused) { userPaused = true; wantsPlayback = false; state("paused"); }
  });
  listen(video, "error", () => { failed = true; video.autoplay = false; pause(); state("error", false); });
  listen(doc, "visibilitychange", sync);
  listen(host, "pagehide", () => { pageActive = false; sync(); });
  listen(host, "pageshow", () => { pageActive = true; sync(); });
  if (motion?.addEventListener) listen(motion, "change", sync);
  else if (motion?.addListener) { motion.addListener(sync); removers.push(() => motion.removeListener(sync)); }
  listen(connection, "change", sync);
  const observer = host.IntersectionObserver ? new host.IntersectionObserver(entries => {
    inView = entries.some(entry => entry.isIntersecting); sync();
  }, { threshold: .01 }) : null;
  observer?.observe(section);
  if (!observer) { listen(host, "scroll", sync, { passive: true }); listen(host, "resize", sync); }
  const control = { destroy() {
    if (disposed) return;
    disposed = true; video.autoplay = false; pause(); observer?.disconnect(); removers.forEach(remove => remove());
    video.removeAttribute("src"); video.load(); state("stopped", false);
    if (mounted.get(section) === control) mounted.delete(section);
  } };
  mounted.set(section, control);
  state("idle", false); sync();
  return control;
}

if (typeof document !== "undefined") {
  const section = document.querySelector("#learning");
  if (section) mountLearningVideo(section);
}
