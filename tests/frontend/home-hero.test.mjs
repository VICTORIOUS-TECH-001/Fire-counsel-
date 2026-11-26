import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createStreamLines, streamCurve, streamDashOffset, drawHeroStreams, mountHeroStreams } from "../../home-hero.mjs";

function harness({ reduced = false, observer = true } = {}) {
  const host = new EventTarget(), doc = new EventTarget(), motion = new EventTarget();
  const frames = new Map(), strokes = [], transforms = [];
  const bounds = { width: 800, height: 460 };
  let nextFrame = 0;
  const context = {
    clearRect() {}, setLineDash() {},
    setTransform(...values) { transforms.push(values); },
    stroke(path) { strokes.push({ path, offset: this.lineDashOffset, shadow: this.shadowBlur }); }
  };
  const canvas = { dataset: {}, getContext: () => context, getBoundingClientRect: () => bounds };
  doc.hidden = false;
  motion.matches = reduced;
  Object.assign(host, {
    devicePixelRatio: 3, matchMedia: () => motion,
    requestAnimationFrame(callback) { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    Path2D: class {
      moveTo(...point) { this.start = point; }
      bezierCurveTo(...points) { this.curve = points; }
    },
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; host.size = this; }
      observe() {} disconnect() { this.disconnected = true; }
    }
  });
  if (observer) host.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; host.intersection = this; }
    observe() {} disconnect() { this.disconnected = true; }
    emit(visible) { this.callback([{ isIntersecting: visible }]); }
  };
  return {
    host, doc, motion, canvas, context, bounds, frames, strokes, transforms,
    tick(time) {
      const current = [...frames.values()];
      frames.clear();
      current.forEach(callback => callback(time));
    },
    mount() { return mountHeroStreams(canvas, { host, doc, random: () => .5 }); }
  };
}

test("hero streams retain the supplied palette, density and exact randomized source parameters", () => {
  const narrow = createStreamLines(599, () => .5), wide = createStreamLines(600, () => .5);
  assert.equal(narrow.length, 34);
  assert.equal(wide.length, 64);
  assert.deepEqual(wide[0], { u: -1, col: "46,230,166", sp: .55, off: 500, len: 100, w: 1.15, a: .5 });
  assert.equal(wide.at(-1).u, 1);
});

test("hero curve uses the template's wide sky, 14px neck and original Bezier control points", () => {
  const curve = streamCurve(1000, 460, { u: 1 });
  assert.deepEqual(curve.start, [960, 0]);
  assert.deepEqual(curve.control1, [950.8, 460 * .98 * .55]);
  assert.deepEqual(curve.control2, [528, 460 * .98 * .35]);
  assert.deepEqual(curve.end, [528, 460 * .98]);
  const middle = streamCurve(1000, 460, { u: 0 });
  assert.equal(middle.start[0], 500);
  assert.equal(middle.end[0], 500);
});

test("highlights move upward at the source speed and wrap safely at every phase", () => {
  const line = { off: 320, sp: .6 };
  assert.equal(streamDashOffset(0, line), -200);
  assert.ok(Math.abs(streamDashOffset(100, line) - (-184.4)) < 1e-9);
  for (const time of [0, 100, 10_000, 100_000, 1_000_000]) {
    const offset = streamDashOffset(time, line);
    assert.ok(offset > -980 && offset <= 120);
  }
});

test("drawing keeps the source's lighter compositing, dim paths, dash length and 8px highlight glow", () => {
  const line = createStreamLines(600, () => .5)[0], calls = [];
  const context = {
    clearRect(...rect) { calls.push(["clear", ...rect]); },
    setLineDash(dashes) { calls.push(["dash", ...dashes]); },
    stroke(path) { calls.push(["stroke", path, this.lineWidth, this.shadowBlur || 0]); }
  };
  drawHeroStreams(context, 800, 460, [line], ["synthetic-path"], 0);
  assert.equal(context.globalCompositeOperation, "lighter");
  assert.equal(context.lineCap, "round");
  assert.deepEqual(calls, [
    ["clear", 0, 0, 800, 460], ["dash"], ["stroke", "synthetic-path", .8, 0],
    ["dash", 100, 900], ["stroke", "synthetic-path", 1.15 * 1.2, 8]
  ]);
  assert.equal(context.shadowBlur, 0);
});

test("canvas schedules only one loop and pauses offscreen, hidden and across page-cache navigation", () => {
  const h = harness();
  const controller = h.mount();
  assert.equal(h.canvas.dataset.motion, "paused");
  assert.equal(h.frames.size, 0);
  assert.equal(h.strokes.length, 128, "a source still frame is available before intersection");
  h.host.intersection.emit(true);
  assert.equal(h.frames.size, 1);
  h.tick(0); h.tick(100);
  assert.equal(h.frames.size, 1);
  for (let index = 0; index < 5; index++) h.host.intersection.emit(true);
  assert.equal(h.frames.size, 1, "repeated observer notifications cannot multiply loops");
  h.doc.hidden = true; h.doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(h.frames.size, 0);
  h.doc.hidden = false; h.doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(h.frames.size, 1);
  h.host.dispatchEvent(new Event("pagehide"));
  assert.equal(h.frames.size, 0);
  h.host.dispatchEvent(new Event("pageshow"));
  assert.equal(h.frames.size, 1);
  h.host.intersection.emit(false);
  assert.equal(h.frames.size, 0);
  assert.equal(h.canvas.dataset.motion, "paused");
  controller.destroy();
});

