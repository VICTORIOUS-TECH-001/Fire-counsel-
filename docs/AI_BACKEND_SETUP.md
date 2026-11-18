# FIRE COUNSEL AI backend — Step 2

## What this adds

- Python/FastAPI backend suitable for Render.
- Server-side Gemini calls using Google's maintained `google-genai` SDK.
- Automatic Google Search grounding when internal legal evidence is sparse or
  the question concerns current law, recent decisions, amendments or status.
- Firebase ID-token verification on the protected question endpoint.
- Neon PostgreSQL full-text retrieval for course materials, legal authorities,
  statutes and past-question examples.
- Versioned Nigerian-law system prompt and structured response schema.
- Starter Neon schema with pgvector columns and legal-authority relationships.

The existing Stage 1 PWA files and IndexedDB stores are not replaced.

## Research and formatting flow

The backend first retrieves internal course context, legal authorities,
statutes and past-question examples. If fewer than two verified legal
authorities are available, or the question concerns current law, it runs
Google Search grounding. Search and final JSON formatting are separate
Gemini calls: this avoids relying on model/API combinations that do not
support grounded search and strict JSON schema in one call. The final call
receives the research text and only the source links returned by grounding.

The default model is `gemini-2.5-flash`. Change it using `GEMINI_MODEL`
only after checking the selected model's tool and structured-output support.

## Configuration

Create a Render web service from this repository using `backend/render.yaml`,
or configure:

- Root directory: `backend`
- Build: `pip install -r requirements.txt`
- Start: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
- Health check: `/health`

Set these Render environment variables as secrets where appropriate:

- `GEMINI_API_KEY`: Gemini Developer API key.
- `GEMINI_MODEL`: defaults to `gemini-2.5-flash`.
- `FIREBASE_PROJECT_ID`: Firebase project ID.
- `FIREBASE_SERVICE_ACCOUNT_JSON`: service-account JSON as a secret.
- `DATABASE_URL`: Neon pooled or direct PostgreSQL connection string.
- `CORS_ORIGINS`: exact HTTPS origin(s) of the deployed frontend, comma-separated.

Never put Gemini keys, Firebase service-account credentials or the Neon
connection string in frontend JavaScript or commit them to Git.

## Firebase authentication

The browser must sign in with Firebase Authentication, obtain the current
user's ID token, and send it as `Authorization: Bearer <ID_TOKEN>`.
The API verifies the token server-side and rejects missing/invalid tokens.
Do not send a Firebase custom token in place of an ID token.

## Neon setup

Review `database/schema.sql` before running it in the intended Neon database.
It creates the course, materials, chunks, authorities, statutes, past-question,
authority-relationship and research-source tables. Retrieval currently uses
PostgreSQL full-text search. pgvector columns and indexes are prepared for a
later embedding/re-ranking pass; vector similarity retrieval is not yet enabled.

Upload routes are intentionally not included. The agreed policy is admin-only
material uploads and read access for authenticated students. An upload route
must verify a trusted Firebase admin custom claim before it is added.

## API

- `GET /health`: public health check; does not expose secrets.
- `POST /api/ask`: protected legal question endpoint.

Example request body:

```json
{
  "question": "Explain the distinction between an offer and an invitation to treat.",
  "jurisdiction": "Nigeria",
  "course": "Law of Contract",
  "topic": "Offer"
}
```

The response follows the Pydantic `LegalAnswer` schema. It contains sections,
case IRAC fields, statutory authorities, exam tips, generated practice
questions, research links and limitations.

## Frontend integration

The PWA now includes Firebase Email/Password sign-in and a Legal AI workspace.
The client obtains a Firebase ID token and sends it as a Bearer token to
`POST /api/ask`. The backend verifies that token before using Gemini or Neon.

Set `window.FIRE_COUNSEL_CONFIG.apiBaseUrl` in the root `config.js` to the
HTTPS URL of the deployed Render API. Set `CORS_ORIGINS` on Render to the
exact HTTPS origin serving the PWA. Keep Gemini, Firebase service-account and
Neon credentials exclusively in Render environment secrets.

The Firebase web config in `firebase-client.mjs` is public client config,
not a server secret. In Firebase Console, confirm Email/Password is enabled
under Authentication and add the deployed frontend hostname under
Authentication → Settings → Authorized domains. The Gemini API key and Neon
connection string must never be placed in browser files.

## Tests

From the `backend` directory:

```bash
pip install -r requirements.txt
pytest -q
```

Tests cover prompt guardrails, response-schema defaults and automatic-search
selection. A live Gemini, Firebase and Neon integration test requires real
credentials and is not part of the offline test suite.
