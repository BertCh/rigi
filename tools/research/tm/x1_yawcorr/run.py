"""X1 driver: dense-feature yaw correlation on the DEV cache, all scoring variants for one backbone.

    python run.py BACKBONE[:LAYER] OUT_TAG [--cfgs design|final] [--dev cpu|mps] [ids...]
Writes results/<OUT_TAG>.json (per pid → per cfg → hyps / ref scores / timings); resumable per pid.
"""
from __future__ import annotations

import argparse
import json
import math
import time
from pathlib import Path

import numpy as np

import x1lib as X
import sky_cache as SC

HERE = Path(__file__).resolve().parent
RES = HERE / "results"
RES.mkdir(exist_ok=True)
CURVES = HERE / ".curves"
CURVES.mkdir(exist_ok=True)

PITCHES = np.arange(-15.0, 15.0 + 1e-9, 2.0)


def hfov_of(vf, aspect):
    return 2 * math.degrees(math.atan(math.tan(math.radians(vf) / 2) * aspect))


def vfov_of(hf, aspect):
    return 2 * math.degrees(math.atan(math.tan(math.radians(hf) / 2) / aspect))


def configs(kind):
    base = {"style": "both", "wmode": "terr", "pca": 64, "rolls": [-6, -3, 0, 3, 6], "ring": 15, "minFrac": 0.3}
    if kind == "final":
        return {"main": base, "ring45": {**base, "ring": 45}, "sat": {**base, "style": "sat"}, "hill": {**base, "style": "hill"}}
    if kind == "bb":
        return {"main": base, "sat": {**base, "style": "sat"}, "hill": {**base, "style": "hill"}}
    cf = {"main": base}
    cf["pca128"] = {**base, "pca": 128}
    cf["all"] = {**base, "wmode": "all"}
    cf["photoAll"] = {**base, "wmode": "photoAll"}  # pano terrain-only, photo sky kept
    cf["roll0"] = {**base, "rolls": [0]}
    cf["pca16"] = {**base, "pca": 16}
    cf["ring45"] = {**base, "ring": 45}
    return cf


def weights(mode, psky, pfg, terr):
    if mode == "terr":
        return (1 - psky) * (1 - pfg), terr
    if mode == "all":
        return 1 - pfg, np.ones_like(terr)
    if mode == "photoAll":
        return 1 - pfg, terr
    raise ValueError(mode)


def pca_fit(Xs, k):
    X = np.concatenate(Xs)
    if len(X) > 30000:
        X = X[np.random.default_rng(0).choice(len(X), 30000, replace=False)]
    C = X.T @ X / len(X)
    ev, V = np.linalg.eigh(C)
    return V[:, ::-1][:, :k].astype(np.float32)


def prep(F, w):
    """Centre by the (weighted) domain mean, L2-normalise."""
    m = (F * w[:, None]).sum(0) / max(w.sum(), 1e-6)
    return X.l2n(F - m)


def peaks_refine(sg, yaw, curve, start_of, v0, fk, k, nms, order_by):
    """NMS peaks of `curve` (over `yaw`) → skyline coordinate-descent polish (as SG.search) → top-k hyps."""
    idx = X.nms_peaks(yaw, curve, 2 * k, nms)
    hyps = []
    for i in idx:
        st = start_of(i)
        p1, _ = sg.refine(st, v0 if fk else None, 0.08, fine=False)
        p2, s2 = sg.refine(p1, v0 if fk else None, 0.08, fine=True)
        hyps.append({"pose": {kk: float(v) for kk, v in p2.items()}, "score": float(s2), "curve": float(curve[i])})
    key = (lambda h: -h["score"]) if order_by == "sky" else (lambda h: -h["curve"])
    hyps.sort(key=key)
    out = []
    for h in hyps:
        if all(abs(X.dang(h["pose"]["yaw"], q["pose"]["yaw"])) >= 1.0 for q in out):
            out.append(h)
    return [h["pose"] for h in out[:k]]


