import { readFileSync } from "node:fs";
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

// Test the image itself, not just the surrounding logo/text group's midpoint.
// Centering a horizontal group still leaves its emblem visibly off to one side.
async function centeredLogo(page, imageSelector, areaSelector, copySelector) {
  const image = page.locator(imageSelector);
  await image.scrollIntoViewIfNeeded();
  await expect(image).toBeVisible();
  await expect(image).toBeInViewport();
  await expect.poll(() => image.evaluate(img => img.complete && img.naturalWidth > 0), { message: `${imageSelector} loads the real logo artwork` }).toBe(true);
  await expect.poll(() => image.evaluate((img, area) => {
    const logo = img.getBoundingClientRect();
    const region = document.querySelector(area).getBoundingClientRect();
    return Math.abs((logo.left + logo.width / 2) - (region.left + region.width / 2));
  }, areaSelector), { message: `${imageSelector} is centered in ${areaSelector}` }).toBeLessThanOrEqual(1);
  const logo = await image.boundingBox();
  expect(logo.width, "the emblem is large enough to recognise").toBeGreaterThanOrEqual(64);
  expect(await image.evaluate(img => getComputedStyle(img).objectFit), "show the entire gavel, without cropping it into a square").toBe("contain");
  if (copySelector) {
    const copy = await page.locator(copySelector).boundingBox();
    expect(logo.y + logo.height, "the wordmark sits below the centered logo").toBeLessThanOrEqual(copy.y + 1);
    expect(Math.abs((copy.x + copy.width / 2) - (logo.x + logo.width / 2)), "wordmark and emblem share a centerline").toBeLessThanOrEqual(1);
  }
}

test("homepage and dynamically rendered footer logos are centered above their wordmarks at every viewport", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#hero-slides .hero-slide")).toHaveCount(2);
  for (const width of widths) {
    await page.setViewportSize({ width, height: 844 });
    await centeredLogo(page, "#brand-image", ".site-header", "#brand-name");
    await centeredLogo(page, ".footer-mark img", "#site-footer", ".footer-mark strong");
    await expectNoHorizontalOverflow(page);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#nav-toggle").click();
  await expect(page.locator("#primary-nav")).toBeVisible();
  await centeredLogo(page, "#brand-image", ".site-header", "#brand-name");
  await page.locator("#main-nav-links a[href='#learning']").click();
  await expect(page.locator("#nav-toggle")).toHaveAttribute("aria-expanded", "false");
  const heading = await page.locator("#learning").boundingBox();
  const header = await page.locator(".site-header").boundingBox();
  expect(heading.y, "anchor navigation leaves the section below the taller masthead").toBeGreaterThanOrEqual(header.y + header.height - 1);
});

test("homepage fallback markup keeps its logos centered even when the content script cannot load", async ({ page }) => {
  await page.route("**/site.js", route => route.abort("blockedbyclient"));
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/");
  await centeredLogo(page, "#brand-image", ".site-header", "#brand-name");
  await centeredLogo(page, ".footer-mark img", "#site-footer", ".footer-mark strong");
  await expectNoHorizontalOverflow(page);
});

test("sign-in and public student pages use a centered uncropped brand lockup", async ({ page }) => {
  await stubAuth(page);
  for (const path of ["/auth.html", "/student.html"]) {
    await page.goto(path);
    for (const width of widths) {
      await page.setViewportSize({ width, height: 844 });
      await centeredLogo(page, ".auth-brand img", ".auth-shell", ".auth-brand strong");
      await expectNoHorizontalOverflow(page);
    }
  }
});

test("workspace branding is centered in the visible mobile masthead, sidebar and footer", async ({ page }) => {
  await stubStudent(page);
  await page.goto("/study.html#dashboard");
  await expect(page.locator("body")).toHaveAttribute("data-auth-gate", "unlocked");
  await expect(page.locator("#today-label")).not.toHaveText("Today");
  for (const width of widths) {
    await page.setViewportSize({ width, height: 844 });
    if (width <= 900) {
      await centeredLogo(page, "#ws-top-logo", ".ws-topbar", "#ws-top-brand-name");
      await page.locator("#menu-toggle").click();
    }
    await centeredLogo(page, "#ws-logo", "#sidebar", "#ws-brand-name");
    if (width <= 900) {
      await page.locator("#scrim").click({ position: { x: width - 8, y: 40 } });
      await expect(page.locator("#sidebar")).not.toHaveClass(/\bopen\b/);
    }
    await centeredLogo(page, ".footer-mark img", "#site-footer", ".footer-mark strong");
    await page.locator(".ws-ai-head").scrollIntoViewIfNeeded();
    const flame = await page.locator(".ws-mini-fire").boundingBox();
    const heading = await page.locator("#ws-ai-title").boundingBox();
    expect(Math.abs((flame.x + flame.width / 2) - (heading.x + heading.width / 2)), "the AI card's decorative flame also shares the title's centerline").toBeLessThanOrEqual(1);
    expect(flame.y + flame.height).toBeLessThanOrEqual(heading.y);
    await expectNoHorizontalOverflow(page);
  }
});

