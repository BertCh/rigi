# Rigi
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: Copyright (c) Rigi contributors
"""Deterministic synthetic matcher scenarios (Python half of the synth.py / synth.ts twin pair).

Purpose: build skyline edge maps, horizon directions, 2D-3D correspondences and a small xyz view
from a params dict, with integer-exact PRNG (mulberry32) so synth.ts reproduces the same arrays.
make_fixtures.py feeds these into the Python reference (tools/matcher) and records the outputs
in fusion.json; synth.spec.ts checks that synth.ts matches the checksums stored there.

Scalar loops (no numpy reductions) keep the operation order identical to synth.ts.
Regenerate the fixtures (from the repo / worktree root):
  /Users/robertchristie/Documents/GitHub/mt-image/tools/matcher/.venv/bin/python src/lib/matcher/__tests__/fixtures/make_fixtures.py
"""
from __future__ import annotations

import math

import numpy as np

M32 = 0xFFFFFFFF
D = math.pi / 180
XYZ_H, XYZ_W = 48, 64
N_KP = 40


def imul(a: int, b: int) -> int:
    return (a * b) & M32


class Mulberry32:
    def __init__(self, seed: int):
        self.a = seed & M32

    def rand(self) -> float:
        self.a = (self.a + 0x6D2B79F5) & M32
        t = self.a
        t = imul(t ^ (t >> 15), t | 1)
        t ^= (t + imul(t ^ (t >> 7), t | 61)) & M32
        return ((t ^ (t >> 14)) & M32) / 4294967296

    def gauss(self) -> float:
        u1 = 1 - self.rand()
        u2 = self.rand()
        return math.sqrt(-2 * math.log(u1)) * math.cos(2 * math.pi * u2)


def _pose_R(p: dict):
    """common.pose_to_R as scalar rows: right, -up, forward (world ENU -> OpenCV camera)."""
    y, pt, r = p["yaw"] * D, p["pitch"] * D, p["roll"] * D
    f = [math.sin(y) * math.cos(pt), math.cos(y) * math.cos(pt), math.sin(pt)]
    r0 = [math.cos(y), -math.sin(y), 0.0]
    u0 = [r0[1] * f[2] - r0[2] * f[1], r0[2] * f[0] - r0[0] * f[2], r0[0] * f[1] - r0[1] * f[0]]
    cr, sr = math.cos(r), math.sin(r)
    right = [r0[i] * cr - u0[i] * sr for i in range(3)]
    up = [u0[i] * cr + r0[i] * sr for i in range(3)]
    return [right, [-up[0], -up[1], -up[2]], f]


def _cam(R, v):
    return [R[i][0] * v[0] + R[i][1] * v[1] + R[i][2] * v[2] for i in range(3)]


def _focal(vfov: float, h: float) -> float:
    return (h / 2) / math.tan(vfov * D / 2)


def horizon_el_deg(az_rad: float) -> float:
    return 1.2 + 1.5 * math.sin(3 * az_rad) + 0.7 * math.sin(7 * az_rad + 1.0)


def _dir(az_rad: float, el_rad: float):
    return [math.sin(az_rad) * math.cos(el_rad), math.cos(az_rad) * math.cos(el_rad), math.sin(el_rad)]


def _make_dirs() -> np.ndarray:
    n = 1801  # 0 .. 360 deg inclusive, 0.2 deg steps
    out = np.zeros((n, 3), np.float64)
    for i in range(n):
        az = (i * 0.2) * D
        out[i] = _dir(az, horizon_el_deg(az) * D)
    return out


def _skyline_rows(dirs, pose, w, h):
    """Topmost projected horizon row (edge-map px) per column; inf where none."""
    R = _pose_R(pose)
    f = _focal(pose["vfov"], h)
    n = len(dirs)
    u, v, z = [0.0] * n, [0.0] * n, [0.0] * n
    for i in range(n):
        c = _cam(R, dirs[i])
        z[i] = c[2]
        zs = c[2] if c[2] > 1e-6 else 1e-6
        u[i] = w / 2 + f * c[0] / zs
        v[i] = h / 2 + f * c[1] / zs
    rows = [math.inf] * w
    for i in range(n - 1):
        if not (z[i] > 0.1 and z[i + 1] > 0.1 and abs(u[i + 1] - u[i]) < 0.05 * w):
            continue
        lo, hi = min(u[i], u[i + 1]), max(u[i], u[i + 1])
        j = max(0, math.ceil(lo - 0.5))
        while j < w and j + 0.5 < hi:
            t = (j + 0.5 - u[i]) / (u[i + 1] - u[i])
            val = v[i] + t * (v[i + 1] - v[i])
            if val < rows[j]:
                rows[j] = val
            j += 1
    return rows


