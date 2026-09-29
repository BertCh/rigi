"""Path setup for X2: private pylib appended (venv packages take precedence); stub optional DA3 export deps."""
import sys, importlib.abc, importlib.machinery
from pathlib import Path
from unittest.mock import MagicMock
HERE = Path(__file__).resolve().parent
TM = HERE.parent
sys.path.append(str(TM / ".pylib_x2"))
sys.path.insert(0, str(TM))
WEIGHTS = TM / "weights" / "x2"
_STUB = ("moviepy", "trimesh", "plyfile", "open3d", "gsplat", "evo", "pycolmap", "imageio", "xformers")


class _Stub(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    def find_spec(self, name, path, target=None):
        if name.split(".")[0] in _STUB:
            for f in sys.meta_path:
                if f is self: continue
                try:
                    s = f.find_spec(name, path, target)
                except Exception:
                    s = None
                if s is not None:
                    return None  # real module available
            return importlib.machinery.ModuleSpec(name, self, is_package=True)
        return None

    def create_module(self, spec):
        m = MagicMock(); m.__path__ = []; m.__spec__ = spec; m.__name__ = spec.name
        return m

    def exec_module(self, module):
        pass


sys.meta_path.insert(0, _Stub())
