"""Controls for the eye refinement of a two-photo component (default IMG_7059 + IMG_7063).

Keeps the pair's mean eye at the GPS mean and varies ONLY the relative offset, then re-renders the DEM range, refits
both anchor curves and runs the two leave-one-out near-field reprojections (refine_eyes.py's evaluation):
    gps          the GPS eyes (baseline 7.1 m)
    refined      the refine_eyes.py solution (results.json)
    collapsed    both eyes at the mean (baseline 0)
    rot90/180/270  the GPS baseline vector rotated about the vertical (same length, wrong direction)
    x2           twice the GPS baseline
Eye z is always DEM + 1.6 m at the new position (as the app's eye rule).

    tools/matcher/.venv/bin/python tools/nearfield/eyes/controls.py [--ids IMG_7059,IMG_7063]
Writes controls.json.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import refine_eyes as RE  # noqa: E402
from loo import ssim_map  # noqa: E402
from splatrender import render  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--spot", default="region-0-vp4")
    ap.add_argument("--ids", default="IMG_7059,IMG_7063")
    ap.add_argument("--results", default="results.json")
    ap.add_argument("--near", type=float, default=150.0)
    a = ap.parse_args()
    ids = a.ids.split(",")
    spot = RE.ROOT / "tools/nearfield/roll/out" / a.spot
    meta = json.loads((spot / "meta.json").read_text())
    V = {i: RE.View(spot, i) for i in ids}
    dem = RE.LocalDem(RE.EnuFrame(meta["frame"]["lat"], meta["frame"]["lon"], 0), meta["origin"][:2])
    res = json.loads((HERE / a.results).read_text())
    ref = res["iterations"][-1]["solution"]["eyes"]
    A, B = ids
    m = (V[A].eye0 + V[B].eye0) / 2
    g = V[B].eye0 - V[A].eye0
    g[2] = 0

    def at(dxy):
        """eyes = mean -/+ dxy/2, z on the DEM."""
        out = {}
        for k, sgn in ((A, -0.5), (B, 0.5)):
            e = m + sgn * np.asarray([dxy[0], dxy[1], 0.0])
            e[2] = float(dem.height(e[0], e[1])) + RE.EYE_H
            out[k] = e
        return out

    def rotz(v, deg):
        c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
        return np.array([c * v[0] - s * v[1], s * v[0] + c * v[1], 0.0])

    confs = {"gps": {A: V[A].eye0, B: V[B].eye0}, "refined": {k: np.asarray(ref[k]) for k in ids},
             "collapsed": at([0, 0]), "rot90": at(rotz(g, 90)), "rot180": at(rotz(g, 180)), "rot270": at(rotz(g, 270)),
             "x2": at(2 * g)}
    out = {}
    for name, E in confs.items():
        row = {"baselineXY": round(float(np.linalg.norm((E[B] - E[A])[:2])), 2)}
        anc = {}
        for k in ids:
            v = V[k]
            W = 256 if v.aspect >= 1 else round(256 * v.aspect)
            H = round(256 / v.aspect) if v.aspect >= 1 else 256
            an = RE.fit_anchor(v, RE.dem_range(dem, v, E[k], W, H))
            anc[k] = an
            row[f"q_{k}"] = round(an["quality"], 3) if an else 0
        for h, o in ((A, B), (B, A)):
            T, O = V[h], V[o]
            rg = RE.dem_range(dem, T, E[h], T.W, T.H)
            mask = np.isfinite(rg) & (rg <= a.near) & ~T.people
            cl = RE.lift(O, E[o], RE.anchored_ray(O, anc[o], O.W, O.H), a.near)
            rgb, al, _ = render(cl, RE.cam_of(T, E[h]))
            cov = al > 0.5
            mc = mask & cov
            triv = np.broadcast_to(T.photo[mc].mean(0) if mc.any() else np.zeros(3), T.photo.shape)
            sm = ssim_map(rgb, T.photo)
            row[f"{h}<-{o}"] = {"maskFrac": round(float(mask.mean()), 3), "coverage": round(float(cov[mask].mean()), 4) if mask.any() else None,
                                "coveredFracOfImage": round(float(mc.mean()), 4),
                                "psnrCovered": RE.psnr(rgb, T.photo, mc), "psnrTrivial": RE.psnr(triv, T.photo, mc),
                                "ssimCovered": round(float(sm[mc].mean()), 3) if mc.any() else None}
        out[name] = row
        print(name, json.dumps(row), flush=True)
    (HERE / "controls.json").write_text(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
