# Rigi
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: Copyright (c) Rigi contributors

"""E4 driver: per case render once at the start pose (margin 20 deg), DINOv2 features of photo and render, 3x3 restart
LM, errors vs ground truth. Writes out/runs/<case id>.json (+ out/renders/<case id>.npz).

    PYTHONPATH=. tools/matcher/.venv/bin/python e4_run.py [--part i/n] [--kind primary|secondary] [id ...]
Photos are processed grouped by name so the grids/ortho are built once per photo.
"""
from __future__ import annotations

import json
import math
import sys
import time

import numpy as np
import torch
import torch.nn.functional as Fnn
from PIL import Image

import e4_cases as CS
import e4_data as D
import e4_features as FE
import e4_geo as G
import e4_refine as RF
import e4_render as R

HERE = D.HERE
OUT = HERE / "out"
MARGIN_DEG = 20.0
RENDER_LONG = 588


def rot_err(a: dict, b: dict) -> dict:
    return {"rot": G.rot_angle_deg(G.pose_to_R(a), G.pose_to_R(b)), "yaw": G.wrap180(a["yaw"] - b["yaw"]),
            "pitch": a["pitch"] - b["pitch"], "roll": a["roll"] - b["roll"], "f": a["f"] / b["f"] - 1}


def cell_dirs(rows: int, cols: int, Wl: float, Hl: float, f_l: float, R_start: np.ndarray) -> np.ndarray:
    u = (np.arange(cols) + 0.5) / cols * Wl
    v = (np.arange(rows) + 0.5) / rows * Hl
    uu, vv = np.meshgrid(u, v)
    c = np.stack([(uu - Wl / 2) / f_l, (vv - Hl / 2) / f_l, np.ones_like(uu)], -1)
    d = c @ R_start
    return d / np.linalg.norm(d, axis=-1, keepdims=True)


def run_case(case: dict, fx: FE.Features, grids, ortho, photo: np.ndarray, eye_z: float) -> dict:
    t0 = time.time()
    start = case["start"]
    W0, H0 = case["W0"], case["H0"]
    sB = RENDER_LONG / max(W0, H0)
    fB = start["f"] * sB
    WB, HB = W0 * sB, H0 * sB
    hx = min(math.atan(WB / 2 / fB) + math.radians(MARGIN_DEG), math.radians(75))
    hy = min(math.atan(HB / 2 / fB) + math.radians(MARGIN_DEG), math.radians(75))
    Wr, Hr = int(round(2 * fB * math.tan(hx))), int(round(2 * fB * math.tan(hy)))
    r = R.render(grids, ortho, eye_z, start, fB, Wr, Hr)
    if case["kind"] == "primary":  # disk budget: full rgb/xyz/status only for the primary set
        np.savez_compressed(OUT / "renders" / f"{case['id']}.npz", rgb=r["rgb"], xyz=r["xyz"], status=r["status"],
                            colour_ok=r["colour_ok"])
    else:
        Image.fromarray(r["rgb"]).save(OUT / "renders" / f"{case['id']}.jpg", quality=80)
    Rs = G.pose_to_R(start)
    bad = ((r["status"] == 2) | ~r["colour_ok"]).astype(np.float32)
    levels = []
    for long_side in RF.LEVELS:
        m = long_side / RENDER_LONG  # level scale relative to the render
        sl = long_side / max(W0, H0)
        Wq, Hq = W0 * sl, H0 * sl
        colsq, rowsq = max(1, round(Wq / 14)), max(1, round(Hq / 14))
        photo_raw = fx(np.asarray(Image.fromarray(photo).resize((round(Wq), round(Hq)), Image.LANCZOS)), colsq, rowsq)
        Wl, Hl = max(14, round(Wr * m)), max(14, round(Hr * m))
        rimg = np.asarray(Image.fromarray(r["rgb"]).resize((Wl, Hl), Image.LANCZOS)) if m != 1 else r["rgb"]
        colsr, rowsr = max(1, round(Wl / 14)), max(1, round(Hl / 14))
        render_raw = fx(rimg, colsr, rowsr)
        badt = Fnn.adaptive_avg_pool2d(torch.from_numpy(bad)[None, None], (rowsr, colsr))[0, 0].numpy()
        dirs = cell_dirs(rowsr, colsr, Wl, Hl, fB * m, Rs)
        levels.append(RF.Level(photo_raw, render_raw, dirs, badt < 0.25, Wq, Hq, sl, start))
    res = RF.refine(levels, start)
    est = res["theta"]
    out = {"id": case["id"], "kind": case["kind"], "name": case["name"], "start": start, "gt": case["gt"], "refined": est,
           "errStart": rot_err(start, case["gt"]), "errRefined": rot_err(est, case["gt"]),
           "sigmaPred": res["sigma"]["rot"], "sigma": res["sigma"], "cost": res["cost"], "startCost": res["startCost"],
           "gtCost": levels[-1].cost(case["gt"]), "nCells": res["nCells"], "restarts": res["restarts"],
           "eyeUsed": eye_z, "renderSize": [Wr, Hr], "renderSec": r["sec"], "sec": time.time() - t0,
           "scaleDeg": case.get("scaleDeg"), "accepted": case.get("accepted"),
           "startSolvedErr": rot_err(case["startSolved"], case["gt"])["rot"] if "startSolved" in case else None}
    json.dump(out, open(OUT / "runs" / f"{case['id']}.json", "w"))
    print(f"{case['id']}: start {out['errStart']['rot']:.2f} -> refined {out['errRefined']['rot']:.2f} deg  "
          f"sigma {out['sigmaPred']:.3f}  cost {out['cost']:.4f} (start {out['startCost']:.4f}, gt {out['gtCost']:.4f})  "
          f"[{out['sec']:.0f}s]", flush=True)
    return out


