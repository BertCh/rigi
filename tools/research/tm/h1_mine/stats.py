"""H1: summary numbers for REPORT.txt (reads pool.json, runs/*, key/key.json). Prints plain text."""
from __future__ import annotations

import collections
import json
import statistics
from pathlib import Path

HERE = Path(__file__).resolve().parent
RUNS = HERE / "runs"
pool = json.load(open(HERE / "pool.json"))
raw = json.load(open(RUNS / "candidates_raw.json"))


def pct(xs, q):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(q * len(xs)))] if xs else None


print("RAW ROWS by source/kind:", dict(collections.Counter(f"{r['src']}:{r['kind']}" for r in raw)))
print("CLUSTERS:", len(pool), " screened:", sum(r["screened"] for r in pool))
print("STATUS x LABEL:", dict(collections.Counter(f"{r['status']}|{r['label']}" for r in pool)))
kept = [r for r in pool if r["keep"]]
print("KEPT (common>=100 or native fused>=100):", len(kept))
print("  kept by: common only", sum((r["common_inl"] or 0) >= 100 and (r["nativeFusedMax"] or 0) < 100 for r in kept),
      "| native only", sum((r["common_inl"] or 0) < 100 and (r["nativeFusedMax"] or 0) >= 100 for r in kept),
      "| both", sum((r["common_inl"] or 0) >= 100 and (r["nativeFusedMax"] or 0) >= 100 for r in kept))
inh = collections.Counter(r["inherit"]["verdict"] for r in kept if r["inherit"])
print("  inherited verdicts:", dict(inh))
# per source (a cluster counts for each source it contains)
print("\nPER SOURCE (clusters containing the source): all / kept / blind / wrong-construct / inherited-wrong / inherited-correct / capped")
for s in ("S0", "S1", "S2", "S5", "S3", "S4"):
    rs = [r for r in pool if s in r["sources"]]
    k = [r for r in rs if r["keep"]]
    print(f"  {s}: {len(rs)} / {len(k)} / {sum(r['status'] == 'blind' for r in k)} / {sum(r['status'] == 'wrong-construct' for r in k)} / "
          f"{sum(r['status'] == 'inherited' and r['inherit']['verdict'] == 'wrong' for r in k)} / "
          f"{sum(r['status'] == 'inherited' and r['inherit']['verdict'] == 'correct' for r in k)} / {sum(r['status'] == 'capped' for r in k)}")
print("  new-only sources (kept clusters whose sources are only S2/S3/S5, i.e. not reachable from S0/S1):",
      dict(collections.Counter("+".join(r["sources"]) for r in kept if not set(r["sources"]) & {"S0", "S1"})))
# S5 masked
s5 = [r for r in kept if "S5" in r["sources"]]
print("\nS5 masked-basin: kept clusters", len(s5), " with common>=100:", sum((r["common_inl"] or 0) >= 100 for r in s5),
      " native fused>=100:", sum((r["nativeFusedMax"] or 0) >= 100 for r in s5),
      " status:", dict(collections.Counter(r["status"] for r in s5)))
# hard-negative split
print("\nHARD-NEGATIVE CANDIDATE SPLIT (kept):")
print("  blind-to-verify:", sum(r["status"] == "blind" for r in kept),
      " wrong-by-construction:", sum(r["status"] == "wrong-construct" for r in kept),
      " inherited wrong:", inh.get("wrong", 0), " inherited correct:", inh.get("correct", 0),
      " capped (not packed):", sum(r["status"] == "capped" for r in kept))
# common distribution
cs = [r["common_inl"] for r in pool if r["common_inl"] is not None]
print("\nCOMMON SUPPORT (scored clusters n=%d): median %s p75 %s p90 %s max %s; >=100: %d; >=300: %d; >=1000: %d" % (
    len(cs), statistics.median(cs) if cs else None, pct(cs, .75), pct(cs, .9), max(cs) if cs else None,
    sum(c >= 100 for c in cs), sum(c >= 300 for c in cs), sum(c >= 1000 for c in cs)))
