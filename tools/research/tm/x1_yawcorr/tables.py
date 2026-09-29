"""X1: build results/x1_results.json + markdown tables for REPORT.md from the per-run result files.
    python tables.py > tables.md"""
from __future__ import annotations
import json
from pathlib import Path
import numpy as np
import analyze as A
import x1lib as X

HERE = Path(__file__).resolve().parent
TH = (3, 1)


def load(tag):
    f = HERE / "results" / f"{tag}.json"
    return json.load(open(f)) if f.exists() else None


def arms(res, p, cfg="main"):
    c = res[p]["cfg"][cfg]
    b = A.base_hyps(p)
    rf = c.get("rawFine", [])
    return {
        "baseline skyline top-4 (SG.search)": (b, 4),
        "feature raw (grid peaks)": (c["raw"], 4),
        "feature + local pitch/roll refine": (rf, 4),
        "feature peaks + skyline polish": (c["featPol"], 4),
        "column-pooled 1-D feature": (c.get("colpool", []), 4),
        "fused z(feat)+z(sky), skyline polish": (c["fuse1.0_curve"], 4),
        "fused, re-sorted by skyline score": (c["fuse1.0_sky"], 4),
        "baseline re-ranked by feature (tiebreak)": (A.combo_methods(TAG, p, res[p], cfg)["tiebreak"], 4),
        "baseline top-2 + feature top-2 [post hoc]": (b[:2] + rf[:2], 4),
        "baseline top-4 + feature top-2 (6 hyps)": (A.combo_methods(TAG, p, res[p], cfg)["union4+2"], 6),
        "baseline top-4 + feature top-4 (8 hyps)": (b[:4] + rf[:4], 8),
    }


def score(res, pids, cfg="main"):
    out = {}
    for p in pids:
        R = A.meta(p)["correct_refs"]
        for name, (hy, k) in arms(res, p, cfg).items():
            o = out.setdefault(name, {"n": 0, "t1@3": 0, "tk@3": 0, "t1@1": 0, "tk@1": 0, "yawErr1": [], "k": k, "hitIds": []})
            o["n"] += 1
            if not hy:
                o["yawErr1"].append(180.0)
                continue
            d, dy = X.hit_dists(hy[:k], R)
            o["t1@3"] += d[0] <= 3
            o["tk@3"] += min(d) <= 3
            o["t1@1"] += d[0] <= 1
            o["tk@1"] += min(d) <= 1
            o["yawErr1"].append(dy[0])
            if min(d) <= 3:
                o["hitIds"].append(p)
    for o in out.values():
        e = np.array(o["yawErr1"])
        o["yawErr1"] = {"p25": round(float(np.percentile(e, 25)), 2), "med": round(float(np.median(e)), 2),
                        "p75": round(float(np.percentile(e, 75)), 2), "le1": int((e <= 1).sum()), "le3": int((e <= 3).sum()),
                        "gt30": int((e > 30).sum())}
    return out


def md(out, title):
    print(f"\n**{title}**\n")
    print("| arm | n | top-1 @3° | any-of-k @3° | top-1 @1° | any-of-k @1° | k | top-1 |Δyaw| p25/med/p75 | top-1 |Δyaw| > 30° |")
    print("|---|---|---|---|---|---|---|---|---|")
    for name, o in out.items():
        y = o["yawErr1"]
        print(f"| {name} | {o['n']} | {o['t1@3']} | {o['tk@3']} | {o['t1@1']} | {o['tk@1']} | {o['k']} | {y['p25']}/{y['med']}/{y['p75']} | {y['gt30']} |")


