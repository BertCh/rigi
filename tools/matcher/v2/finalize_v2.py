# Rigi
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: Copyright (c) Rigi contributors
"""v2 finalisation as pure functions (no worker, no rendering, no matching): the frozen v2 constants, the record
summary and the cross-eye decision that turns per-eye T6 records into the photo's final record.

run_v2.run_photo_v2 calls decide_moved_eye after it has produced the stated-eye record and the per-eye records;
tools/matcher/v2/dryrun_suggest_only.py replays cached dev records through the same function. Behaviour is
exactly what run_v2.py did inline before this module existed (constants unchanged; see reports/v3-prereg.md).
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "stage1"))
import rule as R  # noqa: E402

EYE_MIN_INL = 100
EYE_RATIO = 3.0
EYE_TOP = 2
EYE_MARGIN = 1.5
AMBIG_DEG = R.AMBIG_DEG


def summarize(rec: dict) -> dict:
    c = R.select(rec)
    if c is None:
        return {"pose": None, "level": "LOW", "source": None}
    lvl, checks = R.confidence(rec, c)
    return {"pose": c["fused"]["pose"], "level": lvl, "source": c.get("source"), "checks": checks,
            "support": R._sup(c), "inliers": R._inl(c), "eye": rec_eye(rec)}


def rec_eye(rec: dict) -> dict | None:
    """The exact eye every render of this record used: the record's lat/lon + the worker's eye height (ENU z)."""
    e = rec.get("eye")
    if not e:
        return None
    return {"lat": rec["lat"], "lon": rec["lon"], "h": float(e[2])}


def decide_moved_eye(rec0: dict, base: int, probes: list, eye_results: list, final: dict, suggest_only: bool) -> dict:
    """Cross-eye decision. eye_results = [(probe, per-eye T6 record, summarize(record))]; `final` is the stated-eye
    summary (+ eyeMoved False). Returns the final dict: the moved-eye result when it passes the gates and
    suggest_only is off, else `final` (stated eye) with a LOW `suggestion` when any eye was tried. Mutates the
    summaries (adds `vetoed`) like the inline code did."""
    strong_poses = [(("stated", 0.0, 0.0), c["fused"]["pose"]) for c in R.verified(rec0) if R.strong(c)]
    for p, rk, _ in eye_results:
        strong_poses += [((p["why"], p["e"], p["n"]), c["fused"]["pose"]) for c in R.verified(rk) if R.strong(c)]
    best = None
    for p, rk, sm in eye_results:
        if sm["level"] != "HIGH":
            continue
        others = [q for q in probes if q is not p]
        runner = max([base] + [q["best"] for q in others])
        margin_ok = p["best"] >= EYE_MARGIN * max(1, runner)
        amb = [k for k, pose in strong_poses if (k[1], k[2]) != (p["e"], p["n"]) and R._dist(pose, sm["pose"]) > AMBIG_DEG]
        if margin_ok and not amb:
            best = (p, sm)
            break
        sm["vetoed"] = {"marginOk": margin_ok, "ambiguousWith": amb}
    if best and not suggest_only:
        p, sm = best
        final = {**sm, "eyeMoved": True, "moveM": round(math.hypot(p["e"], p["n"]), 1), "eyeWhy": p["why"],
                 "eyeLatLon": [p["lat"], p["lon"]]}
    elif eye_results:
        # no accepted moved eye: report the stated result and expose a moved-eye pose as a LOW suggestion
        # (the gated HIGH one if any — V2_SUGGEST_ONLY — else the best-supported eye)
        p, rk, sm = next(((q, r, m) for q, r, m in eye_results if best and q is best[0]), eye_results[0])
        final["suggestion"] = {"pose": sm["pose"], "level": "LOW", "levelAtEye": sm["level"], "eye": sm.get("eye"),
                               "eyeLatLon": [p["lat"], p["lon"]],
                               "moveM": round(math.hypot(p["e"], p["n"]), 1), "sweepBest": p["best"]}
    return final


def position_trusted(entry: dict, final: dict) -> bool:
    return (entry.get("positionSource") == "exif-gps") and not final.get("eyeMoved")
