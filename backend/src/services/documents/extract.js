// Turns an uploaded document into page-numbered text.
//
//  - Digital PDFs: read locally with pdf.js (Mozilla's free PDF library). No AI,
//    no cost, any number of pages.
//  - Scanned PDFs / photos: read by the caller's configured OCR provider,
//    a few pages at a time. If the AI is unavailable, the free OCR.space API is
//    used for small files (free plan: 1 MB, 3 PDF pages) when OCR_SPACE_API_KEY
//    is set.
//  - Word (.docx): mammoth. Plain text: as is.
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDFDocument } from "pdf-lib";
import mammoth from "mammoth";
import { AiError, aiConfig, generate as defaultGenerate } from "../ai/providers.js";

export const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const SUPPORTED_TYPES = new Set(["application/pdf", DOCX_TYPE, "text/plain", "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
const OCR_SPACE_URL = "https://api.ocr.space/parse/image";
const OCR_SPACE_FREE_BYTES = 1024 * 1024;
const OCR_SPACE_FREE_PDF_PAGES = 3;
const MIN_PAGE_CHARS = 25;

const TRANSCRIBE = `You transcribe scanned law documents (judgments, lecture notes, textbooks, examination papers) into plain text.
Rules:
- Transcribe faithfully, word for word. Do not summarise, translate, correct or add anything.
- Keep headings, numbered paragraphs, footnote numbers and footnote text, case names and citations exactly as printed.
- Start every page with a line "[Page N]" using the page numbers given to you.
- Write [illegible] for words you cannot read. Skip page decorations such as watermarks.`;

export class DocumentError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const clean = (text) => String(text || "")
  .replace(/\r\n?/g, "\n")
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
  .replace(/[ \t]+\n/g, "\n")
  .replace(/\n{4,}/g, "\n\n\n")
  .trim();

/** Detects the real file type from its first bytes (never trusts the name alone). */
export function sniffType(buffer, name = "", declared = "") {
  if (!buffer?.length) return null;
  const head = buffer.subarray(0, 16);
  const ascii = head.toString("latin1");
  const lower = String(name).toLowerCase();
  if (ascii.startsWith("%PDF-")) return "application/pdf";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head[0] === 0x89 && ascii.slice(1, 4) === "PNG") return "image/png";
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return "image/webp";
  if (ascii.slice(4, 8) === "ftyp" && /heic|heix|mif1|msf1|heif/.test(ascii.slice(8, 12))) return "image/heic";
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) {
    return lower.endsWith(".docx") || declared === DOCX_TYPE ? DOCX_TYPE : null;
  }
  if (lower.endsWith(".txt") || lower.endsWith(".md") || declared === "text/plain") {
    const sample = buffer.subarray(0, 4096);
    return sample.includes(0) ? null : "text/plain";
  }
  return null;
}

// ------------------------------------------------------------------ page text helpers

/** "[Page N]" markers let a human edit the text without losing page numbers. */
export function pagesToText(pages) {
  return pages.map((page) => (page.page != null ? `[Page ${page.page}]\n${page.text}` : page.text)).join("\n\n").trim();
}

export function textToPages(text) {
  const source = String(text || "");
  const marker = /^\s*\[Page (\d{1,5})\]\s*$/gm;
  const found = [...source.matchAll(marker)];
  if (!found.length) return [{ page: null, text: source.trim() }];
  const pages = [];
  const before = source.slice(0, found[0].index).trim();
  if (before) pages.push({ page: null, text: before });
  found.forEach((match, index) => {
    const end = index + 1 < found.length ? found[index + 1].index : source.length;
    pages.push({ page: Number(match[1]), text: source.slice(match.index + match[0].length, end).trim() });
  });
  return pages;
}

/** Splits an AI transcription of pages firstPage..firstPage+count-1 into pages. */
export function splitMarkedPages(text, firstPage, count) {
  const pages = textToPages(clean(text)).filter((page) => page.text);
  const last = firstPage + count - 1;
  if (!pages.some((page) => page.page != null)) return [{ page: firstPage, text: clean(text) }];
  return pages.map((page) => {
    let number = page.page;
    if (number == null || number < firstPage || number > last) {
      // The model numbered from 1 instead of the original page numbers.
      number = number != null && number >= 1 && number <= count ? firstPage + number - 1 : firstPage;
    }
    return { page: number, text: page.text };
  });
}

