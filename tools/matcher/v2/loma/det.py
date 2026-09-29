"""Experiment 1: determinism + timing of LoMa per device/precision, and of the ALIKED+LightGlue baseline.

    python det.py prep            render one real dev pair (wc_0006, correct ref, centre view) → scratch/det/*.png
    LOMA_DEVICE=mps LOMA_PREC=fp32 LOMA_MODEL=B python det.py run   (5 repeats; each repeat re-extracts both
                                  images, interleaved with a different-size pair to provoke state carry-over)
    python det.py baseline        same protocol for ALIKED (MPS) + LightGlue (CPU, service) and LightGlue on MPS
Output: one JSON line per config appended to scratch/det/results.jsonl
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import ab  # noqa: E402  (paths, scratch, worker port)
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

D = ab.SCRATCH / "det"
D.mkdir(parents=True, exist_ok=True)
PID = "wc_0006"


def prep():
    ph = ab.s1.Photo(PID)
    w = ab.s1.Worker(port=int(os.environ["STAGE1_PORT"]))
    try:
        se = ab.s1.Session(w, ph)
        ref = {k: float(ab.refs.correct_refs(PID)[0]["pose"][k]) for k in ("yaw", "pitch", "roll", "vfov")}
        views, _, meta, _ = ab.render_retry(se, poses=[{"tag": "c", **ref}], styles=("sat",), allow_empty=False)
        v = views[0]
        H, W = v.rgb.shape[:2]
        Image.fromarray(np.array(Image.fromarray(ph.img).resize((W, H), Image.LANCZOS))).save(D / "photo.png")
        Image.fromarray(v.rgb).save(D / "view.png")
        se.close()
    finally:
        w.close()
        ph.cleanup()


def _imgs():
    a = np.array(Image.open(D / "photo.png").convert("RGB"))
    b = np.array(Image.open(D / "view.png").convert("RGB"))
    t = ab.SCRATCH / "LoMa/assets/toronto_"
    c = np.array(Image.open(f"{t}A.jpg").convert("RGB").resize((800, 600)))
    d = np.array(Image.open(f"{t}B.jpg").convert("RGB").resize((800, 600)))
    return a, b, c, d


def summarize(name, runs, times, extra=None):
    ref = runs[0]
    same = []
    for r in runs[1:]:
        if len(r[0]) != len(ref[0]):
            same.append(None)
        else:
            same.append(float(max(np.abs(r[0] - ref[0]).max(initial=0), np.abs(r[1] - ref[1]).max(initial=0))))
    out = {"config": name, "n": [int(len(r[0])) for r in runs], "maxAbsDiffVsRun0": same,
           "identical": all(s == 0.0 for s in same), "secPerPair": [round(t, 2) for t in times],
           "load": os.getloadavg()[0], **(extra or {})}
    print(json.dumps(out), flush=True)
    with open(D / "results.jsonl", "a") as f:
        f.write(json.dumps(out) + "\n")


def run_loma():
    import torch
    L = ab.L
    a, b, c, d = _imgs()
    L.model()
    sync = (lambda: torch.mps.synchronize()) if L.DEVICE == "mps" else (lambda: None)
    L.match_features(L.features(c), L.features(d))  # warm-up
    runs, times = [], []
    for i in range(5):
        t0 = time.time()
        fa, fb = L.features(a), L.features(b)
        r = L.match_features(fa, fb)
        sync()
        times.append(time.time() - t0)
        runs.append(r)
        L.match_features(L.features(c), L.features(d))  # interleave a different pair / keypoint set
    # photo features cached: per-view cost as in correspond_loma
    t0 = time.time()
    for _ in range(3):
        L.match_features(fa, L.features(b))
    sync()
    summarize(f"loma-{L.MODEL} {L.DEVICE} {L.PREC} kp{L.NUM_KP}", runs, times,
              {"secPerViewPhotoCached": round((time.time() - t0) / 3, 2),
               "mpsMemGB": round(torch.mps.driver_allocated_memory() / 1e9, 2) if L.DEVICE == "mps" else None})


def run_baseline():
    s1 = ab.s1
    import match as M
    a, b, c, d = _imgs()
    for lgdev in ("cpu", "mps"):
        s1.core.LG_DEVICE = lgdev
        runs, times = [], []
        s1.core.lg_match(M.extract("aliked", c), M.extract("aliked", d))
        for i in range(5):
            t0 = time.time()
            fa, fb = M.extract("aliked", a), M.extract("aliked", b)
            k0, k1 = s1._lg("aliked", fa, fb)
            times.append(time.time() - t0)
            runs.append((k0, k1))
            s1._lg("aliked", M.extract("aliked", c), M.extract("aliked", d))
        summarize(f"aliked(mps)+lightglue({lgdev}) 4096", runs, times)


if __name__ == "__main__" and sys.argv[1] in ("prep", "run", "baseline"):
    {"prep": prep, "run": run_loma, "baseline": run_baseline}[sys.argv[1]]()


def dump():
    """Save one run's matches per config (for the cross-device comparison)."""
    L = ab.L
    a, b, _, _ = _imgs()
    k0, k1, c = L.match_features(L.features(a), L.features(b))
    np.savez(D / f"m_{L.DEVICE}_{L.PREC}.npz", k0=k0, k1=k1, c=c)


def xdev():
    fs = sorted(D.glob("m_*.npz"))
    Z = {f.stem: np.load(f) for f in fs}
    base = Z["m_cpu_fp32"]
    for k, z in Z.items():
        key0 = {tuple(np.round(p, 1)): q for p, q in zip(base["k0"], base["k1"])}
        common = sum(1 for p, q in zip(z["k0"], z["k1"]) if tuple(np.round(p, 1)) in key0 and np.abs(key0[tuple(np.round(p, 1))] - q).max() < 0.5)
        line = {"config": k, "n": int(len(z["k0"])), "nCpuFp32": int(len(base["k0"])), "sharedWithCpuFp32": common}
        print(json.dumps(line))
        with open(D / "xdev.jsonl", "a") as f:
            f.write(json.dumps(line) + "\n")


if __name__ == "__main__" and sys.argv[1] in ("dump", "xdev"):
    {"dump": dump, "xdev": xdev}[sys.argv[1]]()
