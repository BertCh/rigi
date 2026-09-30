"""E2 stage B: lift + metrics + decision exactly as PROTOCOL.txt. -> results.json (+ prints tables)

Uses X3 evaluate.eval_view (read-only import; its `from common import ...` is pointed at tools/matcher/common.py).
"""
from __future__ import annotations
import importlib.util, json, math, sys
from pathlib import Path
import numpy as np

HERE = Path(__file__).resolve().parent
TM = HERE.parent.parent / "tm"
ROOT = TM.parents[2]
sys.path.insert(0, str(TM)); sys.path.insert(0, str(TM / "c0_cache"))
import tm_common  # noqa: E402
import cache_io as C  # noqa: E402


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


_saved = sys.modules.get("common")
sys.modules["common"] = _load("mt_matcher_common", ROOT / "tools/matcher/common.py")
X3E = _load("x3_evaluate", TM / "x3_modality/evaluate.py")
if _saved is not None:
    sys.modules["common"] = _saved
else:
    del sys.modules["common"]

from scipy.stats import wilcoxon  # noqa: E402

RAW = HERE / "raw"
EVC = HERE / "eval_cache"
DATES = json.load(open(HERE / "dates.json"))
MATCHERS = ["loma", "aliked"]
VARS = [0, 1, 2, 3, 4, 5]
PLAN = {1: "(ii) sun-relit", 2: "(iii) +snow", 5: "(iv) +S2"}
EXTRA = {3: "extra v3 = v2+photo haze/gain fit", 4: "extra v4 = v0+photo haze/gain fit"}
GAIN_T = 0.15
S2_MIN_DATE = "2016-11-01"


def scored_views(meta):
    out = [("refs", r["label"], "correct") for r in meta["correct_refs"]]
    out += [("refs", r["label"], "wrong") for r in meta["wrong_refs"]]
    tags = {v["tag"] for v in meta["views"]["perturb"]}
    out += [("perturb", t, "perturb") for t in ("yaw-8", "yaw-4", "yaw+4", "yaw+8") if t in tags]
    return out


def eval_all():
    rows = {}  # m -> pid -> "grp/tag" -> v -> rec
    for m in MATCHERS:
        for pd in sorted((RAW / m).iterdir()) if (RAW / m).exists() else []:
            pid = pd.name
            tm_common.assert_dev(pid)
            meta = C.load_meta(pid)
            base = meta["perturbBase"]
            ref_pose = next(r["pose"] for r in meta["correct_refs"] if r["label"] == base)
            cf = EVC / m / f"{pid}.json"
            cache = json.load(open(cf)) if cf.exists() else {}
            dirty = False
            for f in sorted(pd.glob("*.npz")):
                g, t, vv = f.stem.split("__")
                key = f"{f.name}:{f.stat().st_mtime_ns}"
                r = cache.get(key)
                if r is None:
                    v = X3E.load_view(pid, g, t)
                    r = cache[key] = X3E.eval_view(f, v, ref_pose, not meta["focal_known"], None)
                    dirty = True
                rows.setdefault(m, {}).setdefault(pid, {}).setdefault(f"{g}/{t}", {})[int(vv[1:])] = r
            if dirty:
                cf.parent.mkdir(parents=True, exist_ok=True)
                json.dump(cache, open(cf, "w"))
    return rows


def boot_median(x, n=2000, seed=20260929):
    x = np.asarray(x, float)
    if len(x) == 0:
        return [None, None]
    rng = np.random.default_rng(seed)
    b = np.median(x[rng.integers(0, len(x), (n, len(x)))], 1)
    return [round(float(np.percentile(b, 2.5)), 4), round(float(np.percentile(b, 97.5)), 4)]


