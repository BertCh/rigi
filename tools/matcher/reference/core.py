"""Matching core for the service: a thin wrapper over ../match.py and ../common.py (imported, not edited).

match.py is CLI-shaped (reads out/renders/<ID>), but its building blocks are pure functions:
extract / match / lift / solve_rotation / models. This file feeds them in-memory views.
"""
from __future__ import annotations

import math
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np

MATCHER_DIR = Path(__file__).resolve().parent.parent
sys.dont_write_bytecode = True  # don't drop __pycache__ into the (shared) tools/matcher dir
os.environ.setdefault("TORCH_HOME", str(MATCHER_DIR / "weights"))
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
if str(MATCHER_DIR) not in sys.path:
    sys.path.insert(0, str(MATCHER_DIR))

import match as M  # noqa: E402  (tools/matcher/match.py)
from common import R_to_pose, dang, focal_px, pose_to_R, score, vfov_from_f  # noqa: E402

VERSION = "matcher-service/0.4.0 (fused skyline+render-match via fusion.py, λ=1; aliked-n16 on MPS + lightglue on CPU; basin-gap LOW trigger for untrusted positions; bounded queue with tickets, client-cancel; ad-hoc policy switch v034|t6, T6 stage-1 search + frozen rule 292fb74f)"
KIND = "aliked"


TICK_HOOK = None  # set by app.py: raises to cancel a job whose client has gone


class Deadline(Exception):
    pass


@dataclass
class View:
    tag: str
    pose: dict
    rgb: np.ndarray  # H×W×3 uint8
    xyz: np.ndarray  # H×W×3 float32 ENU (sky = 0)


def warmup() -> dict:
    """Load ALIKED + LightGlue onto the device and run one dummy pass (first MPS call is slow)."""
    t0 = time.time()
    M.models(KIND)
    img = (np.random.default_rng(0).random((384, 512, 3)) * 255).astype(np.uint8)
    f = M.extract(KIND, img)
    lg_match(f, f)
    return {"device": M.DEV, "lightglueDevice": LG_DEVICE, "warmupMs": round((time.time() - t0) * 1000)}


def check_view(v: View, eye: np.ndarray) -> float:
    """Median reprojection (px) of the view's own xyz under its pose (catches stale geo buffers)."""
    H, W, _ = v.xyz.shape
    ys, xs = np.nonzero((v.xyz != 0).any(2))
    if len(ys) == 0:
        return math.inf
    i = np.random.default_rng(0).choice(len(ys), min(300, len(ys)), replace=False)
    R = pose_to_R(v.pose)
    fp = focal_px(v.pose["vfov"], H)
    c = (v.xyz[ys[i], xs[i]].astype(float) - eye) @ R.T
    ok = c[:, 2] > 0
    if not ok.any():
        return math.inf
    p = np.stack([W / 2 + fp * c[ok, 0] / c[ok, 2], H / 2 + fp * c[ok, 1] / c[ok, 2]], 1)
    return float(np.median(np.linalg.norm(p - np.stack([xs[i][ok] + 0.5, ys[i][ok] + 0.5], 1), axis=1)))


def coverage(x2d: np.ndarray, W: int, H: int, nx=4, ny=3, min_pts=3) -> float:
    """Fraction of an nx×ny photo grid holding ≥ min_pts inliers."""
    if len(x2d) == 0:
        return 0.0
    gx = np.clip((x2d[:, 0] / W * nx).astype(int), 0, nx - 1)
    gy = np.clip((x2d[:, 1] / H * ny).astype(int), 0, ny - 1)
    cnt = np.bincount(gy * nx + gx, minlength=nx * ny)
    return float((cnt >= min_pts).mean())


def _sat(x: float) -> float:
    return max(0.0, min(1.0, x))


_cpu_lg = None


LG_DEVICE = os.environ.get("MATCHER_LG_DEVICE", "cpu")


def lg_match(fp, fr):
    """LightGlue for one pair. Default on CPU: on MPS the same input intermittently gives near-empty
    or spurious extra matches (0/2/3 vs 891 in a 5-request probe under memory pressure), and its
    attention buffers + allocator cache pushed the service to 3–4 GB RSS. CPU is deterministic,
    ~1.6 s/pair at 4096 keypoints. ALIKED extraction stays on the model device (it is deterministic)."""
    import torch
    from lightglue import LightGlue

    global _cpu_lg
    if LG_DEVICE != "cpu":
        k0, k1, _ = M.match(KIND, fp, fr)
        return k0, k1
    if _cpu_lg is None:
        _cpu_lg = LightGlue(features=KIND).eval()
    cpu = lambda f: {k: (t.to("cpu") if hasattr(t, "to") else t) for k, t in f.items()}  # noqa: E731
    with torch.inference_mode():
        out = _cpu_lg({"image0": cpu(fp), "image1": cpu(fr)})
    m = out["matches"][0].numpy()
    return fp["keypoints"][0].cpu().numpy()[m[:, 0]], fr["keypoints"][0].cpu().numpy()[m[:, 1]]


