"""Summarise raw.json -> results.json (error distributions + gate sweep). Mirrors the gate in
src/lib/nearfield/propagate.ts (PROPAGATE_GATE)."""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
raw = json.loads((HERE / "raw.json").read_text())

GOOD = 5.0  # deg: usable as a matcher seed (PROPAGATE_GATE.seedRadiusDeg)
TIGHT = 1.0


def ang(R):
    return math.degrees(math.acos(max(-1.0, min(1.0, (np.trace(R) - 1) / 2))))


def overlap(relR, KA, WA, HA, KB, WB, HB):
    us, vs = np.meshgrid(np.linspace(0.5, WA - 0.5, 16), np.linspace(0.5, HA - 0.5, 12))
    pts = np.stack([us.ravel(), vs.ravel(), np.ones(us.size)])
    b = relR @ (np.linalg.inv(KA) @ pts)
    ok = b[2] > 1e-6
    pb = KB @ (b / np.where(ok, b[2], 1))
    return float((ok & (pb[0] >= 0) & (pb[0] < WB) & (pb[1] >= 0) & (pb[1] < HB)).mean())


def stats(v):
    v = [x for x in v if x is not None]
    if not v:
        return {"n": 0}
    a = np.asarray(v)
    return {"n": len(v), "median": round(float(np.median(a)), 3), "p90": round(float(np.percentile(a, 90)), 3),
            "max": round(float(a.max()), 3), "le1": int((a <= TIGHT).sum()), "le5": int((a <= GOOD).sum())}


def rows():
    """Flatten into (set, err_by_method, evidence) records; negatives have err = inf (any propagation is wrong)."""
    out = []
    for r in raw.get("real", []):
        out.append({"set": "real_overlap" if r["overlap"] > 0 else "real_nooverlap", "id": f"{r['A']}->{r['B']}", **ev(r),
                    "gtAngle": r["gtAngle"], "overlapGt": r["overlap"]})
    for i, r in enumerate(raw.get("synth", [])):
        out.append({"set": "synth" if r["overlap"] > 0 else "synth_nooverlap", "id": f"synth{i}:{r['src']}", **ev(r),
                    "gtAngle": r["gtAngle"], "overlapGt": r["overlap"]})
    for i, r in enumerate(raw.get("neg", [])):
        out.append({"set": "neg_diffplace", "id": f"neg{i}:{r['A']}->{r['B']}", **ev(r, neg=True), "overlapGt": 0.0})
    return out


def ev(r, neg=False):
    d = {}
    for m in ("rot", "ess", "da3"):
        x = r.get(m)
        d[f"{m}Err"] = None if not x else (float("inf") if neg else x["err"])
    x = r.get("rot")
    d["inliers"] = x["inliers"] if x else 0
    d["rmsPx"] = x["rmsPx"] if x else None
    b = r.get("rotBwd")
    d["fwdBwd"] = ang(np.asarray(b["relR"]) @ np.asarray(x["relR"])) if (x and b) else None
    d["inliersBwd"] = b["inliers"] if b else 0
    if x and r.get("da3"):
        d["da3VsRot"] = ang(np.asarray(r["da3"]["relR"]) @ np.asarray(x["relR"]).T)
    return d


def gate(r, g):
    return (r["inliers"] >= g["minInliers"] and r["rmsPx"] is not None and r["rmsPx"] <= g["maxRmsPx"]
            and r["fwdBwd"] is not None and r["fwdBwd"] <= g["maxFwdBwdDeg"])


