"""Joint skyline + render-match pose solve (rotation + focal), with agreement-based confidence.

Library use:
    sk = load_skyline("IMG_7155", shift=0); c = load_corr("IMG_7155", "s0")
    res = solve_photo("IMG_7155", shift=0)          # dict with skyline / match / fused poses + confidence
CLI:
    python fusion.py [IDs] [--lam 1.0] [--tag default]  -> out/results/fusion_<tag>.json

Model (all residuals in pixels of the render-resolution image, W×H ≈ 1024×768):
  params  yaw, pitch, roll (deg), log f (f = focal px); camera centre fixed at the app's eye.
  (a) skyline term: for every edge-map column the topmost projected DEM-horizon direction
      (engine.horizonDirs) is associated (ICP-style) with the best row of the app's own
      skyline score within ±win rows — score(y) = 0.5·edge.fine + (mean P(sky) in the band above
      − mean P(sky) in the band below), the per-point integrand of align.ts scorePose() with the
      same band/gap sizes. Residual = projected row − associated row. Columns with no evidence
      (max score < SKY_MIN) or under the people mask are skipped. Association is redone every
      outer iteration with a shrinking window (WINS).
  (b) match term: ALIKED+LightGlue photo↔satellite-render matches lifted through the render's
      XYZ buffer; residual = reprojection error. Gated per outer iteration (|r| < GATES[i]).
  Both terms: Huber (k = 1.345) on r/σ_t, σ_t = 1.4826·MAD of that term's residuals at the
  current pose (floored at SIGMA_FLOOR), and each term is divided by sqrt(N_t) so each term has
  equal total weight regardless of how many residuals it has; the match term is multiplied by
  sqrt(lam) (lam = 1 by default; not tuned). Plus a weak EXIF focal prior (5 %).
Confidence (a priori rule, fixed before looking at fused results):
  d_agree = rotation angle between the skyline-only (app autoAlign) and match-only solutions;
  sky_med = median |skyline residual| and match_support = share of lifted matches within 6 px,
  both at the fused pose. HIGH iff d_agree < 1° and sky_med < 4 px and match_support ≥ 0.3.
"""
from __future__ import annotations

import argparse
import json
import math
import time
from pathlib import Path

import numpy as np
from scipy.optimize import least_squares
from scipy.spatial.transform import Rotation

from common import HERE, R_to_pose, focal_px, load_meta, pose_to_R, score, vfov_from_f

SKY_DIR = HERE / "out" / "skyline"
CORR_DIR = HERE / "out" / "corr"
HUBER_K = 1.345
SIGMA_FLOOR = {"sky": 1.0, "match": 1.0}  # px
WINS = (24, 12, 6, 6)  # skyline association half-window, edge-map rows, per outer iteration
GATES = (30.0, 15.0, 8.0, 8.0)  # match gate, px, per outer iteration
SKY_MIN = 0.15  # min app skyline score for a column to count as evidence
FOCAL_SIGMA = 0.05
SUPPORT_PX = 6.0
SHIFTS = {0: "s0", 15: "s15", -15: "s-15"}


# ---------- inputs ----------

def skyline_from_arrays(w, h, fine, fg, sky, dirs, app=None, meta=None, shift=0) -> dict:
    """Skyline cue from the app's exported arrays (edge.fine, edge.fg, edge.sky, horizonDirs)."""
    fine = np.asarray(fine, np.float32).reshape(h, w)
    fg = np.asarray(fg, np.float32).reshape(h, w)
    sky = np.asarray(sky, np.float32).reshape(h, w)
    dirs = np.asarray(dirs, np.float64).reshape(-1, 3)
    # per-pixel skyline score, the integrand of align.ts scorePose (fine variant)
    band = max(2, round(h * 0.035))
    gap = max(1, round(h * 0.006))
    cum = np.vstack([np.zeros((1, w)), np.cumsum(sky, 0)])
    ys = np.arange(h)
    a0 = np.clip(ys - gap - band, 0, h)
    a1 = np.clip(ys - gap, 0, h)
    b0 = np.clip(ys + gap, 0, h)
    b1 = np.clip(ys + gap + band, 0, h)
    with np.errstate(invalid="ignore", divide="ignore"):
        above = np.where((a1 > a0)[:, None], (cum[a1] - cum[a0]) / np.maximum(a1 - a0, 1)[:, None], 0.5)
        below = np.where((b1 > b0)[:, None], (cum[b1] - cum[b0]) / np.maximum(b1 - b0, 1)[:, None], 0.5)
    S = (0.5 * fine + (above - below)) * (1 - fg)
    return {"w": w, "h": h, "S": S, "fg": fg, "dirs": dirs, "meta": meta, "shift": shift, "app": app}


