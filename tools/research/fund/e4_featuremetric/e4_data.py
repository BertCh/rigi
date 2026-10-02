# Rigi
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: Copyright (c) Rigi contributors

"""E4 data: Mapterhorn Terrarium tiles -> nested ENU height grids (far field to 40 km), SWISSIMAGE WMTS colour mosaics.

    grids = build_grids(frame, eye_z)      # list of dict(res, e0, n0, w, h, z)  finest first, ENU z incl. curvature
    ortho = Ortho(frame, wedge, tile_dir); ortho.sample(lat, lon, footprint_m) -> rgb float (N,3), NaN = no tile

Heights are used as ellipsoidal h exactly as the app does with its DEM. Tiles are read from .cache/dem-mapterhorn of
the worktree (a copy of the main tree cache) and fetched from tiles.mapterhorn.com when missing (404/204 -> absent,
a coarser zoom is used). Colour: wmts.geo.admin.ch swissimage 3857, (c) swisstopo.
"""
from __future__ import annotations

import math
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image

import e4_geo as G

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
DEM_DIR = ROOT / ".cache" / "dem-mapterhorn"
MT_URL = "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp"
WMTS = "https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg"
UA = {"User-Agent": "rigi-research-e4/0.1"}
# (res m, radius m, zoom, fallback zooms)  finest grid first
LEVELS = [(8.0, 6000.0, 13), (20.0, 14000.0, 12), (40.0, 40000.0, 11)]
STATS = {"bytes": 0, "requests": 0}
_lock = threading.Lock()


def _get(url: str, tries: int = 3) -> bytes | None:
    for k in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40) as r:
                if r.status == 204:
                    return None
                d = r.read()
            with _lock:
                STATS["bytes"] += len(d)
                STATS["requests"] += 1
            return d
        except urllib.error.HTTPError as e:
            if e.code in (404, 400, 403):
                return None
            if k == tries - 1:
                return None
        except Exception:  # noqa: BLE001
            if k == tries - 1:
                return None
        time.sleep(1.0 * (k + 1))
    return None


_tile_mem: dict = {}


def dem_tile(z: int, x: int, y: int):
    """Decoded 512x512 float32 heights or None."""
    key = (z, x, y)
    if key in _tile_mem:
        return _tile_mem[key]
    f = DEM_DIR / str(z) / str(x) / f"{y}.webp"
    out = None
    if not f.exists():
        d = _get(MT_URL.format(z=z, x=x, y=y))
        if d:
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_bytes(d)
    if f.exists():
        a = np.asarray(Image.open(f).convert("RGB"), np.float32)
        out = a[..., 0] * 256.0 + a[..., 1] + a[..., 2] / 256.0 - 32768.0
        out = np.where((out < 0) & (out > -12000), 0.0, out)  # src/lib/dem/decode.ts decodeTerrarium
    if len(_tile_mem) > 400:
        _tile_mem.clear()
    _tile_mem[key] = out
    return out


def sample_dem(lat, lon, z: int, fallback: int = 3) -> np.ndarray:
    """Bilinear Mapterhorn heights at points using zoom z, missing tiles filled from z-1, z-2 ... (NaN if none)."""
    lat = np.asarray(lat, float).ravel()
    lon = np.asarray(lon, float).ravel()
    out = np.full(lat.size, np.nan)
    todo = np.ones(lat.size, bool)
    for zz in range(z, z - fallback - 1, -1):
        if not todo.any():
            break
        tx, ty = G.lonlat_to_tilexy(lon, lat, zz)
        px = tx * 512.0 - 0.5
        py = ty * 512.0 - 0.5
        ti = np.floor(px / 512).astype(int)
        tj = np.floor(py / 512).astype(int)
        keys = sorted(set(zip(ti[todo].tolist(), tj[todo].tolist())))
        # also the neighbours touched by bilinear taps: fetch lazily below
        tiles = {}
        with ThreadPoolExecutor(8) as ex:
            for k, t in zip(keys, ex.map(lambda k: dem_tile(zz, k[0], k[1]), keys)):
                tiles[k] = t
        x0 = np.floor(px).astype(int)
        y0 = np.floor(py).astype(int)
        ax, ay = px - x0, py - y0
        acc = np.zeros(lat.size)
        wsum = np.zeros(lat.size)
        for dy, wy in ((0, 1 - ay), (1, ay)):
            for dx, wx in ((0, 1 - ax), (1, ax)):
                xi, yi = x0 + dx, y0 + dy
                tkx, tky = xi // 512, yi // 512
                for k in set(zip(tkx[todo].tolist(), tky[todo].tolist())):
                    if k not in tiles:
                        tiles[k] = dem_tile(zz, k[0], k[1])
                v = np.full(lat.size, np.nan)
                for k, t in tiles.items():
                    if t is None:
                        continue
                    m = todo & (tkx == k[0]) & (tky == k[1])
                    if m.any():
                        v[m] = t[yi[m] - k[1] * 512, xi[m] - k[0] * 512]
                good = np.isfinite(v)
                ww = wx * wy * good
                acc += np.where(good, v, 0) * ww
                wsum += ww
        ok = todo & (wsum > 0.99)
        out[ok] = acc[ok] / wsum[ok]
        todo &= ~ok
    return out


