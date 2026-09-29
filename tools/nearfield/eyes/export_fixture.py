"""Export one pair's matches + anchored depths + the Python pair_metric result as a TS parity fixture
(src/lib/nearfield/roll/eyes.check.ts reads tools/nearfield/eyes/fixture_<A>_<B>.json).

    tools/matcher/.venv/bin/python tools/nearfield/eyes/export_fixture.py [--pair IMG_7059,IMG_7063]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import refine_eyes as RE  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--spot", default="region-0-vp4")
    ap.add_argument("--pair", default="IMG_7059,IMG_7063")
    a = ap.parse_args()
    A_id, B_id = a.pair.split(",")
    spot = RE.ROOT / "tools/nearfield/roll/out" / a.spot
    meta = json.loads((spot / "meta.json").read_text())
    V = {i: RE.View(spot, i) for i in (A_id, B_id)}
    dem = RE.LocalDem(RE.EnuFrame(meta["frame"]["lat"], meta["frame"]["lon"], 0), meta["origin"][:2])
    anc = {}
    for k, v in V.items():
        W = 256 if v.aspect >= 1 else round(256 * v.aspect)
        H = round(256 / v.aspect) if v.aspect >= 1 else 256
        rg = RE.dem_range(dem, v, v.eye0, W, H)
        an = RE.fit_anchor(v, rg)
        anc[k] = {"ray": RE.anchored_ray(v, an, W, H), "range": rg}
    A, B = V[A_id], V[B_id]
    ka, kb = RE.load_matches(A, B)
    WA, HA = A.big.size
    WB, HB = B.big.size
    keep = ~RE.sample_grid(A.people, ka, WA, HA) & ~RE.sample_grid(B.people, kb, WB, HB)
    ka, kb = ka[keep], kb[keep]
    dA = RE.sample_grid(anc[A_id]["ray"], ka, WA, HA)
    dB = RE.sample_grid(anc[B_id]["ray"], kb, WB, HB)
    res = RE.pair_metric(A, B, anc)
    fx = {
        "A": {"id": A_id, "pose": A.pose, "eye": A.eye0.tolist(), "width": WA, "height": HA},
        "B": {"id": B_id, "pose": B.pose, "eye": B.eye0.tolist(), "width": WB, "height": HB},
        "ka": (ka + 0.5).round(3).ravel().tolist(), "kb": (kb + 0.5).round(3).ravel().tolist(),
        "depthA": np.nan_to_num(dA, nan=-1).round(4).tolist(), "depthB": np.nan_to_num(dB, nan=-1).round(4).tolist(),
        "python": {k: res[k] for k in ("t", "baselineM", "inliers", "nearInliers", "medPx", "relRotCorrDeg", "focalScale", "sdAxesM")},
    }
    out = HERE / f"fixture_{A_id}_{B_id}.json"
    out.write_text(json.dumps(fx))
    print(out, fx["python"])


if __name__ == "__main__":
    main()
