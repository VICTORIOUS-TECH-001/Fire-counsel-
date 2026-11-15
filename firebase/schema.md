# FIRE COUNSEL Firebase plan (not deployed)

These files are a reviewed starting point for the existing Firebase project. The Firebase connector is not available in this workspace, no Firebase CLI login/project selection was made, and nothing was created or deployed remotely. Do not treat this document as proof that a Firestore database, collection, bucket or rule is active.

## Firestore is collections/documents, not SQL tables

Firestore has no fixed table schema. A collection/document is materialized by the first successful write. `firebase/firestore.rules` protects client access, but deploying rules alone does not create collections or records. The collections below should be created/populated by authenticated server routes using Firebase Admin after validating input.

| Collection | Document ID | Intended metadata | Client access |
| --- | --- | --- | --- |
| `accounts` | Firebase Auth `uid` | Minimal account metadata: institution ID, enrolled course IDs, installation hash, plan/activation state and timestamps. No study files or chat transcript. | Admin read only; server writes only. |
| `aiQuotaPolicies` | `default` | Per-feature Free/paid allowance and reset period, active flag and update audit metadata. | Admin read only; server writes only. |
| `aiEntitlements` | Firebase Auth `uid` | Inherit/grant-free/pause access state and per-feature allowance adjustments with an admin reason and timestamp. | Admin read only; server writes only. |
| `aiUsage` | Server-generated user/feature/period key | User ID, feature, reset-period key, integer usage counter and update timestamp. Never store prompts or answers. | Admin read only; server writes only. |
| `siteContent` | `public` | The public homepage JSON, including slide order and Firebase image URLs. Never provider secrets or student records. | Public read; server writes only. |
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

## Administrator identity and AI key

- A trusted project owner must assign the Firebase Auth custom claim `admin: true` outside the public client. No browser control may grant itself this claim.
- The API must verify Firebase ID tokens with Firebase Admin on every protected request and separately require `decodedToken.admin === true` on all admin routes. Firebase Admin SDK bypasses Firestore rules, so server-route authorization is essential.
- Store the Google Gemini key only as a server-side secret such as `GEMINI_API_KEY` in the selected host's protected environment settings (Render was selected for staging only). Never store the raw key in Firestore, public configuration, frontend JavaScript, localStorage or the website JSON.
- Do not send student work to Gemini Free. Confirm the paid/API terms and student-facing eligibility before connecting prompts. A Google API key does not itself prove the account is eligible for this use.
- No AI provider route, sign-in UI, admin user search endpoint or quota-enforcement endpoint is implemented by this preview.

## Slide images

`firebase/storage.rules` proposes `site/slides/{fileName}` as the slide-photo path. Public pages can read the slide files; only Firebase Auth accounts with the server-issued `admin: true` custom claim can create, replace or delete them. It accepts JPG/PNG/WebP content types, with a 10 MiB maximum per image and no file-count ceiling. A per-file rule is not a total-storage or billing cap. App Check and Firebase budget alerts/cost monitoring should also be reviewed before enabling uploads; App Check is not a replacement for Auth and Security Rules.

The homepage renderer accepts local project images and HTTPS Firebase Storage URLs only from the supplied `fire-counsel.firebasestorage.app` bucket, inside `site/slides/`. The admin preview can remove a slide from the local JSON draft and temporarily preview any number of selected local photos. It cannot upload/delete remote files. A future server operation should update the public slide JSON and Storage object together and clean up an object only after confirming it is no longer referenced.

## Rule deployment boundary

`firebase.json`, `firebase/firestore.rules` and `firebase/storage.rules` are local scaffolding. They have not been evaluated with the Firebase Emulator or deployed. Deploying rule changes can affect an existing app, so review the active project and all existing paths first. Do not run a deploy from this workspace until the project owner has reviewed the rules, custom-claim provisioning, App Check, budget alerts and any existing Firebase rules.
