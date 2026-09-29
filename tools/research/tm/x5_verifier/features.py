"""X5 stage B: per-(photo, pose) verifier features from raw/ matches + the C0 cache (no rendering, no matching).

    python features.py [ids...]   -> features.json  (list of rows; see FEATURES below)

A "pose" is a cached view: refs/<label> (correct|wrong), perturb/<tag> (near-miss decoys around the first correct ref),
extra/<tag> (wc_0086 N7, verified-wrong moved-eye HIGH). Ring views are used only for the spread / gain features.
Everything is evaluated AT THE HYPOTHESIS P (the view's own pose, eye, intrinsics) unless stated otherwise.
Grid = the cached half-res xyz grid (native/2). Thresholds fixed a priori (not tuned on labels).
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
TM = HERE.parent
sys.path.insert(0, str(TM))
sys.path.insert(0, str(TM / "c0_cache"))
import tm_common  # noqa: E402
import cache_io as C  # noqa: E402
sys.path.insert(0, str(tm_common.ROOT / "tools/matcher"))
import match as M  # noqa: E402
from common import R_to_pose  # noqa: E402
import skyglobal as SG  # noqa: E402
import cv2  # noqa: E402
from PIL import Image  # noqa: E402
from scipy.stats import binom  # noqa: E402
from scipy.ndimage import binary_dilation, gaussian_filter, sobel  # noqa: E402

RAW = HERE / "raw"
EDGES = tm_common.ROOT / "tools/matcher/v2/.cache/edges"
THR = 6.0            # px (native), service RANSAC threshold
NEAR, FAR = 1000.0, 5000.0
MINB = 12            # min matches for a band solve
D = math.pi / 180


def load_view(pid, g, t):
    if g == "extra":
        vd = HERE / "extra" / pid / t
        rec = json.load(open(vd / "view.json"))
        rec["xyz"] = np.load(vd / "xyz.npz")["xyz"]
        return rec
    rec = json.load(open(C.CACHE / pid / g / t / "view.json"))
    if not rec.get("empty"):
        rec["xyz"] = np.load(C.CACHE / pid / g / t / "xyz.npz")["xyz"]
    return rec


def rot_angle(R1, R2):
    c = (np.trace(R1 @ R2.T) - 1) / 2
    return float(math.degrees(math.acos(max(-1.0, min(1.0, c)))))


def reproj_err(rec, X, x2d, R=None, f=None):
    """Residual (native px) of world X vs photo x2d under the view's hypothesis (or rotation R / focal f)."""
    k = rec["intrinsics"]
    R = C.pose_to_R(rec["pose"]) if R is None else R
    c = (X - np.asarray(rec["eye"], float)) @ R.T
    z = np.maximum(c[:, 2], 1e-9)
    fx, fy = (k["fx"], k["fy"]) if f is None else (f, f)
    u = k["cx"] + fx * c[:, 0] / z
    v = k["cy"] + fy * c[:, 1] / z
    e = np.hypot(u - x2d[:, 0], v - x2d[:, 1])
    e[c[:, 2] <= 0] = np.inf
    return e


def solve(rec, x2d, X, free=False, f0=None, iters=2000):
    W, H = rec["W"], rec["H"]
    f0 = rec["intrinsics"]["fy"] if f0 is None else f0
    if len(x2d) < 6:
        return None
    s = M.solve_rotation(x2d, X, np.asarray(rec["eye"], float), W, H, f0, free, iters=iters, seed=0, thr=THR)
    return s


def coverage(x2d, W, H, nx=4, ny=3, min_pts=3):
    if len(x2d) == 0:
        return 0.0
    gx = np.clip((x2d[:, 0] / W * nx).astype(int), 0, nx - 1)
    gy = np.clip((x2d[:, 1] / H * ny).astype(int), 0, ny - 1)
    cnt = np.bincount(gy * nx + gx, minlength=nx * ny)
    return float((cnt >= min_pts).mean())


# ------------------------------------------------------------------ photo side (once per photo)

