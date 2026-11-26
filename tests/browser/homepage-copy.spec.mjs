import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test, expect, expectNoHorizontalOverflow, stubAuth, stubFirestore, admin, student, rowId, catalog, json } from "./fixtures.mjs";

const bundled = JSON.parse(readFileSync(new URL("../../data/site-content.json", import.meta.url), "utf8"));
const field = (page, path) => page.locator(`[data-homepage-path="${path}"]`);
const draftContent = page => page.locator("#json-editor").inputValue().then(JSON.parse);

async function studio(page, { live = bundled, draft = null, version = null } = {}) {
  await stubAuth(page, { user: admin });
  await stubFirestore(page, { content: live });
  const writes = [];
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === "/api/v1/admin/site/firebase") return route.fallback();
    if (path === "/api/health") return json(route, { database: "connected" });
    if (path.endsWith("/database/catalog")) return json(route, { data: catalog });
    if (path === "/api/v1/admin/site" && request.method() === "GET") return json(route, { data: {
      published: { content: live, updated_at: "2026-11-01T10:00:00Z" },
      draft: draft && { content: draft, updated_at: "2026-11-02T10:00:00Z" },
      versions: version ? [{ id: rowId, created_at: "2026-10-01T10:00:00Z", note: "Synthetic copy version" }] : []
    } });
    if (path === `/api/v1/admin/site/versions/${rowId}`) return json(route, { data: { content: version, created_at: "2026-10-01T10:00:00Z" } });
    if (path === "/api/v1/admin/site/draft" || path === "/api/v1/admin/site/publish") {
      writes.push({ path, body: request.postDataJSON(), firebaseWrites: await page.evaluate(() => window.__firestore.writes.length) });
      return json(route, { data: { saved: true } });
    }
    return json(route, { user: { ...admin, role: "admin" } });
  });
  page.on("dialog", dialog => dialog.accept());
  return writes;
}

async function openEditor(page) {
  await page.goto("/admin.html");
  await page.locator("[data-panel=content]").click();
  await expect(field(page, "hero.copy.title")).toBeEnabled();
}

