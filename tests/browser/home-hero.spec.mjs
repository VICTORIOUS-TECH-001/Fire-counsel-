import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test, expect, expectNoHorizontalOverflow, stubAuth, stubFirestore } from "./fixtures.mjs";

const bundled = JSON.parse(readFileSync(new URL("../../data/site-content.json", import.meta.url), "utf8"));

async function readyHome(page) {
  await page.goto("/");
  await expect(page.locator("#hero-slides .hero-slide")).toHaveCount(bundled.hero.slides.length);
}

test("the new hero keeps the FIRE COUNSEL copy and logo, with Sign up instead of a demo", async ({ page }) => {
  await readyHome(page);
  const hero = page.locator("#home");
  const active = hero.locator(".hero-slide.is-active");
  await expect(page.locator("#hero-streams")).toBeVisible();
  await expect(active.locator("h1")).toContainText("Build legal clarity.");
  await expect(active.locator("h1")).toContainText("Move with confidence.");
  await expect(active.locator(".eyebrow")).toHaveText(bundled.hero.slides[0].eyebrow);
  await expect(active.locator("p")).toHaveText("A focused home for your law courses, case recall and exam practice, designed to keep your own study work close to you.");
  await expect(active.getByRole("link", { name: "Sign up", exact: true })).toHaveAttribute("href", "./auth.html");
  await expect(active.getByRole("link", { name: "See the study tools", exact: true })).toHaveAttribute("href", "#learning");
  await expect(page.locator("#brand-name")).toHaveText("FIRE COUNSEL");
  await expect(page.locator("#brand-image")).toHaveAttribute("src", "./assets/images/fire-counsel-flame.png");
  await expect(hero).not.toContainText(/Projexion|construction data|set up a demo|[—–]/i);
  await expect(hero.locator("img, .dash, .dash-stage")).toHaveCount(0);
  await expect(page.locator("#learning-cards > *")).toHaveCount(4);
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
    const heading = await page.locator(".hero-slide.is-active h1").boundingBox();
    const signup = await page.locator(".hero-slide.is-active .hero-signup").boundingBox();
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

test("old published hero defaults get Sign up, while custom text, safe links and carousel editing still work", async ({ page }) => {
  const content = structuredClone(bundled);
  Object.assign(content.hero.slides[0], {
    primaryLabel: "Open student workspace", primaryHref: "./study.html#dashboard",
    body: "A focused home for your law courses, case recall and exam practice — designed to keep your own study work close to you."
  });
  Object.assign(content.hero.slides[1], {
    title: "Published study guidance", accent: "Keep <img src=x onerror=alert(1)> as text.",
    primaryLabel: "Visit the legal links", primaryHref: "#resources"
  });
  await stubFirestore(page, { content });
  await readyHome(page);
  await expect(page.locator(".hero-slide.is-active .hero-signup")).toHaveText("Sign up");
  await expect(page.locator(".hero-slide.is-active p")).not.toContainText("—");
  await page.locator("#slide-next").click();
  await expect(page.locator("#hero-count")).toHaveText("02 / 02");
  await expect(page.locator(".hero-slide.is-active h1")).toContainText(content.hero.slides[1].title);
  await expect(page.locator(".hero-slide.is-active h1")).toContainText(content.hero.slides[1].accent);
  await expect(page.locator(".hero-slide.is-active .hero-signup")).toHaveText("Visit the legal links");
  await expect(page.locator(".hero-slide.is-active .hero-signup")).toHaveAttribute("href", "#resources");
  await expect(page.locator("#hero-slides img")).toHaveCount(0);
  expect(await page.evaluate(() => window.__firestore.writes)).toEqual([]);
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
  await expect(page.locator(".hero-slide.is-active .hero-word").first()).toHaveCSS("animation-name", "none");
  await expect(page.locator(".hero-slide.is-active .hero-word").first()).toHaveCSS("opacity", "1");
  await expect(page.locator(".hero-glow")).toHaveCSS("animation-name", "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(canvas).toHaveAttribute("data-motion", "running");
  await expect(page.locator(".hero-slide.is-active .hero-word").first()).toHaveCSS("animation-name", "homeWordIn");
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
  await expect(page.locator(".hero-slide.is-active h1")).toContainText("Build legal clarity.");
  await expect(page.locator("#slide-next")).toBeDisabled();
  await expectNoHorizontalOverflow(page);
  await page.locator(".hero-slide.is-active .hero-signup").click();
  await expect(page).toHaveURL(/\/auth\.html$/);
  await expect(page.locator("#google-signin-button")).toBeVisible();
  await expect(page.locator('input[type="email"], input[type="password"]')).toHaveCount(0);
});
