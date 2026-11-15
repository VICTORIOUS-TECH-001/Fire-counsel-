"""Serve FIRE COUNSEL locally and proxy same-origin /api/* requests to Node.

Run the backend separately with `cd backend && npm run dev`, then launch this
from the repository root. Browser modules use relative /api URLs only.
"""
from http.client import HTTPConnection
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
API_HOST = "127.0.0.1"
API_PORT = 4000
MAX_PROXY_BODY = 2 * 1024 * 1024


class FireCounselDevHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def list_directory(self, path):
        self.send_error(404)
        return None

    def send_head(self):
        target = Path(self.translate_path(self.path)).resolve()
        try:
            relative = target.relative_to(ROOT)
        except ValueError:
            self.send_error(404)
            return None
        parts = relative.parts
        blocked = (
            any(part.startswith(".") for part in parts)
            or bool(parts and parts[0] in {"backend", "tools"})
            or any(part in {"node_modules", "__pycache__", ".venv"} for part in parts)
            or (parts and parts[0] == "firebase" and not (
                len(parts) == 2 and parts[1] in {
                    "client.mjs", "auth-client.mjs", "firebase-config.local.mjs", "firebase-config.example.mjs"
                }
            ))
        )
        if blocked:
            self.send_error(404)
            return None
        return super().send_head()

    def _proxy_api(self):
        if not self.path.startswith("/api/"):
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0") or 0)
        except ValueError:
            self.send_error(400, "Invalid Content-Length")
            return
        if length < 0:
            self.send_error(400, "Invalid Content-Length")
            return
        if length > MAX_PROXY_BODY:
            self.send_error(413, "Request body too large")
            return
        body = self.rfile.read(length) if length else None
        headers = {}
        for name in ("Authorization", "Content-Type", "Accept"):
            value = self.headers.get(name)
            if value:
                headers[name] = value
        connection = HTTPConnection(API_HOST, API_PORT, timeout=35)
        try:
            # The browser uses this server as its same-origin API proxy. Strip
            # Origin/Host; the backend still verifies Firebase tokens and admin claims.
            connection.request(self.command, self.path, body=body, headers=headers)
            upstream = connection.getresponse()
            payload = upstream.read()
            self.send_response(upstream.status)
            for name in ("Content-Type", "Retry-After"):
                value = upstream.getheader(name)
                if value:
                    self.send_header(name, value)
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if payload:
                self.wfile.write(payload)
        except OSError:
            message = b'{"error":"Local API is not running on port 4000.","code":"API_UNAVAILABLE"}'
            self.send_response(502)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(message)))
            self.end_headers()
            self.wfile.write(message)
        finally:
            connection.close()

    def do_GET(self):
        if self.path.startswith("/api/"):
            return self._proxy_api()
        return super().do_GET()

    def do_POST(self):
        return self._proxy_api()

    def do_PATCH(self):
        return self._proxy_api()

    def do_DELETE(self):
        return self._proxy_api()


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", 8080), FireCounselDevHandler)
    print("FIRE COUNSEL local preview on port 8080; /api/* proxies to 127.0.0.1:4000")
    server.serve_forever()
