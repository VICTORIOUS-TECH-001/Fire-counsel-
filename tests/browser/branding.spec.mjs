import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test, expect, expectNoHorizontalOverflow, stubAuth, stubFirestore, student, json } from "./fixtures.mjs";

const widths = [320, 390, 768, 1440];
const bundled = JSON.parse(readFileSync(new URL("../../data/site-content.json", import.meta.url), "utf8"));

async function stubStudent(page) {
  await stubAuth(page, { user: student });
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/presence") return route.fulfill({ status: 204 });
    if (path === "/api/v1/ai/me") return json(route, { data: { configured: true, web_search: true, search_providers: ["tavily", "serpapi"], email_verified: true, allowance: { premium: true, unlimited: true, features: {} } } });
    if (path === "/api/v1/profile") return json(route, { error: "No synthetic profile", code: "PROFILE_NOT_CREATED" }, 404);
    return json(route, { data: [] });
  });
}

// Check the actual supplied artwork, left-side placement and inline wordmark.
// The responsive overflow helper remains unchanged.
async function sideLogo(page, imageSelector, areaSelector, copySelector) {
  const image = page.locator(imageSelector);
  await image.scrollIntoViewIfNeeded();
  await expect(image).toBeVisible();
  await expect(image).toBeInViewport();
  await expect.poll(() => image.evaluate(img => img.complete && img.naturalWidth > 0), { message: `${imageSelector} loads the supplied flame artwork` }).toBe(true);
  const [logo, region] = await Promise.all([image.boundingBox(), page.locator(areaSelector).boundingBox()]);
  expect(logo.width, "the side emblem retains the original compact, readable size").toBeGreaterThanOrEqual(40);
  expect(logo.x - region.x, "the emblem is on the leading side, not in the page center").toBeLessThanOrEqual(region.width / 3);
  expect(logo.x + logo.width / 2).toBeLessThan(region.x + region.width / 2 - 1);
  expect(await image.evaluate(img => getComputedStyle(img).objectFit), "show the supplied flame without cropping it").toBe("contain");
  await expect(image).toHaveAttribute("src", /\/assets\/images\/fire-counsel-flame\.png$/);
  if (copySelector) {
    const copy = await page.locator(copySelector).boundingBox();
    expect(copy.x, "the wordmark is beside the logo, never centered underneath it").toBeGreaterThanOrEqual(logo.x + logo.width - 1);
  }
}

test("homepage and dynamic footer logos keep the original side-by-side layout at every viewport", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#hero-slides .hero-slide")).toHaveCount(2);
  for (const width of widths) {
    await page.setViewportSize({ width, height: 844 });
    await sideLogo(page, "#brand-image", ".site-header", "#brand-name");
    await sideLogo(page, ".footer-mark img", "#site-footer", ".footer-mark strong");
    await expectNoHorizontalOverflow(page);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#nav-toggle").click();
  await expect(page.locator("#primary-nav")).toBeVisible();
  await sideLogo(page, "#brand-image", ".site-header", "#brand-name");
  await page.locator("#main-nav-links a[href='#learning']").click();
  await expect(page.locator("#nav-toggle")).toHaveAttribute("aria-expanded", "false");
  const heading = await page.locator("#learning").boundingBox();
  const header = await page.locator(".site-header").boundingBox();
  expect(heading.y, "anchor navigation leaves the section below the compact masthead").toBeGreaterThanOrEqual(header.y + header.height - 1);
});

test("homepage fallback markup keeps logos on the side even when the content script cannot load", async ({ page }) => {
  await page.route("**/site.js", route => route.abort("blockedbyclient"));
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/");
  await sideLogo(page, "#brand-image", ".site-header", "#brand-name");
  await sideLogo(page, ".footer-mark img", "#site-footer", ".footer-mark strong");
  await expectNoHorizontalOverflow(page);
});

test("sign-in and public student pages use an uncropped side-by-side brand lockup", async ({ page }) => {
  await stubAuth(page);
  for (const path of ["/auth.html", "/student.html"]) {
    await page.goto(path);
    for (const width of widths) {
      await page.setViewportSize({ width, height: 844 });
      await sideLogo(page, ".auth-brand img", ".auth-shell", ".auth-brand strong");
      await expectNoHorizontalOverflow(page);
    }
  }
});

