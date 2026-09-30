"""E1 step 3: held-out-cue statistic T(h), per-photo label-free null, NFA decisions, metrics vs the current rule.
Offline (no rendering). -> results.json (+ stats per hypothesis in hyp_scores.json)

    python score.py [--photos ids...]
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path

import numpy as np
from scipy.optimize import least_squares
from scipy.stats import binom, norm

import e1lib as E
from e1lib import dang, eye_dist, same_pose, rot_far

import fusion as F  # tools/matcher/fusion.py (read-only)
import skyglobal as SG  # tools/matcher/stage1/skyglobal.py (read-only)
import rule as R

HP = json.load(open(E.HERE / "hyps_pool.json"))
SPLIT_M = 5000.0
MIN_SIDE = 12
TAU_K = 3.0
SIG_FLOOR = 1.0
EPS = {"AC1": 0.0, "AC2": -2.0}  # log10 NFA thresholds (primary, alternative)
NEG_KINDS = ("NB-inh", "NB-con", "NB-dec", "NE-inh", "NE-dec")
KINDS = ("POS",) + NEG_KINDS + ("AMB", "UNL")


# ------------------------------------------------------------------ skyline cue (pose-free)
_SKY = {}


def photo_edges(pid):
    if pid not in _SKY:
        z = np.load(E.ROOT / "tools/matcher/v2/.cache/edges" / f"{pid}.npz")
        rgb, fg, fine = z["rgb"], z["fg"].astype(np.float32), z["fine"].astype(np.float32)
        sky = SG.fit_sky(rgb, fg, SG.scan_labels(rgb, fg))
        _SKY[pid] = {"fine": fine, "fg": fg, "sky": sky, "dirs": z["dirs"].astype(np.float64), "h": fine.shape[0], "w": fine.shape[1]}
    return _SKY[pid]


def sk_for(pid, dirs):
    pe = photo_edges(pid)
    return F.skyline_from_arrays(pe["w"], pe["h"], pe["fine"], pe["fg"], pe["sky"], dirs)


# ------------------------------------------------------------------ rotation-only refit (fusion.py schedule, focal fixed)
def fit(x0, W, H, sk, colsel, x2d, X, eye):
    x = np.array(x0, float)
    c = {"x2d": x2d, "X": X, "W": W, "H": H}
    for it in range(len(F.WINS)):
        parts = []
        if sk is not None:
            sidx, stgt, _ = F.sky_associate(x, sk, W, H, F.WINS[it])
            if len(sidx):
                keep = colsel(sidx)
                sidx, stgt = sidx[keep], stgt[keep]
            if len(sidx) >= 10:
                r = F.sky_resid(x, sk, W, H, sidx, stgt)
                s = F.robust_sigma(r, F.SIGMA_FLOOR["sky"])
                parts.append(("sky", sidx, stgt, s, F.huber_sqrt_w(r / s)))
        if len(x2d):
            r = F.match_resid(x, c, eye)
            g = np.linalg.norm(r, axis=1) < F.GATES[it]
            if g.sum() >= 6:
                rg = r[g].ravel()
                s = F.robust_sigma(rg, F.SIGMA_FLOOR["match"])
                parts.append(("match", g, None, s, F.huber_sqrt_w(rg / s)))
        if not parts:
            return None

        def fn(p3):
            xx = np.r_[p3, x[3]]
            out = []
            for name, a, b, s, wsq in parts:
                if name == "sky":
                    rr = F.sky_resid(xx, sk, W, H, a, b)
                    out.append(wsq * rr / s / math.sqrt(len(rr)))
                else:
                    cc = {"x2d": x2d[a], "X": X[a], "W": W, "H": H}
                    rr = F.match_resid(xx, cc, eye).ravel()
                    out.append(wsq * rr / s / math.sqrt(len(rr) / 2))
            return np.concatenate(out)
        sol = least_squares(fn, x[:3], method="lm", x_scale=[0.1, 0.1, 0.1], max_nfev=400)
        x[:3] = sol.x
    # final sigma of the fit set
    sig = None
    if len(x2d):
        r = F.match_resid(x, c, eye)
        g = np.linalg.norm(r, axis=1) < F.GATES[-1]
        if g.sum() >= 6:
            sig = F.robust_sigma(r[g].ravel(), SIG_FLOOR)
    if sig is None:
        sky = [p for p in parts if p[0] == "sky"]
        sig = max(SIG_FLOOR, sky[0][3]) if sky else None
    if sig is None:
        return None
    return x, sig


def binom_score(k, n, p0):
    if k <= 0 or n <= 0:
        return 0.0
    v = binom.logsf(k - 1, n, p0)
    if not np.isfinite(v):
        v = binom.logpmf(k, n, p0)
    return float(-v / math.log(10))


def directed(x0, W, H, sk, colsel, fitmask, heldmask, x2d, X, eye):
    r = fit(x0, W, H, sk, colsel, x2d[fitmask], X[fitmask], eye)
    n = int(heldmask.sum())
    if r is None:
        return {"s": 0.0, "n": n, "k": 0, "fit": False}
    x, sig = r
    tau = TAU_K * sig
    e = np.linalg.norm(F.match_resid(x, {"x2d": x2d[heldmask], "X": X[heldmask], "W": W, "H": H}, eye), axis=1) if n else np.zeros(0)
    k = int((e <= tau).sum())
    p0 = min(1.0, math.pi * tau * tau / (W * H))
    drift = float(math.hypot(dang(x[0], x0[0]), x[1] - x0[1]))
    return {"s": binom_score(k, n, p0), "n": n, "k": k, "tau": tau, "p0": p0, "fit": True, "driftDeg": drift}


def statistic(h, sk):
    z = np.load(E.HERE / h["corr"]) if not Path(h["corr"]).is_absolute() else np.load(h["corr"])
    x2d, X, eye = z["x2d"].astype(np.float64), z["X"].astype(np.float64), z["eye"].astype(np.float64)
    W, H = int(z["W"]), int(z["H"])
    pose = h["pose"]
    out = {"nCorr": int(len(x2d)), "W": W, "H": H}
    if len(x2d) < 6:
        out.update(T=0.0, Tfit=0.0, tests={})
        return out
    x0 = F.x_from_pose(pose, H)
    d = np.linalg.norm(X - eye, axis=1)
    far = d >= SPLIT_M
    split = "5km"
    if far.sum() < MIN_SIDE or (~far).sum() < MIN_SIDE:
        med = float(np.median(d))
        far = d >= med
        split = f"median({med:.0f}m)"
    left = x2d[:, 0] < W / 2
    allc = lambda cu: np.ones(len(cu), bool)  # noqa: E731
    lcols = lambda cu: cu < W / 2  # noqa: E731
    rcols = lambda cu: cu >= W / 2  # noqa: E731
    tests = {
        "A->B": directed(x0, W, H, sk, allc, far, ~far, x2d, X, eye),
        "B->A": directed(x0, W, H, None, allc, ~far, far, x2d, X, eye),
        "L->R": directed(x0, W, H, sk, lcols, left, ~left, x2d, X, eye),
        "R->L": directed(x0, W, H, sk, rcols, ~left, left, x2d, X, eye),
    }
    T = min(t["s"] for t in tests.values())
    # diagnostic: no held-out (fit on everything, score everything)
    ones = np.ones(len(x2d), bool)
    tf = directed(x0, W, H, sk, allc, ones, ones, x2d, X, eye)
    out.update(T=T, Tfit=tf["s"], tests=tests, split=split, nFar=int(far.sum()), nNear=int((~far).sum()),
               medDepth=float(np.median(d)), fitAll=tf, sky=sk is not None)
    return out


# ------------------------------------------------------------------ hypotheses per photo
DISP_FULL = bool(int(E.os.environ.get("E1_DISP_FULL", "0")))  # DEVIATIONS.txt D1 secondary run


def disp_in_cut(pid, h):
    """D1 cut: bearing theta (first rng draw, as gen.disp_eyes) at 150 / 400 m."""
    th = float(np.random.default_rng(E.SEED + int(pid.split("_")[1])).uniform(0, 360))
    return h.get("dist") in (150, 400) and abs(dang(h["bearing"], th)) < 1e-6
def photo_hyps(pid):
    P = HP["photos"][pid]
    st = json.load(open(E.GEN / pid / "state.json"))
    stated = P["stated"]
    hs = []
    for h in P["hyps"]:
        hs.append({**h, "label": h["label"], "labelWhy": h["labelWhy"]})
    for h in st.get("ref", []):
        if h.get("corr"):
            hs.append({**h, "eye": {"lat": stated["lat"], "lon": stated["lon"], "h": h["eyeZ"]}, "label": "POS", "labelWhy": "refs.correct_refs"})

    def dup(g):
        return any(same_pose(g["pose"], q["pose"]) and eye_dist(g["eye"], q["eye"]) <= 2 for q in hs)
    ndup = 0
    gen = []
    for h in st.get("disp", []):
        if not DISP_FULL and not disp_in_cut(pid, h):  # DEVIATIONS.txt D1
            continue
        if h.get("corr"):
            gen.append({**h, "eye": {"lat": h["lat"], "lon": h["lon"], "h": h["eyeZ"]}})
    for key in ("ring", "yaw"):
        for h in st.get(key, []):
            if h.get("corr"):
                gen.append({**h, "eye": {"lat": stated["lat"], "lon": stated["lon"], "h": h["eyeZ"]}})
    V = P["V"]
    for g in gen:
        if dup(g):
            ndup += 1
            continue
        if g["kind"] == "DISP":
            if P["Pref"]:
                g["label"], g["labelWhy"] = ("NE-dec", f"displaced {g['dist']} m") if g["dist"] >= 150 else ("AMB", "displaced 50 m")
            else:
                g["label"], g["labelWhy"] = "UNL", "displaced, photo without verified truth"
        else:
            same = [v for v in V if eye_dist(g["eye"], v["eye"]) <= 2]
            if P["Pref"] and same and all(rot_far(g["pose"], v["pose"]) for v in same):
                g["label"], g["labelWhy"] = "NB-dec", f"{g['kind']} solve > 3 deg from every correct pose"
            else:
                g["label"], g["labelWhy"] = "UNL", f"{g['kind']} within 3 deg of a correct pose or no truth"
        hs.append(g)
    return hs, st, ndup


def dirs_for(pid, h, st, stated):
    if h["kind"] == "DISP":
        return np.load(E.HERE / h["dirs"]).astype(np.float64) if h.get("dirs") else None
    if eye_dist(h["eye"], stated) <= 2.0 or h["kind"] in ("REF", "RING", "YAW"):
        return photo_edges(pid)["dirs"]
    z = np.load(h["corr"])
    key = f"{h['eye']['lat']:.7f},{h['eye']['lon']:.7f},{float(z['eye'][2]):.2f}"
    e = (st.get("edges") or {}).get(key)
    if e and e.get("dirs"):
        return np.load(E.HERE / e["dirs"]).astype(np.float64)
    return None


# ------------------------------------------------------------------ truth-geometry misfit of displaced hypotheses
def disp_misfit(pid, h):
    import refs
    meta = json.load(open(E.tm_common.CACHE / pid / "meta.json"))
    r0 = refs.correct_refs(pid)[0]
    vj = next(v for v in meta["views"]["refs"] if v["tag"] == r0["label"])
    z = np.load(E.tm_common.CACHE / pid / "refs" / r0["label"] / "xyz.npz")
    xyz = z["xyz"].reshape(-1, 3).astype(np.float64)
    hh, ww = z["xyz"].shape[:2]
    rr, cc = np.divmod(np.arange(hh * ww), ww)
    ok = np.any(xyz != 0, axis=1)
    eye0 = np.asarray(vj["eye"], float)
    dep = np.linalg.norm(xyz - eye0, axis=1)
    ok &= dep > 250
    xyz, u, v = xyz[ok], 2 * cc[ok] + 0.5, 2 * rr[ok] + 0.5
    Wn, Hn = vj["W"], vj["H"]
    # displaced eye in the stated frame (horizontal offset e, n; its own achieved z)
    eyeD = np.array([h["e"], h["n"], h["eyeZ"]])
    x = F.x_from_pose(h["pose"], Hn)
    D = xyz - eyeD
    D /= np.linalg.norm(D, axis=1, keepdims=True)
    pu, pv, pz = F.project_dirs(x, D, Wn, Hn)
    m = pz > 0
    e = np.hypot(pu[m] - u[m], pv[m] - v[m])
    if not len(e):
        return None
    # the same with the ref pose at the ref eye (sanity: ~0)
    return {"medPx": float(np.median(e)), "p90Px": float(np.percentile(e, 90)), "n": int(len(e))}


def photo_stats(pid):
    """Statistic for every hypothesis of one photo (cached in gen/<pid>/stats.json, keyed by hid + corr path)."""
    E.tm_common.assert_dev(pid)
    P = HP["photos"][pid]
    hs, st, ndup = photo_hyps(pid)
    cf = E.GEN / pid / "stats.json"
    cache = json.load(open(cf)) if cf.exists() else {}
    for h in hs:
        h["pid"] = pid
        key = f"{h['hid']}|{h['corr']}"
        if key in cache:
            h["stat"], h["misfit"] = cache[key]["stat"], cache[key].get("misfit")
            continue
        dirs = dirs_for(pid, h, st, P["stated"])
        sk = sk_for(pid, dirs) if dirs is not None else None
        h["stat"] = statistic(h, sk)
        if h["kind"] == "DISP" and P["Pref"]:
            try:
                h["misfit"] = disp_misfit(pid, h)
            except Exception as ex:  # noqa: BLE001
                h["misfit"] = {"error": str(ex)}
        cache[key] = {"stat": h["stat"], "misfit": h.get("misfit")}
    E.jdump(cache, cf)
    print(pid, len(hs), flush=True)
    return hs, ndup


# ------------------------------------------------------------------ decisions
def decide(hs, pid, P):
    N = len(hs)
    z = np.array([math.log10(1 + h["stat"]["T"]) for h in hs])
    zf = np.array([math.log10(1 + h["stat"]["Tfit"]) for h in hs])
    for i, h in enumerate(hs):
        alt = [j for j, g in enumerate(hs) if j != i and (eye_dist(g["eye"], h["eye"]) >= 100 or
                                                         (eye_dist(g["eye"], h["eye"]) <= 2 and rot_far(g["pose"], h["pose"])))]
        h["nNull"] = len(alt)
        h["nTests"] = N
        for nm, zz in (("", z), ("fit", zf)):
            if len(alt) < 10:
                h[f"log10NFA{nm}"] = None
                h[f"Pemp{nm}"] = None
                continue
            nz = zz[alt]
            mu, sd = float(nz.mean()), max(0.05, float(nz.std(ddof=1)))
            lp = norm.logsf((zz[i] - mu) / sd) / math.log(10)
            h[f"log10NFA{nm}"] = float(math.log10(N) + lp)
            h[f"nullMu{nm}"], h[f"nullSd{nm}"], h[f"zScore{nm}"] = mu, sd, float((zz[i] - mu) / sd)
            h[f"Pemp{nm}"] = float((1 + (nz >= zz[i]).sum()) / (1 + len(nz)))
        acc = {}
        for k, thr in EPS.items():
            acc[k] = h["log10NFA"] is not None and h["log10NFA"] < thr
            acc[k + "fit"] = h["log10NFAfit"] is not None and h["log10NFAfit"] < thr
        acc["CUR"] = h["kind"] != "DISP" and any(same_pose(h["pose"], c["pose"]) and eye_dist(h["eye"], c["eye"]) <= 2 for c in P["CUR"])
        ca = any(same_pose(h["pose"], c["pose"]) and eye_dist(h["eye"], c["eye"]) <= 2 for c in P["CURall"])
        if h["kind"] == "DISP" and h.get("fused", {}).get("pose"):
            rec = {"positionSource": P["positionSource"]}
            ca = ca or bool(R.high(rec, {"fused": h["fused"]}))
        acc["CURall"] = ca
        h["accept"] = acc


METHODS = ("AC1", "AC2", "CUR", "CURall", "AC1fit", "AC2fit")


def metrics(allh, photos):
    out = {}
    for m in METHODS:
        per = {}
        for k in KINDS:
            hk = [h for h in allh if h["label"] == k]
            per[k] = {"n": len(hk), "accepted": sum(h["accept"][m] for h in hk),
                      "photos": len({h["pid"] for h in hk}), "acceptedIds": [h["hid"] for h in hk if h["accept"][m]] if k != "UNL" else None}
        pos_ph = sorted({h["pid"] for h in allh if h["label"] == "POS"})
        rec_ph = sorted({h["pid"] for h in allh if h["label"] == "POS" and h["accept"][m]})
        gross = [h for h in allh if h["label"] in NEG_KINDS and h["accept"][m]]
        out[m] = {"perKind": per, "photosWithPositive": len(pos_ph), "photoRecall": len(rec_ph), "recallPhotos": rec_ph,
                  "gross": len(gross), "grossPhotos": sorted({h["pid"] for h in gross}),
                  "grossIds": [(h["hid"], h["label"]) for h in gross],
                  "atZeroGross": len(gross) == 0,
                  "wrongEyeAccepted": [h["hid"] for h in gross if h["label"] in ("NE-dec", "NE-inh")]}
    return out


def bootstrap(allh, photos, B=2000):
    rng = np.random.default_rng(E.SEED)
    byp = {p: [h for h in allh if h["pid"] == p] for p in photos}
    res = {m: {"recall": [], "gross": [], "posAcc": []} for m in METHODS}
    for _ in range(B):
        samp = rng.choice(photos, len(photos), replace=True)
        for m in METHODS:
            rec = gro = pa = 0
            for p in samp:
                hs = byp[p]
                rec += any(h["label"] == "POS" and h["accept"][m] for h in hs)
                gro += sum(h["label"] in NEG_KINDS and h["accept"][m] for h in hs)
                pa += sum(h["label"] == "POS" and h["accept"][m] for h in hs)
            res[m]["recall"].append(rec)
            res[m]["gross"].append(gro)
            res[m]["posAcc"].append(pa)
    return {m: {k: [float(np.percentile(v, 2.5)), float(np.percentile(v, 97.5))] for k, v in d.items()} for m, d in res.items()}


def auroc(pos, neg):
    if not pos or not neg:
        return None
    pos, neg = np.asarray(pos), np.asarray(neg)
    return float(((pos[:, None] > neg[None, :]).sum() + 0.5 * (pos[:, None] == neg[None, :]).sum()) / (len(pos) * len(neg)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--photos", nargs="*")
    ap.add_argument("--disp-full", action="store_true")
    ap.add_argument("--out-suffix", default="")
    a = ap.parse_args()
    if a.disp_full:  # env so Pool workers see it too
        E.os.environ["E1_DISP_FULL"] = "1"
        global DISP_FULL
        DISP_FULL = True
    photos = [p for p in (a.photos or E.analysed()) if (E.GEN / p / "state.json").exists()]
    allh = []
    info = {}
    t0 = time.time()
    from multiprocessing import Pool
    with Pool(int(E.os.environ.get("E1_PROCS", 4))) as pool:
        per = dict(zip(photos, pool.map(photo_stats, photos)))
    for pid in photos:
        P = HP["photos"][pid]
        hs, ndup = per[pid]
        decide(hs, pid, P)
        info[pid] = {"nHyps": len(hs), "dupDropped": ndup, "Pref": P["Pref"],
                     "byKind": {k: sum(1 for h in hs if h["kind"] == k) for k in ("POOL", "REF", "RING", "YAW", "DISP")}}
        allh += hs
        print(pid, len(hs), f"{time.time() - t0:.0f}s", flush=True)
    M = metrics(allh, photos)
    bs = bootstrap(allh, photos)
    # descriptive (not decisions): AUROC of T and Tfit, POS vs each negative kind
    desc = {}
    for stat in ("T", "Tfit"):
        pos = [h["stat"][stat] for h in allh if h["label"] == "POS"]
        desc[stat] = {k: auroc(pos, [h["stat"][stat] for h in allh if h["label"] == k]) for k in NEG_KINDS + ("AMB",)}
    slim = []
    for h in allh:
        slim.append({k: h.get(k) for k in ("pid", "hid", "kind", "label", "labelWhy", "status", "sources", "pose", "eye", "dist",
                                           "common_inl", "nativeFusedMax", "nNull", "nTests", "log10NFA", "Pemp", "zScore", "nullMu",
                                           "nullSd", "log10NFAfit", "accept", "misfit", "solveInliers", "evidence")}
                    | {"T": h["stat"]["T"], "Tfit": h["stat"]["Tfit"], "nCorr": h["stat"]["nCorr"], "split": h["stat"].get("split"),
                       "nFar": h["stat"].get("nFar"), "nNear": h["stat"].get("nNear"), "sky": h["stat"].get("sky"),
                       "tests": {k: {kk: v.get(kk) for kk in ("s", "n", "k", "tau", "driftDeg")} for k, v in (h["stat"].get("tests") or {}).items()},
                       "fusedLevel": (h.get("fused") or {}).get("level"), "fusedInliers": (h.get("fused") or {}).get("inliers")})
    E.jdump(slim, E.HERE / f"hyp_scores{a.out_suffix}.json")
    res = {"protocol": "PROTOCOL.txt (frozen 2026-09-29T23:13:57Z)", "ruleSha": HP["ruleSha"], "photos": photos, "photoInfo": info,
           "metrics": M, "bootstrap95": bs, "descriptiveAUROC": desc,
           "nHyps": len(allh), "labelCounts": {k: sum(1 for h in allh if h["label"] == k) for k in KINDS}}
    E.jdump(res, E.HERE / f"results{a.out_suffix}.json")
    for m in METHODS:
        mm = M[m]
        print(m, "recall", mm["photoRecall"], "/", mm["photosWithPositive"], "gross", mm["gross"], mm["grossIds"][:8],
              {k: f"{v['accepted']}/{v['n']}" for k, v in mm["perKind"].items()})


if __name__ == "__main__":
    main()