/** Cuts page text into chunks of at most maxChars (paragraph, then word boundaries). */
export function chunkPages(pages, maxChars = 3_500) {
  const chunks = [];
  for (const { page, text } of pages) {
    const source = clean(text);
    let position = 0;
    while (position < source.length) {
      let end = Math.min(position + maxChars, source.length);
      if (end < source.length) {
        const paragraph = source.lastIndexOf("\n\n", end);
        const space = source.lastIndexOf(" ", end);
        if (paragraph > position + maxChars * 0.5) end = paragraph;
        else if (space > position + maxChars * 0.65) end = space;
      }
      const content = source.slice(position, end).trim();
      if (content) chunks.push({ page: page ?? null, content });
      position = end;
    }
  }
  return chunks;
}

// ------------------------------------------------------------------ PDF

export async function readPdfText(buffer, { maxPages = Infinity } = {}) {
  const task = getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  let pdf;
  try {
    pdf = await task.promise;
  } catch (error) {
    await task.destroy().catch(() => {});
    if (error?.name === "PasswordException") throw new DocumentError(400, "This PDF is password-protected. Remove the password (print it to a new PDF) and upload again.", "PDF_PASSWORD");
    throw new DocumentError(400, "This PDF is damaged or not a real PDF. Try saving it again and re-uploading.", "PDF_DAMAGED");
  }
  try {
    if (pdf.numPages > maxPages) throw new DocumentError(413, `This PDF has more than ${maxPages} pages. Split it into smaller files for the working station.`, "DOCUMENT_TOO_LONG");
    const pages = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items) {
        if (typeof item.str !== "string") continue;
        text += item.str;
        text += item.hasEOL ? "\n" : (item.str && !item.str.endsWith(" ") ? " " : "");
      }
      pages.push({ page: number, text: clean(text.replace(/ +\n/g, "\n").replace(/ {2,}/g, " ")) });
      page.cleanup();
    }
    return pages;
  } finally {
    await task.destroy().catch(() => {});
  }
}

const isEmptyPage = (page) => page.text.replace(/\s+/g, "").length < MIN_PAGE_CHARS;

/** True when one or more pages have no text layer (scanned/photographed pages). */
export function needsOcr(pages) {
  return pages.some(isEmptyPage);
}

async function pdfSubset(sourceDoc, pageNumbers) {
  const out = await PDFDocument.create();
  const copied = await out.copyPages(sourceDoc, pageNumbers.map((n) => n - 1));
  copied.forEach((page) => out.addPage(page));
  return Buffer.from(await out.save());
}

function groupRuns(numbers, size) {
  const groups = [];
  for (const number of numbers) {
    const current = groups.at(-1);
    if (current && current.length < size && current.at(-1) === number - 1) current.push(number);
    else groups.push([number]);
  }
  return groups;
}

// ------------------------------------------------------------------ OCR engines

async function aiTranscribe({ data, mimeType, name, firstPage, count }, { env, generate }) {
  const pagesNote = count > 1
    ? `This file contains pages ${firstPage} to ${firstPage + count - 1} of the original document. Label them [Page ${firstPage}] to [Page ${firstPage + count - 1}].`
    : `This is page ${firstPage} of the original document. Label it [Page ${firstPage}].`;
  const result = await generate({
    system: TRANSCRIBE,
    messages: [{ role: "user", text: `${pagesNote} Transcribe it.`, attachments: [{ name, mimeType, data: data.toString("base64"), size: data.length }] }],
    maxTokens: Math.min(8_000 + count * 3_000, 60_000),
    temperature: 0
  }, { env });
  return { pages: splitMarkedPages(result.text, firstPage, count), provider: result.provider, truncated: Boolean(result.truncated) };
}

/** Free OCR.space API (https://ocr.space/ocrapi). Returns [{ page, text }]. */
export async function ocrSpace({ data, mimeType, name = "file" }, { key, fetchImpl = fetch, firstPage = 1 } = {}) {
  if (!key) throw new DocumentError(503, "OCR.space is not configured.", "OCR_NOT_CONFIGURED");
  if (data.length > OCR_SPACE_FREE_BYTES) throw new DocumentError(413, "The free OCR.space plan only reads files up to 1 MB.", "OCR_FILE_TOO_LARGE");
  const form = new FormData();
  form.append("file", new Blob([data], { type: mimeType }), name);
  form.append("language", "eng");
  form.append("OCREngine", "2");
  form.append("scale", "true");
  form.append("isTable", "false");
  if (mimeType === "application/pdf") form.append("filetype", "PDF");
  let response;
  try {
    response = await fetchImpl(OCR_SPACE_URL, { method: "POST", headers: { apikey: key }, body: form, signal: AbortSignal.timeout(120_000) });
  } catch {
    throw new DocumentError(502, "OCR.space could not be reached.", "OCR_FAILED");
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.IsErroredOnProcessing) {
    const detail = [].concat(body.ErrorMessage || []).join(" ").slice(0, 200);
    throw new DocumentError(502, `OCR.space could not read the file${detail ? `: ${detail}` : "."}`, "OCR_FAILED");
  }
  return (body.ParsedResults || []).map((result, index) => ({ page: firstPage + index, text: clean(result.ParsedText) }));
}

