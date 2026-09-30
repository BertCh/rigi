"""GTSAM reference MAP solver for the GA1 TS port (src/lib/geocam/map) + parity test.

    PY="env PYTHONPATH=tools/research/geo/.pylib tools/matcher/.venv/bin/python"
    $PY tools/research/geo/gtsam_ref.py make          # write synthetic + real-data fixtures (inputs only)
    npx tsx tools/research/geo/ts_fixture_solve.ts out/geocam/python/fixtures/*.json   # TS results (*.ts.json)
    $PY tools/research/geo/gtsam_ref.py parity [files...]   # GTSAM vs TS -> out/geocam/python/gtsam_parity.json

The GTSAM graph mirrors the TS factors ROW BY ROW (one CustomFactor per whitened residual row) on the same
parameterisation as core/types.ts: free blocks R = (yaw, pitch, roll) deg [Vector3], F = logf [Vector1],
E = (E, N, U) m [Vector3]; fixed blocks are constants. Each row's robust loss is a gtsam mEstimator.Custom with
weight a*psi(z) and loss a*rho(z)/2 (a = TS grid thinning min(1, nEff/validRows), psi/rho = map/lm.ts), so GTSAM's
robust linearisation gives exactly the TS Gauss-Newton information sum_rows a*psi(z) J^T J. Covariance =
gtsam.Marginals (joint marginal of the free keys) on a second graph whose DATA rows carry 1/s^2,
s = max(1, 1.4826 MAD of the pooled whitened data residuals) (map/covariance.ts). Jacobians: central differences
with small steps (rotation 1e-5 deg, logf 1e-7, eye 1e-3 m); the eye-linearised skyline predictor is taken from the TS
run's exported linearisation (fixed horizons at eL and eL +- delta), as TS's last inner solve saw it.

FIXTURE FORMAT "geocam-map-fixture/1" (out/geocam/python/fixtures/<name>.json; inputs only)
  { "format", "name", "note",
    "base": {"pose": {yaw,pitch,roll,vfov}, "eye": [e,n,u], "aspect": W/H, "intr": {fScale,k1,cx,cy}},  // CameraX
    "f0Px1600": f of base at the long-side-1600 basis,
    "free": {"rotation": true, "focal": bool, "eye": bool},
    "x0": [yaw,pitch,roll,logf,E,N,U],  "truth": [7] | null,
    "opts": {"madRescale", "trustM", "maxOuter", "maxIter", "relinM"},            // solveMap options
    "factors": [
      {"type":"gps", "E0","N0","sigmaH"},                 {"type":"alt", "alt","altBias","sigmaA"},
      {"type":"ground", "plane":{"z0","gE","gN"}, "h","sigmaAbove","sigmaBelow"},   // ground(e,n) = z0+gE e+gN n
      {"type":"gravity", "pitch","roll","sigmaDeg"},      {"type":"compass", "heading","sigmaNoiseDeg","sigmaBiasDeg","nu"},
      {"type":"focal", "fPx1600","sigmaPx1600"},
      {"type":"point", "name", "corrs":[{"u","v","world":[3]}], "sigmaPx", "demSigma":"default"|null, "loss", "nEff"|null},
      {"type":"skyline", "samples":[{"u","v","w"}], "ridge":[[e,n,u]...] (polyline; horizons = TS horizonOf),
       "sigmaPx","sigmaK","loss","nEff","eye","stepM","quantumM"} ] }
  u, v normalised image coords (0..1, v down); Loss = {"kind":"l2"} | {"kind":"cauchy"|"huber","c"} |
  {"kind":"student","nu"}. TS output <name>.ts.json: see ts_fixture_solve.ts.
Agent B's own fixtures (out/geocam/fixtures/*.json, scripts/geocam/ga1-fixtures.ts) are read too when they exist and
carry this format; anything else is listed as "unsupported format".
"""
from __future__ import annotations

import glob
import json
import math
import sys
import time
from pathlib import Path

import geo_common as G  # noqa: E402  (.pylib first on sys.path)
import gtsam  # noqa: E402
import numpy as np  # noqa: E402

D = math.pi / 180
EARTH_R = 6371008.8
MIN_D = 30.0
FIXDIR = G.PYOUT / "fixtures"
B_FIXDIR = G.OUT / "fixtures"
STEPS = np.array([1e-5, 1e-5, 1e-5, 1e-7, 1e-3, 1e-3, 1e-3])
KR, KF, KE = gtsam.symbol("r", 0), gtsam.symbol("f", 0), gtsam.symbol("e", 0)
TOL = {"rotDeg": 1e-3, "logf": 1e-5, "eyeM": 0.1, "sigmaRel": 0.05}


# ---------------------------------------------------------------- camera model (mirror of camera/index.ts +
# concord/core/camera-x.ts)

def pose_basis(yaw, pitch, roll):
    y, pt, r = yaw * D, pitch * D, roll * D
    f = np.array([math.sin(y) * math.cos(pt), math.cos(y) * math.cos(pt), math.sin(pt)])
    r0 = np.array([math.cos(y), -math.sin(y), 0.0])
    u0 = np.cross(r0, f)
    cr, sr = math.cos(r), math.sin(r)
    return f, r0 * cr - u0 * sr, u0 * cr + r0 * sr


def is_identity(i):
    return i["fScale"] == 1 and i["k1"] == 0 and i["cx"] == 0 and i["cy"] == 0


def distort_uv(u, v, intr, aspect, vfov):
    if is_identity(intr):
        return u, v
    t = math.tan(vfov * D / 2)
    xn, yn = (u - 0.5) * 2 * aspect * t, (0.5 - v) * 2 * t
    s = 1 + intr["k1"] * (xn * xn + yn * yn)
    X, Y = intr["fScale"] * xn * s / t, intr["fScale"] * yn * s / t
    return 0.5 + X / (2 * aspect) + intr["cx"], 0.5 - Y / 2 + intr["cy"]


