// Turns an AI answer (Markdown) into downloadable documents:
//  - case analysis -> PDF in the Master Case Research layout (A4, 16 pt body,
//    justified, double spacing, contents page, page numbers, notes, links);
//  - exam-ready notes -> Word (DOCX) in the navy / medium blue / burnt orange
//    palette with light blue-grey single-cell callout boxes.
// Both formats are available for every answer.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import PDFDocument from "pdfkit";
import { lexer } from "marked";
import {
  AlignmentType, BorderStyle, Document, ExternalHyperlink, Footer, FootnoteReferenceRun, HeadingLevel,
  LevelFormat, Packer, PageNumber, Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, WidthType
} from "docx";

export const PALETTE = { navy: "1F3864", blue: "2E75B6", orange: "C55A11", callout: "DEEAF6", red: "C00000", text: "1A1A1A", muted: "595959", border: "8EAADB", zebra: "F3F7FC" };
const FN_OPEN = "\uE000";
const FN_CLOSE = "\uE001";

const STATUS_TEXT = {
  verified: "Opened by FIRE COUNSEL; page mentions the case/topic",
  reachable: "Opened; case name not seen on the page",
  restricted: "Site blocks automatic checks; open it yourself to confirm",
  broken: "Could not be opened; do not rely on this link"
};

// ---------------------------------------------------------------- Markdown

export function safeLink(href) {
  try {
    const url = new URL(String(href || ""));
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

const decode = (text) => String(text || "").replace(/&(amp|lt|gt|quot|#39|#x27|nbsp);/g, (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: "\"", "#39": "'", "#x27": "'", nbsp: "\u00a0" })[e]);

/** Pulls out [^n] footnotes (marked has no footnote support) and lexes the rest. */
export function prepareMarkdown(markdown) {
  const footnotes = new Map();
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  const kept = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^\[\^([^\]\s]{1,24})\]:\s*(.*)$/);
    if (!match) { kept.push(lines[i]); continue; }
    let text = match[2];
    while (i + 1 < lines.length && /^( {2,}|\t)\S/.test(lines[i + 1])) text += ` ${lines[++i].trim()}`;
    footnotes.set(match[1], text.trim());
  }
  const order = [];
  const body = kept.join("\n").replace(/\[\^([^\]\s]{1,24})\]/g, (all, id) => {
    if (!footnotes.has(id)) return all;
    if (!order.includes(id)) order.push(id);
    return `${FN_OPEN}${id}${FN_CLOSE}`;
  });
  for (const id of footnotes.keys()) if (!order.includes(id)) order.push(id);
  const labels = new Map(order.map((id, index) => [id, /^\d{1,4}$/.test(id) ? id : String(index + 1)]));
  return { tokens: lexer(body, { gfm: true }), footnotes, order, labels };
}

function splitFootnotes(text, style) {
  return text.split(new RegExp(`${FN_OPEN}([^${FN_CLOSE}]*)${FN_CLOSE}`)).map((part, i) => (i % 2 ? { ...style, footnote: part, text: "" } : { ...style, text: part })).filter((run) => run.text || run.footnote);
}

