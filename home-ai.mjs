// The supplied orb's digital rain and stars, scoped to the homepage. CSS owns
// the 8s ring, 4s halo and 80s counter-rotating labels. One visibility-aware
// canvas loop drives both layers; this module knows nothing about accounts.
const SIZE = 480;
const CELL = 15;

export function createMatrixColumns(random = Math.random) {
  return Array.from({ length: Math.floor(SIZE / CELL) }, () => ({
    drop: random() * -40, speed: .15 + random() * .35
  }));
}

export function drawMatrix(context, columns, step = 1, random = Math.random) {
  context.fillStyle = "rgba(2,8,18,0.14)";
  context.fillRect(0, 0, SIZE, SIZE);
  context.font = "12px monospace";
  columns.forEach((column, index) => {
    if (column.drop > 0) {
      const character = random() > .5 ? "1" : "0";
      context.fillStyle = random() > .93 ? "#c8fff0" : `rgba(46,230,166,${.35 + random() * .5})`;
      context.fillText(character, index * CELL, column.drop * CELL);
    }
    column.drop += column.speed * step;
    if (column.drop * CELL > SIZE && random() > .975) column.drop = random() * -10;
  });
}

export function createStars(width, height, random = Math.random) {
  return Array.from({ length: 90 }, () => ({
    x: random() * width, y: random() * height, r: random() * 1.3 + .3,
    p: random() * 6.28, s: .5 + random() * 1.5
  }));
}

export function drawStars(context, stars, width, height, time) {
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#b9b3ff";
  stars.forEach(star => {
    context.globalAlpha = .25 + .55 * Math.abs(Math.sin(time * .001 * star.s + star.p));
    context.beginPath();
    context.arc(star.x, star.y, star.r, 0, Math.PI * 2);
    context.fill();
  });
  context.globalAlpha = 1;
}

export function mountHomeAI(scene, { host = globalThis.window, doc = globalThis.document, random = Math.random } = {}) {
  if (!scene || !host || !doc) return null;
  const matrix = scene.querySelector(".home-ai-matrix"), stars = scene.querySelector(".home-ai-stars");
  let matrixContext, starsContext;
  try { matrixContext = matrix?.getContext("2d"); starsContext = stars?.getContext("2d"); } catch { return null; }
  if (!matrixContext || !starsContext) return null;
  const motion = host.matchMedia?.("(prefers-reduced-motion: reduce)");
  const pause = scene.querySelector("#home-ai-pause");
  const columns = createMatrixColumns(random), removers = [];
  let width = 0, height = 0, ratio = 0, points = [];
  let disposed = false, pageActive = true, inView = !host.IntersectionObserver, userPaused = false;
  let frameId = null, lastFrame = null, elapsed = 0;

  // Warm a real source frame once, rather than leaving reduced motion or the
  // initially offscreen orb blank while waiting for rain to enter the canvas.
  matrix.width = matrix.height = SIZE;
  for (let index = 0; index < 160; index++) drawMatrix(matrixContext, columns, 1, random);

  function measure() {
    const bounds = stars.getBoundingClientRect();
    const nextRatio = Math.min(host.devicePixelRatio || 1, 2);
    if (bounds.width === width && bounds.height === height && ratio === nextRatio) return;
    width = bounds.width; height = bounds.height; ratio = nextRatio;
    stars.width = Math.round(width * ratio); stars.height = Math.round(height * ratio);
    starsContext.setTransform(ratio, 0, 0, ratio, 0, 0);
    points = createStars(width, height, random);
    drawStars(starsContext, points, width, height, elapsed);
  }
  const shouldRun = () => !disposed && !userPaused && pageActive && inView && !doc.hidden
    && !motion?.matches && width > 0 && height > 0 && typeof host.requestAnimationFrame === "function";
  function stop() {
    if (frameId !== null) host.cancelAnimationFrame(frameId);
    frameId = null; lastFrame = null;
  }
  function frame(time) {
    frameId = null;
    if (!shouldRun()) { sync(); return; }
    const delta = lastFrame === null ? 0 : Math.min(Math.max(time - lastFrame, 0), 64);
    lastFrame = time; elapsed += delta;
    drawMatrix(matrixContext, columns, delta / (1000 / 60), random);
    drawStars(starsContext, points, width, height, elapsed);
    frameId = host.requestAnimationFrame(frame);
  }
  function sync() {
    const running = shouldRun();
    scene.dataset.motion = disposed ? "stopped" : motion?.matches ? "reduced" : running ? "running" : "paused";
    if (pause) {
      pause.hidden = disposed || Boolean(motion?.matches) || typeof host.requestAnimationFrame !== "function";
      pause.textContent = userPaused ? "Resume animation" : "Pause animation";
    }
    if (running) { if (frameId === null) frameId = host.requestAnimationFrame(frame); }
    else stop();
  }
  function listen(target, name, callback) {
    target.addEventListener(name, callback);
    removers.push(() => target.removeEventListener(name, callback));
  }
  if (motion?.addEventListener) listen(motion, "change", sync);
  else if (motion?.addListener) { motion.addListener(sync); removers.push(() => motion.removeListener(sync)); }
  if (pause?.addEventListener) listen(pause, "click", () => { userPaused = !userPaused; sync(); });
  listen(doc, "visibilitychange", sync);
  listen(host, "pagehide", () => { pageActive = false; sync(); });
  listen(host, "pageshow", () => { pageActive = true; measure(); sync(); });
  const resize = () => { measure(); sync(); };
  let sizeObserver, intersection;
  if (host.ResizeObserver) { sizeObserver = new host.ResizeObserver(resize); sizeObserver.observe(stars); }
  else listen(host, "resize", resize);
  if (host.IntersectionObserver) {
    intersection = new host.IntersectionObserver(([entry]) => { inView = entry.isIntersecting; sync(); }, { threshold: 0 });
    intersection.observe(scene);
  }
  measure(); sync();
  return {
    destroy() {
      if (disposed) return;
      disposed = true; sync();
      intersection?.disconnect(); sizeObserver?.disconnect();
      removers.forEach(remove => remove());
    }
  };
}

if (typeof document !== "undefined") mountHomeAI(document.querySelector("#home-ai-scene"));
