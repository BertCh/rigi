"""X2 step 2/3: score every cached pose (refs, perturb), pano yaw scans, and matcher-solved poses, per photo.

    python run_eval.py [ids...] [--force]      -> results/<pid>.json
CPU only (numpy).  Waits for cache/<pid>/DONE and geom/<pid>.*.npz.
"""
from __future__ import annotations
import _env  # noqa: F401
import argparse, json, math, time, sys
import os
import tempfile
from pathlib import Path
import numpy as np
import tm_common
import geomscore as GS
from geomscore import C

OUT = _env.HERE / "results"
GEOM = _env.HERE / "geom"
MODELS = ["moge_l", "moge_b", "da3_b"]
LOMA = Path(os.environ.get("LOMA_SCRATCH", os.path.join(tempfile.gettempdir(), "rigi-loma"))) / "runs" / "main"
V2OUT = _env.TM.parents[1] / "matcher/v2/out"
SCAN_STEP = 1.0     # full-circle yaw scan step (deg)
NORM_STEP = 5.0     # null-distribution scan step for normalising a pose's score
NORM_EXCL = 10.0    # exclude ± this around the pose's own yaw from its null distribution


def rot_err(a, b):
    Ra, Rb = C.pose_to_R(a), C.pose_to_R(b)
    c = (np.trace(Ra @ Rb.T) - 1) / 2
    return math.degrees(math.acos(max(-1, min(1, c))))


def load_geoms(pid):
    g = {k: dict(np.load(GEOM / f"{pid}.{k}.npz")) for k in MODELS}
    return g


def pmaps(g, W, H):
    cache = {}
    for k in MODELS:
        cache[k] = GS.photo_maps(g[k], W, H, sky_from=g["moge_l"])   # sky from MoGe-L for every model
    return cache


SCAN_MODELS = ["moge_l", "da3_b"]   # moge_b is scored on refs/perturb only (cost)


def score_all(P, R, models=MODELS):
    return {k: GS.scores(P[k], R) for k in models}


def candidates(pid, meta):
    """Matcher-solved poses at the stated eye (LoMa A/B sweep records, v2 finals)."""
    out = []
    f = LOMA / f"{pid}.json"
    if f.exists():
        r = json.load(open(f))
        sw = r.get("sweep") or {}
        for kind in ("aliked", "loma", "loma4096"):
            if kind not in sw:
                continue
            for v in sw[kind]["views"]:
                if v.get("pose") and v.get("inliers", 0) >= 100:
                    out.append({"src": f"sweep_{kind}_{v['tag']}", "kind": kind, "pose": v["pose"], "inliers": v["inliers"]})
            pl = sw[kind].get("pooled") or {}
            if pl.get("pose") and pl.get("inliers", 0) >= 100:
                out.append({"src": f"pooled_{kind}", "kind": kind, "pose": pl["pose"], "inliers": pl["inliers"]})
    for arm, d in (("t6_final", "dev"), ("loma_final", "dev_loma")):
        f = V2OUT / d / f"{pid}.json"
        if f.exists():
            r = json.load(open(f))
            fin = r.get("final") or {}
            if fin.get("pose") and not fin.get("eyeMoved"):
                st = r.get("stated") or {}
                out.append({"src": arm, "kind": arm, "pose": fin["pose"], "inliers": fin.get("inliers"), "level": fin.get("level")})
    return out


def label_pose(pose, meta):
    cr = [x["pose"] for x in meta["correct_refs"]]
    wr = [x["pose"] for x in meta["wrong_refs"]]
    hfov = 2 * math.degrees(math.atan(math.tan(math.radians(pose["vfov"]) / 2) * meta["aspect"]))
    tol = max(2.0, 0.1 * hfov)
    ec = min((rot_err(pose, p) for p in cr), default=None)
    ew = min((rot_err(pose, p) for p in wr), default=None)
    if ec is not None and ec < tol:
        lab = "correct"
    elif ec is not None and ec > 5:
        lab = "wrong"                    # photo has a verified-correct pose and this is > 5° from all of them
    elif ew is not None and ew < 2.5:
        lab = "near_wrong_ref"
    else:
        lab = "unknown"
    return lab, ec, ew


def null_scan(pano, P, pose, W, H, step=NORM_STEP, models=SCAN_MODELS):
    rows = []
    for y in np.arange(0, 360, step):
        dy = (y - pose["yaw"] + 180) % 360 - 180
        if abs(dy) <= NORM_EXCL:
            continue
        q = {**pose, "yaw": float(y)}
        xyz, ok = pano.sample(q, W, H)
        R = GS.render_maps_from_xyz(xyz, pano.eye, q, ok)
        rows.append(score_all(P, R, models))
    return rows


