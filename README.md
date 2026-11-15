# FIRE COUNSEL — legal learning PWA

A local-first, installable law-study workspace with a public website, a separate student workspace and a separate administrator-content preview. Brand line: “Ignite your legal intelligence.”

## Current site structure

- `index.html` — public FIRE COUNSEL homepage with a responsive top navigation bar, real-photo carousel, learning-tool cards, case-note section, study articles, approved-legal-links directory, privacy note and black footer.
- `data/site-content.json` — JSON source for the homepage navigation, hero slides, features, articles, case notes, legal links and footer.
- `site.js` / `site.css` — JSON-driven site rendering, accessible carousel, responsive mobile navigation and motion-safe scroll reveals.
- `study.html` — the student workspace keeps personal files/flashcards local, now displays approved Neon course materials when authenticated, and includes a server-side verified-source search across materials, cases, statutes, exact past questions, mnemonics and approved summaries. AI generation remains disabled pending provider authorization/terms review.
- `auth.html` — Firebase email/password and Google sign-in UI. Google provider enablement and authorized domains must still be configured in Firebase Console; admin access is allowed only after the API verifies the server-issued claim.
- `admin.html` — admin studio with a schema-driven Neon Database Data workspace for academic/legal records, website JSON drafts, slideshow previews and synthetic quota/account drafts. Neon writes require a Firebase-verified admin claim and private server-side `DATABASE_URL`; no live Neon connection is configured in this workspace.
- `firebase/` and `firebase.json` — local Firestore/Storage rule drafts, emulator tests, browser Firebase/Auth helpers and the local Web config template. The provided Web config file is ignored by Git; no live Firebase settings have been changed.
- `backend/` — Express/Firebase Admin/Neon API with verified ID-token middleware, a server-side `admin: true` gate, allowlisted `/api/v1/admin/database` CRUD routes, approved-material reads and verified-source search. The API code is wired to the frontend, but live Neon behavior is unverified because no `DATABASE_URL` is configured. See `backend/DATABASE_SCHEMA.md` for the supplied schema review.
- `render.yaml` — a Free-plan staging blueprint with auto-deploy disabled and no database, Firebase Admin, Gemini or payment secrets. It has not been deployed.

## Local preview

To exercise same-origin `/api/` calls locally, run the backend and the repository dev proxy in separate terminals:

```bash
# Terminal 1
cd backend && npm run dev

# Terminal 2 (repository root)
python3 tools/dev_server.py
```

Open `http://localhost:8080/`. The student workspace is `/study.html`; the admin studio is `/admin.html`. For an admin-first view, run `python3 tools/admin_preview_server.py` instead (port 8093; `/` redirects to `/admin.html`). Both scripts proxy relative `/api/*` requests to the backend on port 4000, so browser code never calls localhost directly. For a static-only preview, run the selected dev server and skip Terminal 1; API calls will return an offline response. These safe servers do not expose backend files, tools, dotfiles or Firebase project docs. Neon and Firebase Admin still require the local ignored `backend/.env`; don't add real student data or credentials to Render Free staging. Avoid running an unrestricted file server from the repository root because it could expose local environment files.

## Images and branding

- The owner-supplied gavel-and-flame image is now used as the FIRE COUNSEL brand mark and source artwork for the PNG PWA icons.
- The slideshow currently uses locally stored JPEG photographs from Pexels (credits and source links are in `assets/images/README.md`). The public renderer accepts local raster images and only HTTPS slide-photo URLs from the supplied `fire-counsel.firebasestorage.app` bucket at `site/slides/`. No Firebase image has been uploaded.
- Admin can remove slides from the local JSON draft and temporarily preview multiple selected photos in the browser. The preview does not upload, copy or persist those photo files. The homepage renderer no longer imposes an eight-slide cap.
- `manifest.webmanifest` uses PNG icons. The app-shell cache is `fire-counsel-shell-v10`; it caches the refreshed student pages without clearing IndexedDB or localStorage.

## Admin, Firebase and secret boundaries

- Website drafts use `fire-counsel-site-draft-v1`; quota/account-control preview values use `fire-counsel-admin-quota-preview-v1`. Both are browser-local drafts only. Quota rows are synthetic examples, not registered Firebase users, and no allowance is enforced.
- The key field says Google Gemini but is deliberately disabled. Your Google API key has not been shared, copied, stored or used. Never paste it in this chat or the static page. After an authenticated backend exists, configure it as a protected server secret (for example `GEMINI_API_KEY` in the selected staging host), not in frontend code, localStorage, site JSON or a public Firestore document.
- Firebase uses Firestore collections/documents, not SQL tables. Proposed structure and rules are in `firebase/schema.md`, `firebase/firestore.rules`, and `firebase/storage.rules`. The rules deny client-side writes to site/account/quota/usage data. Only a server that verifies a trusted Firebase `admin: true` claim should perform those writes.
- You confirmed the project is already on Blaze and permitted use of that existing plan without a billing change. The Storage rule allows public slide reads and admin-claim-only create/update/delete under `site/slides/`, with any number of files and a 10 MiB per-file cap. This is a local rules proposal only: the new Firebase sign-in code has not been tested against the live project; no provider settings, App Check, Firestore database/collection, rule deployment, upload, delete, budget alert or cost-limit change was made. The API token verifier is not configured with a service account yet.
- Firebase client API keys identify an app; they are not admin credentials. Security Rules and App Check are separate controls. See [Firebase API key guidance](https://firebase.google.com/docs/projects/api-keys) and [Firebase Storage billing requirements](https://firebase.google.com/docs/storage/faqs-storage-changes-announced-sept-2024).
- The Neon Database Data workspace can manage allowlisted academic/legal content tables through server routes. Firebase Auth provides self-service password-reset email; account listing/admin resets remain in Firebase Console. Public homepage JSON publishing and slideshow uploads/deletes are not wired. Gemini key storage, AI generation and quota enforcement remain locked pending authorization and provider-terms review.

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
