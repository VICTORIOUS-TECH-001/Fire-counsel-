import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { endingStreamCurve, endingDashOffset, drawEndingStreams, mountHomeEnding } from "../../home-ending.mjs";

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const style = () => ({ values: new Map(), setProperty(key, value) { this.values.set(key, value); }, removeProperty(key) { this.values.delete(key); } });

function harness({ reduced = false, observer = true, contextAvailable = true } = {}) {
  const host = new EventTarget(), doc = new EventTarget(), motion = new EventTarget(), pointer = new EventTarget();
  const frames = new Map(), strokes = [], transforms = [], observed = [];
  const bounds = { width: 800, height: 420 }, sectionBounds = { top: 1000 }, headingBounds = { top: 1100 };
  let nextFrame = 0;
  const context = {
    clearRect() {}, setLineDash() {},
    setTransform(...values) { transforms.push(values); },
    stroke(path) { strokes.push({ path, offset: this.lineDashOffset, shadow: this.shadowBlur }); }
  };
  const canvas = { dataset: {}, getContext: () => contextAvailable ? context : null, getBoundingClientRect: () => bounds };
  const words = Array.from({ length: 5 }, () => ({ style: style() }));
  const heading = { getBoundingClientRect: () => headingBounds, querySelectorAll: () => words };
  const frame = { offsetTop: 80 };
  const action = Object.assign(new EventTarget(), { style: style(), matches: () => false,
    getBoundingClientRect: () => ({ left: 100, top: 100, width: 200, height: 48 }) });
  const section = { dataset: {}, style: style(), getBoundingClientRect: () => sectionBounds,
    querySelector: selector => ({ ".ending-streams": canvas, ".ending-frame": frame, "#exam-ready-title": heading, ".ending-action": action })[selector] };
  const card = {}, footer = { dataset: {}, querySelector: () => card };
  doc.hidden = false; motion.matches = reduced; pointer.matches = true;
  Object.assign(host, {
    innerHeight: 1000, devicePixelRatio: 3, matchMedia: query => query.includes("reduced-motion") ? motion : pointer,
    requestAnimationFrame(callback) { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    Path2D: class { moveTo(...point) { this.start = point; } bezierCurveTo(...points) { this.curve = points; } },
    ResizeObserver: class { constructor(callback) { this.callback = callback; host.size = this; } observe() {} disconnect() { this.disconnected = true; } }
  });
  if (observer) host.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; host.intersection = this; }
    observe(target) { observed.push(target); } disconnect() { this.disconnected = true; }
    emit(target, visible) { this.callback([{ target, isIntersecting: visible }]); }
  };
  return { host, doc, motion, pointer, canvas, section, footer, card, words, action, frames, bounds, sectionBounds, headingBounds, strokes, transforms, observed,
    tick(time) { const current = [...frames.values()]; frames.clear(); current.forEach(callback => callback(time)); },
    enter() { host.intersection.emit(section, true); host.intersection.emit(canvas, true); },
    mount: () => mountHomeEnding(section, footer, { host, doc, random: () => .5 }) };
}

test("closing streams use the supplied bottom-wide, top-neck Bezier rather than flipping the existing hero", () => {
  const curve = endingStreamCurve(1000, 420, { u: 1 });
  assert.deepEqual(curve.start, [960, 420]);
  assert.deepEqual(curve.control1, [950.8, 420 - 420 * .98 * .55]);
  assert.deepEqual(curve.control2, [528, 420 - 420 * .98 * .35]);
  assert.deepEqual(curve.end, [528, 420 - 420 * .98]);
  assert.equal(endingDashOffset(0, { off: 320, sp: .6 }), -200);
  assert.ok(Math.abs(endingDashOffset(100, { off: 320, sp: .6 }) + 215.6) < 1e-9);
});

test("closing drawing retains the source's lighter blend, 900px gap and 8px highlight glow", () => {
  const calls = [], context = { clearRect(...values) { calls.push(["clear", ...values]); },
    setLineDash(values) { calls.push(["dash", ...values]); }, stroke(path) { calls.push(["stroke", path, this.lineWidth, this.shadowBlur || 0]); } };
  drawEndingStreams(context, 800, 420, [{ u: 0, col: "46,230,166", sp: .6, off: 320, len: 60, w: 1.2, a: .6 }], ["path"], 100);
  assert.equal(context.globalCompositeOperation, "lighter"); assert.equal(context.lineCap, "round");
  assert.deepEqual(calls, [["clear", 0, 0, 800, 420], ["dash"], ["stroke", "path", .8, 0], ["dash", 60, 900], ["stroke", "path", 1.2 * 1.2, 8]]);
  assert.ok(Math.abs(context.lineDashOffset + 215.6) < 1e-9); assert.equal(context.shadowBlur, 0);
});

