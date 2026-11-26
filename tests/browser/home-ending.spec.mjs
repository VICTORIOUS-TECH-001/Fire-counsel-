import { readFileSync } from "node:fs";
import { test, expect, expectNoHorizontalOverflow, stubFirestore } from "./fixtures.mjs";
import { validateSiteContent } from "../../firebase/content-schema.mjs";

const bundled = JSON.parse(readFileSync(new URL("../../data/site-content.json", import.meta.url), "utf8"));
const clockedPages = new WeakSet();

// Stop real canvas/CSS work before Playwright restores virtual time and closes
// the context. Otherwise pending native frames can race the next context's CDP
// setup, even though the preceding animation assertions have already passed.
test.afterEach(async ({ page }) => {
  if (page.isClosed()) return;
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll("canvas[data-motion]")]
    .every(canvas => canvas.dataset.motion !== "running")), { intervals: [100] }).toBe(true);
});

async function home(page, content = bundled, { clocked = true } = {}) {
  expect(validateSiteContent(content)).toEqual({ ok: true, errors: [] });
  if (clocked) { await page.clock.install(); clockedPages.add(page); }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await stubFirestore(page, { content });
  await page.goto("/"); await page.bringToFront();
  await expect(page.locator("#footer-disclaimer")).toHaveText(content.footer.disclaimer);
  if (clocked) await page.clock.runFor(1800);
  await expect.poll(() => page.evaluate(() => document.querySelector("#fc-preloader") === null), { intervals: [100] }).toBe(true);
  if (clocked) await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1000);
}
async function flatScene(page) {
  await expect.poll(async () => {
    await page.clock.runFor(32);
    return page.locator("#exam-ready").evaluate(section => Number.parseFloat(section.style.getPropertyValue("--ending-tilt")));
  }, { intervals: [100] }).toBeLessThan(1);
}
async function reveal(page, selector = "#exam-ready") {
  await page.locator(selector).evaluate(element => element.scrollIntoView({ block: "start", behavior: "instant" }));
  if (clockedPages.has(page)) await page.clock.runFor(64);
}

test("the closing note and footer use only Fire Counsel words, original links, logo and disclaimer", async ({ page }) => {
  await home(page); await reveal(page);
  await expect(page.locator("#exam-ready-title")).toHaveText("Make You Exam Ready Note");
  await expect(page.locator("#exam-ready-intro")).toHaveText("Open your local-first study space and start with one subject, one case or one focused session.");
  await expect(page.locator(".ending-action")).toHaveAttribute("href", "./study.html#dashboard");
  await expect(page.locator(".ending-brand img")).toHaveAttribute("src", "./assets/images/fire-counsel-flame.png");
  await expect(page.locator(".footer-mark strong")).toHaveText(bundled.brand.name);
  await expect(page.locator(".footer-brand > p")).toHaveText(bundled.footer.summary);
  await expect(page.locator("#copyright-text")).toHaveText(bundled.footer.copyright);
  const links = await page.locator("#footer-main .footer-column").evaluateAll(columns => columns.map(column => ({
    title: column.querySelector("h3").textContent,
    items: [...column.querySelectorAll("a")].map(link => ({ label: link.textContent, href: link.getAttribute("href") }))
  })));
  expect(links).toEqual(bundled.footer.columns);
  await expect(page.locator(".ending-footer-card")).toHaveCount(1);
  await expect(page.locator("body")).not.toContainText(/Projexion|Construction Management|Set up a Demo|Solutions by Customer/);
  await expect(page.locator("#home h1")).toHaveText("Fire Counsel");
  await expect(page.locator(".home-ai-chip")).toHaveCount(6);
  await expect(page.locator("#case-video")).not.toHaveAttribute("controls");
  expect(await page.evaluate(() => window.__firestore.writes)).toEqual([]);
});