def process(bb, pid, cfgs, lambdas=(0.5, 1.0, 2.0), ckey=None):
    m = X.CI.load_meta(pid)
    fk = bool(m["focal_known"])
    aspect = m["aspect"]
    v0 = m["vfov0"]
    hf0 = m["hfov0"] if fk else 55.0
    dpp = float(np.clip(hf0 / 40, 0.5, 1.0)) if fk else 1.0
    grid = X.make_grid(dpp)
    rec = {"fk": fk, "hfov0": m["hfov0"], "dpp": dpp, "cfg": {}}
    t0 = time.time()
    ring, ringMs, _ = X.ring_tokens(bb, pid, dpp, styles=("sat", "hill"))
    # view yaw of every ring token (for the 45° subset)
    _, tags = X.ring_views(pid)
    gw = int(round(X.RING_HFOV / dpp))
    nper = len(ring["sat"][0]) // len(tags)
    vyaw = np.repeat([int(t[1:]) for t in tags], nper)
    Fp, (W, H), photoMs = X.photo_tokens(bb, pid, hf0, dpp)
    gh_p, gw_p = Fp.shape[:2]
    psky, pfg, sg = X.photo_masks(pid, gw_p, gh_p)
    rec["t"] = {"ringFwdMs": round(ringMs), "photoFwdMs": round(photoMs), "nRingViews": len(tags), "photoGrid": [gw_p, gh_p],
                "loadMs": round((time.time() - t0) * 1000 - ringMs - photoMs)}
    Fp = Fp.reshape(-1, Fp.shape[-1])
    # skyline curve
    z = np.load(SC.OUT / f"{pid}.npz")
    syaw, sbest, sarg = z["yaw"], z["best"].astype(np.float64), z["arg"]
    vfovs = [v0] if fk else [vfov_of(h, aspect) for h in (35, 45, 55, 65, 75)]
    nms = max(3.0, 0.25 * hfov_of(v0, aspect))
    refs = [dict(r, verdict="correct") for r in m["correct_refs"]] + [dict(r, verdict="wrong") for r in m["wrong_refs"]]
    # cam rays per vfov for photo tokens
    rays = {vf: X.cam_rays(W, H, vf, gw_p, gh_p).reshape(-1, 3) for vf in vfovs}
    ref_rays = {r["label"]: X.cam_rays(W, H, r["pose"]["vfov"], gw_p, gh_p).reshape(-1, 3) for r in refs}

    memo = {}  # (wmode, pca, ring) → {"Fq", "wp", "scorers", "curves"}; PCA always fit on photo + both styles

    def space(cf):
        key = (cf["wmode"], cf["pca"], cf["ring"])
        if key in memo:
            return memo[key]
        wp, _ = weights(cf["wmode"], psky.ravel(), pfg.ravel(), np.ones(1))
        Fpp = prep(Fp, wp)
        panoF = {}
        for s in ("sat", "hill"):
            F, az, el, terr = ring[s]
            sel = (vyaw % cf["ring"]) == 0
            _, wq = weights(cf["wmode"], np.zeros(1), np.zeros(1), terr[sel])
            panoF[s] = (prep(F[sel], wq), az[sel], el[sel], wq)
        if cf["pca"]:
            P = pca_fit([Fpp] + [panoF[s][0] for s in panoF], cf["pca"])
            Fq = X.l2n(Fpp @ P)
            panoF = {s: (X.l2n(v[0] @ P),) + v[1:] for s, v in panoF.items()}
        else:
            Fq = Fpp
        sc = {s: X.Scorer(*X.build_pano(*panoF[s], grid), grid) for s in panoF}
        memo[key] = {"Fq": Fq, "wp": wp, "scorers": sc, "curves": {}}
        return memo[key]

    for cname, cf in cfgs.items():
        ts = time.time()
        sp_ = space(cf)
        styles = ["sat", "hill"] if cf["style"] == "both" else [cf["style"]]

        def curve_for(vf, p, r, rr=None, label=None):
            cs = []
            for s in styles:
                k = (s, label or round(vf, 4), round(p, 3), round(r, 3), cf["minFrac"])
                if k not in sp_["curves"]:
                    dw = (rr if rr is not None else rays[vf]) @ X.CI.pose_to_R({"yaw": 0.0, "pitch": p, "roll": r, "vfov": vf})
                    az, el = X.az_el(dw)
                    sp_["curves"][k] = sp_["scorers"][s].curve(sp_["Fq"], sp_["wp"], az, el, cf["minFrac"])[0]
                cs.append(sp_["curves"][k])
            return np.mean(cs, 0)

        na = grid["na"]
        best = np.full(na, -np.inf)
        arg = np.zeros((na, 3))
        for vf in vfovs:
            for p in PITCHES:
                for r in cf["rolls"]:
                    c = curve_for(vf, float(p), float(r))
                    c = np.where(np.isfinite(c), c, -np.inf)
                    b = c > best
                    best = np.where(b, c, best)
                    arg[b] = (vf, p, r)
        fyaw = (np.arange(na)) * grid["cell"]  # curve index i ↔ yaw = i·cell (cell-centre offsets cancel)
        scoreMs = (time.time() - ts) * 1000
        # raw feature hyps
        fb = np.where(np.isfinite(best), best, np.nan)
        pk = X.nms_peaks(fyaw, np.nan_to_num(fb, nan=-np.inf), 4, nms)
        raw = []
        for i in pk:
            dy = X.parabolic(fb, i) * grid["cell"]
            raw.append({"yaw": float((fyaw[i] + dy) % 360), "pitch": float(arg[i, 1]), "roll": float(arg[i, 2]), "vfov": float(arg[i, 0]),
                        "score": float(fb[i])})
        out = {"raw": raw, "scoreMs": round(scoreMs)}
        # skyline curve on the feature yaw grid (max over the sky bins that fall in each feature cell)
        sy_i = np.round(syaw / grid["cell"]).astype(int) % na
        sky_c = np.full(na, -np.inf)
        np.maximum.at(sky_c, sy_i, sbest)
        sky_arg_i = np.zeros(na, int)
        for j in np.argsort(sbest):  # the last write per cell = the max
            sky_arg_i[sy_i[j]] = j
        fz = X.zscore(np.where(np.isfinite(fb), fb, np.nan))
        sz = X.zscore(np.where(np.isfinite(sky_c), sky_c, np.nan))

        def start_feat(i):
            dy = X.parabolic(fb, i) * grid["cell"]
            return {"yaw": float(fyaw[i] + dy), "pitch": float(arg[i, 1]), "roll": float(arg[i, 2]), "vfov": float(arg[i, 0])}

        def start_sky(i):
            j = sky_arg_i[i]
            return {"yaw": float(syaw[j]), "vfov": float(sarg[j, 0]), "pitch": float(sarg[j, 1]), "roll": float(sarg[j, 2])}

        def local(i, curve_idx_score):
            """Fine pitch/roll around a peak: pitch ±2 (0.5), roll ±1.5 (1.5) at the peak's vfov; max within ±2 cells."""
            vf, p0, r0 = arg[i]
            bestv, bp = -np.inf, None
            win = [(i + d) % na for d in range(-2, 3)]
            for p in np.arange(p0 - 2, p0 + 2 + 1e-9, 0.5):
                for r in (r0 - 1.5, r0, r0 + 1.5):
                    c = curve_for(float(vf), float(p), float(r))
                    j = max(win, key=lambda k: c[k] if np.isfinite(c[k]) else -np.inf)
                    if np.isfinite(c[j]) and c[j] > bestv:
                        bestv, bp = c[j], (float(p), float(r), j, X.parabolic(c, j))
            if bp is None:
                return None
            p, r, j, dy = bp
            return {"yaw": float((fyaw[j] + dy * grid["cell"]) % 360), "pitch": p, "roll": r, "vfov": float(vf), "score": float(bestv),
                    "rank": curve_idx_score}

        # column-pooled 1-D variant (pitch-free: pitch 0 / roll 0 mapping per vfov; pitch reported from the 2-D arg)
        cb = np.full(na, -np.inf)
        for vf in vfovs:
            dw = rays[vf] @ X.CI.pose_to_R({"yaw": 0.0, "pitch": 0.0, "roll": 0.0, "vfov": vf})
            az_, el_ = X.az_el(dw)
            cc = np.mean([sp_["scorers"][s].colcurve(sp_["Fq"], sp_["wp"], az_, el_) for s in styles], 0)
            cb = np.maximum(cb, np.where(np.isfinite(cc), cc, -np.inf))
        pkc = X.nms_peaks(fyaw, cb, 4, nms)
        out["colpool"] = [{"yaw": float((fyaw[i] + X.parabolic(cb, i) * grid["cell"]) % 360), "pitch": float(arg[i, 1]),
                           "roll": float(arg[i, 2]), "vfov": float(arg[i, 0]), "score": float(cb[i])} for i in pkc]
        tl = time.time()
        out["rawFine"] = [h for h in (local(i, float(fb[i])) for i in pk) if h]
        out["localMs"] = round((time.time() - tl) * 1000)
        for lam in lambdas:
            fused = fz + lam * sz
            pkf = X.nms_peaks(fyaw, fused, 4, nms)
            out[f"fuseFine{lam}"] = [h for h in (local(i, float(fused[i])) for i in pkf) if h]
        tp = time.time()
        out["featPol"] = peaks_refine(sg, fyaw, np.where(np.isfinite(fb), fz, -np.inf), start_feat, v0, fk, 4, nms, "curve")
        polMs = (time.time() - tp) * 1000
        out["polMs"] = round(polMs)
        for lam in (1.0,):
            fused = fz + lam * sz
            for ob in ("curve", "sky"):
                out[f"fuse{lam}_{ob}"] = peaks_refine(sg, fyaw, fused, start_sky, v0, fk, 4, nms, ob)
        # scores at ref poses: feature (curve at the ref's pitch/roll/vfov, interpolated at its yaw) and skyline
        rs = []
        for r in refs:
            q = r["pose"]
            c = curve_for(q["vfov"], q["pitch"], q["roll"], ref_rays[r["label"]], label="ref" + r["label"])
            x = (q["yaw"] % 360) / grid["cell"]
            i0 = int(np.floor(x)) % na
            a = x - np.floor(x)
            fv = (1 - a) * c[i0] + a * c[(i0 + 1) % na]
            rs.append({"label": r["label"], "verdict": r["verdict"], "yaw": q["yaw"], "pitch": q["pitch"],
                       "feat": None if not np.isfinite(fv) else float(fv),
                       "featZ": None if not np.isfinite(fv) else float((fv - np.nanmedian(fb[np.isfinite(fb)])) / (np.nanstd(fb[np.isfinite(fb)]) + 1e-9)),
                       "featRank": None if not np.isfinite(fv) else int((fb > fv).sum()),
                       "sky": float(sg.score_pose(q, fine=True))})
        out["refs"] = rs
        rec["cfg"][cname] = out
        np.savez_compressed(CURVES / f"{ckey or bb.name + '_' + bb.layer}_{pid}_{cname}.npz", yaw=fyaw, best=best, arg=arg, sky=sky_c)
    # direct photo ↔ ref-render similarity at the ref pose (pixel-aligned renders), full-dim tokens
    wp, _ = weights("terr", psky.ravel(), pfg.ravel(), np.ones(1))
    Fpc = prep(Fp, wp)
    direct = []
    for r in refs:
        v = X.CI.load_view(pid, "refs", r["label"])
        if v.get("empty"):
            continue
        terr = X.area_to_grid((v["xyz"] != 0).any(-1), gw_p, gh_p).ravel()
        d = {"label": r["label"], "verdict": r["verdict"]}
        for s in ("sat", "hill"):
            img = v["rgb"] if s == "sat" else np.repeat(v["hill"][..., None], 3, -1)
            Fr = bb(img, gw_p, gh_p).reshape(-1, Fp.shape[-1])
            # centre the render by the ring mean of this style (render-domain mean)
            F, _, _, tq = ring[s]
            mu = (F * tq[:, None]).sum(0) / max(tq.sum(), 1e-6)
            Fr = X.l2n(Fr - mu)
            ww = wp * terr
            d[s] = float(((Fpc * Fr).sum(1) * ww).sum() / max(ww.sum(), 1e-6))
        direct.append(d)
    rec["direct"] = direct
    rec["t"]["totalMs"] = round((time.time() - t0) * 1000)
    return rec


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("backbone")
    ap.add_argument("tag")
    ap.add_argument("--cfgs", default="design")
    ap.add_argument("--dev", default="mps")
    ap.add_argument("--wait", action="store_true", help="poll the cache for photos not DONE yet")
    ap.add_argument("ids", nargs="*")
    a = ap.parse_args()
    name, _, layer = a.backbone.partition(":")
    ids = a.ids or X.tm_common.dev_ids()
    for p in ids:
        X.tm_common.assert_dev(p)
    out = RES / f"{a.tag}.json"
    res = json.load(open(out)) if out.exists() else {}
    bb = X.Backbone(name, a.dev, layer or "last")
    cfgs = configs(a.cfgs)
    res["_backbone"] = a.tag
    todo = [p for p in ids if p not in res]
    while todo:
        ready = [p for p in todo if X.CI.done(p)]
        if not ready:
            if not a.wait or (X.CI.CACHE / "ALL_DONE").exists():
                break
            time.sleep(30)
            continue
        pid = ready[0]
        todo.remove(pid)
        t = time.time()
        try:
            res[pid] = process(bb, pid, cfgs, ckey=a.tag)
        except Exception as e:  # noqa: BLE001
            import traceback
            traceback.print_exc()
            res[pid] = {"error": repr(e)}
        json.dump(res, open(out, "w"), indent=0)
        print(pid, round(time.time() - t, 1), "s", res[pid].get("t"), flush=True)
    json.dump(res, open(out, "w"), indent=0)
    print("missing:", todo)
