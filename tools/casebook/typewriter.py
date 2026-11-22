#!/usr/bin/env python3
"""A small, dependency-light PDF typesetter for the FIRE COUNSEL casebook.

Why this exists: the sandbox has no Pango/Cairo and no headless browser, so
WeasyPrint and Chromium are unavailable. ReportLab ships its own Type1 font
metrics, so a PDF can be produced anywhere. ReportLab's own Paragraph engine
cannot honour the requested word spacing or letter tracking without text
running past the right margin, so this module does its own line breaking and
full justification with exact control over:

    * word spacing    (extra points added to every inter-word space)
    * letter tracking (extra points added after every character)

Everything is measured with the real font metrics from pdfmetrics, so what is
measured is exactly what is drawn.
"""

from __future__ import annotations

import re

from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfgen import canvas

# ---------------------------------------------------------------- typefaces

SERIF, SERIF_B, SERIF_I, SERIF_BI = (
    "Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic")
SANS, SANS_B = "Helvetica", "Helvetica-Bold"

BODY_SIZE = 16.0
BODY_LEADING = 32.0            # exactly double
SMALL_SIZE = 12.5
SMALL_LEADING = 21.5

WORD_SPACE = 0.2 * 28.346456692913385   # 0.2 cm expressed in points
TRACK = 0.12                            # letter tracking, points

INK = HexColor("#111111")
MUTED = HexColor("#4a4a4a")
ACCENT = HexColor("#7a1f1f")
RULE = HexColor("#b0aca4")
WASH = HexColor("#f4f3ef")

PAGE_W, PAGE_H = A4
M_LEFT = M_RIGHT = 56.7        # 20 mm
M_TOP = 79.4                   # 28 mm
M_BOTTOM = 62.0
FRAME_W = PAGE_W - M_LEFT - M_RIGHT
FRAME_TOP = PAGE_H - M_TOP

_MD = re.compile(r"(\*\*.+?\*\*|\*[^*]+?\*)")


def sw(text: str, font: str, size: float) -> float:
    return pdfmetrics.stringWidth(text, font, size)


# The WinAnsi Type1 encoding has real glyphs for the superscript one, two and
# three but not for four to nine. Rather than risk a missing-glyph box, every
# superscript is detected here and re-rendered as a raised, reduced normal digit,
# which is what a footnote marker is anyway.
SUP_TO_DIGIT = {
    "\u00b9": "1", "\u00b2": "2", "\u00b3": "3",
    "\u2070": "0", "\u2074": "4", "\u2075": "5", "\u2076": "6",
    "\u2077": "7", "\u2078": "8", "\u2079": "9",
}
SUPS = set(SUP_TO_DIGIT)
SUP_SIZE = 0.62
SUP_RISE = 0.34


def parse_inline(text: str, base_font: str = SERIF):
    """Return [[(segment, font, is_superscript), ...]] — one list per word.

    Superscript digits are supported so footnote markers reproduce exactly as
    printed instead of collapsing into a missing glyph. **bold** and *italic*
    are honoured per word.
    """
    runs, pos = [], 0
    for m in _MD.finditer(text):
        if m.start() > pos:
            runs.append((text[pos:m.start()], base_font))
        token = m.group(0)
        if token.startswith("**"):
            runs.append((token[2:-2], SERIF_B if base_font in (SERIF, SERIF_I) else SANS_B))
        else:
            runs.append((token[1:-1], SERIF_I))
        pos = m.end()
    if pos < len(text):
        runs.append((text[pos:], base_font))

    words = []
    for chunk, font in runs:
        for part in chunk.split():
            segs = []
            buf = ""
            for ch in part:
                if ch in SUPS:
                    if buf:
                        segs.append((buf, font, False))
                        buf = ""
                    segs.append((SUP_TO_DIGIT[ch], font, True))
                else:
                    buf += ch
            if buf:
                segs.append((buf, font, False))
            words.append(segs)
    return words