test("double frame, readable words, action and glowing footer fit 320/390/768/1440px without overlap or overflow", async ({ page }) => {
  // Layout uses native resize/scroll delivery under reduced motion; freezing
  // renderer time is only necessary for tests that sample animation frames.
  await home(page, bundled, { clocked: false });
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 }); await reveal(page);
    const geometry = await page.evaluate(() => {
      const box = selector => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
      };
      return { section: box("#exam-ready"), frame: box(".ending-frame"), inner: box(".ending-inner"), action: box(".ending-action"),
        footer: box(".ending-footer-card"), title: box("#exam-ready-title"),
        words: [...document.querySelectorAll(".ending-word")].map(word => {
          const rect = word.getBoundingClientRect(); return { left: rect.left, right: rect.right, opacity: getComputedStyle(word).opacity, filter: getComputedStyle(word).filter };
        }),
        canvas: { width: document.getElementById("exam-ready-streams").width, css: document.getElementById("exam-ready-streams").getBoundingClientRect().width }
      };
    });
    expect(geometry.section.left).toBe(0); expect(geometry.section.width).toBe(width);
    expect(geometry.frame.left).toBeGreaterThanOrEqual(16); expect(geometry.frame.right).toBeLessThanOrEqual(width - 16);
    expect(geometry.inner.left).toBeGreaterThan(geometry.frame.left); expect(geometry.inner.right).toBeLessThan(geometry.frame.right);
    expect(geometry.action.height).toBeGreaterThanOrEqual(44);
    expect(geometry.action.left).toBeGreaterThan(geometry.inner.left); expect(geometry.action.right).toBeLessThan(geometry.inner.right);
    expect(geometry.footer.top - geometry.action.bottom).toBeGreaterThanOrEqual(56);
    expect(Math.abs(geometry.footer.top - geometry.section.bottom + 80)).toBeLessThanOrEqual(.1);
    expect(geometry.canvas.width).toBeLessThanOrEqual(Math.ceil(geometry.canvas.css * 2));
    for (const word of geometry.words) {
      expect(word.left).toBeGreaterThanOrEqual(geometry.inner.left); expect(word.right).toBeLessThanOrEqual(geometry.inner.right);
      expect(word.opacity).toBe("1"); expect(word.filter).toBe("none");
    }
    await expect(page.locator("#exam-ready")).toHaveCSS("background-color", "rgb(10, 8, 32)");
    await expect(page.locator(".ending-frame")).toHaveCSS("border-radius", "20px");
    await expect(page.locator(".ending-inner")).toHaveCSS("border-radius", "14px");
    await expect(page.locator(".ending-footer-card")).toHaveCSS("border-radius", "18px");
    await reveal(page, "#site-footer");
    const links = await page.locator("#footer-main a").evaluateAll(nodes => nodes.map(node => {
      const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, height: r.height };
    }));
    for (const link of links) { expect(link.left).toBeGreaterThanOrEqual(14); expect(link.right).toBeLessThanOrEqual(width - 14); expect(link.height).toBeGreaterThanOrEqual(44); }
    await expectNoHorizontalOverflow(page);
  }
});

test("real closing canvas frames move, stop offscreen and respond to reduced motion", async ({ page }) => {
  await home(page); await reveal(page);
  const canvas = page.locator("#exam-ready-streams");
  await expect(canvas).toHaveAttribute("data-painted", "true");
  const still = await canvas.evaluate(element => element.toDataURL());
  expect(still.length).toBeGreaterThan(1000);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(canvas).toHaveAttribute("data-motion", "running");
  await page.clock.runFor(32); const before = await canvas.evaluate(element => element.toDataURL());
  await page.clock.runFor(100); expect(await canvas.evaluate(element => element.toDataURL())).not.toBe(before);
  await reveal(page, "#learning"); await expect(canvas).toHaveAttribute("data-motion", "paused");
  await expect(page.locator("#site-footer")).toHaveAttribute("data-motion", "paused");
  await page.emulateMedia({ reducedMotion: "reduce" }); await reveal(page);
  await expect(canvas).toHaveAttribute("data-motion", "reduced");
  for (const word of await page.locator(".ending-word").all()) { await expect(word).toHaveCSS("opacity", "1"); await expect(word).toHaveCSS("filter", "none"); }
  await expect(page.locator(".ending-frame")).toHaveCSS("transform", "none");
});

test("closing playback stops while hidden and across page-cache navigation without duplicate animation loops", async ({ page }) => {
  await home(page); await reveal(page); await page.emulateMedia({ reducedMotion: "no-preference" });
  const canvas = page.locator("#exam-ready-streams");
  await expect(canvas).toHaveAttribute("data-motion", "running");
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, value: true }); document.dispatchEvent(new Event("visibilitychange")); });
  await expect(canvas).toHaveAttribute("data-motion", "paused");
  await expect(page.locator("#site-footer")).toHaveAttribute("data-motion", "paused");
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event("visibilitychange")); });
  await expect(canvas).toHaveAttribute("data-motion", "running");
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
  await expect(canvas).toHaveAttribute("data-motion", "paused");
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await expect(canvas).toHaveAttribute("data-motion", "running");
});

