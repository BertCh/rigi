# Rigi
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: Copyright (c) Rigi contributors

"""E4 far-field renderer: per-pixel heightfield ray march (torch, MPS or CPU) over nested ENU grids out to 40 km,
curvature and refraction already in the grid heights (frame lift). Adapted from FUND E3 nf_render.py.

    r = render(grids, ortho, eye, pose, f, W, H)   -> dict(rgb uint8 (H,W,3), xyz float32 (H,W,3) 0 = no hit,
        status uint8 (H,W): 0 hit, 1 sky (ray left the terrain envelope), 2 expired (no hit within tmax, below envelope),
        colour_ok bool (H,W), dirs float32 (H,W,3) unit world ray per pixel centre, sec)
Camera: pinhole, centre (W/2, H/2), focal f px, pixel centres +0.5, pose = app yaw/pitch/roll.
"""
from __future__ import annotations

import time

import numpy as np
import torch
import torch.nn.functional as Fnn

import e4_geo as G

DEV = "mps" if torch.backends.mps.is_available() else "cpu"
SKY = np.array([0xB9, 0xCD, 0xE0], np.uint8)
TMAX = 40000.0


def t_schedule(tmax: float, t0: float = 0.5) -> np.ndarray:
    ts = [t0]
    t = t0
    while t < tmax:
        t += max(1.5, 0.003 * t)
        ts.append(min(t, tmax))
    return np.array(ts)


class Heights:
    def __init__(self, grids, eye_z: float, dev):
        self.lv = []
        for g in grids:
            z = np.where(np.isfinite(g["z"]), g["z"] - eye_z, -1e4).astype(np.float32)
            self.lv.append({"t": torch.from_numpy(z)[None, None].to(dev), "e0": g["e0"], "n0": g["n0"], "res": g["res"],
                            "w": g["w"], "h": g["h"], "R": g["R"]})
        self.zmax = max(float(l["t"].max()) for l in self.lv)

    def __call__(self, e: torch.Tensor, n: torch.Tensor) -> torch.Tensor:
        out = None
        for lv in reversed(self.lv):  # coarse first, finer overrides
            gx = (e - lv["e0"]) / lv["res"] / (lv["w"] - 1) * 2 - 1
            gy = (lv["n0"] - n) / lv["res"] / (lv["h"] - 1) * 2 - 1
            v = Fnn.grid_sample(lv["t"], torch.stack([gx, gy], -1)[None, None], mode="bilinear",
                                padding_mode="border", align_corners=True)[0, 0, 0]
            inside = (gx.abs() <= 0.97) & (gy.abs() <= 0.97) & (v > -5e3)
            out = torch.where(inside, v, out) if out is not None else torch.where(inside, v, torch.full_like(v, -1e4))
        return out


@torch.no_grad()
def march(hf: Heights, dirs: torch.Tensor, tmax: float = TMAX, K: int = 16):
    """First-hit distance (inf = none) and a status code per ray (0 hit, 1 sky, 2 expired)."""
    dev = dirs.device
    N = dirs.shape[0]
    thit = torch.full((N,), float("inf"), device=dev)
    status = torch.full((N,), 2, dtype=torch.uint8, device=dev)
    ts_np = t_schedule(tmax)
    ts = torch.from_numpy(ts_np.astype(np.float32)).to(dev)
    idx = torch.arange(N, device=dev)
    d = dirs
    for k0 in range(0, len(ts_np), K):
        tb = ts[k0:k0 + K]
        kk = tb.numel()
        p = d[:, None, :] * tb[None, :, None]
        h = hf(p[..., 0].reshape(-1), p[..., 1].reshape(-1)).reshape(-1, kk)
        below = p[..., 2] <= h
        anyb = below.any(1)
        if bool(anyb.any()):
            first = below.float().argmax(1)[anyb]
            thi = tb[first]
            tlo = torch.where(first > 0, tb[(first - 1).clamp(min=0)], ts[k0 - 1] if k0 > 0 else torch.zeros_like(thi))
            dh = d[anyb]
            lo, hi = tlo.clone(), thi.clone()
            for _ in range(12):
                mid = (lo + hi) / 2
                pm = dh * mid[:, None]
                bl = pm[:, 2] <= hf(pm[:, 0], pm[:, 1])
                hi = torch.where(bl, mid, hi)
                lo = torch.where(bl, lo, mid)
            thit[idx[anyb]] = hi
            status[idx[anyb]] = 0
        pl = p[:, -1, :]
        sky = ~anyb & (pl[:, 2] > hf.zmax + 1) & (d[:, 2] >= 0)
        status[idx[sky]] = 1
        keep = ~anyb & ~sky
        idx, d = idx[keep], d[keep]
        if idx.numel() == 0:
            break
    return thit, status


def pixel_dirs(pose: dict, f: float, W: int, H: int) -> np.ndarray:
    R = G.pose_to_R(pose)
    u = np.arange(W) + 0.5
    v = np.arange(H) + 0.5
    uu, vv = np.meshgrid(u, v)
    c = np.stack([(uu - W / 2) / f, (vv - H / 2) / f, np.ones_like(uu)], -1)
    d = c @ R
    return (d / np.linalg.norm(d, axis=-1, keepdims=True)).astype(np.float64)


def render(grids, ortho, eye_z: float, pose: dict, f: float, W: int, H: int, dev=DEV) -> dict:
    t0 = time.time()
    hf = Heights(grids, eye_z, dev)
    dirs = pixel_dirs(pose, f, W, H)
    dt = torch.from_numpy(dirs.reshape(-1, 3).astype(np.float32)).to(dev)
    thit, status = march(hf, dt)
    thit = thit.cpu().numpy().astype(np.float64)
    status = status.cpu().numpy()
    del hf
    eye = np.array([0.0, 0.0, eye_z])
    hit = np.isfinite(thit)
    xyz = np.zeros((H * W, 3))
    d2 = dirs.reshape(-1, 3)
    xyz[hit] = eye + d2[hit] * thit[hit, None]
    rgb = np.tile(SKY.astype(np.float64), (H * W, 1))
    col_ok = np.ones(H * W, bool)
    if hit.any():
        lat, lon, _ = ortho.frame.to_geo(xyz[hit, 0], xyz[hit, 1], xyz[hit, 2])
        c = ortho.sample(lat, lon, thit[hit] / f)
        bad = ~np.isfinite(c).all(1)
        c[bad] = 128
        rgb[hit] = c
        ci = np.nonzero(hit)[0]
        col_ok[ci[bad]] = False
    # expired rays (looking at terrain beyond 40 km): grey, flagged unknown through status
    rgb[status == 2] = 128
    return {"rgb": np.clip(rgb, 0, 255).astype(np.uint8).reshape(H, W, 3), "xyz": xyz.astype(np.float32).reshape(H, W, 3),
            "status": status.reshape(H, W), "colour_ok": col_ok.reshape(H, W), "dirs": dirs.astype(np.float32),
            "eye": eye, "sec": time.time() - t0}
