// Admin document workloads have their OWN credentials. Never pass the full
// environment to the student generate() helper: its alias discovery is broad.
import { AiError, callGemini } from "../ai/providers.js";

const clean = value => String(value || "").replace(/[\u200B-\u200D\u2060\uFEFF]/g, "").trim().replace(/^["']|["']$/g, "").replace(/^Bearer\s+/i, "").trim();
const setting = value => value === undefined ? "missing" : clean(value) ? "present" : "empty";
const model = (value, fallback) => /^[\w@./:-]{1,160}$/.test(value || "") ? value : fallback;

export function adminProviderConfig(env = process.env) {
  const candidate = clean(env.ADMIN_GEMINI_API_KEY);
  // Accidentally pasting the old student credential under a new name is not
  // workload isolation. Refuse it rather than silently spending that key.
  const keyState = !candidate ? setting(env.ADMIN_GEMINI_API_KEY) : candidate === clean(env.GEMINI_API_KEY) ? "same_as_student" : /\s/.test(candidate) ? "invalid_format" : "present";
  const key = keyState === "present" ? candidate : "";
  const token = clean(env.ADMIN_CLOUDFLARE_API_TOKEN);
  const account = clean(env.ADMIN_CLOUDFLARE_ACCOUNT_ID);
  return {
    gemini: { configured: Boolean(key), key, state: keyState, model: model(env.ADMIN_GEMINI_MODEL, "gemini-flash-latest") },
    cloudflare: { configured: Boolean(token && !/\s/.test(token) && /^[a-f0-9]{32}$/i.test(account)), token, account,
      tokenState: !token ? setting(env.ADMIN_CLOUDFLARE_API_TOKEN) : /\s/.test(token) ? "invalid_format" : "present",
      accountState: !account ? setting(env.ADMIN_CLOUDFLARE_ACCOUNT_ID) : /^[a-f0-9]{32}$/i.test(account) ? "present" : "invalid_format",
      model: model(env.ADMIN_CLOUDFLARE_MODEL, "@cf/meta/llama-3.3-70b-instruct-fp8-fast") },
    timeoutMs: Math.min(Math.max(Number(env.ADMIN_AI_TIMEOUT_MS) || 90_000, 5_000), 240_000)
  };
}

export function describeAdminProviders(env = process.env) {
  const c = adminProviderConfig(env);
  return {
    configured: c.gemini.configured || c.cloudflare.configured,
    gemini: { configured: c.gemini.configured, setting_state: c.gemini.state, model: c.gemini.model },
    cloudflare: { configured: c.cloudflare.configured, token_state: c.cloudflare.tokenState, account_state: c.cloudflare.accountState, model: c.cloudflare.model },
    ocr: c.gemini.configured ? "admin_gemini" : clean(env.OCR_SPACE_API_KEY) ? "ocr_space" : null,
    isolation: "admin_only"
  };
}

// extractDocument is also a general-purpose local PDF/Word reader. Give its
// capability check ONLY the admin Gemini key, never the student's credentials.
export function adminExtractionEnv(env = process.env) {
  const c = adminProviderConfig(env);
  return {
    GEMINI_API_KEY: c.gemini.key,
    GEMINI_MODELS: c.gemini.model,
    OCR_SPACE_API_KEY: env.OCR_SPACE_API_KEY,
    DOCUMENT_AI_KEY_NAME: "ADMIN_GEMINI_API_KEY",
    DOCUMENT_OCR_MAX_PAGES: env.DOCUMENT_OCR_MAX_PAGES,
    DOCUMENT_OCR_BATCH_PAGES: env.DOCUMENT_OCR_BATCH_PAGES
  };
}

async function cloudflare(request, config, fetchImpl) {
  if (request.messages?.some(message => message.attachments?.length)) throw new AiError(400, "Cloudflare processes extracted text. Scanned PDFs and photos need ADMIN_GEMINI_API_KEY for OCR first.", "ADMIN_OCR_REQUIRED");
  const maxTokens = Math.min(request.maxTokens || 8192, 16384);
  const controller = new AbortController();
  let timer;
  // Cover connection AND response-body reads, even a transport that ignores
  // AbortSignal. A user-triggered test cannot occupy the API indefinitely.
  try {
    return await Promise.race([
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new AiError(504, "Cloudflare Workers AI exceeded the admin deadline.", "ADMIN_PROVIDER_TIMEOUT", { retryable: true }));
        }, config.timeoutMs);
      }),
      (async () => {
        const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${config.cloudflare.account}/ai/run/${config.cloudflare.model}`, {
          method: "POST", redirect: "error",
          headers: { Authorization: `Bearer ${config.cloudflare.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ messages: [{ role: "system", content: request.system || "Process the administrator's document." },
            ...(request.messages || []).map(message => ({ role: message.role === "assistant" ? "assistant" : "user", content: message.text || "" }))],
          max_tokens: maxTokens, temperature: request.temperature ?? 0 }),
          signal: controller.signal
        });
        // Do not echo upstream errors: some providers include credential text.
        if (!response.ok) {
          const auth = [401, 403].includes(response.status);
          throw new AiError(auth ? 503 : response.status === 429 ? 429 : 502,
            auth ? "Cloudflare rejected the admin token or account permission. Check ADMIN_CLOUDFLARE_API_TOKEN and its Workers AI access."
              : response.status === 429 ? "Cloudflare Workers AI rate limit or allowance was reached. Check account usage or choose Admin Gemini."
                : `Cloudflare Workers AI could not process this request (HTTP ${response.status}).`,
            auth ? "ADMIN_PROVIDER_AUTH" : response.status === 429 ? "ADMIN_PROVIDER_QUOTA" : "ADMIN_PROVIDER_FAILED", { retryable: !auth });
        }
        const body = await response.json().catch(() => null);
        const result = body?.result;
        const text = result?.response;
        if (body?.success === false || typeof text !== "string" || !text.trim()) throw new AiError(502, "Cloudflare returned no document text. Check the configured Workers AI text model.", "ADMIN_PROVIDER_EMPTY");
        return { text: text.trim(), provider: "cloudflare", model: config.cloudflare.model,
          truncated: result.finish_reason === "length" || Number(result.usage?.completion_tokens) >= maxTokens };
      })()
    ]);
  } catch (error) {
    if (error instanceof AiError) throw error;
    throw new AiError(502, "Cloudflare Workers AI could not be reached. Check the API service's provider connection.", "ADMIN_PROVIDER_UNAVAILABLE", { retryable: true });
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export async function generateAdmin(request, { env = process.env, fetchImpl = fetch, provider = "auto" } = {}) {
  if (!["auto", "cloudflare", "gemini"].includes(provider)) throw new AiError(400, "Choose Auto, Cloudflare or Admin Gemini.", "VALIDATION_ERROR");
  const config = adminProviderConfig(env);
  const vision = request.messages?.some(message => message.attachments?.length);
  if (vision && !config.gemini.configured) throw new AiError(503, "Scanned documents need the separate ADMIN_GEMINI_API_KEY (or configured OCR.space). The student key is never used.", "ADMIN_OCR_REQUIRED");
  const candidates = vision ? ["gemini"] : provider === "auto" ? ["cloudflare", "gemini"].filter(name => config[name].configured) : [provider];
  if (!candidates.length || candidates.some(name => !config[name].configured)) throw new AiError(503, "Admin AI is not configured. Add ADMIN_GEMINI_API_KEY or ADMIN_CLOUDFLARE_ACCOUNT_ID plus ADMIN_CLOUDFLARE_API_TOKEN in the server environment. The student Gemini key is not a fallback.", "ADMIN_AI_NOT_CONFIGURED");
  const warnings = [];
  for (const [index, name] of candidates.entries()) {
    try {
      const result = name === "cloudflare" ? await cloudflare(request, config, fetchImpl)
        : await callGemini(config.gemini.model, request, { key: config.gemini.key, fetchImpl: (url, init) => fetchImpl(url, { ...init, redirect: "error" }), timeoutMs: config.timeoutMs });
      return { ...result, warnings, fallback: index > 0 };
    } catch (error) {
      if (index === candidates.length - 1) {
        if (name === "gemini") {
          const errors = {
            PROVIDER_QUOTA: [429, "Admin Gemini rate limit, quota or billing allowance was reached. Check the admin Google project's limits; Cloudflare can process already extracted text.", "ADMIN_PROVIDER_QUOTA"],
            PROVIDER_AUTH: [503, "Google rejected the admin Gemini credential or its permissions. Check ADMIN_GEMINI_API_KEY on this API service, not the student key.", "ADMIN_PROVIDER_AUTH"],
            MODEL_UNAVAILABLE: [503, "The configured admin Gemini model is unavailable for this project. Set ADMIN_GEMINI_MODEL to a model available to the admin key, then redeploy.", "ADMIN_MODEL_UNAVAILABLE"],
            PROVIDER_TIMEOUT: [504, "The admin Gemini request exceeded its deadline. Try a smaller document section; an API-service 503 while checking status is a separate failure.", "ADMIN_PROVIDER_TIMEOUT"],
            PROVIDER_UNAVAILABLE: [502, "The admin Gemini provider is temporarily unavailable. Retry the document later or use Cloudflare for already extracted text.", "ADMIN_PROVIDER_UNAVAILABLE"]
          };
          const [status, message, code] = errors[error.code] || [error.status || 502,
            "Admin Gemini could not process this document. Check the admin model, document safety restrictions and provider diagnostics.", "ADMIN_PROVIDER_FAILED"];
          throw new AiError(status, message, code);
        }
        throw error;
      }
      warnings.push(`${name === "cloudflare" ? "Cloudflare" : "Admin Gemini"} was unavailable; the other admin provider was used. No student key was used.`);
    }
  }
}

// Explicit, bounded live acceptance probe. Never called by /status or health,
// never selects Auto/fallback, never touches Neon or sends a document.
export async function testAdminProvider(provider, { env = process.env, fetchImpl = fetch } = {}) {
  if (!["gemini", "cloudflare"].includes(provider)) throw new AiError(400, "Choose Admin Gemini or Cloudflare for this explicit connection test.", "VALIDATION_ERROR");
  const started = Date.now();
  await generateAdmin({ system: "Connection test only. Reply with READY. No research or tools.",
    messages: [{ role: "user", text: "Reply with READY." }], temperature: 0, maxTokens: provider === "gemini" ? 512 : 32 },
    { env: { ...env, ADMIN_AI_TIMEOUT_MS: Math.min(Number(env.ADMIN_AI_TIMEOUT_MS) || 20_000, 20_000) }, fetchImpl, provider });
  // Only return our selected/configured identifiers, never arbitrary upstream
  // text or model metadata. Explicit selection above guarantees no failover.
  return { ok: true, provider, model: adminProviderConfig(env)[provider].model, elapsed_ms: Date.now() - started, check: "live_provider_request" };
}
