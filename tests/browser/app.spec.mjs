import { test, expect, expectNoHorizontalOverflow, stubAuth, stubFirestore, student, admin, json, rowId, catalog } from "./fixtures.mjs";

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
  // The presence heartbeat is a signed-in ping, not study data; track every
  // other non-GET request and require none (nothing is uploaded).
  page.on("request", request => { if (request.method() !== "GET" && !request.url().includes("/api/v1/presence")) mutations.push(request.url()); });
  await stubAuth(page, { user: student });
  await page.route("**/api/v1/presence", route => route.fulfill({ status: 204 }));
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
  await stubAuth(page, { user: student });
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
  // A returning (previously signed-in) browser keeps its local tools when
  // Firebase cannot load; the integration modules then degrade as before.
  await page.addInitScript(key => { try { localStorage.setItem(key, "returning-student"); } catch { /* ignore */ } }, "fire-counsel-auth-gate-v2");
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

test("AI studio sends a question, polls the background job and renders safe answers, links, course choice and downloads", async ({ page }) => {
  await stubAuth(page, { user: student });
  const posts = [];
  let polls = 0;
  const courseId = "323e4567-e89b-42d3-a456-426614174000";
  const conversation = { id: "423e4567-e89b-42d3-a456-426614174000", mode: "chat", title: "Synthetic question" };
  const allowance = { unlimited: false, paused: false, premium: true, timezone: "Africa/Lagos", features: {
    chat: { label: "AI chat messages", used: 1, limit: 20, remaining: 19 },
    case: { label: "Case analyses", used: 0, limit: 3, remaining: 3 },
    notes: { label: "Exam-ready notes", used: 0, limit: 3, remaining: 3 },
    questions: { label: "Question sets", used: 0, limit: 5, remaining: 5 } } };
  const user = { id: "1", role: "user", status: "done", content: "What is consideration?", attachments: [{ name: "notes.txt" }], sources: [], meta: {} };
  const answer = { id: "2", role: "assistant", status: "done", content: "## Consideration\n\n**Price** for a promise.<script>window.__bad = 1</script>\n\n| Case | Point |\n|---|---|\n| Currie v Misa | definition |", meta: { web_search: true },
    sources: [{ url: "https://example.org/currie", title: "Currie v Misa report", status: "verified" }, { url: "javascript:alert(1)", title: "bad", status: "broken" }] };
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/v1/ai/me") return json(route, { data: { configured: true, web_search: true, email_verified: true, admin: false, allowance } });
    if (path === "/api/v1/ai/courses") return json(route, { data: [{ id: courseId, course_code: "LAW 201", title: "Law of Contract", university: "UNILAG" }] });
    if (path === "/api/v1/ai/conversations") return json(route, { data: polls ? [{ ...conversation, updated_at: "2026-11-16T10:00:00Z" }] : [] });
    if (path === `/api/v1/ai/conversations/${conversation.id}`) {
      polls += 1;
      return json(route, { data: { conversation, messages: [user, polls > 1 ? answer : { id: "2", role: "assistant", status: "pending", content: "", sources: [], meta: { stage: "searching" } }] } });
    }
    if (path === "/api/v1/ai/messages" && request.method() === "POST") {
      const body = request.postDataJSON();
      posts.push(body);
      if (body.mode === "questions" && body.options.courseId === "auto") {
        return json(route, { data: { conversation: { ...conversation, mode: "questions" }, messages: [user, { id: "3", role: "assistant", status: "done", content: "Choose the course.", sources: [], meta: { needs_course: true, candidates: [{ id: courseId, label: "LAW 201 · Law of Contract" }] } }] } }, 202);
      }
      if (body.mode === "questions") return json(route, { error: "You have used all 5 question sets for today.", code: "LIMIT_REACHED" }, 429);
      return json(route, { data: { conversation, messages: [user, { id: "2", role: "assistant", status: "pending", content: "", sources: [], meta: {} }] } }, 202);
    }
    if (path === "/api/v1/ai/messages/2/export") return route.fulfill({ status: 200, contentType: "application/pdf", headers: { "content-disposition": 'attachment; filename="consideration.pdf"' }, body: "%PDF-1.4 synthetic" });
    return json(route, { error: "Not part of this fixture" }, 404);
  });
  await page.goto("/ai.html");
  await expect(page.locator(".fc-home h1")).toHaveText("Hi! I'm Fire Counsel");
  await expect(page.locator("#ai-status")).toContainText("Ready");
  await expect(page.locator("#ai-allowance-list")).toContainText("19 of 20 left");
  await expect(page.locator(".fc-signin").first()).toBeHidden();
  await page.locator("#ai-input").fill("What is consideration?");
  await page.locator("#ai-file-input").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("Synthetic note") });
  await expect(page.locator("#ai-files")).toContainText("notes.txt");
  await page.locator("#ai-send").click();
  await expect(page.locator(".ai-pending")).toBeVisible();
  await expect(page.locator(".fc-wait-title")).toHaveText("🔥 Fire is coming…");
  await expect(page.locator(".fc-wait-stage")).toHaveText("Searching the web for trusted sources…", { timeout: 10_000 });
  await expect(page.locator(".ai-answer h3")).toHaveText("Consideration", { timeout: 15_000 });
  expect(posts[0]).toMatchObject({ mode: "chat", text: "What is consideration?", options: { webSearch: true } });
  expect(posts[0].attachments).toEqual([{ name: "notes.txt", mimeType: "text/plain", data: Buffer.from("Synthetic note").toString("base64") }]);
  await expect(page.locator(".ai-answer table")).toBeVisible();
  await expect(page.locator(".ai-answer script")).toHaveCount(0);
  expect(await page.evaluate(() => window.__bad)).toBeUndefined();
  await expect(page.locator("#ai-status")).toHaveText("Answer ready.");
  await expect(page.locator(".ai-sources a")).toHaveCount(1);
  await expect(page.locator(".ai-sources summary")).toHaveText("Verification links (1)");
  await expect(page.locator(".ai-sources a")).toHaveAttribute("href", "https://example.org/currie");
  await expect(page.locator(".ai-link-badge")).toHaveText("Checked");
  await expect(page.locator("#ai-send")).toBeEnabled();
  const download = page.waitForEvent("download");
  await page.locator("[data-download='2'][data-format=pdf]").click();
  expect((await download).suggestedFilename()).toBe("consideration.pdf");

  await page.locator("#fc-open-functions-top").click();
  await expect(page.locator("#fc-functions")).toBeVisible();
  await page.locator("#fc-functions [data-ai-mode=questions]").click();
  await expect(page.locator("#fc-functions")).toBeHidden();
  await expect(page.locator("#ai-workspace-title")).toHaveText("Set exam questions");
  await expect(page.locator("#ai-course-select option")).toHaveCount(2);
  await page.locator("#ai-input").fill("Offer and acceptance notes");
  await page.locator("#ai-send").click();
  await page.locator(`[data-pick-course="${courseId}"]`).click();
  await expect(page.locator("#ai-status")).toContainText("used all 5 question sets");
  expect(posts.at(-1).options.courseId).toBe(courseId);

  // Functions list: tabs and a chat study tool (mnemonics).
  await page.locator("#fc-mode-switch").click();
  await page.locator("#fc-tab-new").click();
  await expect(page.locator("#fc-panel-new")).toBeVisible();
  await expect(page.locator("#fc-panel-must")).toBeHidden();
  await page.locator("#fc-tab-must").click();
  await page.locator("#fc-panel-must [data-ai-task=mnemonics]").click();
  await expect(page.locator("#fc-mode-name")).toHaveText("Create mnemonics");
  await expect(page.locator("#fc-task")).toBeVisible();
  await page.locator("#ai-input").fill("Elements of a valid contract");
  await page.locator("#ai-send").click();
  await expect.poll(() => posts.at(-1).options.task).toBe("mnemonics");
  expect(posts.at(-1).mode).toBe("chat");
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(page);
});

