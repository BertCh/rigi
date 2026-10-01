"""X3 matchers behind one interface.

    m = get(name); k_photo, k_render, conf = m.match(photo_img, render_img)
Coordinates: each input image's own pixel coords, CENTRE of pixel (0,0) at (0,0) (as ALIKED/LightGlue keypoints in
s1.correspond). Callers pass the photo already resized to the render image size.

  aliked   ALIKED (MPS, 4096 kp, det thr 0.01) + LightGlue on CPU (core.lg_match, the service path)   [Apache-2.0/BSD]
  loma     LoMa-B, 4096 kp, MPS fp32 (tools/matcher/v2/loma/matcher.py)                             [MIT/Apache-2.0]  HEAVY (~10 GB) -> gpu_lock
  mroma    MINIMA-RoMa: romatch (RoMa v1, MIT) with MINIMA weights (Apache-2.0), DINOv2-L (Apache-2.0) taken
           from the LoMa checkpoint (identical frozen weights); MPS; 5000 sampled matches, seed 0   HEAVY -> gpu_lock
  mloftr   MINIMA-LoFTR: kornia LoFTR (Apache-2.0) with MINIMA weights; gray, long side 640 (MINIMA test default); MPS
  mxoftr   MINIMA-XoFTR: XoFTR code (OnderT/XoFTR, Apache-2.0) with MINIMA weights; gray, long side 640; MPS
"""
from __future__ import annotations

import os
import tempfile
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
TM = HERE.parent
ROOT = TM.parents[2]
WEIGHTS = TM / "weights"
PYLIB = TM / ".pylib"
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
os.environ.setdefault("LOMA_DEVICE", "mps")
os.environ.setdefault("LOMA_PREC", "fp32")
os.environ.setdefault("LOMA_KP", "4096")
os.environ.setdefault("STAGE1_TMP", os.path.join(tempfile.gettempdir(), "rigi-x3-stage1-tmp"))
Path(os.environ["STAGE1_TMP"]).mkdir(parents=True, exist_ok=True)
sys.path.insert(0, str(TM))
import tm_common  # noqa: E402,F401  (stage1 + v2 on sys.path)

import numpy as np  # noqa: E402
import torch  # noqa: E402
from PIL import Image  # noqa: E402

HEAVY = {"loma", "mroma"}
DEV = "mps" if torch.backends.mps.is_available() else "cpu"


def _gray(img):
    import cv2
    return cv2.cvtColor(img, cv2.COLOR_RGB2GRAY) if img.ndim == 3 else img


class Aliked:
    name = "aliked"

    def __init__(self):
        import s1  # noqa: F401  patches match.models (no point pruning) and imports vendored core
        import match as M
        self.s1, self.M = s1, M
        self._pc: dict = {}

    def match(self, photo, render):
        import hashlib
        key = (photo.shape, hashlib.sha1(np.ascontiguousarray(photo).data).hexdigest())
        if key not in self._pc:
            if len(self._pc) > 8:
                self._pc.clear()
            self._pc[key] = self.M.extract("aliked", photo)
        fr = self.M.extract("aliked", render)
        k0, k1 = self.s1.core.lg_match(self._pc[key], fr)
        return k0, k1, np.ones(len(k0), np.float32)


class Loma:
    name = "loma"

    def __init__(self):
        sys.path.insert(0, str(ROOT / "tools/matcher/v2/loma"))
        import matcher as L
        assert L.DEVICE == "mps" and L.PREC == "fp32" and L.NUM_KP == 4096, (L.DEVICE, L.PREC, L.NUM_KP)
        self.L = L
        L.model()

    def match(self, photo, render):
        return self.L.match_loma(photo, render)


class MinimaRoma:
    name = "mroma"
    NUM = 5000

    def __init__(self):
        from romatch import roma_outdoor
        sd = torch.load(WEIGHTS / "minima_roma.pth", map_location="cpu")
        dino = torch.load(WEIGHTS / "dinov2_vitl14_from_loma.pth", map_location="cpu")
        self.m = roma_outdoor(device=DEV, weights=sd, dinov2_weights=dino, coarse_res=560, upsample_res=864,
                              amp_dtype=torch.float32, use_custom_corr=False)
        self.m.eval()

    @torch.inference_mode()
    def match(self, photo, render):
        H0, W0 = photo.shape[:2]
        H1, W1 = render.shape[:2]
        warp, cert = self.m.match(Image.fromarray(photo), Image.fromarray(render), device=DEV)
        torch.manual_seed(0)
        m, c = self.m.sample(warp, cert, num=self.NUM)
        k0, k1 = self.m.to_pixel_coordinates(m, H0, W0, H1, W1)
        return k0.cpu().numpy() - 0.5, k1.cpu().numpy() - 0.5, c.cpu().numpy()


