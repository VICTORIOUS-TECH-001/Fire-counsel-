import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CASE_VIDEO_ORIGIN, DEFAULT_CASE_VIDEO_URL, caseVideoUrl, safeCaseVideoUrl } from "../../homepage-media.mjs";
import { mountCaseVideo } from "../../home-case-video.mjs";
import { updateHomepageCopy } from "../../homepage-copy.mjs";
import { validateSiteContent } from "../../firebase/content-schema.mjs";

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const bundled = JSON.parse(read("data/site-content.json"));
const invalid = [null, false, {}, 1, "javascript:alert(1)", "data:video/mp4;base64,x", "//example.invalid/clip.mp4",
  "http://pub-8f421f9b11d64c18bb8a952d99a77e62.r2.dev/clip.mp4", "https://evil.invalid/clip.mp4",
  `${CASE_VIDEO_ORIGIN}.evil.invalid/clip.mp4`, `${CASE_VIDEO_ORIGIN}:444/clip.mp4`, `${CASE_VIDEO_ORIGIN}/page.html`,
  `${CASE_VIDEO_ORIGIN}/clip.mp4?token=private`, `${CASE_VIDEO_ORIGIN}/clip.mp4#fragment`, `${CASE_VIDEO_ORIGIN}/bad%00.mp4`,
  `${CASE_VIDEO_ORIGIN}/bad%5c.mp4`, `${CASE_VIDEO_ORIGIN}/bad%GG.mp4`, `${CASE_VIDEO_ORIGIN}/bad\n.mp4`,
  `${CASE_VIDEO_ORIGIN}/clip.mp4`.replace("https://", "https://user:secret@"), `${CASE_VIDEO_ORIGIN}/${"a".repeat(2000)}.mp4`];

test("the owner's corrected MP4 is the exact default, also for old publishes without live rewrites", () => {
  assert.equal(DEFAULT_CASE_VIDEO_URL, "https://pub-8f421f9b11d64c18bb8a952d99a77e62.r2.dev/Statue%20of%20justice%20ThemisTaken%20by%20Canon%20EOS%20R5%20with%2024.mp4");
  assert.equal(bundled.caseNotes.videoUrl, DEFAULT_CASE_VIDEO_URL);
  const old = structuredClone(bundled); delete old.caseNotes.videoUrl;
  const before = structuredClone(old);
  assert.equal(caseVideoUrl(old), DEFAULT_CASE_VIDEO_URL);
  assert.deepEqual(old, before);
  assert.equal(validateSiteContent(old).ok, true);
  assert.equal(caseVideoUrl({ caseNotes: { videoUrl: "" } }), "");
});

test("only safe public video URLs in this R2 bucket are accepted by both renderer and publish validator", () => {
  for (const value of [DEFAULT_CASE_VIDEO_URL, `${CASE_VIDEO_ORIGIN}/other.webm`, ""]) {
    assert.equal(safeCaseVideoUrl(value), value);
    assert.equal(validateSiteContent({ ...bundled, caseNotes: { ...bundled.caseNotes, videoUrl: value } }).ok, true);
  }
  for (const value of invalid) {
    assert.equal(safeCaseVideoUrl(value), "", JSON.stringify(value));
    assert.equal(caseVideoUrl({ caseNotes: { videoUrl: value } }), "");
    assert.equal(validateSiteContent({ ...bundled, caseNotes: { ...bundled.caseNotes, videoUrl: value } }).ok, false, JSON.stringify(value));
  }
});

test("the single Admin draft can edit/disable the clip without changing the photo, copy or access settings", () => {
  const next = updateHomepageCopy(bundled, "caseNotes.videoUrl", `${CASE_VIDEO_ORIGIN}/next.mp4`);
  assert.equal(next.caseNotes.videoUrl, `${CASE_VIDEO_ORIGIN}/next.mp4`);
  assert.equal(bundled.caseNotes.videoUrl, DEFAULT_CASE_VIDEO_URL);
  delete next.caseNotes.videoUrl;
  const original = structuredClone(bundled); delete original.caseNotes.videoUrl;
  assert.deepEqual(next, original);
  assert.equal(updateHomepageCopy(bundled, "caseNotes.videoUrl", "").caseNotes.videoUrl, "");
  for (const path of ["caseNotes.__proto__", "caseNotes.videoUrl.constructor", "caseNotes.image", "caseNotes.autoplay"]) {
    assert.throws(() => updateHomepageCopy(bundled, path, "No"));
  }
});

