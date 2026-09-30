"""GEO GA1 pre-study ("afternoon test"): PnP variants + Laplace covariance on existing lifted correspondences.

Rule: PROTOCOL.txt section PNP (frozen before scoring). Dev only; no renders, no services.

    PYTHONPATH=tools/research/geo/.pylib tools/matcher/.venv/bin/python tools/research/geo/pnp_prior.py [--selftest]
        [--only e1|e3] [--limit N]

Writes out/geocam/python/pnp_prior.json (per hypothesis x method records + summary) and prints the summary tables that
REPORT_PNP.txt quotes.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path

import geo_common as G  # noqa: E402  (puts .pylib on sys.path)
import numpy as np  # noqa: E402
import poselib  # noqa: E402
import pycolmap  # noqa: E402
from scipy.optimize import least_squares  # noqa: E402
from scipy.spatial.transform import Rotation as Rot  # noqa: E402
from scipy.stats import beta  # noqa: E402



def _load_match_solvers():
    """Exec the solver functions of tools/matcher/match.py verbatim (read-only) without importing the module:
    match.py imports torch, whose libomp clashes with pycolmap's in one process."""
    import ast
    import types
    src = (G.ROOT / "tools/matcher/match.py").read_text()
    want = {"triad", "reproj", "solve_rotation", "solve_pnp_exif", "solve_p4pf"}
    mod = ast.parse(src)
    body = [n for n in mod.body if isinstance(n, ast.FunctionDef) and n.name in want]
    assert {n.name for n in body} == want, "tools/matcher/match.py solver set changed"
    m = types.ModuleType("match_solvers")
    m.__dict__.update(np=np, math=math, poselib=poselib, least_squares=least_squares, Rotation=Rot, PX_THRESH=6.0)
    exec(compile(ast.Module(body=body, type_ignores=[]), str(G.ROOT / "tools/matcher/match.py"), "exec"), m.__dict__)
    return m


MM = _load_match_solvers()

THR = MM.PX_THRESH  # 6 px
MIN_N = 12
SIG_GPS = 20.0  # m, per axis
CHI3, CHI2 = 11.34, 9.21
A_UP = np.array([[1.0, 0, 0], [0, 0, -1.0], [0, 1.0, 0]])  # ENU -> (E, -U, N): y along gravity (down)


# ---------------------------------------------------------------- geometry helpers

def project(R, C, X, f, cx, cy):
    c = (X - C) @ R.T
    z = c[:, 2]
    return np.stack([cx + f * c[:, 0] / np.maximum(z, 1e-9), cy + f * c[:, 1] / np.maximum(z, 1e-9)], 1), z > 0


def inliers(R, C, x2d, X, f, cx, cy, thr=THR):
    p, front = project(R, C, X, f, cx, cy)
    e = np.linalg.norm(p - x2d, axis=1)
    return (e < thr) & front, e


def laplace(R, C, x2d, X, f, cx, cy, inl, prior=None):
    """(rotvec-left, C) Laplace covariance at (R, C) over the inliers; s = 1.4826 MAD of residual components."""
    Xi, ui = X[inl], x2d[inl]

    def res(p):
        Rr = Rot.from_rotvec(p[:3]).as_matrix() @ R
        pp, _ = project(Rr, C + p[3:], Xi, f, cx, cy)
        return (pp - ui).ravel()
    r0 = res(np.zeros(6))
    J = np.zeros((len(r0), 6))
    for k in range(6):
        h = 1e-6 if k < 3 else 1e-2
        e = np.zeros(6)
        e[k] = h
        J[:, k] = (res(e) - res(-e)) / (2 * h)
    s = max(0.5, 1.4826 * float(np.median(np.abs(r0 - np.median(r0)))))
    info = J.T @ J / s ** 2
    if prior is not None:
        info[3:, 3:] += np.linalg.inv(prior)
    cov = np.linalg.pinv(info)
    return cov, s


