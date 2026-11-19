import { readFileSync } from "node:fs";
import { test, expect, stubAuth, stubFirestore, student, admin, json, catalog } from "./fixtures.mjs";
import { DEFAULT_WORKSPACE } from "../../workspace-config.mjs";

const bundled = JSON.parse(readFileSync(new URL("../../data/site-content.json", import.meta.url), "utf8"));

async function adminApi(page, { published = bundled, draft = null, archiveStatus = 200, archiveReadStatus = 200 } = {}) {
  const writes = [];
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/v1/admin/site/firebase") return route.fallback();
    if (path === "/api/health") return json(route, { database: "connected" });
    if (path.endsWith("/database/catalog")) return json(route, { data: catalog });
    if (path === "/api/v1/admin/site" && request.method() === "GET") return archiveReadStatus !== 200
      ? json(route, { error: "Synthetic Neon archive-read outage", code: "SITE_SCHEMA_NOT_READY" }, archiveReadStatus)
      : json(route, { data: {
        published: { content: published, updated_at: "2026-11-01T10:00:00Z" },
        draft: draft && { content: draft, updated_at: "2026-11-02T10:00:00Z" }, versions: []
      } });
    if (path === "/api/v1/admin/site/publish" || path === "/api/v1/admin/site/draft") {
      writes.push({ path, body: request.postDataJSON(), firebaseWrites: await page.evaluate(() => window.__firestore.writes.length) });
      return path.endsWith("/publish") && archiveStatus !== 200
        ? json(route, { error: "Synthetic Neon archive outage", code: "SITE_SAVE_FAILED" }, archiveStatus)
        : json(route, { data: { saved: true } });
    }
    return json(route, { user: { ...admin, role: "admin" } });
  });
  return writes;
}

test("the homepage renders a Firestore publish with required metadata instead of discarding it", async ({ page }) => {
  const content = { ...bundled, brand: { ...bundled.brand, name: "Published Firebase Brand" } };
  await stubFirestore(page, { content });
  await page.goto("/");
  await expect(page.locator("#brand-name")).toHaveText("Published Firebase Brand");
  await expect(page.locator("#hero-slides .hero-slide")).toHaveCount(2);
  expect(await page.evaluate(() => window.__firestore.document.updatedBy)).toBe("synthetic-admin");
});

test("admin claim/server publish failures never reach Neon, and archive failure never reports a live publish as rolled back", async ({ page }) => {
  await stubAuth(page, { user: admin });
  await stubFirestore(page, { content: bundled });
  const writes = await adminApi(page, { archiveStatus: 503 });
  page.on("dialog", dialog => dialog.accept());
  await page.goto("/admin.html");
  await expect(page.locator("#admin-auth-status")).toHaveAttribute("data-state", "verified");
  await page.locator("[data-panel=content]").click();
  await expect(page.locator("#editor-status")).toContainText("Live content loaded from Firebase");
  const content = { ...bundled, brand: { ...bundled.brand, name: "Firebase survives archive outage" } };
  await page.locator("#json-editor").fill(JSON.stringify(content));

  await page.evaluate(() => { window.__firestore.adminClaim = false; });
  await page.locator("#publish-site").click();
  await expect(page.locator("#editor-status")).toContainText("no server-issued admin claim");
  expect(writes).toEqual([]);
  expect(await page.evaluate(() => window.__firestore.writes.length)).toBe(0);

  await page.evaluate(() => { window.__firestore.adminClaim = true; window.__firestore.failWrites = "permission-denied"; });
  await page.locator("#publish-site").click();
  await expect(page.locator("#editor-status")).toContainText("matching Firebase project");
  expect(writes).toEqual([]);

  await page.evaluate(() => { window.__firestore.failWrites = null; });
  await page.locator("#publish-site").click();
  await expect(page.locator("#editor-status")).toContainText("Live on Firebase now");
  await expect(page.locator("#editor-status")).toContainText("Synthetic Neon archive outage");
  await expect(page.locator("#editor-status")).not.toContainText("nothing went live");
  expect(writes).toHaveLength(1);
  expect(writes[0].firebaseWrites).toBe(1);
  expect(await page.evaluate(() => window.__firestore.document.brand.name)).toBe(content.brand.name);
});

test("an unconfirmed API reply never claims rollback or archives uncertain homepage/workspace writes", async ({ page }) => {
  await stubAuth(page, { user: admin });
  await stubFirestore(page, { content: { ...bundled, workspace: structuredClone(DEFAULT_WORKSPACE) } });
  const archives = await adminApi(page);
  page.on("dialog", dialog => dialog.accept());
  await page.goto("/admin.html");
  await expect(page.locator("#admin-auth-status")).toHaveAttribute("data-state", "verified");
  await page.locator("[data-panel=content]").click();
  await expect(page.locator("#editor-status")).toContainText("Live content loaded from Firebase");
  await page.evaluate(() => { window.__firestore.unconfirmedReply = true; });
  await page.locator("#json-editor").fill(JSON.stringify({ ...bundled, brand: { ...bundled.brand, name: "Committed but not acknowledged" } }));
  await page.locator("#publish-site").click();
  await expect(page.locator("#editor-status")).toContainText("publishing was not confirmed");
  await expect(page.locator("#editor-status")).not.toContainText("nothing went live");
  expect(await page.evaluate(() => window.__firestore.document.brand.name)).toBe("Committed but not acknowledged");
  expect(archives).toEqual([]);

  await page.locator("[data-panel=workspace]").click();
  await expect(page.locator("#ws-admin-status")).toContainText("live student workspace is loaded");
  await page.locator('[data-path="welcome.title"]').fill("Workspace with uncertain acknowledgement");
  await page.locator("#ws-admin-publish").click();
  await expect(page.locator("#ws-admin-status")).toContainText("publishing was not confirmed");
  await expect(page.locator("#ws-admin-status")).not.toContainText("nothing went live");
  expect(await page.evaluate(() => window.__firestore.document.workspace.welcome.title)).toBe("Workspace with uncertain acknowledgement");
  expect(archives).toEqual([]);
});

