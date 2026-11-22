#!/usr/bin/env python3
"""Index the "Case and study materials" store.

Produces two artefacts from whatever is on disk:

  1. data/manifest.json — the catalogue: every file, its date, its size, its
     SHA-256, its kind and its status. This is the "online store" index.
  2. data/db-seed/*.sql  — idempotent INSERTs for the Neon tables the project
     already documents (materials, material_versions, legal_cases,
     case_mnemonics), so the same records can be pushed to the database.

The SQL is a seed, not a migration. The repository's own DATABASE_SCHEMA.md
warns that the deployed Neon schema has not been checked against this checkout,
so run it only after a schema review and inside a transaction.

Usage:  python3 tools/casebook/build_manifest.py
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
STORE = ROOT / "Case and study materials"
MANIFEST = STORE / "data" / "manifest.json"
SEED = STORE / "data" / "db-seed"

KIND = {
    ".pdf": "pdf", ".md": "text/markdown", ".json": "data",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".sql": "sql",
}
# Which files are deliverables people should download, and which are inputs
# or machine-readable data kept alongside them.
ROLE = {
    "pdf": "deliverable",
    "source": "source record",
    "data": "machine-readable record",
    ".": "store guide",
}


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def dated_name(name: str):
    """Split a leading YYYY-MM-DD off a filename, per the store convention."""
    m = re.match(r"^(\d{4}-\d{2}-\d{2})_(.+)$", name)
    if m:
        return m.group(1), m.group(2)
    return None, name


def sql_str(value) -> str:
    if value is None:
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"


def scan(meta, cases) -> tuple[list, dict]:
    records = []
    for path in sorted(STORE.rglob("*")):
        if not path.is_file() or path.name == "manifest.json":
            continue
        rel = path.relative_to(STORE)
        date_part, bare = dated_name(path.name)
        stat = path.stat()
        records.append({
            "path": rel.as_posix(),
            "name": bare,
            "date": date_part or meta["research_date"],
            "folder": rel.parts[0] if len(rel.parts) > 1 else ".",
            "role": ROLE.get(rel.parts[0] if len(rel.parts) > 1 else ".", "record"),
            "kind": KIND.get(path.suffix.lower(), "file"),
            "bytes": stat.st_size,
            "sha256": sha256(path),
            "modified": datetime.fromtimestamp(
                stat.st_mtime, tz=timezone.utc).isoformat(timespec="seconds"),
        })

    manifest = {
        "store": "Case and study materials",
        "title": meta["title"],
        "subject": meta["subject"],
        "research_date": meta["research_date"],
        "version": meta["version"],
        "generated": datetime.now(tz=timezone.utc).isoformat(timespec="seconds"),
        "naming_convention": "YYYY-MM-DD_<slug>_v<version>.<ext>",
        "folders": {
            "source/": "the uploaded photograph, the verbatim transcription and "
                       "the research brief, kept as the evidence of what was asked",
            "cases/": "one file per authority, so a single case can be handed out "
                      "on its own",
            "data/": "the machine-readable record: cases.json, "
                     "synthesis-and-questions.json, this manifest and the SQL seed",
            "pdf/": "the compiled deliverables",
        },
        "authorities": [
            {"number": c["number"], "name": c["name"],
             "citation": c["citation_short"], "court": c["court"],
             "jurisdiction": c["jurisdiction"], "confidence": c["confidence"],
             "textbook_page": c["textbook_page"]}
            for c in cases
        ],
        "files": records,
        "total_bytes": sum(r["bytes"] for r in records),
    }
    MANIFEST.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
                        encoding="utf-8")
    print(f"manifest: {MANIFEST.relative_to(ROOT)} ({len(records)} files, "
          f"{manifest['total_bytes']:,} bytes)")
    return records, manifest


def seed(meta, cases, records, manifest) -> None:
    SEED.mkdir(parents=True, exist_ok=True)

    # ---------------------------------------------------------- cases seed
    lines = [
        "-- Seed for the legal_cases table, generated from data/cases.json.",
        "-- Run inside a transaction after a schema review; every insert is",
        "-- guarded so re-running does not duplicate rows.",
        "BEGIN;",
        "",
    ]
    for c in cases:
        if c["id"] == "statutes":
            continue
        year = None
        m = re.search(r"\[?\(?(\d{4})\)?", c["citation_verified"])
        if m:
            year = m.group(1)
        cite = c["citation_short"]
        lines.append("INSERT INTO legal_cases")
        lines.append("  (case_name, citation, jurisdiction, court, year, facts, "
                     "issues, decision, ratio, verification_status)")
        lines.append("SELECT")
        lines.append(f"  {sql_str(c['name'])}, {sql_str(cite)}, "
                     f"{sql_str(c['jurisdiction'])}, {sql_str(c['court'])}, "
                     f"{sql_str(year)},")
        lines.append(f"  {sql_str(c['facts'])}, {sql_str(c['issues'])}, "
                     f"{sql_str(c['holding'])}, {sql_str(c['ratio'])}, "
                     f"{sql_str(c['confidence'].split(' ')[0].lower())}")
        lines.append("WHERE NOT EXISTS (")
        lines.append(f"  SELECT 1 FROM legal_cases WHERE citation = {sql_str(cite)});")
        lines.append("")
        if c.get("mnemonics"):
            m_ = c["mnemonics"]
            lines.append("INSERT INTO case_mnemonics (case_id, mnemonic)")
            lines.append("SELECT id, " + sql_str(
                f"{m_['facts_mnemonic']} | RULE: {m_['rule_mnemonic']} | "
                f"TRIGGER: {m_['trigger']}"))
            lines.append(f"FROM legal_cases WHERE citation = {sql_str(cite)};")
            lines.append("")
    lines.append("COMMIT;")
    (SEED / "2026-11-22_legal_cases_seed_v1.0.sql").write_text("\n".join(lines) + "\n",
                                             encoding="utf-8")

    # ------------------------------------------------------- materials seed
    pdf = next((r for r in records if r["kind"] == "pdf"), None)
    body = "\n".join(
        f"-- {rec['path']}  ({rec['date']}, {rec['bytes']:,} bytes, sha256 "
        f"{rec['sha256'][:16]}...)" for rec in records)
    materials = f"""-- Seed for materials / material_versions / material_authorities.
