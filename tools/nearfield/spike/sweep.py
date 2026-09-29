"""Split-parameter sweep on the correct-ref view (MoGe-2), using a coarse proxy label per photo:
CLEAN photos (no discrete near objects expected: Object area ~ false positives) vs OBJ photos (trees, cars, train,
plants, pylons expected: Object area should be > 0). Tags from the dev manifest; the grouping is mine (see SUMMARY).

    tools/matcher/.venv/bin/python tools/nearfield/spike/sweep.py [--model moge_l]
Writes sweep.json.
"""
from __future__ import annotations

import argparse
import itertools
import json
import math

import numpy as np

import spike as S
from spike import fit_mode

CLEAN = ["wc_0002", "wc_0004", "wc_0006", "wc_0009", "wc_0011", "wc_0014", "wc_0017", "wc_0019", "wc_0020", "wc_0027",
         "wc_0047", "wc_0048", "wc_0052", "wc_0071", "wc_0085", "wc_0099"]
OBJ = ["wc_0046", "wc_0054", "wc_0055", "wc_0059", "wc_0067", "wc_0072", "wc_0076"]


def quality(res, inl, r0=0.2):
    return inl * math.exp(-((res / r0) ** 2))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="moge_l")
    a = ap.parse_args()
    data = {}
    for pid in CLEAN + OBJ:
        m = S.C.load_meta(pid)
        rec = S.C.load_view(pid, "refs", m["perturbBase"])
        dem = S.dem_range(rec)
        g = dict(np.load(S.GEOM / f"{pid}.{a.model}.npz"))
        ray, valid = S.model_on_grid(g, rec)
        fits = {}
        for R in (300.0, 1000.0, 3000.0):
            fits[f"scale{int(R)}"] = S.fit_scale(dem, ray, R)
            fits[f"mode{int(R)}"] = fit_mode(dem, ray, R)
        fits["binmode"] = S.fit_binmode(dem, ray)
        data[pid] = (dem, ray, valid, fits)
    rows = []
    fitters = ["scale1000", "scale300", "mode1000", "mode300", "mode3000", "scale3000", "binmode"]
    for fk, margin, nr, gap, qmin in itertools.product(fitters, (0.25, 0.4, 0.5, 0.6), (150.0, 250.0, 400.0), (3.0, 8.0), (0.0, 0.2, 0.35)):
        p = {"objectMargin": margin, "nearRadius": nr, "minGapM": gap}
        fr = {}
        for pid, (dem, ray, valid, fits) in data.items():
            f = fits[fk]
            if fk == "binmode":
                if qmin > 0:
                    continue
                mapped = S.apply_binmode(f, ray) if f["ok"] else np.full_like(ray, np.nan)
            elif not f["ok"] or quality(f["residualLogAll"], f["inlierFrac"]) < qmin:
                mapped = np.full_like(ray, np.nan)
            else:
                mapped = ray * f["scale"]
            cls = S.split(dem, mapped, valid, p)
            fr[pid] = float((cls == S.OBJECT).mean())
        if len(fr) < len(data):
            continue
        c = np.array([fr[p] for p in CLEAN])
        o = np.array([fr[p] for p in OBJ])
        rows.append({"fit": fk, "objectMargin": margin, "nearRadius": nr, "minGapM": gap, "qmin": qmin,
                     "cleanMean": round(float(c.mean()), 4), "cleanOver2pct": int((c > 0.02).sum()),
                     "objOver1pct": int((o > 0.01).sum()), "objMedian": round(float(np.median(o)), 4),
                     # crude score: object photos detected minus clean photos with false-object area
                     "score": int((o > 0.01).sum()) - int((c > 0.02).sum()), "perPhoto": {k: round(v, 4) for k, v in fr.items()}})
    rows.sort(key=lambda r: (-r["score"], r["cleanMean"]))
    fits_out = {pid: {k: ({kk: (round(vv, 4) if isinstance(vv, float) else vv) for kk, vv in f.items()}) for k, f in d[3].items()} for pid, d in data.items()}
    json.dump({"clean": CLEAN, "obj": OBJ, "rows": rows, "fits": fits_out}, open(S.HERE / "sweep.json", "w"), indent=1)
    for r in rows[:15]:
        print({k: v for k, v in r.items() if k != "perPhoto"})
    print("default-ish:")
    for r in rows:
        if r["objectMargin"] == 0.25 and r["nearRadius"] == 400 and r["minGapM"] == 3 and r["qmin"] == 0:
            print({k: v for k, v in r.items() if k != "perPhoto"})


if __name__ == "__main__":
    main()
