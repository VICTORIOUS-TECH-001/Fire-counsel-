// AI provider layer: Google Gemini first, OpenRouter (free models) as fallback.
// API keys are read from server environment variables only (set in Render).
// Nothing here is ever sent to the browser.

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// Free-tier friendly defaults (Gemini API pricing page, November 2026):
// - the writer models are free for input/output but cannot use Google Search
//   on the free tier;
// - gemini-2.5-flash-lite still includes Google Search grounding on the free
//   tier (shared daily limit), so it is the default "researcher".
export const DEFAULT_GEMINI_MODELS = ["gemini-3.8-flash", "gemini-4-hydrogen", "gemini-3.6-flash", "gemini-3.5-flash-lite"];
export const DEFAULT_GEMINI_SEARCH_MODELS = ["gemini-2.5-flash-lite"];
export const DEFAULT_OPENROUTER_MODELS = ["openrouter/free"];

export class AiError extends Error {
  constructor(status, message, code, { retryable = false, cause } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    if (cause) this.cause = cause;
  }
}

const list = (value, fallback) => {
  const items = String(value || "").split(",").map((item) => item.trim()).filter((item) => /^[\w./:-]{1,120}$/.test(item));
  return items.length ? items : fallback;
};

export function aiConfig(env = process.env) {
  const geminiKey = (env.GEMINI_API_KEY || "").trim();
  const openrouterKey = (env.OPENROUTER_API_KEY || "").trim();
  return {
    gemini: { configured: Boolean(geminiKey), key: geminiKey, models: list(env.GEMINI_MODELS, DEFAULT_GEMINI_MODELS), searchModels: list(env.GEMINI_SEARCH_MODELS, DEFAULT_GEMINI_SEARCH_MODELS) },
    openrouter: { configured: Boolean(openrouterKey), key: openrouterKey, models: list(env.OPENROUTER_MODELS, DEFAULT_OPENROUTER_MODELS), referer: env.RENDER_EXTERNAL_URL || (env.PUBLIC_HOST ? `https://${env.PUBLIC_HOST}` : "https://fire-counsel.onrender.com") },
    timeoutMs: Math.min(Math.max(Number(env.AI_TIMEOUT_MS) || 240_000, 10_000), 600_000),
    streamIdleMs: Math.min(Math.max(Number(env.AI_STREAM_IDLE_MS) || 60_000, 5_000), 300_000),
    configured: Boolean(geminiKey || openrouterKey)
  };
}

// Public, secret-free description for the admin status panel.
export function describeProviders(env = process.env) {
  const config = aiConfig(env);
  return {
    configured: config.configured,
    gemini: { configured: config.gemini.configured, models: config.gemini.models, search_models: config.gemini.searchModels },
    openrouter: { configured: config.openrouter.configured, models: config.openrouter.models }
  };
}

function geminiParts(text, attachments = []) {
  const parts = [];
  for (const file of attachments) parts.push({ inline_data: { mime_type: file.mimeType, data: file.data } });
  if (text) parts.push({ text });
  return parts.length ? parts : [{ text: "(empty)" }];
}

function geminiBody({ system, messages, search, json, maxTokens, temperature }) {
  const contents = messages.map((message) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: geminiParts(message.text, message.attachments)
  }));
  const body = {
    contents,
    generationConfig: { temperature: temperature ?? 0.3, maxOutputTokens: maxTokens || 8192 }
  };
  if (system) body.system_instruction = { parts: [{ text: system }] };
  if (search) body.tools = [{ google_search: {} }];
  if (json && !search) body.generationConfig.responseMimeType = "application/json";
  return body;
}

function classifyHttp(status, detail, provider) {
  if (status === 429) return new AiError(429, `${provider} rate limit or free quota reached.`, "PROVIDER_QUOTA", { retryable: true });
  if (status === 401 || status === 403) return new AiError(502, `${provider} rejected the API key. Check the key in Render.`, "PROVIDER_AUTH", { retryable: true });
  if (status === 404) return new AiError(502, `${provider} model not available.`, "MODEL_UNAVAILABLE", { retryable: true });
  if (status >= 500) return new AiError(502, `${provider} is temporarily unavailable.`, "PROVIDER_UNAVAILABLE", { retryable: true });
  return new AiError(502, `${provider} could not process the request${detail ? `: ${detail}` : "."}`, "PROVIDER_REJECTED", { retryable: status === 400 });
}