def undistort_uv(u, v, intr, aspect, vfov):
    if is_identity(intr):
        return u, v
    t = math.tan(vfov * D / 2)
    xd = (u - intr["cx"] - 0.5) * 2 * aspect * t / intr["fScale"]
    yd = (0.5 - (v - intr["cy"])) * 2 * t / intr["fScale"]
    rd = math.hypot(xd, yd)
    r = rd
    for _ in range(5):
        g = r * (1 + intr["k1"] * r * r) - rd
        r -= g / (1 + 3 * intr["k1"] * r * r)
    sc = r / rd if rd > 0 else 1
    return 0.5 + xd * sc / (2 * aspect * t), 0.5 - yd * sc / (2 * t)


def cam_from_state(base, x):
    return {"pose": {**base["pose"], "yaw": x[0], "pitch": x[1], "roll": x[2]}, "eye": [x[4], x[5], x[6]],
            "aspect": base["aspect"], "intr": {**base["intr"], "fScale": base["intr"]["fScale"] * math.exp(x[3])}}


def project_x(cam, w):
    p = cam["pose"]
    f, rt, up = pose_basis(p["yaw"], p["pitch"], p["roll"])
    v = np.asarray(w, float) - np.asarray(cam["eye"], float)
    z = v @ f
    if z <= 0:
        return None
    t = math.tan(p["vfov"] * D / 2)
    u, vv = 0.5 + (v @ rt) / z / (t * cam["aspect"]) / 2, 0.5 - (v @ up) / z / t / 2
    return distort_uv(u, vv, cam["intr"], cam["aspect"], p["vfov"])


def unproject_dir_x(cam, u, v):
    p = cam["pose"]
    iu, iv = undistort_uv(u, v, cam["intr"], cam["aspect"], p["vfov"])
    f, rt, up = pose_basis(p["yaw"], p["pitch"], p["roll"])
    t = math.tan(p["vfov"] * D / 2)
    d = f + rt * ((iu * 2 - 1) * t * cam["aspect"]) + up * ((1 - iv * 2) * t)
    return d / (np.linalg.norm(d) or 1)


def basis_px(aspect):
    return (1600.0, 1600.0 / aspect) if aspect >= 1 else (1600.0 * aspect, 1600.0)


def focal_px1600(cam):
    return basis_px(cam["aspect"])[1] / 2 / math.tan(cam["pose"]["vfov"] * D / 2) * cam["intr"]["fScale"]


def az_el(d):
    return (math.atan2(d[0], d[1]) / D) % 360, math.asin(max(-1.0, min(1.0, d[2]))) / D


def dangle(a, b):
    d = math.fmod(a - b, 360.0)
    if d > 180:
        d -= 360
    if d <= -180:
        d += 360
    return d


# ---------------------------------------------------------------- horizons (mirror of map.check / ts runner)

def horizon_of(R, eye, step=0.05, n=7200):
    R = np.asarray(R, float)
    el = np.full(n, -90.0, np.float32)
    dist = np.zeros(n, np.float32)
    az = (np.degrees(np.arctan2(R[:, 0] - eye[0], R[:, 1] - eye[1])) % 360 + 360) % 360
    for i in range(len(R) - 1):
        a0, a1 = az[i], az[i + 1]
        if a1 - a0 > 180:
            a1 -= 360
        if a0 - a1 > 180:
            a1 += 360
        lo, hi = math.ceil(min(a0, a1) / step), math.floor(max(a0, a1) / step)
        for k in range(lo, hi + 1):
            t = 0 if a1 == a0 else (k * step - a0) / (a1 - a0)
            p = R[i] + t * (R[i + 1] - R[i])
            dh = math.hypot(p[0] - eye[0], p[1] - eye[1])
            e = math.atan2(p[2] - eye[2], dh) / D
            b = k % n
            if e > el[b]:
                el[b], dist[b] = e, dh
    return {"step": step, "elevation": el.astype(float), "distance": dist.astype(float)}


def horizon_el(h, az):
    n = len(h["elevation"])
    t = (az % 360) / h["step"]
    i = math.floor(t)
    f = t - i
    a, b = h["elevation"][i % n], h["elevation"][(i + 1) % n]
    if not (a > -89) or not (b > -89):
        return float("nan")
    return a * (1 - f) + b * f


def lin_horizon_el(lin, az, eye):
    b = horizon_el(lin["h0"], az)
    if not math.isfinite(b) or lin["d"] is None:
        return b
    s = b
    for k in range(3):
        de = eye[k] - lin["eL"][k]
        if de == 0:
            continue
        hp, hm = horizon_el(lin["d"][k][0], az), horizon_el(lin["d"][k][1], az)
        if math.isfinite(hp) and math.isfinite(hm):
            s += (hp - hm) / (2 * lin["delta"]) * de
    return s


def column_sigma(sp, sz, sk, f0, d):
    dd = max(MIN_D, d)
    a = f0 * sz / dd
    b = f0 * sk * dd / (2 * EARTH_R)
    return math.sqrt(sp * sp + a * a + b * b)


def dem_sigma(d):
    return 3 + 0.001 * d


# ---------------------------------------------------------------- losses (mirror of map/lm.ts)

def rho(l, z):
    k = l["kind"]
    if k == "l2":
        return z * z
    if k == "huber":
        a = abs(z)
        return z * z if a <= l["c"] else 2 * l["c"] * a - l["c"] ** 2
    if k == "cauchy":
        return l["c"] ** 2 * math.log1p(z * z / l["c"] ** 2)
    return (l["nu"] + 1) * math.log1p(z * z / l["nu"])


