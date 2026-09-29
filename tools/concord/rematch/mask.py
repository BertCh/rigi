"""Semantic masking of render keypoints (WP-G): drop or lift matches that land on objects the DTM lacks.

The render is a satellite orthophoto draped on the bare-earth DEM, so a keypoint on a roof or a tree
crown is lifted to the GROUND under it, while the photo sees the roof / canopy top. Classes come from
the swisstopo Light Base Map vector tiles (ch.swisstopo.base.vt, z14, CORS-open, no key):

  building  (layer "building", `render_height` m)   → lift by render_height (fallback BUILDING_H)
  forest    (layer "landcover", class wood/forest)   → lift by FOREST_H (a-priori constant, not tuned)
  glacier   (layer "landcover", class glacier/ice)   → drop (DEM epoch ≠ imagery epoch ≠ photo)

Mode "drop" (the service default since the dev run, RESULT.txt) drops every classed keypoint instead. Outside Switzerland the tiles are empty and the
mask is a no-op (reported as coverage 0). Tiles are cached under out/concord/rematch/vt/.

A tiny Mapbox-Vector-Tile decoder is included (no new dependency).
"""
from __future__ import annotations

import gzip
import math
import threading
import urllib.request
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[3]
CACHE = ROOT / "out" / "concord" / "rematch" / "vt"
URL = "https://vectortiles{s}.geo.admin.ch/tiles/ch.swisstopo.base.vt/v1.0.0/{z}/{x}/{y}.pbf"
Z = 14
RES = 512  # raster cells per tile side (≈ 3.3 m at 46.7° N)
BUILDING_H = 8.0  # m, when render_height is missing
FOREST_H = 20.0  # m; plan budget quotes 25–30 m canopy, 20 m is a conservative mean (fixed a priori)
MAX_RANGE_M = 12000.0  # beyond this a class lift is < 1 px and tiles are not fetched

CLS_NONE, CLS_BUILDING, CLS_FOREST, CLS_GLACIER = 0, 1, 2, 3
CLS_NAMES = {CLS_NONE: None, CLS_BUILDING: "building", CLS_FOREST: "forest", CLS_GLACIER: "glacier"}
FOREST_CLASSES = {"wood", "forest", "scrub"}
GLACIER_CLASSES = {"glacier", "ice", "firn"}

# ---------------------------------------------------------------- minimal protobuf / MVT


def _varint(b: bytes, i: int) -> tuple[int, int]:
    r = s = 0
    while True:
        c = b[i]
        i += 1
        r |= (c & 0x7F) << s
        s += 7
        if c < 0x80:
            return r, i


def _fields(b: bytes):
    i = 0
    n = len(b)
    while i < n:
        k, i = _varint(b, i)
        f, w = k >> 3, k & 7
        if w == 0:
            v, i = _varint(b, i)
        elif w == 2:
            ln, i = _varint(b, i)
            v = b[i : i + ln]
            i += ln
        elif w == 5:
            v = b[i : i + 4]
            i += 4
        elif w == 1:
            v = b[i : i + 8]
            i += 8
        else:
            raise ValueError(f"bad wire type {w}")
        yield f, w, v


def _packed(b: bytes) -> list[int]:
    out, i = [], 0
    while i < len(b):
        v, i = _varint(b, i)
        out.append(v)
    return out


def _value(b: bytes):
    import struct

    for f, _w, v in _fields(b):
        if f == 1:
            return v.decode("utf-8", "replace")
        if f == 2:
            return struct.unpack("<f", v)[0]
        if f == 3:
            return struct.unpack("<d", v)[0]
        if f in (4, 5):
            return v
        if f == 6:
            return (v >> 1) ^ -(v & 1)
        if f == 7:
            return bool(v)
    return None


