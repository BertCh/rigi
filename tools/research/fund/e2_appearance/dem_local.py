"""Mapterhorn DEM mosaics for normals and cast shadows. Reads tiles from the shared tools/matcher/.cache/mapterhorn
READ-ONLY when present; tiles not there are downloaded into e2_appearance/.cache/mapterhorn (never into tools/matcher)."""
from __future__ import annotations
import io, math, time, urllib.request
import numpy as np
from PIL import Image
from common import ROOT, HERE

SHARED = ROOT / "tools/matcher/.cache/mapterhorn"
OWN = HERE / ".cache/mapterhorn"
URL = "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp"
UA = "summit-lens-research/0.1 (mt-image fund/e2; urllib)"
D = math.pi / 180


def tile(z, x, y):
    for base in (SHARED, OWN):
        p = base / str(z) / str(x) / f"{y}.webp"
        if p.exists():
            break
    else:
        p = OWN / str(z) / str(x) / f"{y}.webp"
        p.parent.mkdir(parents=True, exist_ok=True)
        for a in range(3):
            try:
                req = urllib.request.Request(URL.format(z=z, x=x, y=y), headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=30) as r:
                    p.write_bytes(r.read())
                break
            except urllib.error.HTTPError as e:
                if e.code in (403, 404):
                    return None
                time.sleep(1 + a)
            except Exception:  # noqa: BLE001
                time.sleep(1 + a)
        else:
            return None
    a = np.asarray(Image.open(io.BytesIO(p.read_bytes())).convert("RGB"), np.float32)
    return a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768


def lonlat_to_px(lon, lat, z):
    n = 512 * 2 ** z
    x = (np.asarray(lon) + 180) / 360 * n
    s = np.sin(np.asarray(lat) * D)
    y = (0.5 - np.log((1 + s) / (1 - s)) / (4 * math.pi)) * n
    return x, y


class Mosaic:
    """Heights + east/north gradients (m/m) on a web-mercator z grid covering a lon/lat box."""

    def __init__(self, z, lon0, lat0, lon1, lat1):
        self.z = z
        x0, y1 = lonlat_to_px(lon0, lat0, z)
        x1, y0 = lonlat_to_px(lon1, lat1, z)
        tx0, tx1, ty0, ty1 = int(x0 // 512), int(x1 // 512), int(y0 // 512), int(y1 // 512)
        self.ox, self.oy = tx0 * 512, ty0 * 512
        a = np.zeros(((ty1 - ty0 + 1) * 512, (tx1 - tx0 + 1) * 512), np.float32)
        for ty in range(ty0, ty1 + 1):
            for tx in range(tx0, tx1 + 1):
                t = tile(z, tx, ty)
                if t is not None:
                    a[(ty - ty0) * 512:(ty - ty0 + 1) * 512, (tx - tx0) * 512:(tx - tx0 + 1) * 512] = t
        self.a = a
        lat_c = (lat0 + lat1) / 2
        self.mpp = 2 * math.pi * 6378137 * math.cos(lat_c * D) / (512 * 2 ** z)  # metres per pixel (at box centre)
        gy, gx = np.gradient(a, self.mpp)
        self.gx = gx.astype(np.float32)          # dz/d(east)
        self.gy = (-gy).astype(np.float32)       # dz/d(north)  (grid rows go south)
        self.box = (lon0, lat0, lon1, lat1)

    def inside(self, lon, lat):
        b = self.box
        return (lon >= b[0]) & (lon <= b[2]) & (lat >= b[1]) & (lat <= b[3])

    def _bil(self, arr, lon, lat):
        x, y = lonlat_to_px(lon, lat, self.z)
        x = np.clip(x - self.ox - 0.5, 0, arr.shape[1] - 1.001)
        y = np.clip(y - self.oy - 0.5, 0, arr.shape[0] - 1.001)
        xi, yi = np.floor(x).astype(np.int64), np.floor(y).astype(np.int64)
        fx, fy = x - xi, y - yi
        return ((arr[yi, xi] * (1 - fx) + arr[yi, xi + 1] * fx) * (1 - fy)
                + (arr[yi + 1, xi] * (1 - fx) + arr[yi + 1, xi + 1] * fx) * fy)

    def h(self, lon, lat):
        return self._bil(self.a, lon, lat)

    def normal(self, lon, lat):
        gx, gy = self._bil(self.gx, lon, lat), self._bil(self.gy, lon, lat)
        n = np.stack([-gx, -gy, np.ones_like(gx)], -1)
        return n / np.linalg.norm(n, axis=-1, keepdims=True)


class Terrain:
    """Fine (z12, ~13 m) mosaic within `fine_km` of the eye, coarse (z10, ~53 m) over the whole box."""

    def __init__(self, frame, bbox, fine_km=20.0, margin_km=15.0):
        lon0, lat0, lon1, lat1 = bbox
        mlon, mlat = frame.mlon * margin_km * 1e3, frame.mlat * margin_km * 1e3
        self.coarse = Mosaic(10, lon0 - mlon, lat0 - mlat, lon1 + mlon, lat1 + mlat)
        fl, fa = frame.mlon * fine_km * 1e3, frame.mlat * fine_km * 1e3
        fb = (max(lon0 - mlon, frame.lon0 - fl), max(lat0 - mlat, frame.lat0 - fa),
              min(lon1 + mlon, frame.lon0 + fl), min(lat1 + mlat, frame.lat0 + fa))
        self.fine = Mosaic(12, *fb)

    def _pick(self, fn, lon, lat):
        inf = self.fine.inside(lon, lat)
        out = getattr(self.coarse, fn)(lon, lat)
        if inf.any():
            out[inf] = getattr(self.fine, fn)(lon[inf], lat[inf])
        return out

    def h(self, lon, lat):
        return self._pick("h", lon, lat)

    def normal(self, lon, lat):
        return self._pick("normal", lon, lat)

    def shadow(self, lon, lat, sun_dir, frame, dmax=20000.0):
        """1 = lit, 0 = cast shadow (heightfield march toward the sun from each point)."""
        sx, sy, sz = sun_dir
        hor = math.hypot(sx, sy)
        if sz <= 0.01:
            return np.zeros(len(lon), np.float32)
        tan_el = sz / hor
        ux, uy = sx / hor, sy / hor
        h0 = self.h(lon, lat)
        lit = np.ones(len(lon), bool)
        s = 15.0
        while s < dmax:
            act = np.nonzero(lit)[0]
            if not len(act):
                break
            lo = lon[act] + ux * s * frame.mlon
            la = lat[act] + uy * s * frame.mlat
            hh = self.h(lo, la)
            bias = 4.0 + 0.004 * s
            lit[act[hh > h0[act] + s * tan_el + bias]] = False
            s *= 1.07
            if h0.size and s * tan_el > 4000:  # nothing in the Alps rises > 4 km above a point
                break
        return lit.astype(np.float32)