def psi(l, z):
    k = l["kind"]
    if k == "l2":
        return 1.0
    if k == "huber":
        a = abs(z)
        return 1.0 if a <= l["c"] else l["c"] / a
    if k == "cauchy":
        return 1 / (1 + z * z / l["c"] ** 2)
    return (l["nu"] + 1) / (l["nu"] + z * z)


# ---------------------------------------------------------------- factor blocks (whitened rows at a full state)

class Block:
    """One TS factor: rows(x) -> whitened residual vector (NaN = no data); loss; prior; nEff. rows() is memoised
    on x (a GTSAM linearisation evaluates every row at the same 15 states)."""

    def __init__(self, family, dim, loss, rows, prior=False, n_eff=None):
        self.family, self.dim, self.loss, self._rows, self.prior, self.n_eff = family, dim, loss, rows, prior, n_eff
        self._cache = {}

    def rows(self, x):
        k = np.asarray(x, float).tobytes()
        r = self._cache.get(k)
        if r is None:
            if len(self._cache) > 64:
                self._cache.clear()
            r = self._cache[k] = np.asarray(self._rows(np.asarray(x, float)), float)
        return r

    def one(self, x, i):
        return self.rows(x)[i]


L2 = {"kind": "l2"}
CLUSTER_DEFAULTS = {"rho": 0.5, "sectorDeg": 15}


def distance_band(m):
    return "<0.5km" if m < 500 else "0.5-2km" if m < 2000 else "2-5km" if m < 5000 else "5-15km" if m < 15000 else ">15km"


def cluster_key(az, d, sector):
    return f"{math.floor(((az % 360) + 360) % 360 / sector)}|{distance_band(d)}"


def median_of(a):
    return sorted(a)[len(a) >> 1]


def cluster_whitener(Gm, clusters):
    """Mirror of map/cluster.ts: rows of cluster c have covariance I + s_c^2 G_c G_c^T; apply(r) = Sigma^-1/2 r
    (matrix function, so independent of the eigen solver). NaN rows are skipped and stay NaN."""
    blks = []
    for rows, sm in clusters:
        if not (sm > 0) or not rows:
            continue
        Gc = Gm[rows]
        lam, V = np.linalg.eigh(Gc.T @ Gc)
        vmax = max(lam.max(), 0)
        keep = [k for k in range(3) if lam[k] > 1e-12 * vmax and lam[k] > 0]
        if not keep:
            continue
        U = np.stack([Gc @ V[:, k] / math.sqrt(lam[k]) for k in keep], 1)
        kk = np.array([1 / math.sqrt(1 + sm * sm * lam[k]) - 1 for k in keep])
        blks.append((np.array(rows), U, kk))

    def apply(r):
        r = np.array(r, float)
        for rows, U, kk in blks:
            v = r[rows]
            ok = np.isfinite(v)
            c = (U[ok].T @ v[ok]) * kk
            v2 = v.copy()
            v2[ok] = v[ok] + U[ok] @ c
            r[rows] = v2
        return r
    return apply


def point_block(fx, f, x_lin):
    base = fx["base"]
    corrs = f["corrs"]
    dem = None if f.get("demSigma", "default") is None else dem_sigma
    cl = None if (f.get("cluster", {}) is None or dem is None) else {**CLUSTER_DEFAULTS, **(f.get("cluster") or {})}
    rho_ = cl["rho"] if cl else 0.0
    fb = focal_px1600(base)
    W, H = basis_px(base["aspect"])
    world = np.array([c["world"] for c in corrs], float)
    uv = np.array([[c["u"], c["v"]] for c in corrs], float)
    dist = np.maximum(1.0, np.linalg.norm(world - np.asarray(base["eye"], float), axis=1))
    sp = np.array([c.get("sigmaPx", f.get("sigmaPx", 2)) for c in corrs], float)
    sig = sp if dem is None else np.hypot(sp, fb * math.sqrt(1 - rho_) * dem_sigma(dist) / dist)

    def raw_cam(cam):
        r = np.empty(2 * len(corrs))
        for i in range(len(corrs)):
            q = project_x(cam, world[i])
            if q is None:
                r[2 * i] = r[2 * i + 1] = np.nan
            else:
                r[2 * i] = (q[0] - uv[i, 0]) * W / sig[i]
                r[2 * i + 1] = (q[1] - uv[i, 1]) * H / sig[i]
        return r
    white = None
    if cl:
        cam = cam_from_state(base, x_lin)
        Gm = np.zeros((2 * len(corrs), 3))
        for k in range(3):
            ep, em = list(cam["eye"]), list(cam["eye"])
            ep[k] += 0.5
            em[k] -= 0.5
            g = (raw_cam({**cam, "eye": ep}) - raw_cam({**cam, "eye": em})) / 1.0
            Gm[:, k] = np.where(np.isfinite(g), g, 0.0)
        groups = {}
        for i in range(len(corrs)):
            az = math.degrees(math.atan2(world[i, 0] - cam["eye"][0], world[i, 1] - cam["eye"][1]))
            g = groups.setdefault(cluster_key(az, dist[i], cl["sectorDeg"]), ([], []))
            g[0].extend([2 * i, 2 * i + 1])
            g[1].append(dist[i])
        white = cluster_whitener(Gm, [(rows, math.sqrt(rho_) * dem_sigma(median_of(ds))) for rows, ds in groups.values()])

    def rows(x):
        r = raw_cam(cam_from_state(base, x))
        return white(r) if white else r
    return Block("point", 2 * len(corrs), f.get("loss") or {"kind": "cauchy", "c": 2.5}, rows, False, f.get("nEff"))


