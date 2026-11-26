import { readFile } from "node:fs/promises";
import { test, expect, expectNoHorizontalOverflow, stubAuth, admin, student, json, catalog, rowId } from "./fixtures.mjs";

const courseId = "323e4567-e89b-42d3-a456-426614174000";
const materialId = "423e4567-e89b-42d3-a456-426614174000";
const source = "[Page 1]\nOriginal source with <script>unsafe()</script> and a legal citation [1932] AC 562.";
const text = "[Page 1]\nCorrected document with <img src=x onerror=unsafe()> kept as literal text.";
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function fixture(page, { user = admin, result = {}, onPoll, onSave, onDocuments, onTest, database = "ready" } = {}) {
  await stubAuth(page, { user });
  const processing = [], approvals = [], mutations = [], diagnostics = [];
  const polls = new Map();
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    if (!["GET", "HEAD"].includes(method) && path !== "/api/v1/presence") mutations.push({ path, method });
    if (path === "/api/health") return json(route, { database: "connected" });
    if (path === "/api/v1/presence") return route.fulfill({ status: 204 });
    if (path === "/api/v1/admin/me") {
      const current = await page.evaluate(() => window.__firebaseAuth.currentUser);
      return current?.uid === student.uid ? json(route, { error: "Administrator permission required" }, 403) : json(route, { user: { ...current, role: "admin" } });
    }
    if (path === "/api/v1/admin/database/catalog") return json(route, { data: catalog });
    if (path.includes("/database/options/courses")) return json(route, { data: [{ id: courseId, label: "LAW 201 · Contract" }] });
    if (path.includes("/database/options/materials")) return json(route, { data: [{ id: materialId, label: "Original notes — keep previous versions" }] });
    if (path.includes("/database/options/")) return json(route, { data: [] });
    if (path === "/api/v1/admin/documents/usage") return json(route, { data: { used_bytes: 0, budget_bytes: 350 * 1048576, files: 0, max_file_bytes: 25 * 1048576, ocr: { ai: true } } });
    if (path === "/api/v1/admin/documents") return onDocuments ? onDocuments(route) : json(route, { data: [] });
    if (path === "/api/v1/admin/workstation/status") return json(route, { data: { database, providers: { configured: true, cloudflare: { configured: true, model: "test-cf" }, gemini: { configured: true, model: "test-gemini" }, ocr: "admin_gemini" } } });
    if (path === "/api/v1/admin/workstation/providers/test") {
      const body = request.postDataJSON(); diagnostics.push(body);
      return onTest ? onTest(route, body) : json(route, { data: { ok: true, provider: body.provider, model: `test-${body.provider}` } });
    }
    if (path === "/api/v1/admin/workstation/jobs" && method === "POST") {
      processing.push(request.postDataJSON());
      const id = `${processing.length}23e4567-e89b-42d3-a456-426614174000`;
      return json(route, { data: { id, name: processing.at(-1).name, status: "queued" } }, 202);
    }
    const jobId = path.match(/\/jobs\/([^/]+)/)?.[1];
    if (jobId && method === "DELETE") return route.fulfill({ status: 204 });
    if (jobId && path.endsWith("/save")) {
      const body = request.postDataJSON(); approvals.push({ path, body });
      if (onSave) return onSave(route, approvals.length, body);
      return json(route, { data: { upload_id: jobId, title: body.title, version_number: body.purpose === "material_version" ? 2 : 1, chunks: 3, material_id: materialId } });
    }
    if (jobId && method === "GET") {
      const n = (polls.get(jobId) || 0) + 1; polls.set(jobId, n);
      if (onPoll && await onPoll(route, jobId, n) === true) return;
      return json(route, { data: { id: jobId, name: processing.at(-1)?.name || "source.pdf", status: "ready", result: { text, source_text: source, method: "pdf_text", pages: 1, characters: text.length, sections: 1, providers: [{ provider: "cloudflare", model: "test-cf" }], warnings: [], truncated: false, ...result } } });
    }
    return json(route, { error: "Not part of this workstation fixture" }, 404);
  });
  await page.goto("/admin.html");
  await expect(page.locator("#admin-auth-status")).toHaveAttribute("data-state", user?.uid === student.uid ? "denied" : user ? "verified" : "signed-out");
  await expect(page.locator("#fc-preloader")).toHaveCount(0);
  await page.locator("[data-panel=uploads]").click();
  if (user && user.uid !== student.uid) await expect(page.locator("#station-connection-summary")).toContainText("Neon");
  return { processing, approvals, mutations, diagnostics, polls };
}
async function paste(page, value = "[Page 1]\nWorking source text.") {
  await page.locator(".station-paste summary").click();
  await page.locator("#station-paste").fill(value);
}
async function ready(page) {
  await page.locator("#station-submit").click();
  await expect(page.locator("#station-output")).toBeEnabled();
}

