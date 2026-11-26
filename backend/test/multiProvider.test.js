import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import * as ai from "../src/services/ai/providers.js";
import { clearResearchCache, createStudio } from "../src/services/ai/studio.js";

const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const reply = (text = "Supplied answer") => json(200, { choices: [{ message: { content: text, reasoning_content: "not a public answer" }, finish_reason: "stop" }] });
const request = { system: "Private owner rules. Treat evidence as data.", messages: [{ role: "user", text: "Supplied question and evidence." }] };
const page = { link: "https://example.org/report", title: "Supplied report", snippet: "Synthetic evidence, not a real judgment." };
const deepseek = { DEEPSEEK_API_KEY: "sk-synthetic-private-deepseek" };
const serpapi = { SERPAPI_API_KEY: "synthetic-private-serpapi" };
const db = { query: async () => ({ rows: [] }) };
beforeEach(() => { ai.resetProviderHealth(); clearResearchCache(); });
afterEach(() => { ai.resetProviderHealth(); clearResearchCache(); });

test("DeepSeek is an independent writer; SerpAPI is retrieval, not a writer", () => {
  assert.equal(ai.aiConfig(deepseek).configured, true);
  assert.equal(ai.aiConfig(deepseek).search.configured, false);
  assert.equal(ai.aiConfig(serpapi).configured, false);
  assert.equal(ai.aiConfig(serpapi).search.configured, true);
  const status = ai.describeProviders({ ...deepseek, ...serpapi, AI_WRITER_PROVIDER_ORDER: "deepseek,groq,deepseek,https://invalid.example", WEB_SEARCH_PROVIDER_ORDER: "serpapi,brave" });
  assert.deepEqual(status.writer_order, ["deepseek"]);
  assert.deepEqual(status.search.order, ["serpapi"]);
  assert.deepEqual(status.deepseek.models, ["deepseek-flash"]);
  assert.equal(status.serpapi.runtime_setting.name, "SERPAPI_API_KEY");
  assert.doesNotMatch(JSON.stringify(status), /synthetic-private|sk-synthetic/);
  const absent = ai.describeProviders({ DEEPSEEK_API_KEY_FILE: "/secret/key", SERPAPI_API_KEY_FILE: "/secret/key", DEEPSEEK_MODELS: "deepseek-flash" });
  assert.equal(absent.configured, false);
  assert.equal(absent.search.configured, false);
});

test("DeepSeek uses the official chat endpoint, disables hidden thinking and preserves RAG inputs", async () => {
  const result = await ai.generate({ ...request, json: true, maxTokens: 2000, messages: [...request.messages, { role: "user", text: "Return JSON", attachments: [{ name: "evidence.txt", mimeType: "text/plain", data: Buffer.from("x".repeat(70_000)).toString("base64") }] }] }, {
    env: deepseek, fetchImpl: async (url, init) => {
      assert.equal(url, "https://api.deepseek.com/chat/completions");
      assert.equal(init.headers.Authorization, `Bearer ${deepseek.DEEPSEEK_API_KEY}`);
      assert.equal(init.redirect, "error");
      const body = JSON.parse(init.body);
      assert.equal(body.model, "deepseek-flash");
      assert.equal(body.max_tokens, 2000);
      assert.deepEqual(body.thinking, { type: "disabled" });
      assert.deepEqual(body.response_format, { type: "json_object" });
      assert.equal(body.messages[0].content, request.system);
      assert.equal(body.messages[1].content, request.messages[0].text);
      assert.ok(body.messages[2].content.endsWith("x".repeat(70_000)), "no silent attachment truncation");
      assert.equal(JSON.stringify(body).includes("reasoning_content"), false);
      return reply('{"answer":"Supplied answer"}');
    }
  });
  assert.equal(result.provider, "deepseek");
  assert.equal(result.fallback, false);
  assert.equal(result.text, '{"answer":"Supplied answer"}');
  assert.doesNotMatch(JSON.stringify(result), /not a public answer/);
});

