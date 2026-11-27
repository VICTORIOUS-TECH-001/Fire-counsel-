import { readFileSync } from "node:fs";
import { test, expect, expectNoHorizontalOverflow, stubFirestore } from "./fixtures.mjs";
import { LEARNING_VIDEO_URL } from "../../home-learning-video.mjs";
import { DEFAULT_CASE_VIDEO_URL } from "../../homepage-media.mjs";

const bundled = JSON.parse(readFileSync(new URL("../../data/site-content.json", import.meta.url), "utf8"));
// Generated 1.1s VP8: black left half, white right half, moving teal stripe.
// Actual decoding/looping/compositing run; only the external media bytes differ.
const fixture = readFileSync(new URL("../fixtures/learning-background.webm", import.meta.url));
const videoSelector = "#learning-background-video";

test.afterEach(async ({ page }) => {
  if (page.isClosed()) return;
  await page.emulateMedia({ reducedMotion: "reduce" });
  if (await page.locator(videoSelector).count()) await expect.poll(() => page.locator(videoSelector).evaluate(video => video.paused)).toBe(true);
});

async function home(page, { failure = false } = {}) {
  const requests = [];
  await page.emulateMedia({ reducedMotion: "reduce" });
  await stubFirestore(page, { content: bundled });
  await page.route(url => url.href === LEARNING_VIDEO_URL, async route => {
    const request = route.request();
    requests.push({ url: request.url(), method: request.method(), authorization: request.headers().authorization });
    return route.fulfill(failure ? { status: 404, body: "Not found" }
      : { status: 200, contentType: "video/webm", body: fixture });
  });
  await page.goto("/"); await page.bringToFront();
  await expect(page.locator("#footer-disclaimer")).toHaveText(bundled.footer.disclaimer);
  await expect(page.locator("#learning")).toHaveAttribute("data-video-state", "reduced");
  await expect(page.locator("#fc-preloader")).toHaveCount(0);
  return requests;
}
async function reveal(page) {
  await page.locator("#learning").evaluate(section => section.scrollIntoView({ block: "start", behavior: "instant" }));
}
async function start(page) {
  await reveal(page); await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(page.locator("#learning")).toHaveAttribute("data-video-state", "playing");
  await expect(page.locator(videoSelector)).toHaveCSS("opacity", "0.32");
}
const luminance = rgb => rgb.slice(0, 3).map(value => {
  value /= 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
}).reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);

test("the supplied learning clip is lazy, silent, inline and really loops without affecting the separate case clip", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 500 });
  const requests = await home(page), video = page.locator(videoSelector);
  await video.evaluate(element => { window.__learningLoops = 0; element.addEventListener("seeking", () => window.__learningLoops++); });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(page.locator("#learning")).not.toBeInViewport();
  await expect(page.locator("#learning")).toHaveAttribute("data-video-state", "paused");
  await expect(video).not.toHaveAttribute("src"); expect(requests).toEqual([]);
  await start(page);
  await expect(video).toHaveAttribute("src", LEARNING_VIDEO_URL);
  expect(await video.evaluate(element => ({ muted: element.muted, defaultMuted: element.defaultMuted, inline: element.playsInline,
    loop: element.loop, controls: element.controls, paused: element.paused, width: element.videoWidth, height: element.videoHeight })))
    .toEqual({ muted: true, defaultMuted: true, inline: true, loop: true, controls: false, paused: false, width: 192, height: 108 });
  await expect.poll(() => page.evaluate(() => window.__learningLoops), { intervals: [100] }).toBeGreaterThanOrEqual(2);
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every(request => request.url === LEARNING_VIDEO_URL && request.method === "GET" && !request.authorization)).toBe(true);
  expect(await page.evaluate(() => window.__firestore.document.caseNotes.videoUrl)).toBe(DEFAULT_CASE_VIDEO_URL);
  expect(await page.evaluate(() => window.__firestore.writes)).toEqual([]);
  await expect(page.locator("#case-cta")).toHaveAttribute("href", "./ai.html?mode=case");
});

