"""X4 analysis: hits, phase flips, runtime, abstain-signal AUROC. Subsets odd / even / all (odd = design set).
    analyze.py [odd|even|all] [--json OUT]"""
from __future__ import annotations
import json, sys
from pathlib import Path
import numpy as np
import x4lib as L

D = L.HERE / "results" / "per_photo"
METHODS = ["base", "cf_arg_raw", "cf_arg_pol", "cf_top_raw", "cf_top_pol", "bnb"]


def odd(pid):
    return int(pid[3:]) % 2 == 1


def load(subset):
    rows = {}
    for f in sorted(D.glob("*.json")):
        r = json.load(open(f))
        if "strips" not in r:
            continue
        pid = r["pid"]
        if subset == "odd" and not odd(pid) or subset == "even" and odd(pid):
            continue
        rows[pid] = r
    return rows


PRE = False  # True: use the coarse peaks (pre-refine, ranked by the coarse objective) instead of the final hyps


def poses(run, shift=0.0):
    if PRE:  # peaks of yaw-shifted runs are stored in the rotated frame
        return [{**{k: p[k] for k in ("pitch", "roll", "vfov")}, "yaw": (p["yaw"] + shift) % 360} for p in run["peaks"][:4]]
    return [h["pose"] for h in run["hyps"]]


def pdist(a, b):
    return abs(float(L.dang(a["yaw"], b["yaw"]))) + abs(a["pitch"] - b["pitch"])


def sh(r, phase):
    return r["ystep"] / 2 if phase in ("yaw", "all") else 0.0


def hits(rows, meth, phase="phase0"):
    out = {}
    for pid, r in rows.items():
        if meth not in r or phase not in r[meth]:
            continue
        d = L.ref_dists(poses(r[meth][phase], sh(r, phase)), pid)
        if d is None:
            continue
        out[pid] = {"t1_3": bool(d) and d[0] <= 3, "t4_3": bool(d) and min(d[:4]) <= 3, "t1_1": bool(d) and d[0] <= 1,
                    "t4_1": bool(d) and min(d[:4]) <= 1, "d": d}
    return out


def flips(rows, meth, phase):
    h0, h1 = hits(rows, meth), hits(rows, meth, phase)
    common = [p for p in h0 if p in h1]
    f4 = [p for p in common if h0[p]["t4_3"] != h1[p]["t4_3"]]
    f1 = [p for p in common if h0[p]["t1_3"] != h1[p]["t1_3"]]
    id1, set4 = [], []
    for pid, r in rows.items():
        if meth not in r or phase not in r[meth]:
            continue
        a, b = poses(r[meth]["phase0"]), poses(r[meth][phase], sh(r, phase))
        if not a or not b:
            continue
        if pdist(a[0], b[0]) > 3:
            id1.append(pid)
        if any(min(pdist(x, y) for y in b) > 3 for x in a) or any(min(pdist(x, y) for y in a) > 3 for x in b):
            set4.append(pid)
    return {"hit4_flips": f4, "hit1_flips": f1, "top1_moves": id1, "top4_set_changes": set4, "n": len(rows)}


def strip_signal(r, meth, S, eps, kind):
    vf = r["stripVf"].get(meth)
    if vf is None:
        return None
    rows = r["strips"][vf][str(S)]
    k = "in1" if eps == 1 else "in2"
    if kind == "agree":
        return sum(1 for s in rows if s[meth][k] >= s["fmax"] - 1e-12)
    m = [s[meth][k] - s[meth]["out3"] for s in rows]
    return float(np.mean(m)) if kind == "mean" else float(np.median(m))