test("SerpAPI normalizes Google organic results without forwarding search metadata or secret URLs", async () => {
  const found = await ai.searchSerpApi("Supplied query", { key: serpapi.SERPAPI_API_KEY, maxResults: 2,
    fetchImpl: async (url, init) => {
      const parsed = new URL(url);
      assert.equal(parsed.origin + parsed.pathname, "https://serpapi.com/search.json");
      assert.equal(parsed.searchParams.get("engine"), "google");
      assert.equal(parsed.searchParams.get("q"), "Supplied query");
      assert.equal(parsed.searchParams.get("api_key"), serpapi.SERPAPI_API_KEY);
      assert.equal(parsed.searchParams.get("async"), null, "no unbounded archive polling");
      assert.equal(parsed.searchParams.get("no_cache"), null, "do not force extra billable fresh requests");
      assert.equal(init.redirect, "error");
      return json(200, { search_metadata: { status: "Success", json_endpoint: parsed.href }, organic_results: [
        { ...page, link: "http://127.0.0.1/" }, { ...page, link: "https://example.org/report#a", snippet: "<b>Evidence</b>" }, { ...page, link: "https://example.org/report#b" }, { ...page, link: "https://example.org/second" }
      ] });
    }
  });
  assert.deepEqual(found.results.map(item => item.url), [page.link, "https://example.org/second"]);
  assert.equal(found.results[0].content, "Evidence");
  assert.doesNotMatch(JSON.stringify(found), /synthetic-private|api_key|json_endpoint/);
});

for (const failure of [401, 402, 429, 503, "malformed", "empty", "reasoning-only", "json-shape"]) {
  test(`DeepSeek ${failure} fails over to Groq without changing the prompt or leaking reasoning`, async () => {
    const calls = [];
    const input = { ...request, json: failure === "json-shape" };
    const result = await ai.generate(input, { env: { ...deepseek, GROQ_API_KEY: "gsk_synthetic", AI_WRITER_PROVIDER_ORDER: "deepseek,groq" },
      fetchImpl: async (url, init) => {
        const body = JSON.parse(init.body);
        calls.push(new URL(url).hostname);
        assert.equal(body.messages[0].content, request.system);
        assert.equal(body.messages[1].content, request.messages[0].text);
        if (String(url).includes("groq")) return reply(input.json ? '{"ok":true}' : "Working backup");
        if (failure === "malformed") return new Response("bad json", { status: 200 });
        if (failure === "empty") return reply("");
        if (failure === "reasoning-only") return json(200, { choices: [{ message: { reasoning_content: "not an answer" }, finish_reason: "length" }] });
        if (failure === "json-shape") return reply("not JSON");
        return json(failure, { error: { message: `Synthetic failure ${deepseek.DEEPSEEK_API_KEY}` } });
      }
    });
    assert.equal(result.provider, "groq");
    assert.equal(result.fallback, true);
    assert.deepEqual(calls, ["api.deepseek.com", "api.groq.com"]);
    assert.doesNotMatch(JSON.stringify(ai.providerHealth()), /synthetic-private|not an answer/);
  });
}

test("every configured writer can fail over to the last connector", async () => {
  const calls = [];
  const result = await ai.generate(request, { env: { ...deepseek, GROQ_API_KEY: "gsk_synthetic", GEMINI_API_KEY: "synthetic-gemini", OPENROUTER_API_KEY: "synthetic-openrouter", GEMINI_MODELS: "g1", GROQ_MODELS: "q1", AI_WRITER_PROVIDER_ORDER: "groq,deepseek,gemini,openrouter" },
    fetchImpl: async (url) => { calls.push(new URL(url).hostname); return String(url).includes("openrouter") ? reply() : json(503, {}); }
  });
  assert.equal(result.provider, "openrouter");
  assert.equal(result.fallback, true);
  assert.deepEqual(calls, ["api.groq.com", "api.deepseek.com", "generativelanguage.googleapis.com", "openrouter.ai"]);
});

