# Rigi
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: Copyright (c) Rigi contributors
"""Record Python reference outputs of tools/matcher/pose6.py (Problem, sigmas, rot_search, solve6,
total_cost, basin_gap) on the synthetic scenarios of synth.py with an ANALYTIC fake DEM, and write
basin.json next to this file. The TS spec implements the identical fake DEM.

FakeDem(lat0, lon0, extent_m), R = 6371008.8 m (all float64):
  ground(e, n) = 1200.0 + 0.05*e - 0.03*n + 20.0*sin(e/300.0)*cos(n/400.0)
  geo(e, n)    = (lon0 + e/(R*pi/180*cos(radians(lat0))), lat0 + n/(R*pi/180))      # (lon, lat)
  horizon(eye=(E, N, Z), az0, az1, step, dmin=5, dmax=1e5, grow=0.004):
      az  = arange(az0, az1 + step*0.5, step)          # degrees
      a   = radians(az)
      el  = synth.horizon_el_deg(a) + 0.002*(E*cos(3a) - N*sin(2a)) + 0.001*(Z - 1500.0)   # degrees
      dist = 10000 for every azimuth
      dirs = [sin(a)cos(el), cos(a)cos(el), sin(el)]   # el in radians
      returns {az, el, dist, dirs}

Regenerate (from the repo / worktree root):
  /Users/robertchristie/Documents/GitHub/mt-image/tools/matcher/.venv/bin/python src/lib/matcher/__tests__/fixtures/make_basin_fixtures.py
"""
from __future__ import annotations

import json
import math
import sys
import time
import types
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
MATCHER = HERE.parents[4] / "tools" / "matcher"
if not (MATCHER / "pose6.py").exists():
    MATCHER = Path("/Users/robertchristie/Documents/GitHub/mt-image/tools/matcher")
sys.dont_write_bytecode = True
sys.path.insert(0, str(MATCHER / "server"))
sys.path.insert(0, str(MATCHER))
sys.path.insert(0, str(HERE))

for _mod in ("cv2", "poselib", "lightglue"):
    try:
        __import__(_mod)
    except ImportError:
        stub = types.ModuleType(_mod)
        stub.LightGlue = object
        sys.modules[_mod] = stub

import fuse  # noqa: E402
import fusion as F  # noqa: E402
import pose6  # noqa: E402
import synth  # noqa: E402

R_EARTH = 6371008.8


class FakeDem:
    def __init__(self, lat0, lon0, extent_m=200.0):
        self.lat0, self.lon0, self.extent = lat0, lon0, extent_m
        self.mlat = 1 / (R_EARTH * math.pi / 180)
        self.mlon = 1 / (R_EARTH * math.pi / 180 * math.cos(math.radians(lat0)))

    def ground(self, e, n):
        e, n = np.asarray(e, float), np.asarray(n, float)
        return 1200.0 + 0.05 * e - 0.03 * n + 20.0 * np.sin(e / 300.0) * np.cos(n / 400.0)

    def geo(self, e, n):
        return self.lon0 + np.asarray(e) * self.mlon, self.lat0 + np.asarray(n) * self.mlat

    def horizon(self, eye, az0, az1, step, dmin=5.0, dmax=100000.0, grow=0.004):
        az = np.arange(az0, az1 + step * 0.5, step)
        a = np.radians(az)
        E, N, Z = float(eye[0]), float(eye[1]), float(eye[2])
        base = np.array([synth.horizon_el_deg(float(x)) for x in a])
        el = base + 0.002 * (E * np.cos(3 * a) - N * np.sin(2 * a)) + 0.001 * (Z - 1500.0)
        dist = np.full(len(az), 10000.0)
        er = np.radians(el)
        dirs = np.stack([np.sin(a) * np.cos(er), np.cos(a) * np.cos(er), np.sin(er)], 1)
        return {"az": az, "el": el, "dist": dist, "dirs": dirs}


pose6.DM.Dem = FakeDem


def clean(v):
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


