#!/usr/bin/env python3
"""Typeset the store guide (markdown) into a PDF companion document.

The casebook is generated from data; this guide is prose, so it is rendered
from the markdown source it already exists as. Only the constructs actually
used in that file are supported: headings, paragraphs, bullet and numbered
lists, block quotes, pipe tables, fenced code blocks and horizontal rules.

Usage:  python3 tools/casebook/build_guide.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from typewriter import (ACCENT, BODY_LEADING, BODY_SIZE, FRAME_W, INK, MUTED,
                        RULE, SMALL_LEADING, Doc, parse_inline, sw)

ROOT = Path(__file__).resolve().parents[2]
STORE = ROOT / "Case and study materials"
SOURCE = STORE / "2026-11-22_Case-and-study-materials_store_v1.0.md"
OUT = STORE / "pdf" / "2026-11-22_Store-guide_v1.0.pdf"

MONO = "Courier"

# The WinAnsi Type1 encoding has no box-drawing glyphs; using them would put a
# missing-glyph box on the page. Transliterate to ASCII for the monospaced tree.
TREE = {
    "\u251c": "|", "\u2514": "`", "\u2502": "|", "\u2500": "-",
    "\u255c": "`", "\u2564": "+", "\u250c": "/",
}


def mono_safe(text: str) -> str:
    for k, v in TREE.items():
        text = text.replace(k, v)
    return text.replace("\u2014", "-").replace("\u2013", "-")


def inline(text: str) -> str:
    """Markdown inline -> the markers typewriter.parse_inline understands."""
    text = text.replace("**", "\x00B\x00").replace("*", "\x01I\x01")
    text = text.replace("\x00B\x00", "**").replace("\x01I\x01", "*")
    text = text.replace("`", "")
    return text


def cover(d: Doc):
    d.y -= 34
    d.text(56.7, d.y, "FIRE COUNSEL  ·  LEGAL LEARNING WORKSPACE",
           "Helvetica-Bold", 10.5, 3.2, ACCENT)
    d.y -= 52
    d.h1("STORE GUIDE", size=44, tracking=1.2, gap=58)
    d.c.setStrokeColor(INK)
    d.c.setLineWidth(2.2)
    d.c.line(56.7, d.y, 56.7 + 132, d.y)
    d.y -= 26
    d.p("Case and study materials — what is in the store, what the research "
        "found, and how to put it online", size=18, leading=29, justify=False)
    d.y -= 30
    for lbl, val in [
        ("Companion to", "OFFER casebook v1.0 (108 pages)"),
        ("Subject", "Law of Contract (Nigeria)"),
        ("Version", "1.0"),
        ("Date", "22 November 2026"),
    ]:
        d.ensure(22)
        d.text(56.7, d.y - 9, lbl.upper(), "Helvetica-Bold", 8.8, 1.1, MUTED)
        d.text(56.7 + 132, d.y - 9, val, "Times-Roman", 12.2, 0, INK)
        d.y -= 20


def code_block(d: Doc, lines: list[str]):
    """Monospaced tree or shell block on a tinted panel."""
    size, leading, pad = 8.6, 12.4, 10
    longest = max((sw(l, MONO, size) for l in lines), default=0)
    need = len(lines) * leading + pad * 2
    if need > 720:
        # split across pages rather than clip
        chunks = [lines[i:i + 46] for i in range(0, len(lines), 46)]
    else:
        chunks = [lines]
    for chunk in chunks:
        need = len(chunk) * leading + pad * 2
        if need > (d.y - 62):
            d.new_page()
        top = d.y
        d.y -= pad
        for line in chunk:
            d.ensure(leading)
            d.text(56.7 + 8, d.y - size * 0.86, line, MONO, size, 0,
                   MUTED if line.strip()[:1] in ("|", "`") else INK)
            d.y -= leading
        d.y -= pad
        d.c.setFillColorRGB(0.96, 0.955, 0.945)
        d.c.setStrokeColor(RULE)
        d.c.setLineWidth(0.6)
        d.c.rect(56.7, d.y, min(FRAME_W, longest + 30), top - d.y,
                 stroke=1, fill=0)
        d.y -= 12


def table(d: Doc, rows: list[str]):
    """Pipe table -> a re-flowed record list, legible at this measure."""
    cells = [[c.strip() for c in r.strip().strip("|").split("|")] for r in rows]
    header = cells[0]
    body = [r for r in cells[1:] if not all(set(c) <= set("-: ") for c in r)]
    def plain(text: str) -> str:
        return re.sub(r"[*`]", "", text).strip()

    for r in body:
        d.ensure(96)
        d.label(plain(r[0]), gap_after=4)
        for i, value in enumerate(r[1:], start=1):
            if not value or i >= len(header):
                continue
            d.ensure(34)
            d.text(56.7 + 10, d.y - 8, re.sub(r"[*`]", "", header[i]) + ":",
                   "Times-Italic", 11, 0, MUTED)
            d.draw_words(parse_inline(inline(value)), 11.8, 16.8, True,
                         indent=110, width=FRAME_W - 110)
        d.rule(pad=10)


def render(d: Doc, markdown: str):
    lines = markdown.splitlines()
    i = 0
    pending: list[str] = []

    def flush_para():
        nonlocal pending
        if pending:
            d.p(inline(" ".join(pending)))
            pending = []

    while i < len(lines):
        raw = lines[i]
        line = raw.rstrip()
        stripped = line.strip()

        # fenced code
        if stripped.startswith("```"):
            flush_para()
            i += 1
            block = []
            while i < len(lines) and not lines[i].strip().startswith("```"):
                block.append(mono_safe(lines[i].rstrip("\n")))
                i += 1
            i += 1
            if block and all(not b.strip() or b.strip().startswith("#")
                             for b in block[:1]):
                pass
            code_block(d, block)
            continue

        # horizontal rule
        if re.fullmatch(r"-{3,}", stripped):
            flush_para()
            d.rule(pad=16)
            i += 1
            continue

        # table
        if stripped.startswith("|"):
            flush_para()
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                rows.append(lines[i])
                i += 1
            table(d, rows)
            continue

        # headings
        m = re.match(r"^(#{1,4})\s+(.*)$", stripped)
        if m:
            flush_para()
            level, text = len(m.group(1)), m.group(2)
            if level == 1:
                d.h2(text)
            elif level == 2:
                d.h2(text)
            else:
                d.ensure(90)
                d.h3(inline(text))
            i += 1
            continue

        # lists
        if re.match(r"^[-*]\s+", stripped) or re.match(r"^\d+\.\s+", stripped):
            flush_para()
            ordered = bool(re.match(r"^\d+\.\s+", stripped))
            marker_re = r"^\s*\d+\.\s+" if ordered else r"^\s*[-*]\s+"
            items, current = [], None
            while i < len(lines):
                text_line = lines[i]
                s_line = text_line.strip()
                if re.match(marker_re, text_line):
                    if current is not None:
                        items.append(current)
                    current = re.sub(marker_re, "", text_line).strip()
                elif not s_line:
                    # a blank line ends the list only if the next line is not a
                    # continuation of it
                    if i + 1 < len(lines) and lines[i + 1].startswith(("  ", "\t")) \
                            and lines[i + 1].strip():
                        i += 1
                        continue
                    break
                elif current is not None and not re.match(
                        r"^(#{1,4}\s|\||```|-{3,})", s_line):
                    # wrapped source line belonging to the same item
                    current += " " + s_line
                else:
                    break
                i += 1
            if current is not None:
                items.append(current)
            d.bullets([inline(x) for x in items], ordered=ordered,
                      size=14.5, leading=25.5, indent=28)
            continue

        # block quote
        if stripped.startswith(">"):
            flush_para()
            quote = []
            while i < len(lines) and lines[i].strip().startswith(">"):
                quote.append(lines[i].strip().lstrip(">").strip())
                i += 1
            d.ensure(60)
            top = d.y
            d.draw_words(parse_inline(inline(" ".join(quote))), 14.5, 25,
                         True, indent=26, width=FRAME_W - 26, colour=MUTED)
            d.c.setStrokeColor(RULE)
            d.c.setLineWidth(2.0)
            d.c.line(56.7 + 8, top + 10, 56.7 + 8, d.y + 8)
            d.y -= 6
            continue

        # blank ends a paragraph
        if not stripped:
            flush_para()
            i += 1
            continue

        pending.append(line.strip())
        i += 1

    flush_para()


def build() -> Path:
    markdown = SOURCE.read_text(encoding="utf-8")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    d = Doc(str(OUT), "Case and study materials — store guide",
            running_head="CASE AND STUDY MATERIALS — STORE GUIDE")
    cover(d)
    d.pagebreak()
    render(d, markdown)
    d.save()
    return OUT


if __name__ == "__main__":
    try:
        path = build()
    except Exception:
        import traceback
        traceback.print_exc()
        raise SystemExit(1)
    print(f"wrote {path}  ({path.stat().st_size:,} bytes)")