for st in ("blind", "wrong-construct", "inherited", "capped"):
    xs = sorted(r["common_inl"] or 0 for r in kept if r["status"] == st)
    if xs:
        print(f"  {st}: n={len(xs)} median {statistics.median(xs)} min {xs[0]} max {xs[-1]}")
iw = sorted(r["common_inl"] or 0 for r in kept if r["status"] == "inherited" and r["inherit"]["verdict"] == "wrong")
ic = sorted(r["common_inl"] or 0 for r in kept if r["status"] == "inherited" and r["inherit"]["verdict"] == "correct")
print("  inherited-wrong common:", iw)
print("  inherited-correct common: median", statistics.median(ic) if ic else None, "n", len(ic))
wc = [r for r in kept if r["status"] == "wrong-construct"]
print("  wrong-construct with common>=100:", sum((r["common_inl"] or 0) >= 100 for r in wc), "native>=100:", sum((r["nativeFusedMax"] or 0) >= 100 for r in wc))
# per photo
print("\nPER PHOTO (kept: blind / construct / inh-wrong / inh-correct / capped):")
byp = collections.defaultdict(list)
for r in kept:
    byp[r["pid"]].append(r)
for p in sorted({r["pid"] for r in pool}):
    rs = byp.get(p, [])
    c = collections.Counter(r["status"] if r["status"] != "inherited" else "inh-" + r["inherit"]["verdict"] for r in rs)
    print(f"  {p}: {c.get('blind', 0)} / {c.get('wrong-construct', 0)} / {c.get('inh-wrong', 0)} / {c.get('inh-correct', 0)} / {c.get('capped', 0)}")
print("\nPHOTOS with >=1 blind candidate:", len({r["pid"] for r in kept if r["status"] == "blind"}),
      " with >=1 construct:", len({r["pid"] for r in kept if r["status"] == "wrong-construct"}))
print("eyeFlag (achieved eye > 0.5 m off):", sum(1 for r in pool if (r.get("common") or {}).get("eyeFlag")))
print("score errors:", [(r["cid"], r["common"].get("error")) for r in pool if r.get("common") and r["common"].get("error")])
rp = [r["replay"] for r in pool if r.get("replay")]
print("replays:", len(rp), "errors", sum(1 for x in rp if x.get("error")),
      "pose diff > 0.1 deg:", sum(1 for x in rp if (x.get("replayPoseDiffDeg") or 0) > 0.1),
      "inlier ratio median:", statistics.median([x["replayInliers"] / x["recordedInliers"] for x in rp if x.get("recordedInliers")]) if rp else None)
print("kept with fused corr:", sum(1 for r in kept if r["corrFused"]), "/", len(kept), " with single corr:", sum(1 for r in kept if r["corrSingle"]))
kf = HERE / "key/key.json"
if kf.exists():
    k = json.load(open(kf))
    print("\nPACK:", len(k["candidates"]), "images,", len(k["folders"]), "folders; kinds", k["counts"], "; batches", [len(b) for b in k["batches"]])
# runtimes
print("\nRUNTIME per stage (sum of per-photo wall s):")
for st in ("S1", "S2", "S5", "S3a"):
    ws = [json.load(open(f)).get("h1WallS", 0) for f in (RUNS / st).glob("wc_*.json")]
    if ws:
        print(f"  {st}: {len(ws)} photos, total {sum(ws) / 60:.1f} min, median {statistics.median(ws):.0f} s")
errs = []
for st in ("S1", "S2", "S5", "S3a"):
    for f in (RUNS / st).glob("wc_*.json"):
        r = json.load(open(f))
        if r.get("error"):
            errs.append((st, r["id"], r["error"][:120]))
        for c in r.get("candidates") or []:
            if c.get("error"):
                errs.append((st, r["id"], "cand: " + c["error"][:100]))
        for k2, rk in (r.get("eyeRecs") or {}).items():
            if rk.get("error"):
                errs.append((st, r["id"], k2 + ": " + rk["error"][:100]))
        for p in r.get("probes") or []:
            if p.get("error"):
                errs.append((st, r["id"], "probe " + p["why"] + ": " + p["error"][:100]))
print("generation errors:", errs)