test("timed mock exam: start, answer, auto-save, submit, score, and send essays for AI marking; read-aloud toggles", async ({ page }) => {
  await stubAuth(page, { user: student });
  await page.addInitScript(() => {
    window.__spoken = [];
    Object.defineProperty(window, "speechSynthesis", { configurable: true, value: { getVoices: () => [{ lang: "en-GB", name: "Test" }], speak: (u) => { window.__spoken.push(u.text); setTimeout(() => u.onend?.(), 0); }, cancel: () => {} } });
    window.SpeechSynthesisUtterance = function (text) { this.text = text; };
  });
  const posts = [];
  const conversation = { id: "523e4567-e89b-42d3-a456-426614174000", mode: "chat", title: "Mock" };
  const quiz = { title: "Torts mock", instructions: "Answer all questions.", minutes: 5, total_marks: 12, questions: [
    { type: "mcq", question: "Which case set out the neighbour principle?", options: ["Donoghue v Stevenson", "Salomon v Salomon", "Carlill v Carbolic", "Hadley v Baxendale"], answer: 0, explanation: "Lord Atkin in Donoghue.", marks: 1 },
    { type: "mcq", question: "Res ipsa loquitur means?", options: ["The thing speaks for itself", "Let the buyer beware", "No harm no foul", "Act of God"], answer: 0, explanation: "It shifts the evidential burden.", marks: 1 },
    { type: "essay", question: "Discuss the duty of care.", marks: 10, guide: "Donoghue; Caparo three-stage test" } ] };
  const mock = { id: "m2", role: "assistant", status: "done", content: "## Torts mock\n\n### Answer key\n\n1. A", sources: [], meta: { task: "mock", quiz } };
  const answer = { id: "a2", role: "assistant", status: "done", content: "**Score: 7 / 10**. Good use of Donoghue.", sources: [], meta: {} };
  let stage = "mock";
  await page.route("**/api/**", route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/v1/ai/me") return json(route, { data: { configured: true, web_search: true, email_verified: true, admin: true, allowance: null } });
    if (path === `/api/v1/ai/conversations/${conversation.id}`) return json(route, { data: { conversation, messages: stage === "mock" ? [{ id: "u1", role: "user", status: "done", content: "Negligence", meta: {} }, mock] : [{ id: "u1", role: "user", status: "done", content: "Negligence", meta: {} }, mock, { id: "u2", role: "user", status: "done", content: "mark", meta: {} }, answer] } });
    if (path === "/api/v1/ai/messages" && request.method() === "POST") {
      const body = request.postDataJSON();
      posts.push(body);
      if (body.options.task === "marker") stage = "marked";
      return json(route, { data: { conversation, messages: [{ id: body.options.task === "marker" ? "u2" : "u1", role: "user", status: "done", content: body.text, meta: {} }, { id: "p", role: "assistant", status: "pending", content: "", meta: {} }] } }, 202);
    }
    if (path === "/api/v1/presence") return route.fulfill({ status: 204 });
    return json(route, { data: [] });
  });
  await page.goto("/ai.html");
  await page.locator("#fc-open-functions").click();
  await page.locator("#fc-panel-must [data-ai-task=mock]").click();
  await expect(page.locator("#ai-quiz-count")).toBeVisible();
  await expect(page.locator("#ai-web-search")).toBeHidden();
  await page.locator("#ai-quiz-count").fill("3");
  await page.locator("#ai-quiz-type").selectOption("mixed");
  await page.locator("#ai-input").fill("Negligence");
  await page.locator("#ai-send").click();
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0].options).toMatchObject({ task: "mock", quiz: { count: 3, type: "mixed" } });
  expect(posts[0].options.webSearch).toBeUndefined();
  await expect(page.locator(".fc-mock-card > h3")).toHaveText("Torts mock", { timeout: 15_000 });
  await page.locator("[data-start-exam=m2]").click();
  await expect(page.locator("#fc-exam")).toBeVisible();
  await expect(page.locator("#fc-exam-timer")).toHaveText(/0[45]:\d\d/);
  await page.locator("input[name=fc-q-0][value='0']").check();
  await page.locator("input[name=fc-q-1][value='2']").check();
  await page.locator("#fc-essay-2").fill("Lord Atkin's neighbour principle and the Caparo test.");
  await expect(page.locator("#fc-exam-progress")).toHaveText("3 of 3 answered");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("fire-counsel-exam-m2")).answers)).toEqual([0, 2, "Lord Atkin's neighbour principle and the Caparo test."]);
  await page.locator("#fc-exam-submit").click();
  await expect(page.locator(".fc-result-head strong")).toHaveText("1 / 2");
  await expect(page.locator(".fc-q[data-result=wrong] [data-correct=true]")).toContainText("The thing speaks for itself");
  await page.locator("[data-mark-essays]").click();
  await expect(page.locator("#fc-exam")).toBeHidden();
  await expect.poll(() => posts.length).toBe(2);
  expect(posts[1].options).toEqual({ webSearch: false, task: "marker" });
  expect(posts[1].text).toContain("MY ANSWER:\nLord Atkin's neighbour principle");
  expect(posts[1].text).toContain("Caparo three-stage test");

  // Read aloud: toggle auto-read, then the next answer is spoken.
  await page.locator("#fc-open-functions-top").click();
  await page.locator("#fc-tab-new").click();
  await page.locator("[data-toggle-read]").click();
  await expect(page.locator("#fc-read-state")).toHaveText("On");
  await page.locator("#fc-functions-back").click();
  await expect(page.locator(".ai-answer .ai-markdown strong").last()).toHaveText("Score: 7 / 10", { timeout: 15_000 });
  await page.locator("[data-speak=a2]").click();
  await expect.poll(() => page.evaluate(() => window.__spoken.join(" "))).toContain("Score: 7 / 10");
  await expect(page.locator(".fc-mock-score")).toContainText("1/2 objective marks");
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(page);
});

