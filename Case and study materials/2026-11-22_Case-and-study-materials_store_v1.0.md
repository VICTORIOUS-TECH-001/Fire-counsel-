# Case and study materials — the store

This folder is a self-contained, versioned legal-research store. Everything in
it is dated, and every authority is labelled `VERIFIED`, `PARTLY VERIFIED` or
`UNVERIFIED (secondary source only)`.

The first entry is the **Offering** casebook compiled from page 23 of the
uploaded Law of Contract text: the definition of an offer at 2.1 and the first
condition for an offer at 2.2.

---

## 1. What is in here

```
Case and study materials/
├── 2026-11-22_Case-and-study-materials_store_v1.0.md   this file
├── source/                         the evidence of what was asked
│   ├── 2026-11-22_Textbook-page-23_Offer_original-photo.jpg
│   ├── 2026-11-22_Textbook-page-23_Offer_verbatim.md
│   └── 2026-11-22_Master-Prompt_All-Cases-Research.pdf
├── cases/                          one standalone file per authority
├── data/
│   ├── 2026-11-22_cases_v1.0.json                  the master record
│   ├── 2026-11-22_synthesis-and-questions_v1.0.json
│   ├── manifest.json               the catalogue (dates, sizes, SHA-256)
│   └── db-seed/
│       ├── 2026-11-22_legal_cases_seed_v1.0.sql
│       └── 2026-11-22_materials_seed_v1.0.sql
└── pdf/
    └── 2026-11-22_OFFER-casebook_v1.0.pdf   108 pages
```

**Naming convention:** `YYYY-MM-DD_<slug>_v<version>.<ext>`. Dates sort
correctly as text, so the newest material always appears first or last
depending on sort direction, and an older version is never overwritten.

### The deliverable

`pdf/2026-11-22_OFFER-casebook_v1.0.pdf` — 108 pages, 7 cases and 1 statutory
class, each with:

- A citation block with the verification label and what remains unverified
- Sections A–L: citation, textbook connection, facts, procedural history,
  issues, holding, ratio, the exact rule, exceptions, application, later
  treatment, examination significance
- Sources, tiered A–G, with working links and access dates
- A clearly separated `SECONDARY-SOURCE ACCOUNT — UNVERIFIED` block, written
  last, as the master prompt requires
- An exam-ready fast-writing note with at least five lines of facts
- Mnemonics and a recall drill
- Doctrinal synthesis, 8 theory questions, 6 problem questions with answer
  guides, and an oral test
- A research audit stating exactly what was searched and what was not

---

## 2. What the research found

Three printed errors on page 23 are corrected, and the correction is recorded
rather than silently applied:

| Printed on page 23 | Verified | Note |
| --- | --- | --- |
| `Dahiru v Kamale [2005] 9 NWLR (Pt 929) 50` | `(2005) 9 NWLR (Pt 929) 8` | The report begins at page 8, not 50. |
| The definition attributed to Ogbuagu JSC in *Dahiru* | The words are reported from *Sparkling Breweries Ltd v Union Bank of Nigeria Ltd* (2001) 15 NWLR (Pt 737) 539 — the page's own footnote 4 | Either a mis-sourcing, or his Lordship repeating himself. Cite *Sparkling Breweries* for the words. |
| `Agomo v Guinness (Nig) Plc [1995] 2 NWLR (Pt 580) 672` | `(1995) 2 NWLR (Pt 380) 672` | Part 380, not 580. The report also prints the appellant as "Agoma". |

Two further conflicts are recorded in the casebook: the date of *Adebanjo v
Brown* (7 June vs 8 June 1990), and the part number in *Sax* (361, sometimes
misprinted as 36).

Every authority is present. Nothing was dropped for being hard to find.

---

## 3. Formatting, and one recorded deviation

Applied: A4, body 16 pt, line spacing 2.0 (double), justified body text, word
spacing 0.2 cm (the lower end of the 0.2–0.3 cm range), clear headings,
generous margins, page numbers, contents page with real page numbers.

**Deviation:** the instruction asked for "alphabet spacing 0.1–0.15 inch". That
is 2.54–3.81 mm between every letter. At 16 pt it multiplies the width of a word
by about six, so a line of ordinary text would be several metres long and cannot
be placed on A4 at all — the same instruction forbids clipped or overlapping
text. Letter tracking of 0.12 pt is used instead: it gives the airy, spaced-out
appearance 0.1 inch is aiming at while keeping the text readable and inside the
margins. This is stated on page 2 of the PDF itself, not hidden here.

---

## 4. Rebuilding

