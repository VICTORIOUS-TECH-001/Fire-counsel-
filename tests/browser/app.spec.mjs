import { test, expect, stubAuth, student, admin, json, rowId, catalog } from "./fixtures.mjs";

async function readyStudy(page, hash = "dashboard") {
  await page.goto(`/study.html#${hash}`);
  await expect(page.locator("#today-label")).not.toHaveText("Today");
  await expect(page.locator("#course-nav-count")).toHaveText("6");
  await expect(page.locator("#active-course-select option")).toHaveCount(6);
}

async function finishReply(page, response) {
  await response.finished();
  // Let response.json() continuations and the resulting UI update finish before
  // asserting that a delayed reply did not restore previous-session content.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

test("public homepage renders JSON, carousel, articles and mobile navigation", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#hero-slides .hero-slide")).toHaveCount(2);
  await expect(page.locator("#hero-count")).toHaveText("01 / 02");
  await page.locator("#slide-next").click();
  await expect(page.locator("#hero-count")).toHaveText("02 / 02");
  await expect(page.locator("#learning-cards > *")).toHaveCount(4);
  await expect(page.locator("#article-grid > *")).not.toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#nav-toggle").click();
  await expect(page.locator("#nav-toggle")).toHaveAttribute("aria-expanded", "true");
  await page.locator("#main-nav-links a[href='#learning']").click();
  await expect(page.locator("#nav-toggle")).toHaveAttribute("aria-expanded", "false");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("local files, flashcards and personal subjects persist across a reload without uploading", async ({ page }) => {
  const mutations = [];
  page.on("request", request => { if (request.method() !== "GET") mutations.push(request.url()); });
  await readyStudy(page, "memory");
  await page.locator("#card-front").fill("Synthetic case recall question");
  await page.locator("#card-back").fill("Synthetic local answer");
  await page.locator("#memory-form button[type=submit]").click();
  await expect(page.locator("#memory-count")).toHaveText("1 card");
  await page.locator("#flip-card").click();
  await expect(page.locator("#recall-area")).toContainText("Synthetic local answer");
  await page.locator("[data-page=library]").click();
  await page.locator("#file-input").setInputFiles({ name: "synthetic-note.txt", mimeType: "text/plain", buffer: Buffer.from("Disposable browser-only note") });
  await expect(page.locator("#library-count")).toHaveText("1 file");
  await page.locator("[data-page=subjects]").click();
  await page.locator("#add-subject-button").click();
  await page.locator("#new-subject-name").fill("Synthetic Equity");
  await page.locator("#modal-confirm").click();
  await expect(page.locator("#course-nav-count")).toHaveText("7");
  await page.reload();
  await expect(page.locator("#course-nav-count")).toHaveText("7");
  await page.locator("[data-page=library]").click();
  await expect(page.locator("#document-list")).toContainText("synthetic-note.txt");
  await page.locator("[data-page=memory]").click();
  await expect(page.locator("#memory-count")).toHaveText("1 card");
  expect(mutations).toEqual([]);
});

test("existing legacy study records and session counter remain readable and unchanged", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async () => {
    localStorage.setItem("lexmaster-sessions", "7");
    await new Promise((resolve, reject) => {
      const request = indexedDB.open("lexmaster-ai-stage1", 1);
      request.onupgradeneeded = () => {
        for (const [name, keyPath] of [["documents", "id"], ["cards", "id"], ["settings", "key"]]) request.result.createObjectStore(name, { keyPath });
      };
      request.onerror = reject;
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction(["documents", "cards", "settings"], "readwrite");
        transaction.objectStore("documents").put({ id: "legacy-document", name: "legacy.txt", size: 9, blob: new Blob(["preserved"], { type: "text/plain" }), addedAt: 123 });
        transaction.objectStore("cards").put({ id: "legacy-card", front: "Legacy prompt", back: "Legacy answer", subject: "Contract Law", createdAt: 123 });
        transaction.objectStore("settings").put({ key: "unrelated-sentinel", value: "do-not-touch" });
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onerror = reject;
      };
    });
  });
  await readyStudy(page, "library");
  await expect(page.locator("#document-list")).toContainText("legacy.txt");
  await expect(page.locator("#stat-sessions")).toHaveText("7");
  await page.locator("[data-page=memory]").click();
  await expect(page.locator("#recall-area")).toContainText("Legacy prompt");
  const state = await page.evaluate(async () => {
    const db = await new Promise(resolve => { const r = indexedDB.open("lexmaster-ai-stage1", 1); r.onsuccess = () => resolve(r.result); });
    const transaction = db.transaction(["settings", "documents"]);
    const read = (store, key) => new Promise(resolve => { const r = transaction.objectStore(store).get(key); r.onsuccess = () => resolve(r.result); });
    const [sentinel, document] = await Promise.all([read("settings", "unrelated-sentinel"), read("documents", "legacy-document")]);
    db.close();
    return { version: db.version, sentinel: sentinel.value, text: await document.blob.text(), count: localStorage.getItem("lexmaster-sessions") };
  });
  expect(state).toEqual({ version: 1, sentinel: "do-not-touch", text: "preserved", count: "7" });
});