test("plain-text homepage fields share the protected draft, unsaved preview and explicit publish flow", async ({ page, context }) => {
  const draft = structuredClone(bundled);
  draft.hero.copy.introduction = "An unpublished opening paragraph.";
  const writes = await studio(page, { draft });
  await openEditor(page);
  const introduction = field(page, "hero.copy.introduction");
  await expect(introduction).toHaveValue(draft.hero.copy.introduction);
  await introduction.fill("Learn");
  await introduction.pressSequentially(" with purpose and confidence.");
  await expect(introduction).toHaveValue("Learn with purpose and confidence.");
  await expect(introduction).toBeFocused();
  await field(page, "hero.copy.tagline").fill("Legal learning, your way.");
  await field(page, "learning.title").fill("Tools for <law>");
  await field(page, "learning.intro").fill("An introduction edited without touching JSON.");
  await field(page, "learning.cards.0.text").fill("A description written by the administrator.");
  await field(page, "learning.cards.0.linkLabel").fill("Choose your course");
  await field(page, "aiSpotlight.title").fill("Study <b>law</b> with Fire Counsel AI");
  await field(page, "aiSpotlight.intro").fill("An AI introduction edited in the shared draft.");
  await field(page, "aiSpotlight.closing").fill("A closing paragraph from the administrator.");
  await field(page, "aiSpotlight.buttonLabel").fill("Open our AI study companion");
  await field(page, "aiSpotlight.chips.0").fill("Study ideas");
  await page.locator(".homepage-preview-copy > summary").first().click();
  await field(page, "learning.cards.0.preview.badge").fill("Organised by you <b>not bold</b>");
  await field(page, "learning.cards.0.preview.labels.2").fill("A custom course choice");
  await expect(page.locator("#homepage-copy-status")).toContainText("not saved or published");
  const edited = await draftContent(page);
  expect(edited.hero.copy.introduction).toBe("Learn with purpose and confidence.");
  expect(edited.hero.slides).toEqual(bundled.hero.slides);
  expect(edited.caseNotes).toEqual(bundled.caseNotes);
  expect(edited.brand).toEqual(bundled.brand);
  expect(writes).toEqual([]);
  expect(await page.evaluate(() => window.__firestore.writes)).toEqual([]);

  await page.locator("#save-draft").click();
  await expect(page.locator("#editor-status")).toContainText("Draft saved");
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ path: "/api/v1/admin/site/draft", body: { content: edited }, firebaseWrites: 0 });
  const [preview] = await Promise.all([page.waitForEvent("popup"), page.locator("#preview-site").click()]);
  const errors = [];
  preview.on("pageerror", error => errors.push(error.message));
  try {
    await preview.bringToFront();
    await preview.waitForLoadState("domcontentloaded");
    await expect(preview.locator("#preview-banner")).toContainText("PREVIEW");
    await expect(preview.locator("#home .hero-introduction")).toHaveText(edited.hero.copy.introduction);
    await expect(preview.locator("#home .hero-tagline")).toHaveText(edited.hero.copy.tagline);
    await expect(preview.locator("#learning-title")).toHaveText("Tools for <law>behind the law.");
    await expect(preview.locator("#learning-intro")).toHaveText(edited.learning.intro);
    await expect(preview.locator("#learning-pane-0 .learning-badge")).toHaveText(edited.learning.cards[0].preview.badge);
    await expect(preview.locator("#learning-pane-0 .learning-table-row").nth(1)).toContainText("A custom course choice");
    await expect(preview.locator("#learning-pane-0 .learning-open")).toHaveText("Choose your course ↗");
    await expect(preview.locator("#home a")).toHaveCount(1);
    await expect(preview.locator("#home a")).toHaveAttribute("href", "./auth.html");
    await expect(preview.locator("#home img, #learning img, #learning b, #learning script")).toHaveCount(0);
    await expect(preview.locator("#case-image")).toHaveAttribute("src", bundled.caseNotes.image);
    await expect(preview.locator("#home-ai-title")).toHaveText(edited.aiSpotlight.title);
    await expect(preview.locator("#home-ai-intro")).toHaveText(edited.aiSpotlight.intro);
    await expect(preview.locator("#home-ai-closing")).toHaveText(edited.aiSpotlight.closing);
    await expect(preview.locator("#home-ai-button-label")).toHaveText(edited.aiSpotlight.buttonLabel);
    await expect(preview.locator(".home-ai-chip").first()).toHaveText("Study ideas");
    await expect(preview.locator("#home-ai b, #home-ai script")).toHaveCount(0);
    await expect(preview.locator(".home-ai-open")).toHaveAttribute("href", "./ai.html");
    expect(errors).toEqual([]);
  } finally { await preview.close(); }
  expect(writes).toHaveLength(1, "previewing never publishes");
  await page.locator("#publish-site").click();
  await expect(page.locator("#editor-status")).toContainText("Published!");
  expect(writes).toHaveLength(2);
  expect(writes[1]).toMatchObject({ path: "/api/v1/admin/site/publish", body: { content: edited }, firebaseWrites: 1 });
  const published = await page.evaluate(() => window.__firestore.document);
  expect(published.hero.copy).toEqual(edited.hero.copy);
  expect(published.learning).toEqual(edited.learning);
  expect(published.aiSpotlight).toEqual(edited.aiSpotlight);
  const visitor = await context.newPage();
  try {
    await stubFirestore(visitor, { content: published });
    await visitor.goto("/");
    await expect(visitor.locator("#home .hero-introduction")).toHaveText(edited.hero.copy.introduction);
    await expect(visitor.locator("#learning-pane-0 .learning-badge")).toHaveText(edited.learning.cards[0].preview.badge);
    await expect(visitor.locator("#home-ai-title")).toHaveText(edited.aiSpotlight.title);
    await expect(visitor.locator(".home-ai-chip").first()).toHaveText("Study ideas");
  } finally { await visitor.close(); }
});

