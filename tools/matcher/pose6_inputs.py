"""Inputs for pose6 on bench photos (tools/bench/**, read-only) via the render worker, plus the
re-render confirmation callback. Work files go to tools/bench/t5/work/<id>/ (renders deleted after use;
the compact inputs.npz is kept so a photo can be re-solved without the worker)."""
from __future__ import annotations

import json
import math
import shutil
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

import fusion as F
from common import focal_px, pose_to_R
from pose6 import Problem
from worker_client import Worker

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
BENCH = ROOT / "tools" / "bench"
WORK = BENCH / "t5" / "work"
NARROW_HFOV = 20.0


def start_worker():
    return Worker()


def manifest_entry(bid):
    return next(e for e in json.loads((BENCH / "data" / "manifest.json").read_text()) if e["id"] == bid)


def fused_result(bid):
    return json.loads((BENCH / "harness" / "out" / "runs" / "wild" / "results" / bid / "given.fused.json").read_text())


def upright_photo(src: Path, dst: Path):
    im = ImageOps.exif_transpose(Image.open(src)).convert("RGB")
    dst.parent.mkdir(parents=True, exist_ok=True)
    im.save(dst, quality=95)
    return im.size


def _check_view(v, eye):
    xyz = v["xyzArr"]
    H, W, _ = xyz.shape
    ys, xs = np.nonzero((xyz != 0).any(2))
    if len(ys) == 0:
        return math.inf
    i = np.random.default_rng(0).choice(len(ys), min(300, len(ys)), replace=False)
    c = (xyz[ys[i], xs[i]].astype(float) - eye) @ pose_to_R(v["pose"]).T
    f = focal_px(v["pose"]["vfov"], H)
    p = np.stack([W / 2 + f * c[:, 0] / c[:, 2], H / 2 + f * c[:, 1] / c[:, 2]], 1)
    return float(np.median(np.linalg.norm(p - np.stack([xs[i] + .5, ys[i] + .5], 1), axis=1)))


def render(worker, adhoc, prior, offsets, outdir, skyline=True, views=True):
    req = {"cmd": "render", "adhoc": adhoc, "prior": prior, "skyline": skyline, "outDir": str(outdir), "allowEmpty": True}
    if views:
        req["offsets"] = offsets
    else:
        req["views"] = False
    r = worker.call(req, timeout=900)
    if not r.get("ok"):
        raise RuntimeError(f"render failed: {r.get('error')}")
    return r


def sky_from_worker(r):
    s = r.get("skyline")
    if not s:
        return None
    rd = lambda k: np.fromfile(s["files"][k], np.float32)  # noqa: E731
    return F.skyline_from_arrays(s["w"], s["h"], rd("fine"), rd("fg"), rd("sky"), rd("horizon"), app=s.get("app"))


def correspond(photo_rgb, views, eye):
    import match as M
    X2, X3 = [], []
    fp = None
    for v in views:
        if fp is None:
            H, W = v["xyzArr"].shape[:2]
            ph = np.array(Image.fromarray(photo_rgb).resize((W, H), Image.LANCZOS))
            fp = M.extract("aliked", ph)
        k0, k1, _ = M.match("aliked", fp, M.extract("aliked", v["rgbArr"]))
        X, ok = M.lift(k1, v["xyzArr"], eye)
        X2.append(k0[ok] + 0.5)
        X3.append(X[ok])
    if not X2:
        return None
    return np.concatenate(X2).astype(np.float64), np.concatenate(X3)


