"""Score pred_dev.json against refs / GT. Prints markdown tables used in REPORT.md."""
from __future__ import annotations
import json, math, sys
from pathlib import Path
import numpy as np

HERE = Path(__file__).resolve().parent
D = json.load(open(HERE / (sys.argv[1] if len(sys.argv) > 1 else "pred_dev.json")))
META = D.pop("_meta")
MODE = sys.argv[2] if len(sys.argv) > 2 else "free"   # free | prior (prior falls back to free when no EXIF)
hf = lambda v, a: 2 * math.degrees(math.atan(math.tan(math.radians(v) / 2) * a))  # noqa: E731

rows = []
for pid, r in D.items():
    t = r["truth"]
    if not t:
        continue
    p = r.get(MODE) or r["free"]
    a = r["W"] / r["H"]
    rows.append({"pid": pid, "set": r["set"], "fk": r["focalKnown"], "narrow": t["hfov"] < 25, "sky": r["skyline"],
                 "tp": t["pitch"], "tr": t["roll"], "tv": t["vfov"], "th": t["hfov"],
                 "pp": p["pitch"], "pr": p["roll"], "pv": p["vfov"], "ph": hf(p["vfov"], a),
                 "sp": p["sigma"]["pitch"], "sr": p["sigma"]["roll"], "sv": p["sigma"]["vfov"],
                 "dv": r["defaultVfov"], "ev": r["exifVfov"], "aspect": a})
N = len(rows)
A = lambda k: np.array([x[k] for x in rows], float)  # noqa: E731

# ---- conventions: pick the sign that best matches
print(f"## Conventions (mode={MODE}, n={N})")
for tk, pk in (("tp", "pp"), ("tr", "pr")):
    t, p = A(tk), A(pk)
    print(f"- {pk}: corr(+)={np.corrcoef(t, p)[0,1]:+.2f}  median|Δ| same sign {np.median(abs(p-t)):.2f}  flipped {np.median(abs(-p-t)):.2f}")

for x in rows:
    x["ep"], x["er"] = x["pp"] - x["tp"], x["pr"] - x["tr"]
    x["rv"] = x["pv"] / x["tv"]


def summ(sel, label):
    s = [x for x in rows if sel(x)]
    if not s:
        return
    ep = np.abs([x["ep"] for x in s]); er = np.abs([x["er"] for x in s])
    lr = np.abs(np.log([x["rv"] for x in s]))
    zp = np.abs([x["ep"] / x["sp"] for x in s]); zr = np.abs([x["er"] / x["sr"] for x in s])
    print(f"| {label} | {len(s)} | {np.median(ep):.1f} | {np.percentile(ep,90):.1f} | {ep.max():.1f} | {np.median(er):.1f} | {np.percentile(er,90):.1f} | {er.max():.1f} "
          f"| {np.exp(np.median(lr)):.2f} | {np.mean(np.exp(lr) <= 1.1)*100:.0f}% | {np.median([x['sp'] for x in s]):.1f}/{np.median([x['sr'] for x in s]):.1f} "
          f"| {np.mean(zp<=1)*100:.0f}/{np.mean(zp<=2)*100:.0f} | {np.mean(zr<=1)*100:.0f}/{np.mean(zr<=2)*100:.0f} |")


