"""X3 stage B: lift raw matches through the cached xyz, rotation(+focal) RANSAC solve, per-view + per-photo metrics.

    python evaluate.py [--matchers ...] [--configs ...] [--ids ...] --out results_prune.json

Camera conventions: render pixel -> ray uses the cache's exact render intrinsics (view.json fx, fy, cx, cy); the photo
side (solve + all 6 px residual checks) uses the service model (square f from vfov, principal point at W/2, H/2), as the
live matcher does (<= 0.4 px apart at the image edge).
Lifting (equivalent of tools/matcher/match.py lift, adapted to the stride-2 cache): render keypoint -> native
continuous coords; the 3-D point is eye + ray(exact pixel) * range(nearest xyz sample); dropped if sky, range
<= 250 m (MIN_RANGE) or a depth discontinuity (3x3 sample window ~ 6 native px, range spread > 8 %).
The rotation solve only uses directions, so it is exact in the render pose. Solve = match.solve_rotation
(2-pt RANSAC 3000 it + LM, 6 px, free focal iff the photo focal is unknown, seeded with the view's vfov) — the
same solver the service/ab.py use (core.solve wraps it).

Per view: matches, lifted, cons6 (= lifted matches within 6 px of the VIEW's own pose, no solve), solved inliers,
inlier frac, solved pose, rot err vs view pose, rot err vs the photo's perturb-base correct ref, inlAtRef6.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
TM = HERE.parent
sys.path.insert(0, str(TM))
sys.path.insert(0, str(TM / "c0_cache"))
import tm_common  # noqa: E402
sys.path.insert(0, str(tm_common.ROOT / "tools/matcher"))
import numpy as np  # noqa: E402
import cache_io as C  # noqa: E402
import match as M  # noqa: E402  tools/matcher/match.py (solve_rotation, MIN_RANGE)
from common import R_to_pose, pose_to_R, vfov_from_f  # noqa: E402

RAW = HERE / "raw"
EVC = HERE / "eval_cache"  # per-npz results keyed by file name + mtime
PX = 6.0


def rot_err(p, q):
    R = pose_to_R(p) @ pose_to_R(q).T
    return math.degrees(math.acos(max(-1.0, min(1.0, (np.trace(R) - 1) / 2))))


_vc: dict = {}


def load_view(pid, grp, tag):
    k = (pid, grp, tag)
    if k not in _vc:
        if len(_vc) > 64:
            _vc.clear()
        v = C.load_view(pid, grp, tag)
        v["rng"] = C.depth(v)  # nan at sky
        _vc[k] = v
    return _vc[k]


def lift(k1_file, v, scale):
    W, H = v["W"], v["H"]
    u = (k1_file[:, 0] + 0.5) / scale
    w = (k1_file[:, 1] + 0.5) / scale
    rng = v["rng"]
    h, ww = rng.shape
    ci = np.clip(np.round((u - 0.5) / 2).astype(int), 0, ww - 1)
    ri = np.clip(np.round((w - 0.5) / 2).astype(int), 0, h - 1)
    r0 = rng[ri, ci]
    ok = np.isfinite(r0) & (r0 > M.MIN_RANGE)
    lo = np.full(len(u), np.inf)
    hi = np.zeros(len(u))
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            q = rng[np.clip(ri + dy, 0, h - 1), np.clip(ci + dx, 0, ww - 1)]
            q = np.where(np.isfinite(q), q, np.inf)  # sky neighbour -> discontinuity
            lo = np.minimum(lo, q)
            hi = np.maximum(hi, q)
    ok &= hi < lo * 1.08
    d = C.pixel_rays(v, u, w)  # exact render intrinsics (fx != fy by <= 1e-3, cache FORMAT.md)
    X = np.asarray(v["eye"], float) + d * np.nan_to_num(r0)[:, None]
    return X, ok


def resid(pose, x2d, X, eye, W, H):
    """Photo-side projection with the SERVICE camera model (square f from vfov, c = W/2,H/2), the same model the
    rotation solve (match.solve_rotation) uses; <= 0.4 px from the renderer's own fx/fy at the image edge."""
    f = (H / 2) / math.tan(math.radians(pose["vfov"]) / 2)
    c = (np.asarray(X, float) - np.asarray(eye, float)) @ pose_to_R(pose).T
    z = np.where(c[:, 2] > 1e-9, c[:, 2], np.nan)
    uv = np.stack([W / 2 + f * c[:, 0] / z, H / 2 + f * c[:, 1] / z], 1)
    e = np.linalg.norm(uv - x2d, axis=1)
    return np.where(np.isfinite(e), e, 1e9)


