import { readFileSync } from "node:fs";
import { test, expect, stubAuth, stubFirestore, student, json } from "./fixtures.mjs";
import { validateSiteContent } from "../../firebase/content-schema.mjs";

const bundled = JSON.parse(readFileSync(new URL("../../data/site-content.json", import.meta.url), "utf8"));
const removed = "#case-title, #case-intro, #case-points, .case-copy, .case-disclaimer, #articles, #article-grid, #article-dialog, #resources, #privacy-note";

async function home(page, content = bundled) {
  expect(validateSiteContent(content)).toEqual({ ok: true, errors: [] });
  await stubFirestore(page, { content });
  await page.goto("/");
  await page.bringToFront();
  await expect(page.locator("#footer-disclaimer")).toHaveText(content.footer.disclaimer);
  await expect(page.locator("#fc-preloader")).toHaveCount(0);
}

async function expectTrimmedHome(page) {
  await expect(page.locator(removed)).toHaveCount(0);
  expect(await page.locator("main > section").evaluateAll(nodes => nodes.map(node => node.id)))
    .toEqual(["home", "learning", "home-ai", "cases", "exam-ready"]);
  await expect(page.locator("#case-cta")).toHaveText("Open case desk ↗");
  await expect(page.locator("#case-cta")).toHaveAttribute("href", "./ai.html?mode=case");
  await expect(page.locator("#case-cta span")).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator("#case-cta")).not.toHaveAttribute("data-ai-entry");
  await expect(page.locator("#exam-ready-title")).toHaveText("Make You Exam Ready Note");
  await expect(page.locator(".home-ai-chip")).toHaveText(["Hacks", "Clarity", "Legislation", "Statues", "Exam", "Cases"]);
  await expect(page.locator("#home .hero-signup")).toHaveAttribute("href", "./auth.html");
  await expect(page.locator("#case-video")).not.toHaveAttribute("controls");
}

test("legacy published blocks/CTA cannot return; only retired same-homepage links are omitted without rewriting content", async ({ page }) => {
  const content = structuredClone(bundled);
  content.caseNotes.title = '<img src=x onerror="window.__retiredInjected=true">';
  content.caseNotes.ctaLabel = "Restore old exam button";
  content.caseNotes.ctaHref = "./study.html#planner";
  content.caseNotes.status = "PUBLISHED CASE PREVIEW";
  content.navigation = [
    ...content.navigation.slice(0, 3),
    { label: "Old articles", href: "./index.html#articles" },
    { label: "Old sources", href: "/#resources" },
    { label: "Old privacy", href: "#privacy-note" },
    { label: "Research", href: "./study.html#ai-chat" },
    { label: "External archive", href: "https://example.invalid/library#articles" }
  ];
  content.footer.columns[2].items.push({ label: "Research", href: "./study.html#ai-chat" });
  content.footer.columns.push({ title: "Retired links", items: [
    { label: "Old articles", href: "./index.html#articles" },
    { label: "Old privacy", href: "/#privacy-note" }
  ] });
  await home(page, content);
  await expectTrimmedHome(page);
  await expect(page.locator("#case-status")).toHaveText(content.caseNotes.status);
  await expect(page.locator("#case-image")).toHaveAttribute("src", content.caseNotes.image);
  expect(await page.locator("#main-nav-links a").evaluateAll(nodes => nodes.map(node => node.getAttribute("href"))))
    .toEqual(["#home", "#learning", "#cases", "./study.html#ai-chat", "https://example.invalid/library#articles"]);
  expect(await page.locator(".footer-column h3").allTextContents()).toEqual(["Explore", "Study space", "Information"]);
  expect(await page.locator(".footer-column a").allTextContents())
    .toEqual(["Learning tools", "Case notes", "Open student workspace", "Personal library", "Exam practice", "Research"]);
  expect(await page.locator(".footer-column a").last().getAttribute("href")).toBe("./study.html#ai-chat");
  await expect(page.locator("body")).not.toContainText("Restore old exam button");
  expect(await page.evaluate(() => window.__retiredInjected || false)).toBe(false);
  expect(await page.evaluate(() => {
    const { updatedAt: _updatedAt, updatedBy: _updatedBy, ...content } = window.__firestore.document;
    return content;
  })).toEqual(content);
  expect(await page.evaluate(() => window.__firestore.writes)).toEqual([]);
  // / and /index.html represent the same homepage, including preview URLs.
  await page.goto("/index.html");
  await expect(page.locator("#footer-disclaimer")).toHaveText(content.footer.disclaimer);
  await expectTrimmedHome(page);
  expect(await page.locator("#main-nav-links a").count()).toBe(5);
});

test("keyboard activation opens the existing AI case-analysis mode for a Google-signed-in student without starting a case job", async ({ page }) => {
  await stubAuth(page, { user: student });
  const mutations = [];
  await page.route("**/api/**", route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === "/api/v1/presence") return route.fulfill({ status: 204 });
    if (request.method() !== "GET") mutations.push(path);
    if (path === "/api/v1/ai/me") return json(route, { data: { configured: true, web_search: true, email_verified: true,
      allowance: { premium: true, unlimited: true, features: {} } } });
    return json(route, { data: [] });
  });
  await home(page); await expectTrimmedHome(page);
  const action = page.getByRole("link", { name: "Open case desk", exact: true });
  await page.keyboard.press("Tab"); await action.focus();
  await expect(action).toBeFocused(); await expect(action).toHaveCSS("outline-style", "solid");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/ai\.html\?mode=case$/);
  await expect(page.locator("body")).toHaveAttribute("data-auth-gate", "unlocked");
  await expect(page.locator("body")).toHaveAttribute("data-mode", "case");
  await expect(page.locator("#ai-workspace-title")).toHaveText("Case analysis");
  expect(mutations).toEqual([]);
});

test("the case desk button does not bypass the existing signed-out Google gate", async ({ page }) => {
  await stubAuth(page);
  await home(page);
  await page.getByRole("link", { name: "Open case desk", exact: true }).click();
  await expect(page).toHaveURL(/\/ai\.html\?mode=case$/);
  await expect(page.locator("body")).toHaveAttribute("data-auth-gate", "locked");
  await expect(page.locator("#auth-gate-signin")).toHaveAttribute("href", "./auth.html?next=ai.html");
});

test("missing content script leaves the same trimmed layout, original photo and native desk destination usable", async ({ page }) => {
  await stubAuth(page);
  await page.route("**/site.js", route => route.abort("blockedbyclient"));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator("#fc-preloader")).toHaveCount(0);
  await expectTrimmedHome(page);
  await expect(page.locator("#case-image")).toHaveAttribute("src", bundled.caseNotes.image);
  await expect(page.locator("#case-video")).not.toHaveAttribute("src");
  await expect(page.locator('a[href="#articles"], a[href="#resources"], a[href="#privacy-note"]')).toHaveCount(0);
  await page.getByRole("link", { name: "Open case desk", exact: true }).click();
  await expect(page).toHaveURL(/\/ai\.html\?mode=case$/);
  await expect(page.locator("body")).toHaveAttribute("data-auth-gate", "locked");
});