test("real black frames disappear into the site backdrop while bright frames stay subtle and the heading/intro retain text contrast", async ({ page }) => {
  await home(page); await start(page);
  const section = page.locator("#learning"), video = page.locator(videoSelector);
  await expect(video).toHaveCSS("mix-blend-mode", "screen");
  await expect(page.locator(".learning-video-shade")).toHaveCSS("background-color", "rgba(10, 8, 32, 0.66)");
  await expect(page.locator(".learning-inner")).toHaveCSS("z-index", "2");
  // Freeze unrelated scripted canvases only for this compositor sample;
  // native video decoding/looping keeps its own real clock. Two thin page
  // clips sample the same four real pixels without transferring/re-decoding
  // an entire page image or depending on locator stability RAFs.
  await page.clock.install(); await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1);
  const { y, width, height } = await section.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { y: rect.top + scrollY, width: innerWidth, height: Math.floor(rect.height) };
  });
  const images = [];
  for (const clip of [{ x: 0, y: y + Math.floor(height / 2), width, height: 1 }, { x: width - 40, y, width: 1, height }]) {
    images.push((await page.screenshot({ clip, fullPage: true, animations: "disabled" })).toString("base64"));
  }
  const pixels = await page.evaluate(async images => {
    const samplers = await Promise.all(images.map(async base64 => {
      const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d"); ctx.drawImage(bitmap, 0, 0);
      return { width: canvas.width, height: canvas.height, color: (x, y) => [...ctx.getImageData(x, y, 1, 1).data].slice(0, 3) };
    }));
    const [row, column] = samplers;
    return { black: row.color(40, 0), white: row.color(row.width - 40, 0),
      top: column.color(0, 0), bottom: column.color(0, column.height - 1) };
  }, images);
  for (const pixel of [pixels.black, pixels.top, pixels.bottom]) {
    for (const [i, channel] of pixel.entries()) expect(Math.abs(channel - [10, 8, 32][i])).toBeLessThanOrEqual(1);
  }
  expect(luminance(pixels.white)).toBeGreaterThan(luminance(pixels.black) + .005);
  for (const [i, channel] of pixels.white.entries()) expect(channel).toBeLessThanOrEqual([38, 37, 58][i]);
  const colors = await section.locator(".section-heading .eyebrow, .section-heading h2, #learning-intro").evaluateAll(nodes => nodes.map(node => getComputedStyle(node).color.match(/[\d.]+/g).slice(0, 3).map(Number)));
  for (const color of colors) expect((luminance(color) + .05) / (luminance(pixels.white) + .05)).toBeGreaterThanOrEqual(4.5);
});

test("the background fills only learning at 320/390/768/1440px with unchanged joins, text and controls", async ({ page }) => {
  await home(page); await start(page);
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 }); await reveal(page);
    const geometry = await page.locator("#learning").evaluate(section => {
      const box = section.getBoundingClientRect(), video = section.querySelector("video").getBoundingClientRect();
      const hero = document.getElementById("home"), ai = document.getElementById("home-ai");
      return { left: box.left, width: box.width, dx: video.x - box.x, dy: video.y - box.y, dw: video.width - box.width, dh: video.height - box.height,
        heroGap: box.top - hero.getBoundingClientRect().bottom, aiGap: ai.getBoundingClientRect().top - box.bottom,
        backgrounds: [section, hero.querySelector(".hero-frame"), ai].map(node => getComputedStyle(node).backgroundColor),
        mask: getComputedStyle(section.querySelector("video")).maskImage };
    });
    expect(geometry.left).toBe(0); expect(geometry.width).toBe(width);
    for (const key of ["dx", "dy", "dw", "dh", "heroGap", "aiGap"]) expect(Math.abs(geometry[key])).toBeLessThanOrEqual(.5);
    expect(geometry.backgrounds).toEqual(Array(3).fill("rgb(10, 8, 32)"));
    expect(geometry.mask).toContain("14%"); expect(geometry.mask).toContain("86%");
    await expect(page.locator(videoSelector)).toHaveCSS("object-fit", "cover");
    await expect(page.locator("#learning-intro")).toHaveText(bundled.learning.intro);
    await expect(page.locator('#learning-cards [role="tab"]')).toHaveCount(4);
    await expectNoHorizontalOverflow(page);
  }
});

test("mouse hover, click, double-click and keyboard focus cannot expose controls or activate the background instead of a learning tool", async ({ page }) => {
  await home(page); await start(page);
  const video = page.locator(videoSelector);
  await video.evaluate(element => {
    window.__learningPointerHits = 0;
    for (const type of ["click", "dblclick", "pointerdown", "contextmenu"]) element.addEventListener(type, () => window.__learningPointerHits++);
  });
  await page.mouse.move(8, 180); await page.mouse.click(8, 180); await page.mouse.dblclick(8, 180);
  await video.evaluate(element => element.focus()); await expect(video).not.toBeFocused();
  expect(await video.evaluate(element => ({ controls: element.controls, inert: element.inert, tab: element.tabIndex,
    pip: element.disablePictureInPicture, remote: element.disableRemotePlayback, paused: element.paused })))
    .toEqual({ controls: false, inert: true, tab: -1, pip: true, remote: true, paused: false });
  await expect(video).toHaveCSS("pointer-events", "none"); await expect(video).toHaveAttribute("aria-hidden", "true");
  await expect(video).not.toHaveAttribute("controls");
  expect(await page.evaluate(() => window.__learningPointerHits)).toBe(0);
  expect(await page.evaluate(() => document.fullscreenElement || document.pictureInPictureElement || null)).toBeNull();
  const tabs = page.locator('#learning-cards [role="tab"]');
  await tabs.first().focus(); await page.keyboard.press("ArrowDown");
  await expect(tabs.nth(1)).toBeFocused(); await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('.learning-pane:not([hidden]) .learning-open')).toHaveAttribute("href", bundled.learning.cards[1].href);
});

