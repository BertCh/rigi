"""POST HOC summaries (labelled in REPORT.txt), merged into results.json under "posthoc" after analyse.py has run.
- G50h (height-kept 50 m displacement, e3_posthoc.py): fraction better than GPS, V1/V2, 3/2-DoF.
- Failure anatomy of the frozen primary (G50 V2 3-DoF): scene has no far5 content even at T (rotation step can never
  run) vs displaced render lost the matches (lifted at G50 << lifted at T) vs centre step failed.
- (a) restricted to photos that have any 0-2 km inlier with any variant (the rest contribute g = 0 by construction).
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
rng = np.random.default_rng(0)


def boot(x, stat=np.mean, nb=10000):
    x = np.asarray(x, float)
    if len(x) == 0:
        return None
    idx = rng.integers(0, len(x), size=(nb, len(x)))
    return [float(stat(x)), float(np.percentile([stat(x[i]) for i in idx], 2.5)),
            float(np.percentile([stat(x[i]) for i in idx], 97.5))]


def main():
    R = {p.stem: json.load(open(p)) for p in sorted((HERE / "out").glob("wc_*.json"))}
    P = {p.stem: json.load(open(p)) for p in sorted((HERE / "out_posthoc").glob("wc_*.json"))}
    pids = sorted(R)
    res = json.load(open(HERE / "results.json"))
    ph = {"label": "POST HOC - not used for the verdict"}
    # G50h
    g = {}
    pp = [p for p in pids if p in P]
    for var in ("V1", "V2"):
        for dof in ("3dof", "2dof"):
            rows = [P[p][f"G50h_{var}"] for p in pp]
            better = np.array([r[dof]["better"] for r in rows], float)
            fails = [r[dof]["info"].get("fail") for r in rows]
            g[f"G50h_{var}_{dof}"] = {
                "n": len(rows), "nBetter": int(better.sum()), "fracBetter": boot(better),
                "nSolved": int(sum(f is None for f in fails)),
                "failReasons": {k: fails.count(k) for k in set(fails) if k},
                "perPhoto": {p: {"gps": round(r["eGps3d"], 1), "est": round(r[dof]["err3d"], 1),
                                 "lifted": r["lifted"], "fail": r[dof]["info"].get("fail")} for p, r in zip(pp, rows)},
            }
    ph["G50h"] = g
    # failure anatomy of the primary
    anat = {}
    for p in pids:
        b = R[p]["b"]["G50_V2"]
        info = b["3dof"]["info"]
        far5T = R[p]["solveAtT_circular"]["V0"]["info"].get("nFar5", 0)
        liftT = R[p]["a"]["V2"]["lifted"]
        if info.get("fail") is None:
            cls = "solved-better" if b["3dof"]["better"] else "solved-worse"
        elif far5T < 6:
            cls = "no-far5-even-at-T"
        elif b["lifted"] < 0.2 * max(liftT, 1):
            cls = "displaced-render-lost-matches"
        else:
            cls = "other-" + info["fail"]
        anat[p] = {"class": cls, "far5_atT_V0": far5T, "lifted_T_V2": liftT, "lifted_G50_V2": b["lifted"],
                   "dz_G50": round(b["G"][2] - R[p]["T"][2], 1), "fail": info.get("fail"),
                   "err": round(b["3dof"]["err3d"], 1), "gps": round(b["eGps3d"], 1)}
    cnt = {}
    for v in anat.values():
        cnt[v["class"]] = cnt.get(v["class"], 0) + 1
    ph["primaryFailureAnatomy"] = {"counts": cnt, "perPhoto": anat}
    # (a) among photos with any 0-2 km inlier
    sel = [p for p in pids if any(R[p]["a"][v]["inl_near"] + R[p]["a"][v]["inl_mid"] > 0 for v in ("V0", "V1", "V2"))]
    aa = {"n": len(sel), "pids": sel}
    for var in ("V1", "V2"):
        n0 = np.array([R[p]["a"]["V0"]["inl_near"] + R[p]["a"]["V0"]["inl_mid"] for p in sel])
        nv = np.array([R[p]["a"][var]["inl_near"] + R[p]["a"][var]["inl_mid"] for p in sel])
        aa[f"{var}_log2gain"] = boot(np.log2((1 + nv) / (1 + n0)))
        aa[f"{var}_nPhotosUp"] = int((nv > n0).sum())
        aa[f"{var}_nPhotosDown"] = int((nv < n0).sum())
        aa[f"{var}_near_inl_sum"] = int(sum(R[p]["a"][var]["inl_near"] for p in sel))
    aa["V0_near_inl_sum"] = int(sum(R[p]["a"]["V0"]["inl_near"] for p in sel))
    ph["a_photosWithAny0-2kmInlier"] = aa
    # convergence: independent starts (G20/G50/G150 V2 3-DoF, G50h V2 3-DoF) that solved -> spread of estimates
    conv = {}
    for p in pids:
        E = {}
        for k in ("G20_V2", "G50_V2", "G150_V2"):
            s = R[p]["b"][k]["3dof"]
            if s["info"].get("fail") is None:
                E[k] = s["E"]
        if p in P and P[p]["G50h_V2"]["3dof"]["info"].get("fail") is None:
            E["G50h_V2"] = P[p]["G50h_V2"]["3dof"]["E"]
        if len(E) >= 2:
            X = np.array(list(E.values()))
            c = X.mean(0)
            conv[p] = {"starts": list(E), "maxDevFromMean_m": round(float(np.linalg.norm(X - c, axis=1).max()), 1),
                       "meanE_minus_T": np.round(c - np.array(R[p]["T"]), 1).tolist(),
                       "meanE_dist_to_T_m": round(float(np.linalg.norm(c - np.array(R[p]["T"]))), 1),
                       "T_agl_m": round(R[p]["T"][2] - R[p]["dtmAtT"], 1)}
    ph["convergenceAcrossStarts"] = conv
    res["posthoc"] = ph
    (HERE / "results.json").write_text(json.dumps(res, indent=1))
    print(json.dumps({k: {kk: vv for kk, vv in v.items() if kk != "perPhoto"} for k, v in g.items()}, indent=1))
    print(json.dumps(cnt), json.dumps(aa, indent=1))


if __name__ == "__main__":
    main()
