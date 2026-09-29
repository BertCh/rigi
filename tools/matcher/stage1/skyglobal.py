"""Skyline-only global search (goal 1d): the app's skyline score, exhaustively over yaw × pitch × roll × FOV.

Photo evidence = the app's own edge maps (edge.fine / edge.coarse / edge.fg, exported by the worker's
`edges` command) and a POSE-FREE P(sky) colour model (a port of align.ts scanLabels + fitSkyModel, so no
prior pose leaks in). DEM evidence = the app's 360° horizonDirs, resampled to a max-elevation profile
e(azimuth). The score is align.ts scorePose: mean over projected horizon samples of
(0.5·edge + P(sky) band above − band below)·(1 − fg), times the app's coverage factor.

Yaw enters only as a circular shift of e(azimuth), so for each (pitch, roll, fov) all yaws are scored
at once. Local maxima over yaw (NMS) give the top-k hypotheses, each polished by the app's coordinate
descent on the fine map. Pure numpy, no renders.
"""
from __future__ import annotations

import math
import time

import numpy as np
from scipy.ndimage import uniform_filter

BINS = 12


def box(a, r):
    return uniform_filter(a.astype(np.float64), size=2 * r + 1, mode="nearest").astype(np.float32)


def scan_labels(rgb, fg):
    """align.ts scanLabels without a prior (pose-free)."""
    h, w, _ = rgb.shape
    c = rgb.astype(np.int32)
    lbl = np.zeros((h, w), np.int8)
    band = round(h * 0.06)
    # diff(x, y-3, y+1) for y in [3, h-1)
    d = np.abs(c[:-4] - c[4:]).sum(2)  # row k ↔ y = k + 3
    for x in range(w):
        stop = -1
        col_fg = fg[:, x]
        for y in range(3, h - 1):
            if col_fg[y] > 0.3:
                break
            if d[y - 3, x] > 40:
                stop = y
                break
        top = round(h * 0.12) if stop < 0 else stop
        lbl[: max(0, top - 2), x] = 1
        if h * 0.04 < stop < h * 0.85:
            lbl[stop + 3: min(h, stop + 3 + band), x] = -1
        lbl[round(h * 0.8):, x] = -1
    return lbl


