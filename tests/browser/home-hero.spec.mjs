import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test, expect, expectNoHorizontalOverflow, stubAuth, stubFirestore } from "./fixtures.mjs";

const bundled = JSON.parse(readFileSync(new URL("../../data/site-content.json", import.meta.url), "utf8"));

async function readyHome(page) {
  await page.goto("/");
  await expect(page.locator("#learning-cards > *")).toHaveCount(4);
}

async function expectSingleHero(page) {
  const hero = page.locator("#home");
  await expect(hero.locator("h1")).toHaveText("Fire Counsel");
  await expect(hero.locator("h1")).toHaveCSS("font-weight", "800");
  await expect(hero.locator(".hero-tagline")).toHaveText("Ignite your legal intelligence");
  await expect(hero.locator("a")).toHaveCount(1);
  await expect(hero.getByRole("link", { name: "Sign up", exact: true })).toHaveAttribute("href", "./auth.html");
  await expect(hero).toHaveText("Fire Counsel Ignite your legal intelligence Sign up");
  await expect(hero.locator('img, .eyebrow, .hero-slide, .hero-controls, .hero-secondary, [aria-roledescription="carousel"]')).toHaveCount(0);
  await expect(page.locator("#slide-prev, #slide-next, #hero-dots, #hero-count")).toHaveCount(0);
}

function legacyContent() {
  const content = structuredClone(bundled);
  content.hero.autoplayMs = 4000;
  content.hero.slides = [1, 2].map(index => ({
    ...bundled.hero.slides[0],
    title: `Old slide ${index}`, accent: "Do not restore <img src=x onerror=alert(1)>.",
    body: "Organise notes, build personal case cards and practise deliberately. Your saved study files stay in this browser in this preview.",
    image: `./assets/images/retired-slide-${index}.jpg`,
    primaryLabel: "Open student workspace", primaryHref: "./study.html#dashboard",
    secondaryLabel: "Explore study space", secondaryHref: "#learning"
  }));
  return content;
}

test("single hero shows bold Fire Counsel, its tagline and only Sign up", async ({ page }) => {
  await readyHome(page);
  await expectSingleHero(page);
  await expect(page.locator("#hero-streams")).toBeVisible();
  await expect(page.locator("#brand-name")).toHaveText("FIRE COUNSEL");
  await expect(page.locator("#brand-image")).toHaveAttribute("src", "./assets/images/fire-counsel-flame.png");
  await expect(page.locator("#case-image")).toHaveAttribute("src", bundled.caseNotes.image);
  await expect(page.locator("#case-intro")).toHaveText(bundled.caseNotes.intro);
  await expect(page.locator("#article-grid > *")).toHaveCount(bundled.articles.items.length);
  await expect(page.locator("#footer-disclaimer")).toHaveText(bundled.footer.disclaimer);
});

test("the reference background and centered hero fit 320, 390, 768 and 1440 pixels without changing the logo", async ({ page }) => {
  await readyHome(page);
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await expectNoHorizontalOverflow(page);
    const frame = await page.locator(".hero-frame").boundingBox();
    const heading = await page.locator("#home h1").boundingBox();
    const signup = await page.locator("#home .hero-signup").boundingBox();
    expect(frame.x).toBe(0);
    expect(frame.width).toBe(width);
    expect(Math.abs(heading.x + heading.width / 2 - width / 2)).toBeLessThanOrEqual(1);
    expect(signup.x).toBeGreaterThanOrEqual(16);
    expect(signup.x + signup.width).toBeLessThanOrEqual(width - 16);
    expect(signup.height).toBeGreaterThanOrEqual(44);
    await expect(page.locator(".hero-frame")).toHaveCSS("background-color", "rgb(10, 8, 32)");
    const bounds = await page.locator("#hero-streams").evaluate(canvas => ({
      width: canvas.width, height: canvas.height,
      cssWidth: canvas.getBoundingClientRect().width, cssHeight: canvas.getBoundingClientRect().height,
      mask: getComputedStyle(canvas).maskImage
    }));
    expect(bounds.width).toBeLessThanOrEqual(Math.ceil(bounds.cssWidth * 2));
    expect(bounds.height).toBeLessThanOrEqual(Math.ceil(bounds.cssHeight * 2));
    expect(bounds.mask).toContain("70%");
    await expect(page.locator("#brand-image")).toHaveCSS("object-fit", "contain");
    await expect(page.locator("#brand-image")).toHaveAttribute("src", "./assets/images/fire-counsel-flame.png");
    if (process.env.SHOT_DIR) {
      await mkdir(process.env.SHOT_DIR, { recursive: true });
      await expect(page.locator("#fc-preloader")).toBeHidden();
      await page.screenshot({ path: join(process.env.SHOT_DIR, `home-hero-${width}.png`) });
    }
  }
});

test("legacy published slides cannot restore deleted photos, text or carousel", async ({ page }) => {
  const content = legacyContent();
  content.learning.intro = "Published lower-page content still works.";
  const retiredPhotos = [];
  page.on("request", request => { if (request.url().includes("retired-slide-")) retiredPhotos.push(request.url()); });
  await page.clock.install();
  await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1000);
  await stubFirestore(page, { content });
  await readyHome(page);
  await expect(page.locator("#learning-intro")).toHaveText(content.learning.intro);
  await expectSingleHero(page);
  // Advance beyond several old autoplay intervals: no slide or CTA returns.
  await page.clock.runFor(16000);
  await expectSingleHero(page);
  expect(retiredPhotos).toEqual([]);
  expect(await page.evaluate(() => window.__firestore.writes)).toEqual([]);
});

