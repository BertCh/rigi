"""Step Inside P1: splat PLACEMENT validation (offline, DEV ids only). Python port of
src/lib/nearfield/anchor.ts (fitCurve: monotone log-log piecewise-linear DEM calibration) and
src/lib/nearfield/ground.ts (object grounding), run on the TM dev cache + the x2 MoGe-2 depth (no new inference).

Reports per photo (correct ref, moge_l):
  (a) terrain residual |log(placed / DEM)| at DEM 15-500 m for: curve, scale-only IRLS (R3000), mode (R3000),
      scale fitted on DEM 15-150 m only.
  (b) grounded object components: DEM range at contact vs the curve's placed range there, the grounded factor vs the curve,
      object top height above the contact ground and lowest point height above the DEM near its xy.
Writes place.json and out/place/<pid>_place.png (photo | classes+grounded components | placed-range error map).

    tools/matcher/.venv/bin/python tools/nearfield/spike/place.py [--depth moge_l|<npz dir>] [ids...]
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
TM = ROOT / "tools/research/tm"
sys.path.insert(0, str(TM))
sys.path.insert(0, str(TM / "c0_cache"))
sys.path.insert(0, str(HERE))
import cache_io as C  # noqa: E402
import tm_common  # noqa: E402
from spike import fit_mode, fit_scale, model_on_grid  # noqa: E402

GEOM = TM / "x2_geom/geom"
OUT = HERE / "out/place"
SKY, TERRAIN, OBJECT, FAR, UNKNOWN = 0, 1, 2, 3, 4
SPLIT = dict(objectMargin=0.5, nearRadius=150.0, minGapM=3.0)
OBJ_IDS = ("wc_0046", "wc_0054", "wc_0055", "wc_0059", "wc_0067", "wc_0072", "wc_0076")

# ---- curve (mirror of anchor.ts CURVE_DEFAULTS) ----
CURVE = dict(band=math.log(1.25), knots=6, minSpacing=0.2, slopeMin=0.75, slopeMax=6.0, step=0.02, slices=16,
             minRange=15.0, maxRange=3000.0, maxN=40000, octaveWeights=True, slopePrior=0.002, qEnd=0.02)


def fit_curve(mr, dr, o=CURVE):
    """mr = model ray length, dr = DEM range (1-D candidate arrays). Returns dict(x=[log knots], y=[log metres]).
    Globally optimal (on a y grid) piecewise-linear log D = f(log m) under the truncated-L1 loss min(|e|, band), with
    every segment slope in [slopeMin, slopeMax] (monotone; rejects the flat 'object in front of far terrain' branch)."""
    x = np.log(mr)
    y = np.log(dr)
    n = x.size
    if n > o["maxN"]:  # deterministic thinning
        k = np.linspace(0, n - 1, o["maxN"]).astype(int)
        x, y = x[k], y[k]
        n = x.size
    if o["octaveWeights"]:
        # every octave of DEM range weighs the same in total: near terrain (few pixels) matters as much as the
        # far ranges that fill most of a landscape photo
        ob = np.floor(y / math.log(2)).astype(int)
        _, inv, cnt = np.unique(ob, return_inverse=True, return_counts=True)
        wts = 1.0 / cnt[inv]
    else:
        wts = np.ones(n)
    wts = wts * (n / wts.sum())
    order = np.argsort(x)
    xs = x[order]
    cw = np.cumsum(wts[order])
    cw /= cw[-1]
    q = np.linspace(o["qEnd"], 1 - o["qEnd"], o["knots"])
    cand = [float(xs[min(n - 1, int(np.searchsorted(cw, qq)))]) for qq in q]
    kx = [cand[0]]
    for c in cand[1:]:
        if c - kx[-1] >= o["minSpacing"]:
            kx.append(c)
    if len(kx) >= 2 and cand[-1] - kx[-1] > 0 and cand[-1] != kx[-1]:
        # make sure the far end is covered: replace the last knot if the final candidate was dropped for spacing
        if cand[-1] - kx[-2] >= o["minSpacing"]:
            kx[-1] = cand[-1]
    band, step = o["band"], o["step"]
    ys = np.sort(y)
    g0 = ys[int(0.01 * (n - 1))] - 2.0
    g1 = ys[int(0.99 * (n - 1))] + 1.0
    G = int(math.ceil((g1 - g0) / step)) + 1
    grid = g0 + step * np.arange(G)
    kern = np.minimum(np.abs(np.arange(-(G - 1), G) * step), band)  # truncated L1 of a grid offset

    def cost_fn(yy, ww):
        """cost over the grid of placing the curve at ŷ for the samples yy: Σ w·min(|y - ŷ|, band)."""
        if yy.size == 0:
            return np.zeros(G)
        h = np.bincount(np.clip(np.round((yy - g0) / step).astype(int), 0, G - 1), weights=ww, minlength=G)
        return np.convolve(kern, h, "valid")  # kern symmetric: out[a] = sum_i h[i] * kern(a - i)

    K = len(kx)
    if K == 1:
        r = y - x
        # constant ratio: the mode of log(D/m) under the same loss
        rr = np.sort(r)
        lo, hi = rr[0] - band, rr[-1] + band
        gg = np.arange(lo, hi + step, step)
        cs = [(wts * np.minimum(np.abs(r - t), band)).sum() for t in gg]
        t = float(gg[int(np.argmin(cs))])
        return {"x": kx, "y": [kx[0] + t], "n": n}
    kxa = np.asarray(kx)
    # unary costs at the ends (extrapolation with slope 1)
    U = [np.zeros(G) for _ in range(K)]
    left = x < kxa[0]
    right = x >= kxa[-1]
    U[0] += cost_fn(y[left] - (x[left] - kxa[0]), wts[left])
    U[-1] += cost_fn(y[right] - (x[right] - kxa[-1]), wts[right])
    V = U[0].copy()
    back = []
    T = o["slices"]
    for s in range(K - 1):
        dx = kxa[s + 1] - kxa[s]
        sel = (x >= kxa[s]) & (x < kxa[s + 1])
        t = (x[sel] - kxa[s]) / dx
        ts = np.minimum(T - 1, (t * T).astype(int))
        ysel, wsel, xsel = y[sel], wts[sel], x[sel]
        tc = (np.arange(T) + 0.5) / T
        # evaluate each slice at its centre; off-centre samples move along slope 1 to it (error (t-tc)(dy-dx))
        Cs = [cost_fn(ysel[ts == i] - (xsel[ts == i] - (kxa[s] + tc[i] * dx)), wsel[ts == i]) for i in range(T)]
        dmin = int(math.ceil(o["slopeMin"] * dx / step))
        dmax = int(math.floor(o["slopeMax"] * dx / step))
        Vn = np.full(G, np.inf)
        Bn = np.zeros(G, int)
        a = np.arange(G)
        for d in range(dmin, dmax + 1):
            b = a + d
            okb = b < G
            aa, bb = a[okb], b[okb]
            pc = np.zeros(aa.size)
            for i in range(T):
                idx = np.clip(np.round(aa + tc[i] * d).astype(int), 0, G - 1)
                pc += Cs[i][idx]
            # tie-break toward slope 1 (a constant ratio): a knot the data does not pin down (only one-sided outliers
            # near it) stays proportional instead of drifting to a constraint bound
            tot = V[aa] + pc + o["slopePrior"] * n * abs(d * step - dx)
            better = tot < Vn[bb]
            Vn[bb[better]] = tot[better]
            Bn[bb[better]] = aa[better]
        V = Vn + U[s + 1]
        back.append(Bn)
    ys_i = [int(np.argmin(V))]
    for Bn in reversed(back):
        ys_i.append(int(Bn[ys_i[-1]]))
    ys_i.reverse()
    cv = {"x": kx, "y": [float(grid[i]) for i in ys_i], "n": n}
    # sub-grid refinement: shift the curve by the weighted median inlier residual
    e = y - np.log(apply_curve(cv, np.exp(x)))
    inl = np.abs(e) <= band
    if inl.any():
        o_ = np.argsort(e[inl])
        cwi = np.cumsum(wts[inl][o_])
        sh = float(e[inl][o_][np.searchsorted(cwi, cwi[-1] / 2)])
        cv["y"] = [v + sh for v in cv["y"]]
    return cv


def apply_curve(cv, m):
    """metres for model ray length m (array); slope-1 extrapolation beyond the end knots."""
    x = np.log(np.maximum(m, 1e-6))
    kx, ky = np.asarray(cv["x"]), np.asarray(cv["y"])
    if kx.size == 1:
        out = np.exp(x - kx[0] + ky[0])
    else:
        y = np.interp(x, kx, ky)
        y = np.where(x < kx[0], ky[0] + x - kx[0], y)
        y = np.where(x > kx[-1], ky[-1] + x - kx[-1], y)
        out = np.exp(y)
    return np.where(np.isfinite(m), out, np.nan)


def octave_weights(dr):
    ob = np.floor(np.log(dr) / math.log(2)).astype(int)
    _, inv, cnt = np.unique(ob, return_inverse=True, return_counts=True)
    w = 1.0 / cnt[inv]
    return w / w.sum()


def wmedian(v, w):
    o = np.argsort(v)
    c = np.cumsum(w[o])
    return float(v[o][np.searchsorted(c, c[-1] / 2)])


def curve_quality(cv, mr, dr, band=CURVE["band"]):
    """quality = inlierFrac * exp(-(err/0.2)^2), err = median |log| over ALL candidates. Unweighted (the spike's
    definition) and octave-weighted (every octave of DEM range counts the same, like the fit)."""
    e = np.abs(np.log(dr) - np.log(apply_curve(cv, mr)))
    err = float(np.median(e))
    inl = float((e < band).mean())
    w = octave_weights(dr)
    werr = wmedian(e, w)
    winl = float(w[e < band].sum())
    # object-explained: candidates the split would call Object (placed < DEM * (1 - objectMargin)) are excluded
    pl = apply_curve(cv, mr)
    keep = ~((pl < dr * (1 - SPLIT["objectMargin"])) & (pl <= SPLIT["nearRadius"]))
    eo = e[keep]
    oerr = float(np.median(eo)) if eo.size else float("nan")
    oinl = float((eo < band).mean()) if eo.size else 0.0
    return {"residualLogAll": err, "inlierFrac": inl, "quality": inl * math.exp(-((err / 0.2) ** 2)),
            "residualLogAllW": werr, "inlierFracW": winl, "qualityW": winl * math.exp(-((werr / 0.2) ** 2)),
            "objExplainedFrac": float(1 - keep.mean()), "qualityObj": oinl * math.exp(-((oerr / 0.2) ** 2))}


# ---- split (mirror of split.ts classifyRange) ----
def split(dem, placed, valid, p=SPLIT, placed_hi=None):
    """placed_hi (optional): a conservative (far-side) placed range for the Object margin test."""
    ph = placed if placed_hi is None else placed_hi
    cls = np.full(dem.shape, UNKNOWN, np.uint8)
    hit = np.isfinite(dem)
    m = np.isfinite(placed)
    cls[~valid] = SKY
    cls[valid & ~m & hit] = FAR
    far = m & ~(placed <= p["nearRadius"])
    cls[far] = FAR
    near = m & ~far
    obj = near & (~hit | ((ph < dem * (1 - p["objectMargin"])) & (dem - ph >= p["minGapM"])))
    cls[near] = TERRAIN
    cls[obj] = OBJECT
    return cls


# ---- grounding (mirror of ground.ts groundObjects) ----
GROUND = dict(maxInlierLog=0.55, maxLogStep=0.5, bottomBandFrac=0.15, bottomBandMin=2, searchRows=2, contactLog=0.35, minContacts=2,
              minPixels=6)


def components(cls, mr, o=GROUND):
    H, W = cls.shape
    lab = np.full((H, W), -1, int)
    comps = []
    obj = cls == OBJECT
    for j0, i0 in zip(*np.nonzero(obj)):
        if lab[j0, i0] >= 0:
            continue
        cid = len(comps)
        lab[j0, i0] = cid
        dq = deque([(j0, i0)])
        px = []
        while dq:
            j, i = dq.popleft()
            px.append((j, i))
            for dj, di in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                jj, ii = j + dj, i + di
                if 0 <= jj < H and 0 <= ii < W and obj[jj, ii] and lab[jj, ii] < 0:
                    a, b = mr[j, i], mr[jj, ii]
                    if np.isfinite(a) and np.isfinite(b) and abs(math.log(b / a)) > o["maxLogStep"]:
                        continue
                    lab[jj, ii] = cid
                    dq.append((jj, ii))
        comps.append(np.asarray(px))
    return lab, comps


def ground(cls, mr, dem, curve, o=GROUND):
    """Returns (lab, comps info list, factor per component or nan). factor = metres per model unit for the component."""
    H, W = cls.shape
    lab, comps = components(cls, mr, o)
    H_ = H
    info = []
    for cid, px in enumerate(comps):
        jj, ii = px[:, 0], px[:, 1]
        c = {"id": cid, "n": int(len(px)), "bbox": [int(ii.min()), int(jj.min()), int(ii.max()), int(jj.max())]}
        c["curveMedRange"] = float(np.nanmedian(apply_curve(curve, mr[jj, ii])))
        c["factor"] = None
        if len(px) < o["minPixels"]:
            info.append(c)
            continue
        bottom = jj.max()
        hgt = bottom - jj.min() + 1
        # uprightness: median model depth of the top quarter of rows / bottom quarter (receding terrain >> 1)
        q1 = jj.min() + 0.25 * (hgt - 1)
        q3 = jj.min() + 0.75 * (hgt - 1)
        mt, mb = mr[jj[jj <= q1], ii[jj <= q1]], mr[jj[jj >= q3], ii[jj >= q3]]
        c["recede"] = float(np.nanmedian(mt) / np.nanmedian(mb)) if np.isfinite(mt).any() and np.isfinite(mb).any() else None
        if o.get("upright") and c["recede"] is not None and hgt >= 8 and c["recede"] > o["upright"]:
            c["notUpright"] = True
            cls[jj, ii] = TERRAIN
            info.append(c)
            continue
        band = max(o["bottomBandMin"], int(math.ceil(o["bottomBandFrac"] * hgt)))
        # per column: the lowest pixel of the component
        colbot = {}
        for j, i in px:
            if j > colbot.get(i, -1):
                colbot[i] = j
        ratios, dems, models = [], [], []
        for i, j in colbot.items():
            if j < bottom - band + 1:
                continue
            mo = mr[j, i]
            if not np.isfinite(mo):
                continue
            for s in range(1, o["searchRows"] + 1):
                jb = j + s
                if jb >= H:
                    break
                if cls[jb, i] == OBJECT and lab[jb, i] != cid:
                    break
                if cls[jb, i] != TERRAIN or not np.isfinite(dem[jb, i]):
                    continue
                mt = mr[jb, i]
                if not np.isfinite(mt) or abs(math.log(mt / mo)) > o["contactLog"]:
                    break  # a depth jump: the object floats in front of that terrain
                if o["maxInlierLog"] and abs(math.log(dem[jb, i] / apply_curve(curve, np.array([mt]))[0])) > o["maxInlierLog"]:
                    break  # the ground there is not terrain the DEM models (terrace, roof, eye-height error): no contact
                ratios.append(dem[jb, i] / mo)
                dems.append(dem[jb, i])
                models.append(mo)
                c.setdefault("contactPx", []).append((int(jb), int(i)))
                break
        c["contacts"] = len(ratios)
        if len(ratios) >= o["minContacts"]:
            c["factor"] = float(np.median(ratios))
            c["contactDem"] = float(np.median(dems))
            c["contactModel"] = float(np.median(models))
            c["contactCurve"] = float(apply_curve(curve, np.array([c["contactModel"]]))[0])
        info.append(c)
    return lab, info


def placed_grid(mr, curve, lab, info):
    out = apply_curve(curve, mr)
    for c in info:
        if c["factor"] is not None:
            k = lab == c["id"]
            out[k] = c["factor"] * mr[k]
    return out


# ---- geometry helpers for heights ----
def world_points(rec, rng):
    u, v = C.xyz_pixel_coords(rec)
    d = C.pixel_rays(rec, u, v)
    return np.asarray(rec["eye"], float) + d * rng[..., None]


def dem_height_lookup(rec):
    from scipy.spatial import cKDTree
    X = rec["xyz"].astype(np.float64)
    hit = (X != 0).any(-1)
    return cKDTree(X[hit][:, :2]), X[hit][:, 2]


COLORS = np.array([[180, 200, 230], [60, 170, 70], [255, 0, 200], [40, 70, 200], [0, 0, 0]], np.uint8)


def save_png(pid, cls, lab, info, err, path):
    ph = Image.open(tm_common.CACHE / pid / "photo.jpg").convert("RGB")
    h, w = cls.shape
    pw = 384
    ph_s = ph.resize((pw, round(pw * h / w)), Image.BILINEAR)
    sx = pw / w
    cm = Image.fromarray(COLORS[cls]).resize(ph_s.size, Image.NEAREST)
    ov = Image.blend(ph_s, cm, 0.5)
    # grounded components yellow outline + contact dots cyan; ungrounded components magenta (as class colour)
    grounded = np.zeros(cls.shape, bool)
    for c in info:
        if c["factor"] is not None:
            grounded |= lab == c["id"]
    gm = np.asarray(Image.fromarray(grounded.astype(np.uint8) * 255).resize(ph_s.size, Image.NEAREST)) > 0
    a = np.asarray(ov).copy()
    a[gm] = (0.35 * np.asarray(ph_s)[gm] + 0.65 * np.array([255, 210, 0])).astype(np.uint8)
    im = Image.fromarray(a)
    dr = ImageDraw.Draw(im)
    for c in info:
        for jb, i in c.get("contactPx", []) if c["factor"] is not None else []:
            dr.point((i * sx, jb * sx), fill=(0, 255, 255))
    # error map: log(placed/DEM) on terrain-ish pixels, red = too far, blue = too near, white = ok (±0.5 full scale)
    e = np.clip(np.nan_to_num(err, nan=0.0) / 0.5, -1, 1)
    rgb = np.stack([1 - np.maximum(-e, 0), 1 - np.abs(e), 1 - np.maximum(e, 0)], -1)
    rgb[~np.isfinite(err)] = 0.15
    em = Image.fromarray((rgb * 255).astype(np.uint8)).resize(ph_s.size, Image.NEAREST)
    canvas = Image.new("RGB", (pw * 3, ph_s.size[1]))
    canvas.paste(ph_s, (0, 0))
    canvas.paste(im, (pw, 0))
    canvas.paste(em, (2 * pw, 0))
    canvas.save(path, optimize=True)


def load_depth(pid, src):
    if src in ("moge_l", "moge_b"):
        return dict(np.load(GEOM / f"{pid}.{src}.npz"))
    g = dict(np.load(Path(src) / f"{pid}.npz"))
    if "mask" not in g:
        g["mask"] = np.load(GEOM / f"{pid}.moge_l.npz")["mask"]
    return g


def resid(dem, placed, cls, lo=15.0, hi=500.0):
    w = np.isfinite(dem) & np.isfinite(placed) & (dem > lo) & (dem < hi) & (cls != OBJECT)
    if w.sum() < 150:
        return None
    return float(np.median(np.abs(np.log(placed[w] / dem[w]))))


def resid_bins(dem, placed, cls):
    return {f"{lo}-{hi}": resid(dem, placed, cls, lo, hi) for lo, hi in ((15, 50), (50, 150), (150, 500))}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ids", nargs="*")
    ap.add_argument("--depth", default="moge_l", help="moge_l | moge_b | a directory of <pid>.npz (depth z, mask?)")
    ap.add_argument("--tag", default="")
    ap.add_argument("--png", action="store_true")
    ap.add_argument("--hi", type=float, default=0.0, help="model-depth uncertainty for the conservative Object test")
    ap.add_argument("--inlier", type=float, default=0.55, help="max |log(DEM / curve)| at a contact's terrain pixel")
    ap.add_argument("--step", type=float, default=GROUND["maxLogStep"], help="max |log| model-depth step inside a component")
    ap.add_argument("--upright", type=float, default=2.0, help="drop components whose top/bottom model depth ratio > this")
    ap.add_argument("--curve", default="{}", help="JSON overrides of CURVE")
    a = ap.parse_args()
    CURVE.update(json.loads(a.curve))
    OUT.mkdir(parents=True, exist_ok=True)
    dev = set(tm_common.dev_ids())
    raw = json.load(open(HERE / "results_raw.json"))
    ids = a.ids or sorted(raw)
    res = {}
    for pid in ids:
        assert pid in dev, f"{pid} not dev"
        m = C.load_meta(pid)
        if not m["correct_refs"]:
            continue
        rec = C.load_view(pid, "refs", m["perturbBase"])
        dem = C.depth(rec)
        g = load_depth(pid, a.depth)
        ray, valid = model_on_grid(g, rec, "solved", g["mask"] if a.depth not in ("moge_l", "moge_b") else None)
        cand = np.isfinite(dem) & np.isfinite(ray) & (dem >= CURVE["minRange"]) & (dem <= CURVE["maxRange"])
        r = {"n": int(cand.sum()), "tags": m["tags"].get("foreground")}
        if cand.sum() < 200:
            r["ok"] = False
            res[pid] = r
            print(pid, "no fit", cand.sum(), flush=True)
            continue
        cv = fit_curve(ray[cand], dem[cand])
        r["curve"] = cv
        r["curveQ"] = curve_quality(cv, ray[cand], dem[cand])
        slopes = np.diff(cv["y"]) / np.diff(cv["x"]) if len(cv["x"]) > 1 else np.array([1.0])
        r["slopes"] = [round(float(s), 3) for s in slopes]
        placed_c = apply_curve(cv, ray)
        cls = split(dem, placed_c, valid, placed_hi=apply_curve(cv, ray * (1 + a.hi)) if a.hi > 0 else None)
        sc = fit_scale(dem, ray, 3000.0)
        md = fit_mode(dem, ray, 3000.0)
        s150 = fit_scale(dem, ray, 150.0)
        # method-independent evaluation mask: not Object under the spike's recommended split (mode3000 scale); the
        # curve's own split is used only for grounding
        cls_eval = split(dem, ray * md["scale"], valid) if md["ok"] else cls
        r["objFracCurve"] = float((cls == OBJECT).mean())
        r["objFracMode"] = float((cls_eval == OBJECT).mean())
        cls_c = cls
        cls = cls_eval
        r["resid500"] = {
            "curve": resid(dem, placed_c, cls),
            "scale3000": resid(dem, ray * sc["scale"], cls) if sc["ok"] else None,
            "mode3000": resid(dem, ray * md["scale"], cls) if md["ok"] else None,
            "scale150": resid(dem, ray * s150["scale"], cls) if s150.get("ok") else None,
        }
        r["residBins"] = {"curve": resid_bins(dem, placed_c, cls),
                          "scale3000": resid_bins(dem, ray * sc["scale"], cls) if sc["ok"] else None}
        cls = cls_c
        lab, info = ground(cls, ray, dem, cv, dict(GROUND, upright=a.upright, maxInlierLog=a.inlier, maxLogStep=a.step))
        r["objFracFinal"] = float((cls == OBJECT).mean())
        placed = placed_grid(ray, cv, lab, info)
        # heights: grounded components, points in world
        P = world_points(rec, np.nan_to_num(placed, nan=0.0))
        tree, zs = dem_height_lookup(rec)
        Pc = world_points(rec, np.nan_to_num(dem, nan=0.0))
        comps = []
        for c in info:
            if c["n"] < 30:
                continue
            k = lab == c["id"]
            o = {kk: c.get(kk) for kk in ("id", "n", "bbox", "contacts", "factor", "contactDem", "contactModel",
                                          "contactCurve", "curveMedRange", "recede", "notUpright")}
            o["placedMedRange"] = float(np.nanmedian(placed[k]))
            o["demBehindMed"] = float(np.nanmedian(dem[k])) if np.isfinite(dem[k]).any() else None
            if c["factor"] is not None:
                cp = np.asarray(c["contactPx"])
                gz = float(np.median(Pc[cp[:, 0], cp[:, 1], 2]))
                pts = P[k]
                o["topAboveContactGround"] = float(pts[:, 2].max() - gz)
                o["bottomAboveContactGround"] = float(pts[:, 2].min() - gz)
                dist, idx = tree.query(pts[:, :2], k=1)
                hh = pts[:, 2] - zs[idx]
                okh = dist < 0.05 * placed[k] + 2.0
                o["fracPtsWithDem"] = float(okh.mean())
                o["fracBelowDem1m"] = float((hh[okh] < -1.0).mean()) if okh.any() else None
                o["heightAboveDemP05"] = float(np.percentile(hh[okh], 5)) if okh.any() else None
                # consistency: placed range at the contact pixels (object side) vs DEM range at contact
                o["contactPlacedOverDem"] = c["factor"] * c["contactModel"] / c["contactDem"]
                o["curveOverDemAtContact"] = c["contactCurve"] / c["contactDem"]
                o["scale3000OverDemAtContact"] = (sc["scale"] * c["contactModel"] / c["contactDem"]) if sc["ok"] else None
            comps.append(o)
        r["components"] = comps
        r["objFrac"] = float((cls == OBJECT).mean())
        err = np.log(placed / dem)
        err[(cls == OBJECT) | ~np.isfinite(err)] = np.nan
        if a.png:
            save_png(pid, cls, lab, info, err, OUT / f"{pid}_place{a.tag}.png")
        res[pid] = r
        g_n = sum(1 for c in comps if c.get("factor") is not None)
        print(pid, "n", r["n"], "slopes", r["slopes"], "q", {k: round(v, 3) for k, v in r["curveQ"].items()},
              "res500", {k: (round(v, 3) if v is not None else None) for k, v in r["resid500"].items()},
              "comps>=30", len(comps), "grounded", g_n, flush=True)
    json.dump(res, open(HERE / f"place{a.tag}.json", "w"), indent=1, default=float)


if __name__ == "__main__":
    main()
