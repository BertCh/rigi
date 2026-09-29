"""Verified reference poses on DEV (+ GT-12) for v2 experiments. Read-only over tools/bench/gt/t6 (dev only).

    correct_refs(pid) -> [{"pose": {yaw,pitch,roll,vfov}, "eyeH": float|None, "label": str}]   (verdict == correct)
    wrong_refs(pid)   -> same for verdict == wrong
"""
from __future__ import annotations
import json, sys
from pathlib import Path
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "stage1"))
import evaluate as EV  # noqa: E402


def _all(pid: str):
    assert pid in EV.V, "dev ids only"
    cl = dict(EV.V[pid]["clusters"])
    cm = EV.V[pid].get("cascadeMapterhorn") or {}
    if cm.get("src") == "blind" and cm.get("verdict"):
        f = EV.ROOT / f"tools/bench/harness/out/runs/wild-cascade-mt/results/{pid}/given.cascade.json"
        if f.exists():
            c = json.load(open(f))
            if c.get("pose") and isinstance(c.get("eye"), (int, float)):
                cl["CMT"] = {"pose": c["pose"], "eye": {"h": c["eye"]}, "verdict": cm["verdict"]}
    cl.update(EV.extra_verified(pid))
    return [{"pose": c["pose"], "eyeH": (c.get("eye") or {}).get("h"), "label": k, "verdict": c.get("verdict")} for k, c in cl.items()]


def correct_refs(pid):
    return [r for r in _all(pid) if r["verdict"] == "correct"]


def wrong_refs(pid):
    return [r for r in _all(pid) if r["verdict"] == "wrong"]


def dev_ids():
    return sorted(EV.V)


if __name__ == "__main__":
    n = 0
    for p in dev_ids():
        c = correct_refs(p)
        n += bool(c)
        print(p, len(c), [round(r["pose"]["yaw"], 1) for r in c])
    print("dev photos with a correct ref:", n)
