"""Minimal 3D Gaussian splat rasteriser (numpy + torch CPU) for offline evaluation of roll spots.

Standard 3DGS forward pass (EWA projection, per-tile front-to-back alpha compositing, SH degree 0):
  cov3 = R S S^T R^T; cov2 = J W cov3 W^T J^T + lowPass*I; alpha = min(0.99, o * exp(-d^T cov2^-1 d / 2)),
  skipped below 1/255; colour = sum_i T_i alpha_i c_i over a background.
Same conventions as src/lib/nearfield/deck-splat-shaders.ts where it matters (low-pass 0.3 px, 3 sigma).
Cameras: COLMAP PINHOLE + world->camera quaternion/translation (src/lib/export/camera.ts colmapLines), pixel
centres at (i + 0.5, j + 0.5).

    from splatrender import load_ply, render, read_colmap_text
"""
from __future__ import annotations

import numpy as np
import torch

SH_C0 = 0.28209479177387814
_TYPES = {"float": "<f4", "float32": "<f4", "double": "<f8", "uchar": "u1", "uint8": "u1", "char": "i1", "int": "<i4",
          "uint": "<u4", "short": "<i2", "ushort": "<u2", "int32": "<i4", "uint32": "<u4"}


def load_ply(path: str) -> dict:
    """3DGS binary little-endian .ply -> dict(means (N,3), scales (N,3) linear, quats (N,4) wxyz unit,
    colors (N,3) 0..1, opacity (N,)). Reads Rigi (encodeGaussianPly) and Brush exports."""
    with open(path, "rb") as f:
        raw = f.read()
    end = raw.index(b"end_header") + len(b"end_header")
    if raw[end:end + 1] == b"\r":
        end += 1
    if raw[end:end + 1] == b"\n":
        end += 1
    head = raw[:end].decode("latin1").splitlines()
    assert "format binary_little_endian 1.0" in [h.strip() for h in head], "binary LE only"
    n, props, in_vertex = 0, [], False
    for h in head:
        t = h.split()
        if not t:
            continue
        if t[0] == "element":
            in_vertex = t[1] == "vertex"
            if in_vertex:
                n = int(t[2])
        elif t[0] == "property" and in_vertex:
            props.append((t[2], _TYPES[t[1]]))
    a = np.frombuffer(raw, dtype=np.dtype(props), count=n, offset=end)
    g = lambda k: a[k].astype(np.float64)  # noqa: E731
    means = np.stack([g("x"), g("y"), g("z")], 1)
    scales = np.exp(np.stack([g(f"scale_{k}") for k in range(3)], 1))
    q = np.stack([g(f"rot_{k}") for k in range(4)], 1)
    q /= np.maximum(np.linalg.norm(q, axis=1, keepdims=True), 1e-12)
    col = np.clip(0.5 + SH_C0 * np.stack([g(f"f_dc_{k}") for k in range(3)], 1), 0, 1)
    op = 1 / (1 + np.exp(-g("opacity")))
    ok = np.isfinite(means).all(1) & np.isfinite(scales).all(1) & np.isfinite(op)
    return {"means": means[ok], "scales": scales[ok], "quats": q[ok], "colors": col[ok], "opacity": op[ok]}


def concat(*clouds: dict) -> dict:
    cs = [c for c in clouds if c is not None and len(c["means"])]
    if not cs:
        return {k: np.zeros((0, d)) if d else np.zeros(0) for k, d in (("means", 3), ("scales", 3), ("quats", 4), ("colors", 3), ("opacity", 0))}
    return {k: np.concatenate([c[k] for c in cs], 0) for k in cs[0]}


def quat_to_rot(q: np.ndarray) -> np.ndarray:
    w, x, y, z = q[:, 0], q[:, 1], q[:, 2], q[:, 3]
    return np.stack([
        np.stack([1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)], -1),
        np.stack([2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)], -1),
        np.stack([2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)], -1),
    ], 1)


