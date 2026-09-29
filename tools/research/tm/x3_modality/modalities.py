"""X3: render-side modalities derived offline from the C0 cache layers, and photo-side preprocessing.

Render modalities (all at the rgb file resolution of the view; uint8 HxWx3):
  sat       satellite drape as cached (baseline)
  hill      cached hillshade (gray → 3ch)
  satxhill  sat multiplied by hillshade shading: sat * (0.35 + 0.65 * hill/255) / mean-normalised
  depth     log-inverse-depth coded gray (near bright, far dark >= 25, sky black; DPT/MiDaS style) from xyz
  normal    camera-frame surface normals coded as RGB ((n+1)/2), sky black, from xyz finite differences
  haze      "photo-styled" sat: I = sat*t + sky*(1-t), t = exp(-d/L); sky colour and L fitted per photo
            POSE-AGNOSTICALLY (photo top strip + ring views only; never the ref views)
  snow      sat brightened to shaded white above a per-photo snowline (60th pct of ring-view terrain z)
            on slopes < 40°, texture from hillshade; fixed rule, not fitted to the photo
  edges     render: occluding contours (depth discontinuities) + terrain/sky boundary, white on black, blurred;
            PHOTO SIDE is the matching Canny edge map (the pair is edge↔edge)
Photo-side variants (render = sat):
  p_clahe   CLAHE on L of Lab (clip 2.0, 8x8)
  p_dehaze  dark-channel-prior dehaze (He et al.; 15 px patch, omega 0.9, t0 0.25, box-smoothed t)
  gray      photo and render both converted to gray (3ch)

Every modality config is (render_mod, photo_mod). The same per-photo parameters are used for every view of a
photo (correct refs, wrong refs, perturb), so discrimination comparisons are fair.
"""
from __future__ import annotations

import math

import cv2
import numpy as np
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "c0_cache"))

CONFIGS = {  # name -> (render modality, photo modality)
    "sat": ("sat", "raw"),
    "hill": ("hill", "raw"),
    "satxhill": ("satxhill", "raw"),
    "depth": ("depth", "raw"),
    "normal": ("normal", "raw"),
    "haze": ("haze", "raw"),
    "snow": ("snow", "raw"),
    "edges": ("edges", "edges"),
    "p_clahe": ("sat", "clahe"),
    "p_dehaze": ("sat", "dehaze"),
    "gray": ("gray", "gray"),
}


# ------------------------------------------------------------------ geometry layers at file resolution