print("\n| split | n | pitch med | p90 | max | roll med | p90 | max | vfov ratio err (med, ×) | within ±10% | σ med p/r | pitch in 1σ/2σ % | roll in 1σ/2σ % |")
print("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
summ(lambda x: True, "all")
summ(lambda x: x["set"] == "dev", "dev refs")
summ(lambda x: x["set"] == "gt", "app GT")
summ(lambda x: x["fk"], "focal known")
summ(lambda x: not x["fk"], "focal unknown")
summ(lambda x: x["narrow"], "narrow (hfov<25)")
summ(lambda x: not x["narrow"], "normal")
summ(lambda x: x["sky"] == "near", "near skyline")
summ(lambda x: x["sky"] == "far", "far skyline")

# ---- fans
print("\n## Fans (95 % containment)")
ep, er, sp, sr = np.abs(A("ep")), np.abs(A("er")), A("sp"), A("sr")
def kneed(e, s, q=0.95):
    z = np.sort(e / s); return z[int(math.ceil(q * len(z))) - 1]
kp, kr = kneed(ep, sp), kneed(er, sr)
both = lambda k: np.mean((ep <= k * sp) & (er <= k * sr))  # noqa: E731
kb = next(k for k in np.arange(0.1, 10, 0.05) if both(k) >= 0.95)
cp, cr = np.sort(ep)[int(math.ceil(.95 * N)) - 1], np.sort(er)[int(math.ceil(.95 * N)) - 1]
print(f"- σ-scaled: pitch k={kp:.2f} (mean half-width {np.mean(kp*sp):.1f}°, median {np.median(kp*sp):.1f}°), roll k={kr:.2f} (mean {np.mean(kr*sr):.1f}°, median {np.median(kr*sr):.1f}°); joint k={kb:.2f}: pitch mean ±{np.mean(kb*sp):.1f}, roll ±{np.mean(kb*sr):.1f}")
print(f"- constant-width (centre=GeoCalib): pitch ±{cp:.1f}°, roll ±{cr:.1f}°; area vs ±15×±9: {(cp*cr)/(15*9)*100:.0f}%")
print(f"- current fan ±15/±9 around 0 contains truth: pitch {np.mean(np.abs(A('tp'))<=15)*100:.0f}%, roll {np.mean(np.abs(A('tr'))<=9)*100:.0f}%")
print(f"- baseline constant fan around 0 for 95 %: pitch ±{np.sort(np.abs(A('tp')))[int(math.ceil(.95*N))-1]:.1f}, roll ±{np.sort(np.abs(A('tr')))[int(math.ceil(.95*N))-1]:.1f}")
# σ-scaled with floor
for fl in (1.0, 2.0, 3.0):
    ok = lambda k: np.mean((ep <= np.maximum(k * sp, fl)) & (er <= np.maximum(k * sr, fl)))  # noqa: E731
    k = next(k for k in np.arange(0.05, 10, 0.05) if ok(k) >= 0.95)
    print(f"  floor {fl}°: joint k={k:.2f}: pitch mean ±{np.mean(np.maximum(k*sp,fl)):.1f}, roll mean ±{np.mean(np.maximum(k*sr,fl)):.1f}")

for name, sel in (("normal (hfov>=25)", lambda x: not x["narrow"]), ("narrow", lambda x: x["narrow"]), ("far", lambda x: x["sky"] == "far"), ("near", lambda x: x["sky"] == "near")):
    s_ = [x for x in rows if sel(x)]; n_ = len(s_); q = int(math.ceil(.95 * n_)) - 1
    e1 = np.sort([abs(x["ep"]) for x in s_]); e2 = np.sort([abs(x["er"]) for x in s_])
    z1 = np.array([abs(x["ep"]) / x["sp"] for x in s_]); z2 = np.array([abs(x["er"]) / x["sr"] for x in s_])
    k = next(k for k in np.arange(0.05, 20, 0.05) if np.mean((z1 <= k) & (z2 <= k)) >= 0.95)
    t1 = np.sort([abs(x["tp"]) for x in s_]); t2 = np.sort([abs(x["tr"]) for x in s_])
    print(f"- {name} n={n_}: const fan around GeoCalib ±{e1[q]:.1f}/±{e2[q]:.1f}; around 0 ±{t1[q]:.1f}/±{t2[q]:.1f}; joint σ-fan k={k:.2f} → mean ±{k*np.mean([x['sp'] for x in s_]):.1f}/±{k*np.mean([x['sr'] for x in s_]):.1f}")

# ---- vfov for focal-unknown
print("\n## vfov, focal unknown")
print("| id | set | truth hfov | GeoCalib hfov | ratio vfov | σ vfov | default 50° ratio | truth in 35–75 sweep |")
print("|---|---|---|---|---|---|---|---|")
U = [x for x in rows if not x["fk"]]
for x in sorted(U, key=lambda x: x["th"]):
    print(f"| {x['pid']} | {x['set']} | {x['th']:.1f} | {x['ph']:.1f} | {x['rv']:.2f} | {x['sv']:.1f} | {x['dv']/x['tv']:.2f} | {'yes' if 35<=x['th']<=75 else 'no'} |")
if U:
    lg = np.abs(np.log([x["rv"] for x in U])); ld = np.abs(np.log([x["dv"] / x["tv"] for x in U]))
    print(f"- median ratio err GeoCalib {np.exp(np.median(lg)):.2f}× vs default {np.exp(np.median(ld)):.2f}×; within ±10 %: {np.mean(np.exp(lg)<=1.1)*100:.0f}% vs {np.mean(np.exp(ld)<=1.1)*100:.0f}%; "
          f"GeoCalib better on {sum(a<b for a,b in zip(lg,ld))}/{len(U)}; in 35–75 sweep {sum(35<=x['th']<=75 for x in U)}/{len(U)}")
K = [x for x in rows if x["fk"]]
lg = np.abs(np.log([x["rv"] for x in K])); le = np.abs(np.log([x["ev"] / x["tv"] for x in K]))
print(f"- focal known (n={len(K)}): GeoCalib median ratio err {np.exp(np.median(lg)):.2f}×, EXIF {np.exp(np.median(le)):.3f}×")

# ---- per-photo table
print("\n## Per photo")
print("| id | set | fk | hfov | sky | truth p/r | pred p/r (σ) | Δp | Δr | vfov ratio |")
print("|---|---|---|---|---|---|---|---|---|---|")
for x in sorted(rows, key=lambda x: -max(abs(x["ep"]), abs(x["er"]))):
    print(f"| {x['pid']} | {x['set']} | {'y' if x['fk'] else 'n'} | {x['th']:.0f} | {x['sky']} | {x['tp']:+.1f}/{x['tr']:+.1f} | {x['pp']:+.1f}/{x['pr']:+.1f} ({x['sp']:.1f}/{x['sr']:.1f}) | {x['ep']:+.1f} | {x['er']:+.1f} | {x['rv']:.2f} |")
print("\ntiming:", META.get("timing_warm_2048px"))
