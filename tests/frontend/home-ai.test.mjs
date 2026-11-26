import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createMatrixColumns, drawMatrix, createStars, drawStars, mountHomeAI } from "../../home-ai.mjs";
import { AI_DESTINATION, AI_SIGNIN, resolveAIEntry } from "../../home-ai-access.mjs";
import { DEFAULT_AI_COPY, aiCopy, updateHomepageCopy } from "../../homepage-copy.mjs";
import { validateSiteContent } from "../../firebase/content-schema.mjs";

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const bundled = JSON.parse(read("data/site-content.json"));

test("the new AI section keeps the owner's exact title and two paragraphs, including old-document fallbacks", () => {
  assert.deepEqual(aiCopy(bundled), DEFAULT_AI_COPY);
  assert.deepEqual(aiCopy({}), DEFAULT_AI_COPY);
  assert.equal(DEFAULT_AI_COPY.chips.length, 6);
  assert.equal(DEFAULT_AI_COPY.chips[5], "Cases");
  const cases = updateHomepageCopy(bundled, "aiSpotlight.chips.5", "Case law");
  assert.equal(aiCopy(cases).chips[5], "Case law");
  assert.equal(validateSiteContent(cases).ok, true);
  assert.equal(DEFAULT_AI_COPY.title, "Study Smart with Fire Counsel AI");
  assert.equal(DEFAULT_AI_COPY.intro, "Your personal AI legal study companion. Understand complex legal principles, simplify difficult cases, test your knowledge, discover relevant authorities, and prepare confidently for your law theory examinations. Learn faster, think critically, and study with the intelligence you need to succeed.");
  assert.equal(DEFAULT_AI_COPY.closing, "Let Fire Counsel AI turn the way you study law into the way you master it.");
  const edited = updateHomepageCopy(bundled, "aiSpotlight.chips.0", "Study ideas");
  assert.equal(aiCopy(edited).chips[0], "Study ideas");
  assert.deepEqual(edited.learning, bundled.learning);
  assert.deepEqual(edited.hero, bundled.hero);
  assert.deepEqual(edited.caseNotes, bundled.caseNotes);
  assert.deepEqual(bundled.aiSpotlight.chips, DEFAULT_AI_COPY.chips);
  assert.equal(validateSiteContent(edited).ok, true);
  for (const path of ["aiSpotlight.href", "aiSpotlight.__proto__", "aiSpotlight.chips.6", "aiSpotlight.chips.constructor"]) assert.throws(() => updateHomepageCopy(bundled, path, "No"));
});

test("the optional AI copy map is bounded plain text, not configurable redirects or a required migration", () => {
  const old = structuredClone(bundled); delete old.aiSpotlight;
  assert.equal(validateSiteContent(old).ok, true);
  for (const bad of [null, [], {}, { ...DEFAULT_AI_COPY, href: "https://example.invalid" }, { ...DEFAULT_AI_COPY, title: " " }, { ...DEFAULT_AI_COPY, intro: "x".repeat(601) }, { ...DEFAULT_AI_COPY, closing: "bad\ntext" }, { ...DEFAULT_AI_COPY, buttonLabel: "" }, { ...DEFAULT_AI_COPY, chips: ["Only one"] }, { ...DEFAULT_AI_COPY, chips: ["", "Clarity", "Legislation", "Statutes", "Exam"] }]) {
    assert.equal(validateSiteContent({ ...bundled, aiSpotlight: bad }).ok, false, JSON.stringify(bad));
  }
});

test("matrix and stars retain the supplied orb's actual source parameters", () => {
  const columns = createMatrixColumns(() => .5);
  assert.equal(columns.length, 32);
  assert.ok(columns.every(column => Math.abs(column.speed - .325) < 1e-12));
  const writes = [], rectangles = [];
  const context = { fillRect(...args) { rectangles.push([this.fillStyle, ...args]); }, fillText(...args) { writes.push([this.font, ...args]); } };
  columns.forEach(column => { column.drop = 4; });
  drawMatrix(context, columns, 1, () => .5);
  assert.deepEqual(rectangles[0], ["rgba(2,8,18,0.14)", 0, 0, 480, 480]);
  assert.equal(writes.length, 32);
  assert.deepEqual(writes[0], ["12px monospace", "0", 0, 60]);
  assert.equal(columns[0].drop, 4.325);
  const stars = createStars(800, 450, () => .5);
  assert.equal(stars.length, 90);
  assert.deepEqual(stars[0], { x: 400, y: 225, r: .95, p: 3.14, s: 1.25 });
  const dots = [];
  drawStars({ clearRect() {}, beginPath() {}, arc(...args) { dots.push(args); }, fill() {} }, stars, 800, 450, 1000);
  assert.equal(dots.length, 90);
});

