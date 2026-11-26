import { readFileSync } from "node:fs";
import { test, expect, expectNoHorizontalOverflow, stubFirestore } from "./fixtures.mjs";
import { CASE_VIDEO_ORIGIN, DEFAULT_CASE_VIDEO_URL } from "../../homepage-media.mjs";

const bundled = JSON.parse(readFileSync(new URL("../../data/site-content.json", import.meta.url), "utf8"));
const fixture = readFileSync(new URL("../fixtures/case-loop.webm", import.meta.url));

async function home(page, { content = bundled, failure = false } = {}) {
  const requests = [];
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await stubFirestore(page, { content });
  // Exercise real decoding/looping, replacing only the external media bytes.
  // No live provider, Firebase write or R2 traffic is permitted in this suite.
  await page.route(`${CASE_VIDEO_ORIGIN}/**`, async route => {
    requests.push({ url: route.request().url(), method: route.request().method(), headers: route.request().headers() });
    await route.fulfill(failure ? { status: 404, contentType: "text/plain", body: "Not found" }
      : { status: 200, contentType: "video/webm", body: fixture });
  });
  await page.goto("/");
  await page.bringToFront();
  await expect.poll(() => page.locator("#cases .case-image").getAttribute("data-video-state"), { intervals: [100] }).toBe("reduced");
  await page.clock.runFor(1800);
  await expect.poll(() => page.evaluate(() => document.querySelector("#fc-preloader") === null), { intervals: [100] }).toBe(true);
  // Freeze page timers only after the real preloader finishes. HTML video
  // decoding and native looping still use the real media clock; unrelated
  // decorative canvas RAFs must not compete with virtual frame catch-up.
  await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1000);
  return requests;
}
async function reveal(page) {
  await page.locator("#cases .case-image").evaluate(element => element.scrollIntoView({ block: "center", behavior: "instant" }));
}
async function start(page) {
  await reveal(page);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  // Observe from the runner clock, independent of paused page timers/RAFs.
  await expect.poll(() => page.locator("#cases .case-image").getAttribute("data-video-state"), { intervals: [100] }).toBe("playing");
}

test("the supplied R2 clip autoplays muted and inline in the marked panel, then really loops without a replay click", async ({ page }) => {
  const requests = await home(page);
  const video = page.locator("#case-video");
  expect(requests).toEqual([]);
  await expect(video).not.toHaveAttribute("src");
  await video.evaluate(element => {
    window.__caseLoopCount = 0;
    element.addEventListener("seeking", () => { window.__caseLoopCount++; });
  });
  await start(page);
  await expect(video).toHaveAttribute("src", DEFAULT_CASE_VIDEO_URL);
  const playback = await video.evaluate(element => ({ muted: element.muted, defaultMuted: element.defaultMuted, loop: element.loop, inline: element.playsInline, width: element.videoWidth, paused: element.paused, controls: element.controls }));
  expect(playback).toEqual({ muted: true, defaultMuted: true, loop: true, inline: true, width: 64, paused: false, controls: true });
  await expect.poll(() => page.evaluate(() => window.__caseLoopCount), { intervals: [100] }).toBeGreaterThanOrEqual(2);
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every(item => item.url === DEFAULT_CASE_VIDEO_URL && item.method === "GET" && !item.headers.authorization)).toBe(true);
  await expect(page.locator("#case-status")).toHaveText(bundled.caseNotes.status);
  await expect(page.locator("#case-image")).toHaveAttribute("src", bundled.caseNotes.image);
  await expect(page.locator("#home h1")).toHaveText("Fire Counsel");
  await expect(page.locator(".home-ai-chip")).toHaveCount(6);
  expect(await page.evaluate(() => window.__firestore.writes)).toEqual([]);
});

test("the video keeps the same rounded media box, visible stamp and no overflow at four viewport widths", async ({ page }) => {
  await home(page);
  await start(page);
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await reveal(page);
    await expect(page.locator("#case-video")).toHaveCSS("object-fit", "cover");
    const bounds = await page.locator("#cases .case-image").evaluate(panel => {
      const media = panel.querySelector("video").getBoundingClientRect(), box = panel.getBoundingClientRect();
      return { dx: media.x - box.x, dy: media.y - box.y, dw: media.width - box.width, dh: media.height - box.height, radius: getComputedStyle(panel).borderRadius };
    });
    for (const key of ["dx", "dy", "dw", "dh"]) expect(Math.abs(bounds[key])).toBeLessThanOrEqual(.1);
    expect(bounds.radius).toBe("24px");
    await expect(page.locator("#case-status")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }
});