test("JSON edits, invalid JSON, import, discard and version restore keep the copy fields in sync", async ({ page }) => {
  const version = structuredClone(bundled);
  version.hero.copy.title = "Restored introduction";
  version.learning.cards[0].text = "An older tool description.";
  version.aiSpotlight.title = "Restored AI section";
  const writes = await studio(page, { version });
  await openEditor(page);
  const direct = structuredClone(bundled);
  direct.hero.copy.title = "Words from JSON";
  direct.learning.cards[0].text = "Words from the same JSON source.";
  direct.aiSpotlight.intro = "AI words from the same JSON source.";
  await page.locator("#json-editor").fill(JSON.stringify(direct));
  await expect(field(page, "hero.copy.title")).toHaveValue(direct.hero.copy.title);
  await expect(field(page, "learning.cards.0.text")).toHaveValue(direct.learning.cards[0].text);
  await expect(field(page, "aiSpotlight.intro")).toHaveValue(direct.aiSpotlight.intro);
  await page.locator("#json-editor").fill("{");
  await expect(field(page, "hero.copy.title")).toBeDisabled();
  await expect(field(page, "aiSpotlight.title")).toBeDisabled();
  await expect(page.locator("#homepage-copy-status")).toContainText("Fix the JSON");
  await expect(page.locator("#json-editor")).toHaveValue("{");
  await page.locator("#json-editor").fill(JSON.stringify(direct));
  await expect(field(page, "hero.copy.title")).toBeEnabled();

  const imported = structuredClone(bundled);
  imported.hero.copy.title = "Imported words";
  imported.learning.cards = imported.learning.cards.slice(0, 2);
  imported.aiSpotlight.chips[4] = "Imported exam label";
  await page.locator("#json-import").setInputFiles({ name: "homepage-words.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(imported)) });
  await expect(field(page, "hero.copy.title")).toHaveValue(imported.hero.copy.title);
  await expect(field(page, "aiSpotlight.chips.4")).toHaveValue("Imported exam label");
  await expect(page.locator(".homepage-copy-tool")).toHaveCount(2);
  expect((await draftContent(page)).learning.cards).toHaveLength(2);
  await page.locator("#clear-draft").click();
  await expect(field(page, "hero.copy.title")).toHaveValue(bundled.hero.copy.title);
  await expect(page.locator(".homepage-copy-tool")).toHaveCount(4);
  await expect(field(page, "aiSpotlight.chips.4")).toHaveValue(bundled.aiSpotlight.chips[4]);
  expect(writes).toEqual([]);
  await page.locator("[data-restore-version]").click();
  await expect(page.locator("#editor-status")).toContainText("live again on Firebase");
  await expect(field(page, "hero.copy.title")).toHaveValue(version.hero.copy.title);
  await expect(field(page, "learning.cards.0.text")).toHaveValue(version.learning.cards[0].text);
  await expect(field(page, "aiSpotlight.title")).toHaveValue("Restored AI section");
  expect(writes).toHaveLength(1);
  expect(writes[0].firebaseWrites).toBe(1);
});

test("copy fields wait for the newer draft, retain typed words, fit mobile and lock on sign-out", async ({ page }) => {
  await page.clock.install();
  const draft = structuredClone(bundled);
  draft.hero.copy.title = "The newer saved draft";
  const writes = await studio(page, { draft });
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const requestStarted = new Promise(resolve => { started = resolve; });
  await page.route("**/api/v1/admin/site", async route => { started(); await gate; await route.fallback(); });
  try {
    await page.goto("/admin.html", { waitUntil: "commit" });
    await requestStarted;
    await page.locator("[data-panel=content]").click();
    await expect(field(page, "hero.copy.title")).toBeDisabled();
    await expect(field(page, "aiSpotlight.title")).toBeDisabled();
    release();
    await expect(field(page, "hero.copy.title")).toBeEnabled();
    await expect(field(page, "hero.copy.title")).toHaveValue(draft.hero.copy.title);
    await field(page, "hero.copy.title").fill("A deliberate local edit");
    await page.clock.runFor(1800); // real first-visit preloader minimum + removal
    await page.locator(".homepage-preview-copy > summary").first().click();
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expectNoHorizontalOverflow(page);
      if (process.env.SHOT_DIR && [390, 1440].includes(width)) {
        await mkdir(process.env.SHOT_DIR, { recursive: true });
        await expect(page.locator("#fc-preloader")).toBeHidden();
        await page.evaluate(() => window.scrollTo({
          top: window.scrollY + document.querySelector(".homepage-copy-editor").getBoundingClientRect().top - 150,
          behavior: "instant"
        }));
        await page.screenshot({ path: join(process.env.SHOT_DIR, `homepage-copy-admin-${width}.png`) });
      }
    }
    await expect(field(page, "hero.copy.title")).toHaveValue("A deliberate local edit");
    await page.locator("#admin-signout").click();
    await expect(field(page, "hero.copy.title")).toBeDisabled();
    await expect(field(page, "aiSpotlight.title")).toBeDisabled();
    await expect(page.locator("#publish-site")).toBeDisabled();
    expect((await draftContent(page)).hero.copy.title).toBe("A deliberate local edit");
    expect(writes).toEqual([]);
  } finally { release(); }
});

test("a late draft response cannot replace the editor or re-enable fields after sign-out", async ({ page }) => {
  const draft = structuredClone(bundled);
  draft.hero.copy.title = "A late unpublished draft";
  await studio(page, { draft });
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const requestStarted = new Promise(resolve => { started = resolve; });
  await page.route("**/api/v1/admin/site", async route => { started(); await gate; await route.fallback(); });
  try {
    await page.goto("/admin.html", { waitUntil: "commit" });
    await requestStarted;
    await page.locator("#admin-signout").click();
    await expect(page.locator("#admin-auth-status")).toHaveAttribute("data-state", "signed-out");
    const response = page.waitForResponse(reply => new URL(reply.url()).pathname === "/api/v1/admin/site");
    release();
    await (await response).finished();
    await expect(page.locator("#json-editor")).toHaveAttribute("data-homepage-ready", "false");
    await expect(page.locator("#json-editor")).not.toHaveValue(/A late unpublished draft/);
    await page.locator("[data-panel=content]").click();
    await expect(field(page, "hero.copy.title")).toBeDisabled();
    await expect(field(page, "aiSpotlight.title")).toBeDisabled();
    await expect(page.locator("#publish-site")).toBeDisabled();
  } finally { release(); }
});

test("signed-out and non-admin accounts cannot enable the new copy fields", async ({ page }) => {
  await stubAuth(page);
  await page.route("**/api/**", route => json(route, { error: "Administrator required" }, 403));
  await page.goto("/admin.html");
  await page.locator("[data-panel=content]").click();
  await expect(field(page, "hero.copy.title")).toBeDisabled();
  await expect(field(page, "aiSpotlight.title")).toBeDisabled();
  await expect(page.locator("#publish-site")).toBeDisabled();
  await page.evaluate(user => window.__auth.setUser(user), student);
  await expect(page.locator("#admin-auth-status")).toHaveAttribute("data-state", "denied");
  await expect(field(page, "hero.copy.title")).toBeDisabled();
  await expect(field(page, "aiSpotlight.title")).toBeDisabled();
  await expect(page.locator("#publish-site")).toBeDisabled();
});

test("published introduction and all illustration words render as safe text, including long mobile edits", async ({ page }) => {
  const content = structuredClone(bundled);
  content.hero.copy = { title: "LegalClarity".repeat(9), tagline: "<b>Your legal future</b>", introduction: "Keep <script>alert(1)</script> as plain words." };
  content.learning.previewLabel = "Our <i>tool preview</i>";
  content.learning.cards.forEach((card, index) => {
    card.title = `Tool <i>${index}</i>`;
    card.text = "A literal <img src=x onerror=alert(1)> description.";
    card.linkLabel = `Enter <b>tool ${index}</b>`;
    card.href = "javascript:alert(1)";
    card.preview = { badge: `Badge <b>${index}</b>`, labels: Array.from({ length: index === 0 ? 10 : 3 }, (_unused, label) => `${"Legal".repeat(35)} <script>${label}</script>`) };
  });
  await stubFirestore(page, { content });
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto("/");
  await expect(page.locator("#learning-cards")).toHaveAttribute("data-enhanced", "true");
  await expect(page.locator("#home h1")).toHaveText(content.hero.copy.title);
  await expect(page.locator("#home .hero-tagline")).toHaveText(content.hero.copy.tagline);
  await expect(page.locator("#home .hero-introduction")).toHaveText(content.hero.copy.introduction);
  for (const [index, card] of content.learning.cards.entries()) {
    await page.getByRole("tab", { name: card.title, exact: true }).click();
    const panel = page.locator('.learning-pane:not([hidden])');
    await expect(panel.locator(".learning-preview-kicker")).toHaveText(content.learning.previewLabel);
    await expect(panel.locator(".learning-badge")).toHaveText(card.preview.badge);
    await expect(panel).toContainText(card.preview.labels[0]);
    await expect(panel.locator(".learning-open")).toHaveText(`${card.linkLabel} ↗`);
    await expect(panel.locator(".learning-open")).toHaveAttribute("href", "#");
    await expect(page.locator(`#learning-pane-${index}`)).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }
  await expect(page.locator("#home b, #home script, #learning img, #learning script, #learning b, #learning em i")).toHaveCount(0);
  await expect(page.locator("#home a")).toHaveAttribute("href", "./auth.html");
  await expect(page.locator("#brand-image")).toHaveAttribute("src", bundled.brand.markImage);
  await expect(page.locator("#case-image")).toHaveAttribute("src", bundled.caseNotes.image);
  expect(await page.evaluate(() => window.__firestore.writes)).toEqual([]);
});
