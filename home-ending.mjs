/* Closing-section effects from the supplied reference: bottom-wide light
   streams, scroll-flattening double frame, floating words and magnetic action.
   Reuse the unchanged hero's palette/line parameters, not its animation phase. */
import { createStreamLines, streamCurve } from "./home-hero.mjs";

const mounted = new WeakMap();
const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const ease = value => 1 - (1 - value) ** 3;

export function endingStreamCurve(width, height, line) {
  // The source CTA path is the vertical mirror of its hero path: wide at
  // the bottom, converging into the same 14px neck at two percent height.
  return Object.fromEntries(Object.entries(streamCurve(width, height, line)).map(([key, [x, y]]) => [key, [x, height - y]]));
}

export function endingDashOffset(time, line) {
  return -((time * .001 * line.sp * 260 + line.off) % 1100) + 120;
}

export function drawEndingStreams(context, width, height, lines, paths, time) {
  context.clearRect(0, 0, width, height);
  context.globalCompositeOperation = "lighter"; context.lineCap = "round";
  lines.forEach((line, index) => {
    const fade = 1 - Math.abs(line.u) * .55;
    context.setLineDash([]); context.strokeStyle = `rgba(${line.col},${.1 * fade})`;
    context.lineWidth = .8; context.stroke(paths[index]);
    context.setLineDash([line.len, 900]); context.lineDashOffset = endingDashOffset(time, line);
    context.strokeStyle = `rgba(${line.col},${Math.min(1, line.a * 1.5) * fade})`;
    context.lineWidth = line.w * 1.2; context.shadowColor = `rgba(${line.col},.9)`;
    context.shadowBlur = 8; context.stroke(paths[index]); context.shadowBlur = 0;
  });
}

