"""Score flags.json against F1 labels and verified-correct refs (dev only). Prints tables used in REPORT.txt."""
from __future__ import annotations
import json, sys
from pathlib import Path
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
sys.path.insert(0, str(ROOT / "tools/matcher/v2"))
import refs  # noqa: E402

F = json.load(open(HERE / "flags.json"))
TX = json.load(open(ROOT / "tools/research/tm/f1_autopsy/taxonomy.json"))["photos"]
POS = {p for p, v in TX.items() if v["stage"] == "position"}
BIG = {p for p, v in TX.items() if "a_big" in v["causes"]}
ANYA = {p for p, v in TX.items() if {"a_big", "a_small"} & set(v["causes"])}
CORR = {r["pid"]: refs.correct_refs(r["pid"]) for r in F}
HASC = {p for p, c in CORR.items() if c}


def score(name, flagged, pos):
    ids = {r["pid"] for r in F}
    tp, fp = len(flagged & pos), len(flagged - pos)
    fn, tn = len(pos - flagged), len(ids - flagged - pos)
    cost = sorted(flagged & HASC)
    print(f"{name:34s} flagged={len(flagged):2d} TP={tp} FP={fp} FN={fn} TN={tn} "
          f"prec={tp / max(1, tp + fp):.2f} rec={tp / max(1, len(pos)):.2f} | flags on photos with a correct ref: {len(cost)} {cost}")


prim = {r["pid"] for r in F if r["suspect"]}
novis = {r["pid"] for r in F if set(r["flags"]) & {"F-far", "F-low"}}
withx = prim | {r["pid"] for r in F if r["fExif"]}
print(f"dev n={len(F)}  F1 position-stage={len(POS)} {sorted(POS)}  a_big={len(BIG)}  a_any={len(ANYA)}  with correct ref={len(HASC)}")
for lab, pos in (("A position-stage", POS), ("B a_big", BIG), ("C a_big|a_small", ANYA)):
    print(f"-- label {lab}")
    score("primary (far|low|vis)", prim, pos)
    score("far|low only", novis, pos)
    score("primary + F-exif", withx, pos)
    for fl in ("F-far", "F-low", "F-vis"):
        score(f"  {fl} alone", {r["pid"] for r in F if fl in r["flags"]}, pos)
    score("  F-exif alone", {r["pid"] for r in F if r["fExif"]}, pos)

print("\nPer photo")
print(f"{'pid':8s} {'F1':10s} {'ref':3s} {'src':6s} {'flags':16s} {'exif-dem':>8s}  viewpoint -> feature (dist m)  | targets (dist km, vis, offHdg)")
for r in F:
    p = r["pid"]
    f1 = (TX[p]["stage"][:5] + ("/" + ",".join(c for c in TX[p]["causes"] if c.startswith("a")) if any(c.startswith("a") for c in TX[p]["causes"]) else "")) if p in TX else "ok-HIGH"
    vp = "; ".join(f"'{v['text']}'->{v['feature']['name'] if v['feature'] else '?'}({v['feature']['distM']:.0f})" if v["feature"] else f"'{v['text']}'->unresolved" for v in r["viewpoints"]) or "-"
    tg = "; ".join(f"{t['feature']['name']}({t['feature']['distM'] / 1000:.1f},{'v' if t.get('visible') else ('X' if 'visible' in t else '-')},{t.get('offHeading', '-')})" for t in r["targets"]) or "-"
    ex = f"{r['exifMinusGround']:+.0f}" if r["exifMinusGround"] is not None else "-"
    print(f"{p:8s} {f1:10s} {'Y' if p in HASC else '-':3s} {r['positionSource'][:6]:6s} {','.join(r['flags']) or '-':16s} {ex:>8s}  {vp} | {tg}")

print("\nCandidate-eye check (flagged photos)")
for r in F:
    if not r["suspect"]:
        continue
    p = r["pid"]
    for c in r["candidates"]:
        from p1 import hav
        dxy = hav(r["lat"], r["lon"], c["lat"], c["lon"])
        cr = CORR.get(p) or []
        s = (f"correct ref eye(s) at stated lat/lon h={[round(x['eyeH'], 1) if x['eyeH'] else None for x in cr]} -> proposal is {dxy:.0f} m horiz"
             + (f", dh={c['h'] - cr[0]['eyeH']:+.0f} m" if cr and cr[0]['eyeH'] else "") + " from the verified eye (proposal moves AWAY)") if cr else "no verified ref"
        print(f"{p} {c['reason']:40s} -> eye ({c['lat']:.5f},{c['lon']:.5f},{c['h']:.0f}) | stated eye h={r['eye']:.0f} | {s}")
    if not r["candidates"]:
        print(f"{p} {r['flags']} no candidate eye | {'has correct ref' if p in HASC else 'no ref'}")
mx = max(abs(r["eye"] - r["cacheEye"]) for r in F if r["cacheEye"] is not None)
print(f"\nstated-eye recompute vs C0 cache meta.eye: max |diff| = {mx:.2f} m")
