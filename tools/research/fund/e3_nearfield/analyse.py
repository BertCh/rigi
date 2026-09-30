"""Aggregate out/<pid>.json per PROTOCOL.txt -> results.json + printed tables."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
FIRST = ["wc_0002", "wc_0034", "wc_0052", "wc_0055"]
rng = np.random.default_rng(0)
NB = 10000


def boot(x, stat=np.mean):
    x = np.asarray(x, float)
    if len(x) == 0:
        return None
    idx = rng.integers(0, len(x), size=(NB, len(x)))
    s = np.array([stat(x[i]) for i in idx])
    return [float(stat(x)), float(np.percentile(s, 2.5)), float(np.percentile(s, 97.5))]


def main():
    R = {p.stem: json.load(open(p)) for p in sorted(OUT.glob("wc_*.json"))}
    pids = sorted(R)
    res = {"n": len(pids), "pids": pids}
    # validation
    v = {"V0e_nearMedRel": [], "V1_nearMedRel": [], "V1_midMedRel": [], "V0e_gray": [], "V1_gray": [], "reproj": [],
         "cov": [], "clampT": []}
    for p in pids:
        val = R[p]["validation"]
        v["reproj"].append(val["cacheReprojMedPx"])
        v["cov"].append(R[p]["dtmCoverage"])
        v["clampT"].append(R[p]["renders"]["T_V1"]["clamped"])
        for var in ("V0e", "V1"):
            if "0-250" in val[var]:
                v[f"{var}_nearMedRel"].append(val[var]["0-250"]["medRelAbs"])
            if var == "V1" and "250-2000" in val[var]:
                v["V1_midMedRel"].append(val[var]["250-2000"]["medRelAbs"])
            if val[var]["grayCorrNear"] is not None:
                v[f"{var}_gray"].append(val[var]["grayCorrNear"])
    res["validation"] = {k: (float(np.median(x)) if k not in ("clampT",) else int(sum(x))) for k, x in v.items() if len(x)}
    res["validation"]["minCoverage"] = float(min(v["cov"]))
    # (a)
    A = {}
    for var in ("V0", "V0cut", "V0e", "V1", "V2"):
        for b in ("near", "mid", "far"):
            A[f"{var}_inl_{b}"] = [R[p]["a"][var][f"inl_{b}"] for p in pids]
            A[f"{var}_lift_{b}"] = [R[p]["a"][var][f"lift_{b}"] for p in pids]
        A[f"{var}_inl_total"] = [R[p]["a"][var]["inl_total"] for p in pids]
    a = {"perPhoto": {p: {var: {"inl<2km": R[p]["a"][var]["inl_near"] + R[p]["a"][var]["inl_mid"],
                                 "inl_far": R[p]["a"][var]["inl_far"],
                                 "lift<2km": R[p]["a"][var]["lift_near"] + R[p]["a"][var]["lift_mid"]}
                           for var in ("V0", "V0e", "V1", "V2")} for p in pids}}
    n0 = np.array(A["V0_inl_near"]) + np.array(A["V0_inl_mid"])
    for var in ("V0e", "V1", "V2"):
        nv = np.array(A[f"{var}_inl_near"]) + np.array(A[f"{var}_inl_mid"])
        g = np.log2((1 + nv) / (1 + n0))
        a[f"{var}_vs_V0_log2gain_0-2km"] = boot(g)
        a[f"{var}_vs_V0_medianDiff_0-2km"] = boot(nv - n0, np.median)
        a[f"{var}_sum_inl_0-2km"] = int(nv.sum())
        for b in ("near", "mid", "far"):
            a[f"{var}_sum_inl_{b}"] = int(np.sum(A[f"{var}_inl_{b}"]))
            a[f"{var}_sum_lift_{b}"] = int(np.sum(A[f"{var}_lift_{b}"]))
        a[f"{var}_photos_with_any_inl_0-2km"] = int((nv > 0).sum())
    for b in ("near", "mid", "far"):
        a[f"V0_sum_inl_{b}"] = int(np.sum(A[f"V0_inl_{b}"]))
        a[f"V0_sum_lift_{b}"] = int(np.sum(A[f"V0_lift_{b}"]))
    a["V0_sum_inl_0-2km"] = int(n0.sum())
    a["V0_photos_with_any_inl_0-2km"] = int((n0 > 0).sum())
    a["cutEffect_V0_near_inliers_regained"] = int(np.sum(A["V0_inl_near"]))
    gainV1 = a["V1_vs_V0_log2gain_0-2km"][1] > 0
    gainV2 = a["V2_vs_V0_log2gain_0-2km"][1] > 0
    a["GAIN"] = bool(gainV1 or gainV2)
    res["a"] = a
    # (b)
    B = {}
    for key in ("G50_V2", "G50_V1", "G50_V0e", "G20_V2", "G150_V2"):
        for dof in ("3dof", "2dof"):
            rows = [R[p]["b"][key] for p in pids if key in R[p]["b"]]
            better = np.array([r[dof]["better"] for r in rows], float)
            est = np.array([r[dof]["err3d"] for r in rows])
            gps = np.array([r["eGps3d"] for r in rows])
            estH = np.array([r[dof]["errH"] for r in rows])
            gpsH = np.array([r["eGpsH"] for r in rows])
            fails = [r[dof]["info"].get("fail") for r in rows]
            B[f"{key}_{dof}"] = {
                "n": len(rows), "fracBetter": boot(better), "nBetter": int(better.sum()),
                "nSolved": int(sum(f is None for f in fails)),
                "failReasons": {k: fails.count(k) for k in set(fails) if k},
                "medianErrEst": float(np.median(est)), "medianErrGps": float(np.median(gps)),
                "fracBetterH": float(np.mean(estH < gpsH)),
                "solvedOnly_medianErr": float(np.median(est[[f is None for f in fails]])) if any(f is None for f in fails) else None,
                "solvedOnly_fracBetter": float(np.mean(better[[f is None for f in fails]])) if any(f is None for f in fails) else None,
                "perPhoto": {p: {"gps": round(R[p]["b"][key]["eGps3d"], 1), "est": round(R[p]["b"][key][dof]["err3d"], 1),
                                 "fail": R[p]["b"][key][dof]["info"].get("fail"),
                                 "nFar5": R[p]["b"][key][dof]["info"].get("nFar5"),
                                 "nNearMid": R[p]["b"][key][dof]["info"].get("nNearMid"),
                                 "ctrInl": R[p]["b"][key][dof]["info"].get("ctrInl")} for p in pids if key in R[p]["b"]},
            }
    prim = B["G50_V2_3dof"]
    B["PRIMARY_fracBetter"] = prim["fracBetter"][0]
    B["PASS"] = bool(prim["fracBetter"][0] >= 0.60)
    # circular at T
    B["circularAtT"] = {var: {"nSolved": sum("fail" not in R[p]["solveAtT_circular"][var]["info"] for p in pids),
                              "medianErrSolved": (float(np.median([R[p]["solveAtT_circular"][var]["err3d"] for p in pids
                                                                   if "fail" not in R[p]["solveAtT_circular"][var]["info"]]))
                                                  if any("fail" not in R[p]["solveAtT_circular"][var]["info"] for p in pids) else None)}
                        for var in ("V0", "V0e", "V1", "V2")}
    B["gpsEyeHeightChange"] = {"median_dz_G50": float(np.median([abs(R[p]["b"]["G50_V2"]["G"][2] - R[p]["T"][2]) for p in pids])),
                               "G50_liftedMedian_V2": float(np.median([R[p]["b"]["G50_V2"]["lifted"] for p in pids])),
                               "T_liftedMedian_V2": float(np.median([R[p]["a"]["V2"]["lifted"] for p in pids]))}
    res["b"] = B
    # stated vs ref
    d = [float(np.linalg.norm(np.array(R[p]["T"]) - np.array(R[p]["stated"]))) for p in pids]
    res["refVsStated_m"] = {"min": min(d), "median": float(np.median(d)), "max": max(d)}
    # (c)
    c = {}
    for p in FIRST:
        if p not in R:
            continue
        cut = R[p]["a"]["V0cut"]["inl_total"]
        best = max(R[p]["a"]["V1"]["inl_total"], R[p]["a"]["V2"]["inl_total"])
        c[p] = {"V0cut_total": cut, "V0_total": R[p]["a"]["V0"]["inl_total"], "V1_total": R[p]["a"]["V1"]["inl_total"],
                "V2_total": R[p]["a"]["V2"]["inl_total"], "gainsSupport": bool(best >= 1.5 * cut and best >= cut + 20)}
    res["c"] = c
    res["VERDICT"] = "KILL" if (not a["GAIN"] or not B["PASS"]) else "PASS"
    (HERE / "results.json").write_text(json.dumps(res, indent=1))
    print(json.dumps({k: res[k] for k in ("n", "validation", "refVsStated_m", "c", "VERDICT")}, indent=1))
    print(json.dumps({k: v for k, v in a.items() if k != "perPhoto"}, indent=1))
    for k, v in B.items():
        if isinstance(v, dict) and "perPhoto" in v:
            print(k, {kk: vv for kk, vv in v.items() if kk != "perPhoto"})
        else:
            print(k, v)


if __name__ == "__main__":
    main()
