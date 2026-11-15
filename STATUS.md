# FIRE COUNSEL — status and verification report

**Checked:** 15 November 2026 (UTC)

**Branch:** `arena/15cb68b6-fire-counsel`

**Scope:** code review/repairs, self-service student profiles and installation authorization, dependency checks, local SQL/API/proxy tests, synthetic browser tests and local preview. No live-project verification or deployment.

## Results

| Check | Result | What this establishes |
| --- | --- | --- |
| Backend tests | **62/62 passed** | Firebase verification, profile SQL/migration against in-memory PGlite, UID/installation/status isolation, first-binding races/rollback, stale-email and unknown-field rejection, content authorization, allowlisted CRUD/text versions, readiness, CORS and JSON limits |
| Frontend / service-worker / request-state tests | **37/37 passed** | Actual Auth/API helper logic against a stub SDK, installation persistence/storage failures, DOM/assets, navigation, cache boundaries and stale-session guards |
| Python preview/proxy tests | **14/14 passed** | Restricted files/assets, API methods/auth/installation headers, replacement of client IP assertions, body/framing limits, HEAD and unavailable-upstream responses |
| Legacy study-data compatibility checks | **3/3 passed** | Existing IndexedDB identity/version/stores, localStorage key and non-destructive cache cleanup remain intact |
| Headless Chromium browser tests | **26/26 passed** | Existing public/local/offline/admin flows plus registration, Google-prefilled profile creation, consent, safe name edits, Firebase security UI, changed-installation denial, delayed profile replies and preserved local records |
| JavaScript/Python syntax | **Passed** | 51 JavaScript modules plus Python development/test tools parse successfully |
| `git diff --check` | **Passed** | No patch whitespace errors |
| Firebase Firestore/Storage rules suite | **BLOCKED — not passed** | Emulator startup stops because Java is unavailable. The six security-rule scenarios have not executed here. |

**Total runnable regression tests: 142 passed.** This excludes the blocked security-rule scenarios and all live Firebase/Neon checks.

Browser tests use isolated disposable profiles, synthetic users and stubbed authenticated replies. External browser requests are blocked. They do not validate real Firebase tokens, create accounts, send reset email, connect to Neon, or access anyone's existing browser profile.

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

## Current integration status

| Area | Status / remaining work |
| --- | --- |
| Public homepage | Implemented and locally/browser tested. Additional jurisdiction and school-approved legal-link domains are still undecided. |
| Local study tools | Implemented and browser tested. Personal documents, cards, subjects and focus-session counter stay local. Existing storage identifiers are unchanged. |
| Same-origin API | Runs without external credentials. `/healthz` is liveness only; `/api/health` correctly returns **503 / `not_configured`** without Neon. Anonymous protected requests return 401. |
| Firebase browser configuration | Ignored `firebase/firebase-config.local.mjs` is absent in this checkout. Pages show setup notices without disabling personal study tools. |
| Firebase Admin configuration | `FIREBASE_PROJECT_ID` and `FIREBASE_SERVICE_ACCOUNT_JSON` are not supplied in the local environment. No server-side Firebase connection is verified. |
| Firebase registration/sign-in and security | Code/SDK-stub/browser tests pass. Real registration, Google/redirect/reauthentication, verification/reset/change-email delivery, password policy and security updates remain **unverified**. |
| Student-owned profiles | Implemented and locally tested; independent of courses/payments/admin. Migration is proposed only, default enable flag is off, and live identity/profile provisioning remains unverified. Strict lost-installation lockout/recovery consequences still need rollout approval. |
| Administrator access | API requires Firebase verification and the exact server-issued `admin: true` claim. No claim is granted here; live claims and the intended UID remain unverified. The page itself is not a security boundary. |
| Neon connection/schema | `DATABASE_URL` is absent. No live Neon reads/writes, schema compatibility, memberships, CRUD or full-text search have been verified. Profile SQL/migration tests use in-memory PGlite with known identity columns; other SQL/UI tests use injected providers/stubs. |
| Academic content | Allowlisted content CRUD and pasted-text versions/chunks are implemented. Academic-material **file uploads are not implemented**. |
| Student materials/search | Verified email + active bound profile now precede existing approved/published/institution/enrollment checks. Disabled/unreviewed profile setup blocks these APIs instead of bypassing the device restriction. All live access/retrieval still needs disposable staging testing. No AI/external search runs. |
| Firestore/Storage rules | Local proposals only; no emulator pass, current-live-rule review or deployment. Java 21+ and emulator download access are required. |
| AI/Gemini, OCR and quotas | Provider key entry and operations remain disabled. No provider calls or quota enforcement. |
| Slideshow uploads/deletes | Browser-local temporary photo previews only; no cloud upload/delete. |
| Accounts/payments/publishing | Account adjustments are synthetic local drafts only. No account listing, administrator-set passwords, payment/activation or global publishing endpoint. Students' own Firebase security/profile flows are implemented separately; administrator account adjustment remains disabled. |
| Deployment | Render blueprint remains staging-only; nothing deployed. No real student data, prompts, payments or production secrets should be configured on Render Free. |
| GitHub checks | No existing PR or workflow runs were found for this working branch during the check. A local/browser workflow and separate Java-enabled emulator job were added; their remote execution and branch-protection status are **not verified**. |

## Dependency audit

- **Root browser/test tooling:** `npm audit` reports **0 vulnerabilities**.
- **Backend (including the pinned PGlite test dependency):** `npm audit` reports **0 vulnerabilities**.
- **Firebase development tooling:** `npm audit` reports **10 moderate**, **0 high**, **0 critical** advisories. Affected paths involve the CLI's OpenTelemetry, glob/minimatch, archiver and gaxios/uuid dependencies. These are test/development tools, not a newly enabled production feature.
- `npm ls` also identifies **three inherited `glob@14.0.6` resolutions outside their dependants' declared ranges** in the Firebase lockfile (`firebase-tools`, `exegesis`, `rimraf`). `npm ci` succeeds, but that does not establish compatibility.
- Those Firebase dependency issues are **not resolved** in this pass. No forced major-version downgrade/override was applied without an emulator run. Review the upstream dependency graph, choose supported patched versions, then rerun Java-enabled rules tests before trusting the toolchain for deployment. The workflow reports moderate audit warnings and fails on high/critical audit findings; it is not an assertion of a clean Firebase audit.

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

1. Resolve Firebase toolchain dependency warnings; run the rules suite in Java 21+ and confirm the new CI jobs actually pass.
2. Review the existing Firebase project settings, current deployed rules/App Check, authorized domains/providers and intended administrator UID/claim. Review the real Neon schema before connecting it.
3. Supply credentials **privately** in ignored local/backend configuration or a trusted staging secret store. Never paste keys, service-account JSON or database URLs into chat.
4. Review and manually apply the proposed student-installation migration only to disposable staging, then enable profiles there. Test real registration/Google, profile creation/editing, email verification/change/reset, password changes, first binding and second-installation denial, suspended/revoked users, admin denial, Neon CRUD/rollback, content access and search. Review ingress/IP provenance and lockout/recovery behavior. Confirm personal browser study data remains unchanged.
5. Keep AI, uploads, quotas, administrative account management, automatic device transfers, payments and production deployment disabled until their authorization, privacy/provider terms and integration tests are settled.

No live Firebase/Neon write, schema migration, rule deployment, admin-claim change, account creation, provider-key setup, AI request, cloud upload/delete, payment, billing change, commit, push or deployment was performed for this verification pass.