def eval_view(npz, v, ref_pose, free_focal, photo_vfov=None):
    z = np.load(npz)
    k0, k1 = z["k0"], z["k1"]
    W, H = v["W"], v["H"]
    scale = float(z["fileW"]) / W
    rec = {"matches": int(len(k0)), "ms": round(float(z["ms"]))}
    if len(k0) == 0:
        return {**rec, "lifted": 0, "cons6": 0, "inliers": 0, "inlFrac": 0.0}
    X, ok = lift(k1, v, scale)
    x2d = (k0[ok].astype(np.float64) + 0.5) / scale
    X = X[ok]
    eye = np.asarray(v["eye"], float)
    rec["lifted"] = int(ok.sum())
    rec["cons6"] = int((resid(v["pose"], x2d, X, eye, W, H) < PX).sum()) if len(X) else 0
    # photo focal hypothesis: a ref / perturb render carries its own (candidate) vfov; ring renders have a fixed 40° hfov,
    # so the photo focal there is the base correct ref's vfov (or the manifest prior vfov0 if the photo has none)
    f0 = (H / 2) / math.tan(math.radians(photo_vfov or v["pose"]["vfov"]) / 2)
    s = M.solve_rotation(x2d, X, eye, W, H, f0, free_focal) if len(X) >= 6 else None
    if s is None:
        return {**rec, "inliers": 0, "inlFrac": 0.0}
    pose = R_to_pose(s["R"], vfov_from_f(s["f"], H))
    inl = s["inliers"]
    rec.update({"inliers": int(inl.sum()), "inlFrac": round(float(inl.mean()), 4),
                "pose": {k: round(float(pose[k]), 4) for k in pose}, "errView": round(rot_err(pose, v["pose"]), 3)})
    if ref_pose is not None:
        rec["errRef"] = round(rot_err(pose, ref_pose), 3)
        er = resid(ref_pose, x2d, X, eye, W, H) < PX
        rec["inlAtRef6"] = int((inl & er).sum())
        rec["liftedAtRef6"] = int(er.sum())
    return rec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--matchers", default=None)
    ap.add_argument("--configs", default=None)
    ap.add_argument("--ids", default=None)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    mnames = a.matchers.split(",") if a.matchers else sorted(p.name for p in RAW.iterdir() if p.is_dir())
    cf = set(a.configs.split(",")) if a.configs else None
    out = {"views": {}, "photos": {}}
    for mname in mnames:
        for pd in sorted((RAW / mname).iterdir()):
            pid = pd.name
            if a.ids and pid not in a.ids.split(","):
                continue
            tm_common.assert_dev(pid)
            meta = C.load_meta(pid)
            base = meta.get("perturbBase")
            ref_pose = next((r["pose"] for r in meta["correct_refs"] if r["label"] == base), None) if base else None
            if pid not in out["photos"]:
                out["photos"][pid] = {"tags": meta["tags"], "focal_known": meta["focal_known"], "hfov0": meta["hfov0"],
                                      "narrow": meta["narrow"], "base": base,
                                      "correct": [r["label"] for r in meta["correct_refs"]],
                                      "wrong": [r["label"] for r in meta["wrong_refs"]],
                                      "poses": {r["label"]: r["pose"] for r in meta["correct_refs"] + meta["wrong_refs"]}}
            cfile = EVC / mname / f"{pid}.json"
            cache = json.load(open(cfile)) if cfile.exists() else {}
            dirty = False
            for f in sorted(pd.glob("*.npz")):
                grp, tag, cfg = f.stem.split("__")
                if cf and cfg not in cf:
                    continue
                key = f"{f.name}:{f.stat().st_mtime_ns}" + (":ringf2" if grp == "ring" else "")
                r = cache.get(key)
                if r is None:
                    v = load_view(pid, grp, tag)
                    pv = ((ref_pose or {}).get("vfov") or meta["vfov0"]) if grp == "ring" else None
                    r = cache[key] = eval_view(f, v, ref_pose, not meta["focal_known"], pv)
                    dirty = True
                out["views"].setdefault(mname, {}).setdefault(cfg, {}).setdefault(pid, {})[f"{grp}/{tag}"] = r
            if dirty:
                cfile.parent.mkdir(parents=True, exist_ok=True)
                json.dump(cache, open(cfile, "w"))
            print(mname, pid, flush=True)
    json.dump(out, open(HERE / a.out, "w"), indent=0)


if __name__ == "__main__":
    main()