def _rings(geom: list[int]) -> list[np.ndarray]:
    """Decode MVT command stream into rings/lines (tile units)."""
    rings, cur = [], []
    x = y = 0
    i = 0
    while i < len(geom):
        cmd, cnt = geom[i] & 7, geom[i] >> 3
        i += 1
        if cmd in (1, 2):
            for _ in range(cnt):
                dx, dy = geom[i], geom[i + 1]
                i += 2
                x += (dx >> 1) ^ -(dx & 1)
                y += (dy >> 1) ^ -(dy & 1)
                if cmd == 1 and cur:
                    rings.append(np.array(cur, np.float64))
                    cur = []
                cur.append((x, y))
        elif cmd == 7:
            if cur:
                rings.append(np.array(cur, np.float64))
                cur = []
    if cur:
        rings.append(np.array(cur, np.float64))
    return rings


def decode_mvt(data: bytes, layers: set[str]) -> dict[str, list[tuple[dict, int, list[np.ndarray], int]]]:
    """{layer: [(tags, geomType, rings, extent)]} for the requested layers."""
    if data[:2] == b"\x1f\x8b":
        data = gzip.decompress(data)
    out: dict = {}
    for f, _w, lay in _fields(data):
        if f != 3:
            continue
        name, keys, vals, feats, extent = None, [], [], [], 4096
        for f2, _w2, v2 in _fields(lay):
            if f2 == 1:
                name = v2.decode()
            elif f2 == 2:
                feats.append(v2)
            elif f2 == 3:
                keys.append(v2.decode())
            elif f2 == 4:
                vals.append(_value(v2))
            elif f2 == 5:
                extent = v2
        if name not in layers:
            continue
        lst = out.setdefault(name, [])
        for fb in feats:
            tags, gtype, geom = [], 0, []
            for f3, _w3, v3 in _fields(fb):
                if f3 == 2:
                    tags = _packed(v3)
                elif f3 == 3:
                    gtype = v3
                elif f3 == 4:
                    geom = _packed(v3)
            td = {keys[tags[k]]: vals[tags[k + 1]] for k in range(0, len(tags) - 1, 2)}
            lst.append((td, gtype, _rings(geom), extent))
    return out


# ---------------------------------------------------------------- tile rasters


def tile_xy(lat: np.ndarray, lon: np.ndarray, z: int = Z) -> tuple[np.ndarray, np.ndarray]:
    """Fractional slippy-map tile coordinates."""
    n = 2.0**z
    x = (lon + 180.0) / 360.0 * n
    y = (1.0 - np.arcsinh(np.tan(np.radians(lat))) / math.pi) / 2.0 * n
    return x, y


_mem: dict[tuple[int, int], tuple[np.ndarray, np.ndarray] | None] = {}
_lock = threading.Lock()


def _fetch(x: int, y: int) -> bytes | None:
    CACHE.mkdir(parents=True, exist_ok=True)
    p = CACHE / f"{Z}_{x}_{y}.pbf"
    if p.exists():
        return p.read_bytes()
    url = URL.format(s=(x + y) % 5, z=Z, x=x, y=y)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "rigi-concord-rematch/0.1"})
        with urllib.request.urlopen(req, timeout=20) as r:
            data = r.read()
    except Exception:  # noqa: BLE001  (404 outside CH, network) → no classes
        data = b""
    p.write_bytes(data)
    return data


def tile_raster(x: int, y: int) -> tuple[np.ndarray, np.ndarray] | None:
    """(class uint8 RES×RES, height float32 RES×RES) for one z14 tile; None if empty/unavailable."""
    with _lock:
        if (x, y) in _mem:
            return _mem[(x, y)]
    data = _fetch(x, y)
    res = None
    if data:
        lay = decode_mvt(data, {"building", "landcover"})
        cls = np.zeros((RES, RES), np.uint8)
        hgt = np.zeros((RES, RES), np.float32)

        def fill(rings, extent, val, target=cls):
            pts = [np.round(r * (RES / extent)).astype(np.int32) for r in rings if len(r) >= 3]
            if pts:
                cv2.fillPoly(target, pts, val)

        for td, gtype, rings, ext in lay.get("landcover", []):
            if gtype != 3:
                continue
            c = str(td.get("class", "")).lower()
            sc = str(td.get("subclass", "")).lower()
            if c in GLACIER_CLASSES or sc in GLACIER_CLASSES:
                fill(rings, ext, CLS_GLACIER)
            elif c in FOREST_CLASSES or sc in FOREST_CLASSES:
                fill(rings, ext, CLS_FOREST)
        for td, gtype, rings, ext in lay.get("building", []):
            if gtype != 3:
                continue
            h = td.get("render_height")
            h = float(h) if isinstance(h, (int, float)) and h > 0 else BUILDING_H
            fill(rings, ext, CLS_BUILDING)
            fill(rings, ext, float(h), hgt)
        res = (cls, hgt) if cls.any() or lay else None
    with _lock:
        _mem[(x, y)] = res
    return res