def colmap_cov_to_C(P, cov6, s):
    """pycolmap [rot(3), t(3)] covariance (unit px noise, left perturbation) -> centre covariance, scaled by s^2."""
    R0, t0 = P.rotation.matrix(), P.translation

    def cen(p):
        Rr = Rot.from_rotvec(p[:3]).as_matrix() @ R0
        return -Rr.T @ (t0 + p[3:])
    J = np.zeros((3, 6))
    for k in range(6):
        e = np.zeros(6)
        e[k] = 1e-6
        J[:, k] = (cen(e) - cen(-e)) / 2e-6
    return J @ cov6 @ J.T * s ** 2


def camera(f, cx, cy, W, H):
    return pycolmap.Camera(model="PINHOLE", width=int(W), height=int(H), params=[f, f, cx, cy])


def run_colmap(x2d, X, f, cx, cy, W, H, prior_C=None):
    eo = pycolmap.AbsolutePoseEstimationOptions()
    eo.ransac.max_error = THR
    eo.ransac.random_seed = 0
    ro = pycolmap.AbsolutePoseRefinementOptions()
    ro.gradient_tolerance = 1e-10
    ro.loss_function_scale = 2.0
    if prior_C is not None:
        ro.use_position_prior = True
        ro.position_prior_in_world = np.asarray(prior_C, float)
        ro.position_prior_covariance = np.eye(3) * SIG_GPS ** 2
    r = pycolmap.estimate_and_refine_absolute_pose(x2d, X, camera(f, cx, cy, W, H), eo, ro, return_covariance=True)
    if r is None:
        return None
    P = r["cam_from_world"]
    R = P.rotation.matrix()
    return {"R": R, "C": -R.T @ P.translation, "P": P, "cov6": r.get("covariance")}


def run_up2p(x2d, X, f, cx, cy, R_h, C0, iters=2000, seed=0):
    """Gravity-aware: gravity from R_h (pitch/roll); 2-point RANSAC with poselib.up2p, then 4-DoF robust LM."""
    n = len(x2d)
    Rc = A_UP @ R_h.T  # tilt correction: Rc R_h A^T = I
    b = np.stack([(x2d[:, 0] - cx) / f, (x2d[:, 1] - cy) / f, np.ones(n)], 1)
    b /= np.linalg.norm(b, axis=1, keepdims=True)
    bu = b @ Rc.T
    Xc = X - C0
    Xu = Xc @ A_UP.T
    rng = np.random.default_rng(seed)
    best = (None, -1)
    for _ in range(iters):
        i = rng.choice(n, 2, replace=False)
        try:
            sols = poselib.up2p(bu[i], Xu[i])
        except Exception:  # noqa: BLE001
            continue
        for P in sols:
            R = Rc.T @ P.R @ A_UP
            C = C0 + A_UP.T @ (-P.R.T @ P.t)
            cnt = int(inliers(R, C, x2d, X, f, cx, cy)[0].sum())
            if cnt > best[1]:
                best = ((R, C), cnt)
    if best[0] is None:
        return None
    R, C = best[0]
    th0 = 0.0
    for _ in range(2):
        inl, _ = inliers(R, C, x2d, X, f, cx, cy, THR * 1.5)
        if inl.sum() < 6:
            return None
        Ru0 = R

        def res(p):
            Ry = Rot.from_rotvec([0, p[0], 0]).as_matrix()
            Rr = Rc.T @ Ry @ Rc @ Ru0  # rotation about the gravity axis (camera-frame y after tilt removal)
            pp, _ = project(Rr, C + p[1:], X[inl], f, cx, cy)
            return (pp - x2d[inl]).ravel()
        s = least_squares(res, np.r_[th0, 0, 0, 0], loss="soft_l1", f_scale=2.0)
        R = Rc.T @ Rot.from_rotvec([0, s.x[0], 0]).as_matrix() @ Rc @ Ru0
        C = C + s.x[1:]
    return {"R": R, "C": C}


