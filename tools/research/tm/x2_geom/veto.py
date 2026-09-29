"""X2 (A)/(C) veto test: thresholds fixed on the ODD subset's verified-correct refs, applied to everything.

Rule: veto a pose if score < tau, tau = min over odd-id correct refs (raw score, or null-z for *.z keys).
Reports false vetoes of correct refs / correct matcher poses and vetoes of wrong refs, trap refs, gross matcher poses.
    python veto.py  -> veto.json
"""
from __future__ import annotations
import _env  # noqa: F401
import glob, json
import numpy as np
from analyze import get

R = {f.split("/")[-1][:-5]: json.load(open(f)) for f in sorted(glob.glob(str(_env.HERE / "results/*.json")))}
odd = lambda p: int(p[3:]) % 2 == 1  # noqa: E731
TRAP_REFS = {"wc_0001": "B", "wc_0069": "A", "wc_0070": "A", "wc_0074": "A"}   # LoMa ≥100-inlier basins (loma/REPORT.md)
KEYS = [("sky_miou", False), ("rank_all", False), ("rank_t", False), ("ord_local", False), ("edge_all", False),
        ("edge_int", False), ("normal_cos", False), ("combo", True), ("combo_int", True)]
MODELS = ["moge_l", "da3_b", "moge_b"]


def main():
    out = {}
    for m in MODELS:
        for k, z in KEYS:
            if m != "moge_l" and (k == "normal_cos" and m == "da3_b"):
                continue
            if m == "moge_b" and z:
                continue   # moge_b has no null scans
            name = f"{m}.{k}{'.z' if z else ''}"
            tr = [get(x, m, k, z) for p, r in R.items() if odd(p) for x in r["refs"] if x["verdict"] == "correct"]
            tr = [t for t in tr if t is not None]
            if not tr:
                continue
            tau = min(tr)
            res = {"tau": tau, "n_train": len(tr)}
            for sub, sel in (("odd", odd), ("even", lambda p: not odd(p)), ("all", lambda p: True)):
                cr = [get(x, m, k, z) for p, r in R.items() if sel(p) for x in r["refs"] if x["verdict"] == "correct"]
                wr = [get(x, m, k, z) for p, r in R.items() if sel(p) for x in r["refs"] if x["verdict"] == "wrong"]
                cr = [c for c in cr if c is not None]; wr = [w for w in wr if w is not None]
                res[sub] = {"correct_refs_vetoed": f"{sum(c < tau for c in cr)}/{len(cr)}", "wrong_refs_vetoed": f"{sum(w < tau for w in wr)}/{len(wr)}"}
            res["traps"] = {}
            for p, lab in TRAP_REFS.items():
                x = next(x for x in R[p]["refs"] if x["label"] == lab)
                s = get(x, m, k, z)
                res["traps"][f"{p}{lab}"] = {"score": s, "vetoed": (s is not None and s < tau), "subset": "odd" if odd(p) else "even"}
            # matcher-solved poses (>=100 inliers, pano coverage >= 0.3)
            good, bad, badrows, goodrows = 0, 0, [], []
            gv = bv = 0
            for p, r in R.items():
                for c in r["cands"]:
                    if (c.get("inliers") or 0) < 100 or c["pano_cover"] < 0.3:
                        continue
                    s = get(c, m, k, z)
                    if s is None:
                        continue
                    if c["label"] == "correct":
                        good += 1; gv += s < tau
                        if s < tau:
                            goodrows.append([p, c["src"], c["inliers"], round(s, 3)])
                    elif c["label"] in ("wrong", "near_wrong_ref"):
                        bad += 1; bv += s < tau
                        badrows.append([p, c["src"], c["label"], c["inliers"], round(s, 3), bool(s < tau)])
            res["matcher"] = {"correct_vetoed": f"{gv}/{good}", "gross_vetoed": f"{bv}/{bad}", "gross": badrows, "correct_vetoed_rows": goodrows}
            out[name] = res
    json.dump(out, open(_env.HERE / "veto.json", "w"), indent=1, default=float)
    print(f"{'score':22s} {'tau':>7s} | correct refs vetoed odd/even | wrong refs vetoed all | traps (0001B 0069A 0070A 0074A) | matcher: correct vetoed, gross vetoed")
    for n, r in out.items():
        t = " ".join("V" if v["vetoed"] else "." for v in r["traps"].values())
        print(f"{n:22s} {r['tau']:7.3f} | {r['odd']['correct_refs_vetoed']:>6s} {r['even']['correct_refs_vetoed']:>6s} | "
              f"{r['all']['wrong_refs_vetoed']:>7s} | {t} | {r['matcher']['correct_vetoed']:>6s} {r['matcher']['gross_vetoed']:>6s}")


if __name__ == "__main__":
    main()


def finals(keys=("moge_l.rank_all", "moge_l.rank_t", "moge_l.combo.z", "moge_l.combo_int.z", "da3_b.combo.z", "da3_b.combo_int.z")):
    """HIGH finals of the T6 (dev) and LoMa (dev_loma) arms at the stated eye: which would the veto remove?"""
    v = json.load(open(_env.HERE / "veto.json"))
    base = _env.TM.parents[1] / "matcher/v2/out"
    ver = {}
    for arm, d in (("t6_final", "dev"), ("loma_final", "dev_loma")):
        for r in json.load(open(base / d / "score.json"))["rows"]["t6"]:
            ver[(arm, r["id"])] = r
    out = {}
    for pid, r in R.items():
        for c in r["cands"]:
            srcs = [c["src"]] + [d["src"] for d in c.get("dups", [])]
            for arm in ("t6_final", "loma_final"):
                vr = ver.get((arm, pid))
                if arm not in srcs or not vr or not vr["high"]:
                    continue
                row = {"pid": pid, "verdict": vr["verdict"], "poseLabel": c["label"], "panoCover": c["pano_cover"]}
                for k in keys:
                    m, kk = k.split(".")[0], k.split(".")[1]
                    s = get(c, m, kk, k.endswith(".z"))
                    row[k] = {"score": s, "vetoed": bool(s is not None and s < v[k]["tau"])}
                out.setdefault(arm, []).append(row)
    summ = {arm: {k: {"correct_high_vetoed": sum(x[k]["vetoed"] for x in rows if x["verdict"] == "correct"),
                      "n_correct_high": sum(x["verdict"] == "correct" for x in rows),
                      "wrong_high_vetoed": sum(x[k]["vetoed"] for x in rows if x["verdict"] == "wrong"),
                      "n_wrong_high": sum(x["verdict"] == "wrong" for x in rows)} for k in keys} for arm, rows in out.items()}
    json.dump({"rows": out, "summary": summ}, open(_env.HERE / "veto_finals.json", "w"), indent=1, default=float)
    for arm, s in summ.items():
        for k, x in s.items():
            print(f"{arm:10s} {k:20s} correct HIGH vetoed {x['correct_high_vetoed']}/{x['n_correct_high']}  wrong HIGH vetoed {x['wrong_high_vetoed']}/{x['n_wrong_high']}")


if __name__ == "__main__":
    finals()
