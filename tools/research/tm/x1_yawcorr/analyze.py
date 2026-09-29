"""X1 metrics. python analyze.py TAG [TAG...] [--subset odd|even|all] [--cfg main] [--json out.json]

hit@T = a hypothesis within T° (|Δyaw|+|Δpitch|) of a verified-correct ref; top-1 / any-of-top-4.
Baseline = SkyGlobal.search hyps (.sky cache, == tools/matcher/v2/out/prior_ab.json base).
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

import x1lib as X

HERE = Path(__file__).resolve().parent


def subset(pids, s):
    if s == "all":
        return pids
    par = 1 if s == "odd" else 0
    return [p for p in pids if int(p.split("_")[1]) % 2 == par]


def meta(pid):
    return X.CI.load_meta(pid)


def base_hyps(pid):
    z = np.load(HERE / ".sky" / f"{pid}.npz")
    return [h["pose"] for h in json.loads(str(z["hyps"]))]


def metr(hyps_by_pid, refs_by_pid, k=4):
    r = {"n": 0, "t1@3": 0, "t4@3": 0, "t1@1": 0, "t4@1": 0, "t1yaw@3": 0, "t4yaw@3": 0, "yawErr1": []}
    for p, hy in hyps_by_pid.items():
        R = refs_by_pid[p]
        if not R:
            continue
        r["n"] += 1
        if not hy:
            r["yawErr1"].append(180.0)
            continue
        d, dy = X.hit_dists(hy[:k], R)
        r["t1@3"] += d[0] <= 3
        r["t4@3"] += min(d) <= 3
        r["t1@1"] += d[0] <= 1
        r["t4@1"] += min(d) <= 1
        r["t1yaw@3"] += dy[0] <= 3
        r["t4yaw@3"] += min(dy) <= 3
        r["yawErr1"].append(dy[0])
    e = np.array(r["yawErr1"]) if r["yawErr1"] else np.zeros(1)
    r["yawErr1"] = {"med": round(float(np.median(e)), 2), "le5": int((e <= 5).sum()), "le10": int((e <= 10).sum()),
                    "gt30": int((e > 30).sum())}
    return r


def methods(rec, cfg):
    c = rec["cfg"][cfg]
    out = {"raw": c["raw"], "rawFine": c.get("rawFine", []), "featPol": c["featPol"]}
    if "colpool" in c:
        out["colpool"] = c["colpool"]
    for k, v in c.items():
        if k.startswith("fuse"):
            out[k] = v
    return out


def combo_methods(tag, pid, rec, cfg):
    """Integration arms built from the baseline hyps + feature outputs.
    union4+2 : baseline top-4 then feature rawFine top-2 not already covered (6 hyps, like v2's ≤6) — any-of only
    tiebreak : baseline top-4 re-ordered by the feature best-curve value at each hyp yaw (±1 cell max)"""
    c = rec["cfg"][cfg]
    b = base_hyps(pid)
    extra = [h for h in c.get("rawFine", []) if all(abs(X.dang(h["yaw"], q["yaw"])) > 2 for q in b)][:2]
    cv = curve_file(tag, pid, cfg)
    out = {"union4+2": b + extra}
    if cv is not None:
        yaw, best = cv["yaw"], np.where(np.isfinite(cv["best"]), cv["best"], -1)
        cell = yaw[1] - yaw[0]
        def fv(h):
            i = int(round(h["yaw"] / cell)) % len(yaw)
            return max(best[(i + d) % len(yaw)] for d in (-1, 0, 1))
        out["tiebreak"] = sorted(b, key=lambda h: -fv(h))
    return out


BB_OF = {}


def curve_file(tag, pid, cfg):
    bb = BB_OF.get(tag)
    if bb is None:
        return None
    f = HERE / ".curves" / f"{bb}_{pid}_{cfg}.npz"
    return np.load(f) if f.exists() else None


def ref_prefs(res, pids, cfg):
    """Pairwise: correct ref vs wrong ref in a different yaw basin (> 3° from every correct ref)."""
    agg = {"feat": [0, 0], "sky": [0, 0], "directSat": [0, 0], "directHill": [0, 0], "directMean": [0, 0]}
    rows = []
    for p in pids:
        rec = res.get(p)
        if not rec or "cfg" not in rec:
            continue
        rs = rec["cfg"][cfg]["refs"]
        C = [r for r in rs if r["verdict"] == "correct"]
        Wr = [r for r in rs if r["verdict"] == "wrong" and all(abs(X.dang(r["yaw"], c["yaw"])) > 3 for c in C)]
        dd = {d["label"]: d for d in rec.get("direct", [])}
        for c in C:
            for w in Wr:
                row = {"pid": p, "c": c["label"], "w": w["label"]}
                for key in ("feat", "sky"):
                    if c[key] is None or w[key] is None:
                        continue
                    agg[key][1] += 1
                    agg[key][0] += c[key] > w[key]
                    row[key] = c[key] > w[key]
                if c["label"] in dd and w["label"] in dd:
                    for key, f in (("directSat", lambda d: d["sat"]), ("directHill", lambda d: d["hill"]),
                                   ("directMean", lambda d: d["sat"] + d["hill"])):
                        agg[key][1] += 1
                        agg[key][0] += f(dd[c["label"]]) > f(dd[w["label"]])
                        row[key] = f(dd[c["label"]]) > f(dd[w["label"]])
                rows.append(row)
    return agg, rows


def wrong_only(res, pids, cfg):
    """Photos without a correct ref: where the feature top-1/fused top-1 points vs the wrong refs."""
    out = {}
    for p in pids:
        rec = res.get(p)
        m = meta(p)
        if not rec or "cfg" not in rec or m["correct_refs"]:
            continue
        c = rec["cfg"][cfg]
        W = m["wrong_refs"]
        def near(h):
            return min((abs(X.dang(h["yaw"], w["pose"]["yaw"])) + abs(h["pitch"] - w["pose"]["pitch"]), w["label"]) for w in W) if W else None
        out[p] = {"raw1": [round(c["raw"][0]["yaw"], 1), round(c["raw"][0]["pitch"], 1)] if c["raw"] else None,
                  "raw1NearestWrong": near(c["raw"][0]) if c["raw"] else None,
                  "rawAnyWrongWithin3": any(near(h)[0] <= 3 for h in c["raw"]) if W else None,
                  "base1": [round(base_hyps(p)[0]["yaw"], 1), round(base_hyps(p)[0]["pitch"], 1)],
                  "base1NearestWrong": near(base_hyps(p)[0]) if W else None,
                  "wrongFeatRank": {r["label"]: r["featRank"] for r in c["refs"]},
                  "wrongFeatZ": {r["label"]: None if r["featZ"] is None else round(r["featZ"], 2) for r in c["refs"]}}
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("tags", nargs="+")
    ap.add_argument("--subset", default="all")
    ap.add_argument("--cfg", default=None)
    ap.add_argument("--json", default=None)
    ap.add_argument("--quiet", action="store_true")
    ap.add_argument("--wrong", action="store_true")
    ap.add_argument("--perphoto", default=None, help="comma list of methods for a per-photo min-dist table")
    a = ap.parse_args()
    summary = {}
    for tag in a.tags:
        res = json.load(open(HERE / "results" / f"{tag}.json"))
        BB_OF[tag] = res.get("_backbone") or (tag[2:] + "_last" if tag.startswith("d_") else None)
        pids = subset(sorted(p for p in res if isinstance(res[p], dict) and "cfg" in res[p]), a.subset)
        refs = {p: meta(p)["correct_refs"] for p in pids}
        withref = [p for p in pids if refs[p]]
        b = metr({p: base_hyps(p) for p in withref}, refs)
        print(f"== {tag}  subset={a.subset}  photos={len(pids)} withCorrectRef={len(withref)}")
        print(f"{'method':32s} n  t1@3 t4@3 t1@1 t4@1 yaw3:t1 t4  medYawErr1  <=5 <=10 >30")
        def line(name, r):
            print(f"{name:32s} {r['n']:2d} {r['t1@3']:4d} {r['t4@3']:4d} {r['t1@1']:4d} {r['t4@1']:4d} {r['t1yaw@3']:7d} {r['t4yaw@3']:2d}"
                  f"  {r['yawErr1']['med']:9.2f} {r['yawErr1']['le5']:4d} {r['yawErr1']['le10']:4d} {r['yawErr1']['gt30']:3d}")
        line("baseline skyline (SG.search)", b)
        cfgs = [a.cfg] if a.cfg else list(res[pids[0]]["cfg"])
        summary[tag] = {"baseline": b, "cfg": {}}
        for cf in cfgs:
            ms = {}
            for p in withref:
                for k, v in methods(res[p], cf).items():
                    ms.setdefault(k, {})[p] = v
                for k, v in combo_methods(tag, p, res[p], cf).items():
                    ms.setdefault(k, {})[p] = v
            summary[tag]["cfg"][cf] = {}
            for k, hy in ms.items():
                r = metr(hy, refs, 6 if k == "union4+2" else 4)
                summary[tag]["cfg"][cf][k] = r
                if not a.quiet or k in ("raw", "colpool", "rawFine", "featPol", "fuse1.0_curve", "fuse1.0_sky", "fuseFine1.0", "union4+2", "tiebreak"):
                    line(f"{cf}/{k}", r)
            if a.perphoto:
                mm = a.perphoto.split(",")
                print("   per photo: min(|dyaw|+|dpitch|) over top-4 / top-1 ->", mm)
                for p in withref:
                    cells = []
                    for k in ["base"] + mm:
                        hy = [h for h in base_hyps(p)] if k == "base" else ms[k][p]
                        d, _ = X.hit_dists(hy[:4], refs[p]) if hy else ([999], None)
                        cells.append(f"{min(d):6.1f}/{d[0]:6.1f}")
                    print(f"   {p} fk={int(meta(p)['focal_known'])} " + "  ".join(cells))
            agg, _ = ref_prefs(res, pids, cf)
            summary[tag]["cfg"][cf]["refPref"] = agg
            print(f"   {cf} correct>wrong(other basin) pairs:", {k: f"{v[0]}/{v[1]}" for k, v in agg.items()})
            wo = wrong_only(res, pids, cf)
            summary[tag]["cfg"][cf]["noCorrectRef"] = wo
            if a.wrong:
                print(f"   {cf} photos without a correct ref (feature raw top-1 vs wrong refs; baseline top-1):")
                for p, r in wo.items():
                    print(f"     {p} feat1={r['raw1']} nearestWrong={r['raw1NearestWrong']} anyOf4NearWrong={r['rawAnyWrongWithin3']}"
                          f" | base1={r['base1']} nearestWrong={r['base1NearestWrong']} | wrongRefFeatRank={r['wrongFeatRank']}")
                n1 = sum(1 for r in wo.values() if r["raw1NearestWrong"] and r["raw1NearestWrong"][0] <= 3)
                nb = sum(1 for r in wo.values() if r["base1NearestWrong"] and r["base1NearestWrong"][0] <= 3)
                print(f"     top-1 within 3° of a known-wrong ref: feature {n1}/{len(wo)}, baseline {nb}/{len(wo)}")
            t = [res[p]["cfg"][cf]["scoreMs"] for p in pids]
            print(f"   {cf} scoreMs median {np.median(t):.0f}")
        tt = {k: float(np.median([res[p]["t"][k] for p in pids])) for k in ("ringFwdMs", "photoFwdMs", "totalMs", "loadMs")}
        print("   timings (median ms):", tt)
        summary[tag]["t"] = tt
    if a.json:
        json.dump(summary, open(a.json, "w"), indent=1)