def sky_state(fx, f, x_sky):
    """Skyline linearisation built at state x_sky (horizons at eL, eL +- delta from the ridge; per-sample sigma and
    the cluster whitener at the camera of x_sky) - mirror of skylineFactor.relinearize."""
    base = fx["base"]
    q = lambda v, qq=f["quantumM"]: math.floor(v / qq + 0.5) * qq  # noqa: E731  (JS Math.round: halves up)
    eL = [q(x_sky[4]), q(x_sky[5]), q(x_sky[6])]
    delta = f["stepM"]
    R = f["ridge"]
    h0 = horizon_of(R, eL)
    d = None
    if f.get("eye", True):
        d = []
        for k in range(3):
            ep, em = list(eL), list(eL)
            ep[k] += delta
            em[k] -= delta
            d.append([horizon_of(R, ep), horizon_of(R, em)])
    lin = {"eL": eL, "h0": h0, "d": d, "delta": delta}
    cl = None if (f.get("cluster", {}) is None or d is None) else {**CLUSTER_DEFAULTS, **(f.get("cluster") or {})}
    rho_ = cl["rho"] if cl else 0.0
    S = f["samples"]
    wm = sum(s.get("w", 1) for s in S) / max(1, len(S))
    cam = cam_from_state(base, x_sky)
    fp = focal_px1600(cam)
    n = len(h0["elevation"])
    sig = np.zeros(len(S))
    Gm = np.zeros((len(S), 3))
    groups = {}
    for i, s in enumerate(S):
        az, _ = az_el(unproject_dir_x(cam, s["u"], s["v"]))
        dd = h0["distance"][math.floor((az % 360) / h0["step"] + 0.5) % n]
        dd = dd if dd > 0 else float("nan")
        c = (column_sigma(f["sigmaPx"], math.sqrt(1 - rho_) * dem_sigma(dd), f["sigmaK"], fp, dd)
             if math.isfinite(dd) else f["sigmaPx"])
        sig[i] = c / math.sqrt(max(1e-3, s.get("w", 1) / wm))
        if not cl or d is None or not math.isfinite(dd):
            continue
        for k in range(3):
            g = (horizon_el(d[k][0], az) - horizon_el(d[k][1], az)) / (2 * delta)
            Gm[i, k] = -g * D * fp / sig[i] if math.isfinite(g) else 0.0
        gr = groups.setdefault(cluster_key(az, dd, cl["sectorDeg"]), ([], []))
        gr[0].append(i)
        gr[1].append(dd)
    white = cluster_whitener(Gm, [(rows, math.sqrt(rho_) * dem_sigma(median_of(ds))) for rows, ds in groups.values()]) \
        if cl else None
    return {"lin": lin, "sig": sig, "white": white}


def sky_block(fx, f, st):
    base = fx["base"]
    S = f["samples"]
    lin, sig, white = st["lin"], st["sig"], st["white"]

    def rows(x):
        cam = cam_from_state(base, x)
        fp = focal_px1600(cam)
        r = np.empty(len(S))
        for i, s in enumerate(S):
            az, el = az_el(unproject_dir_x(cam, s["u"], s["v"]))
            r[i] = (el - lin_horizon_el(lin, az, cam["eye"])) * D * fp / sig[i]
        return white(r) if white else r
    return Block("skyline", len(S), f.get("loss") or {"kind": "cauchy", "c": 2}, rows, False, f.get("nEff", 60))


def build_blocks(fx, x_lin=None, sky_st=None):
    """All TS factors as Blocks. x_lin: the state of the relinAll pass (point-cluster whitener); sky_st: the
    skyline linearisation (sky_state) in force."""
    out = []
    for f in fx["factors"]:
        t = f["type"]
        if t == "gps":
            E0, N0, s = f["E0"], f["N0"], f["sigmaH"]
            out.append(Block("gps", 2, L2, lambda x, E0=E0, N0=N0, s=s: [(x[4] - E0) / s, (x[5] - N0) / s], True))
        elif t == "alt":
            mu, s = f["alt"] - f["altBias"], f["sigmaA"]
            out.append(Block("alt", 1, L2, lambda x, mu=mu, s=s: [(x[6] - mu) / s], True))
        elif t == "ground":
            p, h, sa, sb = f["plane"], f["h"], f["sigmaAbove"], f["sigmaBelow"]

            def gr(x, p=p, h=h, sa=sa, sb=sb):
                a = x[6] - (p["z0"] + p["gE"] * x[4] + p["gN"] * x[5]) - h
                return [a / (sb if a < 0 else sa)]
            out.append(Block("ground", 1, L2, gr, True))
        elif t == "gravity":
            pg, rg, s = f["pitch"], f["roll"], f["sigmaDeg"]
            out.append(Block("gravity", 2, L2, lambda x, pg=pg, rg=rg, s=s: [(x[1] - pg) / s, dangle(x[2], rg) / s], True))
        elif t == "compass":
            hd, s = f["heading"], math.hypot(f["sigmaNoiseDeg"], f["sigmaBiasDeg"])
            out.append(Block("compass", 1, {"kind": "student", "nu": f["nu"]}, lambda x, hd=hd, s=s: [dangle(x[0], hd) / s], True))
        elif t == "focal":
            f0, fp, s = fx["f0Px1600"], f["fPx1600"], f["sigmaPx1600"]
            out.append(Block("focal", 1, L2, lambda x, f0=f0, fp=fp, s=s: [(f0 * math.exp(x[3]) - fp) / s], True))
        elif t == "point":
            out.append(point_block(fx, f, np.asarray(x_lin if x_lin is not None else fx["x0"], float)))
        elif t == "skyline":
            assert sky_st is not None, "skyline needs a linearisation"
            out.append(sky_block(fx, f, sky_st))
        else:
            raise ValueError(f"unknown factor {t}")
    return out


# ---------------------------------------------------------------- GTSAM graph

def free_mask(free):
    return [True, True, True, bool(free["focal"]), bool(free["eye"]), bool(free["eye"]), bool(free["eye"])]