-- Generated from data/manifest.json on {manifest['generated']}.
-- Review DATABASE_SCHEMA.md first: the deployed schema has not been checked
-- against this checkout, and materials.content_text belongs in
-- material_versions, not in materials.
BEGIN;

INSERT INTO materials
  (title, material_type, source, approval_status, publication_status)
SELECT {sql_str(meta['title'])}, 'casebook', 'FIRE COUNSEL research workspace',
       'approved', 'published'
WHERE NOT EXISTS (SELECT 1 FROM materials WHERE title = {sql_str(meta['title'])});

-- File record for the compiled PDF:
--   file_storage_path: {pdf['path'] if pdf else 'none'}
--   sha256: {pdf['sha256'] if pdf else 'none'}
--   bytes: {pdf['bytes'] if pdf else 0}
--
-- Files in this store:
{body}

-- Link each case row to this material after both exist:
-- INSERT INTO material_authorities (material_id, case_id)
-- SELECT m.id, c.id FROM materials m, legal_cases c
-- WHERE m.title = {sql_str(meta['title'])} AND c.citation IN (...);

COMMIT;
"""
    (SEED / "2026-11-22_materials_seed_v1.0.sql").write_text(materials, encoding="utf-8")
    print(f"seed:     {SEED.relative_to(ROOT)}")


def main() -> None:
    data = json.loads(
        (STORE / "data" / "2026-11-22_cases_v1.0.json").read_text(encoding="utf-8"))
    meta, cases = data["casebook"], data["cases"]
    # Scan, write the seed, then scan again: the seed files are themselves
    # store files, so the manifest has to hash them too.
    records, man = scan(meta, cases)
    seed(meta, cases, records, man)
    scan(meta, cases)


if __name__ == "__main__":
    main()
