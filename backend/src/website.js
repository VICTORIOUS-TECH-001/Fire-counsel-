import path from "node:path";
import { fileURLToPath } from "node:url";
import helmet from "helmet";

// Repository root (backend/src -> backend -> repo). The website files live there.
export const DEFAULT_WEBSITE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Same explicit allowlist as tools/dev_server.py. Backend code, .env files, Git
// metadata, package files, tests and rules are never served.
export const PUBLIC_FILES = new Set([
  "index.html", "study.html", "admin.html", "auth.html",
  "site.css", "styles.css", "admin.css", "auth.css", "integrations.css",
  "site.js", "app.js", "admin.js", "sw.js", "manifest.webmanifest",
  "auth-page.mjs", "admin-auth.mjs", "admin-database.mjs",
  "study-materials.mjs", "research-search.mjs", "request-scope.mjs",
  "student-profile.mjs", "installation.mjs",
  "ai-studio.css", "ai-studio.mjs", "ai-markdown.mjs", "admin-ai.mjs", "presence.mjs",
  "admin-site.mjs", "admin-uploads.mjs",
  "data/site-content.json",
  "firebase/client.mjs", "firebase/auth-client.mjs",
  "firebase/firebase-config.mjs", "firebase/firebase-config.example.mjs"
]);
// Friendly sign-in addresses (mirrors the Netlify _redirects file).
export const REDIRECTS = new Map(["/login", "/login/", "/signin", "/sign-in", "/sign-in/"].map((from) => [from, "/auth.html"]));
const ASSET_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".svg", ".ico"]);

export function resolvePublicFile(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const relative = path.posix.normalize(decoded).replace(/^\/+/, "");
  if (relative === "" || relative === ".") return "index.html";
  const parts = relative.split("/");
  if (parts.some((part) => part === ".." || part.startsWith("."))) return null;
  if (PUBLIC_FILES.has(relative)) return relative;
  if (parts.length > 1 && parts[0] === "assets" && ASSET_EXTENSIONS.has(path.posix.extname(relative).toLowerCase())) {
    return relative;
  }
  return null;
}

// Website pages need Firebase sign-in popups (Google) and the gstatic SDK, so
// they use relaxed opener/CSP headers. API routes keep the strict defaults.
const websiteHeaders = helmet({
  contentSecurityPolicy: false,
  crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
  crossOriginResourcePolicy: { policy: "same-origin" },
  referrerPolicy: { policy: "same-origin" }
});

export function createWebsiteHandler({ root = DEFAULT_WEBSITE_ROOT } = {}) {
  return function serveWebsite(req, res, next) {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (req.path === "/api" || req.path.startsWith("/api/") || req.path === "/healthz") return next();
    const redirect = REDIRECTS.get(req.path);
    if (redirect) return res.redirect(301, redirect);
    const file = resolvePublicFile(req.path);
    if (!file) return next();
    websiteHeaders(req, res, () => {
      // Always revalidate so a new deploy is picked up; the service worker
      // handles offline caching of the study shell.
      res.set("Cache-Control", "no-cache");
      if (file === "sw.js") res.set("Service-Worker-Allowed", "/");
      res.sendFile(file, { root, dotfiles: "deny" }, (error) => {
        if (error && !res.headersSent) next();
      });
    });
  };
}
