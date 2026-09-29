"""X3 (POST HOC, defined after the final light-matcher results were seen): candidate-level true-vs-wrong separation,
and a "texture proposer + geometry verifier" rule.

Candidates = every ref render of every dev photo:
  positive  = a verified-CORRECT ref render whose solve lands < 2° from that ref
  negative  = a verified-WRONG ref render whose solve STAYS < 2° on that wrong ref (the matcher supports the wrong pose)
A candidate's support under a combo = inliers of that combo's solve on that render (0 if the solve leaves the candidate).
Reports, per combo: AUC(positive support vs negative support), and at inlier thresholds T: TPR (share of correct refs
accepted) / FP (number of wrong refs accepted). Then proposer+verifier: accept iff proposer support >= 30 AND verifier
support >= t.

    python verify_combo.py results_final.json --combos aliked:sat,loma:sat,... --verifiers mxoftr:depth,mxoftr:hill,loma:hill
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent


def support(res, combo, pid, label, key="inliers"):
    m, c = combo
    r = res["views"].get(m, {}).get(c, {}).get(pid, {}).get(f"refs/{label}")
    if not r or r.get("errView") is None or r["errView"] >= 2:
        return 0
    return r[key]


def cands(res):
    out = []
    for pid, info in res["photos"].items():
        for lab in info["correct"]:
            out.append((pid, lab, 1))
        for lab in info["wrong"]:
            out.append((pid, lab, 0))
    return out


def auc(pos, neg):
    p = np.asarray(pos, float)[:, None]
    n = np.asarray(neg, float)[None, :]
    return float(((p > n).sum() + 0.5 * (p == n).sum()) / (p.size * n.size))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("res")
    ap.add_argument("--combos", required=True)
    ap.add_argument("--verifiers", default="")
    a = ap.parse_args()
    res = json.load(open(HERE / a.res))
    C = cands(res)
    combos = [tuple(x.split(":")) for x in a.combos.split(",")]
    ver = [tuple(x.split(":")) for x in a.verifiers.split(",") if x]
    print(f"candidates: {sum(y for *_, y in C)} correct refs, {sum(1 - y for *_, y in C)} wrong refs "
          f"(over {len(res['photos'])} photos)\n")
    print("| combo | AUC | correct refs supported ≥30 | wrong refs supported ≥30 | ≥100 | ≥300 | max wrong support | "
          "correct refs > max wrong |")
    print("|---|---|---|---|---|---|---|---|")
    for cb in combos:
        pos = [support(res, cb, p, l) for p, l, y in C if y]
        neg = [support(res, cb, p, l) for p, l, y in C if not y]
        mx = max(neg)
        print(f"| {cb[0]}:{cb[1]} | {auc(pos, neg):.3f} | {sum(x >= 30 for x in pos)}/{len(pos)} | {sum(x >= 30 for x in neg)}/{len(neg)} | "
              f"{sum(x >= 100 for x in neg)} | {sum(x >= 300 for x in neg)} | {mx} | {sum(x > mx for x in pos)} |")
    print("\nSame, with the solve's INLIER FRACTION as the support score (scale-free; needed for dense MINIMA-RoMa):\n")
    print("| combo | AUC (frac) | max wrong frac | correct refs > max wrong frac | wrong refs with frac ≥ 0.3 | correct refs with frac ≥ 0.3 |")
    print("|---|---|---|---|---|---|")
    for cb in combos:
        pos = [support(res, cb, p, l, "inlFrac") for p, l, y in C if y]
        neg = [support(res, cb, p, l, "inlFrac") for p, l, y in C if not y]
        mx = max(neg)
        print(f"| {cb[0]}:{cb[1]} | {auc(pos, neg):.3f} | {mx:.2f} | {sum(x > mx for x in pos)} | {sum(x >= 0.3 for x in neg)}/{len(neg)} | "
              f"{sum(x >= 0.3 for x in pos)}/{len(pos)} |")
    if ver:
        print("\nProposer + verifier (accept iff proposer ≥ 30 AND verifier ≥ t): correct refs accepted / wrong refs accepted\n")
        ts = [10, 20, 30, 50]
        print("| proposer | verifier | " + " | ".join(f"t={t}" for t in ts) + " | proposer alone |")
        print("|---|---|" + "---|" * (len(ts) + 1))
        for pr in combos:
            for vf in ver:
                if vf == pr:
                    continue
                cells = []
                for t in ts:
                    tp = sum(1 for p, l, y in C if y and support(res, pr, p, l) >= 30 and support(res, vf, p, l) >= t)
                    fp = sum(1 for p, l, y in C if not y and support(res, pr, p, l) >= 30 and support(res, vf, p, l) >= t)
                    cells.append(f"{tp} / {fp}")
                tp0 = sum(1 for p, l, y in C if y and support(res, pr, p, l) >= 30)
                fp0 = sum(1 for p, l, y in C if not y and support(res, pr, p, l) >= 30)
                print(f"| {pr[0]}:{pr[1]} | {vf[0]}:{vf[1]} | " + " | ".join(cells) + f" | {tp0} / {fp0} |")


if __name__ == "__main__":
    main()
