"""E3 driver (PROTOCOL.txt): per photo, render V0/V0e/V1/V2 at the ref eye T and at displaced GPS eyes G_d, match
(ALIKED+LightGlue CPU, no 250 m cut), count ref-pose inliers per depth band, solve the eye (far-fixed rotation,
near/mid centre), write out/<pid>.json (+ corr/<pid>_<tag>.npz, examples/).

    PYTHONPATH=../.pylib ../../../matcher/.venv/bin/python e3_run.py [pid ...]
"""
from __future__ import annotations

import json
import math
import os
import sys
import time
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "tools/research/tm/c0_cache"))
sys.path.insert(0, str(ROOT / "tools/research/tm"))
os.environ.setdefault("TORCH_HOME", str(ROOT / "tools/matcher/weights"))

import numpy as np  # noqa: E402
import torch  # noqa: E402
from PIL import Image  # noqa: E402
from scipy.optimize import least_squares  # noqa: E402
from scipy.spatial.transform import Rotation  # noqa: E402

import cache_io as C  # noqa: E402
import nf_data as D  # noqa: E402
import nf_geo as G  # noqa: E402
import nf_render as NR  # noqa: E402
import tm_common  # noqa: E402

OUT = HERE / "out"
CORR = HERE / "corr"
EX = HERE / "examples"
PX = 6.0
ORDER_FIRST = ["wc_0002", "wc_0034", "wc_0052", "wc_0055"]
DISPS = [50, 20, 150]
EXAMPLE_PIDS = {"wc_0002", "wc_0034", "wc_0055", "wc_0067"}

# ---------------- matching ----------------
_M = {}


def models():
    if not _M:
        from lightglue import ALIKED, LightGlue
        _M["ext"] = ALIKED(max_num_keypoints=4096, detection_threshold=0.01).eval()
        _M["lg"] = LightGlue(features="aliked").eval()
    return _M["ext"], _M["lg"]


@torch.inference_mode()
def feats(img):
    ext, _ = models()
    return ext.extract(torch.from_numpy(img).permute(2, 0, 1).float().div(255))


@torch.inference_mode()
def match(f0, f1):
    _, lg = models()
    out = lg({"image0": f0, "image1": f1})
    m = out["matches"][0].numpy()
    return f0["keypoints"][0].numpy()[m[:, 0]], f1["keypoints"][0].numpy()[m[:, 1]]


def lift(kp, xyz, eye):
    """match.py lift() with min_range 0: nearest pixel xyz, 5x5 range spread < 8 %."""
    H, W, _ = xyz.shape
    xi = np.clip(np.round(kp[:, 0]).astype(int), 0, W - 1)
    yi = np.clip(np.round(kp[:, 1]).astype(int), 0, H - 1)
    X = xyz[yi, xi].astype(np.float64)
    rng = np.linalg.norm(xyz.astype(np.float64) - eye, axis=2)
    rng[(xyz == 0).all(2)] = np.inf
    ok = np.isfinite(rng[yi, xi])
    lo = np.full(len(kp), np.inf)
    hi = np.zeros(len(kp))
    for dy in range(-2, 3):
        for dx in range(-2, 3):
            v = rng[np.clip(yi + dy, 0, H - 1), np.clip(xi + dx, 0, W - 1)]
            lo = np.minimum(lo, v)
            hi = np.maximum(hi, v)
    ok &= hi < lo * 1.08
    return X, ok


def project(X, R, C, K):
    c = (X - C) @ R.T
    z = c[:, 2]
    u = K["cx"] + K["fx"] * c[:, 0] / np.where(z > 1e-9, z, np.nan)
    v = K["cy"] + K["fy"] * c[:, 1] / np.where(z > 1e-9, z, np.nan)
    return np.stack([u, v], 1)


def bands(dep):
    return {"near": dep < 250, "mid": (dep >= 250) & (dep < 2000), "far": dep >= 2000}


# ---------------- eye solve ----------------

def triad(a1, a2, b1, b2):
    def frame(v1, v2):
        t1 = v1 / np.linalg.norm(v1, axis=1, keepdims=True)
        t2 = np.cross(v1, v2)
        t2 /= np.linalg.norm(t2, axis=1, keepdims=True) + 1e-12
        return np.stack([t1, t2, np.cross(t1, t2)], axis=2)
    A, B = frame(a1, a2), frame(b1, b2)
    return B @ np.transpose(A, (0, 2, 1))


