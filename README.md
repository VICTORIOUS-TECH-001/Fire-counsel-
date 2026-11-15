# FIRE COUNSEL — legal learning PWA

A local-first, installable law-study workspace with a public website, a separate student workspace and a separate administrator-content preview. Brand line: “Ignite your legal intelligence.”

## Current site structure

- `index.html` — public FIRE COUNSEL homepage with a responsive top navigation bar, real-photo carousel, learning-tool cards, case-note section, study articles, approved-legal-links directory, privacy note and black footer.
- `data/site-content.json` — JSON source for the homepage navigation, hero slides, features, articles, case notes, legal links and footer.
- `site.js` / `site.css` — JSON-driven site rendering, accessible carousel, responsive mobile navigation and motion-safe scroll reveals.
- `study.html` — the existing student workspace, separated from administration. Its AI area has been restyled as a colorful study studio; the chat composer and setup/legal notices were removed from that screen. AI actions remain preview-only, and no student data is sent to an AI provider.
- `admin.html` — separate, unlinked admin-studio preview. It has website JSON editing, slide removal and temporary multi-photo previews, a locked Google Gemini key slot, editable Free/paid feature quotas, and per-account adjustment controls with synthetic sample IDs. Site and quota drafts stay in that browser. It is not authenticated and must not be publicly deployed as an admin system.
- `firebase/` and `firebase.json` — local draft Firestore/Storage rules and a proposed collection schema. They are not connected to or deployed on Firebase.
- `backend/` — the existing Express/Firebase Admin/Neon foundation. It still has no admin, quota, provider-key, account-search, AI or image-upload routes.

## Local preview

Run a static server from the repository root; service workers require localhost or HTTPS.

```bash
python3 -m http.server 8080 --bind 0.0.0.0
```

Open `http://localhost:8080/`. The student workspace is `http://localhost:8080/study.html`; the unprotected admin preview is `http://localhost:8080/admin.html`. For an admin-first live preview that opens the studio at `/`, run `python3 tools/admin_preview_server.py` from the project root (port 8093).

## Images and branding

- The owner-supplied gavel-and-flame image is now used as the FIRE COUNSEL brand mark and source artwork for the PNG PWA icons.
- The slideshow currently uses locally stored JPEG photographs from Pexels (credits and source links are in `assets/images/README.md`). The public renderer accepts local raster images and only HTTPS slide-photo URLs from the supplied `fire-counsel.firebasestorage.app` bucket at `site/slides/`. No Firebase image has been uploaded.
- Admin can remove slides from the local JSON draft and temporarily preview multiple selected photos in the browser. The preview does not upload, copy or persist those photo files. The homepage renderer no longer imposes an eight-slide cap.
- `manifest.webmanifest` uses PNG icons. The app-shell cache is `fire-counsel-shell-v6`; it caches the refreshed student pages without clearing IndexedDB or localStorage.

## Admin, Firebase and secret boundaries