def read_colmap_text(cameras: str, images: str) -> list[dict]:
    """[{name, width, height, fx, fy, cx, cy, R (w2c 3x3), t (3,)}] from COLMAP text-model contents."""
    cams = {}
    for line in cameras.splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        t = line.split()
        assert t[1] == "PINHOLE", t[1]
        cams[int(t[0])] = dict(width=int(t[2]), height=int(t[3]), fx=float(t[4]), fy=float(t[5]), cx=float(t[6]), cy=float(t[7]))
    out = []
    for line in images.splitlines():
        t = line.split()
        if len(t) < 10 or line.startswith("#"):
            continue
        qw, qx, qy, qz, tx, ty, tz = map(float, t[1:8])
        R = quat_to_rot(np.array([[qw, qx, qy, qz]]))[0]
        out.append({"name": t[9], **cams[int(t[8])], "R": R, "t": np.array([tx, ty, tz])})
    return out


def scale_camera(cam: dict, width: int, height: int) -> dict:
    sx, sy = width / cam["width"], height / cam["height"]
    return {**cam, "width": width, "height": height, "fx": cam["fx"] * sx, "fy": cam["fy"] * sy, "cx": cam["cx"] * sx, "cy": cam["cy"] * sy}


@torch.no_grad()
def render(cloud: dict, cam: dict, bg=(0.5, 0.5, 0.5), tile: int = 16, low_pass: float = 0.3, sigmas: float = 3.0,
           max_radius: float = 1024.0, near: float = 0.2, chunk: int = 4096) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """-> (rgb HxWx3 0..1 over bg, alpha HxW, expected depth HxW (NaN where alpha < 0.5))."""
    W, H = cam["width"], cam["height"]
    R, t = cam["R"], cam["t"]
    m = cloud["means"]
    pc = m @ R.T + t
    z = pc[:, 2]
    keep = z > near
    if not keep.any():
        return np.tile(np.array(bg, np.float32), (H, W, 1)), np.zeros((H, W), np.float32), np.full((H, W), np.nan, np.float32)
    pc, z = pc[keep], z[keep]
    S = cloud["scales"][keep]
    Rq = quat_to_rot(cloud["quats"][keep])
    M = Rq * S[:, None, :]
    cov3 = M @ M.transpose(0, 2, 1)
    covc = R[None] @ cov3 @ R.T[None]
    fx, fy, cx, cy = cam["fx"], cam["fy"], cam["cx"], cam["cy"]
    x, y = pc[:, 0], pc[:, 1]
    J = np.zeros((len(z), 2, 3))
    J[:, 0, 0] = fx / z
    J[:, 0, 2] = -fx * x / z ** 2
    J[:, 1, 1] = fy / z
    J[:, 1, 2] = -fy * y / z ** 2
    cov2 = J @ covc @ J.transpose(0, 2, 1)
    cov2[:, 0, 0] += low_pass
    cov2[:, 1, 1] += low_pass
    a, b, c = cov2[:, 0, 0], cov2[:, 0, 1], cov2[:, 1, 1]
    det = a * c - b * b
    ok = det > 1e-12
    mx = fx * x / z + cx - 0.5  # pixel index space: pixel i covers [i, i+1), centre i + 0.5 -> i
    my = fy * y / z + cy - 0.5
    lam = 0.5 * (a + c) + np.sqrt(np.maximum(0.25 * (a - c) ** 2 + b * b, 0))
    rad = np.minimum(sigmas * np.sqrt(np.maximum(lam, 0)), max_radius)
    ok &= (mx + rad >= 0) & (mx - rad < W) & (my + rad >= 0) & (my - rad < H)
    idx = np.nonzero(ok)[0]
    inv = np.stack([c[idx] / det[idx], -b[idx] / det[idx], a[idx] / det[idx]], 1)
    mx, my, rad, zz = mx[idx], my[idx], rad[idx], z[idx]
    col = cloud["colors"][keep][idx]
    op = cloud["opacity"][keep][idx]
    TW, TH = (W + tile - 1) // tile, (H + tile - 1) // tile
    tx0 = np.clip(np.floor((mx - rad) / tile), 0, TW - 1).astype(np.int64)
    tx1 = np.clip(np.floor((mx + rad) / tile), 0, TW - 1).astype(np.int64)
    ty0 = np.clip(np.floor((my - rad) / tile), 0, TH - 1).astype(np.int64)
    ty1 = np.clip(np.floor((my + rad) / tile), 0, TH - 1).astype(np.int64)
    nx, ny = tx1 - tx0 + 1, ty1 - ty0 + 1
    cnt = nx * ny
    gid = np.repeat(np.arange(len(idx)), cnt)
    off = np.arange(cnt.sum()) - np.repeat(np.cumsum(cnt) - cnt, cnt)
    tx = tx0[gid] + off % nx[gid]
    ty = ty0[gid] + off // nx[gid]
    tid = ty * TW + tx
    order = np.lexsort((zz[gid], tid))
    tid, gid = tid[order], gid[order]
    starts = np.searchsorted(tid, np.arange(TW * TH), "left")
    ends = np.searchsorted(tid, np.arange(TW * TH), "right")
    T = lambda v: torch.from_numpy(np.ascontiguousarray(v, dtype=np.float32))  # noqa: E731
    Mx, My, Inv, Col, Op, Z = T(mx), T(my), T(inv), T(col), T(op), T(zz)
    out = np.zeros((H, W, 3), np.float32)
    alpha_out = np.zeros((H, W), np.float32)
    depth_out = np.zeros((H, W), np.float32)
    bgv = torch.tensor(bg, dtype=torch.float32)
    for k in range(TW * TH):
        s, e = starts[k], ends[k]
        ty_, tx_ = divmod(k, TW)
        x0, y0 = tx_ * tile, ty_ * tile
        w_, h_ = min(tile, W - x0), min(tile, H - y0)
        if e <= s:
            out[y0:y0 + h_, x0:x0 + w_] = bg
            continue
        py, px = torch.meshgrid(torch.arange(y0, y0 + h_, dtype=torch.float32), torch.arange(x0, x0 + w_, dtype=torch.float32), indexing="ij")
        px, py = px.reshape(-1, 1), py.reshape(-1, 1)
        Tacc = torch.ones(px.shape[0], 1)
        C = torch.zeros(px.shape[0], 3)
        D = torch.zeros(px.shape[0], 1)
        g = torch.from_numpy(gid[s:e])
        for c0 in range(0, len(g), chunk):
            gg = g[c0:c0 + chunk]
            dx = px - Mx[gg][None, :]
            dy = py - My[gg][None, :]
            iv = Inv[gg]
            pw = -0.5 * (iv[:, 0] * dx * dx + 2 * iv[:, 1] * dx * dy + iv[:, 2] * dy * dy)
            al = torch.clamp(Op[gg][None, :] * torch.exp(torch.clamp(pw, max=0)), max=0.99)
            al = torch.where((al >= 1 / 255) & (pw > -0.5 * sigmas * sigmas * 1.0001), al, torch.zeros_like(al))
            trans = torch.cumprod(torch.cat([torch.ones_like(al[:, :1]), 1 - al[:, :-1]], 1), 1) * Tacc
            wgt = trans * al
            C += wgt @ Col[gg]
            D += wgt @ Z[gg][:, None]
            Tacc = trans[:, -1:] * (1 - al[:, -1:])
            if float(Tacc.max()) < 1e-4:
                break
        img = C + Tacc * bgv[None]
        out[y0:y0 + h_, x0:x0 + w_] = img.reshape(h_, w_, 3).numpy()
        alpha_out[y0:y0 + h_, x0:x0 + w_] = (1 - Tacc).reshape(h_, w_).numpy()
        depth_out[y0:y0 + h_, x0:x0 + w_] = (D / torch.clamp(1 - Tacc, min=1e-6)).reshape(h_, w_).numpy()
    depth_out[alpha_out < 0.5] = np.nan
    return np.clip(out, 0, 1), alpha_out, depth_out
