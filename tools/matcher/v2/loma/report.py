"""Aggregate ab.py records → markdown tables (experiments 2-4).

    python report.py [RUN_DIR] > tables.md
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
DEFAULT = Path("/private/tmp/claude-501/-Users-robertchristie-Documents-GitHub-mt-image/75c91a88-da3f-430c-b0e0-21fa75f9d390/scratchpad/loma/runs/main")
KINDS = ("aliked", "loma", "loma4096")
NAMES = {"aliked": "ALIKED+LG 4096", "loma": "LoMa-B 2048", "loma4096": "LoMa-B 4096"}
RUN = DEFAULT
LBEST = "loma4096"
STRONG = 100


def dang(a, b):
    return (a - b + 540.0) % 360.0 - 180.0


def med(x):
    x = [v for v in x if v is not None]
    return float(np.median(x)) if x else float("nan")


def hfov(vfov, rec):
    # render aspect = photo aspect; recover from hfov0/vfov0
    import math
    a = math.tan(math.radians(rec["hfov0"]) / 2) / math.tan(math.radians(rec["vfov0"]) / 2)
    return 2 * math.degrees(math.atan(math.tan(math.radians(vfov) / 2) * a))


def subsets(rec):
    t = rec.get("tags", {})
    notes = t.get("notes", "") or ""
    s = []
    if t.get("season") == "winter":
        s.append("winter")
    if re.search(r"haz|fog|mist", notes, re.I):
        s.append("haze")
    if t.get("skylineDist") == "near":
        s.append("near")
    return s


def sweep_eval(rec, kind):
    """Discrimination on the 40° sweep for a photo with correct refs."""
    sw = rec["sweep"][kind]["views"]
    refs = rec["correctRefs"]
    hf = hfov(rec["sweep"]["vfov"], rec)
    d = [min(abs(dang(v["yaw"], r["pose"]["yaw"])) for r in refs) for v in sw]
    near = int(np.argmin(d))
    correct = {near} | {i for i, v in enumerate(sw) if (v.get("refRotErr") is not None and v["refRotErr"] < 3 and d[i] < hf)}
    wrong = [i for i in range(len(sw)) if d[i] >= hf and i not in correct]
    bc = max(sw[i]["inliers"] for i in correct)
    bw = max((sw[i]["inliers"] for i in wrong), default=0)
    top = int(np.argmax([v["inliers"] for v in sw]))
    pooled = rec["sweep"][kind]["pooled"]
    pe = None
    if pooled.get("pose"):
        from ab import rot_err
        pe = min(rot_err(pooled["pose"], {k: float(r["pose"][k]) for k in ("yaw", "pitch", "roll", "vfov")}) for r in refs)
    return {"bestCorrect": bc, "bestWrong": bw, "ratio": bc / max(bw, 1), "top1": top in correct, "nWrong": len(wrong),
            "nearInl": sw[near]["inliers"], "nearAtRef6": sw[near].get("liftedAtRef6", 0), "nearRotErr": sw[near].get("refRotErr"),
            "pooledInl": pooled["inliers"], "pooledRotErr": pe, "pooledOK": pe is not None and pe < max(2.0, 0.1 * hf) and pooled["inliers"] >= 30}


def fmt(x, nd=1):
    if x is None or (isinstance(x, float) and not np.isfinite(x)):
        return "–"
    if isinstance(x, float):
        return f"{x:.{nd}f}"
    return str(x)


def oracle_table(recs, title):
    rs = [r for r in recs if "oracle" in r and all(k in r["oracle"] for k in KINDS)]
    out = [f"### {title} (n = {len(rs)} photos with a correct ref)\n",
           "| matcher | view | median lifted | median inliers | median lifted ≤6 px of ref | median inlier frac ≤6 px of ref | median rot err ° | rot err < 1° | < 2° | ≥ 30 inl & < 2° | ms / pair (median) |",
           "|---|---|---|---|---|---|---|---|---|---|---|"]
    for k in KINDS:
        for v in ("centre", "fan"):
            S = [r["oracle"][k][v] for r in rs]
            re_ = [s.get("rotErr") for s in S]
            out.append(f"| {NAMES[k]} | {v} | {med([s['lifted'] for s in S]):.0f} | {med([s['inliers'] for s in S]):.0f} | "
                       f"{med([s.get('liftedAtRef6', 0) for s in S]):.0f} | {fmt(med([s.get('inlAtRef6Frac') for s in S]), 2)} | "
                       f"{fmt(med(re_), 2)} | {sum(1 for e in re_ if e is not None and e < 1)} | {sum(1 for e in re_ if e is not None and e < 2)} | "
                       f"{sum(1 for s in S if s.get('rotErr') is not None and s['rotErr'] < 2 and s['inliers'] >= 30)} | "
                       f"{med([r['oracle'][k]['msPerPair'] for r in rs]):.0f} |")
    return "\n".join(out) + "\n"


def oracle_per_photo(recs):
    rs = [r for r in recs if "oracle" in r and all(k in r["oracle"] for k in KINDS)]
    out = ["| photo | tags | " + " | ".join(f"{NAMES[k]} centre inl" for k in KINDS) + " | "
           + " | ".join(f"{NAMES[k]} fan inl / rot° vs ref" for k in KINDS) + " |", "|---|---|" + "---|" * (2 * len(KINDS))]
    for r in rs:
        o = r["oracle"]
        out.append(f"| {r['id']} | {','.join(subsets(r))} | " + " | ".join(str(o[k]["centre"]["inliers"]) for k in KINDS) + " | "
                   + " | ".join(f"{o[k]['fan']['inliers']} / {fmt(o[k]['fan'].get('rotErr'), 2)}" for k in KINDS) + " |")
    return "\n".join(out) + "\n"


def _load(rec, name):
    z = np.load(RUN / rec["id"] / f"{name}.npz")
    return {"x2d": z["x2d"].astype(float), "X": z["X"], "W": int(z["W"]), "H": int(z["H"]), "perView": json.loads(str(z["per"]))}


def _solve(c, eye, vfov, ff):
    import match as M
    from common import R_to_pose, focal_px, vfov_from_f
    s = M.solve_rotation(c["x2d"], c["X"], np.asarray(eye, float), c["W"], c["H"], focal_px(vfov, c["H"]), ff)
    if s is None:
        return None, 0
    return R_to_pose(s["R"], vfov_from_f(s["f"], c["H"])), int(s["inliers"].sum())


def consensus_table(recs, title):
    """The verified refs come from other pipeline versions / eye heights / focal: on the oracle render they
    sit 1-2° from where BOTH matchers solve, so 6 px agreement with the raw ref is ~0 for both. Consensus pose
    = rotation solved from the pooled fan matches of all matchers, kept if within 3° of the ref. Per matcher:
    lifted matches within 6 px of the consensus, and the matcher's own solve vs the consensus."""
    import ab
    rows = {k: [] for k in KINDS}
    n = 0
    for r in recs:
        if "oracle" not in r or not all(k in r["oracle"] for k in KINDS):
            continue
        o = r["oracle"]
        ref, eye, ff = o["ref"], o["eye"], not r["focalKnown"]
        C = {k: _load(r, f"oracle_{k}") for k in KINDS}
        pool = {**C[KINDS[0]], "x2d": np.concatenate([C[k]["x2d"] for k in KINDS]), "X": np.concatenate([C[k]["X"] for k in KINDS])}
        cp, _ = _solve(pool, eye, ref["vfov"], ff)
        if cp is None or ab.rot_err(cp, ref) > 3:
            continue
        n += 1
        for k in KINDS:
            c = C[k]
            e = ab.resid_px(c, cp, eye)
            own, ninl = _solve(c, eye, ref["vfov"], ff)
            inl6 = 0
            if own is not None:
                es = ab.resid_px(c, own, eye)
                inl6 = float(((es < 6) & (e < 6)).sum() / max(1, (es < 6).sum()))
            rows[k].append({"sup": int((e < 6).sum()), "frac": float((e < 6).mean()) if len(e) else 0.0, "inl": ninl, "inl6": inl6,
                            "err": ab.rot_err(own, cp) if own is not None else None})
    out = [f"### {title} (n = {n} photos whose pooled consensus is within 3° of the ref)\n",
           "| matcher | median lifted ≤ 6 px of consensus | median frac of lifted ≤ 6 px | median own-solve inliers | median frac of own inliers ≤ 6 px of consensus | median own rot err vs consensus ° | own err < 0.5° |",
           "|---|---|---|---|---|---|---|"]
    for k in KINDS:
        R = rows[k]
        if not R:
            continue
        out.append(f"| {NAMES[k]} | {med([x['sup'] for x in R]):.0f} | {med([x['frac'] for x in R]):.2f} | {med([x['inl'] for x in R]):.0f} | "
                   f"{med([x['inl6'] for x in R]):.2f} | {fmt(med([x['err'] for x in R]), 3)} | {sum(1 for x in R if x['err'] is not None and x['err'] < 0.5)} |")
    return "\n".join(out) + "\n"


