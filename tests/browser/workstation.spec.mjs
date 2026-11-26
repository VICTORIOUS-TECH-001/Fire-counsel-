import { readFile } from "node:fs/promises";
import { test, expect, expectNoHorizontalOverflow, stubAuth, admin, student, json, catalog, rowId } from "./fixtures.mjs";

const courseId = "323e4567-e89b-42d3-a456-426614174000";
const materialId = "423e4567-e89b-42d3-a456-426614174000";
const source = "[Page 1]\nOriginal source with <script>unsafe()</script> and a legal citation [1932] AC 562.";
const text = "[Page 1]\nCorrected document with <img src=x onerror=unsafe()> kept as literal text.";
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function fixture(page, { user = admin, result = {}, onPoll, onSave, database = "ready" } = {}) {
  await stubAuth(page, { user });
  const processing = [], approvals = [], mutations = [];
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
    if (path === "/api/v1/admin/documents") return json(route, { data: [] });
    if (path === "/api/v1/admin/workstation/status") return json(route, { data: { database, providers: { configured: true, cloudflare: { configured: true, model: "test-cf" }, gemini: { configured: true, model: "test-gemini" }, ocr: "admin_gemini" } } });
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
      if (onPoll) await onPoll(route, jobId, n);
      return json(route, { data: { id: jobId, name: processing.at(-1)?.name || "source.pdf", status: "ready", result: { text, source_text: source, method: "pdf_text", pages: 1, characters: text.length, sections: 1, providers: [{ provider: "cloudflare", model: "test-cf" }], warnings: [], truncated: false, ...result } } });
    }
    return json(route, { error: "Not part of this workstation fixture" }, 404);
  });
  await page.goto("/admin.html");
  await expect(page.locator("#admin-auth-status")).toHaveAttribute("data-state", user?.uid === student.uid ? "denied" : user ? "verified" : "signed-out");
  await expect(page.locator("#fc-preloader")).toHaveCount(0);
  await page.locator("[data-panel=uploads]").click();
  if (user && user.uid !== student.uid) await expect(page.locator("#station-connection-summary")).toContainText("Neon");
  return { processing, approvals, mutations };
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
