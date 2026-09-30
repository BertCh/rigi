"""Step 2(iv) data (written on resume): nearest clear Sentinel-2 L2A true colour per applicable photo (see PROTOCOL.txt).

Source: Earth Search (element84) sentinel-2-l2a 'visual' (TCI, 10 m) + 'scl'; that archive has nothing before 2018 over
the Alps, so Planetary Computer sentinel-2-l2a ('visual', 'SCL', anonymous SAS token) is the fallback when Earth Search
returns no candidate (PROTOCOL amendment A1). Candidates +-20 d, eo:cloud_cover < 90, nearest date first; SCL clear =
{2,4,5,6,7,11}; a scene clear on < 40% of the box is skipped; per pixel the nearest-date clear scene wins.
Grid: the snow box (snow/<pid>.json bbox), resolution max(10 m, box extent / 4000).
Output: s2/<pid>.npz  rgb (uint8 TCI, 0 where unknown), valid (bool), item (int8 index into provenance, -1 unknown),
grid (lon0, lat_top, dlon, dlat); s2/<pid>.json provenance incl. each item's sun az/el.
"""
from __future__ import annotations
import json, sys, urllib.request
from datetime import datetime, timedelta
import numpy as np
from common import OUT, eval_ids
from snow_fetch import post, scl_classify, MIN_LOCAL_VALID, pc_token
import rasterio
from rasterio.warp import reproject, Resampling, transform_bounds
from rasterio.windows import from_bounds
from rasterio.transform import from_origin

S2 = OUT / "s2"
S2.mkdir(exist_ok=True)
dates = json.load(open(OUT / "dates.json"))
MIN_DATE = datetime(2016, 11, 1)


def es_items(bb, t, days=20):
    body = {"collections": ["sentinel-2-l2a"], "bbox": bb, "limit": 200,
            "datetime": f"{(t - timedelta(days=days)).date()}T00:00:00Z/{(t + timedelta(days=days)).date()}T23:59:59Z",
            "query": {"eo:cloud_cover": {"lt": 90}}}
    best = {}
    for f in post("https://earth-search.aws.element84.com/v1/search", body).get("features", []):
        p = f["id"].split("_"); key = (p[1], p[2])
        if key not in best or f["id"] > best[key]["id"]:
            best[key] = f
    out = []
    for f in best.values():
        pr = f["properties"]
        out.append({"id": f["id"], "src": "ES", "tci": f["assets"]["visual"]["href"], "scl": f["assets"]["scl"]["href"],
                    "date": pr["datetime"], "sunAz": pr.get("view:sun_azimuth"), "sunEl": pr.get("view:sun_elevation"),
                    "cloud": pr.get("eo:cloud_cover")})
    return out


def pc_items(bb, t, days=20):
    tok = pc_token("sentinel-2-l2a")
    body = {"collections": ["sentinel-2-l2a"], "bbox": bb, "limit": 200,
            "datetime": f"{(t - timedelta(days=days)).date()}T00:00:00Z/{(t + timedelta(days=days)).date()}T23:59:59Z",
            "query": {"eo:cloud_cover": {"lt": 90}}}
    out = []
    for f in post("https://planetarycomputer.microsoft.com/api/stac/v1/search", body).get("features", []):
        pr = f["properties"]
        z = pr.get("s2:mean_solar_zenith")
        out.append({"id": f["id"], "src": "PC", "tci": f["assets"]["visual"]["href"] + "?" + tok,
                    "scl": f["assets"]["SCL"]["href"] + "?" + tok, "date": pr["datetime"],
                    "sunAz": pr.get("s2:mean_solar_azimuth"), "sunEl": None if z is None else 90 - z,
                    "cloud": pr.get("eo:cloud_cover")})
    return out


