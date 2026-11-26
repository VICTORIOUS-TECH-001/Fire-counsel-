import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test, expect, expectNoHorizontalOverflow, stubFirestore } from "./fixtures.mjs";

const bundled = JSON.parse(readFileSync(new URL("../../data/site-content.json", import.meta.url), "utf8"));
const introduction = "Fire Counsel is more than a place to learn the law. It is the intelligence behind your success, empowering you to master the law, unlock your potential and become one of tomorrow's great legal minds.";

async function readyLearning(page) {
  await page.goto("/");
  await expect(page.locator("#learning-cards")).toHaveAttribute("data-enhanced", "true");
}

test("the learning section joins the hero directly, keeps our words and replaces the principles strip", async ({ page }) => {
  await readyLearning(page);
  await expect(page.locator("#home .hero-introduction")).toHaveText(introduction);
  await expect(page.locator(".hero-section + #learning")).toHaveCount(1);
  await expect(page.locator(".quickfacts, #quickfacts-grid")).toHaveCount(0);
  const section = page.locator("#learning");
  await expect(section).not.toContainText(/Projexion|Outsourced data|Control Tower|Increase productivity|Stay focused|Recall more|Practise well/);
  await expect(section.locator("h2")).toHaveText("Tools for the workbehind the law.");
  await expect(page.locator("#learning-intro")).toHaveText(bundled.learning.intro);
  await expect(section).toHaveCSS("background-color", "rgb(10, 8, 32)");
  for (const [index, tool] of bundled.learning.cards.entries()) {
    const tab = section.getByRole("tab", { name: tool.title, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(tab.locator(".learning-tool-body")).toHaveText(tool.text);
    const panel = section.getByRole("tabpanel");
    await expect(panel).toHaveCount(1);
    await expect(panel.locator("h3")).toHaveText(tool.title);
    await expect(panel.locator(".learning-open")).toHaveAttribute("href", tool.href);
    await expect(section.locator(".learning-pane").nth(index)).toBeVisible();
  }
  await expect(page.locator("#case-image")).toHaveAttribute("src", bundled.caseNotes.image);
  await expect(page.locator("#brand-image")).toHaveAttribute("src", bundled.brand.markImage);
  await expect(page.locator("#case-intro")).toHaveText(bundled.caseNotes.intro);
  await expect(page.locator("#footer-disclaimer")).toHaveText(bundled.footer.disclaimer);
});

test("learning controls support keyboard selection and reduced motion without moving focus or autoplay", async ({ page }) => {
  await readyLearning(page);
  const tabs = page.locator('#learning-cards [role="tab"]');
  await tabs.first().focus();
  await page.keyboard.press("ArrowDown");
  await expect(tabs.nth(1)).toBeFocused();
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(tabs.last()).toBeFocused();
  await expect(tabs.last()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  await expect(tabs.first()).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(tabs.last()).toBeFocused();
  await page.keyboard.press("Home");
  await expect(tabs.first()).toBeFocused();
  await expect(tabs).toHaveCount(4);
  await expect(page.locator('#learning-cards [tabindex="0"]')).toHaveCount(1);
  await expect(page.locator('.learning-pane:not([hidden])')).toHaveCount(1);
  await expect(page.locator('.learning-pane:not([hidden]) .learning-badge')).toHaveCSS("animation-name", "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(page.locator('.learning-pane:not([hidden]) .learning-badge')).toHaveCSS("animation-name", "learningFloat");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(tabs.first()).toBeFocused();
  await expect(page.locator('.learning-pane:not([hidden]) .learning-badge')).toHaveCSS("animation-name", "none");
});

test("the wider title and reference-style learning split fit four viewports with a seamless join", async ({ page }) => {
  await readyLearning(page);
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await expectNoHorizontalOverflow(page);
    const hero = await page.locator("#home").boundingBox();
    const learning = await page.locator("#learning").boundingBox();
    const heading = await page.locator("#home h1").boundingBox();
    const title = await page.locator("#home h1").evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element);
      const box = range.getBoundingClientRect();
      return { x: box.x, right: box.right, width: box.width, height: box.height, lineHeight: parseFloat(getComputedStyle(element).lineHeight) };
    });
    expect(Math.abs(hero.y + hero.height - learning.y)).toBeLessThanOrEqual(1);
    expect(title.width).toBeGreaterThan(width * .72);
    expect(title.x).toBeGreaterThanOrEqual(16);
    expect(title.right).toBeLessThanOrEqual(width - 16);
    expect(title.height).toBeLessThan(heading.height * 1.3);
    expect(title.height).toBeLessThan(title.lineHeight * 1.4);
    const [tabs, preview] = await Promise.all([
      page.locator("#learning-cards").boundingBox(), page.locator("#learning-visual").boundingBox()
    ]);
    if (width > 900) {
      expect(preview.x).toBeGreaterThan(tabs.x + tabs.width);
      expect(Math.abs(preview.y - tabs.y)).toBeLessThan(120);
    } else {
      expect(preview.y).toBeGreaterThanOrEqual(tabs.y + tabs.height + 25);
    }
    await page.locator("#learning").scrollIntoViewIfNeeded();
    await expectNoHorizontalOverflow(page);
    if (process.env.SHOT_DIR) {
      await mkdir(process.env.SHOT_DIR, { recursive: true });
      await expect(page.locator("#fc-preloader")).toBeHidden();
      await page.locator("#learning").screenshot({ path: join(process.env.SHOT_DIR, `home-learning-${width}.png`) });
      await page.locator("#home").screenshot({ path: join(process.env.SHOT_DIR, `home-introduction-${width}.png`) });
    }
  }
});