def main():
    args = sys.argv[1:]
    part = (0, 1)
    kind = None
    if "--part" in args:
        i = args.index("--part")
        a, b = args[i + 1].split("/")
        part = (int(a), int(b))
        del args[i:i + 2]
    if "--kind" in args:
        i = args.index("--kind")
        kind = args[i + 1]
        del args[i:i + 2]
    cases = []
    if kind in (None, "primary"):
        cases += CS.primary_cases()
    if kind in (None, "secondary"):
        cases += CS.secondary_cases()
    if args:
        cases = [c for c in cases if c["id"] in args or c["name"] in args]
    names = sorted({c["name"] for c in cases})
    names = [n for k, n in enumerate(names) if k % part[1] == part[0]]
    (OUT / "runs").mkdir(parents=True, exist_ok=True)
    (OUT / "renders").mkdir(parents=True, exist_ok=True)
    fx = FE.Features()
    for name in names:
        group = [c for c in cases if c["name"] == name]
        todo = [c for c in group if not (OUT / "runs" / f"{c['id']}.json").exists()]
        if not todo:
            continue
        c0 = todo[0]
        fr = G.EnuFrame(c0["lat"], c0["lon"], 0.0)
        grids = D.build_grids(fr, c0["eye"])
        eye_z, clamped = D.clamp_eye(grids, c0["eye"])
        photo = CS.load_photo(c0)
        # ortho wedge covers every start of the group (margin + the largest start offset)
        yaws = [c["start"]["yaw"] for c in todo]
        wy = max(abs(G.wrap180(y - yaws[0])) for y in yaws)
        sB = RENDER_LONG / max(c0["W0"], c0["H0"])
        hfov = 2 * math.degrees(math.atan(c0["W0"] * sB / 2 / (c0["start"]["f"] * sB)))
        wedge = (yaws[0], min(85.0, hfov / 2 + MARGIN_DEG + 10 + wy + 12))
        ortho = D.Ortho(fr, wedge, HERE / "cache_ortho")
        for c in todo:
            try:
                run_case({**c, "eyeClamped": clamped}, fx, grids, ortho, photo, eye_z)
            except Exception as e:  # noqa: BLE001
                import traceback

                traceback.print_exc()
                print(f"{c['id']}: FAILED {e}", flush=True)


if __name__ == "__main__":
    main()