# ---------------------------------------------------------------- one hypothesis

def pose_errs(R, R_true):
    if R_true is None:
        return {}
    pe, pt = G.R_to_pose(R, 50.0), G.R_to_pose(R_true, 50.0)
    return {"rotErrDeg": G.rot_angle_deg(R, R_true), "yawErr": G.dang(pe["yaw"], pt["yaw"]),
            "pitchErr": pe["pitch"] - pt["pitch"], "rollErr": pe["roll"] - pt["roll"]}


def solve_all(x2d, X, W, H, f, C_hyp, R_hyp, R_true, C_true):
    cx, cy = W / 2, H / 2
    out = {}
    e_hyp = float(np.linalg.norm(C_hyp - C_true)) if C_true is not None else None

    def rec(name, R, C, ff=None, cov=None, s=None, extra=None):
        inl, _ = inliers(R, C, x2d, X, ff or f, cx, cy)
        r = {"n": int(inl.sum()), "C": C.tolist(), "shift": float(np.linalg.norm(C - C_hyp)), **pose_errs(R, R_true)}
        if ff is not None:
            r["fRatio"] = ff / f
        if C_true is not None:
            r["eTrue"] = float(np.linalg.norm(C - C_true))
            r["eTrueH"] = float(np.linalg.norm((C - C_true)[:2]))
            r["eHyp"] = e_hyp
            r["toward"] = r["eTrue"] < e_hyp
        if cov is not None:
            sC = cov[3:, 3:]
            r["sigma"] = np.sqrt(np.maximum(np.diag(sC), 0)).tolist()
            r["sigmaEN"] = float(math.sqrt(max(np.linalg.eigvalsh(sC[:2, :2]).max(), 0)))
            r["s"] = s
            if C_true is not None:
                d = C - C_true
                r["z2"] = (d ** 2 / np.maximum(np.diag(sC), 1e-12)).tolist()
                r["m2True"] = float(d @ np.linalg.pinv(sC) @ d)
        if extra:
            r.update(extra)
        out[name] = r
        return r

    # (a) status quo
    s = MM.solve_rotation(x2d, X, C_hyp, W, H, f, False)
    if s is not None:
        rec("ROT", s["R"], C_hyp.copy())
    s = MM.solve_pnp_exif(x2d, X, C_hyp, W, H, f)
    if s is not None:
        rec("PNP6", s["R"], C_hyp + np.asarray(s["centreShift"]))
    # (b)
    s = MM.solve_p4pf(x2d, X, C_hyp, W, H, f)
    if s is not None:
        rec("P4PF", s["R"], C_hyp + np.asarray(s["centreShift"]), ff=float(s["f"]))
    # (c) pycolmap without / with prior; fusion by information addition
    c0 = run_colmap(x2d, X, f, cx, cy, W, H)
    if c0 is not None:
        inl0, _ = inliers(c0["R"], c0["C"], x2d, X, f, cx, cy)
        if inl0.sum() >= 6:
            cov, sc = laplace(c0["R"], c0["C"], x2d, X, f, cx, cy, inl0)
            sC = cov[3:, 3:]
            d = C_hyp - c0["C"]
            m2 = float(d @ np.linalg.pinv(sC) @ d)
            m2h = float(d[:2] @ np.linalg.pinv(sC[:2, :2]) @ d[:2])
            extra = {"m2Hyp": m2, "m2HypH": m2h, "flag": bool(inl0.sum() >= MIN_N and m2 > CHI3),
                     "flagH": bool(inl0.sum() >= MIN_N and m2h > CHI2)}
            if c0["cov6"] is not None:
                cc = colmap_cov_to_C(c0["P"], c0["cov6"], sc)
                extra["sigmaColmap"] = np.sqrt(np.maximum(np.diag(cc), 0)).tolist()
            rec("COL0", c0["R"], c0["C"], cov=cov, s=sc, extra=extra)
            # FUSE: centre information addition (rotation block ignored: exact only if C ~ independent of R)
            Ld = np.linalg.pinv(sC)
            Lp = np.eye(3) / SIG_GPS ** 2
            Sf = np.linalg.inv(Ld + Lp)
            Cf = Sf @ (Ld @ c0["C"] + Lp @ C_hyp)
            covf = np.zeros((6, 6))
            covf[3:, 3:] = Sf
            rec("FUSE", c0["R"], Cf, cov=covf, s=sc)
    cp = run_colmap(x2d, X, f, cx, cy, W, H, prior_C=C_hyp)
    if cp is not None:
        inlp, _ = inliers(cp["R"], cp["C"], x2d, X, f, cx, cy)
        if inlp.sum() >= 6:
            cov, sc = laplace(cp["R"], cp["C"], x2d, X, f, cx, cy, inlp, prior=np.eye(3) * SIG_GPS ** 2)
            rec("COLP", cp["R"], cp["C"], cov=cov, s=sc)
    # (d) gravity-aware
    u = run_up2p(x2d, X, f, cx, cy, R_hyp, C_hyp)
    if u is not None:
        rec("UP2P", u["R"], u["C"])
    return out


