# FIRE COUNSEL Firebase plan (not deployed)

These files are a reviewed starting point for the existing Firebase project. The Firebase connector is not available in this workspace, no Firebase CLI login/project selection was made, and nothing was created or deployed remotely. Do not treat this document as proof that a Firestore database, collection, bucket or rule is active.

## Firestore is collections/documents, not SQL tables

Firestore has no fixed table schema. A collection/document is materialized by the first successful write. `firebase/firestore.rules` protects client access, but deploying rules alone does not create collections or records. Server-owned collections should be created/populated by authenticated server routes using Firebase Admin after validating input. The two browser-written collections below are validated twice: by `firebase/content-schema.mjs` in the client (early, plain-language feedback) and again by the deployed security rules (the enforced gate).

| Collection | Document ID | Intended metadata | Client access |
| --- | --- | --- | --- |
| `siteContent` | `public` | The public homepage JSON, including slide order and image URLs, plus `updatedAt`/`updatedBy` write metadata. Never provider secrets or student records. | Public read; **admin-claim browser write** (fully validated by rules); delete is server-only. |
| `studentPages` | Firebase Auth `uid` | A student's own public page: display name, headline, bio, links, focus areas, published flag, created/updated timestamps. | Owner (or admin) write; public can fetch only pages with `published: true`; list is admin-only. |
| `accounts` | Firebase Auth `uid` | Minimal account metadata: institution ID, enrolled course IDs, installation hash, plan/activation state and timestamps. No study files or chat transcript. | Admin read only; server writes only. |
| `aiQuotaPolicies` | `default` | Per-feature Free/paid allowance and reset period, active flag and update audit metadata. | Admin read only; server writes only. |
| `aiEntitlements` | Firebase Auth `uid` | Inherit/grant-free/pause access state and per-feature allowance adjustments with an admin reason and timestamp. | Admin read only; server writes only. |
| `aiUsage` | Server-generated user/feature/period key | User ID, feature, reset-period key, integer usage counter and update timestamp. Never store prompts or answers. | Admin read only; server writes only. |
| `adminAudit` | Server-generated event ID | Recommended: administrator UID, target UID, changed feature/access, old/new value, reason and timestamp. | Admin read only; server writes only. |

A policy document should start inactive and unset until the administrator chooses every count and reset period. `limit: 0` can mean disabled. A blank limit must not mean unlimited. The API should reject an active policy with an unset limit or period. The admin preview has no preset quota numbers.

Example shape only — this is not a database record and contains no selected values:

```json
{
  "active": false,
  "features": {
    "explanations": {
      "free": { "limit": null, "period": null },
      "paid": { "limit": null, "period": null }
    },
    "pastQuestions": { "free": { "limit": null, "period": null }, "paid": { "limit": null, "period": null } },
    "marking": { "free": { "limit": null, "period": null }, "paid": { "limit": null, "period": null } },
    "ocr": { "free": { "limit": null, "period": null }, "paid": { "limit": null, "period": null } },
    "practiceScenarios": { "free": { "limit": null, "period": null }, "paid": { "limit": null, "period": null } }
  }
}
```

Individual overrides should be validated on the server, clamped so an effective allowance cannot go below zero, and recorded in the audit log. Usage must be checked and incremented atomically on the server before each billable/provider request. The client must never choose its own plan, counters, or admin status. A student's account page should call a token-protected `/api/v1/me` endpoint which returns only that student's safe plan and feature usage summary.

## `siteContent/public` — homepage content and slides

The admin studio (**Pages & JSON → Publish**, **Restore this version**, and **Student workspace → Publish**) writes this document directly from the browser with the admin's Firebase session. The homepage (`site.js`) and student workspace (`workspace.mjs`) read it first and fall back to `data/site-content.json` (Neon on the API host, otherwise bundled) when Firebase is unconfigured, unreachable, or the document fails read-side validation. Required `updatedAt`/`updatedBy` metadata is removed only on reads; it is never accepted as editor input. Neon keeps drafts and version archives; a history failure never rolls back the live Firestore publish, and a Firestore denial never silently becomes a Neon-only success.

Document shape (rules-enforced; limits mirrored in `firebase/content-schema.mjs`):

| Field | Rule |
| --- | --- |
| `brand` | Map with exactly `name` (1–80 chars), `tagline`, `markImage`, `markAlt` (≤ 200). |
| `navigation` | 1–8 maps of exactly `label` (1–60) and `href` (site-relative, `#anchor`, or `https://`). |
| `hero.autoplayMs` | Optional number 4000–15000. |
| `hero.slides` | 1–12 maps, each with exactly `eyebrow`, `title` (1–120), `accent`, `body` (≤ 600), `image`, `imageAlt`, `imageCredit` (≤ 200), `primaryLabel`, `primaryHref`, `secondaryLabel`, `secondaryHref`. |
| `quickFacts`, `learning`, `caseNotes`, `articles`, `resources`, `footer` | Present; type-checked (list/map). Deep content caps are client-enforced. |
| `workspace` | Optional public map from the dashboard editor. Same Google/admin requirement; deep caps are client-enforced. |
| `updatedAt` | Must equal `request.time` — clients send `serverTimestamp()`. |
| `updatedBy` | Must equal the caller's `uid`. |