def unpack(values, free, xfix):
    x = np.array(xfix, float)
    x[0:3] = values.atVector(KR)
    if free["focal"]:
        x[3] = values.atVector(KF)[0]
    if free["eye"]:
        x[4:7] = values.atVector(KE)
    return x


def keys_of(free):
    ks = [(KR, slice(0, 3))]
    if free["focal"]:
        ks.append((KF, slice(3, 4)))
    if free["eye"]:
        ks.append((KE, slice(4, 7)))
    return ks


def values_of(x, free):
    v = gtsam.Values()
    v.insert(KR, np.array(x[0:3], float))
    if free["focal"]:
        v.insert(KF, np.array([x[3]], float))
    if free["eye"]:
        v.insert(KE, np.array(x[4:7], float))
    return v


def thinning(b, x):
    if b.n_eff is None:
        return 1.0
    r = b.rows(x)
    n = int(np.isfinite(r).sum())
    return min(1.0, b.n_eff / n) if n else 1.0


def make_graph(blocks, free, xfix, a_list, s2=1.0):
    g = gtsam.NonlinearFactorGraph()
    ks = keys_of(free)
    mask = free_mask(free)
    for b, a in zip(blocks, a_list):
        k = 1.0 if b.prior else 1.0 / s2
        loss = b.loss
        est = gtsam.noiseModel.mEstimator.Custom(
            lambda e, loss=loss, a=a, k=k: a * k * psi(loss, e),
            lambda e, loss=loss, a=a, k=k: a * k * rho(loss, e) / 2)
        noise = gtsam.noiseModel.Robust.Create(est, gtsam.noiseModel.Unit.Create(1))
        for i in range(b.dim):
            def err(this, values, H, b=b, i=i):
                x = unpack(values, free, xfix)
                r = b.one(x, i)
                ok = math.isfinite(r)
                if H is not None:
                    J = np.zeros(7)
                    if ok:
                        for p in range(7):
                            if not mask[p]:
                                continue
                            xp, xm = x.copy(), x.copy()
                            xp[p] += STEPS[p]
                            xm[p] -= STEPS[p]
                            d = (b.one(xp, i) - b.one(xm, i)) / (2 * STEPS[p])
                            J[p] = d if math.isfinite(d) else 0.0
                    for j, (_, sl) in enumerate(ks):
                        H[j] = J[sl].reshape(1, -1)
                return np.array([r if ok else 0.0])
            g.add(gtsam.CustomFactor(noise, [kk for kk, _ in ks], err))
    return g


def mad_scale(blocks, x):
    e = []
    for b in blocks:
        if b.prior:
            continue
        r = b.rows(x)
        e.extend(r[np.isfinite(r)].tolist())
    if len(e) < 5:
        return 1.0
    e = np.array(e)
    m = np.median(e)
    return float(1.4826 * np.median(np.abs(e - m)))


def gtsam_solve(blocks, free, x0, a_list):
    g = make_graph(blocks, free, x0, a_list)
    p = gtsam.LevenbergMarquardtParams()
    p.setMaxIterations(200)
    p.setRelativeErrorTol(1e-14)
    p.setAbsoluteErrorTol(1e-14)
    opt = gtsam.LevenbergMarquardtOptimizer(g, values_of(x0, free), p)
    v = opt.optimize()
    return unpack(v, free, x0), opt.iterations()


def gtsam_cov(blocks, free, x, mad_rescale=True):
    a_list = [thinning(b, x) for b in blocks]
    mad = mad_scale(blocks, x)
    s2 = max(1.0, mad) ** 2 if mad_rescale else 1.0
    g = make_graph(blocks, free, x, a_list, s2)
    m = gtsam.Marginals(g, values_of(x, free))
    ks = keys_of(free)
    kv = gtsam.KeyVector()
    for k, _ in ks:
        kv.append(k)
    jm = m.jointMarginalCovariance(kv)
    idx = []
    for _, sl in ks:
        idx.extend(range(sl.start, sl.stop))
    full = np.block([[jm.at(ki, kj) for kj, _ in ks] for ki, _ in ks])
    cov = np.zeros((7, 7))
    cov[np.ix_(idx, idx)] = full
    return cov, mad


# ---------------------------------------------------------------- parity

def sky_states(fx, relin):
    """Replay skylineFactor.relinearize over the TS relinAll passes: a pass whose quantised eye equals the current
    linearisation's is a no-op (lin, sigma and whitener stay from the earlier pass)."""
    f = next((f for f in fx["factors"] if f["type"] == "skyline"), None)
    if f is None:
        return [None] * len(relin)
    out, cur, curL = [], None, None
    qq = f["quantumM"]
    for x in relin:
        eL = [math.floor(x[k] / qq + 0.5) * qq for k in (4, 5, 6)]
        if cur is None or eL != curL:
            cur, curL = sky_state(fx, f, np.asarray(x, float)), eL
        out.append(cur)
    return out


