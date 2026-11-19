import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import * as providers from "../src/services/ai/providers.js";
import { clearResearchCache, createStudio } from "../src/services/ai/studio.js";

const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const page = { url: "https://example.org/report", title: "Supplied synthetic report", content: "Synthetic search extract, not live legal material." };
const noDb = { query: async () => ({ rows: [] }) };
beforeEach(() => { providers.resetProviderHealth(); clearResearchCache(); });
afterEach(() => { providers.resetProviderHealth(); clearResearchCache(); });

test("a model reply without grounding URLs is not a successful web search", async () => {
  await assert.rejects(providers.generate({ search: true, messages: [{ role: "user", text: "Find the supplied report" }] }, {
    env: { GEMINI_API_KEY: "synthetic-gemini", GEMINI_SEARCH_MODELS: "test-search" },
    fetchImpl: async () => json(200, { candidates: [{ content: { parts: [{ text: "An answer from memory, without search results." }] } }] })
  }), { code: "SEARCH_NO_RESULTS" });
});

test("dedicated web search supplies extracts directly, without an extra AI call or dependence on Gemini", async () => {
  const calls = [];
  const result = await providers.generate({ search: true, messages: [{ role: "user", text: "Find the supplied report" }] }, {
    env: { GEMINI_API_KEY: "synthetic-gemini", GROQ_API_KEY: "gsk_synthetic", TAVILY_API_KEY: "tvly-synthetic" },
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).includes("tavily")) return json(200, { results: [page] });
      return json(200, { candidates: [{ content: { parts: [{ text: "An ungrounded answer" }] } }] });
    }
  });
  assert.equal(result.searchProvider, "tavily");
  assert.match(result.text, /Synthetic search extract/);
  assert.equal(result.sources[0].url, page.url);
  assert.deepEqual(calls, ["https://api.tavily.com/search"]);
});

test("Brave takes over when Tavily rejects a key, using Brave's subscription-token header", async () => {
  const calls = [];
  const result = await providers.generate({ search: true, searchQuery: "supplied report", messages: [{ role: "user", text: "Research this" }] }, {
    env: { GROQ_API_KEY: "gsk_synthetic", TAVILY_API_KEY: "tvly-synthetic", BRAVE_SEARCH_API_KEY: "synthetic-brave" },
    fetchImpl: async (url, init) => {
      const parsed = new URL(url);
      calls.push(parsed.hostname);
      if (parsed.hostname === "api.tavily.com") return json(401, { detail: { error: "Invalid key" } });
      assert.equal(parsed.origin + parsed.pathname, "https://api.search.brave.com/res/v1/web/search");
      assert.equal(parsed.searchParams.get("q"), "supplied report");
      assert.equal(init.headers["X-Subscription-Token"], "synthetic-brave");
      assert.equal(parsed.searchParams.has("extra_snippets"), false, "do not require plan-specific extras");
      assert.equal(parsed.href.includes("synthetic-brave"), false);
      return json(200, { web: { results: [{ url: page.url, title: page.title, description: page.content }] } });
    }
  });
  assert.equal(result.searchProvider, "brave");
  assert.equal(result.sources[0].origin, "brave");
  assert.deepEqual(calls, ["api.tavily.com", "api.search.brave.com"]);
});

test("online chat fails explicitly if retrieval fails; it does not spend a writer call on an unsourced answer", async () => {
  const calls = [];
  const studio = createStudio({ db: noDb, env: {}, researchCache: false, generate: async (request) => {
    calls.push(request.search ? "search" : "writer");
    if (request.search) throw new providers.AiError(503, "Search service unavailable.", "PROVIDER_UNAVAILABLE", { retryable: true });
    return { text: "Unsourced answer", provider: "groq", model: "test-writer" };
  } });
  await assert.rejects(studio.run("chat", { text: "Find the supplied report", options: { webSearch: true } }), /[Ss]earch.*unavailable/);
  assert.deepEqual(calls, ["search"]);
});