def bearings(x2d, K):
    b = np.stack([(x2d[:, 0] - K["cx"]) / K["fx"], (x2d[:, 1] - K["cy"]) / K["fy"], np.ones(len(x2d))], 1)
    return b / np.linalg.norm(b, axis=1, keepdims=True)


def solve_R(x2d, X, Cc, K, R0, rng, iters=2000):
    n = len(x2d)
    if n < 6:
        return None
    Wd = X - Cc
    Wd /= np.linalg.norm(Wd, axis=1, keepdims=True)
    b = bearings(x2d, K)
    i = rng.integers(0, n, size=(iters, 2))
    i = i[i[:, 0] != i[:, 1]]
    Rs = np.concatenate([R0[None], triad(Wd[i[:, 0]], Wd[i[:, 1]], b[i[:, 0]], b[i[:, 1]])])
    cnt = []
    for k0 in range(0, len(Rs), 256):
        c = np.einsum("kij,nj->kni", Rs[k0:k0 + 256], Wd)
        cnt.append((np.einsum("kni,ni->kn", c, b) > math.cos(PX / K["fx"])).sum(1))
    R = Rs[int(np.concatenate(cnt).argmax())]
    for _ in range(3):
        e = np.linalg.norm(project(X, R, Cc, K) - x2d, axis=1)
        inl = e < PX * 1.5
        if inl.sum() < 6:
            return None

        def res(x):
            return (project(X[inl], Rotation.from_rotvec(x).as_matrix(), Cc, K) - x2d[inl]).ravel()
        sol = least_squares(res, Rotation.from_matrix(R).as_rotvec(), loss="soft_l1", f_scale=2.0)
        R = Rotation.from_rotvec(sol.x).as_matrix()
    e = np.linalg.norm(project(X, R, Cc, K) - x2d, axis=1)
    inl = e < PX
    return (R, int(inl.sum())) if inl.sum() >= 6 else None


def solve_C(x2d, X, R, C0, K, rng, zfun=None, iters=2000):
    """Centre with R fixed. zfun(x, y) -> z for the 2-DoF variant (None = 3-DoF)."""
    n = len(x2d)
    if n < 6:
        return None
    w = bearings(x2d, K) @ R  # world bearings (R^T b)
    i = rng.integers(0, n, size=(iters, 2))
    i = i[i[:, 0] != i[:, 1]]
    # closest point between lines X_a - s w_a and X_b - t w_b
    p1, d1, p2, d2 = X[i[:, 0]], -w[i[:, 0]], X[i[:, 1]], -w[i[:, 1]]
    r = p1 - p2
    a, bb, c = (d1 * d1).sum(1), (d1 * d2).sum(1), (d2 * d2).sum(1)
    dd, e = (d1 * r).sum(1), (d2 * r).sum(1)
    den = a * c - bb * bb
    ok = den > 1e-9
    s = np.where(ok, (bb * e - c * dd) / np.where(ok, den, 1), 0)
    t = np.where(ok, (a * e - bb * dd) / np.where(ok, den, 1), 0)
    hyp = ((p1 + s[:, None] * d1) + (p2 + t[:, None] * d2)) / 2
    good = ok & (s > 0) & (t > 0) & (np.linalg.norm(hyp - C0, axis=1) < 1000)
    hyp = np.concatenate([C0[None], hyp[good]])
    if zfun is not None:
        hyp[:, 2] = [zfun(h[0], h[1]) for h in hyp] if len(hyp) < 400 else hyp[:, 2]
    best, bc = C0, -1
    for h in hyp:
        if zfun is not None and len(hyp) >= 400:
            h = h.copy()
            h[2] = zfun(h[0], h[1])
        if not np.all(np.isfinite(h)):
            continue
        cnt = int((np.linalg.norm(project(X, R, h, K) - x2d, axis=1) < PX).sum())
        if cnt > bc:
            best, bc = h, cnt
    e = np.linalg.norm(project(X, R, best, K) - x2d, axis=1)
    inl = np.nan_to_num(e, nan=1e9) < PX * 1.5
    if inl.sum() < 6:
        return None

    def full(x):
        return np.array([x[0], x[1], zfun(x[0], x[1])]) if zfun is not None else x

    def res(x):
        return np.nan_to_num((project(X[inl], R, full(x), K) - x2d[inl]).ravel(), nan=1e3)
    x0 = best[:2] if zfun is not None else best
    sol = least_squares(res, x0, loss="soft_l1", f_scale=2.0, x_scale=10.0)
    Cn = full(sol.x)
    if not np.all(np.isfinite(Cn)) or np.linalg.norm(Cn - C0) > 1000:
        return None
    e = np.linalg.norm(project(X, R, Cn, K) - x2d, axis=1)
    ninl = int((np.nan_to_num(e, nan=1e9) < PX).sum())
    return (Cn, ninl) if ninl >= 6 else None


