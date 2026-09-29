"""Single-image calibration prior (GeoCalib) in the app camera convention.

    calib(photo_path) -> {"pitch", "roll", "vfov", "hfov", "sigma": {"pitch", "roll", "vfov"}, ...}   (degrees)
    calib(photo_path, vfov_source="anycalib")  -> vfov from AnyCalib instead (better focal; see REPORT.md)

Conventions (tools/matcher/stage1/skyglobal.py project_rel), verified in REPORT.md ("Conventions"):
  pitch  + = camera tilted up                       (GeoCalib pitch, same sign; corr +0.69 vs refs/GT)
  roll   + = content rotated CCW in the image, i.e. the app pose roll (GeoCalib roll, same sign;
             synthetic rotation test: rotating the content CCW by 8 deg moves GeoCalib roll by +7..+8 deg)
  vfov   = vertical FOV of the full upright photo (the photo as s1.upright_photo produces it).
sigma = GeoCalib's own 1-sigma (pitch roughly calibrated, roll conservative; vfov sigma for AnyCalib is the
empirical dev spread 0.19 in log-vfov). Note: on the dev set GeoCalib's roll is worse than assuming roll = 0.

The photo is uprighted exactly as stage 1 does (s1.upright_photo: harness normalize + service _upright_jpeg).
GeoCalib code Apache-2.0, weights CC-BY-4.0 (https://github.com/cvg/GeoCalib).
"""
from __future__ import annotations

import math
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
import torch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "stage1"))
import s1  # noqa: E402  (upright_photo)

# GeoCalib -> app sign maps (empirical, see REPORT.md "Conventions")
PITCH_SIGN = 1.0
ROLL_SIGN = 1.0

_MODELS: dict = {}


def _model(device: str, weights: str = "pinhole"):
    k = (device, weights)
    if k not in _MODELS:
        from geocalib import GeoCalib
        local = HERE / "weights" / f"geocalib-{weights}.tar"  # kept inside calib/ (not the shared torch hub)
        _MODELS[k] = GeoCalib(weights=str(local) if local.exists() else weights).to(device).eval()
    return _MODELS[k]


def upright(photo_path: str | Path) -> np.ndarray:
    with tempfile.TemporaryDirectory(prefix="calib-") as tmp:
        img, _, _ = s1.upright_photo(Path(photo_path), Path(tmp) / "u.jpg")
    return img


def calib_array(img: np.ndarray, device: str = "cpu", vfov_prior: float | None = None, weights: str = "pinhole") -> dict:
    """img: upright RGB uint8 (H, W, 3). vfov_prior (deg): optional focal prior (e.g. from EXIF)."""
    H, W = img.shape[:2]
    m = _model(device, weights)
    x = torch.from_numpy(np.ascontiguousarray(img)).permute(2, 0, 1).float().div(255).to(device)
    priors = None
    if vfov_prior is not None:
        f = H / 2 / math.tan(math.radians(vfov_prior) / 2)
        priors = {"focal": torch.tensor(f, dtype=torch.float32, device=device)}
    t0 = time.perf_counter()
    r = m.calibrate(x, camera_model="pinhole" if weights == "pinhole" else "simple_radial", priors=priors)
    if device == "mps":
        torch.mps.synchronize()
    ms = (time.perf_counter() - t0) * 1000
    cam, g = r["camera"], r["gravity"]
    roll, pitch = (float(v) for v in torch.rad2deg(g.rp)[0].cpu())
    vfov = float(torch.rad2deg(cam.vfov)[0].cpu())
    hfov = float(torch.rad2deg(cam.hfov)[0].cpu())
    d = lambda k: float(torch.rad2deg(r[k]).reshape(-1)[0].cpu())  # noqa: E731
    return {"pitch": PITCH_SIGN * pitch, "roll": ROLL_SIGN * roll, "vfov": vfov, "hfov": hfov,
            "sigma": {"pitch": d("pitch_uncertainty"), "roll": d("roll_uncertainty"), "vfov": d("vfov_uncertainty")},
            "W": W, "H": H, "ms": ms, "device": device, "focalPrior": vfov_prior}


ANYCALIB_LOG_SIGMA = 0.19  # ln(1.45)/1.96: dev 95 % |log vfov ratio| for hfov >= 25 photos


def anycalib_vfov(img: np.ndarray, device: str = "cpu") -> float:
    """AnyCalib (anycalib_pinhole, DINOv2 ViT-L, 1.3 GB, Apache-2.0) vertical FOV of an upright RGB image."""
    k = (device, "anycalib")
    if k not in _MODELS:
        from anycalib import AnyCalib
        local = HERE / "weights" / "anycalib_pinhole.pt"  # kept inside calib/ (not the shared torch hub)
        if local.exists():
            m = AnyCalib()
            m.load_state_dict(torch.load(local, map_location="cpu"), strict=True)
        else:
            m = AnyCalib(model_id="anycalib_pinhole")
        _MODELS[k] = m.to(device).eval()
    x = torch.from_numpy(np.ascontiguousarray(img)).permute(2, 0, 1).float().div(255).to(device)
    f = float(_MODELS[k].predict(x, cam_id="simple_pinhole")["intrinsics"][0].cpu())
    return 2 * math.degrees(math.atan(img.shape[0] / 2 / f))


def calib(photo_path: str | Path, device: str = "cpu", vfov_prior: float | None = None,
          vfov_source: str = "geocalib") -> dict:
    """GeoCalib pitch / roll / vfov (deg, app convention) with 1-σ uncertainties for one photo file.

    vfov_prior: EXIF vfov (deg) if known -> passed to GeoCalib as a focal prior (improves pitch on tele photos).
    vfov_source="anycalib": replace vfov with AnyCalib's (use when EXIF has no focal)."""
    img = upright(photo_path)
    r = calib_array(img, device=device, vfov_prior=vfov_prior)
    if vfov_source == "anycalib":
        v = anycalib_vfov(img, device)
        r["vfov_geocalib"], r["vfov"] = r["vfov"], v
        r["hfov"] = 2 * math.degrees(math.atan(math.tan(math.radians(v) / 2) * r["W"] / r["H"]))
        r["sigma"]["vfov"] = v * ANYCALIB_LOG_SIGMA
    r["vfovSource"] = vfov_source
    return r


if __name__ == "__main__":
    import json
    for p in sys.argv[1:]:
        print(p, json.dumps(calib(p), indent=None))
