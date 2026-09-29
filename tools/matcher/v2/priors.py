"""Optional single-image calibration priors for v2 (OFF by default; see reports/matching-v2.md §priors).

    pred(pid, photo_path=None) -> {"pitch", "sigmaPitch", "vfovAny"} from the cached dev predictions
                                  (calib/pred_dev.json GeoCalib-with-EXIF-prior / free, calib/pred_anycalib.json),
                                  else computed on CPU with calib/calib.py (slow first call; weights required).
    sky_grid(vfov0, focal_known, aspect, p, use_pitch, use_focal) -> (vfovs, pitches) for SkyGlobal
    patch_skyglobal(get_pred, use_pitch, use_focal)  monkeypatches SG.SkyGlobal.search for this process
    probe_vfovs(ph, p, use_focal) -> vfov list for the eye-probe fine sweep

GeoCalib pitch fan: centre = GeoCalib pitch (EXIF focal prior when known), half-width min(15, max(4, 2.5σ)),
never narrowed for narrow photos (calib/REPORT.md recommendation). AnyCalib focal (focal-unknown photos only):
hfov ∈ AnyCalib × {0.87, 1, 1.15} for the sky grid, a single AnyCalib vfov for the probe fine sweep.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "stage1"))
import skyglobal as SG  # noqa: E402

_GEO = _ANY = None
SNAP = True


def _load():
    global _GEO, _ANY
    if _GEO is None:
        _GEO = json.load(open(HERE / "calib" / "pred_dev.json"))
        _ANY = json.load(open(HERE / "calib" / "pred_anycalib.json"))


def pred(pid: str, photo_path: str | None = None, focal_known: bool = True) -> dict | None:
    _load()
    g = _GEO.get(pid)
    a = _ANY.get(pid)
    if g is None and photo_path:  # not cached: compute on CPU (deterministic; MPS differs, calib/REPORT.md)
        sys.path.insert(0, str(HERE / "calib"))
        import calib as C  # noqa: E402
        g = {"free": C.calib(photo_path, device="cpu")}
        a = C.calib(photo_path, device="cpu", vfov_source="anycalib")
    if g is None:
        return None
    gp = g.get("prior") if (focal_known and g.get("prior")) else g.get("free")
    return {"pitch": float(gp["pitch"]), "sigmaPitch": float(gp["sigma"]["pitch"]),
            "vfovAny": float(a["vfov"]) if a and a.get("vfov") else None}


def hfov(vf, aspect):
    return 2 * math.degrees(math.atan(math.tan(math.radians(vf) / 2) * aspect))


def vfov(hf, aspect):
    return 2 * math.degrees(math.atan(math.tan(math.radians(hf) / 2) / aspect))


def sky_grid(vfov0, focal_known, aspect, p, use_pitch, use_focal, pitch_range=15.0):
    if focal_known:
        vfovs = [vfov0 * s for s in (0.94, 1.0, 1.06)]
    elif use_focal and p and p.get("vfovAny"):
        h0 = hfov(p["vfovAny"], aspect)
        vfovs = [vfov(min(100.0, max(10.0, h0 * s)), aspect) for s in (0.87, 1.0, 1.15)]
    else:
        vfovs = [vfov(hf, aspect) for hf in (35, 45, 55, 65, 75)]
    pstep = max(0.5, min(1.5, min(vfovs) / 30))
    if use_pitch and p:
        half = min(pitch_range, max(4.0, 2.5 * p["sigmaPitch"]))
        c = float(p["pitch"])
        lo, hi = c - half, c + half
        base = np.arange(-pitch_range, pitch_range + 1e-9, pstep)
        if SNAP:  # the fan as a subset of T6's own pitch samples (same phase), so only the range changes
            pitches = base[(base >= lo - 1e-9) & (base <= hi + 1e-9)]
            if len(pitches) == 0:
                pitches = base[[int(np.argmin(np.abs(base - c)))]]
        else:  # first version: free-phase fan centred on the estimate (clipped to ±15)
            c = float(np.clip(c, -pitch_range, pitch_range))
            lo, hi = max(-30.0, c - half), min(30.0, c + half)
            pitches = np.arange(lo, hi + 1e-9, pstep)
    else:
        pitches = np.arange(-pitch_range, pitch_range + 1e-9, pstep)
    return vfovs, pitches, pstep


def search(sg: SG.SkyGlobal, vfov0, focal_known, k=6, nms_deg=None, vfovs=None, pitches=None, pstep=None, roll_range=9.0):
    """SG.SkyGlobal.search with an explicit (vfovs, pitches) grid; identical otherwise (verified in _prior_ab.py)."""
    rolls = np.arange(-roll_range, roll_range + 1e-9, 1.5)
    g = sg.grid(vfovs, pitches, rolls)
    yaw, best, arg = g["yaw"], g["best"], g["arg"]
    hf0 = hfov(vfov0, sg.aspect)
    nms = nms_deg or max(3.0, 0.25 * hf0)
    order = np.argsort(-best)
    n = len(yaw)
    peaks = []
    for i in order:
        if not np.isfinite(best[i]) or best[i] <= 0:
            break
        if not (best[i] >= best[(i - 1) % n] and best[i] >= best[(i + 1) % n]):
            continue
        if all(abs(((yaw[i] - q["yaw"] + 540) % 360) - 180) >= nms for q in peaks):
            peaks.append({"yaw": float(yaw[i]), "vfov": float(arg[i, 0]), "pitch": float(arg[i, 1]), "roll": float(arg[i, 2]),
                          "coarse": float(best[i])})
        if len(peaks) >= 2 * k:
            break
    import time
    t0 = time.time()
    hyps = []
    for pk in peaks:
        st = {k2: pk[k2] for k2 in ("yaw", "pitch", "roll", "vfov")}
        p1, _ = sg.refine(st, vfov0 if focal_known else None, 0.08, fine=False)
        p2, s2 = sg.refine(p1, vfov0 if focal_known else None, 0.08, fine=True)
        hyps.append({"pose": {k2: float(v) for k2, v in p2.items()}, "score": float(s2), "coarse": pk["coarse"]})
    hyps.sort(key=lambda h: -h["score"])
    out = []
    for hy in hyps:
        if all(abs(((hy["pose"]["yaw"] - q["pose"]["yaw"] + 540) % 360) - 180) >= 1.0 for q in out):
            out.append(hy)
    return {"hyps": out[:k], "gridMs": g["ms"], "refineMs": round((time.time() - t0) * 1000),
            "grid": {"vfovs": list(map(float, vfovs)), "pitches": [float(pitches[0]), float(pitches[-1]), pstep],
                     "rolls": [float(rolls[0]), float(rolls[-1]), 1.5], "astep": g["astep"], "prior": True}}


def patch_skyglobal(get_pred, use_pitch: bool, use_focal: bool):
    """Route every SkyGlobal.search in this process through the prior grid. get_pred() → pred dict for the photo
    currently being processed (or None → default grid)."""
    orig = SG.SkyGlobal.search

    def _search(self, vfov0, focal_known, k=6, nms_deg=None, pitch_range=15.0, roll_range=9.0):
        p = get_pred()
        if not p:
            return orig(self, vfov0, focal_known, k=k, nms_deg=nms_deg, pitch_range=pitch_range, roll_range=roll_range)
        vfovs, pitches, pstep = sky_grid(vfov0, focal_known, self.aspect, p, use_pitch, use_focal, pitch_range)
        return search(self, vfov0, focal_known, k, nms_deg, vfovs, pitches, pstep, roll_range)

    SG.SkyGlobal.search = _search
    return orig


def probe_vfovs(ph, p, use_focal):
    if ph.focal_known or not use_focal or not p or not p.get("vfovAny"):
        return None
    return [float(p["vfovAny"])]
