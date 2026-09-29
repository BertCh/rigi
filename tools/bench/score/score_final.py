#!/usr/bin/env python3
"""Pre-registered test-set scoring (reports/test-prereg.md).

  python3 tools/bench/score/score_final.py pack     # inherit verdicts, build ONE mixed blinded pack (+ decoys)
  python3 tools/bench/score/score_final.py score    # after verdicts are in: all pre-registered metrics

Inputs (read-only):
  tools/bench/final/out/{A,B,C}/<id>.json            arm records (tools/bench/final/run_arm.sh)
  tools/bench/split.json                              test ids
  tools/bench/data/manifest.json                      strata (positionSource, skylineDist, headingKnown)
  tools/bench/gt/wild/verify_v2/key_v2.json + tools/bench/score/wild_scores_v2.json
                                                      v2 clusters (pose, eye) with their blind verdicts
  tools/bench/score/cascade_mt_scores.json + wild-cascade-mt results
                                                      Mapterhorn cascade poses, verdicts, acc75 (agreement input)
Pack output: tools/bench/final/verify/{index.json, key.json, inherit.json, <cand>.jpg}
Verdicts expected: tools/bench/final/verify/verdicts/part_*.json (blind, same schema as the wild packs)
Scoring reads the tracked copy of the pack key/inherit/verdicts from tools/bench/gt/final/verify/ (pack still writes to final/verify).
Score output: tools/bench/final/scores.json and a markdown report on stdout.
"""
import glob
import json
import math
import os
import random
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../.."))
FIN = os.path.join(ROOT, "tools/bench/final")
VER = os.path.join(FIN, "verify")  # pack output (overlays, index/key/inherit as written)
GT = os.path.join(ROOT, "tools/bench/gt")  # tracked blind ground truth
GT_VER = os.path.join(GT, "final/verify")
ARMS = ["A", "B", "C"]
TOL_DEG, TOL_EYE = 0.5, 2.0


def load(p):
    with open(p) as f:
        return json.load(f)


def dyaw(a, b):
    return abs(((a - b) % 360 + 540) % 360 - 180)


def same(p, eye_h, q, q_eye_h):
    return (dyaw(p["yaw"], q["yaw"]) <= TOL_DEG and abs(p["pitch"] - q["pitch"]) <= TOL_DEG
            and eye_h is not None and q_eye_h is not None and abs(eye_h - q_eye_h) <= TOL_EYE)


def wilson(k, n, z=1.96):
    if n == 0:
        return None
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return [round(max(0, c - h), 3), round(min(1, c + h), 3)]


def test_ids():
    return load(os.path.join(ROOT, "tools/bench/split.json"))["test"]


def arm_records():
    out = {}
    for a in ARMS:
        for f in glob.glob(os.path.join(FIN, "out", a, "wc_*.json")):
            r = load(f)
            out[(a, r["id"])] = r
    return out


def known_verdicts():
    """Existing verified poses per photo: v2 clusters and the Mapterhorn cascade (all blind-verified)."""
    key = load(os.path.join(GT, "wild/verify_v2/key_v2.json"))
    key = key.get("photos", key)
    rows = {r["id"]: r for r in load(os.path.join(ROOT, "tools/bench/score/wild_scores_v2.json"))["rows"]}
    known = {}
    for pid, e in key.items():
        lst = []
        for lab, c in e["clusters"].items():
            if lab == "P":
                continue
            v = next((m["verdict"] for m in rows[pid]["methods"].values() if m["cluster"] == lab), None)
            if v in ("correct", "wrong", "unsure"):
                lst.append({"pose": c["pose"], "eyeH": (c.get("eye") or {}).get("h"), "verdict": v, "src": f"v2:{lab}"})
        known[pid] = lst
    cmt = {r["id"]: r for r in load(os.path.join(ROOT, "tools/bench/score/cascade_mt_scores.json"))}
    for pid, r in cmt.items():
        rec = os.path.join(ROOT, f"tools/bench/harness/out/runs/wild-cascade-mt/results/{pid}/given.cascade.json")
        if os.path.exists(rec) and r["verdict"] in ("correct", "wrong", "unsure"):
            c = load(rec)
            known.setdefault(pid, []).append({"pose": c["pose"], "eyeH": _eye_h(c.get("eye")),
                                              "verdict": r["verdict"], "src": "cascade-mt"})
    return known, cmt