def _prep_gray(img, long_side, df=8):
    import cv2
    g = _gray(img)
    h, w = g.shape
    s = long_side / max(h, w)
    wn, hn = int(round(w * s)) // df * df, int(round(h * s)) // df * df
    g = cv2.resize(g, (wn, hn), interpolation=cv2.INTER_AREA)
    t = torch.from_numpy(g)[None, None].float().div(255).to(DEV)
    return t, np.array([w / wn, h / hn])


def _unscale(k, sc):
    return (k + 0.5) * sc - 0.5


class MinimaLoftr:
    name = "mloftr"
    RES = 640

    def __init__(self):
        from kornia.feature import LoFTR
        self.m = LoFTR(pretrained=None)
        sd = torch.load(WEIGHTS / "minima_loftr.ckpt", map_location="cpu", weights_only=False)["state_dict"]
        self.m.load_state_dict({k.replace("matcher.", "", 1): v for k, v in sd.items()}, strict=True)
        self.m = self.m.eval().to(DEV)

    @torch.inference_mode()
    def match(self, photo, render):
        t0, s0 = _prep_gray(photo, self.RES)
        t1, s1 = _prep_gray(render, self.RES)
        out = self.m({"image0": t0, "image1": t1})
        k0 = out["keypoints0"].cpu().numpy()
        k1 = out["keypoints1"].cpu().numpy()
        return _unscale(k0, s0), _unscale(k1, s1), out["confidence"].cpu().numpy()


class MinimaXoftr:
    name = "mxoftr"
    RES = 640

    def __init__(self):
        sys.path.insert(0, str(PYLIB / "site"))
        sys.path.insert(0, str(PYLIB / "XoFTR"))
        from src.config.default import get_cfg_defaults
        from src.xoftr import XoFTR

        def lower(c):
            return {k.lower(): lower(v) for k, v in c.items()} if isinstance(c, dict) else c
        cfg = lower(get_cfg_defaults(inference=True))["xoftr"]
        cfg["match_coarse"]["thr"] = 0.3
        cfg["fine"]["thr"] = 0.1
        self.m = XoFTR(config=cfg)
        sd = torch.load(WEIGHTS / "minima_xoftr.ckpt", map_location="cpu", weights_only=False)["state_dict"]
        self.m.load_state_dict({k.replace("matcher.", "", 1): v for k, v in sd.items()}, strict=True)
        self.m = self.m.eval().to(DEV)

    @torch.inference_mode()
    def match(self, photo, render):
        t0, s0 = _prep_gray(photo, self.RES)
        t1, s1 = _prep_gray(render, self.RES)
        batch = {"image0": t0, "image1": t1}
        self.m(batch)
        k0 = batch["mkpts0_f"].cpu().numpy()
        k1 = batch["mkpts1_f"].cpu().numpy()
        return _unscale(k0, s0), _unscale(k1, s1), batch["mconf_f"].cpu().numpy()


_REG = {"aliked": Aliked, "loma": Loma, "mroma": MinimaRoma, "mloftr": MinimaLoftr, "mxoftr": MinimaXoftr}


def get(name):
    return _REG[name]()


if __name__ == "__main__":  # smoke test: python matchers.py <name> [pid] ; determinism x2 + timing
    import cv2
    sys.path.insert(0, str(TM / "c0_cache"))
    import cache_io as C
    name = sys.argv[1]
    pid = sys.argv[2] if len(sys.argv) > 2 else "wc_0002"
    m = get(name)
    v = C.load_view(pid, "refs", C.load_meta(pid)["perturbBase"] if (C.CACHE / pid / "meta.json").exists() else "A")
    H, W = v["rgb"].shape[:2]
    ph = cv2.resize(C.load_photo(pid), (W, H), interpolation=cv2.INTER_AREA)
    res = []
    for i in range(3):
        t = time.time()
        k0, k1, c = m.match(ph, v["rgb"])
        res.append((len(k0), time.time() - t, float(np.abs(k0).sum() + np.abs(k1).sum())))
    print(name, res, "mps mem GB", round(torch.mps.driver_allocated_memory() / 1e9, 2) if DEV == "mps" else None)