test("workspace branding follows navigation/profile controls in the mobile masthead and sidebar", async ({ page }) => {
  await stubStudent(page);
  await page.goto("/study.html#dashboard");
  await expect(page.locator("body")).toHaveAttribute("data-auth-gate", "unlocked");
  await expect(page.locator("#today-label")).not.toHaveText("Today");
  for (const width of widths) {
    await page.setViewportSize({ width, height: 844 });
    if (width <= 900) {
      await sideLogo(page, "#ws-top-logo", ".ws-topbar", "#ws-top-brand-name");
      const [profile, menu, brand] = await Promise.all([page.locator("#student-profile-link").boundingBox(), page.locator("#menu-toggle").boundingBox(), page.locator(".ws-top-brand").boundingBox()]);
      expect(profile.y + profile.height, "the student's profile row comes before the mobile logo").toBeLessThanOrEqual(brand.y);
      expect(menu.y + menu.height, "navigation controls also come first").toBeLessThanOrEqual(brand.y);
      if (process.env.SHOT_DIR && width === 390) {
        await mkdir(process.env.SHOT_DIR, { recursive: true });
        await expect(page.locator("#fc-preloader")).toBeHidden();
        await page.screenshot({ path: join(process.env.SHOT_DIR, "workspace-profile-before-brand.png") });
      }
      await page.locator("#menu-toggle").click();
    }
    await sideLogo(page, "#ws-logo", "#sidebar", "#ws-brand-name");
    expect(await page.locator("#ws-logo").evaluate(logo => Boolean(document.querySelector("#student-nav").compareDocumentPosition(logo) & Node.DOCUMENT_POSITION_FOLLOWING)), "sidebar links precede the brand in document and keyboard order").toBe(true);
    const [nav, brand] = await Promise.all([page.locator("#student-nav").boundingBox(), page.locator(".ws-brand").boundingBox()]);
    expect(nav.y + nav.height, "sidebar branding sits below the entire navigation").toBeLessThanOrEqual(brand.y);
    if (width <= 900) {
      await page.locator("#scrim").click({ position: { x: width - 8, y: 40 } });
      await expect(page.locator("#sidebar")).not.toHaveClass(/\bopen\b/);
    }
    await sideLogo(page, ".footer-mark img", "#site-footer", ".footer-mark strong");
    await page.locator(".ws-ai-head").scrollIntoViewIfNeeded();
    const flame = await page.locator(".ws-mini-fire").boundingBox();
    const heading = await page.locator("#ws-ai-title").boundingBox();
    expect(flame.x + flame.width, "the AI card's animated flame sits beside its title again").toBeLessThanOrEqual(heading.x);
    expect(heading.y).toBeLessThan(flame.y + flame.height);
    await expectNoHorizontalOverflow(page);
  }
});

test("AI keeps the reference layout: text-only top bar, left-aligned flame/greeting and original composer", async ({ page }) => {
  await stubStudent(page);
  await page.goto("/ai.html");
  await expect(page.locator("body")).toHaveAttribute("data-auth-gate", "unlocked");
  await expect(page.locator("#ai-status")).toBeEmpty();
  await expect(page.locator("#ai-status")).toBeHidden();
  await expect(page.locator("#ai-search-status")).toHaveCount(0);
  await expect(page.locator(".fc-title img")).toHaveCount(0);
  for (const width of widths) {
    await page.setViewportSize({ width, height: 844 });
    const menu = await page.locator("#fc-menu").boundingBox();
    const title = await page.locator("#fc-mode-switch").boundingBox();
    const controls = await page.locator(".fc-pill").boundingBox();
    expect(title.x).toBeGreaterThanOrEqual(menu.x + menu.width);
    expect(title.x + title.width).toBeLessThanOrEqual(controls.x + 1);
    expect(Math.abs(title.y + title.height / 2 - menu.y - menu.height / 2)).toBeLessThanOrEqual(1);
    const logo = page.locator(".fc-logo img");
    await expect(logo).toHaveAttribute("src", "./assets/images/fire-counsel-flame.png");
    await expect(logo).toBeInViewport();
    const [mark, heading, sub] = await Promise.all([logo.boundingBox(), page.locator(".fc-home h1").boundingBox(), page.locator(".fc-sub").boundingBox()]);
    expect(Math.abs(mark.x - heading.x), "the emblem stays left-aligned with the original greeting").toBeLessThanOrEqual(1);
    expect(Math.abs(mark.x - sub.x)).toBeLessThanOrEqual(1);
    expect(mark.y + mark.height).toBeLessThanOrEqual(heading.y);
    expect(await logo.evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
    await expect(page.locator("#ai-input")).toBeInViewport();
    await expect(page.locator("#ai-send")).toBeInViewport();
    await page.locator("#fc-menu").click();
    await sideLogo(page, ".fc-brand img", "#fc-drawer", ".fc-brand strong");
    await page.locator("#fc-drawer-close").click();
    await expect(page.locator("#fc-drawer")).toBeHidden();
    await expectNoHorizontalOverflow(page);
    if (process.env.SHOT_DIR) {
      await mkdir(process.env.SHOT_DIR, { recursive: true });
      await expect(page.locator("#fc-preloader")).toBeHidden();
      await page.screenshot({ path: join(process.env.SHOT_DIR, `ai-restored-${width}.png`) });
    }
  }
  await page.setViewportSize({ width: 320, height: 740 });
  await page.locator("#fc-theme").click();
  await expect(page.locator("body")).toHaveAttribute("data-theme", "light");
  await expect(page.locator(".fc-logo img")).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.goto("/ai.html?mode=questions");
  await expect(page.locator("#fc-mode-name")).toHaveText("Question setter");
  await expect(page.locator("#fc-open-functions-top")).toBeInViewport();
  await expect(page.locator("#ai-input")).toBeInViewport();
  await expectNoHorizontalOverflow(page);
});

test("the supplied welcome flame animates again and respects reduced motion", async ({ page }) => {
  await stubStudent(page);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/ai.html");
  await expect(page.locator("body")).toHaveAttribute("data-auth-gate", "unlocked");
  await expect(page.locator(".fc-logo")).toBeVisible();
  const animations = () => page.locator(".fc-logo").evaluate(logo => ({
    flame: getComputedStyle(logo, "::before").animationName,
    embers: [...logo.querySelectorAll(".fc-logo-ember")].map(ember => getComputedStyle(ember).animationName),
    source: getComputedStyle(logo, "::before").backgroundImage
  }));
  expect(await animations()).toMatchObject({ flame: "fcLogoFlicker", embers: ["fcEmber", "fcEmber", "fcEmber"], source: expect.stringContaining("fire-counsel-flame.png") });
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await animations()).toMatchObject({ flame: "none", embers: ["none", "none", "none"] });
});