def photo(pid, force=False):
    f = OUT / f"{pid}.json"
    if f.exists() and not force:
        return json.load(open(f))
    tm_common.assert_dev(pid)
    t0 = time.time()
    meta = C.load_meta(pid)
    g = load_geoms(pid)
    res = {"pid": pid, "hfov0": meta["hfov0"], "vfov0": meta["vfov0"], "focal_known": meta["focal_known"], "aspect": meta["aspect"],
           "tags": meta.get("tags"), "fov_pred": {k: {"hfov": float(g[k]["hfov_pred"]), "vfov": float(g[k]["vfov_pred"])} for k in MODELS},
           "infer_s": {k: float(g[k]["seconds"]) for k in MODELS}}
    W, H = meta["views"]["ring"][0]["W"], meta["views"]["ring"][0]["H"]  # native size (photo aspect)
    P = pmaps(g, W, H)
    res["sky_frac_pred"] = float(P["moge_l"]["sky"].mean())
    pano = GS.Pano(pid)
    # ---------------- refs (exact renders)
    res["refs"] = []
    for x in meta["correct_refs"] + meta["wrong_refs"]:
        rec = C.load_view(pid, "refs", x["label"])
        if rec.get("empty"):
            continue
        xyz = GS.view_xyz_grid(rec)
        R = GS.render_maps_from_xyz(xyz, rec["eye"], rec["pose"])
        stated = abs(rec["eye"][2] - meta["eye"][2]) < 0.05
        row = {"label": x["label"], "verdict": x["verdict"], "pose": rec["pose"], "statedEye": stated,
               "eyeDz": rec["eye"][2] - meta["eye"][2], "terrainFrac": rec.get("terrainFrac"), "scores": score_all(P, R)}
        # pano check (same pose at stated eye) and null distribution
        xyz2, ok2 = pano.sample(rec["pose"], W, H)
        R2 = GS.render_maps_from_xyz(xyz2, pano.eye, rec["pose"], ok2)
        row["pano_cover"] = float(ok2.mean())
        row["pano_scores"] = score_all(P, R2)
        if stated:
            a, b = R["logd"], R2["logd"]
            m = ok2 & np.isfinite(a) & np.isfinite(b)
            row["pano_vs_render"] = {"medAbsLogD": float(np.median(np.abs(a[m] - b[m]))) if m.any() else None,
                                     "skyAgree": float((R["sky"] == R2["sky"])[ok2].mean())}
        row["null"] = null_scan(pano, P, rec["pose"], W, H)
        res["refs"].append(row)
    # ---------------- perturb
    res["perturb"] = []
    for v in meta["views"]["perturb"]:
        if v.get("empty"):
            continue
        rec = C.load_view(pid, "perturb", v["tag"])
        xyz = GS.view_xyz_grid(rec)
        R = GS.render_maps_from_xyz(xyz, rec["eye"], rec["pose"])
        res["perturb"].append({"tag": v["tag"], "axis": v["axis"], "offset": v["offsetDeg"], "scores": score_all(P, R)})
    # ---------------- yaw scans (pano, stated eye) at each ref's pitch/roll/vfov
    res["scans"] = []
    for x in meta["correct_refs"] + meta["wrong_refs"]:
        pose = x["pose"]
        rows = []
        for y in np.arange(0, 360, SCAN_STEP):
            q = {k: float(pose[k]) for k in ("yaw", "pitch", "roll", "vfov")}; q["yaw"] = float(y)
            xyz, ok = pano.sample(q, W, H)
            R = GS.render_maps_from_xyz(xyz, pano.eye, q, ok)
            rows.append(score_all(P, R, SCAN_MODELS))
        res["scans"].append({"label": x["label"], "verdict": x["verdict"], "pose": pose, "yaws": list(np.arange(0, 360, SCAN_STEP)),
                             "scores": rows})
        break_after_correct = x["verdict"] == "correct"
        if break_after_correct:
            break   # one scan per photo at the first correct ref's pitch/roll/vfov (else at the first wrong ref's)
    # ---------------- matcher-solved poses
    res["cands"] = []
    uniq = []
    for c in sorted(candidates(pid, meta), key=lambda c: -(c.get("inliers") or 0)):
        dup = next((u for u in uniq if rot_err(u["pose"], c["pose"]) < 0.3 and abs(u["pose"]["vfov"] - c["pose"]["vfov"]) < 0.5), None)
        if dup is not None:
            dup.setdefault("dups", []).append({"src": c["src"], "inliers": c.get("inliers"), "level": c.get("level")})
        else:
            uniq.append(c)
    for c in uniq:
        lab, ec, ew = label_pose(c["pose"], meta)
        q = {k: float(c["pose"][k]) for k in ("yaw", "pitch", "roll", "vfov")}
        xyz, ok = pano.sample(q, W, H)
        R = GS.render_maps_from_xyz(xyz, pano.eye, q, ok)
        res["cands"].append({**c, "label": lab, "errCorrect": ec, "errWrongRef": ew, "pano_cover": float(ok.mean()),
                             "scores": score_all(P, R, SCAN_MODELS), "null": null_scan(pano, P, q, W, H, step=10.0)})
    res["eval_s"] = round(time.time() - t0, 1)
    OUT.mkdir(exist_ok=True)
    with open(f, "w") as fh:
        json.dump(res, fh, default=lambda o: float(o) if isinstance(o, (np.floating, np.integer)) else str(o))
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ids", nargs="*")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--wait", action="store_true")
    a = ap.parse_args()
    ids = a.ids or tm_common.dev_ids()
    todo = list(ids)
    while todo:
        prog = False
        for pid in list(todo):
            if (tm_common.CACHE / pid / "DONE").exists() and all((GEOM / f"{pid}.{k}.npz").exists() for k in MODELS):
                t0 = time.time()
                try:
                    photo(pid, a.force)
                    print(pid, f"{time.time() - t0:.0f}s", flush=True)
                except Exception as e:  # noqa: BLE001
                    import traceback; traceback.print_exc()
                    print(pid, "ERROR", e, flush=True)
                todo.remove(pid); prog = True
        if not todo or (not a.wait) or (tm_common.CACHE / "ALL_DONE").exists() and not prog:
            if not prog and (tm_common.CACHE / "ALL_DONE").exists():
                break
            if not a.wait:
                break
        if not prog:
            time.sleep(30)


if __name__ == "__main__":
    main()
