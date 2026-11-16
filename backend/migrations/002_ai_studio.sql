-- FIRE COUNSEL AI studio: additive tables only. Existing tables are not altered.
-- Idempotent (IF NOT EXISTS) so it can be re-run safely by the migration workflow.
-- Users are keyed by Firebase UID (text) so AI works without the optional
-- student-profile migration. No API keys are stored here — keys live in Render.
BEGIN;

-- Admin-editable settings (e.g. default daily limits).
CREATE TABLE IF NOT EXISTS ai_settings (
  key text PRIMARY KEY CHECK (key ~ '^[a-z_]{1,60}$'),
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  updated_by text
);

-- Private prompt texts uploaded by an admin (kept out of the public repository).
CREATE TABLE IF NOT EXISTS ai_prompts (
  kind text PRIMARY KEY CHECK (kind IN ('case_research', 'exam_note', 'question_setter', 'chat')),
  content text NOT NULL CHECK (char_length(content) BETWEEN 20 AND 200000),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  updated_by text
);

-- Per-account limit overrides. NULL = use the default for that feature.
CREATE TABLE IF NOT EXISTS ai_user_limits (
  firebase_uid text PRIMARY KEY CHECK (char_length(firebase_uid) BETWEEN 1 AND 128),
  chat_daily integer CHECK (chat_daily BETWEEN 0 AND 100000),
  case_daily integer CHECK (case_daily BETWEEN 0 AND 100000),
  notes_daily integer CHECK (notes_daily BETWEEN 0 AND 100000),
  questions_daily integer CHECK (questions_daily BETWEEN 0 AND 100000),
  paused boolean NOT NULL DEFAULT false,
  note text CHECK (note IS NULL OR char_length(note) <= 280),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  updated_by text
);

-- One row per AI request. Failed requests do not count against the allowance.
CREATE TABLE IF NOT EXISTS ai_usage (
  id bigserial PRIMARY KEY,
  firebase_uid text NOT NULL,
  feature text NOT NULL CHECK (feature IN ('chat', 'case', 'notes', 'questions', 'extract')),
  status text NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'completed', 'failed')),
  provider text,
  model text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS ai_usage_user_feature_time ON ai_usage (firebase_uid, feature, created_at DESC);

-- Last activity per signed-in account (drives the Active / Offline badge).
CREATE TABLE IF NOT EXISTS user_presence (
  firebase_uid text PRIMARY KEY CHECK (char_length(firebase_uid) BETWEEN 1 AND 128),
  email text,
  display_name text,
  last_seen_at timestamptz NOT NULL DEFAULT NOW(),
  last_page text CHECK (last_page IS NULL OR char_length(last_page) <= 40)
);

CREATE TABLE IF NOT EXISTS ai_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firebase_uid text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('chat', 'case', 'notes', 'questions')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  course_id uuid,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ai_conversations_user_time ON ai_conversations (firebase_uid, updated_at DESC);

CREATE TABLE IF NOT EXISTS ai_messages (
  id bigserial PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  status text NOT NULL DEFAULT 'done' CHECK (status IN ('pending', 'done', 'failed')),
  content text NOT NULL DEFAULT '',
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider text,
  model text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ai_messages_conversation ON ai_messages (conversation_id, id);

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT NOW()
);
INSERT INTO schema_migrations (name) VALUES ('002_ai_studio') ON CONFLICT (name) DO NOTHING;

COMMIT;
