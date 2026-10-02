# Rigi
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: Copyright (c) Rigi contributors
"""Reference outputs of the Python solvers the browser ports replace (src/lib/pose6dof/ransac):

  absolute : poselib.estimate_absolute_pose (match.py solve_pnp_exif's call), max_reproj_error 6
  camrot   : tools/matcher/match.py solve_rotation (matcher service), fixed and free focal
  rot      : tools/nearfield/propagate/run_propagate.py rot_ransac (relative-rotation service), on synthetic
             bearing sets and on RECORDED ALIKED+LightGlue matches of the 20 study pairs (IMG_7053..7086)

Usage: [RIGI_ROOT=<main tree>] tools/matcher/.venv/bin/python scripts/pose6dof/ransac-parity.py OUT.json [--no-real]
Then:  npx tsx scripts/pose6dof/ransac-parity.ts OUT.json
"""
from __future__ import annotations

import json
import math
import os
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(os.environ.get("RIGI_ROOT") or Path(__file__).resolve().parents[2])  # RIGI_ROOT: a tree with public/photos
sys.path.insert(0, str(ROOT / "tools/matcher"))
sys.path.insert(0, str(ROOT / "tools/nearfield/propagate"))
import poselib  # noqa: E402

import match as M  # noqa: E402
import run_propagate as RP  # noqa: E402


def rodrigues(w):
    th = np.linalg.norm(w)
    if th < 1e-12:
        return np.eye(3)
    k = w / th
    K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + math.sin(th) * K + (1 - math.cos(th)) * K @ K


def synth_abs(rng, n, out_frac, f=1000.0, W=1024, H=768):
    R = rodrigues(np.array([math.pi / 2 + rng.uniform(-0.15, 0.15), rng.uniform(-0.15, 0.15), rng.uniform(-0.05, 0.05)]))
    eye = np.array([2000 + rng.uniform(0, 100), -3000 + rng.uniform(0, 100), 1500 + rng.uniform(0, 50)])
    t = -R @ eye
    z = rng.uniform(500, 5500, n)
    u = rng.uniform(0, W, n)
    v = rng.uniform(0, H, n)
    pc = np.stack([(u - W / 2) / f * z, (v - H / 2) / f * z, z], 1)
    X = (pc - t) @ R  # R^T (pc - t)
    x2 = np.stack([u, v], 1) + rng.normal(0, 1, (n, 2))
    k = int(n * out_frac)
    x2[:k] = np.stack([rng.uniform(0, W, k), rng.uniform(0, H, k)], 1)
    return R, t, eye, X, x2


