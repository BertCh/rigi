"""E2 render variants (offline post-processing of cached views). See PROTOCOL.txt.

  v0  current rgb.jpg (baseline)
  v1  sun-relit: albedo = dehazed ortho / baked shading (Lambert, sun + ambient fitted per photo on RING views), then
      x photo-time shading (Lambert with sun from the capture time + ambient by weather tag) x cast shadow (DEM march),
      exposure renormalised to the v0 terrain median luminance, app haze re-applied
  v2  v1 + date-matched snow: albedo mixed toward snow albedo by the S2/Landsat snow fraction at each pixel's lon/lat
  v3  v2 + per-view haze & colour-gain fit on the PHOTO: P = g*R*t + A*(1-t), t = exp(-d/L), per channel g and airlight A
      by LSQ on depth-quantile-bin medians (10 bins, terrain pixels), L from a grid (2-128 km, inf); sky pixels := A
      (A := photo top-strip sky colour when L = inf). Fitted per view on the photo resized to the view, identically for
      correct and decoy views; never on match outcomes.
  v4  (pre-registered ablation) v0 + the same haze/gain fit as v3 (isolates the photo colour fit from the physics)
  v5  (added on resume = plan item (iv)) v2 shading + nearest clear Sentinel-2 L2A colour (s2_fetch.py): S2 shading at
      the item's sun divided out, S2 albedo low frequencies (normalised Gaussian, sigma 4 px) replace the ortho albedo's
      (ratio clipped [1/3, 3], S2 scaled to the ortho albedo terrain median), ortho high frequencies kept; v2 albedo
      where S2 has no clear pixel. See PROTOCOL.txt.
"""
from __future__ import annotations
import json, math, sys
import numpy as np
import cv2
from common import C, OUT, sun_dir, TM
from geo import Frame, view_geom, scored_views
from colour import s2l, l2s, remove_app_haze, add_app_haze, lum
from dem_local import Terrain
sys.path.insert(0, str(TM / "x3_modality"))
from modalities import photo_sky_colour  # noqa: E402

VAR = OUT / "variants"
PARAMS = OUT / "params"
DATES = json.load(open(OUT / "dates.json"))
AMBIENT = {"clear": 0.25, "clouds_on_skyline": 0.35, "cloudy": 0.6}
SNOW_ALB = np.array([0.80, 0.82, 0.86], np.float32)
S_FLOOR = 0.15


def shade(n, L, a):
    return a + (1 - a) * np.maximum(n @ np.asarray(L, np.float32), 0)


def fit_baked(pid, meta, fr, terr):
    """Baked ortho sun: grid over sun az/el and ambient, maximise corr(log Y_dehazed, log shading) on ring-view terrain
    pixels at 0.5-20 km (pose-agnostic: ring views only). Lambert only (no cast shadows)."""
    Ys, Ns = [], []
    rng = np.random.default_rng(0)
    for y in range(0, 360, 30):
        v = C.load_view(pid, "ring", f"y{y:03d}")
        if v.get("empty"):
            continue
        xyz, sky, d = view_geom(v)
        m = (~sky) & (d > 500) & (d < 20000)
        idx = np.flatnonzero(m.ravel())
        if len(idx) < 200:
            continue
        idx = rng.choice(idx, min(4000, len(idx)), replace=False)
        lin = remove_app_haze(v["rgb"], d).reshape(-1, 3)[idx]
        X = xyz.reshape(-1, 3)[idx]
        lon, lat = fr.geo(X[:, 0], X[:, 1])
        Ys.append(lum(lin)); Ns.append(terr.normal(lon, lat))
    Y = np.concatenate(Ys); N = np.concatenate(Ns).astype(np.float32)
    ly = np.log(np.maximum(Y, 1e-3))
    best = {"corr": -1}
    for az in range(90, 285, 15):
        for el in (25, 35, 45, 55, 65):
            L = sun_dir(az, el)
            for a in (0.15, 0.3, 0.5):
                ls = np.log(shade(N, L, a))
                c = float(np.corrcoef(ly, ls)[0, 1])
                if c > best["corr"]:
                    best = {"corr": c, "az": az, "el": el, "ambient": a}
    best["n"] = int(len(Y))
    best["applied"] = best["corr"] >= 0.1
    return best