test("non-secret provider settings are not mistaken for API credentials", () => {
  const info = providers.describeProviders({ GROQ_BASE_URL: "https://api.groq.com", GROQ_ENABLED: "true", TAVILY_ENABLED: "true", TAVILY_API_KEY_FILE: "/etc/secrets/tavily" });
  assert.equal(info.groq.configured, false);
  assert.equal(info.tavily.configured, false);
});

test("Tavily authentication, quota, outage, malformed JSON and empty results all fall through to Brave", async (t) => {
  for (const failure of [401, 429, 432, 433, 503, "json", "empty"]) await t.test(String(failure), async () => {
    providers.resetProviderHealth();
    const calls = [];
    const result = await providers.generate({ search: true, messages: [{ role: "user", text: "Supplied synthetic report" }] }, {
      env: { TAVILY_API_KEY: "tvly-synthetic", BRAVE_API_KEY: "synthetic-brave" },
      fetchImpl: async (url) => {
        const host = new URL(url).hostname;
        calls.push(host);
        if (host === "api.search.brave.com") return json(200, { web: { results: [{ ...page, description: page.content }] } });
        if (failure === "json") return new Response("not-json", { status: 200 });
        if (failure === "empty") return json(200, { results: [] });
        return json(failure, { error: "Synthetic failure" });
      }
    });
    assert.equal(result.searchProvider, "brave");
    assert.deepEqual(calls, ["api.tavily.com", "api.search.brave.com"]);
    if ([401, 429, 432, 433, 503, "json"].includes(failure)) {
      calls.length = 0;
      await providers.generate({ search: true, messages: [{ role: "user", text: "Another query" }] }, {
        env: { TAVILY_API_KEY: "tvly-synthetic", BRAVE_API_KEY: "synthetic-brave" },
        fetchImpl: async (url) => { calls.push(new URL(url).hostname); return json(200, { web: { results: [page] } }); }
      });
      assert.deepEqual(calls, ["api.search.brave.com"], "respect Tavily's cooldown on subsequent requests");
    } else assert.deepEqual(providers.providerHealth(), [], "an empty query result is not a service outage");
  });
});

test("Brave-first order is explicit, validated, and independent of the writer configuration", async () => {
  const calls = [];
  const env = { BRAVE_API_KEY: "synthetic-brave", TAVILY_API_KEY: "tvly-synthetic", WEB_SEARCH_PROVIDER_ORDER: "brave,https://evil.example,tavily,brave" };
  const config = providers.aiConfig(env);
  assert.equal(config.configured, false, "a search key does not masquerade as an answer-writing model");
  assert.equal(config.search.configured, true);
  assert.deepEqual(config.search.order, ["brave", "tavily", "gemini"]);
  const result = await providers.generate({ search: true, messages: [{ role: "user", text: "Supplied report" }] }, { env,
    fetchImpl: async (url) => { calls.push(new URL(url).hostname); return json(200, { web: { results: [page] } }); } });
  assert.equal(result.searchProvider, "brave");
  assert.deepEqual(calls, ["api.search.brave.com"]);
  assert.equal(Number.isNaN(Date.parse(result.searchedAt)), false);
});

test("a writer-only configuration does not call Groq or pretend to perform web search", async () => {
  let called = false;
  await assert.rejects(providers.generate({ search: true, messages: [{ role: "user", text: "Report" }] }, {
    env: { GROQ_API_KEY: "gsk_synthetic" }, fetchImpl: async () => { called = true; throw new Error("must not fetch"); }
  }), { code: "SEARCH_NOT_CONFIGURED" });
  assert.equal(called, false);
});