test.describe("touch background", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test("tapping the background never shows a player and the original learning tabs remain usable", async ({ page }) => {
    await home(page); await start(page); await page.touchscreen.tap(8, 180);
    await expect(page.locator(videoSelector)).not.toHaveAttribute("controls");
    await expect(page.locator(videoSelector)).not.toBeFocused();
    expect(await page.locator(videoSelector).evaluate(element => element.paused)).toBe(false);
    const tabs = page.locator('#learning-cards [role="tab"]');
    await tabs.nth(2).tap(); await expect(tabs.nth(2)).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('.learning-pane:not([hidden]) .learning-open')).toHaveAttribute("href", bundled.learning.cards[2].href);
  });
});

test("real playback pauses offscreen, while hidden and during page-cache navigation, then resumes without changing its source", async ({ page }) => {
  await home(page); await start(page);
  const video = page.locator(videoSelector);
  await page.locator("#site-footer").evaluate(section => section.scrollIntoView({ block: "start", behavior: "instant" }));
  await expect(video).not.toBeInViewport(); await expect.poll(() => video.evaluate(element => element.paused)).toBe(true);
  await reveal(page); await expect.poll(() => video.evaluate(element => element.paused)).toBe(false);
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, value: true }); document.dispatchEvent(new Event("visibilitychange")); });
  await expect.poll(() => video.evaluate(element => element.paused)).toBe(true);
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event("visibilitychange")); });
  await expect.poll(() => video.evaluate(element => element.paused)).toBe(false);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
  await expect.poll(() => video.evaluate(element => element.paused)).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await expect.poll(() => video.evaluate(element => element.paused)).toBe(false);
  await expect(video).toHaveAttribute("src", LEARNING_VIDEO_URL);
});

test("reduced motion and data saving keep the original plain midnight background without fetching the clip", async ({ page }) => {
  await page.addInitScript(() => {
    const connection = new EventTarget(); connection.saveData = true;
    Object.defineProperty(navigator, "connection", { configurable: true, value: connection }); window.__learningConnection = connection;
  });
  const requests = await home(page); await reveal(page);
  await expect(page.locator(videoSelector)).not.toHaveAttribute("src"); expect(requests).toEqual([]);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(page.locator("#learning")).toHaveAttribute("data-video-state", "data-saver");
  await expect(page.locator(videoSelector)).toHaveCSS("opacity", "0"); expect(requests).toEqual([]);
  await page.evaluate(() => { window.__learningConnection.saveData = false; window.__learningConnection.dispatchEvent(new Event("change")); });
  await expect(page.locator("#learning")).toHaveAttribute("data-video-state", "playing");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(videoSelector)).toHaveCSS("opacity", "0");
  await expect(page.locator("#learning")).toHaveCSS("background-color", "rgb(10, 8, 32)");
});

for (const failure of ["media", "autoplay"]) {
  test(`${failure} failure leaves no black rectangle, controls or play button and does not obstruct the original text/tools`, async ({ page }) => {
    if (failure === "autoplay") await page.addInitScript(() => {
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function (...args) {
        return this.id === "learning-background-video" ? Promise.reject(new DOMException("Autoplay blocked", "NotAllowedError")) : play.apply(this, args);
      };
    });
    await home(page, { failure: failure === "media" }); await reveal(page); await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(page.locator("#learning")).toHaveAttribute("data-video-state", failure === "media" ? "error" : "blocked");
    await expect(page.locator(videoSelector)).toHaveCSS("opacity", "0"); await expect(page.locator(videoSelector)).not.toHaveAttribute("controls");
    await page.mouse.click(8, 180);
    await expect(page.locator(videoSelector)).toHaveCSS("opacity", "0");
    await expect(page.locator("#learning-intro")).toHaveText(bundled.learning.intro);
    await page.locator('#learning-cards [role="tab"]').nth(3).click();
    await expect(page.locator('.learning-pane:not([hidden]) .learning-open')).toHaveAttribute("href", bundled.learning.cards[3].href);
  });
}

test("missing background script leaves the original learning copy/tools and site background intact", async ({ page }) => {
  await stubFirestore(page, { content: bundled });
  await page.route("**/home-learning-video.mjs", route => route.abort("blockedbyclient"));
  await page.goto("/"); await page.bringToFront();
  await expect(page.locator("#learning-cards")).toHaveAttribute("data-enhanced", "true");
  await expect(page.locator("#fc-preloader")).toHaveCount(0); await reveal(page);
  await expect(page.locator(videoSelector)).toHaveCSS("opacity", "0"); await expect(page.locator(videoSelector)).not.toHaveAttribute("src");
  await expect(page.locator("#learning-intro")).toHaveText(bundled.learning.intro);
  await expect(page.locator("#learning")).toHaveCSS("background-color", "rgb(10, 8, 32)");
  await expect(page.locator("#exam-ready-title")).toHaveText("Make You Exam Ready Note");
  await expect(page.locator("#case-cta")).toHaveAttribute("href", "./ai.html?mode=case");
});