def sweep_table(recs, title):
    rs = [r for r in recs if r.get("correctRefs") and all(k in r.get("sweep", {}) for k in KINDS)]
    out = [f"### {title} (n = {len(rs)} photos with a correct ref)\n",
           "| matcher | top-1 view is correct | median best-correct inl | median best-wrong inl | median ratio correct/wrong | ratio ≥ 2 | best-wrong ≥ 100 | pooled 9-view solve correct (< max(2°, 0.1·hfov), ≥ 30 inl) |",
           "|---|---|---|---|---|---|---|---|"]
    for k in KINDS:
        E = [sweep_eval(r, k) for r in rs]
        out.append(f"| {NAMES[k]} | {sum(e['top1'] for e in E)}/{len(E)} | {med([e['bestCorrect'] for e in E]):.0f} | "
                   f"{med([e['bestWrong'] for e in E]):.0f} | {fmt(med([e['ratio'] for e in E]), 2)} | {sum(e['ratio'] >= 2 for e in E)} | "
                   f"{sum(e['bestWrong'] >= STRONG for e in E)} | {sum(e['pooledOK'] for e in E)} |")
    return "\n".join(out) + "\n"


def sweep_per_photo(recs):
    rs = [r for r in recs if r.get("correctRefs") and all(k in r.get("sweep", {}) for k in KINDS)]
    out = ["| photo | tags | " + " | ".join(f"{NAMES[k]} correct / wrong (top-1)" for k in KINDS) + " | "
           + " | ".join(f"{NAMES[k]} pooled inl / rot°" for k in KINDS) + " |", "|---|---|" + "---|" * (2 * len(KINDS))]
    for r in rs:
        E = {k: sweep_eval(r, k) for k in KINDS}
        out.append(f"| {r['id']} | {','.join(subsets(r))} | "
                   + " | ".join(f"{E[k]['bestCorrect']} / {E[k]['bestWrong']} ({'Y' if E[k]['top1'] else 'n'})" for k in KINDS) + " | "
                   + " | ".join(f"{E[k]['pooledInl']} / {fmt(E[k]['pooledRotErr'], 1)}" for k in KINDS) + " |")
    return "\n".join(out) + "\n"


