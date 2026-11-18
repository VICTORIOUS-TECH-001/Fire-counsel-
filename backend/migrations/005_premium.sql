-- FIRE COUNSEL premium flag: per-account paywall for the AI features.
-- Additive and idempotent. Accounts default to the free plan (premium = false);
-- only an administrator can grant premium (Admin → Users & AI limits), and the
-- server checks it on every AI request, so it cannot be enabled from a browser.
-- Run it from: Actions -> "Neon database migration (AI, website, uploads)" -> Run workflow.
BEGIN;

ALTER TABLE ai_user_limits ADD COLUMN IF NOT EXISTS premium boolean NOT NULL DEFAULT false;

COMMIT;
