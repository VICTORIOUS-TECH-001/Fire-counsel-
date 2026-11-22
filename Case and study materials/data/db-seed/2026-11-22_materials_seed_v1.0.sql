-- Seed for materials / material_versions / material_authorities.
-- Generated from data/manifest.json on 2026-11-22T02:57:17+00:00.
-- Review DATABASE_SCHEMA.md first: the deployed schema has not been checked
-- against this checkout, and materials.content_text belongs in
-- material_versions, not in materials.
BEGIN;

INSERT INTO materials
  (title, material_type, source, approval_status, publication_status)
SELECT 'OFFER — CASEBOOK AND STUDY MATERIALS', 'casebook', 'FIRE COUNSEL research workspace',
       'approved', 'published'
WHERE NOT EXISTS (SELECT 1 FROM materials WHERE title = 'OFFER — CASEBOOK AND STUDY MATERIALS');

-- File record for the compiled PDF:
--   file_storage_path: pdf/2026-11-22_OFFER-casebook_v1.0.pdf
--   sha256: 4f1155ea81baf4444694bbfa054693249b5cad09aefff11d28e948175c14ca56
--   bytes: 380921
--
-- Files in this store:
-- 2026-11-22_Case-and-study-materials_store_v1.0.md  (2026-11-22, 9,209 bytes, sha256 0aa830730fe7998a...)
-- cases/2026-11-22_01_Storer-v-Manchester-City-Council_v1.0.md  (2026-11-22, 12,091 bytes, sha256 c91ae30816c78e4f...)
-- cases/2026-11-22_02_Alhaji-M-C-Dahiru-Anor-v-Alhaji-Bubakare-Kamale_v1.0.md  (2026-11-22, 14,371 bytes, sha256 8fb45781cd195f7c...)
-- cases/2026-11-22_03_United-Bank-for-Africa-Ltd-v-Tejumola-Sons-Ltd_v1.0.md  (2026-11-22, 12,509 bytes, sha256 9e62a15df18d5102...)
-- cases/2026-11-22_04_Agomo-also-reported-as-Agoma-v-Guinness-Nigeria-Ltd_v1.0.md  (2026-11-22, 11,115 bytes, sha256 19b5aff8331726ee...)
-- cases/2026-11-22_05_Sparkling-Breweries-Ltd-5-Ors-v-Union-Bank-of-Nigeria-Ltd_v1.0.md  (2026-11-22, 10,672 bytes, sha256 2113730632be1eaf...)
-- cases/2026-11-22_06_S-A-Adebanjo-v-A-A-Brown_v1.0.md  (2026-11-22, 12,273 bytes, sha256 fa3241453f478cc7...)
-- cases/2026-11-22_07_Union-Bank-of-Nigeria-Ltd-v-Sax-Nigeria-Ltd-2-Ors_v1.0.md  (2026-11-22, 9,789 bytes, sha256 26f5f4db72046f8e...)
-- cases/2026-11-22_08_Non-case-authorities-registered-under-Section-1-of-the-research-prompt_v1.0.md  (2026-11-22, 5,674 bytes, sha256 32aa87fee0f791eb...)
-- data/2026-11-22_cases_v1.0.json  (2026-11-22, 95,818 bytes, sha256 587e8ec68b2e72f8...)
-- data/2026-11-22_synthesis-and-questions_v1.0.json  (2026-11-22, 26,964 bytes, sha256 f9c1242a7ea4b10d...)
-- data/db-seed/2026-11-22_legal_cases_seed_v1.0.sql  (2026-11-22, 22,700 bytes, sha256 45ee63e07fa67cd8...)
-- data/db-seed/2026-11-22_materials_seed_v1.0.sql  (2026-11-22, 3,176 bytes, sha256 3c5adb0a254f708c...)
-- pdf/2026-11-22_OFFER-casebook_v1.0.pdf  (2026-11-22, 380,921 bytes, sha256 4f1155ea81baf444...)
-- source/2026-11-22_Master-Prompt_All-Cases-Research.pdf  (2026-11-22, 28,356 bytes, sha256 f3ac0cd941e852a2...)
-- source/2026-11-22_Textbook-page-23_Offer_original-photo.jpg  (2026-11-22, 3,685,285 bytes, sha256 b9eef58b70d2b9e6...)
-- source/2026-11-22_Textbook-page-23_Offer_verbatim.md  (2026-11-22, 2,908 bytes, sha256 47f1a2767d6c4968...)

-- Link each case row to this material after both exist:
-- INSERT INTO material_authorities (material_id, case_id)
-- SELECT m.id, c.id FROM materials m, legal_cases c
-- WHERE m.title = 'OFFER — CASEBOOK AND STUDY MATERIALS' AND c.citation IN (...);

COMMIT;