test("unsaved preview preserves other content without reviving the removed slides", async ({ page }) => {
  const content = legacyContent();
  content.learning.intro = "Unsaved lower-page preview remains available.";
  await readyHome(page);
  const opened = page.waitForEvent("popup");
  await page.evaluate(content => {
    const send = event => {
      if (event.origin !== location.origin || event.data?.type !== "fire-counsel-preview-ready") return;
      event.source.postMessage({ type: "fire-counsel-preview", content }, location.origin);
      window.removeEventListener("message", send);
    };
    window.addEventListener("message", send);
    window.open("/?preview=1", "single-hero-preview");
  }, content);
  const preview = await opened;
  const errors = [];
  preview.on("pageerror", error => errors.push(error.message));
  try {
    await expect(preview.locator("#preview-banner")).toContainText("PREVIEW");
    await expect(preview.locator("#learning-intro")).toHaveText(content.learning.intro);
    await expectSingleHero(preview);
    await expect(preview.locator("#case-image")).toHaveAttribute("src", bundled.caseNotes.image);
    expect(errors).toEqual([]);
  } finally {
    await preview.close();
  }
});

test("light streams really animate, pause offscreen and respect changes to reduced motion", async ({ page }) => {
  // Drive the production RAF callbacks at explicit frame times, not through
  // wall-clock polling: native headless frame/timer delivery can stop entirely.
  await page.clock.install();
  await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1000);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await readyHome(page);
  await page.bringToFront();
  const canvas = page.locator("#hero-streams");
  await expect(canvas).toHaveAttribute("data-motion", "running");
  await page.clock.runFor(32);
  const before = await canvas.evaluate(element => element.toDataURL());
  // Advance the production callbacks into a real canvas. No app drawing,
  // pixels or elapsed-time calculation is replaced by a test implementation.
  await page.clock.runFor(100);
  expect(await canvas.evaluate(element => element.toDataURL()), "the production loop really moves its highlights after 100ms of frames").not.toBe(before);
  await page.evaluate(() => document.getElementById("learning").scrollIntoView({ behavior: "instant" }));
  await expect(canvas).toHaveAttribute("data-motion", "paused");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(canvas).toHaveAttribute("data-motion", "reduced");
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await expect(page.locator("#home .hero-word").first()).toHaveCSS("animation-name", "none");
  await expect(page.locator("#home .hero-word").first()).toHaveCSS("opacity", "1");
  await expect(page.locator(".hero-glow")).toHaveCSS("animation-name", "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(canvas).toHaveAttribute("data-motion", "running");
  await expect(page.locator("#home .hero-word").first()).toHaveCSS("animation-name", "homeWordIn");
});

test("actual canvas pixels travel upward along the template's converging paths", async ({ page }) => {
  await readyHome(page);
  const result = await page.evaluate(async () => {
    const { streamCurve, drawHeroStreams } = await import("/home-hero.mjs");
    const canvas = document.createElement("canvas");
    canvas.width = 200; canvas.height = 460;
    const context = canvas.getContext("2d");
    const line = { u: 0, col: "46,230,166", sp: .6, off: 320, len: 60, w: 1.2, a: .6 };
    const curve = streamCurve(200, 460, line);
    const path = new Path2D();
    path.moveTo(...curve.start);
    path.bezierCurveTo(...curve.control1, ...curve.control2, ...curve.end);
    const center = time => {
      drawHeroStreams(context, 200, 460, [line], [path], time);
      const pixels = context.getImageData(0, 0, 200, 460).data;
      let weight = 0, sum = 0;
      for (let y = 0; y < 460; y++) for (let x = 0; x < 200; x++) {
        const alpha = pixels[(y * 200 + x) * 4 + 3];
        weight += alpha; sum += y * alpha;
      }
      return { y: sum / weight, weight };
    };
    return { before: center(0), after: center(100) };
  });
  expect(result.before.weight).toBeGreaterThan(0);
  expect(result.after.weight).toBeGreaterThan(0);
  expect(result.after.y, "the real highlight moves toward the top, not down toward the text").toBeLessThan(result.before.y - 2);
});

test("static hero fallback retains the brand, readable copy and Google-only Sign up destination", async ({ page }) => {
  await stubAuth(page);
  await page.route("**/site.js", route => route.abort("blockedbyclient"));
  await page.route("**/home-hero.mjs", route => route.abort("blockedbyclient"));
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/");
  await expect(page.locator("#brand-name")).toHaveText("FIRE COUNSEL");
  await expectSingleHero(page);
  await expectNoHorizontalOverflow(page);
  await page.locator("#home .hero-signup").click();
  await expect(page).toHaveURL(/\/auth\.html$/);
  await expect(page.locator("#google-signin-button")).toBeVisible();
  await expect(page.locator('input[type="email"], input[type="password"]')).toHaveCount(0);
});
