# FIRE COUNSEL — Stage 2 foundation

An installable, offline-first law-student learning PWA with the first secure
AI-backend and legal-knowledge-library foundation. The platform is designed
for Nigerian legal education and other common-law jurisdictions.

## Existing PWA features preserved

- Responsive dashboard and subject navigation
- Add custom subjects (saved locally)
- Add and delete PDF, TXT and Markdown files in IndexedDB
- Create and practise question/answer recall cards
- Focus timer with 15, 25, 45 and 60-minute options
- PWA manifest, service worker and app-shell caching
- Existing localStorage and IndexedDB identifiers remain unchanged

## Stage 2 backend foundation

- FastAPI backend in `backend/`, deployable to Render
- Server-side Gemini integration using the maintained Google Gen AI SDK
- Versioned Nigerian-law system prompt with adaptive detailed responses
- Automatic Google Search grounding when verified internal legal evidence
  is insufficient or the question concerns current law
- Structured legal answer schema for IRAC cases, statutes, exam guidance,
  practice questions and research links
- Firebase ID-token verification for protected AI requests
- Neon PostgreSQL schema for courses, materials, document chunks, cases,
  statutes, past questions, authority relationships and research sources
- PostgreSQL full-text retrieval; pgvector columns/indexes are prepared for
  a later semantic retrieval implementation
- GitHub Actions workflow for backend syntax checks and unit tests

## Important integration boundary

The current browser PWA still has no Firebase web sign-in screen or connected
AI chat interface. The backend is protected and will reject unauthenticated
requests. This is intentional: Gemini credentials and the legal database must
never be exposed to anonymous browser code. Complete the Firebase web app
configuration and sign-in flow before connecting the student chat interface.

Admin-only document uploads are not implemented yet. The database design
preserves the agreed policy: administrators upload approved course materials;
authenticated students may read the published knowledge library.

## Run the PWA locally

Service workers and PWA installation require `localhost` or HTTPS.

```bash
python -m http.server 8080
```

Then visit `http://localhost:8080`.

## Deploy the AI backend

A Render Blueprint is provided at the repository root in `render.yaml`.

- Root directory: `backend`
- Build command: `pip install -r requirements.txt`
- Start command: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
- Health check: `/health`

Configure the secrets and environment variables described in
[`docs/AI_BACKEND_SETUP.md`](docs/AI_BACKEND_SETUP.md). Never commit API
keys, Firebase service-account credentials or database passwords.

## Database

Review `database/schema.sql` before running it against the intended Neon
PostgreSQL database. The backend currently performs full-text retrieval.
Vector embeddings and similarity ranking are a subsequent implementation
step; pgvector is prepared in the schema but not yet called by the API.

## Backend tests

From the `backend` directory:

```bash
pip install -r requirements.txt
pytest -q
```

A live Gemini/Firebase/Neon integration test requires real credentials and
is not part of the offline unit test suite.

## Next implementation steps

1. Connect the Firebase web SDK, sign-in and student identity to the PWA.
2. Add the authenticated AI chat interface and render structured responses.
3. Build the admin-only upload and document extraction pipeline.
4. Generate embeddings and enable pgvector retrieval/reranking.
5. Add verified authority ingestion, status tracking and citation review.
6. Add examiner mode, marking rubrics, spaced repetition and progress sync.
