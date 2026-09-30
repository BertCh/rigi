"""Propagation DEM-render check (METHOD.txt, frozen before the first run). CPU only.

    npx tsx tools/nearfield/propagate/render_check/skyline.ts          # step 1 (photo skylines)
    tools/matcher/.venv/bin/python tools/nearfield/propagate/render_check/check.py

Writes render_check/out/result.json and overlays out/overlay_<id>.jpg
(white = GT, orange/red = propagated from the two anchors, green = DEM-skyline fit F, cyan = photo skyline).
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import cv2
import numpy as np
from scipy.optimize import minimize

HERE = Path(__file__).resolve().parent
PROP = HERE.parent
ROOT = PROP.parent.parent.parent
sys.path.insert(0, str(ROOT / "tools/matcher"))
sys.path.insert(0, str(PROP))
from common import R_to_pose, pose_to_R  # noqa: E402
from dem import BANDS, K_REFR, R_EARTH, Dem  # noqa: E402

OUT = HERE / "out"
D = math.pi / 180
IDS = ["IMG_7059", "IMG_7063", "IMG_7068"]
TAU = 12.0
DMIN_SKY = 1000.0

GT = json.loads((ROOT / "data/ground-truth.json").read_text())
META = {p["id"]: p for p in json.loads((ROOT / "public/photos/photos.json").read_text())}
RAW = json.loads((PROP / "raw.json").read_text())["real"]
PAIRS = [r for r in RAW if r["A"] in IDS and r["B"] in IDS]
assert len(PAIRS) == 6

lat0, lon0 = GT["IMG_7063"]["lat"], GT["IMG_7063"]["lon"]
dem = Dem(lat0, lon0, extent_m=500)


def eye_z(k):
    """DEVIATIONS.txt D1: the GT 'max' eye rule (max(GPS alt, ground + 1.6 m)) applied to Mapterhorn ground,
    because the stated GT eyes (GPS altitude; Terrarium ground 1859-1903 m) are 5-18 m BELOW Mapterhorn ground."""
    g = GT[k]
    e, n = (g["lon"] - lon0) / dem.mlon, (g["lat"] - lat0) / dem.mlat
    return max(g["eye"], float(dem.ground(np.array([e]), np.array([n]))[0]) + 1.6)


def eye_of(k, z=None):
    g = GT[k]
    return np.array([(g["lon"] - lon0) / dem.mlon, (g["lat"] - lat0) / dem.mlat, eye_z(k) if z is None else z])


def gt_pose(k):
    g = GT[k]
    return {"yaw": g["yaw"], "pitch": g["pitch"], "roll": g["roll"], "vfov": 2 * math.atan(g["height"] / 2 / g["f"]) / D}


def geod(Ra, Rb):
    c = (np.trace(Ra @ Rb.T) - 1) / 2
    return math.degrees(math.acos(max(-1.0, min(1.0, c))))


def pose_from_R(R, vfov):
    return R_to_pose(R, vfov)


# ---------------- photo skyline + DEM skyline ----------------

SKY = {k: json.loads((OUT / f"skyline_{k}.json").read_text()) for k in IDS}
HZ = {}


def horizon(k, z=None):
    key = (k, z)
    if key not in HZ:
        HZ[key] = dem.horizon(eye_of(k, z), 0.0, 359.98, 0.02)
    return HZ[key]


def focal_w(k, vfov=None):
    s = SKY[k]
    if vfov is None:
        return GT[k]["f"] * s["W"] / GT[k]["width"]
    return (s["H"] / 2) / math.tan(vfov * D / 2)


def dem_rows(k, R, f, z=None):
    """Per-column DEM skyline row and its distance for camera rotation R (world->OpenCV) and working focal f."""
    s = SKY[k]
    W, H = s["W"], s["H"]
    hz = horizon(k, z)
    c = hz["dirs"] @ R.T
    ok = c[:, 2] > 1e-3
    u = W / 2 + f * c[ok, 0] / c[ok, 2]
    v = H / 2 + f * c[ok, 1] / c[ok, 2]
    dist = hz["dist"][ok]
    col = np.floor(u).astype(int)
    m = (col >= 0) & (col < W)
    col, v, dist = col[m], v[m], dist[m]
    rows = np.full(W, np.nan)
    dd = np.full(W, np.nan)
    order = np.lexsort((v, col))  # per column, smallest row first
    col, v, dist = col[order], v[order], dist[order]
    first = np.r_[True, col[1:] != col[:-1]]
    rows[col[first]] = v[first]
    dd[col[first]] = dist[first]
    return rows, dd


def photo_rows(k):
    s = SKY[k]
    r = np.array([np.nan if x is None else x for x in s["rows"]], float)
    w = np.array(s["weight"], float)
    return np.where(np.isfinite(r) & (w > 0.05), r, np.nan)


def eligible(k, R, f):
    rows, dd = dem_rows(k, R, f)
    H = SKY[k]["H"]
    return np.isfinite(rows) & (rows >= 2) & (rows <= H - 2) & (dd >= DMIN_SKY)


def residual(k, R, f, C, z=None, cols=None):
    rows, _ = dem_rows(k, R, f, z)
    pr = photo_rows(k)
    idx = np.nonzero(C)[0] if cols is None else cols
    d = pr[idx] - rows[idx]
    d = np.where(np.isfinite(d), d, TAU)  # DEM out of frame on a C column counts as capped
    a = np.abs(d)
    return {"r": float(np.mean(np.minimum(a, TAU))), "medAbs": float(np.median(a)), "bias": float(np.median(d)), "n": int(len(idx))}


def fit(k, starts, C, z=None, cols=None):
    f = focal_w(k)
    vf = gt_pose(k)["vfov"]

    def loss(x):
        R = pose_to_R({"yaw": x[0], "pitch": x[1], "roll": x[2]})
        return residual(k, R, f, C, z, cols)["r"]

    best = None
    for p in starts:
        x0 = np.array([p["yaw"], p["pitch"], p["roll"]])
        simplex = np.vstack([x0, x0 + [0.5, 0, 0], x0 + [0, 0.5, 0], x0 + [0, 0, 0.5]])
        res = minimize(loss, x0, method="Nelder-Mead",
                       options={"initial_simplex": simplex, "xatol": 0.005, "fatol": 1e-4, "maxiter": 600})
        if best is None or res.fun < best.fun:
            best = res
    x = best.x
    return {"yaw": float(x[0] % 360), "pitch": float(x[1]), "roll": float(x[2]), "vfov": vf}, float(best.fun)


# ---------------- parallax simulation ----------------

def ground_banded(E, N, dist):
    """Terrain ENU z with the same distance bands as Dem.horizon (from the eye)."""
    out = np.full(E.shape, np.nan)
    lo = 0.0
    for dm, mos in dem.mos:
        sel = (dist >= lo) & (dist < dm)
        lo = dm
        if sel.any():
            lon, lat = dem.geo(E[sel], N[sel])
            out[sel] = mos.sample(lon, lat) - (1 - K_REFR) * (E[sel] ** 2 + N[sel] ** 2) / (2 * R_EARTH)
    return out


def ray_hits(eye, dirs):
    """First DEM intersection of unit world rays (N,3) from eye; returns X (N,3) and t (nan = no hit)."""
    t = [2.0]
    while t[-1] < 40000:
        t.append(t[-1] + max(1.0, t[-1] * 0.002))
    t = np.array(t)
    P = eye[None, None, :] + dirs[:, None, :] * t[None, :, None]
    g = ground_banded(P[..., 0], P[..., 1], np.broadcast_to(t[None, :], P.shape[:2]))
    below = P[..., 2] < g
    has = below.any(1)
    i = np.argmax(below, 1)
    th = np.full(len(dirs), np.nan)
    for j in np.nonzero(has)[0]:
        a, b = (t[i[j] - 1] if i[j] > 0 else 0.0), t[i[j]]
        for _ in range(30):
            m = (a + b) / 2
            p = eye + dirs[j] * m
            if p[2] < ground_banded(np.array([p[0]]), np.array([p[1]]), np.array([m]))[0]:
                b = m
            else:
                a = m
        th[j] = (a + b) / 2
    X = eye[None, :] + dirs * th[:, None]
    return X, th


def parallax_pairs(min_hit: float = 0.0):
    """min_hit > 0 is POST HOC only (posthoc.py): drop inliers whose DEM hit is nearer than min_hit m."""
    import run_propagate as rp
    imgs = {k: rp.load(ROOT / f"public/photos/{k}.jpg") for k in IDS}
    out = []
    for row in PAIRS:
        A, B = row["A"], row["B"]
        a, b = imgs[A], imgs[B]
        KA = rp.K_of(gt_pose(A)["vfov"], a.width, a.height)
        KB = rp.K_of(META[B]["vfov"], b.width, b.height)
        ka, kb, _ = rp.lg_match(a, b)
        r = rp.rot_ransac(ka, kb, KA, KB)
        ba = np.linalg.inv(KA) @ np.vstack([ka.T + 0.5, np.ones(len(ka))])
        bb = np.linalg.inv(KB) @ np.vstack([kb.T + 0.5, np.ones(len(kb))])
        ba /= np.linalg.norm(ba, axis=0)
        bb /= np.linalg.norm(bb, axis=0)
        inl = np.linalg.norm(bb - r["R"] @ ba, axis=0) < 4.0 / KB[0, 0]
        assert inl.sum() == r["inliers"]
        cached = row["rot"]["inliers"]
        reproduced = abs(r["inliers"] - cached) <= 2
        RA, RB = pose_to_R(gt_pose(A)), pose_to_R(gt_pose(B))
        relGT = RB @ RA.T
        eA, eB = eye_of(A), eye_of(B)
        dirsA = (RA.T @ ba[:, inl]).T
        X, th = ray_hits(eA, dirsA)
        hit = np.isfinite(th) & (np.nan_to_num(th, nan=-1.0) >= min_hit)
        if hit.sum() < 10:  # POST HOC path only (min_hit > 0): too few usable DEM hits
            print(f"{A}->{B}: only {int(hit.sum())} DEM hits >= {min_hit} m; parallax not simulated", flush=True)
            out.append({"A": A, "B": B, "inliers": int(r["inliers"]), "hits": int(hit.sum()),
                        "nearDropped": int((np.isfinite(th) & ~hit).sum()), "baselineM": float(np.linalg.norm((eye_of(B) - eye_of(A))[:2])),
                        "biasPar": float("nan"), "dRotPar": float("nan"), "parallaxMedianDeg": float("nan"),
                        "dGT": geod(np.asarray(row["rot"]["relR"]), relGT), "Rpar": np.full((3, 3), np.nan).tolist()})
            continue
        vB = (RB @ (X[hit] - eB).T)
        vB /= np.linalg.norm(vB, axis=0)
        from run_propagate import kabsch
        Rpar = kabsch(ba[:, inl][:, hit], vB)
        u1 = X[hit] - eA
        u2 = X[hit] - eB
        pang = np.degrees(np.arccos(np.clip(np.sum(u1 * u2, 1) / np.linalg.norm(u1, axis=1) / np.linalg.norm(u2, axis=1), -1, 1)))
        relRot = np.asarray(row["rot"]["relR"])
        base = float(np.linalg.norm((eB - eA)[:2]))
        out.append({
            "A": A, "B": B, "baselineM": base, "dzM": float(eB[2] - eA[2]),
            "inliers": int(r["inliers"]), "cachedInliers": cached, "reproduced": bool(reproduced),
            "rerunVsCachedDeg": geod(r["R"], relRot),
            "hits": int(hit.sum()), "noHit": int((~np.isfinite(th)).sum()), "nearDropped": int((np.isfinite(th) & ~hit).sum()),
            "distMedianM": float(np.nanmedian(th)), "distP10M": float(np.nanpercentile(th, 10)),
            "shareLt500": float(np.mean(th[np.isfinite(th)] < 500)), "shareLt2000": float(np.mean(th[np.isfinite(th)] < 2000)),
            "parallaxMedianDeg": float(np.median(pang)), "parallaxP90Deg": float(np.percentile(pang, 90)),
            "biasPar": geod(Rpar, relGT), "dRotPar": geod(relRot, Rpar), "dGT": geod(relRot, relGT),
            "Rpar": Rpar.tolist(),
        })
        o = out[-1]
        print(f"{A}->{B} base {base:.0f} m inl {o['inliers']}/{cached} dist med {o['distMedianM']:.0f} m "
              f"<500 {o['shareLt500']:.2f} par med {o['parallaxMedianDeg']:.3f} biasPar {o['biasPar']:.3f} "
              f"dRotPar {o['dRotPar']:.3f} dGT {o['dGT']:.3f}", flush=True)
    return out


# ---------------- overlays ----------------

def overlay(k, lines):
    s = SKY[k]
    im = cv2.resize(cv2.imread(str(ROOT / f"public/photos/{k}.jpg")), (s["W"], s["H"]), interpolation=cv2.INTER_AREA)
    pr = photo_rows(k)
    for x in range(s["W"] - 1):
        if np.isfinite(pr[x]) and np.isfinite(pr[x + 1]):
            cv2.line(im, (x, int(pr[x])), (x + 1, int(pr[x + 1])), (255, 255, 0), 1)
    for rows, col in lines:
        for x in range(s["W"] - 1):
            if np.isfinite(rows[x]) and np.isfinite(rows[x + 1]):
                cv2.line(im, (x, int(rows[x])), (x + 1, int(rows[x + 1])), col, 1)
    cv2.imwrite(str(OUT / f"overlay_{k}.jpg"), im, [cv2.IMWRITE_JPEG_QUALITY, 88])


def main():
    OUT.mkdir(exist_ok=True)
    R_GT = {k: pose_to_R(gt_pose(k)) for k in IDS}
    prop = {}  # (A,B) -> rotation
    for row in PAIRS:
        prop[(row["A"], row["B"])] = np.asarray(row["rot"]["relR"]) @ R_GT[row["A"]]
    res = {"method": "METHOD.txt", "targets": {}, "pairs": []}
    F, Fz = {}, {}
    for B in IDS:
        f = focal_w(B)
        anchors = [A for A in IDS if A != B]
        C = eligible(B, R_GT[B], f)
        for A in anchors:
            C &= eligible(B, prop[(A, B)], f)
        C &= np.isfinite(photo_rows(B))
        t = {"C": int(C.sum()), "fW": f}
        t["GT"] = residual(B, R_GT[B], f, C)
        for A in anchors:
            t[f"prop_{A}_gtf"] = residual(B, prop[(A, B)], f, C)
            t[f"prop_{A}_exif"] = residual(B, prop[(A, B)], focal_w(B, META[B]["vfov"]), C)
        starts = [gt_pose(B)] + [pose_from_R(prop[(A, B)], gt_pose(B)["vfov"]) for A in anchors]
        pF, rF = fit(B, starts, C)
        F[B] = pose_to_R(pF)
        t["F"] = {**pF, **residual(B, F[B], f, C)}
        t["F_vs_GT"] = {"geod": geod(F[B], R_GT[B]), "dyaw": (pF["yaw"] - GT[B]["yaw"] + 180) % 360 - 180,
                        "dpitch": pF["pitch"] - GT[B]["pitch"], "droll": pF["roll"] - GT[B]["roll"]}
        # bootstrap
        idx = np.nonzero(C)[0]
        rng = np.random.default_rng(0)
        nb = int(math.ceil(len(idx) / 32))
        bs = []
        for _ in range(200):
            starts_b = rng.integers(0, max(1, len(idx) - 32 + 1), nb)
            cols = np.concatenate([idx[s:s + 32] for s in starts_b])[: len(idx)]
            pb, _ = fit(B, [pF], C, cols=cols)
            bs.append([pb["yaw"], pb["pitch"], pb["roll"], geod(pose_to_R(pb), F[B])])
        bs = np.array(bs)
        bs[:, 0] = (bs[:, 0] - pF["yaw"] + 180) % 360 - 180
        t["F_boot_sd"] = {"yaw": float(bs[:, 0].std()), "pitch": float(bs[:, 1].std()), "roll": float(bs[:, 2].std()),
                          "geodRms": float(np.sqrt(np.mean(bs[:, 3] ** 2)))}
        # eye sensitivity
        z = eye_z(B) + 15.0  # DEVIATIONS.txt D2
        pFz, _ = fit(B, [pF, gt_pose(B)], C, z=z)
        Fz[B] = pose_to_R(pFz)
        t["Fz"] = {**pFz, "eyeZ": z, **residual(B, Fz[B], f, C, z=z), "geodVsF": geod(Fz[B], F[B])}
        t["GT_at_groundEye"] = residual(B, R_GT[B], f, C, z=z)
        res["targets"][B] = t
        print(B, json.dumps({kk: (vv if not isinstance(vv, dict) else {a: round(b, 3) if isinstance(b, float) else b for a, b in vv.items()}) for kk, vv in t.items()}), flush=True)
        lines = [(dem_rows(B, R_GT[B], f)[0], (255, 255, 255))]
        for A, col in zip(anchors, [(0, 140, 255), (0, 0, 255)]):
            lines.append((dem_rows(B, prop[(A, B)], f)[0], col))
        lines.append((dem_rows(B, F[B], f)[0], (0, 220, 0)))
        overlay(B, lines)

    par = parallax_pairs()
    for p in par:
        A, B = p["A"], p["B"]
        relRot = np.asarray([r for r in PAIRS if r["A"] == A and r["B"] == B][0]["rot"]["relR"])
        p["dF"] = geod(relRot, F[B] @ F[A].T)
        p["dGF"] = geod(R_GT[B] @ R_GT[A].T, F[B] @ F[A].T)
        p["dFz"] = geod(relRot, Fz[B] @ Fz[A].T)
        res["pairs"].append(p)
    med = lambda key: float(np.median([p[key] for p in par]))  # noqa: E731
    m = {k: med(k) for k in ("dGT", "dF", "dGF", "biasPar", "dRotPar", "dFz")}
    res["medians"] = m

    def classify(dF):
        ts = res["targets"]
        if any(t["F_boot_sd"]["geodRms"] > 0.5 for t in ts.values()) or any(t["C"] < 100 for t in ts.values()):
            return "INCONCLUSIVE (fit precision / coverage)"
        gt_err = dF <= 0.5 * m["dGT"] and m["biasPar"] <= 0.5 * m["dGT"] and all(t["F"]["r"] < t["GT"]["r"] for t in ts.values())
        parx = m["biasPar"] >= 0.5 * m["dGT"] and m["dRotPar"] <= 0.5 * m["dGT"]
        if gt_err and parx:
            return "MIXED"
        if gt_err:
            return "GT ERROR"
        if parx:
            return "PARALLAX"
        if dF >= 0.8 * m["dGT"] and m["biasPar"] < 0.5 * m["dGT"]:
            return "OTHER MATCHER BIAS"
        return "INCONCLUSIVE"

    res["decision"] = classify(m["dF"])
    res["decisionEyeGround"] = classify(m["dFz"])
    print("medians", {k: round(v, 3) for k, v in m.items()})
    print("DECISION", res["decision"], "| with ground-eye fit:", res["decisionEyeGround"])
    (OUT / "result.json").write_text(json.dumps(res, indent=1))


if __name__ == "__main__":
    main()
