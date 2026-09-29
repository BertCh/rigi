"""Stage-1 search + hypothesis verification for ad-hoc photos (T6).

Per photo:
  generators (stage 1)
    sweep40     replay of the service sweep (9 views every 40°, pitch 0, request vfov)       [baseline]
    appseeds    the service fallback: app autoAlign from 9 yaw × 3 pitch seeds, best score     [baseline]
    sweepfine   FOV-aware match sweep: views every 0.5·hfov (≥ 8°) at the request vfov (unknown focal:
                hfov 40° and 62°); matches pooled over windows of 3 adjacent views → one rotation per
                window (2-point RANSAC, free focal when unknown)
    sky         skyline-only global search (skyglobal.py) over 360° × pitch × roll × FOV, top-k
  verification (stage 2)
    every distinct hypothesis (≤ MAX_VERIFY) goes through the service's own stage 2: 5-view render fan
    at the hypothesis + skyline export → correspond → assemble (fuse.fuse, the a-priori HIGH/LOW rule).
    Per hypothesis we also record hypothesis-independent comparators:
      skyScore   the app skyline score of the fused pose on the POSE-FREE sky model (skyglobal)
      sweepSup   number of fine-sweep lifted matches (renders not centred on any hypothesis) within 6 px
  selection
    select.py (offline, from the recorded candidates), so policies can be compared without re-running.
Records go to <out>/<id>.json. Renders live in a temp dir and are deleted immediately.
"""
from __future__ import annotations

import json
import math
import sys
import time
import traceback
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import s1  # noqa: E402
import skyglobal as SG  # noqa: E402

MAX_VERIFY = 6
PHOTO_WALL_S = int(__import__("os").environ.get("STAGE1_PHOTO_WALL_S", 900))  # hard per-photo cap


class PhotoTimeout(Exception):
    pass


def _alarm(signum, frame):
    raise PhotoTimeout()
SKY_K = 4
SWEEP_WIN_MIN_INL = 15
FINE_MIN_STEP = 8.0
UNKNOWN_HFOVS = (40.0, 62.0)


def _p(pose):
    return {k: float(pose[k]) for k in ("yaw", "pitch", "roll", "vfov")}


def fine_sweep(se: s1.Session, ph: s1.Photo, eye):
    """FOV-aware sweep; returns (hypotheses, pooled corr per vfov for sweepSup)."""
    hyps, pools = [], []
    vfovs = [ph.vfov0] if ph.focal_known else [s1.vfov_from_hfov(h, ph.aspect) for h in UNKNOWN_HFOVS]
    t0 = time.time()
    nviews = 0
    for vf in vfovs:
        hf = s1.hfov_from_vfov(vf, ph.aspect)
        step = max(FINE_MIN_STEP, 0.5 * hf)
        n = max(9, int(math.ceil(360 / step)))
        step = 360 / n
        poses = [{"tag": f"f{i}", "yaw": i * step, "pitch": 0.0, "roll": 0.0, "vfov": vf} for i in range(n)]
        views, _, meta, _ = se.render(poses=poses, styles=("sat",))
        nviews += len(views)
        if not views:
            continue
        c = s1.correspond(ph.img, views, eye)
        pools.append(c)
        # per-view lifted index ranges → windows of 3 adjacent views (circular)
        counts = [p["lifted"] for p in c["perView"]]
        starts = np.r_[0, np.cumsum(counts)]
        tags = [p["tag"] for p in c["perView"]]
        for i in range(len(views)):
            idx = np.concatenate([np.arange(starts[(i + d) % len(views)], starts[(i + d) % len(views) + 1]) for d in (-1, 0, 1)])
            if len(idx) < 12:
                continue
            sub = {**c, "x2d": c["x2d"][idx], "X": c["X"][idx]}
            prior = {"yaw": views[i].pose["yaw"], "pitch": 0.0, "roll": 0.0, "vfov": vf}
            s = s1.solve(sub, views, eye, prior, not ph.focal_known)
            if s.get("pose") and s.get("inliers", 0) >= SWEEP_WIN_MIN_INL:
                hyps.append({"source": "sweepfine", "pose": _p(s["pose"]), "inliers": int(s["inliers"]),
                             "inlierFrac": s.get("inlierFrac"), "window": tags[i], "vfovRender": vf})
    hyps.sort(key=lambda h: -h["inliers"])
    out = []
    for h in hyps:
        if all(abs(s1.dang(h["pose"]["yaw"], q["pose"]["yaw"])) > 2 or abs(h["pose"]["pitch"] - q["pose"]["pitch"]) > 2 for q in out):
            out.append(h)
    return out[:4], pools, {"views": nviews, "ms": round((time.time() - t0) * 1000), "vfovs": vfovs}


