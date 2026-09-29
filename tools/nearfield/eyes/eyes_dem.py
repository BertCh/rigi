"""Mapterhorn DEM in a Rigi roll ENU frame (offline mirror of src/lib/geodesy.ts EnuFrame + src/lib/terrain.ts).

    fr = EnuFrame(lat, lon, 0);  dem = LocalDem(fr, center_en=(E, N))
    dem.height(E, N) -> frame z of the DEM surface;  dem.ray_range(eye, dirs, tmax) -> first terrain hit (m)

Tiles are cached under tools/nearfield/eyes/cache/tiles (a few MB). Near grid: z17 (0.4 m/px), 1 m posts over
+-near m; far grid: z14 (3.3 m/px), 6 m posts over +-far m.
"""
from __future__ import annotations

import io
import math
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

A = 6378137.0
F = 1 / 298.257223563
E2 = F * (2 - F)
EARTH_R = 6371008.8
REFRACTION_K = 0.13
D = math.pi / 180
TILES = Path(__file__).resolve().parent / "cache" / "tiles"


def to_ecef(lat, lon, h):
    phi, lam = np.asarray(lat) * D, np.asarray(lon) * D
    s = np.sin(phi)
    n = A / np.sqrt(1 - E2 * s * s)
    c = np.cos(phi)
    return np.stack([(n + h) * c * np.cos(lam), (n + h) * c * np.sin(lam), (n * (1 - E2) + h) * s], -1)


class EnuFrame:
    def __init__(self, lat, lon, h=0.0):
        self.lat, self.lon, self.h = lat, lon, h
        self.o = to_ecef(lat, lon, h)
        phi, lam = lat * D, lon * D
        sp, cp, sl, cl = math.sin(phi), math.cos(phi), math.sin(lam), math.cos(lam)
        self.r = np.array([[-sl, cl, 0], [-sp * cl, -sp * sl, cp], [cp * cl, cp * sl, sp]])

    def from_geo(self, lat, lon, h):
        d = to_ecef(lat, lon, h) - self.o
        enu = d @ self.r.T
        d2 = enu[..., 0] ** 2 + enu[..., 1] ** 2
        enu[..., 2] += REFRACTION_K * d2 / (2 * EARTH_R)
        return enu

    def to_geo(self, e, n, u):
        e, n, u = np.asarray(e, float), np.asarray(n, float), np.asarray(u, float)
        uu = u - REFRACTION_K * (e * e + n * n) / (2 * EARTH_R)
        v = np.stack([e, n, uu], -1) @ self.r + self.o
        x, y, z = v[..., 0], v[..., 1], v[..., 2]
        p = np.hypot(x, y)
        b = A * (1 - F)
        ep2 = (A * A - b * b) / (b * b)
        th = np.arctan2(z * A, p * b)
        lat = np.arctan2(z + ep2 * b * np.sin(th) ** 3, p - E2 * A * np.cos(th) ** 3)
        lon = np.arctan2(y, x)
        s = np.sin(lat)
        nn = A / np.sqrt(1 - E2 * s * s)
        return lat / D, lon / D, p / np.cos(lat) - nn


def _tile(z, x, y):
    TILES.mkdir(parents=True, exist_ok=True)
    p = TILES / f"{z}_{x}_{y}.npy"
    if p.exists():
        return np.load(p)
    req = urllib.request.Request(f"https://tiles.mapterhorn.com/{z}/{x}/{y}.webp", headers={"User-Agent": "Mozilla/5.0"})
    b = urllib.request.urlopen(req, timeout=30).read()
    im = np.asarray(Image.open(io.BytesIO(b)).convert("RGB"), np.float64)
    h = (im[..., 0] * 256 + im[..., 1] + im[..., 2] / 256 - 32768).astype(np.float32)
    np.save(p, h)
    return h