def signals(r, meth):
    run = r[meth]["phase0"]
    hy = run["hyps"]
    s = {}
    s["fine_gap12"] = hy[0]["score"] - hy[1]["score"] if len(hy) > 1 else 1.0
    g = run["gaps"]
    s["coarse_gap3"] = g["gap3"]
    s["coarse_gapN"] = g["gapN"] if g.get("gapN") is not None else np.nan
    s["coarse_gap3_rel"] = g["gap3"] / max(g["bstar"], 1e-9)
    if meth == "bnb":
        b = run["bnb"]
        s["cert_gap3"] = b["gap3_cert"]
        s["cert_gapN"] = b.get("gapN_cert", np.nan)
    for S in (3, 4, 5):
        for eps in (1, 2):
            for kind in ("agree", "mean"):
                s[f"strip{S}_e{eps}_{kind}"] = strip_signal(r, meth, S, eps, kind)
    return s


def auroc_table(rows, meth):
    H = hits(rows, meth)
    pids = sorted(H)
    lab = [H[p]["t1_3"] for p in pids]
    sig = {p: signals(rows[p], meth) for p in pids}
    out = {}
    for k in sig[pids[0]]:
        v = [sig[p][k] for p in pids]
        if any(x is None for x in v):
            continue
        out[k] = L.auroc(v, lab)
    return out, sum(lab), len(lab), sig


def main():
    global PRE
    PRE = "--pre" in sys.argv
    subset = sys.argv[1] if len(sys.argv) > 1 else "all"
    rows = load(subset)
    print("PRE-REFINE coarse peaks" if PRE else "final hyps")
    print(f"subset={subset} photos={len(rows)} with refs={sum(1 for p in rows if L.REFS.correct_refs(p))}")
    summ = {"subset": subset, "n": len(rows)}
    print("\n| method | top1@3 | top4@3 | top1@1 | top4@1 | median ms | mean ms |")
    print("|---|---|---|---|---|---|---|")
    for m in METHODS:
        H = hits(rows, m)
        ms = [r[m]["phase0"]["ms"] for r in rows.values() if m in r]
        t = {k: sum(h[k] for h in H.values()) for k in ("t1_3", "t4_3", "t1_1", "t4_1")}
        summ.setdefault("hits", {})[m] = {**t, "nref": len(H), "median_ms": float(np.median(ms)), "mean_ms": float(np.mean(ms))}
        print(f"| {m} | {t['t1_3']}/{len(H)} | {t['t4_3']}/{len(H)} | {t['t1_1']}/{len(H)} | {t['t4_1']}/{len(H)} | {np.median(ms):.0f} | {np.mean(ms):.0f} |")
    print("\nphase-shift flips (half-step): hit4 flips / hit1 flips (ref photos), top-1 moves >3° / top-4 set changes (all photos)")
    print("| method | shift | hit4 flips | hit1 flips | top1 moves | top4 set changes | shifted top4@3 |")
    print("|---|---|---|---|---|---|---|")
    for m in METHODS:
        for ph in ("pitch", "roll", "yaw", "all"):
            if not any(ph in r.get(m, {}) for r in rows.values()):
                continue
            f = flips(rows, m, ph)
            H1 = hits(rows, m, ph)
            summ.setdefault("flips", {}).setdefault(m, {})[ph] = {**f, "t4_3_shifted": sum(h["t4_3"] for h in H1.values())}
            print(f"| {m} | {ph} | {len(f['hit4_flips'])} {f['hit4_flips']} | {len(f['hit1_flips'])} | {len(f['top1_moves'])} | {len(f['top4_set_changes'])} | {sum(h['t4_3'] for h in H1.values())} |")
    print("\nAUROC (label = own top-1 within 3° of a verified-correct ref)")
    for m in ("base", "cf_arg_pol", "cf_top_pol", "bnb"):
        a, npos, n, sig = auroc_table(rows, m)
        summ.setdefault("auroc", {})[m] = {"npos": npos, "n": n, "auroc": a}
        print(m, f"pos {npos}/{n}", {k: (round(v, 3) if v is not None else None) for k, v in a.items()})
    print("\nbnb certification:", sum(r["bnb"]["phase0"]["bnb"]["certified"] for r in rows.values()), "/", len(rows),
          "median bound-slack at top-1 (bstar_ub - bstar):",
          round(float(np.median([r["bnb"]["phase0"]["bnb"]["bstar_ub"] - r["bnb"]["phase0"]["bnb"]["bstar"] for r in rows.values()])), 4))
    print("\nper-photo (ref photos + wrong-basin list): method top-1 dist to correct ref / signals")
    per = {}
    for pid, r in rows.items():
        has = bool(L.REFS.correct_refs(pid))
        if not has and pid not in L.WRONG_BASIN:
            continue
        row = {}
        for m in ("base", "cf_arg_pol", "cf_top_pol", "bnb"):
            p = poses(r[m]["phase0"])
            d = L.ref_dists(p, pid)
            wd = L.wrong_dists(p, pid)
            sg = signals(r, m)
            row[m] = {"top1": {k: round(v, 2) for k, v in p[0].items()} if p else None, "d1": round(d[0], 2) if d else None,
                      "dmin4": round(min(d[:4]), 2) if d else None, "wd1": round(wd[0], 2) if wd else None,
                      "sig": {k: (round(v, 4) if isinstance(v, float) else v) for k, v in sg.items()
                              if k in ("fine_gap12", "coarse_gap3", "cert_gap3", "coarse_gapN", "strip4_e2_agree", "strip4_e2_mean", "strip3_e2_agree")}}
        per[pid] = row
        tag = "WRONG-BASIN" if pid in L.WRONG_BASIN else ""
        print(pid, tag, {m: (row[m]["d1"], row[m]["wd1"], row[m]["sig"].get("cert_gap3", row[m]["sig"]["coarse_gap3"]), row[m]["sig"]["strip4_e2_agree"]) for m in row})
    summ["per_photo"] = per
    if "--json" in sys.argv:
        json.dump(summ, open(sys.argv[sys.argv.index("--json") + 1], "w"), indent=1, default=float)


