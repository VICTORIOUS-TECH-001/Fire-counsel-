# FIRE COUNSEL Firebase content schema (owner deployment required)

These maintained files describe the application and its proposed rules for the existing Firebase project. Tests use synthetic identities and demo-project emulators; no live Firebase settings, records, claims or rules were changed by this repair. Do not treat this document as proof that the default Firestore database, bucket, IAM permissions or rules are active.

## Firestore is collections/documents, not SQL tables

Firestore has no fixed table schema. A collection/document is materialized by the first successful write. `firebase/firestore.rules` protects client access, but deploying rules alone does not create collections or records. Server-owned collections should be created/populated by authenticated server routes using Firebase Admin after validating input. Homepage content is validated by `firebase/content-schema.mjs` in the browser for feedback and independently in the protected API as the enforced gate. Homepage browser writes are **always denied** by rules. Student-owned pages remain browser-written and independently validated by the deployed security rules.

| Collection | Document ID | Intended metadata | Client access |
| --- | --- | --- | --- |
| `siteContent` | `public` | The public homepage JSON, including slide order and image URLs, plus `updatedAt`/`updatedBy` write metadata. Never provider secrets or student records. | Public read; **Google/admin-protected API write only** (fully validated on the server); all browser writes, including admin writes, denied. |
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

The admin studio (**Pages & JSON → Publish**, **Restore this version**, and **Student workspace → Publish**) calls **POST `/api/v1/admin/site/firebase`** with a freshly checked Google/admin token. The API verifies that token (including revocation), requires `admin: true`, validates the entire shared schema, checks the requested project against its configured Admin SDK project, and writes only `siteContent/public` using the Firebase Admin SDK. It owns both metadata fields and enforces a 512 KiB UTF-8 byte cap in addition to the shared 200,000-character cap. This path does not require Neon. Full 12-slide/8-link validation exceeded Firestore's 1,000-expression limit, so the fix moves enforcement to the protected server rather than lowering limits or weakening validation. The homepage (`site.js`) and student workspace (`workspace.mjs`) read it first and fall back to `data/site-content.json` (Neon on the API host, otherwise bundled) when Firebase is unconfigured, unreachable, or the document fails read-side validation. Required `updatedAt`/`updatedBy` metadata is removed only on reads; it is never accepted as editor input. Neon keeps drafts and version archives; a history failure never rolls back the live Firestore publish, and a Firestore failure never silently becomes a Neon-only success. Only a confirmed API acknowledgement triggers archiving. An ambiguous/network reply can follow a committed write, so the UI says publishing was not confirmed, not that nothing went live. If archive reads fail, live content remains editable; workspace publishing skips the archive rather than overwriting an unknown unpublished draft.

Document shape (enforced by the protected API using `firebase/content-schema.mjs`, also checked by the browser):

| Field | Rule |
| --- | --- |
| `brand` | Map with exactly `name` (1–80 chars), `tagline`, `markImage`, `markAlt` (≤ 200). |
| `navigation` | 1–8 maps of exactly `label` (1–60) and `href` (site-relative, `#anchor`, or `https://`). |
| `hero.copy` | Optional map with exactly `title` (non-blank, ≤ 120), `tagline` (≤ 120) and `introduction` (≤ 600). All three are plain text without control characters; tagline/introduction may be empty. This is the single public introduction, with no image, carousel or configurable CTA. |
| `hero.autoplayMs` | Optional number 4000–15000, retained for legacy compatibility; the public homepage does not autoplay slides. |
| `hero.slides` | Required compatibility/archive list of 1–12 maps, each with exactly `eyebrow`, `title` (1–120), `accent`, `body` (≤ 600), `image`, `imageAlt`, `imageCredit` (≤ 200), `primaryLabel`, `primaryHref`, `secondaryLabel`, `secondaryHref`. The single public introduction never renders this list or its photos/buttons. |
| `quickFacts`, `learning`, `caseNotes`, `articles`, `resources`, `footer` | Present; type-checked (list/map). Deep caps are server-enforced: text ≤ 2,000 chars, lists ≤ 40 items, nesting ≤ 8 levels. |
| `caseNotes.videoUrl` | Optional string, ≤ 2,000 chars: empty to disable, or an absolute HTTPS `.mp4`/`.webm` URL in the configured public R2 bucket. No credentials, alternate host/port, query or fragment. Absent fields display the owner's bundled clip without rewriting stored content. |
| `workspace` | Optional public map from the dashboard editor. Same Google/admin API requirement and server-enforced deep caps. |
| `aiSpotlight` | Optional map with exactly `title` (non-blank, ≤ 120), `intro` and `closing` (non-blank, ≤ 600 each), `buttonLabel` (non-blank, ≤ 60), and `chips` (six non-blank labels, ≤ 36 each; legacy five-label lists are also accepted). Plain text without control characters; no image, redirect, mode or authentication fields. |
| `updatedAt` | API-owned `FieldValue.serverTimestamp()`; editor input cannot supply it. |
| `updatedBy` | API-owned verified caller UID; editor input cannot supply it. |

