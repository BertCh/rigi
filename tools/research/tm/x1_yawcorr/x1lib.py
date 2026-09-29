"""X1 dense-feature yaw correlation: backbones, cylindrical feature panorama, photo splatting, FFT yaw scoring.

Angular grid: azimuth a ∈ [0,360) (clockwise from north), elevation e ∈ [E0, E1], cell size `cell` degrees.
Pano  Q[c, e, a]  = weighted mean of (centred, L2-normalised) ring tokens landing in the cell (bilinear splat,
                    normalised convolution 3×3 to fill holes), valid mass M[e, a] ∈ [0,1].
Photo P_h[c, e, α] = sum of w·f̂ of photo tokens at relative azimuth α (yaw 0) under hypothesis h = (pitch, roll, vfov),
                    weight mass W_h[e, α].
Score(yaw) = Σ_{c,e,α} P_h Q[·, α+yaw] / Σ W_h M[·, α+yaw]   (mean cosine over the overlap; FFT along azimuth).
"""
from __future__ import annotations

import json
import math
import sys
import time
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
TM = HERE.parent
sys.path.insert(0, str(TM))
sys.path.insert(0, str(TM / "c0_cache"))
import tm_common  # noqa: E402
import cache_io as CI  # noqa: E402

sys.path.append(str(TM / ".pylib" / "x1"))  # timm / huggingface_hub (appended: never shadow the venv)
import os  # noqa: E402

os.environ.setdefault("TORCH_HOME", str(TM / "weights" / "torchhub"))
os.environ.setdefault("HF_HOME", str(TM / "weights" / "hf"))
os.environ.setdefault("HF_HUB_OFFLINE", "1")
import torch  # noqa: E402

D = math.pi / 180
MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)


# ---------------------------------------------------------------- backbones
class Backbone:
    def __init__(self, name: str, device: str = "mps", layer: str = "last"):
        self.name, self.device, self.layer = name, device, layer
        if name.startswith("dinov2"):
            self.patch = 14
            if name == "dinov2_vitl14":
                m = torch.hub.load("facebookresearch/dinov2", "dinov2_vitl14", pretrained=False)
                sd = torch.load(TM / "weights" / "dinov2_vitl14_from_loma.pth", map_location="cpu")
                m.load_state_dict(sd)
            else:
                m = torch.hub.load("facebookresearch/dinov2", name)
            self.kind = "hub"
            self.depth = len(m.blocks)
        elif name.startswith("dinov3"):
            import timm
            tn = {"dinov3_vits16": "vit_small_patch16_dinov3.lvd1689m", "dinov3_vitb16": "vit_base_patch16_dinov3.lvd1689m"}[name]
            m = timm.create_model(tn, pretrained=True, num_classes=0, dynamic_img_size=True)
            self.patch = 16
            self.kind = "timm"
            self.depth = len(m.blocks)
        else:
            raise ValueError(name)
        self.m = m.eval().to(device)

    @torch.no_grad()
    def __call__(self, img: np.ndarray, gw: int, gh: int) -> np.ndarray:
        """img uint8 HxWx3 → tokens (gh, gw, C) float32 for the image resized to (gw·p, gh·p)."""
        p = self.patch
        x = cv2.resize(img, (gw * p, gh * p), interpolation=cv2.INTER_AREA if img.shape[1] > gw * p else cv2.INTER_LINEAR)
        x = (x.astype(np.float32) / 255 - MEAN) / STD
        t = torch.from_numpy(x).permute(2, 0, 1)[None].to(self.device)
        if self.kind == "hub":
            if self.layer == "last":
                f = self.m.forward_features(t)["x_norm_patchtokens"]
            else:
                li = int(round(self.depth * float(self.layer))) - 1
                f = self.m.get_intermediate_layers(t, n=[li], norm=True)[0]
        else:
            if self.layer == "last":
                f = self.m.forward_features(t)[:, self.m.num_prefix_tokens:]
            else:
                li = int(round(self.depth * float(self.layer))) - 1
                f = self.m.forward_intermediates(t, indices=[li], output_fmt="NLC", intermediates_only=True, norm=True)[0]
                if f.shape[1] != gh * gw:
                    f = f[:, -gh * gw:]
        return f[0].float().cpu().numpy().reshape(gh, gw, -1)


