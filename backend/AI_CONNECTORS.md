# Multi-provider RAG connectors

Updated 19 November 2026. This is an application implementation, not a live-provider or production availability guarantee. No credentials belong in this document, chat, Git, the frontend or localStorage.

## How a request works

```text
Google-authenticated request → existing Premium/admin/quota checks → queued job
    ├─ Existing course-library retrieval (Neon full-text passages with page citations)
    └─ Requested web retrieval: Tavily → Brave → SerpAPI → Gemini grounding
                           ↓
          One evidence bundle: instructions + history + passages + source excerpts
                           ↓
        Writer connector: Gemini → Groq → DeepSeek → OpenRouter
                           ↓
       Existing source/link checks + answer/provenance → Neon → browser/export
```

The orders above are the code defaults. The supplied deployment examples prefer **Groq → DeepSeek → Gemini → OpenRouter**. Configure priorities independently; omit credentials for services that must not be used. An order is **not** an allowlist: omitted recognized providers are appended, duplicates/unknown names are ignored, and services without keys are skipped. A provider can consume quota or incur charges whenever its key is configured and it is selected as a fallback. No account is automatically upgraded and no credits are purchased.

`src/services/ai/providers.js` owns explicit writer/search adapter registries. `studio.js` retrieves evidence once and passes the same bounded evidence/history/instructions to every writer attempt. Adding a connector does not require rewriting the chat, case, note, mock-exam or question pipelines. This retains the existing full-text RAG implementation; it does **not** introduce embeddings, a vector database, an external LangChain service or a schema migration.

The approved-library `/api/v1/research/search` endpoint remains a separate, installation/access-controlled database-only search. Its permissions and the AI studio's existing library retrieval policy are unchanged; this connector change does not grant any extra material/course access.

## Server settings

| Purpose | Canonical secret | Models / options |
| --- | --- | --- |
| Groq text writer | `GROQ_API_KEY` | `GROQ_MODELS`, `GROQ_TOKENS_PER_MINUTE` |
| DeepSeek text writer | `DEEPSEEK_API_KEY` | `DEEPSEEK_MODELS=deepseek-flash` |
| Gemini writer / grounded retrieval | `GEMINI_API_KEY` | `GEMINI_MODELS`, `GEMINI_SEARCH_MODELS` |
| OpenRouter writer | `OPENROUTER_API_KEY` | `OPENROUTER_MODELS` |
| Tavily retrieval | `TAVILY_API_KEY` | `TAVILY_SEARCH_DEPTH=basic`, `TAVILY_MAX_RESULTS=8` |
| Brave Web Search retrieval | `BRAVE_SEARCH_API_KEY` | `BRAVE_MAX_RESULTS=8` |
| SerpAPI Google organic retrieval | `SERPAPI_API_KEY` | `SERPAPI_MAX_RESULTS=8` (1–10) |

`DEEPSEEK_KEY` and `SERPAPI_KEY` are explicit compatibility aliases; canonical names are preferred. No guessed `sk-` credential from another environment setting is reused for DeepSeek. Secret files/custom base URLs are not loaded by this layer. Existing Groq/Tavily/Brave aliases remain supported. Model lists deduplicate and cap at eight entries per provider to bound attempts; choose IDs actually available to your account. Only `deepseek-flash` is selected by default; the code does not automatically upgrade DeepSeek to a more expensive model.

Recommended non-secret settings:

```dotenv
AI_WRITER_PROVIDER_ORDER=groq,deepseek,gemini,openrouter
WEB_SEARCH_PROVIDER_ORDER=tavily,brave,serpapi,gemini
DEEPSEEK_MODELS=deepseek-flash
AI_TIMEOUT_MS=240000
AI_WRITER_PROVIDER_TIMEOUT_MS=60000
WEB_SEARCH_TIMEOUT_MS=45000
WEB_SEARCH_PROVIDER_TIMEOUT_MS=12000
AI_RESEARCH_CACHE_MINUTES=0
```

- `AI_TIMEOUT_MS` (1–600 s, default 240 s) is now the **whole writer chain's deadline**, not a fresh timeout for every model. A shorter internal request budget (chat defaults to 100 s) still wins.
- `AI_WRITER_PROVIDER_TIMEOUT_MS` (1–600 s, default 60 s) caps each provider's combined model attempts. Remaining time is shared fairly with later configured writers and candidate models. Errors move on immediately; slow attempts are aborted at their share. Increase budgets deliberately for long outputs, bearing in mind the queued-job deadline.
- Streaming Gemini also observes first-visible-text and idle deadlines. Heartbeats/thought-only chunks do not indefinitely extend the first-text wait. Connections, successful/error bodies and streams are bounded, even if a transport ignores `AbortSignal`.
- Search retains a 45-second whole-chain / 12-second per-attempt default. A failed writer does not repeat retrieval or spend more search calls. Search providers can still be tried in succession when retrieval fails.
- Circuit health skips temporary model/service failures. Writer circuits are provider/model/credential-scoped; internal fingerprints are never returned. Rotating a key does not inherit the previous writer key's cooldown. Size/capability/no-result failures do not disable an otherwise healthy model for other requests. If everything is cooling down, the request fails promptly instead of hammering every service again. An explicit admin connection test can retest immediately.

