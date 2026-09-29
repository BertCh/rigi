"""Camera geometry for the render → re-match loop (WP-G): CameraX in numpy, tile views, photo→view warps,
and frame conversions between the engine's ENU frame and a caller's frame.

Conventions mirror src/lib/concord/core/camera-x.ts and tools/matcher/common.py:
  - pose {yaw, pitch, roll, vfov} (deg), R = pose_to_R(pose): world ENU → OpenCV camera (x right, y down, z fwd)
  - photo uv normalised (0..1, v down); intrinsics {fScale, k1, cx, cy}: ideal tangent coords (xn, yn) →
    distorted (xn, yn)·(1 + k1 r²) → X = fScale·xd/t (half-height units), u = 0.5 + X/(2·aspect) + cx.
  - A "view" is a pinhole render (identity intrinsics) of W×H px at its own pose; the photo is warped into
    it by an exact per-pixel ray map (view pixel → ray → photo uv through the CameraX), so rotation,
    focal scale and k1 are all honoured, and keypoints map back through the same function.
"""
from __future__ import annotations

import math
import sys
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

MATCHER_DIR = Path(__file__).resolve().parents[2] / "matcher"
if str(MATCHER_DIR) not in sys.path:
    sys.path.insert(0, str(MATCHER_DIR))
from common import R_to_pose, focal_px, pose_to_R  # noqa: E402  (tools/matcher/common.py, read-only)

D = math.pi / 180
WGS_A = 6378137.0
WGS_E2 = 6.69437999014e-3
EARTH_R = 6371008.8  # src/lib/geodesy.ts EARTH_R
REFRACTION_K = 0.13  # src/lib/geodesy.ts REFRACTION_K (checked at import by the server)


# ---------------------------------------------------------------- CameraX


@dataclass
class Cam:
    pose: dict
    eye: np.ndarray  # (3,) in the working (engine) frame
    aspect: float
    intr: dict = field(default_factory=lambda: {"fScale": 1.0, "k1": 0.0, "cx": 0.0, "cy": 0.0})

    @property
    def R(self) -> np.ndarray:
        return pose_to_R(self.pose)

    @property
    def t(self) -> float:
        return math.tan(self.pose["vfov"] * D / 2)

    def identity(self) -> bool:
        i = self.intr
        return i["fScale"] == 1 and i["k1"] == 0 and i["cx"] == 0 and i["cy"] == 0

    def with_pose(self, pose: dict) -> "Cam":
        return Cam({**pose, "vfov": self.pose["vfov"]}, self.eye.copy(), self.aspect, dict(self.intr))

    @staticmethod
    def from_json(j: dict, eye_override: np.ndarray | None = None) -> "Cam":
        intr = {"fScale": 1.0, "k1": 0.0, "cx": 0.0, "cy": 0.0, **(j.get("intr") or {})}
        eye = np.asarray(j.get("eye", [0, 0, 0]), float) if eye_override is None else eye_override
        p = j["pose"]
        return Cam({k: float(p[k]) for k in ("yaw", "pitch", "roll", "vfov")}, eye, float(j["aspect"]), intr)


