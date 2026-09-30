"""Mapterhorn DEM in Python: tile cache, multi-resolution mosaics, and a fast ray-marched horizon at
any eye, in the app's camera-anchored ENU frame (src/lib/geodesy.ts: origin (lat0, lon0, h=0),
curvature + refraction k = 0.13 baked into the vertical).

Only Mapterhorn (https://tiles.mapterhorn.com/{z}/{x}/{y}.webp, Terrarium encoding, 512 px) is used.
Tiles are cached under tools/matcher/.cache/mapterhorn (gitignored), capped at 1 GB (LRU by atime).

    dem = Dem(lat0, lon0, extent_m=1500)          # mosaics covering eye moves up to ±extent_m
    h = dem.ground(e, n)                           # ENU z of the terrain at (e, n) (vectorised)
    hz = dem.horizon(eye, az0, az1, step)          # dict(az, el, dist, dirs (N,3) unit, azimuth order)
"""
from __future__ import annotations

import io
import math
import os
import time
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
CACHE = Path(os.environ.get("MATCHER_DEM_CACHE", HERE / ".cache" / "mapterhorn"))
CACHE_CAP = int(os.environ.get("MATCHER_DEM_CACHE_BYTES", 1 << 30))
URL = os.environ.get("MAPTERHORN_URL") or "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp"  # self-hosting: reports/licences.md
R_EARTH = 6371008.8
K_REFR = 0.13
D = math.pi / 180
# (max distance from the eye in m, zoom): z14 ≈ 3.3 m/px, z12 ≈ 13 m/px, z10 ≈ 53 m/px at 46.5°N
BANDS = ((3000.0, 14), (15000.0, 12), (100000.0, 10))
_fetched = 0
CANCEL = None  # optional callable, polled between tiles (the service sets it to abort a departed client's job)
UA = "summit-lens-research/0.1 (mt-image tools/matcher; urllib)"


def _tile_path(z, x, y):
    return CACHE / str(z) / str(x) / f"{y}.webp"


def _prune_cache():
    files = [p for p in CACHE.rglob("*.webp")]
    tot = sum(p.stat().st_size for p in files)
    if tot <= CACHE_CAP:
        return
    for p in sorted(files, key=lambda p: p.stat().st_atime):
        tot -= p.stat().st_size
        p.unlink(missing_ok=True)
        if tot <= CACHE_CAP * 0.9:
            break


def tile(z: int, x: int, y: int) -> np.ndarray | None:
    """Elevation (m) 512×512 float32, or None if the tile doesn't exist."""
    global _fetched
    p = _tile_path(z, x, y)
    if not p.exists():
        p.parent.mkdir(parents=True, exist_ok=True)
        for attempt in range(3):
            try:
                req = urllib.request.Request(URL.format(z=z, x=x, y=y), headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=30) as r:
                    data = r.read()
                break
            except urllib.error.HTTPError as e:
                if e.code in (403, 404):
                    return None
                time.sleep(1 + attempt)
            except Exception:  # noqa: BLE001
                time.sleep(1 + attempt)
        else:
            return None
        p.write_bytes(data)
        _fetched += 1
        if _fetched % 200 == 0:
            _prune_cache()
    try:
        a = np.asarray(Image.open(io.BytesIO(p.read_bytes())).convert("RGB"), np.float32)
    except Exception:  # noqa: BLE001
        p.unlink(missing_ok=True)
        return None
    return a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768


def lonlat_to_px(lon, lat, z):
    n = 512 * 2 ** z
    x = (np.asarray(lon) + 180) / 360 * n
    s = np.sin(np.asarray(lat) * D)
    y = (0.5 - np.log((1 + s) / (1 - s)) / (4 * math.pi)) * n
    return x, y