def build_grids(frame: G.EnuFrame, eye_z: float, levels=LEVELS) -> list[dict]:
    """Nested ENU grids centred on the eye (cell centres e0 + i res, n0 - j res; row 0 = north). z = ENU height of the
    surface (curvature + refraction through the frame), NaN = no data."""
    out = []
    for res, R, zoom in levels:
        n = int(math.ceil(R / res))
        ii = np.arange(-n, n + 1)
        ee, nn = np.meshgrid(ii * res, -ii * res)
        lat, lon, _ = frame.to_geo(ee, nn, np.full(ee.shape, eye_z))
        h = sample_dem(lat, lon, zoom).reshape(ee.shape)
        zz = frame.from_geo(lat, lon, np.nan_to_num(h))[..., 2]
        zz = np.where(np.isfinite(h), zz, np.nan).astype(np.float32)
        out.append({"res": res, "e0": float(ii[0] * res), "n0": float(-ii[0] * res), "w": zz.shape[1], "h": zz.shape[0],
                    "z": zz, "R": n * res, "zoom": zoom})
    return out


def clamp_eye(grids: list[dict], eye_z: float) -> tuple[float, bool]:
    """Eye floor: if the stated eye is < ground + 1.0 m on the Mapterhorn grid it is raised to ground + 1.6 m
    (PROTOCOL amendment A1; E3 used the same clamp). Returns (eye_z, clamped)."""
    g = grids[0]["z"]
    ground = float(g[g.shape[0] // 2, g.shape[1] // 2])
    if np.isfinite(ground) and eye_z < ground + 1.0:
        return ground + 1.6, True
    return eye_z, False


# ---------------- SWISSIMAGE colour ----------------

ZOOM_R = {11: 40000.0, 12: 20000.0, 13: 10000.0, 14: 5000.0, 15: 2500.0, 16: 1200.0, 17: 600.0}


class Ortho:
    """WMTS mosaics z11..z17 (radius per zoom) clipped to the view wedge (yaw, half-angle). sample(lat, lon, footprint_m)
    picks the finest zoom whose texel is not finer than the footprint (coarser fallback); NaN where no tile exists."""

    def __init__(self, frame: G.EnuFrame, wedge, tile_dir: Path):
        self.frame = frame
        self.mos = {}
        tile_dir.mkdir(parents=True, exist_ok=True)
        for z, R in ZOOM_R.items():
            res = G.merc_res(frame.lat, z)
            step = res * 128
            k = int(math.ceil(R / step))
            ii = np.arange(-k, k + 1) * step
            ee, nn = np.meshgrid(ii, ii)
            d = np.hypot(ee, nn)
            az = np.degrees(np.arctan2(ee, nn))
            dd = (az - wedge[0] + 540) % 360 - 180
            m = (d <= R + step * 1.5) & ((np.abs(dd) <= wedge[1]) | (d < 3 * step))
            la, lo, _ = frame.to_geo(ee[m], nn[m], np.zeros(m.sum()))
            tx, ty = G.lonlat_to_tilexy(lo, la, z)
            keys = sorted(set(zip(tx.astype(int).tolist(), ty.astype(int).tolist())))
            if not keys:
                continue
            x0, x1 = min(a[0] for a in keys), max(a[0] for a in keys)
            y0, y1 = min(a[1] for a in keys), max(a[1] for a in keys)
            img = np.zeros(((y1 - y0 + 1) * 256, (x1 - x0 + 1) * 256, 3), np.uint8)
            have = np.zeros((y1 - y0 + 1, x1 - x0 + 1), bool)

            def fetch(key, z=z):
                x, y = key
                f = tile_dir / f"{z}_{x}_{y}.jpg"
                if not f.exists():
                    d_ = _get(WMTS.format(z=z, x=x, y=y))
                    if d_ is None:
                        f.with_suffix(".none").write_bytes(b"")
                        return key, None
                    f.write_bytes(d_)
                if not f.exists():
                    return key, None
                try:
                    return key, np.array(Image.open(f).convert("RGB"))
                except Exception:  # noqa: BLE001
                    return key, None

            todo = [kk for kk in keys if not (tile_dir / f"{z}_{kk[0]}_{kk[1]}.none").exists()]
            with ThreadPoolExecutor(8) as ex:
                for (x, y), a in ex.map(fetch, todo):
                    if a is None:
                        continue
                    img[(y - y0) * 256:(y - y0 + 1) * 256, (x - x0) * 256:(x - x0 + 1) * 256] = a
                    have[y - y0, x - x0] = True
            self.mos[z] = {"img": img, "x0": x0, "y0": y0, "have": have, "res": res}

    def sample(self, lat, lon, footprint) -> np.ndarray:
        lat, lon, footprint = (np.asarray(a, float).ravel() for a in (lat, lon, footprint))
        out = np.full((lat.size, 3), np.nan)
        zs = sorted(self.mos)
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