function harness({ reduced = false } = {}) {
  const host = new EventTarget(), doc = new EventTarget(), motion = new EventTarget();
  const frames = new Map(); let id = 0, draws = 0;
  const matrixContext = { clearRect() {}, fillRect() { draws++; }, fillText() {} };
  const starsContext = { setTransform() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {} };
  const matrix = { width: 480, height: 480, getContext: () => matrixContext };
  const stars = { width: 0, height: 0, getContext: () => starsContext, getBoundingClientRect: () => ({ width: 800, height: 450 }) };
  const scene = { dataset: {}, querySelector: selector => selector.includes("matrix") ? matrix : selector.includes("stars") ? stars : null };
  motion.matches = reduced; doc.hidden = false;
  Object.assign(host, {
    devicePixelRatio: 3, matchMedia: () => motion,
    requestAnimationFrame(callback) { const next = ++id; frames.set(next, callback); return next; },
    cancelAnimationFrame(frame) { frames.delete(frame); },
    IntersectionObserver: class { constructor(fn) { this.fn = fn; host.intersection = this; } observe() {} disconnect() { this.disconnected = true; } emit(value) { this.fn([{ isIntersecting: value }]); } },
    ResizeObserver: class { constructor(fn) { this.fn = fn; host.size = this; } observe() {} disconnect() { this.disconnected = true; } }
  });
  return { host, doc, motion, scene, matrix, stars, frames, draws: () => draws,
    mount: () => mountHomeAI(scene, { host, doc, random: () => .5 }),
    tick(time) { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn(time)); }
  };
}

test("orb uses one frame loop, caps star pixels, pauses offscreen/hidden/page-cache and cleans up", () => {
  const h = harness(), control = h.mount();
  assert.equal(h.scene.dataset.motion, "paused");
  assert.ok(h.draws() > 0, "the real digital matrix has a static first frame");
  assert.equal(h.stars.width, 1600); assert.equal(h.stars.height, 900);
  assert.equal(h.matrix.width, 480);
  h.host.intersection.emit(true); h.host.intersection.emit(true);
  assert.equal(h.frames.size, 1);
  h.tick(0); h.tick(16); assert.equal(h.frames.size, 1);
  h.doc.hidden = true; h.doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(h.frames.size, 0); assert.equal(h.scene.dataset.motion, "paused");
  h.doc.hidden = false; h.doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(h.frames.size, 1);
  h.host.dispatchEvent(new Event("pagehide")); assert.equal(h.frames.size, 0);
  h.host.dispatchEvent(new Event("pageshow")); assert.equal(h.frames.size, 1);
  h.host.intersection.emit(false); assert.equal(h.frames.size, 0);
  control.destroy();
  assert.equal(h.scene.dataset.motion, "stopped");
  assert.equal(h.host.size.disconnected, true); assert.equal(h.host.intersection.disconnected, true);
  h.host.intersection.emit(true); h.host.dispatchEvent(new Event("pageshow"));
  assert.equal(h.frames.size, 0);
});

test("reduced motion has a genuine still matrix with no loop and responds to live preference changes", () => {
  const h = harness({ reduced: true }), control = h.mount();
  h.host.intersection.emit(true);
  assert.equal(h.scene.dataset.motion, "reduced"); assert.equal(h.frames.size, 0);
  h.motion.matches = false; h.motion.dispatchEvent(new Event("change")); assert.equal(h.frames.size, 1);
  h.motion.matches = true; h.motion.dispatchEvent(new Event("change")); assert.equal(h.frames.size, 0);
  control.destroy();
  assert.equal(mountHomeAI(null), null);
  assert.equal(mountHomeAI({ querySelector: () => ({ getContext: () => null }) }, { host: h.host, doc: h.doc }), null);
});

test("no manual pause control is rendered or injected; automatic motion preferences still work", () => {
  for (const path of ["index.html", "home-ai.mjs", "home-ai.css"]) {
    assert.doesNotMatch(read(path), /home-ai-pause|Pause animation|Resume animation/, path);
  }
  const h = harness(), control = h.mount();
  h.host.intersection.emit(true); assert.equal(h.frames.size, 1);
  h.motion.matches = true; h.motion.dispatchEvent(new Event("change")); assert.equal(h.frames.size, 0);
  h.motion.matches = false; h.motion.dispatchEvent(new Event("change")); assert.equal(h.frames.size, 1);
  control.destroy(); assert.equal(h.frames.size, 0);
});

