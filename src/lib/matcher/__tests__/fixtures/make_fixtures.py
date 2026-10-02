# Rigi
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: Copyright (c) Rigi contributors
"""Record Python reference outputs (tools/matcher: fusion.py, match.py, reference/core.py, reference/fuse.py)
on the deterministic synthetic scenarios of synth.py and write fusion.json next to this file.

The TS port of the matcher is tested against fusion.json; synth.spec.ts checks that synth.ts
regenerates the same scenario arrays (checksums stored per scenario). Fixture floats are rounded
to 9 significant digits (checksums are not). Timing fields are dropped.

Regenerate (from the repo / worktree root):
  /Users/robertchristie/Documents/GitHub/mt-image/tools/matcher/.venv/bin/python src/lib/matcher/__tests__/fixtures/make_fixtures.py
"""
from __future__ import annotations

import json
import math
import sys
import types
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
MATCHER = HERE.parents[4] / "tools" / "matcher"
sys.dont_write_bytecode = True
sys.path.insert(0, str(MATCHER / "reference"))
sys.path.insert(0, str(MATCHER))
sys.path.insert(0, str(HERE))

# Stub optional heavy deps only if missing (the matcher venv has cv2, poselib, lightglue, torch).
for _mod in ("cv2", "poselib", "lightglue"):
    try:
        __import__(_mod)
    except ImportError:
        stub = types.ModuleType(_mod)
        stub.LightGlue = object
        sys.modules[_mod] = stub

import core  # noqa: E402
import fuse  # noqa: E402
import fusion as F  # noqa: E402
import match as M  # noqa: E402
import synth  # noqa: E402
from common import R_to_pose, focal_px, pose_to_R, vfov_from_f  # noqa: E402


