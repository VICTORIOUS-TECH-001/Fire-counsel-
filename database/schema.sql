-- FIRE COUNSEL legal knowledge schema (Neon PostgreSQL)
-- Run this manually against the intended Neon database after reviewing it.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS courses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  jurisdiction text NOT NULL DEFAULT 'Nigeria',
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS materials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid REFERENCES courses(id) ON DELETE SET NULL,
  title text NOT NULL,
  material_type text NOT NULL CHECK (material_type IN
    ('lecturer_note','textbook','past_question','judgment','statute','other')),
  uploaded_by_uid text NOT NULL,
  processing_status text NOT NULL DEFAULT 'queued' CHECK (processing_status IN
    ('queued','processing','ready','failed')),
  jurisdiction text NOT NULL DEFAULT 'Nigeria',
  source_url text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS document_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  material_id uuid NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  course_id uuid REFERENCES courses(id) ON DELETE SET NULL,
  chunk_index integer NOT NULL,
  page_number integer,
  jurisdiction text NOT NULL DEFAULT 'Nigeria',
  chunk_text text NOT NULL,
  embedding vector(768),
  search_vector tsvector GENERATED ALWAYS AS
    (to_tsvector('english', coalesce(chunk_text, ''))) STORED,
  UNIQUE(material_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS document_chunks_search_idx
  ON document_chunks USING gin(search_vector);
CREATE INDEX IF NOT EXISTS document_chunks_embedding_idx
  ON document_chunks USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS legal_authorities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_name text NOT NULL,
  citation text,
  court text,
  year integer,
  jurisdiction text NOT NULL DEFAULT 'Nigeria',
  material_facts text,
  issues text,
  holding text,
  ratio_decidendi text,
  obiter text,
  legal_status text NOT NULL DEFAULT 'unverified' CHECK (legal_status IN
    ('good_law','overruled','distinguished','uncertain','unverified')),
  verification_status text NOT NULL DEFAULT 'unverified' CHECK (verification_status IN
    ('verified','unverified')),
  source_url text,
  pinpoint text,
  embedding vector(768),
  search_vector tsvector GENERATED ALWAYS AS
    (to_tsvector('english', concat_ws(' ', case_name, citation, material_facts,
      issues, holding, ratio_decidendi, obiter))) STORED,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS legal_authorities_search_idx
  ON legal_authorities USING gin(search_vector);
CREATE INDEX IF NOT EXISTS legal_authorities_embedding_idx
  ON legal_authorities USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS statutes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  provision text,
  text text NOT NULL,
  year integer,
  jurisdiction text NOT NULL DEFAULT 'Nigeria',
  effective_from date,
  effective_to date,
  verification_status text NOT NULL DEFAULT 'unverified' CHECK (verification_status IN
    ('verified','unverified')),
  source_url text,
  embedding vector(768),
  search_vector tsvector GENERATED ALWAYS AS
    (to_tsvector('english', concat_ws(' ', title, provision, text))) STORED,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS statutes_search_idx ON statutes USING gin(search_vector);
CREATE INDEX IF NOT EXISTS statutes_embedding_idx
  ON statutes USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS past_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid REFERENCES courses(id) ON DELETE SET NULL,
  material_id uuid REFERENCES materials(id) ON DELETE SET NULL,
  jurisdiction text NOT NULL DEFAULT 'Nigeria',
  exam_year integer,
  section_label text,
  question_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS past_questions_course_year_idx
  ON past_questions(course_id, exam_year DESC);

CREATE TABLE IF NOT EXISTS authority_relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_authority_id uuid NOT NULL REFERENCES legal_authorities(id) ON DELETE CASCADE,
  to_authority_id uuid NOT NULL REFERENCES legal_authorities(id) ON DELETE CASCADE,
  relationship text NOT NULL CHECK (relationship IN
    ('follows','overrules','distinguishes','approves','applies','criticises')),
  explanation text,
  source_url text,
  verification_status text NOT NULL DEFAULT 'unverified',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(from_authority_id, to_authority_id, relationship)
);

CREATE TABLE IF NOT EXISTS research_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  url text NOT NULL UNIQUE,
  publisher text,
  source_type text NOT NULL,
  jurisdiction text,
  checked_at timestamptz,
  verification_status text NOT NULL DEFAULT 'unverified'
);

-- Security design:
-- * Never expose DATABASE_URL to the browser.
-- * Only trusted admin backend jobs may insert/publish materials, cases,
--   statutes and past questions. Student API access is read-only.
-- * Verify Firebase ID tokens on every protected API request.
-- * Do not treat a user-supplied role or UID as proof of admin status.
-- * Add explicit admin-claim checks before implementing any upload route.