test("admin branding stays on the left beside preview controls, with navigation below it", async ({ page }) => {
  await stubAuth(page);
  await page.goto("/admin.html");
  for (const width of widths) {
    await page.setViewportSize({ width, height: 844 });
    await sideLogo(page, ".admin-brand img", ".admin-topbar", ".admin-brand strong");
    const header = await page.locator(".admin-topbar").boundingBox();
    const controls = await page.locator(".admin-top-actions").boundingBox();
    const nav = await page.locator(".admin-sidebar").boundingBox();
    expect(controls.y + controls.height, "preview controls remain inside the masthead").toBeLessThanOrEqual(header.y + header.height);
    expect(nav.y, "admin navigation does not overlap the compact masthead").toBeGreaterThanOrEqual(header.y + header.height - 1);
    await expect(page.locator("#preview-site-top")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }
});

test("signed-out workspace and AI gates show the full brand artwork on the side", async ({ page }) => {
  await stubAuth(page);
  for (const path of ["/study.html", "/ai.html"]) {
    await page.goto(path);
    await expect(page.locator("body")).toHaveAttribute("data-auth-gate", "locked");
    for (const width of widths) {
      await page.setViewportSize({ width, height: 844 });
      await sideLogo(page, ".auth-gate-brand", ".auth-gate-card");
      await expectNoHorizontalOverflow(page);
    }
  }
});

test("older published/cached gavel paths resolve to the supplied flame without a remote publication", async ({ page }) => {
  const requested = [];
  page.on("request", request => requested.push(new URL(request.url()).pathname));
  await stubStudent(page);
  await stubFirestore(page, { content: { ...bundled, brand: { ...bundled.brand, markImage: "./assets/images/fire-counsel-brand.jpg" }, workspace: { brand: { logo: "./assets/images/fire-counsel-brand.jpg" } } } });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator("#hero-slides .hero-slide")).toHaveCount(2);
  await sideLogo(page, "#brand-image", ".site-header", "#brand-name");
  await sideLogo(page, ".footer-mark img", "#site-footer", ".footer-mark strong");
  await page.goto("/study.html");
  await expect(page.locator("body")).toHaveAttribute("data-auth-gate", "unlocked");
  await sideLogo(page, "#ws-top-logo", ".ws-topbar", "#ws-top-brand-name");
  expect(requested.filter(path => path.endsWith("fire-counsel-brand.jpg")), "no retired image is requested even with old server settings").toEqual([]);
  expect(await page.evaluate(() => window.__firestore.writes)).toEqual([]);
});

test("published custom brand names wrap beside side-aligned logos without overflowing", async ({ page }) => {
  const name = "FIRE COUNSEL LEGAL LEARNING AND RESEARCH";
  await stubStudent(page);
  await stubFirestore(page, { content: { ...bundled, brand: { ...bundled.brand, name }, workspace: { brand: { name, tagline: "Your legal study and research companion", logo: bundled.brand.markImage } } } });
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/");
  await expect(page.locator("#brand-name")).toHaveText(name);
  await sideLogo(page, "#brand-image", ".site-header", "#brand-name");
  await sideLogo(page, ".footer-mark img", "#site-footer", ".footer-mark strong");
  await expectNoHorizontalOverflow(page);
  await page.goto("/study.html");
  await expect(page.locator("#ws-top-brand-name")).toHaveText(name);
  await expect(page.locator("#ws-brand-name")).toHaveText(name);
  await sideLogo(page, "#ws-top-logo", ".ws-topbar", "#ws-top-brand-name");
  await expectNoHorizontalOverflow(page);
});