def _full_xyz(view: dict, W: int, H: int):
    """Upsample the stride-2 xyz grid to the rgb file size (W,H). Returns (xyz HxWx3 float32, sky mask HxW)."""
    xyz = view["xyz"].astype(np.float32)
    sky = ~(xyz != 0).any(2)
    Wn, Hn = view["W"], view["H"]
    s = W / Wn
    # file pixel (i) centre -> native u = (i+0.5)/s ; sample c covers native u = 2c+0.5 -> c = (u-0.5)/2
    u = (np.arange(W) + 0.5) / s
    v = (np.arange(H) + 0.5) / s
    mx = ((u - 0.5) / 2).astype(np.float32)
    my = ((v - 0.5) / 2).astype(np.float32)
    MX, MY = np.meshgrid(mx, my)
    # fill sky with nearest-terrain-free values to avoid bleeding: interpolate each channel, then mask by nearest sky
    out = cv2.remap(xyz, MX, MY, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    skyf = cv2.remap(sky.astype(np.uint8), MX, MY, cv2.INTER_NEAREST, borderMode=cv2.BORDER_REPLICATE).astype(bool)
    # any bilinear tap touching sky -> treat as sky/edge (use min-filter of terrain mask)
    terr = cv2.remap((~sky).astype(np.float32), MX, MY, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    skyf |= terr < 0.999
    out[skyf] = 0
    return out, skyf


def _depth(xyz, sky, eye):
    d = np.linalg.norm(xyz.astype(np.float64) - np.asarray(eye, float), axis=2)
    d[sky] = np.nan
    return d


def _cam_normals(xyz, sky, pose):
    from cache_io import pose_to_R  # c0_cache/cache_io.py (same convention as tools/matcher/common.py)
    dx = np.zeros_like(xyz)
    dy = np.zeros_like(xyz)
    dx[:, 1:-1] = xyz[:, 2:] - xyz[:, :-2]
    dy[1:-1] = xyz[2:] - xyz[:-2]
    n = np.cross(dx, dy)
    nn = np.linalg.norm(n, axis=2, keepdims=True)
    n = n / np.maximum(nn, 1e-9)
    # orient upward (world z up) so normals face the camera side consistently
    n[n[..., 2] < 0] *= -1
    R = pose_to_R(pose)
    nc = n @ R.T  # camera frame (x right, y down, z fwd)
    bad = sky | (nn[..., 0] < 1e-9)
    bad |= cv2.dilate(sky.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)
    return nc, n, bad


# ------------------------------------------------------------------ per-photo parameters (pose-agnostic)

def photo_sky_colour(photo: np.ndarray) -> np.ndarray:
    top = photo[: max(4, photo.shape[0] // 8)].reshape(-1, 3).astype(np.float32)
    lum = top.mean(1)
    sel = top[lum >= np.percentile(lum, 50)]
    return np.median(sel, 0)


def _lab_stats(img: np.ndarray):
    lab = cv2.cvtColor(img, cv2.COLOR_RGB2LAB).reshape(-1, 3).astype(np.float32)
    return np.r_[lab.mean(0), lab[:, 0].std()]


HAZE_L = [3e3, 6e3, 12e3, 25e3, 50e3, 1e9]


def fit_params(photo: np.ndarray, ring_views: list[dict]) -> dict:
    """Per-photo haze (sky colour, L) and snowline, from the photo and the pose-agnostic ring views only."""
    sky = photo_sky_colour(photo)
    small = cv2.resize(photo, (256, round(256 * photo.shape[0] / photo.shape[1])), interpolation=cv2.INTER_AREA)
    target = _lab_stats(small)
    rings = []
    zs = []
    for v in ring_views[:: max(1, len(ring_views) // 8)]:
        if v.get("empty"):
            continue
        rgb = cv2.resize(v["rgb"], (256, round(256 * v["rgb"].shape[0] / v["rgb"].shape[1])), interpolation=cv2.INTER_AREA)
        xyz, skym = _full_xyz(v, rgb.shape[1], rgb.shape[0])
        d = _depth(xyz, skym, v["eye"])
        rings.append((rgb, d, skym))
        zs.append(xyz[..., 2][~skym])
    best = None
    for L in HAZE_L:
        st = np.mean([_lab_stats(_haze(rgb, d, skym, sky, L)) for rgb, d, skym in rings], 0)
        w = np.array([1.0, 0.5, 0.5, 1.0])
        cost = float(np.sum(w * (st - target) ** 2))
        if best is None or cost < best[0]:
            best = (cost, L)
    z = np.concatenate(zs) if zs else np.zeros(1)
    return {"skyRGB": [float(x) for x in sky], "hazeL": best[1], "hazeCost": best[0],
            "snowZ": float(np.percentile(z, 60)), "photoLabStats": [float(x) for x in target]}


def _haze(rgb, d, skym, sky, L):
    t = np.exp(-np.nan_to_num(d, nan=1e9) / L)[..., None]
    out = rgb.astype(np.float32) * t + np.asarray(sky, np.float32) * (1 - t)
    out[skym] = sky
    return np.clip(out, 0, 255).astype(np.uint8)


# ------------------------------------------------------------------ render modalities

def render_modality(mod: str, view: dict, params: dict) -> np.ndarray:
    rgb = view["rgb"]
    H, W = rgb.shape[:2]
    if mod == "sat":
        return rgb
    if mod == "gray":
        g = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
        return np.repeat(g[..., None], 3, 2)
    hill = view["hill"]
    if hill.ndim == 3:
        hill = hill[..., 0]
    if mod == "hill":
        return np.repeat(hill[..., None], 3, 2)
    if mod == "satxhill":
        sh = 0.35 + 0.65 * hill.astype(np.float32) / 255.0
        out = rgb.astype(np.float32) * sh[..., None]
        out *= rgb.mean() / max(out.mean(), 1e-3)
        return np.clip(out, 0, 255).astype(np.uint8)
    xyz, sky = _full_xyz(view, W, H)
    if mod == "depth":
        d = _depth(xyz, sky, view["eye"])
        ld = np.log(np.maximum(np.nan_to_num(d, nan=1.0), 1.0))
        v = ld[~sky]
        lo, hi = (np.percentile(v, 1), np.percentile(v, 99.5)) if v.size else (0, 1)
        g = np.clip((hi - ld) / max(hi - lo, 1e-9), 0, 1)  # near bright, far dark (log inverse depth)
        g = (25 + 230 * g).astype(np.uint8)
        g[sky] = 0
        return np.repeat(g[..., None], 3, 2)
    if mod == "normal":
        nc, _, bad = _cam_normals(xyz, sky, view["pose"])
        # camera frame: x right, y down, z forward; code as (x, -y, -z) like standard normal maps
        col = np.stack([nc[..., 0], -nc[..., 1], -nc[..., 2]], -1)
        out = ((col + 1) / 2 * 255).clip(0, 255).astype(np.uint8)
        out = cv2.GaussianBlur(out, (3, 3), 0)
        out[bad] = 0
        return out
    if mod == "haze":
        d = _depth(xyz, sky, view["eye"])
        return _haze(rgb, d, sky, params["skyRGB"], params["hazeL"])
    if mod == "snow":
        _, n, bad = _cam_normals(xyz, sky, view["pose"])
        slope = np.degrees(np.arccos(np.clip(np.abs(n[..., 2]), 0, 1)))
        z = xyz[..., 2]
        m = (~bad) & (z > params["snowZ"]) & (slope < 40)
        # soft edges
        mf = cv2.GaussianBlur(m.astype(np.float32), (7, 7), 0)[..., None]
        sh = (0.45 + 0.55 * hill.astype(np.float32) / 255.0)[..., None]
        white = np.array([240, 244, 250], np.float32) * sh
        out = rgb.astype(np.float32) * (1 - mf) + white * mf
        return np.clip(out, 0, 255).astype(np.uint8)
    if mod == "edges":
        return render_edges(xyz, sky, view["eye"])
    raise ValueError(mod)


def render_edges(xyz, sky, eye) -> np.ndarray:
    d = _depth(xyz, sky, eye)
    ld = np.log(np.nan_to_num(d, nan=1e7))
    # occluding contours: relative depth jump across 3 px
    k = np.ones((3, 3), np.uint8)
    mx = cv2.dilate(ld.astype(np.float32), k)
    mn = cv2.erode(ld.astype(np.float32), k)
    e = (mx - mn) > math.log(1.15)
    e = e & ~cv2.erode(sky.astype(np.uint8), k).astype(bool)  # not in the sky interior
    # thin: keep the near side of the jump
    e &= (ld - mn) < (mx - ld)
    img = (e * 255).astype(np.uint8)
    img = cv2.dilate(img, k)
    img = cv2.GaussianBlur(img, (5, 5), 0)
    return np.repeat(img[..., None], 3, 2)


# ------------------------------------------------------------------ photo-side

def photo_modality(mod: str, photo: np.ndarray) -> np.ndarray:
    """photo: uint8 RGB already resized to the render file size."""
    if mod == "raw":
        return photo
    if mod == "gray":
        g = cv2.cvtColor(photo, cv2.COLOR_RGB2GRAY)
        return np.repeat(g[..., None], 3, 2)
    if mod == "clahe":
        lab = cv2.cvtColor(photo, cv2.COLOR_RGB2LAB)
        lab[..., 0] = cv2.createCLAHE(2.0, (8, 8)).apply(lab[..., 0])
        return cv2.cvtColor(lab, cv2.COLOR_LAB2RGB)
    if mod == "dehaze":
        return dehaze(photo)
    if mod == "edges":
        g = cv2.cvtColor(photo, cv2.COLOR_RGB2GRAY)
        g = cv2.bilateralFilter(g, 9, 40, 7)
        med = float(np.median(g))
        e = cv2.Canny(g, int(max(10, 0.66 * med)), int(min(255, 1.33 * med + 40)))
        k = np.ones((3, 3), np.uint8)
        img = cv2.GaussianBlur(cv2.dilate(e, k), (5, 5), 0)
        return np.repeat(img[..., None], 3, 2)
    raise ValueError(mod)


def dehaze(img: np.ndarray, patch=15, omega=0.9, t0=0.25) -> np.ndarray:
    I = img.astype(np.float32) / 255.0
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (patch, patch))
    dark = cv2.erode(I.min(2), k)
    n = max(1, int(dark.size * 0.001))
    idx = np.argsort(dark.ravel())[-n:]
    A = I.reshape(-1, 3)[idx].max(0)
    t = 1 - omega * cv2.erode((I / np.maximum(A, 1e-3)).min(2), k)
    t = cv2.blur(t, (patch * 2 + 1, patch * 2 + 1))
    t = np.maximum(t, t0)[..., None]
    J = (I - A) / t + A
    return (np.clip(J, 0, 1) * 255).astype(np.uint8)
