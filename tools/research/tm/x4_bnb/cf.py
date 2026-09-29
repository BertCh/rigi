"""X4 closed-form / tiny-robust-fit pitch & roll per yaw (no pitch or roll grid).

Photo skyline (pose-free): per image column x of the coarse score map Sc, v_sky(x) = argmax_y Sc (variant "arg") or
the top-most y with Sc >= 0.7*colmax ("top"); weight = max(colmax, 0).
Per (yaw on the baseline yaw grid, vfov): each DEM sample j (relative azimuth a_j, elevation e_j) sits at a fixed
column at roll 0 (u = 0.5 + tan a/(2 t aspect)); inverting the exact projection gives the pitch that puts it on the
photo skyline: tan p_j = (tan e_j - Y_j cos a_j)/(cos a_j + Y_j tan e_j), Y_j = (0.5 - v_sky/h)*2t.
p0 = weighted median(p_j); then (p, r) by 4 Gauss-Newton IRLS steps (2 Huber k=4 px, 2 Tukey c=8 px) on the pixel
residual v(p, r)*h - v_sky(x(p, r)). The yaw is then scored with the exact SkyGlobal objective F at the fitted (p, r),
optionally polished over pitch ±{1,2} px × roll {-0.5,0,+0.5}° (15 evaluations, still gridless in absolute pitch).
"""
from __future__ import annotations
import math
import numpy as np
import x4lib as L


def skyline(S, mode="arg"):
    h, w = S.shape
    cm = S.max(0)
    if mode == "arg":
        vs = S.argmax(0)
    else:
        vs = (S >= 0.7 * np.maximum(cm, 1e-6)[None, :]).argmax(0)
    return vs.astype(np.float64) + 0.5, np.maximum(cm, 0.0)


def wmedian(x, w):
    """row-wise weighted median; x, w [B, n]."""
    o = np.argsort(x, 1)
    xs = np.take_along_axis(x, o, 1)
    ws = np.take_along_axis(w, o, 1)
    cw = np.cumsum(ws, 1)
    half = cw[:, -1:] / 2
    i = (cw < half).sum(1)
    i = np.minimum(i, x.shape[1] - 1)
    return xs[np.arange(len(x)), i]


def fit_pr(O, iy, vs, ws, colmask=None, fit_roll=True, iters=((4.0, "h"), (4.0, "h"), (8.0, "t"), (8.0, "t")),
           prange=(-15, 15), rrange=(-9, 9)):
    """(p, r) per yaw index row. iy [B] profile bins."""
    h, w = O.h, O.w
    El = O.prof[(iy[:, None] + O.ja[None, :]) % O.n]
    al = np.radians(O.alpha)[None, :]
    c = np.cos(al)
    u0 = 0.5 + np.tan(al) / (2 * O.t * O.sg.aspect)
    okc = (u0 > 0.01) & (u0 < 0.99)
    if colmask is not None:
        okc = okc & colmask[None, :]
    x0 = np.clip(np.floor(u0 * w).astype(int), 0, w - 1)
    Y = (0.5 - vs[x0] / h) * 2 * O.t
    T = np.tan(np.radians(El))
    pj = np.degrees(np.arctan((T - Y * c) / (c + Y * T)))
    wj = np.broadcast_to(ws[x0] * okc, pj.shape)
    wsum = wj.sum(1)
    p = np.clip(wmedian(pj, wj + 1e-12), *prange)
    r = np.zeros(len(iy))
    B = len(iy)
    for k, kind in iters:
        u, v, ok = O.project(El, p, r)
        if colmask is not None:
            ok = ok & colmask[None, :]
        x = np.clip(np.floor(u * w).astype(int), 0, w - 1)
        res = v * h - vs[x]
        wt = ws[x] * ok
        _, vp, _ = O.project(El, p + 0.1, r)
        Jp = (vp - v) * h / 0.1
        a = np.abs(res)
        if kind == "h":
            rw = np.where(a <= k, 1.0, k / np.maximum(a, 1e-9))
        else:
            rw = np.where(a < k, (1 - (a / k) ** 2) ** 2, 0.0)
        W = wt * rw
        if fit_roll:
            _, vr, _ = O.project(El, p, r + 0.1)
            Jr = (vr - v) * h / 0.1
            A11 = (W * Jp * Jp).sum(1) + 1e-6
            A12 = (W * Jp * Jr).sum(1)
            A22 = (W * Jr * Jr).sum(1) + 1e-6
            b1 = -(W * Jp * res).sum(1)
            b2 = -(W * Jr * res).sum(1)
            det = A11 * A22 - A12 * A12
            dp = (A22 * b1 - A12 * b2) / np.where(np.abs(det) > 1e-12, det, 1e-12)
            dr = (A11 * b2 - A12 * b1) / np.where(np.abs(det) > 1e-12, det, 1e-12)
            dr = np.clip(dr, -3, 3)
            r = np.clip(r + np.where(np.isfinite(dr), dr, 0), *rrange)
        else:
            dp = -(W * Jp * res).sum(1) / ((W * Jp * Jp).sum(1) + 1e-6)
        dp = np.clip(dp, -3, 3)
        p = np.clip(p + np.where(np.isfinite(dp), dp, 0), *prange)
    return p, r, wsum