def _eye_h(eye):
    """Cascade records store the eye as an absolute height (float); arm records as {lat, lon, h}."""
    if isinstance(eye, (int, float)):
        return float(eye)
    return eye.get("h") if isinstance(eye, dict) else None


def cascade_pose(pid):
    rec = os.path.join(ROOT, f"tools/bench/harness/out/runs/wild-cascade-mt/results/{pid}/given.cascade.json")
    if not os.path.exists(rec):
        return None
    c = load(rec)
    return {"pose": c["pose"], "eyeH": _eye_h(c.get("eye"))}


# ---------------------------------------------------------------- pack

def cmd_pack():
    ids = test_ids()
    recs = arm_records()
    known, _ = known_verdicts()
    man = {e["id"]: e for e in load(os.path.join(ROOT, "tools/bench/data/manifest.json"))}
    inherit, need = {}, {}
    for (a, pid), r in sorted(recs.items()):
        if pid not in ids or not r.get("pose") or r.get("status") != "ok":
            continue
        p, h = r["pose"], (r.get("eye") or {}).get("h")
        hit = next((k for k in known.get(pid, []) if same(p, h, k["pose"], k["eyeH"])), None)
        if hit:
            inherit[f"{a}:{pid}"] = {"verdict": hit["verdict"], "src": hit["src"]}
            continue
        # arms that landed on the same new pose share one candidate
        grp = need.setdefault(pid, [])
        g = next((g for g in grp if same(p, h, g["pose"], g["eyeH"])), None)
        if g:
            g["arms"].append(a)
        else:
            grp.append({"pose": p, "eyeH": h, "eye": r.get("eye"), "arms": [a]})
    rng = random.Random(20260926)
    cands = []
    for pid, grp in need.items():
        for g in grp:
            cands.append({"pid": pid, **g})
    n_decoy = max(5, round(0.1 * len(cands)))
    decoys = [dict(c, decoyOf=None) for c in rng.sample(cands, min(n_decoy, len(cands)))]
    allc = [dict(c, decoy=False) for c in cands] + [dict(c, decoy=True) for c in decoys]
    rng.shuffle(allc)
    os.makedirs(VER, exist_ok=True)
    index, key = {}, {}
    for i, c in enumerate(allc):
        cid = f"t{rng.randrange(16**6):06x}"
        while cid in key:
            cid = f"t{rng.randrange(16**6):06x}"
        e = man[c["pid"]]
        p = c["pose"]
        out = os.path.join(VER, f"{cid}.jpg")
        eye = c.get("eye") or {}
        args = ["npx", "tsx", "tools/bench/harness/overlay.ts", "--photo", os.path.join("tools/bench/data", e["file"]),
                "--lat", str(e["lat"]), "--lon", str(e["lon"]), "--eye-h", str(c["eyeH"]),
                "--pose", f"{p['yaw']},{p['pitch']},{p['roll']},{p['vfov']}",
                "--title", f"candidate {cid}", "--out", out]
        if eye.get("lat") is not None:
            args += ["--eye-lat", str(eye["lat"]), "--eye-lon", str(eye["lon"])]
        subprocess.run(args, cwd=ROOT, check=True, capture_output=True, timeout=600)
        index[cid] = {"photo": os.path.relpath(os.path.join(ROOT, "tools/bench/data", e["file"]), VER), "overlay": f"{cid}.jpg"}
        key[cid] = {"pid": c["pid"], "arms": c["arms"], "pose": p, "eyeH": c["eyeH"], "decoy": c["decoy"]}
        print(f"{i + 1}/{len(allc)} {cid}", flush=True)
    json.dump({"about": "Blinded candidates, one overlay each (DEM skyline + peaks at a candidate pose). Arms, confidence and decoy status are hidden.",
               "candidates": index}, open(os.path.join(VER, "index.json"), "w"), indent=1)
    json.dump(key, open(os.path.join(VER, "key.json"), "w"), indent=1)
    json.dump(inherit, open(os.path.join(VER, "inherit.json"), "w"), indent=1)
    print(f"inherited {len(inherit)} arm-poses; blind candidates {len(cands)} + {len(decoys)} decoys = {len(allc)}")


