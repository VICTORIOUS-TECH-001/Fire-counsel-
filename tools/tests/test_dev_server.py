"""Synthetic HTTP checks; never read credentials or contact a live provider."""
import json
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
from threading import Thread
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dev_server import FireCounselDevHandler, MAX_PROXY_BODY, create_server
from admin_preview_server import AdminPreviewHandler


class Upstream(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def respond(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length).decode() if length else ""
        payload = json.dumps({
            "method": self.command, "path": self.path, "body": body,
            "authorization": self.headers.get("Authorization"),
            "origin": self.headers.get("Origin"), "cookie": self.headers.get("Cookie"),
            "host": self.headers.get("Host"),
            "installation": self.headers.get("X-Fire-Counsel-Installation"),
            "forwarded": self.headers.get("X-Forwarded-For"),
        }).encode()
        self.send_response(401 if self.path == "/api/protected" else 200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    do_GET = do_HEAD = do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = respond


class QuietMain(FireCounselDevHandler):
    def log_message(self, *_args):
        pass


class QuietAdmin(AdminPreviewHandler):
    def log_message(self, *_args):
        pass


class PreviewTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        cls.main = create_server(0, cls.upstream.server_port, QuietMain)
        cls.admin = create_server(0, cls.upstream.server_port, QuietAdmin)
        # A reserved-then-closed port gives a deterministic unavailable upstream.
        unused = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        closed_port = unused.server_port
        unused.server_close()
        cls.offline = create_server(0, closed_port, QuietMain)
        cls.servers = [cls.upstream, cls.main, cls.admin, cls.offline]
        for server in cls.servers:
            Thread(target=server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        for server in cls.servers:
            server.shutdown()
            server.server_close()

    def request(self, path, method="GET", body=None, headers=None, server=None):
        connection = HTTPConnection("127.0.0.1", (server or self.main).server_port, timeout=5)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_homepage_and_all_integration_assets_are_served(self):
        for path in ["/", "/home-hero.css", "/home-learning.css", "/home-ai.css", "/home-ai.mjs", "/home-ai-access.mjs", "/home-hero.mjs", "/homepage-copy.mjs", "/admin-homepage.mjs", "/study.html", "/admin.html", "/auth.html", "/student.html", "/integrations.css", "/branding.css", "/request-scope.mjs", "/student-profile.mjs", "/student-page.mjs", "/student-page-view.mjs", "/installation.mjs", "/auth-gate.mjs", "/admin-database.mjs", "/admin-network.mjs", "/firebase/auth-client.mjs", "/firebase/auth-errors.mjs", "/firebase/client.mjs", "/firebase/firestore-client.mjs", "/firebase/content-schema.mjs", "/firebase/firebase-config.mjs"]:
            with self.subTest(path=path):
                status, headers, body = self.request(path)
                self.assertEqual(status, 200)
                self.assertTrue(body)
                self.assertEqual(headers["Cache-Control"], "no-store")
                self.assertEqual(headers["X-Content-Type-Options"], "nosniff")

    def test_backend_git_tools_rules_test_files_and_package_metadata_are_private(self):
        for server in [self.main, self.admin]:
            for path in ["/.git/HEAD", "/%2egit/HEAD", "/backend/package.json", "/backend/.env", "/backend/%2eenv", "/tools/dev_server.py", "/firebase/firestore.rules", "/firebase/package.json", "/firebase/tests/security.rules.test.mjs", "/package.json", "/package-lock.json", "/tests/frontend/page-wiring.test.mjs", "/README.md"]:
                with self.subTest(server=server.server_port, path=path):
                    self.assertEqual(self.request(path, server=server)[0], 404)

    def test_directory_listings_are_not_available(self):
        for path in ["/assets/", "/data/", "/firebase/", "/backend/"]:
            with self.subTest(path=path):
                self.assertEqual(self.request(path)[0], 404)

    def test_head_serves_static_headers_without_a_body(self):
        status, headers, body = self.request("/study.html", method="HEAD")
        self.assertEqual(status, 200)
        self.assertGreater(int(headers["Content-Length"]), 0)
        self.assertEqual(body, b"")

    def test_proxy_preserves_auth_body_method_query_and_upstream_status(self):
        for method in ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]:
            with self.subTest(method=method):
                status, headers, body = self.request("/api/echo?q=synthetic", method=method, body='{"test":true}', headers={"Content-Type": "application/json", "Authorization": "Bearer synthetic-token"})
                data = json.loads(body)
                self.assertEqual(status, 200)
                self.assertEqual(data["authorization"], "Bearer synthetic-token")
                self.assertEqual(data["method"], method)
                self.assertEqual(data["path"], "/api/echo?q=synthetic")
                self.assertEqual(data["body"], '{"test":true}')
                self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(self.request("/api/protected")[0], 401)

    def test_browser_origin_host_and_cookies_are_not_forwarded(self):
        status, _, body = self.request("/api/echo", headers={"Origin": "https://8080-sandbox.e2b.app", "Host": "8080-sandbox.e2b.app", "Cookie": "never-forward=this"})
        data = json.loads(body)
        self.assertEqual(status, 200)
        self.assertIsNone(data["origin"])
        self.assertIsNone(data["cookie"])
        self.assertEqual(data["host"], f"127.0.0.1:{self.upstream.server_port}")

    def test_proxy_preserves_installation_but_replaces_client_asserted_ip(self):
        status, _, body = self.request("/api/v1/profile", headers={
            "X-Fire-Counsel-Installation": "a" * 43,
            "X-Forwarded-For": "203.0.113.99", "X-Real-IP": "203.0.113.88",
        })
        data = json.loads(body)
        self.assertEqual(status, 200)
        self.assertEqual(data["installation"], "a" * 43)
        self.assertEqual(data["forwarded"], "127.0.0.1")

    def test_head_api_requests_are_proxied_without_a_body(self):
        status, headers, body = self.request("/api/echo", method="HEAD")
        self.assertEqual(status, 200)
        self.assertGreater(int(headers["Content-Length"]), 0)
        self.assertEqual(body, b"")

    def test_offline_api_returns_safe_json_not_a_directory_or_traceback(self):
        status, headers, body = self.request("/api/health", server=self.offline)
        self.assertEqual(status, 502)
        self.assertEqual(json.loads(body)["code"], "API_UNAVAILABLE")
        self.assertEqual(headers["Content-Type"], "application/json; charset=utf-8")

    def test_proxy_rejects_oversized_and_invalid_content_lengths(self):
        for length, expected in [(str(MAX_PROXY_BODY + 1), 413), ("-1", 400), ("not-a-number", 400)]:
            with self.subTest(length=length):
                self.assertEqual(self.request("/api/echo", method="POST", headers={"Content-Length": length})[0], expected)

    def test_proxy_rejects_duplicate_content_length(self):
        connection = HTTPConnection("127.0.0.1", self.main.server_port, timeout=5)
        try:
            connection.putrequest("POST", "/api/echo")
            connection.putheader("Content-Length", "0")
            connection.putheader("Content-Length", "1")
            connection.endheaders()
            response = connection.getresponse()
            self.assertEqual(response.status, 400)
            response.read()
        finally:
            connection.close()

    def test_proxy_rejects_unsupported_chunked_bodies(self):
        self.assertEqual(self.request("/api/echo", method="POST", headers={"Transfer-Encoding": "chunked"})[0], 400)

    def test_proxy_does_not_accept_mutations_to_static_files(self):
        for method in ["POST", "PUT", "PATCH", "DELETE"]:
            with self.subTest(method=method):
                self.assertEqual(self.request("/data/site-content.json", method=method)[0], 404)

    def test_admin_preview_redirects_root_but_uses_the_same_protected_static_server(self):
        for method in ["GET", "HEAD"]:
            status, headers, _ = self.request("/", method=method, server=self.admin)
            self.assertEqual(status, 302)
            self.assertEqual(headers["Location"], "/admin.html")
        self.assertEqual(self.request("/api/echo", server=self.admin)[0], 200)


if __name__ == "__main__":
    unittest.main()