def cf_profile(sg, vfovs, astep, ystep, mode="arg", polish=True, fit_roll=True):
    """-> yaw [ny], best [ny], arg [ny, 3] (vfov, pitch, roll) like SkyGlobal.grid."""
    vs, ws = skyline(sg.Sc, mode)
    sy = int(round(ystep / astep))
    best = arg = None
    for vf in vfovs:
        O = L.Objective(sg, vf, astep)
        iy = np.arange(0, O.n, sy)
        p, r, _ = fit_pr(O, iy, vs, ws, fit_roll=fit_roll)
        f = O.F(iy, p, r)
        bp, br = p.copy(), r.copy()
        if polish:
            pd = vf / O.h
            for dpp in (-2, -1, 0, 1, 2):
                for drr in (-0.5, 0.0, 0.5):
                    if dpp == 0 and drr == 0:
                        continue
                    pp, rr = np.clip(p + dpp * pd, -15, 15), np.clip(r + drr, -9, 9)
                    g = O.F(iy, pp, rr)
                    b = g > f
                    f = np.where(b, g, f); bp = np.where(b, pp, bp); br = np.where(b, rr, br)
        if best is None:
            best = f.copy(); arg = np.stack([np.full(len(f), vf), bp, br], 1)
        else:
            b = f > best
            best = np.where(b, f, best)
            arg[b] = np.stack([np.full(b.sum(), vf), bp[b], br[b]], 1)
    return np.arange(len(best)) * ystep, best, arg


def strip_profiles(sg, vf, astep, ystep, S=4, mode="arg", polish_px=3):
    """Independent per-strip yaw profiles (pitch per strip by closed form + ±polish_px, roll 0).
    -> yaw [ny], F [S, ny]."""
    vs, ws = skyline(sg.Sc, mode)
    sy = int(round(ystep / astep))
    O = L.Objective(sg, vf, astep)
    iy = np.arange(0, O.n, sy)
    al = np.radians(O.alpha)
    u0 = 0.5 + np.tan(al) / (2 * O.t * O.sg.aspect)
    out = np.zeros((S, len(iy)))
    n60 = O.n60
    for s in range(S):
        cm = (u0 >= s / S) & (u0 < (s + 1) / S)
        p, _, _ = fit_pr(O, iy, vs, ws, colmask=cm, fit_roll=False, iters=((4.0, "h"), (8.0, "t")))
        O.n60 = n60 / S
        best = np.full(len(iy), -np.inf)
        pd = vf / O.h
        for d in range(-polish_px, polish_px + 1):
            best = np.maximum(best, O.F(iy, np.clip(p + d * pd, -15, 15), np.zeros(len(iy)), colmask=cm[None, :]))
        O.n60 = n60
        out[s] = best
    return np.arange(len(iy)) * ystep, out