test("search normalises and caps results, strips markup, and rejects unsafe or duplicated URLs", async () => {
  const unsafe = ["javascript:alert(1)", "file:///etc/passwd", "http://localhost/", "http://127.0.0.1/", "https://example.internal/", "https://example.org:8080/", "https://user:pw@example.org/", "http://[::ffff:7f00:1]/", "http://169.254.169.254/latest"];
  const found = await providers.searchTavily("word ".repeat(100), { key: "synthetic-key", maxResults: 2.7,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      assert.ok(body.query.length <= 380);
      assert.ok(body.query.split(" ").length <= 50);
      assert.equal(body.max_results, 2);
      assert.equal(body.include_answer, false);
      assert.equal(init.redirect, "error", "never forward credentials to an API redirect");
      assert.equal(init.headers.Authorization, "Bearer synthetic-key");
      return json(200, { results: [...unsafe.map(url => ({ ...page, url })),
        { ...page, url: page.url + "#a", title: "<b>Report</b>", content: "<script>evil()</script><strong>Supplied</strong> extract" },
        { ...page, url: page.url + "#b" }, { ...page, url: "https://example.org/second", content: "x".repeat(5000) },
        { ...page, url: "https://example.org/third" }] });
    }
  });
  assert.deepEqual(found.results.map(r => r.url), [page.url, "https://example.org/second"]);
  assert.equal(found.results[0].title, "Report");
  assert.equal(found.results[0].content, "Supplied extract");
  assert.equal(found.results[1].content.length, 1500);
});

test("the search deadline covers a hanging response body, aborts it and does not wait indefinitely", async () => {
  let signal;
  const started = Date.now();
  await assert.rejects(providers.searchTavily("Supplied report", { key: "synthetic-key", timeoutMs: 30,
    fetchImpl: async (_url, init) => { signal = init.signal; return { ok: true, status: 200, json: () => new Promise(() => {}) }; }
  }), { code: "PROVIDER_TIMEOUT" });
  assert.equal(signal.aborted, true);
  assert.ok(Date.now() - started < 1500);
});

test("the complete failover chain respects the request's overall deadline", async () => {
  const calls = [];
  const started = Date.now();
  await assert.rejects(providers.generate({ search: true, timeoutMs: 35, messages: [{ role: "user", text: "Report" }] }, {
    env: { TAVILY_API_KEY: "tvly-synthetic", BRAVE_API_KEY: "synthetic-brave" },
    fetchImpl: async (url) => { calls.push(new URL(url).hostname); return new Promise(() => {}); }
  }), { code: "PROVIDER_TIMEOUT" });
  assert.ok(Date.now() - started < 1500);
  assert.deepEqual(calls, ["api.tavily.com"], "do not start another provider after the total budget is exhausted");
});

test("provider echoes of real-format or unprefixed credentials are redacted from errors and health", async () => {
  const keys = { TAVILY_API_KEY: "unprefixed-private-synthetic-token", BRAVE_API_KEY: "brave-private-synthetic-token" };
  await assert.rejects(providers.generate({ search: true, messages: [{ role: "user", text: "Report" }] }, {
    env: keys, fetchImpl: async (url) => json(401, { error: { message: `Bad key ${String(url).includes("tavily") ? keys.TAVILY_API_KEY : keys.BRAVE_API_KEY}` } })
  }), (error) => {
    assert.doesNotMatch(error.message, /private-synthetic-token/);
    assert.match(error.message, /redacted/);
    return true;
  });
  assert.doesNotMatch(JSON.stringify(providers.providerHealth()), /private-synthetic-token/);
  assert.doesNotMatch(JSON.stringify(providers.describeProviders(keys)), /private-synthetic-token/);
});

test("Groq can be the primary writer, uses current completion parameters, and never leaks reasoning", async () => {
  const calls = [];
  const result = await providers.generate({ messages: [{ role: "user", text: "Explain this supplied report" }] }, {
    env: { GROQ_API_KEY: "gsk_synthetic", GEMINI_API_KEY: "synthetic-gemini", AI_WRITER_PROVIDER_ORDER: "groq,gemini" },
    fetchImpl: async (url, init) => {
      calls.push(new URL(url).hostname);
      const body = JSON.parse(init.body);
      assert.equal(body.max_tokens, undefined);
      assert.ok(body.max_completion_tokens > 1000);
      assert.equal(body.reasoning_effort, "low");
      return json(200, { model: body.model, choices: [{ message: { content: "<think>private chain</think>Supplied answer", reasoning: "hidden reasoning" }, finish_reason: "stop" }] });
    }
  });
  assert.equal(result.provider, "groq");
  assert.equal(result.fallback, false);
  assert.equal(result.text, "Supplied answer");
  assert.deepEqual(calls, ["api.groq.com"]);
});

