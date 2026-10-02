# Rigi
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: Copyright (c) Rigi contributors
"""Tables for the skyline-parallax study: python3 analyze.py [results.json] (protocol: PROTOCOL.txt)."""
import json, math, sys
from collections import defaultdict

res = json.load(open(sys.argv[1] if len(sys.argv) > 1 else "results.json"))["results"]

def cp(k, n, a=0.05):
    from math import comb
    if n == 0: return (float("nan"),) * 2
    def cdf(x, p): return sum(comb(n, i) * p**i * (1 - p) ** (n - i) for i in range(0, x + 1))
    lo, hi = 0.0, 1.0
    if k > 0:
        a_, b_ = 0.0, k / n
        for _ in range(60):
            m = (a_ + b_) / 2
            (a_, b_) = (a_, m) if 1 - cdf(k - 1, m) > a / 2 else (m, b_)
        lo = (a_ + b_) / 2
    if k < n:
        a_, b_ = k / n, 1.0
        for _ in range(60):
            m = (a_ + b_) / 2
            (a_, b_) = (m, b_) if cdf(k, m) > a / 2 else (a_, m)
        hi = (a_ + b_) / 2
    else: hi = 1.0
    return lo, hi

def rej(rows): return sum(1 for r in rows if r["reject"])
def line(name, rows):
    k, n = rej(rows), len(rows)
    lo, hi = cp(k, n)
    ab = sum(1 for r in rows if r["abstain"])
    print(f"  {name:34s} {k:4d}/{n:<4d} {100*k/max(n,1):5.1f}%  [{100*lo:.1f}, {100*hi:.1f}]   abstain {ab}/{n} ({100*ab/max(n,1):.0f}%)")

by = defaultdict(list)
for r in res: by[r["label"]].append(r)
print(f"n = {len(res)}  labels: " + ", ".join(f"{k} {len(v)}" for k, v in sorted(by.items())))
pos, ne = by["POS"], by["NE-dec"]
print("\nGATING")
line("POS accepted by CUR (kill if > 0)", [r for r in pos if r["e1CUR"]])
line("NE-dec (kill if < 30%)", ne)
line("NE-dec & e1AC1 (kill if < 5/10)", [r for r in ne if r["e1AC1"]])
k1 = rej([r for r in pos if r["e1CUR"]]); k2 = rej(ne); k3 = rej([r for r in ne if r["e1AC1"]])
n2 = len(ne); n3 = sum(1 for r in ne if r["e1AC1"])
kill = k1 > 0 or k2 < 0.3 * n2 or k3 < 5
print(f"\nVERDICT: {'KILL' if kill else 'PASS (dev only)'}  [CUR positives rejected {k1}; NE-dec {k2}/{n2}; AC1 NE-dec {k3}/{n3}]")
print("\nREPORTED (not gating)")
line("all POS", pos)
line("NB-con", by["NB-con"])
for d in (150, 400): line(f"NE-dec {d} m", [r for r in ne if r["dispDistM"] and abs(r["dispDistM"] - d) < 1])
for lab in ("NB-dec", "NE-inh", "NB-inh"): line(lab, by[lab])
nab = sum(1 for r in res if r["abstain"])
print(f"\nabstention overall {nab}/{len(res)}; by reason:", {k: sum(1 for r in res if r['abstain'] == k) for k in {r['abstain'] for r in res if r['abstain']}})

def chi(r): return r["chi2Eye"] if r["abstain"] is None and r["chi2Eye"] == r["chi2Eye"] else 0.0
def auroc(a, b):
    s = 0.0
    for x in a:
        for y in b: s += 1.0 if x > y else 0.5 if x == y else 0.0
    return s / (len(a) * len(b))
print(f"AUROC chi2_eye NE-dec vs POS (abstained = 0): {auroc([chi(r) for r in ne], [chi(r) for r in pos]):.3f}")
def med(a):
    a = sorted(a); return a[len(a) // 2] if a else float('nan')
for lab in ("POS", "NE-dec"):
    ok = [r for r in by[lab] if r["abstain"] is None]
    print(f"{lab}: non-abstained {len(ok)}; median chi2_eye {med([r['chi2Eye'] for r in ok]):.1f}; median |delta| {med([r['deltaNormM'] for r in ok]):.0f} m; median |resid| after fit {med([r['medianAbsResidualPx'] for r in ok]):.2f} px")
print("\nPOS detail (pid id chi2 |delta| nValid scale abstain CUR rej)")
for r in sorted(pos, key=lambda r: r["id"]):
    f = lambda v, fmt: format(v, fmt) if v is not None else "n/a"
    print(f"  {r['id']:18s} chi2 {f(r['chi2Eye'], '10.1f'):>10s} d {f(r['deltaNormM'], '7.0f'):>7s} n {r['nValid']:4d} sc {f(r['scalePx'], '.2f'):>5s} {r['abstain'] or '-':20s} CUR {int(r['e1CUR'])} rej {int(r['reject'])}")
