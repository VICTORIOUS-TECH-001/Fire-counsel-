#!/usr/bin/env python3
"""Write one standalone markdown file per authority into cases/.

The casebook is one long PDF. Students often need one case, so each entry in
data/cases.json is also written out on its own, dated and versioned, with its
verification label and its sources intact.

Usage:  python3 tools/casebook/split_cases.py
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
STORE = ROOT / "Case and study materials"
CASES_DIR = STORE / "cases"
DATE = "2026-11-22"


def slug(text: str) -> str:
    text = re.sub(r"[^A-Za-z0-9 ]+", " ", text)
    return "-".join(text.split())[:70]


def main() -> None:
    data = json.loads((STORE / "data" / "2026-11-22_cases_v1.0.json").read_text(encoding="utf-8"))
    CASES_DIR.mkdir(parents=True, exist_ok=True)
    written = []
    for c in data["cases"]:
        out = CASES_DIR / f"{DATE}_{c['number']:02d}_{slug(c['name'])}_v1.0.md"
        lines = [
            "---",
            f"title: \"{c['name']}\"",
            f"citation: \"{c['citation_verified']}\"",
            f"court: \"{c['court']}\"",
            f"date: \"{c['date']}\"",
            f"confidence: \"{c['confidence']}\"",
            f"textbook_page: \"{c['textbook_page']}\"",
            f"subject: \"Law of Contract (Nigeria)\"",
            f"compiled: {DATE}",
            "---",
            "",
            f"# Case {c['number']}: {c['name']}",
            "",
            f"**{c['confidence']}**",
            "",
            c["citation_verified"],
            "",
            f"- **Court:** {c['court']}",
            f"- **Date:** {c['date']}",
            f"- **Judges / panel:** {c['judges']}",
            f"- **Verification:** {c['verification_note']}",
            "",
        ]
        if c.get("citation_conflict"):
            lines += ["## Corrections and unresolved conflicts",
                      "", c["citation_conflict"], ""]
        lines += [
            "## A. Verified citation", "", c["citation_verified"], "",
            f"## B. Source and textbook connection", "",
            f"Printed at {c['textbook_page']}.", "",
            c["textbook_proposition"], "",
        ]
        for lbl, key in [
            ("C. Material facts", "facts"),
            ("D. Procedural history", "procedure"),
            ("E. Issues for determination", "issues"),
            ("F. Decision / holding", "holding"),
            ("G. Ratio decidendi", "ratio"),
            ("H. The exact legal rule", "exact_rule"),
            ("I. Exceptions, limits and qualifications", "exceptions"),
            ("J. Application to the subject", "application"),
            ("K. Later treatment", "later_treatment"),
            ("L. Examination significance", "exam_significance"),
        ]:
            lines += [f"## {lbl}", "", c.get(key, ""), ""]
        lines += ["## Sources consulted", ""]
        for s in c.get("sources", []):
            lines.append(f"- **Tier {s['tier']}** — {s['label']}. "
                         f"*{s['type']}*. Accessed {s['accessed']}.  \n  {s['url']}")
        lines += ["", "## Secondary-source account — unverified", ""]
        sec = c.get("secondary_account") or []
        if sec:
            lines.append("Written second, after the verified material. Never to be "
                         "presented as the court's words or as settled law.")
            lines.append("")
            for s in sec:
                lines.append(f"- {s['text']}  \n  *{s['source']}* "
                             f"({s['type']}), accessed {s['accessed']}.  \n  {s['url']}")
        else:
            lines.append("No secondary source was relied on for this entry.")
        e = c["exam_note"]
        lines += [
            "", "## Case prepared for exam — fast writing", "",
            f"**Citation and court.** {e['citation_court']}", "",
            "**Facts.**", "",
        ]
        lines += [f"{i}. {f}" for i, f in enumerate(e["facts"], 1)]
        lines += [
            "", f"**Issue.** {e['issue']}", "",
            f"**Held.** {e['held']}", "",
            f"**Rule / ratio.** {e['rule']}", "",
            f"**Exception or qualification.** {e['exception']}", "",
            f"**Why it matters.** {e['why']}", "",
            "## Mnemonics", "",
        ]
        m = c["mnemonics"]
        lines += [
            f"- **Case-name cue:** {m['name_cue']}",
            f"- **Facts:** {m['facts_mnemonic']}",
            f"- **Rule:** {m['rule_mnemonic']}",
            f"- **Trigger:** {m['trigger']}",
            f"- **Recall drill:** {m['drill']}",
            "",
        ]
        out.write_text("\n".join(lines) + "\n", encoding="utf-8")
        written.append(out.name)
    print(f"wrote {len(written)} case files into cases/")
    for w in written:
        print("  ", w)


if __name__ == "__main__":
    main()