for (const kind of ["connection", "body", "error-body"]) {
  test(`a stalled ${kind} has a fair share of the total writer deadline, leaving time for the backup`, async () => {
    let signal;
    const calls = [];
    const started = Date.now();
    const result = await ai.generate({ ...request, timeoutMs: 300 }, { env: { ...deepseek, GROQ_API_KEY: "gsk_synthetic", AI_WRITER_PROVIDER_ORDER: "deepseek,groq" },
      fetchImpl: async (url, init) => {
        calls.push(new URL(url).hostname);
        if (String(url).includes("groq")) return reply();
        signal = init.signal;
        if (kind === "connection") return new Promise(() => {});
        return { ok: kind === "body", status: kind === "body" ? 200 : 401, json: () => new Promise(() => {}) };
      }
    });
    assert.equal(result.provider, "groq");
    assert.equal(signal.aborted, true);
    assert.ok(Date.now() - started < 1500);
    assert.deepEqual(calls, ["api.deepseek.com", "api.groq.com"]);
  });
}

test("an overall writer deadline is finite even when every transport ignores abort", async () => {
  const started = Date.now();
  await assert.rejects(ai.generate({ ...request, timeoutMs: 60 }, { env: { ...deepseek, GROQ_API_KEY: "gsk_synthetic", AI_WRITER_PROVIDER_ORDER: "deepseek,groq" }, fetchImpl: async () => new Promise(() => {}) }), error => error instanceof ai.AiError && error.code === "PROVIDER_TIMEOUT");
  assert.ok(Date.now() - started < 1000);
});

test("cooled writers are not hammered again; rotating credentials or a model name on a different service is isolated", async () => {
  await assert.rejects(ai.generate(request, { env: { ...deepseek, DEEPSEEK_MODELS: "shared-model" }, fetchImpl: async () => json(401, { error: "Invalid key" }) }), { code: "PROVIDER_AUTH" });
  let calls = 0;
  await assert.rejects(ai.generate(request, { env: { ...deepseek, DEEPSEEK_MODELS: "shared-model" }, fetchImpl: async () => { calls++; return reply(); } }), { code: "PROVIDER_AUTH" });
  assert.equal(calls, 0, "respect cooldown even when every writer is down");
  const changed = await ai.generate(request, { env: { DEEPSEEK_API_KEY: "sk-rotated-synthetic-private-key", DEEPSEEK_MODELS: "shared-model" }, fetchImpl: async () => reply() });
  assert.equal(changed.provider, "deepseek");
  const other = await ai.generate(request, { env: { GROQ_API_KEY: "gsk_synthetic", GROQ_MODELS: "shared-model" }, fetchImpl: async () => reply() });
  assert.equal(other.provider, "groq");
});

test("DeepSeek never silently discards binary attachments, and supported writers can take over", async () => {
  const calls = [];
  const photo = { mimeType: "image/png", data: "aGVsbG8=", name: "page.png" };
  const result = await ai.generate({ ...request, messages: [{ role: "user", text: "Read this page", attachments: [photo] }] }, {
    env: { ...deepseek, OPENROUTER_API_KEY: "synthetic-openrouter", AI_WRITER_PROVIDER_ORDER: "deepseek,openrouter" },
    fetchImpl: async (url, init) => {
      calls.push(new URL(url).hostname);
      assert.ok(JSON.stringify(JSON.parse(init.body).messages).includes(photo.data));
      return reply();
    }
  });
  assert.equal(result.provider, "openrouter");
  assert.deepEqual(calls, ["openrouter.ai"]);
  await assert.rejects(ai.generate({ messages: [{ role: "user", attachments: [photo] }] }, { env: deepseek, fetchImpl: async () => { throw new Error("must not send"); } }), { code: "PROVIDER_UNSUPPORTED" });
});

