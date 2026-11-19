# Google sign-in, admin usage and Neon setup

These are owner-operated deployment steps, not actions performed by the local tests. Keep keys, service-account JSON and database URLs out of chat and Git. Review the existing project, back up the target database and test in disposable staging first.

## 1. Google-only account access

- `/study.html` and `/ai.html` require a Google session. There is no email/password sign-in, email registration or anonymous-continue option. Signing out locks both pages.
- The API independently verifies the Firebase token (including revocation) and requires `firebase.sign_in_provider == "google.com"`. Merely having a linked Google identity is not sufficient; an old password/custom/anonymous session receives `403 GOOGLE_SIGN_IN_REQUIRED`. Administrators must also sign in with Google and still need their existing `admin: true` claim.
- Firestore/Storage rules apply the same Google-session requirement to private access and writes. Public homepage content, slide-image reads and published student pages remain public. Review and deploy the updated rules after the emulator gate passes; tests do not deploy them.
- A browser that previously signed in with Google may open its **local study tools offline** when Firebase cannot load. This is not offline API authorization: protected requests still need a valid token. Explicit sign-out clears this convenience marker, not study records or the separate profile-installation binding.

Owner checklist:

1. Firebase Console → **Authentication → Sign-in method → Google**: enable it and select a support email.
2. Under **Authentication → Settings → Authorized domains**, add the actual website hostname (no scheme/path/port).
3. Supply the public Web `apiKey` in `firebase/firebase-config.mjs`; never put a service-account/private key there. Configure the backend's matching `FIREBASE_PROJECT_ID` and `FIREBASE_SERVICE_ACCOUNT_JSON` privately.
4. Before disabling other providers or rolling out the enforcement, confirm that the administrator can sign in with Google using the **existing Firebase UID/admin claim**. Recover/link any password-only legacy account through a trusted owner-controlled process; do not delete/recreate accounts or grant admin based only on a matching email.
5. Disable **Email/Password** and any other unused sign-in providers in Firebase. Removing this app's form does not change Firebase Console settings.

For the full provider/domain/MFA guide, see [firebase/README.md](firebase/README.md).

## 2. Fix “Create Neon Branch” HTTP 401

This check authenticates to the **Neon management API**. It does not use Firebase or the PostgreSQL connection password. A 401 means its Neon API credential is missing, invalid, expired or not usable for that request; the workflow output alone does not identify which one.

1. In the Neon Console, select the existing project. Copy its **Project ID** from the project settings; this is not the display name or a connection string.
2. Open Neon account/organization settings → **API keys**. Create or replace a key authorized to manage branches in that project. Copy it directly into GitHub's secret form; do not paste it into chat or a source file.
3. Open this repository on GitHub → **Settings → Secrets and variables → Actions**.
4. On the **Secrets** tab, choose **New repository secret** (or update the existing secret):
   - Name: `NEON_API_KEY`
   - Value: the Neon API key.
5. On the **Variables** tab, choose **New repository variable** (or update it):
   - Name: `NEON_PROJECT_ID`
   - Value: the existing Neon project ID.
6. Open **Actions → Create/Delete Branch for Pull Request → the failed run → Re-run failed jobs**.

Use repository Actions settings, not Dependabot/Codespaces secrets or an unattached environment. If 401 persists, replace the key and verify its account/organization/project permissions. Do not log credentials or weaken pull-request secret protections to debug it.

## 3. Run the database migration after merge

This is separate from the preview-branch check. It uses a PostgreSQL connection URL, **not** `NEON_API_KEY`.

1. After merging the reviewed PR, open the target database in Neon and copy its connection string for the correct database/role/branch. Use the same target as the backend service's `DATABASE_URL`. Confirm it is the intended staging or approved deployment database before running anything.
2. GitHub repository → **Settings → Secrets and variables → Actions → Secrets → New repository secret** (or update):
   - Name: `DATABASE_URL`
   - Value: the complete Neon PostgreSQL connection string. Preserve the SSL options. Do not share the URL; it includes a database password.
