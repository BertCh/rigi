"""X2 pose scores between a photo's monocular geometry and a render's exact depth at a pose.

Everything lives on a canonical *score grid*: native render pixels (G*c + 0.5, G*r + 0.5), G = GRID_STRIDE (native px),
i.e. ~256 px wide for a 1024-px-wide native render.  Photo-side maps are nearest-sampled at the same native positions.

Render side comes either from a cached view (xyz.npz, stride 2) or from a ring panorama (rotation-only resampling of
the 24 ring views at the stated eye) for arbitrary poses (yaw scans, matcher-solved poses).
"""
from __future__ import annotations
import _env  # noqa: F401
import math, sys
import numpy as np, cv2
from scipy.stats import rankdata

sys.path.insert(0, str(_env.TM / "c0_cache"))
import cache_io as C  # noqa: E402

D = math.pi / 180
GRID_STRIDE = 4
SKY_LOG = 30.0           # log-depth assigned to sky when sky is treated as "farthest"

# ---- fixed design (chosen on odd ids; see REPORT.md) ----
CFG = dict(
    near_m=100.0,         # drop photo pixels whose MoGe-L metric depth is below this (m); 0 = off
    near_q=0.0,          # drop photo pixels whose predicted depth is below this quantile of the photo's terrain depths
    edge_tau_r=0.15,     # render discontinuity: |Δ log d| between grid neighbours
    edge_tau_p=0.10,     # prediction discontinuity threshold (log units)
    edge_sigma=2.0,      # chamfer sigma (grid px)
    ord_delta=0.05,      # pred pairs need |Δ log d| > delta (or one sky)
    n_pairs=20000,
)


# ------------------------------------------------------------------ grids
def grid_uv(W, H, G=GRID_STRIDE):
    h, w = H // G, W // G
    jj, ii = np.mgrid[0:h, 0:w]
    return ii * G + 0.5, jj * G + 0.5


def photo_maps(g: dict, W, H, sky_from=None):
    P = _photo_maps(g, W, H, sky_from)
    ref = _photo_maps(sky_from, W, H, sky_from) if sky_from is not None else P
    P["near_logd"] = ref["logd"]   # MoGe-L metric log-depth for the near-field mask
    return P


def _photo_maps(g: dict, W, H, sky_from=None):
    """Sample photo geometry npz (768-wide grid over the photo) at the score grid of a W×H native render.
    Returns dict(logd (nan=sky), sky, normal or None)."""
    d = g["depth"].astype(np.float32)
    gh, gw = d.shape
    u, v = grid_uv(W, H)
    x = np.clip(np.round(u * gw / W - 0.5).astype(int), 0, gw - 1)
    y = np.clip(np.round(v * gh / H - 0.5).astype(int), 0, gh - 1)
    sk = ~(sky_from if sky_from is not None else g)["mask"][y, x]
    dd = d[y, x]
    sk |= ~(dd > 0)
    logd = np.where(sk, np.nan, np.log(np.maximum(dd, 1e-6)))
    n = g["normal"].astype(np.float32)[y, x] if "normal" in g else None
    return {"logd": logd, "sky": sk, "normal": n}


# ------------------------------------------------------------------ render side
def render_maps_from_xyz(xyz_grid, eye, pose, valid=None):
    """xyz on the score grid (h,w,3), zeros = sky. Returns dict(logd, sky, normal(cam), valid)."""
    X = xyz_grid.astype(np.float64)
    sky = ~(X != 0).any(-1)
    V = X - np.asarray(eye, float)
    dist = np.linalg.norm(V, axis=-1)
    logd = np.where(sky, np.nan, np.log(np.maximum(dist, 1e-3)))
    # normals by central differences on the grid, invalid across discontinuities / sky
    n = np.full(X.shape, np.nan)
    dx = X[1:-1, 2:] - X[1:-1, :-2]
    dy = X[2:, 1:-1] - X[:-2, 1:-1]
    nn = np.cross(dx, dy)
    nn /= np.linalg.norm(nn, axis=-1, keepdims=True) + 1e-12
    ld = np.where(sky, np.inf, logd)
    c = ld[1:-1, 1:-1]
    ok = (np.abs(ld[1:-1, 2:] - c) < 0.05) & (np.abs(ld[1:-1, :-2] - c) < 0.05) & (np.abs(ld[2:, 1:-1] - c) < 0.05) & \
         (np.abs(ld[:-2, 1:-1] - c) < 0.05) & np.isfinite(c)
    s = np.sign((nn * V[1:-1, 1:-1]).sum(-1))  # face the camera: n·(X-eye) < 0
    nn = nn * (-s)[..., None]
    nn[~ok] = np.nan
    n[1:-1, 1:-1] = nn
    ncam = n @ C.pose_to_R(pose).T
    if valid is None:
        valid = np.ones(sky.shape, bool)
    return {"logd": logd, "sky": sky, "normal": ncam, "valid": valid}


