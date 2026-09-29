"""Render-and-match, steps 2–3: match the photo to DEM renders, lift to 3D, solve the pose.

  python match.py IMG_7059 [...] [--stage initial|refine] [--configs aliked:sat,aliked:hill,...]

Stage "initial" matches against the prior ± yaw renders (tags y*), stage "refine" against
renders at the previous solution (tags it1*, written by render.mjs --poses).
Writes out/results/<ID>_<stage>.json and match visualisations in out/viz/.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import time
from pathlib import Path

os.environ.setdefault("TORCH_HOME", str(Path(__file__).resolve().parent / "weights"))
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

import cv2
import numpy as np
import poselib
import torch
from PIL import Image
from scipy.optimize import least_squares
from scipy.spatial.transform import Rotation

from common import (HERE, ROOT, R_to_pose, focal_px, list_tags, load_meta, load_render, pose_to_R, render_path,
                    score, vfov_from_f)

DEV = "mps" if torch.backends.mps.is_available() else "cpu"
OUT = HERE / "out"
MIN_RANGE = 250.0  # m; nearer terrain is inside the GPS error cone
PX_THRESH = 6.0  # RANSAC inlier threshold, px at ~1024 px image size
_models: dict = {}


def models(kind: str):
    if kind not in _models:
        from lightglue import ALIKED, DISK, LightGlue
        ext = (ALIKED(max_num_keypoints=4096, detection_threshold=0.01) if kind == "aliked"
               else DISK(max_num_keypoints=4096))
        # NB: LightGlue on MPS is intermittently wrong for the same input (near-empty or spurious extra
        # matches), with or without flash attention; the service guards against it with a double run +
        # CPU fallback (server/core.py). flash stays on: turning it off didn't remove the glitches and
        # materialises 4×4096² attention matrices (memory). See reports/position.md, "Service changes".
        _models[kind] = (ext.eval().to(DEV), LightGlue(features=kind).eval().to(DEV))
    return _models[kind]


_roma = None


def roma_match(img0: np.ndarray, img1: np.ndarray, num=5000):
    """RoMa v1 outdoor (MIT code/weights, DINOv2 ViT-L backbone Apache-2.0): dense warp → sampled matches."""
    global _roma
    if _roma is None:
        from romatch import roma_outdoor
        _roma = roma_outdoor(device=DEV, coarse_res=560, upsample_res=(864, 1152))
    H0, W0 = img0.shape[:2]
    H1, W1 = img1.shape[:2]
    warp, cert = _roma.match(Image.fromarray(img0), Image.fromarray(img1), device=DEV)
    m, c = _roma.sample(warp, cert, num=num)
    k0, k1 = _roma.to_pixel_coordinates(m, H0, W0, H1, W1)
    # RoMa pixel coords have 0 at the image edge; the rest of this file uses pixel-centre integers
    return k0.cpu().numpy() - 0.5, k1.cpu().numpy() - 0.5, c.cpu().numpy()


def to_tensor(img: np.ndarray) -> torch.Tensor:
    return torch.from_numpy(img).permute(2, 0, 1).float().div(255)[None].to(DEV)


@torch.inference_mode()
def extract(kind: str, img: np.ndarray):
    ext, _ = models(kind)
    return ext.extract(to_tensor(img)[0])


@torch.inference_mode()
def match(kind: str, f0, f1):
    _, lg = models(kind)
    out = lg({"image0": f0, "image1": f1})
    m = out["matches"][0].cpu().numpy()
    sc = out["scores"][0].cpu().numpy()
    k0 = f0["keypoints"][0].cpu().numpy()
    k1 = f1["keypoints"][0].cpu().numpy()
    return k0[m[:, 0]], k1[m[:, 1]], sc


def lift(kp: np.ndarray, xyz: np.ndarray, eye: np.ndarray, min_range: float = MIN_RANGE):
    """Render keypoints → ENU xyz; drop sky, near terrain and depth discontinuities."""
    H, W, _ = xyz.shape
    xi = np.clip(np.round(kp[:, 0]).astype(int), 0, W - 1)
    yi = np.clip(np.round(kp[:, 1]).astype(int), 0, H - 1)
    X = xyz[yi, xi].astype(np.float64)
    rng = np.linalg.norm(xyz.astype(np.float64) - eye, axis=2)
    rng[(xyz == 0).all(2)] = np.inf  # sky
    ok = np.isfinite(rng[yi, xi]) & (rng[yi, xi] > min_range)
    # discontinuity: 5×5 range spread > 8 %
    r = 2
    lo = np.full(len(kp), np.inf)
    hi = np.zeros(len(kp))
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            v = rng[np.clip(yi + dy, 0, H - 1), np.clip(xi + dx, 0, W - 1)]
            lo = np.minimum(lo, v)
            hi = np.maximum(hi, v)
    ok &= hi < lo * 1.08
    return X, ok


# ---------- solvers ----------

def triad(a1, a2, b1, b2):
    """Batch rotation R with R a ≈ b from two vector pairs. a*, b*: (N, 3)."""
    def frame(v1, v2):
        t1 = v1 / np.linalg.norm(v1, axis=1, keepdims=True)
        t2 = np.cross(v1, v2)
        t2 /= np.linalg.norm(t2, axis=1, keepdims=True) + 1e-12
        t3 = np.cross(t1, t2)
        return np.stack([t1, t2, t3], axis=2)  # columns
    A, B = frame(a1, a2), frame(b1, b2)
    return B @ np.transpose(A, (0, 2, 1))


def reproj(R, f, Wd, cx, cy):
    c = Wd @ R.T
    z = np.maximum(c[:, 2], 1e-9)
    return np.stack([cx + f * c[:, 0] / z, cy + f * c[:, 1] / z], 1), c[:, 2] > 0


def solve_rotation(x2d, X, eye, W, H, f0, free_focal: bool, iters=3000, seed=0, thr: float = PX_THRESH):
    """Camera centre fixed at the eye: 2-point rotation RANSAC, then robust LM on rotation (+focal)."""
    n = len(x2d)
    if n < 6:
        return None
    cx, cy = W / 2, H / 2
    Wd = X - eye
    Wd /= np.linalg.norm(Wd, axis=1, keepdims=True)
    rng = np.random.default_rng(seed)
    best = (None, -1, None)
    for f_try in ([f0 * s for s in (0.9, 0.95, 1.0, 1.05, 1.1)] if free_focal else [f0]):
        b = np.stack([(x2d[:, 0] - cx) / f_try, (x2d[:, 1] - cy) / f_try, np.ones(n)], 1)
        b /= np.linalg.norm(b, axis=1, keepdims=True)
        i = rng.integers(0, n, size=(iters, 2))
        i = i[i[:, 0] != i[:, 1]]
        Rs = triad(Wd[i[:, 0]], Wd[i[:, 1]], b[i[:, 0]], b[i[:, 1]])
        # angular residual → px
        c = np.einsum("kij,nj->kni", Rs, Wd)
        cosang = np.einsum("kni,ni->kn", c, b)
        inl = cosang > math.cos(thr / f_try)
        cnt = inl.sum(1)
        k = int(cnt.argmax())
        if cnt[k] > best[1]:
            best = (Rs[k], int(cnt[k]), f_try)
    R, _, f = best
    if R is None:
        return None
    for _ in range(3):
        p, front = reproj(R, f, Wd, cx, cy)
        e = np.linalg.norm(p - x2d, axis=1)
        inl = (e < thr * 1.5) & front
        if inl.sum() < 6:
            return None
        rv0 = Rotation.from_matrix(R).as_rotvec()
        x0 = np.r_[rv0, math.log(f)] if free_focal else rv0

        def res(x):
            Rr = Rotation.from_rotvec(x[:3]).as_matrix()
            ff = math.exp(x[3]) if free_focal else f
            pp, _ = reproj(Rr, ff, Wd[inl], cx, cy)
            r = (pp - x2d[inl]).ravel()
            if free_focal:  # weak EXIF focal prior (5 %)
                r = np.r_[r, (x[3] - math.log(f0)) / 0.05 * 1.0]
            return r
        sol = least_squares(res, x0, loss="soft_l1", f_scale=2.0)
        R = Rotation.from_rotvec(sol.x[:3]).as_matrix()
        if free_focal:
            f = math.exp(sol.x[3])
    p, front = reproj(R, f, Wd, cx, cy)
    e = np.linalg.norm(p - x2d, axis=1)
    inl = (e < thr) & front
    return {"R": R, "f": f, "inliers": inl, "rmse": float(np.sqrt(np.mean(e[inl] ** 2))) if inl.any() else None}


def solve_pnp_exif(x2d, X, eye, W, H, f0):
    """6-DoF PnP with EXIF focal (PoseLib LO-RANSAC), points expressed relative to the eye."""
    if len(x2d) < 6:
        return None
    cam = {"model": "PINHOLE", "width": W, "height": H, "params": [f0, f0, W / 2, H / 2]}
    pose, info = poselib.estimate_absolute_pose(x2d, X - eye, cam, {"max_reproj_error": PX_THRESH}, {})
    inl = np.array(info["inliers"], bool)
    if inl.sum() < 6:
        return None
    R = pose.R
    C = -R.T @ pose.t  # camera centre relative to eye
    return {"R": R, "f": f0, "inliers": inl, "centreShift": C.tolist()}


def solve_p4pf(x2d, X, eye, W, H, f0, iters=1500, seed=0):
    """P4Pf (PoseLib minimal solver) in a hand-rolled RANSAC; unknown focal + 6-DoF."""
    n = len(x2d)
    if n < 8:
        return None
    cx, cy = W / 2, H / 2
    xc = x2d - [cx, cy]
    Xr = X - eye
    rng = np.random.default_rng(seed)
    best = (None, None, -1)
    for _ in range(iters):
        i = rng.choice(n, 4, replace=False)
        try:
            poses, fs = poselib.p4pf(xc[i], Xr[i], True)
        except Exception:
            continue
        for P, f in zip(poses, fs):
            if not (0.5 * f0 < f < 2 * f0):
                continue
            c = Xr @ P.R.T + P.t
            z = c[:, 2]
            pp = f * c[:, :2] / np.maximum(z, 1e-9)[:, None]
            e = np.linalg.norm(pp - xc, axis=1)
            cnt = int(((e < PX_THRESH) & (z > 0)).sum())
            if cnt > best[2]:
                best = (P, f, cnt)
    P, f, cnt = best
    if P is None:
        return None
    c = Xr @ P.R.T + P.t
    e = np.linalg.norm(f * c[:, :2] / np.maximum(c[:, 2], 1e-9)[:, None] - xc, axis=1)
    inl = (e < PX_THRESH) & (c[:, 2] > 0)
    return {"R": P.R, "f": f, "inliers": inl, "centreShift": (-P.R.T @ P.t).tolist()}


# ---------- library entry point ----------

def load_photo(pid: str, W: int, H: int) -> np.ndarray:
    pid = pid.split("@")[0]  # "IMG_x@r1000" = synthetic wrong-GPS variant of IMG_x
    return np.array(Image.open(ROOT / "public" / "photos" / f"{pid}.jpg").convert("RGB").resize((W, H), Image.LANCZOS))


def correspondences(pid: str, tags: list[str], kind: str = "aliked", styles=("sat",), eye=None, photo=None,
                    min_range: float = MIN_RANGE):
    """Match the photo against the given renders and lift to 3D.

    Returns dict(x2d (N,2) photo px at render resolution, pixel-centre convention; X (N,3) ENU;
    W, H; perView list). Needs out/renders/<pid>/<tag>{.json,_xyz.f32,_<style>.jpg}."""
    if eye is None:
        eye = np.array(load_meta(pid)["eye"], float)
    info0, _ = load_render(pid, tags[0])
    W, H = info0["W"], info0["H"]
    if photo is None:
        photo = load_photo(pid, W, H)
    fp = extract(kind, photo) if kind != "roma" else None
    X2, X3, per = [], [], []
    for tag in tags:
        _, xyz = load_render(pid, tag)
        for st in styles:
            rimg = np.array(Image.open(render_path(pid, tag, st)).convert("RGB"))
            if kind == "roma":
                k0, k1, _ = roma_match(photo, rimg)
            else:
                k0, k1, _ = match(kind, fp, extract(kind, rimg))
            X, ok = lift(k1, xyz, eye, min_range)
            per.append({"tag": tag, "style": st, "matches": int(len(k0)), "lifted": int(ok.sum())})
            X2.append(k0[ok] + 0.5)
            X3.append(X[ok])
    x2d = np.concatenate(X2) if X2 else np.zeros((0, 2))
    X = np.concatenate(X3) if X3 else np.zeros((0, 3))
    return {"x2d": x2d, "X": X, "W": W, "H": H, "perView": per}


# ---------- visualisation ----------

def draw(photo, render, k0, k1, inl, path, title=""):
    H, W, _ = photo.shape
    canvas = np.concatenate([photo, render], 1).copy()
    for a, b, ok in zip(k0, k1, inl):
        col = (40, 220, 60) if ok else (230, 40, 40)
        if not ok and inl.sum() > 0 and np.random.rand() > 0.3:
            continue
        cv2.line(canvas, (int(a[0]), int(a[1])), (int(b[0]) + W, int(b[1])), col, 1, cv2.LINE_AA)
    cv2.putText(canvas, title, (10, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 3, cv2.LINE_AA)
    cv2.putText(canvas, title, (10, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 0), 1, cv2.LINE_AA)
    Image.fromarray(canvas).resize((W, H // 2)).save(path, quality=85) if False else Image.fromarray(canvas).save(path, quality=85)


# ---------- driver ----------

def run(pid: str, stage: str, configs: list[str], viz: bool, suffix: str = "", prefix: str | None = None):
    meta = load_meta(pid)
    eye = np.array(meta["eye"], float)
    prefix = prefix or ("y" if stage == "initial" else "it1" if stage == "refine" else stage)
    tags = list_tags(pid, prefix)
    if not tags:
        print(f"{pid}: no renders for stage {stage}")
        return None
    info0, _ = load_render(pid, tags[0])
    W, H = info0["W"], info0["H"]
    photo = np.array(Image.open(ROOT / "public" / "photos" / f"{pid}.jpg").convert("RGB").resize((W, H), Image.LANCZOS))
    f0 = focal_px(meta["prior"]["vfov"], H)
    renders = {t: load_render(pid, t) for t in tags}
    results = {"id": pid, "stage": stage, "W": W, "H": H, "tags": tags, "configs": {}}
    feats_photo = {}
    for cfg in configs:
        kind, styles = cfg.split(":")
        styles = styles.split("+")
        t0 = time.time()
        if kind != "roma" and kind not in feats_photo:
            feats_photo[kind] = extract(kind, photo)
        fp = feats_photo.get(kind)
        X2, X3, per = [], [], []
        best_view = (None, -1)
        for tag in tags:
            info, xyz = renders[tag]
            for st in styles:
                rimg = np.array(Image.open(render_path(pid, tag, st)).convert("RGB"))
                if kind == "roma":
                    k0, k1, sc = roma_match(photo, rimg)
                else:
                    k0, k1, sc = match(kind, fp, extract(kind, rimg))
                X, ok = lift(k1, xyz, eye)
                per.append({"tag": tag, "style": st, "matches": int(len(k0)), "lifted": int(ok.sum())})
                X2.append(k0[ok] + 0.5)
                X3.append(X[ok])
                if ok.sum() > best_view[1]:
                    best_view = ((tag, st, k0, k1, ok), int(ok.sum()))
        x2d = np.concatenate(X2) if X2 else np.zeros((0, 2))
        X = np.concatenate(X3) if X3 else np.zeros((0, 3))
        tmatch = time.time() - t0
        out = {"perView": per, "nLifted": int(len(x2d)), "matchSec": tmatch}
        for name, fn in (
            ("rot_fixf", lambda: solve_rotation(x2d, X, eye, W, H, f0, False)),
            ("rot_freef", lambda: solve_rotation(x2d, X, eye, W, H, f0, True)),
            ("pnp_exif", lambda: solve_pnp_exif(x2d, X, eye, W, H, f0)),
            ("p4pf", lambda: solve_p4pf(x2d, X, eye, W, H, f0)),
        ):
            t1 = time.time()
            try:
                s = fn()
            except Exception as e:  # noqa: BLE001
                print(f"  {name} failed: {e}")
                s = None
            if s is None:
                out[name] = None
                continue
            pose = R_to_pose(s["R"], vfov_from_f(s["f"], H))
            r = {"pose": pose, "inliers": int(s["inliers"].sum()), "inlierFrac": float(s["inliers"].mean()),
                 "f": s["f"], "sec": time.time() - t1, **score(pose, meta)}
            if "centreShift" in s:
                r["centreShift"] = s["centreShift"]
            if "rmse" in s:
                r["rmse"] = s["rmse"]
            out[name] = r
            if name == "rot_fixf":
                inl_all = s["inliers"]
        out["totalSec"] = time.time() - t0
        results["configs"][cfg] = out
        rf = out.get("rot_fixf")
        msg = f"{pid} {stage:7s} {cfg:18s} lifted {len(x2d):5d}"
        if rf:
            msg += f"  inl {rf['inliers']:4d}  yaw {rf['pose']['yaw']:7.2f}"
            if "dYaw" in rf:
                msg += f"  dYaw {rf['dYaw']:+6.2f} dPitch {rf['dPitch']:+5.2f} dRoll {rf['dRoll']:+5.2f} pin {rf['pinPx']:6.1f}px"
        print(msg, f"({out['totalSec']:.1f}s)")
        if viz and best_view[0] is not None and rf:
            tag, st, k0, k1, ok = best_view[0]
            # inlier flags for this view under the fixed-focal rotation solution
            R = pose_to_R(rf["pose"])
            Wd = X_view = None
            Xv, _ = lift(k1, renders[tag][1], eye)
            Wd = Xv - eye
            Wd /= np.linalg.norm(Wd, axis=1, keepdims=True)
            p, front = reproj(R, focal_px(rf["pose"]["vfov"], H), Wd, W / 2, H / 2)
            inl = ok & front & (np.linalg.norm(p - (k0 + 0.5), axis=1) < PX_THRESH)
            rimg = np.array(Image.open(render_path(pid, tag, st)).convert("RGB"))
            vdir = OUT / "viz"
            vdir.mkdir(parents=True, exist_ok=True)
            draw(photo, rimg, k0, k1, inl, vdir / f"{pid}_{stage}_{cfg.replace(':', '_').replace('+', '-')}.jpg",
                 f"{pid} {cfg} {tag}: {int(inl.sum())}/{len(k0)} inliers")
    rdir = OUT / "results"
    rdir.mkdir(parents=True, exist_ok=True)
    (rdir / f"{pid}_{stage}{suffix}.json").write_text(json.dumps(results, indent=1))
    return results


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ids", nargs="*")
    ap.add_argument("--stage", default="initial")
    ap.add_argument("--configs", default="aliked:sat,aliked:hill,aliked:sat+hill,disk:sat,disk:hill,disk:sat+hill")
    ap.add_argument("--no-viz", action="store_true")
    ap.add_argument("--prefix", default=None, help="render tag prefix (default y for initial, it1 for refine, else = stage)")
    ap.add_argument("--suffix", default="", help="results file suffix, e.g. _roma")
    a = ap.parse_args()
    ids = a.ids or sorted(p.name for p in (HERE / "out" / "renders").iterdir() if p.is_dir())
    print(f"device {DEV}")
    for pid in ids:
        run(pid, a.stage, a.configs.split(","), not a.no_viz, a.suffix, a.prefix)


if __name__ == "__main__":
    main()
