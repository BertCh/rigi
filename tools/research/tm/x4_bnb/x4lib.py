"""X4 shared helpers: load the cached pose-free edge maps, the exact SkyGlobal coarse-grid objective vectorised over
arbitrary (yaw bin, pitch, roll) triples, the SkyGlobal peak→refine→dedup tail, and the ref hit metric.

Objective F (identical to SkyGlobal.grid for one pose): with prof = horizon_profile(dirs, astep), samples ja in
[-J, J] (J = int((hf/2*1.25+3)/astep)), alpha = ja*astep, El = prof[(iy+ja) % n], project_rel(alpha, El, p, r, vf):
    F = sum_{valid} Sc[y, x] / max(cnt, n60)     (n60 = n*(vf*aspect/360)*0.6; F = 0 if cnt <= max(3, 0.9/astep))
which equals SkyGlobal's  mean * min(cnt/n60, 1).
"""
from __future__ import annotations
import json, math, sys, time
from pathlib import Path
import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import tm_common  # noqa: E402
import skyglobal as SG  # noqa: E402
import refs as REFS  # noqa: E402

EDGES = tm_common.ROOT / "tools/matcher/v2/.cache/edges"
WRONG_BASIN = ["wc_0001", "wc_0069", "wc_0070", "wc_0074"]


def dang(a, b):
    return (np.asarray(a) - b + 540.0) % 360.0 - 180.0


def rot_dirs(dirs, delta):
    """Rotate ENU unit dirs so that every azimuth decreases by delta deg (az' = az - delta)."""
    a = math.radians(delta)
    c, s = math.cos(a), math.sin(a)
    # az = atan2(x, y) (clockwise from north). az - delta: rotate (x, y) by +delta counter-clockwise in (y, x) sense
    x, y = dirs[:, 0], dirs[:, 1]
    return np.stack([x * c - y * s, x * s + y * c, dirs[:, 2]], 1)


def load(pid, yaw_shift=0.0):
    """-> (SkyGlobal, meta). yaw_shift: DEM azimuths rotated by -yaw_shift (grid phase test); add it back to yaws."""
    tm_common.assert_dev(pid)
    z = np.load(EDGES / f"{pid}.npz")
    m = json.loads(str(z["meta"]))
    dirs = z["dirs"] if not yaw_shift else rot_dirs(z["dirs"], yaw_shift)
    ed = {"w": z["fine"].shape[1], "h": z["fine"].shape[0], "fine": z["fine"], "coarse": z["coarse"], "fg": z["fg"],
          "rgb": z["rgb"], "dirs": dirs}
    return SG.SkyGlobal(ed, m["aspect"]), m


def hfov(vf, aspect):
    return 2 * math.degrees(math.atan(math.tan(math.radians(vf) / 2) * aspect))


def vfov_of(hf, aspect):
    return 2 * math.degrees(math.atan(math.tan(math.radians(hf) / 2) / aspect))


def default_vfovs(v0, fk, aspect):
    if fk:
        return [v0 * s for s in (0.94, 1.0, 1.06)]
    return [vfov_of(hf, aspect) for hf in (35, 45, 55, 65, 75)]


def grid_params(sg, vfovs):
    """astep / ystep exactly as SkyGlobal.grid."""
    vmax = max(vfovs)
    hmax = hfov(vmax, sg.aspect)
    astep = max(0.1, min(0.5, hmax / 120))
    ystep = max(astep, round(0.5 / astep) * astep)
    return astep, ystep