test("the answer appears word by word while the AI is still writing", async ({ page }) => {
  await stubAuth(page, { user: student });
  const conversation = { id: "623e4567-e89b-42d3-a456-426614174000", mode: "chat", title: "Estoppel" };
  const user = { id: "1", role: "user", status: "done", content: "Explain estoppel", meta: {} };
  let polls = 0;
  let finish = false;
  await page.route("**/api/**", route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/v1/ai/me") return json(route, { data: { configured: true, web_search: true, email_verified: true, admin: true, allowance: null } });
    if (path === `/api/v1/ai/conversations/${conversation.id}`) {
      polls += 1;
      const partial = polls === 1 ? "## Estoppel\n\nEstoppel stops a party" : "## Estoppel\n\nEstoppel stops a party from going back on a promise <img src=x onerror=alert(1)>";
      const message = finish
        ? { id: "2", role: "assistant", status: "done", content: "## Estoppel\n\nEstoppel stops a party from going back on a promise the other side relied on.", sources: [], meta: {} }
        : { id: "2", role: "assistant", status: "pending", content: partial, sources: [], meta: { stage: "writing", streaming: true } };
      return json(route, { data: { conversation, messages: [user, message] } });
    }
    if (path === "/api/v1/ai/messages" && request.method() === "POST") return json(route, { data: { conversation, messages: [user, { id: "2", role: "assistant", status: "pending", content: "", sources: [], meta: {} }] } }, 202);
    if (path === "/api/v1/presence") return route.fulfill({ status: 204 });
    return json(route, { data: [] });
  });
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/ai.html");
  await page.locator("#ai-input").fill("Explain estoppel");
  await page.locator("#ai-send").click();
  await expect(page.locator(".fc-wait-title")).toHaveText(/Fire is coming/);
  const streaming = page.locator(".ai-streaming");
  await expect(streaming.locator("h3")).toHaveText("Estoppel", { timeout: 10_000 });
  await expect(streaming).toContainText("Writing…");
  await expect(streaming).toContainText("Estoppel stops a party");
  await expect(streaming).toContainText("going back on a promise", { timeout: 10_000 });
  await expect(page.locator(".ai-streaming img")).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/streaming.png` });
  finish = true;
  await expect(page.locator(".ai-answer").last()).toContainText("the other side relied on", { timeout: 10_000 });
  await expect(page.locator(".ai-streaming")).toHaveCount(0);
  await expect(page.locator("[data-speak='2']")).toBeVisible();
});

test("signed out, the AI studio and the workspace both show only the sign-in gate", async ({ page }) => {
  await stubAuth(page, { user: null });
  await page.goto("/ai.html");
  // No AI preview: the gate covers the page and links back to sign-in.
  await expect(page.locator("#auth-gate")).toBeVisible();
  await expect(page.locator("#auth-gate-signin")).toHaveAttribute("href", "./auth.html?next=ai.html");
  await expect(page.locator("#ai-workspace")).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(page);
  // Signed out, the workspace shows only its lock screen with a sign-in route.
  await page.goto("/study.html");
  await expect(page.locator("#auth-gate")).toBeVisible();
  await expect(page.locator("#auth-gate-signin")).toHaveAttribute("href", "./auth.html?next=study.html");
  await expect(page.locator("#student-nav")).toBeHidden();
  await expectNoHorizontalOverflow(page);
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
  // The published course list is public (the same for everyone); every other call is authenticated.
  expect(requests.filter(request => new URL(request.url()).pathname !== "/api/v1/courses").every(request => request.headers().authorization === "Bearer synthetic-test-token")).toBe(true);
  expect(requests.filter(request => new URL(request.url()).pathname === "/api/v1/courses").every(request => !request.headers().authorization)).toBe(true);
  expect(requests.find(request => request.method() === "POST" && request.url().endsWith("/research/search")).postDataJSON()).toEqual({ query: "contract law" });
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
  // The website-content editor and slideshow load the live public JSON.
  await expect(page.locator("#editor-status")).toHaveText("Live website content loaded");
  await expect(page.locator("#json-editor")).toHaveValue(/"brand"/);
  await expect(page.locator(".slide-card")).not.toHaveCount(0);
  for (const name of ["content", "media", "uploads", "ai", "plans", "database", "overview"]) {
    await page.locator(`[data-panel=${name}]`).click();
    await expect(page.locator(`#panel-${name}`)).toBeVisible();
    await expect(page.locator(".admin-panel:visible")).toHaveCount(1);
  }
  await page.locator("[data-panel=database]").click();
  await expect(page.locator("#database-firebase-state")).toContainText("not an administrator");
  await expect(page.locator("#database-new")).toBeDisabled();
  await expect(page.locator("#database-resource")).toBeDisabled();
  await expect(page.locator("#ai-test-button")).toBeDisabled();
  await expect(page.locator("#ai-prompt-save")).toBeDisabled();
  await expect(page.locator("#save-default-limits")).toBeDisabled();
  await expect(page.locator("#admin-claim")).toBeHidden();
  for (const id of ["#publish-site", "#save-draft", "#add-slide-files", "#upload-submit", "#upload-files"]) await expect(page.locator(id)).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("admin AI panel shows Groq and Tavily keys and a health row for every model", async ({ page }) => {
  await stubAuth(page, { user: admin });
  let gatewayTimeout = false;
  const providers = {
    configured: true,
    gemini: { configured: true, models: ["gemini-3.8-flash"], search_models: ["gemini-2.5-flash-lite"] },
    groq: { configured: true, key_name: "GROQ_API_KEY", warning: null, models: ["openai/gpt-oss-120b", "openai/gpt-oss-20b"] },
    openrouter: { configured: true, models: ["openrouter/free"], warning: "OpenRouter keys start with sk-or-v1-. What is saved does not look like a key: paste ONLY the key from openrouter.ai/keys (not the TypeScript or REST code)." },
    tavily: { configured: true, key_name: "TRIVILY_API_KEY", warning: "Tavily keys normally start with tvly-. Check that the whole key was pasted.", depth: "basic" }
  };
  const models = [
    { provider: "gemini", model: "gemini-3.8-flash", role: "writer", ok: false, ms: 900, code: "PROVIDER_QUOTA", error: "Gemini rate limit or free quota reached." },
    { provider: "groq", model: "openai/gpt-oss-120b", role: "fast backup", ok: true, ms: 420, reply: "FIRE COUNSEL AI is connected.", sources: 0 },
    { provider: "openrouter", model: "free-model", role: "backup", ok: true, ms: 2100, reply: "FIRE COUNSEL AI is connected.", sources: 0 },
    { provider: "tavily", model: "tavily", role: "backup web search", ok: true, ms: 800, reply: "3 pages", sources: 3 }
  ];
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/health") return json(route, { database: "connected" });
    if (path === "/api/v1/admin/me") return json(route, { user: { ...admin, role: "admin" } });
    if (path.endsWith("/catalog")) return json(route, { data: catalog });
    if (path === "/api/v1/presence") return route.fulfill({ status: 204 });
    if (path === "/api/v1/admin/ai/status") return json(route, { data: { providers, skipped_models: [], database: "configured", schema_ready: true, prompts: [], limits: null, today: {}, timezone: "Africa/Lagos" } });
    if (path === "/api/v1/admin/ai/test" && gatewayTimeout) return route.fulfill({ status: 524, contentType: "text/html", body: "<html>A timeout occurred</html>" });
    if (path === "/api/v1/admin/ai/test") return json(route, { data: { ok: true, provider: "groq", model: "openai/gpt-oss-120b", reply: "FIRE COUNSEL AI is connected.", fallback: true, search: { ok: true, provider: "tavily", model: "tavily", sources: 3 }, models } });
    return json(route, { data: [] });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/admin.html");
  await expect(page.locator("#admin-auth-status")).toHaveAttribute("data-state", "verified");
  await page.locator("[data-panel=ai]").click();
  const status = page.locator("#ai-provider-status");
  await expect(status).toContainText("Groq (fast backup)");
  await expect(status).toContainText("Tavily (backup web search)");
  await expect(status).toContainText("TRIVILY_API_KEY");
  await expect(status.locator(".fc-warn").filter({ hasText: "tvly-" })).toHaveCount(1);
  await expect(status.locator(".fc-warn").filter({ hasText: "sk-or-v1-" })).toContainText("not the TypeScript or REST code");
  await page.locator("#ai-test-button").click();
  await expect(page.locator("#ai-test-result")).toContainText("Working: Groq (openai/gpt-oss-120b)");
  await expect(page.locator("#ai-test-result")).toContainText("Web search works via Tavily (3 sources)");
  const rows = page.locator("#ai-test-models tbody tr");
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText("QUOTA");
  await expect(rows.nth(0)).toContainText("free quota reached");
  await expect(rows.nth(1)).toContainText("HEALTHY");
  await expect(rows.nth(3)).toContainText("Tavily");
  await expect(rows.nth(3)).toContainText("3 sources");
  if (process.env.SHOT_DIR) await page.locator("#panel-ai").screenshot({ path: `${process.env.SHOT_DIR}/admin-health.png` });
  // A gateway timeout is explained in plain words, not "Request failed (524)".
  gatewayTimeout = true;
  await page.locator("#ai-test-button").click();
  await expect(page.locator("#ai-test-result")).toContainText("took too long");
  await expect(page.locator("#ai-test-result")).toHaveAttribute("data-kind", "error");
  await expect(page.locator("#ai-test-models tbody tr")).toHaveCount(0);
  await expect(page.locator("#ai-test-button")).toBeEnabled();
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
    if (path === "/api/v1/presence") return route.fulfill({ status: 204 });
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

test("sign-in is Google-only: no email form, and the Google button signs in with a branded logo", async ({ page }) => {
  await stubAuth(page);
  await page.route("**/api/v1/profile", route => json(route, { data: { full_name: student.displayName, email: student.email, installation: { registered: true } } }));
  await page.goto("/auth.html");
  // Google is the only sign-in path; no password fields or anonymous link.
  await expect(page.locator("#google-signin-button")).toBeVisible();
  await expect(page.locator("#google-signin-button .google-logo")).toBeVisible();
  await expect(page.locator("#email-signin-form")).toHaveCount(0);
  await expect(page.locator(".auth-card input[type=password]")).toHaveCount(0);
  await page.locator("#google-signin-button").click();
  await expect(page.locator("#signed-in-email")).toHaveText("google@example.invalid");
  await expect(page.locator("#continue-button")).toBeVisible();
  expect(await page.evaluate(() => window.__auth.googleCalls)).toBe(1);
  await page.locator("#sign-out-button").click();
  await expect(page.locator("#google-signin-button")).toBeVisible();
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
    await stubAuth(page, { user: student });
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
  await expect(page.locator("#google-signin-button")).toBeVisible();
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

// A tiny one-page PDF with real text (pdf.js rebuilds the cross-reference table).
function syntheticPdf(text) {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  return Buffer.from(`%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length ${stream.length} >> stream
${stream}
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
trailer << /Root 1 0 R /Size 6 >>
%%EOF
`);
}

test("students can read a saved PDF in the built-in reader and close it with Back", async ({ page }) => {
  await stubAuth(page, { user: student });
  await readyStudy(page, "library");
  await page.locator("#file-input").setInputFiles({ name: "synthetic-judgment.pdf", mimeType: "application/pdf", buffer: syntheticPdf("Reader works offline") });
  await expect(page.locator("#library-count")).toHaveText("1 file");
  await page.locator("[data-open-doc]").click();
  const reader = page.locator(".reader-overlay");
  await expect(reader).toBeVisible();
  await expect(reader.locator(".reader-title")).toHaveText("synthetic-judgment.pdf");
  await expect(reader.locator(".reader-page canvas")).toHaveCount(1);
  await expect(reader.locator(".reader-counter")).toHaveText("1 / 1");
  await reader.getByRole("button", { name: "Show the text so you can copy it" }).click();
  await expect(reader.locator(".reader-text")).toContainText("Reader works offline");
  await reader.getByRole("button", { name: "Zoom in" }).click();
  await page.goBack();
  await expect(reader).toHaveCount(0);
  await expect(page.locator("#document-list")).toContainText("synthetic-judgment.pdf");
  // Plain-text notes open too.
  await page.locator("#file-input").setInputFiles({ name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("Ratio decidendi line") });
  await page.locator("[data-open-doc]", { hasText: "note.txt" }).click();
  await expect(page.locator(".reader-plain")).toHaveText("Ratio decidendi line");
  await page.locator(".reader-close").click();
  await expect(page.locator(".reader-overlay")).toHaveCount(0);
});

test("admin previews a website draft, publishes to Firebase before Neon and restores the primary live document", async ({ page, context }) => {
  await stubAuth(page, { user: admin });
  const base = await (await page.request.get("/data/site-content.json")).json();
  await stubFirestore(page, { content: base });
  const draft = { ...base, brand: { ...base.brand, name: "Draft Brand Name" } };
  const calls = [];
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/health") return json(route, { database: "connected" });
    if (path.endsWith("/database/catalog")) return json(route, { data: catalog });
    if (path === "/api/v1/admin/site" && request.method() === "GET") {
      return json(route, { data: { draft: { content: draft, updated_at: "2026-11-02T10:00:00Z" }, published: { content: base, updated_at: "2026-11-01T10:00:00Z" }, versions: [{ id: rowId, note: "First", published_by: "admin@example.invalid", created_at: "2026-11-01T10:00:00Z" }, { id: "323e4567-e89b-42d3-a456-426614174000", note: "Older", published_by: "admin@example.invalid", created_at: "2026-10-01T10:00:00Z" }] } });
    }
    if (path.startsWith("/api/v1/admin/site/versions/")) return json(route, { data: { content: base, created_at: "2026-11-01T10:00:00Z" } });
    if (path.startsWith("/api/v1/admin/site") || path.startsWith("/api/v1/admin/documents")) {
      calls.push({ method: request.method(), path, type: request.headers()["content-type"], body: request.postData(), firebaseWrites: path.endsWith("/publish") ? await page.evaluate(() => window.__firestore.writes.length) : null });
      if (path.endsWith("/usage")) return json(route, { data: { used_bytes: 1048576, budget_bytes: 367001600, files: 1, max_file_bytes: 26214400, ocr: { ai: true, ocr_space: false } } });
      if (path === "/api/v1/admin/documents" && request.method() === "GET") return json(route, { data: [{ id: rowId, purpose: "material", file_name: "Contract notes.pdf", size_bytes: 2048, status: "saved", method: "pdf_text", page_count: 12, warnings: [], result: { title: "Contract notes", version_number: 1, chunks: 9 }, has_file: true }] });
      if (path === "/api/v1/admin/documents" && request.method() === "POST") return json(route, { data: { id: rowId, status: "uploaded" } }, 202);
      return json(route, { data: { saved: true } });
    }
    return json(route, { user: { ...admin, role: "admin" } });
  });
  page.on("dialog", dialog => dialog.accept());
  await page.goto("/admin.html");
  await expect(page.locator("#admin-auth-status")).toHaveAttribute("data-state", "verified");
  await page.locator("[data-panel=content]").click();
  await expect(page.locator("#editor-status")).toContainText("Unpublished draft loaded");
  await expect(page.locator("#json-editor")).toHaveValue(/Draft Brand Name/);
  await expect(page.locator("#site-versions")).toContainText("LATEST ARCHIVE");
  await expect(page.locator("#publish-site")).toBeEnabled();

  await page.locator("#save-draft").click();
  await expect(page.locator("#editor-status")).toContainText("Draft saved");

  const [preview] = await Promise.all([context.waitForEvent("page"), page.locator("#preview-site").click()]);
  await expect(preview.locator("#preview-banner")).toContainText("PREVIEW");
  await expect(preview.locator("body")).toContainText("Draft Brand Name");
  await preview.close();

  await page.locator("#publish-note").fill("New brand");
  await page.locator("#publish-site").click();
  await expect(page.locator("#editor-status")).toContainText("Published");
  const publish = calls.find(call => call.path.endsWith("/publish"));
  expect(JSON.parse(publish.body)).toMatchObject({ note: "New brand", content: { brand: { name: "Draft Brand Name" } } });
  expect(JSON.parse(calls.find(call => call.path.endsWith("/draft")).body).content.brand.name).toBe("Draft Brand Name");

  expect(publish.firebaseWrites).toBe(1, "Firebase is already live before Neon is touched");
  expect(await page.evaluate(() => window.__firestore.tokenRefreshes)).toEqual([true]);
  await page.locator("[data-restore-version]").first().click();
  await expect(page.locator("#editor-status")).toContainText("live again on Firebase");
  expect(calls.filter(call => call.path.endsWith("/publish")).map(call => call.firebaseWrites)).toEqual([1, 2]);
  expect(await page.evaluate(() => window.__firestore.document.brand.name)).toBe(base.brand.name);

  // Upload documents: the file is sent as-is with its own type.
  await page.locator("[data-panel=uploads]").click();
  await expect(page.locator("#upload-rows")).toContainText("Contract notes.pdf");
  await expect(page.locator("#upload-rows")).toContainText("9 searchable parts");
  await expect(page.locator("#upload-usage")).toContainText("Gemini");
  await page.locator("#upload-files").setInputFiles({ name: "Torts.pdf", mimeType: "application/pdf", buffer: syntheticPdf("Torts") });
  await page.locator("#upload-submit").click();
  await expect(page.locator("#upload-status")).toContainText("1 file uploaded");
  const upload = calls.find(call => call.method === "POST" && call.path === "/api/v1/admin/documents");
  expect(upload.type).toBe("application/pdf");
  expect(upload.body.startsWith("%PDF")).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("students see the administrator's published courses next to their personal ones, kept in sync", async ({ page }) => {
  let official = [
    { id: "c1", course_code: "LAW 241", title: "Contract Law", academic_level: "200 level", university: "UNN" },
    { id: "c2", course_code: "LAW 311", title: "Law of Evidence", academic_level: null, university: "UNN" }
  ];
  await stubAuth(page, { user: student });
  await page.route("**/api/v1/courses", route => json(route, { data: official }));
  await page.goto("/study.html#subjects");
  // 2 official courses + 6 personal areas, minus the personal "Contract Law" duplicate.
  await expect(page.locator("#course-nav-count")).toHaveText("7");
  const cards = page.locator("#all-subjects .subject-card");
  await expect(cards.first()).toContainText("LAW 241 · Contract Law");
  await expect(cards.first()).toContainText("Official course · 200 level · UNN");
  await expect(page.locator("#all-subjects .official-course")).toHaveCount(2);
  await expect(page.locator("#active-course-select option").first()).toHaveText("LAW 241 · Contract Law");
  // An admin edit reaches the student when the page is shown again.
  official = [{ ...official[1], title: "Law of Evidence (revised)" }];
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.locator("#all-subjects .official-course")).toHaveCount(1);
  await expect(page.locator("#all-subjects .official-course")).toContainText("Law of Evidence (revised)");
  await expect(page.locator("#course-nav-count")).toHaveText("7");
  // Offline: the last list is kept.
  await page.unroute("**/api/v1/courses");
  await page.route("**/api/v1/courses", route => route.abort());
  await page.reload();
  await expect(page.locator("#all-subjects .official-course")).toContainText("Law of Evidence (revised)");
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(page);
});

test("admin adds and edits a course, and imports and edits the AI background instructions", async ({ page }) => {
  await stubAuth(page, { user: admin });
  const writes = [];
  const uni = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const courseId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  let courses = [];
  let universities = [];
  const instructionList = () => [
    { key: "system_instructions", label: "Master system instructions", group: "always", saved: writes.some(w => w.path.endsWith("/import")), length: 3999, updated_at: "2026-11-18T10:00:00Z" },
    { key: "case_analysis", label: "Case analysis", group: "specialist", saved: writes.some(w => w.path.endsWith("/import")), length: 1299, updated_at: "2026-11-18T10:00:00Z" },
    { key: "socratic_tutoring", label: "Socratic tutoring", group: "specialist", saved: false, length: 0, updated_at: null }
  ];
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (method !== "GET") writes.push({ method, path, body: request.postDataJSON() });
    if (path === "/api/health") return json(route, { database: "connected" });
    if (path === "/api/v1/admin/me") return json(route, { user: { ...admin, role: "admin" } });
    if (path.endsWith("/catalog")) return json(route, { data: catalog });
    if (path === "/api/v1/presence") return route.fulfill({ status: 204 });
    if (path === "/api/v1/admin/database/options/universities") return json(route, { data: universities });
    if (path === "/api/v1/admin/database/universities" && method === "POST") {
      universities = [{ id: uni, label: request.postDataJSON().name }];
      return json(route, { data: { id: uni } }, 201);
    }
    if (path === "/api/v1/admin/database/courses" && method === "GET") return json(route, { data: courses, pagination: { total: courses.length } });
    if (path === "/api/v1/admin/database/courses" && method === "POST") {
      courses = [{ id: courseId, ...request.postDataJSON() }];
      return json(route, { data: courses[0] }, 201);
    }
    if (path === `/api/v1/admin/database/courses/${courseId}` && method === "GET") return json(route, { data: courses[0] });
    if (path === `/api/v1/admin/database/courses/${courseId}` && method === "PATCH") {
      courses = [{ ...courses[0], ...request.postDataJSON() }];
      return json(route, { data: courses[0] });
    }
    if (path === "/api/v1/admin/ai/instructions") return json(route, { data: instructionList() });
    if (path === "/api/v1/admin/ai/instructions/import") return json(route, { data: { saved: [{ key: "system_instructions", label: "Master system instructions", length: 50 }, { key: "case_analysis", label: "Case analysis", length: 40 }], missing: [{ key: "socratic_tutoring", label: "Socratic tutoring" }] } });
    if (path.startsWith("/api/v1/admin/ai/instructions/")) {
      const key = path.split("/").pop();
      if (method === "PUT") return json(route, { data: { key, saved: true } });
      const saved = instructionList().find(item => item.key === key);
      return json(route, { data: { key, saved: saved?.saved || false, content: saved?.saved ? `Saved text for ${key}.` : "", updated_at: null } });
    }
    return json(route, { data: [] });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/admin.html");
  await expect(page.locator("#admin-auth-status")).toHaveAttribute("data-state", "verified");

  // Courses: first course with a brand-new university.
  await page.locator("[data-panel=courses]").click();
  await expect(page.locator("#course-rows")).toContainText("No courses yet");
  await page.locator("#course-add").click();
  await expect(page.locator("#course-new-university-field")).toBeVisible();
  await page.locator("#course-new-university").fill("University of Nigeria");
  await page.locator("#course-code").fill("LAW 241");
  await page.locator("#course-title").fill("Law of Contract I");
  await page.locator("#course-level").fill("200 level");
  await page.locator("#course-save").click();
  await expect(page.locator("#course-form-status")).toContainText("Every student now sees this course");
  const created = writes.find(w => w.path === "/api/v1/admin/database/courses");
  expect(created.body).toMatchObject({ university_id: uni, course_code: "LAW 241", title: "Law of Contract I", academic_level: "200 level", semester: null, is_published: true });
  expect(writes.find(w => w.path === "/api/v1/admin/database/universities").body).toMatchObject({ name: "University of Nigeria", slug: "university-of-nigeria" });
  await expect(page.locator("#course-rows")).toContainText("Law of Contract I");
  await expect(page.locator("#course-rows")).toContainText("VISIBLE TO STUDENTS");
  // Edit it: hide from students.
  await page.locator("#course-cancel").click();
  await expect(page.locator("#course-form")).toBeHidden();
  await page.locator("[data-edit-course]").click();
  await expect(page.locator("#course-form")).toBeVisible();
  await expect(page.locator("#course-title")).toHaveValue("Law of Contract I");
  await page.locator("#course-title").fill("Law of Contract (Part I)");
  await page.locator("#course-published").uncheck();
  await page.locator("#course-save").click();
  await expect(page.locator("#course-form-status")).toContainText("HIDDEN");
  const patched = writes.find(w => w.method === "PATCH");
  expect(patched.path).toBe(`/api/v1/admin/database/courses/${courseId}`);
  expect(patched.body).toMatchObject({ title: "Law of Contract (Part I)", is_published: false });
  await expect(page.locator("#course-rows")).toContainText("HIDDEN");
  await expectNoHorizontalOverflow(page);

  // AI background instructions: import the file, then edit one.
  await page.locator("[data-panel=ai]").click();
  await expect(page.locator("#ai-instr-list")).toContainText("No background instructions saved yet");
  await page.locator("#ai-instr-import").setInputFiles({ name: "Fire_Counsel_Master_Prompts_and_Guides.txt", mimeType: "text/plain", buffer: Buffer.from("SYSTEM_INSTRUCTIONS = r'''\nSample master rules for the test.\n'''\n") });
  await expect(page.locator("#ai-instr-import-status")).toContainText("Saved 2 instructions");
  await expect(page.locator("#ai-instr-import-status")).toContainText("Not in the file: Socratic tutoring");
  expect(writes.find(w => w.path.endsWith("/import")).body.text).toContain("SYSTEM_INSTRUCTIONS");
  await expect(page.locator("#ai-instr-list")).toContainText("2 of 3 instructions saved");
  await page.locator("[data-instr=case_analysis]").click();
  await expect(page.locator("#ai-instr-text")).toHaveValue("Saved text for case_analysis.");
  await expect(page.locator("#ai-instr-state")).toHaveText("IN USE");
  await page.locator("#ai-instr-text").fill("Edited case analysis instruction for every student.");
  await page.locator("#ai-instr-save").click();
  await expect(page.locator("#ai-instr-status")).toContainText("Saved");
  const put = writes.find(w => w.method === "PUT" && w.path.endsWith("/instructions/case_analysis"));
  expect(put.body).toEqual({ content: "Edited case analysis instruction for every student." });
  await expectNoHorizontalOverflow(page);
});

test("admin sees Google accounts, today's AI use and presence, and sign-out clears the list", async ({ page }) => {
  await stubAuth(page, { user: admin });
  const defaults = { chat: 30, case: 4, notes: 3, questions: 5 };
  const account = {
    uid: student.uid, email: "google@example.invalid", name: "Google Student", providers: ["google.com"],
    email_verified: true, admin: false, online: true, last_seen_at: new Date().toISOString(),
    limits: { chat: null, case: 10, notes: null, questions: null },
    usage_today: { chat: 7, case: 2, notes: 1, questions: 0 }, premium: true, paused: false
  };
  let holdUsers = false, release, started;
  const held = new Promise(resolve => { release = resolve; });
  const requestStarted = new Promise(resolve => { started = resolve; });
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/health") return json(route, { database: "connected" });
    if (path === "/api/v1/admin/me") return json(route, { user: { ...admin, role: "admin" } });
    if (path.endsWith("/catalog")) return json(route, { data: catalog });
    if (path === "/api/v1/presence") return route.fulfill({ status: 204 });
    if (path === "/api/v1/admin/ai/users") {
      if (holdUsers) { started(); await held; }
      return json(route, { data: { users: [account], total: 1, online: 1, defaults } });
    }
    if (path === "/api/v1/admin/ai/status") return json(route, { data: {
      providers: { gemini: { configured: false, models: [], search_models: [] }, openrouter: { configured: false, models: [] } },
      schema_ready: true, prompts: [], limits: defaults, today: {}, timezone: "Africa/Lagos"
    } });
    return json(route, { data: [] });
  });
  await page.goto("/admin.html");
  await expect(page.locator("#admin-auth-status")).toHaveAttribute("data-state", "verified");
  await page.locator("[data-panel=plans]").click();
  const row = page.locator("#student-account-rows tr");
  await expect(page.locator("#accounts-summary")).toHaveText("1 account · 1 active now");
  for (const text of ["Google Student", "google@example.invalid", "Active", "PREMIUM", "Chats: 7 / 30", "Cases: 2 / 10", "Notes: 1 / 3", "Questions: 0 / 5"]) {
    await expect(row).toContainText(text);
  }
  await page.locator("#account-search").fill("unknown account");
  await expect(row).toContainText("No account matches");
  await page.locator("#account-search").fill("google@example.invalid");
  await expect(row).toContainText("Google Student");
  await row.getByRole("button", { name: "Change limits" }).click();
  await expect(page.locator("#user-premium")).toBeChecked();
  await expect(page.locator("#user-limit-case")).toHaveValue("10");
  // A pending refresh must not restore private account data after sign-out.
  holdUsers = true;
  await page.locator("#refresh-accounts").click();
  await requestStarted;
  await page.locator("#admin-signout").click();
  await expect(page.locator("#accounts-summary")).toContainText("Sign in as an administrator");
  await expect(page.locator("#student-account-rows")).toBeEmpty();
  await expect(page.locator("#account-adjustment-form")).toBeHidden();
  const returned = page.waitForResponse("**/api/v1/admin/ai/users");
  release();
  await finishReply(page, await returned);
  await expect(page.locator("#student-account-rows")).toBeEmpty();
});

test("a saved password session cannot open either app page or enable auth continuation", async ({ page }) => {
  await stubAuth(page, { user: { ...student, signInProvider: "password" } });
  for (const path of ["/study.html", "/ai.html"]) {
    await page.goto(path);
    await expect(page.locator("body")).toHaveAttribute("data-auth-gate", "locked");
    await expect(page.locator("#auth-gate-signin")).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("fire-counsel-auth-gate-v2"))).toBeNull();
  }
  await page.goto("/auth.html");
  await expect(page.locator("#auth-message")).toContainText("did not sign in with Google");
  await expect(page.locator("#google-signin-button")).toBeVisible();
  await expect(page.locator("#signed-in-panel")).toBeHidden();
  await expect(page.locator("#continue-button")).toBeHidden();
});

test("a delayed Google-session check cannot unlock an app page after sign-out", async ({ page }) => {
  await stubAuth(page);
  for (const path of ["/study.html", "/ai.html"]) {
    await page.goto(path);
    await expect(page.locator("body")).toHaveAttribute("data-auth-gate", "locked");
    await page.evaluate(user => {
      window.__auth.checkGoogleSession = () => new Promise(resolve => { window.__auth.releaseGoogleCheck = resolve; });
      window.__auth.setUser(user);
    }, student);
    await expect(page.locator("body")).toHaveAttribute("data-auth-gate", "pending");
    await page.evaluate(() => window.__auth.setUser(null));
    await expect(page.locator("body")).toHaveAttribute("data-auth-gate", "locked");
    await page.evaluate(() => window.__auth.releaseGoogleCheck(true));
    await expect(page.locator("body")).toHaveAttribute("data-auth-gate", "locked");
    expect(await page.evaluate(() => localStorage.getItem("fire-counsel-auth-gate-v2"))).toBeNull();
  }
});
