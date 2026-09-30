"""E0 evaluation per PROTOCOL.txt: AUROCs + bootstrap CIs from features.json -> results.json, table.txt."""
from __future__ import annotations
import json, math
from pathlib import Path
import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
F = json.load(open(HERE / "features.json"))
TAX = json.load(open(ROOT / "tools/research/tm/f1_autopsy/taxonomy.json"))["photos"]
FLOORS = [0.05, 0.10, 0.20, 0.30, 0.50]
rng = np.random.default_rng(0)


def label(pid):
    t = TAX.get(pid)
    if not t:
        return "SUCCESS"
    s = t["stage"]
    return "ROT" if s in ("search", "matching", "refine") else "POS" if s == "position" else "OTHER"


def posc(pid):
    t = TAX.get(pid)
    return bool(t) and t["causes"][0] in ("a_small", "a_big")


def wstar(row, floor, widths):
    if row is None or all(r is None for r in row):
        return math.nan
    for w, r in zip(widths, row):
        if r is None:
            continue
        if r == float("inf") or r > floor:
            return float(w)
    return 360.0


def auc(pos, neg):
    pos, neg = np.asarray(pos, float), np.asarray(neg, float)
    pos, neg = pos[np.isfinite(pos)], neg[np.isfinite(neg)]
    if len(pos) == 0 or len(neg) == 0:
        return math.nan, 0, 0
    g = (pos[:, None] > neg[None, :]).mean() + 0.5 * (pos[:, None] == neg[None, :]).mean()
    return float(g), len(pos), len(neg)


def auc_ci(pos, neg, nb=4000):
    pos, neg = np.asarray(pos, float), np.asarray(neg, float)
    pos, neg = pos[np.isfinite(pos)], neg[np.isfinite(neg)]
    a, npos, nneg = auc(pos, neg)
    if not npos or not nneg:
        return dict(auc=None, n_pos=npos, n_neg=nneg)
    bs = [auc(rng.choice(pos, npos), rng.choice(neg, nneg))[0] for _ in range(nb)]
    allv = np.concatenate([pos, neg]); ge = 0
    for _ in range(10000):
        p = rng.permutation(allv)
        ge += auc(p[:npos], p[npos:])[0] >= a - 1e-12
    return dict(auc=round(a, 3), ci95=[round(float(np.percentile(bs, 2.5)), 3), round(float(np.percentile(bs, 97.5)), 3)],
                p_perm=round((ge + 1) / 10001, 4), n_pos=npos, n_neg=nneg)


def feats(pid, analysis, floor=0.10):
    r = F[pid]; W = r["widths"]
    if analysis == "A":
        ws = [wstar(row, floor, W) for row in r["minres_A"]]
        ws = [w for w in ws if np.isfinite(w)]
        wmed = float(np.median(ws)) if ws else math.nan
        d = r["A"]
    elif analysis == "B":
        d = r.get("B_heading")
        if not d:
            return None
        wmed = wstar(d["minres"], floor, W)
    elif analysis == "C":
        d = r.get("C")
        if not d:
            return None
        wmed = wstar(d["minres"], floor, W)
    elif analysis == "D":
        return feats(pid, "C", floor) or feats(pid, "B", floor) or feats(pid, "A", floor)
    R = r["hfov0"] / wmed if np.isfinite(wmed) else math.nan
    return dict(wstar=wmed, R=R, I_tot=d["I_tot"], I_no250=d["I_no250"], f250=d["f250"],
                crb_h_match=d["crb_h_match"], crb_h_all=d["crb_h_all"], crb_up_match=d["crb_up_match"],
                bands={k: d[k] for k in ("lt250", "m250_2k", "m2k_10k", "gt10k")})


SCORES = {  # oriented: higher = predicted failure
    "-R": lambda f: -f["R"],
    "-I_no250": lambda f: -f["I_no250"],
    "-I_tot": lambda f: -f["I_tot"],
    "+f250": lambda f: f["f250"],
    "+crb_h_match": lambda f: f["crb_h_match"],
}


def run(analysis, floor=0.10, scores=SCORES):
    ids = sorted(F)
    lab = {p: label(p) for p in ids}
    ft = {p: feats(p, analysis, floor) for p in ids}
    ids = [p for p in ids if ft[p]]
    out = {"n": {g: sum(lab[p] == g for p in ids) for g in ("SUCCESS", "ROT", "POS", "OTHER")}}
    comps = {
        "ROT_vs_SUCCESS": (lambda p: lab[p] == "ROT", lambda p: lab[p] == "SUCCESS"),
        "POS_vs_SUCCESS": (lambda p: lab[p] == "POS", lambda p: lab[p] == "SUCCESS"),
        "ANYFAIL_vs_SUCCESS": (lambda p: lab[p] != "SUCCESS", lambda p: lab[p] == "SUCCESS"),
        "ROT_vs_rest": (lambda p: lab[p] == "ROT", lambda p: lab[p] != "ROT"),
        "POS_vs_rest": (lambda p: lab[p] == "POS", lambda p: lab[p] != "POS"),
        "POSc_vs_SUCCESS": (posc, lambda p: lab[p] == "SUCCESS"),
    }
    for cn, (fp, fn) in comps.items():
        for sn, sf in scores.items():
            out[f"{cn}|{sn}"] = auc_ci([sf(ft[p]) for p in ids if fp(p)], [sf(ft[p]) for p in ids if fn(p)])
    return out, ft