def view_xyz_grid(rec):
    """Score-grid xyz from a cached view (xyz stride 2 → take every GRID_STRIDE/2)."""
    s = rec["files"]["xyz"]["stride"]
    k = GRID_STRIDE // s
    W, H = rec["W"], rec["H"]
    h, w = H // GRID_STRIDE, W // GRID_STRIDE
    return rec["xyz"][::k, ::k][:h, :w]


class Pano:
    """Equirectangular xyz panorama from the 24 ring views (stated eye). Rotation-only resampling."""

    def __init__(self, pid, res_deg=0.1):
        m = C.load_meta(pid)
        self.eye = np.asarray(m["eye"], float)
        self.aspect = m["aspect"]
        vr = m["ring"]["vfov"]
        self.res = res_deg
        self.el0 = -vr / 2
        naz, nel = int(round(360 / res_deg)), int(math.floor(vr / res_deg))
        az = (np.arange(naz) + 0.5) * res_deg
        el = self.el0 + (np.arange(nel) + 0.5) * res_deg
        AZ, EL = np.meshgrid(az * D, el * D)
        dirs = np.stack([np.sin(AZ) * np.cos(EL), np.cos(AZ) * np.cos(EL), np.sin(EL)], -1)
        pano = np.zeros((nel, naz, 3), np.float32)
        filled = np.zeros((nel, naz), bool)
        views = {v["tag"]: v for v in m["views"]["ring"]}
        step = m["ring"]["stepDeg"]
        k = np.round(((AZ / D) % 360) / step).astype(int) % int(360 / step)
        for t in range(int(360 / step)):
            tag = f"y{t * step:03d}"
            sel = k == t
            if tag not in views:
                continue
            if views[tag].get("empty"):   # all-sky ring view (worker skipped it): covered, no terrain
                filled[sel] = True
                continue
            rec = C.load_view(pid, "ring", tag)
            k_ = rec["intrinsics"]
            c = dirs[sel] @ C.pose_to_R(rec["pose"]).T
            u = k_["cx"] + k_["fx"] * c[:, 0] / c[:, 2]
            vv = k_["cy"] + k_["fy"] * c[:, 1] / c[:, 2]
            s = rec["files"]["xyz"]["stride"]
            cc = np.round((u - 0.5) / s).astype(int)
            rr = np.round((vv - 0.5) / s).astype(int)
            xh, xw = rec["xyz"].shape[:2]
            ok = (c[:, 2] > 0) & (cc >= 0) & (cc < xw) & (rr >= 0) & (rr < xh)
            idx = np.nonzero(sel)
            pano[idx[0][ok], idx[1][ok]] = rec["xyz"][rr[ok], cc[ok]]
            filled[idx[0][ok], idx[1][ok]] = True
        self.xyz, self.filled = pano, filled
        self.naz, self.nel = naz, nel

    def sample(self, pose, W, H):
        """Score-grid xyz + valid mask for pose (native size W×H)."""
        u, v = grid_uv(W, H)
        k_ = C.intrinsics(pose["vfov"], W, H, self.aspect)
        d = np.stack([(u - k_["cx"]) / k_["fx"], (v - k_["cy"]) / k_["fy"], np.ones_like(u, dtype=float)], -1) @ C.pose_to_R(pose)
        d /= np.linalg.norm(d, axis=-1, keepdims=True)
        az = (np.degrees(np.arctan2(d[..., 0], d[..., 1])) % 360)
        el = np.degrees(np.arcsin(np.clip(d[..., 2], -1, 1)))
        ia = np.floor(az / self.res).astype(int) % self.naz
        ie = np.floor((el - self.el0) / self.res).astype(int)
        ok = (ie >= 0) & (ie < self.nel)
        iec = np.clip(ie, 0, self.nel - 1)
        xyz = self.xyz[iec, ia]
        ok &= self.filled[iec, ia]
        xyz = np.where(ok[..., None], xyz, 0)
        return xyz, ok


