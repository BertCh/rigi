"""LaMa (big-lama) hole filling for Step Inside P3 (DEM-conditioned generation; research flag only).

Weights: tools/nearfield/service/weights/big-lama.pt, the TorchScript trace of big-lama that IOPaint (Sanster/lama-cleaner,
Apache-2.0) distributes at https://github.com/Sanster/models/releases/download/add_big_lama/big-lama.pt
(205,669,692 bytes, md5 e3aa4aaa15225a33ec84f9f4bc47e500 = IOPaint's LAMA_MODEL_MD5; verified 2026-09-28).
Licence: LaMa code AND the big-lama weights are Apache-2.0 (github.com/advimman/lama LICENSE, GitHub API spdx Apache-2.0;
the upstream README's official download huggingface.co/smartywu/big-lama is tagged apache-2.0). The Sanster/models repo that
hosts the traced file has no LICENSE of its own; it redistributes the Apache-2.0 weights unmodified (traced), which Apache-2.0
permits. Commercial use OK. Trained on Places2 (the dataset's own terms apply to the training data, not to the weights).

Model contract (TorchScript): forward(image [1,3,H,W] float 0..1 RGB, mask [1,1,H,W] float {0,1}, 1 = hole) ->
[1,3,H,W] float 0..1. H and W must be multiples of 8 (we reflect-pad). Measured 2026-09-28 on this Mac (512x768):
CPU ~2.1 s, MPS ~0.27 s warm (1.2 s first call).

It is small (~200 MB resident), so it does NOT take the machine-wide GPU lock (that rule is for > 4 GB MPS models) and it is
kept outside models.Manager, so an /inpaint never evicts the resident depth model. BUT every MPS call in this process must be
serialised with the depth models: concurrent MPS use from two server threads aborts the process (observed 2026-09-28:
"failed assertion _status < MTLCommandBufferStatusCommitted" when an /inpaint overlapped a /depth). app.py therefore sets
MPS_LOCK = MGR.lock (the Manager's inference RLock) and every LaMa load / run / unload holds it.
Env: NEARFIELD_LAMA_DEVICE (mps|cpu; default mps when available), NEARFIELD_LAMA_CKPT (path override).
"""
from __future__ import annotations

import os
import threading
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
LAMA_CKPT = Path(os.environ.get("NEARFIELD_LAMA_CKPT", HERE / "weights" / "big-lama.pt"))
LAMA_MD5 = "e3aa4aaa15225a33ec84f9f4bc47e500"
LICENCE = ("LaMa big-lama: Apache-2.0 (code + weights, github.com/advimman/lama; HF smartywu/big-lama apache-2.0). "
           "TorchScript trace redistributed by IOPaint (Sanster/models release add_big_lama). Commercial use OK. "
           "Output is GENERATED content: provenance 'generated', never measurable.")
NAME = "big-lama"
MPS_LOCK = None  # set by app.py to models.Manager.lock


def _mps_lock():
    import contextlib

    return MPS_LOCK if MPS_LOCK is not None else contextlib.nullcontext()


def status() -> tuple[bool, str]:
    if not LAMA_CKPT.exists():
        return False, f"LaMa checkpoint not found at {LAMA_CKPT} (download https://github.com/Sanster/models/releases/download/add_big_lama/big-lama.pt)"
    return True, "ok"