def narrow_stage1(se: s1.Session, ph: s1.Photo, ra: dict):
    """Service narrow_stage1 (v0.3.4) on the align result `ra` (360° × pitch seeds): seeds = yaw hint +
    the app's top-3 separated skyline alternatives; each seed matched against a 3×3 fan at the photo's FOV.
    Returns (baseline candidate = what the service would pass to stage 2, other seeds with ≥ 30 inliers, info)."""
    A = s1.APP
    hf = ph.hfov0
    p0 = ph.p0
    seeds = []
    if ph.yaw_hint is not None:
        seeds.append({"yaw": float(ph.yaw_hint), "pitch": p0["pitch"], "roll": p0["roll"], "source": "yaw-hint"})
    alts = sorted((a for x in ra["runs"] for a in x.get("alternatives", []) if a.get("pose")), key=lambda a: -a["total"])
    for a in alts:
        if len([q for q in seeds if q["source"] == "app-skyline"]) >= 3:
            break
        if all(abs(s1.dang(a["pose"]["yaw"], q["yaw"])) > 2 * hf for q in seeds):
            seeds.append({**{k: a["pose"][k] for k in ("yaw", "pitch", "roll")}, "source": "app-skyline"})
    seeds = seeds[:A.ADHOC_NARROW_MAX_SEEDS]
    dy, dp = 0.8 * hf, 0.8 * p0["vfov"]
    tried, best = [], None
    for sd in seeds:
        views = []
        for j, pp in enumerate((-dp, 0.0, dp)):
            vs, _, meta, _ = se.render(prior={"yaw": sd["yaw"], "pitch": sd["pitch"] + pp, "roll": sd["roll"], "vfov": p0["vfov"]},
                                       offsets=[round(-dy, 4), 0, round(dy, 4)], styles=("sat",))
            for v in vs:
                v.tag = f"{v.tag}_p{j}"
            views += vs
        if not views:
            tried.append({"seed": sd, "pose": None, "inliers": 0})
            continue
        c = s1.correspond(ph.img, views, se.ph.eye, max_kp=A.SWEEP_KP)
        r = s1.core.solve(c, views, se.ph.eye, {**p0, "yaw": sd["yaw"]}, free_focal=not ph.focal_known)
        tried.append({"seed": sd, "pose": r.get("pose"), "inliers": r.get("inliers", 0)})
        if r.get("pose") is not None and (best is None or r.get("inliers", 0) > best[1].get("inliers", 0)):
            best = (sd, r)
    info = {"seeds": seeds, "tried": tried}

    def cand(pose, inl):
        p2 = _p(pose)
        if ph.focal_known:
            p2["vfov"] = p0["vfov"]
        return {"pose": p2, "inliers": inl}
    if best is not None and best[1].get("inliers", 0) >= A.ADHOC_STAGE1_MIN_INLIERS:
        base = cand(best[1]["pose"], best[1]["inliers"])
        info["used"] = best[0]["source"]
    elif seeds:
        sd = next((q for q in seeds if q["source"] == "app-skyline"), seeds[0])
        base = {"pose": {"yaw": sd["yaw"], "pitch": sd["pitch"], "roll": sd["roll"], "vfov": p0["vfov"]}, "inliers": 0}
        info["used"] = f"fallback:{sd['source']}"
    else:
        base = None
    others = [cand(t["pose"], t["inliers"]) for t in tried if t["pose"] and t["inliers"] >= A.ADHOC_STAGE1_MIN_INLIERS
              and (best is None or t["pose"] is not best[1].get("pose"))]
    return base, others, info


def sweep_support(pools, pose, eye, H, W):
    """# fine-sweep lifted matches within 6 px of `pose` (renders independent of the hypothesis)."""
    import fusion as F
    n = 0
    for c in pools:
        if len(c["x2d"]) == 0:
            continue
        e = np.linalg.norm(F.match_resid(F.x_from_pose(pose, H), {**c, "W": W, "H": H}, np.asarray(eye, float)), axis=1)
        n += int((e < F.SUPPORT_PX).sum())
    return n


