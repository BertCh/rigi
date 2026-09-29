"""X2 design selection on the ODD dev ids only: grid over near mask / edge thresholds, ref discrimination only.

    python tune.py            -> tune_odd.json (printed summary)
"""
from __future__ import annotations
import _env  # noqa: F401
import itertools, json
import numpy as np
import tm_common
import geomscore as GS
from geomscore import C
from analyze import auroc

MODELS = ["moge_l", "da3_b"]
GRID = dict(near_m=[0, 30, 100, 300], edge_tau_p=[0.05, 0.1, 0.2], edge_tau_r=[0.15, 0.3], edge_sigma=[2.0, 4.0])


def main():
    ids = [p for p in tm_common.dev_ids() if int(p[3:]) % 2 == 1 and (tm_common.CACHE / p / "DONE").exists()
           and (_env.HERE / "geom" / f"{p}.moge_l.npz").exists()]
    data = []
    for pid in ids:
        m = C.load_meta(pid)
        if not m["correct_refs"] and not m["wrong_refs"]:
            continue
        g = {k: dict(np.load(_env.HERE / "geom" / f"{pid}.{k}.npz")) for k in MODELS}
        for x in m["correct_refs"] + m["wrong_refs"]:
            rec = C.load_view(pid, "refs", x["label"])
            if rec.get("empty"):
                continue
            R = GS.render_maps_from_xyz(GS.view_xyz_grid(rec), rec["eye"], rec["pose"])
            P = {k: GS.photo_maps(g[k], rec["W"], rec["H"], sky_from=g["moge_l"]) for k in MODELS}
            data.append((pid, x["verdict"], P, R))
    print("odd photos", len(ids), "ref views", len(data))
    res = []
    keys = list(GRID)
    for vals in itertools.product(*GRID.values()):
        cfg = {**GS.CFG, **dict(zip(keys, vals))}
        row = {"cfg": dict(zip(keys, vals))}
        for mk in MODELS:
            sc = [(pid, v, GS.scores(P[mk], R, cfg)) for pid, v, P, R in data]
            for k in GS.SCORE_KEYS:
                pos = [s.get(k) for _, v, s in sc if v == "correct"]
                neg = [s.get(k) for _, v, s in sc if v == "wrong"]
                wins = []
                for pid in set(p for p, _, _ in sc):
                    c = [s.get(k) for p, v, s in sc if p == pid and v == "correct" and s.get(k) is not None and np.isfinite(s.get(k))]
                    w = [s.get(k) for p, v, s in sc if p == pid and v == "wrong" and s.get(k) is not None and np.isfinite(s.get(k))]
                    wins += [float(a > b) for a in c for b in w]
                row[f"{mk}.{k}"] = (auroc(pos, neg), float(np.mean(wins)) if wins else None)
        res.append(row)
        print(row["cfg"], {k: (round(v[0], 3) if v[0] else None) for k, v in row.items() if k != "cfg" and ("edge" in k or "rank" in k or "ord_local" in k)}, flush=True)
    json.dump({"ids": ids, "n_views": len(data), "grid": res}, open(_env.HERE / "tune_odd.json", "w"), indent=1)


if __name__ == "__main__":
    main()
