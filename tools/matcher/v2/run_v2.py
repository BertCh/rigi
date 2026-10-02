"""v2 pipeline = T6 (stage1/pipeline.run_photo at the stated eye) + an eye-position fallback.

Why: on the wild dev set most photos with 0 match support anywhere are not matcher failures. The stated
eye (hand-placed Commons pin, drifting EXIF, pin a few metres below a summit) sits where near terrain hides
the real view, so every render at that eye is the wrong picture (reports/matching-v2.md).

Flow per photo
  1. T6 at the stated eye → select + confidence (rule.py, unchanged).
  2. If not HIGH: viewpoint candidates (viewpoints.candidates: local high points, open spots; photo-independent)
     → FOV-aware fine sweep (pipeline.fine_sweep) at each → best window inliers per eye.
  3. Eyes whose best inliers ≥ max(EYE_MIN_INL, EYE_RATIO × stated best) → full T6 at that eye (top EYE_TOP).
  4. Choose across eyes. A moved-eye result is HIGH only if HIGH under rule.py at that eye AND no other eye
     (stated included) holds a strong candidate > AMBIG_DEG away (cross-eye ambiguity), AND the eye's sweep
     evidence beats the runner-up eye by EYE_MARGIN. positionTrusted is always false for a moved eye.

Usage: run_v2.py OUTDIR id ...   (dev ids only unless V2_ALLOW_TEST=1)
"""
from __future__ import annotations

import json
import math
import os
import sys
import time
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "stage1"))
sys.path.insert(0, str(HERE))
import s1  # noqa: E402
import pipeline as PL  # noqa: E402
import rule as R  # noqa: E402
import finalize_v2 as F  # noqa: E402

sys.path.insert(0, str(HERE.parents[1] / "bench/final"))
import stamps as ST  # noqa: E402  arm code stamps (arm "V2": run_v2 + finalize_v2 + viewpoints + stage-1 code)
from finalize_v2 import AMBIG_DEG, EYE_MARGIN, EYE_MIN_INL, EYE_RATIO, EYE_TOP, rec_eye, summarize  # noqa: E402,F401
import viewpoints as VP  # noqa: E402

# EYE_* constants, summarize/rec_eye and the cross-eye decision live in finalize_v2 (pure, replayable without the worker)

STATED_DIR = os.environ.get("V2_STATED_DIR")
MATCHER = os.environ.get("V2_MATCHER", "aliked")  # aliked (T6 default) | loma (LoMa-B 4096, MPS fp32; loma/REPORT.md)
NO_FALLBACK = os.environ.get("V2_NO_FALLBACK") == "1"
SUGGEST_ONLY = os.environ.get("V2_SUGGEST_ONLY") == "1"  # moved-eye results are never accepted (reports/matching-v2.md §3)
PRIORS = [x for x in os.environ.get("V2_PRIORS", "").split(",") if x]  # "", "pitch", "focal", "pitch,focal"
_CUR = {"pid": None, "fk": True}


def use_loma():
    """Route every s1.correspond (sweep40, fine sweep, narrow, stage-2 verification) through LoMa."""
    os.environ.setdefault("LOMA_DEVICE", "mps")
    os.environ.setdefault("LOMA_PREC", "fp32")
    os.environ.setdefault("LOMA_KP", "4096")
    sys.path.insert(0, str(HERE / "loma"))
    import matcher as LM  # noqa: E402

    def corr(photo, views, eye, kind="aliked", style="sat", max_side=None, max_kp=None):
        assert style == "sat" and not max_side, "LoMa flag supports the T6 call pattern only"
        return LM.correspond_loma(photo, views, eye, num_kp=int(os.environ["LOMA_KP"]))

    s1.correspond = corr


def use_priors():
    import priors as P
    P.patch_skyglobal(lambda: P.pred(_CUR["pid"], focal_known=_CUR["fk"]), "pitch" in PRIORS, "focal" in PRIORS)  # reuse stamped T6 stated-eye records (e.g. tools/bench/t6/out/raw)


def stated_record(w, pid, e):
    if STATED_DIR:
        f = Path(STATED_DIR) / f"{pid}.json"
        if f.exists():
            r = json.load(open(f))
            if ((r.get("codeStamp") or {}).get("sha1") == s1.code_stamp()["sha1"] and r.get("lat") == e["lat"] and r.get("lon") == e["lon"]
                    and r.get("matcher", "aliked") == MATCHER and r.get("priors", []) == PRIORS):
                r["reused"] = str(f)
                return r
    return run_t6(w, pid, e)


def run_t6(w, pid, e):
    r = PL.run_photo(w, pid, entry=e)
    r["matcher"], r["priors"] = MATCHER, PRIORS
    return r


def stated_sweep_best(rec: dict) -> int:
    hy = (rec.get("candidates") or [])
    fs = [c.get("inliers", 0) for c in hy if c.get("source") in ("sweepfine", "sweep40", "narrow", "narrowalt")]
    return int(max(fs, default=0))


def probe_eyes(w, pid, entry, cands):
    out = []
    saved = PL.UNKNOWN_HFOVS
    if "focal" in PRIORS and not _CUR["fk"]:
        import priors as P
        pp = P.pred(pid, focal_known=False)
        if pp and pp.get("vfovAny"):
            ph0 = s1.Photo(pid, entry)
            PL.UNKNOWN_HFOVS = (P.hfov(pp["vfovAny"], ph0.aspect),)  # one AnyCalib FOV instead of 40° and 62°
            ph0.cleanup()
    try:
        return _probe(w, pid, entry, cands, out)
    finally:
        PL.UNKNOWN_HFOVS = saved