def load_skyline(pid: str, shift: int = 0) -> dict:
    m = json.loads((SKY_DIR / f"{pid}.json").read_text())
    rd = lambda n: np.fromfile(SKY_DIR / f"{pid}_{n}.f32", np.float32)  # noqa: E731
    return skyline_from_arrays(m["w"], m["h"], rd("fine"), rd("fg"), rd(f"sky{shift}"), rd("horizon"),
                               app=m["shifts"][str(shift)], meta=m, shift=shift)


def load_corr(pid: str, scen: str) -> dict | None:
    f = CORR_DIR / f"{pid}_{scen}.npz"
    if not f.exists():
        return None
    z = np.load(f)
    return {"x2d": z["x2d"].astype(np.float64), "X": z["X"], "W": int(z["W"]), "H": int(z["H"])}


# ---------- projection ----------

def params_to_pose(x) -> dict:
    return {"yaw": x[0], "pitch": x[1], "roll": x[2], "f": math.exp(x[3])}


def project_dirs(x, D, W, H):
    p = params_to_pose(x)
    R = pose_to_R({**p, "vfov": 0})
    c = D @ R.T
    z = c[:, 2]
    zs = np.where(z > 1e-6, z, 1e-6)
    return W / 2 + p["f"] * c[:, 0] / zs, H / 2 + p["f"] * c[:, 1] / zs, z


def pose_from_x(x, H) -> dict:
    p = params_to_pose(x)
    return {"yaw": p["yaw"] % 360, "pitch": p["pitch"], "roll": p["roll"], "vfov": vfov_from_f(p["f"], H)}


def x_from_pose(pose: dict, H) -> np.ndarray:
    return np.array([pose["yaw"], pose["pitch"], pose["roll"], math.log(focal_px(pose["vfov"], H))])


# ---------- terms ----------

def sky_curve(x, sk, W, H, cu):
    """Rendered skyline row (render px) at photo columns `cu` (render px): the topmost crossing of
    the projected DEM-horizon polyline (horizonDirs are in azimuth order). inf where none."""
    u, v, z = project_dirs(x, sk["dirs"], W, H)
    u0, u1, v0, v1 = u[:-1], u[1:], v[:-1], v[1:]
    ok = (z[:-1] > 0.1) & (z[1:] > 0.1) & (np.abs(u1 - u0) < 0.05 * W) & (np.maximum(u0, u1) > -0.05 * W) & (np.minimum(u0, u1) < 1.05 * W)
    # fast path (identical result): consecutive valid segments forming one chain with u strictly
    # increasing can't overlap, so the topmost crossing at a column is the linear interpolation
    idx = np.nonzero(ok)[0]
    if len(idx) >= 2 and np.all(np.diff(idx) == 1):
        uu = np.r_[u0[idx], u1[idx[-1]]]
        vv = np.r_[v0[idx], v1[idx[-1]]]
        if np.all(np.diff(uu) > 0):
            out = np.interp(cu, uu, vv)
            out[(cu < uu[0]) | (cu >= uu[-1])] = np.inf
            return out
    u0, u1, v0, v1 = u0[ok], u1[ok], v0[ok], v1[ok]
    lo, hi = np.minimum(u0, u1), np.maximum(u0, u1)
    m = (lo[:, None] <= cu[None, :]) & (cu[None, :] < hi[:, None])
    t = (cu[None, :] - u0[:, None]) / np.where(u1 - u0 == 0, 1e-9, u1 - u0)[:, None]
    vv = np.where(m, v0[:, None] + t * (v1 - v0)[:, None], np.inf)
    return vv.min(axis=0) if len(vv) else np.full(len(cu), np.inf)