def top_k(f: dict, k: int | None) -> dict:
    """Keep the k highest-scoring keypoints (the extractor returns up to 4096)."""
    n = f["keypoints"].shape[1]
    if not k or n <= k:
        return f
    import torch

    idx = torch.topk(f["keypoint_scores"][0], k).indices.sort().values
    return {kk: (v[:, idx] if kk in ("keypoints", "descriptors", "keypoint_scores") else v) for kk, v in f.items()}


def correspond(photo: np.ndarray, views: list[View], eye, *, deadline: float | None = None, max_kp: int | None = None) -> dict:
    """ALIKED+LightGlue photo↔view matches lifted through each view's xyz (as match.correspondences)."""
    from PIL import Image

    t0 = time.time()
    eye = np.asarray(eye, float)
    H, W = views[0].xyz.shape[:2]
    if photo.shape[:2] != (H, W):
        photo = np.array(Image.fromarray(photo).resize((W, H), Image.LANCZOS))

    def tick():
        if deadline is not None and time.time() > deadline:
            raise Deadline()
        if TICK_HOOK is not None:
            TICK_HOOK()

    bad = [v.tag for v in views if check_view(v, eye) > 2.0]
    if bad:
        raise ValueError(f"xyz buffer does not reproject under its pose for views {bad} (stale/mismatched render)")
    tick()
    fp = top_k(M.extract(KIND, photo), max_kp)
    raw = []
    for v in views:
        tick()
        rimg = v.rgb
        if rimg.shape[:2] != (H, W):
            raise ValueError(f"view {v.tag}: rgb {rimg.shape[:2]} != xyz {(H, W)}")
        fr = top_k(M.extract(KIND, rimg), max_kp)
        k0, k1 = lg_match(fp, fr)
        raw.append([v, fr, k0, k1, None])
    X2, X3, per = [], [], []
    for v, fr, k0, k1, retried in raw:
        X, ok = M.lift(k1, v.xyz, eye)
        terrain = (v.xyz != 0).any(2)
        per.append({"tag": v.tag, "matches": int(len(k0)), "lifted": int(ok.sum()),
                    "keypoints": int(fr["keypoints"].shape[1]), "terrainFrac": round(float(terrain.mean()), 3),
                    "rgbStd": round(float(v.rgb[terrain].std()), 1) if terrain.any() else 0.0,
                    **({"retried": retried} if retried else {})})  # retried: unused since LightGlue moved to CPU
        X2.append(k0[ok] + 0.5)
        X3.append(X[ok])
    x2d = np.concatenate(X2) if X2 else np.zeros((0, 2))
    X = np.concatenate(X3) if X3 else np.zeros((0, 3))
    return {"x2d": x2d, "X": X, "W": W, "H": H, "perView": per, "matchMs": round((time.time() - t0) * 1000)}


def solve(corr: dict, views: list[View], eye, prior: dict, *, free_focal=False,
          deadline: float | None = None, meta_for_score: dict | None = None) -> dict:
    """Legacy render-match solve (RANSAC + LM rotation, camera centre fixed at eye) on `corr`."""
    eye = np.asarray(eye, float)
    x2d, X, W, H, per = corr["x2d"], corr["X"], corr["W"], corr["H"], corr["perView"]
    f0 = focal_px(prior["vfov"], H)
    match_ms = corr["matchMs"]
    if deadline is not None and time.time() > deadline:
        raise Deadline()
    t1 = time.time()
    s = M.solve_rotation(x2d, X, eye, W, H, f0, free_focal)
    solve_ms = (time.time() - t1) * 1000
    base = {"nLifted": int(len(x2d)), "perView": per, "timingMs": {"match": round(match_ms), "solve": round(solve_ms)}}
    if s is None:
        return {**base, "pose": None, "inliers": 0, "confidence": 0.0, "reason": "too few lifted matches"}
    inl = s["inliers"]
    pose = R_to_pose(s["R"], vfov_from_f(s["f"], H))
    n_inl = int(inl.sum())
    frac = float(inl.mean()) if len(inl) else 0.0
    resid = s.get("rmse")
    cov = coverage(x2d[inl], W, H)
    dyaw = dang(pose["yaw"], prior["yaw"])
    span = max(abs(v.pose["yaw"] - prior["yaw"]) for v in views) + prior["vfov"] * 0.5 * W / H
    # Heuristic, uncalibrated: enough inliers, mostly consistent, spread over the frame, tight fit,
    # and inside the rendered yaw fan. Wrong GPS fixes can still score high (reports/matcher.md).
    conf = (_sat(n_inl / 200) * _sat(frac / 0.6) * _sat(cov / 0.4)
            * (1.0 if resid is None or resid <= 3.5 else 3.5 / resid)
            * (1.0 if abs(dyaw) <= span else 0.0))
    out = {
        **base,
        "pose": pose,
        "inliers": n_inl,
        "inlierFrac": round(frac, 4),
        "residualPx": None if resid is None else round(resid, 3),
        "coverage": round(cov, 3),
        "deltaYawFromPrior": round(dyaw, 3),
        "confidence": round(conf, 3),
        "focalPx": round(s["f"], 2),
        "freeFocal": free_focal,
        "size": {"W": W, "H": H},
    }
    if meta_for_score and meta_for_score.get("gt"):
        sc = score(pose, meta_for_score)
        out["vsGroundTruth"] = {k: (None if v is None else round(v, 3)) for k, v in sc.items()}
    return out
