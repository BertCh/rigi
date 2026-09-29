"""LoMa photo<->render matcher, drop-in for the ALIKED+LightGlue path in stage1/s1.py.

    match_loma(photo_rgb, view_rgb) -> (kp_photo Nx2, kp_view Nx2, conf N)
    correspond_loma(photo, views, eye)  -> same dict as s1.correspond (x2d, X, W, H, perView, matchMs)

Pixel convention: the same as LightGlue/ALIKED keypoints in s1.correspond, i.e. pixel coordinates of
each input image with the CENTRE of pixel (0, 0) at (0, 0) (s1 adds +0.5 when it builds x2d). LoMa's
own to_pixel_coords is edge-origin, so 0.5 is subtracted here.

Preprocessing replicates LoMa's path API (model.match(path_A, path_B)) exactly: detector (DaD) on the
image resized to long side 1024 (keep aspect, dims floored to /8), descriptor (DeDoDe-G = DINOv2 ViT-L +
VGG) on the image squashed to 784x784 (PIL bicubic), mutual-NN filter at score > 0.1.

Device / precision are fixed per process (LoMa binds loma.device at import) via env:
    LOMA_DEVICE = cpu (default) | mps
    LOMA_PREC   = fp32 (default) | fp16 (LoMa's own MPS default: autocast fp16, DINOv2 in fp16)
    LOMA_MODEL  = B (default) | G
    LOMA_KP     = keypoints per image (default 2048 = LoMa default)
Weights: ~/.cache/torch/hub/checkpoints (loma_B.pt 723 MB, loma_G.pth 1.4 GB, dad.pth 25 MB). The DINOv2
checkpoint LoMa would otherwise download separately (1.2 GB) is not fetched: the LoMa checkpoints carry
the frozen DINOv2 weights themselves (the missing-keys assert in LoMa guards this).
"""
from __future__ import annotations

import hashlib
import os
import sys
import time
import types

import numpy as np
import torch
from PIL import Image

DEVICE = os.environ.get("LOMA_DEVICE", "cpu")
PREC = os.environ.get("LOMA_PREC", "fp32")
MODEL = os.environ.get("LOMA_MODEL", "B")
NUM_KP = int(os.environ.get("LOMA_KP", 2048))
DET_RES = 1024
DESC_RES = 784
FILTER_TH = 0.1
# LoMa weights live outside the repo, independent of TORCH_HOME (tools/matcher/match.py points TORCH_HOME
# at tools/matcher/weights for the service's own models).
WEIGHTS_DIR = os.environ.get("LOMA_WEIGHTS", os.path.expanduser("~/.cache/torch/hub/checkpoints"))

_model = None
_cache: dict = {}


def _install_device_stub():
    """loma/device.py picks mps when available and fp16/bf16 autocast; every loma module does
    `from loma.device import device, amp_dtype` at import, so the choice must be made before import."""
    if "loma.loma" in sys.modules:
        return
    dev = torch.device(DEVICE)
    amp = torch.float32 if PREC == "fp32" else (torch.float16 if DEVICE == "mps" else torch.bfloat16)
    import importlib.util
    spec = importlib.util.find_spec("loma")  # locate the package without executing __init__
    pkg = types.ModuleType("loma")
    pkg.__path__ = list(spec.submodule_search_locations)
    pkg.__spec__ = spec
    sys.modules["loma"] = pkg
    stub = types.ModuleType("loma.device")
    stub.device, stub.amp_dtype = dev, amp
    sys.modules["loma.device"] = stub
    pkg.device = stub


def model():
    global _model
    if _model is not None:
        return _model
    if DEVICE == "cpu":
        torch.set_num_threads(int(os.environ.get("LOMA_THREADS", os.cpu_count() or 8)))
    _install_device_stub()
    import warnings
    warnings.filterwarnings("ignore", message=".*autocast.*")
    from loma.loma import LoMa, LoMaB, LoMaG
    orig = torch.hub.load_state_dict_from_url

    def hub(url, *a, **k):
        if "dinov2_vitl14_pretrain" in url:  # carried by the LoMa checkpoint; skip the 1.2 GB download
            from loma.descriptor.transformer import vit_large
            return vit_large(img_size=518, patch_size=14, init_values=1.0, ffn_layer="mlp", block_chunks=0).state_dict()
        k["model_dir"] = WEIGHTS_DIR
        return orig(url, *a, **k)
    torch.hub.load_state_dict_from_url = hub
    try:
        cfg = (LoMaG if MODEL == "G" else LoMaB)(mp=(PREC != "fp32"), num_keypoints=NUM_KP)
        _model = LoMa(cfg).eval()
    finally:
        torch.hub.load_state_dict_from_url = orig
    return _model