test("actual closing highlights travel upward from the wide base toward the neck", async ({ page }) => {
  await home(page);
  const result = await page.evaluate(async () => {
    const { endingStreamCurve, drawEndingStreams } = await import("/home-ending.mjs");
    const canvas = document.createElement("canvas"); canvas.width = 200; canvas.height = 420;
    const context = canvas.getContext("2d"), line = { u: 0, col: "46,230,166", sp: .6, off: 180, len: 60, w: 1.2, a: .6 };
    const curve = endingStreamCurve(200, 420, line), path = new Path2D();
    path.moveTo(...curve.start); path.bezierCurveTo(...curve.control1, ...curve.control2, ...curve.end);
    const center = time => {
      drawEndingStreams(context, 200, 420, [line], [path], time);
      const pixels = context.getImageData(0, 0, 200, 420).data; let weight = 0, sum = 0;
      for (let y = 0; y < 420; y++) for (let x = 0; x < 200; x++) { const alpha = pixels[(y * 200 + x) * 4 + 3]; weight += alpha; sum += y * alpha; }
      return { y: sum / weight, weight };
    };
    return { before: center(0), after: center(100) };
  });
  expect(result.before.weight).toBeGreaterThan(0); expect(result.after.weight).toBeGreaterThan(0);
  expect(result.after.y).toBeLessThan(result.before.y - 2);
});

test("the seven-second footer border really changes gradient angle without rotating its content", async ({ page }) => {
  await home(page); await reveal(page, "#site-footer"); await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(page.locator("#site-footer")).toHaveAttribute("data-motion", "running");
  const border = await page.locator(".ending-footer-card").evaluate(card => {
    const animation = document.getAnimations().find(item => item.animationName === "endingBorderAngle");
    if (!animation) throw new Error("Conic border animation missing");
    animation.currentTime = 0; const before = getComputedStyle(card, "::before").backgroundImage;
    animation.currentTime = 1750; const after = getComputedStyle(card, "::before").backgroundImage;
    return { before, after, duration: animation.effect.getTiming().duration, state: getComputedStyle(card, "::before").animationPlayState,
      transform: getComputedStyle(card).transform, contentTransform: getComputedStyle(card.querySelector("#footer-main")).transform };
  });
  expect(border.duration).toBe(7000); expect(border.state).toBe("running");
  expect(border.before).not.toBe(border.after); expect(border.after).toContain("conic-gradient");
  expect(border.transform).toBe("none"); expect(border.contentTransform).toBe("none");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await page.locator(".ending-footer-card").evaluate(card => getComputedStyle(card, "::before").animationName)).toBe("none");
  expect(await page.locator(".ending-footer-card").evaluate(card => getComputedStyle(card, "::before").backgroundImage)).toContain("conic-gradient");
});

test("the double frame flattens and its staggered words finish fully visible as the note scrolls in", async ({ page }) => {
  // Native scroll/RAF delivery is the behaviour under test here, not a virtual
  // clock racing its queued IntersectionObserver and media-query callbacks.
  await home(page, bundled, { clocked: false }); await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(() => window.scrollTo({ top: document.getElementById("exam-ready").offsetTop - innerHeight + 40, behavior: "instant" }));
  await expect(page.locator("#exam-ready")).toHaveAttribute("data-motion", "running");
  await expect.poll(() => page.locator("#exam-ready").evaluate(section => Number.parseFloat(section.style.getPropertyValue("--ending-tilt"))),
    { intervals: [100] }).toBeGreaterThan(12);
  await page.locator("#exam-ready").evaluate(element => element.scrollIntoView({ block: "start", behavior: "instant" }));
  await expect.poll(() => page.locator("#exam-ready").evaluate(section => Number.parseFloat(section.style.getPropertyValue("--ending-tilt"))),
    { intervals: [100] }).toBeLessThan(1);
  for (const word of await page.locator(".ending-word").all()) { await expect(word).toHaveCSS("opacity", "1"); await expect(word).toHaveCSS("filter", "none"); }
});