class PhotoSide:
    def __init__(self, pid, gh, gw):
        self.pid = pid
        ph = C.load_photo(pid)
        g = np.array(Image.fromarray(ph).convert("L").resize((gw, gh), Image.LANCZOS)).astype(np.float32)
        self.gray = g
        # multi-scale Canny (a priori: sigma 1 and 2, thresholds from the median) + orientation from smoothed Sobel
        E = np.zeros((gh, gw), bool)
        for sg in (1.0, 2.0):
            gs = gaussian_filter(g, sg)
            u8 = np.clip(gs, 0, 255).astype(np.uint8)
            med = float(np.median(u8))
            E |= cv2.Canny(u8, max(5, 0.4 * med * 0.5), max(15, 0.4 * med * 1.2), L2gradient=True) > 0
        self.edge = E
        gs = gaussian_filter(g, 1.5)
        self.theta = np.arctan2(sobel(gs, 0), sobel(gs, 1))  # gradient direction (normal to the edge)
        self.obin = self._bins(self.theta)
        # app photo evidence: fine edge map + pose-free P(sky) (skyglobal port of align.ts)
        z = np.load(EDGES / f"{pid}.npz")
        ed = {"w": z["fine"].shape[1], "h": z["fine"].shape[0], "fine": z["fine"], "coarse": z["coarse"], "fg": z["fg"],
              "rgb": z["rgb"], "dirs": z["dirs"]}
        self.sg = SG.SkyGlobal(ed, json.loads(str(z["meta"]))["aspect"])
        self.sky = np.array(Image.fromarray(self.sg.sky).resize((gw, gh), Image.BILINEAR))
        self.fine = np.array(Image.fromarray(z["fine"]).resize((gw, gh), Image.BILINEAR))
        # photo skyline per column: first row (from top) where P(sky) < 0.5 for 3 consecutive rows
        s = self.sky < 0.5
        run = s[:-2] & s[1:-1] & s[2:]
        has = run.any(0)
        self.sky_row = np.where(has, run.argmax(0), gh).astype(float)
        self._dil = {}

    NB = 8

    def _bins(self, th):
        a = np.mod(th, np.pi)  # orientation mod 180
        return np.minimum((a / np.pi * self.NB).astype(int), self.NB - 1)

    def dil(self, E, obin, r, shift=(0, 0)):
        key = (id(E), r, shift)
        if key not in self._dil:
            out = []
            Es = np.roll(E, shift, (0, 1))
            Os = np.roll(obin, shift, (0, 1))
            st = np.ones((2 * r + 1, 2 * r + 1), bool)
            per = [binary_dilation(Es & (Os == b), st) for b in range(self.NB)]
            for b in range(self.NB):  # accept orientation bins b-1, b, b+1 (±~34°)
                out.append(per[b] | per[(b - 1) % self.NB] | per[(b + 1) % self.NB])
            self._dil[key] = out
        return self._dil[key]


SHIFTS = [(12, 0), (-12, 0), (0, 12), (0, -12), (9, 9), (-9, -9), (9, -9), (-9, 9)]


def render_contours(rec):
    """Interior occluding contours of the render (grid px): near-side pixel of a |Δ log depth| > 0.3 jump between
    4-neighbours, both terrain, near side ≥ 300 m, not within 3 px of sky. Returns mask, jump weight, normal angle,
    near depth, terrain mask, depth."""
    dep = C.depth(rec)
    terr = np.isfinite(dep)
    ld = np.log(np.where(terr, dep, 1.0))
    h, w = dep.shape
    M_ = np.zeros((h, w), bool)
    Wt = np.zeros((h, w))
    for ax in (0, 1):
        a = ld[:-1, :] if ax == 0 else ld[:, :-1]
        b = ld[1:, :] if ax == 0 else ld[:, 1:]
        ta = terr[:-1, :] if ax == 0 else terr[:, :-1]
        tb = terr[1:, :] if ax == 0 else terr[:, 1:]
        j = np.abs(a - b)
        m = ta & tb & (j > 0.3)
        near_a = a < b
        ia = np.zeros((h, w), bool)
        ib = np.zeros((h, w), bool)
        if ax == 0:
            ia[:-1, :] = m & near_a
            ib[1:, :] = m & ~near_a
            ja = np.zeros((h, w)); ja[:-1, :] = np.where(m & near_a, j, 0)
            jb = np.zeros((h, w)); jb[1:, :] = np.where(m & ~near_a, j, 0)
        else:
            ia[:, :-1] = m & near_a
            ib[:, 1:] = m & ~near_a
            ja = np.zeros((h, w)); ja[:, :-1] = np.where(m & near_a, j, 0)
            jb = np.zeros((h, w)); jb[:, 1:] = np.where(m & ~near_a, j, 0)
        M_ |= ia | ib
        Wt = np.maximum(Wt, np.maximum(ja, jb))
    skyd = binary_dilation(~terr, np.ones((7, 7), bool))
    M_ &= ~skyd & (np.where(terr, dep, 0) >= 300)
    # contour normal = log-depth gradient direction (sky filled with a far value)
    ldf = np.where(terr, ld, math.log(2e5))
    ldf = gaussian_filter(ldf, 1.0)
    nth = np.arctan2(sobel(ldf, 0), sobel(ldf, 1))
    return M_, np.minimum(Wt, 1.5), nth, dep, terr