def problem_bench(bid: str, worker, fast=False) -> Problem:
    wd = WORK / bid
    cache = wd / "inputs.npz"
    e = manifest_entry(bid)
    fr = fused_result(bid)
    pose0 = {k: float(fr["pose"][k]) for k in ("yaw", "pitch", "roll", "vfov")}
    focal_known = bool(fr.get("assumptions", {}).get("focalKnown"))
    regime = "exif" if e.get("positionSource") == "exif-gps" else "manual"
    if not cache.exists():
        photo = wd / "photo.jpg"
        Wp, Hp = upright_photo(BENCH / "data" / e["file"], photo)
        adhoc = {"id": f"t5-{bid}", "photoFile": str(photo), "region": None,
                 "meta": {"lat": e["lat"], "lon": e["lon"], "alt": e.get("altitudeM"), "width": Wp, "height": Hp,
                          "heading": pose0["yaw"], "pitch": pose0["pitch"], "roll": pose0["roll"], "vfov": pose0["vfov"],
                          "f35": e.get("focal35mm")}}
        hfov = 2 * math.degrees(math.atan(math.tan(math.radians(pose0["vfov"]) / 2) * Wp / Hp))
        offs = [round(k * hfov, 4) for k in (-0.5, -0.25, 0, 0.25, 0.5)] if hfov < NARROW_HFOV else [-20, -10, 0, 10, 20]
        rd = wd / "r"
        r = render(worker, adhoc, pose0, offs, rd)
        eye = np.array(r["meta"]["eye"], float)
        views = []
        for v in r["views"]:
            xyz = np.fromfile(v["xyz"], np.float32).reshape(v["H"], v["W"], 3)
            vv = {"pose": v["pose"], "xyzArr": xyz, "rgbArr": np.array(Image.open(v["rgb"]).convert("RGB"))}
            if _check_view(vv, eye) > 2.0:
                raise RuntimeError(f"stale xyz buffer in view {v['tag']}")
            views.append(vv)
        s = r["skyline"]
        rdf = lambda k: np.fromfile(s["files"][k], np.float32)  # noqa: E731
        W, H = (views[0]["xyzArr"].shape[1], views[0]["xyzArr"].shape[0]) if views else (1024, round(1024 * Hp / Wp))
        cr = correspond(np.array(Image.open(photo).convert("RGB")), views, eye) if views else None
        np.savez_compressed(cache, fine=rdf("fine"), fg=rdf("fg"), sky=rdf("sky"), horizon=rdf("horizon"),
                            x2d=cr[0] if cr else np.zeros((0, 2)), X=cr[1] if cr else np.zeros((0, 3)),
                            meta=json.dumps({"w": s["w"], "h": s["h"], "app": s.get("app"), "eye": eye.tolist(),
                                             "frame": r["meta"]["frame"], "W": W, "H": H, "adhoc": adhoc}))
        shutil.rmtree(rd, ignore_errors=True)
    z = np.load(cache)
    m = json.loads(str(z["meta"]))
    sk = F.skyline_from_arrays(m["w"], m["h"], z["fine"], z["fg"], z["sky"], z["horizon"], app=m.get("app"))
    corr = {"x2d": z["x2d"].astype(np.float64), "X": z["X"], "W": m["W"], "H": m["H"]} if len(z["x2d"]) else None
    return Problem(bid, m["W"], m["H"], sk, corr, m["eye"], m["frame"]["lat"], m["frame"]["lon"], pose0, focal_known, regime,
                   {"adhoc": m["adhoc"], "positionSource": e.get("positionSource")}, fast=fast)


def make_confirm(pid, prob: Problem, worker):
    """Re-render at a new eye: the app's own horizon and skyline cue there (views skipped)."""
    if pid.startswith("IMG_"):
        pm = next(p for p in json.loads((ROOT / "public" / "photos" / "photos.json").read_text()) if p["id"] == pid)
        base = {"id": f"t5-{pid}", "photoFile": str(ROOT / "public" / "photos" / f"{pid}.jpg"), "region": None,
                "meta": {"lat": pm["lat"], "lon": pm["lon"], "alt": pm["alt"], "width": pm["width"], "height": pm["height"],
                         "heading": pm["heading"], "pitch": pm["pitch"], "roll": pm["roll"], "vfov": pm["vfov"], "f35": pm["f35"]}}
    else:
        base = prob.meta["adhoc"]

    def confirm(lat, lon, h, pose):
        adhoc = {**base, "meta": {**base["meta"], "lat": lat, "lon": lon, "alt": h, "heading": pose["yaw"],
                                  "pitch": pose["pitch"], "roll": pose["roll"], "vfov": pose["vfov"]}}
        d = WORK / pid / "confirm"
        r = render(worker, adhoc, pose, [], d, skyline=True, views=False)
        sk = sky_from_worker(r)
        shutil.rmtree(d, ignore_errors=True)
        return sk
    return confirm