# ---------------------------------------------------------------- score

def pack_verdicts():
    """cid -> merged verdict; two verifiers disagreeing -> unsure. Also verifier consistency on decoys."""
    per = {}
    for f in glob.glob(os.path.join(GT_VER, "verdicts", "part_*.json")):
        for cid, v in load(f)["candidates"].items():
            per.setdefault(cid, []).append(v["verdict"])
    merged = {cid: (vs[0] if len(set(vs)) == 1 else "unsure") for cid, vs in per.items()}
    pairs = [vs for vs in per.values() if len(vs) >= 2]
    return merged, {"overlapPairs": len(pairs), "agree": sum(len(set(v[:2])) == 1 for v in pairs)}


def cmd_score():
    ids = test_ids()
    recs = arm_records()
    man = {e["id"]: e for e in load(os.path.join(ROOT, "tools/bench/data/manifest.json"))}
    _, cmt = known_verdicts()
    inherit = load(os.path.join(GT_VER, "inherit.json"))
    key = load(os.path.join(GT_VER, "key.json"))
    merged, overlap = pack_verdicts()
    # decoy consistency: decoy cid vs its original cid (same pid, pose)
    dec = []
    for cid, k in key.items():
        if k["decoy"]:
            orig = next((c for c, o in key.items() if not o["decoy"] and o["pid"] == k["pid"] and o["pose"] == k["pose"]), None)
            if orig and cid in merged and orig in merged:
                dec.append(merged[cid] == merged[orig])
    verdict = {}
    for cid, k in key.items():
        if k["decoy"]:
            continue
        for a in k["arms"]:
            verdict[(a, k["pid"])] = merged.get(cid, "unjudged")
    for ak, v in inherit.items():
        a, pid = ak.split(":")
        verdict[(a, pid)] = v["verdict"]
    # photos with any verified-correct pose (any arm, the cascade, or earlier v2 methods)
    v2rows = {r["id"]: r for r in load(os.path.join(ROOT, "tools/bench/score/wild_scores_v2.json"))["rows"]}
    solvable = {pid for pid in ids if v2rows[pid]["anyCorrect"] or cmt.get(pid, {}).get("verdict") == "correct"
                or any(verdict.get((a, pid)) == "correct" for a in ARMS)}

    def row(a, pid):
        r = recs.get((a, pid))
        e = man[pid]
        ok = bool(r and r.get("status") == "ok" and r.get("pose"))
        v = verdict.get((a, pid), "no-pose") if ok else "no-pose"
        high = ok and str(r.get("confidenceLevel", "")).lower() == "high"
        exif = e.get("positionSource") == "exif-gps"
        cp = cascade_pose(pid)
        c = cmt.get(pid, {})
        agree = bool(ok and cp and c.get("acc75") and same(r["pose"], (r.get("eye") or {}).get("h"), cp["pose"], cp["eyeH"]))
        gap = (r or {}).get("basinGap")
        return {"id": pid, "arm": a, "verdict": v, "high": high, "exif": exif, "agree": agree,
                "product": high and (exif or agree), "looser": high and (exif or (gap is not None and gap >= 0.20)),
                "gross": high and v == "wrong", "timeout": bool(r and r.get("timeout")),
                "wall": (r or {}).get("wallSec"), "pos": e.get("positionSource"),
                "dist": e["tags"].get("skylineDist"), "heading": bool(e["tags"].get("headingKnown"))}

    def agg(rows):
        n = len(rows)
        cor = sum(r["verdict"] == "correct" for r in rows)
        sol = [r for r in rows if r["id"] in solvable]

        def prec(flag):
            acc = [r for r in rows if r[flag]]
            k = sum(r["verdict"] == "correct" for r in acc)
            w = sum(r["verdict"] in ("wrong", "no-pose") for r in acc)
            rec_k = sum(r["verdict"] == "correct" for r in sol if r[flag])
            return {"accepted": len(acc), "correct": k, "wrong": w, "unsure": len(acc) - k - w,
                    "precision": round(k / (k + w), 3) if k + w else None, "precisionCI": wilson(k, k + w),
                    "recall": f"{rec_k}/{len(sol)}", "recallCI": wilson(rec_k, len(sol))}
        walls = sorted(r["wall"] for r in rows if r["wall"] is not None)
        return {"n": n, "correct": cor, "correctCI": wilson(cor, n), "HIGH": prec("high"),
                "grossHIGH": sum(r["gross"] for r in rows), "product": prec("product"), "looser": prec("looser"),
                "timeouts": sum(r["timeout"] for r in rows),
                "wallMedian": walls[len(walls) // 2] if walls else None,
                "wallP90": walls[int(0.9 * (len(walls) - 1))] if walls else None}

    strata = {"all": lambda r: True, "exif": lambda r: r["exif"], "manual": lambda r: not r["exif"],
              "near": lambda r: r["dist"] == "near", "far": lambda r: r["dist"] == "far",
              "headingKnown": lambda r: r["heading"], "headingUnknown": lambda r: not r["heading"]}
    res = {a: {s: agg([x for x in (row(a, pid) for pid in ids) if f(x)]) for s, f in strata.items()} for a in ARMS}
    A, B, C = res["A"], res["B"], res["C"]

    def passbar(X):
        e = X["exif"]["HIGH"]
        return {"exifHighPrecisionGe095": e["precision"] is not None and e["precision"] >= 0.95,
                "exifGrossZero": X["exif"]["grossHIGH"] == 0,
                "productPrecision1": X["all"]["product"]["precision"] == 1.0,
                "productRecallGeA": int(X["all"]["product"]["recall"].split("/")[0]) >= int(A["all"]["product"]["recall"].split("/")[0]),
                "manualGrossNotAboveA": X["manual"]["grossHIGH"] <= A["manual"]["grossHIGH"]}
    pb = {"B": passbar(B), "C": passbar(C)}
    pb["B"]["PASS"] = all(pb["B"].values())
    pb["C"]["PASS"] = all(pb["C"].values()) and C["all"]["correct"] > B["all"]["correct"]
    L = B["all"]["looser"]
    looser_ok = L["precision"] == 1.0 and B["all"]["grossHIGH"] == 0 and \
        int(L["recall"].split("/")[0]) > int(B["all"]["product"]["recall"].split("/")[0])
    out = {"preregSha1": open(os.path.join(FIN, "out", "drive.log")).readline().split()[0],
           "solvable": len(solvable), "verifier": {**overlap, "decoys": len(dec), "decoyConsistent": sum(dec)},
           "results": res, "passBar": pb, "looserRuleAdopt": looser_ok}
    json.dump(out, open(os.path.join(FIN, "scores.json"), "w"), indent=1)
    print(json.dumps({k: out[k] for k in ("preregSha1", "solvable", "verifier", "passBar", "looserRuleAdopt")}, indent=1))
    for a in ARMS:
        x = res[a]["all"]
        print(f"arm {a}: correct {x['correct']}/{x['n']} CI{x['correctCI']} | HIGH {x['HIGH']['correct']}/{x['HIGH']['accepted']} "
              f"prec {x['HIGH']['precision']} CI{x['HIGH']['precisionCI']} gross {x['grossHIGH']} | product {x['product']} | "
              f"looser {x['looser']} | timeouts {x['timeouts']} wall med {x['wallMedian']} p90 {x['wallP90']}")


if __name__ == "__main__":
    {"pack": cmd_pack, "score": cmd_score}[sys.argv[1]]()