def contour_cov(ps: PhotoSide, cm, wt, nth, r=2, shift=(0, 0)):
    if cm.sum() == 0:
        return np.nan
    dl = ps.dil(ps.edge, ps.obin, r, shift)
    b = ps._bins(nth)
    hit = np.zeros(cm.shape, bool)
    for k in range(ps.NB):
        sel = cm & (b == k)
        hit[sel] = dl[k][sel]
    return float((hit[cm] * wt[cm]).sum() / wt[cm].sum())


def contour_feats(ps, rec):
    cm, wt, nth, dep, terr = render_contours(rec)
    out = {"ctr_n": int(cm.sum())}
    if cm.sum() < 30:
        return {**out, "ctr_cov": np.nan, "ctr_chance": np.nan, "ctr_lift": np.nan, "ctr_cov_near": np.nan,
                "ctr_cov_far": np.nan, "ctr_lift_near": np.nan, "ctr_lift_far": np.nan, "edge_explained": np.nan}
    cov = contour_cov(ps, cm, wt, nth)
    ch = float(np.nanmean([contour_cov(ps, cm, wt, nth, shift=s) for s in SHIFTS]))
    out.update({"ctr_cov": cov, "ctr_chance": ch, "ctr_lift": cov - ch})
    for nm, sel in (("near", dep < 2000), ("far", dep > FAR)):
        c2 = cm & sel
        if c2.sum() >= 30:
            cv = contour_cov(ps, c2, wt, nth)
            chv = float(np.nanmean([contour_cov(ps, c2, wt, nth, shift=s) for s in SHIFTS[:4]]))
            out[f"ctr_cov_{nm}"], out[f"ctr_lift_{nm}"] = cv, cv - chv
        else:
            out[f"ctr_cov_{nm}"], out[f"ctr_lift_{nm}"] = np.nan, np.nan
    # converse: strong photo edges in the rendered terrain (away from skyline) explained by a rendered contour (r=2)
    cd = binary_dilation(cm, np.ones((5, 5), bool))
    skyd = binary_dilation(~terr, np.ones((7, 7), bool))
    pe = ps.edge & terr & ~skyd
    if pe.sum() > 50:
        ex = cd[pe].mean()
        chs = np.mean([np.roll(cd, s, (0, 1))[pe].mean() for s in SHIFTS[:4]])
        out["edge_explained"] = float(ex - chs)
    else:
        out["edge_explained"] = np.nan
    return out


def skyline_feats(ps, rec):
    terr = (rec["xyz"] != 0).any(-1)
    h, w = terr.shape
    top_sky = ~terr[0]
    has_t = terr.any(0)
    cols = np.nonzero(top_sky & has_t)[0]
    out = {"sky_cols": float(len(cols) / w)}
    if len(cols) < 0.1 * w:
        return {**out, "sky_med": np.nan, "sky_frac3": np.nan, "sky_edge": np.nan}
    sr = terr[:, cols].argmax(0).astype(float)
    sp = ps.sky_row[cols]
    d = np.abs(sr - sp)
    out["sky_med"] = float(np.median(d))
    out["sky_frac3"] = float((d <= 3).mean())
    Ed = binary_dilation(ps.edge, np.ones((3, 3), bool))
    ri = np.clip(sr.astype(int), 0, h - 1)
    out["sky_edge"] = float(Ed[ri, cols].mean())
    return out


# ------------------------------------------------------------------ ring hypotheses (once per photo)

