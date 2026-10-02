# Rigi
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: Copyright (c) Rigi contributors

"""E4 renderer validation (PROTOCOL section 4), run before any scoring.

(i)  xyz reprojected through the render camera -> its own pixel centre (px).
(ii) render at the GT pose: skyline row per column vs the app's GT skyline (start_poses.ts dump) at 588 px width,
     columns with app horizon distance < 35 km.
(iii) render skyline vs the photo's detectSkyline rows (same columns), reported only.
Writes out/validation.json.   PYTHONPATH=. tools/matcher/.venv/bin/python e4_validate.py [name ...]
"""
from __future__ import annotations

import json
import math
import sys
import time

import numpy as np

import e4_data as D
import e4_geo as G
import e4_render as R

HERE = D.HERE
W_VAL = 588


def render_skyline(status: np.ndarray) -> np.ndarray:
    """First terrain-hit row per column (NaN if none). Status 2 (no terrain within 40 km, below the terrain envelope)
    is sky OR terrain beyond 40 km, so it is not counted as terrain; the comparison keeps only columns where the app
    skyline is nearer than 35 km."""
    nonsky = status == 0
    first = nonsky.argmax(0).astype(float)
    first[~nonsky.any(0)] = np.nan
    return first


def app_distance_per_column(v, rows) -> np.ndarray:
    g = v["gt"]
    s = W_VAL / g["width"]
    f, W, H = g["f"] * s, round(g["width"] * s), round(g["height"] * s)
    Rm = G.pose_to_R(g)
    hz = v["horizon"]
    dist = np.full(W, np.nan)
    for x in range(W):
        y = rows[x]
        if y is None:
            continue
        c = np.array([(x + 0.5 - W / 2) / f, (y - H / 2) / f, 1.0])
        d = c @ Rm
        az = math.degrees(math.atan2(d[0], d[1])) % 360
        dist[x] = hz["distance"][int(round(az / hz["step"])) % len(hz["distance"])]
    return dist


def main():
    S = json.load(open(HERE / "out/start_poses.json"))
    names = sys.argv[1:] or sorted(S)
    out = {}
    for name in names:
        v = S[name]
        t0 = time.time()
        fr = G.EnuFrame(v["lat"], v["lon"], 0.0)
        grids = D.build_grids(fr, v["eye"])
        eye_z, clamped = D.clamp_eye(grids, v["eye"])
        v = {**v, "eye": eye_z}
        g = v["gt"]
        s = W_VAL / g["width"]
        f, W, H = g["f"] * s, round(g["width"] * s), round(g["height"] * s)
        hfov = 2 * math.degrees(math.atan(W / 2 / f))
        ortho = D.Ortho(fr, (g["yaw"], hfov / 2 + 25), HERE / "cache_ortho")
        r = R.render(grids, ortho, v["eye"], g, f, W, H)
        # (i) reprojection
        Rm = G.pose_to_R(g)
        m = r["status"] == 0
        X = r["xyz"][m].astype(float) - r["eye"]
        c = X @ Rm.T
        u = W / 2 + f * c[:, 0] / c[:, 2]
        vv = H / 2 + f * c[:, 1] / c[:, 2]
        yy, xx = np.nonzero(m)
        reproj = np.hypot(u - (xx + 0.5), vv - (yy + 0.5))
        # (ii)/(iii) skyline
        rs = render_skyline(r["status"])
        sk = v["skyline"]
        gt_rows = sk["gtRows"]
        dist = app_distance_per_column(v, gt_rows)
        app = np.array([np.nan if y is None else y for y in gt_rows])
        ph = np.array([np.nan if y is None else y for y in sk["photoRows"]])
        ok = np.isfinite(app) & np.isfinite(rs) & (dist < 35000)
        d_app = np.abs(rs - app)[ok]
        ok3 = np.isfinite(ph) & np.isfinite(rs) & (dist < 35000)
        d_ph = np.abs(rs - ph)[ok3]
        out[name] = {
            "reprojMedianPx": float(np.median(reproj)), "reprojMaxPx": float(reproj.max()),
            "nCols": int(ok.sum()), "skylineVsApp": {"medianPx": float(np.median(d_app)) if d_app.size else None,
                                                     "p90Px": float(np.percentile(d_app, 90)) if d_app.size else None},
            "skylineVsPhoto": {"nCols": int(ok3.sum()), "medianPx": float(np.median(d_ph)) if d_ph.size else None},
            "status": {k: int((r["status"] == k).sum()) for k in (0, 1, 2)},
            "eyeClamped": clamped, "eyeUsed": eye_z, "colourMissing": float((~r["colour_ok"]).mean()), "renderSec": round(r["sec"], 1), "totalSec": round(time.time() - t0, 1),
            "grids": [(gr["zoom"], float(np.isnan(gr["z"]).mean())) for gr in grids],
        }
        print(name, json.dumps(out[name]), flush=True)
    path = HERE / "out/validation.json"
    if names == sorted(S):
        json.dump(out, open(path, "w"), indent=1)
        med = [o["skylineVsApp"]["medianPx"] for o in out.values() if o["skylineVsApp"]["medianPx"] is not None]
        print("median of per-photo median |drow| vs app GT skyline:", float(np.median(med)), "n", len(med))
        print("photos > 20 px:", sum(1 for x in med if x > 20), "photos > 10 px:", sum(1 for x in med if x > 10))


if __name__ == "__main__":
    main()
