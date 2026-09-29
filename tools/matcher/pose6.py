"""6-DoF pose refinement (rotation + focal + camera position) on top of the fused skyline+match solve.

Library:  refine(problem) -> result dict;   problem builders: problem_app(pid), problem_bench(id, worker)
CLI:      python pose6.py run <ids...> [--out DIR]     (tools/matcher/pose6_run.sh wraps this)

Model
  params  yaw, pitch, roll (deg), log f, E, N (m, app ENU frame of the start position), a (m above ground)
          eye = (E, N, ground(E, N) + clip(a, AGL_FLOOR, cap)); ground from Mapterhorn only (dem.py).
  data    the two Huber terms of fusion.py, re-evaluated at the moving eye:
          - skyline: DEM horizon ray-marched in Python at the current eye (dem.py), associated ICP-style
            with the app's skyline score map (exported by the app for the start position);
          - match: the lifted 2D–3D matches, 3D points held fixed in world coordinates.
          Each term is normalised to N_EFF effective samples (σ from the single-cue fits at the start eye).
  priors  focal (log f, σ 5 % if the focal is known, else 15 %); horizontal position (σ_H = 30 m for
          EXIF GPS, 400 m for hand-placed); height above ground: one-sided soft prior (a − ref)/3 m with
          ref = max(1.6, start AGL), hard cap max(10, start AGL), floor 1.5 m (eye.ts clearance;
          was 1.0 until the GT-12 check showed eyes parked at 1.0 m on slopes, IMG_7155).
  regimes A (exif-gps / app photos): LM from the fused pose at the start eye.
          B (manual): 9×9 grid ±1000 m (250 m spacing) at ground + ref; per node a coarse rotation search on
            the app skyline score (yaw ±15°, pitch ±3°); the 10 nodes with the best coarse score get the
            rotation-only fused LM and the comparable cost N_EFF·selection + priors (basin gap is computed
            over these). Top-3 basins (NMS 1.5 spacings) are refined with the 6-DoF LM; lowest cost wins.
            Re-render at the final eye to confirm.
  gate    the result replaces the start (the fused pose at the given position, unchanged) only if it lowers
          the comparable cost (N_EFF·selection + priors) by MIN_GAIN = 5 below BOTH the start and a
          rotation-only re-solve at the start eye — i.e. only a gain that needs the position move counts
          [added after the GT-12 run, before any dev run: on IMG_7059 the re-solve drifted 0.8° in yaw
          with no real position change].

CONFIDENCE RULE — fixed on 2026-09-25 BEFORE looking at any dev verdict/overlay outcome of new poses:
  HIGH iff all hold, else LOW:
   1. fusion checks at the final eye: d_agree (skyline-only vs match-only rotation, both re-solved at
      the final eye) < 1°, skyline median |r| < 4 px, match support (share of lifted matches within 6 px)
      ≥ 0.3  — the thresholds of reports/fusion.md, unchanged;
   2. eye not pushed onto the height cap: NOT (final AGL ≥ cap − 0.5 m and final AGL > start AGL + 0.5 m)
      [amended after the GT-12 run, before any dev run: as first written, an eye whose GPS altitude
      already sits > 10 m above the DEM (cap = start AGL) was "on the cap" without moving: IMG_7130/7131];
   3. horizontal shift ≤ 3 σ_H (90 m EXIF, 1200 m hand-placed);
   4. regime B: basin gap (c2 − c1)/c1 ≥ 0.15, c1 the best grid node cost, c2 the best node ≥ 2 spacings
      away;
   5. if the eye moved > 10 m horizontally (always in regime B): re-render confirmation — the app's own
      horizon at the final eye (render_worker at the new lat/lon/alt) gives skyline median |r| < 4 px
      at the final pose.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path

import numpy as np
from scipy.optimize import least_squares

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import dem as DM  # noqa: E402
import fusion as F  # noqa: E402
from common import R_to_pose, dang, focal_px, pose_to_R, vfov_from_f  # noqa: E402

N_EFF = 60.0
SIGMA_H = {"exif": 30.0, "manual": 400.0}
GRID_R, GRID_N = 1000.0, 9
AGL_NOMINAL, AGL_SIGMA, AGL_MAX, AGL_FLOOR = 1.6, 3.0, 10.0, 1.5  # floor as eye.ts clearance
FOCAL_SIGMA = {True: 0.05, False: 0.15}
BASIN_GAP = 0.15
CONFIRM_PX = 4.0
TOPK = 3
GRID_THREADS = int(__import__('os').environ.get('POSE6_GRID_THREADS', 6))
NODE_LM = 10  # grid nodes (best coarse skyline score) that get the rotation LM + comparable cost
MIN_GAIN = 5.0  # comparable-cost units (N_EFF-scaled); eye.ts review suggested minGain 5–10
STEPS = np.array([0.003, 0.003, 0.003, 3e-4, 0.5, 0.5, 0.3])  # numeric Jacobian steps


# ---------------------------------------------------------------- problem

class Problem:
    """Everything the solver needs for one photo. eye0 is in the app ENU frame of (lat0, lon0)."""

    def __init__(self, pid, W, H, sk, corr, eye0, lat0, lon0, pose0, focal_known, regime, meta=None,
                 fast=False):
        """fast=True (the service's basin-gap check): horizon sector only as wide as the ±15° yaw search
        needs and azimuth step 2× coarser (gaps reproduce on dev to ±0.01, reports/position.md)."""
        self.pid, self.W, self.H = pid, W, H
        self.sk, self.corr = sk, corr
        self.eye0 = np.asarray(eye0, float)
        self.lat0, self.lon0 = lat0, lon0
        self.pose0 = dict(pose0)
        self.focal_known = focal_known
        self.f0 = focal_px(pose0["vfov"], H)
        self.fsig = FOCAL_SIGMA[bool(focal_known)]
        self.regime = regime
        self.sigmaH = SIGMA_H[regime]
        self.meta = meta or {}
        self.hfov = 2 * math.degrees(math.atan(math.tan(math.radians(pose0["vfov"]) / 2) * W / H))
        extent = GRID_R + 300 if regime == "manual" else 300
        self.dem = DM.Dem(lat0, lon0, extent)
        g0 = float(self.dem.ground(self.eye0[0], self.eye0[1]))
        self.agl0 = float(self.eye0[2] - g0)
        self.agl_ref = max(AGL_NOMINAL, self.agl0)
        self.cap = max(AGL_MAX, self.agl0)
        half = self.hfov / 2 + min(35.0, max(6.0, 2.5 * self.hfov))
        if fast:
            half = min(half, self.hfov / 2 + 17.0)
        self.az0 = pose0["yaw"] - half
        self.az1 = pose0["yaw"] + half
        self.azstep = float(np.clip(self.hfov / W, 0.004, 0.05)) * (2.0 if fast else 1.0)
        self.grow = 0.004  # coarser distance steps changed the basin gap on dev (0.008: wc_0027 0.21→0.12)
        self._hz = {}
        self.n_horizon = 0
        # Delta horizon: the app's own horizon at the start eye (what fusion used) plus the change the
        # Python ray-march predicts between the start eye and the current eye. At zero shift the model is
        # exactly fusion's; the Python DEM only supplies the parallax (it differs from the app's mesh by
        # up to ~1.5° in the near field, e.g. IMG_7059, so it is not used absolutely).
        self._py0 = self.dem.horizon(self.eye0, self.az0, self.az1, self.azstep, grow=self.grow)
        self.base_el = self._app_el(sk["dirs"], self._py0)

    def _app_el(self, dirs, py0):
        az = py0["az"]
        a = (np.degrees(np.arctan2(dirs[:, 0], dirs[:, 1])) - self.az0) % 360
        el = np.degrees(np.arcsin(np.clip(dirs[:, 2], -1, 1)))
        k = np.round(a / self.azstep).astype(int)
        ok = (k >= 0) & (k < len(az))
        out = np.full(len(az), -np.inf)
        np.maximum.at(out, k[ok], el[ok])
        good = np.isfinite(out)
        if good.sum() < 10:
            return py0["el"].copy()
        idx = np.arange(len(az))
        out[~good] = np.interp(idx[~good], idx[good], out[good])
        # outside the app's coverage, fall back to the ray-march
        lo, hi = idx[good].min(), idx[good].max()
        out[:lo] = py0["el"][:lo]
        out[hi + 1:] = py0["el"][hi + 1:]
        return out

    # eye / horizon ---------------------------------------------------------
    def eye(self, E, N, a):
        g = float(self.dem.ground(E, N))
        return np.array([E, N, g + float(np.clip(a, AGL_FLOOR, self.cap))])

    def horizon(self, eye):
        key = tuple(np.round(np.asarray(eye) / 0.1).astype(int))
        h = self._hz.get(key)
        if h is None:
            py = self.dem.horizon(eye, self.az0, self.az1, self.azstep, grow=self.grow)
            el = np.radians(self.base_el + (py["el"] - self._py0["el"]))
            az = np.radians(py["az"])
            h = {**py, "el": np.degrees(el),
                 "dirs": np.stack([np.sin(az) * np.cos(el), np.cos(az) * np.cos(el), np.sin(el)], 1)}
            self.n_horizon += 1
            if len(self._hz) > 4000:
                self._hz.clear()
            self._hz[key] = h
        return h

    def sky_at(self, eye):
        return {**self.sk, "dirs": self.horizon(eye)["dirs"]}

    def enu_to_geo(self, E, N):
        lon, lat = self.dem.geo(E, N)
        return float(lat), float(lon)


def xfull(pose, E, N, a, H):
    return np.r_[F.x_from_pose(pose, H), E, N, a]


def pose_of(p, H):
    return F.pose_from_x(p[:4], H)


# ---------------------------------------------------------------- terms

def sigmas(prob: Problem, x4, eye):
    """σ per term from single-cue fits at this eye (as fusion.solve_photo)."""
    sk = prob.sky_at(eye)
    sig = {"sky": 2.0, "match": 2.0}
    s = F.solve(x4, prob.W, prob.H, prob.f0, sk=sk, use_match=False)
    if s and "sky" in s[1]:
        sig["sky"] = s[1]["sky"]["sigma"]
    if prob.corr is not None and len(prob.corr["x2d"]) >= 6:
        m = F.solve(x4, prob.W, prob.H, prob.f0, c=prob.corr, eye=eye, use_sky=False)
        if m and "match" in m[1]:
            sig["match"] = m[1]["match"]["sigma"]
    return sig


def total_cost(prob: Problem, p, sig):
    """Comparable cost: N_EFF·fusion selection cost at the eye + position/AGL/focal priors."""
    eye = prob.eye(*p[4:7])
    sel = F.selection_cost(p[:4], prob.sky_at(eye), prob.corr, eye, prob.W, prob.H, sig)
    return N_EFF * sel + prior_sq(prob, p)


def prior_res(prob: Problem, p):
    E, N, a = p[4:7]
    a = float(np.clip(a, AGL_FLOOR, prob.cap))
    return np.array([(p[3] - math.log(prob.f0)) / prob.fsig, E / prob.sigmaH, N / prob.sigmaH,
                     max(0.0, a - prob.agl_ref) / AGL_SIGMA])


def prior_sq(prob, p):
    return float(np.sum(prior_res(prob, p) ** 2))


def solve6(prob: Problem, p0, sig, move=True, iters=len(F.WINS)):
    """Outer: re-associate skyline, re-gate matches, IRLS weights; inner: LM over the 7 (or 4) params."""
    p = np.array(p0, float)
    W, H, c = prob.W, prob.H, prob.corr
    idx = list(range(7)) if move else [0, 1, 2, 3]
    info = {}
    for it in range(iters):
        eye = prob.eye(*p[4:7])
        sk = prob.sky_at(eye)
        parts = []
        cu, tgt, _ = F.sky_associate(p[:4], sk, W, H, F.WINS[it])
        if len(cu) >= 10:
            r = F.sky_resid(p[:4], sk, W, H, cu, tgt)
            parts.append(("sky", cu, tgt, F.huber_sqrt_w(r / sig["sky"])))
        if c is not None and len(c["x2d"]):
            r = F.match_resid(p[:4], c, eye)
            g = np.linalg.norm(r, axis=1) < F.GATES[it]
            if g.sum() >= 6:
                parts.append(("match", g, None, F.huber_sqrt_w(r[g].ravel() / sig["match"])))
        if not parts:
            return None
        info["n"] = {k[0]: int(len(k[1]) if k[0] == "sky" else k[1].sum()) for k in parts}

        def res(q):
            pp = p.copy()
            pp[idx] = q
            e = prob.eye(*pp[4:7])
            out = []
            for name, a, b, wsq in parts:
                if name == "sky":
                    rr = F.sky_resid(pp[:4], prob.sky_at(e), W, H, a, b)
                    out.append(wsq * rr / sig["sky"] * math.sqrt(N_EFF / len(rr)))
                else:
                    cc = {"x2d": c["x2d"][a], "X": c["X"][a], "W": W, "H": H}
                    rr = F.match_resid(pp[:4], cc, e).ravel()
                    out.append(wsq * rr / sig["match"] * math.sqrt(N_EFF / (len(rr) / 2)))
            pr = prior_res(prob, pp)
            out.append(pr if move else pr[:1])
            return np.concatenate(out)

        def jac(q):
            r0 = res(q)
            J = np.empty((len(r0), len(q)))
            for j in range(len(q)):
                dq = q.copy()
                dq[j] += STEPS[idx[j]]
                J[:, j] = (res(dq) - r0) / STEPS[idx[j]]
            return J

        sol = least_squares(res, p[idx], jac=jac, method="trf", max_nfev=40, x_scale=STEPS[idx] * 30)
        p[idx] = sol.x
        p[6] = float(np.clip(p[6], AGL_FLOOR, prob.cap))
        info["cost"] = float(sol.cost)
    return p, info


# ---------------------------------------------------------------- rotation search at a fixed eye

def rot_batch(poses):
    """pose_to_R for many poses at once (K×3×3), same convention as common.pose_basis."""
    D = math.pi / 180
    y = np.array([p["yaw"] for p in poses]) * D
    pt = np.array([p["pitch"] for p in poses]) * D
    r = np.array([p["roll"] for p in poses]) * D
    f = np.stack([np.sin(y) * np.cos(pt), np.cos(y) * np.cos(pt), np.sin(pt)], 1)
    r0 = np.stack([np.cos(y), -np.sin(y), np.zeros_like(y)], 1)
    u0 = np.cross(r0, f)
    right = r0 * np.cos(r)[:, None] - u0 * np.sin(r)[:, None]
    up = u0 * np.cos(r)[:, None] + r0 * np.sin(r)[:, None]
    return np.stack([right, -up, f], 1)


def rot_search(prob: Problem, eye, seed_pose, yaw_win=15.0, pitch_win=3.0):
    """Coarse yaw×pitch search on the app skyline score (mean S along the projected skyline).
    Vectorised over candidates (same candidates and score as the original per-candidate loop)."""
    sk = prob.sky_at(eye)
    S, w, h = sk["S"], sk["w"], sk["h"]
    dirs = sk["dirs"]
    W, H = prob.W, prob.H
    f = focal_px(seed_pose["vfov"], H)
    ystep = max(0.05, min(0.25, prob.hfov / 100))
    pstep = max(0.1, min(0.5, prob.hfov / 60))
    poses = [{**seed_pose, "yaw": seed_pose["yaw"] + dy, "pitch": seed_pose["pitch"] + dp}
             for dy in np.arange(-yaw_win, yaw_win + 1e-9, ystep)
             for dp in np.arange(-pitch_win, pitch_win + 1e-9, pstep)]
    scores = np.full(len(poses), -np.inf)
    B = max(1, int(4e6 // max(len(dirs), 1)))
    for b0 in range(0, len(poses), B):
        Rs = rot_batch(poses[b0:b0 + B])  # K×3×3
        c = np.matmul(dirs[None, :, :], Rs.transpose(0, 2, 1))
        z = c[..., 2]
        ok = z > 0.1
        zs = np.where(ok, z, 1.0)
        u = (W / 2 + f * c[..., 0] / zs) / W * w
        v = (H / 2 + f * c[..., 1] / zs) / H * h
        k = ok & (u >= 0) & (u < w) & (v >= 0) & (v < h)
        K = len(Rs)
        rows = np.full((K, w), np.inf)
        kk, nn = np.nonzero(k)
        np.minimum.at(rows, (kk, u[kk, nn].astype(int)), v[kk, nn])
        fin = np.isfinite(rows)
        ri = np.where(fin, rows, 0).astype(int)
        vals = np.where(fin, S[ri, np.arange(w)[None, :]], 0.0)
        ncol = fin.sum(1)
        with np.errstate(invalid="ignore", divide="ignore"):
            sc = vals.sum(1) / np.maximum(ncol, 1) * np.minimum(1.0, ncol / (0.6 * w))
        sc[k.sum(1) < 20] = -np.inf
        scores[b0:b0 + K] = sc
    order = np.argsort(-scores, kind="stable")
    out = []
    for i in order:
        if not np.isfinite(scores[i]):
            break
        pose = poses[i]
        if all(abs(dang(pose["yaw"], q["yaw"])) > 1.0 or abs(pose["pitch"] - q["pitch"]) > 1.0 for _, q in out):
            out.append((float(scores[i]), pose))
        if len(out) >= 3:
            break
    return out


def node_solve(prob: Problem, E, N, seed_pose, sig):
    """Best rotation at a fixed eye (grid node): coarse search, then rotation-only LM from the top hypotheses."""
    a = prob.agl_ref
    eye = prob.eye(E, N, a)
    best = None
    for _, pose in rot_search(prob, eye, seed_pose):
        p0 = xfull(pose, E, N, a, prob.H)
        s = solve6(prob, p0, sig, move=False)
        if not s:
            continue
        cst = total_cost(prob, s[0], sig)
        if best is None or cst < best[1]:
            best = (s[0], cst)
    return best


# ---------------------------------------------------------------- checks

def agreement(prob: Problem, p, sig):
    """d_agree, sky_med, match_support at the final eye (as fusion.solve_photo, re-solved at this eye)."""
    import match as M
    eye = prob.eye(*p[4:7])
    sk = prob.sky_at(eye)
    x4 = p[:4]
    s = F.solve(x4, prob.W, prob.H, prob.f0, sk=sk, use_match=False, sigma={"sky": sig["sky"]})
    sky_pose = F.pose_from_x(s[0], prob.H) if s else None
    m_pose = None
    c = prob.corr
    if c is not None and len(c["x2d"]) >= 6:
        rs = M.solve_rotation(c["x2d"], c["X"], eye, prob.W, prob.H, math.exp(x4[3]), False)
        if rs is not None:
            rp = R_to_pose(rs["R"], F.pose_from_x(x4, prob.H)["vfov"])
            m = F.solve(F.x_from_pose(rp, prob.H), prob.W, prob.H, prob.f0, c=c, eye=eye, use_sky=False, sigma={"match": sig["match"]})
            m_pose = F.pose_from_x(m[0], prob.H) if m else rp
    d = F.rot_angle(sky_pose, m_pose) if (sky_pose and m_pose) else None
    diag = F.diagnostics(x4, sk, c, eye, prob.W, prob.H)
    return {"d_agree": d, "sky_med": diag.get("sky_med"), "match_support": diag.get("match_support"),
            "skyPose": sky_pose, "matchPose": m_pose}


def sky_med_with(prob: Problem, pose, sk_app):
    """Skyline median |r| (px) of `pose` against an independent (re-rendered app) skyline cue."""
    x4 = F.x_from_pose(pose, prob.H)
    return F.diagnostics(x4, sk_app, None, None, prob.W, prob.H).get("sky_med")


def grid_search(prob: Problem, sig, grid_r=None, grid_n=None, node_lm=None, cancel=None):
    """Regime-B position grid around the start eye: coarse rotation search per node, rotation LM +
    comparable cost on the best `node_lm` nodes. Returns (evaluated nodes sorted by cost, grid info) or
    (None, None). grid info carries the basin gap (c2 − c1)/c1, c2 = best node ≥ 2 spacings from the best."""
    grid_r = GRID_R if grid_r is None else grid_r
    grid_n = GRID_N if grid_n is None else grid_n
    node_lm = NODE_LM if node_lm is None else node_lm
    E0, N0 = float(prob.eye0[0]), float(prob.eye0[1])
    step = 2 * grid_r / (grid_n - 1)
    pts = [(E0 - grid_r + i * step, N0 - grid_r + j * step) for i in range(grid_n) for j in range(grid_n)]

    import threading
    stop = threading.Event()

    def node(en):
        if stop.is_set():
            return None
        E, N = en
        return E, N, rot_search(prob, prob.eye(E, N, prob.agl_ref), prob.pose0)

    # horizon ray-march + coarse search per node are independent numpy work (GIL released in the
    # large array ops): a thread pool gives the same result, in node order, ~3× faster.
    # cancel() (raises to abort) is polled by this thread while the pool works; a shared Event makes
    # the pending nodes return at once.
    from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
    with ThreadPoolExecutor(max_workers=GRID_THREADS) as ex:
        futs = [ex.submit(node, en) for en in pts]
        pending = set(futs)
        try:
            while pending:
                _, pending = wait(pending, timeout=0.25, return_when=FIRST_COMPLETED)
                if cancel is not None:
                    cancel()
        except BaseException:
            stop.set()
            for f in futs:
                f.cancel()
            raise
        res = [f.result() for f in futs]
    res = [r for r in res if r is not None]
    nodes = [{"E": E, "N": N, "coarse": hyps[0][0], "hyps": hyps} for E, N, hyps in res if hyps]
    if not nodes:
        return None, None
    nodes.sort(key=lambda n: -n["coarse"])
    ev = []
    for n in nodes[:node_lm]:
        if cancel is not None:
            cancel()
        bestn = None
        for _, pose in n["hyps"]:
            p0 = xfull(pose, n["E"], n["N"], prob.agl_ref, prob.H)
            r = solve6(prob, p0, sig, move=False)
            if r:
                cst = total_cost(prob, r[0], sig)
                if bestn is None or cst < bestn[1]:
                    bestn = (r[0], cst)
        if bestn:
            ev.append({"E": n["E"], "N": n["N"], "p": bestn[0], "cost": bestn[1]})
    ev.sort(key=lambda n: n["cost"])
    if not ev:
        return None, None
    c1 = ev[0]["cost"]
    far = [n for n in ev if math.hypot(n["E"] - ev[0]["E"], n["N"] - ev[0]["N"]) >= 2 * step - 1e-6]
    c2 = far[0]["cost"] if far else math.inf
    gap = (c2 - c1) / max(abs(c1), 1e-9)
    grid = {"step": step, "n": len(nodes), "evaluated": len(ev), "best": {k: ev[0][k] for k in ("E", "N", "cost")},
            "second": {k: far[0][k] for k in ("E", "N", "cost")} if far else None, "gap": gap,
            "coarseMap": [[round(n["E"]), round(n["N"]), round(float(n["coarse"]), 4)] for n in nodes],
            "costs": [[round(n["E"]), round(n["N"]), round(n["cost"], 2)] for n in ev]}
    return ev, grid


def basin_gap(prob: Problem, grid_r=None, grid_n=None, node_lm=None, cancel=None) -> dict:
    """Stand-alone basin-gap check (for the service's LOW trigger): σ from the single-cue fits at the
    start eye, then grid_search. No new renders — only the given skyline cue, matches and the DEM."""
    t0 = time.time()
    x4 = F.x_from_pose(prob.pose0, prob.H)
    sig = sigmas(prob, x4, prob.eye0)
    ev, grid = grid_search(prob, sig, grid_r, grid_n, node_lm, cancel)
    return {"gap": grid["gap"] if grid else None, "grid": grid, "sigma": sig, "ms": round((time.time() - t0) * 1000),
            "horizons": prob.n_horizon}


# ---------------------------------------------------------------- main solve

def refine(prob: Problem, confirm=None) -> dict:
    """confirm(lat, lon, h, pose) -> app skyline dict at that eye (or None): re-render check."""
    t0 = time.time()
    H = prob.H
    E0, N0 = float(prob.eye0[0]), float(prob.eye0[1])
    p_start = xfull(prob.pose0, E0, N0, prob.agl0, H)
    sig = sigmas(prob, p_start[:4], prob.eye0)
    out = {"id": prob.pid, "regime": prob.regime, "sigma": sig, "start": {"pose": prob.pose0, "eyeEnu": prob.eye0.tolist(), "agl": prob.agl0}}
    grid = None
    if prob.regime == "exif":
        cands = [p_start]
    else:
        ev, grid = grid_search(prob, sig)
        if ev is None:
            return {**out, "error": "no grid node could be solved"}
        step = grid["step"]
        picks = []
        for n in ev:
            if all(math.hypot(n["E"] - q["E"], n["N"] - q["N"]) > 1.5 * step for q in picks):
                picks.append(n)
            if len(picks) >= TOPK:
                break
        cands = [n["p"] for n in picks]
    best = None
    for p0 in cands:
        s = solve6(prob, p0, sig, move=True)
        if not s:
            continue
        cst = total_cost(prob, s[0], sig)
        if best is None or cst < best[1]:
            best = (s[0], cst)
    # gain gate: the start (the fused pose at the given position, unrefined) stays unless the refined
    # 6-DoF pose lowers the comparable cost by MIN_GAIN (as eye.ts's minGain, in N_EFF units)
    c_start = total_cost(prob, p_start, sig)
    rot = solve6(prob, p_start, sig, move=False)
    c_rot = total_cost(prob, rot[0], sig) if rot else c_start
    out["costStart"], out["costRotOnly"] = c_start, c_rot
    if best is None or best[1] > min(c_start, c_rot) - MIN_GAIN:
        out["keptStart"] = True
        best = (p_start, c_start)
    p, cst = best
    eye = prob.eye(*p[4:7])
    pose = pose_of(p, H)
    lat, lon = prob.enu_to_geo(eye[0], eye[1])
    shift = math.hypot(eye[0] - E0, eye[1] - N0)
    agl = float(eye[2] - prob.dem.ground(eye[0], eye[1]))
    ag = agreement(prob, p, sig)
    checks = {
        "d_agree": ag["d_agree"], "sky_med": ag["sky_med"], "match_support": ag["match_support"],
        "agl": agl, "cap": prob.cap, "onCap": agl >= prob.cap - 0.5 and agl > prob.agl0 + 0.5,
        "shiftM": shift, "shiftSigma": shift / prob.sigmaH,
        "basinGap": grid["gap"] if grid else None,
        "confirmSkyMedPx": None,
    }
    need_confirm = prob.regime == "manual" or shift > 10
    if need_confirm and confirm is not None:
        try:
            sk_app = confirm(lat, lon, float(eye[2]), pose)
            checks["confirmSkyMedPx"] = sky_med_with(prob, pose, sk_app) if sk_app else None
        except Exception as e:  # noqa: BLE001
            checks["confirmError"] = str(e)[:200]
    c = checks
    ok = [
        c["d_agree"] is not None and c["d_agree"] < 1.0,
        c["sky_med"] is not None and c["sky_med"] < 4.0,
        (c["match_support"] or 0) >= 0.3,
        not c["onCap"],
        c["shiftSigma"] <= 3.0,
        prob.regime != "manual" or (c["basinGap"] is not None and c["basinGap"] >= BASIN_GAP),
        (not need_confirm) or (c["confirmSkyMedPx"] is not None and c["confirmSkyMedPx"] < CONFIRM_PX),
    ]
    names = ["agree<1", "skyMed<4", "support>=0.3", "notOnCap", "shift<=3sigma", "basinGap", "confirm"]
    c["failed"] = [n for n, k in zip(names, ok) if not k]
    level = "HIGH" if all(ok) else "LOW"
    out.update(pose=pose, eye={"lat": lat, "lon": lon, "h": float(eye[2])}, eyeEnu=eye.tolist(), confidenceLevel=level,
               checks=checks, cost=cst, grid=grid, horizons=prob.n_horizon, sec=time.time() - t0)
    return out


# ---------------------------------------------------------------- problem builders

def problem_app(pid: str) -> Problem:
    """GT-12 photo: app skyline export (out/skyline), s0 correspondences (out/corr), fused pose (fusion_default)."""
    from common import load_meta
    meta = load_meta(pid)
    sk = F.load_skyline(pid, 0)
    corr = F.load_corr(pid, "s0")
    fr = next(r for r in json.loads((HERE / "out" / "results" / "fusion_default.json").read_text()) if r["id"] == pid and r["shift"] == 0)
    W, H = fr["W"], fr["H"]
    return Problem(pid, W, H, sk, corr, meta["eye"], meta["frame"]["lat"], meta["frame"]["lon"], fr["fused"]["pose"], True, "exif", meta)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["run"])
    ap.add_argument("ids", nargs="+")
    ap.add_argument("--out", default=str(ROOT / "tools" / "bench" / "t5"))
    ap.add_argument("--no-confirm", action="store_true")
    a = ap.parse_args()
    import pose6_inputs as PI
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    worker = None
    try:
        for pid in a.ids:
            t0 = time.time()
            try:
                if pid.startswith("IMG_"):
                    prob = problem_app(pid)
                    need_worker = not a.no_confirm
                else:
                    worker = worker or PI.start_worker()
                    prob = PI.problem_bench(pid, worker)
                    need_worker = True
                if need_worker and worker is None:
                    worker = PI.start_worker()
                confirm = None if a.no_confirm else PI.make_confirm(pid, prob, worker)
                res = refine(prob, confirm)
            except Exception as e:  # noqa: BLE001
                res = {"id": pid, "error": f"{type(e).__name__}: {e}"[:500]}
            res["wallSec"] = time.time() - t0
            (out / f"{pid}.json").write_text(json.dumps(res, indent=1, default=float))
            c = res.get("checks") or {}
            print(f"{pid}: {res.get('confidenceLevel', 'ERR')} shift {c.get('shiftM', float('nan')):.0f} m agl {c.get('agl', float('nan')):.1f} "
                  f"failed {c.get('failed')} {res.get('error', '')} ({res['wallSec']:.0f}s)", flush=True)
    finally:
        if worker is not None:
            worker.close()


if __name__ == "__main__":
    main()