# ------------------------------------------------------------------ scores
def _spearman(a, b):
    if len(a) < 50:
        return np.nan
    ra, rb = rankdata(a), rankdata(b)
    ra -= ra.mean(); rb -= rb.mean()
    return float((ra * rb).sum() / math.sqrt((ra * ra).sum() * (rb * rb).sum() + 1e-12))


_PAIRS = {}


def _pairs(h, w, local, n, seed=0):
    key = (h, w, local, n)
    if key not in _PAIRS:
        rng = np.random.default_rng(seed)
        y1 = rng.integers(0, h, n); x1 = rng.integers(0, w, n)
        if local:
            r = rng.uniform(2, 12, n); t = rng.uniform(0, 2 * np.pi, n)
            y2 = np.clip(np.round(y1 + r * np.sin(t)).astype(int), 0, h - 1)
            x2 = np.clip(np.round(x1 + r * np.cos(t)).astype(int), 0, w - 1)
        else:
            y2 = rng.integers(0, h, n); x2 = rng.integers(0, w, n)
        _PAIRS[key] = (y1, x1, y2, x2)
    return _PAIRS[key]


def _shift(A, dy, dx, fill):
    """S[y, x] = A[y+dy, x+dx] (fill outside)."""
    h, w = A.shape
    S = np.full_like(A, fill)
    ys, yd = (slice(dy, h), slice(0, h - dy)) if dy >= 0 else (slice(0, h + dy), slice(-dy, h))
    xs, xd = (slice(dx, w), slice(0, w - dx)) if dx >= 0 else (slice(0, w + dx), slice(-dx, w))
    S[yd, xd] = A[ys, xs]
    return S


def _edges(logd_skyfar, tau, internal_only, sky):
    """Discontinuity pixels (marked on the near side) + orientation (towards far side) in 8 bins."""
    L = logd_skyfar
    h, w = L.shape
    E = np.zeros((h, w), bool)
    for dy, dx in ((0, 1), (1, 0), (1, 1), (1, -1)):
        S = _shift(L, dy, dx, np.nan)
        diff = S - L
        jump = np.abs(diff) > tau
        if internal_only:
            jump &= ~sky & ~_shift(sky, dy, dx, True)
        E |= jump & (diff > 0)
        E |= _shift(jump & (diff < 0), -dy, -dx, False)
    Ls = cv2.GaussianBlur(np.nan_to_num(L, nan=SKY_LOG).astype(np.float32), (0, 0), 1.0)
    gx = cv2.Sobel(Ls, cv2.CV_32F, 1, 0, ksize=3); gy = cv2.Sobel(Ls, cv2.CV_32F, 0, 1, ksize=3)
    b = np.round(np.arctan2(gy, gx) / (np.pi / 4)).astype(int) % 8
    return E, b


def _chamfer(Ea, ba, Eb, bb, sigma, valid):
    """Mean over edges of a of exp(-d²/2σ²), d = distance to nearest b-edge with orientation within ±1 bin."""
    ya, xa = np.nonzero(Ea & valid)
    if len(ya) < 10:
        return np.nan
    dts = []
    for k in range(8):
        m = (Eb & (bb == k)).astype(np.uint8)
        if m.any():
            dts.append(cv2.distanceTransform(1 - m, cv2.DIST_L2, 3))
        else:
            dts.append(np.full(Ea.shape, 1e3, np.float32))
    kk = ba[ya, xa]
    S = np.stack(dts)
    d = np.minimum(np.minimum(S[kk, ya, xa], S[(kk + 1) % 8, ya, xa]), S[(kk - 1) % 8, ya, xa])
    return float(np.exp(-d ** 2 / (2 * sigma ** 2)).mean())


