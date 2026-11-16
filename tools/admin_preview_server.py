"""Development-only admin-first preview, using the same restricted API proxy."""
from urllib.parse import urlsplit
from dev_server import FireCounselDevHandler, run


class AdminPreviewHandler(FireCounselDevHandler):
    def _redirect_admin(self):
        if urlsplit(self.path).path != "/":
            return False
        self.send_response(302)
        self.send_header("Location", "/admin.html")
        self.send_header("Content-Length", "0")
        self.end_headers()
        return True

    def do_GET(self):
        if not self._redirect_admin():
            super().do_GET()

    def do_HEAD(self):
        if not self._redirect_admin():
            super().do_HEAD()


if __name__ == "__main__":
    run(AdminPreviewHandler, default_port=8093)