def stage2(se: s1.Session, ph: s1.Photo, prior2: dict):
    """The service's stage 2 at prior2 (exactly app.match_adhoc's second half)."""
    hf = ph.hfov0
    offs2 = [round(k * hf, 4) for k in (-0.5, -0.25, 0, 0.25, 0.5)] if ph.narrow else [-20, -10, 0, 10, 20]
    views, sk, meta, tim = se.render(prior=prior2, offsets=offs2, styles=("sat",), skyline=True, allow_empty=False)
    eye = meta["eye"]
    corr = s1.correspond(ph.img, views, eye)
    res = s1.APP.assemble(corr, views, eye, prior2, sk, fused=True, free_focal=not ph.focal_known, meta=None,
                          deadline=time.time() + 600, sky_note=None if sk else "app has no horizon/edge map")
    return res, sk, corr, eye


def basin_gap(ph: s1.Photo, res, sk, corr, eye):
    """pose6's stand-alone basin gap on the service's own stage-2 skyline cue + matches (no re-render)."""
    import pose6 as P6
    t0 = time.time()
    regime = "exif" if ph.e.get("positionSource") == "exif-gps" else "manual"
    # exactly the v0.3 service call (basin_gap_check): fast mode, regime "manual", own stage-2 cue + matches
    prob = P6.Problem("adhoc", corr["W"], corr["H"], sk, corr if len(corr["x2d"]) else None, eye, ph.e["lat"], ph.e["lon"],
                      res["pose"], ph.focal_known, "manual", fast=True)
    bg = P6.basin_gap(prob)
    return {"gap": bg["gap"], "ms": round((time.time() - t0) * 1000), "regime": regime}


