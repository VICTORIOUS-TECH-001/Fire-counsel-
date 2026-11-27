import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { LEARNING_VIDEO_URL, mountLearningVideo } from "../../home-learning-video.mjs";
import { DEFAULT_CASE_VIDEO_URL, safeCaseVideoUrl } from "../../homepage-media.mjs";

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

function harness({ reduced = false, saveData = false, rejection = false, throwing = false, deferred = false, observer = true } = {}) {
  const host = new EventTarget(), doc = new EventTarget(), motion = new EventTarget(), connection = new EventTarget();
  motion.matches = reduced; connection.saveData = saveData; doc.hidden = false;
  const attrs = new Map(), h = {};
  const video = Object.assign(new EventTarget(), { paused: true, plays: 0, loads: 0, blurs: 0,
    blur() { this.blurs++; }, setAttribute(key, value) { attrs.set(key, value); },
    removeAttribute(key) { attrs.delete(key); if (key === "src") delete this.src; },
    load() { this.loads++; },
    pause() { if (this.paused) return; this.paused = true; this.dispatchEvent(new Event("pause")); },
    play() {
      this.plays++;
      if (throwing) throw new Error("Autoplay blocked");
      if (rejection) return Promise.reject(new Error("Autoplay blocked"));
      const start = () => { this.paused = false; this.dispatchEvent(new Event("playing")); };
      if (deferred) return new Promise(resolve => { h.finishPlay = () => { start(); resolve(); }; });
      start(); return Promise.resolve();
    }
  });
  const bounds = { top: 20, bottom: 700 };
  const section = { dataset: {}, querySelector: () => video, getBoundingClientRect: () => bounds };
  Object.assign(host, { innerHeight: 900, navigator: { connection }, matchMedia: () => motion });
  if (observer) host.IntersectionObserver = class {
    constructor(fn) { this.fn = fn; host.observer = this; }
    observe(target) { this.target = target; }
    disconnect() { this.disconnected = true; }
    emit(value) { this.fn([{ isIntersecting: value }]); }
  };
  return Object.assign(h, { host, doc, motion, connection, video, section, attrs, bounds,
    mount: () => mountLearningVideo(section, { host, doc }) });
}