def ring_solves(pid, meta):
    out = []
    for v in meta["views"]["ring"]:
        if v.get("empty"):
            continue
        f = RAW / pid / f"ring__{v['tag']}.npz"
        if not f.exists():
            continue
        z = np.load(f)
        ok = z["ok"]
        x2d, X = z["x2d"][ok].astype(float), z["X"][ok]
        rec = load_view(pid, "ring", v["tag"])
        f0 = (rec["H"] / 2) / math.tan(meta["vfov0"] * D / 2)
        s = solve(rec, x2d, X, free=not meta["focal_known"], f0=f0, iters=1500)
        if s is None:
            out.append({"tag": v["tag"], "inl": 0})
            continue
        p = R_to_pose(s["R"], 0)
        out.append({"tag": v["tag"], "inl": int(s["inliers"].sum()), "yaw": p["yaw"], "pitch": p["pitch"], "R": s["R"]})
    return out


def dyaw(a, b):
    return abs((a - b + 540) % 360 - 180)


def spread_feats(rs, pose, inl_hyp):
    good = [r for r in rs if r["inl"] >= 15]
    near = [r["inl"] for r in good if dyaw(r["yaw"], pose["yaw"]) <= 10]
    comp = [r["inl"] for r in good if dyaw(r["yaw"], pose["yaw"]) > 20]
    sup = max(near, default=0)
    cmp_ = max(comp, default=0)
    top = max([r["inl"] for r in good], default=0)
    # SUE-style dispersion: circular spread of solved yaws within 80 % of the top ring support (per photo)
    ys = [r["yaw"] for r in good if r["inl"] >= 0.8 * top] if top else []
    if ys:
        a = np.radians(ys)
        R_ = math.hypot(np.cos(a).mean(), np.sin(a).mean())
        disp = math.degrees(math.sqrt(max(0.0, -2 * math.log(max(R_, 1e-9)))))
    else:
        disp = np.nan
    return {"ring_sup": sup, "ring_comp": cmp_, "ring_top": top,
            "ring_comp_ratio": math.log((cmp_ + 10) / (sup + 10)),       # competitor basin vs own basin in the ring
            "hyp_vs_comp": math.log((inl_hyp + 10) / (cmp_ + 10)),       # hypothesis inliers vs best other basin
            "rematch_gain": math.log((inl_hyp + 10) / (sup + 10)),       # (5) exact-pose render vs coarse ring render
            "sue_disp": disp, "sue_n": len(ys)}


# ------------------------------------------------------------------ per pose

def band_feats(rec, x2d, X, dep):
    out = {}
    bands = {"near": dep < NEAR, "mid": (dep >= NEAR) & (dep < FAR), "far": dep >= FAR}
    RP = C.pose_to_R(rec["pose"])
    own = {}
    for b, m in bands.items():
        out[f"n_{b}"] = int(m.sum())
        e = reproj_err(rec, X[m], x2d[m])
        out[f"rate_hyp_{b}"] = float((e < THR).mean()) if m.sum() >= MINB else np.nan
        own[b] = solve(rec, x2d[m], X[m], iters=1000) if m.sum() >= MINB else None
        if own[b] is not None:
            out[f"rot_{b}_vs_hyp"] = rot_angle(own[b]["R"], RP)
            out[f"rate_own_{b}"] = float(own[b]["inliers"].mean())
    # (1) far-solve -> residuals of mid/near under the far rotation (fixed hypothesis focal)
    f = rec["intrinsics"]["fy"]
    for src, dsts in (("far", ("mid", "near")), ("mid", ("near",))):
        s = own.get(src)
        for d in dsts:
            m = bands[d]
            if s is None or m.sum() < MINB or own.get(d) is None:
                out[f"xfer_{src}_{d}"] = np.nan
                out[f"rot_{src}_{d}"] = np.nan
                out[f"res_{src}_{d}"] = np.nan
                continue
            e = reproj_err(rec, X[m], x2d[m], R=s["R"], f=f)
            eo = reproj_err(rec, X[m], x2d[m], R=own[d]["R"], f=f)
            ro = (eo < THR).mean()
            out[f"xfer_{src}_{d}"] = float((e < THR).mean() / max(ro, 1e-6))
            out[f"rot_{src}_{d}"] = rot_angle(s["R"], own[d]["R"])
            out[f"res_{src}_{d}"] = float(np.median(e[eo < THR])) if (eo < THR).any() else np.nan
    # post-hoc-free variant with always-available bands: split hypothesis inliers at their median depth
    e = reproj_err(rec, X, x2d)
    inl = e < THR
    if inl.sum() >= 2 * MINB:
        md = np.median(dep[inl])
        lo, hi = inl & (dep < md), inl & (dep >= md)
        # use all lifted matches in each half (not only inliers) so a wrong hypothesis cannot pre-select them
        lo_all, hi_all = dep < md, dep >= md
        sh = solve(rec, x2d[hi_all], X[hi_all], iters=1000)
        sl = solve(rec, x2d[lo_all], X[lo_all], iters=1000)
        if sh is not None and sl is not None:
            out["q_rot_far_near"] = rot_angle(sh["R"], sl["R"])
            e1 = reproj_err(rec, X[lo_all], x2d[lo_all], R=sh["R"], f=f)
            e2 = reproj_err(rec, X[lo_all], x2d[lo_all], R=sl["R"], f=f)
            out["q_xfer"] = float((e1 < THR).mean() / max((e2 < THR).mean(), 1e-6))
        out["q_depth_ratio"] = float(np.median(dep[hi]) / max(np.median(dep[lo]), 1.0))
    for k in ("q_rot_far_near", "q_xfer", "q_depth_ratio"):
        out.setdefault(k, np.nan)
    return out