export function inlineRuns(tokens = [], style = {}) {
  const runs = [];
  for (const token of tokens) {
    switch (token.type) {
      case "strong": runs.push(...inlineRuns(token.tokens, { ...style, bold: true })); break;
      case "em": runs.push(...inlineRuns(token.tokens, { ...style, italics: true })); break;
      case "del": runs.push(...inlineRuns(token.tokens, { ...style, strike: true })); break;
      case "codespan": runs.push({ ...style, text: decode(token.text), code: true }); break;
      case "link": {
        const link = safeLink(token.href);
        runs.push(...inlineRuns(token.tokens?.length ? token.tokens : [{ type: "text", text: token.text || token.href }], link ? { ...style, link } : style));
        break;
      }
      case "br": runs.push({ ...style, text: "\n" }); break;
      case "text": if (token.tokens?.length) runs.push(...inlineRuns(token.tokens, style)); else runs.push(...splitFootnotes(decode(token.text), style)); break;
      case "html": runs.push({ ...style, text: decode(token.text.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")) }); break;
      case "image": runs.push({ ...style, text: token.text || "" }); break;
      default: if (typeof token.text === "string") runs.push(...splitFootnotes(decode(token.text), style));
    }
  }
  return runs;
}

const plain = (runs, labels) => runs.map((run) => (run.footnote ? `[${labels?.get(run.footnote) || run.footnote}]` : run.text)).join("");

function blockText(tokens = [], labels) {
  return tokens.map((token) => {
    if (token.type === "list") return token.items.map((item) => blockText(item.tokens, labels)).join("\n");
    if (token.type === "table") return [token.header, ...token.rows].map((row) => row.map((cell) => plain(inlineRuns(cell.tokens), labels)).join(" | ")).join("\n");
    if (token.tokens && token.type !== "blockquote") return plain(inlineRuns(token.tokens), labels);
    if (token.type === "blockquote") return blockText(token.tokens, labels);
    return decode(token.text || "");
  }).filter(Boolean).join("\n");
}

function appendix({ footnotes, order, labels }, sources, accessDate) {
  const parts = [];
  if (order.length) {
    parts.push("## Notes", ...order.map((id) => `**[${labels.get(id)}]** ${footnotes.get(id)}`));
  }
  const usable = (sources || []).filter((source) => source?.url && safeLink(source.url));
  if (usable.length) {
    const cell = (value) => String(value || "").replace(/\|/g, "/").replace(/\s+/g, " ").trim();
    parts.push(
      `## Verification links checked by FIRE COUNSEL (${accessDate})`,
      "Every link below was opened automatically by the FIRE COUNSEL server on the date shown. Links marked as blocked or not opened must be checked by hand before you rely on them.",
      ["| # | Source | Link check | Link |", "|---|---|---|---|",
        ...usable.map((source, index) => `| ${index + 1} | ${cell(source.title) || cell(new URL(source.url).hostname)} | ${STATUS_TEXT[source.status] || cell(source.status)} | [${cell(source.url)}](${source.url}) |`)].join("\n")
    );
  }
  return parts.join("\n\n");
}

function accessDateText(date) {
  try {
    return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Africa/Lagos" }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export function documentFileName(title, extension) {
  const base = String(title || "fire-counsel").normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 80) || "fire-counsel";
  return `${base}.${extension}`;
}

// ---------------------------------------------------------------- PDF

const require = createRequire(import.meta.url);
function fontDir() {
  try {
    return join(dirname(require.resolve("dejavu-fonts-ttf/package.json")), "ttf");
  } catch {
    return null;
  }
}
const FONT_FILES = { Serif: "DejaVuSerif.ttf", "Serif-Bold": "DejaVuSerif-Bold.ttf", "Serif-Italic": "DejaVuSerif-Italic.ttf", "Serif-BoldItalic": "DejaVuSerif-BoldItalic.ttf", Mono: "DejaVuSansMono.ttf", Symbols: "DejaVuSans.ttf" };
const STANDARD_FONTS = { Serif: "Times-Roman", "Serif-Bold": "Times-Bold", "Serif-Italic": "Times-Italic", "Serif-BoldItalic": "Times-BoldItalic", Mono: "Courier", Symbols: "Helvetica" };
// Arrows, ticks, boxes and other symbols the serif face lacks come from DejaVu Sans.
const SYMBOL_RE = /[\u2190-\u21ff\u2300-\u23ff\u2460-\u27bf\u2900-\u2bff]/;

function registerFonts(doc) {
  const dir = fontDir();
  const ok = dir && Object.values(FONT_FILES).every((file) => existsSync(join(dir, file)));
  for (const [name, file] of Object.entries(FONT_FILES)) doc.registerFont(name, ok ? join(dir, file) : STANDARD_FONTS[name]);
  return ok;
}

const fontFor = (run) => (run.code ? "Mono" : run.bold && run.italics ? "Serif-BoldItalic" : run.bold ? "Serif-Bold" : run.italics ? "Serif-Italic" : "Serif");

export const PDF_PROFILES = {
  // Master Case Research §11.
  casebook: { size: 16, spacing: 2.0, contents: true, label: "Case analysis" },
  // Readable compact layout for notes and question papers.
  notes: { size: 12, spacing: 1.4, contents: true, label: "Study notes" }
};

function renderPdf(doc, ctxBase, prepared, headingPages) {
  const { profile, title, subtitle, labels } = ctxBase;
  const left = doc.page.margins.left;
  const fullWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom;
  const headings = [];
  let pageIndex = 0;
  doc.on("pageAdded", () => { pageIndex += 1; });

  doc.font("Serif").fontSize(profile.size);
  const bodyGap = doc.currentLineHeight() * (profile.spacing - 1) + 1;

  // Own line layout (word by word) so mixed bold/italic/link runs justify
  // correctly, footnote markers are true superscripts, and heights are exact.
  function layout(runs, width, size) {
    const pieces = [];
    let pendingSpace = false;
    for (const run of runs) {
      if (run.footnote) {
        pieces.push({ text: labels.get(run.footnote) || run.footnote, font: "Serif", size: size * 0.62, sup: true, space: false, color: run.color, link: run.link });
        pendingSpace = false;
        continue;
      }
      for (const part of String(run.text).split(/(\n|[ \t\u00a0]+)/)) {
        if (!part) continue;
        if (part === "\n") { pieces.push({ newline: true }); pendingSpace = false; continue; }
        if (/^[ \t\u00a0]+$/.test(part)) { pendingSpace = true; continue; }
        const font = SYMBOL_RE.test(part) ? "Symbols" : fontFor(run);
        pieces.push({ text: part, font, size: run.code ? Math.max(size - 2, 8) : size, space: pendingSpace, color: run.color, link: run.link, strike: run.strike });
        pendingSpace = false;
      }
    }
    const lines = [];
    let line = { words: [], width: 0, hard: false };
    const push = (hard) => { lines.push({ ...line, hard }); line = { words: [], width: 0, hard: false }; };
    for (const piece of pieces) {
      if (piece.newline) { push(true); continue; }
      doc.font(piece.font).fontSize(piece.size);
      piece.width = doc.widthOfString(piece.text);
      piece.gap = piece.space && line.words.length ? doc.widthOfString(" ") : 0;
      if (line.words.length && line.width + piece.gap + piece.width > width) { push(false); piece.gap = 0; }
      if (piece.width > width) {
        // A single very long word (e.g. a URL) is broken by characters.
        let chunk = "";
        for (const char of piece.text) {
          if (doc.widthOfString(chunk + char) > width && chunk) {
            line.words.push({ ...piece, text: chunk, width: doc.widthOfString(chunk), gap: 0 });
            push(false);
            chunk = "";
          }
          chunk += char;
        }
        piece.text = chunk;
        piece.width = doc.widthOfString(chunk);
        piece.gap = 0;
      }
      line.words.push(piece);
      line.width += piece.gap + piece.width;
    }
    if (line.words.length || !lines.length) push(true);
    doc.font("Serif").fontSize(size);
    const base = doc.currentLineHeight();
    for (const item of lines) item.height = base;
    return lines;
  }

  function writeRuns(runs, x, width, options = {}) {
    const size = options.size || profile.size;
    const lineGap = options.lineGap ?? bodyGap;
    const lines = layout(runs.filter((run) => run.text || run.footnote), width, size);
    let y = options.y ?? doc.y;
    const limit = options.height ? y + options.height : null;
    lines.forEach((line, index) => {
      if (limit != null && y + line.height > limit + 1) return;
      if (limit == null && y + line.height > bottom()) { doc.addPage(); y = doc.page.margins.top; }
      const last = index === lines.length - 1 || line.hard;
      const gaps = line.words.filter((word, i) => i > 0 && word.gap > 0).length;
      const justify = options.align === "justify" && !last && gaps > 0 ? (width - line.width) / gaps : 0;
      let cursor = x;
      line.words.forEach((word, i) => {
        if (i > 0 && word.gap > 0) cursor += word.gap + justify;
        doc.font(word.font).fontSize(word.size).fillColor(word.link ? `#${PALETTE.blue}` : word.color || options.color || `#${PALETTE.text}`);
        const wy = word.sup ? y - 1 : y + (size - word.size) * 0.75;
        doc.text(word.text, cursor, wy, { lineBreak: false });
        if (word.link) {
          doc.link(cursor, y, word.width, line.height, word.link);
          doc.save().moveTo(cursor, y + size * 1.02).lineTo(cursor + word.width, y + size * 1.02).lineWidth(0.6).strokeColor(`#${PALETTE.blue}`).stroke().restore();
        }
        if (word.strike) doc.save().moveTo(cursor, y + size * 0.6).lineTo(cursor + word.width, y + size * 0.6).lineWidth(0.6).strokeColor(`#${PALETTE.text}`).stroke().restore();
        cursor += word.width;
      });
      y += line.height + (last && index === lines.length - 1 ? 0 : lineGap);
    });
    doc.x = x;
    doc.y = y + (lines.length ? lineGap * 0.5 : 0);
    doc.fillColor(`#${PALETTE.text}`);
  }

  function measureRuns(runs, width, size, lineGap) {
    const lines = layout(runs.filter((run) => run.text || run.footnote), width, size);
    return lines.reduce((sum, line) => sum + line.height, 0) + Math.max(lines.length - 1, 0) * lineGap;
  }

  function ensureSpace(height) {
    if (doc.y + height > bottom()) doc.addPage();
  }

  function heading(token, ctx) {
    const level = Math.min(token.depth, 4);
    const sizes = [0, profile.size + 8, profile.size + 4, profile.size + 2, profile.size + 1];
    const colors = [0, PALETTE.navy, PALETTE.navy, PALETTE.blue, PALETTE.orange];
    const text = plain(inlineRuns(token.tokens), labels).trim() || " ";
    const atTop = doc.y <= doc.page.margins.top + 2;
    if (level === 1 && !ctx.inBox && !atTop && ctx.sectionBreaks) doc.addPage();
    else {
      doc.font("Serif-Bold").fontSize(sizes[level]);
      ensureSpace(doc.heightOfString(text, { width: ctx.width }) + profile.size * 3);
      if (!atTop) doc.moveDown(0.6);
    }
    const id = `h${headings.length}`;
    const recordable = !ctx.inBox && level <= 2;
    if (recordable) headings.push({ id, text, level, page: pageIndex });
    doc.font("Serif-Bold").fontSize(sizes[level]).fillColor(`#${colors[level]}`)
      .text(text, ctx.x, doc.y, { width: ctx.width, align: "left", lineGap: 4, ...(recordable ? { destination: id } : {}) });
    if (level <= 2 && !ctx.inBox) {
      const y = doc.y + 2;
      doc.save().moveTo(ctx.x, y).lineTo(ctx.x + ctx.width, y).lineWidth(level === 1 ? 1.5 : 0.75).strokeColor(`#${level === 1 ? PALETTE.orange : PALETTE.border}`).stroke().restore();
      doc.y = y + 6;
    } else doc.moveDown(0.2);
    doc.fillColor(`#${PALETTE.text}`);
  }

  function table(token, ctx) {
    const columns = token.header.length;
    const size = columns >= 7 ? 9 : columns >= 5 ? 10.5 : columns >= 3 ? 12 : 13;
    const pad = 5;
    const lineGap = 2;
    const cellRuns = (cell) => inlineRuns(cell.tokens);
    const weights = token.header.map((head, c) => {
      const lengths = [head, ...token.rows.map((row) => row[c])].map((cell) => plain(cellRuns(cell || { tokens: [] }), labels).length);
      return Math.min(Math.max(...lengths, 6), 60);
    });
    const total = weights.reduce((a, b) => a + b, 0);
    const minW = Math.min(55, ctx.width / columns);
    let widths = weights.map((w) => Math.max(minW, (w / total) * ctx.width));
    const scale = ctx.width / widths.reduce((a, b) => a + b, 0);
    widths = widths.map((w) => w * scale);
    const usable = doc.page.height - doc.page.margins.top - doc.page.margins.bottom;

    const measure = (row, bold) => Math.max(...row.map((cell, c) => {
      const runs = cellRuns(cell || { tokens: [] }).map((run) => (bold ? { ...run, bold: true } : run));
      return measureRuns(runs, widths[c] - 2 * pad, size, lineGap) + 2;
    })) + 2 * pad;

    const drawRow = (row, header, zebra) => {
      const height = Math.min(measure(row, header), usable - 4);
      if (doc.y + height > bottom()) {
        doc.addPage();
        if (!header) drawRow(token.header, true, false);
      }
      const y = doc.y;
      let x = ctx.x;
      row.forEach((cell, c) => {
        if (header || zebra) doc.save().rect(x, y, widths[c], height).fill(`#${header ? PALETTE.navy : PALETTE.zebra}`).restore();
        doc.save().rect(x, y, widths[c], height).lineWidth(0.5).strokeColor(`#${PALETTE.border}`).stroke().restore();
        const runs = cellRuns(cell || { tokens: [] }).map((run) => (header ? { ...run, bold: true, color: "#FFFFFF" } : run));
        writeRuns(runs, x + pad, widths[c] - 2 * pad, { size, lineGap, y: y + pad, height: height - 2 * pad, align: "left" });
        x += widths[c];
      });
      doc.x = ctx.x;
      doc.y = y + height;
    };
    doc.moveDown(0.3);
    drawRow(token.header, true, false);
    token.rows.forEach((row, index) => drawRow(row, false, index % 2 === 1));
    doc.moveDown(0.6);
  }

  function box(tokens, ctx, fill, accent) {
    const pad = 10;
    const inner = { ...ctx, x: ctx.x + pad + 3, width: ctx.width - 2 * pad - 3, inBox: true };
    doc.font("Serif").fontSize(profile.size);
    const estimate = doc.heightOfString(blockText(tokens, labels) || " ", { width: inner.width, lineGap: bodyGap }) * 1.1 + 2 * pad + 8;
    const usable = doc.page.height - doc.page.margins.top - doc.page.margins.bottom;
    doc.moveDown(0.3);
    if (estimate < usable) {
      ensureSpace(estimate);
      const y = doc.y;
      doc.save().rect(ctx.x, y, ctx.width, estimate).fill(`#${fill}`).restore();
      doc.save().rect(ctx.x, y, 3, estimate).fill(`#${accent}`).restore();
      doc.y = y + pad;
      blocks(tokens, inner);
      doc.y = Math.max(doc.y, y + estimate) + 4;
    } else {
      blocks(tokens, inner);
    }
    doc.x = ctx.x;
    doc.moveDown(0.4);
  }

  function list(token, ctx) {
    const markerWidth = token.ordered ? profile.size * 1.9 : profile.size * 1.2;
    token.items.forEach((item, index) => {
      const marker = item.task ? (item.checked ? "☑" : "☐") : token.ordered ? `${(Number(token.start) || 1) + index}.` : "•";
      ensureSpace(doc.currentLineHeight(true) + 2);
      const y = doc.y;
      doc.font(item.task ? "Symbols" : "Serif").fontSize(profile.size).fillColor(`#${PALETTE.text}`).text(marker, ctx.x, y, { width: markerWidth, lineGap: bodyGap, lineBreak: false });
      doc.y = y;
      blocks(item.tokens, { ...ctx, x: ctx.x + markerWidth, width: ctx.width - markerWidth, tight: true });
    });
    doc.x = ctx.x;
    doc.moveDown(0.2);
  }

  function blocks(tokens, ctx) {
    for (const token of tokens) {
      switch (token.type) {
        case "heading": heading(token, ctx); break;
        case "paragraph":
        case "text": {
          const runs = token.tokens ? inlineRuns(token.tokens) : splitFootnotes(decode(token.text), {});
          writeRuns(runs, ctx.x, ctx.width, { align: ctx.inBox || ctx.tight ? "left" : "justify" });
          if (!ctx.tight) doc.moveDown(0.25);
          break;
        }
        case "list": list(token, ctx); break;
        case "blockquote": box(token.tokens, ctx, PALETTE.callout, PALETTE.blue); break;
        case "table": table(token, ctx); break;
        case "code": {
          doc.font("Mono").fontSize(Math.max(profile.size - 4, 9));
          const height = doc.heightOfString(token.text || " ", { width: ctx.width - 16, lineGap: 2 }) + 16;
          ensureSpace(Math.min(height, 200));
          const y = doc.y;
          if (height < doc.page.height / 2) doc.save().rect(ctx.x, y, ctx.width, height).fill("#F2F2F2").restore();
          doc.fillColor(`#${PALETTE.text}`).text(token.text || " ", ctx.x + 8, y + 8, { width: ctx.width - 16, lineGap: 2 });
          doc.moveDown(0.6);
          break;
        }
        case "hr": {
          doc.moveDown(0.3);
          const y = doc.y;
          doc.save().moveTo(ctx.x, y).lineTo(ctx.x + ctx.width, y).lineWidth(0.75).strokeColor(`#${PALETTE.border}`).stroke().restore();
          doc.moveDown(0.6);
          break;
        }
        case "html": {
          const text = decode(token.text.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")).trim();
          if (text) writeRuns([{ text }], ctx.x, ctx.width, { align: "left" });
          break;
        }
        default: break;
      }
    }
  }

  // Title block and contents page.
  doc.font("Serif-Bold").fontSize(profile.size + 12).fillColor(`#${PALETTE.navy}`).text(title, left, doc.y, { width: fullWidth, align: "center", lineGap: 4 });
  doc.moveDown(0.3);
  doc.font("Serif-Italic").fontSize(Math.max(profile.size - 3, 11)).fillColor(`#${PALETTE.muted}`).text(subtitle, { width: fullWidth, align: "center", lineGap: 2 });
  doc.moveDown(0.5);
  doc.save().moveTo(left, doc.y).lineTo(left + fullWidth, doc.y).lineWidth(1.5).strokeColor(`#${PALETTE.orange}`).stroke().restore();
  doc.moveDown(1);
  if (profile.contents && headingPages?.length) {
    doc.font("Serif-Bold").fontSize(profile.size + 2).fillColor(`#${PALETTE.navy}`).text("Contents", left, doc.y, { width: fullWidth });
    doc.moveDown(0.4);
    const size = Math.max(profile.size - 2, 11);
    for (const entry of headingPages) {
      const indent = entry.level === 2 ? 18 : 0;
      doc.font(entry.level === 1 ? "Serif-Bold" : "Serif").fontSize(size);
      const height = doc.heightOfString(entry.text, { width: fullWidth - indent - 50, lineGap: 3 });
      ensureSpace(height + 4);
      const y = doc.y;
      doc.fillColor(`#${PALETTE.text}`).text(entry.text, left + indent, y, { width: fullWidth - indent - 50, lineGap: 3, goTo: entry.id });
      const after = doc.y;
      doc.text(String(entry.page + 1), left + fullWidth - 45, y, { width: 45, align: "right", goTo: entry.id });
      doc.y = Math.max(after, doc.y) + 2;
    }
  }
  doc.addPage();
  blocks(prepared.tokens, { x: left, width: fullWidth, sectionBreaks: true });
  return headings;
}

function finishPdf(doc, label) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    const bottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font("Serif").fontSize(10).fillColor(`#${PALETTE.muted}`)
      .text(`FIRE COUNSEL · ${label}  |  Page ${i + 1} of ${range.count}`, doc.page.margins.left, doc.page.height - bottomMargin + 24,
        { width: doc.page.width - doc.page.margins.left - doc.page.margins.right, align: "center", lineBreak: false });
    doc.page.margins.bottom = bottomMargin;
  }
}

function pdfPass(prepared, options, headingPages) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4", margins: { top: 72, bottom: 72, left: 68, right: 68 }, bufferPages: true,
      info: { Title: options.title, Author: "FIRE COUNSEL AI", Subject: options.profile.label, Creator: "FIRE COUNSEL" }, lang: "en-GB", displayTitle: true
    });
    registerFonts(doc);
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("error", reject);
    let headings;
    doc.on("end", () => resolve({ buffer: Buffer.concat(chunks), headings }));
    try {
      headings = renderPdf(doc, { ...options, labels: prepared.labels }, prepared, headingPages);
      finishPdf(doc, options.profile.label);
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

/** Builds a PDF. Two passes: the first finds the page of every heading for the contents page. */
export async function buildPdf({ title, markdown, sources = [], profile = "casebook", generatedAt = new Date(), modelNote = "" }) {
  const settings = PDF_PROFILES[profile] || PDF_PROFILES.casebook;
  const accessDate = accessDateText(generatedAt);
  const first = prepareMarkdown(markdown);
  const extra = appendix(first, sources, accessDate);
  const prepared = prepareMarkdown(`${markdown}\n\n${extra}`);
  const options = {
    profile: settings,
    title: String(title || settings.label).slice(0, 200),
    subtitle: `Prepared by FIRE COUNSEL AI on ${accessDate}${modelNote ? ` · ${modelNote}` : ""}. Check every authority against the linked sources before relying on it.`
  };
  const draft = await pdfPass(prepared, options, settings.contents ? [{ id: "x", text: "Contents", level: 1, page: 0 }] : null);
  if (!settings.contents || !draft.headings.length) return draft.buffer;
  const sized = await pdfPass(prepared, options, draft.headings);
  // The contents page can push headings onto later pages; one more pass settles it.
  if (sized.headings.every((h, i) => h.page === draft.headings[i]?.page)) return sized.buffer;
  return (await pdfPass(prepared, options, sized.headings)).buffer;
}

// ---------------------------------------------------------------- DOCX

const DOCX_FONT = "Calibri";
const HEAD_FONT = "Cambria";

function docxRuns(runs, labels, footnoteIds, base = {}) {
  const children = [];
  for (const run of runs) {
    if (run.footnote) {
      const id = footnoteIds.get(run.footnote);
      if (id) children.push(new FootnoteReferenceRun(id));
      else children.push(new TextRun({ text: `[${labels.get(run.footnote) || run.footnote}]`, superScript: true }));
      continue;
    }
    const pieces = run.text.split("\n");
    pieces.forEach((piece, index) => {
      // "TESTED: 2019, 2021" markers are shown in red, as in the exam-note format.
      for (const [i, segment] of piece.split(/(\bTESTED\b:?[^.;\n)]*)/).entries()) {
        if (!segment && !(index > 0 && i === 0)) continue;
        const tested = i % 2 === 1;
        const options = {
          text: segment, break: index > 0 && i === 0 ? 1 : undefined, bold: run.bold || tested || base.bold, italics: run.italics || base.italics, strike: run.strike,
          font: run.code ? "Consolas" : base.font || DOCX_FONT, color: tested ? PALETTE.red : run.link ? "0563C1" : base.color, size: base.size,
          underline: run.link ? {} : undefined
        };
        const textRun = new TextRun(options);
        children.push(run.link ? new ExternalHyperlink({ link: run.link, children: [textRun] }) : textRun);
      }
    });
  }
  return children.length ? children : [new TextRun({ text: "", ...base })];
}