test("missing Firebase config degrades safely while the real proxy and authorization gates work", async ({ page }) => {
  await readyStudy(page, "library");
  await expect(page.locator("#server-materials-status")).toContainText("configuration is not available");
  await page.locator("[data-page=ai-chat]").click();
  await expect(page.locator("#research-search-status")).toContainText("configuration is not available");
  await page.locator("#research-query").fill("contract law");
  await page.locator("#research-search-button").click();
  await expect(page.locator("#research-search-status")).toContainText("Sign in");
  const state = await page.evaluate(async () => {
    const health = await fetch("/api/health");
    const gate = await fetch("/api/v1/admin/database/catalog");
    const privateFile = await fetch("/backend/package.json");
    return { healthStatus: health.status, health: await health.json(), gateStatus: gate.status, privateStatus: privateFile.status };
  });
  expect(state.healthStatus).toBe(503);
  expect(state.health.database).toBe("not_configured");
  expect(state.gateStatus).toBe(401);
  expect(state.privateStatus).toBe(404);
});

test("authenticated materials and verified source search render safe text from stubbed API replies", async ({ page }) => {
  await stubAuth(page, { user: student });
  const requests = [];
  await page.route("**/api/**", route => {
    requests.push(route.request());
    const path = new URL(route.request().url()).pathname;
    if (path === `/api/v1/materials/${rowId}`) return json(route, { data: { extracted_text: "Reviewed synthetic material text" } });
    if (path === "/api/v1/materials") return json(route, { data: [{ id: rowId, title: "Synthetic <script>unsafe()</script>", course_title: "Contract Law", material_type: "handout" }] });
    if (path === "/api/v1/research/search") return json(route, { data: { summaries: [{ id: rowId, case_name: "Synthetic case", full_summary: "First paragraph", key_principle: "Second paragraph" }] } });
    return json(route, { error: "Not part of this fixture" }, 404);
  });
  await readyStudy(page, "library");
  await expect(page.locator(".server-material-card")).toHaveCount(1);
  await expect(page.locator(".server-material-card h3")).toHaveText("Synthetic <script>unsafe()</script>");
  await expect(page.locator(".server-material-card script")).toHaveCount(0);
  await page.locator(".server-material-content summary").click();
  await expect(page.locator(".server-material-content pre")).toHaveText("Reviewed synthetic material text");
  await page.locator("[data-page=ai-chat]").click();
  await page.locator("#research-query").fill("contract law");
  await page.locator("#research-search-button").click();
  await expect(page.locator("#research-search-status")).toContainText("1 source result");
  await expect(page.locator(".research-result-card pre")).toHaveText("First paragraph\n\nSecond paragraph");
  expect(requests.every(request => request.headers().authorization === "Bearer synthetic-test-token")).toBe(true);
  expect(requests.find(request => request.method() === "POST").postDataJSON()).toEqual({ query: "contract law" });
});

test("sign-out clears approved materials and ignores an earlier in-flight material reply", async ({ page }) => {
  await stubAuth(page, { user: student });
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let started;
  const requestStarted = new Promise(resolve => { started = resolve; });
  await page.route("**/api/v1/materials?*", async route => {
    started();
    await blocked;
    await json(route, { data: [{ id: rowId, title: "Previous account private fixture" }] });
  });
  await readyStudy(page, "library");
  await requestStarted;
  await page.evaluate(() => window.__auth.setUser(null));
  await expect(page.locator("#server-materials-status")).toContainText("Sign in");
  const returned = page.waitForResponse("**/api/v1/materials?*");
  release();
  await finishReply(page, await returned);
  await expect(page.locator(".server-material-card")).toHaveCount(0);
  await expect(page.locator("#server-materials-status")).toContainText("Sign in");
});