3. Go to **Actions → Neon database migration (AI, website, uploads)**.
4. Choose **Run workflow → Use workflow from: main → Run workflow**. If the button/workflow is absent, confirm the PR containing `.github/workflows/neon-migrate.yml` has been merged into the default branch and that your repository role can run Actions.
5. Open the new run and its **migrate** job. Success logs include `Applied 005_premium.sql` and `Tables present (12/12)`. All four reviewed migrations (`002`–`005`) run; they are additive and idempotent, not a database reset.
6. Deploy/redeploy the matching app/backend code, sign in as the administrator with Google and check **Users & AI limits**. The premium checkbox requires migration `005`.

**Not included:** `001_student_profiles.sql` still needs separate review against the actual `app_users` schema, manual application and `STUDENT_PROFILES_ENABLED=true` before private profile/material routes can be enabled. Do not assume the AI migration workflow creates or enables those student profiles.

The automatic PR workflow creates a temporary preview branch; the migration workflow instead changes whichever database `DATABASE_URL` identifies. It does not automatically choose that PR branch.

## 4. Where the administrator sees students and usage

Open `/admin.html`, sign in with the Google account carrying the server-issued admin claim, then select **Users & AI limits**:

- Accounts are listed from Firebase Authentication, including students who have not made an AI request. The current list is capped at 5,000 and reports when truncated.
- Each row shows the name/email, Active/Offline status and last seen time, and today's **Chats / Cases / Notes / Questions** used versus the effective limits.
- Counts come from server-side `ai_usage`, include in-progress reservations and exclude failed requests and earlier days. Day boundaries follow `AI_TIMEZONE` (default `Africa/Lagos`).
- **Change limits** lets the admin grant/revoke Premium, pause AI and set per-account daily overrides. Signing in never grants premium or administrator rights automatically.
- Use **Refresh** to reload the list. Signing out clears it; a delayed response cannot restore another session's account data.

Live prerequisites: matching Firebase Admin credentials with user-list access, the correct Neon `DATABASE_URL`, and migrations `002`–`005`. Local browser/API tests use synthetic users and in-memory/stub data and do not establish that these production services are configured.

## 5. Groq/Tavily still show `false` after saving keys

### Writers and online search are separate

| Job | Supported services | Needed server setting |
| --- | --- | --- |
| Write an answer | Groq, DeepSeek, Gemini, OpenRouter | At least one of `GROQ_API_KEY`, `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY` |
| Retrieve online sources | Tavily, Brave Search, SerpAPI, Gemini grounding | `TAVILY_API_KEY`, `BRAVE_SEARCH_API_KEY` and/or `SERPAPI_API_KEY`; Gemini grounding is another fallback only if that account/model supports it |

**Recommended for this repair:** Groq/DeepSeek for text answers, Tavily for retrieval and Brave/SerpAPI as independent retrieval fallbacks. Gemini is **not required** for that combination. Groq alone does **not** search the web; Tavily/Brave/SerpAPI alone do **not** generate answers. The Brave browser is not the Brave Search API. No key, free quota, paid plan or live model entitlement is supplied by the code.

Set these **non-secret** options on the API service (the supplied local, Render and Oracle examples prefer Groq):

```dotenv
AI_WRITER_PROVIDER_ORDER=groq,deepseek,gemini,openrouter
DEEPSEEK_MODELS=deepseek-flash
AI_TIMEOUT_MS=240000
AI_WRITER_PROVIDER_TIMEOUT_MS=60000
WEB_SEARCH_PROVIDER_ORDER=tavily,brave,serpapi,gemini
WEB_SEARCH_TIMEOUT_MS=45000
WEB_SEARCH_PROVIDER_TIMEOUT_MS=12000
AI_RESEARCH_CACHE_MINUTES=0
```

With no writer-order override the code retains `gemini,groq,deepseek,openrouter`; the default search order is `tavily,brave,serpapi,gemini`. Ordering settings change priority, not exclusion: omitted recognised providers are appended and providers without keys are skipped. To disable a provider, remove its server credential. The total search budget defaults to 45 seconds (configurable 1–120 s); each provider attempt defaults to 12 seconds (1–60 s, limited by the remaining total). Failed/unavailable services cool down in this server process; an explicit admin test probes them again. Writers now share one total deadline (default 240 s, shorter chat budgets win), a per-provider cap (default 60 s) and fair time shares for models/fallbacks. Cooling circuits are not bypassed when all writers are down. A writer switch reuses the same retrieved evidence instead of repeating search. See [the connector architecture and cost guide](backend/AI_CONNECTORS.md).

