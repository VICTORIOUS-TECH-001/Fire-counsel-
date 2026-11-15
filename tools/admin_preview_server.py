"""Local-only helper: serve this project and open the admin preview at /."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class AdminPreviewHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/":
            self.send_response(302)
            self.send_header("Location", "/admin.html")
            self.end_headers()
            return
        super().do_GET()


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", 8093), AdminPreviewHandler)
    print("FIRE COUNSEL admin preview on port 8093 (local preview only)")
    server.serve_forever()
