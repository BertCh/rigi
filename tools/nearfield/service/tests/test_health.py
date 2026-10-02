# Rigi
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: Copyright (c) Rigi contributors
"""/health honesty and cache versioning of the near-field service, fully in-process (no torch/model import).

Run (matcher venv; ~1 s):
    tools/matcher/.venv/bin/python -m unittest discover -s tools/nearfield/service/tests -v
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

os.environ.setdefault("NEARFIELD_CACHE_DIR", tempfile.mkdtemp(prefix="nf-test-cache-"))
os.environ["NEARFIELD_NO_GPU_LOCK"] = "1"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import _env  # noqa: E402
import app  # noqa: E402
import cache  # noqa: E402
import models  # noqa: E402


class HealthTest(unittest.TestCase):
    def setUp(self):
        import types

        self._mgr = app.MGR
        app.MGR = types.SimpleNamespace(dev="cpu", key=None, gpu=types.SimpleNamespace(held=False))

    def tearDown(self):
        app.MGR = self._mgr

    def test_reports_version(self):
        h = app.health()
        self.assertTrue(h["ok"])
        self.assertEqual(h["version"], _env.SERVICE_VERSION)

    def test_missing_weights_reported_with_reason(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(_env, "X2_WEIGHTS", Path(d)):
            ok, why = models.moge_status("moge2")
            self.assertFalse(ok)
            self.assertIn("weights not found", why)
            h = app.health()
        self.assertNotIn("moge2", h["models"])
        self.assertNotIn("lift", h["models"])
        self.assertNotIn("da3", h["models"])
        self.assertFalse(h["depth"]["moge2"]["available"])
        self.assertTrue(h["depth"]["moge2"]["reason"])

    def test_available_when_weights_and_packages_found(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(_env, "X2_WEIGHTS", Path(d)):
            w = Path(d) / models.MOGE["moge2"] / "model.pt"
            w.parent.mkdir(parents=True)
            w.write_bytes(b"x")
            with mock.patch.object(models, "_spec", return_value=True):
                self.assertEqual(models.moge_status("moge2"), (True, "ok"))
                h = app.health()
        self.assertIn("moge2", h["models"])
        self.assertIn("lift", h["models"])
        self.assertNotIn("moge2b", h["models"])

    def test_missing_package_reported(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(_env, "X2_WEIGHTS", Path(d)):
            w = Path(d) / models.MOGE["moge2"] / "model.pt"
            w.parent.mkdir(parents=True)
            w.write_bytes(b"x")
            with mock.patch.object(models, "_spec", return_value=False):
                ok, why = models.moge_status("moge2")
        self.assertFalse(ok)
        self.assertIn("not installed", why)


class CacheKeyTest(unittest.TestCase):
    def test_key_changes_with_service_version(self):
        a = cache.key("/depth", [b"img"], {"m": "moge2"})
        with mock.patch.object(_env, "SERVICE_VERSION", "other-version"):
            b = cache.key("/depth", [b"img"], {"m": "moge2"})
        self.assertNotEqual(a, b)
        self.assertEqual(a, cache.key("/depth", [b"img"], {"m": "moge2"}))


if __name__ == "__main__":
    unittest.main()
