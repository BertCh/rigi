""".splat-v1 codec and the depth-lift Gaussian builder (pure numpy; no torch).

.splat-v1 (little-endian), shared with the TS reader:
  bytes 0..7 ASCII "RIGISPL1"; u32 count N; u32 flags (bit0 = frame is ENU else camera; bit1 = has source array);
  f64 originLat, f64 originLon, f64 originH (0 if camera frame);
  then f32 positions[3N], f32 scales[3N] (linear metres), f32 rotations[4N] (w,x,y,z), u8 colors[4N] (RGBA),
  u8 provenance[N], zero pad to a 4-byte boundary, then u16 source[N] if bit1.
"""
from __future__ import annotations

import base64
import struct

import numpy as np

MAGIC = b"RIGISPL1"
HEADER = struct.Struct("<8sII3d")  # 40 bytes
FLAG_ENU = 1
FLAG_SOURCE = 2
PROV_OBSERVED, PROV_RECONSTRUCTED, PROV_DEM, PROV_GENERATED = 0, 1, 2, 3


def encode_splat_v1(positions, scales, rotations, colors, provenance, source=None, enu_origin=None) -> bytes:
    n = int(len(positions))
    pos = np.ascontiguousarray(positions, "<f4").reshape(n, 3)
    scl = np.ascontiguousarray(scales, "<f4").reshape(n, 3)
    rot = np.ascontiguousarray(rotations, "<f4").reshape(n, 4)
    col = np.ascontiguousarray(colors, np.uint8).reshape(n, 4)
    prv = np.ascontiguousarray(np.broadcast_to(np.asarray(provenance, np.uint8), (n,)))
    flags = (FLAG_ENU if enu_origin is not None else 0) | (FLAG_SOURCE if source is not None else 0)
    lat, lon, h = enu_origin if enu_origin is not None else (0.0, 0.0, 0.0)
    parts = [HEADER.pack(MAGIC, n, flags, lat, lon, h), pos.tobytes(), scl.tobytes(), rot.tobytes(), col.tobytes(), prv.tobytes()]
    size = sum(len(p) for p in parts)
    if size % 4:
        parts.append(b"\0" * (4 - size % 4))
    if source is not None:
        parts.append(np.ascontiguousarray(source, "<u2").reshape(n).tobytes())
    return b"".join(parts)


def decode_splat_v1(buf: bytes) -> dict:
    magic, n, flags, lat, lon, h = HEADER.unpack_from(buf, 0)
    if magic != MAGIC:
        raise ValueError(f"bad magic {magic!r}")
    o = HEADER.size

    def take(dtype, count):
        nonlocal o
        a = np.frombuffer(buf, dtype, count, o)
        o += a.nbytes
        return a

    out = {"count": n, "frame": "enu" if flags & FLAG_ENU else "camera", "origin": (lat, lon, h),
           "positions": take("<f4", 3 * n), "scales": take("<f4", 3 * n), "rotations": take("<f4", 4 * n),
           "colors": take(np.uint8, 4 * n), "provenance": take(np.uint8, n)}
    o = (o + 3) // 4 * 4
    if flags & FLAG_SOURCE:
        out["source"] = take("<u2", n)
    if o != len(buf):
        raise ValueError(f"trailing bytes: parsed {o}, have {len(buf)}")
    return out


def f16_b64(a: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(a, "<f2").tobytes()).decode("ascii")


def u8_b64(a: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(a, np.uint8).tobytes()).decode("ascii")


def _quat_from_mats(R: np.ndarray) -> np.ndarray:
    """Rotation matrices (N,3,3) -> unit quaternions (N,4) w,x,y,z."""
    from scipy.spatial.transform import Rotation

    q = Rotation.from_matrix(R).as_quat()  # x,y,z,w
    return q[:, [3, 0, 1, 2]].astype(np.float32)


