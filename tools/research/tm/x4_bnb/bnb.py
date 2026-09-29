"""X4 branch-and-bound over (yaw, pitch, roll) × discrete vfov on the exact SkyGlobal coarse objective.

Boxes: yaw = contiguous range of yaw-grid indices [k0, k1] (yaw = k*ystep, the baseline's yaw grid), pitch [p0, p1],
roll [r0, r1] (continuous, deg), vfov = one of the baseline's vfovs. Upper bound (rigorous, interval arithmetic):
per DEM sample (fixed relative azimuth alpha): elevation range over the yaw range (sparse-table min/max of the
profile) → tangent-plane coords (X, Y) at roll 0 are monotone in tan(e), tan(p) (Y) or bounded by corner/extremum
analysis (X = sin a / (cos a cos p + tan e sin p)) → roll by interval rotation → pixel rectangle → 2-D sparse-table
max of the score map. UB(F) = max(0, Σ contrib) / max(#surely-valid, n60); a sample that may be invalid contributes
max(M, 0), one that is surely out of frame 0. Lower bound = exact F at the box centre.

Goal: the exact per-yaw profile B(k) = max_{p,r,vf} F wherever B(k) >= tau, tau = value of the 2k-th NMS peak
(the only part of the profile SkyGlobal.search's peak picking reads), plus certified gaps.
"""
from __future__ import annotations
import math, time
import numpy as np
import x4lib as L

EPS = 2e-3  # absolute tolerance on F (scores are ~0.2-0.7)


class RectMax:
    def __init__(self, S):
        h, w = S.shape
        self.LY = int(math.floor(math.log2(h))) + 1
        self.LX = int(math.floor(math.log2(w))) + 1
        st = np.full((self.LY, self.LX, h, w), -np.inf, np.float32)
        st[0, 0] = S
        for lx in range(1, self.LX):
            d = 1 << (lx - 1)
            st[0, lx, :, : w - d] = np.maximum(st[0, lx - 1, :, : w - d], st[0, lx - 1, :, d:])
        for ly in range(1, self.LY):
            d = 1 << (ly - 1)
            st[ly, :, : h - d] = np.maximum(st[ly - 1, :, : h - d], st[ly - 1, :, d:])
        self.st = st

    def __call__(self, x0, x1, y0, y1):
        lx = np.floor(np.log2(x1 - x0 + 1)).astype(np.int32)
        ly = np.floor(np.log2(y1 - y0 + 1)).astype(np.int32)
        xb = x1 - (1 << lx) + 1
        yb = y1 - (1 << ly) + 1
        s = self.st
        return np.maximum(np.maximum(s[ly, lx, y0, x0], s[ly, lx, y0, xb]), np.maximum(s[ly, lx, yb, x0], s[ly, lx, yb, xb]))


class Range1D:
    """circular range min/max of the profile over [a, a+W-1] (W <= n)."""

    def __init__(self, prof):
        n = len(prof)
        ext = np.concatenate([prof, prof])
        self.n = n
        L = int(math.floor(math.log2(n))) + 1
        mx = [ext]
        mn = [ext]
        for l in range(1, L):
            d = 1 << (l - 1)
            a, b = mx[-1], mn[-1]
            m1 = np.full_like(ext, -np.inf); m1[: len(ext) - d] = np.maximum(a[: len(ext) - d], a[d:])
            m2 = np.full_like(ext, np.inf); m2[: len(ext) - d] = np.minimum(b[: len(ext) - d], b[d:])
            mx.append(m1); mn.append(m2)
        self.mx, self.mn = np.stack(mx), np.stack(mn)

    def __call__(self, a, W):
        a = a % self.n
        l = np.floor(np.log2(W)).astype(np.int32)
        b = a + W - (1 << l)
        return np.minimum(self.mn[l, a], self.mn[l, b]), np.maximum(self.mx[l, a], self.mx[l, b])


def _imul(a0, a1, b0, b1):
    c = np.stack([a0 * b0, a0 * b1, a1 * b0, a1 * b1])
    return c.min(0), c.max(0)