def med(v):
    v = [x for x in v if x is not None and np.isfinite(x)]
    return round(float(np.median(v)), 4) if v else None


def main():
    res = {"protocol": "PROTOCOL.txt (frozen 2026-09-29T23:06Z)", "analyses": {}}
    per = {}
    for an in ("A", "B", "C", "D"):
        o, ft = run(an)
        res["analyses"][an] = o
        per[an] = ft
    # floor sweep (rotation only, A and C)
    sweep = {}
    for an in ("A", "C"):
        for fl in FLOORS:
            o, ft = run(an, fl, {"-R": SCORES["-R"]})
            sweep[f"{an}|{fl}"] = {k: v for k, v in o.items() if k.startswith(("ROT_vs_SUCCESS", "ANYFAIL"))}
            sweep[f"{an}|{fl}"]["median_wstar"] = {g: med([ft[p]["wstar"] for p in ft if ft[p] and label(p) == g])
                                                   for g in ("SUCCESS", "ROT", "POS", "OTHER")}
    res["floor_sweep"] = sweep
    # group medians
    gm = {}
    for an in ("A", "C"):
        for k in ("wstar", "R", "I_tot", "I_no250", "f250", "crb_h_match", "crb_h_all", "crb_up_match"):
            gm[f"{an}|{k}"] = {g: med([per[an][p][k] for p in per[an] if per[an][p] and label(p) == g])
                               for g in ("SUCCESS", "ROT", "POS", "OTHER")}
        for b in ("lt250", "m250_2k", "m2k_10k", "gt10k"):
            gm[f"{an}|share_{b}"] = {g: med([per[an][p]["bands"][b] / per[an][p]["I_tot"] for p in per[an]
                                             if per[an][p] and label(p) == g and per[an][p]["I_tot"] > 0])
                                     for g in ("SUCCESS", "ROT", "POS", "OTHER")}
            gm[f"{an}|share_no250_{b}"] = {g: med([per[an][p]["bands"][b] / per[an][p]["I_no250"] for p in per[an]
                                                   if per[an][p] and label(p) == g and per[an][p]["I_no250"] > 0])
                                           for g in ("SUCCESS", "ROT", "POS", "OTHER")} if b != "lt250" else None
    res["group_medians"] = gm
    # ring-vs-ref sanity (Spearman on ref holders)
    from scipy.stats import spearmanr
    xs, ys, zs, qs = [], [], [], []
    for p, r in F.items():
        if r.get("C") and r.get("ring_at_ref"):
            xs.append(r["ring_at_ref"]["I_no250"]); ys.append(r["C"]["I_no250"])
            zs.append(r["ring_at_ref"]["I_no250"]); qs.append(r["A"]["I_no250"])
    res["sanity"] = {"spearman_I_no250_ringAtRefYaw_vs_refView": round(float(spearmanr(xs, ys)[0]), 3),
                     "spearman_I_no250_ringAtRefYaw_vs_A": round(float(spearmanr(zs, qs)[0]), 3), "n": len(xs)}
    A = res["analyses"]["A"]
    ar, ap = A["ROT_vs_SUCCESS|-R"]["auc"], A["POS_vs_SUCCESS|-I_no250"]["auc"]
    res["kill"] = {"AUROC_rot_primary": ar, "AUROC_pos_primary": ap,
                   "verdict": "KILL" if (ar < 0.65 and ap < 0.65) else
                   ("SURVIVES (both)" if ar >= 0.65 and ap >= 0.65 else
                    "PARTIAL: rotation half survives" if ar >= 0.65 else "PARTIAL: position half survives")}
    rows = []
    for p in sorted(F):
        a = per["A"][p]; c = per["C"].get(p); b = per["B"].get(p)
        rows.append(dict(pid=p, label=label(p), posc=posc(p), hfov0=round(F[p]["hfov0"], 1),
                         sky_invalid=round(F[p]["sky_invalid_frac"], 2),
                         A_wstar=a["wstar"], A_R=round(a["R"], 2) if np.isfinite(a["R"]) else None,
                         A_I_no250=round(a["I_no250"], 4), A_f250=round(a["f250"], 4), A_crb_h=round(a["crb_h_match"], 2),
                         B_wstar=b and b["wstar"], B_I_no250=b and round(b["I_no250"], 4),
                         C_wstar=c and c["wstar"], C_I_no250=c and round(c["I_no250"], 4),
                         C_f250=c and round(c["f250"], 4), C_crb_h=c and round(c["crb_h_match"], 2),
                         C_crb_h_all=c and round(c["crb_h_all"], 3)))
    res["per_photo"] = rows
    json.dump(res, open(HERE / "results.json", "w"), indent=1)
    with open(HERE / "table.txt", "w") as fh:
        keys = list(rows[0])
        fh.write("\t".join(keys) + "\n")
        for r in sorted(rows, key=lambda r: (r["label"], r["pid"])):
            fh.write("\t".join(str(r[k]) for k in keys) + "\n")
    print(json.dumps(res["kill"]))
    for an in ("A", "B", "C", "D"):
        print("==", an, res["analyses"][an]["n"])
        for k, v in res["analyses"][an].items():
            if k != "n":
                print(f"  {k:40s} {v}")
    print(json.dumps(res["group_medians"], indent=0)[:6000])
    print(res["sanity"])
    for k, v in sweep.items():
        print(k, {kk: (vv.get("auc") if isinstance(vv, dict) and "auc" in vv else vv) for kk, vv in v.items()})


if __name__ == "__main__":
    main()
