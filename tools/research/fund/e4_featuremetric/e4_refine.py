# Rigi
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: Copyright (c) Rigi contributors

"""E4 dense feature-metric refinement (PROTOCOL section 6): PixLoc-style LM over (yaw, pitch, roll, f) on the residual
between photo patch tokens (sampled at the projection of each render cell's world ray) and render patch tokens.
No re-render in the loop; the eye is fixed, every cell is a world direction (rotation-only).
"""
from __future__ import annotations

import math

import numpy as np
import torch
import torch.nn.functional as Fnn

import e4_geo as G

C_CAUCHY = 0.5
STEPS = np.array([0.05, 0.05, 0.05, 0.002])  # deg, deg, deg, log f
LEVELS = (294, 588)  # long side px of the photo at each pyramid level


def cauchy_rho(r: torch.Tensor, c: float = C_CAUCHY) -> torch.Tensor:
    return 0.5 * c * c * torch.log1p((r / c) ** 2)


class Level:
    """One pyramid level: photo token map, render cells (world dirs, raw tokens, validity)."""

    def __init__(self, photo_raw: torch.Tensor, render_raw: torch.Tensor, cell_dirs: np.ndarray, cell_valid: np.ndarray,
                 W: int, H: int, scale: float, start: dict):
        self.rows_q, self.cols_q, C = photo_raw.shape
        self.W, self.H, self.scale = W, H, scale  # photo image size at this level (px), px per full-res px
        nq = photo_raw.norm(dim=-1)
        self.q = (photo_raw / nq[..., None].clamp(min=1e-6)).permute(2, 0, 1)[None].contiguous()  # (1, C, r, c)
        self.nq = nq[None, None]
        nr = render_raw.reshape(-1, C).norm(dim=-1)
        self.r = render_raw.reshape(-1, C) / nr[:, None].clamp(min=1e-6)
        self.nr = nr
        self.dirs = torch.from_numpy(cell_dirs.reshape(-1, 3).astype(np.float32))
        self.valid = torch.from_numpy(cell_valid.reshape(-1))
        self.f0 = start["f"]
        # S0: valid cells inside the frame at the start pose (fixed for every restart)
        _, inside, _ = self._project(start)
        self.S0 = self.valid & inside
        self.nS = int(self.S0.sum())

    def _project(self, theta: dict):
        R = torch.from_numpy(G.pose_to_R(theta).astype(np.float32))
        c = self.dirs @ R.T
        z = c[:, 2]
        zz = z.clamp(min=0.05)
        f = theta["f"] * self.scale
        u = self.W / 2 + f * c[:, 0] / zz
        v = self.H / 2 + f * c[:, 1] / zz
        inside = (z > 0.05) & (u > 0) & (u < self.W) & (v > 0) & (v < self.H)
        return torch.stack([u, v], -1), inside, z

    def residual(self, theta: dict):
        """-> (r (N, C) zero outside, rn (N,), w (N,), inside (N,)) on all cells (use S0 to select)."""
        uv, inside, _ = self._project(theta)
        gx = uv[:, 0] / self.W * 2 - 1
        gy = uv[:, 1] / self.H * 2 - 1
        grid = torch.stack([gx, gy], -1)[None, None]
        fq = Fnn.grid_sample(self.q, grid, mode="bilinear", padding_mode="border", align_corners=False)[0, :, 0].T
        nqs = Fnn.grid_sample(self.nq, grid, mode="bilinear", padding_mode="border", align_corners=False)[0, 0, 0]
        r = fq - self.r
        r = r * inside[:, None]
        rn = r.norm(dim=-1)
        w = torch.minimum(nqs / self.nr.clamp(min=1e-6), self.nr / nqs.clamp(min=1e-6)).clamp(0, 1)
        return r, rn, w, inside

    def cost(self, theta: dict) -> float:
        r, rn, w, inside = self.residual(theta)
        sel = self.S0
        rho = torch.where(inside, w * cauchy_rho(rn), cauchy_rho(torch.tensor(1.0)).expand_as(rn))
        return float(rho[sel].mean())


def theta_to_vec(t: dict) -> np.ndarray:
    return np.array([t["yaw"], t["pitch"], t["roll"], math.log(t["f"])])


def vec_to_theta(x: np.ndarray) -> dict:
    return {"yaw": float(x[0]) % 360.0, "pitch": float(x[1]), "roll": float(x[2]), "f": math.exp(float(x[3]))}


