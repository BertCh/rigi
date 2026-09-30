"""swisstopo near-field data for E3: STAC -> COG window reads (swissALTI3D DTM, swissSURFACE3D DSM) resampled onto
ENU-aligned grids in the cache frame, plus SWISSIMAGE WMTS mosaics. Mirrors src/lib/concord/occl/swiss-cog.ts
(same STAC root/collections, newest year per km tile), in Python with tifffile + HTTP range reads.

    g = build_grids(pid, frame, eye_xy, h_ref, wedge=(yaw, half), kinds=("dtm", "dsm"))
    g["inner"] / g["outer"]: dict(res, e0, n0, w, h, dtm, dsm)   heights = ENU z (curvature/refraction applied), NaN = no data
    o = Ortho(frame, eye_xy, wedge, cache_dir); o.sample(xyz_enu, footprint_m) -> rgb float (N,3)

Data: swisstopo OGD, (c) swisstopo.
"""
from __future__ import annotations

import io
import json
import math
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image

import nf_geo as G

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
STAC_ROOT = "https://data.geo.admin.ch/api/stac/v0.9"
DSM_COLLECTION = "ch.swisstopo.swisssurface3d-raster"
DTM_COLLECTION = "ch.swisstopo.swissalti3d"
WMTS = "https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg"
UA = {"User-Agent": "rigi-research-e3/0.1"}

INNER_R, INNER_RES = 500.0, 0.5
OUTER_R, OUTER_RES = 2300.0, 2.0  # 2 km from displaced eyes up to 150 m + margin

STATS = {"bytes": 0, "requests": 0}
_lock = threading.Lock()


def _get(url: str, rng: tuple[int, int] | None = None, tries: int = 4) -> bytes:
    h = dict(UA)
    if rng:
        h["Range"] = f"bytes={rng[0]}-{rng[1]}"
    for k in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=60) as r:
                d = r.read()
                if rng and r.status == 200:
                    d = d[rng[0]:rng[1] + 1]
            with _lock:
                STATS["bytes"] += len(d)
                STATS["requests"] += 1
            return d
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise
            if k == tries - 1:
                raise
        except Exception:
            if k == tries - 1:
                raise
        time.sleep(1.5 * (k + 1))
    raise RuntimeError(url)


# ---------------- STAC ----------------

def stac_tiles(collection: str, bbox, gsd: float) -> dict[tuple[int, int], dict]:
    """(kx, ky) -> {year, gsd, href}: newest year per km tile, asset gsd closest to `gsd`."""
    url = f"{STAC_ROOT}/collections/{collection}/items?bbox={','.join(f'{v:.6f}' for v in bbox)}&limit=100"
    best: dict = {}
    for _ in range(40):
        j = json.loads(_get(url))
        for it in j.get("features", []):
            import re
            m = re.search(r"_(\d{4})_(\d{4})-(\d{4})$", it["id"])
            if not m:
                continue
            year, kx, ky = int(m[1]), int(m[2]), int(m[3])
            pick = None
            for a in it["assets"].values():
                if not a["href"].lower().endswith(".tif"):
                    continue
                g = a.get("eo:gsd")
                if g is None:
                    mm = re.search(r"_([\d.]+)_2056_", a["href"])
                    g = float(mm[1]) if mm else None
                if g is None:
                    continue
                if pick is None or abs(g - gsd) < abs(pick["gsd"] - gsd):
                    pick = {"year": year, "gsd": g, "href": a["href"]}
            if pick and ((kx, ky) not in best or best[(kx, ky)]["year"] < year):
                best[(kx, ky)] = pick
        nxt = [l["href"] for l in j.get("links", []) if l.get("rel") == "next"]
        if not nxt:
            break
        url = nxt[0]
    return best


# ---------------- COG ----------------