test("sign-out clears source results and ignores a pending previous-session search", async ({ page }) => {
  await stubAuth(page, { user: student });
  await page.route("**/api/v1/materials?*", route => json(route, { data: [] }));
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let started;
  const requestStarted = new Promise(resolve => { started = resolve; });
  await page.route("**/api/v1/research/search", async route => {
    started(); await blocked;
    await json(route, { data: { cases: [{ id: rowId, case_name: "Previous account source" }] } });
  });
  await readyStudy(page, "ai-chat");
  await expect(page.locator("#research-search-status")).toContainText("Ready to search");
  await page.locator("#research-query").fill("contract law");
  await page.locator("#research-search-button").click();
  await requestStarted;
  await page.evaluate(() => window.__auth.setUser(null));
  const returned = page.waitForResponse("**/api/v1/research/search");
  release(); await finishReply(page, await returned);
  await expect(page.locator("#research-search-results")).toBeEmpty();
  await expect(page.locator("#research-search-status")).toContainText("Sign in");
});

test("admin sections navigate correctly and a student cannot unlock database controls", async ({ page }) => {
  await stubAuth(page, { user: student });
  await page.route("**/api/**", route => new URL(route.request().url()).pathname === "/api/health"
    ? json(route, { database: "connected" }) : json(route, { error: "Administrator permission required." }, 403));
  await page.goto("/admin.html");
  await expect(page.locator("#admin-auth-status")).toHaveAttribute("data-state", "denied");
  for (const name of ["content", "media", "ai", "plans", "database", "overview"]) {
    await page.locator(`[data-panel=${name}]`).click();
    await expect(page.locator(`#panel-${name}`)).toBeVisible();
    await expect(page.locator(".admin-panel:visible")).toHaveCount(1);
  }
  await page.locator("[data-panel=database]").click();
  await expect(page.locator("#database-firebase-state")).toContainText("not an administrator");
  await expect(page.locator("#database-new")).toBeDisabled();
  await expect(page.locator("#database-resource")).toBeDisabled();
  await expect(page.locator("#provider-key")).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("verified administrator still cannot edit when Neon is unconfigured", async ({ page }) => {
  await stubAuth(page, { user: admin });
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/health") return json(route, { database: "not_configured" }, 503);
    if (path.endsWith("/catalog")) return json(route, { data: catalog });
    return json(route, { user: { ...admin, role: "admin" } });
  });
  await page.goto("/admin.html");
  await expect(page.locator("#admin-auth-status")).toHaveAttribute("data-state", "verified");
  await page.locator("[data-panel=database]").click();
  await expect(page.locator("#database-neon-state")).toContainText("not configured");
  await expect(page.locator("#database-new")).toBeDisabled();
  await expect(page.locator("#database-resource")).toBeDisabled();
});

