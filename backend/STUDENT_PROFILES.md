# Student accounts, editable profiles and browser-installation policy

**Implemented locally; not enabled or verified against live Firebase/Neon.** No live migration or account creation was performed. Render Free remains disposable staging only, with no real student data or payments.

## Student flow — no course onboarding

1. Open `/auth.html`. Sign in with Google, sign in with an existing Firebase email/password account, or choose **New here? Create a student account**. Email registration asks only for name, email, password and confirmation. Firebase owns the credentials.
2. A first successful Google sign-in normally creates the Firebase identity and supplies its available name, email and Google photo. It never supplies Google's password. Sign-in alone does not silently bind a browser or create Neon enrollment records.
3. Choose **Set up my student profile** or open **My profile** at `/study.html#profile`. Available name/email are prefilled; a Google image or initials are used. Review the installation warning, check the consent box, then choose **Create my student profile**. First binding requires a Firebase sign-in within five minutes; sign out/in on this browser if that window expires.
4. Edit the saved name with **Save profile**. Your chosen name survives subsequent Google sign-ins and unrelated administrator content writes. There is no institution/course/plan/role selector, payment, or administrator-approval requirement.
5. The security area manages Firebase email/password actions. Email changes require reauthentication and Firebase's verification-before-update email. Finish verification, then **Refresh account** to force a new token and sync the address from Firebase Admin. Password accounts can change their Firebase password after confirming the current password. Google-only accounts instead link to Google security; no Google password is collected, displayed or stored. Verification emails are sent only on the student's explicit request.
6. Unverified-email users may create/edit their own basic profile. Protected student material/search APIs additionally require verified email. Existing institution/course/publication checks still apply to content; creating a profile grants none of those entitlements.

`/api/v1/me` is only Firebase identity/display-role verification, not profile provisioning or installation authorization. Administrator APIs continue to require the verified `admin: true` claim; there is no self-service claim-grant or administrator account-management feature.

## What “device” means here

This is **one browser installation per Firebase-backed student profile**, not reliable physical-hardware identification:

- A cryptographically random 32-byte marker is persisted under localStorage key `fire-counsel-installation-v1`. Web Locks serialize initial creation across tabs where available. There is no hardware fingerprint, IP lookup service, geolocation, or IP-derived device ID.
- Authenticated profile/material/research requests send `X-Fire-Counsel-Installation` to the same-origin API. Neon stores a SHA-256 hash domain-separated by verified Firebase UID, never the raw marker. A marker alone cannot authorize another UID. Both valid Firebase authentication and the bound marker are required.
- Profile creation/registration is one transaction: insert/reuse `app_users`, lock its row, check active status, bind once, sync the Firebase email and save only the latest observed address. Two installations cannot replace each other's first binding. Subsequent reads, name edits, syncs, material reads and source searches enforce the binding server-side; UI hiding is not the boundary.
- A different browser/profile, private session, deleted site data, changed hosting origin or new physical device produces a different installation and is refused for the existing account. It must use a **separate Firebase identity**, not a new profile for the same Google UID/email. Email collisions return 409 rather than merging accounts.
- **There is no self-service device transfer, reset, recovery or delete route.** Losing the marker can permanently block app access under this policy. Do not clear it on sign-out or copy it between devices. Review and approve these lockout consequences and a future recovery policy before any real-user rollout.
- Markers are resettable/copyable browser state, not attestation. Someone possessing both a valid Firebase session and a copied marker may bypass an installation lock. Different browsers on the same phone count as different installations. This feature cannot guarantee physical-device exclusivity.
- The lock protects application profiles and protected student API access. It does not prevent Firebase/Google authentication itself on another device or supersede Firebase's independent credential/reset controls. Administrator content APIs retain their separate claim-based authorization.

## IP address provenance and retention

`last_observed_ip` is the most recent address observed during profile creation/name save/explicit sync, not an immutable identifier or a per-request history. The response labels its source and the UI calls it **Last observed connection IP**. GET does not update this metadata. IP changes never rebind an account.

By default Express trusts **no forwarded headers**. `req.ip` is the connection peer, often a proxy/loopback address. Optional `TRUSTED_PROXY_CIDRS` accepts only explicit proxy IPs/CIDRs, not `true`, names, hop counts, wildcards or `/0`. Set it only after reviewing the actual ingress path and ensuring that those proxies replace client-supplied forwarding headers. A wrong trust list can still allow address spoofing.

The development Python proxy replaces any supplied `X-Forwarded-For` with its own observed connection peer and forwards only the authorization, content, accept and installation headers otherwise. For that helper, trusting `127.0.0.1/32` in the API can expose the helper's observed peer. In Arena that peer may still be an upstream gateway; it is **not verified as the browser's public IP**. Do not copy this proxy setting into an unrelated production topology. An empty trust setting safely records the API peer instead. No client-provided JSON IP, `X-Real-IP`, arbitrary public forwarded header or third-party “what is my IP” service is trusted.

