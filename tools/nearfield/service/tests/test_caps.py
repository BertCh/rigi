# Rigi
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: Copyright (c) Rigi contributors
"""CR-05 caps and error paths of the near-field service (reports/code-review-2026-09-30.md), fully in-process.

Run (matcher venv, no torch/model is imported or loaded; ~1 s):
    tools/matcher/.venv/bin/python -m unittest discover -s tools/nearfield/service/tests -v
"""
from __future__ import annotations

import http.client
import io
import json
import os
import sys
import tempfile
import threading
import types
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

os.environ.setdefault("NEARFIELD_CACHE_DIR", tempfile.mkdtemp(prefix="nf-test-cache-"))
os.environ["NEARFIELD_NO_GPU_LOCK"] = "1"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from PIL import Image  # noqa: E402

import app  # noqa: E402
from models import ServiceError  # noqa: E402


def png(w=8, h=6, mode="RGB") -> bytes:
    b = io.BytesIO()
    Image.new(mode, (w, h), 128).save(b, "PNG")
    return b.getvalue()


def multipart(parts: list[tuple[str, bytes, str | None]]) -> tuple[str, bytes]:
    bd = "XBOUNDARYX"
    out = b""
    for name, data, fname in parts:
        disp = f'form-data; name="{name}"' + (f'; filename="{fname}"' if fname else "")
        out += f"--{bd}\r\nContent-Disposition: {disp}\r\n\r\n".encode() + data + b"\r\n"
    return f"multipart/form-data; boundary={bd}", out + f"--{bd}--\r\n".encode()