def lift_gaussians(rgb: np.ndarray, depth: np.ndarray, valid: np.ndarray, K_norm: dict, normal: np.ndarray | None = None,
                   stride: int = 2, edge_ratio: float = 1.5, sigma_frac: float = 0.6, flat_frac: float = 0.15,
                   max_stretch: float = 4.0) -> dict:
    """One Gaussian per stride cell from a depth map (camera frame, OpenCV). Returns SoA arrays + stats.

    rgb (H,W,3) uint8 and depth/valid/normal all on the same HxW grid. Scale = sigma_frac * pixel footprint
    (stride * z / f_px); when normals exist the splat is a disc in the tangent plane, stretched along the
    view-projected direction by 1/|cos| (capped) and flattened along the normal. Pixels whose 3x3 depth
    max/min ratio exceeds edge_ratio (flying pixels at depth edges) are dropped (edge_ratio <= 0 disables).
    """
    import cv2

    H, W = depth.shape
    s = max(1, int(stride))
    gh, gw = H // s, W // s
    c0 = s // 2
    ys = np.arange(gh) * s + c0
    xs = np.arange(gw) * s + c0
    z = depth[np.ix_(ys, xs)].astype(np.float32)
    ok = valid[np.ix_(ys, xs)].astype(bool) & np.isfinite(z) & (z > 0)
    if edge_ratio and edge_ratio > 0:
        zz = np.where(ok, z, np.nan)
        pad = np.pad(zz, 1, mode="edge")
        win = np.stack([pad[dy:dy + gh, dx:dx + gw] for dy in range(3) for dx in range(3)])
        with np.errstate(invalid="ignore", divide="ignore"):
            ratio = np.nanmax(win, 0) / np.nanmin(win, 0)
        ok &= ~(ratio > edge_ratio)
    col = cv2.resize(np.ascontiguousarray(rgb[: gh * s, : gw * s]), (gw, gh), interpolation=cv2.INTER_AREA) if s > 1 else rgb[:gh, :gw]
    fx, fy = K_norm["fx"] * W, K_norm["fy"] * H
    cx, cy = K_norm["cx"] * W, K_norm["cy"] * H
    u = (xs + 0.5)[None, :].repeat(gh, 0)
    v = (ys + 0.5)[:, None].repeat(gw, 1)
    zi = z[ok]
    x = (u[ok] - cx) / fx * zi
    y = (v[ok] - cy) / fy * zi
    pos = np.stack([x, y, zi], 1).astype(np.float32)
    n = len(pos)
    foot = (s * zi / (0.5 * (fx + fy))).astype(np.float32)
    sig = sigma_frac * foot
    if normal is not None and n:
        nrm = normal[np.ix_(ys, xs)][ok].astype(np.float32)
        nl = np.linalg.norm(nrm, axis=1, keepdims=True)
        good = (nl[:, 0] > 0.5) & np.isfinite(nl[:, 0])
        nrm = np.where(good[:, None], nrm / np.maximum(nl, 1e-6), 0)
        vd = pos / np.linalg.norm(pos, axis=1, keepdims=True)
        # face the camera
        flip = (nrm * vd).sum(1) > 0
        nrm[flip] *= -1
        cos = np.abs((nrm * vd).sum(1))
        # t1 = view direction projected into the tangent plane (the stretch axis), t2 = n x t1
        t1 = vd - (vd * nrm).sum(1, keepdims=True) * nrm
        t1l = np.linalg.norm(t1, axis=1, keepdims=True)
        # fallback when looking straight down the normal: any perpendicular
        alt = np.cross(nrm, np.array([1.0, 0, 0], np.float32))
        alt_bad = np.linalg.norm(alt, axis=1) < 1e-3
        alt[alt_bad] = np.cross(nrm[alt_bad], np.array([0, 1.0, 0], np.float32))
        t1 = np.where(t1l > 1e-4, t1 / np.maximum(t1l, 1e-6), alt / np.maximum(np.linalg.norm(alt, axis=1, keepdims=True), 1e-6))
        t2 = np.cross(nrm, t1)
        R = np.stack([t1, t2, nrm], 2)  # columns = local axes in camera frame
        stretch = np.minimum(1.0 / np.maximum(cos, 1e-3), max_stretch)
        scl = np.stack([sig * stretch, sig, sig * flat_frac], 1)
        rot = np.empty((n, 4), np.float32)
        rot[good] = _quat_from_mats(R[good].astype(np.float64)) if good.any() else rot[good]
        rot[~good] = (1, 0, 0, 0)
        scl[~good] = sig[~good, None]
    else:
        scl = np.repeat(sig[:, None], 3, 1)
        rot = np.tile(np.array([1, 0, 0, 0], np.float32), (n, 1))
    rgba = np.concatenate([col[ok].reshape(-1, 3), np.full((n, 1), 255, np.uint8)], 1).astype(np.uint8)
    return {"positions": pos, "scales": scl.astype(np.float32), "rotations": rot, "colors": rgba,
            "provenance": np.full(n, PROV_RECONSTRUCTED, np.uint8), "grid": (gw, gh), "kept": n, "cells": gw * gh}