# ---------------------------------------------------------------- datasets

def e1_items(full_disp=False):
    photos = G.e1_photos()
    hs = G.e1_hyps(full_disp)
    if full_disp:  # secondary: only the extra displaced hypotheses
        prim = {h["hid"] for h in G.e1_hyps(False)}
        hs = [h for h in hs if h["hid"] not in prim and h["kind"] == "DISP"]
        for h in hs:
            if h["label"] == "UNL" and h.get("dist") == 50 and photos[h["pid"]].get("Pref"):
                h["label"] = "AMB"
    keep = ("POS", "NE-dec", "NE-inh") if not full_disp else ("NE-dec", "AMB")
    vf = {}
    for h in hs:
        if h["label"] not in keep:
            continue
        pid = h["pid"]
        G.assert_dev(pid)
        ph = photos[pid]
        if pid not in vf:
            vf[pid] = G.e1_state(pid)["vfov0"]
        z = G.load_corr(h["corrPath"])
        st = ph["stated"]
        e, n = G.enu_offset(h["eye"]["lat"], h["eye"]["lon"], st["lat"], st["lon"])
        V = ph.get("V") or []
        C_true = np.array([e, n, st["h"]]) if h["label"] != "NE-inh" else None
        R_true = G.pose_to_R(V[0]["pose"]) if V else None
        yield {"set": "E1" + ("x" if full_disp else ""), "pid": pid, "hid": h["hid"], "label": h["label"],
               "kind": h["kind"], "dist": h.get("dist"), "x2d": z["x2d"], "X": z["X"], "W": z["W"], "H": z["H"],
               "f": G.focal_px(vf[pid], z["H"]), "C_hyp": z["eye"], "R_hyp": G.pose_to_R(h["pose"]),
               "R_true": R_true, "C_true": C_true}


def e3_items():
    for f in sorted((G.E3 / "out").glob("*.json")):
        r = json.load(open(f))
        pid = r["pid"]
        G.assert_dev(pid)
        view = json.load(open(G.ROOT / f"tools/research/tm/cache/{pid}/refs/{r['ref']}/view.json"))
        K = view["intrinsics"]
        W, H = r["W"], r["H"]
        assert abs(K["cx"] - W / 2) < 1e-6 and abs(K["cy"] - H / 2) < 1e-6
        R_true = G.pose_to_R(view["pose"])
        T = np.array(r["T"], float)
        eyes = {"T_V2": T}
        for k, b in (r.get("b") or {}).items():
            if k.endswith("_V2") and b.get("G") is not None:
                eyes[k] = np.array(b["G"], float)
        for tag, C_hyp in eyes.items():
            p = G.E3 / "corr" / f"{pid}_{tag}.npz"
            if not p.exists():
                continue
            z = np.load(p)
            yield {"set": "E3", "pid": pid, "hid": f"{pid}_{tag}", "label": "T" if tag.startswith("T") else tag.split("_")[0],
                   "kind": "E3", "dist": None, "x2d": z["x2d"].astype(float), "X": z["X"].astype(float), "W": W, "H": H,
                   "f": float(K["fx"]), "C_hyp": C_hyp, "R_hyp": R_true, "R_true": R_true, "C_true": T}