if __name__ == "__main__":
    J = {}
    for TAG in ("final_v2Breg", "final_v2S"):
        res = load(TAG)
        if not res:
            continue
        A.BB_OF[TAG] = res.get("_backbone")
        allp = sorted(p for p in res if p.startswith("wc") and "cfg" in res[p] and A.meta(p)["correct_refs"])
        J[TAG] = {}
        for sub in ("odd", "even", "all"):
            ps = A.subset(allp, sub)
            o = score(res, ps)
            J[TAG][sub] = o
            md(o, f"{TAG} — {sub} DEV photos with a correct ref ({'design subset' if sub == 'odd' else 'held-out' if sub == 'even' else 'all'})")
        for cfg in ("sat", "hill", "ring45"):
            o = score(res, allp, cfg)
            J[TAG]["all_" + cfg] = {k: o[k] for k in ("feature raw (grid peaks)", "feature + local pitch/roll refine",
                                                     "fused z(feat)+z(sky), skyline polish", "baseline top-2 + feature top-2 [post hoc]")}
            md(J[TAG]["all_" + cfg], f"{TAG} cfg={cfg} (all 30)")
        agg, rows = A.ref_prefs(res, [p for p in res if p.startswith("wc")], "main")
        J[TAG]["refPref"] = {"agg": agg, "rows": rows}
        J[TAG]["noCorrectRef"] = A.wrong_only(res, [p for p in res if p.startswith("wc")], "main")
        print(f"\n{TAG} correct-vs-wrong(other basin) ref preference:", {k: f"{v[0]}/{v[1]}" for k, v in agg.items()})
        t = {k: float(np.median([res[p]["t"][k] for p in res if p.startswith("wc")])) for k in ("ringFwdMs", "photoFwdMs", "totalMs")}
        J[TAG]["t"] = t
    # design phase (odd only): backbones
    print("\n**Design phase (odd ids, 14 photos with a correct ref): backbone sweep, cfg main (sat+hill, terrain-masked, PCA-64)**\n")
    print("| backbone | photos | raw top-1/any4 @3° | +local refine top-1/any4 @3° | @1° top-1 (refined) | fused top-1/any4 @3° | base2+feat2 @3° | colpool top-1 @3° |")
    print("|---|---|---|---|---|---|---|---|")
    J["design"] = {}
    for bbn in ("dinov2_vits14", "dinov2_vitb14", "dinov2_vitb14_reg", "dinov3_vits16", "dinov3_vitb16", "dinov2_vitl14"):
        TAG = "d_" + bbn
        res = load(TAG)
        if not res:
            continue
        A.BB_OF[TAG] = res.get("_backbone") or bbn + "_last"
        ps = A.subset(sorted(p for p in res if p.startswith("wc") and "cfg" in res[p] and A.meta(p)["correct_refs"]), "odd")
        if len(ps) < 14:
            print(f"| {bbn} | incomplete ({len(ps)}) | | | | | | |")
            continue
        o = score(res, ps)
        J["design"][bbn] = o
        g = lambda k: o[k]
        cp = g("column-pooled 1-D feature")
        print(f"| {bbn} | {len(ps)} | {g('feature raw (grid peaks)')['t1@3']}/{g('feature raw (grid peaks)')['tk@3']} | "
              f"{g('feature + local pitch/roll refine')['t1@3']}/{g('feature + local pitch/roll refine')['tk@3']} | "
              f"{g('feature + local pitch/roll refine')['t1@1']} | "
              f"{g('fused z(feat)+z(sky), skyline polish')['t1@3']}/{g('fused z(feat)+z(sky), skyline polish')['tk@3']} | "
              f"{g('baseline top-2 + feature top-2 [post hoc]')['tk@3']} | {cp['t1@3'] if cp['n'] and TAG not in ('d_dinov2_vitb14_reg', 'd_dinov3_vitb16') else 'n/a'} |")
    TAG = "final_v2Breg"
    A.BB_OF[TAG] = load(TAG).get("_backbone")
    base = score(load("final_v2Breg"), A.subset(sorted(p for p in load("final_v2Breg") if p.startswith("wc") and A.meta(p)["correct_refs"]), "odd"))
    b = base["baseline skyline top-4 (SG.search)"]
    print(f"| (baseline skyline) | 14 | {b['t1@3']}/{b['tk@3']} | | {b['t1@1']} | | | |")
    # ablation (odd, dinov2_vitb14_reg)
    res = load("abl_v2Breg")
    if res:
        TAG = "abl_v2Breg"
        A.BB_OF[TAG] = res.get("_backbone")
        ps = A.subset(sorted(p for p in res if p.startswith("wc") and "cfg" in res[p] and A.meta(p)["correct_refs"]), "odd")
        print(f"\n**Ablation (odd ids, {len(ps)} photos with a correct ref, DINOv2-B/14-reg)**\n")
        print("| cfg | raw top-1/any4 @3° | refined top-1 @1° | fused top-1/any4 @3° | base2+feat2 @3° |")
        print("|---|---|---|---|---|")
        J["ablation"] = {}
        for cfg in res[ps[0]]["cfg"]:
            o = score(res, ps, cfg)
            J["ablation"][cfg] = o
            r, f, rf = o["feature raw (grid peaks)"], o["fused z(feat)+z(sky), skyline polish"], o["feature + local pitch/roll refine"]
            print(f"| {cfg} | {r['t1@3']}/{r['tk@3']} | {rf['t1@1']} | {f['t1@3']}/{f['tk@3']} | {o['baseline top-2 + feature top-2 [post hoc]']['tk@3']} |")
    for f in sorted((HERE / "results").glob("timing_*.json")):
        d = json.load(open(f))
        J.setdefault("timing", {})[f.stem] = {"perPhoto": d, "median": {k: float(np.median([v[k] for v in d.values()])) for k in
                                                                           ("ringFwdMs", "photoFwdMs", "panoMs", "gridMs", "totalMs")}}
        print(f.stem, J["timing"][f.stem]["median"])
    json.dump(J, open(HERE / "results" / "x1_results.json", "w"), indent=1, default=float)