- Website drafts use `fire-counsel-site-draft-v1`; quota/account-control preview values use `fire-counsel-admin-quota-preview-v1`. Both are browser-local drafts only. Quota rows are synthetic examples, not registered Firebase users, and no allowance is enforced.
- The key field says Google Gemini but is deliberately disabled. Your Google API key has not been shared, copied, stored or used. Never paste it in this chat or the static page. After an authenticated backend exists, configure it as a protected server secret (for example `GEMINI_API_KEY` in the selected staging host), not in frontend code, localStorage, site JSON or a public Firestore document.
- Firebase uses Firestore collections/documents, not SQL tables. Proposed structure and rules are in `firebase/schema.md`, `firebase/firestore.rules`, and `firebase/storage.rules`. The rules deny client-side writes to site/account/quota/usage data. Only a server that verifies a trusted Firebase `admin: true` claim should perform those writes.
- You confirmed the project is already on Blaze and permitted use of that existing plan without a billing change. The Storage rule allows public slide reads and admin-claim-only create/update/delete under `site/slides/`, with any number of files and a 10 MiB per-file cap. This is a local rules proposal only: the new Firebase sign-in code has not been tested against the live project; no provider settings, App Check, Firestore database/collection, rule deployment, upload, delete, budget alert or cost-limit change was made. The API token verifier is not configured with a service account yet.
- Firebase client API keys identify an app; they are not admin credentials. Security Rules and App Check are separate controls. See [Firebase API key guidance](https://firebase.google.com/docs/projects/api-keys) and [Firebase Storage billing requirements](https://firebase.google.com/docs/storage/faqs-storage-changes-announced-sept-2024).
- The Neon Database Data workspace can manage allowlisted academic/legal content tables through server routes. Firebase Auth provides self-service password-reset email; account listing/admin resets remain in Firebase Console. Public homepage JSON publishing and slideshow uploads/deletes are not wired. Gemini key storage, AI generation and quota enforcement remain locked pending authorization and provider-terms review.
- You confirmed the project is already on Blaze and permitted use of that existing plan without a billing change. The Storage rule allows public slide reads and admin-claim-only create/update/delete under `site/slides/`, with any number of files and a 10 MiB per-file cap. This is a local rules proposal only: no Firebase sign-in, App Check configuration, Firestore database/collection, rule deployment, upload, delete, budget alert or cost-limit change was made.
- Firebase client API keys identify an app; they are not admin credentials. Security Rules and App Check are separate controls. See [Firebase API key guidance](https://firebase.google.com/docs/projects/api-keys) and [Firebase Storage billing requirements](https://firebase.google.com/docs/storage/faqs-storage-changes-announced-sept-2024).
- The admin page is a design preview only. It has no Firebase sign-in, server authorization, AI-key storage endpoint, account search API, quota enforcement or global publish endpoint.

## Study-data compatibility and privacy

- The student workspace keeps the existing IndexedDB name (`lexmaster-ai-stage1`), version 1 and stores (`documents`, `cards`, `settings`), plus the existing localStorage counter key (`lexmaster-sessions`). These internal names are deliberately preserved so existing browser study data remains reachable; visible branding is FIRE COUNSEL. No browser data was accessed, cleared or migrated.
- Personal PDFs, notes, flashcards, OCR text, answers, chat history and progress remain local by design. The PWA does not upload them or send them to an AI service.
- The service worker caches site/app files only; it does not clear or migrate IndexedDB or localStorage. Clearing browser site data can still remove local study files, so keep separate backups of important documents.

## Pending product and integration decisions

- You confirmed an adults-only audience (18+) and prefer Gemini. You now have a Google API key, but it has not been shared, stored or connected. No age verification or AI provider is active. Confirm paid/API terms and student-facing eligibility before use; never send student work to Gemini Free. Render Free was selected for staging only; it has not been deployed. Do not put real student data, prompts or payments on a free staging instance.
- Paystack remains a future payment choice and ₦2,000 is the supplied upgrade price. The paid-plan duration (12 months vs school term) and payment/activation flow remain unconfirmed and disabled.
- You specified that the administrator should set every AI feature allowance. The admin preview now has blank Free/paid fields and daily, weekly, monthly, school-term, 12-month and one-time reset choices for explanations, archived past questions, marking, OCR and practice scenarios. It also has per-account preview controls for granting free AI, pausing AI, and increasing/reducing a feature allowance. No preset limits, live accounts or server enforcement are present; exact values can be entered by the admin after secure integration.
- Exact archived past questions only are wanted (no generated variants of archived questions). Separate, clearly labelled practice scenarios from approved notes/rubrics are wanted, but their counts are still pending.
- You selected Nigeria plus other jurisdictions, but have not named the additional jurisdictions or school-approved domains. Legal-web fallback remains disabled; the website directory shows this as pending rather than inventing sources.
- The device policy selected earlier is one registered app installation per account; a device change means a new account. A PWA cannot read a reliable hardware ID, and clearing site data may appear to create a new installation.

## No production or billing actions

No Firebase/Neon write, migration, Firestore database/collection creation, rules deployment, account creation, Gemini key setup, AI request, image upload/delete, payment, activation code, paid-plan change or deployment was made. The Firebase Web config is local-only and ignored by Git; the Firebase rules remain un-deployed proposals. Render Free was selected for staging only and now has a blueprint, but has not been deployed; no real student data, prompts or payment credentials are configured there.
No Firebase/Neon write, migration, Firestore database/collection creation, rules deployment, account creation, API-key setup, AI request, image upload/delete, payment, activation code, paid-plan change, commit or deployment was made. The Firebase rule/schema files are local proposals only. Render Free was selected for staging only and has not been deployed; the API secret, authenticated admin, account data and publishing remain disconnected.
