"""Run GeoCalib on every DEV photo (refs.dev_ids) + the 12 app GT photos -> pred_dev.json.
Never touches the test half of tools/bench/split.json or tools/bench/data_v3."""
from __future__ import annotations
import json, math, sys, time
from pathlib import Path
import numpy as np
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE)); sys.path.insert(0, str(HERE.parent))
import calib as C  # noqa: E402
import refs  # noqa: E402
ROOT = HERE.parents[3]
MAN = ROOT / "tools/bench/data/manifest.json"
split = json.load(open(ROOT / "tools/bench/split.json"))
DEV = refs.dev_ids()
assert set(DEV) <= set(split["dev"]) and not set(DEV) & set(split["test"])

vfov_from_hfov = lambda h, a: 2 * math.degrees(math.atan(math.tan(math.radians(h) / 2) / a))  # noqa: E731
hfov_from_vfov = lambda v, a: 2 * math.degrees(math.atan(math.tan(math.radians(v) / 2) * a))  # noqa: E731
GT_NEAR = {"IMG_7059", "IMG_7063", "IMG_7068", "IMG_7130"}  # dominant skyline <= 5 km (GT notes)


def exif_vfov(e, W, H):  # same order as s1.Photo
    a = W / H
    if e.get("vfovDeg"):
        return float(e["vfovDeg"])
    if e.get("hfovDeg"):
        return vfov_from_hfov(float(e["hfovDeg"]), a)
    if e.get("focal35mm"):
        fpx = e["focal35mm"] * math.hypot(W, H) / 43.2666
        return 2 * math.degrees(math.atan(H / 2 / fpx))
    return None


def items():
    man = {e["id"]: e for e in json.load(open(MAN))}
    for pid in DEV:
        e = man[pid]
        src = Path(e["file"]); src = src if src.is_absolute() else MAN.parent / src
        cr = refs.correct_refs(pid)
        truth = None
        if cr:
            P = np.array([[r["pose"]["pitch"], r["pose"]["roll"], r["pose"]["vfov"]] for r in cr])
            truth = {"pitch": float(np.median(P[:, 0])), "roll": float(np.median(P[:, 1])), "vfov": float(np.median(P[:, 2])),
                     "nRefs": len(cr), "spread": float(np.ptp(P[:, :2], axis=0).max())}
        yield pid, "dev", src, e, truth, e["tags"].get("skylineDist")
    gt = json.load(open(ROOT / "data/ground-truth.json"))
    for pid, g in gt.items():
        truth = None
        if g.get("f"):
            truth = {"pitch": g["pitch"], "roll": g["roll"], "vfov": 2 * math.degrees(math.atan(g["height"] / 2 / g["f"])),
                     "nRefs": 1, "spread": 0.0, "quality": g.get("quality")}
        ef = (g.get("prior") or {}).get("f")
        e = {"_gtPriorVfov": 2 * math.degrees(math.atan(g["height"] / 2 / ef)) if ef else None}
        yield pid, "gt", ROOT / "public/photos" / f"{pid}.jpg", e, truth, "near" if pid in GT_NEAR else "far"


def main():
    out = {}
    for pid, setn, src, e, truth, dist in items():
        img = C.upright(src)
        H, W = img.shape[:2]
        fv = e["_gtPriorVfov"] if setn == "gt" else exif_vfov(e, W, H)
        rec = {"set": setn, "W": W, "H": H, "skyline": dist, "focalKnown": fv is not None, "exifVfov": fv,
               "defaultVfov": vfov_from_hfov(50.0, W / H), "truth": truth}
        if truth:
            rec["truth"]["hfov"] = hfov_from_vfov(truth["vfov"], W / H)
        rec["free"] = C.calib_array(img, "cpu")
        rec["free_mps"] = C.calib_array(img, "mps")
        if fv is not None:
            rec["prior"] = C.calib_array(img, "cpu", vfov_prior=fv)
        out[pid] = rec
        f = rec["free"]
        print(pid, setn, f"p {f['pitch']:+.1f}±{f['sigma']['pitch']:.1f} r {f['roll']:+.1f}±{f['sigma']['roll']:.1f} v {f['vfov']:.1f}",
              "| truth", None if not truth else f"p {truth['pitch']:+.1f} r {truth['roll']:+.1f} v {truth['vfov']:.1f}",
              f"| {f['ms']:.0f}ms cpu {rec['free_mps']['ms']:.0f}ms mps", flush=True)
    # steady-state timing (models warm): 10 repeats on one photo each device
    img = C.upright(ROOT / "public/photos/IMG_7086.jpg")
    tm = {}
    for dev in ("cpu", "mps"):
        ts = [C.calib_array(img, dev)["ms"] for _ in range(10)]
        tm[dev] = {"median_ms": float(np.median(ts)), "min_ms": float(min(ts))}
    json.dump({"_meta": {"model": "GeoCalib pinhole v1.0", "timing_warm_2048px": tm,
                         "note": "free = no priors; prior = EXIF focal prior; angles deg, app convention (see calib.py)"}, **out},
              open(HERE / "pred_dev.json", "w"), indent=1)
    print(tm)


if __name__ == "__main__":
    main()