def read_warp(href, bb, dst_tf, W, H, bands, resampling):
    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif,.TIF"):
        with rasterio.open(href) as src:
            b = transform_bounds("EPSG:4326", src.crs, *bb, densify_pts=21)
            win = from_bounds(*b, transform=src.transform).round_offsets().round_lengths()
            win = win.intersection(rasterio.windows.Window(0, 0, src.width, src.height))
            # decimated read when the source is much finer than the target grid (uses COG overviews)
            dst_res = abs(dst_tf.a) * 111320 * np.cos(np.radians(bb[1]))
            f = max(1, int(dst_res // abs(src.transform.a)))
            shape = (len(bands), max(1, int(win.height // f)), max(1, int(win.width // f)))
            a = src.read(bands, window=win, out_shape=shape,
                         resampling=Resampling.average if resampling == Resampling.average else Resampling.nearest)
            tf = src.window_transform(win) * rasterio.Affine.scale(win.width / shape[2], win.height / shape[1])
            return a, tf, src.crs


def warp_to(arr, tf, crs, dst_tf, W, H, resampling):
    dst = np.zeros((H, W), np.float32)
    reproject(arr.astype(np.float32), dst, src_transform=tf, src_crs=crs, dst_transform=dst_tf, dst_crs="EPSG:4326",
              resampling=resampling, src_nodata=None, dst_nodata=0)
    return dst


def main(ids):
    for pid in ids:
        f = S2 / f"{pid}.npz"
        if f.exists():
            continue
        t = datetime.fromisoformat(dates[pid]["dateTaken"])
        if t < MIN_DATE:
            print(pid, "before 2016-11: (iv) not applicable", flush=True)
            continue
        bb = json.load(open(OUT / "snow" / f"{pid}.json"))["bbox"]
        lat_mid = (bb[1] + bb[3]) / 2
        ext_m = max((bb[2] - bb[0]) * 111320 * np.cos(np.radians(lat_mid)), (bb[3] - bb[1]) * 111320)
        res_m = max(10.0, ext_m / 4000)
        dlat = res_m / 111320; dlon = dlat / np.cos(np.radians(lat_mid))
        W = int(np.ceil((bb[2] - bb[0]) / dlon)); H = int(np.ceil((bb[3] - bb[1]) / dlat))
        tf = from_origin(bb[0], bb[3], dlon, dlat)
        its = es_items(bb, t)
        if not its:
            its = pc_items(bb, t)
        for it in its:
            dt = datetime.fromisoformat(it["date"].replace("Z", "+00:00")).replace(tzinfo=None)
            it["dd"] = abs((dt - t).total_seconds()) / 86400
        its.sort(key=lambda x: (round(x["dd"]), x["cloud"] or 0))
        print(pid, dates[pid]["dateTaken"], f"res {res_m:.0f} m", W, H, "candidates", len(its),
              "src", its[0]["src"] if its else None, flush=True)
        rgb = np.zeros((H, W, 3), np.uint8)
        item = np.full((H, W), -1, np.int8)
        used = []
        for it in its[:12]:
            try:
                s, stf, scrs = read_warp(it["scl"], bb, tf, W, H, [1], Resampling.nearest)
                _, valid = scl_classify(s[0])
                v = warp_to(valid, stf, scrs, tf, W, H, Resampling.average) > 0.5
                lv = float(v.mean())
                rec = {k: it[k] for k in it if k not in ("tci", "scl")} | {"localValid": round(lv, 3)}
                if lv < MIN_LOCAL_VALID:
                    used.append(rec | {"skipped": True, "newPx": 0}); continue
                a, atf, acrs = read_warp(it["tci"], bb, tf, W, H, [1, 2, 3], Resampling.average)
                c = np.stack([warp_to(a[i], atf, acrs, tf, W, H, Resampling.average) for i in range(3)], -1)
            except Exception as e:  # noqa: BLE001
                print("   fail", it["id"], e, file=sys.stderr); continue
            ok = v & (item < 0) & (c.sum(-1) > 0)
            rgb[ok] = np.clip(np.round(c[ok]), 0, 255).astype(np.uint8)
            item[ok] = len(used)
            used.append(rec | {"newPx": int(ok.sum())})
            cov = float((item >= 0).mean())
            print(f"   {it['id']} dd={it['dd']:.1f} lv={lv:.2f} +{ok.sum()} cov={cov:.3f}", flush=True)
            if cov > 0.98:
                break
        prov = {"pid": pid, "bbox": bb, "W": W, "H": H, "res_m": res_m, "items": used,
                "coverage": float((item >= 0).mean())}
        np.savez_compressed(f, rgb=rgb, item=item, grid=np.array([bb[0], bb[3], dlon, dlat]))
        json.dump(prov, open(S2 / f"{pid}.json", "w"), indent=1)
        print(f"  -> cov={prov['coverage']:.3f}", flush=True)


if __name__ == "__main__":
    main(sys.argv[1:] or eval_ids())
