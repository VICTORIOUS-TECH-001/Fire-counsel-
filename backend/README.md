# FIRE COUNSEL Backend — Phase 1

This directory contains the first Node.js API foundation. The existing static frontend remains at the repository root and is not replaced.

## Stack

- Node.js 20+
- Express
- Neon PostgreSQL through node-postgres
- Firebase Admin SDK for verifying Firebase ID tokens
- Helmet, CORS allowlist and rate limiting

## Local setup

1. Install Node.js 20 or newer.
2. From this directory, run `npm install`.
3. Copy `.env.example` to `.env`.
4. Set `DATABASE_URL` to the Neon pooled connection string.
5. Set `FIREBASE_SERVICE_ACCOUNT_JSON` to the Firebase service-account JSON on one line.
6. Set `CORS_ORIGINS` to the exact origin(s) serving the frontend.
7. Run `npm run dev`.

The API listens on port 4000 by default.

## Endpoints

- `GET /api/health` — checks API/database readiness.
- `GET /api/v1/me` — protected example endpoint. Requires
  `Authorization: Bearer <Firebase ID token>`.

## Security notes

- Never commit `.env`, Firebase service-account files, database passwords or API keys.
- Store production secrets in the hosting provider's secret/environment-variable manager.
- Use the Neon pooled connection string.
- Configure only trusted frontend origins in `CORS_ORIGINS`.
- The frontend must obtain Firebase ID tokens using the Firebase client SDK and send them to protected API routes.
- Do not expose the Neon connection string or Firebase Admin credentials in browser JavaScript.

## Current scope

This is infrastructure only. It does not yet create user-profile tables, migrate local browser data, or connect existing frontend features to the API. Those changes should be designed and reviewed as separate steps.