def nfa(n, k, W, H, n_tests):
    """log10 NFA of k of n matches landing within THR px of their prediction by chance (uniform background)."""
    if n == 0 or k == 0:
        return 0.0
    p = math.pi * THR ** 2 / (W * H)
    ls = binom.logsf(k - 1, n, p)
    if not math.isfinite(ls):  # underflow: Chernoff bound -n KL(k/n || p)
        q = k / n
        ls = -n * (q * math.log(q / p) + ((1 - q) * math.log((1 - q) / (1 - p)) if q < 1 else 0.0))
    return float((math.log(n_tests) + ls) / math.log(10))


def pnp_feats(rec, x2d, X, inl_rot):
    import poselib
    out = {"pnp_rel": np.nan, "pnp_rel10": np.nan, "pnp_shift": np.nan, "pnp_up": np.nan, "pnp_dist": np.nan, "pnp_up_abs": np.nan, "pnp_gain": np.nan, "pnp_inl": 0}
    if len(X) < 12:
        return out
    k = rec["intrinsics"]
    cam = {"model": "PINHOLE", "width": rec["W"], "height": rec["H"], "params": [k["fx"], k["fy"], k["cx"], k["cy"]]}
    eye = np.asarray(rec["eye"], float)
    pose, info = poselib.estimate_absolute_pose(x2d - 0.0, X - eye, cam, {"max_reproj_error": THR, "max_iterations": 5000,
                                                                          "min_iterations": 500}, {})
    inl = np.array(info["inliers"], bool)
    if inl.sum() < 6:
        return out
    Cc = -pose.R.T @ pose.t
    dep = np.linalg.norm(X[inl] - eye, axis=1)
    # (post hoc, after seeing raw pnp_dist: far-only scenes make the centre ill-conditioned) parallax-normalised shift
    out["pnp_rel"] = float(np.linalg.norm(Cc) / np.median(dep))
    out["pnp_rel10"] = float(np.linalg.norm(Cc) / np.percentile(dep, 10))
    out.update({"pnp_shift": float(np.hypot(Cc[0], Cc[1])), "pnp_up": float(Cc[2]), "pnp_dist": float(np.linalg.norm(Cc)), "pnp_up_abs": float(abs(Cc[2])), "pnp_inl": int(inl.sum()),
                "pnp_gain": math.log((inl.sum() + 10) / (inl_rot + 10))})
    return out