def photo_params(pid):
    f = PARAMS / f"{pid}.json"
    if f.exists():
        return json.load(open(f))
    meta = C.load_meta(pid)
    fr = Frame(meta["lat"], meta["lon"])
    bb = json.load(open(OUT / "snow" / f"{pid}.json"))["bbox"]
    terr = get_terrain(pid, fr, bb)
    p = {"baked": fit_baked(pid, meta, fr, terr)}
    photo = C.load_photo(pid)
    p["skyRGB"] = [float(x) for x in photo_sky_colour(photo)]
    PARAMS.mkdir(exist_ok=True)
    json.dump(p, open(f, "w"), indent=1)
    return p


_terr = {}


def get_terrain(pid, fr, bb):
    if pid not in _terr:
        _terr.clear()
        # the ring views reach further than the scored views: widen the box to 20 km around the eye for the baked fit
        r = 20e3
        bb2 = [min(bb[0], fr.lon0 - r * fr.mlon), min(bb[1], fr.lat0 - r * fr.mlat),
               max(bb[2], fr.lon0 + r * fr.mlon), max(bb[3], fr.lat0 + r * fr.mlat)]
        _terr[pid] = Terrain(fr, bb2)
    return _terr[pid]


def sample_snow(pid, lon, lat):
    z = np.load(OUT / "snow" / f"{pid}.npz")
    fr_ = z["frac"].astype(np.float32)
    lon0, lat_top, dlon, dlat = z["grid"]
    c = np.floor((lon - lon0) / dlon).astype(int)
    r = np.floor((lat_top - lat) / dlat).astype(int)
    ok = (c >= 0) & (c < fr_.shape[1]) & (r >= 0) & (r < fr_.shape[0])
    out = np.full(len(lon), np.nan, np.float32)
    out[ok] = fr_[r[ok], c[ok]]
    return out


def sample_s2(pid, lon, lat):
    """(N,3) linear-ish TCI/255 (nan unknown) and the S2 sun direction per sample (N,3)."""
    f = OUT / "s2" / f"{pid}.npz"
    if not f.exists():
        return None
    z = np.load(f)
    prov = json.load(open(OUT / "s2" / f"{pid}.json"))
    rgb, item = z["rgb"], z["item"]
    lon0, lat_top, dlon, dlat = z["grid"]
    c = np.floor((lon - lon0) / dlon).astype(int)
    r = np.floor((lat_top - lat) / dlat).astype(int)
    ok = (c >= 0) & (c < rgb.shape[1]) & (r >= 0) & (r < rgb.shape[0])
    col = np.full((len(lon), 3), np.nan, np.float32)
    it = np.full(len(lon), -1, np.int64)
    it[ok] = item[r[ok], c[ok]]
    ok &= it >= 0
    # bilinear over valid neighbours (cell centres), so 10 m cells do not show as facets in the near field
    x = (lon - lon0) / dlon - 0.5; y = (lat_top - lat) / dlat - 0.5
    x0 = np.floor(x).astype(int); y0 = np.floor(y).astype(int); fx = x - x0; fy = y - y0
    acc = np.zeros((len(lon), 3), np.float32); wsum = np.zeros(len(lon), np.float32)
    for dy, wy in ((0, 1 - fy), (1, fy)):
        for dx, wx in ((0, 1 - fx), (1, fx)):
            cc = np.clip(x0 + dx, 0, rgb.shape[1] - 1); rr = np.clip(y0 + dy, 0, rgb.shape[0] - 1)
            w = (wx * wy).astype(np.float32) * (item[rr, cc] >= 0)
            acc += w[:, None] * rgb[rr, cc].astype(np.float32); wsum += w
    col[ok] = acc[ok] / np.maximum(wsum[ok], 1e-6)[:, None] / 255.0
    suns = np.zeros((len(prov["items"]) + 1, 3), np.float32)
    for i, rec in enumerate(prov["items"]):
        if rec.get("sunAz") is not None and rec.get("sunEl") is not None:
            suns[i] = sun_dir(rec["sunAz"], rec["sunEl"])
        else:  # ephemeris at the item time (never needed so far; kept for completeness)
            from common import sun_position
            from datetime import datetime, timezone
            t = datetime.fromisoformat(rec["date"].replace("Z", "+00:00")).astimezone(timezone.utc)
            s = sun_position(t, float(lat.mean()), float(lon.mean()))
            suns[i] = s["dir"]
    return col, suns[np.where(it >= 0, it, len(prov["items"]))]


def lowpass(x, m, sigma=4.0):
    """Normalised Gaussian low-pass of x (H,W,C) over mask m (H,W)."""
    mf = m.astype(np.float32)
    den = cv2.GaussianBlur(mf, (0, 0), sigma)
    num = cv2.GaussianBlur(x * mf[..., None], (0, 0), sigma)
    return num / np.maximum(den, 1e-4)[..., None], den