test("verified admin CRUD uses the API and clears records on sign-out (all replies stubbed)", async ({ page }) => {
  await stubAuth(page, { user: admin });
  let records = [{ id: rowId, name: "Synthetic University", slug: "synthetic-u", is_active: true }];
  const mutations = [];
  await page.route("**/api/**", route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/health") return json(route, { database: "connected" });
    if (path === "/api/v1/admin/me") return json(route, { user: { ...admin, role: "admin" } });
    if (path.endsWith("/catalog")) return json(route, { data: catalog });
    if (request.method() === "POST") {
      mutations.push({ method: request.method(), data: request.postDataJSON() });
      records = [{ id: rowId, ...request.postDataJSON() }];
      return json(route, { data: records[0] }, 201);
    }
    if (request.method() === "PATCH") {
      mutations.push({ method: request.method(), data: request.postDataJSON() });
      records[0] = { ...records[0], ...request.postDataJSON() };
      return json(route, { data: records[0] });
    }
    if (request.method() === "DELETE") {
      mutations.push({ method: request.method(), data: request.postDataJSON() });
      records = [];
      return json(route, { data: { deactivated: true } });
    }
    if (path.endsWith(`/${rowId}`)) return json(route, { data: records[0] });
    return json(route, { data: records, pagination: { total: records.length } });
  });
  await page.goto("/admin.html");
  await page.locator("[data-panel=database]").click();
  await expect(page.locator("#database-table-body")).toContainText("Synthetic University");
  await expect(page.locator("#database-next")).toBeDisabled();
  await expect(page.locator("#database-prev")).toBeDisabled();
  await page.locator("#database-new").click();
  await page.getByLabel("University name", { exact: true }).fill("Created fixture university");
  await page.getByLabel("Slug", { exact: true }).fill("created-fixture");
  await page.locator("#database-save").click();
  await expect(page.locator("#database-table-body")).toContainText("Created fixture university");
  await page.locator("#database-table-body").getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("University name", { exact: true }).fill("Edited fixture university");
  await page.locator("#database-save").click();
  await expect(page.locator("#database-table-body")).toContainText("Edited fixture university");
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#database-table-body").getByRole("button", { name: "Deactivate", exact: true }).click();
  await expect(page.locator("#database-table-body")).toContainText("No records found");
  await expect(page.locator("#database-next")).toBeDisabled();
  expect(mutations.map(item => item.method)).toEqual(["POST", "PATCH", "DELETE"]);
  expect(mutations.at(-1).data).toEqual({ confirm: true });
  await page.locator("#admin-signout").click();
  await expect(page.locator("#database-new")).toBeDisabled();
  await expect(page.locator("#database-table-body")).toBeEmpty();
});

test("sign-in and password-reset UI works with local stubs, without sending email", async ({ page }) => {
  await stubAuth(page);
  await page.route("**/api/v1/profile", route => json(route, { data: { full_name: student.displayName, email: student.email, installation: { registered: true } } }));
  await page.goto("/auth.html");
  await expect(page.locator("#email-signin-form")).toBeVisible();
  await page.locator("#forgot-password-button").click();
  await expect(page.locator("#auth-message")).toContainText("Enter your email");
  await page.locator("#auth-email").fill("student@example.invalid");
  await page.locator("#forgot-password-button").click();
  await expect(page.locator("#auth-message")).toContainText("If a Firebase account exists");
  expect(await page.evaluate(() => window.__auth.resets)).toEqual(["student@example.invalid"]);
  await page.locator("#auth-password").fill("synthetic-password");
  await page.locator("#email-signin-button").click();
  await expect(page.locator("#continue-button")).toBeVisible();
  await page.locator("#sign-out-button").click();
  await expect(page.locator("#email-signin-form")).toBeVisible();
  await page.locator("#google-signin-button").click();
  await expect(page.locator("#signed-in-email")).toHaveText("google@example.invalid");
  expect(await page.evaluate(() => window.__auth.googleCalls)).toBe(1);
});

