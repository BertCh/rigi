"""X5 stage C: evaluate verifier features (features.json) — per-feature AUROC, per-photo ranking, ≤4-feature logistic
regression with leave-one-photo-out CV, traps, and a simulated veto on top of T6/v2.

    python evaluate.py  -> eval.json + printed tables
Positives = correct refs (32). Negatives = wrong refs (128) + wc_0086 N7 (moved-eye HIGH, verified wrong).
Perturb views (±1..8° yaw, ±1..2° pitch around the first correct ref) are scored with the same models and reported
separately (not used for training). All CV is grouped by photo.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
from scipy.optimize import minimize

HERE = Path(__file__).resolve().parent
TM = HERE.parent
ROOT = TM.parents[2]

# direction: +1 = higher means "more likely correct" (declared a priori from the feature's meaning)
FEATS = {
    # positive evidence (baselines)
    "log_inl": 1, "frac_hyp": 1, "cov_hyp": 1, "rmse_hyp": -1, "hyp_drift": -1, "log10_nfa": -1, "log10_nfa_per_match": -1,
    # (1) depth-band consistency
    "xfer_far_mid": 1, "xfer_far_near": 1, "xfer_mid_near": 1, "rot_far_mid": -1, "rot_far_near": -1, "rot_mid_near": -1,
    "res_far_mid": -1, "res_far_near": -1, "q_xfer": 1, "q_rot_far_near": -1,
    "pnp_shift": -1, "pnp_gain": -1, "pnp_dist": -1, "pnp_up_abs": -1, "pnp_rel": -1, "pnp_rel10": -1,
    "rate_hyp_near": 1, "rate_hyp_mid": 1, "rate_hyp_far": 1,
    # (2) occluding contours
    "ctr_cov": 1, "ctr_lift": 1, "ctr_lift_near": 1, "ctr_lift_far": 1, "edge_explained": 1,
    # (3) skyline
    "sky_med": -1, "sky_frac3": 1, "sky_edge": 1, "sg_score": 1,
    # (4) hypothesis spread / (5) re-match gain
    "ring_comp_ratio": -1, "hyp_vs_comp": 1, "sue_disp": -1, "rematch_gain": 1,
}
NEG_ONLY = ["xfer_far_mid", "xfer_far_near", "xfer_mid_near", "rot_far_mid", "rot_far_near", "rot_mid_near", "res_far_mid",
            "res_far_near", "q_xfer", "q_rot_far_near", "ctr_cov", "ctr_lift", "ctr_lift_near", "ctr_lift_far", "edge_explained",
            "sky_med", "sky_frac3", "sky_edge", "sg_score", "ring_comp_ratio", "hyp_vs_comp", "sue_disp", "rematch_gain",
            "log10_nfa_per_match", "rmse_hyp"]
TRAPS = ["wc_0001", "wc_0069", "wc_0070", "wc_0074", "wc_0086"]
RULE_REJECTED = ["wc_0063", "wc_0006"]
HARD_INL = 100


def auroc(pos, neg):
    pos, neg = np.asarray(pos, float), np.asarray(neg, float)
    pos, neg = pos[np.isfinite(pos)], neg[np.isfinite(neg)]
    if len(pos) == 0 or len(neg) == 0:
        return None
    allv = np.r_[pos, neg]
    order = allv.argsort(kind="mergesort")
    ranks = np.empty(len(allv))
    # average ranks for ties
    sv = allv[order]
    i = 0
    while i < len(sv):
        j = i
        while j + 1 < len(sv) and sv[j + 1] == sv[i]:
            j += 1
        ranks[order[i:j + 1]] = (i + j) / 2 + 1
        i = j + 1
    rp = ranks[: len(pos)].sum()
    return float((rp - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg)))


def val(r, f):
    v = r.get(f)
    return np.nan if v is None else float(v) * FEATS.get(f, 1)


def fit_lr(X, y, lam=1.0):
    n, d = X.shape
    w0 = np.zeros(d + 1)
    wp = 0.5 / max(1, y.sum())
    wn = 0.5 / max(1, (1 - y).sum())
    sw = np.where(y == 1, wp, wn)

    def f(w):
        z = X @ w[1:] + w[0]
        l = np.logaddexp(0, -z) * y + np.logaddexp(0, z) * (1 - y)
        p = 1 / (1 + np.exp(-z))
        g = (p - y) * sw
        return (sw * l).sum() + lam / 2 * (w[1:] ** 2).sum() / n, np.r_[g.sum(), X.T @ g + lam * w[1:] / n]
    return minimize(f, w0, jac=True, method="L-BFGS-B").x


class Model:
    def __init__(self, feats, lam=1.0):
        self.feats, self.lam = feats, lam

    def mat(self, rows):
        return np.array([[val(r, f) for f in self.feats] for r in rows])

    def fit(self, rows, y):
        X = self.mat(rows)
        self.med = np.nanmedian(X, 0)
        self.med = np.where(np.isfinite(self.med), self.med, 0)
        X = np.where(np.isfinite(X), X, self.med)
        self.mu, self.sd = X.mean(0), X.std(0) + 1e-9
        self.w = fit_lr((X - self.mu) / self.sd, np.asarray(y, float), self.lam)
        return self

    def score(self, rows):
        X = self.mat(rows)
        X = np.where(np.isfinite(X), X, self.med)
        return ((X - self.mu) / self.sd) @ self.w[1:] + self.w[0]


def is_pos(r):
    return r["label"] == "correct"


def forward_select(rows, pool, k=4):
    """Greedy forward selection maximising grouped (inner LOPO) 'correct retained at zero wrong' then AUROC."""
    chosen = []
    for _ in range(k):
        best = None
        for f in pool:
            if f in chosen:
                continue
            fs = chosen + [f]
            sc = grouped_cv_scores(rows, fs)
            y = np.array([is_pos(r) for r in rows])
            ret0 = int((sc[y] > sc[~y].max()).sum())
            a = auroc(sc[y], sc[~y])
            key = (ret0, a)
            if best is None or key > best[0]:
                best = (key, f)
        chosen.append(best[1])
    return chosen


def lopo_scores(rows, feats, lam=1.0, extra=None):
    """Out-of-fold scores (grouped by photo) for rows; `extra` rows (e.g. perturb) scored by the fold of their photo."""
    pids = sorted({r["pid"] for r in rows})
    sc = np.full(len(rows), np.nan)
    esc = np.full(len(extra or []), np.nan)
    thr = {}
    for p in pids:
        tr = [r for r in rows if r["pid"] != p]
        m = Model(feats, lam).fit(tr, [is_pos(r) for r in tr])
        idx = [i for i, r in enumerate(rows) if r["pid"] == p]
        sc[idx] = m.score([rows[i] for i in idx])
        trs = m.score(tr)
        trneg = trs[~np.array([is_pos(r) for r in tr])]
        thr[p] = (float(trneg.max()), float(np.sort(trneg)[-2]))
        if extra:
            ei = [i for i, r in enumerate(extra) if r["pid"] == p]
            if ei:
                esc[ei] = m.score([extra[i] for i in ei])
    if extra is not None:
        return sc, esc, thr
    return sc


def summarize_model(name, rows, feats, perturb, nested_pool=None):
    y = np.array([is_pos(r) for r in rows])
    sc, psc, thr = lopo_scores(rows, feats, extra=perturb)
    a = auroc(sc[y], sc[~y])
    hard = np.array([(not is_pos(r)) and r["inl_hyp"] >= HARD_INL for r in rows])
    a_hard = auroc(sc[y], sc[hard])
    neg = np.sort(sc[~y])
    oracle0 = int((sc[y] > neg[-1]).sum())
    oracle1 = int((sc[y] > neg[-2]).sum())
    # nested threshold: each held-out photo judged against max (2nd max) of its fold's training wrongs
    n0 = n1 = w0 = w1 = 0
    acc = {}
    for i, r in enumerate(rows):
        t0, t1 = thr[r["pid"]]
        a0, a1 = sc[i] > t0, sc[i] > t1
        if is_pos(r):
            n0 += a0; n1 += a1
        else:
            w0 += a0; w1 += a1
        acc[(r["pid"], r["tag"])] = {"score": float(sc[i]), "acc0": bool(a0), "acc1": bool(a1), "label": r["label"],
                                      "inl": r["inl_hyp"], "thr0": t0}
    # per-photo ranking with the OOF score
    rk = rank_photos(rows, sc)
    pert = {}
    for i, r in enumerate(perturb):
        t0, _ = thr.get(r["pid"], (np.inf, np.inf))
        pert.setdefault(r["tag"], []).append(bool(psc[i] > t0))
    out = {"feats": feats, "auroc": a, "auroc_hard": a_hard, "n_pos": int(y.sum()), "n_neg": int((~y).sum()), "n_hard": int(hard.sum()),
           "oracle_retained_at0": oracle0, "oracle_retained_at1": oracle1,
           "nested_retained_at0": int(n0), "nested_wrong_at0": int(w0), "nested_retained_at1": int(n1), "nested_wrong_at1": int(w1),
           "rank": rk, "perturb_accepted_nested0": {k: f"{sum(v)}/{len(v)}" for k, v in sorted(pert.items())},
           "per_pose": {f"{k[0]}/{k[1]}": v for k, v in acc.items()}}
    print(f"\n== {name}: {feats}\n  AUROC {a:.3f} (hard-wrong {a_hard if a_hard is None else round(a_hard, 3)}, n_hard={int(hard.sum())})"
          f"  oracle retained@0={oracle0}/{int(y.sum())} @1={oracle1}  nested@0: {n0}/{int(y.sum())} correct, {w0} wrong;"
          f" nested@1-thr: {n1} correct, {w1} wrong;  per-photo rank {rk['wins']}/{rk['n']}")
    print("  perturb accepted (nested@0):", out["perturb_accepted_nested0"])
    return out, sc


def nested_fs(rows, y):
    """Nested forward selection (≤4 features chosen inside each outer LOPO fold; inner = grouped 5-fold)."""
    from collections import Counter
    pool = list(FEATS)
    pids = sorted({r["pid"] for r in rows})
    sc = np.full(len(rows), np.nan)
    sel_log, thr = {}, {}
    for p in pids:
        tr = [r for r in rows if r["pid"] != p]
        fs = forward_select(tr, pool, 4)
        sel_log[p] = fs
        m = Model(fs).fit(tr, [is_pos(r) for r in tr])
        idx = [i for i, r in enumerate(rows) if r["pid"] == p]
        sc[idx] = m.score([rows[i] for i in idx])
        trs = m.score(tr)
        thr[p] = float(trs[~np.array([is_pos(r) for r in tr])].max())
    a = auroc(sc[y], sc[~y])
    pp = {f"{r['pid']}/{r['tag']}": {"score": float(sc[i]), "acc0": bool(sc[i] > thr[r["pid"]]), "label": r["label"],
                                     "inl": r["inl_hyp"], "thr0": thr[r["pid"]]} for i, r in enumerate(rows)}
    n0 = sum(1 for v in pp.values() if v["label"] == "correct" and v["acc0"])
    w0 = sum(1 for v in pp.values() if v["label"] != "correct" and v["acc0"])
    cnt = Counter(f for fs in sel_log.values() for f in fs)
    print(f"\n== M4 nested forward-selected (≤4, inside each LOPO fold): AUROC {a:.3f}; nested@0 {n0}/{int(y.sum())} correct,"
          f" {w0} wrong; per-photo rank {rank_photos(rows, sc)}; feature frequency {cnt.most_common(10)}")
    return {"auroc": a, "nested_retained_at0": n0, "nested_wrong_at0": w0, "selection_freq": dict(cnt), "per_fold": sel_log,
            "rank": rank_photos(rows, sc), "per_pose": pp}


def grouped_cv_scores(rows, feats, k=5):
    pids = sorted({r["pid"] for r in rows})
    fold = {p: i % k for i, p in enumerate(pids)}
    sc = np.full(len(rows), np.nan)
    for f in range(k):
        tr = [r for r in rows if fold[r["pid"]] != f]
        m = Model(feats).fit(tr, [is_pos(r) for r in tr])
        idx = [i for i, r in enumerate(rows) if fold[r["pid"]] == f]
        sc[idx] = m.score([rows[i] for i in idx])
    return sc


def rank_photos(rows, sc):
    by = {}
    for i, r in enumerate(rows):
        by.setdefault(r["pid"], {"c": [], "w": []})["c" if is_pos(r) else "w"].append(sc[i])
    both = {p: d for p, d in by.items() if d["c"] and d["w"]}
    wins = [p for p, d in both.items() if np.nanmin(d["c"]) > np.nanmax(d["w"])]
    return {"n": len(both), "wins": len(wins), "losers": sorted(set(both) - set(wins))}


def main():
    import os
    ext = os.environ.get("X5_EXT") == "1"
    rows_all = json.load(open(HERE / ("features_ext.json" if ext else "features.json")))
    if ext:
        FEATS["ext_x2_combo_int_z"] = 1
    extra_src = sys.argv[1:]  # optional extra feature files (X2/X3), merged by (pid, group, tag)
    rows = [r for r in rows_all if r["label"] in ("correct", "wrong")]
    perturb = [r for r in rows_all if r["label"] == "perturb"]
    y = np.array([is_pos(r) for r in rows])
    hard = np.array([(not is_pos(r)) and r["inl_hyp"] >= HARD_INL for r in rows])
    print(f"n correct={int(y.sum())} ({len({r['pid'] for r in rows if is_pos(r)})} photos), wrong={int((~y).sum())} "
          f"({len({r['pid'] for r in rows if not is_pos(r)})} photos), hard wrong (inl_hyp>={HARD_INL})={int(hard.sum())} "
          f"({sorted({r['pid'] for r, h in zip(rows, hard) if h})}), perturb={len(perturb)}")
    res = {"n": {"correct": int(y.sum()), "wrong": int((~y).sum()), "hard": int(hard.sum()), "perturb": len(perturb)}}
    # ---- single features
    single = {}
    print(f"\n{'feature':24s} {'AUC all':>8s} {'AUC hard':>9s} {'n_pos/n_neg':>11s} {'rank':>6s}  pert±4/8 AUC  (correct vs perturb|yaw|>=4)")
    far = [r for r in perturb if r["tag"] in ("yaw-8", "yaw-4", "yaw+4", "yaw+8")]
    for f in FEATS:
        v = np.array([val(r, f) for r in rows])
        a = auroc(v[y], v[~y])
        ah = auroc(v[y], v[hard])
        rk = rank_photos(rows, np.where(np.isfinite(v), v, -np.inf))
        ap = auroc(v[y], [val(r, f) for r in far])
        single[f] = {"auroc": a, "auroc_hard": ah, "n_pos": int(np.isfinite(v[y]).sum()), "n_neg": int(np.isfinite(v[~y]).sum()),
                     "rank": f"{rk['wins']}/{rk['n']}", "auroc_vs_perturb48": ap}
        fmt = lambda x: "  n/a" if x is None else f"{x:.3f}"  # noqa: E731
        print(f"{f:24s} {fmt(a):>8s} {fmt(ah):>9s} {single[f]['n_pos']:>4d}/{single[f]['n_neg']:<4d}  {single[f]['rank']:>6s}  {fmt(ap)}")
    res["single"] = single
    # ---- traps: each trap's wrong refs vs the photo-free distribution of correct refs
    # ---- models
    models = {
        "M0 positive-only (log_inl)": ["log_inl"],
        "M1 positive-only (log_inl, frac_hyp, cov_hyp, sg_score)": ["log_inl", "frac_hyp", "cov_hyp", "sg_score"],
        "M2 a-priori negative-evidence (log_inl, q_rot_far_near, ctr_lift, hyp_vs_comp)": ["log_inl", "q_rot_far_near", "ctr_lift", "hyp_vs_comp"],
        "M3 negative-only (rot_far_near, ctr_lift, sky_frac3, ring_comp_ratio)": ["q_rot_far_near", "ctr_lift", "sky_frac3", "ring_comp_ratio"],
    }
    if ext:
        models = {k: v for k, v in models.items() if k.startswith("M0") or k.startswith("M2")}
        models["M5-ext X2 only (ext_x2_combo_int_z)"] = ["ext_x2_combo_int_z"]
        models["M6-ext log_inl + X2"] = ["log_inl", "ext_x2_combo_int_z"]
        models["M7-ext M2 + X2"] = ["log_inl", "pnp_dist", "hyp_vs_comp", "ext_x2_combo_int_z"]
    res["models"] = {}
    for name, fs in models.items():
        out, _ = summarize_model(name, rows, fs, perturb)
        res["models"][name] = out
    if not ext:
        res["models"]["M4 nested forward selection"] = nested_fs(rows, y)
    res["veto_single"] = veto_single(rows)
    # ---- traps, rule-rejected corrects, and the simulated veto on top of T6/v2 (per model, LOPO scores)
    highs = v2_highs()
    res["v2_highs"] = highs
    for name, out in res["models"].items():
        pp = out.get("per_pose")
        if not pp:
            continue
        print(f"\n-- {name}")
        tr = {}
        for k, v in pp.items():
            pid = k.split("/")[0]
            if (pid in TRAPS and v["label"] == "wrong" and v["inl"] >= 30) or pid in RULE_REJECTED:
                tr[k] = v
                print(f"   {k:16s} {v['label']:8s} inl {v['inl']:5d} score {v['score']:7.2f} thr0 {v['thr0']:6.2f} accepted@0={v['acc0']}")
        out["traps"] = tr
        veto = []
        for pid, h in highs.items():
            v = pp.get(f"{pid}/{h['ref']}")
            if v is None:
                continue
            veto.append({"pid": pid, "ref": h["ref"], "verdict": h["verdict"], "score": v["score"], "thr0": v["thr0"],
                         "vetoed": not v["acc0"]})
        nv_c = [x["pid"] for x in veto if x["vetoed"] and x["verdict"] == "correct"]
        nv_w = [x["pid"] for x in veto if x["vetoed"] and x["verdict"] == "wrong"]
        out["veto"] = {"rows": veto, "correct_high_vetoed": nv_c, "wrong_high_vetoed": nv_w}
        print(f"   veto on v2 HIGHs ({len(veto)}): correct HIGH vetoed {len(nv_c)} {nv_c}; wrong HIGH vetoed {nv_w}")
    json.dump(res, open(HERE / ("eval_ext.json" if ext else "eval.json"), "w"), indent=1, default=float)


def veto_single(rows, min_inl=HARD_INL):
    """Single-feature veto on top of positive evidence. Population = poses positive evidence would plausibly accept
    (inl_hyp >= min_inl): correct refs (to spare) vs hard wrongs (to catch). tau for photo p = min of the feature over
    OTHER photos' spared-population correct refs (LOPO; missing feature -> no veto)."""
    pop = [r for r in rows if r["inl_hyp"] >= min_inl]
    out = {}
    print(f"\n== single-feature veto (population inl_hyp>={min_inl}: {sum(is_pos(r) for r in pop)} correct, "
          f"{sum(not is_pos(r) for r in pop)} wrong; tau = LOPO min over other photos' correct)")
    for f in FEATS:
        cv, wv, caught, spared_fail = 0, 0, [], []
        ncw = [0, 0]
        for r in pop:
            v = val(r, f)
            if not np.isfinite(v):
                continue
            tr = [val(q, f) for q in pop if is_pos(q) and q["pid"] != r["pid"]]
            tr = [t for t in tr if np.isfinite(t)]
            if not tr:
                continue
            vet = v < min(tr)
            if is_pos(r):
                ncw[0] += 1; cv += vet
                if vet:
                    spared_fail.append(f"{r['pid']}/{r['tag']}")
            else:
                ncw[1] += 1; wv += vet
                if vet:
                    caught.append(f"{r['pid']}/{r['tag']}")
        out[f] = {"correct_vetoed": f"{cv}/{ncw[0]}", "wrong_vetoed": f"{wv}/{ncw[1]}", "caught": caught, "correct_lost": spared_fail}
        if wv:
            print(f"  {f:22s} correct vetoed {cv}/{ncw[0]} {spared_fail}  wrong vetoed {wv}/{ncw[1]}  {caught}")
    return out


