"""E3 near-field renderer: per-pixel heightfield ray march (torch; MPS or CPU) of swisstopo DTM/DSM grids in the
C0 cache frame, textured with SWISSIMAGE, plus compositing over the cached far field and a forward warp of a cached
render to another eye.

API (all poses/intrinsics in the cache conventions of tools/research/tm/cache/FORMAT.md):

    grids = nf_data.build_grids(frame, 0, 0, eye_z, wedge, cache=...)      # once per photo (around the ref eye)
    ortho = nf_data.Ortho(frame, 0, 0, eye_z, wedge, tile_dir)              # once per photo
    r = render_near(grids, ortho, eye, pose, intr, W, H, surface="dsm"|"dtm", ss=2, tmax=2000, clear_r=15,
                    coarse=None|3.3, max_zoom=19)
        -> dict(rgb uint8 (H,W,3), xyz float32 (H,W,3) (0 = no hit), cov float32 (H,W) fraction of subsamples that hit,
                depth (H,W) nan = no hit, eye (clamped), eyeClamped bool, sec)
    comp = composite(r, far_rgb, far_xyz)          # near wins where it hits; else far
    far = warp_view(view, eye_new, pose, intr, W, H, min_depth=1500)   # forward-splat a cached view to another eye
"""
from __future__ import annotations

import math
import time

import numpy as np
import torch
import torch.nn.functional as Fnn

import nf_data as D
import nf_geo as G

DEV = "mps" if torch.backends.mps.is_available() else "cpu"
SKY = np.array([0xb9, 0xcd, 0xe0], np.uint8)


def pose_to_R(p: dict) -> np.ndarray:
    D_ = math.pi / 180
    y, pt, r = p["yaw"] * D_, p["pitch"] * D_, p["roll"] * D_
    f = np.array([math.sin(y) * math.cos(pt), math.cos(y) * math.cos(pt), math.sin(pt)])
    r0 = np.array([math.cos(y), -math.sin(y), 0.0])
    u0 = np.cross(r0, f)
    right = r0 * math.cos(r) - u0 * math.sin(r)
    up = u0 * math.cos(r) + r0 * math.sin(r)
    return np.stack([right, -up, f])


def _t_schedule(tmax: float, t0: float = 0.3) -> np.ndarray:
    ts = [t0]
    t = t0
    while t < tmax:
        t += max(0.12, 0.0022 * t)
        ts.append(min(t, tmax))
    return np.array(ts)


class _HF:
    """Height lookup on the inner/outer grids (torch, relative to eye z)."""

    def __init__(self, grids, surface: str, eye, clear_r: float, coarse: float | None, dev):
        self.dev = dev
        self.lv = []
        for name in ("inner", "outer"):
            g = grids[name]
            hts = np.array(g["dtm"] if surface == "dtm" else g["dsm"], np.float64)
            if surface == "dsm":
                dtm = np.asarray(g["dtm"], np.float64)
                h, w = hts.shape
                ee = g["e0"] + np.arange(w) * g["res"]
                nn = g["n0"] - np.arange(h) * g["res"]
                dd = np.hypot(ee[None, :] - eye[0], nn[:, None] - eye[1])
                hts = np.where(dd < clear_r, dtm, hts)
                hts = np.where(np.isfinite(hts), hts, dtm)  # DSM holes -> DTM
            if coarse:
                hts = _coarsen(hts, g["res"], coarse)
            hts = hts - eye[2]
            hts = np.where(np.isfinite(hts), hts, -1e4).astype(np.float32)
            h, w = hts.shape
            self.lv.append({
                "t": torch.from_numpy(hts)[None, None].to(dev),
                "e0": g["e0"] - eye[0], "n0": g["n0"] - eye[1], "res": g["res"], "w": w, "h": h,
                # grid centre relative to eye (grids are built around the ref eye)
                "cx": g["e0"] + (w - 1) / 2 * g["res"] - eye[0], "cy": g["n0"] - (h - 1) / 2 * g["res"] - eye[1],
                "R": (w - 1) / 2 * g["res"],
            })
        self.zmax = max(float(l["t"].max()) for l in self.lv)

    def __call__(self, e: torch.Tensor, n: torch.Tensor) -> torch.Tensor:
        inner, outer = self.lv
        di = torch.hypot(e - inner["cx"], n - inner["cy"])
        use_in = di < inner["R"] - 4 * inner["res"]
        out = torch.full_like(e, -1e4)
        for lv, sel in ((inner, use_in), (outer, ~use_in)):
            if not bool(sel.any()):
                continue
            ee, nn = e[sel], n[sel]
            gx = (ee - lv["e0"]) / lv["res"] / (lv["w"] - 1) * 2 - 1
            gy = (lv["n0"] - nn) / lv["res"] / (lv["h"] - 1) * 2 - 1
            grid = torch.stack([gx, gy], -1)[None, None]
            v = Fnn.grid_sample(lv["t"], grid, mode="bilinear", padding_mode="border", align_corners=True)[0, 0, 0]
            inside = (gx.abs() <= 1) & (gy.abs() <= 1)
            out[sel] = torch.where(inside, v, torch.full_like(v, -1e4))
        return out