def sweep(R):
    res = []
    for mi in (10, 15, 20, 30, 40, 60, 100):
        for fb in (0.5, 1.0, 1.5, 3.0, 1e9):
            g = {"minInliers": mi, "maxRmsPx": 3.5, "maxFwdBwdDeg": fb}
            p = [r for r in R if gate(r, g)]
            good = [r for r in p if r["rotErr"] is not None and r["rotErr"] <= GOOD]
            allgood = [r for r in R if r["rotErr"] is not None and r["rotErr"] <= GOOD]
            res.append({"minInliers": mi, "maxFwdBwdDeg": fb if fb < 1e8 else None, "passed": len(p),
                        "passedGood": len(good), "falsePass": len(p) - len(good),
                        "recallOfGood": round(len(good) / max(1, len(allgood)), 3),
                        "falsePassIds": [r["id"] for r in p if not (r["rotErr"] is not None and r["rotErr"] <= GOOD)][:8]})
    return res


R = rows()
sets = sorted({r["set"] for r in R})
summary = {}
for s in sets:
    S = [r for r in R if r["set"] == s]
    summary[s] = {m: stats([r[f"{m}Err"] if r[f"{m}Err"] != float("inf") else None for r in S]) for m in ("rot", "ess", "da3")}
    summary[s]["n"] = len(S)
    summary[s]["inliers"] = stats([r["inliers"] for r in S])

CHOSEN = {"minInliers": 40, "maxRmsPx": 3.5, "maxFwdBwdDeg": 1.5}
chosen = {}
for s in sets:
    S = [r for r in R if r["set"] == s]
    P = [r for r in S if gate(r, CHOSEN)]
    errs = [r["rotErr"] for r in P if r["rotErr"] not in (None, float("inf"))]
    chosen[s] = {"n": len(S), "passed": len(P), "falsePass": sum(1 for r in P if not (r["rotErr"] is not None and r["rotErr"] <= GOOD)),
                 "errOfPassed": stats(errs),
                 "missedGood": [r["id"] for r in S if r["rotErr"] is not None and r["rotErr"] <= GOOD and not gate(r, CHOSEN)][:10]}

# DA3: does any available signal predict its error? (agreement with rot, its own overlap)
da3 = [r for r in R if r.get("da3Err") not in (None, float("inf")) and r["set"] in ("synth", "real_overlap")]
da3_corr = None
if da3:
    e = np.array([r["da3Err"] for r in da3])
    v = np.array([r.get("da3VsRot", np.nan) for r in da3])
    ok = np.isfinite(v)
    da3_corr = {"n": int(len(e)), "spearman_da3Err_vs_da3VsRot": float(
        np.corrcoef(np.argsort(np.argsort(e[ok])), np.argsort(np.argsort(v[ok])))[0, 1]) if ok.sum() > 3 else None,
        "da3Err_by_gtAngle": {f"{lo}-{hi}": stats([r["da3Err"] for r in da3 if lo <= r["gtAngle"] < hi])
                              for lo, hi in ((0, 10), (10, 20), (20, 40), (40, 90))}}

out = {
    "about": "Pose propagation within a viewpoint (Step Inside P2). See REPORT.txt. Errors are geodesic deg between "
             "predicted and GT target rotation (= relR error, the anchor pose is exact GT here). 'real' GT poses are "
             "'approx' quality (0.3-1 deg each) for 7059/7063/7068. Negatives: pairs of different wild DEV photos.",
    "goodDeg": GOOD,
    "summary": summary,
    "gateChosen": {"gate": CHOSEN, "bySet": chosen},
    "gateSweepAll": sweep(R),
    "da3": da3_corr,
    "wildDevCase": json.loads((HERE / "wild_dev_case.json").read_text()) if (HERE / "wild_dev_case.json").exists() else None,
    "da3SecondsMedian": float(np.median([x["da3"]["seconds"] for k in ("real", "synth") for x in raw.get(k, []) if x.get("da3")])),
    "rows": R,
}
(HERE / "results.json").write_text(json.dumps(out, indent=1, default=lambda x: None if x == float("inf") else x)
                                   .replace("Infinity", "null"))
print(json.dumps({"summary": summary, "gateChosen": chosen, "da3": da3_corr}, indent=1).replace("Infinity", "null"))