def run(p: dict) -> dict:
    sc = synth.make_scenario(p)
    W, H, w, h = p["W"], p["H"], p["w"], p["h"]
    tp, app = p["truePose"], p["appPose"]
    prior = {**{k: round(tp[k], 1) for k in ("yaw", "pitch", "roll")}, "vfov": tp["vfov"]}
    sk = F.skyline_from_arrays(w, h, sc["fine"], sc["fg"], sc["sky"], sc["dirs"])
    sk["app"] = {"pose": app, "confidence": 0.5, "accepted": True}
    corr = {"x2d": sc["x2d"], "X": sc["X"], "W": W, "H": H} if len(sc["x2d"]) > 0 else None
    eye0 = [0.0, 0.0, 1500.0]
    lat0, lon0 = 46.7, 7.8
    pose0 = fuse.fuse(prior, np.array(eye0, float), W, H, sk, corr)["fusedPose"]
    prob = pose6.Problem("fx", W, H, sk, corr, eye0, lat0, lon0, pose0, True, "manual", fast=True)

    be = prob.base_el
    n_app = int(np.isfinite(be).sum())
    out = {"eye0": eye0, "lat0": lat0, "lon0": lon0, "pose0": pose0}
    out["problem"] = {
        "f0": prob.f0, "fsig": prob.fsig, "sigmaH": prob.sigmaH, "hfov": prob.hfov, "agl0": prob.agl0,
        "agl_ref": prob.agl_ref, "cap": prob.cap, "az0": prob.az0, "az1": prob.az1, "azstep": prob.azstep,
        "n": len(be), "base_el_every10": [float(x) for x in be[::10]], "base_el_first": float(be[0]),
        "base_el_last": float(be[-1]), "base_el_sum": float(be.sum()),
        "n_app_in_range": n_app,
    }
    x4 = F.x_from_pose(pose0, H)
    sig = pose6.sigmas(prob, x4, prob.eye0)
    out["sigmas"] = sig
    out["eyeAt"] = [{"E": E, "N": N, "a": a, "eye": prob.eye(E, N, a)}
                    for E, N, a in ((0.0, 0.0, 1.6), (250.0, -500.0, 50.0))]

    rs = []
    for E, N in ((0.0, 0.0), (250.0, -500.0), (-1000.0, 1000.0)):
        hy = pose6.rot_search(prob, prob.eye(E, N, prob.agl_ref), pose0)
        rs.append({"E": E, "N": N, "hyps": [{"score": s, "pose": q} for s, q in hy]})
    out["rotSearch"] = rs

    top = rs[0]["hyps"][0]["pose"]
    p0 = pose6.xfull(top, 0.0, 0.0, prob.agl_ref, H)
    r = pose6.solve6(prob, p0, sig, move=False)
    out["solve6"] = {"p0": p0, "p": r[0], "info": r[1],
                     "totalCost": pose6.total_cost(prob, r[0], sig),
                     "priorRes": pose6.prior_res(prob, r[0])}

    t0 = time.time()
    bg = pose6.basin_gap(prob)
    g = bg["grid"]
    out["basinGap"] = {"gap": bg["gap"], "sigma": bg["sigma"], "step": g["step"], "n": g["n"],
                       "evaluated": g["evaluated"], "best": g["best"], "second": g["second"],
                       "coarseMap": g["coarseMap"], "costs": g["costs"], "horizons": bg["horizons"]}
    print(p["name"], "basin_gap", round(time.time() - t0, 1), "s")
    return out


def main():
    t0 = time.time()
    res = {}
    for p in synth.SCENARIOS:
        if p["name"] not in ("agree", "disagree"):
            continue
        res[p["name"]] = clean(run(p))
    path = HERE / "basin.json"
    path.write_text(json.dumps(res, separators=(",", ":"), allow_nan=False))
    print(f"wrote {path} ({path.stat().st_size / 1024:.0f} KB) in {time.time() - t0:.1f}s")
    for k, v in res.items():
        b = v["basinGap"]
        print(k, "gap", b["gap"], "best", b["best"], "second", b["second"], "pose0", v["pose0"])


if __name__ == "__main__":
    main()