def _coarsen(h: np.ndarray, res: float, target: float) -> np.ndarray:
    """Emulate a coarse DEM (app z14 ~3.3 m): sample at `target` spacing and bilinearly re-interpolate."""
    if target <= res:
        return h
    k = target / res
    H, W = h.shape
    ys = np.arange(0, H, k)
    xs = np.arange(0, W, k)
    small = h[np.round(ys).astype(int).clip(0, H - 1)][:, np.round(xs).astype(int).clip(0, W - 1)]
    t = torch.from_numpy(np.nan_to_num(small, nan=-1e4).astype(np.float32))[None, None]
    up = Fnn.interpolate(t, size=(H, W), mode="bilinear", align_corners=True)[0, 0].numpy().astype(np.float64)
    up[up < -5e3] = np.nan
    return np.where(np.isfinite(h), up, np.nan)


@torch.no_grad()
def march(hf: _HF, dirs: torch.Tensor, tmax: float, K: int = 24) -> torch.Tensor:
    """First-hit distance along unit rays from the eye (origin); inf = no hit within tmax.
    Steps are evaluated K at a time (one host sync per batch), then the first crossing is bisected."""
    dev = dirs.device
    N = dirs.shape[0]
    thit = torch.full((N,), float("inf"), device=dev)
    ts_np = _t_schedule(tmax)
    ts = torch.from_numpy(ts_np.astype(np.float32)).to(dev)
    idx = torch.arange(N, device=dev)
    d = dirs
    for k0 in range(0, len(ts_np), K):
        tb = ts[k0:k0 + K]
        kk = tb.numel()
        p = d[:, None, :] * tb[None, :, None]  # (n, kk, 3)
        h = hf(p[..., 0].reshape(-1), p[..., 1].reshape(-1)).reshape(-1, kk)
        below = p[..., 2] <= h
        anyb = below.any(1)
        if bool(anyb.any()):
            first = below.float().argmax(1)[anyb]
            thi = tb[first]
            tlo = torch.where(first > 0, tb[(first - 1).clamp(min=0)],
                              ts[k0 - 1] if k0 > 0 else torch.zeros_like(thi))
            dh = d[anyb]
            lo, hi = tlo.clone(), thi.clone()
            for _ in range(12):
                mid = (lo + hi) / 2
                pm = dh * mid[:, None]
                bl = pm[:, 2] <= hf(pm[:, 0], pm[:, 1])
                hi = torch.where(bl, mid, hi)
                lo = torch.where(bl, lo, mid)
            thit[idx[anyb]] = hi
        pl = p[:, -1, :]
        keep = ~anyb & ~((pl[:, 2] > hf.zmax + 1) & (d[:, 2] >= 0))
        idx, d = idx[keep], d[keep]
        if idx.numel() == 0:
            break
    return thit


