"""Geodesy for the E3 near-field renderer: a numpy port of src/lib/geodesy.ts EnuFrame (float64, vectorised),
LV95 <-> WGS84 (pyproj EPSG:2056), web-mercator tile maths.

Frame = the C0 cache frame EnuFrame(photo.lat, photo.lon, 0): x east, y north, z up, with the app's refraction lift
z = u + k d^2 / 2R (k = 0.13) - exactly as src/lib/geodesy.ts.
"""
from __future__ import annotations

import math
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / ".pylib"))
os.environ.setdefault("PROJ_NETWORK", "OFF")

import numpy as np  # noqa: E402
import pyproj  # noqa: E402

A = 6378137.0
F = 1 / 298.257223563
E2 = F * (2 - F)
EARTH_R = 6371008.8
REFRACTION_K = 0.13
DEG = math.pi / 180

_to_lv95 = pyproj.Transformer.from_crs(4326, 2056, always_xy=True)
_from_lv95 = pyproj.Transformer.from_crs(2056, 4326, always_xy=True)


def wgs_to_lv95(lat, lon):
    E, N = _to_lv95.transform(np.asarray(lon, float), np.asarray(lat, float))
    return np.asarray(E), np.asarray(N)


def lv95_to_wgs(E, N):
    lon, lat = _from_lv95.transform(np.asarray(E, float), np.asarray(N, float))
    return np.asarray(lat), np.asarray(lon)


def to_ecef(lat, lon, h):
    phi = np.asarray(lat, float) * DEG
    lam = np.asarray(lon, float) * DEG
    s = np.sin(phi)
    n = A / np.sqrt(1 - E2 * s * s)
    c = np.cos(phi)
    return np.stack([(n + h) * c * np.cos(lam), (n + h) * c * np.sin(lam), (n * (1 - E2) + h) * s], -1)


class EnuFrame:
    def __init__(self, lat: float, lon: float, h: float = 0.0):
        self.lat, self.lon, self.h = lat, lon, h
        self.o = to_ecef(lat, lon, h)
        phi, lam = lat * DEG, lon * DEG
        sp, cp, sl, cl = math.sin(phi), math.cos(phi), math.sin(lam), math.cos(lam)
        self.r = np.array([[-sl, cl, 0], [-sp * cl, -sp * sl, cp], [cp * cl, cp * sl, sp]])

    def from_geo(self, lat, lon, h):
        d = to_ecef(lat, lon, h) - self.o
        enu = d @ self.r.T
        d2 = enu[..., 0] ** 2 + enu[..., 1] ** 2
        enu[..., 2] += REFRACTION_K * d2 / (2 * EARTH_R)
        return enu

    def to_geo(self, e, n, u):
        e, n, u = (np.asarray(v, float) for v in (e, n, u))
        d2 = e * e + n * n
        uu = u - REFRACTION_K * d2 / (2 * EARTH_R)
        r = self.r
        x = self.o[0] + r[0, 0] * e + r[1, 0] * n + r[2, 0] * uu
        y = self.o[1] + r[0, 1] * e + r[1, 1] * n + r[2, 1] * uu
        z = self.o[2] + r[0, 2] * e + r[1, 2] * n + r[2, 2] * uu
        p = np.hypot(x, y)
        b = A * (1 - F)
        ep2 = (A * A - b * b) / (b * b)
        th = np.arctan2(z * A, p * b)
        lat = np.arctan2(z + ep2 * b * np.sin(th) ** 3, p - E2 * A * np.cos(th) ** 3)
        lon = np.arctan2(y, x)
        s = np.sin(lat)
        nn = A / np.sqrt(1 - E2 * s * s)
        h = p / np.cos(lat) - nn
        return lat / DEG, lon / DEG, h

    # ENU <-> LV95 at a given height (the tangent-plane e,n of a point depend on h by ~h*d/R: 0.3 m at 2 km for
    # dh = 1000 m; callers pass the eye height as the reference height)
    def enu_to_lv95(self, e, n, h_ref: float):
        lat, lon, _ = self.to_geo(e, n, np.full_like(np.asarray(e, float), h_ref))
        return wgs_to_lv95(lat, lon)

    def lv95_to_enu(self, E, N, h):
        lat, lon = lv95_to_wgs(E, N)
        return self.from_geo(lat, lon, h)


# ---------------- web mercator (256 px tiles) ----------------

def lonlat_to_tilexy(lon, lat, z):
    n = 2.0 ** z
    x = (np.asarray(lon, float) + 180.0) / 360.0 * n
    la = np.asarray(lat, float) * DEG
    y = (1.0 - np.log(np.tan(la) + 1 / np.cos(la)) / math.pi) / 2.0 * n
    return x, y


def merc_res(lat: float, z: int) -> float:
    return 2 * math.pi * A * math.cos(lat * DEG) / (256 * 2 ** z)
