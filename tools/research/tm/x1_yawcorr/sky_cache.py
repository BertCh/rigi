"""X1: cache the stage-1 skyline global-search yaw curve per DEV photo (offline, cached pose-free edge maps).

Runs exactly SkyGlobal.search's grid (same vfovs / pitches / rolls) and stores the per-yaw best score + argmax
(vfov, pitch, roll), plus the full search hyps (k=4) so x1lib.peaks_refine can be checked to reproduce SG.search.
    python sky_cache.py [ids...]      -> .sky/<pid>.npz
"""
from __future__ import annotations
import json, math, sys, time
from pathlib import Path
import numpy as np
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import tm_common  # noqa: E402
import skyglobal as SG  # noqa: E402

EDGES = tm_common.ROOT / "tools/matcher/v2/.cache/edges"
OUT = HERE / ".sky"
OUT.mkdir(exist_ok=True)


def load_sg(pid):
    z = np.load(EDGES / f"{pid}.npz")
    m = json.loads(str(z["meta"]))
    ed = {"w": z["fine"].shape[1], "h": z["fine"].shape[0], "fine": z["fine"], "coarse": z["coarse"], "fg": z["fg"],
          "rgb": z["rgb"], "dirs": z["dirs"]}
    return SG.SkyGlobal(ed, m["aspect"]), m


def default_grid(sg, v0, fk):
    if fk:
        vfovs = [v0 * s for s in (0.94, 1.0, 1.06)]
    else:
        vfovs = [2 * math.degrees(math.atan(math.tan(math.radians(hf) / 2) / sg.aspect)) for hf in (35, 45, 55, 65, 75)]
    pstep = max(0.5, min(1.5, min(vfovs) / 30))
    pitches = np.arange(-15.0, 15.0 + 1e-9, pstep)
    rolls = np.arange(-9.0, 9.0 + 1e-9, 1.5)
    return vfovs, pitches, rolls


if __name__ == "__main__":
    ids = sys.argv[1:] or tm_common.dev_ids()
    for pid in ids:
        tm_common.assert_dev(pid)
        f = OUT / f"{pid}.npz"
        if f.exists():
            continue
        sg, m = load_sg(pid)
        vfovs, pitches, rolls = default_grid(sg, m["vfov0"], m["focalKnown"])
        t = time.time()
        g = sg.grid(vfovs, pitches, rolls)
        gms = (time.time() - t) * 1000
        t = time.time()
        r = sg.search(m["vfov0"], m["focalKnown"], k=4)
        sms = (time.time() - t) * 1000
        np.savez(f, yaw=g["yaw"], best=g["best"], arg=g["arg"], astep=g["astep"], gridMs=gms, searchMs=sms,
                 hyps=json.dumps(r["hyps"]), meta=json.dumps(m))
        print(pid, round(gms), round(sms), flush=True)