test("one closing loop pauses offscreen, hidden and during page-cache navigation; footer CSS runs only in view", () => {
  const h = harness(), control = h.mount();
  assert.equal(h.frames.size, 0); assert.equal(h.strokes.length, 0);
  assert.equal(h.canvas.dataset.motion, "paused"); assert.equal(h.footer.dataset.motion, "paused");
  h.enter(); h.host.intersection.emit(h.card, true);
  assert.equal(h.frames.size, 1); assert.equal(h.footer.dataset.motion, "running");
  h.tick(0); h.tick(100);
  for (let i = 0; i < 4; i++) h.enter();
  assert.equal(h.frames.size, 1);
  h.doc.hidden = true; h.doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(h.frames.size, 0); assert.equal(h.footer.dataset.motion, "paused");
  h.doc.hidden = false; h.doc.dispatchEvent(new Event("visibilitychange")); assert.equal(h.frames.size, 1);
  h.host.dispatchEvent(new Event("pagehide")); assert.equal(h.frames.size, 0);
  h.host.dispatchEvent(new Event("pageshow")); assert.equal(h.frames.size, 1);
  h.host.intersection.emit(h.section, false); h.host.intersection.emit(h.card, false);
  assert.equal(h.frames.size, 0); assert.equal(h.footer.dataset.motion, "paused");
  control.destroy();
});

test("streams do not rasterize or recur until their own canvas enters view, and painting is capped without changing phase speed", () => {
  const h = harness(), control = h.mount();
  h.host.intersection.emit(h.section, true); h.tick(0);
  h.host.size.callback(); h.tick(16);
  assert.equal(h.frames.size, 0); assert.equal(h.strokes.length, 0);
  assert.equal(h.canvas.dataset.motion, "paused");
  h.host.intersection.emit(h.canvas, true); h.tick(0); const count = h.strokes.length;
  h.tick(16); assert.equal(h.strokes.length, count);
  h.tick(40); assert.equal(h.strokes.length, count + 128);
  h.host.intersection.emit(h.canvas, false); h.tick(60);
  assert.equal(h.frames.size, 0); control.destroy();
});

test("scroll flattening and word reveal use the reference easing, with a fully readable reduced-motion state", () => {
  const h = harness(); h.host.scrollY = 0; const control = h.mount(); h.enter(); h.tick(0);
  assert.equal(h.section.style.values.get("--ending-tilt"), "18deg");
  assert.equal(h.section.style.values.get("--ending-scale"), "0.88");
  h.sectionBounds.top = -100; h.headingBounds.top = 100;
  // A native scroll notification can arrive after the next canvas frame.
  h.host.scrollY = 1000; h.tick(100);
  assert.equal(h.section.style.values.get("--ending-tilt"), "0deg");
  assert.equal(h.section.style.values.get("--ending-scale"), "1");
  assert.equal(h.words.at(-1).style.values.get("opacity"), "1");
  h.motion.matches = true; h.motion.dispatchEvent(new Event("change"));
  assert.equal(h.frames.size, 0); assert.equal(h.canvas.dataset.motion, "reduced");
  assert.equal(h.section.style.values.get("--ending-tilt"), "0deg");
  for (const word of h.words) {
    assert.equal(word.style.values.get("opacity"), "1"); assert.equal(word.style.values.get("filter"), "none");
    assert.equal(word.style.values.get("transform"), "none");
  }
  h.motion.matches = false; h.motion.dispatchEvent(new Event("change")); assert.equal(h.frames.size, 1);
  control.destroy(); assert.equal(h.frames.size, 0);
});

test("a live motion preference stops the next frame and updates CSS state even before its change event is delivered", () => {
  const h = harness(), control = h.mount(); h.enter(); h.host.intersection.emit(h.card, true); h.tick(0);
  h.motion.matches = true; h.tick(40);
  assert.equal(h.frames.size, 0); assert.equal(h.canvas.dataset.motion, "reduced");
  assert.equal(h.footer.dataset.motion, "reduced");
  for (const word of h.words) assert.equal(word.style.values.get("opacity"), "1");
  control.destroy();
});

