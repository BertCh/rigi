"""Dump the inputs of src/lib/nearfield/anchor.ts fitAnchor for the DEV photos, so scripts/nearfield/anchor-eval.ts can
run the REAL TypeScript fit offline (no browser). Same data as place.py: the TM dev cache correct ref (perturbBase view),
the x2 MoGe-2 large depth (moge_l) nearest-resampled onto the view's xyz grid by spike.model_on_grid, the MoGe mask as
sky/valid, and the FIXED Object mask place.py uses for the terrain residual (spike mode-scale split).

Per photo <pid>.bin (float32/uint8 little-endian, row 0 = top, W*H cells of the xyz grid, concatenated in this order):
  depth  float32 W*H  model z-depth (metres, NaN where invalid: masked, non-finite or <= 0)
  dem    float32 W*H  DEM ray range |xyz - eye| (NaN = no terrain)
  valid  uint8   W*H  1 = the MoGe mask says geometry (not sky)
  sky    uint8   W*H  1 = sky (= 1 - valid)
  object uint8   W*H  1 = Object under place.py's fixed mask (split(dem, ray * mode-scale R3000))
and <pid>.json: {id, width, height, K:{fx,fy,cx,cy} normalised (fx/W, fy/H, cx/W, cy/H of the NATIVE photo; the
xyz-grid cell (i,j) sits at native pixel (i*stride+0.5, j*stride+0.5)), stride, nativeW, nativeH, isObj}.

    tools/matcher/.venv/bin/python tools/nearfield/spike/dump_anchor_inputs.py [--out DIR] [ids...]
Reads the gitignored TM cache from the main tree (set RIGI_MAIN to override). DEV ids only.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np

MAIN = Path(os.environ.get("RIGI_MAIN", "/Users/robertchristie/Documents/GitHub/mt-image"))
HERE = MAIN / "tools/nearfield/spike"
TM = MAIN / "tools/research/tm"
sys.path[:0] = [str(TM), str(TM / "c0_cache"), str(HERE)]
import cache_io as C  # noqa: E402
import tm_common  # noqa: E402
from place import GEOM, OBJ_IDS, OBJECT, SPLIT, CURVE, apply_curve, fit_curve, split  # noqa: E402,F401
from spike import fit_mode, model_on_grid  # noqa: E402

DEFAULT_OUT = Path(
    "/private/tmp/claude-501/-Users-robertchristie-Documents-GitHub-mt-image/81540ede-f146-474f-8d03-4441676ff7c0/scratchpad/anchor-inputs"
)


def load_view_dir(vd: Path) -> dict:
    rec = json.load(open(vd / "view.json"))
    rec["xyz"] = np.load(vd / "xyz.npz")["xyz"]
    return rec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ids", nargs="*")
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    ap.add_argument(
        "--view-dir",
        help="smoke test: read this view dir (view.json + xyz.npz, e.g. x5_verifier/extra/wc_0086/N7) for the single "
        "dev id given, instead of the TM cache correct ref. Not a correct ref: for pipeline checks only.",
    )
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    dev = set(tm_common.dev_ids())
    ids = a.ids or sorted(dev)
    total = 0
    for pid in ids:
        assert pid in dev, f"{pid} not dev"
        if not (GEOM / f"{pid}.moge_l.npz").exists():
            continue
        if a.view_dir:
            rec = load_view_dir(Path(a.view_dir))
        else:
            if not (C.CACHE / pid / "meta.json").exists() or not (C.CACHE / pid / "refs").exists():
                continue  # the render cache is gitignored and may be pruned: skip, do not fail
            m = C.load_meta(pid)
            if not m["correct_refs"]:
                continue
            rec = C.load_view(pid, "refs", m["perturbBase"])
        dem = C.depth(rec)
        g = dict(np.load(GEOM / f"{pid}.moge_l.npz"))
        ray, valid = model_on_grid(g, rec, "solved")
        h, w = dem.shape
        # z-depth on the same grid (model_on_grid returns ray length; recompute z with the same sampling)
        d = g["depth"].astype(np.float32)
        gh, gw = d.shape
        u, v = C.xyz_pixel_coords(rec)
        x = np.clip(np.floor(u / rec["W"] * gw).astype(int), 0, gw - 1)
        y = np.clip(np.floor(v / rec["H"] * gh).astype(int), 0, gh - 1)
        z = d[y, x].astype(np.float32)
        zok = np.isfinite(ray)
        z[~zok] = np.nan
        # fixed Object mask exactly as place.py main(): the mode-scale split, else the curve's own split
        cand = np.isfinite(dem) & np.isfinite(ray) & (dem >= CURVE["minRange"]) & (dem <= CURVE["maxRange"])
        if cand.sum() < 200:
            objm = np.zeros((h, w), bool)
        else:
            md = fit_mode(dem, ray, 3000.0)
            if md["ok"]:
                cls = split(dem, ray * md["scale"], valid)
            else:
                cv = fit_curve(ray[cand], dem[cand])
                cls = split(dem, apply_curve(cv, ray), valid)
            objm = cls == OBJECT
        k = rec["intrinsics"]
        W0, H0 = rec["W"], rec["H"]
        meta = {
            "id": pid, "width": w, "height": h, "stride": rec["files"]["xyz"]["stride"], "nativeW": W0, "nativeH": H0,
            "K": {"fx": k["fx"] / W0, "fy": k["fy"] / H0, "cx": k["cx"] / W0, "cy": k["cy"] / H0},
            "isObj": pid in OBJ_IDS,
        }
        with open(out / f"{pid}.bin", "wb") as f:
            f.write(z.astype("<f4").tobytes())
            f.write(dem.astype("<f4").tobytes())
            f.write(valid.astype(np.uint8).tobytes())
            f.write((~valid).astype(np.uint8).tobytes())
            f.write(objm.astype(np.uint8).tobytes())
        json.dump(meta, open(out / f"{pid}.json", "w"))
        total += 1
        print(pid, w, h, meta["K"], "obj", round(float(objm.mean()), 4), flush=True)
    print("wrote", total, "photos to", out)


if __name__ == "__main__":
    main()