# ---------------------------------------------------------------- summary

def cp_ci(k, n):
    if n == 0:
        return [None, None]
    lo = 0.0 if k == 0 else float(beta.ppf(0.025, k, n - k + 1))
    hi = 1.0 if k == n else float(beta.ppf(0.975, k + 1, n - k))
    return [lo, hi]


def med(v):
    v = [x for x in v if x is not None and np.isfinite(x)]
    return float(np.median(v)) if v else None


def summarise(recs):
    S = {}
    groups = {}
    for r in recs:
        groups.setdefault((r["set"], r["label"]), []).append(r)
    methods = ("ROT", "PNP6", "P4PF", "COL0", "COLP", "FUSE", "UP2P")
    for (st, lab), rs in sorted(groups.items()):
        g = {"n": len(rs)}
        for m in methods:
            ms = [r["m"][m] for r in rs if m in r["m"]]
            if not ms:
                continue
            d = {"solved": len(ms)}
            for k in ("rotErrDeg", "pitchErr", "yawErr", "eTrue", "eTrueH", "shift", "sigmaEN", "fRatio"):
                vals = [abs(x[k]) if k.endswith("Err") else x[k] for x in ms if k in x]
                if vals:
                    d["med_" + k] = med(vals)
            tw = [x["toward"] for x in ms if "toward" in x]
            if tw:
                d["towardFrac"] = sum(tw) / len(tw)
            z2 = [x["z2"] for x in ms if "z2" in x]
            if z2:
                d["med_z2_ENU"] = [med([z[i] for z in z2]) for i in range(3)]
                d["med_m2True"] = med([x["m2True"] for x in ms if "m2True" in x])
            if m == "COL0":
                ok = [x for x in ms if x["n"] >= MIN_N]
                k3 = sum(x["flag"] for x in ok)
                k2 = sum(x["flagH"] for x in ok)
                d["flag3"] = {"k": k3, "n": len(ok), "rate": k3 / len(ok) if ok else None, "ci": cp_ci(k3, len(ok))}
                d["flagH"] = {"k": k2, "n": len(ok), "rate": k2 / len(ok) if ok else None, "ci": cp_ci(k2, len(ok))}
                d["flag3_ofAll"] = {"k": k3, "n": len(rs)}
            g[m] = d
        S[f"{st}:{lab}"] = g
    return S


def print_summary(S):
    for key, g in S.items():
        print(f"\n== {key}  n={g['n']}")
        for m, d in g.items():
            if m == "n":
                continue
            parts = [f"{m:5s} solved {d['solved']:3d}"]
            for k in ("med_rotErrDeg", "med_pitchErr", "med_yawErr", "med_eTrue", "med_eTrueH", "med_shift",
                      "med_sigmaEN", "towardFrac", "med_fRatio"):
                if d.get(k) is not None:
                    parts.append(f"{k[4:] if k.startswith('med_') else k} {d[k]:.3g}")
            if "med_z2_ENU" in d:
                parts.append("z2 " + "/".join(f"{v:.3g}" if v is not None else "-" for v in d["med_z2_ENU"]))
            if "flag3" in d:
                f3, fh = d["flag3"], d["flagH"]
                parts.append(f"FLAG3 {f3['k']}/{f3['n']} ci[{f3['ci'][0]:.2f},{f3['ci'][1]:.2f}]" if f3["n"] else "FLAG3 -")
                parts.append(f"FLAGH {fh['k']}/{fh['n']}")
            print("  " + " | ".join(parts))


