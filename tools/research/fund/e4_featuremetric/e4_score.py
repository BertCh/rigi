# Rigi
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: Copyright (c) Rigi contributors

"""E4 scoring (PROTOCOL sections 1-3): aggregate out/runs/*.json into results.json and print the verdict.
    PYTHONPATH=. tools/matcher/.venv/bin/python e4_score.py
"""
from __future__ import annotations

import json
import math

import numpy as np
from scipy.stats import spearmanr

import e4_data as D

HERE = D.HERE


def med(v):
    return float(np.median(v)) if len(v) else None


def main():
    runs = [json.load(open(p)) for p in sorted((HERE / "out/runs").glob("*.json"))]
    prim = [r for r in runs if r["kind"] == "primary"]
    sec = [r for r in runs if r["kind"] == "secondary"]
    res = {"protocol": "PROTOCOL.txt", "label": "dev, not a result", "nPrimary": len(prim), "nSecondary": len(sec)}
    res["primary"] = {
        "perPhoto": [{"id": r["id"], "accepted": r["accepted"], "startErr": r["errStart"]["rot"],
                      "refinedErr": r["errRefined"]["rot"], "startYaw": r["errStart"]["yaw"], "refinedYaw": r["errRefined"]["yaw"],
                      "startPitch": r["errStart"]["pitch"], "refinedPitch": r["errRefined"]["pitch"],
                      "sigmaPred": r["sigmaPred"], "cost": r["cost"], "startCost": r["startCost"], "gtCost": r["gtCost"],
                      "fErrStart": r["errStart"]["f"], "fErrRefined": r["errRefined"]["f"]} for r in prim],
        "medianStartRot": med([r["errStart"]["rot"] for r in prim]),
        "medianRefinedRot": med([r["errRefined"]["rot"] for r in prim]),
        "medianStartYaw": med([abs(r["errStart"]["yaw"]) for r in prim]),
        "medianRefinedYaw": med([abs(r["errRefined"]["yaw"]) for r in prim]),
        "medianStartPitch": med([abs(r["errStart"]["pitch"]) for r in prim]),
        "medianRefinedPitch": med([abs(r["errRefined"]["pitch"]) for r in prim]),
        "nRefinedBetter": sum(r["errRefined"]["rot"] < r["errStart"]["rot"] for r in prim),
    }
    res["secondary"] = {"perRun": [{"id": r["id"], "scaleDeg": r["scaleDeg"], "startErr": r["errStart"]["rot"], "refinedErr": r["errRefined"]["rot"], "sigmaPred": r["sigmaPred"], "fErrRefined": r["errRefined"]["f"]} for r in sec]}
    for s in (1.0, 3.0, 10.0):
        g = [r for r in sec if r["scaleDeg"] == s]
        res["secondary"][f"{int(s)}deg"] = {
            "n": len(g), "fracWithin0.3": float(np.mean([r["errRefined"]["rot"] <= 0.3 for r in g])) if g else None,
            "fracStartWithin0.3": float(np.mean([r["errStart"]["rot"] <= 0.3 for r in g])) if g else None,
            "medianStart": med([r["errStart"]["rot"] for r in g]), "medianRefined": med([r["errRefined"]["rot"] for r in g]),
            "nRefinedBetter": sum(r["errRefined"]["rot"] < r["errStart"]["rot"] for r in g)}
    allr = [r for r in runs if math.isfinite(r["sigmaPred"])]
    rho, p = spearmanr([r["sigmaPred"] for r in allr], [r["errRefined"]["rot"] for r in allr])
    res["spearman"] = {"rho": float(rho), "p": float(p), "n": len(allr), "nNanSigma": len(runs) - len(allr)}
    prim_ok = (res["primary"]["medianRefinedRot"] is not None) and res["primary"]["medianRefinedRot"] < res["primary"]["medianStartRot"]
    sp_ok = rho >= 0.4
    res["verdict"] = {"primaryMedianLower": bool(prim_ok), "spearmanAtLeast0.4": bool(sp_ok), "verdict": "PASS (dev only)" if prim_ok and sp_ok else "KILL"}
    # POST HOC (never changes the verdict): spearman by kind; error vs cost; GT cost vs refined cost
    res["posthoc"] = {
        "spearmanPrimaryOnly": float(spearmanr([r["sigmaPred"] for r in prim], [r["errRefined"]["rot"] for r in prim])[0]) if len(prim) > 2 else None,
        "spearmanSecondaryOnly": float(spearmanr([r["sigmaPred"] for r in sec], [r["errRefined"]["rot"] for r in sec])[0]) if len(sec) > 2 else None,
        "fracRefinedCostBelowGtCost": float(np.mean([r["cost"] < r["gtCost"] for r in runs])),
        "medianSolvedAlwaysStartErrPrimary": med([r["startSolvedErr"] for r in prim if r.get("startSolvedErr") is not None]),
    }
    json.dump(res, open(HERE / "results.json", "w"), indent=1)
    print(json.dumps({k: v for k, v in res.items() if k not in ("primary",)}, indent=1))
    print("primary:", {k: v for k, v in res["primary"].items() if k != "perPhoto"})


if __name__ == "__main__":
    main()
