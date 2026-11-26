// Shared admin response diagnostics. This module NEVER retries a request:
// callers may schedule bounded status GETs, never mutations or AI generation.
export function retryAfterMs(response, body = {}, now = Date.now()) {
  const raw = response.headers.get("Retry-After");
  const seconds = raw == null ? NaN : Number(raw);
  const absolute = raw && !Number.isFinite(seconds) ? Date.parse(raw) : NaN;
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(absolute) ? absolute - now
    : typeof body?.retry_after_seconds === "number" ? body.retry_after_seconds * 1000 : 0;
  // No early retry of a supplied deadline. A very long provider/ingress hold
  // is shown for manual follow-up instead of silently shortening its delay.
  return Math.max(0, Number.isFinite(delay) ? delay : 0);
}

export async function adminResponse(response) {
  let body = {};
  try { body = await response.json(); } catch { /* platform replies may be HTML */ }
  if (body == null || typeof body !== "object" || Array.isArray(body)) body = {};
  if (!response.ok) {
    const temporary = [502, 503, 504].includes(response.status);
    const fallback = response.status === 429
      ? "The API request limit was reached (HTTP 429). Wait before checking again; this reply alone does not establish Gemini quota."
      : temporary ? `The API service is temporarily unavailable (HTTP ${response.status}). An existing job may still be running.`
        : `The server could not confirm this operation (HTTP ${response.status}).`;
    throw Object.assign(new Error(typeof body.error === "string" ? body.error : fallback), {
      status: response.status, code: body.code, data: body.data, retryAfterMs: retryAfterMs(response, body)
    });
  }
  if (response.status !== 204 && (!Object.hasOwn(body, "data") || body.data == null)) {
    throw Object.assign(new Error("The server reply was incomplete. Check the existing operation before starting another request."), { code: "INCOMPLETE_REPLY" });
  }
  return body;
}

// Production backoff for transient READ failures, not a sleep/test retry.
// Five scheduled checks, with Retry-After taking priority. No lost-job/auth or
// provider-job failure is retried; completed job errors arrive in HTTP 200.
export function statusRetryDelay(error, failures) {
  if (!(error instanceof TypeError) && !["TimeoutError", "AbortError"].includes(error?.name)
    && error?.code !== "INCOMPLETE_REPLY" && ![429, 502, 503, 504].includes(error?.status)) return null;
  const delays = [2000, 5000, 10000, 20000, 30000];
  if (failures < 1 || failures > delays.length || error?.retryAfterMs > 15 * 60_000) return null;
  return Math.max(delays[failures - 1], error?.retryAfterMs || 0);
}