test("the magnetic action never moves for touch, keyboard focus or reduced motion and resets on leave", () => {
  const h = harness(), control = h.mount(); h.enter();
  const move = type => h.action.dispatchEvent(Object.assign(new Event("pointermove"), { pointerType: type, clientX: 290, clientY: 140 }));
  move("touch"); assert.equal(h.action.style.values.get("--ending-magnet-x"), undefined);
  move("mouse"); assert.equal(h.action.style.values.get("--ending-magnet-x"), "12px");
  h.action.dispatchEvent(new Event("pointerleave")); assert.equal(h.action.style.values.get("--ending-magnet-x"), undefined);
  h.action.matches = () => true; move("mouse"); assert.equal(h.action.style.values.get("--ending-magnet-x"), undefined);
  h.action.matches = () => false; move("mouse"); h.motion.matches = true; h.motion.dispatchEvent(new Event("change"));
  assert.equal(h.action.style.values.get("--ending-magnet-x"), undefined); move("mouse");
  assert.equal(h.action.style.values.get("--ending-magnet-x"), undefined); control.destroy();
});

test("resize caps device pixels and remount/destroy remove observers, callbacks and input listeners", () => {
  const h = harness(), first = h.mount(); h.enter();
  assert.equal(h.canvas.width, 1600); assert.equal(h.canvas.height, 840);
  assert.deepEqual(h.transforms[0], [2, 0, 0, 2, 0, 0]);
  h.bounds.width = 390; h.host.size.callback(); assert.equal(h.canvas.width, 780); assert.equal(h.frames.size, 1);
  const previousObserver = h.host.intersection, previousSize = h.host.size;
  const second = h.mount(); assert.equal(previousObserver.disconnected, true); assert.equal(previousSize.disconnected, true);
  first.destroy(); h.enter(); second.destroy();
  assert.equal(h.canvas.dataset.motion, "stopped"); assert.equal(h.footer.dataset.motion, "stopped"); assert.equal(h.frames.size, 0);
  h.host.dispatchEvent(new Event("scroll")); h.host.dispatchEvent(new Event("resize")); h.motion.dispatchEvent(new Event("change"));
  assert.equal(h.frames.size, 0);
  h.action.dispatchEvent(Object.assign(new Event("pointermove"), { pointerType: "mouse", clientX: 290, clientY: 140 }));
  assert.equal(h.action.style.values.get("--ending-magnet-x"), undefined);
});

test("missing observers or a missing canvas context still leave the closing words, links and footer usable", () => {
  const h = harness({ observer: false, reduced: true, contextAvailable: false }), control = h.mount();
  assert.ok(control); assert.equal(h.frames.size, 0);
  for (const word of h.words) assert.equal(word.style.values.get("opacity"), "1");
  assert.equal(h.footer.dataset.motion, "reduced"); control.destroy();
  assert.equal(mountHomeEnding(null, null, { host: h.host, doc: h.doc }), null);
});

test("only public ending assets are served/cached and Fire Counsel copy/destinations remain, without template branding or invented socials", () => {
  const html = read("index.html");
  for (const asset of ["home-ending.css", "home-ending.mjs"]) for (const file of ["index.html", "sw.js", "backend/src/website.js", "tools/dev_server.py"]) assert.ok(read(file).includes(asset), `${file}: ${asset}`);
  const closing = html.match(/<section[^>]+id="exam-ready"[\s\S]*?<\/section>/)[0];
  assert.match(closing.replace(/<[^>]*>/g, " ").replace(/\s+/g, " "), /Make You Exam Ready Note/);
  assert.match(closing, /href="\.\/study\.html#dashboard"/);
  assert.doesNotMatch(closing, /\breveal\b|cta-orb/);
  assert.match(html, /class="ending-footer-card"/);
  for (const file of ["home-ending.mjs", "home-ending.css"]) assert.doesNotMatch(read(file), /fetch\(|localStorage|sessionStorage|indexedDB|firebase|api\/v1|Projexion|construction|Set up a Demo/i);
  assert.match(read("home-ending.css"), /7s linear infinite/);
  assert.doesNotMatch(html, /Projexion|Solutions by Customer|Set up a Demo|aria-label="(?:Discord|LinkedIn|YouTube)"/);
});
