import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test, expect, expectNoHorizontalOverflow, stubAuth, stubFirestore, student, json } from "./fixtures.mjs";

const bundled = JSON.parse(readFileSync(new URL("../../data/site-content.json", import.meta.url), "utf8"));
const copy = bundled.aiSpotlight;

async function home(page, { user, content = bundled } = {}) {
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await stubFirestore(page, { content });
  if (user !== undefined) await stubAuth(page, { user });
  await page.goto("/");
  await page.bringToFront();
  await expect.poll(() => page.evaluate(() => document.querySelector("#home-ai")?.dataset.content), { intervals: [100] }).toBe("ready");
  await page.clock.runFor(1800); // advance the real first-visit preloader lifecycle
  // Check actual removal on the runner's clock rather than depending on
  // another native frame/timer poll (as in the shared layout assertion).
  // No preloader element or production timer is disabled here.
  await expect.poll(() => page.evaluate(() => document.querySelector("#fc-preloader") === null), { intervals: [100] }).toBe(true);
}

async function viewScene(page) {
  await page.locator("#home-ai-scene").evaluate(scene => scene.scrollIntoView({ block: "center", behavior: "instant" }));
}

async function setOrbitTime(page, time) {
  await page.locator("#home-ai-scene").evaluate((scene, time) => {
    for (const animation of scene.getAnimations({ subtree: true })) {
      if (["homeAIOrbit", "homeAIUpright"].includes(animation.animationName)) {
        animation.pause(); animation.currentTime = time;
      }
    }
  }, time);
}

async function sampleFullOrbit(page, step = 5000) {
  // Sample the actual CSS animation in one evaluation (a full 80s rotation).
  // Explicit timeline positions avoid native-clock waits and repeated renderer
  // round trips without changing CSS or substituting geometry.
  return page.locator("#home-ai-scene").evaluate((scene, step) => {
    const animations = scene.getAnimations({ subtree: true })
      .filter(animation => ["homeAIOrbit", "homeAIUpright"].includes(animation.animationName));
    animations.forEach(animation => animation.pause());
    const samples = [];
    for (let time = 0; time < 80_000; time += step) {
      animations.forEach(animation => { animation.currentTime = time; });
      const elements = [...scene.querySelectorAll(".home-ai-chip")];
      samples.push({ time, pills: elements.map(element => ({ text: element.textContent, ...element.getBoundingClientRect().toJSON() })) });
    }
    return samples;
  }, step);
}

function expectPillsFit(pills, width) {
  for (const pill of pills) {
    expect(pill.x, `${pill.text} stays inside the left edge`).toBeGreaterThanOrEqual(4);
    expect(pill.right, `${pill.text} stays inside the right edge`).toBeLessThanOrEqual(width - 4);
    // Inverse transform arithmetic can differ by 0.00003px. Compare physical
    // height at millipixel precision; the viewport/overlap bounds stay exact.
    expect(Math.round(pill.height * 1000)).toBeGreaterThanOrEqual(36_000);
  }
  for (let a = 0; a < pills.length; a++) {
    for (let b = a + 1; b < pills.length; b++) {
      const first = pills[a], second = pills[b];
      const overlapX = Math.min(first.right, second.right) - Math.max(first.x, second.x);
      const overlapY = Math.min(first.bottom, second.bottom) - Math.max(first.y, second.y);
      expect(overlapX > 0 && overlapY > 0, `${first.text} and ${second.text} do not overlap`).toBe(false);
    }
  }
}

