"""Model wrappers + a one-model-at-a-time manager holding the machine-wide GPU lock while a model is loaded."""
from __future__ import annotations

import fcntl
import gc
import importlib.util
import math
import os
import sys
import threading
import time
from pathlib import Path

import numpy as np

import _env

MOGE = {"moge2": "moge-2-vitl-normal", "moge2b": "moge-2-vitb-normal"}
DA3_NAME = "DA3-BASE"

LICENCES = {
    "moge2": "MoGe-2 ViT-L normal: MIT (code + weights, HF card Ruicheng/moge-2-vitl-normal); DINOv2 backbone Apache-2.0",
    "moge2b": "MoGe-2 ViT-B normal: MIT (code + weights, HF card Ruicheng/moge-2-vitb-normal)",
    "da3": "Depth-Anything-3 DA3-BASE: Apache-2.0 (code + weights, HF card depth-anything/DA3-BASE)",
    "lift": "derived from the chosen depth model (default moge2, MIT)",
    "sharp": "Apple ml-sharp: code under Apple sample-code LICENSE; WEIGHTS RESEARCH-ONLY (Apple Machine Learning Research "
             "Model License: non-commercial research, no product use). Dev flag only; see tools/nearfield/service/weights/LICENSE_MODEL_SHARP.txt",
}


class ServiceError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def device_name() -> str:
    import torch

    forced = os.environ.get("NEARFIELD_DEVICE")
    if forced:
        return forced
    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def sharp_status() -> tuple[bool, str]:
    if not (_env.SHARP_SRC / "sharp" / "models" / "predictor.py").exists():
        return False, f"ml-sharp source not found at {_env.SHARP_SRC}"
    if not _env.SHARP_CKPT.exists():
        return False, f"SHARP checkpoint not found at {_env.SHARP_CKPT} (download https://ml-site.cdn-apple.com/models/sharp/sharp_2572gikvuh.pt)"
    for m in ("timm", "plyfile"):
        try:
            __import__(m)
        except Exception as e:  # noqa: BLE001
            return False, f"SHARP dependency {m} not importable: {e}"
    return True, "ok (research-only weights)"


def _spec(name: str) -> bool:
    try:
        return importlib.util.find_spec(name) is not None
    except Exception:  # noqa: BLE001
        return False


def _deps_status(weights: Path, pkg: str) -> tuple[bool, str]:
    """Cheap availability check: weights on disk and the packages findable, WITHOUT importing torch or loading a model."""
    try:
        if not weights.exists():
            return False, f"weights not found at {weights}"
        for m in (pkg, "torch"):
            if not _spec(m):
                return False, f"python package {m} not installed"
        return True, "ok"
    except Exception as e:  # noqa: BLE001
        return False, f"status check failed: {e}"


def moge_status(key: str) -> tuple[bool, str]:
    return _deps_status(_env.X2_WEIGHTS / MOGE[key] / "model.pt", "moge")


def da3_status() -> tuple[bool, str]:
    return _deps_status(_env.X2_WEIGHTS / DA3_NAME, "depth_anything_3")


class GpuLock:
    """flock on tools/research/tm/.gpu.lock (the same file tm_common.gpu_lock() uses), with a wait timeout."""

    def __init__(self):
        self.fh = None

    @property
    def held(self) -> bool:
        return self.fh is not None

    def acquire(self, timeout_s: float):
        if self.fh is not None:
            return
        if os.environ.get("NEARFIELD_NO_GPU_LOCK") == "1":
            self.fh = False  # sentinel: "held" without a file
            return
        f = open(_env.GPU_LOCK_FILE, "w")
        t0 = time.time()
        warned = False
        while True:
            try:
                fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.fh = f
                return
            except BlockingIOError:
                if time.time() - t0 > timeout_s:
                    f.close()
                    raise ServiceError(503, "gpu_busy", f"GPU lock {_env.GPU_LOCK_FILE} held by another job for > {timeout_s:.0f}s")
                if not warned and time.time() - t0 > 5:
                    print("[nearfield] waiting for GPU lock...", file=sys.stderr, flush=True)
                    warned = True
                time.sleep(1)

    def release(self):
        if self.fh:
            fcntl.flock(self.fh, fcntl.LOCK_UN)
            self.fh.close()
        self.fh = None


