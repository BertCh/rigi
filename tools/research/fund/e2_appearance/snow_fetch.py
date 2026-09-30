"""Step 2(iii) data: date-matched snow for each scored photo, clipped to the bbox of its scored views' terrain.

Access (no login): Copernicus HR-S&I GFSC was the first choice, but on 2026-09-29 the cryo.land WMS returns 403, the CDSE
STAC collection clms_wsi_gap-filled-fractional-snow-cover_europe_utm_60m_daily_v1 has no items, and CDSE OData lists the
products but download (zipper / eodata S3) needs a CDSE account -> GFSC not used (no anonymous path).
Fallback 1 (protocol): Sentinel-2 L2A SCL from Earth Search (element84, anonymous COGs), nearest-date composite within
+-10 days: SCL 11 = snow; valid = {2,4,5,6,7,11}; clouds/shadows/saturated/nodata invalid.
Fallback 2 (protocol): Landsat C2 L2 QA_PIXEL from Microsoft Planetary
Computer (anonymous SAS token) within +-16 days: bit5 snow; invalid if bit0 fill, bit1 dilated cloud, bit3 cloud,
bit4 cloud shadow.
Composite: S2 (dates >= 2016-11) and Landsat candidates merged, nearest date first; each pixel takes the nearest-date
scene where it is clear; scenes clear on < 40% of the bbox are skipped (cloud-as-snow QC).
Output: snow/<pid>.npz  frac (float16, nan = unknown), valid, grid (lon0, lat0, dlon, dlat), plus snow/<pid>.json
provenance (items, dates, day offsets, coverage).  Grid ~60 m (dlat 0.00054).
"""
from __future__ import annotations
import json, sys, time, urllib.request
from datetime import datetime, timedelta
import numpy as np
from common import C, OUT, eval_ids
from geo import Frame, scored_views
import rasterio
from rasterio.warp import reproject, Resampling, transform_bounds
from rasterio.windows import from_bounds
from rasterio.transform import from_origin

SNOW = OUT / "snow"
SNOW.mkdir(exist_ok=True)
DLAT = 0.00054
dates = json.load(open(OUT / "dates.json"))