test("admin sign-in cannot continue after a server denial or redirect to another origin", async ({ page }) => {
  await stubAuth(page, { user: student });
  await page.route("**/api/v1/admin/me", route => json(route, { error: "Administrator permission required." }, 403));
  await page.goto("/auth.html?next=admin.html");
  await expect(page.locator("#auth-message")).toContainText("did not grant");
  await expect(page.locator("#continue-button")).toBeHidden();
  await page.route("**/api/v1/profile", route => json(route, { data: { full_name: student.displayName, email: student.email, installation: { registered: true } } }));
  await page.goto("/auth.html?next=https://attacker.invalid/admin.html");
  await expect(page.locator("#continue-button")).toBeVisible();
  await page.locator("#continue-button").click();
  await expect(page).toHaveURL(/\/study\.html#dashboard$/);
});

test("offline PWA reload keeps the study page and personal flashcards", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ serviceWorkers: "allow", reducedMotion: "reduce" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await context.route("**/*", route => new URL(route.request().url()).origin === new URL(baseURL).origin ? route.continue() : route.abort());
    await page.goto(`${baseURL}/study.html#memory`);
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    await page.locator("#card-front").fill("Offline synthetic question");
    await page.locator("#card-back").fill("Offline synthetic answer");
    await page.locator("#memory-form button[type=submit]").click();
    await expect(page.locator("#memory-count")).toHaveText("1 card");
    await context.setOffline(true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page).toHaveTitle(/Student Study Space/);
    await expect(page.locator("#recall-area")).toContainText("Offline synthetic question");
    const apiCached = await page.evaluate(async () => Boolean(await caches.match("/api/v1/materials")));
    expect(apiCached).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test("a delayed admin permission reply cannot restore a signed-out session", async ({ page }) => {
  await stubAuth(page, { user: admin });
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let started;
  const requestStarted = new Promise(resolve => { started = resolve; });
  await page.route("**/api/v1/admin/me", async route => {
    started(); await blocked;
    await json(route, { user: { ...admin, role: "admin" } });
  });
  await page.goto("/auth.html?next=admin.html");
  await requestStarted;
  await page.locator("#sign-out-button").click();
  await expect(page.locator("#email-signin-form")).toBeVisible();
  const returned = page.waitForResponse("**/api/v1/admin/me");
  release(); await finishReply(page, await returned);
  await expect(page.locator("#signed-in-panel")).toBeHidden();
  await expect(page.locator("#continue-button")).toBeHidden();
  await expect(page.locator("#auth-message")).not.toContainText("verified administrator");
});

test("a pending database list cannot restore records after administrator sign-out", async ({ page }) => {
  await stubAuth(page, { user: admin });
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let started;
  const requestStarted = new Promise(resolve => { started = resolve; });
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/health") return json(route, { database: "connected" });
    if (path.endsWith("/catalog")) return json(route, { data: catalog });
    if (path === "/api/v1/admin/me") return json(route, { user: { ...admin, role: "admin" } });
    started(); await blocked;
    return json(route, { data: [{ id: rowId, name: "Previous administrator fixture" }], pagination: { total: 1 } });
  });
  await page.goto("/admin.html");
  await requestStarted;
  await page.locator("#admin-signout").click();
  const returned = page.waitForResponse("**/api/v1/admin/database/universities?*");
  release(); await finishReply(page, await returned);
  await page.locator("[data-panel=database]").click();
  await expect(page.locator("#database-table-body")).toBeEmpty();
  await expect(page.locator("#database-new")).toBeDisabled();
  await expect(page.locator("#admin-auth-status")).toHaveAttribute("data-state", "signed-out");
});

test("administrator pasted-text version UI posts text, never a file (stubbed API)", async ({ page }) => {
  await stubAuth(page, { user: admin });
  const material = { id: rowId, title: "Synthetic material" };
  const materialCatalog = [{ key: "materials", label: "Materials", displayColumns: ["title"], fields: [{ name: "title", label: "Title", type: "text", required: true }] }];
  let versions = [];
  let submitted;
  await page.route("**/api/**", route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/health") return json(route, { database: "connected" });
    if (path === "/api/v1/admin/me") return json(route, { user: { ...admin, role: "admin" } });
    if (path.endsWith("/catalog")) return json(route, { data: materialCatalog });
    if (path.endsWith("/versions")) {
      if (request.method() === "POST") {
        submitted = request.postDataJSON();
        versions = [{ id: rowId, version_number: 1, extraction_status: "completed", extracted_text: submitted.extracted_text }];
        return json(route, { data: { ...versions[0], chunk_count: 1 } }, 201);
      }
      return json(route, { data: versions });
    }
    if (path.endsWith(`/${rowId}`)) return json(route, { data: material });
    return json(route, { data: [material], pagination: { total: 1 } });
  });
  await page.goto("/admin.html");
  await page.locator("[data-panel=database]").click();
  await page.locator("#database-table-body").getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator("#database-version-panel")).toBeVisible();
  await page.locator("#database-version-text").fill("Reviewed disposable staging material text.");
  await page.locator("#database-version-form button[type=submit]").click();
  await expect(page.locator("#database-version-list")).toContainText("Version 1");
  expect(submitted).toEqual({ extracted_text: "Reviewed disposable staging material text." });
  await page.locator("#admin-signout").click();
  await expect(page.locator("#database-version-panel")).toBeHidden();
  await expect(page.locator("#database-version-text")).toHaveValue("");
  await expect(page.locator("#database-version-list")).toBeEmpty();
});
