-- FIRE COUNSEL: website publishing + document uploads stored in Neon.
-- Additive and idempotent (IF NOT EXISTS): existing tables and rows are never
-- changed or deleted. Firebase Storage now needs the paid Blaze plan, so the
-- original files and website photos are kept in Neon instead.
BEGIN;

-- Website content: one "draft" slot the admin edits and previews, one
-- "published" slot the public homepage reads.
CREATE TABLE IF NOT EXISTS site_content (
  slot text PRIMARY KEY CHECK (slot IN ('draft', 'published')),
  content jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  updated_by text
);

-- Every publish is kept so a mistake can be undone (the newest 50 are kept).
CREATE TABLE IF NOT EXISTS site_content_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content jsonb NOT NULL,
  note text CHECK (note IS NULL OR char_length(note) <= 200),
  published_by text,
  created_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS site_content_versions_time ON site_content_versions (created_at DESC);

-- Homepage slideshow photos (served at /media/<id>.<ext>).
CREATE TABLE IF NOT EXISTS site_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name text,
  mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 8388608),
  data bytea NOT NULL,
  uploaded_by text,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

-- Original uploaded documents (PDF, Word, photos, text) and their reading job.
CREATE TABLE IF NOT EXISTS uploaded_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose text NOT NULL CHECK (purpose IN ('material', 'case', 'past_questions', 'material_version')),
  file_name text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 200),
  mime_type text NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes > 0),
  sha256 text NOT NULL,
  data bytea,
  status text NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'processing', 'ready', 'saved', 'failed')),
  progress text,
  method text,
  page_count integer,
  characters integer,
  extracted_text text,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb,
  error_code text,
  error_message text,
  attempts integer NOT NULL DEFAULT 0,
  uploaded_by text,
  uploaded_by_email text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS uploaded_files_time ON uploaded_files (created_at DESC);
CREATE INDEX IF NOT EXISTS uploaded_files_status ON uploaded_files (status) WHERE status IN ('uploaded', 'processing');

-- Fast word search over the library text the AI reads.
CREATE INDEX IF NOT EXISTS material_chunks_fts ON material_chunks USING gin (to_tsvector('english', content));

INSERT INTO schema_migrations (name) VALUES ('003_site_and_documents') ON CONFLICT (name) DO NOTHING;

COMMIT;