async function readError(response) {
  try {
    const data = await response.json();
    return String(data?.error?.message || data?.message || "").slice(0, 240);
  } catch {
    return "";
  }
}

function geminiResult(model, data, text, candidate) {
  const grounding = candidate?.groundingMetadata || {};
  const sources = (grounding.groundingChunks || [])
    .map((chunk) => chunk?.web)
    .filter((web) => web && typeof web.uri === "string")
    .map((web) => ({ url: web.uri, title: String(web.title || "").slice(0, 300), origin: "google_search" }));
  return {
    text,
    sources,
    searchQueries: (grounding.webSearchQueries || []).filter((q) => typeof q === "string").slice(0, 30),
    provider: "gemini",
    model: data?.modelVersion || model,
    truncated: candidate?.finishReason === "MAX_TOKENS"
  };
}

/**
 * Streams the answer as it is written (Server-Sent Events) and reports the
 * text so far through request.onText. Instead of one fixed time limit, the
 * model must start within timeoutMs and then never go silent for idleMs —
 * a slow but steady long answer is not cut off, a stuck one fails fast.
 */
async function streamGemini(model, request, { key, fetchImpl, timeoutMs, idleMs }) {
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(new DOMException("first token timeout", "TimeoutError")), timeoutMs);
  const keepAlive = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(new DOMException("stream idle", "TimeoutError")), idleMs); };
  let text = "";
  let last = null;
  let lastCandidate = null;
  try {
    let response;
    try {
      response = await fetchImpl(`${GEMINI_BASE}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(geminiBody(request)),
        signal: controller.signal
      });
    } catch (error) {
      throw new AiError(504, "Gemini did not respond in time.", "PROVIDER_TIMEOUT", { retryable: true, cause: error });
    }
    if (!response.ok) throw classifyHttp(response.status, await readError(response), "Gemini");
    if (!response.body?.getReader) {
      // Some proxies return the whole reply at once.
      const raw = await response.text();
      const events = raw.split(/\n/).filter((line) => line.startsWith("data:")).map((line) => { try { return JSON.parse(line.slice(5)); } catch { return null; } }).filter(Boolean);
      for (const data of events) {
        last = data;
        lastCandidate = data?.candidates?.[0] || lastCandidate;
        text += (data?.candidates?.[0]?.content?.parts || []).filter((part) => typeof part.text === "string" && !part.thought).map((part) => part.text).join("");
      }
    } else {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          keepAlive();
          buffer += decoder.decode(value, { stream: true });
          let cut;
          while ((cut = buffer.search(/\r?\n\r?\n/)) >= 0) {
            const event = buffer.slice(0, cut);
            buffer = buffer.slice(cut).replace(/^\r?\n\r?\n/, "");
            const payload = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
            if (!payload || payload === "[DONE]") continue;
            let data;
            try { data = JSON.parse(payload); } catch { continue; }
            last = data;
            const candidate = data?.candidates?.[0];
            if (candidate) lastCandidate = { ...lastCandidate, ...candidate, groundingMetadata: candidate.groundingMetadata || lastCandidate?.groundingMetadata };
            const piece = (candidate?.content?.parts || []).filter((part) => typeof part.text === "string" && !part.thought).map((part) => part.text).join("");
            if (piece) {
              text += piece;
              try { request.onText(text); } catch { /* progress display only */ }
            }
          }
        }
      } catch (error) {
        throw new AiError(504, text ? "Gemini stopped in the middle of the answer." : "Gemini did not respond in time.", "PROVIDER_TIMEOUT", { retryable: true, cause: error });
      }
    }
  } finally {
    clearTimeout(timer);
  }
  if (!lastCandidate) {
    const reason = last?.promptFeedback?.blockReason;
    throw new AiError(422, reason ? `Gemini declined this request (${reason}).` : "Gemini returned no answer.", "PROVIDER_EMPTY", { retryable: !reason });
  }
  text = text.trim();
  if (!text) {
    throw new AiError(422, lastCandidate.finishReason === "SAFETY" ? "Gemini declined this request for safety reasons." : "Gemini returned an empty answer.", "PROVIDER_EMPTY", { retryable: lastCandidate.finishReason !== "SAFETY" });
  }
  return geminiResult(model, last, text, lastCandidate);
}

export async function callGemini(model, request, { key, fetchImpl = fetch, timeoutMs = 240_000, idleMs = 60_000 }) {
  if (typeof request.onText === "function" && !request.json) return streamGemini(model, request, { key, fetchImpl, timeoutMs, idleMs });
  let response;
  try {
    response = await fetchImpl(`${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(geminiBody(request)),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    throw new AiError(504, "Gemini did not respond in time.", "PROVIDER_TIMEOUT", { retryable: true, cause: error });
  }
  if (!response.ok) throw classifyHttp(response.status, await readError(response), "Gemini");
  const data = await response.json();
  const candidate = data?.candidates?.[0];
  if (!candidate) {
    const reason = data?.promptFeedback?.blockReason;
    throw new AiError(422, reason ? `Gemini declined this request (${reason}).` : "Gemini returned no answer.", "PROVIDER_EMPTY", { retryable: !reason });
  }
  const text = (candidate.content?.parts || []).filter((part) => typeof part.text === "string" && !part.thought).map((part) => part.text).join("").trim();
  if (!text) {
    throw new AiError(422, candidate.finishReason === "SAFETY" ? "Gemini declined this request for safety reasons." : "Gemini returned an empty answer.", "PROVIDER_EMPTY", { retryable: candidate.finishReason !== "SAFETY" });
  }
  return geminiResult(model, data, text, candidate);
}

function openRouterContent(text, attachments = []) {
  if (!attachments.length) return text || "(empty)";
  const content = [];
  if (text) content.push({ type: "text", text });
  for (const file of attachments) {
    const dataUrl = `data:${file.mimeType};base64,${file.data}`;
    if (file.mimeType.startsWith("image/")) content.push({ type: "image_url", image_url: { url: dataUrl } });
    else if (file.mimeType === "application/pdf") content.push({ type: "file", file: { filename: file.name || "document.pdf", file_data: dataUrl } });
    else if (file.mimeType === "text/plain") content.push({ type: "text", text: Buffer.from(file.data, "base64").toString("utf8").slice(0, 200_000) });
  }
  return content;
}

export async function callOpenRouter(request, { key, models, referer, fetchImpl = fetch, timeoutMs = 240_000 }) {
  const messages = [];
  if (request.system) messages.push({ role: "system", content: request.system });
  for (const message of request.messages) {
    messages.push({ role: message.role === "assistant" ? "assistant" : "user", content: openRouterContent(message.text, message.attachments) });
  }
  const body = { messages, max_tokens: request.maxTokens || 8192, temperature: request.temperature ?? 0.3 };
  if (models.length > 1) body.models = models.slice(0, 3);
  else body.model = models[0];
  if (request.messages.some((m) => m.attachments?.some((f) => f.mimeType === "application/pdf"))) {
    body.plugins = [{ id: "file-parser", pdf: { engine: "pdf-text" } }];
  }
  if (request.json) body.response_format = { type: "json_object" };
  let response;
  try {
    response = await fetchImpl(OPENROUTER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "HTTP-Referer": referer, "X-Title": "FIRE COUNSEL" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    throw new AiError(504, "The backup AI did not respond in time.", "PROVIDER_TIMEOUT", { retryable: true, cause: error });
  }
  if (!response.ok) throw classifyHttp(response.status, await readError(response), "OpenRouter");
  const data = await response.json();
  const raw = data?.choices?.[0]?.message?.content;
  const text = (Array.isArray(raw) ? raw.map((part) => part?.text || "").join("") : String(raw || "")).trim();
  if (!text) throw new AiError(422, "The backup AI returned an empty answer.", "PROVIDER_EMPTY", { retryable: true });
  return { text, sources: [], searchQueries: [], provider: "openrouter", model: String(data.model || models[0]), truncated: data?.choices?.[0]?.finish_reason === "length" };
}

// ------------------------------------------------------------ model health
// A model that is missing (404), rate-limited or hanging is skipped for a
// while, so the next student does not wait for it again. When every model is
// marked unhealthy they are all tried anyway (never refuse outright).
const SKIP_MS = { MODEL_UNAVAILABLE: 30 * 60_000, PROVIDER_TIMEOUT: 5 * 60_000, PROVIDER_QUOTA: 2 * 60_000, PROVIDER_UNAVAILABLE: 60_000 };
const unhealthy = new Map();

function markModel(model, error, now = Date.now()) {
  const ms = SKIP_MS[error?.code];
  if (ms) unhealthy.set(model, { until: now + ms, code: error.code, message: error.message });
}

function orderModels(models, now = Date.now()) {
  const healthy = models.filter((model) => !(unhealthy.get(model)?.until > now));
  return healthy.length ? healthy : models;
}

export function providerHealth(now = Date.now()) {
  return [...unhealthy.entries()].filter(([, info]) => info.until > now)
    .map(([model, info]) => ({ model, code: info.code, message: info.message, retry_in_seconds: Math.ceil((info.until - now) / 1000) }));
}

export function resetProviderHealth() { unhealthy.clear(); }

/**
 * Generate text. `search: true` uses a Gemini model with Google Search
 * grounding (no fallback: other providers cannot produce verified sources).
 * Otherwise Gemini writer models are tried in order, then OpenRouter.
 */
export async function generate(request, { env = process.env, fetchImpl = fetch } = {}) {
  const config = aiConfig(env);
  if (!config.configured) throw new AiError(503, "No AI provider key is configured on the server.", "AI_NOT_CONFIGURED");
  const errors = [];
  if (config.gemini.configured) {
    const models = orderModels(request.search ? config.gemini.searchModels : config.gemini.models);
    for (const model of models) {
      try {
        if (typeof request.onText === "function") { try { request.onText(""); } catch { /* display only */ } }
        const result = await callGemini(model, request, { key: config.gemini.key, fetchImpl, timeoutMs: request.timeoutMs || config.timeoutMs, idleMs: config.streamIdleMs });
        unhealthy.delete(model);
        return result;
      } catch (error) {
        errors.push(error);
        markModel(model, error);
        if (!(error instanceof AiError) || !error.retryable) throw error;
      }
    }
  }
  if (request.search) {
    throw errors[errors.length - 1] || new AiError(503, "Live web search needs a Gemini key.", "SEARCH_NOT_CONFIGURED");
  }
  if (config.openrouter.configured) {
    try {
      const result = await callOpenRouter(request, { key: config.openrouter.key, models: config.openrouter.models, referer: config.openrouter.referer, fetchImpl, timeoutMs: request.timeoutMs || config.timeoutMs });
      return { ...result, fallback: true };
    } catch (error) {
      errors.push(error);
    }
  }
  const last = errors[errors.length - 1];
  throw last instanceof AiError ? last : new AiError(503, "All AI providers are unavailable right now. Please try again shortly.", "PROVIDERS_UNAVAILABLE");
}

/**
 * Admin diagnostics: asks every configured model for a one-line reply, one by
 * one, and reports which work and how long each took.
 */
export async function testModels({ env = process.env, fetchImpl = fetch, search = false, timeoutMs = 30_000 } = {}) {
  const config = aiConfig(env);
  const ask = { messages: [{ role: "user", text: "Reply with exactly this sentence: FIRE COUNSEL AI is connected." }], maxTokens: 64, temperature: 0 };
  const results = [];
  const run = async (provider, model, role, call) => {
    const started = Date.now();
    try {
      const reply = await call();
      unhealthy.delete(model);
      results.push({ provider, model: reply.model || model, role, ok: true, ms: Date.now() - started, reply: reply.text.slice(0, 120), sources: reply.sources?.length || 0 });
    } catch (error) {
      markModel(model, error);
      results.push({ provider, model, role, ok: false, ms: Date.now() - started, code: error?.code || "ERROR", error: String(error?.message || error).slice(0, 240) });
    }
  };
  if (config.gemini.configured) {
    for (const model of config.gemini.models) await run("gemini", model, "writer", () => callGemini(model, ask, { key: config.gemini.key, fetchImpl, timeoutMs }));
    if (search) {
      for (const model of config.gemini.searchModels) {
        await run("gemini", model, "web search", () => callGemini(model, { search: true, messages: [{ role: "user", text: "Find the official website of the Supreme Court of Nigeria. Reply in one sentence." }], maxTokens: 256 }, { key: config.gemini.key, fetchImpl, timeoutMs: Math.max(timeoutMs, 60_000) }));
      }
    }
  }
  if (config.openrouter.configured) {
    await run("openrouter", config.openrouter.models.join(", "), "backup", () => callOpenRouter(ask, { key: config.openrouter.key, models: config.openrouter.models, referer: config.openrouter.referer, fetchImpl, timeoutMs }));
  }
  return results;
}

// Parse a JSON object from a model reply (tolerates ```json fences).
export function parseJsonReply(text) {
  const cleaned = String(text || "").replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { /* fall through */ }
    }
    return null;
  }
}
