import { test, expect, stubAuth, admin, expectNoHorizontalOverflow } from "./fixtures.mjs";

const conversation = { id: "723e4567-e89b-42d3-a456-426614174000", mode: "chat", title: "Supplied synthetic report" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function setup(page, { online = true, searchProviders = ["tavily", "brave"], post, poll } = {}) {
  await stubAuth(page, { user: admin });
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/ai/me") return json(route, { data: { configured: true, web_search: online, search_providers: online ? searchProviders : [], email_verified: true, admin: true, allowance: null } });
    if (path === "/api/v1/ai/messages") return post(route);
    if (path === `/api/v1/ai/conversations/${conversation.id}`) return poll(route);
    if (path === "/api/v1/presence") return route.fulfill({ status: 204 });
    return json(route, { data: [] });
  });
}

test("missing search setup never silently unchecks online search; non-web mode is an explicit choice", async ({ page }) => {
  const requests = [];
  const answer = { id: "2", role: "assistant", status: "done", content: "Answer from supplied material, without web research.", sources: [], meta: { web_search: false } };
  await setup(page, { online: false, poll: route => json(route, { data: { conversation, messages: [answer] } }), post: route => {
    const body = route.request().postDataJSON();
    requests.push(body);
    return body.options.webSearch ? json(route, { error: "Online search is not configured. Ask the administrator to configure Tavily or Brave.", code: "SEARCH_NOT_CONFIGURED" }, 503)
      : json(route, { data: { conversation, messages: [answer] } }, 202);
  } });
  await page.goto("/ai.html");
  await expect(page.locator("#ai-status")).toBeEmpty();
  await expect(page.locator("#ai-status")).toBeHidden();
  await page.locator("#ai-input").fill("Explain the supplied synthetic report");
  await expect(page.locator("#ai-web-search")).toBeVisible();
  await expect(page.locator("#ai-web-search")).toBeChecked();
  await expect(page.locator("#ai-web-search")).toBeEnabled();
  await expect(page.locator("#ai-search-status")).toHaveCount(0);
  await page.locator("#ai-send").click();
  await expect(page.locator("#ai-status")).toContainText("Online search is not configured");
  expect(requests[0].options.webSearch).toBe(true);
  await expect(page.locator("#ai-web-search")).toBeChecked();
  await expect(page.locator("#ai-input")).toHaveValue("Explain the supplied synthetic report");
  await expect(page.locator("#ai-status")).toHaveAttribute("data-state", "error");
  await page.locator("#ai-web-search").uncheck();
  await expect(page.locator("#ai-search-status")).toHaveCount(0);
  await page.locator("#ai-send").click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1].options.webSearch).toBe(false);
  await expect(page.locator(".ai-meta")).toContainText("Not web-verified");
  await page.setViewportSize({ width: 320, height: 740 });
  await expectNoHorizontalOverflow(page);
});

test("a failed search job is shown as an error, never as Answer ready", async ({ page }) => {
  const pending = { id: "2", role: "assistant", status: "pending", content: "", meta: { stage: "searching" } };
  const failed = { ...pending, status: "failed", content: "Online search failed. No unsourced answer was generated. This request was not counted.", meta: { code: "SEARCH_UNAVAILABLE" } };
  await setup(page, {
    post: route => json(route, { data: { conversation, messages: [pending] } }, 202),
    poll: route => json(route, { data: { conversation, messages: [failed] } })
  });
  await page.goto("/ai.html");
  await expect(page.locator("#ai-status")).toBeEmpty();
  await expect(page.locator("#ai-status")).toBeHidden();
  await page.locator("#ai-input").fill("Explain the supplied report");
  await page.locator("#ai-send").click();
  await expect(page.locator(".ai-failed")).toContainText("Online search failed", { timeout: 12_000 });
  await expect(page.locator("#ai-status")).toContainText("not counted");
  await expect(page.locator("#ai-status")).toHaveAttribute("data-state", "error");
  await expect(page.locator("#ai-status")).not.toContainText("Answer ready");
  await expect(page.locator(".ai-sources")).toHaveCount(0);
  await expect(page.locator("#ai-send")).toBeEnabled();
});