def v2_highs():
    """v2/T6 HIGH photos -> the cached view at their final pose (correct ref within 0.7°, or wc_0086 N7 moved eye)."""
    sc = json.load(open(ROOT / "tools/matcher/v2/out/dev/score.json"))
    out = {}
    for r in sc["rows"]["v2"]:
        if not r["high"]:
            continue
        pid = r["id"]
        d = json.load(open(ROOT / f"tools/matcher/v2/out/dev/{pid}.json"))["final"]
        if d.get("eyeMoved"):
            out[pid] = {"ref": "N7", "verdict": r["verdict"], "dist": 0.0, "t6_stated_high": False}
            continue
        m = json.load(open(TM / f"cache/{pid}/meta.json"))
        best = None
        for ref in m["correct_refs"] + m["wrong_refs"]:
            dd = max(abs((d["pose"]["yaw"] - ref["pose"]["yaw"] + 540) % 360 - 180), abs(d["pose"]["pitch"] - ref["pose"]["pitch"]))
            if best is None or dd < best[0]:
                best = (dd, ref["label"])
        t6 = next(x for x in sc["rows"]["t6"] if x["id"] == pid)
        out[pid] = {"ref": best[1], "verdict": r["verdict"], "dist": best[0], "t6_stated_high": t6["high"]}
    return out


if __name__ == "__main__":
    main()
