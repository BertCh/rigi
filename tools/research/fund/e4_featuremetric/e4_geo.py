# Rigi
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: Copyright (c) Rigi contributors

"""Geodesy for the E4 renderer: numpy port of src/lib/geodesy.ts EnuFrame (float64, vectorised), web-mercator tile
maths, pose_to_R (the app's yaw/pitch/roll convention). Adapted from FUND E3 nf_geo.py without pyproj (the far grid and
the colour both come from web-mercator tiles, so no LV95 is needed).

Frame = EnuFrame(photo.lat, photo.lon, 0): x east, y north, z up, refraction lift z += k d^2 / 2R (k = 0.13).
"""
from __future__ import annotations

import math

import numpy as np

A = 6378137.0
F = 1 / 298.257223563
E2 = F * (2 - F)
EARTH_R = 6371008.8
REFRACTION_K = 0.13
DEG = math.pi / 180


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


def lonlat_to_tilexy(lon, lat, z):
    """Fractional tile coordinates (tile units, either 256 or 512 px tiles)."""
    n = 2.0**z
    x = (np.asarray(lon, float) + 180.0) / 360.0 * n
    la = np.asarray(lat, float) * DEG
    y = (1.0 - np.log(np.tan(la) + 1 / np.cos(la)) / math.pi) / 2.0 * n
    return x, y


def merc_res(lat: float, z: int, tile: int = 256) -> float:
    return 2 * math.pi * A * math.cos(lat * DEG) / (tile * 2**z)


def pose_to_R(p: dict) -> np.ndarray:
    """World (ENU) -> OpenCV camera (x right, y down, z forward); the app's yaw/pitch/roll convention."""
    y, pt, r = p["yaw"] * DEG, p["pitch"] * DEG, p["roll"] * DEG
    f = np.array([math.sin(y) * math.cos(pt), math.cos(y) * math.cos(pt), math.sin(pt)])
    r0 = np.array([math.cos(y), -math.sin(y), 0.0])
    u0 = np.cross(r0, f)
    right = r0 * math.cos(r) - u0 * math.sin(r)
    up = u0 * math.cos(r) + r0 * math.sin(r)
    return np.stack([right, -up, f])


def rot_angle_deg(Ra: np.ndarray, Rb: np.ndarray) -> float:
    m = Ra @ Rb.T
    return math.degrees(math.acos(max(-1.0, min(1.0, (np.trace(m) - 1) / 2))))


def wrap180(a: float) -> float:
    return (a + 180.0) % 360.0 - 180.0
