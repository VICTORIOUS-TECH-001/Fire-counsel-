# FIRE COUNSEL — legal learning PWA

“Ignite your legal intelligence.” A local-first law-study workspace with a public homepage, student tools, Firebase registration/sign-in, editable student profiles, and a server-authorized Neon content editor.

**Local tests are not live-project approval.** Firebase and Neon are not configured in this checkout. Read [STATUS.md](STATUS.md) for the latest test results, integration limits, and remaining release gates. Render Free remains **disposable staging only**, never a place for real student data, prompts or payments.

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
| Student workspace | `/study.html` | Personal local files, flashcards, subjects and focus timer |
| Account access | `/auth.html` | Firebase email/password registration, Google sign-in and reset emails |
| My profile | `/study.html#profile` | Self-service name edits, Firebase email/password security and installation status; no courses/payments required |
| Admin studio | `/admin.html` | Local previews plus the server-protected Database data panel |
| Database readiness | `/api/health` | `503 / not_configured` is expected without Neon |

An admin-first preview is available with `npm run dev:admin` on port 8093. Both preview servers use the same restricted file server and loopback-only API proxy. Optional port overrides:

```bash
python3 tools/dev_server.py --port 8082 --api-port 4002
```

**Do not use `python3 -m http.server` from this repository.** It can expose `.env`, Git metadata, backend source and installed dependencies. The supplied helpers serve only frontend files/assets and proxy `/api/*`. They are development tools, not production servers. Production hosting must publish only frontend assets and provide an authenticated, same-origin API proxy.

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
- `study.html`, `app.js`: IndexedDB-backed personal documents, recall cards, subject choices and a localStorage focus-session counter. These work without signing in.
- `auth.html`, `firebase/auth-client.mjs`: Firebase email/password registration, Google sign-in, sign-out, verification/reset emails and reauthenticated email/password changes. Google supplies available name/email/photo, **not its password**. No account listing, administrator-set-password or admin-claim-grant endpoint exists.
- `student-profile.mjs`, `/api/v1/profile`: students can create and edit their own Neon profile independently of courses, membership, plans, payments or admin approval. First creation requires explicit browser-installation policy acceptance and a recent Firebase sign-in. UID/email/status/IP/roles cannot be supplied or changed through profile JSON. Live enablement is gated off until private schema review and staging migration. See [the profile setup/policy guide](backend/STUDENT_PROFILES.md).
- `admin.html`, `admin-auth.mjs`, `admin-database.mjs`: server-verified administrator status and allowlisted Neon academic/legal content forms. The HTML itself is not an authorization boundary; every protected API route independently verifies the token and `admin: true` claim.
- `study-materials.mjs`, `research-search.mjs`: authenticated approved/published material text and verified-source retrieval. Verified email, an active profile, its registered browser installation, institution/private/platform scopes and course eligibility are enforced by the backend. Profile creation grants no content entitlement. This is **database search, not Gemini, an AI answer or external web search**.
- Text material versions and searchable plain-text chunks are stored transactionally by the API. **Academic-material file uploads are not implemented.** Student-selected personal files are saved locally, not uploaded.
- `sw.js`: versioned, explicit public/study app-shell caching; network-first page/content refresh and offline study reloads. API replies, Authorization requests, admin pages, runtime Firebase config and arbitrary responses are not cached.
- Session/request guards clear authenticated content and ignore delayed replies when accounts change or sign out. These UI protections supplement, never replace, server authorization.

## Private setup and release boundaries

No live credentials are needed for local study or tests. Before any live integration, review the existing Firebase project and Neon schema; use disposable staging fixtures, never real student work.