test("the learning background uses exactly the supplied MP4 without replacing the existing case clip or publishing content", () => {
  assert.equal(LEARNING_VIDEO_URL, "https://pub-8f421f9b11d64c18bb8a952d99a77e62.r2.dev/home%20page%20vedio%20%20(1).mp4");
  assert.equal(safeCaseVideoUrl(LEARNING_VIDEO_URL), LEARNING_VIDEO_URL);
  assert.notEqual(DEFAULT_CASE_VIDEO_URL, LEARNING_VIDEO_URL);
  const source = read("home-learning-video.mjs");
  assert.doesNotMatch(source, /fetch\(|localStorage|sessionStorage|indexedDB|firebase|apiRequest|requestAnimationFrame|setInterval/);
});

test("only an actually visible learning section attaches its source, with silent inline native infinite looping", async () => {
  const h = harness(), control = h.mount();
  assert.equal(h.video.src, undefined); assert.equal(h.video.plays, 0);
  assert.equal(h.section.dataset.videoVisible, "false");
  assert.equal(h.host.observer.target, h.section);
  // A stale intersection notification must not fetch an offscreen video.
  h.bounds.top = 950; h.bounds.bottom = 1700; h.host.observer.emit(true);
  assert.equal(h.video.src, undefined);
  h.bounds.top = 20; h.bounds.bottom = 700; h.host.observer.emit(true); await Promise.resolve();
  assert.equal(h.video.src, LEARNING_VIDEO_URL); assert.equal(h.video.loads, 1); assert.equal(h.video.plays, 1);
  assert.equal(h.video.muted, true); assert.equal(h.video.defaultMuted, true); assert.equal(h.video.playsInline, true); assert.equal(h.video.loop, true);
  assert.equal(h.video.preload, "none"); assert.equal(h.section.dataset.videoState, "playing");
  assert.equal(h.section.dataset.videoVisible, "true");
  h.host.observer.emit(true); assert.equal(h.video.plays, 1); control.destroy();
});

test("the background has no media controls, focus, picture-in-picture or remote playback, including after playback starts", async () => {
  const h = harness(), control = h.mount(); h.host.observer.emit(true); await Promise.resolve();
  assert.equal(h.video.controls, false); assert.equal(h.video.inert, true); assert.equal(h.video.tabIndex, -1);
  assert.equal(h.video.disablePictureInPicture, true); assert.equal(h.video.disableRemotePlayback, true);
  assert.equal(h.attrs.get("aria-hidden"), "true");
  h.video.dispatchEvent(new Event("focus")); assert.equal(h.video.blurs, 1);
  control.destroy();
});

test("offscreen, hidden and page-cache states pause playback and resume without duplicate loads", async () => {
  const h = harness(), control = h.mount(); h.host.observer.emit(true); await Promise.resolve();
  h.host.observer.emit(false); assert.equal(h.video.paused, true);
  h.host.observer.emit(true); await Promise.resolve(); assert.equal(h.video.paused, false);
  h.doc.hidden = true; h.doc.dispatchEvent(new Event("visibilitychange")); assert.equal(h.video.paused, true);
  h.doc.hidden = false; h.doc.dispatchEvent(new Event("visibilitychange")); await Promise.resolve(); assert.equal(h.video.paused, false);
  h.host.dispatchEvent(new Event("pagehide")); assert.equal(h.video.paused, true);
  h.host.dispatchEvent(new Event("pageshow")); await Promise.resolve(); assert.equal(h.video.paused, false);
  assert.equal(h.video.loads, 1); control.destroy();
});

test("reduced motion and live data-saving preferences retain the plain site backdrop without fetching or showing a play button", async () => {
  for (const setting of ["reduced", "saveData"]) {
    const h = harness({ [setting]: true }), control = h.mount(); h.host.observer.emit(true);
    assert.equal(h.video.src, undefined); assert.equal(h.section.dataset.videoVisible, "false");
    assert.equal(h.section.dataset.videoState, setting === "reduced" ? "reduced" : "data-saver");
    if (setting === "reduced") { h.motion.matches = false; h.motion.dispatchEvent(new Event("change")); }
    else { h.connection.saveData = false; h.connection.dispatchEvent(new Event("change")); }
    await Promise.resolve(); assert.equal(h.video.paused, false);
    h.motion.matches = true; h.motion.dispatchEvent(new Event("change"));
    assert.equal(h.video.paused, true); assert.equal(h.section.dataset.videoVisible, "false");
    assert.equal(h.video.controls, false); control.destroy();
  }
});

test("blocked autoplay, thrown play calls and media errors remain hidden and are never automatically retried", async () => {
  for (const flags of [{ rejection: true }, { throwing: true }, {}]) {
    const h = harness(flags), control = h.mount(); h.host.observer.emit(true); await Promise.resolve();
    if (!flags.rejection && !flags.throwing) h.video.dispatchEvent(new Event("error"));
    assert.equal(h.section.dataset.videoState, flags.rejection || flags.throwing ? "blocked" : "error");
    assert.equal(h.section.dataset.videoVisible, "false"); assert.equal(h.video.paused, true);
    h.host.observer.emit(false); h.host.observer.emit(true);
    assert.equal(h.video.plays, 1); assert.equal(h.video.controls, false); control.destroy();
  }
});

test("an external pause is respected; remount and destruction release observers, source and late play promises", async () => {
  const h = harness(), first = h.mount(); h.host.observer.emit(true); await Promise.resolve();
  h.video.pause(); h.host.observer.emit(false); h.host.observer.emit(true);
  assert.equal(h.video.paused, true);
  const observer = h.host.observer, second = h.mount(); assert.equal(observer.disconnected, true);
  first.destroy(); h.host.observer.emit(true); await Promise.resolve();
  assert.equal(h.video.paused, false); second.destroy();
  const plays = h.video.plays;
  h.host.observer.emit(true); h.motion.dispatchEvent(new Event("change")); h.doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(h.video.src, undefined); assert.equal(h.video.plays, plays); assert.equal(h.section.dataset.videoVisible, "false");
  const late = harness({ deferred: true }), pending = late.mount(); late.host.observer.emit(true); pending.destroy();
  late.finishPlay(); await Promise.resolve(); assert.equal(late.video.paused, true);
});

test("missing observer support uses native scroll visibility, and missing elements degrade safely", async () => {
  const h = harness({ observer: false }); h.bounds.top = 950; h.bounds.bottom = 1700;
  const control = h.mount(); assert.equal(h.video.src, undefined);
  h.bounds.top = 20; h.bounds.bottom = 700; h.host.dispatchEvent(new Event("scroll")); await Promise.resolve();
  assert.equal(h.video.paused, false);
  h.bounds.top = -800; h.bounds.bottom = -50; h.host.dispatchEvent(new Event("scroll")); assert.equal(h.video.paused, true);
  control.destroy();
  assert.equal(mountLearningVideo(null, { host: h.host, doc: h.doc }), null);
  assert.equal(mountLearningVideo({ querySelector: () => null }, { host: h.host, doc: h.doc }), null);
});

test("the layer is scoped to learning, safe without scripts, and only its code is served/cached", () => {
  const html = read("index.html"), tag = html.match(/<video[^>]+id="learning-background-video"[^>]*>/)?.[0];
  assert.ok(tag); assert.match(tag, /autoplay[^>]+muted[^>]+loop[^>]+playsinline/);
  assert.doesNotMatch(tag, /\s(?:controls|src|poster)=|\scontrols(?:\s|>)/);
  assert.match(tag, /\sinert(?:\s|>)/); assert.match(tag, /aria-hidden="true"/);
  for (const path of ["index.html", "sw.js", "backend/src/website.js", "tools/dev_server.py"]) assert.ok(read(path).includes("home-learning-video.mjs"), path);
  assert.doesNotMatch(read("sw.js"), /r2\.dev|\.(?:mp4|webm)["']/);
  const css = read("home-learning.css");
  assert.match(css, /mix-blend-mode:\s*screen/); assert.match(css, /::-webkit-media-controls/);
  assert.match(css, /pointer-events:\s*none/);
});