def _to_t(img: np.ndarray) -> torch.Tensor:
    return torch.from_numpy(img.astype(np.float32) / 255.0).permute(2, 0, 1)[None].contiguous()


@torch.inference_mode()
def features(img: np.ndarray, num_kp: int | None = None) -> dict:
    """DaD keypoints (normalised [-1,1], align_corners=False) + DeDoDe-G descriptors for one RGB uint8 image."""
    m = model()
    H, W = img.shape[:2]
    s = DET_RES / max(W, H)
    wd, hd = int((s * W) // 8 * 8), int((s * H) // 8 * 8)
    im = Image.fromarray(img)
    det = _to_t(np.array(im.resize((wd, hd)))).to(DEVICE)
    kp = m._detector.detect(det, num_keypoints=num_kp or NUM_KP)["keypoints"]
    des = _to_t(np.array(im.resize((DESC_RES, DESC_RES)))).to(DEVICE)
    d = m._descriptor.describe_keypoints(des, kp)["descriptions"]
    return {"kp": kp, "desc": d, "H": H, "W": W}


def _cached_features(img: np.ndarray, num_kp=None) -> dict:
    key = (hashlib.sha1(np.ascontiguousarray(img).data).hexdigest(), img.shape, num_kp or NUM_KP)
    f = _cache.get(key)
    if f is None:
        if len(_cache) > 8:
            _cache.clear()
        f = _cache[key] = features(img, num_kp)
    return f


@torch.inference_mode()
def match_features(fa: dict, fb: dict, filter_threshold: float = FILTER_TH):
    from loma.loma import filter_matches
    m = model()
    scores = m(fa["kp"], fb["kp"], fa["desc"], fb["desc"])["scores"]
    m0, _, ms0, _ = filter_matches(scores.float(), filter_threshold)
    valid = (m0[0] > -1)
    ia = torch.where(valid)[0]
    ib = m0[0][valid]
    ka = fa["kp"][0][ia].float().cpu().numpy()
    kb = fb["kp"][0][ib].float().cpu().numpy()
    conf = ms0[0][ia].float().cpu().numpy()

    def px(k, H, W):  # LoMa normalised → edge-origin px → pixel-centre px
        return np.stack([W * (k[:, 0] + 1) / 2, H * (k[:, 1] + 1) / 2], 1) - 0.5
    return px(ka, fa["H"], fa["W"]), px(kb, fb["H"], fb["W"]), conf


def match_loma(photo_rgb: np.ndarray, view_rgb: np.ndarray, num_kp: int | None = None,
               filter_threshold: float = FILTER_TH):
    """→ (kp_photo Nx2, kp_view Nx2, conf N) in each image's own pixel coordinates (pixel-centre origin,
    as ALIKED/LightGlue keypoints). The photo's features are cached (a photo is matched against many views)."""
    fa = _cached_features(photo_rgb, num_kp)
    fb = features(view_rgb, num_kp)
    return match_features(fa, fb, filter_threshold)


def correspond_loma(photo: np.ndarray, views, eye, num_kp: int | None = None) -> dict:
    """s1.correspond with LoMa as the matcher: photo resized to the render size, matches lifted through
    each view's xyz with the service's lift (range > 250 m, no depth discontinuity)."""
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "stage1"))
    import s1  # noqa: F401  (sets up sys.path for match / core)
    import match as M
    import core
    t0 = time.time()
    eye = np.asarray(eye, float)
    H, W = views[0].xyz.shape[:2]
    if photo.shape[:2] != (H, W):
        photo = np.array(Image.fromarray(photo).resize((W, H), Image.LANCZOS))
    bad = [v.tag for v in views if core.check_view(v, eye) > 2.0]
    if bad:
        raise ValueError(f"xyz buffer does not reproject under its pose for views {bad}")
    X2, X3, per = [], [], []
    for v in views:
        k0, k1, _ = match_loma(photo, v.rgb, num_kp)
        X, ok = M.lift(k1, v.xyz, eye)
        per.append({"tag": v.tag, "matches": int(len(k0)), "lifted": int(ok.sum())})
        X2.append(k0[ok] + 0.5)
        X3.append(X[ok])
    x2d = np.concatenate(X2) if X2 else np.zeros((0, 2))
    X = np.concatenate(X3) if X3 else np.zeros((0, 3))
    return {"x2d": x2d, "X": X, "W": W, "H": H, "perView": per, "matchMs": round((time.time() - t0) * 1000)}