def project(cam: Cam, X: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """World (N,3) → photo uv (N,2) under the CameraX, and a front mask."""
    c = (X - cam.eye) @ cam.R.T
    z = c[:, 2]
    front = z > 1e-6
    zz = np.where(front, z, 1.0)
    xn, yn = c[:, 0] / zz, -c[:, 1] / zz  # tangent coords, y up
    i = cam.intr
    s = 1 + i["k1"] * (xn * xn + yn * yn)
    X_ = i["fScale"] * xn * s / cam.t
    Y_ = i["fScale"] * yn * s / cam.t
    u = 0.5 + X_ / (2 * cam.aspect) + i["cx"]
    v = 0.5 - Y_ / 2 + i["cy"]
    return np.stack([u, v], 1), front


def unproject(cam: Cam, uv: np.ndarray) -> np.ndarray:
    """Photo uv (N,2) → unit world directions (N,3) (inverse of `project`, 5 Newton steps on the radius)."""
    i = cam.intr
    t = cam.t
    xd = (uv[:, 0] - i["cx"] - 0.5) * 2 * cam.aspect * t / i["fScale"]
    yd = (0.5 - (uv[:, 1] - i["cy"])) * 2 * t / i["fScale"]
    if i["k1"] != 0:
        rd = np.hypot(xd, yd)
        r = rd.copy()
        for _ in range(5):
            r -= (r * (1 + i["k1"] * r * r) - rd) / (1 + 3 * i["k1"] * r * r)
        sc = np.where(rd > 0, r / np.maximum(rd, 1e-300), 1.0)
        xd, yd = xd * sc, yd * sc
    dc = np.stack([xd, -yd, np.ones_like(xd)], 1)  # OpenCV camera
    d = dc @ cam.R  # R^T · dc
    return d / np.linalg.norm(d, axis=1, keepdims=True)


def ideal_px(cam: Cam, uv: np.ndarray, W: int, H: int) -> np.ndarray:
    """Photo uv → pixel coords of an identity-intrinsics pinhole W×H at cam.pose (for rotation solves)."""
    d = unproject(cam, uv) @ cam.R.T
    f = focal_px(cam.pose["vfov"], H)
    return np.stack([W / 2 + f * d[:, 0] / d[:, 2], H / 2 + f * d[:, 1] / d[:, 2]], 1)


def px1600(cam: Cam) -> tuple[float, float]:
    """(W, H) of the long-side-1600 basis."""
    return (1600.0, 1600.0 / cam.aspect) if cam.aspect >= 1 else (1600.0 * cam.aspect, 1600.0)


# ---------------------------------------------------------------- views


@dataclass
class ViewSpec:
    tag: str
    pose: dict  # render pose (pinhole, identity intrinsics)
    region: tuple[float, float, float, float] | None = None  # photo uv box the view targets (u0, v0, u1, v1)


def look_pose(cam: Cam, uv_centre: tuple[float, float], vfov: float) -> dict:
    """Pinhole pose looking through photo uv_centre, keeping the camera's right axis (no roll wobble)."""
    f = unproject(cam, np.array([uv_centre]))[0]
    right0 = cam.R[0]
    up = np.cross(right0, f)
    up /= np.linalg.norm(up)
    right = np.cross(f, up)
    R = np.stack([right, -up, f])
    return R_to_pose(R, vfov)


def tile_views(cam: Cam, n: int, overlap: float = 1.3) -> list[ViewSpec]:
    """n = 4 (2×2) or 6 (3×2) tiles over the photo; each rendered as a narrower pinhole view (same render
    aspect), so a tile gets the render's full resolution (the AdHoP-style zoomed re-render)."""
    nx, ny = (2, 2) if n == 4 else (3, 2)
    out = []
    t = cam.t / cam.intr["fScale"]
    # tile angular half-height ≈ t/ny in tangent units; widen for wide tiles (render aspect = photo aspect)
    tile_aspect = (cam.aspect / nx) / (1 / ny)
    half = t / ny * max(1.0, tile_aspect / cam.aspect) * overlap
    vfov = 2 * math.atan(half) / D
    for j in range(ny):
        for i in range(nx):
            uc, vc = (i + 0.5) / nx, (j + 0.5) / ny
            out.append(
                ViewSpec(f"t{j}{i}", look_pose(cam, (uc, vc), vfov), (i / nx, j / ny, (i + 1) / nx, (j + 1) / ny))
            )
    return out


def view_rays(pose: dict, W: int, H: int) -> np.ndarray:
    """Unit world directions of every view pixel centre, (H, W, 3)."""
    f = focal_px(pose["vfov"], H)
    xs = (np.arange(W) + 0.5 - W / 2) / f
    ys = (np.arange(H) + 0.5 - H / 2) / f
    gx, gy = np.meshgrid(xs, ys)
    dc = np.stack([gx, gy, np.ones_like(gx)], -1)
    d = dc @ pose_to_R(pose)
    return d / np.linalg.norm(d, axis=-1, keepdims=True)


def view_px_to_photo_uv(cam: Cam, pose: dict, W: int, H: int, px: np.ndarray) -> np.ndarray:
    """View pixel coords (N,2) (pixel-centre = integer + 0.5 convention) → photo uv via the ray map."""
    f = focal_px(pose["vfov"], H)
    dc = np.stack([(px[:, 0] - W / 2) / f, (px[:, 1] - H / 2) / f, np.ones(len(px))], 1)
    d = dc @ pose_to_R(pose)
    uv, _ = project(cam, cam.eye + d * 1e4)
    return uv


def warp_photo(photo: np.ndarray, cam: Cam, pose: dict, W: int, H: int) -> tuple[np.ndarray, np.ndarray]:
    """Resample the photo into the view (W×H at pose). Returns (image uint8, valid mask)."""
    ph, pw = photo.shape[:2]
    # pre-shrink so a view pixel ≈ a photo pixel (avoids aliasing in bilinear remap)
    fv = focal_px(pose["vfov"], H)
    fp = focal_px(cam.pose["vfov"], ph) * cam.intr["fScale"]
    s = min(1.0, fv / fp * 1.0)
    img = photo
    if s < 0.95:
        img = cv2.resize(photo, (max(8, round(pw * s)), max(8, round(ph * s))), interpolation=cv2.INTER_AREA)
    ih, iw = img.shape[:2]
    rays = view_rays(pose, W, H).reshape(-1, 3)
    uv, front = project(cam, cam.eye + rays * 1e4)
    mx = (uv[:, 0] * iw - 0.5).reshape(H, W).astype(np.float32)
    my = (uv[:, 1] * ih - 0.5).reshape(H, W).astype(np.float32)
    valid = (front.reshape(H, W)) & (mx >= 0) & (my >= 0) & (mx <= iw - 1) & (my <= ih - 1)
    out = cv2.remap(img, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    out[~valid] = 0
    return out, valid


# ---------------------------------------------------------------- frames


def _ecef(lat, lon, h):
    la, lo = np.radians(lat), np.radians(lon)
    n = WGS_A / np.sqrt(1 - WGS_E2 * np.sin(la) ** 2)
    return np.stack(
        [(n + h) * np.cos(la) * np.cos(lo), (n + h) * np.cos(la) * np.sin(lo), (n * (1 - WGS_E2) + h) * np.sin(la)], -1
    )


class EnuFrame:
    """Mirror of src/lib/geodesy.ts EnuFrame: ECEF ENU with the +k·d²/(2R) refraction lift on up."""

    def __init__(self, lat: float, lon: float, h: float):
        self.lat, self.lon, self.h = lat, lon, h
        self.o = _ecef(lat, lon, h)
        p, lm = lat * D, lon * D
        sp, cp, sl, cl = math.sin(p), math.cos(p), math.sin(lm), math.cos(lm)
        self.r = np.array([[-sl, cl, 0], [-sp * cl, -sp * sl, cp], [cp * cl, cp * sl, sp]])

    def to_ecef(self, enu: np.ndarray) -> np.ndarray:
        e = np.array(enu, float, ndmin=2)
        d2 = e[:, 0] ** 2 + e[:, 1] ** 2
        g = e.copy()
        g[:, 2] -= REFRACTION_K * d2 / (2 * EARTH_R)
        return self.o + g @ self.r

    def from_ecef(self, xyz: np.ndarray) -> np.ndarray:
        g = (np.array(xyz, float, ndmin=2) - self.o) @ self.r.T
        g[:, 2] += REFRACTION_K * (g[:, 0] ** 2 + g[:, 1] ** 2) / (2 * EARTH_R)
        return g

    def to_latlon(self, enu: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        x = self.to_ecef(enu)
        lon = np.degrees(np.arctan2(x[:, 1], x[:, 0]))
        p = np.hypot(x[:, 0], x[:, 1])
        lat = np.arctan2(x[:, 2], p * (1 - WGS_E2))
        for _ in range(3):
            n = WGS_A / np.sqrt(1 - WGS_E2 * np.sin(lat) ** 2)
            h = p / np.cos(lat) - n
            lat = np.arctan2(x[:, 2], p * (1 - WGS_E2 * n / (n + h)))
        return np.degrees(lat), lon


def frame_converter(src: EnuFrame, dst: EnuFrame):
    """ENU(src) → ENU(dst). Same origin lat/lon ⇒ a pure up-shift (exact); else via ECEF."""
    if src.lat == dst.lat and src.lon == dst.lon:
        dz = src.h - dst.h
        return lambda p: np.array(p, float, ndmin=2) + np.array([0.0, 0.0, dz])
    return lambda p: dst.from_ecef(src.to_ecef(p))


# ---------------------------------------------------------------- coverage / change


def coverage(uv: np.ndarray, depth: np.ndarray, min_pts: int = 5) -> dict:
    """Quadrants (2×2 photo quarters) and distance bands (plan WP-A bands) holding ≥ min_pts inliers."""
    if len(uv) == 0:
        return {"quadrants": 0, "bands": 0}
    q = (uv[:, 0] >= 0.5).astype(int) + 2 * (uv[:, 1] >= 0.5).astype(int)
    edges = [500.0, 2000.0, 5000.0, 15000.0]
    b = np.digitize(depth, edges)
    return {
        "quadrants": int((np.bincount(q, minlength=4) >= min_pts).sum()),
        "bands": int((np.bincount(b, minlength=5) >= min_pts).sum()),
    }


def median_change_px(a: Cam, b: Cam, n: int = 15) -> float:
    """Median displacement (px @1600) of a 15×15 grid of photo points between cameras a and b (rays at 5 km)."""
    g = (np.arange(n) + 0.5) / n
    uv = np.stack(np.meshgrid(g, g), -1).reshape(-1, 2)
    X = a.eye + unproject(a, uv) * 5000.0
    uvb, _ = project(b, X)
    W, H = px1600(a)
    return float(np.median(np.hypot((uvb[:, 0] - uv[:, 0]) * W, (uvb[:, 1] - uv[:, 1]) * H)))