def eye_solve(x2d, X, dep, C0, R0, K, zfun=None):
    """3 alternations: R from far5 (centre fixed), centre from < 2 km (R fixed). Fails -> C0."""
    rng = np.random.default_rng(0)
    far5, nm = dep > 5000, dep < 2000
    info = {"nFar5": int(far5.sum()), "nNearMid": int(nm.sum())}
    Cc, R = C0.copy(), R0
    for it in range(3):
        rr = solve_R(x2d[far5], X[far5], Cc, K, R, rng)
        if rr is None:
            return C0, {**info, "fail": f"rotation it{it}"}
        R, info["rotInl"] = rr
        cc = solve_C(x2d[nm], X[nm], R, Cc, K, rng, zfun)
        if cc is None:
            return C0, {**info, "fail": f"centre it{it}"}
        Cc, info["ctrInl"] = cc
        if np.linalg.norm(Cc - C0) > 1000:
            return C0, {**info, "fail": "moved > 1000 m"}
    info["dRotDeg"] = float(np.degrees(np.linalg.norm(Rotation.from_matrix(R @ R0.T).as_rotvec())))
    return Cc, info


# ---------------- per photo ----------------

def disp_eye(pid, d, T, grids):
    a = np.random.default_rng(int(pid[3:]) * 7919 + d).uniform(0, 360)
    x, y = d * math.sin(math.radians(a)), d * math.cos(math.radians(a))
    agl = max(1.6, T[2] - NR.dtm_height(grids, T[0], T[1]))
    return np.array([x, y, NR.dtm_height(grids, x, y) + agl]), a


