"""Summaries of place*.json: median over photos of terrain residuals by DEM-range bin, curve vs single scale."""
import json, sys
import numpy as np
for f in sys.argv[1:]:
    r = json.load(open(f))
    ok = [v for v in r.values() if v.get("curve")]
    out = {}
    for meth in ("curve", "scale3000", "mode3000", "scale150"):
        a = [v["resid500"][meth] for v in ok if v["resid500"].get(meth) is not None]
        out[meth + "_15-500"] = (round(float(np.median(a)), 3), round(float(np.mean(np.array(a) < 0.1)), 2), len(a)) if a else None
    for meth in ("curve", "scale3000"):
        for b in ("15-50", "50-150", "150-500"):
            a = [v["residBins"][meth][b] for v in ok if v["residBins"].get(meth) and v["residBins"][meth][b] is not None]
            out[f"{meth}_{b}"] = (round(float(np.median(a)), 3), len(a)) if a else None
    q = [v["curveQ"]["quality"] for v in ok]
    e = [v["curveQ"]["residualLogAll"] for v in ok]
    out["curve_allCand_resid_med"] = round(float(np.median(e)), 3)
    out["quality>=0.15"] = sum(x >= 0.15 for x in q)
    out["quality>=0.35"] = sum(x >= 0.35 for x in q)
    out["nfit"] = len(ok)
    print(f, json.dumps(out))
    clean = ["wc_0002","wc_0004","wc_0006","wc_0009","wc_0011","wc_0014","wc_0019","wc_0020","wc_0027","wc_0047","wc_0052","wc_0071","wc_0077","wc_0085","wc_0094","wc_0099"]
    print("   clean Obj>2%:", sum(1 for p in clean if r.get(p, {}).get("objFracFinal", 0) > 0.02), "mean", round(float(np.mean([r[p].get("objFracFinal", 0) for p in clean if p in r])), 4))
    objs = ["wc_0046","wc_0054","wc_0055","wc_0059","wc_0067","wc_0072","wc_0076"]
    print("   OBJ Obj>1%:", sum(1 for p in objs if r.get(p, {}).get("objFracFinal", 0) > 0.01), {p: round(r.get(p, {}).get("objFracFinal", 0), 3) for p in objs})