if __name__ == "__main__" and "--rerank" not in sys.argv:
    main()


def rerank_main(out_json=None):
    """POST HOC: fine- vs coarse-ranked tails (results/rerank)."""
    rows = {}
    for f in sorted((L.HERE / "results" / "rerank").glob("*.json")):
        r = json.load(open(f))
        pid = f.stem
        base = json.load(open(D / f"{pid}.json"))
        rows[pid] = {**r, "ystep": base["ystep"], "pid": pid}
    rep = all(v["reproduces"] for r in rows.values() for m in ("base_fine", "bnb_fine") for v in r[m].values())
    print("rerank: fine-ranked tail reproduces stored hyps on all runs:", rep)
    summ = {}
    for subset in ("odd", "even", "all"):
        R = {p: r for p, r in rows.items() if subset == "all" or (odd(p) == (subset == "odd"))}
        print(f"\n[{subset}] | tail | top1@3 | top4@3 | top1@1 | top4@1 | flips hit4/hit1/top1-moves/top4-set per shift |")
        for m in ("base_fine", "base_coarse", "bnb_fine", "bnb_coarse"):
            H = hits(R, m)
            t = {k: sum(h[k] for h in H.values()) for k in ("t1_3", "t4_3", "t1_1", "t4_1")}
            fl = {}
            for ph in ("pitch", "roll", "yaw", "all"):
                if any(ph in r[m] for r in R.values()):
                    f = flips(R, m, ph)
                    fl[ph] = [len(f["hit4_flips"]), len(f["hit1_flips"]), len(f["top1_moves"]), len(f["top4_set_changes"])]
                    fl[ph + "_ids"] = f["hit4_flips"] + f["hit1_flips"]
            summ.setdefault(subset, {})[m] = {**t, "nref": len(H), "flips": fl}
            print(f"| {m} | {t['t1_3']}/{len(H)} | {t['t4_3']}/{len(H)} | {t['t1_1']}/{len(H)} | {t['t4_1']}/{len(H)} | "
                  + " ".join(f"{ph}:{'/'.join(map(str, v))}" for ph, v in fl.items() if not ph.endswith("_ids")) + " |")
    if out_json:
        json.dump(summ, open(out_json, "w"), indent=1)


if __name__ == "__main__" and "--rerank" in sys.argv:
    rerank_main(sys.argv[sys.argv.index("--json") + 1] if "--json" in sys.argv else None)