test("reused online research shows its provider and original retrieval time, and clears on sign-out", async ({ page }) => {
  const answer = { id: "2", role: "assistant", status: "done", content: "Explanation of the supplied synthetic report.",
    sources: [{ url: "https://example.org/report", title: "Supplied report", status: "reachable", origin: "brave" }],
    meta: { web_search: true, search_providers: ["brave"], search_cached: true, searched_at: "2026-11-19T10:00:00.000Z" } };
  await setup(page, { post: route => json(route, { data: { conversation, messages: [answer] } }, 202), poll: route => json(route, { data: { conversation, messages: [answer] } }) });
  await page.goto("/ai.html");
  await expect(page.locator("#ai-status")).toBeEmpty();
  await expect(page.locator("#ai-status")).toBeHidden();
  await page.locator("#ai-input").fill("Explain the supplied report");
  await page.locator("#ai-send").click();
  await expect(page.locator(".ai-meta")).toContainText("Reused online research · Brave Search · retrieved");
  await expect(page.locator(".ai-meta")).not.toContainText("Online search completed");
  await expect(page.locator(".ai-link-badge")).toHaveText("Opens");
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(page);
  await page.evaluate(() => window.__auth.setUser(null));
  await expect(page.locator("#ai-thread")).toBeEmpty();
  await expect(page.locator("#ai-search-status")).toHaveCount(0);
});

test("DeepSeek fallback answers keep SerpAPI source provenance and disclose the writer", async ({ page }) => {
  const answer = { id: "2", role: "assistant", status: "done", provider: "deepseek", model: "deepseek-flash", content: "Answer from the supplied report.",
    sources: [{ url: "https://example.org/report", title: "Supplied report", status: "reachable", origin: "serpapi" }],
    meta: { fallback: true, web_search: true, search_providers: ["serpapi"], searched_at: "2026-11-19T10:00:00.000Z", search_cached: false } };
  await setup(page, { searchProviders: ["serpapi"], post: route => json(route, { data: { conversation, messages: [answer] } }, 202), poll: route => json(route, { data: { conversation, messages: [answer] } }) });
  await page.goto("/ai.html");
  await expect(page.locator("#ai-status")).toBeEmpty();
  await expect(page.locator("#ai-status")).toBeHidden();
  await expect(page.locator("#ai-search-status")).toHaveCount(0);
  await expect(page.locator(".fc-privacy")).toContainText("DeepSeek");
  await expect(page.locator(".fc-privacy")).toContainText("SerpAPI");
  await page.locator("#ai-input").fill("Explain the supplied report");
  await page.locator("#ai-send").click();
  await expect(page.locator(".ai-meta")).toContainText("Writer: DeepSeek");
  await expect(page.locator(".ai-meta")).toContainText("Answered by a backup writer");
  await expect(page.locator(".ai-meta")).toContainText("Online search completed · SerpAPI");
  await expect(page.locator(".ai-sources a")).toHaveAttribute("href", "https://example.org/report");
  await page.setViewportSize({ width: 320, height: 740 });
  await expectNoHorizontalOverflow(page);
});

test("all writers unavailable replaces partial text with a retryable error, not an unsourced success", async ({ page }) => {
  const pending = { id: "2", role: "assistant", status: "pending", content: "Partial text from a failed writer", meta: { stage: "writing" } };
  const failed = { ...pending, status: "failed", content: "All configured AI writers are unavailable. Please try again shortly. This request was not counted.", meta: { code: "PROVIDERS_UNAVAILABLE" } };
  await setup(page, { post: route => json(route, { data: { conversation, messages: [pending] } }, 202), poll: route => json(route, { data: { conversation, messages: [failed] } }) });
  await page.goto("/ai.html");
  await expect(page.locator("#ai-status")).toBeEmpty();
  await expect(page.locator("#ai-status")).toBeHidden();
  await page.locator("#ai-input").fill("Explain the supplied report");
  await page.locator("#ai-send").click();
  await expect(page.locator(".ai-failed")).toContainText("writers are unavailable", { timeout: 12_000 });
  await expect(page.locator("#ai-thread")).not.toContainText("Partial text from a failed writer");
  await expect(page.locator("#ai-status")).toHaveAttribute("data-state", "error");
  await expect(page.locator(".ai-failed button")).toHaveText(/Try again/);
  await expect(page.locator("#ai-send")).toBeEnabled();
});
