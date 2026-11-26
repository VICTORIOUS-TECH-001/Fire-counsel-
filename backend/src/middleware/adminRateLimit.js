import { rateLimit } from "express-rate-limit";

export const isAdminApi = req => /^\/api\/v1\/admin(?:\/|$)/i.test(req.path);
export const isReadRequest = req => req.method === "GET" || req.method === "HEAD";
const authorizedRequest = Symbol("admin-authorized-request");

// Always return JSON and Retry-After. An API throttle is NOT provider quota.
export function rateLimitReply(code, message) {
  return (req, res) => {
    const retry = Math.max(1, Math.ceil(((req.rateLimit?.resetTime?.getTime() || Date.now() + 60_000) - Date.now()) / 1000));
    res.set("Cache-Control", "no-store");
    res.set("Retry-After", String(retry));
    return res.status(429).json({ error: message, code, retry_after_seconds: retry });
  };
}

// This is an IP abuse guard BEFORE authentication, not the admin's usage
// allowance. Failed/unknown/denied requests count; authenticated requests that
// pass authorization are instead bounded by the UID gates below. A forged
// Authorization/UID/body/header cannot make an anonymous request successful.
export function createAdminAbuseGate({ limit = 300, windowMs = 15 * 60_000 } = {}) {
  return rateLimit({
    windowMs, limit, skip: req => !isAdminApi(req),
    standardHeaders: "draft-8", legacyHeaders: false, identifier: "admin-auth",
    skipSuccessfulRequests: true,
    requestWasSuccessful: req => req[authorizedRequest] === true,
    validate: { xForwardedForHeader: false },
    handler: rateLimitReply("ADMIN_AUTH_RATE_LIMIT", "Too many unverified or denied administrator requests from this connection. Wait for Retry-After, then sign in again.")
  });
}

// Mount only AFTER verified Firebase identity and the administrator gate.
// Share one instance across routers: no path switching to reset an allowance.
// Reads cannot consume the mutation allowance; one account/IP cannot consume
// another administrator's allowance. Google/admin authorization is unchanged.
export function createAdminRequestGate({ readLimit = 3600, writeLimit = 300, windowMs = 15 * 60_000 } = {}) {
  const base = { windowMs, standardHeaders: "draft-8", legacyHeaders: false,
    keyGenerator: req => `uid:${req.user.uid}` };
  const read = rateLimit({ ...base, limit: readLimit, identifier: "admin-reads",
    handler: rateLimitReply("ADMIN_READ_RATE_LIMIT", "Administrator status requests are temporarily limited. The existing document job may still be running; wait for Retry-After instead of uploading it again.") });
  const write = rateLimit({ ...base, limit: writeLimit, identifier: "admin-writes",
    handler: rateLimitReply("ADMIN_WRITE_RATE_LIMIT", "Administrator changes are temporarily limited. Wait for Retry-After and check existing uploads before submitting another copy.") });
  return (req, res, next) => {
    if (typeof req.user?.uid !== "string" || !req.user.uid) return res.status(401).json({ error: "Verified administrator identity is required.", code: "AUTH_REQUIRED" });
    // Set only at this post-authorization boundary, including UID-limited
    // replies. Such replies must not consume the shared failed-auth IP budget.
    req[authorizedRequest] = true;
    return (isReadRequest(req) ? read : write)(req, res, next);
  };
}

export function createAdminProviderTestGate() {
  return rateLimit({ windowMs: 15 * 60_000, limit: 6,
    keyGenerator: req => `uid:${req.user.uid}`, identifier: "admin-provider-tests",
    standardHeaders: "draft-8", legacyHeaders: false,
    handler: rateLimitReply("ADMIN_TEST_RATE_LIMIT", "Six explicit admin-provider tests are allowed per 15 minutes. Wait for Retry-After; document jobs use their own allowance.") });
}