class HelperTests(unittest.TestCase):
    def test_origin_ok_local(self):
        for o in ("http://localhost", "http://localhost:3100", "https://localhost:8443", "http://127.0.0.1:3100",
                  "http://127.0.0.1", "http://[::1]:3100", "http://[::1]"):
            self.assertTrue(app.origin_ok(o), o)

    def test_origin_ok_rejects_lookalikes(self):
        for o in ("http://localhost.evil.com", "http://127.0.0.1.nip.io", "http://evil.com", "null", "", "localhost",
                  "http://localhost@evil.com", "http://evil.com:80@localhost", "http://localhost:80/x:y", "file://localhost",
                  "ftp://localhost", "javascript://localhost", "//localhost", "http://localhost:evil", "http://[::1]x",
                  "http://[::2]:3100", "http://127.0.0.2", "http://0.0.0.0:3100", "http:localhost", "http://notlocalhost"):
            self.assertFalse(app.origin_ok(o), o)

    def test_origin_ok_extra_exact(self):
        old = app.EXTRA_ORIGINS
        app.EXTRA_ORIGINS = {"https://rigi.example"}
        try:
            self.assertTrue(app.origin_ok("https://rigi.example"))
            self.assertFalse(app.origin_ok("https://rigi.example:444"))
            self.assertFalse(app.origin_ok("https://sub.rigi.example"))
            self.assertFalse(app.origin_ok("http://rigi.example"))
        finally:
            app.EXTRA_ORIGINS = old

    def test_host_ok(self):
        for h in ("localhost", "localhost:8767", "127.0.0.1:8767", "[::1]:8767", "[::1]", "LOCALHOST:1"):
            self.assertTrue(app.host_ok(h), h)
        for h in (None, "", "evil.com", "evil.com:8767", "localhost.evil.com:8767", "127.0.0.1.nip.io", "::1", "[::1]:x",
                  "[::1]evil", "localhost:80:80", "localhost:abc", "10.0.0.5:8767"):
            self.assertFalse(app.host_ok(h), h)

    def test_fnum(self):
        self.assertEqual(app.fnum({}, "x", 7), 7)
        self.assertEqual(app.fnum({"x": ""}, "x", 7), 7)
        self.assertEqual(app.fnum({"x": "12.9"}, "x", 0, 1, 20, int), 12)
        self.assertEqual(app.fnum({"x": "1.5"}, "x", 0, 1, 2), 1.5)
        for bad in ("abc", "nan", "inf", "-inf", "1e999", "99", "-1"):
            with self.assertRaises(ServiceError, msg=bad) as c:
                app.fnum({"x": bad}, "x", 0, 0, 10, int)
            self.assertEqual(c.exception.status, 400)

    def test_decode_image(self):
        rgb, _ = app.decode_image(png(100, 50), 40)
        self.assertEqual(rgb.shape, (20, 40, 3))
        self.assertEqual(app.decode_image(png(10, 10), 64)[0].shape, (10, 10, 3))  # never upscales
        self.assertEqual(app.decode_image(png(10, 10, "L"), None)[0].shape, (10, 10, 3))
        for junk in (b"", b"not an image", png()[:20]):
            with self.assertRaises(ServiceError) as c:
                app.decode_image(junk, None)
            self.assertEqual((c.exception.status, c.exception.code), (400, "bad_image"))

    def test_decode_image_pixel_cap(self):
        old = app.MAX_PIXELS
        app.MAX_PIXELS = 100
        try:
            with self.assertRaises(ServiceError) as c:
                app.decode_image(png(11, 10), None)
            self.assertEqual(c.exception.code, "image_too_large")
            app.decode_image(png(10, 10), None)
        finally:
            app.MAX_PIXELS = old

    def test_parse_multipart(self):
        ct, body = multipart([("model", b" da3 ", None), ("image", b"abc", "a.png")])
        fields, files = app.parse_multipart(ct, body)
        self.assertEqual(fields["model"], "da3")
        self.assertEqual(files["image"], [b"abc"])
        with self.assertRaises(ServiceError) as c:
            app.parse_multipart("application/json", b"{}")
        self.assertEqual(c.exception.status, 400)


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
        cls.srv.daemon_threads = True
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.old = (app.MAX_BODY, dict(app.ROUTES), app.MGR, app.health)
        app.ROUTES["/depth"] = lambda fields, files: ("application/json", {"X-Model": "stub"}, b'{"ok":1}')
        app.health = lambda: {"ok": True}

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()
        app.MAX_BODY, routes, app.MGR, app.health = cls.old
        app.ROUTES.clear()
        app.ROUTES.update(routes)

    def req(self, method="GET", path="/health", headers=None, body=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
        h = {"Host": f"127.0.0.1:{self.port}", **(headers or {})}
        for k, v in h.items():
            if v is not None:
                c.putheader(k, v)
        c.endheaders(body)
        r = c.getresponse()
        data = r.read()
        hdrs = {k.lower(): v for k, v in r.getheaders()}
        c.close()
        return r.status, hdrs, data

    def post(self, parts=None, headers=None, path="/depth"):
        ct, body = multipart(parts if parts is not None else [("image", png(), "a.png"), ("nocache", b"1", None)])
        return self.req("POST", path, {"Content-Type": ct, "Content-Length": str(len(body)), **(headers or {})}, body)

    def test_cors_only_for_allowed_origin(self):
        s, h, _ = self.req(headers={"Origin": "http://localhost:3100"})
        self.assertEqual((s, h.get("access-control-allow-origin"), h.get("vary")), (200, "http://localhost:3100", "Origin"))
        s, h, _ = self.req()  # no Origin (curl, same-origin): served, no CORS grant
        self.assertEqual(s, 200)
        self.assertNotIn("access-control-allow-origin", h)

    def test_foreign_origin_forbidden(self):
        for o in ("http://evil.com", "null", "http://localhost.evil.com"):
            s, h, d = self.req(headers={"Origin": o})
            self.assertEqual(s, 403, o)
            self.assertNotIn("access-control-allow-origin", h)
            self.assertEqual(json.loads(d)["error"], "forbidden")
            s, h, _ = self.post(headers={"Origin": o})
            self.assertEqual(s, 403)

    def test_dns_rebinding_host_forbidden(self):
        s, _, _ = self.req(headers={"Host": "evil.com"})
        self.assertEqual(s, 403)
        s, _, _ = self.post(headers={"Host": "rebind.example:8767"})
        self.assertEqual(s, 403)

    def test_options_preflight(self):
        s, h, d = self.req("OPTIONS", "/depth", {"Origin": "http://127.0.0.1:3100", "Access-Control-Request-Method": "POST"})
        self.assertEqual((s, d), (204, b""))
        self.assertEqual(h["access-control-allow-origin"], "http://127.0.0.1:3100")
        self.assertIn("POST", h["access-control-allow-methods"])
        s, h, _ = self.req("OPTIONS", "/depth", {"Origin": "http://evil.com"})
        self.assertEqual(s, 403)
        self.assertNotIn("access-control-allow-origin", h)

    def test_content_length_caps(self):
        ct = {"Content-Type": "multipart/form-data; boundary=x"}
        s, _, d = self.req("POST", "/depth", ct)  # missing
        self.assertEqual((s, json.loads(d)["error"]), (411, "bad_length"))
        s, _, _ = self.req("POST", "/depth", {**ct, "Content-Length": "0"})
        self.assertEqual(s, 411)
        for bad in ("-5", "abc", "1.5", "0x10"):
            s, _, d = self.req("POST", "/depth", {**ct, "Content-Length": bad})
            self.assertEqual((s, json.loads(d)["error"]), (400, "bad_length"), bad)
        old = app.MAX_BODY
        app.MAX_BODY = 1000
        try:
            s, h, d = self.req("POST", "/depth", {**ct, "Content-Length": "1001"}, None)
            self.assertEqual(s, 413)
            self.assertEqual(h.get("connection"), "close")  # unread body must not poison a keep-alive stream
            s, _, _ = self.req("POST", "/depth", {**ct, "Content-Length": "999999999999999999999"})
            self.assertEqual(s, 413)
            s, _, _ = self.post()  # well under the cap
            self.assertEqual(s, 200)
        finally:
            app.MAX_BODY = old

    def test_post_ok_and_cache_headers(self):
        s, h, d = self.post()
        self.assertEqual((s, d, h["x-cache"]), (200, b'{"ok":1}', "miss"))

    def test_unknown_route_and_not_multipart(self):
        self.assertEqual(self.post(path="/nope")[0], 404)
        self.assertEqual(self.req("GET", "/nope")[0], 404)
        body = b'{"a":1}'
        s, _, d = self.req("POST", "/depth", {"Content-Type": "application/json", "Content-Length": str(len(body))}, body)
        self.assertEqual((s, json.loads(d)["error"]), (400, "bad_request"))

    def test_500_does_not_leak(self):
        def boom(fields, files):
            raise RuntimeError("secret /Users/x/weights/model.pt missing")

        app.ROUTES["/depth"] = boom
        try:
            s, _, d = self.post([("image", png(), "a.png"), ("nocache", b"1", None), ("t", b"boom", None)])
        finally:
            app.ROUTES["/depth"] = lambda fields, files: ("application/json", {"X-Model": "stub"}, b'{"ok":1}')
        self.assertEqual(s, 500)
        self.assertNotIn(b"/Users", d)
        self.assertNotIn(b"RuntimeError", d)

    def test_cache_write_failure_is_not_fatal(self):
        real = app.cache.put

        def full(*a, **k):
            raise OSError(28, "No space left on device")

        app.cache.put = full
        try:
            s, _, d = self.post([("image", png(9, 9), "a.png"), ("nocache", b"1", None)])
        finally:
            app.cache.put = real
        self.assertEqual((s, d), (200, b'{"ok":1}'))

    def test_missing_image_and_bad_params(self):
        app.ROUTES["/depth"] = app.ep_depth
        app.MGR = types.SimpleNamespace(lock=threading.RLock())
        try:
            s, _, d = self.post([("model", b"moge2", None)])
            self.assertEqual((s, json.loads(d)["error"]), (400, "bad_request"))
            s, _, d = self.post([("image", b"garbage", "a.png"), ("nocache", b"1", None)])
            self.assertEqual((s, json.loads(d)["error"]), (400, "bad_image"))
            s, _, d = self.post([("image", png(), "a.png"), ("model", b"x", None), ("nocache", b"1", None)])
            self.assertEqual((s, json.loads(d)["error"]), (400, "bad_model"))
            s, _, d = self.post([("image", png(), "a.png"), ("maxSide", b"nan", None), ("nocache", b"1", None)])
            self.assertEqual((s, json.loads(d)["error"]), (400, "bad_param"))
            got = []  # the inference lock is released after every error above
            th = threading.Thread(target=lambda: got.append(app.MGR.lock.acquire(timeout=2)))
            th.start()
            th.join()
            self.assertEqual(got, [True])
        finally:
            app.ROUTES["/depth"] = lambda fields, files: ("application/json", {"X-Model": "stub"}, b'{"ok":1}')


if __name__ == "__main__":
    unittest.main()
