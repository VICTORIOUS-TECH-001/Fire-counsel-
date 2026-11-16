import { AiError } from "./providers.js";

export const ATTACHMENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf", "text/plain"]);
export const MAX_FILES = 6;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 18 * 1024 * 1024;

/** Validates base64 uploads sent as JSON: [{ name, mimeType, data }]. */
export function validateAttachments(input) {
  if (input == null) return [];
  if (!Array.isArray(input)) throw new AiError(400, "Attachments must be a list of files.", "VALIDATION_ERROR");
  if (input.length > MAX_FILES) throw new AiError(400, `Attach at most ${MAX_FILES} files at a time.`, "VALIDATION_ERROR");
  let total = 0;
  return input.map((file, index) => {
    const mimeType = String(file?.mimeType || "").toLowerCase();
    if (!ATTACHMENT_TYPES.has(mimeType)) throw new AiError(400, `File ${index + 1}: only photos (JPG, PNG, WEBP, HEIC), PDF and .txt files are supported.`, "UNSUPPORTED_FILE");
    const data = typeof file?.data === "string" ? file.data.replace(/^data:[^,]*,/, "").replace(/\s+/g, "") : "";
    if (!data || data.length % 4 === 1 || !/^[A-Za-z0-9+/]+=*$/.test(data)) throw new AiError(400, `File ${index + 1} could not be read. Try selecting it again.`, "VALIDATION_ERROR");
    const size = Math.floor((data.length * 3) / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
    if (size > MAX_FILE_BYTES) throw new AiError(413, `File ${index + 1} is larger than 10 MB. Use a smaller photo or split the PDF.`, "FILE_TOO_LARGE");
    total += size;
    if (total > MAX_TOTAL_BYTES) throw new AiError(413, "Files are larger than 18 MB in total. Send fewer pages at a time.", "FILE_TOO_LARGE");
    const name = String(file?.name || `file-${index + 1}`).replace(/[\u0000-\u001f\u007f/\\]/g, "_").slice(0, 120);
    return { name, mimeType, data, size };
  });
}

export const attachmentSummary = (files) => files.map(({ name, mimeType, size }) => ({ name, mime_type: mimeType, size }));