test("workspace publishing preserves the primary homepage and unpublished JSON draft, and students read that same Firebase content", async ({ page, context }) => {
  const live = { ...bundled, brand: { ...bundled.brand, name: "Newer Firebase homepage" }, workspace: structuredClone(DEFAULT_WORKSPACE) };
  const draft = { ...bundled, brand: { ...bundled.brand, name: "Unpublished homepage work" } };
  await stubAuth(page, { user: admin });
  await stubFirestore(page, { content: live });
  const writes = await adminApi(page, { draft });
  await page.goto("/admin.html");
  await expect(page.locator("#admin-auth-status")).toHaveAttribute("data-state", "verified");
  await page.locator("[data-panel=workspace]").click();
  await expect(page.locator("#ws-admin-status")).toContainText("live student workspace is loaded");
  await page.locator('[data-path="welcome.title"]').fill("Welcome to the new term");
  await page.locator("#ws-admin-publish").click();
  await expect(page.locator("#ws-admin-status")).toContainText("Published on Firebase and archived in Neon");
  expect(writes.map(write => [write.path, write.firebaseWrites])).toEqual([
    ["/api/v1/admin/site/publish", 1], ["/api/v1/admin/site/draft", 1]
  ]);
  expect(writes[0].body.content.brand.name).toBe("Newer Firebase homepage");
  expect(writes[1].body.content.brand.name).toBe("Unpublished homepage work");
  expect(writes[0].body.content.workspace.welcome.title).toBe("Welcome to the new term");
  expect(writes[1].body.content.workspace.welcome.title).toBe("Welcome to the new term");
  const published = await page.evaluate(() => window.__firestore.document);
  const studentPage = await context.newPage();
  await stubAuth(studentPage, { user: student });
  await stubFirestore(studentPage, { content: published });
  await studentPage.route("**/api/v1/presence", route => route.fulfill({ status: 204 }));
  await studentPage.goto("/study.html");
  await expect(studentPage.locator("#ws-welcome-title")).toHaveText("Welcome to the new term");
  await studentPage.close();
});

test("an unavailable Neon archive cannot hide Firebase content or overwrite an unknown draft on workspace publish", async ({ page }) => {
  const live = { ...bundled, brand: { ...bundled.brand, name: "Primary without Neon" }, workspace: structuredClone(DEFAULT_WORKSPACE) };
  await stubAuth(page, { user: admin });
  await stubFirestore(page, { content: live });
  const writes = await adminApi(page, { archiveReadStatus: 503 });
  await page.goto("/admin.html");
  await expect(page.locator("#admin-auth-status")).toHaveAttribute("data-state", "verified");
  await page.locator("[data-panel=content]").click();
  await expect(page.locator("#editor-status")).toContainText("Live content loaded from Firebase");
  await expect(page.locator("#json-editor")).toHaveValue(/Primary without Neon/);
  await page.locator("[data-panel=workspace]").click();
  await expect(page.locator("#ws-admin-status")).toContainText("live student workspace is loaded");
  await page.locator('[data-path="welcome.title"]').fill("Firebase independent publish");
  await page.locator("#ws-admin-publish").click();
  await expect(page.locator("#ws-admin-status")).toContainText("Live on Firebase");
  await expect(page.locator("#ws-admin-status")).toContainText("Synthetic Neon archive-read outage");
  expect(writes).toEqual([], "never overwrite an unpublished archive draft that could not be read");
  const saved = await page.evaluate(() => window.__firestore.document);
  expect(saved.brand.name).toBe("Primary without Neon");
  expect(saved.workspace.welcome.title).toBe("Firebase independent publish");
  expect(saved.updatedBy).toBe(admin.uid);
});

test("a late pre-initialization workspace fallback cannot overwrite a newer Firebase load", async ({ page }) => {
  const live = { ...bundled, workspace: { ...structuredClone(DEFAULT_WORKSPACE), welcome: { ...DEFAULT_WORKSPACE.welcome, title: "Latest live workspace" } } };
  await stubAuth(page, { user: admin });
  await stubFirestore(page, { content: live });
  await adminApi(page);
  let releaseClient, releaseFallback, fallbackStarted;
  const clientGate = new Promise(resolve => { releaseClient = resolve; });
  const fallbackGate = new Promise(resolve => { releaseFallback = resolve; });
  const fallbackRequest = new Promise(resolve => { fallbackStarted = resolve; });
  await page.route("**/firebase/firestore-client.mjs", async route => { await clientGate; await route.fallback(); });
  let requests = 0;
  await page.route("**/data/site-content.json", async route => {
    if (++requests > 1) { fallbackStarted(); await fallbackGate; }
    return json(route, bundled);
  });
  try {
    await page.goto("/admin.html", { waitUntil: "commit" });
    await fallbackRequest;
    releaseClient();
    await page.locator("[data-panel=workspace]").click();
    await expect(page.locator('[data-path="welcome.title"]')).toHaveValue("Latest live workspace");
    const staleResponse = page.waitForResponse(response => response.url().endsWith("/data/site-content.json"));
    releaseFallback();
    await (await staleResponse).finished();
    // Process the released response and render before asserting it was ignored.
    await page.bringToFront();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.locator('[data-path="welcome.title"]')).toHaveValue("Latest live workspace");
    await expect(page.locator("#ws-admin-status")).toContainText("live student workspace is loaded");
  } finally {
    releaseClient();
    releaseFallback();
  }
});