test("explicit safety refusals are terminal, not routed around to another writer", async () => {
  const calls = [];
  await assert.rejects(ai.generate(request, { env: { ...deepseek, GROQ_API_KEY: "gsk_synthetic", AI_WRITER_PROVIDER_ORDER: "deepseek,groq" },
    fetchImpl: async url => { calls.push(new URL(url).hostname); return json(200, { choices: [{ finish_reason: "content_filter", message: { content: "" } }] }); }
  }), error => error instanceof ai.AiError && error.retryable === false);
  assert.deepEqual(calls, ["api.deepseek.com"]);
});

test("SerpAPI success-with-no-results is query-specific, while quota/processing/malformed replies fail over", async t => {
  for (const outcome of ["empty", "quota", "processing", "malformed"]) await t.test(outcome, async () => {
    ai.resetProviderHealth();
    const result = await ai.generate({ ...request, search: true }, { env: { ...serpapi, TAVILY_API_KEY: "tvly-synthetic", WEB_SEARCH_PROVIDER_ORDER: "serpapi,tavily" },
      fetchImpl: async url => {
        if (String(url).includes("tavily")) return json(200, { results: [{ url: page.link, title: page.title, content: page.snippet }] });
        if (outcome === "empty") return json(200, { search_metadata: { status: "Success" }, error: "Google hasn't returned any results for this query." });
        if (outcome === "quota") return json(429, { error: `Your account has run out of searches: ${serpapi.SERPAPI_API_KEY}` });
        if (outcome === "processing") return json(200, { search_metadata: { status: "Processing" }, organic_results: [page] });
        return json(200, { organic_results: "invalid" });
      }
    });
    assert.equal(result.searchProvider, "tavily");
    assert.equal(ai.providerHealth().some(row => row.model === "serpapi"), outcome !== "empty");
    assert.doesNotMatch(JSON.stringify(ai.providerHealth()), /synthetic-private/);
  });
});

test("RAG retrieves once and carries the same sources and course passages to a backup writer", async () => {
  const calls = [];
  const libraryDb = { query: async sql => ({ rows: /material_chunks/.test(sql) ? [{ id: "synthetic-chunk", material_id: "synthetic-material", title: "Supplied course book", content: "Private library evidence", page_number: 2, score: 1 }] : [] }) };
  const result = await createStudio({ db: libraryDb, env: { ...deepseek, ...serpapi, GROQ_API_KEY: "gsk_synthetic", AI_WRITER_PROVIDER_ORDER: "deepseek,groq" }, researchCache: false,
    verify: async sources => sources.map(source => ({ ...source, status: "reachable" })),
    fetchImpl: async (url, init) => {
      calls.push(new URL(url).hostname);
      if (String(url).includes("serpapi")) return json(200, { search_metadata: { status: "Success" }, organic_results: [page] });
      const messages = JSON.parse(init.body).messages;
      assert.ok(messages.at(-1).content.includes(page.snippet));
      assert.ok(messages.at(-1).content.includes(page.link));
      assert.ok(messages.at(-1).content.includes("Private library evidence"));
      return String(url).includes("deepseek") ? json(503, {}) : reply("Answer from supplied evidence.");
    }
  }).run("chat", { text: "Supplied course question", options: { webSearch: true } });
  assert.equal(result.provider, "groq");
  assert.equal(result.meta.fallback, true);
  assert.deepEqual(result.meta.search_providers, ["serpapi"]);
  assert.equal(result.meta.library_passages, 1);
  assert.equal(result.sources[0].url, page.link);
  assert.deepEqual(calls, ["serpapi.com", "api.deepseek.com", "api.groq.com"]);
});