def main():
    rows = eval_all()
    per_photo = {}
    for pid in sorted({p for m in rows for p in rows[m]}):
        meta = C.load_meta(pid)
        st = json.load(open(HERE / "variants" / pid / "stats.json"))
        base = meta["perturbBase"]
        tk = f"refs__{base}"
        info = {"date": DATES[pid]["dateTaken"], "sunEl": DATES[pid]["sun"]["el"], "weather": DATES[pid]["weather"],
                "season": DATES[pid]["season"], "base": base, "snowFracTrue": st[tk]["snowFrac"],
                "s2KnownTrue": st[tk].get("s2Known"), "nDecoys": 0}
        info["snowy"] = (info["snowFracTrue"] or 0) >= 0.05
        info["lowSun"] = info["sunEl"] < 25
        info["s2Applicable"] = info["date"][:10] >= S2_MIN_DATE and (info["s2KnownTrue"] or 0) >= 0.5
        views = scored_views(meta)
        info["nDecoys"] = sum(r != "correct" for *_, r in views)
        for m in rows:
            if pid not in rows[m]:
                continue
            R = rows[m][pid]
            d = {}
            for v in VARS:
                try:
                    tr = R[f"refs/{base}"][v]
                    dec = [R[f"{g}/{t}"][v]["cons6"] for g, t, r in views if r != "correct"]
                    cor = [R[f"{g}/{t}"][v]["cons6"] for g, t, r in views if r == "correct"]
                except KeyError:
                    continue
                I, Dm = tr["cons6"], max(dec) if dec else 0
                d[v] = {"I": I, "inlAtRef6": tr.get("inlAtRef6", 0), "solvedInl": tr.get("inliers", 0),
                        "errRef": tr.get("errRef"), "matches": tr["matches"], "lifted": tr["lifted"],
                        "meanCorrect": float(np.mean(cor)), "D": Dm, "S": math.log10((I + 1) / (Dm + 1)),
                        "rank1": I > Dm}
            info[m] = d
        per_photo[pid] = info

    res = {"protocol": "PROTOCOL.txt", "nPhotos": len(per_photo), "matchers": {}, "decision": {}}
    for m in MATCHERS:
        out = {}
        for v in [1, 2, 5, 3, 4]:
            ps = [p for p, i in per_photo.items() if m in i and 0 in i[m] and v in i[m]
                  and (v != 5 or i["s2Applicable"])]
            I0 = np.array([per_photo[p][m][0]["I"] for p in ps], float)
            Iv = np.array([per_photo[p][m][v]["I"] for p in ps], float)
            g = (Iv - I0) / np.maximum(I0, 10)
            dS = np.array([per_photo[p][m][v]["S"] - per_photo[p][m][0]["S"] for p in ps])
            nz = int((np.abs(dS) > 1e-12).sum())
            pw = None
            if nz >= 6:
                pw = float(wilcoxon(dS, alternative="greater", zero_method="wilcox").pvalue)
            sep_gain = bool(nz >= 6 and np.median(dS) > 0 and pw is not None and pw < 0.05)

            def sub(mask):
                mask = np.asarray(mask, bool)
                return {"n": int(mask.sum()), "medianGain": round(float(np.median(g[mask])), 4) if mask.any() else None,
                        "median_dS": round(float(np.median(dS[mask])), 4) if mask.any() else None}
            r = {"label": PLAN.get(v) or EXTRA[v], "n": len(ps), "photos": ps,
                 "medianGain": round(float(np.median(g)), 4) if len(ps) else None, "medianGainCI95": boot_median(g),
                 "ratioOfSums": round(float(Iv.sum() / max(I0.sum(), 1)), 4) if len(ps) else None,
                 "nImproved": int((Iv > I0).sum()), "nWorse": int((Iv < I0).sum()),
                 "median_dS": round(float(np.median(dS)), 4) if len(ps) else None, "wilcoxonP_dS_greater": pw,
                 "nNonzero_dS": nz, "separationGain": sep_gain,
                 "rank1_v0": int(sum(per_photo[p][m][0]["rank1"] for p in ps)),
                 "rank1_v": int(sum(per_photo[p][m][v]["rank1"] for p in ps)),
                 "sumI_v0": int(I0.sum()), "sumI_v": int(Iv.sum()),
                 "medianI_v0": float(np.median(I0)) if len(ps) else None, "medianI_v": float(np.median(Iv)) if len(ps) else None,
                 "snowy": sub([per_photo[p]["snowy"] for p in ps]), "lowSun": sub([per_photo[p]["lowSun"] for p in ps])}
            if v in PLAN:
                r["KILL"] = bool((r["medianGain"] is None or r["medianGain"] < GAIN_T) and not sep_gain)
            out[str(v)] = r
        res["matchers"][m] = out
    cells = {f"{m}/v{v}": res["matchers"][m][str(v)]["KILL"] for m in MATCHERS for v in PLAN
             if str(v) in res["matchers"].get(m, {})}
    res["decision"] = {"cells_KILL": cells, "E2_KILLED": all(cells.values()) and len(cells) == 6,
                       "passingCells": [k for k, x in cells.items() if not x],
                       "e1ScoreSeparation": "PENDING (E1 hyp_scores not available; own decoys used)"}
    res["perPhoto"] = per_photo
    json.dump(res, open(HERE / "results.json", "w"), indent=1, default=lambda o: bool(o) if isinstance(o, np.bool_) else float(o))
    for m in MATCHERS:
        print(f"== {m}")
        for v, r in res["matchers"][m].items():
            print(f" v{v} {r['label']:36s} n={r['n']:2d} medGain={r['medianGain']} CI={r['medianGainCI95']} "
                  f"sumRatio={r['ratioOfSums']} up/down={r['nImproved']}/{r['nWorse']} med_dS={r['median_dS']} "
                  f"p={r['wilcoxonP_dS_greater']} sepGain={r['separationGain']} rank1 {r['rank1_v0']}->{r['rank1_v']} "
                  f"KILL={r.get('KILL')}")
    print(res["decision"])


if __name__ == "__main__":
    main()