def clean(v):
    """JSON-safe: numpy -> python, 9 significant digits, inf/nan -> None."""
    if isinstance(v, dict):
        return {k: clean(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [clean(x) for x in v]
    if isinstance(v, np.ndarray):
        return clean(v.tolist())
    if isinstance(v, (np.bool_, bool)):
        return bool(v)
    if isinstance(v, (np.integer, int)):
        return int(v)
    if isinstance(v, (np.floating, float)):
        v = float(v)
        return float(f"{v:.9g}") if math.isfinite(v) else None
    return v


def pose_of(x, H):
    return F.pose_from_x(x, H)


def run(p: dict) -> dict:
    sc = synth.make_scenario(p)
    W, H, w, h = p["W"], p["H"], p["w"], p["h"]
    eye = np.array(p["eye"], float)
    tp, app = p["truePose"], p["appPose"]
    prior = {**{k: round(tp[k], 1) for k in ("yaw", "pitch", "roll")}, "vfov": tp["vfov"]}
    f0 = focal_px(prior["vfov"], H)
    sk = F.skyline_from_arrays(w, h, sc["fine"], sc["fg"], sc["sky"], sc["dirs"])
    sk["app"] = {"pose": app, "confidence": 0.5, "accepted": True}
    has_c = len(sc["x2d"]) > 0
    corr = {"x2d": sc["x2d"], "X": sc["X"], "W": W, "H": H} if has_c else None
    out = {"params": p, "prior": prior, "checksums": synth.checksums(sc)}

    S = sk["S"]
    samples = [[(k * 37) % h, (k * 53 + 11) % w] for k in range(20)]
    out["S"] = {"sum": float(S.sum()), "sumsq": float((S * S).sum()),
                "samples": [[r, c, float(S[r, c])] for r, c in samples]}

    xa = F.x_from_pose(app, H)
    cu = (np.arange(w) + 0.5) / w * W
    out["skyCurve"] = F.sky_curve(xa, sk, W, H, cu)
    keep, tgt, ncol = F.sky_associate(xa, sk, W, H, 24)
    out["skyAssociate"] = {"win": 24, "cu": keep, "tgt": tgt, "ncol": ncol}

    if has_c:
        r = F.match_resid(xa, corr, eye)
        out["matchResid"] = {"first20": r[:20], "robustSigma": F.robust_sigma(r.ravel(), 1.0)}
    else:
        out["matchResid"] = None

    def rot(free):
        s = M.solve_rotation(sc["x2d"], sc["X"], eye, W, H, f0, free)
        if s is None:
            return None
        return {"pose": R_to_pose(s["R"], vfov_from_f(s["f"], H)), "inliers": int(s["inliers"].sum()),
                "rmse": s["rmse"], "f": s["f"]}

    out["solveRotation"] = {"fixedFocal": rot(False), "freeFocal": rot(True)} if has_c else None

    # single-cue solves, joint solves, selection cost
    f_sky = F.solve(xa, W, H, f0, sk=sk, use_match=False)
    out["solveSky"] = {"pose": pose_of(f_sky[0], H), "info": f_sky[1]} if f_sky else None
    sigma = {"sky": f_sky[1]["sky"]["sigma"] if f_sky and "sky" in f_sky[1] else 2.0}
    rs = M.solve_rotation(sc["x2d"], sc["X"], eye, W, H, f0, False) if has_c else None
    match_pose = None
    out["solveMatch"] = None
    if rs is not None:
        rp = R_to_pose(rs["R"], prior["vfov"])
        m = F.solve(F.x_from_pose(rp, H), W, H, f0, c=corr, eye=eye, use_sky=False)
        match_pose = pose_of(m[0], H) if m else rp
        sigma["match"] = m[1]["match"]["sigma"] if m and "match" in m[1] else 2.0
        out["solveMatch"] = {"ransacPose": rp, "pose": match_pose, "info": m[1] if m else None}
    out["sigma"] = sigma
    fused = {}
    best = None
    for name, start in (("skyline", app), ("match", match_pose)):
        if start is None:
            continue
        s = F.solve(F.x_from_pose(start, H), W, H, f0, sk=sk, c=corr, eye=eye, lam=1.0, sigma=sigma)
        if not s:
            fused[name] = None
            continue
        sel = F.selection_cost(s[0], sk, corr, eye, W, H, sigma, 1.0)
        fused[name] = {"pose": pose_of(s[0], H), "info": s[1], "x": s[0], "selectionCost": sel}
        if best is None or sel < best[1]:
            best = (s[0], sel, name)
    out["solveFused"] = fused
    out["diagnostics"] = {"start": best[2], **F.diagnostics(best[0], sk, corr, eye, W, H)} if best else None
    out["rotAngle"] = F.rot_angle(app, match_pose) if match_pose else None

    fz = fuse.fuse(prior, eye, W, H, sk, corr)
    fz.pop("fusionMs", None)
    out["fuse"] = fz

    # core.solve with five yaw-fan views
    views = [types.SimpleNamespace(pose={**prior, "yaw": prior["yaw"] + dy}) for dy in (-20, -10, 0, 10, 20)]
    corr_core = {"x2d": sc["x2d"], "X": sc["X"], "W": W, "H": H, "perView": [], "matchMs": 0}
    cs = core.solve(corr_core, views, eye, prior)
    cs.pop("timingMs", None)
    out["coreSolve"] = cs
    out["coverage"] = core.coverage(sc["x2d"][:200], W, H)

    # lift + check_view on the 48x64 xyz buffer
    X, ok = M.lift(sc["kp"], sc["xyz"], eye)
    out["lift"] = {"X": X, "ok": ok.astype(int)}
    vpose = {**tp}
    view = core.View("synth", vpose, np.zeros((synth.XYZ_H, synth.XYZ_W, 3), np.uint8), sc["xyz"])
    out["checkView"] = core.check_view(view, eye)
    # the sample core.check_view draws (default_rng(0).choice) and the same statistic over all terrain px
    ys, xs = np.nonzero((sc["xyz"] != 0).any(2))
    idx = np.random.default_rng(0).choice(len(ys), min(300, len(ys)), replace=False)
    Rm = pose_to_R(vpose)
    fp = focal_px(vpose["vfov"], synth.XYZ_H)

    def med(ii):
        c = (sc["xyz"][ys[ii], xs[ii]].astype(float) - eye) @ Rm.T
        okk = c[:, 2] > 0
        pp = np.stack([synth.XYZ_W / 2 + fp * c[okk, 0] / c[okk, 2], synth.XYZ_H / 2 + fp * c[okk, 1] / c[okk, 2]], 1)
        return float(np.median(np.linalg.norm(pp - np.stack([xs[ii][okk] + 0.5, ys[ii][okk] + 0.5], 1), axis=1)))

    out["checkViewDetail"] = {"sampleIdx": idx, "terrainCount": int(len(ys)), "medianAll": med(np.arange(len(ys))),
                              "medianSample": med(idx)}
    return out


def main():
    res = {}
    for p in synth.SCENARIOS:
        r = run(p)
        chk = r.pop("checksums")
        res[p["name"]] = {**clean(r), "checksums": chk}
    path = HERE / "fusion.json"
    path.write_text(json.dumps(res, separators=(",", ":"), allow_nan=False))
    print(f"wrote {path} ({path.stat().st_size / 1024:.0f} KB)")
    for k, v in res.items():
        z = v["fuse"]
        print(k, z["level"], z["start"], z["fusedPose"], z["checks"])


if __name__ == "__main__":
    main()
