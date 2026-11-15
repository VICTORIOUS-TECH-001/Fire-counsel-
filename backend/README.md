# FIRE COUNSEL Backend — staging foundation

The backend is an Express API intended for a disposable Render Free staging deployment. Keep real student data, AI prompts, payments and production admin operations out of staging.

## Stack

- Node.js 22+
- Express
- Neon PostgreSQL connection module (not required by the liveness endpoint)
- Firebase Admin SDK for verifying Firebase ID tokens/trusted custom claims and retrieving current profile identity
- Additive, manually reviewed student-installation migration; in-memory PGlite only for SQL regression tests
- Helmet, explicit CORS allowlist, JSON body limit and rate limiting
- `src/app.js` app factory for isolated HTTP tests; `src/server.js` binds the running API
- No-store API responses, explicit 400 malformed-JSON and 413 oversized-body responses

## Local setup

1. Install Node.js 22 or newer (required by the Firebase Admin SDK version in this backend).
2. From this directory, run `npm install`.
3. Copy `.env.example` to `.env` (the local `.env` is Git-ignored).
4. When ready to test Neon connectivity, put the Neon pooled URL in `DATABASE_URL` in that local `.env`; the API enforces TLS certificate and hostname validation. Do not paste the URL into chat or commit it.
5. After reviewing the Firebase project, set `FIREBASE_PROJECT_ID` and the matching `FIREBASE_SERVICE_ACCOUNT_JSON` in the ignored `.env` or host secret manager.
6. Set `CORS_ORIGINS` to the exact approved frontend origins. Leave `STUDENT_PROFILES_ENABLED=false` until reviewing the live schema and profile migration on disposable staging. See [STUDENT_PROFILES.md](STUDENT_PROFILES.md). Leave `TRUSTED_PROXY_CIDRS` empty unless the actual ingress has been reviewed; untrusted forwarding headers never determine a student IP.
7. Run `npm run check`, `npm test`, then `npm run dev`.
8. In a separate repository-root terminal, run `npm run dev` (or `python3 tools/dev_server.py`) for the restricted frontend server and same-origin API proxy. Do not serve the repository with an unrestricted static directory server.

Never put Firebase Admin credentials or a Gemini key in the browser, Git, Firestore documents or site JSON. Firebase Web configuration is intentionally browser-readable app identification, not an administrator credential; this project keeps its local Web configuration file Git-ignored by policy.

## Endpoints

- `GET /healthz` — process liveness check for Render. Does not require Firebase or a database.
- `GET /api/health` — database readiness check. Returns degraded when PostgreSQL is not configured or unavailable.
- `GET /api/v1/me` — requires a valid, non-revoked Firebase ID token. Returns only the caller's UID, email, email-verification status and a display role derived from the verified `admin` custom claim.
- `GET /api/v1/profile`, `POST /api/v1/profile`, `PATCH /api/v1/profile` — self-service read/create/sync/name edit for the verified Firebase UID and its registered browser installation. Google supplies available initial details; Firebase Admin supplies current email. Creation requires policy acceptance and a recent sign-in. No enrollment, plan, payment or admin permission is required or granted. Passwords and email changes are Firebase client operations, never Neon profile fields. [API contract and staging migration](STUDENT_PROFILES.md).
- `GET /api/v1/admin/me` — requires the same verified token plus `admin: true`; a role supplied by the browser is ignored.
- `/api/v1/admin/database/catalog` and `/api/v1/admin/database/:resource` — Firebase-verified administrator catalog/list/create/edit/delete operations for an explicit allowlist of academic/legal content tables. Values are parameterized, relation IDs must be UUIDs, unknown columns/tables are rejected, and delete requires an explicit confirmation. Universities/courses/topics/materials are deactivated or unpublished where the schema supports it; other content deletions follow the exported foreign-key cascade rules.
- `POST /api/v1/admin/database/materials/:id/versions` — stores a pasted text version and plain-text chunks in Neon; version/chunk rows are created transactionally. It does not upload files, create embeddings, or call an AI provider.
- `GET /api/v1/admin/database/materials/:id/versions` — administrator-only version history.
- `GET /api/v1/materials` and `GET /api/v1/materials/:id` — Firebase-authenticated, verified-email student reads with an active bound profile, of approved/published Neon materials only, filtered by the exported platform/institution/private access scope and active/completed course enrollment. File-storage paths and embeddings are never returned.
- `POST /api/v1/research/search` — Firebase-authenticated, verified-email and installation-authorized Neon full-text retrieval across accessible material chunks, verified cases/statutes, exact verified past questions, verified mnemonics, approved case summaries and rubrics linked to verified questions. This endpoint does **not** call Gemini or send the query outside FIRE COUNSEL; it returns source records for the future AI pipeline.

Student and administrator sign-in are Firebase Auth client operations. The API verifies the resulting Firebase ID token with Firebase Admin. An administrator must be granted the `admin: true` custom claim by a trusted project owner outside the public client; this repository intentionally has no self-service admin-grant endpoint. Do not issue any admin claim until the target UID and existing project setup have been reviewed.

## Security and staging boundaries

- Firebase Admin credentials must match `FIREBASE_PROJECT_ID`; the server fails closed when either is missing or mismatched.
- Every protected request checks token revocation. Every admin route must use `verifyFirebaseToken` followed by `requireAdmin`.
- Firebase Admin SDK calls bypass Firestore and Storage Security Rules, so server authorization is mandatory on every server write route.
- CORS allows only exact configured origins and the installation header. Do not use `*` for authenticated routes.
- The installation lock is enforced by profile, material and research routes; it is not physical-device identification, an IP lock, or a restriction on Firebase authentication itself. A changed IP is allowed; a different/lost marker is denied without automatic re-binding. No self-service transfer/recovery exists.
- The most recent observed connection IP is security metadata, possibly a proxy/loopback address. Only explicitly trusted proxy IPs/CIDRs affect `req.ip`; do not trust browser JSON, arbitrary forwarding headers or external IP services.
- Resolving an administrator actor never overwrites an existing chosen profile name/email from stale token fields.
- No Gemini provider route, secret, quota persistence, administrative student-account adjustment, image-upload route or payment integration is enabled yet. Add those only after the project and provider authorization/terms are reviewed.
- Render Free is staging only. Do not upload real student data, prompts, payment credentials or production secrets there. A liveness response is not evidence that Firebase, PostgreSQL or Auth is connected.
- Never commit `.env`, Firebase service-account files, database passwords or API keys.

## Firebase project review still required

The supplied browser configuration identifies the `fire-counsel` web app and Storage bucket, but does not confirm Firestore database ID/location, enabled Auth providers, authorized domains, deployed rules, App Check or existing administrator claims. The client sign-in code is present but has not been verified against the live project. Review the Firebase Console settings before live Auth validation, writing to Firestore/Storage or deploying any rules. The local rules remain proposals until they pass Firestore and Storage Emulator tests.
