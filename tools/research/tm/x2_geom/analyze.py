"""X2 analysis: discrimination (A), localisation (B), complementarity (C) from results/*.json.

    python analyze.py [--subset odd|even|all] [--out results_<subset>.json]
"""
from __future__ import annotations
import _env  # noqa: F401
import argparse, json, math, glob
import numpy as np

MODELS = ["moge_l", "moge_b", "da3_b"]
KEYS = ["sky_miou", "rank_t", "rank_all", "ord_local", "ord_global", "edge_int", "edge_all", "normal_cos", "combo", "combo_int"]
# combos = mean of null-z-scores; fixed on the odd subset before the even ids were scored (see REPORT)
COMBOS = {"combo": ["rank_all", "ord_local", "edge_all"],          # uses sky/skyline too
          "combo_int": ["rank_t", "ord_local", "edge_int"]}         # terrain-internal only (no sky / skyline terms)
TRAPS = ["wc_0001", "wc_0069", "wc_0070", "wc_0074"]


def auroc(pos, neg):
    pos = [p for p in pos if p is not None and np.isfinite(p)]
    neg = [n for n in neg if n is not None and np.isfinite(n)]
    if not pos or not neg:
        return None
    pos, neg = np.asarray(pos), np.asarray(neg)
    gt = (pos[:, None] > neg[None, :]).mean() + 0.5 * (pos[:, None] == neg[None, :]).mean()
    return float(gt)


def nullstats(null, model, key):
    v = np.array([(r.get(model) or {}).get(key, np.nan) if key not in COMBOS else np.nan for r in null], float)
    v = v[np.isfinite(v)]
    if len(v) < 5:
        return None
    med = np.median(v); iqr = np.subtract(*np.percentile(v, [75, 25]))
    return med, max(iqr / 1.349, 1e-3), v


def get(row, model, key, z=False, null=None):
    """Raw score, or z vs the pose's own null yaw distribution. combo = mean of z-scores of COMBO keys."""
    if key in COMBOS:
        null = null if null is not None else row.get("null")
        if not null:
            return None
        zs = [get(row, model, k, True, null) for k in COMBOS[key]]
        zs = [x for x in zs if x is not None and np.isfinite(x)]
        return float(np.mean(zs)) if len(zs) == len(COMBOS[key]) else None
    s = (row["scores"].get(model) or {}).get(key)
    if s is None or not np.isfinite(s):
        return None
    if not z:
        return float(s)
    null = null if null is not None else row.get("null")
    ns = nullstats(null, model, key) if null else None
    if ns is None:
        return None
    return float((s - ns[0]) / ns[1])


def subset_ids(files, subset):
    ids = sorted(f.split("/")[-1][:-5] for f in files)
    if subset == "odd":
        return [i for i in ids if int(i[3:]) % 2 == 1]
    if subset == "even":
        return [i for i in ids if int(i[3:]) % 2 == 0]
    return ids


