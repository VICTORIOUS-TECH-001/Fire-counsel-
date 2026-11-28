// Public homepage media only. R2 files are read directly by the browser;
// no bucket credentials, uploads, proxy or private student files belong here.
export const CASE_VIDEO_ORIGIN = "https://pub-8f421f9b11d64c18bb8a952d99a77e62.r2.dev";
export const DEFAULT_CASE_VIDEO_URL = `${CASE_VIDEO_ORIGIN}/hipage%20(1).mp4`;
const PREVIOUS_CASE_VIDEO_URL = `${CASE_VIDEO_ORIGIN}/Statue%20of%20justice%20ThemisTaken%20by%20Canon%20EOS%20R5%20with%2024.mp4`;

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
  // Replace only the owner's former default at read time, including stored
  // publishes which explicitly contain it. Never rewrite the document or
  // override a custom/disabled URL; invalid input never contacts a host.
  const source = content?.caseNotes && Object.hasOwn(content.caseNotes, "videoUrl")
    ? safeCaseVideoUrl(content.caseNotes.videoUrl) : DEFAULT_CASE_VIDEO_URL;
  return source === PREVIOUS_CASE_VIDEO_URL ? DEFAULT_CASE_VIDEO_URL : source;
}
