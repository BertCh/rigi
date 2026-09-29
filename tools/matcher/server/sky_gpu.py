"""Opt-in GPU skyline grid for policy t6 (env T6_GPU_GRID=1; DEFAULT OFF).

Added by session mt-image-bc on 2026-09-28 (tools/matcher/** is owned by session f0; this module is additive).
The render worker's `edges` command, given skyGrid={vfov0, focalKnown, aspect}, runs the WebGPU port of the
stage-1 grid (src/lib/gpu/skyglobal) in the page and writes the certified candidate cells (combo × nYaw + yaw,
u32). grid_from_cands() re-scores exactly those cells in numpy with skyglobal.grid()'s own expressions, so the
resulting {best, arg} are identical to SkyGlobal.grid (verified offline on 50/50 dev photos by
tools/matcher/gpu_port/verify_gpu_cands.py, copied from there). Peaks, NMS and the polish stay in numpy
(skyglobal.py unchanged). Any mismatch raises; t6.py then keeps the full CPU grid.
"""
from __future__ import annotations

import math
import time

import numpy as np


def grid_from_cands(SG, sg, cands: np.ndarray, n_yaw: int | None = None, n_combo: int | None = None):
    """A drop-in for sg.grid(vfovs, pitches, rolls): the same expressions as SkyGlobal.grid, evaluated only on
    the candidate (combo, yaw) cells, combos in grid()'s loop order (strict '>' keeps the first max).
    SG is the skyglobal module; n_yaw / n_combo (from the page's plan) are checked against numpy's."""
    cands = np.asarray(cands).astype(np.int64)

    def grid(vfovs, pitches, rolls, ystep=0.5, astep=None):
        t0 = time.time()
        vmax = max(vfovs)
        hmax = 2 * math.degrees(math.atan(math.tan(math.radians(vmax) / 2) * sg.aspect))
        astep = astep or max(0.1, min(0.5, hmax / 120))
        ystep = max(astep, round(ystep / astep) * astep)
        prof = SG.horizon_profile(sg.dirs, astep)
        n = len(prof)
        sy = int(round(ystep / astep))
        yaws_i = np.arange(0, n, sy)
        ny = len(yaws_i)
        nP, nR = len(pitches), len(rolls)
        if n_yaw is not None and n_yaw != ny:
            raise RuntimeError(f"GPU plan nYaw {n_yaw} != numpy {ny}")
        if n_combo is not None and n_combo != len(vfovs) * nP * nR:
            raise RuntimeError(f"GPU plan nCombo {n_combo} != numpy {len(vfovs) * nP * nR}")
        if len(cands) == 0 or int(cands.max()) >= ny * len(vfovs) * nP * nR:
            raise RuntimeError("GPU candidates out of range")
        best = np.full(ny, -np.inf, np.float64)
        arg = np.zeros((ny, 3), np.float32)
        combo = cands // ny
        yaw = cands % ny
        order = np.lexsort((yaw, combo))
        combo, yaw = combo[order], yaw[order]
        seen = np.zeros(ny, bool)
        seen[yaw] = True
        if not seen.all():
            raise RuntimeError("GPU candidates miss a yaw: run the full grid")
        bounds = np.flatnonzero(np.r_[True, combo[1:] != combo[:-1], True])
        S = sg.Sc
        for a, b in zip(bounds[:-1], bounds[1:]):
            c = int(combo[a])
            ys = yaw[a:b]
            vi, rem = divmod(c, nP * nR)
            pi, ri = divmod(rem, nR)
            vf, p, r = vfovs[vi], pitches[pi], rolls[ri]
            hf = 2 * math.degrees(math.atan(math.tan(math.radians(vf) / 2) * sg.aspect))
            half = hf / 2 * 1.25 + 3
            ja = np.arange(-int(half / astep), int(half / astep) + 1)
            alpha = ja * astep
            El = prof[(yaws_i[ys][:, None] + ja[None, :]) % n]
            u, v, ok = SG.project_rel(alpha[None, :], El, p, r, vf, sg.aspect)
            x = np.clip(np.floor(u * sg.w).astype(np.int32), 0, sg.w - 1)
            y = np.clip(np.floor(v * sg.h).astype(np.int32), 0, sg.h - 1)
            val = np.where(ok, S[y, x], 0.0)
            cnt = ok.sum(1)
            cov = np.minimum(cnt / n / ((vf * sg.aspect / 360) * 0.6), 1)
            sc = np.where(cnt > max(3, 0.9 / astep), val.sum(1) / np.maximum(cnt, 1) * cov, 0.0)
            better = sc > best[ys]
            best[ys[better]] = sc[better]
            arg[ys[better]] = (vf, p, r)
        return {"yaw": yaws_i * astep, "best": best, "arg": arg, "astep": astep, "ms": round((time.time() - t0) * 1000)}

    return grid