def parity_one(fx_path):
    fx = json.load(open(fx_path))
    if fx.get("format") != "geocam-map-fixture/1":
        return {"fixture": str(fx_path), "status": "unsupported format", "format": fx.get("format")}
    ts_path = Path(str(fx_path).replace(".json", ".ts.json"))
    if not ts_path.exists():
        return {"fixture": str(fx_path), "status": "no TS result (run ts_fixture_solve.ts)"}
    ts = json.load(open(ts_path))
    if "relin" not in ts:
        return {"fixture": str(fx_path), "status": "stale TS result (re-run ts_fixture_solve.ts)"}
    free = fx["free"]
    mask = free_mask(free)
    x_ts = np.array(ts["x"])
    relin = ts["relin"] or []
    skys = sky_states(fx, relin)
    rec = {"fixture": Path(fx_path).name, "name": fx["name"], "status": "ok", "free": free, "passes": len(relin)}
    t0 = time.time()
    # (1) MAP of TS's last inner problem: the linearisation of the second-to-last relinAll pass
    xs = np.asarray(relin[-2] if len(relin) >= 2 else (relin[-1] if relin else fx["x0"]), float)
    ss = skys[-2] if len(relin) >= 2 else (skys[-1] if relin else None)
    blocks_s = build_blocks(fx, xs, ss)
    a_s = [thinning(b, xs) for b in blocks_s]
    x_g, iters = gtsam_solve(blocks_s, free, np.array(fx["x0"], float), a_s)
    x_g2, _ = gtsam_solve(blocks_s, free, x_ts, a_s)
    # (2) covariance at the TS solution with the final pass's linearisation, and at GTSAM's solution
    xc = np.asarray(relin[-1], float) if relin else x_ts
    blocks_c = build_blocks(fx, xc, skys[-1] if relin else None)
    cov_g, mad_g = gtsam_cov(blocks_c, free, x_ts, fx["opts"].get("madRescale", True))
    cov_gg, _ = gtsam_cov(blocks_c, free, x_g, fx["opts"].get("madRescale", True))
    cov_ts = np.array(ts["cov"]).reshape(7, 7)

    def dx(a, b):
        return {"rotDeg": max(abs(dangle(a[k], b[k])) for k in range(3)), "logf": abs(a[3] - b[3]),
                "eyeM": float(np.linalg.norm(a[4:7] - b[4:7]))}
    names = ["yaw", "pitch", "roll", "logf", "E", "N", "U"]
    sg, st, sgg = np.sqrt(np.diag(cov_g)), np.sqrt(np.diag(cov_ts)), np.sqrt(np.diag(cov_gg))
    rel = {names[k]: float(sg[k] / st[k] - 1) for k in range(7) if mask[k] and st[k] > 0}
    relg = {names[k]: float(sgg[k] / st[k] - 1) for k in range(7) if mask[k] and st[k] > 0}
    corr = lambda C: C / np.sqrt(np.outer(np.diag(C), np.diag(C)) + 1e-300)  # noqa: E731
    fm = np.array(mask)
    rec.update({
        "xTS": x_ts.tolist(), "xGTSAM": x_g.tolist(), "gtsamIters": iters,
        "dxFromX0": dx(x_g, x_ts), "dxFromTS": dx(x_g2, x_ts),
        "sigmaTS": {names[k]: float(st[k]) for k in range(7) if mask[k]},
        "sigmaGTSAM_atTS": {names[k]: float(sg[k]) for k in range(7) if mask[k]},
        "sigmaRel_atTS": rel, "sigmaRel_atGTSAM": relg,
        "maxCorrDiff": float(np.abs(corr(cov_g)[np.ix_(fm, fm)] - corr(cov_ts)[np.ix_(fm, fm)]).max()),
        "madTS": ts["mad"], "madGTSAM": mad_g, "tsOuter": ts.get("outer"), "tsConverged": ts.get("converged"),
        "sec": time.time() - t0})
    if ts.get("sky") and skys[-1] is not None:
        ts_last = ts["sky"][-1]
        py = skys[-1]
        rec["skyEL"] = {"ts": ts_last["eL"], "py": py["lin"]["eL"]}
        rec["skyH0MaxAbsDiffDeg"] = float(np.nanmax(np.abs(np.array(ts_last["h0"]) - py["lin"]["h0"]["elevation"])))
        rec["skySigmaMaxRelDiff"] = float(np.max(np.abs(py["sig"] / np.array(ts_last["sigmas"]) - 1)))
    if fx.get("truth"):
        rec["truthErrGTSAM"] = dx(x_g, np.array(fx["truth"]))
    d0 = rec["dxFromX0"]
    rec["pass"] = {"x": d0["rotDeg"] <= TOL["rotDeg"] and d0["logf"] <= TOL["logf"] and d0["eyeM"] <= TOL["eyeM"],
                   "sigma": all(abs(v) <= TOL["sigmaRel"] for v in rel.values())}
    return rec


# ---------------------------------------------------------------- fixtures (synthetic + one real-data)

def _ridge(dscale, a0=-40, a1=100, step=0.01):
    out = []
    for a in np.arange(a0, a1, step):
        d = dscale * (1 + 0.3 * math.sin(3 * a * D))
        z = dscale / 8000 * (800 + 300 * math.sin(5 * a * D) + 150 * math.cos(11 * a * D))
        out.append([round(d * math.sin(a * D), 3), round(d * math.cos(a * D), 3), round(z, 3)])
    return out


def _skyline_samples(cam, h, ncol=100):
    out = []
    for c in range(ncol):
        u = (c + 0.5) / ncol

        def g(v):
            az, el = az_el(unproject_dir_x(cam, u, v))
            return el - horizon_el(h, az)
        lo, hi = 0.0, 1.0
        glo, ghi = g(lo), g(hi)
        if not (glo > 0 and ghi < 0):
            continue
        for _ in range(50):
            m = (lo + hi) / 2
            if g(m) > 0:
                lo = m
            else:
                hi = m
        out.append({"u": u, "v": (lo + hi) / 2, "w": 1})
    return out


def _points(cam, rng, n, d0, d1, px, W, H, outl=0.0):
    out = []
    for _ in range(n):
        u, v = 0.05 + 0.9 * rng.random(), 0.05 + 0.9 * rng.random()
        d = d0 * (d1 / d0) ** rng.random()
        w = np.asarray(cam["eye"]) + d * unproject_dir_x(cam, u, v)
        if rng.random() < outl:
            u, v = u + (rng.random() - 0.5) * 0.2, v + (rng.random() - 0.5) * 0.2
        else:
            u, v = u + px * rng.normal() / W, v + px * rng.normal() / H
        out.append({"u": u, "v": v, "world": [float(t) for t in w]})
    return out