test("published tool edits stay escaped and keep safe destinations without restoring old principles", async ({ page }) => {
  const content = structuredClone(bundled);
  content.quickFacts = [{ number: "01", label: "Stay focused", detail: "A calm, organised study space" }];
  content.learning.cards[1] = {
    ...content.learning.cards[1], title: 'My <img src=x onerror=alert(1)> library',
    text: 'Keep <script>alert(1)</script> as plain text.', href: "javascript:alert(1)"
  };
  await stubFirestore(page, { content });
  await readyLearning(page);
  const tab = page.getByRole("tab", { name: content.learning.cards[1].title, exact: true });
  await tab.click();
  await expect(tab.locator(".learning-tool-body")).toHaveText(content.learning.cards[1].text);
  const panel = page.getByRole("tabpanel");
  await expect(panel.locator("h3")).toHaveText(content.learning.cards[1].title);
  await expect(panel.locator(".learning-open")).toHaveAttribute("href", "#");
  await expect(page.locator("#learning img, #learning script, .quickfacts, #quickfacts-grid")).toHaveCount(0);
  await expect(page.locator("#home .hero-introduction")).toHaveText(introduction);
  expect(await page.evaluate(() => window.__firestore.writes)).toEqual([]);
});

test("static learning fallback retains all four working tool links and the new introduction", async ({ page }) => {
  await page.route("**/site.js", route => route.abort("blockedbyclient"));
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto("/");
  await expect(page.locator("#home .hero-introduction")).toHaveText(introduction);
  for (const tool of bundled.learning.cards) {
    await expect(page.locator("#learning-cards").getByRole("link", { name: tool.title, exact: true })).toHaveAttribute("href", tool.href);
  }
  await expect(page.locator("#learning-cards button, .quickfacts")).toHaveCount(0);
  await expect(page.locator("#learning-visual")).toBeHidden();
  await expect(page.locator("#case-image")).toHaveAttribute("src", bundled.caseNotes.image);
  await expectNoHorizontalOverflow(page);
});

test("an empty published tools list does not break the rest of the homepage", async ({ page }) => {
  const content = structuredClone(bundled);
  content.learning.cards = [];
  await stubFirestore(page, { content });
  await readyLearning(page);
  await expect(page.locator("#learning-cards")).toHaveText("Study tools are being prepared.");
  await expect(page.locator("#learning-visual")).toBeHidden();
  await expect(page.locator("#article-grid > *")).toHaveCount(content.articles.items.length);
  await expect(page.locator("#footer-disclaimer")).toHaveText(content.footer.disclaimer);
});