def pose_feats(pid, meta, g, t, ps, rs):
    rec = load_view(pid, g, t)
    z = np.load(RAW / pid / f"{g}__{t}.npz")
    ok = z["ok"]
    n_match = int(len(ok))
    x2d, X = z["x2d"][ok].astype(float), z["X"][ok]
    W, H = rec["W"], rec["H"]
    eye = np.asarray(rec["eye"], float)
    dep = np.linalg.norm(X - eye, axis=1) if len(X) else np.zeros(0)
    e = reproj_err(rec, X, x2d) if len(X) else np.zeros(0)
    inl = e < THR
    k = int(inl.sum())
    row = {"n_match": n_match, "n_lift": int(ok.sum()), "inl_hyp": k, "frac_hyp": float(k / max(1, len(X))),
           "cov_hyp": coverage(x2d[inl], W, H), "log_inl": math.log(k + 1),
           "med_depth_inl": float(np.median(dep[inl])) if k else np.nan,
           "frac_far_inl": float((dep[inl] >= FAR).mean()) if k else np.nan,
           "frac_near_inl": float((dep[inl] < NEAR).mean()) if k else np.nan,
           "rmse_hyp": float(np.sqrt(np.mean(e[inl] ** 2))) if k else np.nan}
    s = solve(rec, x2d, X) if len(X) >= 6 else None
    row["hyp_drift"] = rot_angle(s["R"], C.pose_to_R(rec["pose"])) if s is not None else np.nan
    row["inl_solve"] = int(s["inliers"].sum()) if s is not None else 0
    # (1b, added after the first look at band features — label post hoc) free-centre check: 6-DoF PnP (hypothesis
    # focal) vs the fixed-eye rotation solve. A wrong eye should buy inliers by moving the centre.
    row.update(pnp_feats(rec, x2d, X, row["inl_solve"]))
    row["log10_nfa"] = nfa(len(X), k, W, H, 1)
    row["log10_nfa_per_match"] = row["log10_nfa"] / max(1, len(X))
    row.update(band_feats(rec, x2d, X, dep) if len(X) else {})
    row.update(contour_feats(ps, rec))
    row.update(skyline_feats(ps, rec))
    row["sg_score"] = float(ps.sg.score_pose(rec["pose"], fine=True))
    row.update(spread_feats(rs, rec["pose"], k))
    return row


def label_of(meta, g, t):
    if g == "refs":
        return "correct" if t in {r["label"] for r in meta["correct_refs"]} else "wrong"
    if g == "perturb":
        return "perturb"
    if g == "extra":
        return {"N7": "wrong", "T8": "unlabelled"}[t]
    return None


def main(ids):
    out = []
    fj = HERE / "features.json"
    old = {(r["pid"], r["group"], r["tag"]): r for r in json.load(open(fj))} if fj.exists() and ids else {}
    for pid in ids or tm_common.dev_ids():
        tm_common.assert_dev(pid)
        meta = C.load_meta(pid)
        r0 = load_view(pid, "ring", meta["views"]["ring"][0]["tag"])
        gh, gw = r0["xyz"].shape[:2]
        ps = PhotoSide(pid, gh, gw)
        rs = ring_solves(pid, meta)
        todo = [("refs", r["label"]) for r in meta["correct_refs"] + meta["wrong_refs"]]
        todo += [("perturb", v["tag"]) for v in meta["views"].get("perturb", [])]
        if (HERE / "extra" / pid).exists():
            todo += [("extra", d.name) for d in sorted((HERE / "extra" / pid).iterdir())]
        for g, t in todo:
            if not (RAW / pid / f"{g}__{t}.npz").exists():
                print("missing raw", pid, g, t, flush=True)
                continue
            rec = load_view(pid, g, t)
            if g == "extra" and rec["xyz"].shape[:2] != (gh, gw):
                ps_ = PhotoSide(pid, *rec["xyz"].shape[:2])
            else:
                ps_ = ps
            row = {"pid": pid, "group": g, "tag": t, "label": label_of(meta, g, t), "pose": rec["pose"],
                   "eyeZ": rec["eye"][2], "focal_known": meta["focal_known"], "n_ring": len(rs)}
            row.update(pose_feats(pid, meta, g, t, ps_, rs))
            out.append(row)
            print(pid, g, t, row["label"], "inl", row["inl_hyp"], "drift", round(row["hyp_drift"], 2) if row["hyp_drift"] == row["hyp_drift"] else None,
                  "ctr_lift", None if row["ctr_lift"] != row["ctr_lift"] else round(row["ctr_lift"], 3), flush=True)
            old.pop((pid, g, t), None)
    out = list(old.values()) + out
    json.dump(clean(out), open(fj, "w"), indent=0)


def clean(o):
    if isinstance(o, dict):
        return {k: clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    if isinstance(o, (bool, np.bool_)):
        return bool(o)
    if isinstance(o, (int, np.integer)):
        return int(o)
    if isinstance(o, (float, np.floating)):
        return float(o) if math.isfinite(o) else None
    return o


if __name__ == "__main__":
    main(sys.argv[1:])