def sky_associate(x, sk, W, H, win):
    """Per edge-map column: associate the rendered skyline row with the best row of the app's
    skyline score within ±win rows. Returns (column centres in render px, target rows, n in view)."""
    w, h = sk["w"], sk["h"]
    cols = np.arange(w)
    cu = (cols + 0.5) / w * W
    rows = sky_curve(x, sk, W, H, cu)
    inview = np.isfinite(rows) & (rows > 0.01 * H) & (rows < 0.99 * H)
    keep, tgt = [], []
    for cx in cols[inview]:
        y0 = int(rows[cx] / H * h)
        if sk["fg"][min(max(y0, 0), h - 1), cx] > 0.3:
            continue
        lo, hi = max(0, y0 - win), min(h - 1, y0 + win)
        sc = sk["S"][lo:hi + 1, cx]
        k = int(np.argmax(sc))
        if sc[k] < SKY_MIN:
            continue
        off = 0.0
        if 0 < k < len(sc) - 1:
            den = sc[k - 1] - 2 * sc[k] + sc[k + 1]
            if den < 0:
                off = 0.5 * (sc[k - 1] - sc[k + 1]) / den
        keep.append(cu[cx])
        tgt.append((lo + k + off + 0.5) / h * H)
    return np.array(keep), np.array(tgt), int(inview.sum())


def sky_resid(x, sk, W, H, cu, tgt):
    r = sky_curve(x, sk, W, H, cu) - tgt
    return np.where(np.isfinite(r), r, 50.0)


def match_resid(x, c, eye):
    D = c["X"] - eye
    D = D / np.linalg.norm(D, axis=1, keepdims=True)
    u, v, z = project_dirs(x, D, c["W"], c["H"])
    r = np.stack([u - c["x2d"][:, 0], v - c["x2d"][:, 1]], 1)
    r[z <= 0] = 1e4
    return r


def robust_sigma(r, floor):
    if len(r) == 0:
        return floor
    return max(floor, 1.4826 * float(np.median(np.abs(r - np.median(r)))))


def huber_sqrt_w(rn):
    """sqrt of IRLS Huber weights for normalised residuals."""
    a = np.abs(rn)
    return np.sqrt(np.where(a <= HUBER_K, 1.0, HUBER_K / np.maximum(a, 1e-12)))


def solve(x0, W, H, f0, sk=None, c=None, eye=None, lam=1.0, use_sky=True, use_match=True, iters=len(WINS), sigma=None):
    """Outer loop: re-associate skyline, re-gate matches, IRLS Huber weights; inner: LM (scipy 'lm').

    sigma: fixed per-term scales {"sky": px, "match": px}; if None, each term's σ is re-estimated
    (MAD) at the current pose — used for the single-cue solves, whose final σ then fixes the
    scales of the joint solve (so costs from different starts are comparable)."""
    sigma = dict(sigma or {})
    x = np.array(x0, float)
    info = {}
    for it in range(iters):
        parts = []
        if use_sky and sk is not None:
            sidx, stgt, ncol = sky_associate(x, sk, W, H, WINS[it])
            if len(sidx) >= 10:
                r = sky_resid(x, sk, W, H, sidx, stgt)
                s_sky = sigma.get("sky") or robust_sigma(r, SIGMA_FLOOR["sky"])
                w_sky = huber_sqrt_w(r / s_sky)
                parts.append(("sky", sidx, stgt, s_sky, w_sky))
                info["sky"] = {"n": int(len(sidx)), "cols": int(ncol), "sigma": s_sky}
        if use_match and c is not None and len(c["x2d"]):
            r = match_resid(x, c, eye)
            e = np.linalg.norm(r, axis=1)
            g = e < GATES[it]
            if g.sum() >= 6:
                rg = r[g].ravel()
                s_m = sigma.get("match") or robust_sigma(rg, SIGMA_FLOOR["match"])
                w_m = huber_sqrt_w(rg / s_m)
                parts.append(("match", g, None, s_m, w_m))
                info["match"] = {"n": int(g.sum()), "sigma": s_m}
        if not parts:
            return None

        def F(xx):
            out = []
            for name, a, b, s, wsq in parts:
                if name == "sky":
                    rr = sky_resid(xx, sk, W, H, a, b)
                    out.append(wsq * rr / s / math.sqrt(len(rr)))
                else:
                    cc = {"x2d": c["x2d"][a], "X": c["X"][a], "W": W, "H": H}
                    rr = match_resid(xx, cc, eye).ravel()
                    out.append(math.sqrt(lam) * wsq * rr / s / math.sqrt(len(rr) / 2))
            out.append(np.array([(xx[3] - math.log(f0)) / FOCAL_SIGMA]))
            return np.concatenate(out)

        sol = least_squares(F, x, method="lm", x_scale=[0.1, 0.1, 0.1, 0.01], max_nfev=400)
        x = sol.x
        info["cost"] = float(sol.cost)
    return x, info