# ---------------------------------------------------------------- self test

def selftest():
    rng = np.random.default_rng(1)
    W, H, f = 1024, 768, 800.0
    n = 400
    X = np.c_[rng.uniform(-2000, 2000, n), rng.uniform(300, 6000, n), rng.uniform(-100, 900, n)]
    R = G.pose_to_R({"yaw": 5.0, "pitch": 3.0, "roll": -1.0, "vfov": 50})
    C = np.array([30.0, -20.0, 5.0])
    uv, _ = project(R, C, X, f, W / 2, H / 2)
    ok = (uv[:, 0] > 0) & (uv[:, 0] < W) & (uv[:, 1] > 0) & (uv[:, 1] < H)
    X, uv = X[ok], uv[ok] + rng.normal(0, 1.0, (ok.sum(), 2))
    m = solve_all(uv, X, W, H, f, np.zeros(3), R, R, C)
    for k, v in m.items():
        print(k, {kk: (np.round(vv, 3) if isinstance(vv, (float, list)) else vv) for kk, vv in v.items()
                  if kk in ("n", "eTrue", "rotErrDeg", "sigma", "z2", "flag", "m2Hyp")})
    assert m["UP2P"]["eTrue"] < 5 and m["COL0"]["eTrue"] < 5 and m["ROT"]["rotErrDeg"] > 0.05
    assert m["COL0"]["flag"], "36 m displacement with near points should flag"
    # Monte-Carlo sigma check for COL0
    errs = []
    for k in range(40):
        uvk = project(R, C, X, f, W / 2, H / 2)[0] + rng.normal(0, 1.0, (len(X), 2))
        c0 = run_colmap(uvk, X, f, W / 2, H / 2, W, H)
        errs.append(c0["C"] - C)
    mc = np.std(errs, axis=0)
    print("MC sd", mc.round(3), "laplace sigma", np.round(m["COL0"]["sigma"], 3))
    assert np.all(np.abs(mc / np.array(m["COL0"]["sigma"]) - 1) < 0.35)
    print("selftest ok")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--only", choices=["e1", "e3", "e1x"])
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()
    if a.selftest:
        return selftest()
    srcs = []
    if a.only in (None, "e1"):
        srcs.append(e1_items(False))
    if a.only in (None, "e1x"):
        srcs.append(e1_items(True))
    if a.only in (None, "e3"):
        srcs.append(e3_items())
    recs, skipped = [], []
    t0 = time.time()
    for src in srcs:
        for i, it in enumerate(src):
            if a.limit and i >= a.limit:
                break
            if len(it["x2d"]) < MIN_N:
                skipped.append({"hid": it["hid"], "n": len(it["x2d"])})
                continue
            m = solve_all(it["x2d"], it["X"], it["W"], it["H"], it["f"], np.asarray(it["C_hyp"], float), it["R_hyp"],
                          it["R_true"], None if it["C_true"] is None else np.asarray(it["C_true"], float))
            recs.append({k: it[k] for k in ("set", "pid", "hid", "label", "kind", "dist")} |
                        {"nCorr": len(it["x2d"]), "m": m})
            print(f"{time.time() - t0:6.0f}s {it['hid']:28s} {it['label']:7s} n={len(it['x2d']):5d} "
                  + " ".join(f"{k}:{v.get('eTrue', float('nan')):.0f}" for k, v in m.items()), flush=True)
    S = summarise(recs)
    print_summary(S)
    name = "pnp_prior" + (f"_{a.only}" if a.only else "") + ".json"
    G.jdump({"protocol": "tools/research/geo/PROTOCOL.txt#PNP", "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
             "summary": S, "skipped": skipped, "records": recs}, G.PYOUT / name)
    print("wrote", G.PYOUT / name)


if __name__ == "__main__":
    main()
