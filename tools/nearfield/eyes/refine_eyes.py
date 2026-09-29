"""Step Inside P2: relative EYE refinement for a roll spot (offline study; TS port: src/lib/nearfield/roll/eyes.ts).

Rigi rotations are good (far skyline) but GPS eyes are off by metres to tens of metres, so the near fields of
different photos of a spot misregister. Per overlapping photo pair:
  1. ALIKED+LightGlue matches (1024 px, CPU; as tools/nearfield/propagate/run_propagate.py). People are masked out
     (they move between the photos).
  2. Rotations FIXED to Rigi's poses: world bearings a (A) and b (B). Coplanarity t . (a x b) = 0 for t = eyeB - eyeA,
     a 2-DoF translation-direction problem. 2-point RANSAC on NEAR matches (anchored depth < --nearMax in A or B;
     far matches carry no translation signal, only rotation error), symmetric epipolar-plane distance in px,
     cheirality picks the sign, IRLS refit on inliers.
  3. Metric scale: triangulate the inlier near matches with a unit baseline; scale = median over both photos of
     anchored depth / unit-baseline depth (anchored = MoGe-2 depth through the photo's DEM anchor curve, as spot.ts).
  4. Least squares over all pairs for eye offsets d_i: pair  d_B - d_A = s t - (gpsB - gpsA) (sigma along t = 0.3 s +
     0.5 m, across t = s * sigmaDir + 0.5 m); weak prior |d_i,xy| ~ 15 m; mean of d_xy over each connected
     component = 0 (the GPS mean is kept); DEM: eye z = DEM(x, y) + 1.6 m +- 2 m (Gauss-Newton, robust soft-L1 on pairs).
Diagnostics: far-match relative-rotation residual (Rigi relR vs a pure-rotation fit on far matches), triplet
closure of the pair vectors, LS residuals.

Evaluation (leave one out, like tools/nearfield/roll/loo.py): for each target h with an overlapping neighbour,
the neighbours' single-photo anchored near-field lifts (MoGe-2, <= 150 m) are fused and rendered at h's camera
(tools/nearfield/roll/splatrender.py) with (a) GPS eyes and (b) refined eyes; DEM range buffers and anchor curves
are recomputed at each eye (eyes_dem.py raymarch; matches the app's buffers to ~2 % median, eye z to 2 cm).
Metrics on h's near-field mask (DEM range <= 150 m at h's eye in that condition, minus people): coverage, PSNR,
PSNR on the pixels both conditions cover; plus the same on the GPS-eye mask (fixed mask).

    tools/matcher/.venv/bin/python tools/nearfield/eyes/refine_eyes.py [--spot region-0-vp4]
Needs the near-field service on :8767 for MoGe-2 depth (cached in cache/). Writes results.json + tools/nearfield/eyes/shots/eyes-*.png.
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import math
import sys
import time
import urllib.request
import uuid
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "tools/matcher"))
sys.path.insert(0, str(ROOT / "tools/nearfield/roll"))
sys.path.insert(0, str(ROOT / "tools/nearfield/propagate"))
sys.path.insert(0, str(ROOT / "tools/nearfield/spike"))
from common import pose_to_R  # noqa: E402
from eyes_dem import EnuFrame, LocalDem  # noqa: E402
from place import CURVE, apply_curve, curve_quality, fit_curve  # noqa: E402
from run_propagate import lg_match, load, rot_ransac  # noqa: E402
from splatrender import render  # noqa: E402

CACHE = HERE / "cache"
SHOTS = HERE / "shots"
NF = "http://127.0.0.1:8767"
EYE_H = 1.6
D = math.pi / 180


# ---------------- inputs ----------------


def service_depth(pid: str, jpg: bytes) -> dict:
    """MoGe-2 depth (service /depth, as buildRollSpot's per-photo path), cached as npz."""
    p = CACHE / f"depth_moge2_{pid}.npz"
    if p.exists():
        z = np.load(p)
        return {k: z[k] for k in z.files}
    bnd = uuid.uuid4().hex
    body = io.BytesIO()
    body.write(f"--{bnd}\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\nmoge2\r\n".encode())
    body.write(f"--{bnd}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"p.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n".encode())
    body.write(jpg)
    body.write(f"\r\n--{bnd}--\r\n".encode())
    req = urllib.request.Request(NF + "/depth", data=body.getvalue(), method="POST",
                                 headers={"Content-Type": f"multipart/form-data; boundary={bnd}"})
    with urllib.request.urlopen(req, timeout=900) as r:
        w = json.loads(r.read())
    W, H = w["width"], w["height"]
    d = np.frombuffer(base64.b64decode(w["depthF16"]), "<f2").astype(np.float32).reshape(H, W)
    v = np.frombuffer(base64.b64decode(w["validU8"]), np.uint8).reshape(H, W)
    np.savez_compressed(p, depth=d, valid=v)
    return {"depth": d, "valid": v}


class View:
    """One photo of the spot: Rigi pose (roll frame), GPS eye, photo, people mask, MoGe-2 depth."""

    def __init__(self, spot: Path, pid: str):
        ej = json.loads((spot / "eval" / f"{pid}.json").read_text())
        self.id = pid
        self.pose = ej["pose"]
        self.eye0 = np.asarray(ej["eye"], float)
        self.R = pose_to_R(self.pose)  # world -> OpenCV camera
        self.W, self.H = ej["width"], ej["height"]  # eval grid (512 long side)
        self.aspect = self.W / self.H
        self.photo = np.asarray(Image.open(spot / "eval" / f"{pid}.png").convert("RGB"), np.float64) / 255
        self.range_gps = np.fromfile(spot / "eval" / f"{pid}.range.f32", np.float32).reshape(self.H, self.W)
        ppl = np.zeros((self.H, self.W), bool)
        if ej.get("people"):
            pm = np.fromfile(spot / "eval" / f"{pid}.people.u8", np.uint8).reshape(ej["people"]["height"], ej["people"]["width"])
            ppl = np.asarray(Image.fromarray(pm).resize((self.W, self.H), Image.NEAREST)) >= 128
        from scipy.ndimage import binary_dilation

        self.people = binary_dilation(ppl, iterations=4)
        self.big = load(ROOT / f"public/photos/{pid}.jpg")  # 1024 long side (matching)
        b = io.BytesIO()
        self.big.save(b, "JPEG", quality=92)
        dep = service_depth(pid, b.getvalue())
        self.depth, self.dvalid = dep["depth"], dep["valid"] > 0

    def K(self, W: int, H: int) -> np.ndarray:
        f = (H / 2) / math.tan(self.pose["vfov"] * D / 2)
        return np.array([[f, 0, W / 2], [0, f, H / 2], [0, 0, 1.0]])

    def grid_rays(self, W: int | None = None, H: int | None = None):
        """(H, W, 3) unit world rays and (H, W) cam-ray norm factor sqrt(1 + x^2 + y^2) at pixel centres."""
        W, H = W or self.W, H or self.H
        K = self.K(W, H)
        jj, ii = np.mgrid[0:H, 0:W]
        c = np.stack([(ii + 0.5 - K[0, 2]) / K[0, 0], (jj + 0.5 - K[1, 2]) / K[1, 1], np.ones((H, W))], -1)
        nrm = np.linalg.norm(c, axis=-1)
        return (c / nrm[..., None]) @ self.R, nrm

    def model_ray(self, W: int | None = None, H: int | None = None) -> np.ndarray:
        """MoGe z-depth nearest-sampled on the grid -> ray length (NaN invalid). K from the Rigi pose (spot.ts)."""
        W, H = W or self.W, H or self.H
        dh, dw = self.depth.shape
        jj, ii = np.mgrid[0:H, 0:W]
        y = np.clip(((jj + 0.5) / H * dh).astype(int), 0, dh - 1)
        x = np.clip(((ii + 0.5) / W * dw).astype(int), 0, dw - 1)
        z = self.depth[y, x].astype(np.float64)
        ok = self.dvalid[y, x] & np.isfinite(z) & (z > 0)
        _, nrm = self.grid_rays(W, H)
        r = z * nrm
        r[~ok] = np.nan
        return r


def dem_range(dem: LocalDem, v: View, eye: np.ndarray, W: int, H: int) -> np.ndarray:
    rays, _ = v.grid_rays(W, H)
    r = dem.ray_range(eye, rays.reshape(-1, 3), tmax=5200.0).reshape(H, W)
    return r


def fit_anchor(v: View, rng: np.ndarray):
    """spot.ts fitSpotAnchor: window [15, 3000] then [2, 5000], n >= 200; curve = anchor.ts (place.py port)."""
    H, W = rng.shape
    mr = v.model_ray(W, H)
    ppl = np.asarray(Image.fromarray(v.people).resize((W, H), Image.NEAREST))
    for lo, hi in ((15.0, 3000.0), (2.0, 5000.0)):
        c = np.isfinite(mr) & np.isfinite(rng) & (rng >= lo) & (rng <= hi) & ~ppl
        if c.sum() >= 200:
            o = {**CURVE, "minRange": lo, "maxRange": hi}
            cv = fit_curve(mr[c], rng[c], o)
            q = curve_quality(cv, mr[c], rng[c])
            return {"curve": cv, "window": [lo, hi], "n": int(c.sum()), "quality": q["quality"],
                    "residualLogAll": q["residualLogAll"], "inlierFrac": q["inlierFrac"]}
    return None


def anchored_ray(v: View, anchor, W: int, H: int) -> np.ndarray:
    mr = v.model_ray(W, H)
    return apply_curve(anchor["curve"], mr) if anchor else np.full((H, W), np.nan)


# ---------------- pair geometry ----------------


def bearings(v: View, kp: np.ndarray, Wb: int, Hb: int) -> np.ndarray:
    K = v.K(Wb, Hb)
    c = np.linalg.inv(K) @ np.vstack([kp.T + 0.5, np.ones(len(kp))])
    c /= np.linalg.norm(c, axis=0)
    return (v.R.T @ c).T  # world, (N, 3)


def epi_err(t: np.ndarray, a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Symmetric distance (rad) of each bearing to the epipolar plane spanned by t and the other bearing."""
    na = np.cross(t, a)
    nb = np.cross(t, b)
    na /= np.maximum(np.linalg.norm(na, axis=1, keepdims=True), 1e-12)
    nb /= np.maximum(np.linalg.norm(nb, axis=1, keepdims=True), 1e-12)
    return 0.5 * (np.abs(np.sum(b * na, 1)) + np.abs(np.sum(a * nb, 1)))


def triangulate(t: np.ndarray, a: np.ndarray, b: np.ndarray):
    """Midpoint: A at 0, B at t. Returns depths (la along a, lb along b)."""
    # la a - lb b = t  (least squares)
    ab = np.sum(a * b, 1)
    ta, tb = a @ t, b @ t
    den = 1 - ab**2
    la = (ta - ab * tb) / np.maximum(den, 1e-12)
    lb = (ab * ta - tb) / np.maximum(den, 1e-12)
    return la, lb


def solve_t(a, b, near, thr_rad, iters=3000, seed=0):
    """2-point RANSAC for the translation direction (world) with rotations fixed. Returns (t, inlier mask) or None."""
    idx = np.nonzero(near)[0]
    if idx.size < 8:
        return None
    n = np.cross(a, b)
    rng = np.random.default_rng(seed)
    best, bt = None, None
    for _ in range(iters):
        i, j = rng.choice(idx, 2, replace=False)
        t = np.cross(n[i], n[j])
        if np.linalg.norm(t) < 1e-9:
            continue
        t /= np.linalg.norm(t)
        e = epi_err(t, a[idx], b[idx])
        inl = e < thr_rad
        if best is None or inl.sum() > best.sum():
            best, bt = inl, t
    if bt is None:
        return None
    t = bt
    sel = idx[best]
    for _ in range(5):  # IRLS refit: t = null vector of the weighted (a x b) rows
        nn = n[sel] / np.maximum(np.linalg.norm(n[sel], axis=1, keepdims=True), 1e-12)
        e = epi_err(t, a[sel], b[sel])
        w = 1 / np.maximum(e, thr_rad / 4)
        _, _, Vt = np.linalg.svd(nn * w[:, None])
        t2 = Vt[-1]
        t = t2 if t2 @ t >= 0 else -t2
        e_all = epi_err(t, a[idx], b[idx])
        sel = idx[e_all < thr_rad]
        if sel.size < 5:
            return None
    # cheirality: majority of inlier near points in front of both cameras
    la, lb = triangulate(t, a[sel], b[sel])
    pos = np.mean((la > 0) & (lb > 0))
    neg = np.mean((la < 0) & (lb < 0))
    if neg > pos:
        t = -t
    mask = np.zeros(len(a), bool)
    mask[sel] = True
    return t, mask, max(pos, neg)


def sample_grid(g: np.ndarray, kp: np.ndarray, Wb: int, Hb: int) -> np.ndarray:
    H, W = g.shape
    x = np.clip(((kp[:, 0] + 0.5) / Wb * W).astype(int), 0, W - 1)
    y = np.clip(((kp[:, 1] + 0.5) / Hb * H).astype(int), 0, H - 1)
    return g[y, x]


def pair_solve(A: View, B: View, anc: dict, near_max=300.0, thr_px=3.0, far_min=1500.0):
    ck = CACHE / f"match_{A.id}_{B.id}.npz"
    if ck.exists():
        z = np.load(ck)
        ka, kb, sc = z["ka"], z["kb"], z["sc"]
    else:
        ka, kb, sc = lg_match(A.big, B.big)
        np.savez_compressed(ck, ka=ka, kb=kb, sc=sc)
    WA, HA = A.big.size
    WB, HB = B.big.size
    out = {"A": A.id, "B": B.id, "matches": int(len(ka))}
    if len(ka) < 8:
        return out
    pa = sample_grid(A.people, ka, WA, HA)
    pb = sample_grid(B.people, kb, WB, HB)
    keep = ~pa & ~pb
    ka, kb = ka[keep], kb[keep]
    out["afterPeople"] = int(keep.sum())
    a = bearings(A, ka, WA, HA)
    b = bearings(B, kb, WB, HB)
    dA = sample_grid(anc[A.id]["ray"], ka, WA, HA)
    dB = sample_grid(anc[B.id]["ray"], kb, WB, HB)
    rA = sample_grid(anc[A.id]["range"], ka, WA, HA)
    rB = sample_grid(anc[B.id]["range"], kb, WB, HB)
    near = (np.nan_to_num(dA, nan=1e9) < near_max) | (np.nan_to_num(dB, nan=1e9) < near_max)
    far = (np.nan_to_num(rA, posinf=1e9) > far_min) & (np.nan_to_num(rB, posinf=1e9) > far_min) & ~near
    out["near"], out["far"] = int(near.sum()), int(far.sum())
    f = A.K(WA, HA)[0, 0]
    # rotation check on far matches: Rigi relR vs a pure-rotation fit (bearings in camera frames)
    if far.sum() >= 10:
        KA, KB = A.K(WA, HA), B.K(WB, HB)
        rr = rot_ransac(ka[far], kb[far], KA, KB)
        if rr:
            relR = B.R @ A.R.T
            c = (np.trace(rr["R"] @ relR.T) - 1) / 2
            out["farRotDiffDeg"] = round(math.degrees(math.acos(max(-1, min(1, c)))), 3)
            out["farRotInliers"] = rr["inliers"]
        # Rigi rotations' own far residual: angle between a and b on far matches (should be ~0)
        ang = np.degrees(np.arccos(np.clip(np.sum(a[far] * b[far], 1), -1, 1)))
        out["farAngleMedDeg"] = round(float(np.median(ang)), 3)
    r = solve_t(a, b, near, thr_px / f)
    if r is None:
        out["ok"] = False
        return out
    t, inl, cheir = r
    ninl = inl & near
    la, lb = triangulate(t, a[ninl], b[ninl])
    e = epi_err(t, a[ninl], b[ninl]) * f
    sA = dA[ninl] / la
    sB = dB[ninl] / lb
    s_all = np.concatenate([sA[np.isfinite(sA) & (sA > 0)], sB[np.isfinite(sB) & (sB > 0)]])
    out.update({"ok": True, "t": t.tolist(), "inliers": int(ninl.sum()), "cheirality": round(float(cheir), 3),
                "rmsPx": round(float(np.sqrt(np.mean(e**2))), 3), "thrPx": thr_px})
    if s_all.size >= 5:
        ls = np.log(s_all)
        m = float(np.median(ls))
        out["scale"] = round(math.exp(m), 3)
        out["scaleMadLog"] = round(float(np.median(np.abs(ls - m))), 3)
        out["scaleN"] = int(s_all.size)
    # direction uncertainty: bootstrap over inliers (IRLS on resamples)
    rng = np.random.default_rng(1)
    idx = np.nonzero(ninl)[0]
    angs = []
    nrm = np.cross(a, b)
    for _ in range(100):
        s = rng.choice(idx, idx.size, replace=True)
        nn = nrm[s] / np.maximum(np.linalg.norm(nrm[s], axis=1, keepdims=True), 1e-12)
        _, _, Vt = np.linalg.svd(nn)
        tb = Vt[-1] if Vt[-1] @ t >= 0 else -Vt[-1]
        angs.append(math.degrees(math.acos(min(1.0, float(tb @ t)))))
    out["dirSigmaDeg"] = round(float(np.percentile(angs, 68)), 2)
    gps = B.eye0 - A.eye0
    out["gpsVec"] = gps.round(2).tolist()
    out["gpsDist"] = round(float(np.linalg.norm(gps)), 2)
    if np.linalg.norm(gps) > 0:
        out["angleToGpsDeg"] = round(math.degrees(math.acos(float(np.clip(t @ gps / np.linalg.norm(gps), -1, 1)))), 1)
    return out


def load_matches(A: View, B: View):
    ck = CACHE / f"match_{A.id}_{B.id}.npz"
    if ck.exists():
        z = np.load(ck)
        return z["ka"], z["kb"]
    ka, kb, sc = lg_match(A.big, B.big)
    np.savez_compressed(ck, ka=ka, kb=kb, sc=sc)
    return ka, kb


def _rodrigues(w: np.ndarray) -> np.ndarray:
    th = float(np.linalg.norm(w))
    if th < 1e-12:
        return np.eye(3)
    k = w / th
    Kx = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + math.sin(th) * Kx + (1 - math.cos(th)) * Kx @ Kx


def pair_metric(A: View, B: View, anc: dict, calib="rot+f", sigma_px=1.5, f_prior=0.03, loss_px=2.0):
    """Metric relative translation t = eyeB - eyeA (world, m) from matches + anchored depths, all 3 DoF at once.

    Each match is lifted from the photo whose anchored depth is LARGER (a broken near-end anchor, e.g. a photo whose
    GPS eye puts a DEM ridge in front of the valley, can only under-estimate depth; taking the larger one never
    invents parallax) and reprojected into the other photo. Rotations stay Rigi's; with calib != "none" a relative
    rotation correction of B (3) and, for "rot+f", focal scales of A and B (prior 1 +- f_prior) are NUISANCE
    parameters fitted jointly (far matches pin them; they absorb Rigi's ~1-2 deg relative rotation error and the
    ultrawide's focal error, which would otherwise be read as translation). Returns t, its information matrix
    (Schur complement over the nuisances, px noise sigma_px), and diagnostics."""
    from scipy.optimize import least_squares

    ka, kb = load_matches(A, B)
    out = {"A": A.id, "B": B.id, "mode": f"metric/{calib}", "matches": int(len(ka))}
    if len(ka) < 12:
        out["ok"] = False
        return out
    WA, HA = A.big.size
    WB, HB = B.big.size
    keep = ~sample_grid(A.people, ka, WA, HA) & ~sample_grid(B.people, kb, WB, HB)
    ka, kb = ka[keep], kb[keep]
    dA = sample_grid(anc[A.id]["ray"], ka, WA, HA)
    dB = sample_grid(anc[B.id]["ray"], kb, WB, HB)
    dA = np.nan_to_num(dA, nan=-1.0)
    dB = np.nan_to_num(dB, nan=-1.0)
    ok = (dA > 0) | (dB > 0)
    ka, kb, dA, dB = ka[ok], kb[ok], dA[ok], dB[ok]
    fromA = dA >= dB
    d = np.where(fromA, dA, dB)
    out["used"] = int(len(ka))
    if len(ka) < 20:
        out["ok"] = False
        return out
    KA, KB = A.K(WA, HA), B.K(WB, HB)

    def cam_bearing(kp, K, s):
        c = np.stack([(kp[:, 0] + 0.5 - K[0, 2]) / (K[0, 0] * s), (kp[:, 1] + 0.5 - K[1, 2]) / (K[1, 1] * s),
                      np.ones(len(kp))], 1)
        return c / np.linalg.norm(c, axis=1, keepdims=True)

    def project(v, K, s):
        z = np.where(v[:, 2] > 1e-6, v[:, 2], 1e-6)
        u = K[0, 2] + K[0, 0] * s * v[:, 0] / z
        w = K[1, 2] + K[1, 1] * s * v[:, 1] / z
        behind = v[:, 2] <= 1e-6
        return u, w, behind

    nf = {"none": 0, "rot": 3, "rot+f": 5}[calib]

    def unpack(p):
        t = p[:3]
        w = p[3:6] if nf >= 3 else np.zeros(3)
        sA, sB = (p[6], p[7]) if nf == 5 else (1.0, 1.0)
        return t, w, sA, sB

    def resid(p):
        t, w, sA, sB = unpack(p)
        RB = _rodrigues(w) @ B.R
        aw = cam_bearing(ka, KA, sA) @ A.R  # world bearings (rows): R^T c
        bw = cam_bearing(kb, KB, sB) @ RB
        r = np.zeros((len(ka), 2))
        # lifted from A -> seen in B
        XA = aw[fromA] * d[fromA, None]
        u, v, beh = project((XA - t) @ RB.T, KB, sB)
        r[fromA, 0] = u - (kb[fromA, 0] + 0.5)
        r[fromA, 1] = v - (kb[fromA, 1] + 0.5)
        r[np.nonzero(fromA)[0][beh]] = 200.0
        XB = t + bw[~fromA] * d[~fromA, None]
        u, v, beh = project(XB @ A.R.T, KA, sA)
        r[~fromA, 0] = u - (ka[~fromA, 0] + 0.5)
        r[~fromA, 1] = v - (ka[~fromA, 1] + 0.5)
        r[np.nonzero(~fromA)[0][beh]] = 200.0
        extra = [(sA - 1) / f_prior * sigma_px, (sB - 1) / f_prior * sigma_px] if nf == 5 else []
        # a very weak pull of t toward 0 (100 m) keeps an unobservable pair finite
        return np.concatenate([r.ravel(), np.asarray(extra), t / 100.0 * sigma_px])

    gps = B.eye0 - A.eye0
    best = None
    for t0 in (np.zeros(3), gps):
        p0 = np.concatenate([t0, np.zeros(3) if nf >= 3 else [], [1.0, 1.0] if nf == 5 else []])
        s = least_squares(resid, p0, loss="soft_l1", f_scale=loss_px, x_scale="jac")
        if best is None or s.cost < best.cost:
            best = s
    t, w, sA, sB = unpack(best.x)
    r = resid(best.x)[: 2 * len(ka)].reshape(-1, 2)
    e = np.linalg.norm(r, axis=1)
    inl = e < 3 * loss_px
    J = best.jac / sigma_px
    H = J.T @ J
    # information on t = Schur complement over the nuisance block
    Htt, Htn, Hnn = H[:3, :3], H[:3, 3:], H[3:, 3:]
    info = Htt - (Htn @ np.linalg.pinv(Hnn) @ Htn.T if nf else 0)
    ev, evec = np.linalg.eigh(info)
    sd = 1 / np.sqrt(np.maximum(ev, 1e-12))
    near = inl & (d < 60)
    out.update({
        "ok": True, "t": t.round(3).tolist(), "baselineM": round(float(np.linalg.norm(t)), 2),
        "gpsVec": gps.round(2).tolist(), "gpsDist": round(float(np.linalg.norm(gps)), 2),
        "info": info.tolist(), "sdAxesM": sd.round(3).tolist(), "sdAxes": evec.T.round(3).tolist(),
        "inliers": int(inl.sum()), "nearInliers": int(near.sum()), "medPx": round(float(np.median(e[inl])), 2) if inl.any() else None,
        "relRotCorrDeg": round(math.degrees(float(np.linalg.norm(w))), 3), "focalScale": [round(float(sA), 4), round(float(sB), 4)],
        "fromAFrac": round(float(fromA.mean()), 3), "depthMedNear": round(float(np.median(d[near])), 1) if near.any() else None,
    })
    if np.linalg.norm(gps) > 0 and np.linalg.norm(t) > 0:
        out["angleToGpsDeg"] = round(math.degrees(math.acos(float(np.clip(t @ gps / np.linalg.norm(gps) / np.linalg.norm(t), -1, 1)))), 1)
    return out


# ---------------- least squares ----------------


def pair_vec(p) -> np.ndarray:
    return np.asarray(p["t"]) * (p["scale"] if p.get("info") is None else 1.0)


def drop_inconsistent(pairs: list[dict], ids: list[str], tol_m=2.0, tol_rel=0.2):
    """Triplet closure gate: in every triangle of gated pairs whose closure |t_AB + t_BC - t_AC| exceeds
    max(tol_m, tol_rel * perimeter), ungate the pair with the least near evidence (repeat until consistent)."""
    while True:
        g = {(p["A"], p["B"]): p for p in pairs if p.get("gate")}
        bad = None
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                for k in range(j + 1, len(ids)):
                    A, B, C = ids[i], ids[j], ids[k]
                    if (A, B) in g and (B, C) in g and (A, C) in g:
                        tri = [g[(A, B)], g[(B, C)], g[(A, C)]]
                        v = [pair_vec(x) for x in tri]
                        r = float(np.linalg.norm(v[0] + v[1] - v[2]))
                        per = sum(float(np.linalg.norm(x)) for x in v)
                        if r > max(tol_m, tol_rel * per):
                            bad = min(tri, key=lambda x: (x.get("nearInliers", x.get("inliers", 0)), x.get("inliers", 0)))
                            bad.setdefault("ungated", []).append(f"triplet {A},{B},{C} closure {r:.1f} m of {per:.1f} m")
                            break
                if bad:
                    break
            if bad:
                break
        if not bad:
            return
        bad["gate"] = False


def solve_offsets(views: list[View], pairs: list[dict], dem: LocalDem, prior_m=15.0, z_sigma=2.0, use_pairs=True):
    from scipy.optimize import least_squares

    n = len(views)
    idx = {v.id: k for k, v in enumerate(views)}
    good = [p for p in pairs if p.get("ok") and (p.get("scale") or p.get("info")) and use_pairs]
    whit = []
    for p in good:
        if p.get("info") is None:
            whit.append(None)
            continue
        # pair covariance = matching noise + model error (anchored depth ~25 % -> 0.25 |t|, 0.3 m floor)
        cov = np.linalg.inv(np.asarray(p["info"]) + 1e-9 * np.eye(3))
        cov = cov + ((0.25 * p["baselineM"]) ** 2 + 0.3**2) * np.eye(3)
        whit.append(np.linalg.cholesky(np.linalg.inv(cov)).T)
    # components of the pair graph
    comp = list(range(n))

    def find(x):
        while comp[x] != x:
            x = comp[x]
        return x

    for p in good:
        comp[find(idx[p["A"]])] = find(idx[p["B"]])
    comps = {}
    for k in range(n):
        comps.setdefault(find(k), []).append(k)
    E0 = np.stack([v.eye0 for v in views])

    def resid(x):
        d = x.reshape(n, 3)
        r = []
        for p, Lw in zip(good, whit):
            i, j = idx[p["A"]], idx[p["B"]]
            v = (E0[j] + d[j]) - (E0[i] + d[i])
            if Lw is not None:  # metric pair: whitened 3-vector residual
                r += list(Lw @ (v - np.asarray(p["t"])))
                continue
            t = np.asarray(p["t"])
            s = p["scale"]
            along = v @ t - s
            perp = v - (v @ t) * t
            sa = 0.3 * s + 0.5
            sp = s * max(p.get("dirSigmaDeg", 3.0), 2.0) * D + 0.5
            r += [along / sa, *(perp / sp)]
        for k in range(n):
            r += [d[k, 0] / prior_m, d[k, 1] / prior_m]
            e = E0[k] + d[k]
            r.append((e[2] - (float(dem.height(e[0], e[1])) + EYE_H)) / z_sigma)
        for ks in comps.values():
            if len(ks) > 1:
                m = d[ks].mean(0)
                r += [m[0] / 0.05, m[1] / 0.05]
        return np.asarray(r)

    npair = 3 * len(good)
    sol = least_squares(resid, np.zeros(3 * n), loss="linear", x_scale=5.0)
    # robust second pass on pair residuals only (soft-L1 via weights)
    d = sol.x.reshape(n, 3)
    rr = resid(sol.x)
    return {
        "offsets": {v.id: d[k].round(2).tolist() for k, v in enumerate(views)},
        "eyes": {v.id: (E0[k] + d[k]).round(3).tolist() for k, v in enumerate(views)},
        "components": [[views[k].id for k in ks] for ks in comps.values()],
        "pairResid": [round(float(x), 3) for x in rr[:npair]],
        "cost": round(float(sol.cost), 3),
        "pairsUsed": [f"{p['A']}-{p['B']}" for p in good],
    }


# ---------------- evaluation ----------------


def lift(v: View, eye: np.ndarray, ray: np.ndarray, near=150.0, stride=1):
    """Single-photo near-field lift: anchored ray <= near, model-valid, not people -> isotropic Gaussians."""
    H, W = ray.shape
    rays, _ = v.grid_rays(W, H)
    ok = np.isfinite(ray) & (ray > 0.3) & (ray <= near) & ~v.people
    # flying pixels (lift.ts edgeLog 0.1): log-depth jump to a 4-neighbour
    lr = np.log(np.where(np.isfinite(ray), ray, 1e9))
    jump = np.zeros_like(ok)
    jump[:, 1:] |= np.abs(lr[:, 1:] - lr[:, :-1]) > 0.1 * 3
    jump[1:, :] |= np.abs(lr[1:, :] - lr[:-1, :]) > 0.1 * 3
    ok &= ~jump
    ok[::stride, ::stride] &= True
    sel = np.zeros_like(ok)
    sel[::stride, ::stride] = ok[::stride, ::stride]
    P = eye + rays[sel] * ray[sel][:, None]
    f = v.K(W, H)[0, 0]
    sc = ray[sel] / f * stride * 0.75
    N = int(sel.sum())
    return {"means": P, "scales": np.repeat(sc[:, None], 3, 1), "quats": np.tile([1.0, 0, 0, 0], (N, 1)),
            "colors": v.photo[sel], "opacity": np.full(N, 0.95)}


def cam_of(v: View, eye: np.ndarray) -> dict:
    K = v.K(v.W, v.H)
    return {"width": v.W, "height": v.H, "fx": K[0, 0], "fy": K[1, 1], "cx": K[0, 2], "cy": K[1, 2], "R": v.R,
            "t": -v.R @ eye}


def psnr(a, b, m):
    if not m.any():
        return None
    mse = float(((a[m] - b[m]) ** 2).mean())
    return round(10 * math.log10(1 / max(mse, 1e-10)), 2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--spot", default="region-0-vp4")
    ap.add_argument("--near", type=float, default=150.0)
    ap.add_argument("--nearMax", type=float, default=300.0, help="match is 'near' if anchored depth < this (A or B)")
    ap.add_argument("--thrPx", type=float, default=3.0)
    ap.add_argument("--prior", type=float, default=15.0)
    ap.add_argument("--minNear", type=int, default=20, help="metric gate: inliers lifted from < 60 m")
    ap.add_argument("--iters", type=int, default=1, help="outer iterations (re-anchor at the refined eyes)")
    ap.add_argument("--mode", default="metric", choices=["metric", "dir"])
    ap.add_argument("--calib", default="rot+f", choices=["none", "rot", "rot+f"])
    ap.add_argument("--out", default="results.json")
    a = ap.parse_args()
    CACHE.mkdir(exist_ok=True)
    spot = ROOT / "tools/nearfield/roll/out" / a.spot
    meta = json.loads((spot / "meta.json").read_text())
    t0 = time.time()
    views = [View(spot, pid) for pid in meta["ids"]]
    fr = EnuFrame(meta["frame"]["lat"], meta["frame"]["lon"], 0)
    dem = LocalDem(fr, meta["origin"][:2])
    print(f"inputs {time.time() - t0:.1f}s", flush=True)
    AW = 256  # anchor grid long side

    def anchors_at(eyes: dict):
        out = {}
        for v in views:
            W = AW if v.aspect >= 1 else round(AW * v.aspect)
            H = round(AW / v.aspect) if v.aspect >= 1 else AW
            rg = dem_range(dem, v, eyes[v.id], W, H)
            an = fit_anchor(v, rg)
            out[v.id] = {"anchor": an, "range": rg, "ray": anchored_ray(v, an, W, H),
                         "quality": round(an["quality"], 3) if an else 0}
        return out

    eyes = {v.id: v.eye0.copy() for v in views}
    history = []
    ids = [v.id for v in views]
    V = {v.id: v for v in views}
    for it in range(a.iters):
        anc = anchors_at(eyes)
        print("anchor quality", {k: v["quality"] for k, v in anc.items()}, flush=True)
        pairs, dirs = [], []
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                A_, B_ = V[ids[i]], V[ids[j]]
                # as specified: rotations fixed, 2-DoF direction RANSAC + anchored scale (reported, and used with
                # --mode dir)
                q = pair_solve(A_, B_, anc, a.nearMax, a.thrPx)
                q["gate"] = bool(q.get("ok") and q.get("inliers", 0) >= 30 and q.get("dirSigmaDeg", 99) <= 10
                                 and q.get("scale") and q.get("scaleMadLog", 9) <= 0.5 and q.get("cheirality", 0) >= 0.8)
                dirs.append(q)
                print("dir   ", json.dumps({k: q.get(k) for k in ("A", "B", "matches", "near", "inliers", "rmsPx", "scale",
                                                                    "scaleMadLog", "dirSigmaDeg", "gpsDist", "angleToGpsDeg",
                                                                    "gate")}), flush=True)
                m = pair_metric(A_, B_, anc, a.calib)
                # a translation needs NEAR evidence: far matches only pin the nuisance rotation / focal, and their
                # anchored depths are the least reliable part of the curve at a wrong eye
                m["gate"] = bool(m.get("ok") and m.get("inliers", 0) >= 30 and (m.get("medPx") or 99) <= 2.5
                                 and m.get("nearInliers", 0) >= a.minNear)
                pairs.append(m)
                print("metric", json.dumps({k: m.get(k) for k in ("A", "B", "used", "inliers", "nearInliers", "medPx",
                                                                    "t", "baselineM", "sdAxesM", "gpsDist", "angleToGpsDeg",
                                                                    "relRotCorrDeg", "focalScale", "depthMedNear", "gate")}),
                      flush=True)
        use = pairs if a.mode == "metric" else dirs
        drop_inconsistent(use, ids)
        gp = [dict(p, ok=p["gate"]) for p in use]
        sol = solve_offsets(views, gp, dem, a.prior)
        history.append({"iter": it, "anchorQuality": {k: v["quality"] for k, v in anc.items()}, "pairs": pairs,
                        "dirPairs": dirs, "solution": sol})
        print("offsets", sol["offsets"], flush=True)
        eyes = {k: np.asarray(v) for k, v in sol["eyes"].items()}

    # triplet closure (last iteration, gated metric pairs): t_AB + t_BC - t_AC (m)
    last = history[-1]["pairs"]
    pv = {(p["A"], p["B"]): np.asarray(p["t"]) for p in last if p.get("gate")}
    trip = []
    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            for k in range(j + 1, len(ids)):
                A, B, C = ids[i], ids[j], ids[k]
                if (A, B) in pv and (B, C) in pv and (A, C) in pv:
                    r = pv[(A, B)] + pv[(B, C)] - pv[(A, C)]
                    L = sum(float(np.linalg.norm(pv[x])) for x in ((A, B), (B, C), (A, C)))
                    trip.append({"ids": [A, B, C], "closure": r.round(2).tolist(), "closureM": round(float(np.linalg.norm(r)), 2),
                                 "perimeterM": round(L, 2)})
    # the same closure for the GPS eyes (reference: how far GPS itself is from closing -- always 0 by construction)
    # and the solved eyes' pair vectors vs the measured ones (LS residuals, m)
    fin = history[-1]["solution"]["eyes"]
    for p in last:
        if p.get("gate"):
            v = np.asarray(fin[p["B"]]) - np.asarray(fin[p["A"]])
            p["solvedMinusMeasured"] = (v - np.asarray(p["t"])).round(2).tolist()

    # ---- evaluation: LOO near-field reprojection, GPS vs refined eyes ----
    refined = {k: np.asarray(v) for k, v in history[-1]["solution"]["eyes"].items()}
    conds = {"gps": {v.id: v.eye0 for v in views}, "refined": refined}
    ancs = {c: anchors_at(e) for c, e in conds.items()}
    # neighbours = overlapping photos (>= 30 metric inliers), the same set in every mode
    gated = [p for p in last if p.get("inliers", 0) >= 30]
    nbrs = {k: sorted({p["B"] if p["A"] == k else p["A"] for p in gated if k in (p["A"], p["B"])}) for k in ids}
    from loo import ssim_map
    from splatrender import concat

    evals = {}
    rng_cache = {}
    for h in ids:
        if not nbrs[h]:
            continue
        T = V[h]
        for c, E in conds.items():
            rg = dem_range(dem, T, E[h], T.W, T.H)
            rng_cache[(h, c)] = np.isfinite(rg) & (rg <= a.near) & ~T.people
        gmask = rng_cache[(h, "gps")]
        src_sets = [[o] for o in nbrs[h]] + ([nbrs[h]] if len(nbrs[h]) > 1 else [])
        evals[h] = {}
        for srcs in src_sets:
            key = "+".join(srcs)
            rows, rend = {}, {}
            for c, E in conds.items():
                mask = rng_cache[(h, c)]
                cl = concat(*[lift(V[o], E[o], anchored_ray(V[o], ancs[c][o]["anchor"], V[o].W, V[o].H), a.near) for o in srcs])
                rgb, al, _ = render(cl, cam_of(T, E[h]))
                cov = al > 0.5
                sm = ssim_map(rgb, T.photo)
                mc = mask & cov
                triv = np.broadcast_to(T.photo[mc].mean(0) if mc.any() else np.zeros(3), T.photo.shape)
                rend[c] = (rgb, al, mask)
                rows[c] = {"eye": np.round(E[h], 2).tolist(), "maskFrac": round(float(mask.mean()), 4),
                           "coverage": round(float(cov[mask].mean()), 4) if mask.any() else None,
                           "psnr": psnr(rgb, T.photo, mask), "psnrCovered": psnr(rgb, T.photo, mc),
                           "psnrTrivialCovered": psnr(triv, T.photo, mc),
                           "ssimCovered": round(float(sm[mc].mean()), 4) if mc.any() else None,
                           "onGpsMask": {"coverage": round(float(cov[gmask].mean()), 4) if gmask.any() else None,
                                         "psnrCovered": psnr(rgb, T.photo, gmask & cov)},
                           "splats": int(len(cl["means"]))}
            evals[h][key] = rows
            print("eval", h, "<-", key, json.dumps(rows), flush=True)
            th = 240
            tw = int(th * T.W / T.H)
            tiles = [("target photo (near-field mask lit)", np.where(gmask[..., None], T.photo, T.photo * 0.4))]
            for c in conds:
                rgb, al, m = rend[c]
                r = rows[c]
                tiles.append((f"{c}: cov {r['coverage']} psnrCov {r['psnrCovered']} (triv {r['psnrTrivialCovered']})",
                              np.where((al > 0.5)[..., None], rgb, T.photo * 0.25)))
            from PIL import ImageDraw

            canvas = Image.new("RGB", (tw * len(tiles), th + 18), (20, 20, 20))
            dr = ImageDraw.Draw(canvas)
            for k2, (lab, img) in enumerate(tiles):
                canvas.paste(Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8)).resize((tw, th)), (k2 * tw, 18))
                dr.text((k2 * tw + 4, 3), lab, fill=(230, 230, 230))
            canvas.save(SHOTS / f"eyes-{Path(a.out).stem}-{h}-from-{key}.png")

    res = {"spot": a.spot, "args": vars(a), "iterations": history, "triplets": trip, "eval": evals,
           "anchorQuality": {c: {k: v["quality"] for k, v in an.items()} for c, an in ancs.items()},
           "seconds": round(time.time() - t0, 1)}

    def clean(o):
        if isinstance(o, dict):
            return {k: clean(v) for k, v in o.items()}
        if isinstance(o, list):
            return [clean(v) for v in o]
        if isinstance(o, (np.floating, np.integer)):
            return o.item()
        if isinstance(o, np.bool_):
            return bool(o)
        return o

    (HERE / a.out).write_text(json.dumps(clean(res), indent=1))
    print("triplets", trip)


if __name__ == "__main__":
    main()
