# Rigi
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: Copyright (c) Rigi contributors
"""Manifest selection for the stage-1 runner (STAGE1_MANIFEST) with the v3 seal.

  default                          tools/bench/data/manifest.json (unchanged)
  STAGE1_MANIFEST=<path>           any other manifest (relative paths resolve against the repo root)
  v3 manifest (ids `w3_*`, or a path under tools/bench/data_v3)
                                   REFUSED unless V3_ALLOW=1; even then the manifest sha1 and the photo-listing
                                   digest must equal the ones in data_v3/FROZEN.sha1, else refused.

FROZEN.sha1 format (read from the file itself): line 1 `<sha1>  manifest.json`; a line
`photos: N files; sha1 of 'shasum -a 1 photos/*.jpg' listing (run inside photos/): <sha1>`.
The listing digest is the sha1 of the text `shasum -a 1 *.jpg` prints inside photos/ (`<sha1>  <name>\\n` per file,
names sorted). Only hashes are computed; nothing is decoded or rendered here. Stdlib only.
"""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

V3_DIR_REL = "tools/bench/data_v3"
DEFAULT_REL = "tools/bench/data/manifest.json"


class ManifestRefused(RuntimeError):
    pass


def sha1_file(path: Path) -> str:
    return hashlib.sha1(Path(path).read_bytes()).hexdigest()


def photo_listing_digest(photos_dir: Path) -> str:
    """sha1 of `shasum -a 1 *.jpg` run inside photos_dir."""
    lines = [f"{sha1_file(p)}  {p.name}\n" for p in sorted(Path(photos_dir).glob("*.jpg"), key=lambda p: p.name)]
    return hashlib.sha1("".join(lines).encode()).hexdigest()


def parse_frozen(text: str) -> dict:
    manifest = re.match(r"^([0-9a-f]{40})\s+manifest\.json\s*$", text.splitlines()[0] if text else "")
    listing = re.search(r"listing \(run inside photos/\):\s*([0-9a-f]{40})", text)
    if not manifest or not listing:
        raise ManifestRefused("FROZEN.sha1 not in the expected format")
    return {"manifestSha1": manifest.group(1), "photoListingSha1": listing.group(1)}


def _looks_v3(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to((root / V3_DIR_REL).resolve())
        return True
    except ValueError:
        pass
    try:
        ids = [str(e.get("id", "")) for e in json.load(open(path))]
    except (OSError, ValueError, AttributeError, TypeError):
        return False
    return any(i.startswith("w3_") for i in ids)


def verify_frozen(manifest: Path, frozen: Path, photos_dir: Path) -> dict:
    if not frozen.exists():
        raise ManifestRefused(f"v3 manifest refused: {frozen} missing")
    want = parse_frozen(frozen.read_text())
    got_m = sha1_file(manifest)
    if got_m != want["manifestSha1"]:
        raise ManifestRefused(f"v3 manifest refused: sha1 {got_m} != FROZEN.sha1 {want['manifestSha1']}")
    if not Path(photos_dir).is_dir():
        raise ManifestRefused(f"v3 manifest refused: photo directory {photos_dir} missing")
    got_p = photo_listing_digest(photos_dir)
    if got_p != want["photoListingSha1"]:
        raise ManifestRefused(f"v3 manifest refused: photo-listing digest {got_p} != FROZEN.sha1 {want['photoListingSha1']}")
    return {"manifestSha1": got_m, "photoListingSha1": got_p}


def resolve_manifest(root: Path, env: dict, frozen: Path | None = None, photos_dir: Path | None = None) -> Path:
    """The manifest path stage 1 should use (see module doc). Raises ManifestRefused."""
    root = Path(root)
    raw = env.get("STAGE1_MANIFEST")
    if not raw:
        return root / DEFAULT_REL
    path = Path(raw)
    path = (path if path.is_absolute() else root / path).resolve()
    if not path.exists():
        raise ManifestRefused(f"STAGE1_MANIFEST {path} does not exist")
    if _looks_v3(path, root):
        if env.get("V3_ALLOW") != "1":
            raise ManifestRefused("v3 manifest refused: the set is sealed (needs V3_ALLOW=1 and a FROZEN.sha1 match)")
        verify_frozen(path, frozen or root / V3_DIR_REL / "FROZEN.sha1", photos_dir or path.parent / "photos")
    return path