class Objective:
    """The SkyGlobal coarse-grid objective, vectorised over (iy, p, r) for one vfov."""

    def __init__(self, sg, vf, astep, S=None):
        self.sg, self.vf, self.astep = sg, vf, astep
        self.S = sg.Sc if S is None else S
        self.h, self.w = self.S.shape
        self.prof = SG.horizon_profile(sg.dirs, astep)
        self.n = len(self.prof)
        hf = hfov(vf, sg.aspect)
        half = hf / 2 * 1.25 + 3
        J = int(half / astep)
        self.ja = np.arange(-J, J + 1)
        self.alpha = self.ja * astep
        self.n60 = self.n * ((vf * sg.aspect / 360) * 0.6)
        self.cmin = max(3, 0.9 / astep)
        self.t = math.tan(math.radians(vf) / 2)

    def project(self, El, p, r, alpha=None):
        """project_rel with per-row pitch/roll arrays (deg). El [B, na]; p, r [B]."""
        a = np.radians(self.alpha if alpha is None else alpha)
        e = np.radians(El)
        dx, dy, dz = np.sin(a) * np.cos(e), np.cos(a) * np.cos(e), np.sin(e)
        P = np.radians(np.asarray(p, float))[:, None]
        R = np.radians(np.asarray(r, float))[:, None]
        sp, cp, sr, cr = np.sin(P), np.cos(P), np.sin(R), np.cos(R)
        # r0=(1,0,0), u0=(0,-sp,cp); rvec = r0*cr - u0*sr ; uvec = u0*cr + r0*sr ; fwd=(0,cp,sp)
        rx, ry, rz = cr, sp * sr, -cp * sr
        ux, uy, uz = sr, -sp * cr, cp * cr
        z = dy * cp + dz * sp
        zs = np.where(z > 0.1, z, 1.0)
        u = 0.5 + (dx * rx + dy * ry + dz * rz) / zs / (self.t * self.sg.aspect) / 2
        v = 0.5 - (dx * ux + dy * uy + dz * uz) / zs / self.t / 2
        ok = (z > 0.1) & (u >= 0.01) & (u <= 0.99) & (v >= 0.01) & (v <= 0.99)
        return u, v, ok

    def F(self, iy, p, r, colmask=None, chunk=4096):
        """Exact objective at integer yaw bins iy (yaw = iy*astep), pitch p, roll r (arrays of equal length)."""
        iy = np.asarray(iy, int)
        p = np.broadcast_to(np.asarray(p, float), iy.shape)
        r = np.broadcast_to(np.asarray(r, float), iy.shape)
        out = np.empty(len(iy), np.float64)
        for s in range(0, len(iy), chunk):
            sl = slice(s, s + chunk)
            El = self.prof[(iy[sl, None] + self.ja[None, :]) % self.n]
            u, v, ok = self.project(El, p[sl], r[sl])
            if colmask is not None:
                ok = ok & colmask
            x = np.clip(np.floor(u * self.w).astype(np.int32), 0, self.w - 1)
            y = np.clip(np.floor(v * self.h).astype(np.int32), 0, self.h - 1)
            val = np.where(ok, self.S[y, x], 0.0).sum(1)
            cnt = ok.sum(1)
            f = val / np.maximum(cnt, self.n60)
            out[sl] = np.where(cnt > self.cmin, f, 0.0)
        return out


def peaks_from_profile(yaw, best, arg, nms, k):
    """SkyGlobal.search peak picking (local max on the circular yaw profile, greedy NMS), 2k peaks."""
    order = np.argsort(-best, kind="stable")
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
    return peaks


def finish(sg, peaks, vfov0, fk, k=4):
    """SkyGlobal.search tail: coarse→fine refine of each peak, sort by fine score, 1° dedup, top-k."""
    hyps = []
    for pk in peaks:
        st = {k2: pk[k2] for k2 in ("yaw", "pitch", "roll", "vfov")}
        p1, _ = sg.refine(st, vfov0 if fk else None, 0.08, fine=False)
        p2, s2 = sg.refine(p1, vfov0 if fk else None, 0.08, fine=True)
        hyps.append({"pose": {k2: float(v) for k2, v in p2.items()}, "score": float(s2), "coarse": pk["coarse"]})
    hyps.sort(key=lambda h: -h["score"])
    out = []
    for hy in hyps:
        if all(abs(((hy["pose"]["yaw"] - q["pose"]["yaw"] + 540) % 360) - 180) >= 1.0 for q in out):
            out.append(hy)
    return out[:k]


def nms_deg(vfov0, aspect):
    return max(3.0, 0.25 * hfov(vfov0, aspect))


def ref_dists(hyps_poses, pid):
    R = REFS.correct_refs(pid)
    if not R:
        return None
    return [float(min(abs(dang(h["yaw"], q["pose"]["yaw"])) + abs(h["pitch"] - q["pose"]["pitch"]) for q in R)) for h in hyps_poses]


def wrong_dists(hyps_poses, pid):
    R = REFS.wrong_refs(pid)
    if not R:
        return None
    return [float(min(abs(dang(h["yaw"], q["pose"]["yaw"])) + abs(h["pitch"] - q["pose"]["pitch"]) for q in R)) for h in hyps_poses]


def auroc(scores, labels):
    """P(score_pos > score_neg) with ties 0.5; labels True = positive."""
    s = np.asarray(scores, float)
    l = np.asarray(labels, bool)
    pos, neg = s[l], s[~l]
    if len(pos) == 0 or len(neg) == 0:
        return None
    g = (pos[:, None] > neg[None, :]).sum() + 0.5 * (pos[:, None] == neg[None, :]).sum()
    return float(g / (len(pos) * len(neg)))