Optional account-specific settings: `GROQ_MODELS`, `DEEPSEEK_MODELS` (default `deepseek-flash`), `GEMINI_MODELS`, `GEMINI_SEARCH_MODELS`, `OPENROUTER_MODELS`, `GROQ_TOKENS_PER_MINUTE` (conservative default 8000, not a claim about your plan), `TAVILY_SEARCH_DEPTH=basic`, `TAVILY_MAX_RESULTS=8`, `BRAVE_MAX_RESULTS=8`, `SERPAPI_MAX_RESULTS=8`. Use the provider dashboard to confirm current model IDs, limits, API access and cost. The default Groq models and this DeepSeek connector accept text, **not photos/PDFs**; use extracted text or configure a writer/model supporting the file type. Scanned-document OCR remains a separate Gemini/OCR.space path.

### Put credentials in the running API, not in the browser

For the service currently identified as **`fire-counsel-2`**:

1. Open [Render](https://dashboard.render.com/) → **fire-counsel-2 → Environment**. Privately set `GROQ_API_KEY` from [Groq](https://console.groq.com/keys), `TAVILY_API_KEY` from [Tavily](https://app.tavily.com), and, for independent failover, `BRAVE_SEARCH_API_KEY` from the [Brave Search API dashboard](https://api-dashboard.search.brave.com). Add `DEEPSEEK_API_KEY` from [DeepSeek](https://platform.deepseek.com/api_keys) for another text writer and/or `SERPAPI_API_KEY` from [SerpAPI](https://serpapi.com/manage-api-key) for another retrieval fallback. DeepSeek is usage-billed; free plans have limits and any configured fallback may consume credit. Keep unused provider keys blank/absent. Enter only the key value, not code, a URL, `NAME=`, or an xAI/Grok key. Groq rejects xAI `xai-` credentials. Nonempty unprefixed Tavily keys are accepted with a format warning; only an actual API test establishes validity.
2. **A new environment group is not required.** If using an existing group, link it under this exact service's **Linked Environment Groups**. Merely creating/editing a group does not attach it. Even a project-environment-scoped group still needs linking.
3. Check these exact names for duplicates. A service-level variable **overrides** the same name in a group, including a stale/blank service value; conflicting names in several groups have no guaranteed precedence. Keep one authoritative value for each key without deleting unrelated settings/groups. See [Render's guide](https://render.com/docs/configure-environment-variables#linking-a-group-to-a-service). Keys stored only in GitHub Actions, another service or `/etc/secrets/` files do not configure this process. This provider layer does not load key files.
4. Deploy the reviewed **frontend and API** from the matching commit. Choose **Save and deploy** (or **Save, rebuild, and deploy**); a failed deployment can leave the previous instance serving requests. Confirm the intended deployment becomes **Live** in Events. For local development use the Git-ignored `backend/.env`; for an existing Oracle host edit `/etc/fire-counsel/app.env` privately and restart `fire-counsel` instead of changing Render.
5. Open the running service's `/api/health` (currently [here](https://fire-counsel-2.onrender.com/api/health)). This code returns `config_diagnostics_version: 2`, `render_service` and `render_commit` when available. Compare the SHA with the successful Live deployment; rebuilding an old commit is not this repair.
6. Inspect the secret-free flags: `setup.groq_key`, `setup.tavily_key`, `setup.brave_search_key`, `setup.deepseek_key`, `setup.serpapi_key`, `setup.ai_writer_key`, `setup.web_search_key`. `ai_key_check.groq.state`, `.tavily.state`, `.brave.state`, `.deepseek.state` and `.serpapi.state` describe each **canonical variable** as `missing`, `empty` or `present`. Supported aliases may make a setup flag true while its canonical name is missing. Prefer canonical names; no values, fragments, lengths or hashes are exposed.
7. Sign in as the existing Google administrator → **AI studio settings → Test AI connection**, with **also test web search (uses provider quota)** checked. Confirm a writer row is healthy **and** at least one search row reports source results. It probes configured services, including fallbacks, in parallel; it consumes their API quota and can incur plan charges. Uncheck web search for a writer-only check. Search-only diagnostics work without a writer or Neon, but student AI jobs still require the normal Firebase, Neon, Premium/admin and usage checks.
8. In the AI studio, leave **Web search** selected and test with a non-sensitive, owner-supplied topic. The answer shows the retrieval provider and time. If all searches fail, the request fails explicitly, does not call the final writer and does not count against the student's daily allowance. It never silently becomes an unsourced answer. A non-web answer requires explicitly turning the checkbox off. This code change needs no new database migration; the existing AI tables are still required.

`/api/health` reports **presence only**, not provider authentication or search health. Its top-level `status: ok` means the configured database check succeeded, not that Firebase, AI keys, quota or group linkage were verified. Likewise, KEY ADDED in the admin panel is not HEALTHY. A `render.yaml` declaration does not prove an already-created dashboard service received its variables.

### Read the actual error before changing settings

| Diagnostic | Owner action |
| --- | --- |
| Canonical state `missing` / `empty` | Check the exact API service, linked group, blank overrides and successful Live commit; redeploy after saving. |
| `PROVIDER_AUTH` | Check the correct provider's key **and API/plan permissions** privately. A presence flag cannot validate it. |
| `PROVIDER_QUOTA`, `PROVIDER_MONTHLY_QUOTA`, `SEARCH_QUOTA` | Check usage/reset time and current account entitlement. Independent search falls back automatically when configured. This repair never enables billing or buys credits. |
| `MODEL_UNAVAILABLE` / `SEARCH_UNSUPPORTED` | Choose a supported writer/grounding model in the matching model setting; a writing model need not support search. |
| `PROVIDER_TOO_LARGE` / `PROVIDER_OUTPUT_LIMIT` | Shorten the request, choose another supported model or match `GROQ_TOKENS_PER_MINUTE` to the actual account allowance. Do not raise it beyond the plan limit. |
| `PROVIDER_TIMEOUT`, `PROVIDER_UNAVAILABLE`, `PROVIDER_INVALID_RESPONSE` | Bounded fallback handles slow/outage/malformed responses; review each provider row rather than repeatedly submitting a long job. |
| `PROVIDER_SAFETY` | Explicit safety refusal: not routed around to another model. |
| `SEARCH_NOT_CONFIGURED` / `SEARCH_NO_RESULTS` | Configure retrieval or revise the query. A fluent model answer without source URLs is not a successful search. |

Search results are untrusted excerpts, not complete judgments or proof of a legal holding/quotation. Source badges describe reachability/topic mentions; open and check the primary authority yourself. Domain allowlisting is not implemented. Approved-library search in `/study.html` remains a separate, access-controlled Neon search; it does not call external providers.

Research reuse is **off by default**. Optional `AI_RESEARCH_CACHE_MINUTES` enables bounded, account-scoped, in-memory reuse only for requests without attachments; failures are never cached and the answer retains the original retrieval time. It is not a cross-account legal-answer database or offline online-search capability.

**Verification boundary:** automated API/browser tests use synthetic responses and owner-supplied material. They do not authenticate real Groq/DeepSeek/Tavily/Brave/SerpAPI keys, validate current provider quotas/models, fetch legal materials, change Render/Oracle settings or deploy anything. Keep provider keys and private environment output out of chat, Git, browser storage and site JSON.

## 6. Manually publish the Firebase rules

A Firestore `permission-denied` reply is an authorization/validation denial, not proof that Firebase is disconnected. The old direct-browser publisher also exceeded Firestore's **1,000-expression limit** at the supported 12 slides / 8 navigation links. The repair uses **Google/admin-protected API → full shared validation → Firebase Admin SDK**, not weaker rules or smaller limits. The server's `firebase_admin_key: true` flag checks the service-account file **locally**; it does not test live IAM/database access or grant a custom claim.

**Important: deploy the matching frontend and API before replacing the rules below. All homepage browser writes are deliberately denied, even for admins; the old client will not work with these rules.** This is an integrated application/API/rules repair, not a rules-only fix.

1. Open [Firebase Console → fire-counsel](https://console.firebase.google.com/project/fire-counsel/overview). Back up the current Firestore and Storage rules and review paths used by any other apps in the project before replacing them. Tests never deploy rules.
2. Deploy the reviewed fix from this branch/PR to the actual frontend and **fire-counsel-2** API service. Keep Render's Root Directory at the **repository root**, not `backend/`: the API imports `firebase/content-schema.mjs`. The supplied build/start commands remain `npm --prefix backend ci --omit=dev` and `npm --prefix backend start`. Verify the successful **Live** commit and `config_diagnostics_version: 2` at `/api/health`; rebuilding an older commit will not install this route. All browser calls use same-origin `/api/...`; a separately hosted frontend must keep its existing authenticated API proxy.
3. In Firebase **Build → Firestore Database**, select **`(default)` → Rules**. Replace the editor with the complete contents of [`firebase/firestore.rules`](firebase/firestore.rules), then **Publish**. The browser reads `siteContent/public` in this database; writes go through **POST `/api/v1/admin/site/firebase`**. Do not paste Storage rules here.
4. Separately, only for Firebase Storage operations: open **Build → Storage → Rules** for **`fire-counsel.firebasestorage.app`**. Paste the complete [`firebase/storage.rules`](firebase/storage.rules), then **Publish**. Current admin photo uploads use Neon `/media/`, not Storage. Changing Storage rules/billing does not fix homepage publishing.
5. Sign in at `/admin.html` with the intended **Google** administrator. If the account needs an admin claim, its verified email must be in Render's `ADMIN_EMAILS`; use **Make this account the administrator** in Admin sign-in. That protected endpoint grants the claim and refreshes the ID token. Merely listing an email or publishing rules does **not** add `admin: true`. Never put administrator emails or private keys into public rules to bypass this.
6. Reload the app and publish a small, reversible change. The client refreshes/checks Google/admin, then the API independently verifies the token (including revocation), validates the full content, checks project identity, fixes the path to `siteContent/public`, and owns `updatedAt`/`updatedBy`. It requires a confirmed write acknowledgement before archiving in Neon. Primary publication works without Neon; when archive reads fail, workspace publication skips that archive rather than overwriting an unknown unpublished draft.

If publication still fails, follow the **actual error code**, not another rules relaxation:

| Error | Owner check |
| --- | --- |
| `401` / `403`, or missing admin claim | Re-sign in with Google; verify `ADMIN_EMAILS` and complete the protected claim flow. Rules cannot grant a claim. |
| `404`, HTML response, or no publish acknowledgement | The frontend/API versions or same-origin proxy do not match. Confirm the new `/api/v1/admin/site/firebase` route is in the successful Live deployment. |
| `FIREBASE_PROJECT_MISMATCH` | Match `FIREBASE_PROJECT_ID`, the service-account project and the Web app's `fire-counsel` project. |
| `FIREBASE_ADMIN_NOT_READY` | Check the complete service-account JSON privately in Render and the safe `/api/health` diagnostics. Never send the key in chat. |
| `FIRESTORE_ACCESS_DENIED` | Check that this project's Firestore API is enabled, its `(default)` database exists, and the server's service account has appropriate Firestore data-write IAM access. **Admin SDK writes bypass browser rules**; publishing rules cannot grant this permission. |
| `FIREBASE_PUBLISH_UNCONFIRMED` / lost response | Reload the live content before retrying: the write may already have committed. No Neon archive is attempted without confirmation. |
| Student-page `permission-denied` | This unchanged direct-write flow needs deployed student-page rules, the same Google owner/admin, valid exact fields, and preserved `createdAt`. Confirm the selected project/database and any separately enforced App Check configuration. |

Stored `updatedAt`/`updatedBy` metadata is removed **only on public reads**. Homepage, restore and workspace publishing share the same primary Firestore channel; homepage/workspace readers keep their Neon/bundled/offline fallbacks. A confirmed Firestore publish followed by an archive failure is reported as partial success, never as a rolled-back live change. Do not enable allow-all/test-mode rules. No rules, claims, Render settings or private credentials are deployed by local tests.
