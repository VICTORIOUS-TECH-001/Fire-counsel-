// Public homepage media only. R2 files are read directly by the browser;
// no bucket credentials, uploads, proxy or private student files belong here.
export const CASE_VIDEO_ORIGIN = "https://pub-8f421f9b11d64c18bb8a952d99a77e62.r2.dev";
export const DEFAULT_CASE_VIDEO_URL = `${CASE_VIDEO_ORIGIN}/Statue%20of%20justice%20ThemisTaken%20by%20Canon%20EOS%20R5%20with%2024.mp4`;

export function safeCaseVideoUrl(value) {
  if (typeof value !== "string" || value.length > 2000 || /[\u0000-\u0020\u007f\\]/.test(value)) return "";
  try {
    const url = new URL(value);
    const path = decodeURIComponent(url.pathname);
    if (url.origin !== CASE_VIDEO_ORIGIN || url.username || url.password || url.search || url.hash
      || path === "/" || /[\u0000-\u001f\u007f\\]/.test(path)
      || !/\.(?:mp4|webm)$/i.test(path)) return "";
    return url.href;
  } catch { return ""; }
}

export function caseVideoUrl(content) {
  // Existing Firestore publishes gain the owner's clip without any live write.
  // An explicit empty value disables it; invalid input never contacts a host.
  return content?.caseNotes && Object.hasOwn(content.caseNotes, "videoUrl")
    ? safeCaseVideoUrl(content.caseNotes.videoUrl) : DEFAULT_CASE_VIDEO_URL;
}