test("AI section uses the exact owner copy, reference labels and gated AI links without replacing other sections", async ({ page }) => {
  const authReads = [], mutations = [];
  page.on("request", request => {
    if (request.url().includes("/firebase/auth-client.mjs")) authReads.push(request.url());
    if (request.method() !== "GET") mutations.push(request.url());
  });
  await home(page);
  await expect(page.locator("#home-ai-title")).toHaveText(copy.title);
  await expect(page.locator("#home-ai-title")).toHaveCSS("font-weight", "800");
  await expect(page.locator("#home-ai-intro")).toHaveText(copy.intro);
  await expect(page.locator("#home-ai-closing")).toHaveText(copy.closing);
  await expect(page.locator(".home-ai-chip")).toHaveText(copy.chips);
  await expect(page.locator("#home-ai [data-ai-entry]")).toHaveCount(8);
  for (const link of await page.locator("#home-ai [data-ai-entry]").all()) await expect(link).toHaveAttribute("href", "./ai.html");
  await expect(page.locator("#learning + #home-ai + #cases")).toHaveCount(1);
  await expect(page.locator("#home h1")).toHaveText("Fire Counsel");
  await expect(page.locator("#home a")).toHaveCount(1);
  await expect(page.locator("#home a")).toHaveAttribute("href", "./auth.html");
  await expect(page.getByRole("tab")).toHaveCount(4);
  await expect(page.locator("#brand-image")).toHaveAttribute("src", bundled.brand.markImage);
  await expect(page.locator("#case-image")).toHaveAttribute("src", bundled.caseNotes.image);
  await expect(page.locator("#home-ai-scene")).toHaveAttribute("data-motion", "reduced");
  await expect(page.locator("#home-ai-pause")).toHaveCount(0);
  expect(authReads).toEqual([], "public browsing does not load account code");
  expect(mutations).toEqual([]);
});

test("real matrix, burning flame, growing rotating light and upright 80-second orbits animate and respect automatic motion safeguards", async ({ page }) => {
  await home(page);
  // Settle page loading under reduced motion, then exercise the real live
  // preference switch and frame loop. Warming the unrelated hero for 1.8s
  // while its native renderer and virtual clock compete can stall headless
  // Chromium before this section is even tested. Neither engine is replaced.
  await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1000);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const scene = page.locator("#home-ai-scene"), matrix = page.locator(".home-ai-matrix");
  await expect(scene).toHaveAttribute("data-motion", "paused");
  const still = await matrix.evaluate(canvas => canvas.toDataURL());
  await viewScene(page);
  await expect(scene).toHaveAttribute("data-motion", "running");
  await page.clock.runFor(500);
  expect(await matrix.evaluate(canvas => canvas.toDataURL())).not.toBe(still);
  const samples = await scene.evaluate(scene => {
    const sample = (selector, name, time) => {
      const element = scene.querySelector(selector);
      const animation = element.getAnimations().find(item => item.animationName === name);
      if (!animation) throw new Error(`Missing real CSS animation: ${name}`);
      const duration = animation.effect.getTiming().duration;
      animation.pause(); animation.currentTime = 0;
      const before = { transform: getComputedStyle(element).transform, opacity: getComputedStyle(element).opacity };
      animation.currentTime = time;
      const after = { transform: getComputedStyle(element).transform, opacity: getComputedStyle(element).opacity };
      animation.play();
      return { duration, before, after };
    };
    return {
      ring: sample(".home-ai-ring", "homeAIRing", 2000),
      halo: sample(".home-ai-halo", "homeAIPulse", 2000),
      flame: sample(".home-ai-flame", "homeAIBurn", 400),
      core: sample(".home-ai-flame-inner", "homeAIFlare", 450)
    };
  });
  expect(samples.ring.duration).toBe(8000);
  expect(samples.halo.duration).toBe(4000);
  for (const result of Object.values(samples)) expect(result.after.transform).not.toBe(result.before.transform);
  expect(samples.halo.after.opacity).not.toBe(samples.halo.before.opacity);
  await setOrbitTime(page, 0);
  const start = await page.locator(".home-ai-chip").first().boundingBox();
  await setOrbitTime(page, 20_000);
  const moved = await page.locator(".home-ai-chip").first().boundingBox();
  expect(Math.hypot(moved.x - start.x, moved.y - start.y)).toBeGreaterThan(100);
  const upright = await page.locator(".home-ai-chip").evaluateAll(links => links.map(link => {
    const rotation = new DOMMatrix(getComputedStyle(link.closest(".home-ai-orbit")).transform)
      .multiply(new DOMMatrix(getComputedStyle(link.parentElement).transform))
      .multiply(new DOMMatrix(getComputedStyle(link).transform));
    return { a: rotation.a, b: rotation.b, c: rotation.c, d: rotation.d };
  }));
  for (const rotation of upright) {
    expect(rotation.a).toBeCloseTo(1, 5); expect(rotation.d).toBeCloseTo(1, 5);
    expect(rotation.b).toBeCloseTo(0, 5); expect(rotation.c).toBeCloseTo(0, 5);
  }
  await expect(page.locator("#home-ai button")).toHaveCount(0);
  // Leave the orb fully offscreen without warming either unrelated stream
  // canvas on this virtual frame clock. The old directory target was removed;
  // the media panel now sits between the orb and the ending's canvas.
  await page.locator("#cases").evaluate(section => section.scrollIntoView({ block: "start", behavior: "instant" }));
  await expect(scene).not.toBeInViewport();
  await expect(page.locator("#exam-ready-streams")).not.toHaveAttribute("data-motion", "running");
  await expect(scene).toHaveAttribute("data-motion", "paused");
  const paused = await matrix.evaluate(canvas => canvas.toDataURL());
  await page.clock.runFor(600);
  expect(await matrix.evaluate(canvas => canvas.toDataURL())).toBe(paused);
  await expect(page.locator(".home-ai-ring")).toHaveCSS("animation-play-state", "paused");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(scene).toHaveAttribute("data-motion", "reduced");
  await expect(page.locator(".home-ai-flame")).toHaveCSS("animation-name", "none");
});