def analyse(R, verbose=True):
    out = {"n_photos": len(R)}
    # ---------------- (A) discrimination on refs
    A = {}
    for m in MODELS:
        for k in KEYS:
            for z in (False, True):
                if k in COMBOS and not z:
                    continue
                pos, neg, pairs, photos_both, best_ok = [], [], [], 0, 0
                for r in R.values():
                    c = [get(x, m, k, z) for x in r["refs"] if x["verdict"] == "correct"]
                    w = [get(x, m, k, z) for x in r["refs"] if x["verdict"] == "wrong"]
                    c = [x for x in c if x is not None]; w = [x for x in w if x is not None]
                    pos += c; neg += w
                    if c and w:
                        photos_both += 1
                        pairs += [float(a > b) for a in c for b in w]
                        best_ok += max(c) > max(w)
                A[f"{m}.{k}{'.z' if z else ''}"] = {"auroc": auroc(pos, neg), "n_pos": len(pos), "n_neg": len(neg),
                                                   "pair_win": float(np.mean(pairs)) if pairs else None,
                                                   "photos_both": photos_both, "best_correct_wins": best_ok}
    out["A"] = A
    # traps
    traps = {}
    for pid in TRAPS:
        if pid not in R:
            continue
        rows = []
        for x in R[pid]["refs"]:
            rows.append({"label": x["label"], "verdict": x["verdict"], "pose": {k: round(v, 1) for k, v in x["pose"].items()},
                         **{f"{m}.{k}{'.z' if z else ''}": get(x, m, k, z) for m in ("moge_l", "da3_b")
                            for k in ("rank_all", "rank_t", "ord_local", "edge_all", "edge_int", "normal_cos", "combo", "combo_int") for z in (False, True)
                            if not (k in COMBOS and not z)}})
        traps[pid] = rows
    out["traps"] = traps
    # ---------------- (B) localisation
    B = {}
    for m in MODELS:
        for k in KEYS:
            if k in COMBOS:
                continue
            yaw_argmax0, pitch_argmax0, n, drops = 0, 0, 0, {o: [] for o in (-8, -4, -2, -1, 1, 2, 4, 8)}
            pdrops = {o: [] for o in (-2, -1, 1, 2)}
            for r in R.values():
                if not r["perturb"]:
                    continue
                base = next((x for x in r["refs"] if x["verdict"] == "correct"), None)
                if base is None:
                    continue
                s0 = get(base, m, k)
                ns = nullstats(base["null"], m, k)
                if s0 is None or ns is None:
                    continue
                n += 1
                ys = {p["offset"]: get(p, m, k) for p in r["perturb"] if p["axis"] == "yaw"}
                ps = {p["offset"]: get(p, m, k) for p in r["perturb"] if p["axis"] == "pitch"}
                if all(v is not None for v in ys.values()):
                    yaw_argmax0 += s0 >= max(ys.values())
                if all(v is not None for v in ps.values()):
                    pitch_argmax0 += s0 >= max(ps.values())
                for o in drops:
                    if ys.get(o) is not None:
                        drops[o].append((s0 - ys[o]) / ns[1])
                for o in pdrops:
                    if ps.get(o) is not None:
                        pdrops[o].append((s0 - ps[o]) / ns[1])
            # full-circle scans at the correct ref's pitch/roll/vfov
            scan_err, scan_rank, fwhm, top3 = [], [], [], 0
            for r in R.values():
                sc = next((s for s in r["scans"] if s["verdict"] == "correct"), None)
                if sc is None:
                    continue
                ys = np.array(sc["yaws"], float)
                v = np.array([(row.get(m) or {}).get(k, np.nan) if (row.get(m) or {}).get(k) is not None else np.nan for row in sc["scores"]], float)
                if np.isfinite(v).sum() < 100:
                    continue
                v = np.where(np.isfinite(v), v, np.nanmin(v))
                ty = sc["pose"]["yaw"]
                dy = np.abs((ys - ty + 180) % 360 - 180)
                am = ys[np.argmax(v)]
                scan_err.append(float(abs((am - ty + 180) % 360 - 180)))
                truth = v[dy <= 1.0].max()
                scan_rank.append(int((v[dy > 3] > truth).sum()))
                # local maxima (peaks separated by > 3°) above truth
                peaks = [i for i in range(len(v)) if v[i] >= v[i - 1] and v[i] >= v[(i + 1) % len(v)] and v[i] >= v[i - 2] and v[i] >= v[(i + 2) % len(v)]]
                higher = [i for i in peaks if dy[i] > 3 and v[i] > truth]
                top3 += len(higher) < 3
                # half-width: yaw span around truth where v > (truth+median)/2
                half = (truth + np.median(v)) / 2
                i0 = int(np.argmin(dy)); w = 0
                while w < 180 and v[(i0 + w) % len(v)] > half:
                    w += 1
                w2 = 0
                while w2 < 180 and v[(i0 - w2) % len(v)] > half:
                    w2 += 1
                fwhm.append(float((w + w2) * (ys[1] - ys[0])))
            B[f"{m}.{k}"] = {
                "n_perturb": n, "yaw_truth_is_max": yaw_argmax0, "pitch_truth_is_max": pitch_argmax0,
                "yaw_drop_z_median": {o: (float(np.median(d)) if d else None) for o, d in drops.items()},
                "pitch_drop_z_median": {o: (float(np.median(d)) if d else None) for o, d in pdrops.items()},
                "scan_n": len(scan_err), "scan_argmax_within2": int(sum(e <= 2 for e in scan_err)),
                "scan_argmax_within10": int(sum(e <= 10 for e in scan_err)),
                "scan_median_err": float(np.median(scan_err)) if scan_err else None,
                "scan_truth_in_top3_peaks": top3, "scan_median_higher_yaws": float(np.median(scan_rank)) if scan_rank else None,
                "scan_median_fwhm": float(np.median(fwhm)) if fwhm else None}
    out["B"] = B
    # ---------------- (C) matcher-solved poses
    Cc = {}
    for m in MODELS:
        for k in ("rank_all", "rank_t", "ord_local", "edge_all", "edge_int", "normal_cos", "sky_miou", "combo", "combo_int"):
            for z in (False, True):
                if k in COMBOS and not z:
                    continue
                good, bad, rows = [], [], []
                for pid, r in R.items():
                    for c in r["cands"]:
                        if (c.get("inliers") or 0) < 100 or c["pano_cover"] < 0.3:
                            continue
                        s = get(c, m, k, z)
                        if c["label"] == "correct":
                            good.append(s)
                        elif c["label"] in ("wrong", "near_wrong_ref"):
                            bad.append(s); rows.append((pid, c["src"], c["label"], c["inliers"], s))
                Cc[f"{m}.{k}{'.z' if z else ''}"] = {"auroc": auroc(good, bad), "n_correct": len([g for g in good if g is not None]),
                                                   "n_gross": len([b for b in bad if b is not None]),
                                                   "min_correct": min([g for g in good if g is not None], default=None),
                                                   "gross": rows}
    out["C"] = Cc
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--subset", default="all")
    a = ap.parse_args()
    files = glob.glob(str(_env.HERE / "results" / "*.json"))
    ids = subset_ids(files, a.subset)
    R = {i: json.load(open(_env.HERE / "results" / f"{i}.json")) for i in ids}
    out = analyse(R)
    out["subset"] = a.subset; out["ids"] = ids
    json.dump(out, open(_env.HERE / f"results_{a.subset}.json", "w"), indent=1)
    # console summary
    print(f"subset={a.subset} photos={len(R)}")
    print("(A) refs: key  AUROC  pairwin  best_correct_wins/photos_both   [n_pos/n_neg]")
    for k, v in out["A"].items():
        print(f"  {k:24s} {v['auroc'] if v['auroc'] is None else round(v['auroc'], 3)!s:6} "
              f"{v['pair_win'] if v['pair_win'] is None else round(v['pair_win'], 3)!s:6} {v['best_correct_wins']}/{v['photos_both']} [{v['n_pos']}/{v['n_neg']}]")
    print("(B) localisation")
    for k, v in out["B"].items():
        print(f"  {k:22s} yawmax {v['yaw_truth_is_max']}/{v['n_perturb']} pitchmax {v['pitch_truth_is_max']}/{v['n_perturb']} "
              f"drop±1 {v['yaw_drop_z_median'][-1]!s:.5} {v['yaw_drop_z_median'][1]!s:.5} ±8 {v['yaw_drop_z_median'][-8]!s:.5} {v['yaw_drop_z_median'][8]!s:.5} | "
              f"scan ≤2° {v['scan_argmax_within2']}/{v['scan_n']} ≤10° {v['scan_argmax_within10']} top3 {v['scan_truth_in_top3_peaks']} fwhm {v['scan_median_fwhm']}")
    print("(C) matcher poses ≥100 inl: AUROC correct vs gross")
    for k, v in out["C"].items():
        print(f"  {k:24s} {v['auroc'] if v['auroc'] is None else round(v['auroc'], 3)!s:6} n={v['n_correct']}/{v['n_gross']}")


if __name__ == "__main__":
    main()
