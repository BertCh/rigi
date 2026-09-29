"""Dev-only evaluation of stage-1 records with verdict inheritance (tools/bench/t6/dev_verdicts.json only).

A pose inherits a dev cluster's verdict iff |Δyaw| ≤ 0.5°, |Δpitch| ≤ 0.5° AND its eye is within 2 m of
the cluster's recorded eye (same lat/lon here, so |Δh| ≤ 2 m). Otherwise it is 'pending' (blind pack).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
GT = ROOT / "tools/bench/gt/t6"  # tracked blind ground truth (originals under tools/bench/t6)
V = json.load(open(GT / "dev_verdicts.json"))["photos"]


def dang(a, b):
    return (a - b + 540.0) % 360.0 - 180.0
EYE_TOL_M = 2.0
ANG_TOL = 0.5


_EXTRA = None


def extra_verified(pid: str) -> dict:
    """Blind verdicts given after dev_verdicts.json (dev only): the partial CPU baseline (baseline_cpu_partial.json
    cpu_verdict for rows that did not inherit), the wc_0006 SWEEP_KP=4096 pose, and T6 packs once scored
    (tools/bench/t6/verify/verdicts.json + key.json)."""
    global _EXTRA
    if _EXTRA is None:
        _EXTRA = {}
        t6 = ROOT / "tools/bench/t6"
        try:
            for row in json.load(open(GT / "baseline_cpu_partial.json")):
                if row.get("inherit") or row.get("cpu_verdict") not in ("correct", "wrong", "unsure"):
                    continue
                b = json.load(open(t6 / "baseline_cpu" / f"{row['id']}.json"))
                _EXTRA.setdefault(row["id"], {})["CPU"] = {"pose": b["pose"], "eye": {"h": b["eye"][2]}, "verdict": row["cpu_verdict"]}
        except FileNotFoundError:
            pass
        try:
            v = json.load(open(GT / "verify_cpu_partial/verdict_wc_0006_kp4096.json"))
            b = json.load(open(t6 / "attr_kp/kp4096/wc_0006.json"))
            _EXTRA.setdefault("wc_0006", {})["KP4096"] = {"pose": b["pose"], "eye": {"h": b["eye"][2]}, "verdict": v["verdict"]}
        except FileNotFoundError:
            pass
        try:
            key = json.load(open(GT / "verify/key.json"))
            ver = json.load(open(GT / "verify/verdicts.json"))
            for pid2, k in key.items():
                for lab, c in k["candidates"].items():
                    vp = (ver.get("photos", ver).get(pid2) or {})
                    vv = ((vp.get("candidates", vp).get(lab)) or {}).get("verdict")
                    if vv in ("correct", "wrong", "unsure"):
                        _EXTRA.setdefault(pid2, {})[f"T6{lab}"] = {"pose": c["pose"], "eye": {"h": c["eye"]["h"]}, "verdict": vv}
        except FileNotFoundError:
            pass
    return _EXTRA.get(pid, {})


def inherit(pid: str, pose: dict | None, eye_h: float | None):
    """→ (verdict | 'pending' | None, cluster label)."""
    if pose is None:
        return None, None
    assert pid in V, "dev ids only"
    best = None
    clusters = dict(V[pid]["clusters"])
    cm = V[pid].get("cascadeMapterhorn") or {}
    if cm.get("src") == "blind" and cm.get("verdict") in ("correct", "wrong", "unsure"):
        # the Mapterhorn cascade pose was blind-verified on its own (not a v2 cluster): a verified pose too
        f = ROOT / f"tools/bench/harness/out/runs/wild-cascade-mt/results/{pid}/given.cascade.json"
        if f.exists():
            c = json.load(open(f))
            if c.get("pose") and isinstance(c.get("eye"), (int, float)):
                clusters["CMT"] = {"pose": c["pose"], "eye": {"h": c["eye"]}, "verdict": cm["verdict"]}
    for lab, cl in extra_verified(pid).items():
        clusters[lab] = cl
    for lab, cl in clusters.items():
        dy = abs(dang(pose["yaw"], cl["pose"]["yaw"]))
        dp = abs(pose["pitch"] - cl["pose"]["pitch"])
        if dy <= ANG_TOL and dp <= ANG_TOL:
            ch = (cl.get("eye") or {}).get("h")
            if ch is None or eye_h is None or abs(ch - eye_h) > EYE_TOL_M:
                continue
            if best is None or dy + dp < best[0]:
                best = (dy + dp, lab, cl.get("verdict"))
    if best is None:
        return "pending", None
    return best[2], best[1]


def load_records(d: Path) -> dict:
    out = {}
    for f in sorted(d.glob("wc_*.json")):
        pid = f.stem
        if pid not in V:
            continue  # dev only
        out[pid] = json.load(open(f))
    return out


def fused_of(c):
    return c.get("fused") or {}


def summarize(recs: dict, pick, name: str) -> dict:
    """pick(rec) -> candidate dict (with .fused) or None."""
    rows = []
    for pid, r in recs.items():
        c = pick(r)
        fu = fused_of(c) if c else {}
        pose = fu.get("pose")
        eye_h = (fu.get("eye") or r.get("eye") or [None, None, None])[2]
        v, lab = inherit(pid, pose, eye_h)
        high = fu.get("level") == "high"
        rows.append({"id": pid, "verdict": v, "cluster": lab, "high": high, "source": c.get("source") if c else None,
                     "baselineSeed": r.get("baselineSeed"), "pose": pose, "checks": fu.get("checks"),
                     "basinGap": (fu.get("basinGap") or {}).get("gap"), "exif": r.get("positionSource") == "exif-gps"})
    n = len(rows)
    cnt = lambda f: sum(1 for x in rows if f(x))  # noqa: E731
    s = {"name": name, "n": n,
         "correct": cnt(lambda x: x["verdict"] == "correct"),
         "wrong": cnt(lambda x: x["verdict"] == "wrong"),
         "unsure": cnt(lambda x: x["verdict"] == "unsure"),
         "pending": cnt(lambda x: x["verdict"] == "pending"),
         "high": cnt(lambda x: x["high"]),
         "highCorrect": cnt(lambda x: x["high"] and x["verdict"] == "correct"),
         "highWrong": cnt(lambda x: x["high"] and x["verdict"] == "wrong"),
         "highPending": cnt(lambda x: x["high"] and x["verdict"] == "pending"),
         "highUnsure": cnt(lambda x: x["high"] and x["verdict"] == "unsure")}
    for seed in ("sweep40", "appseeds"):
        sub = [x for x in rows if x["baselineSeed"] == seed]
        s[f"by_{seed}"] = {"n": len(sub), "correct": sum(1 for x in sub if x["verdict"] == "correct"),
                           "pending": sum(1 for x in sub if x["verdict"] == "pending")}
    return {"summary": s, "rows": rows}
