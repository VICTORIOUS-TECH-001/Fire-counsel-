"""Development-only static server with a same-origin, loopback-only API proxy.

Run `npm --prefix backend start` separately, then `python3 tools/dev_server.py`.
Never use Python's unrestricted directory server for this credential-bearing repo.
"""
import argparse
import json
import re
from http.client import HTTPConnection, HTTPException
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
# AI uploads (photos/PDFs as base64) can be up to about 26 MB.
MAX_PROXY_BODY = 26 * 1024 * 1024
PUBLIC_FILES = {
    "index.html", "study.html", "admin.html", "auth.html", "ai.html", "student.html",
    "site.css", "home-hero.css", "home-learning.css", "home-ai.css", "home-case-video.css", "home-ending.css", "home-ending.mjs", "styles.css", "admin.css", "auth.css", "integrations.css", "branding.css",
    "site.js", "home-hero.mjs", "home-learning-video.mjs", "home-ai.mjs", "home-ai-access.mjs", "homepage-copy.mjs", "homepage-media.mjs", "home-case-video.mjs", "admin-homepage.mjs", "app.js", "admin.js", "sw.js", "manifest.webmanifest",
    "auth-page.mjs", "admin-auth.mjs", "admin-database.mjs",
    "study-materials.mjs", "research-search.mjs", "request-scope.mjs",
    "student-profile.mjs", "student-page.mjs", "student-page-view.mjs", "installation.mjs",
    "auth-gate.mjs",
    "ai-studio.css", "ai-page.css", "ai-studio.mjs", "ai-markdown.mjs", "admin-ai.mjs", "admin-courses.mjs", "presence.mjs",
    "admin-site.mjs", "admin-uploads.mjs", "admin-workstation.mjs", "admin-workstation.css", "admin-network.mjs", "pdf-reader.mjs",
    "preloader.css", "preloader.js", "workspace.css", "workspace.mjs", "workspace-config.mjs", "admin-workspace.mjs",
    "data/site-content.json",
    "firebase/client.mjs", "firebase/auth-client.mjs", "firebase/auth-errors.mjs",
    "firebase/firestore-client.mjs", "firebase/content-schema.mjs",
    "firebase/firebase-config.mjs", "firebase/firebase-config.example.mjs",
}


PDFJS_ROOT = ROOT / "backend" / "node_modules" / "pdfjs-dist"
PDFJS_FILES = {
    "build": re.compile(r"^pdf(?:\.worker)?\.min\.mjs$"),
    "standard_fonts": re.compile(r"^[A-Za-z0-9_-]+\.(?:pfb|ttf)$"),
    "cmaps": re.compile(r"^[A-Za-z0-9_-]+\.bcmap$"),
    "iccs": re.compile(r"^[A-Za-z0-9_-]+\.icc$"),
    "wasm": re.compile(r"^[A-Za-z0-9_-]+\.(?:wasm|js)$"),
}
PDFJS_TYPES = {".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm"}


def pdfjs_file(url_path):
    """Mirror of backend/src/website.js resolvePdfjsFile: /vendor/pdfjs/<folder>/<file>."""
    match = re.match(r"^/vendor/pdfjs/([a-z_]+)/([^/]+)$", url_path)
    if not match or match.group(1) not in PDFJS_FILES or not PDFJS_FILES[match.group(1)].match(match.group(2)):
        return None
    folder = "legacy/build" if match.group(1) == "build" else match.group(1)
    target = PDFJS_ROOT / folder / match.group(2)
    return target if target.is_file() else None


class FireCounselDevHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def list_directory(self, path):
        self.send_error(404)
        return None

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        super().end_headers()

    def send_head(self):
        vendor = pdfjs_file(urlsplit(self.path).path)
        if vendor is not None:
            data = vendor.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", PDFJS_TYPES.get(vendor.suffix, "application/octet-stream"))
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            from io import BytesIO
            return BytesIO(data)
        target = Path(self.translate_path(self.path)).resolve()
        try:
            relative = target.relative_to(ROOT)
        except ValueError:
            self.send_error(404)
            return None
        parts = relative.parts
        path = relative.as_posix()
        is_asset = (
            len(parts) > 1 and parts[0] == "assets"
            and target.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".svg", ".ico"}
        )
        if any(part.startswith(".") for part in parts) or not (
            relative == Path(".") or path in PUBLIC_FILES or is_asset
        ):
            self.send_error(404)
            return None
        return super().send_head()

    def _json_error(self, status, message, code):
        payload = json.dumps({"error": message, "code": code}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    def _proxy_api(self):
        if not urlsplit(self.path).path.startswith("/api/"):
            self.send_error(404)
            return
        # HTTPConnection does not decode chunked input for this handler. Reject
        # ambiguous framing instead of silently forwarding an incomplete body.
        lengths = self.headers.get_all("Content-Length", [])
        if self.headers.get("Transfer-Encoding") or len(lengths) > 1:
            self._json_error(400, "Unsupported or ambiguous request framing.", "INVALID_BODY")
            return
        try:
            length = int(lengths[0]) if lengths else 0
            if length < 0:
                raise ValueError
        except ValueError:
            self._json_error(400, "Invalid Content-Length.", "INVALID_BODY")
            return
        if length > MAX_PROXY_BODY:
            self._json_error(413, "Request body too large.", "BODY_TOO_LARGE")
            return
        body = self.rfile.read(length) if length else None
        headers = {}
        for name in ("Authorization", "Content-Type", "Accept", "X-Fire-Counsel-Installation"):
            value = self.headers.get(name)
            if value:
                headers[name] = value
        # Replace, never forward, a browser-supplied X-Forwarded-For value. This
        # address may still be the Arena gateway, not the browser's public IP.
        headers["X-Forwarded-For"] = self.client_address[0]
        connection = HTTPConnection("127.0.0.1", self.server.api_port, timeout=35)
        try:
            # Origin/Host/cookies are not forwarded. Firebase token verification
            # and administrator authorization still happen on the backend.
            connection.request(self.command, self.path, body=body, headers=headers)
            upstream = connection.getresponse()
            payload = upstream.read()
            self.send_response(upstream.status)
            for name in ("Content-Type", "Retry-After"):
                value = upstream.getheader(name)
                if value:
                    self.send_header(name, value)
            self.send_header("Content-Length", (upstream.getheader("Content-Length") or "0") if self.command == "HEAD" else str(len(payload)))
            self.end_headers()
            if payload and self.command != "HEAD":
                self.wfile.write(payload)
        except (OSError, HTTPException):
            self._json_error(502, "Local API is not available. Start the backend and check the proxy API port.", "API_UNAVAILABLE")
        finally:
            connection.close()

    def do_GET(self):
        if urlsplit(self.path).path.startswith("/api/"):
            return self._proxy_api()
        return super().do_GET()

    def do_HEAD(self):
        if urlsplit(self.path).path.startswith("/api/"):
            return self._proxy_api()
        return super().do_HEAD()

    do_POST = _proxy_api
    do_PUT = _proxy_api
    do_PATCH = _proxy_api
    do_DELETE = _proxy_api
    do_OPTIONS = _proxy_api


def create_server(port=8080, api_port=4000, handler=FireCounselDevHandler):
    server = ThreadingHTTPServer(("0.0.0.0", port), handler)
    server.api_port = api_port
    return server


def run(handler=FireCounselDevHandler, default_port=8080):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=default_port)
    parser.add_argument("--api-port", type=int, default=4000)
    args = parser.parse_args()
    with create_server(args.port, args.api_port, handler) as server:
        print(f"FIRE COUNSEL preview on port {server.server_port}; /api/* proxies to loopback:{args.api_port}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    run()