def noref_table(recs):
    rs = [r for r in recs if not r.get("correctRefs") and all(k in r.get("sweep", {}) for k in KINDS)]
    out = [f"### Photos with NO correct ref (n = {len(rs)}): strong (≥ {STRONG}-inlier) single-view support\n",
           "| photo | tags | " + " | ".join(f"{NAMES[k]} best inl (view yaw)" for k in KINDS) + f" | {NAMES[LBEST]} views ≥ 100 inl: view yaw → solved (yaw, pitch, roll), inl | within 3° of a wrong ref? |",
           "|---|---|" + "---|" * len(KINDS) + "---|---|"]
    from ab import rot_err
    for r in rs:
        cells = []
        for k in KINDS:
            sw = r["sweep"][k]["views"]
            i = int(np.argmax([v["inliers"] for v in sw]))
            cells.append(f"{sw[i]['inliers']} ({sw[i]['yaw']:.0f}°)")
        strong = [v for v in r["sweep"][LBEST]["views"] if v["inliers"] >= STRONG and v.get("pose")]
        desc = "; ".join(f"{v['yaw']:.0f}° → ({v['pose']['yaw']:.1f}, {v['pose']['pitch']:.1f}, {v['pose']['roll']:.1f}), {v['inliers']}" for v in strong) or "none"
        wr = []
        for v in strong:
            for w in r.get("wrongRefs", []):
                e = rot_err(v["pose"], {k: float(w["pose"][k]) for k in ("yaw", "pitch", "roll", "vfov")})
                if e < 3:
                    wr.append(f"{w['label']} ({e:.1f}°)")
        out.append(f"| {r['id']} | {','.join(subsets(r))} | {' | '.join(cells)} | {desc} | {', '.join(wr) or '–'} |")
    return "\n".join(out) + "\n"


def main():
    global RUN
    d = RUN = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT
    recs = [json.load(open(f)) for f in sorted(d.glob("wc_*.json"))]
    errs = [r["id"] for r in recs if r.get("error")]
    loads = [r["loadavg"][0] for r in recs if r.get("loadavg")]
    print(f"records: {len(recs)}; errors: {errs or 'none'}; load avg (1 min) during run: median {med(loads):.0f}, max {max(loads):.0f}\n")
    print("## Experiment 2: oracle recall\n")
    print(oracle_table(recs, "All dev"))
    print(consensus_table(recs, "All dev: agreement with a matcher-pooled consensus pose"))
    print(oracle_per_photo(recs))
    print("## Experiment 3: sweep discrimination\n")
    print(sweep_table(recs, "All dev"))
    print(sweep_per_photo(recs))
    print(noref_table(recs))
    print("## Experiment 4: hard subsets\n")
    for s in ("winter", "haze", "near"):
        sub = [r for r in recs if s in subsets(r)]
        print(oracle_table(sub, f"{s}: oracle"))
        print(consensus_table(sub, f"{s}: consensus"))
        print(sweep_table(sub, f"{s}: sweep"))
        nr = [r for r in sub if not r.get("correctRefs")]
        if nr:
            cnt = {k: sum(max(v["inliers"] for v in r["sweep"][k]["views"]) >= STRONG for r in nr if "sweep" in r) for k in KINDS}
            print(f"{s}, no correct ref: {len(nr)} photos; any sweep view ≥ {STRONG} inl: " + ", ".join(f"{NAMES[k]} {cnt[k]}" for k in KINDS) + "\n")


if __name__ == "__main__":
    main()