def _probe(w, pid, entry, cands, out):
    for c in cands:
        ent = {**entry, "lat": c["lat"], "lon": c["lon"], "altitudeM": None}
        ph = s1.Photo(pid, ent)
        se = s1.Session(w, ph)
        r = {k: c[k] for k in ("why", "e", "n", "ground", "open", "lat", "lon")}
        for _ in range(3):
            try:
                eye = se.render(poses=[{"yaw": 0, "pitch": 0, "roll": 0, "vfov": ph.vfov0}])[2]["eye"]
                hy, _, info = PL.fine_sweep(se, ph, eye)
                r.update({"best": max((h["inliers"] for h in hy), default=0), "hyps": hy, "ms": info["ms"]})
                break
            except Exception as ex:  # noqa: BLE001
                r["error"] = f"{type(ex).__name__}: {ex}"
        r.setdefault("best", 0)
        se.close()
        ph.cleanup()
        out.append(r)
    return out


_ARM = {}


def arm_stamp() -> dict:
    """Arm stamp (stamps.py, arm V2), computed once per process and embedded in every output record."""
    if "s" not in _ARM:
        _ARM["s"] = ST.full_stamp("V2")
    return _ARM["s"]


def run_photo_v2(w, pid: str, entry: dict | None = None) -> dict:
    e = entry or s1.manifest()[pid]
    t0 = time.time()
    _CUR["pid"] = pid
    if PRIORS:
        _ph = s1.Photo(pid, e)
        _CUR["fk"] = _ph.focal_known
        _ph.cleanup()
    out = {"id": pid, "matcher": MATCHER, "priors": PRIORS, "positionSource": e.get("positionSource"), "codeStamp": s1.code_stamp(), "armStamp": arm_stamp(), "ruleSha1": R.rule_sha1()}
    rec0 = stated_record(w, pid, e)
    out["stated"] = {"reused": rec0.get("reused"), "summary": summarize(rec0), "sweepBest": stated_sweep_best(rec0), "timingMs": rec0.get("timingMs"),
                     "error": rec0.get("error")}
    out["recs"] = {"stated": rec0}
    final = {**out["stated"]["summary"], "eyeMoved": False}
    if final["level"] != "HIGH" and not NO_FALLBACK:
        ts = time.time()
        vps = VP.candidates(e["lat"], e["lon"])[1:]
        probes = probe_eyes(w, pid, e, vps)
        out["eyeProbe"] = [{k: v for k, v in p.items() if k != "hyps"} for p in probes]
        base = out["stated"]["sweepBest"]
        good = sorted([p for p in probes if p["best"] >= max(EYE_MIN_INL, EYE_RATIO * base)], key=lambda p: -p["best"])
        out["eyeProbeMs"] = round((time.time() - ts) * 1000)
        eye_results = []
        for p in good[:EYE_TOP]:
            # a moved eye is an untrusted position: never inherit the EXIF exemption from the basin-gap check
            ent = {**e, "lat": p["lat"], "lon": p["lon"], "altitudeM": None, "positionSource": "moved"}
            rk = run_t6(w, pid, ent)
            out["recs"][f"eye:{p['why']}:{round(p['e'])},{round(p['n'])}"] = rk
            eye_results.append((p, rk, summarize(rk)))
        final = F.decide_moved_eye(rec0, base, probes, eye_results, final, SUGGEST_ONLY)
        out["eyeResults"] = [{"eye": {k: p[k] for k in ("why", "e", "n", "lat", "lon", "best")}, "summary": sm} for p, _, sm in eye_results]
    out["final"] = final
    out["positionTrusted"] = F.position_trusted(e, final)
    out["timingMs"] = round((time.time() - t0) * 1000)
    return out


def main():
    od = Path(sys.argv[1])
    od.mkdir(parents=True, exist_ok=True)
    (od / "raw").mkdir(exist_ok=True)
    ids = sys.argv[2:]
    header = ST.header_line(arm_stamp(), os.environ.get("PREREG_SHA1"))
    print(header, flush=True)
    with open(od / "run.log", "a") as lg:
        lg.write(header + "\n")
    if os.environ.get("V2_ALLOW_TEST") != "1":
        assert not (set(ids) & s1.test_ids()), "test ids refused"
    if MATCHER == "loma":
        use_loma()
    if PRIORS:
        use_priors()
    w = s1.Worker(port=int(os.environ.get("V2_PORT", 8772)))
    try:
        for pid in ids:
            f = od / f"{pid}.json"
            if f.exists():
                continue
            try:
                r = run_photo_v2(w, pid)
            except Exception as ex:  # noqa: BLE001
                r = {"id": pid, "error": f"{type(ex).__name__}: {ex}", "trace": traceback.format_exc()[-2000:]}
            recs = r.pop("recs", None)
            if recs:
                json.dump(recs, open(od / "raw" / f"{pid}.json", "w"), default=str)
            json.dump(r, open(f, "w"), default=str, indent=1)
            fi = r.get("final", {})
            print(pid, fi.get("level"), fi.get("eyeMoved"), fi.get("moveM"), r.get("timingMs"), r.get("error", ""), flush=True)
    finally:
        w.close()


if __name__ == "__main__":
    main()