def pixel_dirs(pose, intr, W, H, ss: int) -> np.ndarray:
    R = pose_to_R(pose)
    o = (np.arange(ss) + 0.5) / ss
    u = (np.arange(W)[:, None] + o[None, :]).reshape(-1)
    v = (np.arange(H)[:, None] + o[None, :]).reshape(-1)
    uu, vv = np.meshgrid(u, v)  # (H*ss, W*ss)
    c = np.stack([(uu - intr["cx"]) / intr["fx"], (vv - intr["cy"]) / intr["fy"], np.ones_like(uu)], -1)
    d = c @ R
    return d / np.linalg.norm(d, axis=-1, keepdims=True)


def dtm_height(grids, e: float, n: float) -> float:
    """swissALTI3D DTM (ENU z) at ENU (e, n) from the grids (inner if inside, else outer)."""
    for name in ("inner", "outer"):
        g = grids[name]
        fx = (e - g["e0"]) / g["res"]
        fy = (g["n0"] - n) / g["res"]
        h, w = np.asarray(g["dtm"]).shape
        if 0 <= fx < w - 1 and 0 <= fy < h - 1:
            x0, y0 = int(fx), int(fy)
            ax, ay = fx - x0, fy - y0
            z = np.asarray(g["dtm"])
            v = (z[y0, x0] * (1 - ax) * (1 - ay) + z[y0, x0 + 1] * ax * (1 - ay) + z[y0 + 1, x0] * (1 - ax) * ay
                 + z[y0 + 1, x0 + 1] * ax * ay)
            if np.isfinite(v):
                return float(v)
    return float("nan")


def render_near(grids, ortho: D.Ortho, eye, pose, intr, W, H, surface="dsm", ss=2, tmax=2000.0, clear_r=15.0,
                coarse=None, max_zoom=19, dev=DEV) -> dict:
    t0 = time.time()
    eye = np.array(eye, float)
    g0 = dtm_height(grids, eye[0], eye[1])
    clamped = False
    if np.isfinite(g0) and eye[2] < g0 + 1.0:
        eye[2] = g0 + 1.6
        clamped = True
    hf = _HF(grids, surface, eye, clear_r, coarse, dev)
    dirs = pixel_dirs(pose, intr, W, H, ss)
    Hs, Ws = dirs.shape[:2]
    dt = torch.from_numpy(dirs.reshape(-1, 3).astype(np.float32)).to(dev)
    thit = march(hf, dt, tmax).cpu().numpy().astype(np.float64)
    del hf
    dflat = dirs.reshape(-1, 3)
    hit = np.isfinite(thit)
    xyz = np.zeros((Hs * Ws, 3))
    xyz[hit] = eye + dflat[hit] * thit[hit, None]
    # colour
    col = np.zeros((Hs * Ws, 3))
    if hit.any():
        lat, lon, _ = ortho.frame.to_geo(xyz[hit, 0], xyz[hit, 1], xyz[hit, 2])
        fp = thit[hit] / intr["fx"]  # output-pixel footprint (m)
        if max_zoom < 19:
            fp = np.maximum(fp, G.merc_res(ortho.lat0, max_zoom) * 1.0001)
        c = ortho.sample(lat, lon, fp)
        c[~np.isfinite(c).all(1)] = 128
        col[hit] = c
    # downsample subsamples -> pixels
    hitm = hit.reshape(H, ss, W, ss).astype(np.float64)
    cov = hitm.mean((1, 3))
    colr = col.reshape(H, ss, W, ss, 3)
    rgb = (colr * hitm[..., None]).sum((1, 3)) / np.maximum(hitm.sum((1, 3)), 1)[..., None]
    tt = np.where(hit, thit, np.inf).reshape(H, ss, W, ss).transpose(0, 2, 1, 3).reshape(H, W, ss * ss)
    j = tt.argmin(-1)
    xr = xyz.reshape(H, ss, W, ss, 3).transpose(0, 2, 1, 3, 4).reshape(H, W, ss * ss, 3)
    xyz_px = np.take_along_axis(xr, j[..., None, None], 2)[:, :, 0]
    near = cov >= 0.5
    xyz_px[~near] = 0
    depth = np.where(near, np.linalg.norm(xyz_px - eye, axis=-1), np.nan)
    return {"rgb": np.clip(rgb, 0, 255).astype(np.uint8), "xyz": xyz_px.astype(np.float32), "cov": cov.astype(np.float32),
            "depth": depth, "eye": eye, "eyeClamped": clamped, "sec": time.time() - t0, "near": near}


