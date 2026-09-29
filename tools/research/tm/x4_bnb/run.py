"""X4 runner (DEV only, offline on the cached pose-free edge maps; no renders, no services).

Per photo, writes results/<pid>.json with, for each search method and grid phase:
  base      SkyGlobal.search replay (phase0 must reproduce SG.search exactly), plus half-step phase shifts of the
            pitch grid ("pitch"), roll grid ("roll"), yaw grid ("yaw", DEM azimuths rotated by ystep/2) and all ("all")
  cf_*      closed-form/IRLS pitch-roll per yaw (variants arg/top skyline × polish), phase0 and yaw
  bnb       branch-and-bound exact top-2k peaks + certified gaps (seeded with cf_arg_pol LBs), phase0 and yaw
All methods share the peak picking (local max + greedy NMS on the yaw profile, 2k peaks) and the SkyGlobal
coarse→fine refine + 1° dedup, k = 4. Strip profiles (S = 3, 4, 5) at the top-1 vfov of each method.
    run.py [-j N] [ids...]
"""
from __future__ import annotations
import json, math, sys, time, os
from multiprocessing import Pool
import numpy as np
import x4lib as L
import cf as CF
import bnb as BB

OUT = L.HERE / "results" / "per_photo"
OUT.mkdir(parents=True, exist_ok=True)
K = 4


def base_search(sg, v0, fk, poff=0.0, roff=0.0):
    vfovs = L.default_vfovs(v0, fk, sg.aspect)
    pstep = max(0.5, min(1.5, min(vfovs) / 30))
    pitches = np.arange(-15.0, 15.0 + 1e-9, pstep) + poff * pstep
    rolls = np.arange(-9.0, 9.0 + 1e-9, 1.5) + roff * 1.5
    t = time.time()
    g = sg.grid(vfovs, pitches, rolls)
    nms = L.nms_deg(v0, sg.aspect)
    peaks = L.peaks_from_profile(g["yaw"], g["best"], g["arg"], nms, K)
    tg = time.time()
    hyps = L.finish(sg, peaks, v0, fk, K)
    return {"hyps": hyps, "peaks": peaks, "gridMs": round((tg - t) * 1000), "ms": round((time.time() - t) * 1000),
            "gaps": prof_gaps(g["yaw"], g["best"], nms)}


def prof_gaps(yaw, best, nms):
    i = int(np.argmax(best))
    dy = np.abs(L.dang(yaw, yaw[i]))
    return {"bstar": float(best[i]), "gap3": float(best[i] - best[dy > 3].max()), "gapN": float(best[i] - best[dy >= nms].max())}


def cf_search(sg, v0, fk, mode, polish):
    vfovs = L.default_vfovs(v0, fk, sg.aspect)
    astep, ystep = L.grid_params(sg, vfovs)
    t = time.time()
    yaw, best, arg = CF.cf_profile(sg, vfovs, astep, ystep, mode, polish)
    nms = L.nms_deg(v0, sg.aspect)
    peaks = L.peaks_from_profile(yaw, best, arg, nms, K)
    tg = time.time()
    hyps = L.finish(sg, peaks, v0, fk, K)
    return {"hyps": hyps, "peaks": peaks, "gridMs": round((tg - t) * 1000), "ms": round((time.time() - t) * 1000),
            "gaps": prof_gaps(yaw, best, nms)}, (best, arg)


def bnb_search(sg, v0, fk, seed=None, budget=240.0):
    vfovs = L.default_vfovs(v0, fk, sg.aspect)
    astep, ystep = L.grid_params(sg, vfovs)
    t = time.time()
    b = BB.BnB(sg, vfovs, astep, ystep)
    nms = L.nms_deg(v0, sg.aspect)
    r = b.run(k=K, nms=nms, budget_s=budget, seed=seed)
    tg = time.time()
    hyps = L.finish(sg, r["peaks"], v0, fk, K)
    info = {k: (float(v) if isinstance(v, (np.floating, float)) else v) for k, v in r.items() if k not in ("yaw", "best", "arg", "peaks")}
    return {"hyps": hyps, "peaks": r["peaks"], "gridMs": round((tg - t) * 1000), "ms": round((time.time() - t) * 1000),
            "gaps": {"bstar": r["bstar"], "gap3": r["gap3"], "gapN": r.get("gapN")}, "bnb": info}


