"""Step Inside P0 spike: does DEM anchoring + depth split work? (offline, numerical, DEV ids only)

Inputs (read-only): TM dev render cache (tools/research/tm/cache/<pid>/{refs,perturb}/<tag>/xyz.npz, meta.json) and
the MoGe-2 / DA3 geometry that x2_geom already computed (tools/research/tm/x2_geom/geom/<pid>.<model>.npz, 768 wide).

Per photo with a correct ref:
  1. DEM range per pixel |xyz - eye| on the xyz grid (stride 2) and model z-depth -> ray length (solved intrinsics;
     the model's own predicted intrinsics as a variant), nearest-resampled to the same grid.
  2. Robust scale fit (scale-only IRLS on log ratios; affine IRLS in linear space) on terrain pixels:
     model-valid & DEM hit & DEM range < R, R in (300, 1000, 3000).
  3. Depth split with DEFAULT_SPLIT (src/lib/nearfield/types.ts) -> class map PNG in out/.
  4. Pose-verifier: the same fit against wrong refs and yaw/pitch perturbed views.

    tools/matcher/.venv/bin/python tools/nearfield/spike/spike.py [--models moge_l,moge_b,da3_b] [ids...]
Writes tools/nearfield/spike/results.json and out/<pid>_split.png.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
TM = ROOT / "tools/research/tm"
sys.path.insert(0, str(TM))
sys.path.insert(0, str(TM / "c0_cache"))
import cache_io as C  # noqa: E402
import tm_common  # noqa: E402

GEOM = TM / "x2_geom/geom"
OUT = HERE / "out"
RANGES = (300.0, 1000.0, 3000.0)
DEFAULT_SPLIT = dict(objectMargin=0.25, nearRadius=400.0, minGapM=3.0)
BAND = math.log(1.25)  # inlier band on |log residual| (±25 %)
MIN_N = 150  # min candidate pixels for a fit
RMIN = 15.0  # DEM range floor: closer DEM is dominated by eye-height / DEM-resolution error
BINS = (0, 15, 30, 100, 300, 1000, 3000, 10000, 1e9)
PERTURB_TAGS = ("yaw-8", "yaw-2", "yaw+2", "yaw+8", "pitch-2", "pitch+2")


# ------------------------------------------------------------------ sampling
def dem_range(rec):
    return C.depth(rec)  # (h,w) metres, nan = no DEM hit


def model_on_grid(g, rec, intr="solved", sky_mask=None):
    """Model depth (z) nearest-sampled at the xyz grid of view rec, converted to ray length.
    Returns (ray_len (h,w) nan invalid, valid (h,w) bool = model thinks non-sky)."""
    d = g["depth"].astype(np.float32)
    gh, gw = d.shape
    W, H = rec["W"], rec["H"]
    u, v = C.xyz_pixel_coords(rec)
    x = np.clip(np.floor(u / W * gw).astype(int), 0, gw - 1)
    y = np.clip(np.floor(v / H * gh).astype(int), 0, gh - 1)
    msk = (sky_mask if sky_mask is not None else g["mask"])[y, x]
    z = d[y, x].astype(np.float64)
    ok = msk & np.isfinite(z) & (z > 0)
    if intr == "solved":
        k = rec["intrinsics"]
        xn, yn = (u - k["cx"]) / k["fx"], (v - k["cy"]) / k["fy"]
    else:  # model's own predicted fov
        fxn = 0.5 / math.tan(math.radians(float(g["hfov_pred"])) / 2)
        fyn = 0.5 / math.tan(math.radians(float(g["vfov_pred"])) / 2)
        xn, yn = (u / W - 0.5) / fxn, (v / H - 0.5) / fyn
    ray = z * np.sqrt(1 + xn**2 + yn**2)
    ray[~ok] = np.nan
    return ray, msk


# ------------------------------------------------------------------ fits
def fit_scale(dem, mdl, R, rmin=RMIN):
    """Scale-only robust fit of dem ≈ s*mdl on candidates (both finite, dem < R). IRLS (Tukey on log residual)."""
    cand = np.isfinite(dem) & np.isfinite(mdl) & (dem < R) & (dem > rmin)
    n = int(cand.sum())
    if n < MIN_N:
        return {"n": n, "ok": False}
    r = np.log(dem[cand]) - np.log(mdl[cand])
    ls = float(np.median(r))
    for _ in range(10):
        e = r - ls
        c = 2.5 * BAND
        w = np.where(np.abs(e) < c, (1 - (e / c) ** 2) ** 2, 0.0)
        if w.sum() < 1e-6:
            break
        ls_new = float((w * r).sum() / w.sum())
        if abs(ls_new - ls) < 1e-5:
            ls = ls_new
            break
        ls = ls_new
    e = np.abs(r - ls)
    inl = e < BAND
    return {
        "ok": True,
        "n": n,
        "scale": math.exp(ls),
        "logScaleMedian": float(np.median(r)),
        "residualLog": float(np.median(e[inl])) if inl.any() else float("nan"),  # contract definition (inliers)
        "residualLogAll": float(np.median(e)),  # over all candidates (more honest)
        "p90LogAll": float(np.percentile(e, 90)),
        "inlierFrac": float(inl.mean()),
        "maxRange": R,
    }


def fit_affine(dem, mdl, R, rmin=RMIN):
    """dem ≈ s*mdl + t, IRLS with relative (1/dem) weights and Tukey on relative error."""
    cand = np.isfinite(dem) & np.isfinite(mdl) & (dem < R) & (dem > rmin)
    n = int(cand.sum())
    if n < MIN_N:
        return {"n": n, "ok": False}
    D, M = dem[cand], mdl[cand]
    s = float(np.median(D / M))
    t = 0.0
    w = np.ones_like(D)
    for _ in range(15):
        A = np.stack([M, np.ones_like(M)], 1) * (w / D)[:, None]
        b = D * (w / D)
        (s, t), *_ = np.linalg.lstsq(A, b, rcond=None)
        pred = np.maximum(s * M + t, 1e-3)
        e = np.log(D) - np.log(pred)
        c = 2.5 * BAND
        w = np.where(np.abs(e) < c, (1 - (e / c) ** 2) ** 2, 0.0) + 1e-9
    pred = np.maximum(s * M + t, 1e-3)
    e = np.abs(np.log(D) - np.log(pred))
    inl = e < BAND
    return {
        "ok": True,
        "n": n,
        "scale": float(s),
        "shift": float(t),
        "residualLog": float(np.median(e[inl])) if inl.any() else float("nan"),
        "residualLogAll": float(np.median(e)),
        "inlierFrac": float(inl.mean()),
        "maxRange": R,
    }


def fit_logaffine(dem, mdl, R, rmin=RMIN):
    """log dem ≈ a + b log mdl (power law D = e^a d^b), Tukey IRLS on log residual."""
    cand = np.isfinite(dem) & np.isfinite(mdl) & (dem < R) & (dem > rmin)
    n = int(cand.sum())
    if n < MIN_N:
        return {"n": n, "ok": False}
    y, x = np.log(dem[cand]), np.log(mdl[cand])
    w = np.ones_like(y)
    a, b = float(np.median(y - x)), 1.0
    for _ in range(15):
        A = np.stack([np.ones_like(x), x], 1) * w[:, None]
        (a, b), *_ = np.linalg.lstsq(A, y * w, rcond=None)
        e = y - a - b * x
        c = 2.5 * BAND
        w = np.sqrt(np.where(np.abs(e) < c, (1 - (e / c) ** 2) ** 2, 0.0) + 1e-9)
    e = np.abs(y - a - b * x)
    inl = e < BAND
    return {"ok": True, "n": n, "a": float(a), "b": float(b),
            "residualLog": float(np.median(e[inl])) if inl.any() else float("nan"),
            "residualLogAll": float(np.median(e)), "inlierFrac": float(inl.mean()), "maxRange": R}


def fit_mode(dem, mdl, R, rmin=RMIN, bw=0.1):
    """Scale = mode of log(D/d) (Gaussian-smoothed histogram) on DEM range in [rmin, R]: robust to one-sided
    contamination by near objects (which all have D/d >> s)."""
    cand = np.isfinite(dem) & np.isfinite(mdl) & (dem < R) & (dem > rmin)
    n = int(cand.sum())
    if n < MIN_N:
        return {"ok": False, "n": n}
    r = np.log(dem[cand] / mdl[cand])
    lo, hi = np.percentile(r, 1) - 0.5, np.percentile(r, 99) + 0.5
    edges = np.arange(lo, hi + 0.02, 0.02)
    h, _ = np.histogram(r, edges)
    k = np.arange(-3 * bw, 3 * bw + 1e-9, 0.02)
    g = np.exp(-0.5 * (k / bw) ** 2)
    hs = np.convolve(h, g, "same")
    m = 0.5 * (edges[:-1] + edges[1:])[int(np.argmax(hs))]
    inl = np.abs(r - m) < BAND
    if inl.any():
        m = float(np.median(r[inl]))
    e = np.abs(r - m)
    inl = e < BAND
    return {"ok": True, "n": n, "scale": math.exp(m), "residualLogAll": float(np.median(e)),
            "residualLog": float(np.median(e[inl])) if inl.any() else float("nan"), "inlierFrac": float(inl.mean())}


def fit_binmode(dem, mdl, rmin=RMIN, R=1e9, edges=(0, 10, 20, 40, 80, 160, 320, 640, 1280, 1e9)):
    """Range-dependent scale s(d): mode of log(D/d) per model-depth bin, made monotone non-decreasing in d by a running
    minimum from the far end (MoGe compresses range, so s grows with d; near objects only push s UP, and the running
    minimum stops them from inflating near-bin scales). Bins with < MIN_N/3 pixels inherit from the next farther bin.
    Returns dict(ok, knots_d (bin centres, model m), logs (log scale per knot))."""
    cand = np.isfinite(dem) & np.isfinite(mdl) & (dem < R) & (dem > rmin)
    if cand.sum() < MIN_N:
        return {"ok": False, "n": int(cand.sum())}
    d, D = mdl[cand], dem[cand]
    cent, logs = [], []
    for lo, hi in zip(edges[:-1], edges[1:]):
        k = (d >= lo) & (d < hi)
        c = float(np.exp(np.median(np.log(d[k])))) if k.sum() else math.sqrt(max(lo, 1) * min(hi, 1e5))
        cent.append(c)
        if k.sum() >= MIN_N // 3:
            f = fit_mode(D[k], d[k], 1e12, rmin=0)
            logs.append(math.log(f["scale"]) if f["ok"] else None)
        else:
            logs.append(None)
    if all(x is None for x in logs):
        return {"ok": False, "n": int(cand.sum())}
    # empty far bins inherit the nearest supported bin on their near side; then running minimum from the far end
    # (s non-decreasing in d); empty near bins inherit from the far side through the same running minimum.
    for i in range(1, len(logs)):
        if logs[i] is None and logs[i - 1] is not None:
            logs[i] = logs[i - 1]
    last = None
    for i in range(len(logs) - 1, -1, -1):
        if logs[i] is not None:
            last = logs[i] if last is None else min(logs[i], last)
        logs[i] = last
    return {"ok": True, "n": int(cand.sum()), "knots_d": cent, "logs": logs}


def apply_binmode(f, ray):
    x = np.log(np.maximum(np.asarray(f["knots_d"]), 1e-3))
    ls = np.interp(np.log(np.maximum(np.nan_to_num(ray, nan=1.0), 1e-3)), x, np.asarray(f["logs"]))
    out = ray * np.exp(ls)
    out[~np.isfinite(ray)] = np.nan
    return out


def ratio_profile(dem, mdl):
    """Median log(DEM range / model range) per DEM-range bin (both valid)."""
    ok = np.isfinite(dem) & np.isfinite(mdl)
    out = []
    for lo, hi in zip(BINS[:-1], BINS[1:]):
        k = ok & (dem >= lo) & (dem < hi)
        r = np.log(dem[k] / mdl[k]) if k.sum() else np.array([])
        out.append({"lo": lo, "hi": hi, "n": int(k.sum()), "medLogRatio": float(np.median(r)) if r.size >= 50 else None})
    return out


# ------------------------------------------------------------------ split
SKY, TERRAIN, OBJECT, FAR, UNKNOWN = 0, 1, 2, 3, 4


def split(dem, mdl_scaled, model_valid, p=DEFAULT_SPLIT, height=None):
    cls = np.full(dem.shape, UNKNOWN, np.uint8)
    hit = np.isfinite(dem)
    m = np.isfinite(mdl_scaled)
    cls[~model_valid] = SKY
    far = m & (mdl_scaled > p["nearRadius"])
    cls[far] = FAR
    near = m & ~far
    # no calibrated model depth (no anchor fit): the DEM alone decides Terrain vs Far for model-valid pixels
    nod = model_valid & ~m
    cls[nod & hit & (dem <= p["nearRadius"])] = TERRAIN
    cls[nod & hit & (dem > p["nearRadius"])] = FAR
    obj = near & (~hit | ((mdl_scaled < dem * (1 - p["objectMargin"])) & (dem - mdl_scaled > p["minGapM"])))
    if height is not None and p.get("minHeightM"):
        # an Object must stand up off the DEM: rejects grazing-angle ground (eye-height error) and silhouette slivers
        obj &= ~(height < p["minHeightM"])  # nan (DEM not seen there) keeps the range decision
    cls[near] = TERRAIN
    cls[obj] = OBJECT
    return cls


def height_above_dem(rec, mapped, max_nn_frac=0.05):
    """Height (m) of each model point (eye + ray * mapped range) above the DEM surface at its xy. The DEM height field
    is the view's own visible xyz samples (nearest neighbour in xy, accepted within max_nn_frac * range); nan when the
    model point lies over DEM that this view does not see. The product would sample the DEM tiles directly."""
    from scipy.spatial import cKDTree
    X = rec["xyz"].astype(np.float64)
    hit = (X != 0).any(-1)
    tree = cKDTree(X[hit][:, :2])
    zs = X[hit][:, 2]
    u, v = C.xyz_pixel_coords(rec)
    dirs = C.pixel_rays(rec, u, v)
    ok = np.isfinite(mapped)
    P = np.asarray(rec["eye"], float) + dirs[ok] * mapped[ok][:, None]
    dist, idx = tree.query(P[:, :2], k=1)
    h = np.full(mapped.shape, np.nan)
    hv = P[:, 2] - zs[idx]
    hv[dist > max_nn_frac * mapped[ok] + 2.0] = np.nan
    h[ok] = hv
    return h


COLORS = np.array([[180, 200, 230], [60, 170, 70], [255, 0, 200], [40, 70, 200], [0, 0, 0]], np.uint8)


def save_split_png(pid, cls, path):
    ph = Image.open(tm_common.CACHE / pid / "photo.jpg").convert("RGB")
    h, w = cls.shape
    pw = 384
    ph_s = ph.resize((pw, round(pw * h / w)), Image.BILINEAR)
    cm = Image.fromarray(COLORS[cls]).resize(ph_s.size, Image.NEAREST)
    ov = Image.blend(ph_s, cm, 0.55)
    # objects fully opaque-ish so they pop
    a = np.asarray(ov).copy()
    objm = np.asarray(Image.fromarray((cls == OBJECT).astype(np.uint8) * 255).resize(ph_s.size, Image.NEAREST)) > 0
    a[objm] = (0.3 * np.asarray(ph_s)[objm] + 0.7 * COLORS[OBJECT]).astype(np.uint8)
    canvas = Image.new("RGB", (pw * 2, ph_s.size[1]))
    canvas.paste(ph_s, (0, 0))
    canvas.paste(Image.fromarray(a), (pw, 0))
    canvas.save(path, optimize=True)


FINAL_SPLIT = "mode"
RECOMMENDED_SPLIT = dict(objectMargin=0.5, nearRadius=150.0, minGapM=3.0)
BINMODE_SPLIT = dict(objectMargin=0.5, nearRadius=400.0, minGapM=3.0)
BINMODE_H_SPLIT = dict(objectMargin=0.5, nearRadius=400.0, minGapM=3.0, minHeightM=1.0)


def split_variants(dem, ray, fits):
    """Yield (name, calibrated model range, info). Variants:
    scale_v0: scale-only fit (R 1000 -> 300 -> 3000), raw model scale if no fit (the naive design).
    scale:    same but no split at all when there is no fit (mapped = nan -> DEM decides Terrain/Far).
    pow:      power law D = e^a d^b fitted on all DEM hits > RMIN (corrects the model's range compression);
              no split when there is no fit."""
    f = None
    for Rk in ("1000", "300", "3000"):
        f = fits[Rk]["scale"]
        if f["ok"]:
            break
    ok = bool(f and f["ok"])
    yield "scale_v0", ray * (f["scale"] if ok else 1.0), {"scaleUsed": f["scale"] if ok else 1.0, "scaleR": Rk if ok else None}
    yield "scale", ray * f["scale"] if ok else np.full_like(ray, np.nan), {"scaleUsed": f["scale"] if ok else None}
    fm = fits["3000"]["mode"]
    yield "mode", ray * fm["scale"] if fm["ok"] else np.full_like(ray, np.nan), {"scaleUsed": fm.get("scale"), "params": RECOMMENDED_SPLIT}
    bm = fits["all"]["binmode"]
    bmm = apply_binmode(bm, ray) if bm["ok"] else np.full_like(ray, np.nan)
    yield "binmode", bmm, {"params": BINMODE_SPLIT}
    yield "binmode_h", bmm, {"params": BINMODE_H_SPLIT, "height": True}
    la = fits["all"]["logaffine"]
    if la["ok"]:
        yield "pow", np.exp(la["a"]) * ray ** la["b"], {"a": la["a"], "b": la["b"]}
    else:
        yield "pow", np.full_like(ray, np.nan), {"a": None, "b": None}


# ------------------------------------------------------------------ main
def summarize_view(dem, ray, fits_R=RANGES):
    out = {}
    for R in fits_R:
        out[str(int(R))] = {"scale": fit_scale(dem, ray, R), "affine": fit_affine(dem, ray, R),
                            "logaffine": fit_logaffine(dem, ray, R), "mode": fit_mode(dem, ray, R)}
    out["scale_rmin0_1000"] = fit_scale(dem, ray, 1000.0, rmin=1.0)
    out["all"] = {"scale": fit_scale(dem, ray, 1e9), "logaffine": fit_logaffine(dem, ray, 1e9), "binmode": fit_binmode(dem, ray)}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ids", nargs="*")
    ap.add_argument("--models", default="moge_l,moge_b,da3_b")
    ap.add_argument("--png-model", default="moge_l")
    a = ap.parse_args()
    (OUT / "variants").mkdir(parents=True, exist_ok=True)
    dev = set(tm_common.dev_ids())
    ids = a.ids or sorted(p.name for p in tm_common.CACHE.iterdir() if (p / "DONE").exists())
    models = a.models.split(",")
    res = {}
    for pid in ids:
        assert pid in dev, f"{pid} not dev"
        m = C.load_meta(pid)
        if not m["correct_refs"]:
            continue
        base = m["perturbBase"]
        views = [("correct", "refs", r["label"]) for r in m["correct_refs"]]
        views += [("wrong", "refs", r["label"]) for r in m["wrong_refs"]]
        views += [("perturb", "perturb", t) for t in PERTURB_TAGS]
        geoms = {k: dict(np.load(GEOM / f"{pid}.{k}.npz")) for k in models if (GEOM / f"{pid}.{k}.npz").exists()}
        sky_ref = geoms.get("moge_l", next(iter(geoms.values())))["mask"]
        pr = {"W": m["W"], "H": m["H"], "tags": m["tags"], "base": base, "views": {}, "models_hfov_pred": {}}
        hf_true = None
        for kind, grp, tag in views:
            rec = C.load_view(pid, grp, tag)
            if rec.get("empty"):
                continue
            dem = dem_range(rec)
            if kind == "correct" and tag == base:
                hf_true = rec["intrinsics"]["hfov"]
            vr = {"kind": kind, "group": grp, "tag": tag, "demHitFrac": float(np.isfinite(dem).mean()),
                  "demLt": {str(int(R)): float((dem < R).mean()) for R in RANGES}, "models": {}}
            for k, g in geoms.items():
                sm = None if k.startswith("moge") else sky_ref  # DA3 has no sky mask: borrow MoGe-L's
                ray, valid = model_on_grid(g, rec, "solved", sm)
                mv = {"solved": summarize_view(dem, ray)}
                if kind == "correct" and tag == base:
                    ray2, _ = model_on_grid(g, rec, "model", sm)
                    mv["modelIntr"] = summarize_view(dem, ray2)
                    pr["models_hfov_pred"][k] = float(g["hfov_pred"])
                    mv["profile"] = ratio_profile(dem, ray)
                    mv["split"] = {}
                    for var, mapped, info in split_variants(dem, ray, mv["solved"]):
                        hgt = height_above_dem(rec, mapped) if info.pop("height", False) else None
                        cls = split(dem, mapped, valid, info.get("params", DEFAULT_SPLIT), hgt)
                        cnt = np.bincount(cls.ravel(), minlength=5)
                        nonsky = cnt[1:].sum()
                        objNoHit = int(((cls == OBJECT) & ~np.isfinite(dem)).sum())
                        mv["split"][var] = {**info, "counts": cnt.tolist(),
                                            "objectFrac": float(cnt[OBJECT] / cls.size),
                                            "objectFracNonSky": float(cnt[OBJECT] / max(nonsky, 1)),
                                            "objectNoDemHitFrac": float(objNoHit / max(cnt[OBJECT], 1)),
                                            "terrainFrac": float(cnt[TERRAIN] / cls.size), "farFrac": float(cnt[FAR] / cls.size)}
                        # design gate: |log(calibrated model / DEM)| on terrain pixels with DEM range in [RMIN, 500]
                        w5 = np.isfinite(dem) & np.isfinite(mapped) & (dem > RMIN) & (dem < 500)
                        e5 = np.abs(np.log(mapped[w5] / dem[w5])) if w5.any() else np.array([])
                        t5 = (cls[w5] != OBJECT) if w5.any() else np.array([], bool)
                        mv["split"][var].update({"n500": int(w5.sum()),
                                                 "resid500All": float(np.median(e5)) if e5.size >= MIN_N else None,
                                                 "resid500Terr": float(np.median(e5[t5])) if t5.sum() >= MIN_N else None})
                        if k == a.png_model:
                            save_split_png(pid, cls, OUT / (f"{pid}_split.png" if var == FINAL_SPLIT else f"variants/{pid}_split_{var}.png"))
                vr["models"][k] = mv
            pr["views"][f"{grp}/{tag}"] = vr
        pr["hfov_true"] = hf_true
        res[pid] = pr
        b = pr["views"].get(f"refs/{base}", {}).get("models", {}).get("moge_l", {})
        f = b.get("solved", {}).get("1000", {}).get("scale", {})
        print(pid, base, "n", f.get("n"), "s", round(f.get("scale", float("nan")), 3),
              "res", round(f.get("residualLogAll", float("nan")), 3), "inl", round(f.get("inlierFrac", float("nan")), 3),
              "obj", {v: round(x["objectFrac"], 3) for v, x in b.get("split", {}).items()},
              "pow b", b.get("split", {}).get("pow", {}).get("b"), flush=True)
    json.dump(res, open(HERE / "results_raw.json", "w"), indent=1, default=float)


if __name__ == "__main__":
    main()