test("AI home, persistent masthead and menu use the full centered logo in dark and light themes", async ({ page }) => {
  await stubStudent(page);
  await page.goto("/ai.html");
  await expect(page.locator("body")).toHaveAttribute("data-auth-gate", "unlocked");
  for (const width of widths) {
    await page.setViewportSize({ width, height: 1000 });
    await centeredLogo(page, ".fc-title img", ".fc-top", "#fc-mode-name");
    await centeredLogo(page, ".fc-logo img", ".fc-home", ".fc-home h1");
    await page.locator("#fc-menu").click();
    await centeredLogo(page, ".fc-brand img", "#fc-drawer", ".fc-brand strong");
    await page.locator("#fc-drawer-close").click();
    await expect(page.locator("#fc-drawer")).toBeHidden();
    await expectNoHorizontalOverflow(page);
  }
  await page.setViewportSize({ width: 320, height: 740 });
  await page.locator("#fc-theme").click();
  await expect(page.locator("body")).toHaveAttribute("data-theme", "light");
  await centeredLogo(page, ".fc-title img", ".fc-top", "#fc-mode-name");
  await page.goto("/ai.html?mode=questions");
  await expect(page.locator("#fc-mode-name")).toHaveText("Question setter");
  await centeredLogo(page, ".fc-title img", ".fc-top", "#fc-mode-name");
  await expect(page.locator("#ai-input")).toBeInViewport();
  await expectNoHorizontalOverflow(page);
});

test("admin branding is centered independently of preview controls and sticky navigation stays below it", async ({ page }) => {
  await stubAuth(page);
  await page.goto("/admin.html");
  for (const width of widths) {
    await page.setViewportSize({ width, height: 844 });
    await centeredLogo(page, ".admin-brand img", ".admin-topbar", ".admin-brand strong");
    const header = await page.locator(".admin-topbar").boundingBox();
    const controls = await page.locator(".admin-top-actions").boundingBox();
    const nav = await page.locator(".admin-sidebar").boundingBox();
    expect(controls.y + controls.height, "preview controls remain inside the masthead").toBeLessThanOrEqual(header.y + header.height);
    expect(nav.y, "admin navigation does not overlap the taller masthead").toBeGreaterThanOrEqual(header.y + header.height - 1);
    await expect(page.locator("#preview-site-top")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }
});

test("signed-out workspace and AI gates show the full centered brand artwork", async ({ page }) => {
  await stubAuth(page);
  for (const path of ["/study.html", "/ai.html"]) {
    await page.goto(path);
    await expect(page.locator("body")).toHaveAttribute("data-auth-gate", "locked");
    for (const width of widths) {
      await page.setViewportSize({ width, height: 844 });
      await centeredLogo(page, ".auth-gate-brand", ".auth-gate-card");
      await expectNoHorizontalOverflow(page);
    }
  }
});

test("published custom brand names wrap without moving the homepage or mobile workspace logo off center", async ({ page }) => {
  const name = "FIRE COUNSEL LEGAL LEARNING AND RESEARCH";
  await stubStudent(page);
  await stubFirestore(page, { content: { ...bundled, brand: { ...bundled.brand, name }, workspace: { brand: { name, tagline: "Your legal study and research companion", logo: bundled.brand.markImage } } } });
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/");
  await expect(page.locator("#brand-name")).toHaveText(name);
  await centeredLogo(page, "#brand-image", ".site-header", "#brand-name");
  await centeredLogo(page, ".footer-mark img", "#site-footer", ".footer-mark strong");
  await expectNoHorizontalOverflow(page);
  await page.goto("/study.html");
  await expect(page.locator("#ws-top-brand-name")).toHaveText(name);
  await expect(page.locator("#ws-brand-name")).toHaveText(name);
  await centeredLogo(page, "#ws-top-logo", ".ws-topbar", "#ws-top-brand-name");
  await expectNoHorizontalOverflow(page);
});