def make_fixtures():
    FIXDIR.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(20260930)
    base = {"pose": {"yaw": 30.0, "pitch": 2.0, "roll": 1.0, "vfov": 50.0}, "eye": [0.0, 0.0, 0.0], "aspect": 4 / 3,
            "intr": {"fScale": 1, "k1": 0, "cx": 0, "cy": 0}}
    f0 = focal_px1600(base)
    W, H = basis_px(base["aspect"])
    truth = [30.0, 2.0, 1.0, 0.0, 0.0, 0.0, 0.0]
    opts = {"madRescale": True, "trustM": 10, "maxOuter": 5, "maxIter": 50, "relinM": 0.5}

    def priors(g=20.0, heading=None):
        return [{"type": "gps", "E0": g * 0.7 * rng.normal(), "N0": g * 0.7 * rng.normal(), "sigmaH": g},
                {"type": "alt", "alt": -7 + 3 * rng.normal(), "altBias": -7, "sigmaA": 3},
                {"type": "gravity", "pitch": 2 + 1.5 * rng.normal(), "roll": 1 + 1.5 * rng.normal(), "sigmaDeg": 1.5},
                {"type": "compass", "heading": heading if heading is not None else 30 + 7 * rng.normal(),
                 "sigmaNoiseDeg": 5, "sigmaBiasDeg": 5, "nu": 3},
                {"type": "focal", "fPx1600": f0 * (1 + 0.03 * rng.normal()), "sigmaPx1600": 0.03 * f0}]

    def start():
        return [30 + 2 * rng.normal(), 2 + rng.normal(), 1 + rng.normal(), 0.03 * rng.normal(),
                20 * rng.normal(), 20 * rng.normal(), 5 * rng.normal()]

    fixtures = []
    # S1 near scene: points 300 m - 3 km (10 % outliers), ridge ~8 km, everything free
    R = _ridge(8000)
    h0 = horizon_of(R, [0, 0, 0])
    fixtures.append({"name": "syn_near_all", "note": "priors + near points (10% outliers, Cauchy) + skyline; eye, focal free",
                     "free": {"rotation": True, "focal": True, "eye": True},
                     "factors": priors() + [
                         {"type": "point", "name": "point", "corrs": _points(base, rng, 150, 300, 3000, 1.0, W, H, 0.1),
                          "sigmaPx": 1.0, "demSigma": None, "loss": {"kind": "cauchy", "c": 2.5}, "nEff": None},
                         {"type": "skyline", "samples": _skyline_samples(base, h0), "ridge": R, "sigmaPx": 2,
                          "sigmaK": 0.05, "loss": {"kind": "cauchy", "c": 2}, "nEff": 60, "eye": True, "stepM": 5,
                          "quantumM": 0.25}]})
    # S2 all-far: points 15-30 km, ridge ~20 km -> eye unobserved (sigma_EN ~ sigma_GPS)
    R2 = _ridge(20000)
    h2 = horizon_of(R2, [0, 0, 0])
    fixtures.append({"name": "syn_far_all", "note": "all-far points 15-30 km + ridge 20 km (default DEM sigma); eye free",
                     "free": {"rotation": True, "focal": False, "eye": True},
                     "factors": priors() + [
                         {"type": "point", "name": "point", "corrs": _points(base, rng, 200, 15000, 30000, 1.0, W, H),
                          "sigmaPx": 2.0, "demSigma": "default", "loss": {"kind": "cauchy", "c": 2.5}, "nEff": 60},
                         {"type": "skyline", "samples": _skyline_samples(base, h2), "ridge": R2, "sigmaPx": 2,
                          "sigmaK": 0.05, "loss": {"kind": "cauchy", "c": 2}, "nEff": 60, "eye": True, "stepM": 5,
                          "quantumM": 0.25}]})
    # S3 rotation only + 90 deg compass blunder (Student-t), focal free
    fixtures.append({"name": "syn_rot_blunder", "note": "eye fixed; 90 deg compass blunder (Student-t nu=3); focal free",
                     "free": {"rotation": True, "focal": True, "eye": False},
                     "factors": priors(heading=120.0) + [
                         {"type": "point", "name": "point", "corrs": _points(base, rng, 120, 2000, 20000, 1.0, W, H, 0.05),
                          "sigmaPx": 1.0, "demSigma": "default", "loss": {"kind": "cauchy", "c": 2.5}, "nEff": None}]})
    # S4 skyline-only near ridge (2 km) with ground plane: the eye through the linearised horizon
    R4 = _ridge(2000)
    h4 = horizon_of(R4, [0, 0, 0])
    fixtures.append({"name": "syn_skyline_eye", "note": "priors + ground plane + near skyline (ridge ~2 km) only; eye free",
                     "free": {"rotation": True, "focal": False, "eye": True},
                     "factors": priors() + [
                         {"type": "ground", "plane": {"z0": -1.6, "gE": 0.05, "gN": -0.02}, "h": 1.6, "sigmaAbove": 2,
                          "sigmaBelow": 0.5},
                         {"type": "skyline", "samples": _skyline_samples(base, h4), "ridge": R4, "sigmaPx": 1,
                          "sigmaK": 0.05, "loss": {"kind": "cauchy", "c": 2}, "nEff": 60, "eye": True, "stepM": 5,
                          "quantumM": 0.25}]})
    # S5 independent rows (cluster: null) + Huber points: the non-cluster code path and another loss
    fixtures.append({"name": "syn_near_nocluster_huber", "note": "as syn_near_all with cluster null and Huber(1.5) points",
                     "free": {"rotation": True, "focal": True, "eye": True},
                     "factors": priors() + [
                         {"type": "point", "name": "point", "corrs": _points(base, rng, 150, 300, 3000, 1.0, W, H, 0.1),
                          "sigmaPx": 1.0, "demSigma": "default", "cluster": None, "loss": {"kind": "huber", "c": 1.5},
                          "nEff": 80},
                         {"type": "skyline", "samples": _skyline_samples(base, h0), "ridge": R, "sigmaPx": 2,
                          "sigmaK": 0.05, "loss": {"kind": "cauchy", "c": 2}, "nEff": 60, "eye": True, "stepM": 5,
                          "quantumM": 0.25, "cluster": None}]})
    for fxd in fixtures:
        x0 = start()
        if not fxd["free"]["eye"]:
            x0[4:7] = [0.0, 0.0, 0.0]
        if not fxd["free"]["focal"]:
            x0[3] = 0.0
        fxd.update({"format": "geocam-map-fixture/1", "base": base, "f0Px1600": f0, "x0": x0, "truth": truth, "opts": opts})
    fixtures.append(real_fixture())
    fixtures.append(real_fixture("wc_0067_dispd150b259"))  # an E1 displaced-eye decoy (150 m)
    for fxd in fixtures:
        G.jdump(fxd, FIXDIR / f"{fxd['name']}.json")
        print("wrote", FIXDIR / f"{fxd['name']}.json")


