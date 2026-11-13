# FIRE COUNSEL — Stage 1

An installable, offline-first PWA foundation for a law-student learning and examination platform covering Nigeria, England and other common-law jurisdictions. The brand promise is: “Ignite Your Legal Intelligence.”

## Included in Stage 1

- Responsive dark dashboard and colourful subject cards
- Navigation between Dashboard, Subjects, Study Library, Memory Laboratory and Exam Practice
- Add custom subjects (saved locally)
- Add and delete PDF, TXT and Markdown files in IndexedDB
- Create and practise simple question/answer recall cards
- Focus timer with 15, 25, 45 and 60-minute options
- PWA manifest, service worker and app icon
- Basic offline app-shell caching
- No API keys, paid services or external JavaScript libraries required

## Important stage boundary

This is the Stage 1 foundation, not the finished AI platform. Gemini integration, PDF text extraction, OCR, AI case analysis, AI marking, cloud backup, user accounts and advanced spaced repetition are not yet implemented.

## Run locally

Service workers and PWA installation require `localhost` or HTTPS. Do not open `index.html` directly using a `file://` URL.

### Option A: Python
```bash
python -m http.server 8080
```
Then visit `http://localhost:8080`.

### Option B: Node
```bash
npx serve .
```

## Deploy to Cloudflare Pages

1. Create a GitHub repository and upload the contents of this folder.
2. In Cloudflare Dashboard, open Workers & Pages → Create → Pages → Connect to Git.
3. Select the repository.
4. For a static site, use no build command and set the output directory to `/` (or the repository root, depending on the Cloudflare setup screen).
5. Deploy. Use the HTTPS URL to install the PWA.

## Data and privacy

- Subjects are stored in localStorage.
- Documents and recall cards are stored in IndexedDB on the current browser/device.
- Clearing browser site data can remove locally stored content. Back up important documents elsewhere.
- This version has no login, cloud sync or server-side database.
- Files are not uploaded anywhere in Stage 1.

## Suggested next stages

1. Gemini API through a server-side Cloudflare Worker, with the API key stored as a secret.
2. PDF.js extraction, page-aware document chunks and source-grounded AI chat.
3. Case law database and case-analysis workflows with source verification.
4. Constitutional verbatim recall and spaced repetition.
5. Timed exam simulator, rubric-based marking and writing coach.
6. Optional Firebase account and cloud synchronisation.

## Branding and local data compatibility

The application is branded as FIRE COUNSEL. Existing IndexedDB and localStorage keys retain their original internal identifiers so a future rebrand does not unnecessarily orphan study materials already saved in a browser. The service-worker cache has a new FIRE COUNSEL cache name so deployed browsers can refresh the renamed app shell.