class Mosaic:
    def __init__(self, z, lat_min, lat_max, lon_min, lon_max):
        self.z = z
        x0, y1 = lonlat_to_px(lon_min, lat_min, z)
        x1, y0 = lonlat_to_px(lon_max, lat_max, z)
        tx0, tx1 = int(x0 // 512), int(x1 // 512)
        ty0, ty1 = int(y0 // 512), int(y1 // 512)
        self.ox, self.oy = tx0 * 512, ty0 * 512
        a = np.zeros(((ty1 - ty0 + 1) * 512, (tx1 - tx0 + 1) * 512), np.float32)
        self.missing = 0
        for ty in range(ty0, ty1 + 1):
            for tx in range(tx0, tx1 + 1):
                if CANCEL is not None:
                    CANCEL()
                t = tile(z, tx, ty)
                if t is None:
                    self.missing += 1
                    continue
                a[(ty - ty0) * 512:(ty - ty0 + 1) * 512, (tx - tx0) * 512:(tx - tx0 + 1) * 512] = t
        self.a = a

    def sample(self, lon, lat):
        x, y = lonlat_to_px(lon, lat, self.z)
        x = x - self.ox - 0.5
        y = y - self.oy - 0.5
        H, W = self.a.shape
        x = np.clip(x, 0, W - 1.001)
        y = np.clip(y, 0, H - 1.001)
        xi, yi = np.floor(x).astype(np.int64), np.floor(y).astype(np.int64)
        fx, fy = x - xi, y - yi
        a = self.a
        return ((a[yi, xi] * (1 - fx) + a[yi, xi + 1] * fx) * (1 - fy)
                + (a[yi + 1, xi] * (1 - fx) + a[yi + 1, xi + 1] * fx) * fy)


class Dem:
    def __init__(self, lat0: float, lon0: float, extent_m: float = 200.0):
        self.lat0, self.lon0 = lat0, lon0
        self.extent = extent_m
        self.mlat = 1 / (R_EARTH * D)  # deg per metre north
        self.mlon = 1 / (R_EARTH * D * math.cos(lat0 * D))
        self.mos = []
        for dmax, z in BANDS:
            r = dmax + extent_m + 200
            self.mos.append((dmax, Mosaic(z, lat0 - r * self.mlat, lat0 + r * self.mlat,
                                          lon0 - r * self.mlon, lon0 + r * self.mlon)))

    def geo(self, e, n):
        return self.lon0 + np.asarray(e) * self.mlon, self.lat0 + np.asarray(n) * self.mlat

    def height(self, e, n, band=0):
        lon, lat = self.geo(e, n)
        return self.mos[band][1].sample(lon, lat)

    def ground(self, e, n):
        """Terrain ENU z at (e, n): DEM height minus the refraction-reduced earth-curvature drop."""
        e, n = np.asarray(e, float), np.asarray(n, float)
        return self.height(e, n, 0) - (1 - K_REFR) * (e * e + n * n) / (2 * R_EARTH)

    def horizon(self, eye, az0: float, az1: float, step: float, dmin: float = 5.0, dmax: float = 100000.0, grow: float = 0.004):
        """Topmost terrain direction per azimuth in [az0, az1] (deg, clockwise from north) from `eye`."""
        az = np.arange(az0, az1 + step * 0.5, step)
        ex, ey, ez = float(eye[0]), float(eye[1]), float(eye[2])
        # distance samples: fine near, geometric further out
        d = [dmin]
        while d[-1] < dmax:
            d.append(d[-1] + max(4.0, d[-1] * grow))
        d = np.array(d)
        sa, ca = np.sin(az * D), np.cos(az * D)
        best_t = np.full(len(az), -np.inf)
        best_d = np.zeros(len(az))
        lo = 0.0
        for dband, (dm, mos) in zip([b[0] for b in BANDS], self.mos):
            sel = (d >= lo) & (d < dm)
            lo = dm
            if not sel.any():
                continue
            dd = d[sel]
            E = ex + sa[:, None] * dd[None, :]
            N = ey + ca[:, None] * dd[None, :]
            lon, lat = self.geo(E, N)
            h = mos.sample(lon, lat) - (1 - K_REFR) * (E * E + N * N) / (2 * R_EARTH)
            t = (h - ez) / dd[None, :]
            k = np.argmax(t, axis=1)
            tm = t[np.arange(len(az)), k]
            up = tm > best_t
            best_t[up] = tm[up]
            best_d[up] = dd[k[up]]
        el = np.arctan(best_t)
        dirs = np.stack([sa * np.cos(el), ca * np.cos(el), np.sin(el)], 1)
        return {"az": az, "el": el / D, "dist": best_d, "dirs": dirs}