def make_scenario(params: dict) -> dict:
    rng = Mulberry32(params["seed"])
    W, H, w, h = params["W"], params["H"], params["w"], params["h"]
    tp = params["truePose"]
    eye = params["eye"]
    fg_block = params.get("fgBlock")
    dirs = _make_dirs()

    rows = _skyline_rows(dirs, tp, w, h)
    visible = [math.isfinite(r) and r > 0 and r < h for r in rows]
    sky = np.zeros((h, w), np.float32)
    fine = np.zeros((h, w), np.float32)
    fg = np.zeros((h, w), np.float32)
    for y in range(h):
        for x in range(w):
            above = (not visible[x]) or (y + 0.5 < rows[x])
            val = (0.95 if above else 0.05) + (rng.rand() * 2 - 1) * 0.03
            sky[y, x] = min(1.0, max(0.0, val))
    for y in range(h):
        for x in range(w):
            val = rng.rand() * 0.05
            if visible[x]:
                d = (y + 0.5 - rows[x]) / 1.5
                val += math.exp(-(d * d))
            fine[y, x] = val
    if fg_block:
        x0, y0, x1, y1 = fg_block
        fg[y0:y1, x0:x1] = 1.0

    # correspondences through the TRUE pose at W x H
    R = _pose_R(tp)
    f = _focal(tp["vfov"], H)
    hfov = 2 * math.atan(math.tan(tp["vfov"] * D / 2) * W / H)
    x2d, X3 = [], []
    tries = 0
    while len(x2d) < params["nCorr"] and tries < 200 * max(1, params["nCorr"]):
        tries += 1
        az = tp["yaw"] * D + (rng.rand() * 2 - 1) * hfov / 2
        elmax = horizon_el_deg(az) - 0.2
        el = (-6 + rng.rand() * (elmax + 6)) * D
        r = 2000 + rng.rand() * 28000
        d = _dir(az, el)
        P = [eye[0] + r * d[0], eye[1] + r * d[1], eye[2] + r * d[2]]
        c = _cam(R, [P[0] - eye[0], P[1] - eye[1], P[2] - eye[2]])
        if not c[2] > 0:
            continue
        u = W / 2 + f * c[0] / c[2]
        v = H / 2 + f * c[1] / c[2]
        if not (0 <= u < W and 0 <= v < H):
            continue
        ux = u + params["noisePx"] * rng.gauss()
        vx = v + params["noisePx"] * rng.gauss()
        if rng.rand() < params["outlierFrac"]:
            ux = rng.rand() * W
            vx = rng.rand() * H
        x2d.append([ux, vx])
        X3.append(P)
    x2d = np.array(x2d, np.float64).reshape(-1, 2)
    X3 = np.array(X3, np.float64).reshape(-1, 3)

    # xyz view (H=48, W=64): terrain rows >= 20, sky rows < 20
    xyz = np.zeros((XYZ_H, XYZ_W, 3), np.float32)
    for row in range(20, XYZ_H):
        for col in range(XYZ_W):
            r = 400 + 30 * col + 50 * (row - 20)
            if col >= 32:
                r *= 1.5
            if row >= 44 and col < 8:
                r = 150 + 10 * col  # near terrain (< 250 m)
            az = (10 + 0.3 * col) * D
            xyz[row, col, 0] = eye[0] + r * math.sin(az)
            xyz[row, col, 1] = eye[1] + r * math.cos(az)
            xyz[row, col, 2] = eye[2] - 0.05 * r + 20 * math.sin(0.2 * col)
    kp = np.zeros((N_KP, 2), np.float64)
    for i in range(N_KP):
        if i < 10:  # sky
            kp[i] = [rng.rand() * XYZ_W, rng.rand() * 19]
        elif i < 20:  # near the discontinuity at col 32
            kp[i] = [30 + rng.rand() * 4, 20 + rng.rand() * 28]
        elif i < 28:  # near terrain
            kp[i] = [rng.rand() * 8, 44 + rng.rand() * 4]
        else:
            kp[i] = [rng.rand() * XYZ_W, rng.rand() * XYZ_H]
    return {"dirs": dirs, "sky": sky, "fine": fine, "fg": fg, "x2d": x2d, "X": X3, "xyz": xyz, "kp": kp}


def checksums(sc: dict) -> dict:
    out = {}
    for k, a in sc.items():
        v = np.asarray(a, np.float64).ravel()
        out[k] = {"n": int(v.size), "sum": float(v.sum()) if v.size else 0.0,
                  "sumsq": float((v * v).sum()) if v.size else 0.0,
                  "first": float(v[0]) if v.size else 0.0, "last": float(v[-1]) if v.size else 0.0}
    return out


def _sc(name, seed, W, H, w, h, true, app, n_corr, out_frac, noise, fg_block=None):
    return {"name": name, "seed": seed, "W": W, "H": H, "w": w, "h": h, "truePose": true, "appPose": app,
            "nCorr": n_corr, "outlierFrac": out_frac, "noisePx": noise, "fgBlock": fg_block, "eye": [0, 0, 1500]}


_T = {"yaw": 41.37, "pitch": 0.83, "roll": 0.4, "vfov": 40}
_TP = {"yaw": 200.55, "pitch": 3.1, "roll": -0.7, "vfov": 55}
SCENARIOS = [
    _sc("agree", 1, 1024, 768, 256, 192, _T, {**_T, "yaw": 41.57, "pitch": 0.73}, 500, 0.1, 0.8),
    _sc("disagree", 2, 1024, 768, 256, 192, _T, {**_T, "yaw": 45.37}, 500, 0.1, 0.8),
    _sc("skyOnly", 3, 1024, 768, 256, 192, _T, {**_T, "yaw": 41.57, "pitch": 0.73}, 0, 0.1, 0.8),
    _sc("fgBlock", 4, 1024, 768, 256, 192, _T, {**_T, "yaw": 41.57, "pitch": 0.73}, 500, 0.1, 0.8, [96, 0, 160, 192]),
    _sc("portrait", 5, 768, 1024, 192, 256, _TP, {**_TP, "yaw": 200.75, "pitch": 3.0}, 300, 0.1, 0.8),
]