export function mountHomeEnding(section, footer, { host = globalThis.window, doc = globalThis.document, random = Math.random } = {}) {
  if (!section || !host || !doc) return null;
  mounted.get(section)?.destroy();
  const canvas = section.querySelector(".ending-streams"), frame = section.querySelector(".ending-frame");
  const heading = section.querySelector("#exam-ready-title"), words = [...(heading?.querySelectorAll(".ending-word") || [])];
  const action = section.querySelector(".ending-action"), card = footer?.querySelector(".ending-footer-card");
  let context;
  try { context = host.Path2D && canvas?.getContext("2d"); } catch { /* the copy and footer do not depend on canvas support */ }
  const motion = host.matchMedia?.("(prefers-reduced-motion: reduce)");
  const pointer = host.matchMedia?.("(hover: hover) and (pointer: fine)"), removers = [];
  let disposed = false, pageActive = true, inView = !host.IntersectionObserver, streamInView = !host.IntersectionObserver, footerInView = !host.IntersectionObserver;
  let width = 0, height = 0, ratio = 0, lines = [], paths = [], frameId = null, lastFrame = null, lastPaint = null, elapsed = 0, dirty = true, lastScroll = null, needsPaint = true;
  const active = () => !disposed && pageActive && !doc.hidden && !motion?.matches;
  const animateStreams = () => active() && inView && streamInView && context && width > 0 && height > 0;
  const draw = () => {
    if (!context || !streamInView || width <= 0 || height <= 0) return;
    drawEndingStreams(context, width, height, lines, paths, elapsed);
    needsPaint = false; canvas.dataset.painted = "true";
  };
  const resetMagnet = () => { action?.style.removeProperty("--ending-magnet-x"); action?.style.removeProperty("--ending-magnet-y"); };
  function updateScene() {
    const reduced = motion?.matches, viewport = host.innerHeight || 1;
    const top = section.getBoundingClientRect().top + (frame?.offsetTop || 0);
    // Measure the untransformed section/offset, avoiding transform feedback.
    const progress = reduced ? 1 : ease(clamp((viewport - top) / (viewport * .85)));
    section.style.setProperty("--ending-tilt", `${18 * (1 - progress)}deg`);
    section.style.setProperty("--ending-scale", String(.88 + .12 * progress));
    const reveal = reduced ? 1 : clamp((viewport * .92 - (heading?.getBoundingClientRect().top || 0)) / (viewport * .42));
    words.forEach((word, index) => {
      // Finish every word once the heading is in view; do not leave the last
      // word permanently translucent/blurred at the end of the source stagger.
      const amount = reduced || reveal === 1 ? 1 : ease(clamp(reveal * 1.7 - index * .2));
      word.style.setProperty("opacity", String(amount));
      word.style.setProperty("transform", amount === 1 ? "none" : `translateY(${(1 - amount) * [46, 70, 36, 84, 58][index % 5]}px)`);
      word.style.setProperty("filter", amount === 1 ? "none" : `blur(${(1 - amount) * 10}px)`);
    });
    dirty = false;
  }
  function stop() {
    if (frameId !== null) host.cancelAnimationFrame(frameId);
    frameId = null; lastFrame = null; lastPaint = null;
  }
  function tick(time) {
    frameId = null;
    if (!active() || !inView) { sync(); return; }
    // Scroll events can be delivered after a rendered frame. Observe the
    // scalar position too, without reading layout on every idle canvas frame.
    if (host.scrollY !== lastScroll) { lastScroll = host.scrollY; dirty = true; }
    if (dirty) updateScene();
    if (animateStreams()) {
      if (lastFrame !== null) elapsed += time - lastFrame;
      lastFrame = time;
      // Keep the same time-based speed at a bounded 30 painted frames/second.
      // Do not rasterize 64 glowing paths while the stream canvas is offscreen.
      if (lastPaint === null || time - lastPaint >= 1000 / 30) { draw(); lastPaint = time; }
      frameId = host.requestAnimationFrame(tick);
    }
  }
  function sync() {
    const state = visible => disposed ? "stopped" : motion?.matches ? "reduced" : active() && visible ? "running" : "paused";
    section.dataset.motion = state(inView);
    if (canvas) canvas.dataset.motion = context ? state(inView && streamInView) : "unavailable";
    if (footer) footer.dataset.motion = state(footerInView);
    if (motion?.matches) { resetMagnet(); updateScene(); }
    if (!active() || !inView) { stop(); return; }
    if (frameId === null && (dirty || animateStreams()) && host.requestAnimationFrame) frameId = host.requestAnimationFrame(tick);
  }
  function resize() {
    if (disposed) return;
    if (context) {
      const bounds = canvas.getBoundingClientRect(), nextRatio = Math.min(host.devicePixelRatio || 1, 2);
      if (bounds.width !== width || bounds.height !== height || ratio !== nextRatio) {
        width = bounds.width; height = bounds.height; ratio = nextRatio;
        canvas.width = Math.max(1, Math.round(width * ratio)); canvas.height = Math.max(1, Math.round(height * ratio));
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        lines = createStreamLines(width, random);
        paths = lines.map(line => {
          const curve = endingStreamCurve(width, height, line), path = new host.Path2D();
          path.moveTo(...curve.start); path.bezierCurveTo(...curve.control1, ...curve.control2, ...curve.end); return path;
        });
        // Defer expensive glow rasterization until the canvas itself is seen.
        // Reduced motion still gets the real backdrop on that first entry.
        needsPaint = true; canvas.dataset.painted = "false"; draw();
      }
    }
    dirty = true; resetMagnet(); sync();
  }
  function listen(target, type, callback, options) {
    target?.addEventListener(type, callback, options);
    removers.push(() => target?.removeEventListener(type, callback, options));
  }
  listen(host, "scroll", () => { if (inView) { dirty = true; sync(); } }, { passive: true });
  listen(host, "resize", resize);
  listen(doc, "visibilitychange", () => { dirty = true; resetMagnet(); sync(); });
  listen(host, "pagehide", () => { pageActive = false; resetMagnet(); sync(); });
  listen(host, "pageshow", () => { pageActive = true; resize(); });
  if (motion?.addEventListener) listen(motion, "change", () => { dirty = true; sync(); });
  else if (motion?.addListener) {
    const change = () => { dirty = true; sync(); };
    motion.addListener(change); removers.push(() => motion.removeListener(change));
  }
  listen(pointer, "change", resetMagnet);
  listen(action, "pointermove", event => {
    if (event.pointerType !== "mouse" || !active() || !pointer?.matches || action.matches(":focus-visible")) return;
    const rect = action.getBoundingClientRect();
    // Source coefficients, bounded so the action cannot escape a narrow frame.
    action.style.setProperty("--ending-magnet-x", `${clamp((event.clientX - rect.left - rect.width / 2) * .25, -12, 12)}px`);
    action.style.setProperty("--ending-magnet-y", `${clamp((event.clientY - rect.top - rect.height / 2) * .35, -8, 8)}px`);
  });
  listen(action, "pointerleave", resetMagnet); listen(action, "focus", resetMagnet); listen(action, "blur", resetMagnet);
  const intersection = host.IntersectionObserver ? new host.IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.target === section) { inView = entry.isIntersecting; dirty = true; if (!inView) resetMagnet(); }
      if (entry.target === canvas) { streamInView = entry.isIntersecting; if (streamInView && needsPaint) draw(); }
      if (entry.target === card) footerInView = entry.isIntersecting;
    }
    sync();
  }) : null;
  const size = host.ResizeObserver ? new host.ResizeObserver(resize) : null;
  const control = { destroy() {
    if (disposed) return;
    disposed = true; stop(); intersection?.disconnect(); size?.disconnect(); removers.forEach(remove => remove()); resetMagnet();
    section.style.removeProperty("--ending-tilt"); section.style.removeProperty("--ending-scale");
    for (const word of words) for (const property of ["opacity", "transform", "filter"]) word.style.removeProperty(property);
    section.dataset.motion = "stopped"; if (canvas) canvas.dataset.motion = "stopped"; if (footer) footer.dataset.motion = "stopped";
    if (mounted.get(section) === control) mounted.delete(section);
  } };
  mounted.set(section, control);
  resize(); intersection?.observe(section); if (canvas) intersection?.observe(canvas); if (card) intersection?.observe(card);
  if (canvas) size?.observe(canvas); size?.observe(section);
  return control;
}

const section = globalThis.document?.querySelector("#exam-ready");
if (section) mountHomeEnding(section, globalThis.document.querySelector("#site-footer"));