def fit_haze(photo_lin, R_lin, d, sky, A):
    """Per-view photo fit: depth-quantile bins, per-bin medians; L grid, per-channel gain by LSQ."""
    m = ~sky
    if m.sum() < 1000:
        return {"L": None, "g": [1, 1, 1]}
    dq = np.quantile(d[m], np.linspace(0, 1, 11))
    P, R, Dm = [], [], []
    for i in range(10):
        b = m & (d >= dq[i]) & (d <= dq[i + 1])
        if b.sum() < 50:
            continue
        P.append(np.median(photo_lin[b], 0)); R.append(np.median(R_lin[b], 0)); Dm.append(np.median(d[b]))
    P, R, Dm = np.array(P), np.array(R), np.array(Dm)
    best = None
    for L in (2e3, 4e3, 8e3, 16e3, 32e3, 64e3, 128e3, 1e9):
        t = np.exp(-Dm / L)
        if L < 1e8:  # per channel LSQ for (g, A):  P_b = g R_b t_b + A (1 - t_b)
            M = np.stack([R * t[:, None], np.repeat((1 - t)[:, None], 3, 1)], -1)  # (bins, 3, 2)
            g = np.zeros(3); Af = np.zeros(3)
            for c in range(3):
                sol, *_ = np.linalg.lstsq(M[:, c], P[:, c], rcond=None)
                g[c], Af[c] = np.clip(sol[0], 0.3, 3.0), np.clip(sol[1], 0.0, 1.0)
        else:
            Af = np.asarray(A, float)
            g = np.clip((R * P).sum(0) / np.maximum((R * R).sum(0), 1e-9), 0.3, 3.0)
        err = float(((g * R * t[:, None] + Af * (1 - t[:, None]) - P) ** 2).sum())
        if best is None or err < best[0]:
            best = (err, L, g, Af)
    return {"L": best[1], "g": [float(x) for x in best[2]], "A": [float(x) for x in best[3]], "err": best[0]}


def apply_haze(R_lin, d, sky, A0, hz):
    A = np.asarray(hz.get("A", A0), np.float32) if hz["L"] else A0
    t = np.exp(-np.nan_to_num(d, nan=1e12) / (hz["L"] or 1e9))[..., None]
    out = np.asarray(hz["g"], np.float32) * R_lin * t + A * (1 - t)
    out[sky] = A
    return out