class RangeFile(io.RawIOBase):
    """Read-only HTTP file (Range requests) with a small block cache, for tifffile's header parsing."""

    def __init__(self, url: str, block: int = 65536):
        self.url, self.pos, self.block = url, 0, block
        self.blocks: dict[int, bytes] = {}
        head = _get(url, (0, block - 1))
        self.blocks[0] = head
        req = urllib.request.Request(url, method="HEAD", headers=UA)
        with urllib.request.urlopen(req, timeout=60) as r:
            self.size = int(r.headers["Content-Length"])

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, o, wh=0):
        self.pos = o if wh == 0 else self.pos + o if wh == 1 else self.size + o
        return self.pos

    def read(self, n=-1):
        if n is None or n < 0:
            n = self.size - self.pos
        n = min(n, self.size - self.pos)
        if n <= 0:
            return b""
        out = bytearray()
        p = self.pos
        while len(out) < n:
            b = p // self.block
            if b not in self.blocks:
                a = b * self.block
                self.blocks[b] = _get(self.url, (a, min(self.size, a + self.block) - 1))
            chunk = self.blocks[b]
            o = p - b * self.block
            take = chunk[o:o + n - len(out)]
            if not take:
                break
            out += take
            p += len(take)
        self.pos = p
        return bytes(out)

    def readinto(self, buf):
        d = self.read(len(buf))
        buf[:len(d)] = d
        return len(d)