test("AI copy and all orbit positions fit 320, 390, 768 and 1440 pixels with no overlapping labels", async ({ page }) => {
  await home(page);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    const seam = await page.evaluate(() => {
      const learning = document.getElementById("learning"), ai = document.getElementById("home-ai");
      const before = getComputedStyle(learning), after = getComputedStyle(ai);
      return {
        gap: ai.getBoundingClientRect().top - learning.getBoundingClientRect().bottom,
        leftRadius: before.borderBottomLeftRadius, rightRadius: before.borderBottomRightRadius,
        before: before.backgroundColor, after: after.backgroundColor,
        copyGap: document.getElementById("home-ai-title").getBoundingClientRect().top - document.querySelector(".learning-split").getBoundingClientRect().bottom
      };
    });
    expect(Math.abs(seam.gap)).toBeLessThanOrEqual(.5);
    expect(seam.leftRadius).toBe("0px"); expect(seam.rightRadius).toBe("0px");
    expect(seam.before).toBe("rgb(10, 8, 32)"); expect(seam.after).toBe(seam.before);
    expect(seam.copyGap).toBeGreaterThanOrEqual(40); expect(seam.copyGap).toBeLessThanOrEqual(90);
    await expect(page.locator("#home-ai button")).toHaveCount(0);
    await viewScene(page);
    await expect(page.locator("#home-ai-scene")).toHaveAttribute("data-motion", "running");
    for (const { pills } of await sampleFullOrbit(page)) expectPillsFit(pills, width);
    await setOrbitTime(page, 0);
    await expectNoHorizontalOverflow(page);
    const bounds = await page.locator(".home-ai-stars").evaluate(canvas => ({
      width: canvas.width, height: canvas.height, css: canvas.getBoundingClientRect().toJSON(), ratio: Math.min(devicePixelRatio, 2)
    }));
    expect(bounds.width).toBeLessThanOrEqual(Math.ceil(bounds.css.width * 2));
    expect(bounds.height).toBeLessThanOrEqual(Math.ceil(bounds.css.height * 2));
    await expect(page.locator(".home-ai-matrix")).toHaveAttribute("width", "480");
    if (process.env.SHOT_DIR) {
      await mkdir(process.env.SHOT_DIR, { recursive: true });
      await page.locator("#home-ai").screenshot({ path: join(process.env.SHOT_DIR, `home-ai-${width}.png`) });
    }
  }
});