TRUNC = 3.0  # truncation (in σ) of the model-selection cost


def selection_cost(x, sk, c, eye, W, H, sigma, lam=1.0):
    """Truncated-quadratic cost with fixed σ over *all* candidates (every in-view horizon column,
    every lifted match), so a start that explains fewer items can't look cheaper."""
    tot = 0.0
    if sk is not None:
        idx, tgt, ncol = sky_associate(x, sk, W, H, WINS[0])
        if ncol:
            r = sky_resid(x, sk, W, H, idx, tgt) if len(idx) else np.zeros(0)
            q = np.minimum((r / sigma["sky"]) ** 2, TRUNC ** 2)
            tot += (q.sum() + (ncol - len(idx)) * TRUNC ** 2) / ncol
        else:
            tot += TRUNC ** 2
    if c is not None and len(c["x2d"]) and sigma.get("match"):
        e = np.linalg.norm(match_resid(x, c, eye), axis=1)
        tot += lam * float(np.minimum((e / sigma["match"]) ** 2, TRUNC ** 2).mean())
    return tot


# ---------- per-photo driver ----------

def rot_angle(p, q) -> float:
    R = pose_to_R(p) @ pose_to_R(q).T
    return float(np.degrees(np.arccos(np.clip((np.trace(R) - 1) / 2, -1, 1))))


def diagnostics(x, sk, c, eye, W, H):
    out = {}
    if sk is not None:
        idx, tgt, ncol = sky_associate(x, sk, W, H, WINS[-1])
        r = sky_resid(x, sk, W, H, idx, tgt) if len(idx) else np.zeros(0)
        out["sky_med"] = float(np.median(np.abs(r))) if len(r) else None
        out["sky_cols_with_evidence"] = int(len(idx))
        out["sky_cols"] = int(ncol)
        out["sky_cover"] = float((np.abs(r) < 4.0).sum() / ncol) if ncol else 0.0
    if c is not None and len(c["x2d"]):
        e = np.linalg.norm(match_resid(x, c, eye), axis=1)
        inl = e < SUPPORT_PX
        out["match_support"] = float(inl.mean())
        out["match_med"] = float(np.median(e[inl])) if inl.any() else None
        out["match_n"] = int(len(e))
    return out