class MoGeNet:
    def __init__(self, key: str, dev: str):
        import torch
        from moge.model.v2 import MoGeModel

        self.name = MOGE[key]
        self.m = MoGeModel.from_pretrained(str(_env.X2_WEIGHTS / self.name / "model.pt")).to(dev).eval()
        self.dev = dev
        self.torch = torch

    def depth(self, rgb: np.ndarray, fov_x: float | None) -> dict:
        torch = self.torch
        with torch.no_grad():
            x = torch.from_numpy(rgb).float().div(255).permute(2, 0, 1).to(self.dev)
            o = self.m.infer(x, use_fp16=False, fov_x=fov_x)
        K = o["intrinsics"].float().cpu().numpy()
        d = o["depth"].float().cpu().numpy()
        msk = o["mask"].cpu().numpy().astype(bool)
        nrm = o["normal"].float().cpu().numpy() if o.get("normal") is not None else None
        d = np.where(msk & np.isfinite(d), d, 0).astype(np.float32)
        if nrm is not None:
            nrm = np.where(np.isfinite(nrm), nrm, 0).astype(np.float32)
        return {"depth": d, "valid": (d > 0), "normal": nrm, "model": self.name,
                "intrinsicsNorm": {"fx": float(K[0, 0]), "fy": float(K[1, 1]), "cx": float(K[0, 2]), "cy": float(K[1, 2])}}


class DA3Net:
    def __init__(self, dev: str):
        from depth_anything_3.api import DepthAnything3

        self.m = DepthAnything3.from_pretrained(str(_env.X2_WEIGHTS / DA3_NAME)).to(dev).eval()
        self.name = "da3-base"

    def run(self, rgbs: list[np.ndarray], process_res: int, extrinsics=None, intrinsics=None):
        import torch

        with torch.no_grad():
            return self.m.inference(rgbs, extrinsics=extrinsics, intrinsics=intrinsics, process_res=process_res,
                                    ref_view_strategy="first")

    def depth(self, rgb: np.ndarray, process_res: int = 756) -> dict:
        p = self.run([rgb], process_res)
        d = np.asarray(p.depth[0], np.float32)
        h, w = d.shape
        valid = np.isfinite(d) & (d > 0)
        sky = getattr(p, "sky", None)
        if sky is not None:
            valid &= ~(np.asarray(sky[0]) > 0.5)
        out = {"depth": np.where(valid, d, 0).astype(np.float32), "valid": valid, "normal": None, "model": self.name}
        if getattr(p, "intrinsics", None) is not None:
            K = np.asarray(p.intrinsics[0], np.float64)
            out["intrinsicsNorm"] = {"fx": K[0, 0] / w, "fy": K[1, 1] / h, "cx": K[0, 2] / w, "cy": K[1, 2] / h}
        return out


class SharpNet:
    INTERNAL = 1536

    def __init__(self, dev: str):
        import torch
        from sharp.models import PredictorParams, create_predictor

        sd = torch.load(str(_env.SHARP_CKPT), weights_only=True, map_location="cpu")
        m = create_predictor(PredictorParams())
        m.load_state_dict(sd)
        del sd
        self.m = m.eval().to(dev)
        self.dev = dev
        self.name = "sharp-2572gikvuh"

    def predict(self, rgb: np.ndarray, f_px: float):
        import torch
        import torch.nn.functional as F
        from sharp.utils import color_space as cs
        from sharp.utils.gaussians import unproject_gaussians

        dev = torch.device(self.dev)
        with torch.no_grad():
            im = torch.from_numpy(np.ascontiguousarray(rgb)).float().to(dev).permute(2, 0, 1) / 255.0
            _, h, w = im.shape
            disp = torch.tensor([f_px / w]).float().to(dev)
            S = self.INTERNAL
            imr = F.interpolate(im[None], size=(S, S), mode="bilinear", align_corners=True)
            g_ndc = self.m(imr, disp)
            K = torch.tensor([[f_px, 0, w / 2, 0], [0, f_px, h / 2, 0], [0, 0, 1, 0], [0, 0, 0, 1]]).float().to(dev)
            Kr = K.clone()
            Kr[0] *= S / w
            Kr[1] *= S / h
            g = unproject_gaussians(g_ndc, torch.eye(4).to(dev), Kr, (S, S))
            pos = g.mean_vectors.flatten(0, 1).float().cpu().numpy()
            scl = g.singular_values.flatten(0, 1).float().cpu().numpy()
            q = g.quaternions.flatten(0, 1).float().cpu().numpy()
            col = cs.linearRGB2sRGB(g.colors.flatten(0, 1)).float().cpu().numpy()
            op = g.opacities.flatten(0, 1).float().cpu().numpy().reshape(-1)
        q = q / np.maximum(np.linalg.norm(q, axis=1, keepdims=True), 1e-12)
        return pos, scl, q, col, op