// ------------------------------------------------------------------ main entry

/**
 * @returns {{ pages: {page:number|null,text:string}[], pageCount:number|null, method:string, characters:number, warnings:string[] }}
 */
export async function extractDocument({ buffer, mimeType, name = "document" }, { env = process.env, generate = defaultGenerate, fetchImpl = fetch, onProgress = () => {}, maxPages = Infinity } = {}) {
  const type = sniffType(buffer, name, mimeType);
  if (!type) throw new DocumentError(415, "Upload a PDF, Word (.docx), photo (JPG, PNG, WEBP) or .txt file.", "UNSUPPORTED_FILE");
  const ai = aiConfig(env).configured;
  const keyName = env.DOCUMENT_AI_KEY_NAME === "ADMIN_GEMINI_API_KEY" ? "ADMIN_GEMINI_API_KEY" : "GEMINI_API_KEY";
  const ocrKey = String(env.OCR_SPACE_API_KEY || "").trim();
  const maxOcrPages = Math.min(Math.max(Number(env.DOCUMENT_OCR_MAX_PAGES) || 150, 1), 1000);
  const batchPages = Math.min(Math.max(Number(env.DOCUMENT_OCR_BATCH_PAGES) || 6, 1), 20);
  const warnings = [];
  const finish = (pages, pageCount, method) => {
    const kept = pages.map((page) => ({ page: page.page, text: clean(page.text) }));
    const characters = kept.reduce((sum, page) => sum + page.text.length, 0);
    if (!characters) throw new DocumentError(422, "No readable text was found in this file. If it is a photo or scan, make sure it is clear and the right way up.", "NO_TEXT");
    if (type === "application/pdf" && pageCount) {
      const present = new Set(kept.filter(page => page.text).map(page => page.page));
      const missing = Array.from({ length: pageCount }, (_, index) => index + 1).filter(number => !present.has(number));
      if (missing.length) warnings.push(`Page(s) ${missing.slice(0, 30).join(", ")}${missing.length > 30 ? " and more" : ""} could not be read. They may be blank or missing from the transcription; compare the original before saving.`);
    }
    return { pages: kept, pageCount, method, characters, warnings };
  };
  const notConfigured = () => new DocumentError(503, `This file is a scan or photo, so it needs OCR. Add ${keyName} or OCR_SPACE_API_KEY in the server environment, then retry. Admin uploads never use the student Gemini key.`, "OCR_NOT_CONFIGURED");

  if (type === "text/plain") return finish([{ page: null, text: buffer.toString("utf8").replace(/^\uFEFF/, "") }], null, "text");

  if (type === DOCX_TYPE) {
    let result;
    try { result = await mammoth.extractRawText({ buffer }); } catch {
      throw new DocumentError(400, "This Word file could not be opened. Save it again as .docx and re-upload.", "DOCX_DAMAGED");
    }
    return finish([{ page: null, text: result.value }], null, "docx");
  }

  if (type.startsWith("image/")) {
    onProgress("Reading the photo…");
    if (ai) {
      try {
        const read = await aiTranscribe({ data: buffer, mimeType: type, name, firstPage: 1, count: 1 }, { env, generate });
        if (read.truncated) warnings.push("The photo transcription may be cut short (the AI reply hit its length limit).");
        return finish(read.pages, 1, `ai_ocr:${read.provider}`);
      } catch (error) {
        if (!ocrKey && error.code?.startsWith("ADMIN_")) throw error;
        if (!ocrKey) throw new DocumentError(502, `The AI could not read this photo right now (${error.message}). Try again later.`, "OCR_FAILED");
        warnings.push(`AI reading failed (${error.code || "error"}); OCR.space was used instead, so check the text.`);
      }
    }
    if (!ocrKey) throw notConfigured();
    if (type === "image/heic" || type === "image/heif") throw new DocumentError(415, "OCR.space cannot read HEIC photos. Take a JPG screenshot of it and upload that.", "UNSUPPORTED_FILE");
    return finish(await ocrSpace({ data: buffer, mimeType: type, name }, { key: ocrKey, fetchImpl }), 1, "ocr_space");
  }

  // PDF
  onProgress("Reading the PDF text…");
  const pages = await readPdfText(buffer, { maxPages });
  const pageCount = pages.length;
  const empty = pages.filter(isEmptyPage).map((page) => page.page);
  if (!empty.length) return finish(pages, pageCount, "pdf_text");

  // Some or all pages are scans: read only those pages.
  const allScanned = empty.length === pageCount;
  if (!ai && !ocrKey) {
    if (!allScanned) {
      warnings.push(`${empty.length} scanned page(s) could not be read because no OCR is configured.`);
      return finish(pages, pageCount, "pdf_text");
    }
    throw notConfigured();
  }
  const toRead = empty.slice(0, maxOcrPages);
  if (empty.length > toRead.length) warnings.push(`Only the first ${maxOcrPages} scanned pages were read. Split the PDF and upload the rest separately.`);
  const byNumber = new Map(pages.map((page) => [page.page, page]));
  let provider = null;
  if (ai) {
    let source;
    try { source = await PDFDocument.load(buffer, { ignoreEncryption: true }); } catch {
      throw new DocumentError(400, "This PDF is damaged or not a real PDF. Try saving it again and re-uploading.", "PDF_DAMAGED");
    }
    const groups = groupRuns(toRead, batchPages);
    let done = 0;
    let lastAdminError;
    for (const group of groups) {
      onProgress(`Reading scanned pages ${group[0]}–${group.at(-1)} of ${pageCount} with AI…`);
      try {
        const data = await pdfSubset(source, group);
        const read = await aiTranscribe({ data, mimeType: "application/pdf", name, firstPage: group[0], count: group.length }, { env, generate });
        provider = provider || read.provider;
        if (read.truncated) warnings.push(`Pages ${group[0]}–${group.at(-1)} may be cut short (the AI reply hit its length limit).`);
        for (const page of read.pages) {
          const target = byNumber.get(page.page);
          if (target) target.text = target.text && !isEmptyPage(target) ? `${target.text}\n${page.text}` : page.text;
        }
        done += group.length;
      } catch (error) {
        if (error.code?.startsWith("ADMIN_")) lastAdminError = error;
        if (error instanceof AiError && error.code === "AI_NOT_CONFIGURED") throw notConfigured();
        warnings.push(`Pages ${group[0]}–${group.at(-1)} could not be read by the AI (${error.code || "error"}). Retry later to fill them in.`);
      }
    }
    if (!done && allScanned) {
      if (ocrKey && buffer.length <= OCR_SPACE_FREE_BYTES && pageCount <= OCR_SPACE_FREE_PDF_PAGES) {
        warnings.push("The AI could not read this scan, so OCR.space was used instead; check the text.");
        return finish(await ocrSpace({ data: buffer, mimeType: "application/pdf", name }, { key: ocrKey, fetchImpl }), pageCount, "ocr_space");
      }
      if (lastAdminError) throw lastAdminError;
      throw new DocumentError(502, "The AI could not read this scanned PDF right now (free quota or a busy service). Tap Retry in a few minutes.", "OCR_FAILED");
    }
    return finish(pages, pageCount, allScanned ? `ai_ocr:${provider}` : `pdf_text+ai_ocr:${provider}`);
  }
  // OCR.space only
  if (buffer.length > OCR_SPACE_FREE_BYTES || pageCount > OCR_SPACE_FREE_PDF_PAGES) {
    throw new DocumentError(413, `This scan is too big for the free OCR.space plan (1 MB and 3 pages). Add ${keyName} in the server environment to read long scans, or split the PDF.`, "OCR_FILE_TOO_LARGE");
  }
  onProgress("Reading the scan with OCR.space…");
  const read = await ocrSpace({ data: buffer, mimeType: "application/pdf", name }, { key: ocrKey, fetchImpl });
  for (const page of read) {
    const target = byNumber.get(page.page);
    if (target && isEmptyPage(target)) target.text = page.text;
  }
  return finish(pages, pageCount, allScanned ? "ocr_space" : "pdf_text+ocr_space");
}