def strips(sg, v0, fk, vf, top_yaws):
    vfovs = L.default_vfovs(v0, fk, sg.aspect)
    astep, ystep = L.grid_params(sg, vfovs)
    out = {}
    for S in (3, 4, 5):
        yaw, F = CF.strip_profiles(sg, vf, astep, ystep, S=S)
        rows = []
        for s in range(S):
            f = F[s]
            i = int(np.argmax(f))
            row = {"yaw": float(yaw[i]), "fmax": float(f[i])}
            for nm, Y in top_yaws.items():
                dy = np.abs(L.dang(yaw, Y))
                row[nm] = {"in1": float(f[dy <= 1.0].max()), "in2": float(f[dy <= 2.0].max()), "out3": float(f[dy > 3.0].max())}
            rows.append(row)
        out[str(S)] = rows
    return out


def one(pid):
    f = OUT / f"{pid}.json"
    res = json.load(open(f)) if f.exists() else {}
    t0 = time.time()
    sg, m = L.load(pid)
    v0, fk = m["vfov0"], m["focalKnown"]
    vfovs = L.default_vfovs(v0, fk, sg.aspect)
    astep, ystep = L.grid_params(sg, vfovs)
    res.update(pid=pid, vfov0=v0, focalKnown=fk, aspect=sg.aspect, astep=astep, ystep=ystep)

    def save():
        json.dump(res, open(f, "w"))

    if "base" not in res:
        r0 = sg.search(v0, fk, k=K)
        b = base_search(sg, v0, fk)
        b["reproduces"] = [h["pose"] for h in b["hyps"]] == [h["pose"] for h in r0["hyps"]]
        res["base"] = {"phase0": b}
        for nm, (po, ro, yo) in {"pitch": (0.5, 0, 0), "roll": (0, 0.5, 0), "yaw": (0, 0, 1), "all": (0.5, 0.5, 1)}.items():
            sgs = sg if not yo else L.load(pid, yaw_shift=ystep / 2)[0]
            r = base_search(sgs, v0, fk, po, ro)
            if yo:
                for h in r["hyps"]:
                    h["pose"]["yaw"] = (h["pose"]["yaw"] + ystep / 2) % 360
            res["base"][nm] = r
        save()
    seed = None
    sgy = L.load(pid, yaw_shift=ystep / 2)[0]
    for mode in ("arg", "top"):
        for pol in (False, True):
            nm = f"cf_{mode}_{'pol' if pol else 'raw'}"
            if nm in res and not (mode == "arg" and pol):
                continue
            r, sd = cf_search(sg, v0, fk, mode, pol)
            if mode == "arg" and pol:
                seed = sd
            if nm in res:
                continue
            ry, _ = cf_search(sgy, v0, fk, mode, pol)
            for h in ry["hyps"]:
                h["pose"]["yaw"] = (h["pose"]["yaw"] + ystep / 2) % 360
            res[nm] = {"phase0": r, "yaw": ry}
            save()
    if "bnb" not in res:
        r = bnb_search(sg, v0, fk, seed=seed)
        _, sdy = cf_search(sgy, v0, fk, "arg", True)
        ry = bnb_search(sgy, v0, fk, seed=sdy)
        for h in ry["hyps"]:
            h["pose"]["yaw"] = (h["pose"]["yaw"] + ystep / 2) % 360
        res["bnb"] = {"phase0": r, "yaw": ry}
        save()
    if os.environ.get("X4_REDO_STRIPS") == "1" and "cf_top_pol" not in res.get("stripVf", {}):
        res.pop("strips", None)
    if "strips" not in res:
        tops = {}
        for meth in ("base", "cf_arg_pol", "cf_top_pol", "bnb"):
            hy = res[meth]["phase0"]["hyps"]
            if hy:
                tops[meth] = hy[0]["pose"]
        out = {}
        for vf in sorted({round(p["vfov"], 6) for p in tops.values()}):
            out[str(vf)] = strips(sg, v0, fk, vf, {k: p["yaw"] for k, p in tops.items()})
        res["strips"] = out
        res["stripVf"] = {k: str(round(p["vfov"], 6)) for k, p in tops.items()}
        save()
    print(pid, "done", round(time.time() - t0), "s", "bnb cert", res["bnb"]["phase0"]["bnb"]["certified"], flush=True)
    return pid


if __name__ == "__main__":
    args = sys.argv[1:]
    j = 1
    if args and args[0] == "-j":
        j = int(args[1]); args = args[2:]
    ids = args or L.tm_common.dev_ids()
    for p in ids:
        L.tm_common.assert_dev(p)
    if j == 1:
        for p in ids:
            one(p)
    else:
        with Pool(j) as pool:
            for _ in pool.imap_unordered(one, ids):
                pass
