# Rigi
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: Copyright (c) Rigi contributors
"""STAGE1_MANIFEST switch and v3 seal (manifest_guard.py). Synthetic temp repo; nothing real is read."""
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import manifest_guard as G  # noqa: E402

S1_SOURCE = (Path(__file__).resolve().parents[1] / "s1.py").read_text()

# the shape of tools/bench/data_v3/FROZEN.sha1 (README/FROZEN.sha1 are the only readable v3 files), with synthetic hashes
REAL_SHAPE = """61d765bda1efb49e57695dec49cddbeb072287e0  manifest.json
frozenAt: 2026-09-26T15:05:04Z
photos: 74 files; sha1 of 'shasum -a 1 photos/*.jpg' listing (run inside photos/): 51d2e42ca7ed58ab515f5e9a4e7814261158b6da
"""


def make_repo(tmp: Path, ids=("w3_0001", "w3_0002")):
    v3 = tmp / G.V3_DIR_REL
    (v3 / "photos").mkdir(parents=True)
    for i, pid in enumerate(ids):
        (v3 / "photos" / f"{pid}.jpg").write_bytes(f"jpeg{i}".encode())
    (v3 / "manifest.json").write_text(json.dumps([{"id": pid, "file": f"photos/{pid}.jpg"} for pid in ids]))
    frozen = (f"{G.sha1_file(v3 / 'manifest.json')}  manifest.json\nfrozenAt: 2000-01-01T00:00:00Z\n"
              f"photos: {len(ids)} files; sha1 of 'shasum -a 1 photos/*.jpg' listing (run inside photos/): {G.photo_listing_digest(v3 / 'photos')}\n")
    (v3 / "FROZEN.sha1").write_text(frozen)
    return v3


class ManifestGuard(unittest.TestCase):
    def setUp(self):
        self._t = tempfile.TemporaryDirectory()
        self.root = Path(self._t.name)

    def tearDown(self):
        self._t.cleanup()

    def test_default_unchanged(self):
        self.assertEqual(G.resolve_manifest(self.root, {}), self.root / "tools/bench/data/manifest.json")
        self.assertEqual(G.resolve_manifest(self.root, {"STAGE1_MANIFEST": ""}), self.root / "tools/bench/data/manifest.json")
        self.assertIn('MANIFEST = _manifest_guard.resolve_manifest(ROOT, os.environ)', S1_SOURCE)
        self.assertNotIn('MANIFEST = ROOT / "tools/bench/data/manifest.json"', S1_SOURCE)

    def test_other_dev_manifest_accepted(self):
        d = self.root / "elsewhere"
        d.mkdir()
        (d / "m.json").write_text(json.dumps([{"id": "wc_0001"}]))
        self.assertEqual(G.resolve_manifest(self.root, {"STAGE1_MANIFEST": str(d / "m.json")}), (d / "m.json").resolve())
        self.assertEqual(G.resolve_manifest(self.root, {"STAGE1_MANIFEST": "elsewhere/m.json"}), (d / "m.json").resolve())

    def test_missing_manifest_refused(self):
        with self.assertRaises(G.ManifestRefused):
            G.resolve_manifest(self.root, {"STAGE1_MANIFEST": "nope.json"})

    def test_v3_refused_without_allow(self):
        v3 = make_repo(self.root)
        with self.assertRaisesRegex(G.ManifestRefused, "sealed"):
            G.resolve_manifest(self.root, {"STAGE1_MANIFEST": str(v3 / "manifest.json")})
        with self.assertRaisesRegex(G.ManifestRefused, "sealed"):
            G.resolve_manifest(self.root, {"STAGE1_MANIFEST": str(v3 / "manifest.json"), "V3_ALLOW": "0"})

    def test_v3_ids_outside_data_v3_refused_without_allow(self):
        d = self.root / "copy"
        d.mkdir()
        (d / "m.json").write_text(json.dumps([{"id": "w3_0009"}]))
        with self.assertRaisesRegex(G.ManifestRefused, "sealed"):
            G.resolve_manifest(self.root, {"STAGE1_MANIFEST": str(d / "m.json")})

    def test_refused_on_manifest_hash_mismatch(self):
        v3 = make_repo(self.root)
        (v3 / "manifest.json").write_text(json.dumps([{"id": "w3_0001", "file": "photos/w3_0001.jpg", "extra": 1}]))
        with self.assertRaisesRegex(G.ManifestRefused, "manifest.*sha1"):
            G.resolve_manifest(self.root, {"STAGE1_MANIFEST": str(v3 / "manifest.json"), "V3_ALLOW": "1"})

    def test_refused_on_photo_listing_mismatch(self):
        v3 = make_repo(self.root)
        (v3 / "photos" / "w3_0001.jpg").write_bytes(b"changed")
        with self.assertRaisesRegex(G.ManifestRefused, "photo-listing"):
            G.resolve_manifest(self.root, {"STAGE1_MANIFEST": str(v3 / "manifest.json"), "V3_ALLOW": "1"})
        (v3 / "photos" / "w3_0001.jpg").write_bytes(b"jpeg0")
        (v3 / "photos" / "w3_9999.jpg").write_bytes(b"extra")  # an added photo changes the listing too
        with self.assertRaisesRegex(G.ManifestRefused, "photo-listing"):
            G.resolve_manifest(self.root, {"STAGE1_MANIFEST": str(v3 / "manifest.json"), "V3_ALLOW": "1"})

    def test_refused_when_frozen_missing_or_malformed(self):
        v3 = make_repo(self.root)
        env = {"STAGE1_MANIFEST": str(v3 / "manifest.json"), "V3_ALLOW": "1"}
        (v3 / "FROZEN.sha1").write_text("garbage\n")
        with self.assertRaisesRegex(G.ManifestRefused, "format"):
            G.resolve_manifest(self.root, env)
        (v3 / "FROZEN.sha1").unlink()
        with self.assertRaisesRegex(G.ManifestRefused, "missing"):
            G.resolve_manifest(self.root, env)

    def test_accepted_on_matching_synthetic_pair(self):
        v3 = make_repo(self.root)
        got = G.resolve_manifest(self.root, {"STAGE1_MANIFEST": str(v3 / "manifest.json"), "V3_ALLOW": "1"})
        self.assertEqual(got, (v3 / "manifest.json").resolve())

    def test_explicit_frozen_and_photos_args(self):
        v3 = make_repo(self.root)
        other = self.root / "elsewhere"
        (other / "photos").mkdir(parents=True)
        (other / "photos" / "a.jpg").write_bytes(b"x")
        self.assertEqual(G.photo_listing_digest(other / "photos"), hashlib.sha1(f"{G.sha1_file(other / 'photos/a.jpg')}  a.jpg\n".encode()).hexdigest())
        env = {"STAGE1_MANIFEST": str(v3 / "manifest.json"), "V3_ALLOW": "1"}
        with self.assertRaises(G.ManifestRefused):
            G.resolve_manifest(self.root, env, photos_dir=other / "photos")

    def test_frozen_format_parses(self):
        self.assertEqual(G.parse_frozen(REAL_SHAPE), {"manifestSha1": "61d765bda1efb49e57695dec49cddbeb072287e0",
                                                      "photoListingSha1": "51d2e42ca7ed58ab515f5e9a4e7814261158b6da"})


if __name__ == "__main__":
    unittest.main()