def real_fixture(hid="wc_0067_k000"):
    """Real messy data: an E1 POS (verified-correct) LoMa correspondence set of a DEV photo, thinned to 400,
    with GPS/alt/gravity/compass/focal priors around the verified pose (dev only)."""
    h = next(h for h in G.e1_hyps(False) if h["hid"] == hid)
    G.assert_dev(h["pid"])
    z = G.load_corr(h["corrPath"])
    st = G.e1_state(h["pid"])
    W, H = z["W"], z["H"]
    import export_decoys as ED
    keep = ED.thin(z["x2d"], W, H, 400)
    eye = z["eye"]
    pose = dict(h["pose"])
    pose["vfov"] = st["vfov0"]
    base = {"pose": pose, "eye": [float(t) for t in eye], "aspect": W / H, "intr": {"fScale": 1, "k1": 0, "cx": 0, "cy": 0}}
    f0 = focal_px1600(base)
    corrs = [{"u": float(z["x2d"][i, 0] / W), "v": float(z["x2d"][i, 1] / H), "world": [float(t) for t in z["X"][i]]}
             for i in keep]
    x0 = [pose["yaw"] + 1.0, pose["pitch"] - 0.5, pose["roll"] + 0.5, 0.0, 10.0, -10.0, float(eye[2]) + 3.0]
    return {"format": "geocam-map-fixture/1", "name": "real_" + hid,
            "note": f"E1 POS {hid} (dev) LoMa correspondences thinned to 400 + priors; eye and focal free",
            "base": base, "f0Px1600": f0, "free": {"rotation": True, "focal": True, "eye": True}, "x0": x0, "truth": None,
            "opts": {"madRescale": True, "trustM": 10, "maxOuter": 5, "maxIter": 50, "relinM": 0.5},
            "factors": [{"type": "gps", "E0": 0.0, "N0": 0.0, "sigmaH": 20},
                        {"type": "alt", "alt": float(eye[2]) - 7, "altBias": -7, "sigmaA": 3},
                        {"type": "ground", "plane": {"z0": float(eye[2]) - 1.6, "gE": 0.0, "gN": 0.0}, "h": 1.6,
                         "sigmaAbove": 2, "sigmaBelow": 0.5},
                        {"type": "gravity", "pitch": pose["pitch"], "roll": pose["roll"], "sigmaDeg": 1.5},
                        {"type": "compass", "heading": pose["yaw"] + 3.0, "sigmaNoiseDeg": 5, "sigmaBiasDeg": 5, "nu": 3},
                        {"type": "focal", "fPx1600": f0, "sigmaPx1600": 0.03 * f0},
                        {"type": "point", "name": "point", "corrs": corrs, "sigmaPx": 2.0, "demSigma": "default",
                         "loss": {"kind": "cauchy", "c": 2.5}, "nEff": 60}]}


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "parity"
    if cmd == "make":
        return make_fixtures()
    files = sys.argv[2:] or sorted(glob.glob(str(FIXDIR / "*.json")) + glob.glob(str(B_FIXDIR / "*.json")))
    files = [f for f in files if not f.endswith(".ts.json")]
    recs = []
    for f in files:
        try:
            r = parity_one(f)
        except Exception as e:  # noqa: BLE001
            r = {"fixture": f, "status": f"error: {type(e).__name__}: {e}"}
        recs.append(r)
        if r.get("status") != "ok":
            print(f"{Path(f).name}: {r['status']}")
            continue
        d0, d1 = r["dxFromX0"], r["dxFromTS"]
        print(f"{r['name']:24s} PASS x={r['pass']['x']} sigma={r['pass']['sigma']} | from x0: rot {d0['rotDeg']:.2e} deg "
              f"logf {d0['logf']:.1e} eye {d0['eyeM']:.3f} m | from TS: rot {d1['rotDeg']:.1e} eye {d1['eyeM']:.3f} | "
              f"sigma rel max {max(map(abs, r['sigmaRel_atTS'].values())):.4f} (at GTSAM x "
              f"{max(map(abs, r['sigmaRel_atGTSAM'].values())):.4f}) corr {r['maxCorrDiff']:.1e} | "
              f"MAD ts {r['madTS']:.3f} py {r['madGTSAM']:.3f}"
              + (f" | skyσ {r['skySigmaMaxRelDiff']:.1e}" if "skySigmaMaxRelDiff" in r else ""))
    G.jdump({"created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "tolerance": TOL, "results": recs},
            G.PYOUT / "gtsam_parity.json")
    print("wrote", G.PYOUT / "gtsam_parity.json")


if __name__ == "__main__":
    main()