def composite(near: dict, far_rgb: np.ndarray, far_xyz_full: np.ndarray) -> dict:
    """Near render wins where it hits (coverage >= 0.5; rgb blended by coverage at silhouettes); else far."""
    cov = near["cov"][..., None]
    m = near["near"]
    rgb = np.where(m[..., None], near["rgb"] * np.clip(cov, 0, 1) + far_rgb * (1 - np.clip(cov, 0, 1)),
                   far_rgb).astype(np.uint8)
    rgb[m] = np.where(cov[m] > 0.99, near["rgb"][m], rgb[m])
    xyz = np.where(m[..., None], near["xyz"], far_xyz_full).astype(np.float32)
    return {"rgb": rgb, "xyz": xyz}


def upsample_xyz(xyz_s: np.ndarray, stride: int, W: int, H: int) -> np.ndarray:
    """Cache stride-2 xyz -> native size (nearest sample: native (r, c) <- stride (r//s, c//s))."""
    r = np.minimum(np.arange(H) // stride, xyz_s.shape[0] - 1)
    c = np.minimum(np.arange(W) // stride, xyz_s.shape[1] - 1)
    return xyz_s[r][:, c]


def warp_view(rgb: np.ndarray, xyz_full: np.ndarray, eye_new, pose, intr, W, H, min_depth_new=1500.0) -> dict:
    """Forward-splat (z-buffer) a rendered view's pixels (rgb + native xyz) into a camera at eye_new with `pose`,
    keeping only points farther than min_depth_new from eye_new; 5x5 nearest-valid hole fill; rest = sky."""
    R = pose_to_R(pose)
    X = xyz_full.reshape(-1, 3).astype(np.float64)
    col = rgb.reshape(-1, 3)
    valid = (X != 0).any(1)
    X, col = X[valid], col[valid]
    c = (X - np.asarray(eye_new)) @ R.T
    dep = np.linalg.norm(X - np.asarray(eye_new), axis=1)
    ok = (c[:, 2] > 0) & (dep > min_depth_new)
    c, X, col, dep = c[ok], X[ok], col[ok], dep[ok]
    u = intr["cx"] + intr["fx"] * c[:, 0] / c[:, 2]
    v = intr["cy"] + intr["fy"] * c[:, 1] / c[:, 2]
    ui, vi = np.floor(u).astype(int), np.floor(v).astype(int)
    inb = (ui >= 0) & (ui < W) & (vi >= 0) & (vi < H)
    ui, vi, dep, X, col = ui[inb], vi[inb], dep[inb], X[inb], col[inb]
    order = np.argsort(-dep)  # far first, near overwrite
    zbuf = np.full((H, W), np.inf)
    out_rgb = np.zeros((H, W, 3), np.uint8)
    out_xyz = np.zeros((H, W, 3), np.float32)
    lin = vi[order] * W + ui[order]
    zbuf.reshape(-1)[lin] = dep[order]
    out_rgb.reshape(-1, 3)[lin] = col[order]
    out_xyz.reshape(-1, 3)[lin] = X[order]
    have = np.isfinite(zbuf)
    # hole fill: nearest valid within 5x5 (prefer nearest depth)
    if (~have).any():
        best = np.full((H, W), np.inf)
        fr = out_rgb.copy()
        fx = out_xyz.copy()
        for dy in range(-2, 3):
            for dx in range(-2, 3):
                if dx == 0 and dy == 0:
                    continue
                zs = np.roll(np.roll(zbuf, dy, 0), dx, 1)
                cand = (~have) & (zs < best)
                best = np.where(cand, zs, best)
                fr[cand] = np.roll(np.roll(out_rgb, dy, 0), dx, 1)[cand]
                fx[cand] = np.roll(np.roll(out_xyz, dy, 0), dx, 1)[cand]
        filled = (~have) & np.isfinite(best)
        out_rgb[filled], out_xyz[filled] = fr[filled], fx[filled]
        have |= filled
    out_rgb[~have] = SKY
    return {"rgb": out_rgb, "xyz": out_xyz}