def cog_window(href: str, level: int, x0: int, y0: int, w: int, h: int) -> np.ndarray:
    """Pixel window of COG overview `level` (0 = full res) -> float32 (h, w), NaN = nodata/outside."""
    import tifffile
    rf = RangeFile(href)
    tf = tifffile.TiffFile(io.BufferedReader(rf, buffer_size=65536))
    page = tf.series[0].levels[level]
    page = page.pages[0] if hasattr(page, "pages") else page
    H, W = page.shape[:2]
    tw, th = page.tilewidth or W, page.tilelength or H
    out = np.full((h, w), np.nan, np.float32)
    across = math.ceil(W / tw)
    tx0, ty0 = max(0, x0 // tw), max(0, y0 // th)
    tx1, ty1 = min(across - 1, (x0 + w - 1) // tw), min(math.ceil(H / th) - 1, (y0 + h - 1) // th)
    jobs = []
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            k = ty * across + tx
            jobs.append((tx, ty, page.dataoffsets[k], page.databytecounts[k], k))

    def fetch(j):
        tx, ty, off, cnt, k = j
        if cnt == 0:
            return j, None
        return j, _get(href, (off, off + cnt - 1))

    with ThreadPoolExecutor(6) as ex:
        for (tx, ty, off, cnt, k), data in ex.map(fetch, jobs):
            if data is None:
                continue
            arr, _, _ = page.decode(data, k)
            a = np.asarray(arr).reshape(-1, th, tw)[0] if np.asarray(arr).ndim > 2 else np.asarray(arr)
            a = a.reshape(th, tw) if a.size == th * tw else a.squeeze()
            gx0, gy0 = tx * tw - x0, ty * th - y0
            sx0, sy0 = max(0, -gx0), max(0, -gy0)
            dx0, dy0 = max(0, gx0), max(0, gy0)
            ww = min(tw - sx0, w - dx0)
            hh = min(th - sy0, h - dy0)
            if ww > 0 and hh > 0:
                out[dy0:dy0 + hh, dx0:dx0 + ww] = a[sy0:sy0 + hh, sx0:sx0 + ww]
    tf.close()
    out[(out <= -9998) | ~np.isfinite(out)] = np.nan
    return out


def lv95_mosaic(collection: str, gsd: float, level: int, res: float, Emin, Emax, Nmin, Nmax, tiles) -> dict:
    """Assemble an LV95 raster [Emin,Emax]x[Nmin,Nmax] at `res` from the km tiles (read level `level` whose
    resolution must equal res). Returns dict(E0 (left edge), N0 (top edge), res, z (h, w))."""
    E0 = math.floor(Emin / res) * res
    N0 = math.ceil(Nmax / res) * res
    w = int(math.ceil((Emax - E0) / res))
    h = int(math.ceil((N0 - Nmin) / res))
    z = np.full((h, w), np.nan, np.float32)
    per_km = int(round(1000 / res))
    for kx in range(int(Emin // 1000), int(Emax // 1000) + 1):
        for ky in range(int(Nmin // 1000), int(Nmax // 1000) + 1):
            t = tiles.get((kx, ky))
            if not t:
                continue
            # window of this km tile inside the mosaic
            tl_E, tl_N = kx * 1000, (ky + 1) * 1000
            ax0 = max(E0, tl_E)
            ax1 = min(E0 + w * res, tl_E + 1000)
            ay0 = min(N0, tl_N)
            ay1 = max(N0 - h * res, tl_N - 1000)
            if ax1 <= ax0 or ay0 <= ay1:
                continue
            px0 = int(round((ax0 - tl_E) / res))
            py0 = int(round((tl_N - ay0) / res))
            pw = int(round((ax1 - ax0) / res))
            ph = int(round((ay0 - ay1) / res))
            pw, ph = min(pw, per_km - px0), min(ph, per_km - py0)
            try:
                win = cog_window(t["href"], level, px0, py0, pw, ph)
            except Exception as e:  # noqa: BLE001
                print(f"  cog fail {t['href']}: {e}")
                continue
            mx0 = int(round((ax0 - E0) / res))
            my0 = int(round((N0 - ay0) / res))
            z[my0:my0 + ph, mx0:mx0 + pw] = win
    return {"E0": E0, "N0": N0, "res": res, "z": z}


def sample_lv95(mos: dict, E, N) -> np.ndarray:
    """Bilinear sample of an LV95 mosaic at (E, N) (cell centres at E0 + (i+.5) res)."""
    z = mos["z"]
    fx = (np.asarray(E) - mos["E0"]) / mos["res"] - 0.5
    fy = (mos["N0"] - np.asarray(N)) / mos["res"] - 0.5
    x0 = np.floor(fx).astype(int)
    y0 = np.floor(fy).astype(int)
    ax, ay = fx - x0, fy - y0
    h, w = z.shape
    out = np.zeros(np.shape(E), np.float64)
    wsum = np.zeros(np.shape(E), np.float64)
    for dy, wy in ((0, 1 - ay), (1, ay)):
        for dx, wx in ((0, 1 - ax), (1, ax)):
            xi, yi = x0 + dx, y0 + dy
            ok = (xi >= 0) & (xi < w) & (yi >= 0) & (yi < h)
            v = np.where(ok, z[np.clip(yi, 0, h - 1), np.clip(xi, 0, w - 1)], np.nan)
            good = np.isfinite(v)
            ww = wx * wy * good
            out += np.where(good, v, 0) * ww
            wsum += ww
    out = np.where(wsum > 0.5, out / np.maximum(wsum, 1e-9), np.nan)
    return out


def _wedge_mask(ee, nn, r, wedge):
    d = np.hypot(ee, nn)
    m = d <= r
    if wedge is not None:
        yaw, half = wedge
        az = np.degrees(np.arctan2(ee, nn))
        dd = (az - yaw + 540) % 360 - 180
        m &= (np.abs(dd) <= half) | (d < 60)
    return m


def build_grids(frame: G.EnuFrame, cx: float, cy: float, h_ref: float, wedge, kinds=("dtm", "dsm"),
                cache: Path | None = None, emulate_res: float | None = None) -> dict:
    """ENU-aligned height grids around (cx, cy) (ENU metres): inner 0.5 m r<=500 m, outer 2 m r<=2100 m.
    Values = ENU z of the surface (h -> from_geo, i.e. with the frame's curvature+refraction). NaN = no data.
    Cached to `cache` (npz, float32). wedge = (yawDeg, halfDeg) around (cx, cy)."""
    if cache is not None and cache.exists():
        z = np.load(cache)
        out = {}
        for lvl in ("inner", "outer"):
            out[lvl] = {k: (z[f"{lvl}_{k}"] if z[f"{lvl}_{k}"].ndim else float(z[f"{lvl}_{k}"]))
                        for k in ("res", "e0", "n0", *kinds)}
            out[lvl]["h"], out[lvl]["w"] = out[lvl][kinds[0]].shape
        out["meta"] = json.loads(str(z["meta"]))
        return out
    t0 = time.time()
    b0 = STATS["bytes"]
    out = {"meta": {"kinds": list(kinds)}}
    # LV95 bbox of the outer disc
    lat_c, lon_c, _ = frame.to_geo(cx, cy, h_ref)
    Ec, Nc = G.wgs_to_lv95(lat_c, lon_c)
    Ec, Nc = float(Ec), float(Nc)
    for lvl, R, res in (("inner", INNER_R, INNER_RES), ("outer", OUTER_R, OUTER_RES)):
        R2 = R + 10
        la0, lo0 = G.lv95_to_wgs(Ec - R2, Nc - R2)
        la1, lo1 = G.lv95_to_wgs(Ec + R2, Nc + R2)
        bbox = (float(lo0) - 0.001, float(la0) - 0.001, float(lo1) + 0.001, float(la1) + 0.001)
        # ENU grid (cell centres), row 0 = north
        n = int(math.ceil(R / res))
        ii = np.arange(-n, n + 1)
        e0, n0 = cx + ii[0] * res, cy + ii[-1] * res
        ee, nn_ = np.meshgrid(cx + ii * res, cy - ii * res)
        mask = _wedge_mask(ee - cx, nn_ - cy, R, None if lvl == "inner" else wedge)
        # km tiles actually needed (only those containing masked cells)
        Em, Nm = frame.enu_to_lv95(ee[mask], nn_[mask], h_ref)
        need = set(zip((Em // 1000).astype(int).tolist(), (Nm // 1000).astype(int).tolist()))
        rec = {"res": res, "e0": e0, "n0": n0}
        for kind in kinds:
            coll = DTM_COLLECTION if kind == "dtm" else DSM_COLLECTION
            if lvl == "inner":
                gsd, level = 0.5, 0
            else:
                gsd, level = (2.0, 0) if kind == "dtm" else (0.5, 2)
            tiles = {k: v for k, v in stac_tiles(coll, bbox, gsd).items() if k in need}
            out["meta"].setdefault("years", {}).setdefault(f"{lvl}_{kind}", sorted({v["year"] for v in tiles.values()}))
            out["meta"].setdefault("ntiles", {})[f"{lvl}_{kind}"] = f"{len(tiles)}/{len(need)}"
            if kind == "dsm" and lvl == "outer":
                gsd_eff = 2.0
            else:
                gsd_eff = res
            mos = lv95_mosaic(coll, gsd, level, gsd_eff, Em.min() - 4, Em.max() + 4, Nm.min() - 4, Nm.max() + 4, tiles)
            hgt = np.full(ee.shape, np.nan, np.float32)
            hv = sample_lv95(mos, Em, Nm)
            # h -> ENU z (curvature + refraction), exact via from_geo at the sampled point
            la, lo = G.lv95_to_wgs(Em, Nm)
            zz = frame.from_geo(la, lo, np.nan_to_num(hv))[..., 2]
            hgt[mask] = np.where(np.isfinite(hv), zz, np.nan)
            rec[kind] = hgt
            del mos
        rec["h"], rec["w"] = ee.shape
        out[lvl] = rec
    out["meta"]["fetchS"] = round(time.time() - t0, 1)
    out["meta"]["bytes"] = STATS["bytes"] - b0
    if cache is not None:
        cache.parent.mkdir(parents=True, exist_ok=True)
        arrs = {"meta": json.dumps(out["meta"])}
        for lvl in ("inner", "outer"):
            for k in ("res", "e0", "n0", *kinds):
                arrs[f"{lvl}_{k}"] = np.asarray(out[lvl][k])
        np.savez_compressed(cache, **arrs)
    return out


# ---------------- ortho ----------------

ZOOM_R = {19: 350.0, 18: 800.0, 17: 1500.0, 16: 2350.0}


class Ortho:
    """SWISSIMAGE WMTS mosaics (3857) at z16..z19 around an eye, clipped to the view wedge and ZOOM_R radii.
    sample(lat, lon, footprint_m) picks per point the coarsest zoom whose texel <= footprint (fallback coarser)."""

    def __init__(self, frame: G.EnuFrame, cx: float, cy: float, h_ref: float, wedge, tile_dir: Path,
                 zooms=(16, 17, 18, 19)):
        self.frame = frame
        self.lat0 = frame.lat
        self.mos = {}
        tile_dir.mkdir(parents=True, exist_ok=True)
        for z in zooms:
            R = ZOOM_R[z]
            res = G.merc_res(frame.lat, z)
            # candidate tiles: grid over the disc
            step = res * 128
            k = int(math.ceil(R / step))
            ii = np.arange(-k, k + 1) * step
            ee, nn = np.meshgrid(cx + ii, cy + ii)
            m = _wedge_mask(ee - cx, nn - cy, R + step * 1.5, (wedge[0], wedge[1] + 10) if (wedge and z < 18) else None)
            la, lo, _ = frame.to_geo(ee[m], nn[m], np.full(m.sum(), h_ref))
            tx, ty = G.lonlat_to_tilexy(lo, la, z)
            keys = sorted(set(zip(tx.astype(int).tolist(), ty.astype(int).tolist())))
            if not keys:
                continue
            x0, x1 = min(k[0] for k in keys), max(k[0] for k in keys)
            y0, y1 = min(k[1] for k in keys), max(k[1] for k in keys)
            img = np.zeros(((y1 - y0 + 1) * 256, (x1 - x0 + 1) * 256, 3), np.uint8)
            have = np.zeros((y1 - y0 + 1, x1 - x0 + 1), bool)

            def fetch(key):
                x, y = key
                f = tile_dir / f"{z}_{x}_{y}.jpg"
                if not f.exists():
                    try:
                        d = _get(WMTS.format(z=z, x=x, y=y))
                    except Exception:
                        return key, None
                    f.write_bytes(d)
                try:
                    return key, np.array(Image.open(f).convert("RGB"))
                except Exception:
                    return key, None

            with ThreadPoolExecutor(8) as ex:
                for (x, y), a in ex.map(fetch, keys):
                    if a is None:
                        continue
                    img[(y - y0) * 256:(y - y0 + 1) * 256, (x - x0) * 256:(x - x0 + 1) * 256] = a
                    have[y - y0, x - x0] = True
            self.mos[z] = {"img": img, "x0": x0, "y0": y0, "have": have, "res": res}

    def sample(self, lat, lon, footprint) -> np.ndarray:
        """Bilinear rgb (float 0..255) at points; zoom per point from footprint (m/px)."""
        lat, lon, footprint = (np.asarray(a, float).ravel() for a in (lat, lon, footprint))
        out = np.full((lat.size, 3), np.nan)
        zs = sorted(self.mos)
        # desired zoom: finest zoom whose res >= footprint (texel ~ pixel footprint = mip level)
        want = np.full(lat.size, zs[0])
        for z in zs:
            want = np.where(self.mos[z]["res"] >= footprint * 0.999, z, want)
        todo = np.ones(lat.size, bool)
        for z in sorted(zs, reverse=True):
            sel = todo & (want >= z)
            if not sel.any():
                continue
            m = self.mos[z]
            tx, ty = G.lonlat_to_tilexy(lon[sel], lat[sel], z)
            px = (tx - m["x0"]) * 256 - 0.5
            py = (ty - m["y0"]) * 256 - 0.5
            H, W = m["img"].shape[:2]
            ti = np.clip((px + 0.5) // 256, 0, m["have"].shape[1] - 1).astype(int)
            tj = np.clip((py + 0.5) // 256, 0, m["have"].shape[0] - 1).astype(int)
            ok = (px >= 0) & (px < W - 1) & (py >= 0) & (py < H - 1) & m["have"][tj, ti]
            x0 = np.floor(px).astype(int)
            y0 = np.floor(py).astype(int)
            ax = (px - x0)[:, None]
            ay = (py - y0)[:, None]
            x0c, y0c = np.clip(x0, 0, W - 2), np.clip(y0, 0, H - 2)
            im = m["img"]
            v = (im[y0c, x0c] * (1 - ax) * (1 - ay) + im[y0c, x0c + 1] * ax * (1 - ay)
                 + im[y0c + 1, x0c] * (1 - ax) * ay + im[y0c + 1, x0c + 1] * ax * ay)
            idx = np.nonzero(sel)[0][ok]
            out[idx] = v[ok]
            todo[idx] = False
        return out