The PDF is generated, not hand-written, so it can be rebuilt after any edit to
the JSON records in `data/`:

```bash
pip install reportlab            # the only build dependency
python3 tools/casebook/build_casebook.py   # writes pdf/<date>_OFFER-casebook_v<ver>.pdf
python3 tools/casebook/split_cases.py      # rewrites cases/*.md
python3 tools/casebook/build_manifest.py   # rewrites the manifest and both SQL seeds
```

`tools/casebook/typewriter.py` is a small typesetting engine written for this
store. It does its own line breaking and justification against real font
metrics, because ReportLab's paragraph engine cannot honour both the requested
word spacing and letter tracking without running past the right margin. The
build runs twice: the first pass records where each section lands, the second
writes those page numbers into the contents page.

---

## 5. Getting it online for free — the options

You asked for ideas for free online spaces to put the PDF, and to push the text
into your database. There are three separate jobs here, and free services differ
in which they do well.

### A. Serve the PDF files (the "online store")

| Service | Free tier | Good for | Watch out for |
| --- | --- | --- | --- |
| **GitHub Releases** | 2 GB per file, unlimited public bandwidth | Versioned PDF downloads with stable URLs; `v1.0`, `v1.1` alongside the tag | Everything is public; the repo is public already, so this changes nothing. |
| **Cloudflare Pages / R2** | Pages: unlimited requests; R2: 10 GB storage, no egress fee | The fastest free option for students in Nigeria; R2 has no download charges | R2 needs a card on file even on the free tier. |
| **Netlify / Vercel** | 100 GB bandwidth/month | Drag-and-drop of a folder; instant custom URL | Commercial-use and bandwidth limits; fine for a course, not for a faculty. |
| **Firebase Hosting** | 10 GB storage, 360 MB/day transfer | Already in this project (`firebase.json` exists) | 360 MB/day is roughly 900 downloads of this 380 KB PDF — enough for a class, not a faculty, and the Spark plan has no card requirement. |
| **Internet Archive** | Free | Permanent public archive of a legal-research document; a citation URL that outlives your hosting | Public domain/permission questions; do not upload a textbook you do not own. |

**For your current setup, the shortest path is GitHub Releases.** Create a tag,
attach the PDF, and the URL is permanent and versioned:

```bash
gh release create casebook-v1.0 \
  "Case and study materials/pdf/2026-11-22_OFFER-casebook_v1.0.pdf" \
  --title "OFFER casebook v1.0" \
  --notes "Seven cases from page 23 of the contract text, fully analysed."
```

### B. Serve the text as a browsable study site

The `cases/*.md` files are already one case per file. Turn them into a static
site with **GitHub Pages + Jekyll** (zero cost, builds from the repo) or
**MkDocs Material** if you want search. Both read the existing front matter —
`title`, `citation`, `court`, `confidence` — without any rewriting.

Do **not** publish the unverified blocks as if they were law. The labels in the
front matter exist so a site template can render `VERIFIED` differently from
`UNVERIFIED (secondary source only)`.

### C. Push the text into your database

`data/db-seed/` contains idempotent SQL for the tables this project already
documents in `backend/DATABASE_SCHEMA.md`:

- `2026-11-22_legal_cases_seed_v1.0.sql` — one guarded insert per case into
  `legal_cases`, plus `case_mnemonics` rows. Re-running does not duplicate.
- `2026-11-22_materials_seed_v1.0.sql` — a `materials` row for the casebook, with the file path,
  size and SHA-256 recorded in comments, ready to attach to
  `material_versions` / `material_authorities`.

Both parse as valid PostgreSQL. Run them **only** after the schema review that
`DATABASE_SCHEMA.md` asks for, and inside the transaction the files already
declare. The byte-level file index lives in `data/manifest.json` — path, date,
size, SHA-256 — which is what you want for a download page or a sync job.

**Where the bytes should not go:** not into Neon. Neon is a relational database;
large binaries belong in object storage (R2, Firebase Storage, S3) with only the
path and hash stored in the row. `DATABASE_SCHEMA.md` already says the same.

---

## 6. Honest limits

- LawPavilion, vLex and Legalpedia are paywalled. Nothing from them is claimed
  as read.
- The full Supreme Court judgment in *Dahiru v Kamale* was not located in free
  full text. The entry is marked `PARTLY VERIFIED` for that reason.
- Only page 23 of the textbook was supplied, so the book's authorship, edition
  and any wider context could not be checked.
- *Gibson v Manchester City Council* [1979] 1 WLR 294 is discussed but its
  report was not opened; that is marked in the entry.
- This is research and study material, not legal advice, and the questions are
  practice questions, not predictions.
