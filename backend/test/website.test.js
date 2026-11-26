import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../src/app.js";
import { resolvePdfjsFile, resolvePublicFile } from "../src/website.js";

async function serve(t, env) {
  const server = createApp({ env }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test("website is not served unless SERVE_WEBSITE=true", async t => {
  const base = await serve(t, {});
  const response = await fetch(`${base}/`);
  assert.equal(response.status, 404);
  assert.match(response.headers.get("content-type"), /json/);
});

test("website serves allowlisted pages, scripts and assets with popup-safe headers", async t => {
  const base = await serve(t, { SERVE_WEBSITE: "true" });
  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  assert.match(home.headers.get("content-type"), /text\/html/);
  assert.match(await home.text(), /FIRE COUNSEL/i);
  assert.equal(home.headers.get("cross-origin-opener-policy"), "same-origin-allow-popups");
  assert.equal(home.headers.get("cache-control"), "no-cache");

  for (const [path, type] of [["/home-hero.css", /css/], ["/home-learning.css", /css/], ["/home-hero.mjs", /javascript/], ["/homepage-copy.mjs", /javascript/], ["/admin-homepage.mjs", /javascript/], ["/branding.css", /css/], ["/study.html", /html/], ["/auth-page.mjs", /javascript/], ["/firebase/client.mjs", /javascript/], ["/data/site-content.json", /json/], ["/assets/fire-counsel-192.png", /png/], ["/sw.js", /javascript/]]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("content-type"), type, path);
  }
});

test("website never exposes backend, secrets, git metadata, packages or traversal paths", async t => {
  const base = await serve(t, { SERVE_WEBSITE: "true" });
  for (const path of ["/backend/src/app.js", "/backend/.env", "/.env", "/.git/config", "/package.json", "/backend/package.json", "/render.yaml", "/firebase/firestore.rules", "/tools/dev_server.py", "/assets/images/README.md", "/%2e%2e/etc/passwd", "/assets/../backend/.env.example", "/tests/browser/app.spec.mjs"]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 404, path);
  }
  assert.equal(resolvePublicFile("/..%2fbackend/.env"), null);
  assert.equal(resolvePublicFile("/%E0%A4%A"), null);
});

test("website mode keeps API routes, strict API headers and CORS for the service's own origin", async t => {
  const origin = "https://fire-counsel.example.onrender.com";
  const base = await serve(t, { SERVE_WEBSITE: "true", RENDER_EXTERNAL_URL: `${origin}/` });
  const health = await fetch(`${base}/api/health`, { headers: { Origin: origin } });
  assert.equal(health.status, 503);
  assert.equal((await health.json()).database, "not_configured");
  assert.equal(health.headers.get("access-control-allow-origin"), origin);
  assert.equal(health.headers.get("cache-control"), "no-store");
  assert.equal(health.headers.get("cross-origin-opener-policy"), "same-origin");

  const foreign = await fetch(`${base}/api/health`, { headers: { Origin: "https://evil.example" } });
  assert.equal(foreign.status, 403);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test("website redirects friendly sign-in addresses to the sign-in page", async t => {
  const base = await serve(t, { SERVE_WEBSITE: "true" });
  for (const path of ["/login", "/login/", "/signin", "/sign-in", "/sign-in/"]) {
    const response = await fetch(`${base}${path}`, { redirect: "manual" });
    assert.equal(response.status, 301, path);
    assert.equal(response.headers.get("location"), "/auth.html", path);
  }
});

test("the PDF reader engine is served from pdfjs-dist with a strict allowlist", async t => {
  const base = await serve(t, { SERVE_WEBSITE: "true" });
  for (const [path, type] of [["/vendor/pdfjs/build/pdf.min.mjs", /javascript/], ["/vendor/pdfjs/build/pdf.worker.min.mjs", /javascript/], ["/vendor/pdfjs/wasm/jbig2.wasm", /wasm/], ["/pdf-reader.mjs", /javascript/], ["/admin-site.mjs", /javascript/], ["/admin-uploads.mjs", /javascript/], ["/admin-courses.mjs", /javascript/]]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("content-type"), type, path);
  }
  for (const path of ["/vendor/pdfjs/package.json", "/vendor/pdfjs/build/pdf.mjs.map", "/vendor/pdfjs/build/../package.json", "/vendor/pdfjs/web/viewer.html", "/vendor/pdfjs/cmaps/..%2f..%2fpackage.json"]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 404, path);
  }
  assert.equal(resolvePdfjsFile("/vendor/pdfjs/build/pdf.min.mjs"), "legacy/build/pdf.min.mjs");
  assert.equal(resolvePdfjsFile("/vendor/pdfjs/cmaps/78-H.bcmap"), "cmaps/78-H.bcmap");
  assert.equal(resolvePdfjsFile("/vendor/pdfjs/cmaps/../x.bcmap"), null);
});