def sharp_fpx_from_exif(img_pil, w: int, h: int) -> tuple[float, str]:
    """Same rule as ml-sharp io.load_rgb: 35mm-equivalent focal from EXIF, else FocalLength (x8.4 if < 10mm), else 30mm."""
    try:
        ex = img_pil.getexif()
        sub = ex.get_ifd(0x8769) if hasattr(ex, "get_ifd") else {}
        f35 = sub.get(0xA405) or ex.get(0xA405)
        src = "exif35"
        if not f35 or float(f35) < 1:
            f35 = sub.get(0x920A) or ex.get(0x920A)
            src = "exifFocal"
            if f35 is None:
                f35, src = 30.0, "default30mm"
            elif float(f35) < 10:
                f35 = float(f35) * 8.4
        f35 = float(f35)
    except Exception:  # noqa: BLE001
        f35, src = 30.0, "default30mm"
    return f35 * math.sqrt(w * w + h * h) / math.sqrt(36**2 + 24**2), src


class Manager:
    """Keeps at most one model resident. Loading a different model unloads the current one and frees MPS memory.
    The GPU lock is held from load until unload; an idle timer unloads after NEARFIELD_IDLE_S seconds."""

    def __init__(self):
        self.lock = threading.RLock()  # serialises inference AND load/unload
        self.gpu = GpuLock()
        self.key: str | None = None
        self.net = None
        self.last_used = 0.0
        self.dev = device_name()
        self.idle_s = float(os.environ.get("NEARFIELD_IDLE_S", "300"))
        self.gpu_wait_s = float(os.environ.get("NEARFIELD_GPU_WAIT_S", "900"))
        threading.Thread(target=self._idle_loop, daemon=True).start()

    def _idle_loop(self):
        while True:
            time.sleep(10)
            if self.key and time.time() - self.last_used > self.idle_s and self.lock.acquire(blocking=False):
                try:
                    if self.key and time.time() - self.last_used > self.idle_s:
                        print(f"[nearfield] idle unload {self.key}", file=sys.stderr, flush=True)
                        self.unload()
                finally:
                    self.lock.release()

    def unload(self):
        with self.lock:
            if self.net is not None:
                self.net = None
                self.key = None
                gc.collect()
                try:
                    import torch

                    if self.dev == "mps":
                        torch.mps.synchronize()
                        torch.mps.empty_cache()
                    elif self.dev == "cuda":
                        torch.cuda.empty_cache()
                except Exception:  # noqa: BLE001
                    pass
            self.gpu.release()

    def get(self, key: str):
        """Call with self.lock held."""
        if self.key == key and self.net is not None:
            self.last_used = time.time()
            return self.net
        self.unload()
        self.gpu.acquire(self.gpu_wait_s)
        t0 = time.time()
        try:
            if key in MOGE:
                net = MoGeNet(key, self.dev)
            elif key == "da3":
                net = DA3Net(self.dev)
            elif key == "sharp":
                ok, why = sharp_status()
                if not ok:
                    raise ServiceError(501, "sharp_unavailable", why)
                net = SharpNet(self.dev)
            else:
                raise ServiceError(400, "bad_model", f"unknown model {key!r}")
        except BaseException:
            self.gpu.release()
            raise
        print(f"[nearfield] loaded {key} on {self.dev} in {time.time() - t0:.1f}s", file=sys.stderr, flush=True)
        self.key, self.net, self.last_used = key, net, time.time()
        return net

    def sync(self):
        try:
            import torch

            if self.dev == "mps":
                torch.mps.synchronize()
        except Exception:  # noqa: BLE001
            pass
