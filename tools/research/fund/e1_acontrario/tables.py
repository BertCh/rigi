"""E1: plain-text tables from results.json + hyp_scores.json (for REPORT.txt). No new decisions."""
from __future__ import annotations

import json
import math
from collections import defaultdict
from pathlib import Path

import numpy as np
from scipy.stats import beta

HERE = Path(__file__).resolve().parent
R = json.load(open(HERE / "results.json"))
H = json.load(open(HERE / "hyp_scores.json"))
M = R["metrics"]
KINDS = ("POS", "NB-inh", "NB-con", "NB-dec", "NE-inh", "NE-dec", "AMB")
METH = ("AC1", "AC2", "CUR", "CURall", "AC1fit", "AC2fit")


def ub(n):  # exact one-sided 95% upper bound on a rate with 0 events in n
    return 1 - 0.05 ** (1 / n) if n else float("nan")


def cp_upper(k, n):
    return float(beta.ppf(0.95, k + 1, n - k)) if n and k < n else 1.0


print("LABEL COUNTS", R["labelCounts"], "photos", len(R["photos"]), "hyps", R["nHyps"])
print()
print(f"{'kind':8s} {'n':>5s} {'ph':>3s} " + " ".join(f"{m:>8s}" for m in METH))
for k in KINDS + ("UNL",):
    row = M["AC1"]["perKind"][k]
    print(f"{k:8s} {row['n']:5d} {row['photos']:3d} " + " ".join(f"{M[m]['perKind'][k]['accepted']:8d}" for m in METH))
print()
for m in METH:
    mm = M[m]
    bs = R["bootstrap95"][m]
    print(f"{m:7s} photoRecall {mm['photoRecall']}/{mm['photosWithPositive']} (95% boot {bs['recall']}) posAccepted CI {bs['posAcc']} "
          f"gross {mm['gross']} (boot {bs['gross']}) grossPhotos {mm['grossPhotos']} wrongEye {mm['wrongEyeAccepted']}")
print()
# NB-con hard/easy/S5 split
for m in METH:
    hc = [h for h in H if h["label"] == "NB-con"]
    sub = defaultdict(lambda: [0, 0])
    for h in hc:
        for t in h["labelWhy"].split(";"):
            sub[t][0] += 1
            sub[t][1] += h["accept"][m]
    print(m, "NB-con", {k: f"{v[1]}/{v[0]}" for k, v in sub.items()})
print()
print("POSITIVES")
for h in sorted([h for h in H if h["label"] == "POS"], key=lambda h: h["pid"]):
    print(f"  {h['hid']:22s} {h['kind']:4s} nCorr {h['nCorr']:5d} T {h['T']:8.1f} Tfit {h['Tfit']:8.1f} z {(h.get('zScore') if h.get('zScore') is not None else float('nan')):6.2f} "
          f"log10NFA {h['log10NFA'] if h['log10NFA'] is None else round(h['log10NFA'], 2)!s:>6s} split {h['split']} acc {[k for k, v in h['accept'].items() if v]}")
print()
print("WRONG-EYE / AMBIGUOUS DISPLACED + inherited wrong")
for h in sorted([h for h in H if h["label"] in ("NE-dec", "NE-inh", "NB-inh", "AMB")], key=lambda h: (h["label"], h["pid"])):
    mf = h.get("misfit") or {}
    print(f"  {h['label']:6s} {h['hid']:26s} nCorr {h['nCorr']:5d} T {h['T']:8.1f} Tfit {h['Tfit']:8.1f} z {(h.get('zScore') if h.get('zScore') is not None else float('nan')):6.2f} "
          f"NFA {h['log10NFA'] if h['log10NFA'] is None else round(h['log10NFA'], 2)!s:>6s} nNull {h['nNull']:3d} "
          f"misfit med/p90 {mf.get('medPx', float('nan')):6.1f}/{mf.get('p90Px', float('nan')):6.1f} fused {h.get('fusedLevel')} {h.get('fusedInliers')} "
          f"acc {[k for k, v in h['accept'].items() if v]}")
print()
print("NE-dec: z of the displaced decoy vs z of the photo's best positive (same photo)")
byp = defaultdict(list)
for h in H:
    byp[h["pid"]].append(h)
cnt = [0, 0]
for pid, hs in sorted(byp.items()):
    pos = [h for h in hs if h["label"] == "POS"]
    ne = [h for h in hs if h["label"] == "NE-dec"]
    if not pos or not ne:
        continue
    bp = max(h["T"] for h in pos)
    bn = max(h["T"] for h in ne)
    cnt[0] += 1
    cnt[1] += bn >= bp
    print(f"  {pid} bestPOS T {bp:8.1f}  bestNE-dec T {bn:8.1f}  {'NE>=POS' if bn >= bp else ''}")
print("  photos where a >=150 m decoy scores >= the best positive:", cnt[1], "/", cnt[0])
print()
print("UNLABELLED (not in any metric): accept counts by sub-kind")
sub = defaultdict(lambda: defaultdict(int))
for h in H:
    if h["label"] != "UNL":
        continue
    k = (h["kind"], h.get("status") or h["labelWhy"][:40])
    sub[k]["n"] += 1
    for m in METH:
        sub[k][m] += h["accept"][m]
for k, v in sorted(sub.items()):
    print(" ", k, dict(v))
print()
print("DESCRIPTIVE AUROC (POS vs kind), T and Tfit:", json.dumps(R["descriptiveAUROC"]))
print()
print("Split used:", {s: sum(1 for h in H if (h['split'] or 'none').startswith(s)) for s in ('5km', 'median', 'none')},
      "no-sky:", sum(1 for h in H if h['sky'] is False))
nn = [h["nNull"] for h in H]
print("null sizes: median", np.median(nn), "min", min(nn), "no-decision (<10):", sum(1 for h in H if h["log10NFA"] is None),
      "tests/photo median", np.median([h["nTests"] for h in H]))
print("exact 95%% upper bound on accept rate with 0 accepted: NE-dec n=%d -> %.3f; all labelled negatives n=%d -> %.3f" % (
    M["AC1"]["perKind"]["NE-dec"]["n"], ub(M["AC1"]["perKind"]["NE-dec"]["n"]),
    sum(M["AC1"]["perKind"][k]["n"] for k in KINDS[1:6]), ub(sum(M["AC1"]["perKind"][k]["n"] for k in KINDS[1:6]))))
print()
print("Clopper-Pearson one-sided 95% upper bound on the per-kind accept rate (k accepted / n):")
for m in METH:
    print(" ", m, {k: f"{M[m]['perKind'][k]['accepted']}/{M[m]['perKind'][k]['n']} ub {cp_upper(M[m]['perKind'][k]['accepted'], M[m]['perKind'][k]['n']):.3f}"
                   for k in KINDS if M[m]['perKind'][k]['n']})
