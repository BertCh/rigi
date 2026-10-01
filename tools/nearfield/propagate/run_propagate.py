"""P2 exploration: pose propagation within a viewpoint.

An anchor photo A with an accepted pose proposes a pose for a neighbour B via the relative rotation
relR (A-camera -> B-camera, OpenCV axes):  R_B = relR @ R_A  (R = world->OpenCV camera, FORMAT.md).

Estimators of relR:
  da3   : POST /multiview (DA3-Base) on [A, B]; c2w[1] is B-cam -> A-cam, so relR = c2w[1][:3,:3]^T.
  rot   : ALIKED+LightGlue (CPU, deterministic) + 2-point RANSAC pure-rotation model on bearing vectors
          (intrinsics from the anchor GT / target EXIF vfov).
  ess   : same matches, cv2.findEssentialMat + recoverPose (general motion) on normalised coordinates.

Data (no data_v3, no test split):
  real  : the GT viewpoint IMG_7053/7059/7063/7068/7086 (within 210 m), all 20 ordered pairs, GT poses from
          data/ground-truth.json (quality 'good' or 'approx'). Target intrinsics from photos.json EXIF vfov.
  synth : pure-rotation virtual views warped out of single real photos (GT-12 set + wild DEV split only), with a
          random relative rotation (0..1.4 hfov yaw), zoom change, and a photometric change on B.
          Exact relR by construction; no parallax, no time change (optimistic for the matcher).

Usage: tools/matcher/.venv/bin/python tools/nearfield/propagate/run_propagate.py [--synth N] [--skip-da3]
Writes tools/nearfield/propagate/results.json (+ per-pair cache in cache/).
"""
from __future__ import annotations

import argparse
import http.client
import io
import json
import math
import random
import sys
import time
import urllib.request
import uuid
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageEnhance, ImageFilter

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent.parent
sys.path.insert(0, str(ROOT / "tools/matcher"))
from common import R_to_pose, pose_to_R  # noqa: E402

D = math.pi / 180
CACHE = HERE / "cache"
CACHE.mkdir(exist_ok=True)
NF = "http://127.0.0.1:8767"
VIEWPOINT = ["IMG_7053", "IMG_7059", "IMG_7063", "IMG_7068", "IMG_7086"]
MAXS = 1024  # working image size (long side)

# ---------------- geometry ----------------


def rot_angle(R: np.ndarray) -> float:
    c = (np.trace(R) - 1) / 2
    return math.degrees(math.acos(max(-1.0, min(1.0, c))))


def rot_err(Ra: np.ndarray, Rb: np.ndarray) -> float:
    return rot_angle(Ra @ Rb.T)


def wrap180(a: float) -> float:
    return (a + 180) % 360 - 180


def pose_err(p: dict, g: dict) -> dict:
    return {"yaw": wrap180(p["yaw"] - g["yaw"]), "pitch": p["pitch"] - g["pitch"], "roll": wrap180(p["roll"] - g["roll"])}


def K_of(vfov: float, W: int, H: int) -> np.ndarray:
    f = (H / 2) / math.tan(vfov * D / 2)
    return np.array([[f, 0, W / 2], [0, f, H / 2], [0, 0, 1.0]])


def rodrigues(axis, deg) -> np.ndarray:
    return cv2.Rodrigues(np.asarray(axis, float) / np.linalg.norm(axis) * deg * D)[0]


def cam_rot(dyaw: float, dpitch: float, droll: float) -> np.ndarray:
    """Rotation of a virtual camera relative to a source camera, OpenCV axes (x right, y down, z fwd):
    x_V = Rv x_S. Yaw right (+) about -y, pitch up (+) about +x, roll cw (+) about +z."""
    Ry = rodrigues([0, -1, 0], -dyaw)  # turning the camera right moves scene points left in the camera
    Rp = rodrigues([1, 0, 0], dpitch)
    Rr = rodrigues([0, 0, 1], -droll)
    return (Rr @ Rp @ Ry)


def overlap_frac(relR: np.ndarray, KA, WA, HA, KB, WB, HB) -> float:
    """Fraction of a grid over A whose ray lands inside B (pure rotation)."""
    us, vs = np.meshgrid(np.linspace(0.5, WA - 0.5, 24), np.linspace(0.5, HA - 0.5, 18))
    pts = np.stack([us.ravel(), vs.ravel(), np.ones(us.size)])
    b = relR @ (np.linalg.inv(KA) @ pts)
    ok = b[2] > 1e-6
    pb = KB @ (b / np.where(ok, b[2], 1))
    ins = ok & (pb[0] >= 0) & (pb[0] < WB) & (pb[1] >= 0) & (pb[1] < HB)
    return float(ins.mean())