test("signed-out AI button uses Google-only sign-in and safely continues to ai.html", async ({ page }) => {
  const aiRequests = [];
  page.on("request", request => {
    // The existing app reads account/course/history data on arrival. It must
    // not send a prompt or any other AI mutation just for opening the page.
    if (request.url().includes("/api/v1/ai/") && request.method() !== "GET") aiRequests.push(request.url());
  });
  await home(page, { user: null });
  await page.route("**/api/v1/profile", route => json(route, { data: { full_name: student.displayName, email: student.email, installation: { registered: true } } }));
  await page.locator(".home-ai-open").click();
  await expect(page).toHaveURL(/\/auth\.html\?next=ai\.html$/);
  await expect(page.locator("#google-signin-button")).toBeVisible();
  await expect(page.locator("input[type=password]")).toHaveCount(0);
  await page.locator("#google-signin-button").click();
  await expect(page.locator("#continue-button")).toHaveText("Open Fire Counsel AI");
  expect(await page.evaluate(() => window.__auth.googleCalls)).toBe(1);
  // Model Firebase persistence at the SDK boundary on the next document.
  await stubAuth(page, { user: student });
  await page.locator("#continue-button").click();
  await expect(page).toHaveURL(/\/ai\.html$/);
  await expect(page.locator("body")).toHaveAttribute("data-auth-gate", "unlocked");
  expect(aiRequests).toEqual([], "opening the AI app does not send prompts or make a provider request");
});

for (const label of copy.chips) {
  test(`the orbit label ${label} checks authentication before opening AI`, async ({ page }) => {
    await home(page, { user: null });
    await page.getByRole("link", { name: `Open Fire Counsel AI: ${label}`, exact: true }).click();
    await expect(page).toHaveURL(/\/auth\.html\?next=ai\.html$/);
    await expect(page.locator("#google-signin-button")).toBeVisible();
  });
}

test("a verified Google user opens the existing AI page directly from the central flame", async ({ page }) => {
  await home(page, { user: student });
  await page.locator(".home-ai-core-link").click();
  await expect(page).toHaveURL(/\/ai\.html$/);
  await expect(page.locator("body")).toHaveAttribute("data-auth-gate", "unlocked");
});

test("a password session with Google linked and a past offline marker still has to use Google", async ({ page }) => {
  await home(page, { user: { ...student, signInProvider: "password" } });
  await page.evaluate(() => localStorage.setItem("fire-counsel-auth-gate-v2", "synthetic-student"));
  await page.locator(".home-ai-open").click();
  await expect(page).toHaveURL(/\/auth\.html\?next=ai\.html$/);
  await expect(page.locator("#auth-message")).toContainText("did not sign in with Google");
  await expect(page.locator("#continue-button")).toBeHidden();
});

test("sign-out during a pending Google check cannot send a late result to AI or start duplicate checks", async ({ page }) => {
  await home(page, { user: student });
  await page.evaluate(async () => {
    await import("/firebase/auth-client.mjs");
    window.__auth.pendingChecks = [];
    window.__auth.checkGoogleSession = () => new Promise(resolve => window.__auth.pendingChecks.push(resolve));
  });
  await page.locator(".home-ai-open").click();
  await expect(page.locator("#home-ai")).toHaveAttribute("aria-busy", "true");
  await expect.poll(() => page.evaluate(() => window.__auth.pendingChecks.length)).toBe(1);
  await page.locator(".home-ai-core-link").click();
  expect(await page.evaluate(() => window.__auth.pendingChecks.length)).toBe(1);
  await page.evaluate(() => {
    window.__auth.setUser(null);
    window.__auth.pendingChecks.forEach(resolve => resolve(true));
  });
  await expect(page).toHaveURL(/\/auth\.html\?next=ai\.html$/);
  await expect(page.locator("#continue-button")).toBeHidden();
});