test("admin attaches a PDF, instructs the isolated AI, edits/downloads the result and explicitly approves the TXT to Neon", async ({ page }) => {
  const state = await fixture(page);
  await expect(page.locator("#station-panel")).toBeVisible();
  await expect(page.locator("#upload-form")).toBeHidden();
  await expect(page.locator("#station-save")).toBeDisabled();
  await page.locator("#station-panel").screenshot({ path: ".cache/counsel-station-desktop.png" });
  const pdf = Buffer.from("%PDF-1.4\nsynthetic browser-boundary fixture");
  await page.locator("#station-file-input").setInputFiles({ name: "Original judgment.pdf", mimeType: "application/pdf", buffer: pdf });
  await expect(page.locator("#station-file-name")).toContainText("Original judgment.pdf");
  await page.locator("#station-input").fill("Correct OCR and paragraph breaks. Preserve citations and every page.");
  await ready(page);
  expect(state.processing[0]).toMatchObject({ operation: "correct", provider: "auto", instructions: "Correct OCR and paragraph breaks. Preserve citations and every page.", attachment: { name: "Original judgment.pdf", mimeType: "application/pdf", data: pdf.toString("base64") } });
  expect(state.approvals).toEqual([]);
  expect(state.mutations.filter(item => item.method === "POST").map(item => item.path)).toEqual(["/api/v1/admin/workstation/jobs"]);
  await expect(page.locator("#station-output")).toHaveValue(text);
  await expect(page.locator("#station-chat")).toContainText("I have not saved anything");
  await expect(page.locator("#station-review img, #station-chat img, #station-source script")).toHaveCount(0);
  expect(await page.evaluate(() => window.unsafe)).toBeUndefined();
  await page.locator("#station-title").fill("Reviewed judgment");
  await page.locator("#station-course").selectOption(courseId);
  await page.locator("#station-type").selectOption("case_material");
  await page.locator("#station-approval").check();
  await expect(page.locator("#station-save")).toBeEnabled();
  const reviewed = "[Page 1]\nHuman-reviewed legal text with the original citation [1932] AC 562.";
  await page.locator("#station-output").fill(reviewed);
  await expect(page.locator("#station-approval")).not.toBeChecked();
  await expect(page.locator("#station-save")).toBeDisabled();
  const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#station-download").click()]);
  expect(download.suggestedFilename()).toBe("Reviewed judgment.txt");
  expect(await readFile(await download.path(), "utf8")).toBe(reviewed);
  await page.locator("#station-approval").check();
  await page.locator("#station-save").click();
  await expect(page.locator("#station-save-status")).toContainText("Saved to Neon");
  expect(state.approvals).toHaveLength(1);
  expect(state.approvals[0].body).toMatchObject({ approved: true, text: reviewed, title: "Reviewed judgment", purpose: "material", course_id: courseId, material_type: "case_material", publish: false });
  expect(state.approvals[0].body).not.toHaveProperty("attachment");
  await expect(page.locator("#station-save")).toBeDisabled();
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage }));
  for (const secret of [reviewed, "Original judgment.pdf", "Correct OCR and paragraph breaks"]) expect(storage).not.toContain(secret);
  await page.locator("#classic-upload-mode").click();
  await expect(page.locator("#upload-form")).toBeVisible();
  await expect(page.locator("#upload-files")).toBeEnabled();
});