def build_photo(pid, force=False):
    meta = C.load_meta(pid)
    fr = Frame(meta["lat"], meta["lon"])
    p = photo_params(pid)
    dt = DATES[pid]
    bb = json.load(open(OUT / "snow" / f"{pid}.json"))["bbox"]
    terr = get_terrain(pid, fr, bb)
    Ls = dt["sun"]
    Lnew = sun_dir(Ls["az"], Ls["el"])
    amb = AMBIENT.get(dt["weather"], 0.35)
    bk = p["baked"]
    Lb = sun_dir(bk["az"], bk["el"])
    photo = C.load_photo(pid)
    A = s2l(np.array(p["skyRGB"]))
    out_dir = VAR / pid
    out_dir.mkdir(parents=True, exist_ok=True)
    stats = {}
    for g, tag, role in scored_views(meta):
        key = f"{g}__{tag}"
        if not force and all((out_dir / f"{key}__v{i}.jpg").exists() for i in range(1, 6)):
            continue
        v = C.load_view(pid, g, tag)
        H, W = v["rgb"].shape[:2]
        xyz, sky, d = view_geom(v)
        t = ~sky
        base = remove_app_haze(v["rgb"], d)
        # geometry at the stride-2 grid (exact samples), upsampled
        xs = v["xyz"]; ms = (xs != 0).any(2)
        lon, lat = fr.geo(xs[..., 0][ms], xs[..., 1][ms])
        n_s = np.zeros(xs.shape, np.float32); n_s[ms] = terr.normal(lon, lat)
        sh_s = np.ones(ms.shape, np.float32); sh_s[ms] = terr.shadow(lon, lat, Lnew, fr)
        sn_s = np.full(ms.shape, np.nan, np.float32); sn_s[ms] = sample_snow(pid, lon, lat)
        up = lambda a, interp=cv2.INTER_LINEAR: cv2.resize(a, (W, H), interpolation=interp)
        n = up(n_s); n /= np.maximum(np.linalg.norm(n, axis=2, keepdims=True), 1e-6)
        shadow = cv2.GaussianBlur(up(sh_s), (3, 3), 0)
        snow = up(np.nan_to_num(sn_s, nan=0.0), cv2.INTER_NEAREST)
        snow_known = up(np.isfinite(sn_s).astype(np.float32), cv2.INTER_NEAREST) > 0.5
        Sb = np.maximum(shade(n, Lb, bk["ambient"]), S_FLOOR) if bk["applied"] else np.ones((H, W), np.float32)
        alb = base / Sb[..., None]
        Snew = amb + (1 - amb) * np.maximum(n @ np.asarray(Lnew, np.float32), 0) * shadow
        v1 = alb * Snew[..., None]
        k = float(np.median(lum(base)[t]) / max(np.median(lum(v1)[t]), 1e-6)) if t.any() else 1.0
        v1 *= k
        # snow albedo is in the same (exposure-normalised) units as k*alb: mix after the exposure gain
        v2 = (k * alb * (1 - snow[..., None]) + SNOW_ALB * snow[..., None]) * Snew[..., None]
        v1[sky] = base[sky]; v2[sky] = base[sky]
        # v5 = (iv): S2 colour low frequencies on the v2 shading
        s2 = sample_s2(pid, lon, lat)
        s2known = np.zeros((H, W), bool)
        v5 = v2.copy()
        if s2 is not None:
            col, Ls2 = s2
            ok_s = np.isfinite(col[:, 0])
            if ok_s.sum() > 50:
                nsm = n_s[ms]
                ssh = np.maximum(0.25 + 0.75 * np.maximum((nsm * Ls2).sum(1), 0), S_FLOOR)
                a_s = np.zeros(xs.shape, np.float32)
                v_s = np.zeros(ms.shape, np.float32)
                a_s[ms] = np.nan_to_num(col / ssh[:, None]); v_s[ms] = ok_s
                s2alb = up(a_s)
                s2known = (up(v_s, cv2.INTER_NEAREST) > 0.5) & t
                if s2known.sum() > 500:
                    kalb = k * alb
                    c = float(np.median(lum(kalb)[s2known]) / max(np.median(lum(s2alb)[s2known]), 1e-6))
                    lp_s, den = lowpass(c * s2alb, s2known)
                    lp_o, _ = lowpass(kalb, s2known)
                    ratio = np.clip(lp_s / np.maximum(lp_o, 1e-4), 1 / 3, 3)
                    use = s2known & (den > 0.2)
                    alb5 = np.where(use[..., None], kalb * ratio, k * alb * (1 - snow[..., None]) + SNOW_ALB * snow[..., None])
                    v5 = alb5 * Snew[..., None]
                    v5[sky] = base[sky]
        ph = cv2.resize(photo, (W, H), interpolation=cv2.INTER_AREA)
        ph_lin = s2l(ph)
        hz3 = fit_haze(ph_lin, v2, d, sky, A)
        hz4 = fit_haze(ph_lin, base, d, sky, A)
        imgs = {1: add_app_haze(v1, d), 2: add_app_haze(v2, d),
                3: apply_haze(v2, d, sky, A, hz3), 4: apply_haze(base, d, sky, A, hz4), 5: add_app_haze(v5, d)}
        for i, im in imgs.items():
            im = im.copy()
            if i in (1, 2, 5):
                im[sky] = s2l(v["rgb"])[sky]
            cv2.imwrite(str(out_dir / f"{key}__v{i}.jpg"), cv2.cvtColor(l2s(im), cv2.COLOR_RGB2BGR),
                        [cv2.IMWRITE_JPEG_QUALITY, 95])
        stats[key] = {"role": role, "k": round(k, 3), "shadowFrac": round(float(1 - shadow[t].mean()), 3) if t.any() else None,
                      "snowFrac": round(float(snow[t].mean()), 3) if t.any() else None,
                      "snowKnown": round(float(snow_known[t].mean()), 3) if t.any() else None,
                      "s2Known": round(float(s2known[t].mean()), 3) if t.any() else None, "haze3": hz3, "haze4": hz4}
    if stats:
        sf = out_dir / "stats.json"
        old = json.load(open(sf)) if sf.exists() else {}
        old.update(stats)
        json.dump(old, open(sf, "w"), indent=1)
    return stats


if __name__ == "__main__":
    import time
    from common import eval_ids
    ids = [x for x in sys.argv[1:] if not x.startswith("--")] or eval_ids()
    for pid in ids:
        while not (OUT / "snow" / f"{pid}.json").exists():
            time.sleep(10)
        t0 = time.time()
        s = build_photo(pid, force="--force" in sys.argv)
        (VAR / pid / "DONE").touch()
        print(pid, len(s), "views", f"{time.time() - t0:.0f}s", json.load(open(PARAMS / f"{pid}.json"))["baked"], flush=True)