function docxBlocks(tokens, state, ctx = {}) {
  const out = [];
  const runs = (inline, base) => docxRuns(inlineRuns(inline), state.labels, state.footnoteIds, base);
  for (const token of tokens) {
    switch (token.type) {
      case "heading": {
        const level = Math.min(token.depth, 4);
        const map = { 1: [HeadingLevel.HEADING_1, PALETTE.navy, 36], 2: [HeadingLevel.HEADING_2, PALETTE.blue, 30], 3: [HeadingLevel.HEADING_3, PALETTE.orange, 26], 4: [HeadingLevel.HEADING_4, PALETTE.orange, 24] };
        const [headingLevel, color, size] = map[level];
        out.push(new Paragraph({
          heading: headingLevel, keepNext: true, spacing: { before: level === 1 ? 360 : 240, after: 120 },
          border: level === 1 ? { bottom: { style: BorderStyle.SINGLE, size: 12, color: PALETTE.orange, space: 4 } } : undefined,
          children: runs(token.tokens, { bold: true, color, size, font: HEAD_FONT })
        }));
        break;
      }
      case "paragraph":
      case "text":
        out.push(new Paragraph({
          alignment: ctx.inCell ? AlignmentType.LEFT : AlignmentType.JUSTIFIED, spacing: { after: ctx.tight ? 40 : 140, line: 276 },
          ...(ctx.list?.marker || (ctx.list?.indent ? { indent: ctx.list.indent } : {})),
          children: token.tokens ? runs(token.tokens, ctx.base) : docxRuns(splitFootnotes(decode(token.text), {}), state.labels, state.footnoteIds, ctx.base)
        }));
        break;
      case "list": {
        const level = Math.min(ctx.level ?? 0, 4);
        const instance = token.ordered ? ++state.listInstance : 0;
        for (const item of token.items) {
          const marker = token.ordered ? { numbering: { reference: "fc-ordered", level, instance } } : { bullet: { level } };
          const continuation = { left: 720 * (level + 1) };
          let first = true;
          for (const child of item.tokens) {
            if (child.type === "list") { out.push(...docxBlocks([child], state, { ...ctx, level: level + 1, list: undefined })); continue; }
            out.push(...docxBlocks([child], state, { ...ctx, tight: true, list: first ? { marker } : { indent: continuation } }));
            first = false;
          }
        }
        out.push(new Paragraph({ spacing: { after: 60 }, children: [] }));
        break;
      }
      case "blockquote":
        out.push(new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE }, left: { style: BorderStyle.SINGLE, size: 24, color: PALETTE.blue }, insideHorizontal: { style: BorderStyle.NONE }, insideVertical: { style: BorderStyle.NONE } },
          rows: [new TableRow({ children: [new TableCell({
            shading: { type: ShadingType.CLEAR, fill: PALETTE.callout, color: "auto" },
            margins: { top: 120, bottom: 120, left: 180, right: 180 },
            children: docxBlocks(token.tokens, state, { ...ctx, inCell: true, tight: true })
          })] })]
        }), new Paragraph({ spacing: { after: 120 }, children: [] }));
        break;
      case "table": {
        const row = (cells, header) => new TableRow({
          tableHeader: header,
          children: cells.map((cell) => new TableCell({
            shading: header ? { type: ShadingType.CLEAR, fill: PALETTE.navy, color: "auto" } : undefined,
            margins: { top: 60, bottom: 60, left: 100, right: 100 },
            children: [new Paragraph({ children: runs(cell?.tokens || [], header ? { bold: true, color: "FFFFFF" } : {}) })]
          }))
        });
        out.push(new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          borders: Object.fromEntries(["top", "bottom", "left", "right", "insideHorizontal", "insideVertical"].map((side) => [side, { style: BorderStyle.SINGLE, size: 4, color: PALETTE.border }])),
          rows: [row(token.header, true), ...token.rows.map((cells) => row(cells, false))]
        }), new Paragraph({ spacing: { after: 120 }, children: [] }));
        break;
      }
      case "code":
        out.push(...String(token.text || "").split("\n").map((line) => new Paragraph({ shading: { type: ShadingType.CLEAR, fill: "F2F2F2", color: "auto" }, spacing: { after: 0 }, children: [new TextRun({ text: line, font: "Consolas", size: 20 })] })));
        break;
      case "hr":
        out.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: PALETTE.border, space: 1 } }, children: [] }));
        break;
      case "html": {
        const text = decode(token.text.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")).trim();
        if (text) out.push(new Paragraph({ children: [new TextRun({ text })] }));
        break;
      }
      default: break;
    }
  }
  return out;
}