Image fields accept only: bundled `./assets/...` files, Neon `/media/<uuid>.(png|jpg|webp)` uploads, or download URLs from this project's own Storage bucket under `site/slides/`. Link fields never accept `javascript:`/`data:`. Slide photos still upload through the backend into Neon; Firebase Storage uploads stay disabled (see Slide images below).

## `studentPages/{uid}` — a student's own public page

Signed-in students edit their page directly from **study.html → profile → My public student page** (`student-page.mjs` → `firebase/firestore-client.mjs`). Visitors read it at `student.html?u=<uid>` (`student-page-view.mjs`). The private account profile stays in Neon behind `/api/v1/profile`; this page never carries it.

| Field | Rule |
| --- | --- |
| `displayName` | String, 1–120 characters. |
| `headline` | String, ≤ 160. |
| `bio` | String, ≤ 2000 (multi-line allowed). |
| `links` | List of ≤ 5 `https://` strings, each ≤ 300 chars. |
| `focusAreas` | List of ≤ 8 non-empty strings, each ≤ 40 chars. |
| `published` | Boolean. Public reads succeed only while `true`. |
| `createdAt` | `request.time` on create; immutable afterwards. |
| `updatedAt` | `request.time` on every write. |

Ownership is the document ID: only `request.auth.uid == uid` (or an admin claim) may create, update or delete. Extra keys (for example a self-granted `role`) fail the exact-key check. Rules cannot iterate lists, so each list entry is checked by index up to the maximum; the client validator enforces the same limits before any write, and the viewer escapes all text and re-validates link protocols at render time.

## Administrator identity and AI key

- A trusted project owner must assign the Firebase Auth custom claim `admin: true` outside the public client. No browser control may grant itself this claim. The admin page's one-time `/api/v1/admin/claim` button only works for emails on the server's `ADMIN_EMAILS` list.
- The API must verify Firebase ID tokens with Firebase Admin on every protected request and separately require `decodedToken.admin === true` on all admin routes. Firebase Admin SDK bypasses Firestore rules, so server-route authorization is essential.
- Direct browser writes (`siteContent`, `studentPages`) rely on the same claim/ownership checks inside the security rules, which Firebase evaluates on every request. A forged token, a missing claim, or a stale claim (not refreshed after granting) fails there even if the UI is tricked into offering the action.
- Store the Google Gemini key only as a server-side secret such as `GEMINI_API_KEY` in the selected host's protected environment settings (Render was selected for staging only). Never store the raw key in Firestore, public configuration, frontend JavaScript, localStorage or the website JSON.
- Do not send student work to Gemini Free. Confirm the paid/API terms and student-facing eligibility before connecting prompts. A Google API key does not itself prove the account is eligible for this use.
- No AI provider route, sign-in UI, admin user search endpoint or quota-enforcement endpoint is implemented by this preview.

## Slide images

`firebase/storage.rules` proposes `site/slides/{fileName}` as the slide-photo path. Public pages can read the slide files; only Firebase Auth accounts with the server-issued `admin: true` custom claim can create, replace or delete them. It accepts JPG/PNG/WebP content types, with a 10 MiB maximum per image and no file-count ceiling. A per-file rule is not a total-storage or billing cap. App Check and Firebase budget alerts/cost monitoring should also be reviewed before enabling uploads; App Check is not a replacement for Auth and Security Rules.

The homepage renderer accepts local project images, Neon `/media/` uploads, and HTTPS Firebase Storage URLs only from the supplied `fire-counsel.firebasestorage.app` bucket, inside `site/slides/`. The admin preview can remove a slide from the local JSON draft and temporarily preview any number of selected local photos. Photo upload goes through the backend into Neon today; a future server operation could move the public slide JSON and Storage object together and clean up an object only after confirming it is no longer referenced.

## Rule deployment boundary

`firebase.json`, `firebase/firestore.rules` and `firebase/storage.rules` are local scaffolding. The emulator suite in `firebase/tests/security.rules.test.mjs` covers anonymous/student/admin access to every collection, the validated admin publish path, student-page ownership/publish gating, and slide upload type/size — it runs in the Java-enabled GitHub Actions job, not in this sandbox (no Java here). Deploying rule changes can affect an existing app, so review the active project and all existing paths first. Do not run a deploy from this workspace until the project owner has reviewed the rules, custom-claim provisioning, App Check, budget alerts and any existing Firebase rules. Until the new rules are deployed, browser publishes and student-page saves fail closed with a permission error and the site keeps serving the bundled content.