test("reduced motion draws the actual static backdrop, responds to preference changes and cleans up", () => {
  const h = harness({ reduced: true });
  const controller = h.mount();
  h.host.intersection.emit(true);
  assert.equal(h.canvas.dataset.motion, "reduced");
  assert.equal(h.frames.size, 0);
  assert.ok(h.strokes.length > 0);
  h.motion.matches = false; h.motion.dispatchEvent(new Event("change"));
  assert.equal(h.frames.size, 1);
  h.motion.matches = true; h.motion.dispatchEvent(new Event("change"));
  assert.equal(h.frames.size, 0);
  h.motion.matches = false; h.motion.dispatchEvent(new Event("change"));
  controller.destroy();
  assert.equal(h.frames.size, 0);
  assert.equal(h.canvas.dataset.motion, "stopped");
  assert.equal(h.host.size.disconnected, true);
  assert.equal(h.host.intersection.disconnected, true);
  h.motion.dispatchEvent(new Event("change")); h.host.dispatchEvent(new Event("pageshow"));
  assert.equal(h.frames.size, 0);
});

test("canvas caps device pixels, resizes without duplicate loops and degrades safely without a context", () => {
  const h = harness({ observer: false });
  const controller = h.mount();
  assert.equal(h.canvas.width, 1600);
  assert.equal(h.canvas.height, 920);
  assert.deepEqual(h.transforms[0], [2, 0, 0, 2, 0, 0]);
  h.bounds.width = 390;
  h.host.size.callback();
  assert.equal(h.canvas.width, 780);
  assert.equal(h.frames.size, 1);
  assert.equal(h.strokes.length, 128 + 68);
  controller.destroy();
  assert.equal(mountHeroStreams({ getContext: () => null }, { host: h.host, doc: h.doc }), null);
});

test("hero files are served and cached explicitly without changing private data stores or other page styles", () => {
  const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
  for (const path of ["home-hero.css", "home-hero.mjs", "home-learning.css"]) {
    for (const file of ["index.html", "sw.js", "backend/src/website.js", "tools/dev_server.py"]) {
      assert.ok(read(file).includes(path), `${file} explicitly includes ${path}`);
    }
  }
  assert.match(read("index.html"), /<body class="home-streams">/);
  for (const path of ["home-hero.css", "home-hero.mjs", "home-learning.css"]) {
    assert.doesNotMatch(read(path), /fetch\(|localStorage|sessionStorage|indexedDB|firebase|api\/v1|Projexion|construction data|\.ws-|\.admin-/i);
  }
});

test("homepage has one fixed branded introduction, not a carousel or legacy slide copy", () => {
  const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
  const hero = read("index.html").match(/<section class="hero-section"[\s\S]*?<\/section>/)[0];
  const text = hero.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  assert.equal(text, "Fire Counsel Ignite your legal intelligence Fire Counsel is more than a place to learn the law. It is the intelligence behind your success, empowering you to master the law, unlock your potential and become one of tomorrow's great legal minds. Sign up");
  assert.equal((hero.match(/<a\s/g) || []).length, 1);
  assert.match(hero, /class="button button-light hero-signup" href="\.\/auth\.html"/);
  assert.doesNotMatch(hero, /<img|hero-slides?|hero-controls|hero-dots|slide-prev|slide-next|carousel|Explore study space|Organise notes/);
  assert.doesNotMatch(read("site.js"), /renderHero|showSlide|initCarousel|carouselTimer|setInterval\(/);
  assert.doesNotMatch(read("home-hero.css"), /hero-slide|hero-secondary|hero-controls/);
  assert.doesNotMatch(read("data/site-content.json"), /Organise notes, build personal case cards|pexels-law-student|Explore learning tools|See the study tools/);
  assert.doesNotMatch(read("sw.js"), /pexels-law-student/);
});


test("the dark learning section replaces the old principles without reintroducing a hero carousel", () => {
  const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
  const html = read("index.html");
  assert.doesNotMatch(html, /class="quickfacts|id="quickfacts-grid"/);
  assert.doesNotMatch(read("site.js"), /renderQuickFacts|#quickfacts-grid/);
  assert.deepEqual(JSON.parse(read("data/site-content.json")).quickFacts, []);
  const css = read("home-learning.css");
  assert.match(css, /grid-template-columns: 1fr 1fr/);
  assert.match(css, /rgba\(40, 190, 140, \.85\)/);
  assert.match(css, /prefers-reduced-motion/);
  assert.doesNotMatch(css, /\.ws-|\.admin-|Projexion|construction/i);
});