Image fields accept only: bundled `./assets/...` files, Neon `/media/<uuid>.(png|jpg|webp)` uploads, or download URLs from this project's own Storage bucket under `site/slides/`. Link fields never accept `javascript:`/`data:`. Slide photos still upload through the backend into Neon; Firebase Storage uploads stay disabled (see Slide images below).

### Editing the homepage words

In **Admin Studio → Pages & JSON → Introduction, learning & AI**, the text fields edit the same JSON draft as the existing editor. They cover `hero.copy`, the learning headings/introduction, each tool's title/description/number/link wording/destination, **Illustration words** (the floating badge and labels), and the **Fire Counsel AI section** (`aiSpotlight` title, introduction, closing, button wording and six orbit labels). These fields wait for server-verified administrator access and the initial live/draft load. Import, raw JSON editing, discard and version restore update the form too; invalid/incomplete JSON disables it rather than overwriting the draft. Editing fields does not save or publish anything automatically. Use the existing **Save draft → Preview → Publish** actions; unsaved preview still uses the same-origin popup exchange without storing the draft on the visitor page.

Learning preview words live in `learning.previewLabel`, `learning.cards[i].linkLabel` and `learning.cards[i].preview.{badge,labels}`. They use the existing learning deep limits above; missing properties retain the original illustration words. Learning destinations are checked again by the public renderer, so an unsafe protocol becomes `#`, not an executable link. The illustration is not a student record or a performance report.

Older published documents without `hero.copy` remain valid and show the owner's static **Fire Counsel** introduction, never legacy slide marketing copy. Editing a front-page field creates the explicit `hero.copy` map. **Sign up** stays fixed to the Google-only `./auth.html` entry, and the flame logo, photo archive and later homepage pictures are not changed by these fields. This optional text addition needs the matching frontend and API validator deployed together, but no Firestore/Storage rule change, database migration or live-content rewrite.

Older documents without `aiSpotlight` also remain valid and show the owner's **Study Smart with Fire Counsel AI** heading and supplied two paragraphs. Legacy five-label maps keep their custom words and display **Cases** as the sixth fallback without rewriting stored content. Editing an AI field creates the complete six-label text-only map in the existing draft, never a second persistence channel. All AI-spotlight destinations are fixed in application code to **`./ai.html`**. Normal activation lazily checks the restored session's actual Google token provider, then sends signed-out/non-Google visitors to **`./auth.html?next=ai.html`**. The auth page uses AI-specific continuation wording but retains existing profile onboarding and installation-denial checks. Unavailable/time-boxed auth checks, offline access, native modified/new-tab links and a script-failure fallback lead to the existing AI page gate; they do not authorize access in the homepage. Its prior Google/offline policy, API token/installation/Premium checks and all Firebase rules are unchanged. The six labels (**Hacks, Clarity, Legislation, Statues, Exam, Cases** by default) are general AI entry links, not unimplemented deep-linked feature modes. The supplied screenshot's **Statues** wording is retained and is editable here.

The optional AI schema requires the matching public frontend, admin helper and API validator to be deployed together before publishing an AI copy map. It needs no database migration, live rewrite or new Firestore/Storage rule. No publication or deployment is performed by the local implementation.

### Case-library video (Cloudflare R2)

The case-library picture panel can play the owner's public **Statue of Justice** clip directly from `pub-8f421f9b11d64c18bb8a952d99a77e62.r2.dev`. `homepage-media.mjs` owns the approved origin and exact default MP4 URL; the renderer and protected API share this policy. Image URL rules are unchanged. No R2 secret, API proxy, upload integration or private-media permission is required for this public clip.

**Admin Studio → Pages & JSON → Introduction, learning & AI → Case-library video** edits `caseNotes.videoUrl` in the existing draft. Empty means photo only; missing means the bundled clip without a live rewrite. Save, unsaved preview, import/discard, publish and version restore use the existing Google/admin workflow. Another media hostname requires an explicit code/policy update, not arbitrary pasted origins. Deploy the matching frontend and API validator before publishing the optional field; older content needs no migration.