for (const remembered of [false, true]) {
  test(`unavailable sign-in keeps the existing ${remembered ? "returning-offline" : "first-visit locked"} AI gate policy`, async ({ page }) => {
    await home(page);
    if (remembered) await page.evaluate(() => localStorage.setItem("fire-counsel-auth-gate-v2", "synthetic-student"));
    await page.route("**/firebase/auth-client.mjs", route => route.abort("blockedbyclient"));
    await page.locator(".home-ai-open").click();
    await expect(page).toHaveURL(/\/ai\.html$/);
    await expect(page.locator("body")).toHaveAttribute("data-auth-gate", remembered ? "unlocked" : "locked");
    if (!remembered) await expect(page.locator("#auth-gate-signin")).toHaveAttribute("href", "./auth.html?next=ai.html");
  });
}

test("a stalled auth SDK import has a bounded check and falls back to the still-locked AI page", async ({ page }) => {
  await home(page, { user: null });
  let release, started, first = true;
  const blocked = new Promise(resolve => { release = resolve; });
  const requestStarted = new Promise(resolve => { started = resolve; });
  await page.route("**/firebase/auth-client.mjs", async route => {
    if (!first) return route.fallback();
    first = false; started(); await blocked;
    await route.abort("blockedbyclient").catch(() => {}); // the old document may already have navigated
  });
  try {
    await page.locator(".home-ai-open").click();
    await requestStarted;
    await expect(page.locator("#home-ai")).toHaveAttribute("aria-busy", "true");
    // Advance the actual 8-second network budget, not a test sleep/retry.
    await page.clock.fastForward(8001);
    await expect(page).toHaveURL(/\/ai\.html$/);
    await page.bringToFront();
    await expect(page.locator("body")).toHaveAttribute("data-auth-gate", "locked");
  } finally { release(); }
});

test("new AI entry retains student-profile onboarding instead of bypassing an installation denial", async ({ page }) => {
  await stubAuth(page, { user: student });
  await page.route("**/api/v1/profile", route => json(route, { code: "PROFILE_NOT_CREATED" }, 404));
  await page.goto("/auth.html?next=ai.html");
  await expect(page.locator("#continue-button")).toHaveText("Set up my student profile");
  await page.locator("#continue-button").click();
  await expect(page).toHaveURL(/\/study\.html#profile$/);
  await page.route("**/api/v1/profile", route => json(route, { error: "Different installation", code: "INSTALLATION_MISMATCH" }, 403));
  await page.goto("/auth.html?next=ai.html");
  await expect(page.locator("#auth-message")).toContainText("Different installation");
  await expect(page.locator("#continue-button")).toBeHidden();
});

test("keyboard focus freezes the orbit, shows its focus ring and activates Google sign-in", async ({ page }) => {
  await home(page, { user: null });
  // Isolate keyboard behaviour with the cached SDK fixture. Fresh lazy SDK
  // loading, timeouts and every access-policy branch have separate cases.
  await page.evaluate(async () => { await import("/firebase/auth-client.mjs"); });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await viewScene(page);
  await page.locator(".home-ai-core-link").focus();
  await page.keyboard.press("Tab");
  const chip = page.locator(".home-ai-chip").first();
  await expect(chip).toBeFocused();
  await expect(chip).toHaveCSS("outline-style", "solid");
  await expect(page.locator(".home-ai-orbit")).toHaveCSS("animation-play-state", "paused");
  await expect(chip).toHaveCSS("animation-play-state", "paused");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/auth\.html\?next=ai\.html$/);
});

test("a legacy five-label publish keeps custom copy and adds Cases without rewriting stored content", async ({ page }) => {
  const legacy = structuredClone(bundled);
  legacy.aiSpotlight.chips = ["Study ideas", "Clarity", "Legislation", "Statues", "Exam"];
  await home(page, { content: legacy });
  await expect(page.locator(".home-ai-chip")).toHaveText([...legacy.aiSpotlight.chips, "Cases"]);
  await expect(page.locator("#home-ai button")).toHaveCount(0);
  await expect(page.locator(".home-ai-chip").last()).toHaveAttribute("href", "./ai.html");
  expect(await page.evaluate(() => window.__firestore.document.aiSpotlight.chips)).toEqual(legacy.aiSpotlight.chips);
  expect(await page.evaluate(() => window.__firestore.writes)).toEqual([]);
});