1. Copy `backend/.env.example` to the ignored `backend/.env`. Supply `DATABASE_URL`, `FIREBASE_PROJECT_ID`, and matching `FIREBASE_SERVICE_ACCOUNT_JSON` privately. Do not paste values in chat or commit them. Database connections enforce TLS certificate/hostname validation.
2. Put the Firebase **Web** `apiKey` in `firebase/firebase-config.mjs` (Project settings → Your apps → Config). That file is what the sign-in page loads, including on the published site. The other `fire-counsel` fields are already filled in. A Web API key is public app identification, not an admin credential. Never put a service-account key, OAuth client secret, or Gemini key there. Google sign-in is already implemented on `/auth.html`; it stays hidden until this key is real. Add the site hostname under Authentication → Settings → Authorized domains, keep the Google provider enabled with a support email, and if the Google Cloud OAuth consent screen is in Testing, add the Google account as a test user.
3. Verify Auth providers, authorized domains, App Check, deployed rules and the intended administrator UID/claim in the actual Firebase project. A Google account, an email address or a browser-supplied role does not grant administrator permission.
4. Pass local Firestore/Storage emulator tests and review existing deployed rules before considering any deployment. Proposed rules are not deployed by this repository's tests.
5. Review `backend/migrations/001_student_profiles.sql` against the actual Neon schema and manually apply it only to disposable staging. Keep `STUDENT_PROFILES_ENABLED=false` until ready, then enable and test profile/installation authorization. No migration runs at startup. Optional trusted proxy IPs/CIDRs require a separate ingress/header review; the default ignores forwarded IPs.
6. Test real staging registration/Google, verification/reset/change-email delivery, password changes, second-installation denial, admin authorization, Neon CRUD, access scopes and retrieval end to end. Mocks and PGlite do not verify these live services. Review the lockout/recovery policy before real-user rollout.

Backend endpoint/security details are in [backend/README.md](backend/README.md); the reviewed schema reference is [backend/DATABASE_SCHEMA.md](backend/DATABASE_SCHEMA.md). Firebase setup and proposed rules are documented in [firebase/README.md](firebase/README.md).

## Existing study data and preview settings

The student database deliberately retains **`lexmaster-ai-stage1`**, version **1**, stores **`documents`, `cards`, `settings`**, and counter **`lexmaster-sessions`**. No study-store migration, deletion or localStorage clearing is performed. The independent `fire-counsel-installation-v1` marker persists across sign-out; clearing it can lock the student profile to a lost installation. Automated browser tests seed and verify disposable legacy records; they do not inspect anyone's real browser profile. Local study data is shared by accounts using that browser, not encrypted or separated by Firebase UID; sign-out does not hide/delete it. Clearing browser site data can delete local work and the account installation marker, so keep independent backups.

Website drafts use `fire-counsel-site-draft-v1`. Quota/account examples use `fire-counsel-admin-quota-preview-v1`. They are local previews only, with synthetic account IDs. None publishes the site globally or enforces a student's allowance.

The Gemini key field, AI/OCR operations, slideshow cloud uploads/deletes, quotas, administrative account adjustments, payments and public JSON publishing remain disabled. Students' own profile/security edits are implemented separately. Never paste provider keys into a static page, localStorage, site JSON, Firestore documents or chat.

## Product decisions retained

- Adults-only (18+) audience and Gemini were selected, but age verification and provider/privacy approval are not active. Do not use Gemini Free for student work.
- The project owner previously confirmed the existing Firebase Blaze plan; no billing change or Firebase deployment is made here. Proposed Storage rules cover public slide reads and admin-claim-only writes, a 10 MiB per-file limit and no photo-count cap. This is not a spending limit or a live upload feature.
- Administrator-chosen Free/paid per-feature counts, reset periods and individual adjustments are previews only. No preset live quotas are imposed.
- Archived questions must be exact verified questions, not generated variants. New practice scenarios must be separately labelled and grounded in approved material.
- Nigeria was selected, but additional jurisdictions and school-approved source domains remain to be specified. External legal-web fallback stays off.
- Paystack and the supplied ₦2,000 price remain future choices; paid-plan duration and activation are unresolved and disabled.
- A one-browser-installation-per-profile policy is implemented behind the staging setup gate. A different installation cannot reuse the existing profile; there is no automatic transfer or self-service recovery. IP changes do not create an account. A PWA cannot reliably identify physical hardware, and the marker can be cleared/copied; do not describe this as physical-device attestation. Review the lockout consequences before real-user rollout.

Brand artwork, photograph credits and source links are in [assets/images/README.md](assets/images/README.md). No live Firebase/Neon writes, rule deployment, account creation, admin-claim change, AI call, cloud upload/delete, payment, billing change or deployment was performed during the local status check.
