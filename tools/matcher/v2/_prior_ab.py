"""Offline A/B of the calibration priors on the stage-1 skyline global search (DEV only, cached edge maps).
Arms: base (SG.search as in T6), pitch (GeoCalib fan), focal (AnyCalib hfov set, focal-unknown only), both.
Per photo & arm: grid+refine ms, top-4 hyps, hit = some hyp within 2° (|Δyaw|+|Δpitch|) of a verified-correct ref.
Also checks that priors.search with the default grid reproduces SG.search exactly.
    _prior_ab.py OUT.json [ids...]"""
import json, sys, time
from pathlib import Path
import numpy as np
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE)); sys.path.insert(0, str(HERE.parent / "stage1"))
import skyglobal as SG, priors as P, refs, s1  # noqa: E401

out = Path(sys.argv[1])
ids = sys.argv[2:] or refs.dev_ids()
assert not (set(ids) & s1.test_ids())
res = json.load(open(out)) if out.exists() else {}
ARMS = {"base": (False, False), "pitch": (True, False), "focal": (False, True), "both": (True, True)}
if __import__("os").environ.get("PRIOR_SNAP_ONLY") == "1":  # add the grid-phase-snapped pitch arm to an existing file
    ARMS = {"base": (False, False), "pitchSnap": (True, False)}
for pid in ids:
    if pid in res and "pitchSnap" in res[pid] or (pid in res and len(ARMS) == 4):
        continue
    z = np.load(HERE / ".cache" / "edges" / f"{pid}.npz")
    m = json.loads(str(z["meta"]))
    ed = {"w": z["fine"].shape[1], "h": z["fine"].shape[0], "fine": z["fine"], "coarse": z["coarse"], "fg": z["fg"], "rgb": z["rgb"],
          "dirs": z["dirs"]}
    sg = SG.SkyGlobal(ed, m["aspect"])
    fk, v0 = m["focalKnown"], m["vfov0"]
    pr = P.pred(pid, focal_known=fk)
    R = refs.correct_refs(pid)
    row = res.get(pid) or {"focalKnown": fk, "nRefs": len(R), "pred": pr}
    for arm, (up, uf) in ARMS.items():
        if arm == "base" and "base" in row:
            continue
        if arm in ("focal", "both") and fk:
            continue
        t = time.time()
        if arm == "base":
            r = sg.search(v0, fk, k=4)
        else:
            vf, pi, ps = P.sky_grid(v0, fk, m["aspect"], pr, up, uf)
            r = P.search(sg, v0, fk, 4, None, vf, pi, ps)
        ms = round((time.time() - t) * 1000)
        hs = [h["pose"] for h in r["hyps"]]
        d = [min((abs(SG.dang(h["yaw"], q["pose"]["yaw"])) if hasattr(SG, "dang") else abs((h["yaw"] - q["pose"]["yaw"] + 540) % 360 - 180))
                 + abs(h["pitch"] - q["pose"]["pitch"]) for q in R) for h in hs] if R else []
        row[arm] = {"ms": ms, "gridMs": r["gridMs"], "nPitch": len(np.arange(*r["grid"]["pitches"][:2], 1)) if False else r["grid"]["pitches"],
                    "hyps": hs, "refDist": d, "hit": bool(d) and min(d) <= 2.0, "hit1": bool(d) and d[0] <= 2.0}
    if "base" in row:  # exactness check of the refactored search on the default grid
        vf, pi, ps = P.sky_grid(v0, fk, m["aspect"], None, False, False)
        r2 = P.search(sg, v0, fk, 4, None, vf, pi, ps)
        row["reproduces"] = [h["pose"] for h in r2["hyps"]] == row["base"]["hyps"]
    res[pid] = row
    json.dump(res, open(out, "w"), indent=0)
    print(pid, {a: (row[a]["ms"], row[a]["hit"]) for a in ("base", "pitch", "pitchSnap", "focal", "both") if a in row}, row.get("reproduces"), flush=True)
