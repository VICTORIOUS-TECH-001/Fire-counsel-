# FIRE COUNSEL — legal learning PWA

“Ignite your legal intelligence.” A local-first law-study workspace with a public homepage, student tools, Google-only Firebase sign-in, editable student profiles, and a server-authorized Neon content editor.

**Local tests are not live-project approval.** Firebase and Neon are not configured in this checkout. Read [STATUS.md](STATUS.md) for the latest test results, integration limits, and remaining release gates. Render Free remains **disposable staging only**, never a place for real student data, prompts or payments.

**Owner setup:** [Google-only access, admin usage and Neon steps](DEPLOYMENT.md), plus [Multi-AI/RAG/search setup and diagnostics](DEPLOYMENT.md#5-groqtavily-still-show-false-after-saving-keys).

## Run the app safely

Requirements: Node.js **22.17+**, npm, and Python 3. Install each package's locked dependencies:

```bash
npm ci
npm --prefix backend ci
npm --prefix firebase ci
```

Start the API in one terminal:

```bash
npm --prefix backend start
```

Start the website in another:

```bash
npm run dev
```

The website listens on `0.0.0.0:8080`; the API listens on `0.0.0.0:4000`. On your own machine, open `http://localhost:8080/`. In a hosted workspace, use the website's live-preview URL, not `localhost` in your browser.

| Page | Path | Purpose |
| --- | --- | --- |
| Public homepage | `/` | JSON-driven content, slideshow, articles, legal-links directory |
| Student workspace | `/study.html` | Google sign-in required; personal local files, flashcards, subjects and focus timer |
| AI studio | `/ai.html` | Google sign-in required; AI use additionally requires admin-granted Premium (admins bypass the paywall) |
| Account access | `/auth.html` | Google-only sign-in; no email/password form or unsigned continuation |
| My profile | `/study.html#profile` | Self-service name edits, Firebase email/password security and installation status; no courses/payments required |
| Admin studio | `/admin.html` | Website draft → preview → publish, document uploads (PDF/Word/photos), Database data, AI settings — all server-protected |
| Database readiness | `/api/health` | `503 / not_configured` is expected without Neon |

An admin-first preview is available with `npm run dev:admin` on port 8093. Both preview servers use the same restricted file server and loopback-only API proxy. Optional port overrides:

```bash
python3 tools/dev_server.py --port 8082 --api-port 4002
```

**Do not use `python3 -m http.server` from this repository.** It can expose `.env`, Git metadata, backend source and installed dependencies. The supplied helpers serve only frontend files/assets and proxy `/api/*`. They are development tools, not production servers. Production hosting must publish only frontend assets and provide an authenticated, same-origin API proxy.

## AI answers and online search

- **Writer:** Groq, DeepSeek, Gemini or OpenRouter. **Retrieval:** Tavily → Brave Search → SerpAPI → Gemini grounding by default. Groq/DeepSeek + Tavily/Brave/SerpAPI can answer text questions without Gemini; a text writer alone does not enable online search in this app. Each service needs its own server-side API credential and usable quota.
- Copy `backend/.env.example` to the ignored `backend/.env` for local setup, or configure the actual deployed API service. The examples prefer Groq via `AI_WRITER_PROVIDER_ORDER=groq,deepseek,gemini,openrouter`; priorities for retrieval are independently configurable. Never put these keys in a frontend file, localStorage, Git or chat.
- Selected online search must produce source URLs; if all retrieval fails, the request fails clearly instead of silently writing from memory. Failed jobs do not count against the student's daily allowance. Students can explicitly turn off Web search for a non-web answer. Answers show the retrieval provider/time and label optional reuse (off by default).
- `/api/health` and KEY ADDED mean **presence**, not working authentication. The Google/admin-protected connection test reports actual provider/model/search failures and spends provider quota when selected. Source excerpts/link badges do not establish that a legal holding or quotation is correct.
- Writer failover preserves the same library/source evidence, has total/per-provider deadlines and circuit cooldowns, and rejects unsupported files instead of dropping them. DeepSeek is usage-billed; free tiers are limited. See [the connector architecture, key list and current free-access notes](backend/AI_CONNECTORS.md).
- See [the exact deployment checklist](DEPLOYMENT.md#5-groqtavily-still-show-false-after-saving-keys). No new AI schema migration is needed for this repair, but existing Firebase/Neon/AI tables and Premium/admin controls still apply. Automated tests use fixtures, not live provider keys or fetched legal materials.

## Repeatable checks

```bash
npm test                    # syntax + frontend/SW + proxy + backend + study compatibility
npm run test:browser         # headless Chromium UI/offline regression tests
npm run test:rules           # Firestore + Storage emulators, requires Java 21+
npm run test:all             # all of the above; fails if any gate cannot run
```

The browser suite starts isolated servers on ports 8081/4001 with backend cloud credentials blank. External browser requests are blocked; authenticated UI scenarios use synthetic users and stubbed replies. It never signs into Firebase, sends email, calls Neon, invokes AI, or reads real browser study data. Profile SQL/migration tests use in-memory PGlite with a synthetic model of known identity columns; no Neon schema is automatically migrated. Linux uses a pinned Chromium binary and supporting libraries supplied through npm; other platforms can install Playwright Chromium or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`.

The GitHub Actions workflow runs local/browser checks and a **separate Java-enabled rules gate**. Both jobs have passed remotely; see [STATUS.md](STATUS.md) for the verified run and remaining release gates. Rules tests use only demo-project emulators, not the live Firebase project. No deployment is configured by that workflow. Failed browser/rules commands preserve their exit status and publish bounded diagnostics in the check annotations and step summary.

Dependency audits can be checked separately:

```bash
npm audit
npm --prefix backend audit
npm --prefix firebase audit
```

The Firebase development toolchain still has known moderate advisories and inherited `glob` lockfile/range inconsistencies; see [STATUS.md](STATUS.md). Do not force an untested major dependency update just to hide audit warnings.

## What is implemented

- `index.html`, `site.js`, `site.css`, `data/site-content.json`: responsive public site, locally stored photographs, accessible slideshow controls, articles and approved-link placeholders.
- `study.html`, `app.js`: IndexedDB-backed personal documents, recall cards, subject choices and a localStorage focus-session counter. The page requires Google sign-in. Returning browsers retain local tools offline; fresh browsers must sign in online once.
- `auth.html`, `auth-gate.mjs`, `firebase/auth-client.mjs`: Google-only sign-in and sign-out, with a shared lock screen on the workspace and AI studio. The browser, API and proposed Firebase rules check the session token provider, not merely a linked Google identity. Google supplies available name/email/photo, **not its password**. Firebase account-security helpers remain for existing linked accounts; email registration/sign-in/reset helpers have been removed.
- `student-profile.mjs`, `/api/v1/profile`: students can create and edit their own Neon profile independently of courses, membership, plans, payments or admin approval. First creation requires explicit browser-installation policy acceptance and a recent Firebase sign-in. UID/email/status/IP/roles cannot be supplied or changed through profile JSON. Live enablement is gated off until private schema review and staging migration. See [the profile setup/policy guide](backend/STUDENT_PROFILES.md).
- `admin.html`, `admin-auth.mjs`, `admin-database.mjs`, `admin-ai.mjs`: server-verified administrator status, allowlisted Neon content forms, and a Firebase account list with per-student AI usage, presence, Premium grants and limits. The HTML itself is not an authorization boundary; every protected API route independently verifies the token and `admin: true` claim.
- Homepage/slide/workspace publication and version restores call the Google/admin-protected `POST /api/v1/admin/site/firebase`. The API fully validates the shared 12-slide/8-link schema and writes the primary Firestore document with server-owned metadata. **All direct homepage browser writes are denied**; student-owned page editing remains direct and rule-validated. Matching frontend/API deployment, service-account IAM and owner-published rules are required. Neon keeps drafts, archives, photos and fallback JSON; an archive failure never claims a confirmed live publish was rolled back. [Manual deployment and diagnostics](DEPLOYMENT.md#6-manually-publish-the-firebase-rules).
- `study-materials.mjs`, `research-search.mjs`: authenticated approved/published material text and verified-source retrieval. Verified email, an active profile, its registered browser installation, institution/private/platform scopes and course eligibility are enforced by the backend. Profile creation grants no content entitlement. This is **database search, not Gemini, an AI answer or external web search**.
- Text material versions and searchable plain-text chunks are stored transactionally by the API. **Academic-material file uploads are not implemented.** Student-selected personal files are saved locally, not uploaded.
- `sw.js`: versioned, explicit public/study app-shell caching; network-first page/content refresh and offline study reloads. API replies, Authorization requests, admin pages, runtime Firebase config and arbitrary responses are not cached.
- Session/request guards clear authenticated content and ignore delayed replies when accounts change or sign out. These UI protections supplement, never replace, server authorization.

## Private setup and release boundaries

No live credentials are needed for automated tests; first-time app access requires configured Google sign-in. Before any live integration, review the existing Firebase project and Neon schema; use disposable staging fixtures, never real student work.

1. Copy `backend/.env.example` to the ignored `backend/.env`. Supply `DATABASE_URL`, `FIREBASE_PROJECT_ID`, and matching `FIREBASE_SERVICE_ACCOUNT_JSON` privately. Do not paste values in chat or commit them. Database connections enforce TLS certificate/hostname validation.
2. Put the Firebase **Web** `apiKey` in `firebase/firebase-config.mjs` (Project settings → Your apps → Config). That file is what the sign-in page loads, including on the published site. The other `fire-counsel` fields are already filled in. A Web API key is public app identification, not an admin credential. Never put a service-account key, OAuth client secret, or AI/search provider key there. Google sign-in is already implemented on `/auth.html`; it stays hidden until this key is real. Add the site hostname under Authentication → Settings → Authorized domains, keep the Google provider enabled with a support email, and if the Google Cloud OAuth consent screen is in Testing, add the Google account as a test user.
3. Enable Google and disable other sign-in providers after checking existing administrator account linking/UID continuity. Verify authorized domains, App Check, deployed rules and the intended administrator UID/claim in the actual Firebase project. A Google account, an email address or a browser-supplied role does not grant administrator permission.
4. Pass local Firestore/Storage emulator tests and review existing deployed rules before considering any deployment. Proposed rules are not deployed by this repository's tests.
5. Review `backend/migrations/001_student_profiles.sql` against the actual Neon schema and manually apply it only to disposable staging. Keep `STUDENT_PROFILES_ENABLED=false` until ready, then enable and test profile/installation authorization. No migration runs at startup. Optional trusted proxy IPs/CIDRs require a separate ingress/header review; the default ignores forwarded IPs.
6. Test real staging Google sign-in (including legacy password-session denial), account-security changes, second-installation denial, admin authorization, Neon CRUD, access scopes and retrieval end to end. Mocks and PGlite do not verify these live services. Review the lockout/recovery policy before real-user rollout.

Backend endpoint/security details are in [backend/README.md](backend/README.md); the reviewed schema reference is [backend/DATABASE_SCHEMA.md](backend/DATABASE_SCHEMA.md). Firebase setup and proposed rules are documented in [firebase/README.md](firebase/README.md).

## Existing study data and preview settings

The student database deliberately retains **`lexmaster-ai-stage1`**, version **1**, stores **`documents`, `cards`, `settings`**, and counter **`lexmaster-sessions`**. No study-store migration, deletion or localStorage clearing is performed. The independent `fire-counsel-installation-v1` marker persists across sign-out; clearing it can lock the student profile to a lost installation. Automated browser tests seed and verify disposable legacy records; they do not inspect anyone's real browser profile. Local study data is shared by accounts using that browser, not encrypted or separated by Firebase UID; sign-out locks the page without deleting or encrypting it; the same browser vault becomes visible after another account signs in. Clearing browser site data can delete local work and the account installation marker, so keep independent backups.

## Website publishing, uploads and the PDF reader

- **Website edits** (admin → Pages & JSON): *Save draft* stores the draft in Neon (`site_content`), *Preview* opens `index.html?preview=1`, which receives the unsaved draft from the admin tab (same origin only, never stored), and *Publish* makes it live. The public `/data/site-content.json` is then served from Neon, with the bundled file as the fallback. Every publish is kept in `site_content_versions` and can be restored. Slide photos are stored in `site_images` and served at `/media/<id>.<ext>`. No Firebase Storage (Blaze plan) is needed.
- **Document uploads** (admin → Upload documents): PDFs, Word files, photos and text are sent raw to `/api/v1/admin/documents` and read in the background. Digital PDFs are read with pdf.js (free, no AI). Scanned pages are read by Gemini (with the existing key) in page batches, with OCR.space as an optional fallback if `OCR_SPACE_API_KEY` is set. The text goes into the Neon library (materials + page-numbered chunks, case records or past questions), and the AI studio quotes it as `[Library: title, p. N]`. Optional limits: `FILE_STORAGE_LIMIT_MB` (default 350), `DOCUMENT_MAX_FILE_MB` (25), `DOCUMENT_OCR_MAX_PAGES`, `DOCUMENT_OCR_BATCH_PAGES`.
- **Student reader** (`pdf-reader.mjs`): personal library files and published materials' original PDFs open in an in-page reader (pdf.js served from `backend/node_modules/pdfjs-dist` at `/vendor/pdfjs/`, allowlisted). Static copies of the site without the backend fall back to the phone's PDF viewer.
- Run **Neon database migration (AI, website, uploads)** after merge, before using the new schema-dependent controls (migrations `002`–`005`). See [the step-by-step owner guide](DEPLOYMENT.md#3-run-the-database-migration-after-merge).

Never paste provider keys into a static page, localStorage, site JSON, Firestore documents or chat.

## Product decisions retained

- The adults-only (18+) audience is retained, but age verification and provider/privacy approval are not active. Writers are configurable; review each provider before sending any real student work. Do not assume a free plan is approved for it.
- Firebase Auth handles sign-in and Firestore stores published public site content. Website photos and uploaded documents are stored in Neon, not Firebase Storage; the separate Storage rules remain in the repository. Provider/hosting billing is an owner decision, not enabled by these repairs.
- AI access is admin-granted Premium, with server-enforced per-feature daily quotas and per-account overrides. There is no payment checkout or automatic paid-plan activation.
- Archived questions must be exact verified questions, not generated variants. New practice scenarios must be separately labelled and grounded in approved material.
- Nigeria remains the default research context. Online research is now an explicit AI-studio feature; school-approved domain allowlisting and additional jurisdiction controls are not implemented. Approved-library search stays separate from external search. Automated legal-material tests still use only supplied/synthetic evidence, report missing support and never fetch public legal materials. See [Testing materials](#testing-materials--owner-supplied-only).
- Paystack and the supplied ₦2,000 price remain future choices; paid-plan duration and activation are unresolved and disabled.
- A one-browser-installation-per-profile policy is implemented behind the staging setup gate. A different installation cannot reuse the existing profile; there is no automatic transfer or self-service recovery. IP changes do not create an account. A PWA cannot reliably identify physical hardware, and the marker can be cleared/copied; do not describe this as physical-device attestation. Review the lockout consequences before real-user rollout.

Brand artwork, photograph credits and source links are in [assets/images/README.md](assets/images/README.md). No live Firebase/Neon writes, rule deployment, account creation, admin-claim change, AI call, cloud upload/delete, payment, billing change or deployment was performed during the local status check.

## Testing materials — owner supplied only

This rule governs test evidence, including the new online-search regressions: use synthetic provider replies or owner-supplied material, never real student work or fetched legal content. The provider adapters do not authorize copying files from other repositories or changing the existing IndexedDB/installation policies. Live provider authentication and quota checks are separate owner-operated deployment steps.

- Do not fetch, scrape, or search the public web for notes, cases, statutes, or past questions while this app is being tested.
- The owner will give each test item, with its course name and type: note, case, statute, exact past question, or rubric.
- If that supplied material does not support an answer, say it was not found. Do not invent a citation and do not fill the gap online.
- Personal flashcards and local files stay in `lexmaster-ai-stage1`. Do not rename that database or migrate it in this stage.

These other repositories are separate products. Do not merge their auth, tables, or pages into FIRE COUNSEL to avoid a schema conflict:

| Repository | What it already is | Leave it alone because |
| --- | --- | --- |
| [legalhub](https://github.com/VICTORIOUS-TECH-001/legalhub) | Supabase login, `users.reg_number`, `is_admin`, a `materials` approval table, Cloudflare R2 | FIRE COUNSEL uses Firebase Auth and Neon, not Supabase or R2 |
| [articles](https://github.com/VICTORIOUS-TECH-001/articles) | Static HTML question pages for 2019, 2020, 2021, 2023 and 2025 | Copy a page only after the owner marks that exact page as a supplied past question |
| [past_questions](https://github.com/VICTORIOUS-TECH-001/past_questions) | Placeholder README | Nothing to import |
| [Cases-package](https://github.com/VICTORIOUS-TECH-001/Cases-package) | Empty repository | Nothing to import |
| [legal-aid](https://github.com/VICTORIOUS-TECH-001/legal-aid) | Short README and a submodule pointer | Not this app's database |