# ---------------- images ----------------


def load(path: Path, maxs=MAXS) -> Image.Image:
    im = Image.open(path).convert("RGB")
    s = maxs / max(im.size)
    if s < 1:
        im = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
    return im


def jpeg(im: Image.Image) -> bytes:
    b = io.BytesIO()
    im.save(b, "JPEG", quality=92)
    return b.getvalue()


# ---------------- estimators ----------------

_lg = None


def lg_models():
    global _lg
    if _lg is None:
        import torch
        from lightglue import ALIKED, LightGlue
        torch.set_grad_enabled(False)
        _lg = (ALIKED(max_num_keypoints=2048, detection_threshold=0.01).eval(), LightGlue(features="aliked").eval())
    return _lg


def lg_match(a: Image.Image, b: Image.Image):
    import torch
    ext, m = lg_models()
    ta = torch.from_numpy(np.asarray(a)).permute(2, 0, 1).float()[None] / 255
    tb = torch.from_numpy(np.asarray(b)).permute(2, 0, 1).float()[None] / 255
    fa, fb = ext.extract(ta), ext.extract(tb)
    r = m({"image0": fa, "image1": fb})
    mm = r["matches"][0].numpy()
    ka = fa["keypoints"][0].numpy()[mm[:, 0]]
    kb = fb["keypoints"][0].numpy()[mm[:, 1]]
    sc = r["scores"][0].numpy()
    return ka, kb, sc