function harness({ reduced = false, saveData = false, rejection = false, source = DEFAULT_CASE_VIDEO_URL } = {}) {
  const host = new EventTarget(), doc = new EventTarget(), motion = new EventTarget(), connection = new EventTarget();
  motion.matches = reduced; connection.saveData = saveData; doc.hidden = false;
  const attrs = new Map();
  const video = Object.assign(new EventTarget(), { paused: true, plays: 0, loads: 0, blurs: 0,
    blur() { this.blurs++; },
    setAttribute(key, value) { attrs.set(key, value); }, removeAttribute(key) { if (key === "src") delete this.src; attrs.delete(key); },
    load() { this.loads++; },
    pause() { if (this.paused) return; this.paused = true; this.dispatchEvent(new Event("pause")); },
    play() { this.plays++; if (rejection) return Promise.reject(new Error("Autoplay blocked")); this.paused = false; this.dispatchEvent(new Event("playing")); return Promise.resolve(); }
  });
  const imageAttrs = new Map([["src", "./assets/images/pexels-law-judge.jpg"]]);
  const image = { getAttribute: key => imageAttrs.get(key), setAttribute: (key, value) => imageAttrs.set(key, value), removeAttribute: key => imageAttrs.delete(key) };
  const container = { dataset: {}, querySelector: selector => selector === "video" ? video : image };
  Object.assign(host, { navigator: { connection }, matchMedia: () => motion,
    IntersectionObserver: class { constructor(fn) { this.fn = fn; host.observer = this; } observe() {} disconnect() { this.disconnected = true; } emit(value) { this.fn([{ isIntersecting: value }]); } }
  });
  return { host, doc, motion, connection, video, container, attrs,
    mount: () => mountCaseVideo(container, { content: { caseNotes: { videoUrl: source } }, host, doc }) };
}

test("native muted, inline, endless playback is lazy and pauses offscreen, hidden and during page-cache navigation", async () => {
  const h = harness(); const control = h.mount();
  assert.equal(h.video.src, undefined); assert.equal(h.video.plays, 0);
  assert.equal(h.video.loop, true); assert.equal(h.video.muted, true); assert.equal(h.video.defaultMuted, true); assert.equal(h.video.playsInline, true);
  h.host.observer.emit(true); await Promise.resolve();
  assert.equal(h.video.src, DEFAULT_CASE_VIDEO_URL); assert.equal(h.video.paused, false);
  assert.equal(h.container.dataset.videoState, "playing");
  h.host.observer.emit(false); assert.equal(h.video.paused, true);
  h.host.observer.emit(true); await Promise.resolve(); assert.equal(h.video.paused, false);
  h.doc.hidden = true; h.doc.dispatchEvent(new Event("visibilitychange")); assert.equal(h.video.paused, true);
  h.doc.hidden = false; h.doc.dispatchEvent(new Event("visibilitychange")); await Promise.resolve(); assert.equal(h.video.paused, false);
  h.host.dispatchEvent(new Event("pagehide")); assert.equal(h.video.paused, true);
  h.host.dispatchEvent(new Event("pageshow")); await Promise.resolve(); assert.equal(h.video.paused, false);
  control.destroy(); const count = h.video.plays;
  assert.equal(h.host.observer.disconnected, true); assert.equal(h.video.src, undefined);
  h.host.observer.emit(true); h.doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(h.video.plays, count);
});

test("reduced motion and data-saving use the original still image, including live preference changes", async () => {
  for (const setting of ["reduced", "saveData"]) {
    const h = harness({ [setting]: true }); const control = h.mount(); h.host.observer.emit(true);
    assert.equal(h.video.src, undefined); assert.equal(h.container.dataset.videoVisible, "false");
    if (setting === "reduced") { h.motion.matches = false; h.motion.dispatchEvent(new Event("change")); }
    else { h.connection.saveData = false; h.connection.dispatchEvent(new Event("change")); }
    await Promise.resolve(); assert.equal(h.video.paused, false);
    h.motion.matches = true; h.motion.dispatchEvent(new Event("change"));
    assert.equal(h.video.paused, true); assert.equal(h.container.dataset.videoVisible, "false");
    control.destroy();
  }
});

