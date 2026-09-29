"""Evaluate DEM-prompted depth (run_lingbot.py cache) against MoGe-2 + curve on the TM dev cache (DEV ids only).

On the xyz grid of the correct-ref view:
  terrain residual  median |log(range / DEM)| on HELD-OUT Terrain pixels (checkerboard half that was not prompted), by
                    DEM bin 15-50 / 50-150 / 150-500 / 500-3000 m. MoGe+curve: curve fitted on the prompt half only.
  objects           for the components place.py grounds (MoGe pipeline): median range of the component under each depth
                    (LingBot variants raw; MoGe placed = grounded factor) vs the DEM range at its contact.
Writes eval.json.  tools/matcher/.venv/bin/python tools/nearfield/depthprompt/eval.py [ids...]
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "spike"))
import place as P  # noqa: E402

C = P.C
CACHE = HERE / "cache"
BINS = ((15, 50), (50, 150), (150, 500), (500, 3000))


def on_xyz(arr, rec):
    """768-grid array (photo framing) -> xyz grid, nearest."""
    h, w = arr.shape
    u, v = C.xyz_pixel_coords(rec)
    x = np.clip(np.floor(u / rec["W"] * w).astype(int), 0, w - 1)
    y = np.clip(np.floor(v / rec["H"] * h).astype(int), 0, h - 1)
    return arr[y, x]


def z_to_ray(z, rec):
    u, v = C.xyz_pixel_coords(rec)
    k = rec["intrinsics"]
    return z * np.sqrt(1 + ((u - k["cx"]) / k["fx"]) ** 2 + ((v - k["cy"]) / k["fy"]) ** 2)


def resid(pred, dem, sel):
    out = {}
    for lo, hi in BINS:
        s = sel & (dem >= lo) & (dem < hi) & np.isfinite(pred) & (pred > 0)
        out[f"{lo}-{hi}"] = float(np.median(np.abs(np.log(pred[s] / dem[s])))) if s.sum() >= 100 else None
    s = sel & (dem >= 15) & (dem < 500) & np.isfinite(pred) & (pred > 0)
    out["15-500"] = float(np.median(np.abs(np.log(pred[s] / dem[s])))) if s.sum() >= 150 else None
    return out


def main():
    ids = sys.argv[1:] or sorted({p.name.split(".")[0] for p in CACHE.glob("*.npz")})
    res = {}
    for pid in ids:
        files = sorted(CACHE.glob(f"{pid}.*.npz"))
        if not files:
            continue
        m = C.load_meta(pid)
        rec = C.load_view(pid, "refs", m["perturbBase"])
        dem = C.depth(rec)
        g = P.load_depth(pid, "moge_l")
        ray, valid = P.model_on_grid(g, rec, "solved")
        cand = np.isfinite(dem) & np.isfinite(ray) & (dem >= 15) & (dem <= 3000)
        if cand.sum() < 200:
            continue
        cv_all = P.fit_curve(ray[cand], dem[cand])
        cls = P.split(dem, P.apply_curve(cv_all, ray), valid)
        lab, info = P.ground(cls, ray, dem, cv_all, dict(P.GROUND, upright=2.0))
        prompt = on_xyz(np.load(files[0])["prompt"], rec)
        # MoGe + curve fitted on the prompt half only
        c2 = cand & prompt
        cv = P.fit_curve(ray[c2], dem[c2]) if c2.sum() >= 200 else cv_all
        held = (cls == P.TERRAIN) & ~prompt & np.isfinite(dem)
        r = {"heldPx": int(held.sum()), "terrain": {"moge_curve": resid(P.apply_curve(cv, ray), dem, held)}}
        preds = {}
        for f in files:
            var = f.name.split(".")[1]
            z = on_xyz(np.load(f)["depth"].astype(np.float64), rec)
            preds[var] = z_to_ray(z, rec)
            r["terrain"][f"lingbot_{var}"] = resid(preds[var], dem, held)
            # also: the unprompted model after the same curve calibration (is LingBot a better monocular model?)
            if var == "none":
                p = preds[var]
                cc = cand & prompt & np.isfinite(p)
                if cc.sum() >= 200:
                    cvn = P.fit_curve(p[cc], dem[cc])
                    r["terrain"]["lingbot_none_curve"] = resid(P.apply_curve(cvn, p), dem, held)
        objs = []
        for c in info:
            if c["n"] < 60 or c.get("notUpright"):
                continue
            k = lab == c["id"]
            o = {"id": c["id"], "n": c["n"], "grounded": c["factor"] is not None,
                 "contactDem": c.get("contactDem"),
                 "moge_curve": float(np.nanmedian(P.apply_curve(cv_all, ray[k]))),
                 "moge_placed": float(np.nanmedian(c["factor"] * ray[k])) if c["factor"] is not None else None,
                 "demBehind": float(np.nanmedian(dem[k])) if np.isfinite(dem[k]).any() else None}
            for var, p in preds.items():
                o[f"lingbot_{var}"] = float(np.nanmedian(p[k])) if np.isfinite(p[k]).any() else None
            objs.append(o)
        r["objects"] = objs
        res[pid] = r
        t = r["terrain"]
        print(pid, "held", r["heldPx"], {k: (round(v["15-500"], 3) if v["15-500"] is not None else None) for k, v in t.items()}, flush=True)
    json.dump(res, open(HERE / "eval.json", "w"), indent=1)
    # summary
    keys = sorted({k for v in res.values() for k in v["terrain"]})
    print("\nmedian over photos of terrain |log| residual on held-out pixels (n photos):")
    for k in keys:
        row = {}
        for b in ["15-500"] + [f"{lo}-{hi}" for lo, hi in BINS]:
            a = [v["terrain"][k][b] for v in res.values() if k in v["terrain"] and v["terrain"][k][b] is not None]
            row[b] = (round(float(np.median(a)), 3), len(a)) if a else None
        print(f"  {k:22s}", row)
    print("\ngrounded objects: range under each depth / DEM at contact (median over components):")
    g = [o for v in res.values() for o in v["objects"] if o["grounded"] and o["contactDem"]]
    for k in ["moge_curve", "moge_placed"] + [f"lingbot_{x}" for x in ("terr", "terrN", "none")]:
        a = [o[k] / o["contactDem"] for o in g if o.get(k)]
        if a:
            la = np.abs(np.log(a))
            print(f"  {k:14s} n={len(a)} median ratio {np.median(a):.2f}  median |log| {np.median(la):.3f}  within x1.25: {np.mean(la < np.log(1.25)):.2f}")


if __name__ == "__main__":
    main()