Playback is muted, inline and natively looping as a decorative, noninteractive visual. Native controls, picture-in-picture and remote playback are disabled; pointer/touch input cannot activate the player and the video stays outside keyboard navigation. The case section matches the adjacent AI and closing sections' midnight background, with a light 5–14% violet/midnight wash over the footage and the original stamp above it. The original judge photo remains as poster/fallback, with the same media crop and rounded frame. The video stream starts fetching in view; offscreen/hidden/page-cache states pause it. Reduced motion, data saving, autoplay rejection and media/script/offline failures retain the photograph instead of exposing a play button or leaving a blank panel. An autoplay rejection is not retried during that mount. External video bytes are not service-worker cached. `r2.dev` is a development endpoint; a custom media domain is the production path. No Cloudflare setting, bucket permission or live content is changed here.

The latest public layout places a fixed **Open case desk → `./ai.html?mode=case`** link below the video and joins directly to **Make You Exam Ready Note**. This opens the existing AI case-analysis mode, not a newly built standalone desk, and retains that page's Google/offline/API gates. The old case-description/checklist/exam CTA, articles, legal-source directory, privacy block and article dialog are no longer rendered. Their `caseNotes`/`articles`/`resources` data remains valid in the same protected draft/schema; existing publishes need no migration or live rewrite, and the video URL, image and status still render from them. Navigation/footer links to only the removed same-homepage anchors are omitted (including equivalent `/` and `/index.html` paths), without mutating content or changing other-page/external destinations. Empty footer groups are omitted; the summary, remaining links, flame, disclaimer, copyright and closing/footer animations remain.

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
- Direct browser writes to `studentPages` rely on Google-session/ownership/admin checks inside the security rules on every request. **All** direct browser `siteContent` writes fail, even for Google admins. Homepage publication requires the matching protected API and service-account IAM permissions; rules cannot grant the Admin SDK access.
- Store the Google Gemini key only as a server-side secret such as `GEMINI_API_KEY` in the selected host's protected environment settings (Render was selected for staging only). Never store the raw key in Firestore, public configuration, frontend JavaScript, localStorage or the website JSON.
- Do not send student work to Gemini Free. Confirm the paid/API terms and student-facing eligibility before connecting prompts. A Google API key does not itself prove the account is eligible for this use.
- This document describes public Firestore content, not the separate Neon-backed AI, presence, account and quota routes. See [DEPLOYMENT.md](../DEPLOYMENT.md) and [STATUS.md](../STATUS.md) for those features and their live-verification limits.

## Slide images

`firebase/storage.rules` proposes `site/slides/{fileName}` as the slide-photo path. Public pages can read the slide files; only Firebase Auth accounts with the server-issued `admin: true` custom claim can create, replace or delete them. It accepts JPG/PNG/WebP content types, with a 10 MiB maximum per image and no file-count ceiling. A per-file rule is not a total-storage or billing cap. App Check and Firebase budget alerts/cost monitoring should also be reviewed before enabling uploads; App Check is not a replacement for Auth and Security Rules.

The homepage renderer accepts local project images, Neon `/media/` uploads, and HTTPS Firebase Storage URLs only from the supplied `fire-counsel.firebasestorage.app` bucket, inside `site/slides/`. The admin preview can remove a slide from the local JSON draft and temporarily preview any number of selected local photos. Photo upload goes through the backend into Neon today; a future server operation could move the public slide JSON and Storage object together and clean up an object only after confirming it is no longer referenced.

## Rule deployment boundary

`firebase.json`, `firebase/firestore.rules` and `firebase/storage.rules` are maintained deployment inputs, not a record of a live deployment. The nine security scenarios in `firebase/tests/security.rules.test.mjs` cover public reads, universal homepage browser-write denial, trusted full-size server-seeded content, student-page ownership/publish gating, private collections, and Storage upload/read/delete boundaries. They run in the Java 21 GitHub Actions job (Java is absent in this sandbox). The separate backend API suite exercises token verification, full-size schema validation, project/path restrictions, metadata ownership, byte caps and safe error reporting with injected Admin SDK boundaries; it does not test live IAM.

Review the active project and existing paths first. **Deploy the matching frontend and API before replacing the rules**: the old browser publisher will be denied by the new rules. The backend needs the repository root available (it imports the shared schema), a matching service account with Firestore data-write access, an enabled Firestore API and an existing `(default)` database. Rules publication alone neither enables the API nor grants IAM/admin claims. See [manual deployment steps](../DEPLOYMENT.md#6-manually-publish-the-firebase-rules). No rules, claims or credentials are deployed by tests.
