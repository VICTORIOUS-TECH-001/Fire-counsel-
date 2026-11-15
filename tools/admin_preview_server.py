"""Safe local-only admin preview with the dev server's /api proxy."""
from http.server import ThreadingHTTPServer

from dev_server import FireCounselDevHandler


class AdminPreviewHandler(FireCounselDevHandler):
    def do_GET(self):
        if self.path == "/":
            self.send_response(302)
            self.send_header("Location", "/admin.html")
            self.end_headers()
            return
        super().do_GET()


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", 8093), AdminPreviewHandler)
    print("FIRE COUNSEL admin preview on port 8093; /api/* proxies to 127.0.0.1:4000")
    server.serve_forever()