Only the latest IP and first-bound/last-sync timestamps are stored. No IP history or location profile is built. This is still account/security metadata: limit access, avoid logging tokens/markers/passwords and review privacy/retention requirements before production. Local study records remain browser-scoped and can be seen by other accounts using that browser; sign-out intentionally does not delete or encrypt the local vault. Profile responses use an explicit projection and `Cache-Control: no-store`; no profile or credentials are written to localStorage, IndexedDB or service-worker caches.

## Reviewed staging setup — owner action, never automatic

1. Review the existing Firebase project/providers/domains and actual Neon `app_users` definition privately. The schema summary is an offline export, not a live check. Confirm UUID `app_users.id`, unique `firebase_uid` and `email`, profile columns and an allowed `active` account status. New basic profiles receive that server-controlled status explicitly; existing inactive/suspended rows are never reactivated. Take a backup and use a disposable staging database, not production.
2. Review `migrations/001_student_profiles.sql` against that schema. It adds only `student_account_installations`, referencing `app_users`; it changes no roles, memberships, enrollments, billing or private study tables. Apply it manually to staging with the owner's approved database tooling. **Server startup and deployment do not run migrations.** The migration deliberately fails rather than silently accepting an existing, incompatible table.
3. Configure the ignored backend environment and Firebase Web file privately as described in the READMEs. Do not paste credentials into chat. Enable Firebase Email/Password if using registration and review the project's password policy; configure Google separately. No provider is enabled by this code change.
4. Leave `STUDENT_PROFILES_ENABLED=false` until schema review/migration/testing are ready. Then set it to exactly `true` in disposable staging and restart the API. The default is fail-closed: disabled profiles also block protected student material/search requests rather than leaving a device-check bypass. This intentionally changes those endpoints' prerequisites.
5. Keep `TRUSTED_PROXY_CIDRS` empty unless a reviewed ingress requires it. Configure exact CORS origins and preserve the installation header in the same-origin hosting proxy. Browser code must never call a backend localhost address.
6. Test with disposable accounts: Google/registration → consent → create → edit → sign-out/reload; verify email and change/reset credentials; retry on a second installation and ensure denial without rebinding; test IP changes independently; test two UIDs, suspended accounts, expired/revoked tokens and existing unbound users. Confirm no entitlement/role records are created and seeded local documents/cards/settings remain unchanged.
7. Test the loss/recovery policy only with disposable accounts. Do not clear real students' storage to test it. Test the real Neon transaction/index behavior and real Firebase provider/action-email behavior; local stubs/PGlite are not evidence that these live services work.

## API contract

All routes require revocation-checked Firebase Bearer authentication and the installation header. UID, current email, verification and photo are obtained from the verified Firebase session/Admin SDK, never JSON.

| Route | Body | Effect |
| --- | --- | --- |
| `GET /api/v1/profile` | none | Read only the caller's bound, active profile. 404 `PROFILE_NOT_CREATED` if unbound; 403 `INSTALLATION_MISMATCH` for another installation. |
| `POST /api/v1/profile` | `{ "installation_policy": "browser-installation-v1", "full_name": "Optional chosen name" }` | Idempotently create/bind or sync the same account/installation; 201 on first profile/binding, otherwise 200. Omitting name preserves an existing edited name. |
| `PATCH /api/v1/profile` | `{ "full_name": "Chosen name" }` | Edit only the authenticated caller's name and sync current Firebase email; never accept a UID, email, password, role, status, course, or client IP. |

Names must be 1–120 trimmed characters without control characters. Unknown body keys are rejected. Suspended/inactive rows cannot reactivate themselves. Missing configuration/disabled feature/migration failure returns 503 without partially creating users or bindings. Firebase email uniqueness conflicts return 409 without linking identities. There is no arbitrary user-ID route.

The Google image URL is derived from Firebase and limited to HTTPS `*.googleusercontent.com`; initials are the fallback. Image uploads and arbitrary profile-image URLs remain disabled. Names are rendered as text, never HTML. The browser ignores delayed profile/security replies after sign-out or account change; its API helper also refuses to send an old-session token if the account changes while obtaining the token/marker.

## Verification scope

`backend/test/studentProfile.test.js` runs the real migration and profile SQL against an in-memory PGlite PostgreSQL engine with an explicit model of known `app_users` columns. It uses synthetic Firebase identities and a serialized test pool, never a Neon connection. Other backend tests cover Firebase verification, access SQL and administrator-profile preservation. Root tests exercise the actual browser credential/API helpers against a stub SDK, marker persistence, restricted proxy, DOM wiring and cache boundaries. Browser tests block external requests and simulate registration, Google-prefilled creation, edits, Firebase security UI, marker loss/denial, delayed replies, mobile layout and local-study preservation. These are local regression checks, not live provider, physical-device or production-readiness certification.
