-- REVIEW against the actual Neon schema and run only on disposable staging first.
-- This file is NOT executed by server startup, tests against Neon, or deployment.
-- Requires the existing app_users table with its UUID id / unique firebase_uid.
BEGIN;

CREATE TABLE student_account_installations (
  user_id uuid PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
  installation_hash text NOT NULL CHECK (installation_hash ~ '^[0-9a-f]{64}$'),
  policy_version text NOT NULL DEFAULT 'browser-installation-v1'
    CHECK (policy_version = 'browser-installation-v1'),
  bound_at timestamptz NOT NULL DEFAULT NOW(),
  last_seen_at timestamptz NOT NULL DEFAULT NOW(),
  last_observed_ip inet,
  ip_source text NOT NULL CHECK (ip_source IN ('connection_peer', 'trusted_proxy', 'unavailable'))
);

COMMENT ON TABLE student_account_installations IS
  'One browser-installation binding per Firebase-backed profile. Not a hardware ID or IP-based device lock.';
COMMENT ON COLUMN student_account_installations.last_observed_ip IS
  'Most recent observed connection address only; may identify a proxy, not a person/device. No IP history or geolocation.';

COMMIT;