def run(pid):
    tm_common.assert_dev(pid)
    t00 = time.time()
    m = C.load_meta(pid)
    lab = m["perturbBase"]
    v = C.load_view(pid, "refs", lab)
    K, W, H, pose = v["intrinsics"], v["W"], v["H"], v["pose"]
    T = np.array(v["eye"], float)
    R0 = NR.pose_to_R(pose)
    frame = G.EnuFrame(m["lat"], m["lon"], 0)
    wedge = (pose["yaw"], K["hfov"] / 2 + 25)
    grids = D.build_grids(frame, 0, 0, T[2], wedge, cache=D.DATA / pid / "grid.npz")
    ortho = D.Ortho(frame, 0, 0, T[2], wedge, D.DATA / pid / "tiles")
    res = {"pid": pid, "ref": lab, "T": T.tolist(), "stated": m["eye"], "positionSource": m["positionSource"],
           "W": W, "H": H, "hfov": K["hfov"], "gridMeta": grids["meta"], "dtmAtT": NR.dtm_height(grids, 0, 0)}
    # coverage of the DTM in the view wedge (0-2 km)
    g = grids["outer"]
    hh, ww = np.asarray(g["dtm"]).shape
    ee = g["e0"] + np.arange(ww) * g["res"]
    nn = g["n0"] - np.arange(hh) * g["res"]
    EE, NN = np.meshgrid(ee, nn)
    wm = D._wedge_mask(EE, NN, 2000, (pose["yaw"], K["hfov"] / 2))
    res["dtmCoverage"] = float(np.isfinite(np.asarray(g["dtm"])[wm]).mean())
    photo = np.array(Image.open(C.CACHE / pid / "photo.jpg").convert("RGB").resize((W, H), Image.LANCZOS))
    fp = feats(photo)
    far_full = NR.upsample_xyz(v["xyz"], 2, W, H)
    CORR.mkdir(exist_ok=True)

    def do_match(tag, rgb, xyz, eye):
        k0, k1 = match(fp, feats(rgb))
        X, ok = lift(k1, xyz, eye)
        x2d, X = k0[ok] + 0.5, X[ok]
        dep = np.linalg.norm(X - eye, axis=1)
        np.savez_compressed(CORR / f"{pid}_{tag}.npz", x2d=x2d.astype(np.float32), X=X, dep=dep.astype(np.float32),
                            k1=(k1[ok] + 0.5).astype(np.float32))
        return x2d, X, dep, int(len(k0))

    renders = {}
    # ---- at T
    rT = {}
    for var, kw in (("V0e", dict(surface="dtm", coarse=3.3, max_zoom=16)), ("V1", dict(surface="dtm")),
                    ("V2", dict(surface="dsm"))):
        r = NR.render_near(grids, ortho, T, pose, K, W, H, **kw)
        cp = NR.composite(r, v["rgb"], far_full)
        rT[var] = (cp, r)
        renders[f"T_{var}"] = {"sec": round(r["sec"], 1), "eye": r["eye"].tolist(), "clamped": r["eyeClamped"],
                               "nearFrac": float(r["near"].mean())}
    # validation vs cached (V0e, V1) in bands
    dc = C.depth(v)
    val = {}
    for var in ("V0e", "V1"):
        dn = rT[var][1]["depth"][::2, ::2]
        both = np.isfinite(dc) & np.isfinite(dn)
        vv = {}
        for lo, hi in ((0, 250), (250, 2000)):
            s = both & (dc >= lo) & (dc < hi)
            if s.sum() > 50:
                vv[f"{lo}-{hi}"] = {"n": int(s.sum()), "medRelAbs": float(np.median(np.abs(dn[s] - dc[s]) / dc[s])),
                                    "medDiff": float(np.median(dn[s] - dc[s]))}
        # rgb agreement where near hit (grayscale corr, native px)
        nm_ = rT[var][1]["near"]
        a = v["rgb"][nm_].mean(1)
        b = rT[var][0]["rgb"][nm_].mean(1)
        vv["grayCorrNear"] = float(np.corrcoef(a, b)[0, 1]) if nm_.sum() > 100 else None
        vv["meanRGB_cache"] = v["rgb"][nm_].mean(0).round(1).tolist() if nm_.sum() else None
        vv["meanRGB_mine"] = rT[var][0]["rgb"][nm_].mean(0).round(1).tolist() if nm_.sum() else None
        val[var] = vv
    # reprojection self-check of cached xyz with my camera code
    uu, vvv = C.xyz_pixel_coords(v)
    sel = (v["xyz"] != 0).any(-1)
    pp = project(v["xyz"][sel].astype(np.float64), R0, T, K)
    val["cacheReprojMedPx"] = float(np.median(np.hypot(pp[:, 0] - uu[sel], pp[:, 1] - vvv[sel])))
    res["validation"] = val
    res["renders"] = renders

    # ---- (a) ref-pose inliers per band at T
    A = {}
    solvesT = {}
    for var in ("V0", "V0e", "V1", "V2"):
        if var == "V0":
            rgb, xyz, eye = v["rgb"], far_full, T
        else:
            rgb, xyz, eye = rT[var][0]["rgb"], rT[var][0]["xyz"], rT[var][1]["eye"]
        x2d, X, dep, nm_ = do_match(f"T_{var}", rgb, xyz, eye)
        e = np.linalg.norm(project(X, R0, eye, K) - x2d, axis=1)
        inl = np.nan_to_num(e, nan=1e9) < PX
        bb = bands(dep)
        A[var] = {"matches": nm_, "lifted": int(len(X)), **{f"lift_{k}": int(s.sum()) for k, s in bb.items()},
                  **{f"inl_{k}": int((inl & s).sum()) for k, s in bb.items()}, "inl_total": int(inl.sum())}
        E3, i3 = eye_solve(x2d, X, dep, eye, R0, K)
        solvesT[var] = {"E": E3.tolist(), "err3d": float(np.linalg.norm(E3 - T)), "info": i3}
    A["V0cut"] = {k: (0 if k in ("inl_near", "lift_near") else val_) for k, val_ in A["V0"].items()}
    A["V0cut"]["inl_total"] = A["V0"]["inl_mid"] + A["V0"]["inl_far"]
    res["a"] = A
    res["solveAtT_circular"] = solvesT

    if pid in EXAMPLE_PIDS:
        EX.mkdir(exist_ok=True)
        strip = np.concatenate([photo, v["rgb"], rT["V1"][0]["rgb"], rT["V2"][0]["rgb"]], 1)
        im = Image.fromarray(strip)
        im.resize((im.width // 2, im.height // 2), Image.LANCZOS).save(EX / f"{pid}_photo_V0_V1_V2.jpg", quality=82)

    # ---- (b) displaced eyes
    zfun = lambda x, y: NR.dtm_height(grids, x, y) + 1.7  # noqa: E731
    B = {}
    for d in DISPS:
        Gd, az = disp_eye(pid, d, T, grids)
        far = NR.warp_view(v["rgb"], far_full, Gd, pose, K, W, H, min_depth_new=1500.0)
        vars_ = ("V0e", "V1", "V2") if d == 50 else ("V2",)
        for var in vars_:
            kw = {"V0e": dict(surface="dtm", coarse=3.3, max_zoom=16), "V1": dict(surface="dtm"),
                  "V2": dict(surface="dsm")}[var]
            r = NR.render_near(grids, ortho, Gd, pose, K, W, H, **kw)
            cp = NR.composite(r, far["rgb"], far["xyz"])
            eyeR = r["eye"]
            x2d, X, dep, nm_ = do_match(f"G{d}_{var}", cp["rgb"], cp["xyz"], eyeR)
            bb = bands(dep)
            rec = {"G": eyeR.tolist(), "azDeg": az, "eGps3d": float(np.linalg.norm(eyeR - T)),
                   "eGpsH": float(np.hypot(*(eyeR - T)[:2])), "clamped": r["eyeClamped"], "lifted": int(len(X)),
                   **{f"lift_{k}": int(s.sum()) for k, s in bb.items()}}
            for dof, zf in (("3dof", None), ("2dof", zfun)):
                E, info = eye_solve(x2d, X, dep, eyeR, R0, K, zf)
                rec[dof] = {"E": E.tolist(), "err3d": float(np.linalg.norm(E - T)),
                            "errH": float(np.hypot(*(E - T)[:2])), "info": info,
                            "better": bool(np.linalg.norm(E - T) < np.linalg.norm(eyeR - T))}
            B[f"G{d}_{var}"] = rec
            if pid in EXAMPLE_PIDS and d == 50 and var == "V2":
                im = Image.fromarray(np.concatenate([photo, cp["rgb"]], 1))
                im.resize((im.width // 2, im.height // 2), Image.LANCZOS).save(EX / f"{pid}_G50_V2.jpg", quality=82)
    res["b"] = B
    res["sec"] = round(time.time() - t00, 1)
    OUT.mkdir(exist_ok=True)
    (OUT / f"{pid}.json").write_text(json.dumps(res, indent=1, default=float))
    return res


def main():
    ids = sys.argv[1:]
    if not ids:
        from refs import correct_refs
        allp = [p for p in tm_common.dev_ids() if correct_refs(p)]
        ids = ORDER_FIRST + [p for p in allp if p not in ORDER_FIRST]
    torch.set_num_threads(6)
    for pid in ids:
        if (OUT / f"{pid}.json").exists():
            continue
        try:
            r = run(pid)
            a = r["a"]
            b = r["b"]["G50_V2"]
            print(f"{pid} {r['sec']}s  inl<2km V0 {a['V0']['inl_near']+a['V0']['inl_mid']} V1 {a['V1']['inl_near']+a['V1']['inl_mid']} "
                  f"V2 {a['V2']['inl_near']+a['V2']['inl_mid']} | G50 V2 3dof err {b['3dof']['err3d']:.1f} "
                  f"(gps {b['eGps3d']:.1f}) {b['3dof']['info'].get('fail','')}", flush=True)
        except Exception:
            print(f"{pid} FAILED", flush=True)
            traceback.print_exc()


if __name__ == "__main__":
    main()