def seg_width(seg, size: float) -> float:
    if len(seg) == 2:
        text, font = seg
        sup = False
    else:
        text, font, sup = seg
    fs = size * SUP_SIZE if sup else size
    return sw(text, font, fs) + TRACK * len(text)


def word_width(word, size: float) -> float:
    if isinstance(word, str):
        return seg_width((word, SERIF, False), size)
    if isinstance(word, tuple):
        return seg_width(word, size)
    return sum(seg_width(s_, size) for s_ in word)


class Doc:
    def text(self, x, y, s, font=SERIF, size=12, tracking=0.0, colour=INK):
        """One run of text with exact letter tracking. Returns the advance."""
        self.c.setFont(font, size)
        self.c.setFillColor(colour)
        self.c.drawString(x, y, s, charSpace=tracking)
        return sw(s, font, size) + tracking * len(s)

    def width_of(self, s, font=SERIF, size=12, tracking=0.0):
        return sw(s, font, size) + tracking * len(s)

    def __init__(self, path: str, title: str, running_head: str = ""):
        self.c = canvas.Canvas(path, pagesize=A4)
        self.c.setTitle(title)
        self.c.setAuthor("FIRE COUNSEL legal research workspace")
        self.c.setSubject("Offer — casebook and study materials")
        self.c.setCreator("tools/casebook/typewriter.py")
        self.y = FRAME_TOP
        self.page = 0
        self.toc_pages: dict[str, int] = {}
        self.running_head = running_head or "OFFER — CASEBOOK AND STUDY MATERIALS"
        self.new_page()

    # ---------------------------------------------------------- pages
    def new_page(self):
        if self.page:
            self._footer()
            self.c.showPage()
        self.page += 1
        self.y = FRAME_TOP
        if self.page > 1:
            label = self.running_head
            w = self.width_of(label, SERIF, 9, 0.45)
            self.text(PAGE_W / 2 - w / 2, PAGE_H - 42, label, SERIF, 9, 0.45, MUTED)
            self.c.setStrokeColor(RULE)
            self.c.setLineWidth(0.4)
            self.c.line(M_LEFT, PAGE_H - 52, PAGE_W - M_RIGHT, PAGE_H - 52)

    def _footer(self):
        n = str(self.page)
        self.text(PAGE_W / 2 - sw(n, SERIF, 10.5) / 2, 32, n, SERIF, 10.5, 0, MUTED)

    def save(self):
        self._footer()
        self.c.save()

    def ensure(self, height: float):
        if self.y - height < M_BOTTOM:
            self.new_page()

    def pagebreak(self):
        self.new_page()

    def mark(self, key: str):
        self.toc_pages.setdefault(key, self.page)

    def spacer(self, h: float):
        self.ensure(h)
        self.y -= h

    # ---------------------------------------------------------- text
    def break_lines(self, words, size, indent=0.0, width=None):
        width = FRAME_W - indent if width is None else width
        space = sw(" ", SERIF, size) + TRACK + WORD_SPACE
        lines, cur, cur_w = [], [], 0.0
        for w in words:
            ww = word_width(w, size)
            if ww > width:
                if cur:
                    lines.append(cur)
                lines.append([(w, ww)])
                cur, cur_w = [], 0.0
                continue
            add = ww if not cur else ww + space
            if cur_w + add <= width or not cur:
                cur.append((w, ww))
                cur_w += add
            else:
                lines.append(cur)
                cur, cur_w = [(w, ww)], ww
        if cur:
            lines.append(cur)
        return lines, space

    def draw_words(self, words, size, leading, justify=True, indent=0.0,
                   width=None, colour=None, align_center=False):
        width = FRAME_W - indent if width is None else width
        lines, space = self.break_lines(words, size, indent, width)

        for idx, line in enumerate(lines):
            last = idx == len(lines) - 1
            natural = sum(w for _, w in line) + space * (len(line) - 1)
            gap = space
            x0 = M_LEFT + indent
            if justify and not last and len(line) > 1:
                gap = space + (width - natural) / (len(line) - 1)
            elif align_center:
                x0 = M_LEFT + indent + (width - natural) / 2
            self.ensure(leading)
            x = x0
            base = self.y - size * 0.80
            for segs, ww in line:
                for text, font, sup in segs:
                    fs = size * SUP_SIZE if sup else size
                    rise = size * SUP_RISE if sup else 0.0
                    self.text(x, base + rise, text, font, fs, TRACK,
                              colour or INK)
                    x += seg_width((text, font, sup), size)
                x += gap
            self.y -= leading
        return len(lines)

    # ---------------------------------------------------------- blocks
    def h1(self, text, size=34, colour=INK, tracking=0.4, gap=48):
        self.ensure(size * 1.6)
        self.text(M_LEFT, self.y - size * 0.92, text, SANS_B, size, tracking, colour)
        self.y -= gap

    def h2(self, text, size=17.5, toc=False):
        self.ensure(size * 4)
        self.y -= 8
        self.text(M_LEFT, self.y - size * 0.9, text, SANS_B, size, 0, INK)
        self.y -= size * 1.25
        self.c.setStrokeColor(INK)
        self.c.setLineWidth(1.5)
        self.c.line(M_LEFT, self.y + 3, PAGE_W - M_RIGHT, self.y + 3)
        self.y -= 17
        if toc:
            self.toc_pages.setdefault(text, self.page)

    def h3(self, text):
        self.ensure(62)
        self.y -= 6
        maxw = FRAME_W
        line = ""
        lines = []
        for word in text.split():
            trial = (line + " " + word).strip()
            if sw(trial, SANS_B, 13.5) > maxw and line:
                lines.append(line)
                line = word
            else:
                line = trial
        if line:
            lines.append(line)
        for ln in lines:
            self.ensure(22)
            self.text(M_LEFT, self.y - 13, ln, SANS_B, 13.5, 0, INK)
            self.y -= 19
        self.y -= 5

    def label(self, text, colour=ACCENT, size=9.8, gap_after=6):
        self.ensure(size + gap_after + 8)
        upper = text.upper()
        tracking = 0.85
        if self.width_of(upper, SANS_B, size, tracking) > FRAME_W:
            tracking = 0.0
        if self.width_of(upper, SANS_B, size, tracking) > FRAME_W:
            size = size * FRAME_W / self.width_of(upper, SANS_B, size, tracking)
            tracking = 0.0
        self.text(M_LEFT, self.y - size, upper, SANS_B, size, tracking, colour)
        self.y -= size + gap_after

    def p(self, text, size=BODY_SIZE, leading=BODY_LEADING, justify=True,
          indent=0.0, width=None, colour=None, italic=False, gap=0.0):
        if not text:
            return
        words = parse_inline(str(text), SERIF_I if italic else SERIF)
        if not words:
            return
        avail = (FRAME_W - indent if width is None else width)
        lines, _ = self.break_lines(words, size, indent, avail)
        need = len(lines) * leading
        room = self.y - M_BOTTOM
        if 0 < need <= (FRAME_TOP - M_BOTTOM) and need > room:
            self.new_page()
        elif len(lines) <= 3 and room < need + leading * 1.5:
            self.new_page()
        self.draw_words(words, size, leading, justify, indent, width,
                        colour or INK)
        self.y -= leading * 0.14 + gap

    def bullets(self, items, ordered=False, size=15.0, leading=27.0, indent=30):
        for i, item in enumerate(items, 1):
            words = parse_inline(str(item))
            nl, _ = self.break_lines(words, size, indent, FRAME_W - indent)
            need = len(nl) * leading + 4
            if need <= (FRAME_TOP - M_BOTTOM) and need > (self.y - M_BOTTOM):
                self.new_page()
            self.ensure(leading * 2)
            marker = f"{i}." if ordered else "\u2022"
            self.text(M_LEFT + (0 if ordered else 2), self.y - size * 0.80,
                      marker, SERIF_B if ordered else SERIF, size, 0, INK)
            self.draw_words(words, size, leading, True,
                            indent=indent, width=FRAME_W - indent)
            self.y -= 4

    def record(self, rows, size=12.5, leading=19.0):
        for lbl, val in rows:
            words = parse_inline(str(val))
            nl, _ = self.break_lines(words, size, 12, FRAME_W - 12)
            need = len(nl) * leading + 6
            if need <= (FRAME_TOP - M_BOTTOM) and need > (self.y - M_BOTTOM):
                self.new_page()
            self.ensure(leading * 2 + 6)
            self.label(lbl, gap_after=5)
            self.draw_words(words, size, leading, True,
                            indent=12, width=FRAME_W - 12)
            self.y -= 6

    def rule(self, pad=12, colour=RULE, width=0.7, dash=None):
        self.y -= pad * 0.5
        self.c.setStrokeColor(colour)
        self.c.setLineWidth(width)
        if dash:
            self.c.setDash(*dash)
        self.c.line(M_LEFT, self.y, PAGE_W - M_RIGHT, self.y)
        self.c.setDash()
        self.y -= pad * 0.5

    def badge(self, text, kind):
        fill = {"verified": HexColor("#123d1f"),
                "partly": HexColor("#6b4b00"),
                "unverified": HexColor("#6b1414")}[kind]
        label = text.upper()
        w = self.width_of(label, SANS_B, 9.5, 0.6) + 24
        self.ensure(34)
        self.c.setFillColor(fill)
        self.c.roundRect(M_LEFT, self.y - 21, w, 21, 3, stroke=0, fill=1)
        self.text(M_LEFT + 12, self.y - 14.5, label, SANS_B, 9.5, 0.6,
                  HexColor("#ffffff"))
        self.y -= 33

    def panel(self, label, kind="callout"):
        """Open a labelled panel: rule + label, content follows the caller."""
        colour = {"callout": MUTED, "warn": ACCENT, "secondary": MUTED}[kind]
        self.y -= 6
        self.c.setStrokeColor(ACCENT if kind == "warn" else RULE)
        self.c.setLineWidth(1.3 if kind == "warn" else 0.8)
        if kind == "secondary":
            self.c.setDash(3, 2.5)
        self.c.line(M_LEFT, self.y, PAGE_W - M_RIGHT, self.y)
        self.c.setDash()
        self.y -= 15
        self.label(label, colour=colour, gap_after=8)

    def panel_close(self, kind="callout"):
        self.y -= 2
        self.c.setStrokeColor(ACCENT if kind == "warn" else RULE)
        self.c.setLineWidth(1.3 if kind == "warn" else 0.8)
        if kind == "secondary":
            self.c.setDash(3, 2.5)
        self.c.line(M_LEFT, self.y, PAGE_W - M_RIGHT, self.y)
        self.c.setDash()
        self.y -= 16

    def source_line(self, tier, label, kind, url, accessed):
        self.ensure(46)
        self.text(M_LEFT + 12, self.y - 8.5, f"TIER {tier}", SANS_B, 8.6, 0.6, ACCENT)
        words = parse_inline(f"{label} — *{kind}*. Accessed {accessed}.")
        self.draw_words(words, 11.2, 15.4, False, indent=62, width=FRAME_W - 74)
        self.c.setFont(SERIF_I, 10.2)
        self.c.setFillColor(HexColor("#12366b"))
        # wrap the URL on its own line(s)
        self._url(url, M_LEFT + 62, FRAME_W - 74)
        self.y -= 6

    def _url(self, url, x0, width):
        chunk = ""
        for ch in url:
            if sw(chunk + ch, SERIF_I, 9.6) > width:
                self.ensure(13)
                self.text(x0, self.y - 8, chunk, SERIF_I, 9.6, 0,
                          HexColor("#12366b"))
                self.y -= 12.5
                chunk = ch
            else:
                chunk += ch
        if chunk:
            self.ensure(13)
            self.text(x0, self.y - 8, chunk, SERIF_I, 9.6, 0, HexColor("#12366b"))
            self.y -= 13