test("static markup and old published documents retain the AI section and protected destinations", async ({ page }) => {
  const old = structuredClone(bundled); delete old.aiSpotlight;
  await home(page, { content: old, user: null });
  await expect(page.locator("#home-ai-title")).toHaveText(copy.title);
  await expect(page.locator(".home-ai-chip")).toHaveText(copy.chips);
  expect(await page.evaluate(() => window.__firestore.document.aiSpotlight)).toBeUndefined();
  await page.route("**/site.js", route => route.abort("blockedbyclient"));
  await page.route("**/home-ai*.mjs", route => route.abort("blockedbyclient"));
  await page.reload();
  await page.bringToFront();
  await expect(page.locator("#home-ai-intro")).toHaveText(copy.intro);
  await expect(page.locator("#home-ai-scene")).toHaveAttribute("data-motion", "paused");
  await expect(page.locator("#home-ai [data-ai-entry]")).toHaveCount(8);
  await expect(page.locator(".home-ai-flame svg")).toBeVisible();
  await page.locator(".home-ai-open").click();
  await expect(page).toHaveURL(/\/ai\.html$/);
  await page.waitForLoadState("domcontentloaded");
  await page.bringToFront();
  await expect(page.locator("body")).toHaveAttribute("data-auth-gate", "locked");
});

test("long AI edits are safe text and cannot change destinations or overlap at responsive breakpoints", async ({ page }) => {
  const content = structuredClone(bundled);
  content.aiSpotlight = {
    title: "LegalFocus".repeat(12), intro: "Keep <script>alert(1)</script> as words.",
    closing: "Study with <b>clarity</b>.", buttonLabel: "Open <b>Fire Counsel AI</b>",
    chips: Array.from({ length: 6 }, (_item, i) => `${"Legal".repeat(6)} <b>${i}`)
  };
  await page.setViewportSize({ width: 320, height: 1000 });
  await home(page, { content });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(page.locator("#home-ai-title")).toHaveText(content.aiSpotlight.title);
  await expect(page.locator("#home-ai-intro")).toHaveText(content.aiSpotlight.intro);
  await expect(page.locator("#home-ai-closing")).toHaveText(content.aiSpotlight.closing);
  await expect(page.locator("#home-ai-button-label")).toHaveText(content.aiSpotlight.buttonLabel);
  await expect(page.locator("#home-ai b, #home-ai script, #home-ai img")).toHaveCount(0);
  await expect(page.locator(".home-ai-chip")).toHaveText(content.aiSpotlight.chips);
  for (const [index, label] of content.aiSpotlight.chips.entries()) {
    await expect(page.locator(".home-ai-chip").nth(index)).toHaveAttribute("title", label);
    await expect(page.locator(".home-ai-chip").nth(index)).toHaveAttribute("aria-label", `Open Fire Counsel AI: ${label}`);
  }
  await expect(page.locator(".home-ai-chip-text").first()).toHaveCSS("text-overflow", "ellipsis");
  for (const width of [320, 390, 600, 601, 640, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await viewScene(page);
    for (const { pills } of await sampleFullOrbit(page, 1000)) expectPillsFit(pills, width);
    await expectNoHorizontalOverflow(page);
  }
  for (const link of await page.locator("#home-ai [data-ai-entry]").all()) await expect(link).toHaveAttribute("href", "./ai.html");
  expect(await page.evaluate(() => window.__firestore.writes)).toEqual([]);
});

test.describe("touch AI entry", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test("a tap on an orbit label opens AI for a Google-authenticated student", async ({ page }) => {
    await home(page, { user: student });
    await page.getByRole("link", { name: "Open Fire Counsel AI: Cases", exact: true }).tap();
    await expect(page).toHaveURL(/\/ai\.html$/);
    await expect(page.locator("body")).toHaveAttribute("data-auth-gate", "unlocked");
  });
});