test("legacy five-label documents keep custom words and receive Cases without writes or migration", () => {
  const legacy = structuredClone(bundled);
  legacy.aiSpotlight.chips = ["Custom hacks", "Clear thinking", "Legislation", "Statues", "Exam"];
  const before = structuredClone(legacy);
  assert.equal(validateSiteContent(legacy).ok, true);
  assert.deepEqual(aiCopy(legacy).chips, [...legacy.aiSpotlight.chips, "Cases"]);
  assert.deepEqual(legacy, before);
  const edited = updateHomepageCopy(legacy, "aiSpotlight.chips.5", "Cases & decisions");
  assert.equal(edited.aiSpotlight.chips.length, 6);
  assert.equal(edited.aiSpotlight.chips[5], "Cases & decisions");
  assert.deepEqual(edited.aiSpotlight.chips.slice(0, 5), legacy.aiSpotlight.chips);
  for (const count of [0, 1, 4, 7]) assert.equal(validateSiteContent({ ...bundled, aiSpotlight: { ...DEFAULT_AI_COPY, chips: Array(count).fill("Word") } }).ok, false);
});

function auth(user, google = true, synchronous = false) {
  const client = { firebaseAuth: { currentUser: user }, hasGoogleSession: async () => google, unsubscribes: 0 };
  client.onIdTokenChanged = (_auth, fn) => { if (synchronous) fn(user); else queueMicrotask(() => fn(user)); return () => { client.unsubscribes++; }; };
  return client;
}

test("AI entry waits for the actual Google session, not providerData, local markers or a cached currentUser", async () => {
  assert.equal(AI_DESTINATION, "./ai.html"); assert.equal(AI_SIGNIN, "./auth.html?next=ai.html");
  for (const synchronous of [true, false]) {
    const client = auth({ uid: "google" }, true, synchronous);
    assert.equal(await resolveAIEntry(client), AI_DESTINATION);
    assert.equal(client.unsubscribes, 1);
  }
  assert.equal(await resolveAIEntry(auth(null)), AI_SIGNIN);
  assert.equal(await resolveAIEntry(auth({ uid: "password", providerData: [{ providerId: "google.com" }] }, false)), AI_SIGNIN);
  const client = auth({ uid: "old" });
  client.hasGoogleSession = async () => { client.firebaseAuth.currentUser = { uid: "new" }; return true; };
  assert.equal(await resolveAIEntry(client), AI_SIGNIN);
});

test("unavailable/cancelled checks reject, remove listeners and leave offline decisions to the existing page gate", async () => {
  const client = auth({ uid: "u" }); client.hasGoogleSession = async () => { throw new Error("Synthetic unavailable token"); };
  await assert.rejects(resolveAIEntry(client), /Synthetic unavailable token/);
  assert.equal(client.unsubscribes, 1);
  const controller = new AbortController();
  const waiting = { firebaseAuth: { currentUser: null }, unsubscribes: 0, onIdTokenChanged() { return () => { this.unsubscribes++; }; } };
  const result = resolveAIEntry(waiting, { signal: controller.signal }); controller.abort();
  await assert.rejects(result, { name: "AbortError" }); assert.equal(waiting.unsubscribes, 1);
});

test("orb is scoped to the homepage, preserves the reference timings and ships in explicit allowlists/cache", () => {
  const css = read("home-ai.css"), html = read("index.html");
  assert.match(css, /homeAIRing 8s linear infinite/);
  assert.match(css, /homeAIPulse 4s ease-in-out infinite/);
  assert.match(css, /homeAIOrbit 80s linear infinite/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /animation-play-state: paused/);
  assert.match(html, /id="home-ai-title"/);
  assert.doesNotMatch(read("home-ai.mjs"), /fetch\(|localStorage|sessionStorage|indexedDB|firebase|api\/v1/);
  for (const asset of ["home-ai.css", "home-ai.mjs", "home-ai-access.mjs"]) {
    for (const file of ["backend/src/website.js", "tools/dev_server.py", "sw.js"]) assert.ok(read(file).includes(asset), `${file}: ${asset}`);
  }
});