def classify(lat: np.ndarray, lon: np.ndarray, rng: np.ndarray) -> tuple[np.ndarray, np.ndarray, int]:
    """Class code + object height (m) per point; points beyond MAX_RANGE_M are CLS_NONE.
    Returns (cls, height, tilesWithData)."""
    n = len(lat)
    cls = np.zeros(n, np.uint8)
    hgt = np.zeros(n, np.float32)
    if n == 0:
        return cls, hgt, 0
    tx, ty = tile_xy(lat, lon)
    ix, iy = np.floor(tx).astype(int), np.floor(ty).astype(int)
    near = rng <= MAX_RANGE_M
    ok_tiles = 0
    for key in sorted(set(zip(ix[near].tolist(), iy[near].tolist()))):
        r = tile_raster(*key)
        if r is None:
            continue
        ok_tiles += 1
        c, h = r
        sel = near & (ix == key[0]) & (iy == key[1])
        px = np.clip(((tx[sel] - key[0]) * RES).astype(int), 0, RES - 1)
        py = np.clip(((ty[sel] - key[1]) * RES).astype(int), 0, RES - 1)
        cls[sel] = c[py, px]
        hgt[sel] = h[py, px]
    hgt[cls == CLS_FOREST] = FOREST_H
    return cls, hgt, ok_tiles


def apply_mask(world: np.ndarray, lat: np.ndarray, lon: np.ndarray, rng: np.ndarray, mode: str = "lift"):
    """world: (N,3) ENU (z up). Returns (world', keep mask, class names list, stats dict)."""
    cls, hgt, tiles = classify(lat, lon, rng)
    keep = np.ones(len(world), bool)
    w = world.copy()
    if mode == "drop":
        keep &= cls == CLS_NONE
    else:
        keep &= cls != CLS_GLACIER
        lift = (cls == CLS_BUILDING) | (cls == CLS_FOREST)
        w[lift, 2] += hgt[lift]
    names = [CLS_NAMES[int(c)] for c in cls]
    stats = {
        "mode": mode,
        "tiles": tiles,
        "building": int((cls == CLS_BUILDING).sum()),
        "forest": int((cls == CLS_FOREST).sum()),
        "glacier": int((cls == CLS_GLACIER).sum()),
        "dropped": int((~keep).sum()),
    }
    return w, keep, names, stats


if __name__ == "__main__":  # smoke: python mask.py lat lon
    import sys

    la, lo = float(sys.argv[1]), float(sys.argv[2])
    x, y = tile_xy(np.array([la]), np.array([lo]))
    data = _fetch(int(x[0]), int(y[0]))
    lay = decode_mvt(data or b"", {"building", "landcover"})
    from collections import Counter

    print({k: len(v) for k, v in lay.items()})
    print(Counter((str(t.get("class")), str(t.get("subclass"))) for t, *_ in lay.get("landcover", [])).most_common(20))
    print([t.get("render_height") for t, *_ in lay.get("building", [])][:10])
    c, h, n = classify(np.array([la]), np.array([lo]), np.array([0.0]))
    r = tile_raster(int(x[0]), int(y[0]))
    print("tiles", n, "class frac", None if r is None else np.bincount(r[0].ravel(), minlength=4) / RES**2)
