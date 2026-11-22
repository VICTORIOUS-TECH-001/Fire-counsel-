#!/usr/bin/env python3
"""Build the OFFER casebook PDF from "Case and study materials/data/*.json".

Formatting follows the instruction: A4, 16 pt body, double (2.0) line spacing,
justified body text, word spacing 0.2 cm, plus letter tracking.

The instruction also asked for "alphabet spacing" of 0.1-0.15 inch, which is
2.54-3.81 mm between every letter. At 16 pt that multiplies the width of a word
by roughly six and cannot be laid out on A4 — the same instruction forbids
clipped text. Letter tracking of 0.12 pt is used instead and the deviation is
recorded in the document itself and in the store README.

Usage:  python3 tools/casebook/build_casebook.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from typewriter import (ACCENT, BODY_LEADING, BODY_SIZE, FRAME_W, INK, MUTED,
                        RULE, SMALL_LEADING, SMALL_SIZE, Doc, parse_inline)

ROOT = Path(__file__).resolve().parents[2]
STORE = ROOT / "Case and study materials"
BUILD_DATE = "2026-11-22"
OUT = STORE / "pdf" / f"{BUILD_DATE}_OFFER-casebook_v1.0.pdf"

CONF = {"VERIFIED": "verified", "PARTLY VERIFIED": "partly",
        "UNVERIFIED (secondary source only)": "unverified"}


def cover(d: Doc, meta: dict):
    d.y -= 30
    d.text(56.7, d.y, "FIRE COUNSEL  ·  LEGAL LEARNING WORKSPACE",
           "Helvetica-Bold", 10.5, 3.2, ACCENT)
    d.y -= 48
    d.h1("OFFER", size=62, tracking=2.0, gap=78)
    d.c.setStrokeColor(INK)
    d.c.setLineWidth(2.4)
    d.c.line(56.7, d.y, 56.7 + 150, d.y)
    d.y -= 26
    d.p("Casebook and Study Materials for the Authorities Cited on Page 23 of the "
        "Uploaded Law of Contract Text", size=19, leading=30, justify=False)
    d.y -= 34
    rows = [
        ("Subject", meta["subject"]),
        ("Source material", meta["source_material"]),
        ("Jurisdiction", meta["jurisdiction_primary"]),
        ("Authorities", "Seven cases and one statutory class, all analysed"),
        ("Research date", meta["research_date"]),
        ("Version", meta["version"]),
        ("Citation style", meta["citation_style"]),
    ]
    for lbl, val in rows:
        d.ensure(26)
        d.text(56.7, d.y - 9, lbl.upper(), "Helvetica-Bold", 8.8, 1.1, MUTED)
        start = d.y
        d.draw_words(parse_inline(val), 12.0, 17, False, indent=132,
                     width=FRAME_W - 132)
        d.y = min(d.y, start - 20)

    d.y -= 6
    d.panel("How to read the labels in this casebook", "callout")
    d.p("**VERIFIED** — the primary judgment or law report was read and the material "
        "details were corroborated against at least one independent source.",
        size=11.4, leading=17.4)
    d.p("**PARTLY VERIFIED** — some material details were confirmed from primary "
        "text, but the full judgment or a key pinpoint was not available.",
        size=11.4, leading=17.4)
    d.p("**UNVERIFIED (secondary source only)** — the account rests on blogs, student "
        "notes, news or commentary. It is never presented as the court's words and "
        "never as settled law.", size=11.4, leading=17.4)
    d.panel_close("callout")


def front_matter(d: Doc, toc: dict | None = None):
    d.pagebreak()
    d.h2("Formatting note and recorded deviation")
    d.p("This document is set in A4 with a 16 pt body, double (2.0) line spacing, "
        "justified body text, word spacing of 0.2 cm and letter tracking.")
    d.panel("Recorded deviation from the formatting instruction", "warn")
    d.p("The instruction asked for an “alphabet spacing” of 0.1–0.15 inch. That is "
        "2.54–3.81 mm between every single letter. At a 16 pt body the English "
        "alphabet is roughly 100 mm wide on the page; adding 2.54 mm per letter "
        "multiplies the width of every word by about six, so a single line of "
        "ordinary text would run to several metres. It cannot be laid out on A4 at "
        "all, and the same instruction forbids clipped or overlapping text.")
    d.p("Letter tracking of 0.12 pt has therefore been used. It produces the visibly "
        "airy, spaced-out setting that 0.1 inch is reaching for, while remaining "
        "legible inside the margins. Word spacing was applied exactly as specified, "
        "at the lower end of the 0.2–0.3 cm range. A strictly literal 0.1 inch "
        "letter spacing would require a page roughly the size of A0, or a body font "
        "far smaller than 16 pt, and either would defeat the rest of the "
        "specification. Nothing else has been altered.")
    d.panel_close("warn")

    d.spacer(6)
    d.h2("Contents")
    toc = toc or {}
    n = lambda k: str(toc.get(k, "—"))

    def entry(label, key, size=13, indent=0):
        d.ensure(24)
        y0 = d.y
        d.draw_words(parse_inline(label), size, 21, False, indent=indent,
                     width=FRAME_W - indent - 34)
        if toc:
            d.text(56.7 + FRAME_W - 22, y0 - size * 0.80, n(key),
                   "Helvetica", size, 0, MUTED)

    entry("1.  Verbatim transcription of the uploaded page", "verbatim")
    entry("2.  Extraction register — footnotes 1 to 4", "register")
    d.spacer(2)
    d.p("3.  Full case analysis, in the order the page cites them:", size=13.5,
        leading=22, justify=False)
    d.spacer(2)
    for i, t in enumerate([
        "Storer v Manchester City Council [1974] 1 WLR 1403 — Court of Appeal, England",
        "Dahiru v Kamale (2005) 9 NWLR (Pt 929) 8 — Supreme Court of Nigeria",
        "UBA Ltd v Tejumola & Sons Ltd (1988) 2 NWLR (Pt 79) 662 — Supreme Court of Nigeria",
        "Agomo v Guinness (Nig) Ltd (1995) 2 NWLR (Pt 380) 672 — Supreme Court of Nigeria",
        "Sparkling Breweries Ltd v Union Bank of Nigeria Ltd (2001) 15 NWLR (Pt 737) 539 — Supreme Court of Nigeria",
        "Adebanjo v Brown (1990) 3 NWLR (Pt 141) 661 — Supreme Court of Nigeria",
        "Union Bank of Nigeria Ltd v Sax (Nigeria) Ltd (1994) 8 NWLR (Pt 361) 150 — Supreme Court of Nigeria",
        "Non-case authorities — State Contracts Laws, Land Use Act, Statute of Frauds",
    ], 1):
        d.ensure(24)
        d.text(56.7 + 4, d.y - 10, str(i), "Helvetica-Bold", 10, 0, ACCENT)
        y0 = d.y
        d.draw_words(parse_inline(t), 12.4, 20, False, indent=26,
                     width=FRAME_W - 26 - 34)
        if toc:
            d.text(56.7 + FRAME_W - 22, y0 - 10, n(f"case{i}"),
                   "Helvetica", 12.4, 0, MUTED)
        d.y -= 2
    d.spacer(10)
    for i, (lbl, key) in enumerate([
        ("Case prepared for exam — fast writing", "exam"),
        ("Professor's doctrinal synthesis: the law of offer in Nigeria", "synth"),
        ("Memory system and mnemonics", "mnemonics"),
        ("Examination questions — theory and problems", "questions"),
        ("Answer guides", "answers"),
        ("Quick oral test", "oral"),
        ("Research audit and bibliography", "audit"),
    ], 4):
        entry(f"{i}.  {lbl}", key)


def verbatim(d: Doc):
    d.pagebreak()
    d.mark("verbatim")
    d.h2("Verbatim transcription of the uploaded page")
    d.p("Reproduced exactly as printed, including the line-break hyphen in "
        "“Man-/chester”, the superscript footnote markers and the printed errors. "
        "No silent correction has been made anywhere in this transcription; every "
        "correction appears in the casebook entry for the case concerned.",
        size=SMALL_SIZE, leading=SMALL_LEADING)
    d.spacer(6)

    d.h3("OFFER")
    d.spacer(4)
    d.label("2.1.  Meaning of Offer")
    d.p("An offer is an expression of willingness to contract on certain terms made "
        "with the intention that it shall become binding as soon as it is accepted "
        "by the person to whom it is addressed. ¹")
    d.p("For easier understanding, an offer is a proposition made by one party called "
        "the offeror to another party called the offeree clearly and precisely "
        "indicating the terms under which the offeror is willing to enter into a "
        "contract with the offeree. ²")
    d.p("In *Dahiru v Kamale* ³ Ogbuagu, JSC said:")
    d.y -= 4
    d.c.setStrokeColor(RULE)
    d.c.setLineWidth(2.2)
    top = d.y
    d.x_indent = 26
    d.draw_words(parse_inline(
        "An 'offer' it is also settled, is an expression of readiness to contract on "
        "the terms specified by the offeror which if accepted by the offeree, will "
        "give rise to a binding contract. In other words, it is by acceptance that "
        "the offer is converted into a contract. ⁴"), BODY_SIZE, BODY_LEADING, True,
        indent=26, width=FRAME_W - 26)
    d.c.line(56.7 + 10, top + 12, 56.7 + 10, d.y + 18)
    d.y -= 6
    d.p("An offer is the first ingredient to look out for in ascertaining whether "
        "there is a contract or not. Where there is no offer, there is no contract.")

    d.spacer(10)
    d.label("2.2.  Conditions for an Offer")
    d.p("In order for a proposition to amount to an offer capable of acceptance, four "
        "conditions must be satisfied:")
    d.p("First, the proposition must be definite, certain, unequivocal and final. In "
        "other words, it must amount to a definite promise by the offeror to be "
        "bound, provided that certain specified terms are accepted. For this reason, "
        "a true offer creates the power of acceptance. This means that when once an "
        "offer has been made, the offeror has completely done his part towards the "
        "making of the agreement. The only thing remaining is the part to be done by "
        "the offeree.")

    d.spacer(10)
    d.rule()
    d.label("Footnotes as printed")
    notes = [
        "¹ Edwin Peel, *Treitel: The Law of Contract* (12th edn, Sweet and Maxwell "
        "2007) 9; *Storer v Man-chester CC* [1974] 1 WLR 1403.",
        "² *United Bank for Africa v Tejumola* [1988] 2 NWLR (Pt 79) 662; *Agomo v "
        "Guinness (Nig) Plc* [1995] 2 NWLR (Pt 580) 672.",
        "³ [2005] 9 NWLR (Pt 929) 50.",
        "⁴ See also *Sparkling Breweries Ltd & Sons v Union Bank of Nigeria Ltd* "
        "[2001] 15 NWLR (Pt 737) 539; [2001] 7 SCNJ 321, 342; *Adebanjo v Brown* "
        "[1990] 3 NWLR (Pt 141) 661; [1990] 6 SCNJ 1; *Union Bank of Nigeria Ltd v "
        "Sax (Nig) Ltd & 2 Ors* [1994] 8 NWLR (Pt 361) 150; [1994] 9 SCNJ 1, 18 all "
        "cited by Ogbuagu, JSC.",
    ]
    d.bullets(notes, size=13, leading=24)
    d.spacer(4)
    d.label("Page 23", colour=MUTED, gap_after=4)
    d.p("The numeral printed at the foot of the photographed page is 23.",
        size=13, leading=24, justify=False)


def register(d: Doc, rows):
    d.pagebreak()
    d.mark("register")
    d.h2("Extraction register")
    d.p("Every case and authority printed on page 23, preserved as printed before any "
        "correction. Footnote 1 cites one case; footnote 2 cites two; footnote 3 "
        "cites the case for which the definition is quoted; footnote 4 cites four "
        "further authorities and is the “also see” for the quotation itself.",
        size=SMALL_SIZE, leading=SMALL_LEADING)
    d.spacer(8)
    for r in rows:
        d.ensure(92)
        d.label(f"Footnote {r['fn']} — {r['printed_name']}", gap_after=5)
        for lbl, key in [("Citation as printed", "printed_citation"),
                         ("Court as printed", "court_printed"),
                         ("Cited for", "proposition")]:
            d.ensure(34)
            d.text(56.7 + 10, d.y - 8, lbl + ":", "Times-Italic", 11, 0, MUTED)
            d.draw_words(parse_inline(str(r[key])), 11.6, 16.5, True,
                         indent=118, width=FRAME_W - 118)
        d.y -= 8
    d.spacer(8)
    d.panel("Total extracted", "callout")
    d.p("Seven cases and one statutory class. Storer v Manchester City Council; "
        "Alhaji M. C. Dahiru v Alhaji Bubakare Kamale; United Bank for Africa Ltd v "
        "Tejumola & Sons Ltd; Agomo v Guinness (Nig) Ltd; Sparkling Breweries Ltd v "
        "Union Bank of Nigeria Ltd; Adebanjo v Brown; Union Bank of Nigeria Ltd v "
        "Sax (Nig) Ltd; and the State Contracts Laws, the Land Use Act and the "
        "Statute of Frauds. Each is analysed in full below, in the order cited.",
        size=SMALL_SIZE, leading=SMALL_LEADING)
    d.panel_close("callout")


def case_block(d: Doc, c: dict):
    d.pagebreak()
    d.mark(f"case{c['number']}")
    d.label(f"Case {c['number']} of 8", gap_after=6)
    d.draw_words([[(w, "Helvetica-Bold", False)] for w in c["name"].split()],
                 19, 26, False)
    d.p(c["citation_verified"], size=12.6, leading=19, italic=True)
    d.y -= 4
    d.badge(c["confidence"], CONF.get(c["confidence"], "partly"))

    d.label("A.  Verified citation and verification")
    d.record([
        ("Court", c["court"]),
        ("Date", c["date"]),
        ("Judges / panel", c["judges"]),
        ("Verification note", c["verification_note"]),
    ])

    if c.get("citation_conflict"):
        d.panel("Corrections and unresolved conflicts", "warn")
        d.p(c["citation_conflict"], size=SMALL_SIZE, leading=SMALL_LEADING)
        d.panel_close("warn")

    d.label("B.  Source and textbook connection")
    d.p(f"Printed at: **{c['textbook_page']}**.", justify=False)
    d.p(c["textbook_proposition"])

    sections = [
        ("C.  Material facts", "facts"),
        ("D.  Procedural history", "procedure"),
        ("E.  Issues for determination", "issues"),
        ("F.  Decision / holding", "holding"),
        ("G.  Ratio decidendi", "ratio"),
        ("H.  The exact legal rule", "exact_rule"),
        ("I.  Exceptions, limits and qualifications", "exceptions"),
        ("J.  Application to the subject", "application"),
        ("K.  Later treatment", "later_treatment"),
        ("L.  Examination significance", "exam_significance"),
    ]
    for lbl, key in sections:
        d.ensure(70)
        d.label(lbl)
        d.p(c.get(key))

    d.ensure(70)
    d.label("Sources consulted for this entry")
    for s in c.get("sources", []):
        d.source_line(s["tier"], s["label"], s["type"], s["url"], s["accessed"])

    # The secondary block is always last and always its own heading.
    sec = c.get("secondary_account") or []
    d.panel("Secondary-source account — unverified", "secondary")
    if sec:
        d.p("The following comes from blogs, student notes, news and commentary. It is "
            "written second, after the verified material, and is never presented as "
            "the court's words or as settled law.",
            size=SMALL_SIZE, leading=SMALL_LEADING, italic=True)
        for s in sec:
            d.ensure(60)
            d.p(s["text"], size=SMALL_SIZE, leading=SMALL_LEADING)
            d.draw_words(parse_inline(
                f"Source: {s['source']} — {s['type']}, accessed {s['accessed']}."),
                11.2, 16, False, indent=14, width=FRAME_W - 14, colour=MUTED)
            d._url(s["url"], 56.7 + 14, FRAME_W - 14)
            d.y -= 6
    else:
        d.p("No secondary source was relied on for this entry. The entry is complete "
            "from primary and higher-tier material.",
            size=SMALL_SIZE, leading=SMALL_LEADING)
    d.panel_close("secondary")


def exam_block(d: Doc, cases):
    d.pagebreak()
    d.mark("exam")
    d.h2("Case prepared for exam — fast writing")
    d.p("Each note is written for closed-book reproduction under examination "
        "conditions. The facts run to at least five lines, as required. Where an "
        "entry rests on secondary sources only, that is marked here too.",
        size=SMALL_SIZE, leading=SMALL_LEADING)
    for c in cases:
        e = c["exam_note"]
        d.ensure(180)
        d.label(f"{c['number']}.  {c['name']}", gap_after=6)
        d.p(e["citation_court"], size=12.4, leading=19, italic=True)
        d.label("Facts", colour=MUTED, gap_after=5)
        d.bullets(e["facts"], size=12.4, leading=20, indent=24)
        for lbl, key in [("Issue", "issue"), ("Held / decision", "held"),
                         ("Rule / ratio", "rule"),
                         ("Exception or qualification", "exception"),
                         ("Why the case matters", "why")]:
            d.ensure(34)
            d.p(f"**{lbl}.** {e[key]}", size=12.4, leading=20)
        d.rule(pad=14)


def synthesis_block(d: Doc, s):
    d.pagebreak()
    d.mark("synth")
    d.h2("Professor's doctrinal synthesis")
    d.p("The subject of the uploaded material is the law of offer. These are the "
        "authorities synthesised under it, and the method for applying them.",
        size=SMALL_SIZE, leading=SMALL_LEADING, italic=True)
    parts = [
        ("The general principle and its legal foundation", "p", s["general_principle"]),
        ("The constituent rules and how they relate", "ul", s["constituent_rules"]),
        ("Limits, exceptions and rebuttable presumptions", "ul",
         s["limits_exceptions_presumptions"]),
        ("Apparently conflicting cases, and why they are consistent", "ul",
         s["conflicting_or_contrasting_cases"]),
        ("Binding and persuasive authority in Nigeria", "ul",
         s["binding_status_in_nigeria"]),
        ("Relevant statutory provisions", "ul", s["statutory_provisions"]),
        ("The practical method for a problem question", "ol",
         s["problem_question_method"]),
    ]
    for title, kind, body in parts:
        d.ensure(150)
        d.h3(title)
        if kind == "p":
            d.p(body)
        else:
            d.bullets(body, ordered=(kind == "ol"))


def mnemonic_block(d: Doc, cases):
    d.pagebreak()
    d.mark("mnemonics")
    d.h2("Memory system and mnemonics")
    d.p("Each aid preserves the legal meaning. Where a mnemonic would force a rule "
        "into a shape it does not have, the cue is attached to the facts only and "
        "the rule is left in plain words.", size=SMALL_SIZE, leading=SMALL_LEADING)
    for c in cases:
        m = c["mnemonics"]
        d.ensure(200)
        d.label(f"{c['number']}.  {c['name']}", gap_after=6)
        for lbl, key in [("Case-name cue", "name_cue"),
                         ("Facts mnemonic", "facts_mnemonic"),
                         ("Rule mnemonic", "rule_mnemonic"),
                         ("Trigger phrase", "trigger"),
                         ("Closed-book recall drill", "drill")]:
            d.ensure(38)
            d.p(f"**{lbl}.** {m[key]}", size=12.8, leading=21)
        d.rule(pad=16)


def question_block(d: Doc, q):
    d.pagebreak()
    d.mark("questions")
    d.h2("Examination questions")
    d.panel("Practice only", "callout")
    d.p(q["disclaimer"], size=SMALL_SIZE, leading=SMALL_LEADING)
    d.panel_close("callout")
    for title, key in [("A.  Theory questions", "theory"),
                       ("B.  Problem questions", "problems")]:
        d.ensure(60)
        d.h3(title)
        for item in q[key]:
            qlines, _ = d.break_lines(parse_inline(item["q"]), 16, 0, FRAME_W)
            need = len(qlines) * 32 + 52
            if need <= 700 and need > (d.y - 62):
                d.new_page()
            d.p(item["q"])
            d.p(f"{item['marks']} marks  ·  suggested time {item['minutes']} minutes  "
                f"·  answer guide {item['guide_key']}",
                size=11.5, leading=18, justify=False, colour=MUTED)

    d.pagebreak()
    d.mark("answers")
    d.h2("C.  Answer guides")
    d.p("These are structured outlines, not model answers. Where the outcome depends "
        "on a fact that has not been given, the guide says so instead of announcing a "
        "single conclusion.", size=SMALL_SIZE, leading=SMALL_LEADING)
    for key in ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8",
                "P1", "P2", "P3", "P4", "P5", "P6"]:
        d.ensure(80)
        d.h3(key if key.startswith("P") else key)
        d.p(q["answer_guides"][key], size=13.4, leading=23)

    d.pagebreak()
    d.mark("oral")
    d.h2("D.  Quick oral test")
    d.bullets(q["oral_test"], ordered=True, size=14, leading=24)


def audit_block(d: Doc, a, cases):
    d.pagebreak()
    d.mark("audit")
    d.h2("Research audit")
    d.p("The audit records what was actually opened, what came back, and what could "
        "not be reached. Nothing here is listed as searched unless it was searched.",
        size=SMALL_SIZE, leading=SMALL_LEADING)
    d.spacer(6)

    d.label("Audit table")
    for c in cases:
        d.ensure(96)
        d.p(f"**{c['name']}**", size=12.2, leading=18, justify=False)
        d.p(f"Citation as verified: {c['citation_verified'].split(';')[0]}.  "
            f"Confidence: {c['confidence']}.  "
            f"Secondary corroboration used: "
            f"{'yes, labelled unverified' if c.get('secondary_account') else 'not relied on'}.",
            size=11.2, leading=16.5, indent=12)
        d.p("What remains unverified: " + c["verification_note"],
            size=11.2, leading=16.5, indent=12)
        d.rule(pad=10)

    for title, items in [
        ("Search terms actually used", a["search_terms"]),
        ("Databases, repositories and sites actually accessed",
         a["engines_and_repositories_actually_used"]),
        ("Sources inaccessible, paywalled or unavailable",
         a["inaccessible_or_paywalled"]),
        ("Conflicts and unresolved citation issues", a["conflicts_recorded"]),
    ]:
        d.ensure(70)
        d.h3(title)
        d.bullets(items, size=12.4, leading=20, indent=24)

    d.ensure(90)
    d.h3("Date the research was performed")
    d.p("22 November 2026.")
    d.h3("Scope statement")
    d.p("This research did not search “everywhere in the world”, and no such claim is "
        "made. What was searched, and what came back, is listed above. No database is "
        "named as searched unless it was actually opened. No URL, document or "
        "quotation in this casebook was invented; where a source could not be opened, "
        "that is stated.")


def bibliography(d: Doc, cases):
    d.pagebreak()
    d.h2("List of authorities and bibliography")
    d.h3("Cases analysed")
    d.bullets([f"*{c['name']}* — {c['citation_verified']}" for c in cases],
              size=12.4, leading=20, indent=24)
    d.h3("Cases referred to within the analyses")
    d.bullets([
        "Gibson v Manchester City Council [1979] 1 WLR 294 (HL)",
        "Eccles v Bryant and Pollock [1948] Ch 93",
        "Bigg v Boyd Gibbins Ltd [1971] 1 WLR 26",
        "Carlill v Carbolic Smoke Ball Co [1893] 1 QB 256",
        "Hyde v Wrench (1840) 3 Beav 334",
        "Stevenson v McLean (1880) 5 QBD 346",
        "Nesham v Selby (1872) 7 Ch App 406",
        "Bristol, Cardiff and Swansea Aerated Bread Co v Maggs (1890) 44 Ch D 616",
        "Brilliant v Michaels (1944) 1 All ER 121",
        "Shell BP Petroleum Development Co Ltd v Jammal Engineering (Nig) Ltd "
        "(1974) 1 All NLR (Pt 1) 542",
        "Abinabina v Enyimadu 12 WACA 171",
        "Shonekan v Smith (1964) 1 All NLR 168",
        "Eke v Ogbonda (2006) SC.64/2001",
        "David-West v Oduwole (2003)",
        "Akudigwe v Attorney-General of Anambra State (2020) CA",
        "Josku Nigeria Ltd v Ijumu Local Government",
    ], size=12.4, leading=20, indent=24)
    d.h3("Legislation")
    d.bullets([
        "Law Reform (Contracts) Law, Cap 66, Laws of Lagos State, section 5",
        "Land Use Act, Cap L5, Laws of the Federation of Nigeria 2004, section 22",
        "Statute of Frauds (1677) (England)",
    ], size=12.4, leading=20, indent=24)
    d.h3("Books, articles and courseware")
    d.bullets([
        "Edwin Peel, Treitel: The Law of Contract (12th edn, Sweet & Maxwell 2007) 9 "
        "— as cited by the textbook; not independently consulted in this search.",
        "Spencer Bower and Turner, Estoppel by Representation (3rd edn) 324, para 318 "
        "— as applied by the trial judge in Adebanjo v Brown.",
        "Journal of African Law, “Application of Limitation Laws to Oil Spill "
        "Compensation Claims in Nigeria” — abstract only; cites Dahiru v Kamale.",
        "“Moment of Acceptance in Contracts Using Modern Means of Communication — An "
        "Appraisal” — secondary; discusses Dahiru v Kamale on qualified acceptance.",
        "National Open University of Nigeria, LAW 231 Labour Law I — secondary; "
        "quotes Agomo v Guinness on the definition of an offer.",
    ], size=12.4, leading=20, indent=24)


def build(toc: dict | None = None, out: Path | None = None) -> tuple[Path, dict]:
    data = json.loads((STORE / "data" / "2026-11-22_cases_v1.0.json").read_text(encoding="utf-8"))
    syn = json.loads((STORE / "data" / "2026-11-22_synthesis-and-questions_v1.0.json")
                     .read_text(encoding="utf-8"))
    meta, cases = data["casebook"], data["cases"]

    out = out or OUT
    out.parent.mkdir(parents=True, exist_ok=True)
    d = Doc(str(out), "OFFER — Casebook and Study Materials")
    cover(d, meta)
    front_matter(d, toc)
    verbatim(d)
    register(d, data["extraction_register"])
    for c in cases:
        case_block(d, c)
    exam_block(d, cases)
    synthesis_block(d, syn["synthesis"])
    mnemonic_block(d, cases)
    question_block(d, syn["questions"])
    audit_block(d, data["research_audit"], cases)
    bibliography(d, cases)
    d.save()
    return out, d.toc_pages


if __name__ == "__main__":
    try:
        _, first = build()
        path, pages = build(toc=first)
    except Exception:
        import traceback
        traceback.print_exc()
        raise SystemExit(1)
    print(f"wrote {path}  ({path.stat().st_size:,} bytes)")
    print("contents map:", pages)