def sync(dev):
    if dev == "mps":
        torch.mps.synchronize()


# ---------------------------------------------------------------- geometry
def cam_rays(W, H, vfov, gw, gh, K=None):
    """Camera-frame (x right, y down, z fwd) unit rays at token centres of a gw×gh grid over a W×H image.
    K = view.json intrinsics {fx, fy, cx, cy} when available (C0 fixed fx ≠ fy by ≤ 0.4 px), else square pixels from vfov."""
    f = (H / 2) / math.tan(vfov * D / 2)
    fx, fy, cx, cy = (K["fx"], K["fy"], K["cx"], K["cy"]) if K else (f, f, W / 2, H / 2)
    u = (np.arange(gw) + 0.5) * W / gw
    v = (np.arange(gh) + 0.5) * H / gh
    uu, vv = np.meshgrid(u, v)
    d = np.stack([(uu - cx) / fx, (vv - cy) / fy, np.ones_like(uu)], -1)
    return d / np.linalg.norm(d, axis=-1, keepdims=True)


def az_el(dw):
    az = np.degrees(np.arctan2(dw[..., 0], dw[..., 1])) % 360
    el = np.degrees(np.arcsin(np.clip(dw[..., 2], -1, 1)))
    return az, el


def splat_matrix(w, az, el, grid):
    """Sparse (ne·na × N) bilinear splat matrix (weights folded in) and mass vector."""
    import scipy.sparse as sp
    cell, E0, ne, na = grid["cell"], grid["E0"], grid["ne"], grid["na"]
    x = az / cell - 0.5
    y = (el - E0) / cell - 0.5
    x0 = np.floor(x).astype(int)
    y0 = np.floor(y).astype(int)
    fx, fy = x - x0, y - y0
    rows, cols, vals = [], [], []
    n = np.arange(len(w))
    for dx, dy, ww in ((0, 0, (1 - fx) * (1 - fy)), (1, 0, fx * (1 - fy)), (0, 1, (1 - fx) * fy), (1, 1, fx * fy)):
        xi = (x0 + dx) % na
        yi = y0 + dy
        ok = (yi >= 0) & (yi < ne) & (ww > 0) & (w > 0)
        rows.append(yi[ok] * na + xi[ok])
        cols.append(n[ok])
        vals.append((ww * w)[ok])
    A = sp.csr_matrix((np.concatenate(vals), (np.concatenate(rows), np.concatenate(cols))), shape=(ne * na, len(w)))
    return A


def splat(F, w, az, el, grid):
    """Bilinear splat of features F (N,C) with weights w (N) at (az, el) into grid → (S[C,ne,na], Wm[ne,na])."""
    ne, na = grid["ne"], grid["na"]
    A = splat_matrix(w, az, el, grid)
    S = np.asarray(A @ F, np.float64)
    Wm = np.asarray(A.sum(1)).ravel()
    return S.T.reshape(F.shape[1], ne, na), Wm.reshape(ne, na)


def blur3(a, circ_axis=-1):
    """3×3 box sum, circular along azimuth, zero-padded along elevation."""
    b = a + np.roll(a, 1, circ_axis) + np.roll(a, -1, circ_axis)
    out = b.copy()
    out[..., 1:, :] += b[..., :-1, :]
    out[..., :-1, :] += b[..., 1:, :]
    return out


def area_to_grid(mask, gw, gh):
    return cv2.resize(mask.astype(np.float32), (gw, gh), interpolation=cv2.INTER_AREA)


def l2n(F):
    return F / (np.linalg.norm(F, axis=-1, keepdims=True) + 1e-8)