class Lama:
    def __init__(self):
        # app.main() replaces this with models.Manager.lock (an RLock): all MPS work is serialised through one lock
        self.lock: threading.Lock | threading.RLock = threading.RLock()
        self.m = None
        self.dev = None
        self.last_used = 0.0
        self.idle_s = float(os.environ.get("NEARFIELD_IDLE_S", "300"))
        threading.Thread(target=self._idle_loop, daemon=True).start()

    def _idle_loop(self):
        while True:
            time.sleep(10)
            if self.m is not None and time.time() - self.last_used > self.idle_s and self.lock.acquire(blocking=False):
                try:
                    if self.m is not None and time.time() - self.last_used > self.idle_s:
                        print(f"[nearfield] idle unload {NAME}", flush=True)
                        with _mps_lock():
                            self.m = None
                            try:
                                import torch

                                if self.dev == "mps":
                                    torch.mps.synchronize()
                                    torch.mps.empty_cache()
                            except Exception:  # noqa: BLE001
                                pass
                finally:
                    self.lock.release()

    def device(self) -> str:
        forced = os.environ.get("NEARFIELD_LAMA_DEVICE")
        if forced:
            return forced
        import torch

        return "mps" if torch.backends.mps.is_available() else "cpu"

    def _load(self):
        if self.m is not None:
            return
        import torch

        ok, why = status()
        if not ok:
            from models import ServiceError

            raise ServiceError(501, "inpaint_unavailable", why)
        dev = self.device()
        t0 = time.time()
        m = torch.jit.load(str(LAMA_CKPT), map_location="cpu").eval()
        self.m = m.to(dev)
        self.dev = dev
        print(f"[nearfield] loaded {NAME} on {dev} in {time.time() - t0:.1f}s", flush=True)

    def unload(self):
        with self.lock:
            self.m = None

    def inpaint(self, rgb: np.ndarray, hole: np.ndarray, max_side: int = 1024) -> tuple[np.ndarray, dict]:
        """rgb HxWx3 uint8, hole HxW bool (True = fill). Returns (HxWx3 uint8 raw LaMa output at the input size, info).
        Processing size: long side <= max_side, then reflect-padded to multiples of 8."""
        import cv2
        import torch

        H, W = hole.shape
        s = min(1.0, max_side / max(H, W))
        w, h = max(8, round(W * s)), max(8, round(H * s))
        img = cv2.resize(rgb, (w, h), interpolation=cv2.INTER_AREA) if (w, h) != (W, H) else rgb
        # nearest + any-coverage: a hole pixel must stay a hole at the processing size
        msk = (cv2.resize(hole.astype(np.uint8) * 255, (w, h), interpolation=cv2.INTER_AREA) > 0) if (w, h) != (W, H) else hole
        ph, pw = (-h) % 8, (-w) % 8
        img_p = np.pad(img, ((0, ph), (0, pw), (0, 0)), mode="reflect") if ph or pw else img
        msk_p = np.pad(msk, ((0, ph), (0, pw)), mode="reflect") if ph or pw else msk
        with self.lock, _mps_lock():
            self._load()
            t0 = time.time()
            with torch.no_grad():
                x = torch.from_numpy(np.ascontiguousarray(img_p)).float().div(255).permute(2, 0, 1)[None].to(self.dev)
                m = torch.from_numpy(msk_p.astype(np.float32))[None, None].to(self.dev)
                y = self.m(x, m)
                if self.dev == "mps":
                    torch.mps.synchronize()
                out = (y[0].permute(1, 2, 0).clamp(0, 1).mul(255).round().byte().cpu().numpy())
            sec = time.time() - t0
            self.last_used = time.time()
        out = out[:h, :w]
        if (w, h) != (W, H):
            out = cv2.resize(out, (W, H), interpolation=cv2.INTER_CUBIC)
        return out, {"procWidth": w, "procHeight": h, "inferSeconds": round(sec, 3), "device": self.dev}


LAMA = Lama()


def fill(rgb: np.ndarray, hole: np.ndarray, max_side: int = 1024, dilate: int = 0, composite: bool = True) -> tuple[np.ndarray, dict]:
    """Fill `hole` (dilated by `dilate` px first). composite=True keeps every non-hole pixel of `rgb` bit-exact."""
    import cv2

    hole = hole.astype(bool)
    if dilate > 0:
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * dilate + 1, 2 * dilate + 1))
        hole = cv2.dilate(hole.astype(np.uint8), k) > 0
    frac = float(hole.mean())
    if frac == 0:
        return rgb.copy(), {"holeFrac": 0.0, "procWidth": rgb.shape[1], "procHeight": rgb.shape[0], "inferSeconds": 0.0,
                            "device": None, "skipped": True}
    out, info = LAMA.inpaint(rgb, hole, max_side)
    if composite:
        out = np.where(hole[..., None], out, rgb)
    info["holeFrac"] = round(frac, 5)
    return out.astype(np.uint8), info