## Failure and data-integrity rules

- Authentication/quota/balance errors, absent models, network failures, bounded timeouts, unreadable responses and empty final replies move to the next eligible writer. JSON tasks also fall back when the model does not return a JSON object. Feature-specific schema validation still occurs in the relevant pipeline.
- Explicit safety refusals are terminal. The router does not bypass them by asking another model.
- Existing default Groq models and this **DeepSeek connector are text-only**. Binary attachments fail over to a compatible configured writer; otherwise the app explains the unsupported request. Text attachments are not silently truncated by these connectors. No DeepSeek vision/files/native web tools/OCR integration is enabled here. The current Gemini/OCR.space document-import OCR path is unchanged.
- Failed attempts' partial text is replaced, never appended to a backup answer. Aborted late chunks cannot restore it. Only final content is marked done; an exhausted/failed queued job refunds the app's daily allowance. External provider charges for attempted calls are not refundable by this app.
- Only final answer content is returned: DeepSeek/Groq/OpenRouter reasoning fields are neither returned nor persisted. Thinking is explicitly disabled for DeepSeek's chat request.
- Requested web research requires usable source URLs. Empty/failed search is never silently relabelled a non-web answer. Turning off Web search is the student's explicit choice. Source snippets are untrusted evidence, not instructions or complete judgments; link reachability does not prove legal correctness.
- Sources retain the successful retrieval provider and time. Answers record the final writer, a fallback flag and bounded, secret-free writer-attempt status/codes; failed attempt text/provider error details are not in that audit trail.
- SerpAPI requires `api_key` in its server-to-server query string. The adapter rejects redirects, never logs the outgoing URL, discards search metadata/parameters, redacts key echoes in provider errors, and does not preserve raw transport exception causes. Do not enable request-URL logging in an external proxy/observability system without query-secret scrubbing.
- Research reuse remains default-off, account-scoped and in memory only; no attachments/failures are cached. Reuse and conversation/export retention require review of each provider's storage/license/privacy terms. Adding a key is not such approval.

## Free access is limited, not guaranteed

Official public pages checked 19 November 2026; the actual account/dashboard and current terms control eligibility and charges:

| Service | Public allowance / billing | Official source |
| --- | --- | --- |
| Groq | Rate-limited Free plan; model/org-specific request and token caps | [Rate limits](https://console.groq.com/docs/rate-limits), [account limits](https://console.groq.com/settings/limits) |
| Tavily | Researcher: 1,000 free API credits/month, no card; operations can cost multiple credits | [Pricing](https://www.tavily.com/pricing) |
| SerpAPI | Free: 250 searches/month, 50/hour | [Pricing](https://serpapi.com/pricing) |
| Brave Search | Search: $5 monthly credit; listed $5/1,000 requests. A card and applicable terms/attribution/storage review are required | [API plans and FAQ](https://brave.com/search/api/) |
| DeepSeek | Usage-billed API deducted from available balance; do not assume a recurring free allowance or that free consumer chat covers API calls | [Models/pricing](https://api-docs.deepseek.com/quick_start/pricing/) |
| Gemini / OpenRouter | Model/account-specific pricing and quota; do not assume all configured models are free | [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing), [OpenRouter pricing](https://openrouter.ai/pricing) |

Fallback improves availability **only when another configured provider can accept the same request within its quota and time budget**. It cannot guarantee uninterrupted service, legal accuracy, internet availability or zero cost.

## Owner activation and verification

1. Deploy the matching frontend/API; privately set only the intended secrets on Render **`fire-counsel-2` → Environment** (or the private Oracle/local environment file). Use `DEEPSEEK_API_KEY` and optionally `SERPAPI_API_KEY`; other configured keys remain useful fallbacks. Never send keys in chat.
2. Save/deploy and confirm the successful Live commit. `/api/health` remains presence-only diagnostics v2 with additive `setup.deepseek_key`, `setup.serpapi_key` and canonical setting states; it does not call providers or validate balance.
3. Sign in as the existing Google administrator → **AI studio settings → Test AI connection**. Writer probes test every configured writer/model in parallel and may cost money. Search is separately opt-in; select it to test actual source results. Probes bypass cooldowns but respect a common deadline; late replies cannot mutate their health results.
4. Test one non-sensitive, owner-supplied topic. Verify the final writer, source provenance and no unsourced downgrade. Review provider dashboards for actual costs/limits before sharing with students.

Automated tests use synthetic HTTP replies and local PGlite/browser fixtures, not live keys or fetched legal content. They do not deploy, migrate, change billing, grant Premium/admin, alter Firebase rules/claims, or change IndexedDB/installation policies. See [STATUS.md](../STATUS.md) for exact current verification results and [deployment troubleshooting](../DEPLOYMENT.md#5-groqtavily-still-show-false-after-saving-keys).