test("external pause survives lifecycle events; blocked autoplay and media failures keep a controller-free fallback", async () => {
  const h = harness(); const control = h.mount(); h.host.observer.emit(true); await Promise.resolve();
  h.video.pause(); h.host.observer.emit(false); h.host.observer.emit(true);
  assert.equal(h.video.paused, true);
  await h.video.play(); assert.equal(h.container.dataset.videoState, "playing");
  h.video.dispatchEvent(new Event("error")); assert.equal(h.container.dataset.videoVisible, "false");
  h.host.observer.emit(false); h.host.observer.emit(true); assert.equal(h.video.paused, true);
  control.destroy();
  const blocked = harness({ rejection: true }); const other = blocked.mount(); blocked.host.observer.emit(true); await Promise.resolve();
  assert.equal(blocked.container.dataset.videoState, "blocked"); assert.equal(blocked.video.controls, false); assert.equal(blocked.container.dataset.videoVisible, "false");
  blocked.host.observer.emit(false); blocked.host.observer.emit(true);
  assert.equal(blocked.container.dataset.videoState, "blocked"); assert.equal(blocked.video.plays, 1); other.destroy();
  const disabled = harness({ source: "https://evil.invalid/video.mp4" }); const off = disabled.mount(); disabled.host.observer.emit(true);
  assert.equal(disabled.video.src, undefined); assert.equal(disabled.container.dataset.videoState, "disabled"); off.destroy();
});

test("the video stays decorative, unfocusable and controller-free, even during active playback", async () => {
  const h = harness(); const control = h.mount(); h.host.observer.emit(true); await Promise.resolve();
  assert.equal(h.video.controls, false);
  assert.equal(h.video.inert, true);
  assert.equal(h.video.disablePictureInPicture, true);
  assert.equal(h.video.disableRemotePlayback, true);
  assert.equal(h.video.tabIndex, -1);
  assert.equal(h.attrs.get("aria-hidden"), "true");
  h.video.dispatchEvent(new Event("focus")); assert.equal(h.video.blurs, 1);
  const tag = read("index.html").match(/<video[^>]+id="case-video"[^>]*>/)[0];
  assert.doesNotMatch(tag, /\scontrols(?:\s|=|>)/);
  assert.match(tag, /\sinert(?:\s|>)/);
  assert.match(tag, /\sdisablepictureinpicture(?:\s|>)/);
  assert.match(read("home-case-video.css"), /::-webkit-media-controls/);
  assert.doesNotMatch(read("home-case-video.css"), /pointer-events:\s*auto/);
  control.destroy();
});

test("the video and fixed Open case desk action join directly to the ending, without the retired homepage blocks", () => {
  const html = read("index.html");
  const sections = [...html.matchAll(/<section\b[^>]*\bid="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(sections, ["home", "learning", "home-ai", "cases", "exam-ready"]);
  assert.doesNotMatch(html, /case-copy|case-points|case-disclaimer|article-dialog|article-grid/);
  const section = html.match(/<section[^>]+id="cases"[\s\S]*?<\/section>/)[0];
  assert.match(section, /<a\b[^>]+id="case-cta"[^>]+href="\.\/ai\.html\?mode=case">Open case desk <span aria-hidden="true">↗<\/span><\/a>/);
  assert.ok(section.indexOf('id="case-cta"') > section.indexOf("</video>"), "the action follows the video, never overlays it");
  assert.doesNotMatch(section, /data-ai-entry/, "the orbit's fixed chat handler must not discard the case query");
  assert.doesNotMatch(read("site.js"), /cta\.href\s*=|cta\.innerHTML\s*=/, "legacy case JSON cannot restore exam practice over the fixed desk link");
});

test("the static navigation/footer have no links to retired sections and legacy content still validates without migration", () => {
  assert.doesNotMatch(read("index.html"), /href="(?:\.\/index\.html)?#(?:articles|resources|privacy-note)"/);
  assert.equal(validateSiteContent(bundled).ok, true);
  assert.ok(bundled.articles.items.length, "archived article content is preserved, not erased from the data contract");
  assert.equal(bundled.caseNotes.ctaLabel, "Open exam practice", "old content remains readable without writes");
  assert.equal(bundled.caseNotes.videoUrl, DEFAULT_CASE_VIDEO_URL);
});

test("case video assets are explicitly served and cached as code, never as a downloaded R2 media file", () => {
  for (const asset of ["home-case-video.css", "home-case-video.mjs", "homepage-media.mjs"]) {
    for (const server of ["backend/src/website.js", "tools/dev_server.py", "sw.js"]) assert.ok(read(server).includes(asset), `${server}: ${asset}`);
  }
  assert.match(read("index.html"), /<video[^>]+id="case-video"[^>]+autoplay[^>]+muted[^>]+loop[^>]+playsinline/);
  assert.doesNotMatch(read("index.html").match(/<video[^>]*>/)?.[0] || "", /\ssrc=/);
  assert.doesNotMatch(read("sw.js"), /r2\.dev|\.(?:mp4|webm)["']/);
});
