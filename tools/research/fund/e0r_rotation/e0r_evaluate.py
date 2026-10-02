# Rigi
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: Copyright (c) Rigi contributors
"""FUND E0r evaluation (PROTOCOL.txt): w*/AUROC of the rotation predictor -hfov/w* on the horizon-fast 360 deg skyline.
Input: out/research/e0r/<id>.json (scripts/research/e0r-skyline.ts), E0 results.json (labels, hfov0, old w*).
minres_table / wstar / auc / auc_ci are copied from tools/research/fund/e0_observability/{compute,evaluate}.py.
Run: tools/matcher/.venv/bin/python tools/research/fund/e0r_rotation/e0r_evaluate.py [skyline_dir]
"""
from __future__ import annotations
import json, math, sys
from pathlib import Path
import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
SKY = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "out/research/e0r"
E0 = json.load(open(ROOT / "tools/research/fund/e0_observability/results.json"))
PER = {r["pid"]: r for r in E0["per_photo"]}
STEP = 0.25
NB = int(360 / STEP)
WIDTHS = list(range(2, 61, 2)) + [70, 80, 90, 105, 120, 150, 180]
EXCL = 3.0
A0S = [float(a) for a in range(0, 360, 5)]
FLOORS = [0.05, 0.10, 0.20, 0.30, 0.50]
rng = np.random.default_rng(0)


def resample(elev):
    """3600 horizon-fast azimuths (0.1 deg) -> 0.25 deg: max of the overlapping 0.1 bins; -90 = no terrain = invalid."""
    fine = np.asarray(elev, float)
    fine[fine <= -89.99] = np.nan
    S = np.full(NB, np.nan)
    for j in range(NB):
        a, b = j * STEP * 10, (j + 1) * STEP * 10
        seg = fine[int(math.floor(a)):int(math.ceil(b))]
        if len(seg) and np.all(np.isfinite(seg)):
            S[j] = seg.max()
    return S


def minres_table(S, a0_list):  # verbatim from E0 compute.py
    ext = np.concatenate([S, S])
    out = np.full((len(a0_list), len(WIDTHS)), np.nan)
    cand = np.arange(NB)
    for wi, w in enumerate(WIDTHS):
        n = int(round(w / STEP)) + 1
        half = (n - 1) // 2
        starts = (cand - half) % NB
        M = ext[(starts[:, None] + np.arange(n)[None, :])]
        Mv = np.isfinite(M)
        for ai, a0 in enumerate(a0_list):
            j0 = int(round(a0 / STEP)) % NB
            P = M[j0]
            pv = np.isfinite(P)
            if pv.mean() < 0.7:
                continue
            both = Mv & pv[None, :]
            cnt = both.sum(1)
            dif = np.where(both, M - np.where(pv, P, 0)[None, :], 0.0)
            mu = dif.sum(1) / np.maximum(cnt, 1)
            var = (np.where(both, (dif - mu[:, None]) ** 2, 0).sum(1)) / np.maximum(cnt, 1)
            r = np.sqrt(var)
            circ = np.abs(((cand - j0) * STEP + 180) % 360 - 180)
            use = (circ > EXCL) & (cnt >= 0.7 * n)
            out[ai, wi] = r[use].min() if use.any() else np.inf
    return out


def wstar(row, floor):  # E0 evaluate.py semantics (None == nan)
    row = [None if (r is None or (isinstance(r, float) and math.isnan(r))) else r for r in row]
    if all(r is None for r in row):
        return math.nan
    for w, r in zip(WIDTHS, row):
        if r is None:
            continue
        if r == float("inf") or r > floor:
            return float(w)
    return 360.0


def wmed(tab, floor):
    ws = [wstar(list(r), floor) for r in tab]
    ws = [w for w in ws if np.isfinite(w)]
    return float(np.median(ws)) if ws else math.nan


def auc(pos, neg):
    pos, neg = np.asarray(pos, float), np.asarray(neg, float)
    pos, neg = pos[np.isfinite(pos)], neg[np.isfinite(neg)]
    if len(pos) == 0 or len(neg) == 0:
        return math.nan, 0, 0
    g = (pos[:, None] > neg[None, :]).mean() + 0.5 * (pos[:, None] == neg[None, :]).mean()
    return float(g), len(pos), len(neg)


def auc_ci(pos, neg, nb=4000, nperm=10000):
    pos, neg = np.asarray(pos, float), np.asarray(neg, float)
    pos, neg = pos[np.isfinite(pos)], neg[np.isfinite(neg)]
    a, npos, nneg = auc(pos, neg)
    if not npos or not nneg:
        return dict(auc=None, n_pos=npos, n_neg=nneg)
    bs = [auc(rng.choice(pos, npos), rng.choice(neg, nneg))[0] for _ in range(nb)]
    allv = np.concatenate([pos, neg]); ge = 0
    for _ in range(nperm):
        p = rng.permutation(allv)
        ge += auc(p[:npos], p[npos:])[0] >= a - 1e-12
    return dict(auc=round(a, 3), ci95=[round(float(np.percentile(bs, 2.5)), 3), round(float(np.percentile(bs, 97.5)), 3)],
                p_perm=round((ge + 1) / (nperm + 1), 4), n_pos=npos, n_neg=nneg)