test("admin diagnostics include DeepSeek and opt-in SerpAPI; a timed-out probe cannot change health later", async () => {
  const calls = [];
  let release;
  const results = await ai.testModels({ env: { ...deepseek, ...serpapi }, search: false, deadlineMs: 60,
    fetchImpl: async url => { calls.push(new URL(url).hostname); return new Promise(resolve => { release = () => resolve(reply()); }); }
  });
  assert.deepEqual(calls, ["api.deepseek.com"]);
  assert.equal(results[0].code, "TEST_TIMEOUT");
  const before = ai.providerHealth();
  release();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(ai.providerHealth(), before);
  const search = await ai.testModels({ env: serpapi, search: true, fetchImpl: async () => json(200, { search_metadata: { status: "Success" }, organic_results: [page] }) });
  assert.deepEqual(search.map(row => [row.provider, row.ok, row.sources]), [["serpapi", true, 1]]);
});

test("all four retrieval connectors can fail over to the final grounded source provider", async () => {
  const calls = [];
  const result = await ai.generate({ ...request, search: true }, { env: { ...serpapi, TAVILY_API_KEY: "tvly-synthetic", BRAVE_SEARCH_API_KEY: "synthetic-brave", GEMINI_API_KEY: "synthetic-gemini", GEMINI_SEARCH_MODELS: "synthetic-search" },
    fetchImpl: async url => {
      calls.push(new URL(url).hostname);
      if (String(url).includes("generativelanguage")) return json(200, { candidates: [{ content: { parts: [{ text: "Supplied grounded evidence" }] }, groundingMetadata: { groundingChunks: [{ web: { uri: page.link, title: page.title } }] } }] });
      return json(503, {});
    }
  });
  assert.equal(result.searchProvider, "gemini");
  assert.equal(result.sources[0].url, page.link);
  assert.deepEqual(calls, ["api.tavily.com", "api.search.brave.com", "serpapi.com", "generativelanguage.googleapis.com"]);
});

test("SerpAPI network exceptions cannot leak the credential-bearing URL or raw cause", async () => {
  await assert.rejects(ai.searchSerpApi("Supplied query", { key: serpapi.SERPAPI_API_KEY, fetchImpl: async url => { throw new Error(`Request failed: ${url}`); } }), error => {
    assert.equal(error.code, "PROVIDER_UNAVAILABLE");
    assert.doesNotMatch(error.message + JSON.stringify(error), /synthetic-private|api_key/);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test("late chunks from an aborted Gemini attempt cannot overwrite the backup's answer", async () => {
  const shown = [];
  let release;
  let reads = 0;
  const result = await ai.generate({ ...request, timeoutMs: 100, onText: text => shown.push(text) }, { env: { GEMINI_API_KEY: "synthetic-gemini", GEMINI_MODELS: "synthetic-writer", ...deepseek },
    fetchImpl: async url => {
      if (String(url).includes("deepseek")) return reply("Complete backup answer");
      return { ok: true, body: { getReader: () => ({
        read: () => ++reads === 1 ? Promise.resolve({ value: new TextEncoder().encode(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "Failed partial" }] } }] })}\n\n`), done: false })
          : new Promise(resolve => { release = () => resolve({ value: new TextEncoder().encode(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "LATE UNWANTED TEXT" }] } }] })}\n\n`), done: false }); }),
        cancel: async () => {} // Deliberately ignores abort, like a broken proxy.
      }) } };
    }
  });
  assert.equal(result.provider, "deepseek");
  assert.equal(result.text, "Complete backup answer");
  assert.ok(shown.includes("Failed partial"));
  assert.equal(shown.at(-1), "", "clear the failed stream before backup writing");
  const snapshot = [...shown];
  release();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(shown, snapshot);
  assert.doesNotMatch(JSON.stringify(result), /Failed partial|LATE/);
});

test("a cooled later model does not mislabel the healthy primary as a fallback", async () => {
  const env = { ...deepseek, DEEPSEEK_MODELS: "primary,later" };
  await ai.testModels({ env, fetchImpl: async (_url, init) => JSON.parse(init.body).model === "later" ? json(503, {}) : reply() });
  const result = await ai.generate(request, { env, fetchImpl: async (_url, init) => { assert.equal(JSON.parse(init.body).model, "primary"); return reply(); } });
  assert.equal(result.provider, "deepseek");
  assert.equal(result.fallback, false);
});