def _f(p, r):
    if not (np.isfinite(p) and np.isfinite(r)) or p + r == 0:
        return np.nan if not (np.isfinite(p) and np.isfinite(r)) else 0.0
    return 2 * p * r / (p + r)


def scores(P: dict, R: dict, cfg=CFG) -> dict:
    valid = R["valid"]
    Ps, Rs = P["sky"], R["sky"]
    out = {"n_valid": int(valid.sum())}
    if valid.sum() < 200:
        return out
    # near mask (photo side only)
    far = np.ones_like(Ps)
    if cfg["near_q"] > 0:
        t = np.nanquantile(P["logd"][~Ps], cfg["near_q"])
        far = Ps | (P["logd"] >= t)
    if cfg.get("near_m", 0) > 0:
        far = far & (Ps | ~(P["near_logd"] < math.log(cfg["near_m"])))
    v = valid & far
    # sky agreement
    iou_s = (Ps & Rs & v).sum() / max(1, ((Ps | Rs) & v).sum())
    iou_t = (~Ps & ~Rs & v).sum() / max(1, ((~Ps | ~Rs) & v).sum())
    out["sky_miou"] = float(0.5 * (iou_s + iou_t))
    # rank correlations
    tt = v & ~Ps & ~Rs
    out["rank_t"] = _spearman(P["logd"][tt], R["logd"][tt])
    PL = np.where(Ps, SKY_LOG, P["logd"]); RL = np.where(Rs, SKY_LOG, R["logd"])
    out["rank_all"] = _spearman(PL[v], RL[v])
    # ordinal pairs
    h, w = Ps.shape
    for name, local in (("ord_local", True), ("ord_global", False)):
        y1, x1, y2, x2 = _pairs(h, w, local, cfg["n_pairs"])
        ok = v[y1, x1] & v[y2, x2] & ~(Ps[y1, x1] & Ps[y2, x2])
        dp = PL[y2, x2] - PL[y1, x1]
        ok &= np.abs(dp) > cfg["ord_delta"]
        dr = RL[y2, x2] - RL[y1, x1]
        if ok.sum() < 50:
            out[name] = np.nan; continue
        agree = np.where(np.abs(dr[ok]) < 1e-9, 0.5, (np.sign(dr[ok]) == np.sign(dp[ok])).astype(float))
        out[name] = float(agree.mean())
    # discontinuities (oriented chamfer F)
    for name, internal in (("edge_int", True), ("edge_all", False)):
        Ep, bp = _edges(PL, cfg["edge_tau_p"], internal, Ps)
        Er, br = _edges(RL, cfg["edge_tau_r"], internal, Rs)
        vv = cv2.erode(valid.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)
        rec = _chamfer(Er, br, Ep, bp, cfg["edge_sigma"], vv & far)
        prec = _chamfer(Ep, bp, Er, br, cfg["edge_sigma"], vv & far)
        out[name] = _f(prec, rec)
        out[name + "_rec"] = rec; out[name + "_prec"] = prec
    # normals
    if P.get("normal") is not None:
        pn = P["normal"].astype(np.float64)
        pn = pn / (np.linalg.norm(pn, axis=-1, keepdims=True) + 1e-9)
        rn = R["normal"]
        ok = tt & np.isfinite(rn).all(-1) & (np.abs(pn).sum(-1) > 0)
        if ok.sum() > 50:
            cs = (pn[ok] * rn[ok]).sum(-1)
            out["normal_cos"] = float(np.mean(cs))
    return out


SCORE_KEYS = ["sky_miou", "rank_t", "rank_all", "ord_local", "ord_global", "edge_int", "edge_all", "normal_cos"]