class BnB:
    def __init__(self, sg, vfovs, astep, ystep, prange=(-15.0, 15.0), rrange=(-9.0, 9.0)):
        self.sg = sg
        self.vfovs = list(vfovs)
        self.astep, self.ystep = astep, ystep
        self.sy = int(round(ystep / astep))
        self.O = [L.Objective(sg, vf, astep) for vf in vfovs]
        self.n = self.O[0].n
        self.ny = len(np.arange(0, self.n, self.sy))
        self.R1 = Range1D(self.O[0].prof)
        self.RM = RectMax(sg.Sc)
        self.h, self.w = sg.Sc.shape
        self.prange, self.rrange = prange, rrange
        self.nbound = 0

    # ---------------------------------------------------------------- bounds
    def bound(self, vi, k0, k1, p0, p1, r0, r1):
        O = self.O[vi]
        B = len(k0)
        self.nbound += B
        ja = O.ja[None, :]
        a0 = k0[:, None] * self.sy + ja
        W = (k1 - k0)[:, None] * self.sy + 1
        emin, emax = self.R1(a0, np.broadcast_to(W, a0.shape))
        eext = (emax - emin).mean(1)
        T0, T1 = np.tan(np.radians(emin)), np.tan(np.radians(emax))
        P0, P1 = np.radians(p0)[:, None], np.radians(p1)[:, None]
        tP0, tP1 = np.tan(P0), np.tan(P1)
        al = np.radians(O.alpha)[None, :]
        c, s = np.cos(al), np.sin(al)
        # D = c cos p + T sin p (> 0 required); min at corners, max possibly interior (p = atan(T/c))
        Dc = np.stack([c * np.cos(P0) + T0 * np.sin(P0), c * np.cos(P1) + T0 * np.sin(P1),
                       c * np.cos(P0) + T1 * np.sin(P0), c * np.cos(P1) + T1 * np.sin(P1)])
        Dmin, Dmax = Dc.min(0), Dc.max(0)
        ph0, ph1 = np.arctan(T0 / c), np.arctan(T1 / c)
        inter = (ph1 >= P0) & (ph0 <= P1)
        Dmax = np.where(inter, np.maximum(Dmax, np.sqrt(c * c + np.maximum(T0 * T0, T1 * T1))), Dmax)
        E0, E1 = np.radians(emin), np.radians(emax)
        zc = np.stack([c * np.cos(E0) * np.cos(P0) + np.sin(E0) * np.sin(P0), c * np.cos(E0) * np.cos(P1) + np.sin(E0) * np.sin(P1),
                       c * np.cos(E1) * np.cos(P0) + np.sin(E1) * np.sin(P0), c * np.cos(E1) * np.cos(P1) + np.sin(E1) * np.sin(P1)])
        zmin = zc.min(0)
        good = Dmin > 1e-6
        Dm = np.where(good, Dmin, 1.0)
        # Y = (T - c P)/(c + T P): increasing in T, decreasing in P
        Ylo = (T0 - c * tP1) / (c + T0 * tP1)
        Yhi = (T1 - c * tP0) / (c + T1 * tP0)
        xa, xb = s / Dmax, s / Dm
        Xlo, Xhi = np.minimum(xa, xb), np.maximum(xa, xb)
        R0, R1 = np.radians(r0)[:, None], np.radians(r1)[:, None]
        cr_lo = np.cos(np.maximum(np.abs(R0), np.abs(R1)))
        cr_hi = np.where((R0 <= 0) & (R1 >= 0), 1.0, np.cos(np.minimum(np.abs(R0), np.abs(R1))))
        sr_lo, sr_hi = np.sin(R0), np.sin(R1)
        a_lo, a_hi = _imul(Xlo, Xhi, cr_lo, cr_hi)
        b_lo, b_hi = _imul(Ylo, Yhi, sr_lo, sr_hi)
        Xr_lo, Xr_hi = a_lo - b_hi, a_hi - b_lo
        c_lo, c_hi = _imul(Ylo, Yhi, cr_lo, cr_hi)
        d_lo, d_hi = _imul(Xlo, Xhi, sr_lo, sr_hi)
        Yr_lo, Yr_hi = c_lo + d_lo, c_hi + d_hi
        k = 2 * O.t * self.sg.aspect
        ulo, uhi = 0.5 + Xr_lo / k - 1e-7, 0.5 + Xr_hi / k + 1e-7
        vlo, vhi = 0.5 - Yr_hi / (2 * O.t) - 1e-7, 0.5 - Yr_lo / (2 * O.t) + 1e-7
        ulo = np.where(good, ulo, 0.0); uhi = np.where(good, uhi, 1.0)
        vlo = np.where(good, vlo, 0.0); vhi = np.where(good, vhi, 1.0)
        poss = (uhi >= 0.01) & (ulo <= 0.99) & (vhi >= 0.01) & (vlo <= 0.99)
        sure = good & (zmin > 0.1 + 1e-9) & (ulo >= 0.01) & (uhi <= 0.99) & (vlo >= 0.01) & (vhi <= 0.99)
        w, h = self.w, self.h
        x0 = np.clip(np.floor(np.maximum(ulo, 0.01) * w), 0, w - 1).astype(np.int32)
        x1 = np.clip(np.floor(np.minimum(uhi, 0.99) * w), 0, w - 1).astype(np.int32)
        y0 = np.clip(np.floor(np.maximum(vlo, 0.01) * h), 0, h - 1).astype(np.int32)
        y1 = np.clip(np.floor(np.minimum(vhi, 0.99) * h), 0, h - 1).astype(np.int32)
        x1 = np.maximum(x1, x0); y1 = np.maximum(y1, y0)
        M = self.RM(x0, x1, y0, y1).astype(np.float64)
        contrib = np.where(poss, np.where(sure, M, np.maximum(M, 0.0)), 0.0)
        ns = sure.sum(1)
        npos = poss.sum(1)
        ub = np.maximum(contrib.sum(1), 0.0) / np.maximum(ns, O.n60)
        ub = np.where(npos > O.cmin, ub + 1e-8, 0.0)
        return ub, eext

    # ---------------------------------------------------------------- search
    def _eval(self, vi, k0, k1, p0, p1, r0, r1):
        ub, eext = self.bound(vi, k0, k1, p0, p1, r0, r1)
        kc = (k0 + k1) // 2
        pc, rc = (p0 + p1) / 2, (r0 + r1) / 2
        lb = self.O[vi].F(kc * self.sy, pc, rc)
        return ub, lb, kc, pc, rc, eext

    def init_pool(self, chunk=8, seed=None):
        ny = self.ny
        self.best = np.full(ny, -np.inf)
        self.arg = np.zeros((ny, 3))
        if seed is not None:  # heuristic per-yaw values: valid lower bounds (exact F at real points)
            self.best[:] = seed[0]
            self.arg[:] = seed[1]
        cols = {n: [] for n in ("vi", "k0", "k1", "p0", "p1", "r0", "r1", "ub", "eext")}
        k0 = np.arange(0, ny, chunk)
        k1 = np.minimum(k0 + chunk - 1, ny - 1)
        m = len(k0)
        for vi in range(len(self.vfovs)):
            self._add(cols, vi, k0, k1, np.full(m, self.prange[0]), np.full(m, self.prange[1]),
                      np.full(m, self.rrange[0]), np.full(m, self.rrange[1]))
        self.pool = {nm: np.concatenate(v) for nm, v in cols.items()}

    def _upd(self, vi, kc, lb, pc, rc):
        order = np.argsort(lb, kind="stable")
        kc, lb, pc, rc = kc[order], lb[order], pc[order], rc[order]
        better = lb > self.best[kc]
        kk = kc[better]
        self.best[kk] = lb[better]  # duplicates: last (= largest) wins
        self.arg[kk, 0] = self.vfovs[vi]
        self.arg[kk, 1] = pc[better]
        self.arg[kk, 2] = rc[better]

    def _add(self, cols, vi, k0, k1, p0, p1, r0, r1):
        ub, lb, kc, pc, rc, eext = self._eval(vi, k0, k1, p0, p1, r0, r1)
        self._upd(vi, kc, lb, pc, rc)
        for nm, v in (("vi", np.full(len(k0), vi)), ("k0", k0), ("k1", k1), ("p0", p0), ("p1", p1), ("r0", r0), ("r1", r1),
                      ("ub", ub), ("eext", eext)):
            cols[nm].append(v)

    def _split(self, idx):
        pool = self.pool
        pdeg = np.array(self.vfovs)[pool["vi"][idx].astype(int)] / self.h
        ppx = (pool["p1"][idx] - pool["p0"][idx]) / pdeg
        rpx = np.radians(pool["r1"][idx] - pool["r0"][idx]) * self.w / 2
        ypx = np.where(pool["k1"][idx] > pool["k0"][idx], np.maximum(pool["eext"][idx] / pdeg, 1.01), 0.0)
        d = np.stack([ypx, ppx, rpx * 0.999]).argmax(0)
        keep = np.ones(len(pool["ub"]), bool)
        keep[idx] = False
        P = {nm: v[idx] for nm, v in pool.items()}
        cols = {nm: [pool[nm][keep]] for nm in pool}
        ym = (P["k0"] + P["k1"]) // 2
        pm = (P["p0"] + P["p1"]) / 2
        rm = (P["r0"] + P["r1"]) / 2
        for side in (0, 1):
            C = {nm: P[nm].copy() for nm in ("vi", "k0", "k1", "p0", "p1", "r0", "r1")}
            if side == 0:
                C["k1"] = np.where(d == 0, ym, C["k1"]); C["p1"] = np.where(d == 1, pm, C["p1"]); C["r1"] = np.where(d == 2, rm, C["r1"])
            else:
                C["k0"] = np.where(d == 0, ym + 1, C["k0"]); C["p0"] = np.where(d == 1, pm, C["p0"]); C["r0"] = np.where(d == 2, rm, C["r0"])
            for vi in np.unique(C["vi"]):
                s = C["vi"] == vi
                self._add(cols, int(vi), *(C[nm][s] for nm in ("k0", "k1", "p0", "p1", "r0", "r1")))
        self.pool = {nm: np.concatenate(v) for nm, v in cols.items()}

    def _terminal(self):
        pool = self.pool
        pdeg = np.array(self.vfovs)[pool["vi"].astype(int)] / self.h
        ppx = (pool["p1"] - pool["p0"]) / pdeg
        rpx = np.radians(pool["r1"] - pool["r0"]) * self.w / 2
        return (pool["k1"] == pool["k0"]) & (ppx <= self.term_ppx) & (rpx <= self.term_rpx)

    def query(self, allowed, stop_above=None, batch=4096):
        """Exact max of B over yaw bins with allowed[k]. Returns (k*, value, certified UB over allowed region).
        stop_above: early exit once some allowed bin has a value > stop_above (used for the local-max test)."""
        ca = np.concatenate([[0], np.cumsum(allowed)])
        while True:
            pool = self.pool
            inter = (ca[pool["k1"] + 1] - ca[pool["k0"]]) > 0
            inc = self.best[allowed].max() if allowed.any() else -np.inf
            if stop_above is not None and inc > stop_above:
                break
            thr = inc + EPS if stop_above is None else min(inc + EPS, stop_above)
            need = inter & (pool["ub"] > thr) & ~self._terminal()
            if not need.any() or time.time() - self.t0 > self.budget:
                if need.any():
                    self.certified = False
                break
            idx = np.flatnonzero(need)
            if len(idx) > batch:
                idx = idx[np.argpartition(-pool["ub"][idx], batch)[:batch]]
            self._split(idx)
        pool = self.pool
        inter = (ca[pool["k1"] + 1] - ca[pool["k0"]]) > 0
        vals = np.where(allowed, self.best, -np.inf)
        kb = int(np.argmax(vals))
        ubr = float(pool["ub"][inter].max()) if inter.any() else -np.inf
        return kb, float(vals[kb]), max(ubr, float(vals[kb]))

    def run(self, k=4, nms=3.0, chunk=8, budget_s=180.0, seed=None, term_ppx=0.5, term_rpx=1.0, max_q=80):
        self.t0 = time.time()
        self.budget = budget_s
        self.certified = True
        self.term_ppx, self.term_rpx = term_ppx, term_rpx
        self.init_pool(chunk, seed)
        ny = self.ny
        yaw = np.arange(ny) * self.ystep
        allowed = np.ones(ny, bool)
        k1, v1, u1 = self.query(allowed)
        out = {"bstar": v1, "bstar_ub": u1, "ystar": float(yaw[k1])}
        dy = np.abs(L.dang(yaw, yaw[k1]))
        _, v3, u3 = self.query(dy > 3.0)
        out.update(gap3=v1 - v3, gap3_cert=v1 - u3)
        peaks = []
        ex = np.zeros(ny, bool)
        nq, first = 2, True
        while len(peaks) < 2 * k and nq < max_q and (~ex).any():
            kb, vb, ub = (k1, v1, u1) if first else self.query(~ex)
            nq += 1
            if not np.isfinite(vb) or vb <= 0:
                break
            if not first and len(peaks) == 1 and "gapN" not in out:
                out.update(gapN=v1 - vb, gapN_cert=v1 - ub)
            first = False
            is_max = True
            for nb in ((kb - 1) % ny, (kb + 1) % ny):
                if ex[nb]:  # neighbour inside a suppressed window: is it higher?
                    m = np.zeros(ny, bool); m[nb] = True
                    _, vn, _ = self.query(m, stop_above=vb)
                    nq += 1
                    if vn > vb:
                        is_max = False
            if is_max:
                peaks.append({"yaw": float(yaw[kb]), "vfov": float(self.arg[kb, 0]), "pitch": float(self.arg[kb, 1]),
                              "roll": float(self.arg[kb, 2]), "coarse": vb, "ub": ub})
                ex |= np.abs(L.dang(yaw, yaw[kb])) < nms
            else:
                ex[kb] = True
        out.update(peaks=peaks, certified=self.certified, nq=nq, pool=len(self.pool["ub"]), nbound=self.nbound,
                   ms=round((time.time() - self.t0) * 1000), yaw=yaw, best=self.best, arg=self.arg)
        return out
