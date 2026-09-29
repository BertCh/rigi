"""One-sided anchor signals (mode fit) as quality / pose verifier, MoGe-2 on all correct / wrong / perturbed views.

Idea: near objects only ever make the model depth SHORTER than the DEM range (D/d > s). A model depth that is LONGER
than the DEM range ("sees through the terrain") cannot be explained by objects, so its frequency is a cleaner
inconsistency signal than the two-sided residual.

    tools/matcher/.venv/bin/python tools/nearfield/spike/verif2.py [--model moge_l]
Writes verif2.json.
"""
from __future__ import annotations

import argparse
import json
import math

import numpy as np

import spike as S
from sweep import CLEAN, OBJ, fit_mode

RS = (1000.0, 3000.0, 1e9)


def signals(dem, ray, R):
    f = fit_mode(dem, ray, R)
    if not f["ok"]:
        return None
    cand = np.isfinite(dem) & np.isfinite(ray) & (dem < R) & (dem > S.RMIN)
    e = np.log(ray[cand] * f["scale"] / dem[cand])  # >0: model beyond the DEM surface
    behind = e > S.BAND
    front = e < -S.BAND
    terr = ~front
    return {"n": f["n"], "scale": f["scale"], "residualLogAll": f["residualLogAll"], "inlierFrac": f["inlierFrac"],
            "behindFrac": float(behind.mean()), "frontFrac": float(front.mean()),
            "residualLogTerr": float(np.median(np.abs(e[terr]))) if terr.any() else float("nan"),
            "behindFracTerr": float(behind.sum() / max(terr.sum(), 1))}


def auc(pos, neg):
    pos, neg = np.asarray(pos, float), np.asarray(neg, float)
    if not len(pos) or not len(neg):
        return None
    return round(float((pos[:, None] < neg[None, :]).mean() + 0.5 * (pos[:, None] == neg[None, :]).mean()), 3)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="moge_l")
    a = ap.parse_args()
    raw = json.load(open(S.HERE / "results_raw.json"))
    rows = []
    for pid in sorted(raw):
        m = S.C.load_meta(pid)
        g = dict(np.load(S.GEOM / f"{pid}.{a.model}.npz"))
        views = [("correct", "refs", r["label"]) for r in m["correct_refs"]]
        views += [("wrong", "refs", r["label"]) for r in m["wrong_refs"]]
        views += [("perturb", "perturb", t) for t in S.PERTURB_TAGS]
        for kind, grp, tag in views:
            rec = S.C.load_view(pid, grp, tag)
            if rec.get("empty"):
                continue
            dem = S.dem_range(rec)
            ray, _ = S.model_on_grid(g, rec)
            row = {"pid": pid, "kind": kind, "tag": tag, "base": tag == m["perturbBase"]}
            for R in RS:
                row[str(int(R)) if R < 1e8 else "all"] = signals(dem, ray, R)
            rows.append(row)
    groups = {"wrongRefs": lambda r: r["kind"] == "wrong", "yaw±8": lambda r: r["tag"] in ("yaw-8", "yaw+8"),
              "yaw±2": lambda r: r["tag"] in ("yaw-2", "yaw+2"), "pitch±2": lambda r: r["tag"] in ("pitch-2", "pitch+2")}
    sig = {"behindFrac": lambda s: s["behindFrac"], "behindFracTerr": lambda s: s["behindFracTerr"],
           "residualLogTerr": lambda s: s["residualLogTerr"], "residualLogAll": lambda s: s["residualLogAll"],
           "neg_inlierFrac": lambda s: -s["inlierFrac"]}
    out = {"auc": {}, "pairedWin": {}, "rows": rows}
    for Rk in ("1000", "3000", "all"):
        for sn, sf in sig.items():
            pos = [sf(r[Rk]) for r in rows if r["kind"] == "correct" and r[Rk]]
            for gn, gf in groups.items():
                neg = [sf(r[Rk]) for r in rows if gf(r) and r[Rk]]
                pw = []
                for r in rows:
                    if gf(r) and r[Rk]:
                        b = [x for x in rows if x["pid"] == r["pid"] and x["base"] and x[Rk]]
                        if b:
                            pb, pn = sf(b[0][Rk]), sf(r[Rk])
                            pw.append(1.0 if pb < pn else 0.5 if pb == pn else 0.0)
                out["auc"][f"{Rk}|{sn}|{gn}"] = auc(pos, neg)
                out["pairedWin"][f"{Rk}|{sn}|{gn}"] = round(float(np.mean(pw)), 3) if pw else None
    # distribution of the base (correct) view signals by photo group, for calibrating quality
    dist = {}
    for r in rows:
        if r["base"] and r["all"]:
            grp = "obj" if r["pid"] in OBJ else "clean" if r["pid"] in CLEAN else "other"
            dist.setdefault(grp, []).append({k: round(v, 3) for k, v in r["all"].items()} | {"pid": r["pid"]})
    out["baseDist"] = dist
    json.dump(out, open(S.HERE / "verif2.json", "w"), indent=1, default=float)
    for k in out["auc"]:
        print(k, out["auc"][k], out["pairedWin"][k])
    for grp, xs in dist.items():
        for x in xs:
            print(grp, x)


if __name__ == "__main__":
    main()