test("Groq diagnostics reserve room for reasoning and distinguish an output limit from a rejected API key", async () => {
  const results = await providers.testModels({ env: { GROQ_API_KEY: "gsk_synthetic", GROQ_MODELS: "openai/gpt-oss-20b" }, fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.ok(body.max_completion_tokens >= 512, "64 tokens can be exhausted before GPT-OSS returns any answer");
    return json(200, { choices: [{ message: { content: "", reasoning: "private" }, finish_reason: "length" }] });
  } });
  assert.equal(results[0].code, "PROVIDER_OUTPUT_LIMIT");
  assert.doesNotMatch(JSON.stringify(results), /"private"/);
});

test("unselected search diagnostics do not consume Tavily or Brave requests", async () => {
  const calls = [];
  const results = await providers.testModels({ env: { GROQ_API_KEY: "gsk_synthetic", TAVILY_API_KEY: "tvly-synthetic", BRAVE_API_KEY: "synthetic-brave" }, search: false,
    fetchImpl: async (url) => { calls.push(new URL(url).hostname); return json(200, { choices: [{ message: { content: "Connected" } }] }); } });
  assert.ok(results.length > 0);
  assert.ok(calls.every(host => host === "api.groq.com"));
  const searches = await providers.testModels({ env: { TAVILY_API_KEY: "tvly-synthetic", BRAVE_API_KEY: "synthetic-brave" }, search: true,
    fetchImpl: async (url) => String(url).includes("tavily") ? json(200, { results: [page] }) : json(200, { web: { results: [page] } }) });
  assert.deepEqual(searches.map(r => [r.provider, r.ok, r.sources]), [["tavily", true, 1], ["brave", true, 1]]);
});

test("Gemini search diagnostics do not report healthy without returned source URLs", async () => {
  const results = await providers.testModels({ env: { GEMINI_API_KEY: "synthetic-gemini", GEMINI_MODELS: "writer", GEMINI_SEARCH_MODELS: "searcher" }, search: true,
    fetchImpl: async () => json(200, { candidates: [{ content: { parts: [{ text: "A reply without sources" }] } }] }) });
  assert.equal(results[0].ok, true, "writer connectivity can succeed independently");
  assert.equal(results[1].ok, false);
  assert.equal(results[1].code, "SEARCH_NO_RESULTS");
});

