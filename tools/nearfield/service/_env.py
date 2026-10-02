"""Path setup for the near-field service.

Import order: the matcher venv's own packages win; then tools/nearfield/.pylib (shared: timm, plyfile, ml-sharp src);
then the TM research pylib (moge, depth_anything_3, huggingface_hub, ...). Optional heavy deps that inference never
touches (gsplat, open3d, ...) are stubbed with MagicMock modules, exactly like tools/research/tm/x2_geom/_env.py.
"""
from __future__ import annotations

import importlib.abc
import importlib.machinery
import os
import sys
from pathlib import Path
from unittest.mock import MagicMock

HERE = Path(__file__).resolve().parent
NF = HERE.parent
ROOT = NF.parents[1]
TM = ROOT / "tools/research/tm"
PYLIB = NF / ".pylib"
SHARP_SRC = PYLIB / "ml-sharp" / "src"
X2_WEIGHTS = TM / "weights" / "x2"
# Bump when /depth, /gaussians, /multiview or /inpaint outputs change (code or model weights): it is part of every disk-cache key.
SERVICE_VERSION = "2026-10-02.1"
SHARP_CKPT = Path(os.environ.get("NEARFIELD_SHARP_CKPT", HERE / "weights" / "sharp_2572gikvuh.pt"))
CACHE_DIR = Path(os.environ.get("NEARFIELD_CACHE_DIR", NF / ".cache"))
GPU_LOCK_FILE = TM / ".gpu.lock"  # same file as tm_common.gpu_lock()

for p in (PYLIB, SHARP_SRC, TM / ".pylib_x2"):
    if str(p) not in sys.path:
        sys.path.append(str(p))

_STUB = ("moviepy", "trimesh", "open3d", "gsplat", "evo", "pycolmap", "xformers")


class _Stub(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    def find_spec(self, name, path, target=None):
        if name.split(".")[0] in _STUB:
            for f in sys.meta_path:
                if f is self:
                    continue
                try:
                    s = f.find_spec(name, path, target)
                except Exception:
                    s = None
                if s is not None:
                    return None  # real module available
            return importlib.machinery.ModuleSpec(name, self, is_package=True)
        return None

    def create_module(self, spec):
        m = MagicMock()
        m.__path__ = []
        m.__spec__ = spec
        m.__name__ = spec.name
        return m

    def exec_module(self, module):
        pass


def _install_evo_shim():
    """DA3's known-pose path (/multiview with `poses`) calls evo's PosePath3D.align (Umeyama Sim3). A MagicMock stub
    makes that return garbage (500 'not enough values to unpack'), so provide the one class it uses, with evo's
    semantics: align self onto ref, scale translations by s if correct_scale, left-multiply [r|t]; return (r, t, s)."""
    import importlib.util
    import types

    if "evo" in sys.modules or importlib.util.find_spec("evo") is not None:
        return
    import numpy as np

    class PosePath3D:
        def __init__(self, poses_se3=None, **_):
            self.poses_se3 = [np.asarray(p, np.float64) for p in poses_se3]

        @property
        def positions_xyz(self):
            return np.array([p[:3, 3] for p in self.poses_se3])

        def align(self, traj_ref, correct_scale=False, correct_only_scale=False, n=-1):
            x, y = self.positions_xyz.T, traj_ref.positions_xyz.T  # (3, N): est -> ref
            if n > 0:
                x, y = x[:, :n], y[:, :n]
            m = x.shape[1]
            mx, my = x.mean(1, keepdims=True), y.mean(1, keepdims=True)
            sx = ((x - mx) ** 2).sum() / m
            U, D, Vt = np.linalg.svd((y - my) @ (x - mx).T / m)
            S = np.eye(3)
            if np.linalg.det(U) * np.linalg.det(Vt) < 0:
                S[2, 2] = -1
            r = U @ S @ Vt
            s = float(np.trace(np.diag(D) @ S) / sx) if (correct_scale or correct_only_scale) and sx > 1e-12 else 1.0
            t = (my - s * r @ mx).ravel()
            if correct_only_scale:
                r, t = np.eye(3), np.zeros(3)
            out = []
            for p in self.poses_se3:
                q = p.copy()
                q[:3, 3] *= s
                T = np.eye(4)
                T[:3, :3], T[:3, 3] = r, t
                out.append(T @ q)
            self.poses_se3 = out
            return r, t, s

    evo = types.ModuleType("evo")
    core = types.ModuleType("evo.core")
    traj = types.ModuleType("evo.core.trajectory")
    traj.PosePath3D = PosePath3D
    evo.__path__, core.__path__ = [], []
    evo.core, core.trajectory = core, traj
    sys.modules.update({"evo": evo, "evo.core": core, "evo.core.trajectory": traj})


_install_evo_shim()

if not any(isinstance(f, _Stub) for f in sys.meta_path):
    sys.meta_path.insert(0, _Stub())

os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