def kabsch(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """R minimising |b - R a| for unit bearings (3,N)."""
    U, _, Vt = np.linalg.svd(b @ a.T)
    S = np.diag([1, 1, np.sign(np.linalg.det(U @ Vt))])
    return U @ S @ Vt


def rot_ransac(ka, kb, KA, KB, thr_px=4.0, iters=2000, seed=0):
    if len(ka) < 3:
        return None
    ba = np.linalg.inv(KA) @ np.vstack([ka.T + 0.5, np.ones(len(ka))])
    bb = np.linalg.inv(KB) @ np.vstack([kb.T + 0.5, np.ones(len(kb))])
    ba /= np.linalg.norm(ba, axis=0)
    bb /= np.linalg.norm(bb, axis=0)
    thr = thr_px / KB[0, 0]
    rng = np.random.default_rng(seed)
    best, bestR = None, None
    for _ in range(iters):
        i = rng.choice(len(ka), 2, replace=False)
        R = kabsch(ba[:, i], bb[:, i])
        e = np.linalg.norm(bb - R @ ba, axis=0)
        inl = e < thr
        if best is None or inl.sum() > best.sum():
            best, bestR = inl, R
    for _ in range(3):
        R = kabsch(ba[:, best], bb[:, best])
        e = np.linalg.norm(bb - R @ ba, axis=0)
        best = e < thr
        if best.sum() < 3:
            break
    rms = float(np.sqrt(np.mean(e[best] ** 2)) * KB[0, 0]) if best.sum() else None
    return {"R": R, "inliers": int(best.sum()), "n": len(ka), "rmsPx": rms}


def ess_pose(ka, kb, KA, KB, thr_px=2.0):
    if len(ka) < 8:
        return None
    na = cv2.undistortPoints((ka + 0.5).reshape(-1, 1, 2).astype(np.float64), KA, None).reshape(-1, 2)
    nb = cv2.undistortPoints((kb + 0.5).reshape(-1, 1, 2).astype(np.float64), KB, None).reshape(-1, 2)
    E, mask = cv2.findEssentialMat(na, nb, np.eye(3), cv2.RANSAC, 0.999, thr_px / KB[0, 0])
    if E is None or E.shape != (3, 3):
        return None
    n, R, t, mask2 = cv2.recoverPose(E, na, nb, np.eye(3), mask=mask)
    return {"R": R, "inliers": int((mask2 > 0).sum()), "n": len(ka)}


def multipart(parts: list[tuple[str, str, bytes, str]], fields: dict) -> tuple[bytes, str]:
    bnd = uuid.uuid4().hex
    out = io.BytesIO()
    for k, v in fields.items():
        out.write(f"--{bnd}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode())
    for name, fn, data, ct in parts:
        out.write(f"--{bnd}\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"{fn}\"\r\n"
                  f"Content-Type: {ct}\r\n\r\n".encode())
        out.write(data)
        out.write(b"\r\n")
    out.write(f"--{bnd}--\r\n".encode())
    return out.getvalue(), f"multipart/form-data; boundary={bnd}"


def da3(images: list[Image.Image]):
    body, ct = multipart([("images", f"{i}.jpg", jpeg(im), "image/jpeg") for i, im in enumerate(images)], {})
    req = urllib.request.Request(NF + "/multiview", data=body, headers={"Content-Type": ct}, method="POST")
    t0 = time.time()
    for attempt in range(4):  # the shared service may be restarted by other users
        try:
            with urllib.request.urlopen(req, timeout=1800) as r:
                w = json.loads(r.read())
            break
        except (OSError, http.client.HTTPException):
            if attempt == 3:
                raise
            time.sleep(20)
    cams = [np.asarray(c["c2w"], float).reshape(4, 4) for c in w["cameras"]]
    return {"c2w": cams, "K": [c["intrinsicsNorm"] for c in w["cameras"]], "seconds": time.time() - t0,
            "model": w["model"]}


def da3_rel(res, i: int, j: int) -> np.ndarray:
    """relR from camera i to camera j (x_j = relR x_i)."""
    Ri = res["c2w"][i][:3, :3]  # cam_i -> cam_0
    Rj = res["c2w"][j][:3, :3]
    return Rj.T @ Ri


# ---------------- pair evaluation ----------------


def evaluate(a: Image.Image, b: Image.Image, KA, KB, relR_gt, key: str, skip_da3=False):
    cf = CACHE / f"{key}.json"
    if cf.exists():
        c = json.loads(cf.read_text())
        if (skip_da3 or "da3" in c) and "rotBwd" in c:
            return c
        if skip_da3 or "da3" in c:  # add the backward classical estimate only
            kb2, ka2, _ = lg_match(b, a)
            rb = rot_ransac(kb2, ka2, KB, KA)
            c["rotBwd"] = None if rb is None else {"relR": rb["R"].tolist(), "inliers": rb["inliers"], "rmsPx": rb["rmsPx"]}
            cf.write_text(json.dumps(c))
            return c
    out: dict = {"key": key}
    ka, kb, sc = lg_match(a, b)
    out["matches"] = int(len(ka))
    r = rot_ransac(ka, kb, KA, KB)
    e = ess_pose(ka, kb, KA, KB)
    kb2, ka2, _ = lg_match(b, a)
    rb = rot_ransac(kb2, ka2, KB, KA)
    out["rotBwd"] = None if rb is None else {"relR": rb["R"].tolist(), "inliers": rb["inliers"], "rmsPx": rb["rmsPx"]}
    out["rot"] = None if r is None else {"relR": r["R"].tolist(), "inliers": r["inliers"], "rmsPx": r["rmsPx"],
                                         "err": rot_err(r["R"], relR_gt)}
    out["ess"] = None if e is None else {"relR": e["R"].tolist(), "inliers": e["inliers"], "err": rot_err(e["R"], relR_gt)}
    if not skip_da3:
        d = da3([a, b])
        R = da3_rel(d, 0, 1)
        fa = d["K"][0]["fy"] * a.height
        fb = d["K"][1]["fy"] * b.height
        out["da3"] = {"relR": R.tolist(), "err": rot_err(R, relR_gt), "seconds": d["seconds"],
                      "fErrA": fa / KA[1, 1] - 1, "fErrB": fb / KB[1, 1] - 1, "model": d["model"]}
    out["gtAngle"] = rot_angle(relR_gt)
    out["overlap"] = overlap_frac(relR_gt, KA, a.width, a.height, KB, b.width, b.height)
    cf.write_text(json.dumps(out))
    return out


def real_pairs(skip_da3: bool):
    gt = json.loads((ROOT / "data/ground-truth.json").read_text())
    meta = {p["id"]: p for p in json.loads((ROOT / "public/photos/photos.json").read_text())}
    imgs = {k: load(ROOT / f"public/photos/{k}.jpg") for k in VIEWPOINT}
    gpose, R = {}, {}
    for k in VIEWPOINT:
        g = gt[k]
        vf = 2 * math.atan((g["height"] / 2) / g["f"]) / D
        gpose[k] = {"yaw": g["yaw"], "pitch": g["pitch"], "roll": g["roll"], "vfov": vf, "quality": g["quality"]}
        R[k] = pose_to_R(gpose[k])
    rows = []
    for A in VIEWPOINT:
        for B in VIEWPOINT:
            if A == B:
                continue
            a, b = imgs[A], imgs[B]
            KA = K_of(gpose[A]["vfov"], a.width, a.height)  # anchor: accepted pose incl. focal
            KB = K_of(meta[B]["vfov"], b.width, b.height)  # target: EXIF focal only (what the app has)
            relR = R[B] @ R[A].T
            o = evaluate(a, b, KA, KB, relR, f"real_{A}_{B}", skip_da3)
            row = {"A": A, "B": B, **{k: v for k, v in o.items() if k != "key"}}
            row["qualityA"], row["qualityB"] = gpose[A]["quality"], gpose[B]["quality"]
            row["exifVfovErrB"] = meta[B]["vfov"] - gpose[B]["vfov"]
            row["gravityB"] = {"pitch": meta[B]["pitch"], "roll": meta[B]["roll"]}
            for m in ("rot", "ess", "da3"):
                if row.get(m):
                    Rb = np.asarray(row[m]["relR"]) @ R[A]
                    p = R_to_pose(Rb, meta[B]["vfov"])
                    row[m]["pose"] = p
                    row[m]["poseErr"] = pose_err(p, gpose[B])
                    row[m]["gravityDiff"] = {"pitch": p["pitch"] - meta[B]["pitch"], "roll": wrap180(p["roll"] - meta[B]["roll"])}
            rows.append(row)
    # triplet cycle consistency for classical rot on the overlapping triple
    return rows, gpose


def synth_sources():
    gt = json.loads((ROOT / "data/ground-truth.json").read_text())
    meta = {p["id"]: p for p in json.loads((ROOT / "public/photos/photos.json").read_text())}
    src = []
    for k in gt:
        if k in VIEWPOINT:
            continue  # keep the real viewpoint photos independent
        src.append((k, ROOT / f"public/photos/{k}.jpg", meta[k]["vfov"]))
    man = {m["id"]: m for m in json.loads((ROOT / "tools/bench/data/manifest.json").read_text())}
    dev = json.loads((ROOT / "tools/bench/split.json").read_text())["dev"]
    for k in sorted(dev):
        m = man[k]
        f35 = m.get("focal35mm")
        if not f35:
            continue
        W, H = m["width"], m["height"]
        # FF35 diagonal 43.2666 mm -> diagonal FOV; vfov from it
        dpx = math.hypot(W, H)
        f = f35 / 43.2666 * dpx
        src.append((k, ROOT / "tools/bench/data" / m["file"], 2 * math.atan((H / 2) / f) / D))
    return src


def synth_pairs(n: int, skip_da3: bool, seed=7):
    rng = random.Random(seed)
    src = synth_sources()
    rows = []
    for i in range(n):
        k, path, vf_s = src[i % len(src)]
        im = load(path, 1600)
        Ks = K_of(vf_s, im.width, im.height)
        hf_s = 2 * math.atan(math.tan(vf_s * D / 2) * im.width / im.height) / D
        W, H = 768, 576
        hfA = hf_s * rng.uniform(0.45, 0.6)
        hfB = hfA * rng.uniform(0.8, 1.25)
        vfA = 2 * math.atan(math.tan(hfA * D / 2) * H / W) / D
        vfB = 2 * math.atan(math.tan(hfB * D / 2) * H / W) / D
        KA, KB = K_of(vfA, W, H), K_of(vfB, W, H)
        # A somewhere inside the source; B offset by up to ~1.4 hfovA in yaw (some pairs do not overlap)
        span = max(0.0, (hf_s - hfA) / 2)
        yA = rng.uniform(-span, span)
        dy = rng.choice([-1, 1]) * rng.uniform(0, 1.4) * hfA
        yB = max(-hf_s / 2, min(hf_s / 2, yA + dy))
        RA = cam_rot(yA, rng.uniform(-3, 3), rng.uniform(-3, 3))
        RB = cam_rot(yB, rng.uniform(-6, 6), rng.uniform(-8, 8))
        a = warp(im, Ks, RA, KA, W, H)
        b = warp(im, Ks, RB, KB, W, H)
        b = photometric(b, rng)
        relR = RB @ RA.T
        o = evaluate(a, b, KA, KB, relR, f"synth{seed}_{i:03d}_{k}", skip_da3)
        row = {"src": k, **{kk: v for kk, v in o.items() if kk != "key"}}
        # world-pose errors using a canonical anchor pose (yaw 0-360, level)
        pA = {"yaw": rng.uniform(0, 360), "pitch": rng.uniform(-5, 5), "roll": rng.uniform(-3, 3), "vfov": vfA}
        RwA = pose_to_R(pA)
        gB = R_to_pose(relR @ RwA, vfB)
        for m in ("rot", "ess", "da3"):
            if row.get(m):
                p = R_to_pose(np.asarray(row[m]["relR"]) @ RwA, vfB)
                row[m]["poseErr"] = pose_err(p, gB)
        rows.append(row)
        print(f"synth {i} {k} gt={row['gtAngle']:.1f} ov={row['overlap']:.2f} "
              f"rot={fmt(row['rot'])} ess={fmt(row['ess'])} da3={fmt(row.get('da3'))}", flush=True)
    return rows


def negative_pairs(n: int, skip_da3: bool, seed=11):
    """Different photos (different places): any propagation is wrong; the gate must reject all."""
    rng = random.Random(seed)
    src = [x for x in synth_sources() if x[0].startswith("wc_")]
    rows = []
    for i in range(n):
        (ka_, pa, vfa), (kb_, pb, vfb) = rng.sample(src, 2)
        a, b = load(pa, 768), load(pb, 768)
        KA, KB = K_of(vfa, a.width, a.height), K_of(vfb, b.width, b.height)
        o = evaluate(a, b, KA, KB, np.eye(3), f"neg{seed}_{i:03d}_{ka_}_{kb_}", skip_da3)
        rows.append({"A": ka_, "B": kb_, **{k: v for k, v in o.items() if k not in ("key", "gtAngle", "overlap")}})
        print(f"neg {i} {ka_}->{kb_} m={o['matches']} rot={fmt(o['rot'])}", flush=True)
    return rows


def fmt(r):
    return "-" if not r else f"{r['err']:.2f}" + (f"/{r['inliers']}" if "inliers" in r else "")


def warp(im: Image.Image, Ks, Rv, Kv, W, H) -> Image.Image:
    Hm = Ks @ Rv.T @ np.linalg.inv(Kv)  # dst pixel -> src pixel
    arr = cv2.warpPerspective(np.asarray(im), Hm, (W, H), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP,
                              borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0))
    return Image.fromarray(arr)


def photometric(im: Image.Image, rng: random.Random) -> Image.Image:
    im = ImageEnhance.Brightness(im).enhance(rng.uniform(0.7, 1.3))
    im = ImageEnhance.Contrast(im).enhance(rng.uniform(0.75, 1.25))
    im = ImageEnhance.Color(im).enhance(rng.uniform(0.6, 1.4))
    if rng.random() < 0.4:
        im = im.filter(ImageFilter.GaussianBlur(rng.uniform(0.5, 1.5)))
    b = io.BytesIO()
    im.save(b, "JPEG", quality=rng.randint(55, 90))
    return Image.open(io.BytesIO(b.getvalue())).convert("RGB")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--synth", type=int, default=120)
    ap.add_argument("--skip-da3", action="store_true")
    ap.add_argument("--neg", type=int, default=60)
    ap.add_argument("--only", choices=["real", "synth", "neg", "all"], default="all")
    a = ap.parse_args()
    res = {}
    rf = HERE / "raw.json"
    if rf.exists():
        res = json.loads(rf.read_text())
    if a.only in ("real", "all"):
        rows, gp = real_pairs(a.skip_da3)
        res["real"] = rows
        res["realGt"] = gp
        for r in rows:
            print(f"real {r['A']}->{r['B']} gt={r['gtAngle']:.1f} ov={r['overlap']:.2f} m={r['matches']} "
                  f"rot={fmt(r['rot'])} ess={fmt(r['ess'])} da3={fmt(r.get('da3'))}", flush=True)
    if a.only in ("synth", "all"):
        res["synth"] = synth_pairs(a.synth, a.skip_da3)
    if a.only in ("neg", "all"):
        res["neg"] = negative_pairs(a.neg, a.skip_da3)
    rf.write_text(json.dumps(res, indent=1))


if __name__ == "__main__":
    main()