def med(v):
    v = [x for x in v if x is not None and np.isfinite(x)]
    return round(float(np.median(v)), 3) if v else None


def main():
    ids = sorted(PER)
    lab = {p: PER[p]["label"] for p in ids}
    # sanity: E0's original AUROC from its stored features
    e0_score = {p: -PER[p]["hfov0"] / PER[p]["A_wstar"] for p in ids}
    e0_auc = auc_ci([e0_score[p] for p in ids if lab[p] == "ROT"], [e0_score[p] for p in ids if lab[p] == "SUCCESS"], 1000, 1000)
    tabs, sky_nan, hfov = {}, {}, {}
    for p in ids:
        d = json.load(open(SKY / f"{p}.json"))
        S = resample(d["elevation"])
        sky_nan[p] = float(np.isnan(S).mean())
        tabs[p] = minres_table(S, A0S)
        hfov[p] = PER[p]["hfov0"]

    def scores(floor):
        w = {p: wmed(tabs[p], floor) for p in ids}
        return w, {p: -hfov[p] / w[p] if np.isfinite(w[p]) else math.nan for p in ids}

    def cmp(sc, fp, fn):
        return auc_ci([sc[p] for p in ids if fp(p)], [sc[p] for p in ids if fn(p)])

    rot, suc = (lambda p: lab[p] == "ROT"), (lambda p: lab[p] == "SUCCESS")
    w10, sc10 = scores(0.10)
    primary = cmp(sc10, rot, suc)
    verdict = "KILL" if primary["auc"] < 0.65 else "PASS"
    clipped_e0 = {p: PER[p]["sky_invalid"] for p in ids}
    low = lambda p: clipped_e0[p] < 0.30
    res = {
        "protocol": "PROTOCOL.txt", "kill_criterion": "KILL if AUROC(ROT vs SUCCESS, -hfov/w*, analysis A, floor 0.10, horizon-fast 360 skyline) < 0.65; else PASS (dev only; n = 16 vs 19)",
        "primary": dict(primary, verdict=verdict),
        "sanity": {"e0_original_auc_recomputed": e0_auc, "e0_reported": 0.599,
                   "ring_vs_horizon_fast_median_abs_delta": "skipped: E0 ring skylines and C0 cache gone",
                   "new_skyline_invalid_frac_max": max(sky_nan.values())},
        "w_star": {}, "floor_sweep": {}, "secondary": {},
    }
    n360 = lambda w: sum(w[p] == 360.0 for p in ids)
    w_old = {p: PER[p]["A_wstar"] for p in ids}
    res["w_star"] = {"n_w360_new": n360(w10), "n_w360_e0": n360(w_old),
                     "median_by_group_new": {g: med([w10[p] for p in ids if lab[p] == g]) for g in ("SUCCESS", "ROT", "POS", "OTHER")},
                     "median_by_group_e0": {g: med([w_old[p] for p in ids if lab[p] == g]) for g in ("SUCCESS", "ROT", "POS", "OTHER")},
                     "w360_among_e0_clipped_ge50": [int(w10[p] == 360.0) for p in ids if clipped_e0[p] >= 0.5]}
    for fl in FLOORS:
        w, sc = scores(fl)
        res["floor_sweep"][str(fl)] = {"ROT_vs_rest": cmp(sc, rot, lambda p: lab[p] != "ROT"),
                                       "ROT_vs_SUCCESS": cmp(sc, rot, suc),
                                       "median_w_by_group": {g: med([w[p] for p in ids if lab[p] == g]) for g in ("SUCCESS", "ROT", "POS", "OTHER")}}
    res["secondary"]["ROT_vs_SUCCESS_e0_lt30pct_clipped_floor0.10"] = cmp(sc10, lambda p: rot(p) and low(p), lambda p: suc(p) and low(p))
    res["secondary"]["ROT_vs_rest_floor0.10"] = cmp(sc10, rot, lambda p: lab[p] != "ROT")
    res["secondary"]["spearman_newR_vs_e0R"] = None
    try:
        from scipy.stats import spearmanr
        a = [-sc10[p] for p in ids if np.isfinite(sc10[p])]; b = [PER[p]["A_R"] for p in ids if np.isfinite(sc10[p])]
        res["secondary"]["spearman_newR_vs_e0R"] = round(float(spearmanr(a, b)[0]), 3)
    except Exception:
        pass
    res["per_photo"] = [dict(pid=p, label=lab[p], hfov0=hfov[p], e0_clipped=clipped_e0[p], w_new=w10[p], w_e0=w_old[p],
                             R_new=None if not np.isfinite(sc10[p]) else round(-sc10[p], 3), invalid_new=round(sky_nan[p], 3)) for p in ids]
    json.dump(res, open(HERE / "results.json", "w"), indent=1)
    print(json.dumps({k: res[k] for k in ("primary", "sanity", "w_star", "secondary")}, indent=1))
    for fl, v in res["floor_sweep"].items():
        print("floor", fl, "ROT/rest", v["ROT_vs_rest"]["auc"], "ROT/SUCC", v["ROT_vs_SUCCESS"]["auc"], v["median_w_by_group"])


if __name__ == "__main__":
    main()
