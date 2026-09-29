"""X4: B&B determinism check — rerun bnb with a different initial yaw partition (chunk 5 instead of 8) and no CF seed,
compare the coarse peaks with the stored phase0 run (the B&B analogue of a grid-phase shift).
Writes results/bnb_partition.json.   bnb_partition.py [-j N]"""
from __future__ import annotations
import json, sys
from multiprocessing import Pool
import x4lib as L
import bnb as BB

IN = L.HERE / "results" / "per_photo"


def one(pid):
    r = json.load(open(IN / f"{pid}.json"))
    sg, m = L.load(pid)
    v0, fk = m["vfov0"], m["focalKnown"]
    vfovs = L.default_vfovs(v0, fk, sg.aspect)
    astep, ystep = L.grid_params(sg, vfovs)
    b = BB.BnB(sg, vfovs, astep, ystep)
    o = b.run(k=4, nms=L.nms_deg(v0, sg.aspect), chunk=5, budget_s=240, seed=None)
    old = r["bnb"]["phase0"]["peaks"]
    new = o["peaks"]
    d = lambda a, c: abs(float(L.dang(a["yaw"], c["yaw"]))) + abs(a["pitch"] - c["pitch"])
    return pid, {"ms": o["ms"], "certified": o["certified"], "bstar_old": r["bnb"]["phase0"]["bnb"]["bstar"], "bstar_new": o["bstar"],
                 "top1_move": d(old[0], new[0]) if old and new else None,
                 "top4_unmatched": sum(1 for a in old[:4] if min(d(a, c) for c in new[:4]) > 3) if new else None,
                 "yaws_old": [p["yaw"] for p in old[:4]], "yaws_new": [p["yaw"] for p in new[:4]]}


if __name__ == "__main__":
    j = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[1] == "-j" else 1
    ids = L.tm_common.dev_ids()
    with Pool(j) as pool:
        res = dict(pool.imap_unordered(one, ids))
    json.dump(res, open(L.HERE / "results" / "bnb_partition.json", "w"), indent=1)
    mv = [p for p, v in res.items() if v["top1_move"] is not None and v["top1_move"] > 3]
    ch = [p for p, v in res.items() if v["top4_unmatched"]]
    print("top-1 moves >3°:", len(mv), mv, " photos with a top-4 peak change:", len(ch), ch,
          " max |Δbstar|:", max(abs(v["bstar_old"] - v["bstar_new"]) for v in res.values()),
          " certified:", sum(v["certified"] for v in res.values()))