def main():
    out_path = Path(sys.argv[1])
    real = "--no-real" not in sys.argv
    rng = np.random.default_rng(42)
    cases = []
    W, H, f = 1024, 768, 1000.0
    for n in (60, 300, 1500):
        for of in (0.2, 0.5, 0.7):
            R, t, eye, X, x2 = synth_abs(rng, n, of)
            cam = {"model": "PINHOLE", "width": W, "height": H, "params": [f, f, W / 2, H / 2]}
            t0 = time.time()
            pose, info = poselib.estimate_absolute_pose(x2, X, cam, {"max_reproj_error": 6.0}, {})
            pl_ms = (time.time() - t0) * 1000
            t0 = time.time()
            sf = M.solve_rotation(x2.copy(), X.copy(), eye, W, H, f, False)
            sf_ms = (time.time() - t0) * 1000
            t0 = time.time()
            sfree = M.solve_rotation(x2.copy(), X.copy(), eye, W, H, f * 1.04, True)
            sfree_ms = (time.time() - t0) * 1000
            cases.append({
                "kind": "synthetic", "n": n, "outFrac": of, "W": W, "H": H, "f": f,
                "gt": {"R": R.ravel().tolist(), "t": t.tolist(), "eye": eye.tolist()},
                "x2d": x2.ravel().tolist(), "X": X.ravel().tolist(),
                "poselib": {"R": pose.R.ravel().tolist(), "t": pose.t.tolist(), "inliers": [int(b) for b in info["inliers"]],
                            "iterations": int(info["iterations"]), "ms": pl_ms},
                "camrotFixed": None if sf is None else {"R": np.asarray(sf["R"]).ravel().tolist(), "f": sf["f"],
                                                         "inliers": sf["inliers"].astype(int).tolist(), "ms": sf_ms},
                "camrotFree": None if sfree is None else {"R": np.asarray(sfree["R"]).ravel().tolist(), "f": sfree["f"], "f0": f * 1.04,
                                                          "inliers": sfree["inliers"].astype(int).tolist(), "ms": sfree_ms},
            })
    rot = []
    for n in (50, 400, 2000):
        for of in (0.3, 0.6, 0.85):
            Rr = rodrigues(rng.uniform(-0.5, 0.5, 3))
            K = RP.K_of(55.0, W, H)
            ka = np.stack([rng.uniform(0, W, n), rng.uniform(0, H, n)], 1)
            b = np.linalg.inv(K) @ np.vstack([ka.T + 0.5, np.ones(n)])
            pb = K @ (Rr @ b)
            kb = (pb[:2] / pb[2]).T - 0.5 + rng.normal(0, 0.7, (n, 2))
            k = int(n * of)
            kb[:k] = np.stack([rng.uniform(0, W, k), rng.uniform(0, H, k)], 1)
            t0 = time.time()
            r = RP.rot_ransac(ka, kb, K, K)
            rot.append({"kind": "synthetic", "n": n, "outFrac": of, "KA": K.ravel().tolist(), "KB": K.ravel().tolist(),
                        "ka": ka.ravel().tolist(), "kb": kb.ravel().tolist(), "gtR": Rr.ravel().tolist(),
                        "py": None if r is None else {"R": np.asarray(r["R"]).ravel().tolist(), "inliers": r["inliers"], "rmsPx": r["rmsPx"],
                                                      "mask": _mask(ka, kb, K, K, r["R"]), "ms": (time.time() - t0) * 1000}})
    if real:
        from PIL import Image  # noqa: F401
        gt = json.loads((ROOT / "data/ground-truth.json").read_text())
        meta = {p["id"]: p for p in json.loads((ROOT / "public/photos/photos.json").read_text())}
        imgs = {k: RP.load(ROOT / f"public/photos/{k}.jpg") for k in RP.VIEWPOINT}
        for A in RP.VIEWPOINT:
            for B in RP.VIEWPOINT:
                if A == B:
                    continue
                a, bimg = imgs[A], imgs[B]
                g = gt[A]
                vfa = 2 * math.atan((g["height"] / 2) / g["f"]) / RP.D
                KA = RP.K_of(vfa, a.width, a.height)
                KB = RP.K_of(meta[B]["vfov"], bimg.width, bimg.height)
                ka, kb, _ = RP.lg_match(a, bimg)
                t0 = time.time()
                r = RP.rot_ransac(ka, kb, KA, KB)
                cache = json.loads((ROOT / f"tools/nearfield/propagate/cache/real_{A}_{B}.json").read_text())
                rot.append({"kind": "recorded", "pair": f"{A}->{B}", "n": int(len(ka)), "KA": KA.ravel().tolist(), "KB": KB.ravel().tolist(),
                            "ka": ka.astype(float).ravel().tolist(), "kb": kb.astype(float).ravel().tolist(),
                            "cacheRot": cache.get("rot"),
                            "py": None if r is None else {"R": np.asarray(r["R"]).ravel().tolist(), "inliers": r["inliers"], "rmsPx": r["rmsPx"],
                                                          "mask": _mask(ka, kb, KA, KB, r["R"]), "ms": (time.time() - t0) * 1000}})
                print(A, B, len(ka), None if r is None else r["inliers"], file=sys.stderr)
    out_path.write_text(json.dumps({"absolute": cases, "rot": rot, "poselib": poselib.__version__}))
    print(f"wrote {out_path}: {len(cases)} absolute, {len(rot)} rot cases", file=sys.stderr)


def _mask(ka, kb, KA, KB, R):
    ba = np.linalg.inv(KA) @ np.vstack([ka.T + 0.5, np.ones(len(ka))])
    bb = np.linalg.inv(KB) @ np.vstack([kb.T + 0.5, np.ones(len(kb))])
    ba /= np.linalg.norm(ba, axis=0)
    bb /= np.linalg.norm(bb, axis=0)
    e = np.linalg.norm(bb - np.asarray(R) @ ba, axis=0)
    return (e < 4.0 / KB[0, 0]).astype(int).tolist()


if __name__ == "__main__":
    main()
