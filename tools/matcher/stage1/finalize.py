"""Raw stage-1 records → final per-photo poses in the tools/bench/t5 shape.

  python finalize.py --raw tools/bench/t6/out/raw --out tools/bench/t6/out [ids...]

Selection policy and confidence rule are the FROZEN ones (rule.py; sha1 in tools/bench/t6/RULE_FROZEN.sha1).
Output <out>/<id>.json:
  {id, pose{yaw,pitch,roll,vfov}, eye{lat,lon,h}, eyeEnu, confidenceLevel HIGH|LOW, checks{…, failed[]},
   source (generator of the chosen hypothesis), baseline{pose, confidenceLevel} (what the service would return),
   stage1{nCandidates, verified, sources}, timingMs}
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rule as R  # noqa: E402


def final_record(rec: dict) -> dict:
    pid = rec["id"]
    if "error" in rec and not rec.get("candidates"):
        return {"id": pid, "ok": False, "error": rec["error"]}
    c = R.select(rec)
    b = R.baseline(rec)
    if c is None:
        return {"id": pid, "ok": False, "error": "no verified hypothesis"}
    fu = c["fused"]
    lvl, checks = R.confidence(rec, c)
    eye = fu.get("eye") or rec.get("eye")
    out = {
        "id": pid, "ok": True,
        "pose": fu["pose"],
        "eye": {"lat": rec["lat"], "lon": rec["lon"], "h": eye[2]},
        "eyeEnu": eye,
        "confidenceLevel": lvl,
        "checks": checks,
        "source": c["source"], "alsoFrom": c.get("alsoFrom", []),
        "fusedLevelApriori": fu.get("level", "").upper(),
        "baseline": ({"pose": b["fused"]["pose"], "confidenceLevelApriori": (b["fused"].get("level") or "").upper(), "seed": rec.get("baselineSeed")}
                     if b else None),
        "stage1": {"nCandidates": rec.get("nCandidates"), "verified": len(R.verified(rec)),
                   "sources": sorted({x["source"] for x in R.verified(rec)}), "positionSource": rec.get("positionSource"),
                   "focalKnown": rec.get("focalKnown"), "hfov0": rec.get("hfov0")},
        "timingMs": rec.get("timingMs"),
        "rule": {"id": R.RULE_ID, "sha1": R.rule_sha1()},
        "codeStamp": rec.get("codeStamp"),
    }
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("ids", nargs="*")
    a = ap.parse_args()
    frozen = (Path(__file__).resolve().parents[3] / "tools/bench/t6/RULE_FROZEN.sha1").read_text().split()[0]
    if R.rule_sha1() != frozen:
        raise SystemExit(f"rule.py RULE block sha1 {R.rule_sha1()} != frozen {frozen}: refusing")
    raw, out = Path(a.raw), Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    files = [raw / f"{i}.json" for i in a.ids] if a.ids else sorted(raw.glob("*.json"))
    for f in files:
        if not f.exists():
            print(f"{f.stem}: no raw record", file=sys.stderr)
            continue
        r = final_record(json.load(open(f)))
        json.dump(r, open(out / f"{f.stem}.json", "w"), indent=1, default=float)
        print(f.stem, r.get("confidenceLevel"), r.get("source"), r.get("error", ""))


if __name__ == "__main__":
    main()