test("reduced motion and live data-saver changes leave the original photo and do not fetch the video", async ({ page }) => {
  await page.addInitScript(() => {
    const connection = new EventTarget(); connection.saveData = true;
    Object.defineProperty(navigator, "connection", { configurable: true, value: connection });
    window.__caseConnection = connection;
  });
  const requests = await home(page);
  await reveal(page);
  await expect(page.locator("#case-video")).not.toHaveAttribute("src");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(page.locator("#cases .case-image")).toHaveAttribute("data-video-state", "data-saver");
  expect(requests).toEqual([]);
  await page.evaluate(() => { window.__caseConnection.saveData = false; window.__caseConnection.dispatchEvent(new Event("change")); });
  await expect(page.locator("#cases .case-image")).toHaveAttribute("data-video-state", "playing");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator("#cases .case-image")).toHaveAttribute("data-video-visible", "false");
  expect(await page.locator("#case-video").evaluate(element => element.paused)).toBe(true);
  await expect(page.locator("#case-image")).not.toHaveAttribute("aria-hidden");
});

test("real media pauses offscreen, resumes on return, and respects a deliberate native-control pause", async ({ page }) => {
  await home(page); await start(page);
  const video = page.locator("#case-video");
  await page.locator("#resources").evaluate(element => element.scrollIntoView({ block: "start", behavior: "instant" }));
  await expect.poll(() => video.evaluate(element => element.paused), { intervals: [100] }).toBe(true);
  await reveal(page);
  await expect.poll(() => video.evaluate(element => element.paused), { intervals: [100] }).toBe(false);
  // Native controls use the same media pause/play methods; the surrounding
  // lifecycle must not undo the user's pause when they revisit the panel.
  await video.evaluate(element => element.pause());
  await expect(page.locator("#cases .case-image")).toHaveAttribute("data-video-state", "paused");
  await page.locator("#resources").evaluate(element => element.scrollIntoView({ block: "start", behavior: "instant" }));
  await reveal(page);
  expect(await video.evaluate(element => element.paused)).toBe(true);
  await video.focus(); await expect(video).toBeFocused();
  await video.evaluate(element => element.play());
  await expect(page.locator("#cases .case-image")).toHaveAttribute("data-video-state", "playing");
});

test("an unavailable R2 object restores the photo rather than leaving a broken or blank media panel", async ({ page }) => {
  await home(page, { failure: true });
  await page.emulateMedia({ reducedMotion: "no-preference" }); await reveal(page);
  await expect(page.locator("#cases .case-image")).toHaveAttribute("data-video-state", "error");
  await expect(page.locator("#case-video")).toHaveCSS("opacity", "0");
  await expect(page.locator("#case-image")).not.toHaveAttribute("aria-hidden");
  await expect(page.locator("#case-image")).toBeVisible();
  await expect(page.locator("#case-cta")).toHaveAttribute("href", bundled.caseNotes.ctaHref);
});

for (const mode of ["old", "custom", "disabled"]) {
  test(`existing published content supports ${mode} video configuration without writes`, async ({ page }) => {
    const content = structuredClone(bundled);
    if (mode === "old") delete content.caseNotes.videoUrl;
    if (mode === "custom") content.caseNotes.videoUrl = `${CASE_VIDEO_ORIGIN}/edited.mp4`;
    if (mode === "disabled") content.caseNotes.videoUrl = "";
    // Disabled is intentionally not the helper's initial reduced state.
    if (mode === "disabled") {
      await page.clock.install(); await page.emulateMedia({ reducedMotion: "reduce" });
      await stubFirestore(page, { content }); await page.goto("/");
      await expect(page.locator("#cases .case-image")).toHaveAttribute("data-video-state", "disabled");
      await page.emulateMedia({ reducedMotion: "no-preference" }); await reveal(page);
      await expect(page.locator("#case-video")).not.toHaveAttribute("src");
    } else {
      const requests = await home(page, { content }); await start(page);
      expect(requests[0].url).toBe(mode === "old" ? DEFAULT_CASE_VIDEO_URL : content.caseNotes.videoUrl);
    }
    expect(await page.evaluate(() => window.__firestore.document.caseNotes.videoUrl)).toBe(content.caseNotes.videoUrl);
    expect(await page.evaluate(() => window.__firestore.writes)).toEqual([]);
  });
}

test("a failed enhancement script leaves the original photo and case links usable", async ({ page }) => {
  await stubFirestore(page, { content: bundled });
  await page.route("**/home-case-video.mjs", route => route.abort("blockedbyclient"));
  await page.goto("/");
  await expect(page.locator("#case-image")).toHaveAttribute("src", bundled.caseNotes.image);
  await expect(page.locator("#case-video")).toHaveCSS("opacity", "0");
  await expect(page.locator("#case-video")).not.toHaveAttribute("src");
  await expect(page.locator("#case-cta")).toHaveAttribute("href", bundled.caseNotes.ctaHref);
});