test("the real studio pipeline uses Tavily extracts, checks links and asks Groq to write exactly once", async () => {
  const calls = [];
  const result = await createStudio({ db: noDb, env: { GROQ_API_KEY: "gsk_synthetic", TAVILY_API_KEY: "tvly-synthetic" }, researchCache: false,
    verify: async (sources) => sources.map(s => ({ ...s, status: "reachable" })),
    fetchImpl: async (url, init) => {
      calls.push(new URL(url).hostname);
      if (String(url).includes("tavily")) return json(200, { results: [page] });
      const body = JSON.parse(init.body);
      assert.match(body.messages.at(-1).content, /Synthetic search extract/);
      assert.match(body.messages.at(-1).content, /WEB RESEARCH EXCERPTS \(tavily;/);
      assert.doesNotMatch(body.messages.at(-1).content, /LIVE WEB RESEARCH NOTES \(Google Search\)/);
      return json(200, { choices: [{ message: { content: `See [supplied report](${page.url}).` } }] });
    }
  }).run("chat", { text: "Explain the supplied synthetic report", options: { webSearch: true } });
  assert.equal(result.provider, "groq");
  assert.equal(result.meta.web_search, true);
  assert.deepEqual(result.meta.search_providers, ["tavily"]);
  assert.equal(result.meta.search_cached, false);
  assert.equal(Number.isNaN(Date.parse(result.meta.searched_at)), false);
  assert.equal(result.sources[0].url, page.url);
  assert.deepEqual(calls, ["api.tavily.com", "api.groq.com"]);
});

test("explicit non-web mode still works and never contacts a search engine", async () => {
  const calls = [];
  const result = await createStudio({ db: noDb, env: {}, researchCache: false, generate: async (request) => {
    calls.push(request.search ? "search" : "writer");
    return { text: "Answer from supplied material, not web-checked", provider: "groq", model: "test-writer" };
  } }).run("chat", { text: "Explain the supplied material", options: { webSearch: false } });
  assert.deepEqual(calls, ["writer"]);
  assert.equal(result.meta.web_search, false);
  assert.deepEqual(result.meta.search_providers, []);
});

test("case and authorised outside-research notes do not silently proceed when every search fails", async (t) => {
  for (const mode of ["case", "notes"]) await t.test(mode, async () => {
    const calls = [];
    const studio = createStudio({ db: noDb, env: {}, researchCache: false, generate: async (request) => {
      calls.push(request.search ? "search" : "writer");
      if (request.search) throw new providers.AiError(503, "Search unavailable.", "SEARCH_UNAVAILABLE");
      return { text: "Unsourced answer", provider: "groq", model: "writer" };
    } });
    await assert.rejects(studio.run(mode, { text: "A supplied synthetic study passage. ".repeat(12), options: { allowResearch: true } }), { code: "SEARCH_UNAVAILABLE" });
    assert.deepEqual(calls, ["search"]);
  });
});

function cachedStudio(scope, env, calls) {
  return createStudio({ db: noDb, env, researchCache: true, researchCacheScope: scope, verify: async sources => sources.map(s => ({ ...s, status: "reachable" })),
    generate: async (request) => {
      if (request.search) { calls.push("search"); return { text: page.content, sources: [page], searchProvider: "brave", searchedAt: "2026-11-19T10:00:00.000Z" }; }
      return { text: "Explanation from the supplied report", provider: "groq", model: "writer" };
    }
  });
}

test("fresh web retrieval is the default, even for repeated questions", async () => {
  const calls = [];
  const studio = cachedStudio("synthetic-a", {}, calls);
  const first = await studio.run("chat", { text: "Explain the supplied report" });
  const second = await studio.run("chat", { text: "Explain the supplied report" });
  assert.deepEqual(calls, ["search", "search"]);
  assert.equal(first.meta.search_cached, false);
  assert.equal(second.meta.search_cached, false);
});

test("opt-in research reuse is labelled with its original time and is isolated by account", async () => {
  const calls = [];
  const env = { AI_RESEARCH_CACHE_MINUTES: "10" };
  const a = cachedStudio("synthetic-a", env, calls);
  const b = cachedStudio("synthetic-b", env, calls);
  const first = await a.run("chat", { text: "Explain the supplied report" });
  const reused = await a.run("chat", { text: "Explain the supplied report" });
  const different = await b.run("chat", { text: "Explain the supplied report" });
  assert.equal(first.meta.search_cached, false);
  assert.equal(reused.meta.search_cached, true);
  assert.equal(reused.meta.searched_at, "2026-11-19T10:00:00.000Z");
  assert.deepEqual(reused.meta.search_providers, ["brave"]);
  assert.equal(different.meta.search_cached, false);
  assert.deepEqual(calls, ["search", "search"]);
});

test("Gemini grounding also bounds a stalled body within the total retrieval budget", async () => {
  let signal;
  const started = Date.now();
  await assert.rejects(providers.generate({ search: true, timeoutMs: 35, messages: [{ role: "user", text: "Supplied report" }] }, {
    env: { GEMINI_API_KEY: "synthetic-gemini", GEMINI_SEARCH_MODELS: "synthetic-search" },
    fetchImpl: async (_url, init) => { signal = init.signal; return { ok: true, json: () => new Promise(() => {}) }; }
  }), { code: "PROVIDER_TIMEOUT" });
  assert.equal(signal.aborted, true);
  assert.ok(Date.now() - started < 1500);
});

test("a malformed writer reply is a retryable provider error, not a reason to abandon fallback", async () => {
  const calls = [];
  const result = await providers.generate({ messages: [{ role: "user", text: "Supplied material" }] }, {
    env: { GEMINI_API_KEY: "synthetic-gemini", GEMINI_MODELS: "synthetic-writer", GROQ_API_KEY: "gsk_synthetic" },
    fetchImpl: async (url, init) => {
      calls.push(new URL(url).hostname);
      assert.equal(init.redirect, "error");
      return String(url).includes("googleapis") ? new Response("unreadable-json", { status: 200 })
        : json(200, { choices: [{ message: { content: "Answer from supplied material" } }] });
    }
  });
  assert.deepEqual(calls, ["generativelanguage.googleapis.com", "api.groq.com"]);
  assert.equal(result.provider, "groq");
  assert.equal(result.fallback, true);
  assert.equal(providers.providerHealth()[0].code, "PROVIDER_INVALID_RESPONSE");
});

test("Gemini grounding is a third independent retrieval option when Tavily fails and Brave has no usable results", async () => {
  const calls = [];
  const result = await providers.generate({ search: true, messages: [{ role: "user", text: "Supplied report" }] }, {
    env: { TAVILY_API_KEY: "tvly-synthetic", BRAVE_API_KEY: "synthetic-brave", GEMINI_API_KEY: "synthetic-gemini", GEMINI_SEARCH_MODELS: "synthetic-search", GROQ_API_KEY: "gsk_synthetic" },
    fetchImpl: async (url, init) => {
      calls.push(new URL(url).hostname);
      if (String(url).includes("tavily")) return json(503, { error: "Synthetic outage" });
      if (String(url).includes("brave")) return json(200, { web: { results: [] } });
      assert.match(String(url), /\/synthetic-search:generateContent$/);
      assert.deepEqual(JSON.parse(init.body).tools, [{ google_search: {} }]);
      return json(200, { candidates: [{ content: { parts: [{ text: "Extract from supplied source" }] }, groundingMetadata: { groundingChunks: [
        { web: { uri: page.url, title: page.title } }, { web: { uri: "http://127.0.0.1/", title: "Unsafe result" } }
      ] } }] });
    }
  });
  assert.deepEqual(calls, ["api.tavily.com", "api.search.brave.com", "generativelanguage.googleapis.com"]);
  assert.equal(result.searchProvider, "gemini");
  assert.deepEqual(result.sources, [{ url: page.url, title: page.title, origin: "google_search" }]);
  assert.equal(providers.providerHealth().some(row => row.model === "brave"), false, "no results is query-specific, not a cooldown-worthy outage");
});

test("multi-case research retains an explicit partial-failure warning and truthful provenance", async () => {
  let writers = 0;
  const studio = createStudio({ db: noDb, env: {}, researchCache: false,
    verify: async sources => sources.map(s => ({ ...s, status: "reachable" })),
    generate: async request => {
      if (request.json) return { text: JSON.stringify({ cases: [{ name: "Synthetic Alpha v Beta" }, { name: "Synthetic Missing v Report" }] }) };
      if (request.search) {
        if (request.searchQuery.includes("Missing")) throw new providers.AiError(404, "No supplied result", "SEARCH_NO_RESULTS");
        return { text: page.content, sources: [page], searchProvider: "tavily", searchedAt: "2026-11-19T10:00:00.000Z" };
      }
      writers += 1;
      assert.match(request.messages.at(-1).text, /Synthetic Missing v Report[\s\S]*UNVERIFIED/);
      return { text: "Only the supplied Alpha source was found; the other case is unverified.", provider: "groq", model: "synthetic-writer" };
    }
  });
  const result = await studio.run("case", { text: "Analyse the supplied synthetic authorities", attachments: [{ name: "supplied.txt", mimeType: "text/plain", data: "U3VwcGxpZWQ=" }] });
  assert.equal(writers, 1);
  assert.equal(result.meta.web_search, true);
  assert.equal(result.meta.search_partial, true);
  assert.equal(result.meta.search_cached, false);
  assert.deepEqual(result.meta.search_providers, ["tavily"]);
  assert.equal(result.meta.searched_at, "2026-11-19T10:00:00.000Z");
});
