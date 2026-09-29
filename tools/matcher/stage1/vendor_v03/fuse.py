"""Fused (skyline + render-match) solve for the service: an in-memory replay of ../fusion.py.

fusion.solve_photo() reads out/skyline/* and out/corr/* files; this module feeds the same
functions (fusion.solve / selection_cost / diagnostics / rot_angle, match.solve_rotation) with
arrays the service produced itself. Nothing in ../fusion.py is modified or re-tuned: same λ,
Huber k, windows, gates and the same a-priori HIGH/LOW rule.
"""
from __future__ import annotations

import math
import time

import numpy as np

import core  # noqa: F401  (sets sys.path / env for the tools/matcher imports)
import fusion as F  # tools/matcher/fusion.py
import match as M
from common import R_to_pose, focal_px, score

HIGH_CONF, LOW_CONF = 0.9, 0.2  # numeric `confidence` for existing clients (m.confidence < 0.5)


def skyline_from_arrays(w: int, h: int, fine, fg, sky, dirs, app: dict) -> dict:
    """Same dict as fusion.load_skyline(), from in-memory arrays (edge.fine / edge.fg / edge.sky /
    horizonDirs as exported by render_worker.mjs, identical to export_skyline.mjs)."""
    fine = np.asarray(fine, np.float32).reshape(h, w)
    fg = np.asarray(fg, np.float32).reshape(h, w)
    sky = np.asarray(sky, np.float32).reshape(h, w)
    dirs = np.asarray(dirs, np.float32).reshape(-1, 3).astype(np.float64)
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
    return {"w": w, "h": h, "S": S, "fg": fg, "dirs": dirs, "meta": {}, "shift": 0, "app": app}


def _r(v, n=3):
    return None if v is None else round(float(v), n)


def _pose(p):
    return {k: float(p[k]) for k in ("yaw", "pitch", "roll", "vfov")}


def fuse(prior: dict, eye, W: int, H: int, sk: dict | None, corr: dict | None, lam: float = 1.0,
         meta_for_score: dict | None = None) -> dict:
    """Mirror of fusion.solve_photo() for one scenario. `sk["app"]["pose"]` is the skyline pose (the
    app's autoAlign answer after PhotoWorkspace's acceptance rule), `corr` = {x2d, X, W, H}."""
    t0 = time.time()
    eye = np.asarray(eye, float)
    f0 = focal_px(prior["vfov"], H)
    c = corr if corr is not None and len(corr["x2d"]) else None
    sky_pose = sk["app"]["pose"] if sk else None
    sigma = {}
    sky_resid_at_own = None
    if sk is not None:
        s = F.solve(F.x_from_pose(sky_pose, H), W, H, f0, sk=sk, use_match=False)
        sigma["sky"] = s[1]["sky"]["sigma"] if s and "sky" in s[1] else 2.0
        sky_resid_at_own = F.diagnostics(F.x_from_pose(sky_pose, H), sk, None, eye, W, H).get("sky_med")
    mo = None
    if c is not None and len(c["x2d"]) >= 6:
        rs = M.solve_rotation(c["x2d"], c["X"], eye, W, H, f0, False)
        if rs is not None:
            rp = R_to_pose(rs["R"], prior["vfov"])
            m = F.solve(F.x_from_pose(rp, H), W, H, f0, c=c, eye=eye, use_sky=False)
            mo = {"ransacPose": rp, "inliers": int(rs["inliers"].sum()), "rmse": rs.get("rmse"),
                  "pose": F.pose_from_x(m[0], H) if m else rp}
            sigma["match"] = m[1]["match"]["sigma"] if m and "match" in m[1] else 2.0
    if "sky" not in sigma:
        sigma["sky"] = 2.0  # as fusion.solve_photo (unused when sk is None)
    best = None
    for name, start in (("skyline", sky_pose), ("match", mo["pose"] if mo else None)):
        if start is None:
            continue
        s = F.solve(F.x_from_pose(start, H), W, H, f0, sk=sk, c=c, eye=eye, lam=lam, sigma=sigma)
        if s:
            sel = F.selection_cost(s[0], sk, c, eye, W, H, sigma, lam)
            if best is None or sel < best[1]:
                best = (s[0], sel, name)
    fused = diag = None
    if best:
        fused = F.pose_from_x(best[0], H)
        diag = F.diagnostics(best[0], sk, c, eye, W, H)
    d_agree = F.rot_angle(sky_pose, mo["pose"]) if (mo and sky_pose) else None
    dz = diag or {}
    high = (d_agree is not None and d_agree < 1.0 and dz.get("sky_med") is not None and dz["sky_med"] < 4.0
            and (dz.get("match_support") or 0) >= 0.3)
    # fusion.md's continuous summary of the same three checks (leaderboard confidence)
    score_c = (math.exp(-d_agree) * math.exp(-(dz.get("sky_med") or 99) / 4.0) * min(1.0, (dz.get("match_support") or 0) / 0.3)
               if d_agree is not None else 0.0)
    out = {
        "fusedPose": _pose(fused) if fused else None,
        "start": best[2] if best else None,
        "level": "high" if high else "low",
        "checks": {"cueAgreeDeg": _r(d_agree), "skylineMedPx": _r(dz.get("sky_med")), "matchSupport": _r(dz.get("match_support"))},
        "fusionScore": round(score_c, 3),
        "cues": {
            "skyline": ({"pose": _pose(sky_pose), "residualPx": _r(sky_resid_at_own), "appConfidence": _r(sk["app"].get("confidence")),
                         "accepted": sk["app"].get("accepted")} if sk else None),
            "match": ({"pose": _pose(mo["pose"]), "inliers": mo["inliers"], "residualPx": _r(mo["rmse"])} if mo else None),
        },
        "diag": dz,
        "sigma": {k: _r(v) for k, v in sigma.items()},
        "fusionMs": round((time.time() - t0) * 1000),
    }
    if fused and meta_for_score and meta_for_score.get("gt") and len(meta_for_score["gt"]["pins"]) >= 2:
        out["vsGroundTruth"] = {k: _r(v) for k, v in score(_pose(fused), meta_for_score).items()}
    return out
