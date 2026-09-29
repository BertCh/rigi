"""Aggregate results_raw.json (spike.py) into results.json: scale behaviour, fit quality, split stats, verifier AUCs.

    tools/matcher/.venv/bin/python tools/nearfield/spike/analyze.py
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
RAW = json.load(open(HERE / "results_raw.json"))
MODELS = ("moge_l", "moge_b", "da3_b")
RS = ("300", "1000", "3000")


def auc(pos, neg):
    """P(score_pos < score_neg) for lower-is-better scores (ties 0.5). pos = correct."""
    pos, neg = np.asarray(pos, float), np.asarray(neg, float)
    if not len(pos) or not len(neg):
        return None
    c = (pos[:, None] < neg[None, :]).mean() + 0.5 * (pos[:, None] == neg[None, :]).mean()
    return round(float(c), 3)


def fit(v, m, R, kind="scale", intr="solved"):
    try:
        f = v["models"][m][intr][R][kind]
    except KeyError:
        return None
    return f if f.get("ok") else None


def base_view(p):
    return p["views"].get(f"refs/{p['base']}")


def q(x, k=3):
    return None if x is None or (isinstance(x, float) and not math.isfinite(x)) else round(float(x), k)


# signals, lower = better (more like a correct pose)
SIGNALS = {
    "residualLogAll": lambda f: f["residualLogAll"],
    "residualLog_inliers": lambda f: f["residualLog"],
    "neg_inlierFrac": lambda f: -f["inlierFrac"],
    "neg_quality": lambda f: -quality(f["residualLogAll"], f["inlierFrac"]),
}


def quality(res, inl, r0=0.2):
    """Proposed AnchorFit.quality = inlierFrac * exp(-(residualLogAll / r0)^2) (scale-only IRLS fit). See SUMMARY."""
    return float(inl * math.exp(-((res / r0) ** 2)))


def main():
    out = {"photos": {}, "scaleVsRange": {}, "fitQuality": {}, "verifier": {}, "split": {}}
    pids = sorted(RAW)
    # ---- per-photo table (moge_l, correct base)
    for pid in pids:
        p = RAW[pid]
        v = base_view(p)
        row = {"tags": {k: p["tags"].get(k) for k in ("focalClass", "skylineDist", "foreground", "notes")},
               "hfovTrue": q(p["hfov_true"], 1), "hfovPred": {k: q(x, 1) for k, x in p["models_hfov_pred"].items()},
               "demHitFrac": q(v["demHitFrac"]), "demLt": v["demLt"], "fits": {}, "split": {}}
        for m in MODELS:
            if m not in v["models"]:
                continue
            row["fits"][m] = {}
            for R in RS:
                f, a, la = fit(v, m, R), fit(v, m, R, "affine"), fit(v, m, R, "logaffine")
                fm = fit(v, m, R, "scale", "modelIntr")
                row["fits"][m][R] = None if f is None else {
                    "n": f["n"], "scale": q(f["scale"]), "residualLog": q(f["residualLog"]),
                    "residualLogAll": q(f["residualLogAll"]), "inlierFrac": q(f["inlierFrac"]),
                    "quality": q(quality(f["residualLogAll"], f["inlierFrac"])),
                    "affine": a and {"scale": q(a["scale"]), "shift": q(a["shift"], 1), "residualLogAll": q(a["residualLogAll"]), "inlierFrac": q(a["inlierFrac"])},
                    "logaffine": la and {"b": q(la["b"]), "residualLogAll": q(la["residualLogAll"]), "inlierFrac": q(la["inlierFrac"])},
                    "modelIntr": fm and {"scale": q(fm["scale"]), "residualLogAll": q(fm["residualLogAll"]), "inlierFrac": q(fm["inlierFrac"])},
                }
            row["split"][m] = {vn: {k: (q(x) if isinstance(x, float) else x) for k, x in sv.items()}
                               for vn, sv in v["models"][m]["split"].items()}
        out["photos"][pid] = row

    # ---- scale vs range: median over photos of per-bin median log ratio (DEM/model), correct base view
    for m in MODELS:
        bins = {}
        for pid in pids:
            v = base_view(RAW[pid])
            for b in v["models"].get(m, {}).get("profile", []):
                if b["medLogRatio"] is not None:
                    bins.setdefault(f"{int(b['lo'])}-{int(b['hi']) if b['hi'] < 1e8 else 'inf'}", []).append(b["medLogRatio"])
        out["scaleVsRange"][m] = {k: {"nPhotos": len(x), "medianScale": q(math.exp(np.median(x))),
                                      "p25": q(math.exp(np.percentile(x, 25))), "p75": q(math.exp(np.percentile(x, 75)))}
                                  for k, x in bins.items()}

    # ---- fit quality summary per model, R, fit kind (correct base view)
    for m in MODELS:
        for R in RS:
            for kind in ("scale", "affine", "logaffine"):
                for intr in ("solved", "modelIntr") if kind == "scale" else ("solved",):
                    fs = [fit(base_view(RAW[p]), m, R, kind, intr) for p in pids]
                    ok = [f for f in fs if f]
                    if not ok:
                        continue
                    res = np.array([f["residualLogAll"] for f in ok])
                    key = f"{m}|R{R}|{kind}" + ("|modelIntr" if intr != "solved" else "")
                    d = {"nPhotos": len(ok), "of": len(pids),
                         "medResidualLogAll": q(np.median(res)), "fracRes<0.1": q((res < 0.1).mean()),
                         "fracRes<0.2": q((res < 0.2).mean()),
                         "medInlierFrac": q(np.median([f["inlierFrac"] for f in ok])),
                         "medResidualLog_inliers": q(np.median([f["residualLog"] for f in ok]))}
                    if kind == "scale":
                        sc = np.array([f["scale"] for f in ok])
                        d.update({"medScale": q(np.median(sc)), "fracScaleIn[0.8,1.25]": q(((sc > 0.8) & (sc < 1.25)).mean()),
                                  "scaleP10": q(np.percentile(sc, 10)), "scaleP90": q(np.percentile(sc, 90))})
                    if kind == "logaffine":
                        d["medB"] = q(np.median([f["b"] for f in ok]))
                    out["fitQuality"][key] = d

    # ---- verifier
    groups = {"wrongRefs": lambda v: v["kind"] == "wrong",
              "yaw±8": lambda v: v["tag"] in ("yaw-8", "yaw+8"),
              "yaw±2": lambda v: v["tag"] in ("yaw-2", "yaw+2"),
              "pitch±2": lambda v: v["tag"] in ("pitch-2", "pitch+2")}
    for m in MODELS:
        for R in RS:
            for kind in ("scale", "logaffine"):
                key = f"{m}|R{R}|{kind}"
                entry = {}
                for sname, sf in SIGNALS.items():
                    if kind == "logaffine" and sname == "residualLog_inliers":
                        continue
                    pos, per = [], {g: [] for g in groups}
                    paired = {g: [] for g in groups}
                    cov = {g: [0, 0] for g in groups}
                    for pid in pids:
                        vs = RAW[pid]["views"]
                        cf = [fit(v, m, R, kind) for v in vs.values() if v["kind"] == "correct"]
                        cf = [sf(f) for f in cf if f]
                        pos += cf
                        bf = fit(base_view(RAW[pid]), m, R, kind)
                        for g, gf in groups.items():
                            for v in vs.values():
                                if not gf(v):
                                    continue
                                cov[g][1] += 1
                                f = fit(v, m, R, kind)
                                if f is None:
                                    continue
                                cov[g][0] += 1
                                per[g].append(sf(f))
                                if bf is not None:
                                    paired[g].append(1.0 if sf(bf) < sf(f) else 0.5 if sf(bf) == sf(f) else 0.0)
                    entry[sname] = {g: {"auc": auc(pos, per[g]), "nPos": len(pos), "nNeg": len(per[g]),
                                        "coverage": f"{cov[g][0]}/{cov[g][1]}",
                                        "pairedWin": q(np.mean(paired[g])) if paired[g] else None} for g in groups}
                out["verifier"][key] = entry

    # ---- split summary
    for m in MODELS:
        fr = [(out["photos"][p]["split"].get(m, {}).get("mode") or {}).get("objectFrac") for p in pids]
        fr = [x for x in fr if x is not None]
        out["split"][m] = {"medObjectFrac": q(np.median(fr)), "photosObject>1%": int(sum(x > 0.01 for x in fr)),
                           "photosObject>20%": int(sum(x > 0.2 for x in fr)), "n": len(fr)}
    # ---- split variants: object fraction per photo + design-gate residual at DEM range < 500 m
    CLEAN = json.load(open(HERE / "sweep.json"))["clean"] if (HERE / "sweep.json").exists() else []
    OBJ = json.load(open(HERE / "sweep.json"))["obj"] if (HERE / "sweep.json").exists() else []
    var = {}
    for pid in pids:
        sp = base_view(RAW[pid])["models"]["moge_l"]["split"]
        for vn, x in sp.items():
            var.setdefault(vn, {})[pid] = {"objectFrac": q(x["objectFrac"]), "resid500All": q(x.get("resid500All")),
                                           "resid500Terr": q(x.get("resid500Terr")), "n500": x.get("n500")}
    vsum = {}
    for vn, d in var.items():
        c = [d[p]["objectFrac"] for p in CLEAN if p in d]
        o = [d[p]["objectFrac"] for p in OBJ if p in d]
        r5 = [x["resid500All"] for x in d.values() if x["resid500All"] is not None]
        r5t = [x["resid500Terr"] for x in d.values() if x["resid500Terr"] is not None]
        vsum[vn] = {"cleanPhotosObject>2%": f"{sum(x > 0.02 for x in c)}/{len(c)}", "cleanMeanObjectFrac": q(np.mean(c)) if c else None,
                    "objPhotosObject>1%": f"{sum(x > 0.01 for x in o)}/{len(o)}", "objMedianObjectFrac": q(np.median(o)) if o else None,
                    "photosWithDem<500Fit": len(r5), "medResid500All": q(np.median(r5)) if r5 else None,
                    "medResid500Terrain": q(np.median(r5t)) if r5t else None,
                    "fracPhotosResid500Terrain<0.1": q(np.mean([x < 0.0953 for x in r5t])) if r5t else None}
    out["splitVariants"] = {"summary": vsum, "perPhoto": var}
    # ---- quality pass rates (scale-only IRLS fit, R = 3000 and 1000; no fit -> quality 0)
    qp = {}
    for R in ("1000", "3000"):
        for thr in (0.15, 0.25, 0.35, 0.5):
            def rate(pred):
                xs = []
                for pid in pids:
                    for v in RAW[pid]["views"].values():
                        if pred(pid, v):
                            f = fit(v, "moge_l", R)
                            xs.append(0.0 if f is None else quality(f["residualLogAll"], f["inlierFrac"]))
                return q(np.mean([x >= thr for x in xs])) if xs else None
            qp[f"R{R}|q>={thr}"] = {
                "correct": rate(lambda p, v: v["kind"] == "correct"),
                "correctObjPhotos": rate(lambda p, v: v["kind"] == "correct" and p in OBJ),
                "correctCleanPhotos": rate(lambda p, v: v["kind"] == "correct" and p in CLEAN),
                "wrongRefs": rate(lambda p, v: v["kind"] == "wrong"),
                "yaw±8": rate(lambda p, v: v["tag"] in ("yaw-8", "yaw+8")),
                "yaw±2": rate(lambda p, v: v["tag"] in ("yaw-2", "yaw+2"))}
    out["qualityPassRates"] = qp
    if (HERE / "verif2.json").exists():
        v2 = json.load(open(HERE / "verif2.json"))
        out["verifierOneSidedModeFit"] = {"auc": v2["auc"], "pairedWin": v2["pairedWin"]}
    if (HERE / "sweep.json").exists():
        sw = json.load(open(HERE / "sweep.json"))
        out["splitSweepTop"] = [{k: v for k, v in r.items() if k != "perPhoto"} for r in sw["rows"][:20]]
    json.dump(out, open(HERE / "results.json", "w"), indent=1)
    print(json.dumps(vsum, indent=0))
    print(json.dumps(qp, indent=0))
    # console digest
    for k, d in out["fitQuality"].items():
        if k.startswith("moge_l") or "|R1000|scale" in k:
            print(k, d)
    print("scaleVsRange moge_l", out["scaleVsRange"]["moge_l"])
    print("scaleVsRange da3_b", out["scaleVsRange"]["da3_b"])
    for k, e in out["verifier"].items():
        print(k, {s: {g: (x["auc"], x["pairedWin"], x["coverage"]) for g, x in d.items()} for s, d in e.items()})
    print(out["split"])


if __name__ == "__main__":
    main()