def post(url, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    for a in range(4):
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.load(r)
        except Exception as e:  # noqa: BLE001
            print("  retry", e, file=sys.stderr)
            time.sleep(3 + 5 * a)
    raise RuntimeError(url)


def bbox_for(pid):
    meta = C.load_meta(pid)
    fr = Frame(meta["lat"], meta["lon"])
    lo = [1e9, 1e9]; hi = [-1e9, -1e9]
    for g, t, _ in scored_views(meta):
        v = C.load_view(pid, g, t)
        xyz = v["xyz"]
        m = (xyz != 0).any(2)
        lon, lat = fr.geo(xyz[..., 0][m], xyz[..., 1][m])
        lo = [min(lo[0], lon.min()), min(lo[1], lat.min())]
        hi = [max(hi[0], lon.max()), max(hi[1], lat.max())]
    pad = 0.005
    return [float(lo[0] - pad), float(lo[1] - pad), float(hi[0] + pad), float(hi[1] + pad)]


def grid_for(bb, lat_mid):
    dlon = DLAT / np.cos(np.radians(lat_mid))
    W = int(np.ceil((bb[2] - bb[0]) / dlon)); H = int(np.ceil((bb[3] - bb[1]) / DLAT))
    return from_origin(bb[0], bb[3], dlon, DLAT), W, H, dlon


def warp_item(href, bb, dst_tf, W, H, classify):
    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif,.TIF"):
        with rasterio.open(href) as src:
            b = transform_bounds("EPSG:4326", src.crs, *bb, densify_pts=21)
            win = from_bounds(*b, transform=src.transform).round_offsets().round_lengths()
            win = win.intersection(rasterio.windows.Window(0, 0, src.width, src.height))
            a = src.read(1, window=win)
            tf = src.window_transform(win)
            snow, valid = classify(a)
            out = []
            for arr in (snow.astype(np.float32), valid.astype(np.float32)):
                dst = np.zeros((H, W), np.float32)
                reproject(arr, dst, src_transform=tf, src_crs=src.crs, dst_transform=dst_tf, dst_crs="EPSG:4326",
                          resampling=Resampling.average, src_nodata=None, dst_nodata=0)
                out.append(dst)
    return out[0], out[1]


def scl_classify(a):
    valid = np.isin(a, [2, 4, 5, 6, 7, 11])
    return (a == 11) & valid, valid


def qa_classify(a):
    a = a.astype(np.int64)
    bad = (a & 1) | ((a >> 1) & 1) | ((a >> 3) & 1) | ((a >> 4) & 1)
    valid = bad == 0
    return (((a >> 5) & 1) == 1) & valid, valid


def s2_items(bb, t, days=10):
    body = {"collections": ["sentinel-2-l2a"], "bbox": bb, "limit": 200,
            "datetime": f"{(t - timedelta(days=days)).date()}T00:00:00Z/{(t + timedelta(days=days)).date()}T23:59:59Z",
            "query": {"eo:cloud_cover": {"lt": 90}}}
    fs = post("https://earth-search.aws.element84.com/v1/search", body).get("features", [])
    best = {}
    for f in fs:  # dedupe processing baselines: keep the highest _N_ per (tile, date)
        p = f["id"].split("_")
        key = (p[1], p[2])
        if key not in best or f["id"] > best[key]["id"]:
            best[key] = f
    out = []
    for f in best.values():
        dt = datetime.fromisoformat(f["properties"]["datetime"].replace("Z", "+00:00")).replace(tzinfo=None)
        out.append({"id": f["id"], "href": f["assets"]["scl"]["href"], "date": dt.isoformat(),
                    "dd": abs((dt - t).total_seconds()) / 86400, "cloud": f["properties"].get("eo:cloud_cover")})
    return sorted(out, key=lambda x: (round(x["dd"]), x["cloud"] or 0))


_TOK: dict = {}


def pc_token(coll):
    """Anonymous PC SAS token, cached per process (resume fix: one token per photo hit HTTP 429)."""
    if coll not in _TOK:
        for a in range(6):
            try:
                _TOK[coll] = json.load(urllib.request.urlopen(
                    f"https://planetarycomputer.microsoft.com/api/sas/v1/token/{coll}", timeout=60))["token"]
                break
            except Exception as e:  # noqa: BLE001
                print("  token retry", e, file=sys.stderr)
                time.sleep(20 * (a + 1))
        else:
            raise RuntimeError("PC token")
    return _TOK[coll]


def ls_items(bb, t, days=16):
    tok = pc_token("landsat-c2-l2")
    body = {"collections": ["landsat-c2-l2"], "bbox": bb, "limit": 200,
            "datetime": f"{(t - timedelta(days=days)).date()}T00:00:00Z/{(t + timedelta(days=days)).date()}T23:59:59Z",
            "query": {"eo:cloud_cover": {"lt": 90}}}
    fs = post("https://planetarycomputer.microsoft.com/api/stac/v1/search", body).get("features", [])
    out = []
    for f in fs:
        dt = datetime.fromisoformat(f["properties"]["datetime"].replace("Z", "+00:00")).replace(tzinfo=None)
        out.append({"id": f["id"], "href": f["assets"]["qa_pixel"]["href"] + "?" + tok, "date": dt.isoformat(),
                    "dd": abs((dt - t).total_seconds()) / 86400, "cloud": f["properties"].get("eo:cloud_cover"),
                    "platform": f["properties"].get("platform")})
    return sorted(out, key=lambda x: (round(x["dd"]), x["cloud"] or 0))


MIN_LOCAL_VALID = 0.4  # QC (fixed before scoring): a scene clear on < 40% of the bbox is skipped (thick cloud is
#                         labelled snow by SCL/QA often enough to paint whole valleys white in August; seen on wc_0006)


def composite(items, bb, tf, W, H, max_items=16):
    """Nearest-date-first composite over S2 and Landsat candidates together."""
    frac = np.full((H, W), np.nan, np.float32)
    ddays = np.full((H, W), np.nan, np.float32)
    used = []
    for it in items[:max_items]:
        try:
            s, v = warp_item(it["href"], bb, tf, W, H, scl_classify if it["classify"] == "scl" else qa_classify)
        except Exception as e:  # noqa: BLE001
            print("   fail", it["id"], e, file=sys.stderr)
            continue
        lv = float((v > 0.5).mean())
        rec = {k: it[k] for k in it if k not in ("href", "classify")} | {"localValid": round(lv, 3)}
        if lv < MIN_LOCAL_VALID:
            used.append(rec | {"skipped": True, "newPx": 0})
            continue
        ok = (v > 0.5) & np.isnan(frac)
        frac[ok] = s[ok] / v[ok]
        ddays[ok] = it["dd"]
        used.append(rec | {"newPx": int(ok.sum())})
        cov = float(np.isfinite(frac).mean())
        print(f"   {it['id']} dd={it['dd']:.1f} lv={lv:.2f} +{ok.sum()} cov={cov:.3f}", flush=True)
        if cov > 0.98:
            break
    return frac, ddays, used


def main(ids):
    for pid in ids:
        f = SNOW / f"{pid}.npz"
        if f.exists():
            continue
        r = dates[pid]
        t = datetime.fromisoformat(r["dateTaken"])
        bb = bbox_for(pid)
        tf, W, H, dlon = grid_for(bb, (bb[1] + bb[3]) / 2)
        print(pid, r["dateTaken"], "bbox", [round(x, 3) for x in bb], W, H, flush=True)
        prov = {"pid": pid, "date": r["dateTaken"], "bbox": bb, "W": W, "H": H, "source": None}
        its = []
        if t >= datetime(2016, 11, 1):
            its += [dict(i, src="S2", classify="scl") for i in s2_items(bb, t)]
        its += [dict(i, src="Landsat", classify="qa") for i in ls_items(bb, t)]
        its.sort(key=lambda x: x["dd"])
        print("  candidates", len(its), "S2", sum(i["src"] == "S2" for i in its))
        frac, dd, items = composite(its, bb, tf, W, H)
        prov.update(items=items, coverage=float(np.isfinite(frac).mean()),
                    source="+".join(sorted({i["src"] for i in items if i.get("newPx", 0) > 0})) or "none")
        prov["snowFracMeanKnown"] = float(np.nanmean(frac)) if np.isfinite(frac).any() else None
        prov["medianDaysOffset"] = float(np.nanmedian(dd)) if np.isfinite(dd).any() else None
        np.savez_compressed(f, frac=frac.astype(np.float16), ddays=dd.astype(np.float16),
                            grid=np.array([bb[0], bb[3], dlon, DLAT]))
        json.dump(prov, open(SNOW / f"{pid}.json", "w"), indent=1)
        print(f"  -> {prov['source']} cov={prov['coverage']:.3f} snowMean={prov['snowFracMeanKnown']}", flush=True)


if __name__ == "__main__":
    main(sys.argv[1:] or eval_ids())