export async function buildDocx({ title, markdown, sources = [], generatedAt = new Date(), modelNote = "" }) {
  const accessDate = accessDateText(generatedAt);
  const prepared = prepareMarkdown(markdown);
  const footnoteIds = new Map(prepared.order.map((id, index) => [id, index + 1]));
  const footnotes = Object.fromEntries(prepared.order.map((id, index) => [index + 1, {
    children: [new Paragraph({ children: docxRuns(inlineRuns(lexer(prepared.footnotes.get(id) || "")[0]?.tokens || []), prepared.labels, new Map(), { size: 18 }) })]
  }]));
  const linksOnly = appendix({ footnotes: new Map(), order: [], labels: new Map() }, sources, accessDate);
  const appendixTokens = linksOnly ? lexer(linksOnly, { gfm: true }) : [];
  const state = { labels: prepared.labels, footnoteIds, listInstance: 0 };
  const children = [
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 80 }, children: [new TextRun({ text: String(title || "Exam-ready notes").slice(0, 200), bold: true, size: 40, color: PALETTE.navy, font: HEAD_FONT })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 240 }, border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: PALETTE.orange, space: 6 } },
      children: [new TextRun({ text: `Prepared by FIRE COUNSEL AI on ${accessDate}${modelNote ? ` · ${modelNote}` : ""}`, italics: true, size: 20, color: PALETTE.muted })] }),
    ...docxBlocks(prepared.tokens, state),
    ...docxBlocks(appendixTokens, state)
  ];
  const doc = new Document({
    creator: "FIRE COUNSEL AI",
    title: String(title || "Exam-ready notes").slice(0, 200),
    styles: {
      default: { document: { run: { font: DOCX_FONT, size: 23, color: PALETTE.text } } },
      characterStyles: [{ id: "Hyperlink", name: "Hyperlink", run: { color: "0563C1", underline: {} } }]
    },
    numbering: { config: [{ reference: "fc-ordered", levels: [0, 1, 2, 3, 4].map((level) => ({ level, format: level % 2 ? LevelFormat.LOWER_LETTER : LevelFormat.DECIMAL, text: `%${level + 1}.`, alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } } })) }] },
    footnotes,
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "FIRE COUNSEL · Page ", size: 18, color: PALETTE.muted }), new TextRun({ children: [PageNumber.CURRENT], size: 18, color: PALETTE.muted }), new TextRun({ text: " of ", size: 18, color: PALETTE.muted }), new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 18, color: PALETTE.muted })] })] }) },
      children
    }]
  });
  return Packer.toBuffer(doc);
}