# ---------------------------------------------------------------- pano
RING_HFOV = 40.0


def ring_views(pid, step=15):
    m = CI.load_meta(pid)
    out = []
    for v in m["views"]["ring"]:
        if v.get("empty") or int(round(v["pose"]["yaw"])) % step:
            continue
        out.append(v["tag"])
    return m, out


def ring_tokens(bb: Backbone, pid, dpp, styles=("sat", "hill"), step=15):
    """Per ring view tokens + world (az, el) + terrain fraction. Returns {style: (F[N,C], az[N], el[N], terr[N])}, ms."""
    m, tags = ring_views(pid, step)
    out = {s: [[], [], [], []] for s in styles}
    ms = 0.0
    for tag in tags:
        v = CI.load_view(pid, "ring", tag)
        W, H = v["W"], v["H"]
        gw = int(round(RING_HFOV / dpp))
        gh = max(1, int(round(gw * H / W)))
        rays = cam_rays(W, H, v["pose"]["vfov"], gw, gh, v.get("intrinsics")) @ CI.pose_to_R(v["pose"])
        az, el = az_el(rays)
        terr = area_to_grid((v["xyz"] != 0).any(-1), gw, gh)
        for s in styles:
            img = v["rgb"] if s == "sat" else np.repeat(v["hill"][..., None], 3, -1)
            t = time.time()
            F = bb(img, gw, gh)
            sync(bb.device)
            ms += (time.time() - t) * 1000
            o = out[s]
            o[0].append(F.reshape(-1, F.shape[-1]))
            o[1].append(az.ravel())
            o[2].append(el.ravel())
            o[3].append(terr.ravel())
    return {s: tuple(np.concatenate(x) for x in out[s]) for s in styles}, ms, m


def photo_tokens(bb: Backbone, pid, hfov_guess, dpp, max_w=96):
    """Photo tokens on a grid with ≈ dpp degrees per patch at the guessed hfov. Returns F[gh,gw,C], (W,H), ms."""
    img = CI.load_photo(pid)
    H, W = img.shape[:2]
    gw = int(min(max_w, max(16, round(hfov_guess / dpp))))
    gh = max(8, int(round(gw * H / W)))
    t = time.time()
    F = bb(img, gw, gh)
    sync(bb.device)
    return F, (W, H), (time.time() - t) * 1000


def photo_masks(pid, gw, gh):
    """Pose-free P(sky) (skyglobal colour model) and foreground mask, area-averaged to the token grid."""
    import sky_cache
    sg, _ = sky_cache.load_sg(pid)
    return area_to_grid(sg.sky, gw, gh), area_to_grid(sg.fg, gw, gh), sg


def make_grid(dpp, E0=-17.0, E1=17.0):
    cell = dpp
    na = int(round(360 / cell))
    ne = int(math.ceil((E1 - E0) / cell))
    return {"cell": cell, "E0": E0, "ne": ne, "na": na}


def build_pano(F, az, el, w, grid):
    """Q·M (weighted-mean features times valid mass) and M (weight / coverage), both [.., ne, na]."""
    S, Wm = splat(F, w, az, el, grid)
    _, Cm = splat(F[:, :1], np.ones_like(w), az, el, grid)
    S, Wm, Cm = blur3(S), blur3(Wm), blur3(Cm)
    Q = S / np.maximum(Wm, 1e-6)
    M = np.where(Cm > 0.05, Wm / np.maximum(Cm, 1e-6), 0.0)
    Q[:, Wm < 1e-3] = 0
    return (Q * M).astype(np.float32), M.astype(np.float32)


