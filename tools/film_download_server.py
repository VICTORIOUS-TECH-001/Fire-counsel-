#!/usr/bin/env python3
"""Tiny, attachment-only download page for the generated brand film."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
FILES = {
    "/Fire-Counsel-brand-film-download.zip": (ROOT / "Fire-Counsel-brand-film-download.zip", "application/zip"),
    "/Fire-Counsel-brand-film.mp4": (ROOT / "Fire-Counsel-brand-film.mp4", "video/mp4"),
}
PAGE = '''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Download the Fire Counsel film</title><style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#08090e;color:#f8f4ed;font:16px system-ui,sans-serif}.card{width:min(92vw,600px);padding:34px;border:1px solid #42352f;border-radius:24px;background:linear-gradient(145deg,#17161c,#0d0e14);box-shadow:0 22px 80px #0008}h1{margin:0 0 10px;font-size:clamp(27px,6vw,40px)}p{color:#b8b2ad;line-height:1.55}.tag{color:#ffab62;font-size:12px;font-weight:700;letter-spacing:.16em}.btn{display:block;margin-top:14px;padding:16px 18px;border-radius:13px;background:#e65c22;color:white;text-decoration:none;font-weight:700;text-align:center}.btn.secondary{background:#29252a;border:1px solid #64524a}.small{font-size:13px;color:#8d8989}
</style><main class="card"><div class="tag">FIRE COUNSEL · BRAND FILM</div><h1>Your film is ready.</h1><p>Choose a download. The ZIP contains the MP4 video.</p><a class="btn" href="/Fire-Counsel-brand-film-download.zip">Download ZIP · 5.6 MB</a><a class="btn secondary" href="/Fire-Counsel-brand-film.mp4">Download MP4 · 5.4 MB</a><p class="small">If a tap opens a preview instead, press and hold the button and choose Download link.</p></main></html>'''.encode("utf-8")

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = urlparse(self.path).path
        if path in ("/", "/index.html"):
            body = PAGE
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        if path not in FILES:
            self.send_error(404)
            return
        file_path, content_type = FILES[path]
        if not file_path.is_file():
            self.send_error(404, "Film file is not present")
            return
        size = file_path.stat().st_size
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(size))
        self.send_header("Content-Disposition", f'attachment; filename="{file_path.name}"')
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        with file_path.open("rb") as stream:
            while chunk := stream.read(1024 * 1024):
                self.wfile.write(chunk)

    def log_message(self, fmt, *args):
        print(f"film-download: {self.address_string()} {fmt % args}", flush=True)

if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", 8765), Handler)
    print("Fire Counsel download page listening on 0.0.0.0:8765", flush=True)
    server.serve_forever()