def run_photo(w: s1.Worker, pid: str, gap_for_high=True, entry: dict | None = None, cond: str = "given") -> dict:
    ph = s1.Photo(pid, entry, cond=cond)
    se = s1.Session(w, ph)
    rec = {"id": pid, "focalKnown": ph.focal_known, "vfov0": ph.vfov0, "hfov0": ph.hfov0, "narrow": ph.narrow,
           "positionSource": ph.e.get("positionSource"), "lat": ph.e["lat"], "lon": ph.e["lon"]}
    T = {}
    t0 = time.time()
    import signal
    signal.signal(signal.SIGALRM, _alarm)
    signal.alarm(PHOTO_WALL_S)
    rec["stage"] = "start"
    rec["codeStamp"] = s1.code_stamp()
    try:
        # --- photo evidence + horizon (no autoAlign): skyline global search
        ts = time.time()
        rec["stage"] = "edges+sky"
        ed = se.edges()
        eye = ed["meta"]["eye"]
        rec["eye"] = eye
        rec["horizonDirs"] = int(len(ed["dirs"]))
        if len(ed["dirs"]) < 500:  # a page whose 360° horizon never got traced (seen after a dev-server reload)
            se.close()
            raise RuntimeError(f"worker: page has an empty horizon ({len(ed['dirs'])} dirs)")
        sg = SG.SkyGlobal(ed, ph.aspect)
        sres = sg.search(ph.vfov0, ph.focal_known, k=SKY_K)
        cands = [{"source": "sky", "rank": i, "pose": h["pose"], "skyScore0": h["score"]} for i, h in enumerate(sres["hyps"])]
        rec["sky"] = {"gridMs": sres["gridMs"], "refineMs": sres["refineMs"], "grid": sres["grid"]}
        T["sky"] = round((time.time() - ts) * 1000)
        # --- baseline: service sweep replay
        ts = time.time()
        rec["stage"] = "sweep40"
        base_seed = None
        s40 = {}
        if not ph.narrow:  # the service runs the 40° sweep only for hfov ≥ 25° (narrow: narrow_stage1 below)
            views, _, meta, tim = se.render(prior=ph.p0, offsets=s1.APP.ADHOC_360_OFFSETS if ph.full else [-20, -10, 0, 10, 20], styles=("sat",))
            c40 = s1.correspond(ph.img, views, eye, max_kp=s1.APP.SWEEP_KP)
            s40 = s1.core.solve(c40, views, eye, ph.p0, free_focal=not ph.focal_known)
            rec["sweep40"] = {"inliers": s40.get("inliers", 0), "pose": s40.get("pose"), "renderTiming": tim}
            del views
        if s40.get("pose") and s40.get("inliers", 0) >= s1.APP.ADHOC_STAGE1_MIN_INLIERS:
            p2 = _p(s40["pose"])
            if ph.focal_known:
                p2["vfov"] = ph.p0["vfov"]
            cands.append({"source": "sweep40", "pose": p2, "inliers": s40["inliers"]})
            base_seed = "sweep40"
        T["sweep40"] = round((time.time() - ts) * 1000)
        # --- baseline: app skyline seeds (the service computes these only when sweep40 < 30; we always do)
        ts = time.time()
        rec["stage"] = "appseeds"
        seeds = [{"yaw": float(y), "pitch": dp, "roll": 0.0, "vfov": ph.p0["vfov"]} for y in s1.APP.ADHOC_360_OFFSETS for dp in s1.APP.ADHOC_SEED_PITCHES]
        ra = se.align(seeds)
        best = max((x for x in ra["runs"] if x.get("pose")), key=lambda x: x["score"], default=None)
        if best:
            cands.append({"source": "appseeds", "pose": _p(best["pose"]), "appScore": best["score"]})
            if base_seed is None and not ph.narrow:
                base_seed = "appseeds"
        if ph.narrow:  # replay of the service's narrow_stage1 (same seeds, 3×3 fans, best by inliers)
            rec["stage"] = "narrow"
            nb, nalt, ninfo = narrow_stage1(se, ph, ra)
            rec["narrow"] = ninfo
            if nb:
                cands.append({**nb, "source": "narrow"})
                base_seed = "narrow"
            cands += [{**x, "source": "narrowalt"} for x in nalt]
        rec["baselineSeed"] = base_seed
        T["appseeds"] = round((time.time() - ts) * 1000)
        # --- FOV-aware fine sweep
        ts = time.time()
        rec["stage"] = "sweepfine"
        pools = []
        if not ph.narrow:
            fh, pools, finfo = fine_sweep(se, ph, eye)
            rec["sweepfine"] = finfo
            for h in fh:
                p2 = dict(h["pose"])
                if ph.focal_known:
                    p2["vfov"] = ph.p0["vfov"]
                cands.append({**h, "pose": p2})
        T["sweepfine"] = round((time.time() - ts) * 1000)
        # --- dedupe + order for verification: baseline seed first (so the baseline result is always
        # reproduced), then fine sweep by inliers, then sky by score, then the other baseline source
        # order for verification: the baseline seed first (so the service result is always reproduced),
        # then fine-sweep (by inliers) and sky (by score) hypotheses interleaved, then the other baseline source
        base = [c for c in cands if c["source"] == base_seed]
        fine = sorted([c for c in cands if c["source"] == "sweepfine"], key=lambda c: -c.get("inliers", 0))
        sky = sorted([c for c in cands if c["source"] == "sky"], key=lambda c: c.get("rank", 0))
        fine = fine + sorted([c for c in cands if c["source"] == "narrowalt"], key=lambda c: -c.get("inliers", 0))
        rest = [c for c in cands if c["source"] in ("sweep40", "appseeds") and c["source"] != base_seed]
        inter = []
        for i in range(max(len(fine), len(sky))):
            inter += fine[i:i + 1] + sky[i:i + 1]
        cands = base + inter + rest
        uniq = []
        for c in cands:
            dup = next((u for u in uniq if abs(s1.dang(c["pose"]["yaw"], u["pose"]["yaw"])) < 2 and abs(c["pose"]["pitch"] - u["pose"]["pitch"]) < 2), None)
            if dup:
                dup.setdefault("alsoFrom", []).append(c["source"])
                continue
            uniq.append(c)
        rec["nCandidates"] = len(uniq)
        # --- verification
        ts = time.time()
        W = H = None
        rec["candidates"] = uniq
        for i, c in enumerate(uniq[:MAX_VERIFY]):
            t1 = time.time()
            rec["stage"] = f"verify[{i}]:{c['source']}"
            try:
                res, sk, corr, eye2 = stage2(se, ph, c["pose"])
            except Exception as e:  # noqa: BLE001
                c["error"] = f"{type(e).__name__}: {e}"
                continue
            W, H = corr["W"], corr["H"]
            fp = res.get("pose")
            c["fused"] = {"pose": fp, "level": res.get("confidenceLevel"), "method": res.get("method"),
                          "checks": res.get("confidenceChecks"), "fusionScore": res.get("fusionScore"),
                          "inliers": res.get("inliers"), "inlierFrac": res.get("inlierFrac"), "nLifted": res.get("nLifted"),
                          "fusedFrom": res.get("fusedFrom"), "cues": res.get("cues"), "eye": eye2}
            if fp:
                c["fused"]["skyScore"] = sg.score_pose(fp, fine=True)
                c["fused"]["sweepSup"] = sweep_support(pools, fp, eye2, H, W) if pools else None
                # basin gap (v0.3.4 service logic) for every candidate a HIGH rule could accept: a-priori HIGH, or
                # match support ≥ 0.5 (candidate "match-dominant" criterion, goal 2); hand-placed positions only
                sup = (res.get("confidenceChecks") or {}).get("matchSupport") or 0
                if gap_for_high and (res.get("confidenceLevel") == "high" or sup >= 0.5) and ph.e.get("positionSource") != "exif-gps":
                    try:
                        rec["stage"] = f"basinGap[{i}]"
                        c["fused"]["basinGap"] = basin_gap(ph, res, sk, corr, eye2)
                    except Exception as e:  # noqa: BLE001
                        c["fused"]["basinGap"] = {"error": f"{type(e).__name__}: {e}"}
            c["ms"] = round((time.time() - t1) * 1000)
            del sk, corr
        T["verify"] = round((time.time() - ts) * 1000)
        rec["candidates"] = uniq
    except PhotoTimeout:
        rec["timeout"] = True
        rec["error"] = f"timeout after {PHOTO_WALL_S} s in stage {rec.get('stage')}"
    except Exception as e:  # noqa: BLE001
        rec["error"] = f"{type(e).__name__}: {e}"
        rec["trace"] = traceback.format_exc()[-2000:]
    finally:
        signal.alarm(0)
        rec["hmrReopens"] = se.hmr_reopens
        rec["matchRetries"] = list(s1.RETRIES)
        s1.RETRIES.clear()
        se.close()
        ph.cleanup()
    T["total"] = round((time.time() - t0) * 1000)
    rec["timingMs"] = T
    return rec


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("ids", nargs="+")
    ap.add_argument("--out", default=str(s1.HERE / "out" / "runs" / "dev"))
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--allow-test", action="store_true", help="only for the lead's single test run")
    ap.add_argument("--manifest", default=None, help="other manifest (e.g. GT-12 ablation manifest)")
    ap.add_argument("--cond", default="given", help="given (wild: weak heading) | none | full | nogravity | noheading")
    a = ap.parse_args()
    entries = {e["id"]: e for e in json.load(open(a.manifest))} if a.manifest else None
    test = s1.test_ids()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    w = s1.Worker()
    try:
        for pid in a.ids:
            if pid in test and not a.allow_test:
                print(f"{pid}: test id refused (pass --allow-test only for the final test run)", flush=True)
                continue
            f = out / f"{pid}.json"
            if f.exists() and not a.force:
                print(pid, "cached (existing record kept)", flush=True)
                continue
            for attempt in range(2):
                s1.disk_guard()
                rec = run_photo(w, pid, entry=entries[pid] if entries else None, cond=a.cond)
                if "error" not in rec and rec.get("hmrReopens", 0) == 0:
                    break
                if rec.get("timeout"):
                    w.close()  # the worker may be mid-command: start clean
                    w = s1.Worker()
                    break
                print(f"{pid}: retry ({rec.get('error', 'HMR reload mid-photo')})", flush=True)
                if "worker" in str(rec.get("error", "")):
                    w.close()
                    w = s1.Worker()
            rec["attempts"] = attempt + 1
            json.dump(rec, open(f, "w"), indent=1, default=float)
            nh = sum(1 for c in rec.get("candidates", []) if (c.get("fused") or {}).get("level") == "high")
            print(pid, "cands", rec.get("nCandidates"), "HIGH", nh, "ms", rec["timingMs"].get("total"), rec.get("error", ""), flush=True)
    finally:
        w.close()


if __name__ == "__main__":
    main()
