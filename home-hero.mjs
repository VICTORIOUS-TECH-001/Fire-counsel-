/* Homepage only. Light-stream geometry, palette, dash lengths, glow and speed
   come from section 10 of the owner's supplied animation template. No template
   dashboards, brand names, analytics or unrelated interactions are included. */
const COLORS = ["120,110,255", "70,150,255", "46,230,166", "160,150,255"];

export function createStreamLines(width, random = Math.random) {
  const count = width < 600 ? 34 : 64;
  return Array.from({ length: count }, (_, index) => ({
    u: index / (count - 1) * 2 - 1 + (random() - .5) * .04,
    col: COLORS[Math.floor(random() * COLORS.length)],
    sp: .25 + random() * .6,
    off: random() * 1000,
    len: 40 + random() * 120,
    w: .6 + random() * 1.1,
    a: .25 + random() * .5
  }));
}

export function streamCurve(width, height, line) {
  const center = width / 2, spread = width * .46, neck = 14;
  const startX = center + line.u * spread;
  const endX = center + line.u * neck * (1 + Math.abs(line.u));
  const endY = height * .98;
  return {
    start: [startX, 0],
    control1: [startX + (center - startX) * .02, endY * .55],
    control2: [endX, endY * .35],
    end: [endX, endY]
  };
}

export function streamDashOffset(time, line) {
  // Retain the source's 1100px cycle and 260px/s speed multiplier, but run
  // its phase backwards: highlights travel UP from the neck toward the sky,
  // as requested, without flipping the reference's wide-at-the-top geometry.
  const phase = ((line.off - time * .001 * line.sp * 260) % 1100 + 1100) % 1100;
  return -phase + 120;
}

export function drawHeroStreams(context, width, height, lines, paths, time) {
  context.clearRect(0, 0, width, height);
  context.globalCompositeOperation = "lighter";
  context.lineCap = "round";
  lines.forEach((line, index) => {
    const fade = 1 - Math.abs(line.u) * .55;
    context.setLineDash([]);
    context.strokeStyle = `rgba(${line.col},${.1 * fade})`;
    context.lineWidth = .8;
    context.stroke(paths[index]);
    context.setLineDash([line.len, 900]);
    context.lineDashOffset = streamDashOffset(time, line);
    context.strokeStyle = `rgba(${line.col},${Math.min(1, line.a * 1.5) * fade})`;
    context.lineWidth = line.w * 1.2;
    context.shadowColor = `rgba(${line.col},.9)`;
    context.shadowBlur = 8;
    context.stroke(paths[index]);
    context.shadowBlur = 0;
  });
}

export function mountHeroStreams(canvas, { host = globalThis.window, doc = globalThis.document, random = Math.random } = {}) {
  if (!canvas || !host || !doc || !host.Path2D) return null;
  let context;
  try { context = canvas.getContext("2d"); } catch { return null; }
  if (!context) return null;
  const motion = host.matchMedia?.("(prefers-reduced-motion: reduce)");
  const removers = [];
  let width = 0, height = 0, ratio = 0, lines = [], paths = [];
  let inView = !host.IntersectionObserver, pageActive = true, disposed = false;
  let frameId = null, lastFrame = null, elapsed = 0;

  const draw = () => drawHeroStreams(context, width, height, lines, paths, elapsed);
  const shouldRun = () => !disposed && pageActive && inView && !doc.hidden && !motion?.matches && width > 0 && height > 0;
  function stop() {
    if (frameId !== null) host.cancelAnimationFrame(frameId);
    frameId = null;
    lastFrame = null;
  }
  function frame(time) {
    frameId = null;
    if (!shouldRun()) { sync(); return; }
    if (lastFrame !== null) elapsed += time - lastFrame;
    lastFrame = time;
    draw();
    frameId = host.requestAnimationFrame(frame);
  }
  function sync() {
    const running = shouldRun() && typeof host.requestAnimationFrame === "function";
    canvas.dataset.motion = disposed ? "stopped" : motion?.matches ? "reduced" : running ? "running" : "paused";
    if (running) {
      if (frameId === null) frameId = host.requestAnimationFrame(frame);
    } else stop();
  }
  function resize() {
    if (disposed) return;
    const bounds = canvas.getBoundingClientRect();
    const nextRatio = Math.min(host.devicePixelRatio || 1, 2);
    if (width === bounds.width && height === bounds.height && ratio === nextRatio) return;
    width = bounds.width; height = bounds.height; ratio = nextRatio;
    canvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    lines = createStreamLines(width, random);
    paths = lines.map(line => {
      const curve = streamCurve(width, height, line);
      const path = new host.Path2D();
      path.moveTo(...curve.start);
      path.bezierCurveTo(...curve.control1, ...curve.control2, ...curve.end);
      return path;
    });
    // A single still frame preserves the actual backdrop for reduced motion.
    draw();
    sync();
  }
  const listen = (target, type, handler) => {
    target.addEventListener(type, handler);
    removers.push(() => target.removeEventListener(type, handler));
  };
  listen(host, "resize", resize);
  listen(doc, "visibilitychange", sync);
  listen(host, "pagehide", () => { pageActive = false; sync(); });
  listen(host, "pageshow", () => { pageActive = true; resize(); sync(); });
  if (motion?.addEventListener) listen(motion, "change", sync);
  else if (motion?.addListener) {
    motion.addListener(sync);
    removers.push(() => motion.removeListener(sync));
  }
  const intersection = host.IntersectionObserver ? new host.IntersectionObserver(([entry]) => {
    inView = entry.isIntersecting;
    sync();
  }) : null;
  const size = host.ResizeObserver ? new host.ResizeObserver(resize) : null;
  resize();
  intersection?.observe(canvas);
  size?.observe(canvas);
  return {
    destroy() {
      disposed = true;
      stop();
      intersection?.disconnect();
      size?.disconnect();
      removers.forEach(remove => remove());
      canvas.dataset.motion = "stopped";
    }
  };
}

const canvas = globalThis.document?.querySelector("#hero-streams");
if (canvas) mountHeroStreams(canvas);