def fit_sky(rgb, fg, lbl):
    """align.ts fitSkyModel → P(sky) (box-blurred r=1)."""
    q = np.minimum(BINS - 1, (rgb.astype(np.int32) * BINS) // 256)
    b = (q[..., 0] * BINS + q[..., 1]) * BINS + q[..., 2]
    ok = fg <= 0.3
    NB = BINS ** 3
    hs = np.bincount(b[ok & (lbl > 0)], minlength=NB).astype(np.float64)
    ht = np.bincount(b[ok & (lbl < 0)], minlength=NB).astype(np.float64)
    ns, nt = hs.sum(), ht.sum()
    a_s = ns / NB * 2 + 1e-3
    a_t = nt / NB * 2 + 1e-3
    ps = (hs[b] + a_s) / (ns + a_s * NB)
    pt = (ht[b] + a_t) / (nt + a_t * NB)
    S = np.where(fg > 0.3, 0.5, ps / (ps + pt)).astype(np.float32)
    return box(S, 1)


def score_map(E, sky, fg, fine: bool):
    """Per-pixel integrand of scorePose: (0.5·edge + above − below)·(1 − fg)."""
    h, w = sky.shape
    band = max(2, round(h * 0.035))
    gap = max(1, round(h * (0.006 if fine else 0.012)))
    cum = np.vstack([np.zeros((1, w)), np.cumsum(sky, 0, dtype=np.float64)])
    ys = np.arange(h)
    a0 = np.clip(ys - gap - band, 0, h)
    a1 = np.clip(ys - gap, 0, h)
    b0 = np.clip(ys + gap, 0, h)
    b1 = np.clip(ys + gap + band, 0, h)
    above = np.where((a1 > a0)[:, None], (cum[a1] - cum[a0]) / np.maximum(a1 - a0, 1)[:, None], 0.5)
    below = np.where((b1 > b0)[:, None], (cum[b1] - cum[b0]) / np.maximum(b1 - b0, 1)[:, None], 0.5)
    return ((0.5 * E + (above - below)) * (1 - fg)).astype(np.float32)


def horizon_profile(dirs, step):
    """Max elevation (deg) per azimuth bin (deg, 0 = north, clockwise) from ENU unit directions."""
    az = np.degrees(np.arctan2(dirs[:, 0], dirs[:, 1])) % 360
    el = np.degrees(np.arcsin(np.clip(dirs[:, 2], -1, 1)))
    n = int(round(360 / step))
    k = np.floor(az / step).astype(int) % n
    prof = np.full(n, -np.inf)
    np.maximum.at(prof, k, el)
    good = np.isfinite(prof)
    if good.sum() < 10:
        return None
    idx = np.arange(n)
    gi = idx[good]
    prof[~good] = np.interp(idx[~good], np.r_[gi - n, gi, gi + n], np.tile(prof[good], 3))
    return prof


def project_rel(alpha_deg, el_deg, pitch, roll, vfov, aspect):
    """app forEachProjected at yaw 0 for directions (rel azimuth α, elevation e) → (u, v, valid)."""
    a = np.radians(alpha_deg)
    e = np.radians(el_deg)
    dx, dy, dz = np.sin(a) * np.cos(e), np.cos(a) * np.cos(e), np.sin(e)
    p, r = math.radians(pitch), math.radians(roll)
    fx, fy, fz = 0.0, math.cos(p), math.sin(p)
    r0 = (1.0, 0.0, 0.0)
    u0 = (0.0, -math.sin(p), math.cos(p))
    cr, sr = math.cos(r), math.sin(r)
    rx, ry, rz = r0[0] * cr - u0[0] * sr, r0[1] * cr - u0[1] * sr, r0[2] * cr - u0[2] * sr
    ux, uy, uz = u0[0] * cr + r0[0] * sr, u0[1] * cr + r0[1] * sr, u0[2] * cr + r0[2] * sr
    t = math.tan(math.radians(vfov) / 2)
    z = dx * fx + dy * fy + dz * fz
    zs = np.where(z > 0.1, z, 1.0)
    u = 0.5 + (dx * rx + dy * ry + dz * rz) / zs / (t * aspect) / 2
    v = 0.5 - (dx * ux + dy * uy + dz * uz) / zs / t / 2
    ok = (z > 0.1) & (u >= 0.01) & (u <= 0.99) & (v >= 0.01) & (v <= 0.99)
    return u, v, ok


class SkyGlobal:
    def __init__(self, ed: dict, aspect: float):
        self.w, self.h = ed["w"], ed["h"]
        self.aspect = aspect
        self.fg = ed["fg"]
        rgb = ed["rgb"]
        sky = fit_sky(rgb, self.fg, scan_labels(rgb, self.fg))
        self.sky = sky
        self.Sc = score_map(ed["coarse"], sky, self.fg, fine=False)
        self.Sf = score_map(ed["fine"], sky, self.fg, fine=True)
        self.dirs = ed["dirs"]

    # exact app score for one pose (fine or coarse), on the raw horizonDirs
    def score_pose(self, pose, fine=True):
        a = np.degrees(np.arctan2(self.dirs[:, 0], self.dirs[:, 1])) - pose["yaw"]
        el = np.degrees(np.arcsin(np.clip(self.dirs[:, 2], -1, 1)))
        u, v, ok = project_rel(a, el, pose["pitch"], pose["roll"], pose["vfov"], self.aspect)
        n = int(ok.sum())
        if n <= 20:
            return 0.0
        S = self.Sf if fine else self.Sc
        x = np.floor(u[ok] * self.w).astype(int)
        y = np.floor(v[ok] * self.h).astype(int)
        s = float(S[y, x].sum())
        cov = min(n / len(self.dirs) / ((pose["vfov"] * self.aspect / 360) * 0.6), 1)
        return s / n * cov

    def grid(self, vfovs, pitches, rolls, ystep=0.5, astep=None):
        """Score every (vfov, pitch, roll) × all yaws (coarse map). Returns best per yaw [ny] + argmax params."""
        t0 = time.time()
        vmax = max(vfovs)
        hmax = 2 * math.degrees(math.atan(math.tan(math.radians(vmax) / 2) * self.aspect))
        astep = astep or max(0.1, min(0.5, hmax / 120))
        ystep = max(astep, round(ystep / astep) * astep)
        prof = horizon_profile(self.dirs, astep)
        n = len(prof)
        sy = int(round(ystep / astep))
        yaws_i = np.arange(0, n, sy)
        best = np.full(len(yaws_i), -np.inf, np.float32)
        arg = np.zeros((len(yaws_i), 3), np.float32)
        S = self.Sc
        for vf in vfovs:
            hf = 2 * math.degrees(math.atan(math.tan(math.radians(vf) / 2) * self.aspect))
            half = hf / 2 * 1.25 + 3
            ja = np.arange(-int(half / astep), int(half / astep) + 1)
            alpha = ja * astep
            idx = (yaws_i[:, None] + ja[None, :]) % n
            El = prof[idx]  # [ny, na]
            total = n  # samples per 360°
            for p in pitches:
                for r in rolls:
                    u, v, ok = project_rel(alpha[None, :], El, p, r, vf, self.aspect)
                    x = np.clip(np.floor(u * self.w).astype(np.int32), 0, self.w - 1)
                    y = np.clip(np.floor(v * self.h).astype(np.int32), 0, self.h - 1)
                    val = np.where(ok, S[y, x], 0.0)
                    cnt = ok.sum(1)
                    cov = np.minimum(cnt / total / ((vf * self.aspect / 360) * 0.6), 1)
                    sc = np.where(cnt > max(3, 0.9 / astep), val.sum(1) / np.maximum(cnt, 1) * cov, 0.0)
                    better = sc > best
                    best = np.where(better, sc, best)
                    arg[better] = (vf, p, r)
        return {"yaw": yaws_i * astep, "best": best, "arg": arg, "astep": astep, "ms": round((time.time() - t0) * 1000)}

    def refine(self, start, vfov_prior=None, vfov_sigma=None, fine=True):
        """align.ts refine (coordinate descent, halving steps); optional focal penalty as autoAlign."""
        def f(p):
            s = self.score_pose(p, fine)
            if vfov_prior:
                s -= 0.1 * ((p["vfov"] - vfov_prior) / (vfov_prior * vfov_sigma)) ** 2
            return s
        best = dict(start)
        steps = {"yaw": 0.4, "pitch": 0.4, "roll": 0.8, "vfov": start["vfov"] * 0.02}
        cur = f(best)
        for _ in range(60):
            improved = False
            for k in ("yaw", "pitch", "roll", "vfov"):
                for sg in (1, -1):
                    p = {**best, k: best[k] + sg * steps[k]}
                    s = f(p)
                    if s > cur:
                        cur, best, improved = s, p, True
            if not improved:
                steps = {k: v / 2 for k, v in steps.items()}
                if steps["yaw"] < 0.01:
                    break
        return best, cur

    def search(self, vfov0, focal_known, k=6, nms_deg=None, pitch_range=15.0, roll_range=9.0):
        """Top-k skyline hypotheses over 360° × pitch × roll × FOV."""
        if focal_known:
            vfovs = [vfov0 * s for s in (0.94, 1.0, 1.06)]
        else:
            vfovs = [2 * math.degrees(math.atan(math.tan(math.radians(hf) / 2) / self.aspect)) for hf in (35, 45, 55, 65, 75)]
        pstep = max(0.5, min(1.5, min(vfovs) / 30))
        pitches = np.arange(-pitch_range, pitch_range + 1e-9, pstep)
        rolls = np.arange(-roll_range, roll_range + 1e-9, 1.5)
        g = self.grid(vfovs, pitches, rolls)
        yaw, best, arg = g["yaw"], g["best"], g["arg"]
        hf0 = 2 * math.degrees(math.atan(math.tan(math.radians(vfov0) / 2) * self.aspect))
        nms = nms_deg or max(3.0, 0.25 * hf0)
        order = np.argsort(-best)
        n = len(yaw)
        peaks = []
        for i in order:
            if not np.isfinite(best[i]) or best[i] <= 0:
                break
            if not (best[i] >= best[(i - 1) % n] and best[i] >= best[(i + 1) % n]):
                continue
            if all(abs(((yaw[i] - q["yaw"] + 540) % 360) - 180) >= nms for q in peaks):
                peaks.append({"yaw": float(yaw[i]), "vfov": float(arg[i, 0]), "pitch": float(arg[i, 1]), "roll": float(arg[i, 2]),
                              "coarse": float(best[i])})
            if len(peaks) >= 2 * k:
                break
        t0 = time.time()
        hyps = []
        for pk in peaks:
            st = {k2: pk[k2] for k2 in ("yaw", "pitch", "roll", "vfov")}
            p1, _ = self.refine(st, vfov0 if focal_known else None, 0.08, fine=False)
            p2, s2 = self.refine(p1, vfov0 if focal_known else None, 0.08, fine=True)
            hyps.append({"pose": {k2: float(v) for k2, v in p2.items()}, "score": float(s2), "coarse": pk["coarse"]})
        hyps.sort(key=lambda h: -h["score"])
        out = []
        for hy in hyps:
            if all(abs(((hy["pose"]["yaw"] - q["pose"]["yaw"] + 540) % 360) - 180) >= 1.0 for q in out):
                out.append(hy)
        return {"hyps": out[:k], "gridMs": g["ms"], "refineMs": round((time.time() - t0) * 1000),
                "grid": {"vfovs": vfovs, "pitches": [float(pitches[0]), float(pitches[-1]), pstep], "rolls": [float(rolls[0]), float(rolls[-1]), 1.5],
                         "astep": g["astep"]}}