test("the silver action responds to a real mouse but resets for keyboard focus and reduced motion", async ({ page }) => {
  await home(page); await reveal(page); await page.emulateMedia({ reducedMotion: "no-preference" }); await page.clock.runFor(64);
  await expect(page.locator("#exam-ready-streams")).toHaveAttribute("data-motion", "running");
  await flatScene(page);
  const action = page.locator(".ending-action"), box = await action.boundingBox();
  await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2);
  expect(await action.evaluate(link => link.style.getPropertyValue("--ending-magnet-x"))).toBe("12px");
  await page.keyboard.press("Tab"); await action.focus(); await expect(action).toBeFocused();
  expect(await action.evaluate(link => link.style.getPropertyValue("--ending-magnet-x"))).toBe("");
  await expect(action).toHaveCSS("outline-style", "solid");
  await expect(action).toHaveAttribute("href", "./study.html#dashboard");
  await page.emulateMedia({ reducedMotion: "reduce" }); await expect(action).toHaveCSS("transform", "none");
  await reveal(page, "#site-footer");
  await page.locator(".footer-column a").first().focus(); await expect(page.locator(".footer-column a").first()).toBeFocused();
});

test.describe("touch input", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test("touch cannot magnetically displace the action and all footer links stay usable", async ({ page }) => {
    await home(page); await reveal(page); await page.emulateMedia({ reducedMotion: "no-preference" }); await page.clock.runFor(64);
    const action = page.locator(".ending-action");
    await action.dispatchEvent("pointermove", { pointerType: "touch", clientX: 200, clientY: 200 });
    expect(await action.evaluate(link => link.style.getPropertyValue("--ending-magnet-x"))).toBe("");
    await expect(action).toHaveAttribute("href", "./study.html#dashboard");
    await reveal(page, "#site-footer");
    await page.getByRole("link", { name: "Back to top" }).tap(); await page.clock.runFor(800);
    expect(await page.evaluate(() => location.hash)).toBe("#home");
    await expectNoHorizontalOverflow(page);
  });
});

for (const failure of ["script", "canvas"]) {
  test(`a missing ${failure} keeps the heading, photo-free double frame, footer and destinations readable`, async ({ page }) => {
    if (failure === "script") await page.route("**/home-ending.mjs", route => route.abort("blockedbyclient"));
    else await page.addInitScript(() => { const get = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (...args) { return this.id === "exam-ready-streams" ? null : get.apply(this, args); }; });
    await home(page); await reveal(page);
    await expect(page.locator("#exam-ready-title")).toHaveText("Make You Exam Ready Note");
    for (const word of await page.locator(".ending-word").all()) await expect(word).toHaveCSS("opacity", "1");
    await expect(page.locator(".ending-action")).toHaveAttribute("href", "./study.html#dashboard");
    await expect(page.locator("#footer-disclaimer")).toHaveText(bundled.footer.disclaimer);
    await reveal(page, "#site-footer"); await expectNoHorizontalOverflow(page);
  });
}

test("published footer words remain escaped, preserve all links and wrap long mobile edits without writes", async ({ page }) => {
  const content = structuredClone(bundled);
  content.footer.summary = '<img src=x onerror="window.__footerInjected=true"> ' + "Study notes ".repeat(18);
  content.footer.columns[0].title = "RevisionandCasePreparation".repeat(3);
  content.footer.columns[0].items[0].label = "Openyourlegalstudynotes".repeat(4);
  content.footer.copyright = "© 2026 FIRE COUNSEL. Powered by Victorious Tech Institute.";
  await page.setViewportSize({ width: 320, height: 1000 }); await home(page, content); await reveal(page, "#site-footer");
  await expect(page.locator(".footer-brand > p")).toHaveText(content.footer.summary);
  await expect(page.locator("#footer-main img")).toHaveCount(1);
  await expect(page.locator("#copyright-text")).toHaveText(content.footer.copyright);
  await expect(page.locator(".footer-column a").first()).toHaveAttribute("href", content.footer.columns[0].items[0].href);
  expect(await page.evaluate(() => window.__footerInjected || false)).toBe(false);
  expect(await page.evaluate(() => window.__firestore.writes)).toEqual([]);
  await expectNoHorizontalOverflow(page);
});
