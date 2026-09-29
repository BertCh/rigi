"""X4 POST HOC (designed after seeing the all-50 results): is the remaining phase brittleness from the refine/re-rank tail?
For base (phase0/pitch/roll/yaw/all) and bnb (phase0/yaw): refine every stored coarse peak exactly as SkyGlobal.search
does (coarse→fine coordinate descent), then order either by the refined FINE score (= the SkyGlobal tail; must reproduce
the stored hyps) or by the peak's COARSE value (the exact B&B objective for bnb), 1° dedup, top-4.
Writes results/rerank/<pid>.json.   rerank.py [-j N] [ids...]"""
from __future__ import annotations
import json, sys
from multiprocessing import Pool
import x4lib as L

IN = L.HERE / "results" / "per_photo"
OUT = L.HERE / "results" / "rerank"
OUT.mkdir(parents=True, exist_ok=True)


def dedup(hyps, k=4):
    out = []
    for hy in hyps:
        if all(abs(((hy["pose"]["yaw"] - q["pose"]["yaw"] + 540) % 360) - 180) >= 1.0 for q in out):
            out.append(hy)
    return out[:k]


def one(pid):
    f = OUT / f"{pid}.json"
    if f.exists():
        return
    r = json.load(open(IN / f"{pid}.json"))
    v0, fk, ys = r["vfov0"], r["focalKnown"], r["ystep"]
    sg0, _ = L.load(pid)
    sgy, _ = L.load(pid, yaw_shift=ys / 2)
    res = {}
    for meth, phases in (("base", ("phase0", "pitch", "roll", "yaw", "all")), ("bnb", ("phase0", "yaw"))):
        for ph in phases:
            sg = sgy if ph in ("yaw", "all") else sg0
            hy = []
            for pk in r[meth][ph]["peaks"]:
                st = {k2: pk[k2] for k2 in ("yaw", "pitch", "roll", "vfov")}
                p1, _ = sg.refine(st, v0 if fk else None, 0.08, fine=False)
                p2, s2 = sg.refine(p1, v0 if fk else None, 0.08, fine=True)
                pose = {k2: float(v) for k2, v in p2.items()}
                if ph in ("yaw", "all"):
                    pose["yaw"] = (pose["yaw"] + ys / 2) % 360
                hy.append({"pose": pose, "score": float(s2), "coarse": pk["coarse"]})
            fine = dedup(sorted(hy, key=lambda h: -h["score"]))
            coarse = dedup(sorted(hy, key=lambda h: -h["coarse"]))
            same = [h["pose"] for h in fine] == [h["pose"] for h in r[meth][ph]["hyps"]]
            res.setdefault(meth + "_fine", {})[ph] = {"hyps": fine, "reproduces": same}
            res.setdefault(meth + "_coarse", {})[ph] = {"hyps": coarse}
    json.dump(res, open(f, "w"))
    print(pid, flush=True)


if __name__ == "__main__":
    a = sys.argv[1:]
    j = 1
    if a and a[0] == "-j":
        j = int(a[1]); a = a[2:]
    ids = a or L.tm_common.dev_ids()
    for p in ids:
        L.tm_common.assert_dev(p)
    with Pool(j) as pool:
        list(pool.imap_unordered(one, ids))
