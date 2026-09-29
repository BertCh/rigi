"""Score v2 dev runs (DEV only) against verified refs: arm T6 = the run's stated-eye result, arm v2 = its final.

Verdicts:
  stated-eye poses  → evaluate.inherit (0.5° yaw/pitch + eye within 2 m of a blind-verified dev cluster)
  moved-eye poses   → v2 blind pack verdicts (tools/matcher/v2/verify/verdicts.json: {pid: {"verdict", "eye", "pose"}}),
                      matched by the same 0.5° + 2 m (3-D eye) tolerance; otherwise 'pending'
Rules (as reports/test-prereg.md, with a moved eye never counting as EXIF):
  product = HIGH ∧ (EXIF ∧ eye not moved ∨ Mapterhorn cascade acc75 agrees at the same eye)
  looser  = HIGH ∧ (EXIF ∧ eye not moved ∨ basinGap ≥ 0.20)
    score_v2.py OUTDIR [OUTDIR ...]   → prints tables, writes OUTDIR/score.json
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "stage1"))
import evaluate as EV  # noqa: E402

ROOT = HERE.parents[2]
CMT = {r["id"]: r for r in json.load(open(ROOT / "tools/bench/score/cascade_mt_scores.json"))}
VV = HERE / "verify" / "verdicts.json"
MOVED_V = json.load(open(VV)) if VV.exists() else {}


def dang(a, b):
    return (a - b + 540.0) % 360.0 - 180.0


def eye_dist(a, b):
    dn = (a["lat"] - b["lat"]) * 111195.0
    de = (a["lon"] - b["lon"]) * 111195.0 * math.cos(math.radians(a["lat"]))
    return math.sqrt(dn * dn + de * de + (a["h"] - b["h"]) ** 2)


def cascade(pid):
    f = ROOT / f"tools/bench/harness/out/runs/wild-cascade-mt/results/{pid}/given.cascade.json"
    if not f.exists():
        return None
    c = json.load(open(f))
    return {"pose": c["pose"], "eyeH": c["eye"] if isinstance(c.get("eye"), (int, float)) else None}


def verdict(pid, s, moved):
    if not s.get("pose"):
        return "no-pose"
    if not moved:
        return EV.inherit(pid, s["pose"], (s.get("eye") or {}).get("h"))[0]
    for v in MOVED_V.get(pid, []):
        if (abs(dang(v["pose"]["yaw"], s["pose"]["yaw"])) <= 0.5 and abs(v["pose"]["pitch"] - s["pose"]["pitch"]) <= 0.5
                and eye_dist(v["eye"], s["eye"]) <= 2.0):
            return v["verdict"]
    return "pending"


def row(pid, s, moved, exif):
    v = verdict(pid, s, moved)
    high = s.get("level") == "HIGH"
    cp = cascade(pid)
    c = CMT.get(pid, {})
    agree = bool(not moved and s.get("pose") and cp and c.get("acc75") and abs(dang(s["pose"]["yaw"], cp["pose"]["yaw"])) <= 0.5
                 and abs(s["pose"]["pitch"] - cp["pose"]["pitch"]) <= 0.5 and cp["eyeH"] is not None
                 and abs((s.get("eye") or {}).get("h", 1e9) - cp["eyeH"]) <= 2.0)
    gap = (s.get("checks") or {}).get("basinGap")
    ex = exif and not moved
    return {"id": pid, "verdict": v, "high": high, "moved": moved, "exif": exif, "agree": agree,
            "product": high and (ex or agree), "looser": high and (ex or (gap is not None and gap >= 0.20))}


def agg(rows, solvable):
    k = lambda f: sum(1 for r in rows if f(r))  # noqa: E731
    out = {"n": len(rows), "correct": k(lambda r: r["verdict"] == "correct"),
           "wrong": k(lambda r: r["verdict"] == "wrong"), "pending": k(lambda r: r["verdict"] == "pending")}
    for flag in ("high", "product", "looser"):
        acc = [r for r in rows if r[flag]]
        out[flag] = {"acc": len(acc), "correct": sum(r["verdict"] == "correct" for r in acc),
                     "wrong": sum(r["verdict"] in ("wrong", "no-pose") for r in acc),
                     "unsure": sum(r["verdict"] == "unsure" for r in acc), "pending": sum(r["verdict"] == "pending" for r in acc),
                     "recall": f"{sum(r['verdict'] == 'correct' for r in acc if r['id'] in solvable)}/{len(solvable)}"}
    ex = [r for r in rows if r["exif"] and r["high"] and not r["moved"]]
    out["exifHigh"] = {"acc": len(ex), "correct": sum(r["verdict"] == "correct" for r in ex), "wrong": sum(r["verdict"] == "wrong" for r in ex)}
    mv = [r for r in rows if r["moved"]]
    out["moved"] = {"n": len(mv), "high": sum(r["high"] for r in mv), "highCorrect": sum(r["high"] and r["verdict"] == "correct" for r in mv),
                    "highWrong": sum(r["high"] and r["verdict"] == "wrong" for r in mv), "highPending": sum(r["high"] and r["verdict"] in ("pending", "unsure") for r in mv)}
    return out


def main():
    for od in map(Path, sys.argv[1:]):
        recs = {f.stem: json.load(open(f)) for f in sorted(od.glob("wc_*.json")) if f.stem in EV.V}
        man = {e["id"]: e for e in json.load(open(ROOT / "tools/bench/data/manifest.json"))}
        A, B = [], []
        for pid, r in recs.items():
            if r.get("error"):
                print("ERROR", pid, r["error"][:120])
                continue
            exif = man[pid].get("positionSource") == "exif-gps"
            A.append(row(pid, r["stated"]["summary"], False, exif))
            fi = r["final"]
            B.append(row(pid, fi, bool(fi.get("eyeMoved")), exif))
        solvable = {p for p in EV.V if any(c.get("verdict") == "correct" for c in EV.V[p]["clusters"].values())
                    or (EV.V[p].get("cascadeMapterhorn") or {}).get("verdict") == "correct"
                    or any(c.get("verdict") == "correct" for c in EV.extra_verified(p).values())}
        solvable |= {r["id"] for r in A + B if r["verdict"] == "correct"}
        res = {"dir": str(od), "nSolvable": len(solvable), "t6_stated": agg(A, solvable), "v2_final": agg(B, solvable),
               "rows": {"t6": A, "v2": B}, "timing": {pid: {"totalMs": r.get("timingMs"), "fallbackMs": r.get("eyeProbeMs"),
                                                             "moved": bool(r.get("final", {}).get("eyeMoved"))} for pid, r in recs.items()}}
        json.dump(res, open(od / "score.json", "w"), indent=1)
        print(od, "photos", len(recs), "solvable", len(solvable))
        for k in ("t6_stated", "v2_final"):
            print(" ", k, json.dumps(res[k]))
        for r in B:
            if r["moved"] or r["verdict"] == "pending":
                print("   moved/pending:", r)


if __name__ == "__main__":
    main()