test("Working Station fits mobile from empty/loading through incomplete review and preserves old material versions", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const gate = deferred(); const requested = deferred();
  const state = await fixture(page, { result: { truncated: true, warnings: ["Some scanned pages were not readable. Compare the source."] }, onPoll: async () => { requested.resolve(); await gate.promise; } });
  await expectNoHorizontalOverflow(page);
  await page.setViewportSize({ width: 390, height: 1800 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator("#station-panel").screenshot({ path: ".cache/counsel-station-mobile.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("[data-station-tool=extract]").click();
  await paste(page);
  await page.locator("#station-submit").click(); await requested.promise;
  await expect(page.locator("#station-progress")).toBeVisible();
  await expectNoHorizontalOverflow(page);
  gate.resolve(); await expect(page.locator("#station-output")).toBeEnabled();
  expect(state.processing[0]).toMatchObject({ operation: "extract", instructions: "", text: "[Page 1]\nWorking source text." });
  await page.locator("#station-purpose").selectOption("material_version");
  await page.locator("#station-material").selectOption(materialId);
  await expect(page.locator("#station-version-note")).toContainText("keeps every earlier version");
  await expect(page.locator("#station-course-field")).toBeHidden();
  await page.locator("#station-approval").check();
  await expect(page.locator("#station-save")).toBeDisabled();
  await page.locator("#station-incomplete").check();
  await expect(page.locator("#station-save")).toBeEnabled();
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalOverflow(page);
    if (width <= 390) expect((await page.locator("#station-provider").boundingBox()).width).toBeGreaterThanOrEqual(120);
  }
  await page.setViewportSize({ width: 1440, height: 1800 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator("#station-review").screenshot({ path: ".cache/counsel-station-review.png" });
  await page.locator("#station-save").click();
  await expect(page.locator("#station-save-status")).toContainText("version 2");
  expect(state.approvals[0].body).toMatchObject({ purpose: "material_version", material_id: materialId, acknowledge_incomplete: true });
  expect(state.mutations.some(item => item.path.startsWith("/api/v1/admin/documents/") && item.method === "DELETE")).toBe(false);
});

test("follow-up corrections reuse edited text, not the PDF, and a failed refinement keeps the earlier draft", async ({ page }) => {
  const state = await fixture(page);
  await paste(page); await ready(page);
  const edited = "[Page 1]\nMy corrected source for another pass.";
  await page.locator("#station-output").fill(edited);
  await page.locator("#station-input").fill("Keep my corrections and improve the headings only.");
  await page.locator("#station-provider").selectOption("gemini");
  await page.locator("#station-tool").selectOption("custom");
  await ready(page);
  expect(state.processing[1]).toMatchObject({ text: edited, operation: "custom", provider: "gemini", instructions: "Keep my corrections and improve the headings only." });
  expect(state.processing[1]).not.toHaveProperty("attachment");
  await page.route("**/api/v1/admin/workstation/jobs/*", route => json(route, { data: { id: rowId, status: "failed", error: { code: "ADMIN_PROVIDER_QUOTA", message: "Admin Gemini quota was reached." } } }));
  await page.locator("#station-input").fill("One more pass.");
  await page.locator("#station-submit").click();
  await expect(page.locator("#station-status")).toContainText("Any earlier draft below is unchanged");
  await expect(page.locator("#station-output")).toHaveValue(text);
  expect(state.approvals).toHaveLength(0);
});

test("an unconfirmed Neon save freezes its approval and retries the exact same job without a second AI bill", async ({ page }) => {
  const state = await fixture(page, { onSave: (route, count, body) => count === 1 ? json(route, { error: "Synthetic lost save acknowledgement" }, 503)
    : json(route, { data: { title: body.title, version_number: 1, chunks: 1 } }) });
  await paste(page); await ready(page);
  await page.locator("#station-approval").check(); await page.locator("#station-save").click();
  await expect(page.locator("#station-save-status")).toContainText("save outcome is unconfirmed");
  await expect(page.locator("#station-output")).toBeDisabled();
  await expect(page.locator("#station-new")).toBeDisabled();
  await expect(page.locator("#station-save")).toHaveText("Retry the same save");
  await page.locator("#station-save").click();
  await expect(page.locator("#station-save-status")).toContainText("Saved to Neon");
  expect(state.approvals).toHaveLength(2);
  expect(state.approvals[0]).toEqual(state.approvals[1]);
  expect(state.processing).toHaveLength(1);
});

test("sign-out clears private drafts immediately and a late worker reply cannot restore them", async ({ page }) => {
  const gate = deferred(), requested = deferred();
  await fixture(page, { onPoll: async () => { requested.resolve(); await gate.promise; } });
  await paste(page, "Previous administrator private text"); await page.locator("#station-submit").click(); await requested.promise;
  await page.locator("#admin-signout").click();
  await expect(page.locator("#station-input")).toBeDisabled();
  await expect(page.locator("#station-paste")).toHaveValue("");
  const reply = page.waitForResponse(response => /\/workstation\/jobs\//.test(response.url()));
  gate.resolve(); await (await reply).finished();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator("#station-output")).toHaveValue("");
  await expect(page.locator("#station-review")).toBeHidden();
  await expect(page.locator("#station-chat")).toBeEmpty();
  await expect(page.locator("#station-panel")).not.toContainText("Previous administrator private text");
});

test("a late save reply cannot reveal another administrator's approved document after account change", async ({ page }) => {
  const gate = deferred(), requested = deferred();
  await fixture(page, { onSave: async route => { requested.resolve(); await gate.promise; return json(route, { data: { title: "Old private saved document", version_number: 1, chunks: 1 } }); } });
  await paste(page); await ready(page);
  await page.locator("#station-approval").check(); await page.locator("#station-save").click(); await requested.promise;
  await page.evaluate(user => window.__auth.setUser(user), { ...admin, uid: "next-administrator", email: "next@example.invalid" });
  await expect(page.locator("#station-output")).toHaveValue("");
  const reply = page.waitForResponse(response => response.url().endsWith("/save"));
  gate.resolve(); await (await reply).finished();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator("#station-save-status")).not.toContainText("Old private saved document");
  await expect(page.locator("#station-review")).toBeHidden();
});

test("a student sees a locked station and a missing Neon connection allows TXT review but no approval", async ({ page }) => {
  await fixture(page, { user: student });
  await expect(page.locator("#station-submit")).toBeDisabled();
  await expect(page.locator("#station-file-input")).toBeDisabled();
  await fixture(page, { database: "not_configured" });
  await paste(page); await ready(page);
  await page.locator("#station-approval").check();
  await expect(page.locator("#station-download")).toBeEnabled();
  await expect(page.locator("#station-save")).toBeDisabled();
});


// Fake time drives production backoff deadlines exactly. These are not sleeps
// or whole-test retries, and no external/provider request is made by the suite.
async function controlTime(page) {
  await page.clock.install();
  await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1000);
}

test("temporary API 503 and 429 recover the same workstation job and honor Retry-After without re-uploading", async ({ page }) => {
  const state = await fixture(page, { onPoll: async (route, _id, n) => {
    if (n === 1) { await route.fulfill({ status: 503, contentType: "text/html", body: "<h1>API ingress unavailable</h1>" }); return true; }
    if (n === 2) { await route.fulfill({ status: 429, contentType: "application/json", headers: { "Retry-After": "12" }, body: JSON.stringify({ code: "ADMIN_READ_RATE_LIMIT", error: "Administrator status requests are temporarily limited." }) }); return true; }
  } });
  await paste(page); await controlTime(page);
  await page.locator("#station-submit").click();
  await expect(page.locator("#station-status")).toContainText("HTTP 503");
  await expect(page.locator("#station-status")).toContainText("same job again in 2 seconds");
  await page.clock.runFor(1999);
  expect([...state.polls.values()]).toEqual([1]);
  await page.clock.runFor(1);
  await expect(page.locator("#station-status")).toContainText("same job again in 12 seconds");
  await page.clock.runFor(11999);
  expect([...state.polls.values()]).toEqual([2]);
  await page.clock.runFor(1);
  await expect(page.locator("#station-output")).toHaveValue(text);
  await expect(page.locator("#station-output")).toBeEnabled();
  expect([...state.polls.values()]).toEqual([3]);
  expect(state.processing).toHaveLength(1);
  expect(state.approvals).toHaveLength(0);
  expect(state.diagnostics).toHaveLength(0);
});

test("repeated transient status failures stop after five scheduled checks; manual progress resumes only the same job", async ({ page }) => {
  const state = await fixture(page, { onPoll: async (route, _id, n) => {
    if (n <= 6) { await route.fulfill({ status: 503, contentType: "text/html", body: "Temporarily unavailable" }); return true; }
  } });
  await paste(page); await controlTime(page);
  await page.locator("#station-submit").click();
  await expect(page.locator("#station-status")).toContainText("(1/5)");
  for (const [index, delay] of [2000, 5000, 10000, 20000, 30000].entries()) {
    await page.clock.runFor(delay);
    await expect(page.locator("#station-status")).toContainText(index === 4 ? "Automatic status checks are paused" : `(${index + 2}/5)`);
  }
  await expect(page.locator("#station-submit > span:first-child")).toHaveText("Check progress");
  await page.locator("#classic-upload-mode").click();
  await page.locator("#station-mode").click();
  await page.clock.runFor(120000);
  expect([...state.polls.values()]).toEqual([6]);
  expect(state.processing).toHaveLength(1);
  await page.locator("#station-submit").click();
  await expect(page.locator("#station-output")).toHaveValue(text);
  expect([...state.polls.values()]).toEqual([7]);
  expect(state.processing).toHaveLength(1);
  expect(state.approvals).toHaveLength(0);
});

test("hidden station polling pauses and navigation resumes its job rather than starting another", async ({ page }) => {
  const state = await fixture(page, { onPoll: async (route, id, n) => {
    if (n === 1) { await json(route, { data: { id, status: "processing", progress: "Reading the photo…" } }); return true; }
  } });
  await paste(page); await controlTime(page);
  await page.locator("#station-submit").click();
  await expect(page.locator("#station-status")).toContainText("Reading the photo");
  await page.locator("#classic-upload-mode").click();
  await page.clock.runFor(120000);
  expect([...state.polls.values()]).toEqual([1]);
  await page.locator("#station-mode").click();
  await expect(page.locator("#station-output")).toHaveValue(text);
  expect([...state.polls.values()]).toEqual([2]);
  expect(state.processing).toHaveLength(1);
});

test("a missing RAM job explains restart/expiry and never automatically recreates the upload", async ({ page }) => {
  const state = await fixture(page, { onPoll: async route => {
    await json(route, { error: "Temporary job not found", code: "DRAFT_NOT_FOUND" }, 404); return true;
  } });
  await paste(page, "Private source retained after restart"); await controlTime(page);
  await page.locator("#station-submit").click();
  await expect(page.locator("#station-status")).toContainText("server no longer has this temporary job");
  await expect(page.locator("#station-paste")).toHaveValue("Private source retained after restart");
  await expect(page.locator("#station-submit > span:first-child")).toHaveText("Process");
  await page.clock.runFor(120000);
  expect([...state.polls.values()]).toEqual([1]);
  expect(state.processing).toHaveLength(1);
  expect(state.approvals).toHaveLength(0);
});

test("sign-out cancels scheduled recovery and cannot restore another account's private draft", async ({ page }) => {
  const state = await fixture(page, { onPoll: async route => {
    await route.fulfill({ status: 503, contentType: "text/html", body: "Unavailable" }); return true;
  } });
  await paste(page, "Private text from previous administrator"); await controlTime(page);
  await page.locator("#station-submit").click();
  await expect(page.locator("#station-status")).toContainText("same job again");
  await page.locator("#admin-signout").click();
  await expect(page.locator("#station-submit")).toBeDisabled();
  await page.clock.runFor(120000);
  expect([...state.polls.values()]).toEqual([1]);
  await expect(page.locator("#station-paste")).toHaveValue("");
  await expect(page.locator("#station-chat")).toBeEmpty();
});

test("Classic keeps a Reading upload during 429/503 and recovers GETs without submitting a duplicate file", async ({ page }) => {
  let phase = "seed";
  let reads = 0;
  const row = { id: rowId, purpose: "material", file_name: "IMG_20261124_105054_298.jpg", size_bytes: 4000, has_file: true, status: "processing", progress: "Reading the photo…" };
  const state = await fixture(page, { onDocuments: async route => {
    expect(route.request().method()).toBe("GET"); reads++;
    if (phase === "throttle") { phase = "outage"; return route.fulfill({ status: 429, contentType: "application/json", headers: { "Retry-After": "7" }, body: JSON.stringify({ code: "ADMIN_READ_RATE_LIMIT", error: "API status requests are temporarily limited." }) }); }
    if (phase === "outage") { phase = "recovered"; return route.fulfill({ status: 503, contentType: "text/html", body: "<h1>API unavailable</h1>" }); }
    return json(route, { data: [{ ...row, ...(phase === "recovered" ? { status: "ready" } : {}) }] });
  } });
  await controlTime(page); phase = "throttle";
  const before = reads;
  await page.locator("#classic-upload-mode").click();
  await expect(page.locator("#upload-status")).toContainText("existing upload list again in 7 seconds");
  await expect(page.locator("#upload-rows")).toContainText(row.file_name);
  await expect(page.locator("[data-upload-state=processing]")).toBeVisible();
  await page.clock.runFor(6999); expect(reads).toBe(before + 1);
  await page.clock.runFor(1);
  await expect(page.locator("#upload-status")).toContainText("HTTP 503");
  await expect(page.locator("#upload-status")).toContainText("again in 5 seconds");
  await page.clock.runFor(5000);
  await expect(page.locator("[data-upload-state=ready]")).toBeVisible();
  await expect(page.locator("#upload-status")).toContainText("Connection restored");
  expect(reads).toBe(before + 3);
  expect(state.mutations).toHaveLength(0);
});

test("provider diagnostics are explicit admin-only calls, explain rejected credentials and clear on sign-out", async ({ page }) => {
  const state = await fixture(page, { onTest: (route, body) => body.provider === "gemini"
    ? json(route, { error: "Google rejected the admin Gemini credential or its permissions.", code: "ADMIN_PROVIDER_AUTH" }, 503)
    : json(route, { data: { ok: true, provider: "cloudflare", model: "test-cf" } }) });
  expect(state.diagnostics).toHaveLength(0);
  await page.locator(".station-connection summary").click();
  await page.getByRole("button", { name: "Test Admin Gemini", exact: true }).click();
  await expect(page.locator("#station-test-status")).toContainText("ADMIN_PROVIDER_AUTH");
  await expect(page.locator("#station-test-status")).toContainText("student key was not used");
  expect(state.diagnostics).toEqual([{ provider: "gemini" }]);
  await page.getByRole("button", { name: "Test Cloudflare", exact: true }).click();
  await expect(page.locator("#station-test-status")).toContainText("Cloudflare Workers AI accepted the test");
  expect(state.diagnostics).toEqual([{ provider: "gemini" }, { provider: "cloudflare" }]);
  expect(state.processing).toHaveLength(0);
  expect(state.approvals).toHaveLength(0);
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalOverflow(page);
  }
  await page.locator(".station-connection").screenshot({ path: ".cache/counsel-station-diagnostics.png" });
  await page.locator("#admin-signout").click();
  await expect(page.getByRole("button", { name: "Test Admin Gemini", exact: true })).toBeDisabled();
  await expect(page.locator("#station-test-status")).not.toContainText("accepted the test");
});


test("neither job creation nor a raw Classic upload is replayed after an unconfirmed 503", async ({ page }) => {
  let creates = 0, uploads = 0;
  const state = await fixture(page, { onDocuments: async route => {
    if (route.request().method() === "POST") {
      uploads++;
      return route.fulfill({ status: 503, contentType: "text/html", body: "Upload acknowledgement unavailable" });
    }
    return json(route, { data: [] });
  } });
  await page.route("**/api/v1/admin/workstation/jobs", route => {
    creates++;
    return route.fulfill({ status: 503, contentType: "text/html", body: "Job acknowledgement unavailable" });
  });
  await paste(page); await controlTime(page);
  await page.locator("#station-submit").click();
  await expect(page.locator("#station-status")).toContainText("HTTP 503");
  await page.clock.runFor(120000);
  expect(creates).toBe(1);
  expect(state.approvals).toHaveLength(0);
  await page.locator("#classic-upload-mode").click();
  await page.locator("#upload-files").setInputFiles({ name: "One attempt.txt", mimeType: "text/plain", buffer: Buffer.from("One raw upload attempt only.") });
  await page.locator("#upload-submit").click();
  await expect(page.locator("#upload-status")).toContainText("HTTP 503");
  await page.clock.runFor(120000);
  expect(uploads).toBe(1);
  expect(creates).toBe(1);
});

test("Classic recovery is bounded across tab switches and manual Refresh checks only the existing list", async ({ page }) => {
  let failing = false, failures = 0;
  const state = await fixture(page, { onDocuments: route => {
    if (failing) { failures++; return route.fulfill({ status: 503, contentType: "text/html", body: "Unavailable" }); }
    return json(route, { data: [] });
  } });
  await controlTime(page); failing = true;
  await page.locator("#classic-upload-mode").click();
  await expect(page.locator("#upload-status")).toContainText("(1/5)");
  for (const [index, delay] of [2000, 5000, 10000, 20000, 30000].entries()) {
    await page.clock.runFor(delay);
    await expect(page.locator("#upload-status")).toContainText(index === 4 ? "Automatic checks are paused" : `(${index + 2}/5)`);
  }
  await page.locator("#station-mode").click();
  await page.locator("#classic-upload-mode").click();
  await page.clock.runFor(120000);
  expect(failures).toBe(6);
  failing = false;
  await page.locator("#upload-refresh").click();
  await expect(page.locator("#upload-status")).toContainText("Connection restored");
  expect(state.mutations).toHaveLength(0);
});
