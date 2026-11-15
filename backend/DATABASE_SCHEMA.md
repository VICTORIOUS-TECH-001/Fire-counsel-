# Neon schema review and FIRE COUNSEL admin map

## Source and scope

This map is based on the two user-supplied Neon exports dated 2026-11-15: public column names/types/defaults and public constraints/foreign keys. Together they describe **27 public tables and 232 columns**. They contain schema metadata, not row data. This workspace has no `DATABASE_URL` and no `backend/.env`, so this is not a live connection or a verification of the currently deployed Neon schema/data.

## Domain structure

### Academic hierarchy

`universities → faculties → departments` and `universities → courses → course_topics → topic_learning_objectives`.

- `courses` also has optional faculty/department links and a uniqueness rule across university, course code and academic session.
- Topics support a parent-topic tree and importance/publication fields.
- `institution_memberships` and `course_enrollments` connect users to institutions and courses; they contain account-specific data and should be managed in a dedicated, permission-checked workflow, not a public content editor.

### Learning materials and provenance

`materials → material_versions → material_chunks`.

- `materials` owns the title, course/topic/university, type, source, access scope, approval and publication state, and optional file metadata/path.
- `material_versions` owns versioned extracted text and an optional `file_storage_path`.
- `material_chunks` owns text chunks and an optional custom `embedding` column. Chunks/embeddings are derived search/AI data, not normal hand-edited content.
- `material_authorities` links a material to either a case or a statute section (the database constraint requires exactly one of those links).
- The export describes storage *paths* but does not say which object-storage provider holds file bytes. Do not treat Neon as a binary file store or invent a Firebase bucket path for course files.

### Legal authorities and assessment content

- `legal_cases` stores case name, citation, jurisdiction, court, year, facts, issues, decision, ratio, obiter and verification state. It may reference a source material.
- `case_mnemonics` and `case_memory_summaries` attach memory content to cases; summaries have a review state. Generated/AI content must remain disabled until the separate provider and content-authorization review.
- `statutes → statute_sections` stores the law, section text, simplified explanation, legal effect and amendment note.
- `past_questions` stores question text, year/semester/marks/duration, provenance, source material and verification state. `question_topic_links` connects questions to topics.
- `marking_rubrics → marking_criteria` connects course/question rubrics to ordered criteria and marks.

### Identity, roles and private study data

- `app_users` maps a Neon profile to Firebase using unique `firebase_uid` and `email`; it stores profile/status metadata, **not passwords**.
- `roles`, `permissions`, `role_permissions` and `user_roles` are authorization tables. Changes to them must not be exposed as ordinary content CRUD; the verified Firebase `admin: true` claim remains the server-side gate.
- `student_flash_cases` contains per-user notes and recall data. Do not expose every student's private study data in a general admin database browser, and do not migrate browser-local study records without a separate consent/data-preservation plan.

## Admin-panel boundary

The **Neon Database Data** area now uses domain forms (academic setup, materials/versions, cases/statutes, past questions/rubrics) and relation pickers, not raw SQL or arbitrary table/column editing. It shows approval/publication/access state, supports search/list/edit, and requires a confirmation before delete. Universities, courses, topics and materials are deactivated/unpublished where supported; other deletes follow the database foreign-key cascades described in the export. Material text is versioned and split into plain searchable chunks. Actor IDs such as `uploaded_by`, `created_by`, `approved_by` are resolved by the server from a Firebase-verified admin, never accepted from form inputs. Actual Neon operations remain inactive until the server's private `DATABASE_URL` is configured and the supplied snapshot is checked against the live schema.

Firebase remains a separate area for Firebase Auth accounts/admin claims and the homepage slideshow images. Password changes/reset are Firebase Auth operations; a password is never readable or stored in Neon. A safe admin action is to send a password-reset email, not to display or reuse a password.

## AI / research boundary

The schema is well suited to a future source-grounded research pipeline: retrieve only approved/published, access-eligible material versions/chunks, then related cases/statutes and verified past questions/rubrics; return citations back to those rows. `material_chunks.embedding`, `case_memory_summaries` and generated questions must not be used to imply a source is authoritative. No provider key, prompt transmission, Gemini request, automatic mnemonic/question generation or quota enforcement is enabled by this schema review. Provider terms, student-content eligibility, retention and authorization must be reviewed first; any provider secret belongs in a server secret manager, never Neon or browser code.

## Live integration prerequisite

Set the Neon pooled connection URL privately in the ignored `backend/.env` as `DATABASE_URL` when ready; do not paste it into chat. The API enforces TLS certificate/hostname validation. Before write routes run against Neon, compare this snapshot against the live schema, take a backup, test routes on disposable/staging data, and document the chosen object-storage provider for file uploads. No database migration, live write, deletion, or Firebase change was made by this schema review.