# ---------------------------------------------------------------- scoring
class Scorer:
    """Precomputes FFT of the pano; scores hypotheses (pitch, roll, vfov) over all yaws."""

    def __init__(self, QM, M, grid):
        self.grid = grid
        self.FQ = np.fft.rfft(QM, axis=-1)          # [C, ne, na/2+1]
        self.FM = np.fft.rfft(M, axis=-1)          # [ne, ...]
        self.na = grid["na"]
        q1 = QM.sum(1)  # [C, na] column-pooled pano (terrain-weighted)
        m1 = M.sum(0)
        q1 = q1 / (np.linalg.norm(q1, axis=0, keepdims=True) + 1e-8)
        q1[:, m1 < 0.5] = 0
        self.FQ1 = np.fft.rfft(q1, axis=-1)
        self.FM1 = np.fft.rfft((m1 >= 0.5).astype(np.float64))

    def colcurve(self, Fp, wp, az_rel, el):
        """Column-pooled variant: per-azimuth-column mean feature (over elevation) of photo and pano, cosine over yaw."""
        S, Wm = splat(Fp, wp, az_rel % 360, el, self.grid)
        p1 = S.sum(1)
        w1 = Wm.sum(0)
        p1 = p1 / (np.linalg.norm(p1, axis=0, keepdims=True) + 1e-8)
        p1[:, w1 < 0.5] = 0
        num = np.fft.irfft((np.conj(np.fft.rfft(p1, axis=-1)) * self.FQ1).sum(0), n=self.na)
        den = np.fft.irfft(np.conj(np.fft.rfft((w1 >= 0.5).astype(np.float64))) * self.FM1, n=self.na)
        tot = (w1 >= 0.5).sum() + 1e-9
        s = num / np.maximum(den, 1e-6)
        s[den < 0.5 * tot] = np.nan
        return s

    def curve(self, Fp, wp, az_rel, el, min_frac=0.3):
        """Fp (N,C) photo features (already centred/normalised), wp (N) weights, (az_rel, el) at yaw 0 → score[na]."""
        S, Wm = splat(Fp, wp, az_rel % 360, el, self.grid)
        FS = np.fft.rfft(S, axis=-1)
        FW = np.fft.rfft(Wm, axis=-1)
        num = np.fft.irfft((np.conj(FS) * self.FQ).sum((0, 1)), n=self.na)
        den = np.fft.irfft((np.conj(FW) * self.FM).sum(0), n=self.na)
        tot = Wm.sum() + 1e-9
        s = num / np.maximum(den, 1e-6)
        s[den < min_frac * tot] = np.nan
        return s, den / tot


def parabolic(y, i):
    n = len(y)
    a, b, c = y[(i - 1) % n], y[i], y[(i + 1) % n]
    if not (np.isfinite(a) and np.isfinite(c)):
        return 0.0
    d = a - 2 * b + c
    return float(np.clip(0.5 * (a - c) / d, -0.5, 0.5)) if d < 0 else 0.0


def dang(a, b):
    return (a - b + 540) % 360 - 180


def zscore(c):
    c = np.asarray(c, np.float64)
    ok = np.isfinite(c)
    if ok.sum() < 5:
        return np.zeros_like(c)
    med = np.median(c[ok])
    sd = np.std(c[ok]) + 1e-9
    z = (c - med) / sd
    z[~ok] = np.nanmin(z) if ok.any() else 0
    return z


def nms_peaks(yaw, sc, k, nms):
    n = len(yaw)
    order = np.argsort(-sc)
    out = []
    for i in order:
        if not np.isfinite(sc[i]):
            continue
        if not (sc[i] >= sc[(i - 1) % n] and sc[i] >= sc[(i + 1) % n]):
            continue
        if all(abs(dang(yaw[i], yaw[j])) >= nms for j in out):
            out.append(int(i))
        if len(out) >= k:
            break
    return out


def hit_dists(hyps, refs):
    """|Δyaw|+|Δpitch| of each hyp to the nearest ref, and |Δyaw| alone."""
    d, dy = [], []
    for h in hyps:
        d.append(min(abs(dang(h["yaw"], r["pose"]["yaw"])) + abs(h["pitch"] - r["pose"]["pitch"]) for r in refs))
        dy.append(min(abs(dang(h["yaw"], r["pose"]["yaw"])) for r in refs))
    return d, dy
