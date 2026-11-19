# FIRE COUNSEL — status and verification report

**Latest update:** 18 November 2026 (UTC), branch `arena/3619f8a2-fire-counsel`

## Firebase publishing and missing runtime keys

- Live read-only inspection of `https://fire-counsel-2.onrender.com/api/health` confirmed database `connected`, both Groq/Tavily flags `false`, and service name `fire-counsel-2`. This is a runtime-presence check, not provider authentication. The source already accepts nonempty unprefixed Tavily keys; it does not require `tvly-`. Render's private settings/group linkage have **not** been inspected or changed.
- Added secret-free canonical setting states (`missing` / `empty` / `present`), diagnostic version and Render commit SHA to health output. The existing per-provider admin test remains the way to check actual credentials/quota. [DEPLOYMENT.md](DEPLOYMENT.md#5-groqtavily-still-show-false-after-saving-keys) distinguishes linked groups, service-level overrides, secret files, GitHub secrets and a successful **Live** deployment; a new environment group is not inherently needed.
- Fixed a reproduced Firestore read bug: required `updatedAt`/`updatedBy` metadata was rejected as unsupported editor fields, so valid published documents disappeared on read. Only those two metadata fields are now removed on reads; unknown sections still fail.
- Aligned the optional public `workspace` map across client validation and rules, tightened nested required-field/whitelist preflight to match the rules, and refreshed/checked the Google admin claim before direct publishing. Student owner/admin boundaries and server-owned timestamps remain enforced; no allow-all rule was introduced.
- The first current-branch emulator run exposed a rules-budget bug at the advertised **12 slides / 8 navigation links**: Firestore refused the otherwise-valid document after 1,000 evaluated expressions. The rule validators now cache list lengths/slide field names, combine equivalent image alternatives, and avoid redundant `hasAll` checks while still dereferencing/type-checking every required field. The deployment gate checks the bundled document, full-sized bundled/Storage-image documents, and removal of every required field. Firebase tests use the built-in spec reporter so bounded CI excerpts retain failure details. No slide/navigation cap or authorization/field validation was relaxed.
- Homepage publishing, version restoration and workspace publishing now update the same primary Firestore document before the Neon archive. Both public renderers read that primary channel, with existing fallback/offline behavior. Archive failures accurately report partial success; Firestore failures never become a silent Neon-only publish. A late workspace fallback is session-guarded so it cannot overwrite newer live settings. Shell cache v26 refreshes the changed workspace client without deleting study records.
- The prior migration workflow **44457757369** completed successfully on main `05817f7`; this agent only inspected its status, did not dispatch it, and could not retrieve its downloadable logs. This supersedes the earlier instruction to assume the migration was unrun. The target database URL and table-by-table live results were not inspected.

**Verification:** `npm test` passed: syntax **104** modules, frontend **70/70**, backend **146/146**, proxy **14/14**, Firebase local **13/13**. The new client regressions first reproduced metadata rejection and missing claim/session preflight. Initial full Chromium run: **42/44**, exposing the late-workspace-fallback race and a profile reload assertion that sampled before rehydration. The race is now guarded and covered by a deliberately reordered-response test; profile reload now waits for the actual new-document profile response on the foreground page. Focused checks **3/3** passed after those fixes; the subsequent complete Chromium suite passed **45/45** with retries disabled. Local rule execution is blocked by missing Java; the current branch's **Firestore and Storage rules deployment gate** in GitHub Actions must pass before deployment (it exercises **9 security-rule scenarios**, plus the local suites it reruns). The earlier merged rule gate alone does not verify this change. No sleeps, skipped cases, relaxed assertions or whole-test retry setting were added.

**Live deployment boundary:** no Firebase rules/claims, Render settings or credentials were changed. Publish the complete maintained `firebase/firestore.rules` in **Firestore Database → (default) → Rules**; `firebase/storage.rules` belongs separately in **Storage → Rules**. Deploy the matching app code as well. Publishing rules does not grant `admin: true`; the Google administrator must use the protected `ADMIN_EMAILS` bootstrap/refresh flow. See [DEPLOYMENT.md](DEPLOYMENT.md#6-manually-publish-the-firebase-rules).

## Previously merged access rollout (18 November 2026)

Branch `arena/d4df7fc6-fire-counsel`, merged through PR #25. The verification and deployment notes in this subsection are historical; the current findings above supersede them.

**Access and paywall changes that round:**
- Sign-in is **Google-only** (`auth.html` has no email/password form or unsigned-continue link) and the button carries the official four-colour Google logo (inline SVG, offline-safe).
- Locked pages (`study.html` workspace **and** `ai.html` AI studio) no longer render for signed-out visitors: a shared lock screen (`auth-gate.mjs`) hides the page until Firebase Auth confirms an account, and sign-out locks again instantly. A browser that has signed in before keeps its local study tools offline; a fresh browser must sign in online once. Server data was never exposed either way — every API route requires a verified Firebase token. The public homepage, the auth page and published student pages stay public; the admin page keeps its own server-verified admin gate.
- AI features are now a premium plan, enforced server-side: `ai_user_limits.premium` (migration `005_premium.sql`, admin-granted in Admin → Users & AI limits) is checked inside `reserveUsage`, so free accounts get `403 PREMIUM_REQUIRED` before any AI spend and cannot enable it from a browser. `/api/v1/ai/me` exposes the flag; the AI studio shows a free-plan notice and locks its composer.
- Google-only is enforced beyond the UI: verified API tokens and proposed Firestore/Storage rules require `firebase.sign_in_provider == "google.com"`, including for admins. Password/custom/anonymous sessions cannot use protected APIs or writes even when the account has a linked Google identity.
- Admin → **Users & AI limits** lists Firebase accounts (including zero-use students), Active/Offline status and today's per-feature usage. API tests now verify day/failed-request filtering; a browser test covers the list, search, effective limits, and clearing it on sign-out while ignoring a delayed refresh.
- **Owner guide:** [DEPLOYMENT.md](DEPLOYMENT.md) has the exact `NEON_API_KEY` secret / `NEON_PROJECT_ID` variable / `DATABASE_URL` secret and migration-workflow steps. The Neon management API 401 is still an owner credential/configuration issue; this session cannot inspect repository secret settings.
- **Deploy step required:** run the Neon migration workflow (Actions → "Neon database migration") so the `premium` column exists before using the admin premium toggle; without it, reads simply report every account as free.

**Latest verification (18 November):** `npm test` passed — frontend **63/63**, backend **144/144**, proxy **14/14**, Firebase local **10/10**; syntax **102** modules. Chromium browser suite **41/41** passed locally with external services blocked and whole-test retries disabled. The extra layout regression deliberately creates overflow, requires the real width check to fail, then requires it to pass when the box fits; no clipping CSS, relaxed width threshold or assertion timeout increase. Layout checks observe render frames on the foreground page, and the preserved-data test uses the actual mobile menu rather than a native fragment navigation during resize. The Java-enabled Firestore/Storage gate passed on `5f38a00`, including **8 security-rule scenarios** and the local suites it reruns. These are synthetic/emulator checks, not live project verification. The updated rules still require owner review and deployment.

## Historical baseline (15 November 2026)

The sections below record the earlier review. The latest access/Google-only/admin-usage changes above supersede its older email-registration, unsigned-local-access and disabled-AI descriptions.

**Checked:** 15 November 2026 (UTC)

**Branch:** `arena/15cb68b6-fire-counsel`

**Scope:** code review/repairs, self-service student profiles and installation authorization, dependency checks, local SQL/API/proxy tests, synthetic browser tests, GitHub Actions demo-project rule emulators and local preview. No live-project verification or deployment.

## Results

| Check | Result | What this establishes |
| --- | --- | --- |
| Backend tests | **62/62 passed** | Firebase verification, profile SQL/migration against in-memory PGlite, UID/installation/status isolation, first-binding races/rollback, stale-email and unknown-field rejection, content authorization, allowlisted CRUD/text versions, readiness, CORS and JSON limits |
| Frontend / service-worker / request-state / CI-reporting tests | **40/40 passed** | Actual Auth/API helper logic against a stub SDK, installation persistence/storage failures, DOM/assets, navigation, cache boundaries, stale-session guards and failure-reporting exit-code preservation |
| Python preview/proxy tests | **14/14 passed** | Restricted files/assets, API methods/auth/installation headers, replacement of client IP assertions, body/framing limits, HEAD and unavailable-upstream responses |
| Legacy study-data compatibility checks | **3/3 passed** | Existing IndexedDB identity/version/stores, localStorage key and non-destructive cache cleanup remain intact |
| Headless Chromium browser tests | **27/27 passed** | Existing public/local/offline/admin flows plus registration, Google-prefilled profile creation, consent, safe name edits, Firebase security UI, changed-installation denial, delayed profile replies, preserved local records and responsive profile states |
| JavaScript/Python syntax | **Passed** | 52 JavaScript modules plus Python development/test tools parse successfully |
| `git diff --check` | **Passed** | No patch whitespace errors |
| Firebase Firestore/Storage rule scenarios | **6/6 passed in GitHub Actions** | Java 21 demo-project emulators exercised actual public/admin/student access rules, slide type/size/path restrictions, denied deletions preserving bytes, and successful admin deletion. Java remains unavailable in this sandbox; this is a CI emulator pass, not live-project verification. |

**Local regression tests: 146 passed** (`npm test`: 119; browser: 27). **Six additional security-rule scenarios passed in CI**, for **152 distinct checks** across those suites. The emulator command also reruns the three compatibility tests already counted above. All live Firebase/Neon checks remain unverified.

Browser tests use isolated disposable profiles, synthetic users and stubbed authenticated replies. External browser requests are blocked. They do not validate real Firebase tokens, create accounts, send reset email, connect to Neon, or access anyone's existing browser profile.

## GitHub Actions failures corrected

- **Storage download comparison:** Firebase `getBytes()` returns an ArrayBuffer, not an iterable. Tests now compare its byte length and Uint8Array contents.
- **Deleted public objects:** `assertFails()` is for permission denials, not `storage/object-not-found`. The suite still requires student and anonymous deletion denials, verifies that the original bytes remain, then requires admin deletion and the exact missing-object error. The rules themselves were not changed.
- **Responsive-layout timing:** the mobile browser assertion sometimes read the new viewport while footer styles retained the preceding desktop layout. A new regression reproduces profile loading, consent, security and signed-out states at 320, 390, 768 and 1024 pixels, including a 120-character name. A web-first layout assertion waits for the actual width condition; persistent overflow still fails with element bounds. No arbitrary sleeps, skipped tests or whole-test retries were added.
- **Unavailable downloadable logs:** `tools/ci_check.sh` preserves command/tee failures while publishing bounded excerpts in check annotations and step summaries. Three local tests cover success, nonzero exit propagation, escaping and output limits.

## Regressions found and corrected

1. **Unloaded integration modules.** The checked-out student/admin HTML did not mount the existing Auth, database, approved-materials and source-search modules or contain their required UI targets. The pages now include those sections, modules and styles. Database controls remain locked without server authorization and database readiness.
2. **Failing compatibility assertion and incomplete offline boundaries.** A test expected shell v10 while the worker was v6. The cache is now v12 (including the new profile/installation UI modules), the compatibility test checks the versioned naming contract rather than a stale exact number, and behavioral tests cover cache cleanup. Only the explicit public/study shell is cached; API, admin and runtime-config responses bypass it. Offline scripts no longer receive a homepage HTML fallback.
3. **Unrestricted admin preview server.** The old separate helper used a general directory server. It now shares the restricted frontend file allowlist and same-origin API proxy. Backend files, `.env`, Git metadata, package files, tests and rules are not served.
4. **Hidden Auth controls displayed by CSS.** Author styles overrode the browser's hidden behavior, exposing a disabled Continue control after admin denial. Hidden Auth elements now remain hidden, with browser coverage.
5. **Wrong initial slideshow count.** The public page retained its static three-slide count despite loading two JSON slides. The count now initializes from the rendered slides, including under reduced motion.
6. **Stale authenticated content.** Session/request guards clear restricted UI content on sign-out/account changes and reject delayed replies. Browser tests exercise pending material, search, admin-permission and admin-record requests. Admin pagination also respects the actual record count.
7. **Misleading input-error responses.** Malformed JSON and oversized bodies now return 400/413 instead of generic 500 responses. API replies are explicitly no-store, and readiness does not report a false database check as connected.
8. **Stale documentation and links.** README/setup instructions now describe the actual protected content routes and safe server, distinguish local tests from live verification, retain disabled-feature boundaries, and correct student-footer links.

## Student profile feature added

- Students can register with Firebase email/password or Google, then create and edit their own profile at `/study.html#profile`. Google supplies available name/email/photo; passwords remain Firebase credentials. No course, membership, payment or admin approval is required or granted.
- Profile creation explicitly confirms the browser-installation policy. Only the caller's UID-scoped profile can be read/edited; server-controlled email is fetched from Firebase Admin. Unknown identity/password/role/status/course/IP JSON fields are rejected. Existing edited names survive Google sign-in and unrelated admin content writes.
- `backend/migrations/001_student_profiles.sql` adds an installation table to the existing `app_users` model. It has **not been applied to Neon**. `STUDENT_PROFILES_ENABLED` defaults off; startup never migrates. Missing configuration/schema fails closed and partial profile/binding writes roll back.
- The installation marker is persistent random browser state, hashed per UID on the server. A different installation cannot read/edit/rebind an existing profile or use protected student material/search APIs. A copied marker plus a valid session can defeat a browser lock; this is **not hardware attestation**. Lost/cleared site data, private browsing, another browser or a changed hosting origin can lock the profile out. No self-service transfer/recovery exists; approve those consequences before real-user rollout.
- The latest observed connection IP is separate security metadata, not a device identifier. Only an explicitly configured trusted proxy list can affect forwarded-IP handling; otherwise the API records its peer. Arena's peer may be a gateway, not the student's public IP. No arbitrary JSON/header IP or external lookup is trusted, and an IP change does not create a new account.
- Firebase email verification, reauthenticated verification-before-email-change, password changes for password-backed accounts, and generic reset-email UI are implemented locally. Google-only accounts never expose or invent a Google/Firebase password. Unverified users can edit basic profiles but not protected student content.
- Profile details never enter browser persistence or service-worker caches. Legacy study stores and the separate installation marker survive profile edits/sign-out. Local study remains browser-scoped, not a per-account encrypted vault.

See [backend/STUDENT_PROFILES.md](backend/STUDENT_PROFILES.md) for the exact flow, API contract, proxy/IP limitations, migration review and remaining staging checks. Local tests use a synthetic identity model and in-memory PostgreSQL; they do not establish compatibility with the actual Neon schema or real Google/Firebase behavior.

## Firestore direct-write content and student pages (18 November 2026 update)

- `firebase/firestore.rules` now covers two browser-written collections in addition to the server-only ones. `siteContent/public` accepts writes only from the server-issued `admin: true` claim, with the full homepage shape validated in-rule: exact top-level sections, 1–12 fully-checked slides, bounded text fields, safe link patterns (site-relative/anchor/https only) and images confined to bundled assets, Neon `/media/` uploads or this bucket's `site/slides/` folder. `updatedAt` must be the server timestamp and `updatedBy` the caller's UID. Delete stays server-only.
- `studentPages/{uid}` is a new owner-written public page: exact key set (`displayName`, `headline`, `bio`, `links`, `focusAreas`, `published`, `createdAt`, `updatedAt`), bounded fields, https-only links, `createdAt` immutable after creation. Public `get` succeeds only for `published: true`; `list` is admin-only. The private Neon profile and its `/api/v1/profile` contract are unchanged.
- `firebase/content-schema.mjs` mirrors the rule limits in JavaScript for pre-write validation and read-side checks; `firebase/firestore-client.mjs` (Firestore Lite) implements public content load, admin publish, and student page load/save. The homepage reads Firestore first with a 2.5 s cap and falls back to the bundled JSON; the admin publish writes Firestore first and still archives each version in Neon, with a partial-failure message if only the history save fails.
- New `student.html` + `student-page-view.mjs` render a published page unauthenticated, escaping all text and re-validating link protocols; the editor card lives in `study.html` (`student-page.mjs`). Both files were added to the restricted static allowlists in `tools/dev_server.py` and `backend/src/website.js`.
- Auth review: the error mapping moved into `firebase/auth-errors.mjs` and now also covers `auth/user-disabled`, `auth/invalid-email`/`auth/missing-email` and `auth/requires-recent-login`; `auth-client.mjs` exposes `hasAdminClaim()` for UI gating (rules remain the enforcement).
- Local gates rerun: frontend/wiring/auth suites **35/35**, Firebase local suite (compat + content-schema) **10/10**, Python proxy suite **14/14**, syntax check 99 modules. The rules suite was extended to 8 scenarios (validated admin publish, forged metadata, unsafe slide image/link, student-page ownership/publish/immutability and list-denial) — it still needs the Java-enabled GitHub Actions emulator job; Java is absent from this sandbox. **The new rules are not deployed**, so live publishes/saves fail closed with permission errors until the owner deploys them after review.

## Current integration status

| Area | Status / remaining work |
| --- | --- |
| Public homepage | Implemented and locally/browser tested. Additional jurisdiction and school-approved legal-link domains are still undecided. |
| Local study tools | Implemented and browser tested. Personal documents, cards, subjects and focus-session counter stay local. Existing storage identifiers are unchanged. |
| Same-origin API | Runs without external credentials. `/healthz` is liveness only; `/api/health` correctly returns **503 / `not_configured`** without Neon. Anonymous protected requests return 401. |
| Firebase browser configuration | `firebase/firebase-config.mjs` is loaded by the sign-in page. Project IDs are filled in. The Web API key is still the placeholder, so live Google/email sign-in cannot succeed until that public key is pasted from Project settings. |
| Firebase Admin configuration | `FIREBASE_PROJECT_ID` and `FIREBASE_SERVICE_ACCOUNT_JSON` are not supplied in the local environment. No server-side Firebase connection is verified. |
| Firebase registration/sign-in and security | Code/SDK-stub/browser tests pass. Real registration, Google/redirect/reauthentication, verification/reset/change-email delivery, password policy and security updates remain **unverified**. |
| Student-owned profiles | Implemented and locally tested; independent of courses/payments/admin. Migration is proposed only, default enable flag is off, and live identity/profile provisioning remains unverified. Strict lost-installation lockout/recovery consequences still need rollout approval. |
| Administrator access | API requires Firebase verification and the exact server-issued `admin: true` claim. No claim is granted here; live claims and the intended UID remain unverified. The page itself is not a security boundary. |
| Neon connection/schema | `DATABASE_URL` is absent. No live Neon reads/writes, schema compatibility, memberships, CRUD or full-text search have been verified. Profile SQL/migration tests use in-memory PGlite with known identity columns; other SQL/UI tests use injected providers/stubs. |
| Academic content | Allowlisted content CRUD and pasted-text versions/chunks are implemented. Academic-material **file uploads are not implemented**. |
| Student materials/search | Verified email + active bound profile now precede existing approved/published/institution/enrollment checks. Disabled/unreviewed profile setup blocks these APIs instead of bypassing the device restriction. All live access/retrieval still needs disposable staging testing. No AI/external search runs. |
| Firestore/Storage rules | Six security-rule scenarios passed in Java 21 GitHub Actions demo-project emulators; the suite now adds validated admin `siteContent` publishing and owner-gated `studentPages` scenarios for the next run. Java remains absent locally. The live settings/current rules have not been reviewed and nothing was deployed. |
| AI/Gemini, OCR and quotas | Provider key entry and operations remain disabled. No provider calls or quota enforcement. |
| Slideshow uploads/deletes | Browser-local temporary photo previews only; no cloud upload/delete. |
| Accounts/payments/publishing | Account adjustments are synthetic local drafts only. No account listing, administrator-set passwords, payment/activation or global publishing endpoint. Students' own Firebase security/profile flows are implemented separately; administrator account adjustment remains disabled. |
| Deployment | Render blueprint remains staging-only; nothing deployed. No real student data, prompts, payments or production secrets should be configured on Render Free. |
| GitHub checks | **Both jobs passed** for code commit `2931160` in [run 43781545600](https://github.com/VICTORIOUS-TECH-001/Fire-counsel-/actions/runs/43781545600): local/API/proxy/browser/audits and Java-enabled Firestore/Storage emulators. Branch-protection settings have not been reviewed; a green run does not authorize deployment or merge. |

## Dependency audit

- **Root browser/test tooling:** `npm audit` reports **0 vulnerabilities**.
- **Backend (including the pinned PGlite test dependency):** `npm audit` reports **0 vulnerabilities**.
- **Firebase development tooling:** `npm audit` reports **10 moderate**, **0 high**, **0 critical** advisories. Affected paths involve the CLI's OpenTelemetry, glob/minimatch, archiver and gaxios/uuid dependencies. These are test/development tools, not a newly enabled production feature.
- `npm ls` also identifies **three inherited `glob@14.0.6` resolutions outside their dependants' declared ranges** in the Firebase lockfile (`firebase-tools`, `exegesis`, `rimraf`). `npm ci` succeeds, but that does not establish compatibility.
- Those Firebase dependency issues are **not resolved** in this pass. No forced major-version downgrade/override was applied. The Java-enabled emulator pass establishes the tested scenarios, not dependency remediation. Review the upstream graph, choose supported patched versions, then rerun all gates before trusting the toolchain for deployment. The workflow reports moderate audit warnings and fails on high/critical audit findings; it is not an assertion of a clean Firebase audit.

## Reproduce

Install the three locked dependency sets listed in README first, then:

```bash
npm test
npm run test:browser
npm run test:rules       # currently blocked here: Java is missing
# Or run every gate, stopping on any failure/blocker:
npm run test:all
```

Start the local API with `npm --prefix backend start` and the restricted website with `npm run dev`. Use `/study.html` for the student workspace or `/admin.html` for the studio. Do not serve this repository with an unrestricted directory server.

## Next release gates

1. Resolve Firebase toolchain dependency warnings and rerun all gates after dependency changes. Both CI jobs now pass; action-runtime deprecation/runner-image warnings remain maintenance work, not live-project approval.
2. Review the existing Firebase project settings, current deployed rules/App Check, authorized domains/providers and intended administrator UID/claim. Review the real Neon schema before connecting it.
3. Supply credentials **privately** in ignored local/backend configuration or a trusted staging secret store. Never paste keys, service-account JSON or database URLs into chat.
4. Review and manually apply the proposed student-installation migration only to disposable staging, then enable profiles there. Test real registration/Google, profile creation/editing, email verification/change/reset, password changes, first binding and second-installation denial, suspended/revoked users, admin denial, Neon CRUD/rollback, content access and search. Review ingress/IP provenance and lockout/recovery behavior. Confirm personal browser study data remains unchanged.
5. Keep AI, uploads, quotas, administrative account management, automatic device transfers, payments and production deployment disabled until their authorization, privacy/provider terms and integration tests are settled.

Implementation and CI fixes were committed and pushed to the working branch as requested. No live Firebase/Neon write, schema migration, rule deployment, admin-claim change, real account creation, provider-key setup, AI request, cloud upload/delete, payment, billing change, merge or deployment was performed. Emulator writes used only disposable demo-project fixtures.