def solve_photo(pid: str, shift: int = 0, lam: float = 1.0) -> dict:
    import match as M  # RANSAC init for the match-only solution
    meta = load_meta(pid.split("@")[0])  # true meta (GT, aspect); "@" variants differ only in eye
    eye = np.array(load_meta(pid)["eye"], float)
    sk = load_skyline(pid, shift)
    c = load_corr(pid, SHIFTS[shift])
    W, H = (c["W"], c["H"]) if c else ((1024, 768) if meta["aspect"] >= 1 else (768, 1024))
    prior = sk["app"]["prior"]
    f0 = focal_px(prior["vfov"], H)
    t0 = time.time()
    res = {"id": pid, "shift": shift, "prior": prior, "W": W, "H": H}
    # skyline-only: the app's autoAlign answer (global search), plus our LM polish of it
    # shift 0: the pose the app actually applied at load (as scored by scripts/eval-app.mjs);
    # ±15: autoAlign re-run in-page from the shifted prior with the app's acceptance rule
    sky_pose = meta["auto"] if (shift == 0 and "@" not in pid) else sk["app"]["pose"]
    res["skyline"] = {"pose": sky_pose, "appConfidence": sk["app"]["confidence"], "accepted": sk["app"]["accepted"]}
    s = solve(x_from_pose(sky_pose, H), W, H, f0, sk=sk, use_match=False)
    res["skylineLM"] = {"pose": pose_from_x(s[0], H)} if s else None
    sigma = {"sky": s[1]["sky"]["sigma"] if s and "sky" in s[1] else 2.0}
    # match-only: RANSAC (fixed EXIF focal) then the same LM with the match term only
    mo = None
    if c is not None and len(c["x2d"]) >= 6:
        rs = M.solve_rotation(c["x2d"], c["X"], eye, W, H, f0, False)
        if rs is not None:
            rp = R_to_pose(rs["R"], prior["vfov"])
            m = solve(x_from_pose(rp, H), W, H, f0, c=c, eye=eye, use_sky=False)
            mo = {"ransacPose": rp, "ransacInliers": int(rs["inliers"].sum()), "pose": pose_from_x(m[0], H) if m else rp}
            sigma["match"] = m[1]["match"]["sigma"] if m and "match" in m[1] else 2.0
    res["match"] = mo
    res["sigma"] = sigma
    # fused: joint solve from each single-cue solution with σ fixed from the single-cue fits;
    # keep the one with the lower truncated selection cost
    best = None
    for name, start in (("skyline", sky_pose), ("match", mo["pose"] if mo else None)):
        if start is None:
            continue
        s = solve(x_from_pose(start, H), W, H, f0, sk=sk, c=c, eye=eye, lam=lam, sigma=sigma)
        if s:
            sel = selection_cost(s[0], sk, c, eye, W, H, sigma, lam)
            s[1]["selection"] = sel
            if best is None or sel < best[1]["selection"]:
                best = (s[0], s[1], name)
    if best:
        xf = best[0]
        res["fused"] = {"pose": pose_from_x(xf, H), "start": best[2], "terms": best[1], **diagnostics(xf, sk, c, eye, W, H)}
    else:
        res["fused"] = None
    # confidence from agreement + per-term fit at the fused pose
    d_agree = rot_angle(sky_pose, mo["pose"]) if mo else None
    fz = res["fused"] or {}
    high = (d_agree is not None and d_agree < 1.0 and (fz.get("sky_med") is not None and fz["sky_med"] < 4.0)
            and (fz.get("match_support") or 0) >= 0.3)
    res["confidence"] = {"d_agree": d_agree, "sky_med": fz.get("sky_med"), "match_support": fz.get("match_support"),
                         "sky_cover": fz.get("sky_cover"),
                         "level": "HIGH" if high else "LOW"}
    res["sec"] = time.time() - t0
    # scores vs pins GT (empty when the photo has < 2 pins)
    scorable = meta.get("gt") and len(meta["gt"]["pins"]) >= 2
    for k in ("prior", "skyline", "skylineLM", "match", "fused"):
        v = res[k] if k == "prior" else (res[k] or {}).get("pose")
        res.setdefault("scores", {})[k] = score(v, meta) if (v and scorable) else {}
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ids", nargs="*")
    ap.add_argument("--lam", type=float, default=1.0)
    ap.add_argument("--tag", default="default")
    a = ap.parse_args()
    ids = a.ids or sorted(p.stem for p in SKY_DIR.glob("IMG_*.json") if "@" not in p.stem)
    out = []
    for pid in ids:
        for shift in ([0] if "@" in pid else SHIFTS):
            r = solve_photo(pid, shift, a.lam)
            out.append(r)
            sc = r["scores"]
            f = lambda k: (f"{sc[k]['dYaw']:+6.2f}/{sc[k]['dPitch']:+5.2f}/{sc[k]['dRoll']:+5.2f} {sc[k]['pinPx']:6.1f}px" if sc.get(k) else "      –      ")  # noqa: E731
            cf = r["confidence"]
            print(f"{pid} {shift:+3d} sky {f('skyline')} | match {f('match')} | fused {f('fused')} | "
                  f"agree {cf['d_agree'] if cf['d_agree'] is None else round(cf['d_agree'], 2)} skymed {cf['sky_med'] and round(cf['sky_med'], 1)} "
                  f"supp {cf['match_support'] and round(cf['match_support'], 2)} {cf['level']}", flush=True)
    (HERE / "out" / "results").mkdir(parents=True, exist_ok=True)
    (HERE / "out" / "results" / f"fusion_{a.tag}.json").write_text(json.dumps(out, indent=1, default=float))


if __name__ == "__main__":
    main()