def heights_geo(lat, lon, z):
    """Bilinear DEM height (terrain.ts sampleGrid: texel centres at (i + 0.5) / S) at zoom z."""
    lat, lon = np.asarray(lat, float), np.asarray(lon, float)
    n = 2.0**z
    fx = (lon + 180) / 360 * n
    fy = (1 - np.arcsinh(np.tan(lat * D)) / math.pi) / 2 * n
    tx, ty = np.floor(fx).astype(int), np.floor(fy).astype(int)
    out = np.full(lat.shape, np.nan)
    for kx, ky in set(zip(tx.ravel().tolist(), ty.ravel().tolist())):
        t = _tile(z, kx, ky)
        S = t.shape[0]
        sel = (tx == kx) & (ty == ky)
        x = np.clip((fx[sel] - kx) * S - 0.5, 0, S - 1)
        y = np.clip((fy[sel] - ky) * S - 0.5, 0, S - 1)
        x0, y0 = np.floor(x).astype(int), np.floor(y).astype(int)
        x1, y1 = np.minimum(x0 + 1, S - 1), np.minimum(y0 + 1, S - 1)
        ax, ay = x - x0, y - y0
        a = t[y0, x0] * (1 - ax) + t[y0, x1] * ax
        bb = t[y1, x0] * (1 - ax) + t[y1, x1] * ax
        out[sel] = a * (1 - ay) + bb * ay
    return out


class LocalDem:
    """Two regular grids of frame-z posts: near (fine) and far (coarse); bilinear lookups."""

    def __init__(self, frame: EnuFrame, center_en, near=600.0, near_step=1.0, far=4000.0, far_step=6.0, zn=17, zf=14):
        self.fr = frame
        self.c = np.asarray(center_en, float)
        self.grids = []
        for half, step, z in ((near, near_step, zn), (far, far_step, zf)):
            k = int(round(half / step))
            ax = np.arange(-k, k + 1) * step
            E, N = np.meshgrid(self.c[0] + ax, self.c[1] + ax)
            lat, lon, _ = frame.to_geo(E, N, np.full(E.shape, 1900.0))
            h = heights_geo(lat, lon, z)
            zz = frame.from_geo(lat, lon, h)[..., 2]
            self.grids.append((self.c[0] - k * step, self.c[1] - k * step, step, 2 * k + 1, zz))

    def height(self, E, N):
        E, N = np.asarray(E, float), np.asarray(N, float)
        out = np.full(np.broadcast(E, N).shape, np.nan)
        for e0, n0, st, m, zz in self.grids:  # near first
            x = (E - e0) / st
            y = (N - n0) / st
            ok = np.isnan(out) & (x >= 0) & (y >= 0) & (x <= m - 1) & (y <= m - 1)
            if not ok.any():
                continue
            xs, ys = x[ok], y[ok]
            x0 = np.minimum(np.floor(xs).astype(int), m - 2)
            y0 = np.minimum(np.floor(ys).astype(int), m - 2)
            ax, ay = xs - x0, ys - y0
            out[ok] = (zz[y0, x0] * (1 - ax) * (1 - ay) + zz[y0, x0 + 1] * ax * (1 - ay)
                       + zz[y0 + 1, x0] * (1 - ax) * ay + zz[y0 + 1, x0 + 1] * ax * ay)
        return out

    def ray_range(self, eye, dirs, tmax=3500.0, t0=0.3, grow=1.004, refine=12):
        """First crossing of the DEM surface along unit rays (N,3) from eye; inf = none within tmax."""
        eye = np.asarray(eye, float)
        n = len(dirs)
        hit = np.full(n, np.inf)
        prev_t = np.zeros(n)
        alive = np.ones(n, bool)
        t = t0
        ts = []
        while t < tmax:
            ts.append(t)
            t = max(t * grow, t + 0.25)
        for t in ts:
            idx = np.nonzero(alive)[0]
            if not idx.size:
                break
            p = eye + dirs[idx] * t
            h = self.height(p[:, 0], p[:, 1])
            below = p[:, 2] <= h
            if below.any():
                bi = idx[below]
                lo, hi = prev_t[bi].copy(), np.full(bi.size, t)
                for _ in range(refine):
                    mid = (lo + hi) / 2
                    q = eye + dirs[bi] * mid[:, None]
                    under = q[:, 2] <= self.height(q[:, 0], q[:, 1])
                    hi = np.where(under, mid, hi)
                    lo = np.where(under, lo, mid)
                hit[bi] = hi
                alive[bi] = False
            prev_t[idx[~below]] = t
        return hit