def jacobian(level: Level, x: np.ndarray, W_all=None):
    """Central finite differences of the S0 residual vector (n_in * C, 4) with the current IRLS/confidence weights."""
    cols = []
    for k in range(4):
        d = np.zeros(4)
        d[k] = STEPS[k]
        rp, _, _, _ = level.residual(vec_to_theta(x + d))
        rm, _, _, _ = level.residual(vec_to_theta(x - d))
        cols.append(((rp - rm) / (2 * STEPS[k]))[level.S0])
    return torch.stack(cols, -1)  # (n, C, 4)


def lm(level: Level, x0: np.ndarray, iters: int = 25):
    x = x0.copy()
    lam = 1e-2
    cur = level.cost(vec_to_theta(x))
    for _ in range(iters):
        r, rn, w, inside = level.residual(vec_to_theta(x))
        S = level.S0
        irls = 1.0 / (1.0 + (rn / C_CAUCHY) ** 2)
        ww = (w * irls * inside)[S]  # (n,)
        J = jacobian(level, x)  # (n, C, 4)
        rr = r[S]  # (n, C)
        JW = J * ww[:, None, None]
        H = torch.einsum("nca,ncb->ab", JW, J).double().numpy()
        g = torch.einsum("nca,nc->a", JW, rr).double().numpy()
        # scale the log f axis so damping is comparable (steps in deg vs log f)
        improved = False
        for _try in range(8):
            A = H + lam * np.diag(np.maximum(np.diag(H), 1e-9))
            try:
                dx = -np.linalg.solve(A, g)
            except np.linalg.LinAlgError:
                lam *= 10
                continue
            dx = np.clip(dx, [-6, -6, -6, -0.1], [6, 6, 6, 0.1])
            xn = x + dx
            new = level.cost(vec_to_theta(xn))
            if new < cur:
                x, cur, lam = xn, new, max(lam * 0.3, 1e-7)
                improved = True
                break
            lam *= 5
        if not improved or (np.abs(dx[:3]).max() < 0.005 and abs(dx[3]) < 2e-4):
            break
    return x, cur


def sigma_pred(level: Level, x: np.ndarray) -> dict:
    """Cov = s2 (J^T W J)^-1 at the optimum; rotation sigma (deg) = sqrt(var_yaw + var_pitch + var_roll)."""
    r, rn, w, inside = level.residual(vec_to_theta(x))
    S = level.S0
    irls = 1.0 / (1.0 + (rn / C_CAUCHY) ** 2)
    ww = (w * irls * inside)[S]
    J = jacobian(level, x)
    JW = J * ww[:, None, None]
    H = torch.einsum("nca,ncb->ab", JW, J).double().numpy()
    rr = r[S]
    M = int(rr.numel())
    s2 = float((ww[:, None] * rr * rr).sum()) / max(M - 4, 1)
    try:
        cov = s2 * np.linalg.inv(H + 1e-12 * np.eye(4))
    except np.linalg.LinAlgError:
        return {"rot": float("nan"), "var": [float("nan")] * 4}
    var = np.diag(cov)
    return {"rot": float(math.sqrt(max(var[0], 0) + max(var[1], 0) + max(var[2], 0))), "var": [float(v) for v in var],
            "s2": s2, "nEff": float(ww.sum())}


def refine(levels: list[Level], start: dict, yaw_offs=(-4.0, 0.0, 4.0), pitch_offs=(-2.0, 0.0, 2.0)) -> dict:
    """3x3 perturbed restarts, each through the full pyramid; lowest final fine-level cost wins."""
    runs = []
    for dy in yaw_offs:
        for dp in pitch_offs:
            t0 = {**start, "yaw": start["yaw"] + dy, "pitch": start["pitch"] + dp}
            x = theta_to_vec(t0)
            for lv in levels:
                x, c = lm(lv, x)
            runs.append({"offset": [dy, dp], "theta": vec_to_theta(x), "cost": c})
    best = min(runs, key=lambda r: r["cost"])
    xb = theta_to_vec(best["theta"])
    sig = sigma_pred(levels[-1], xb)
    return {"theta": best["theta"], "cost": best["cost"], "sigma": sig, "restarts": runs,
            "startCost": levels[-1].cost(start), "nCells": [lv.nS for lv in levels]}
