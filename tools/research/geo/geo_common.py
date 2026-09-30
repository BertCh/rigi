"""GEO research: shared helpers (see README.txt). Wraps tm_common (dev ids, locks); adds the GT split guard,
E1 hypothesis loading and the app pose conventions (tools/matcher/common.py, loaded by path)."""
from __future__ import annotations

import importlib.util
import json
import math
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
PYLIB = HERE / ".pylib"
if PYLIB.is_dir() and str(PYLIB) not in sys.path:
    sys.path.insert(0, str(PYLIB))
sys.path.insert(0, str(ROOT / "tools/research/tm"))
import tm_common  # noqa: E402

import numpy as np  # noqa: E402

OUT = ROOT / "out/geocam"
PYOUT = OUT / "python"
E1 = ROOT / "tools/research/fund/e1_acontrario"
E3 = ROOT / "tools/research/fund/e3_nearfield"
H1 = ROOT / "tools/research/tm/h1_mine"
D = math.pi / 180
R_EARTH = 6371008.8

GT_DEV = ["IMG_5495", "IMG_6971", "IMG_7018", "IMG_7033", "IMG_7053", "IMG_7059", "IMG_7063", "IMG_7068",
          "IMG_7131", "IMG_7155"]
GT_HOLDOUT = ["IMG_6019", "IMG_6958", "IMG_7086", "IMG_7130"]

render_lock = tm_common.render_lock
gpu_lock = tm_common.gpu_lock
dev_ids = tm_common.dev_ids


def _norm_gt(pid: str) -> str:
    s = str(pid)
    return s if s.startswith("IMG_") else f"IMG_{s}" if s.isdigit() else s


def assert_dev(pid: str) -> str:
    """Refuse anything that is not a wild dev id or a GT dev photo. Holdout GT is refused with no override."""
    g = _norm_gt(pid)
    if g in GT_HOLDOUT:
        raise AssertionError(f"{pid} is a GT HOLDOUT photo (tools/concord/pins/PROTOCOL.txt) - refused")
    if g in GT_DEV:
        return g
    tm_common.assert_dev(pid)
    return pid


def _load_matcher_common():
    spec = importlib.util.spec_from_file_location("matcher_common", ROOT / "tools/matcher/common.py")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


MC = _load_matcher_common()
pose_to_R = MC.pose_to_R  # world ENU -> OpenCV camera (x right, y down, z forward)
R_to_pose = MC.R_to_pose
focal_px = MC.focal_px
vfov_from_f = MC.vfov_from_f


def enu_offset(lat0, lon0, lat, lon):
    """Local equirectangular offset (m) of (lat, lon) from (lat0, lon0); same formula as e1lib/h1lib."""
    return ((lon - lon0) * D * R_EARTH * math.cos(lat0 * D), (lat - lat0) * D * R_EARTH)


def rot_angle_deg(Ra, Rb) -> float:
    c = (np.trace(Ra @ Rb.T) - 1) / 2
    return math.degrees(math.acos(max(-1.0, min(1.0, c))))


def dang(a, b):
    return (a - b + 540.0) % 360.0 - 180.0


def jdump(obj, f: Path):
    f = Path(f)
    f.parent.mkdir(parents=True, exist_ok=True)
    tmp = f.with_suffix(f.suffix + ".tmp")
    with open(tmp, "w") as fh:
        json.dump(obj, fh, indent=1, default=_default)
    os.replace(tmp, f)


def _default(o):
    if isinstance(o, np.floating):
        return float(o)
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, np.bool_):
        return bool(o)
    if isinstance(o, np.ndarray):
        return o.tolist()
    return str(o)


# ---------------------------------------------------------------- E1 hypotheses (read-only)

def e1_photos() -> dict:
    """pid -> hyps_pool.json photo record (stated eye, verified poses V, POOL hyps with H1 corr paths)."""
    return json.load(open(E1 / "hyps_pool.json"))["photos"]


def e1_state(pid: str) -> dict:
    assert_dev(pid)
    return json.load(open(E1 / "gen" / pid / "state.json"))


def e1_hyps(full_disp: bool = False) -> list[dict]:
    """E1 scored hypotheses (primary cut, or the pre-declared dispfull secondary), each with an absolute 'corrPath'.

    Every returned hid has pid in the dev set (asserted)."""
    hs = json.load(open(E1 / ("hyp_scores_dispfull.json" if full_disp else "hyp_scores.json")))
    paths: dict[str, str] = {}
    for pid, ph in e1_photos().items():
        assert_dev(pid)
        for h in ph.get("hyps", []):
            if h.get("corr"):
                paths[h["hid"]] = h["corr"]
        st = e1_state(pid)
        for key in ("ref", "ring", "yaw", "disp"):
            for h in st.get(key, []) or []:
                if h.get("corr") and h.get("hid"):
                    paths[h["hid"]] = str(E1 / h["corr"])
    out = []
    for h in hs:
        assert_dev(h["pid"])
        p = paths.get(h["hid"])
        if p and Path(p).exists():
            out.append({**h, "corrPath": p})
    return out


def load_corr(path: str) -> dict:
    """E1/H1 corr npz -> dict(x2d (N,2) px at W x H with 0 = image edge, X (N,3) ENU in a frame centred on the
    hypothesis eye's lat/lon, eye (3,), pose (4,), W, H)."""
    z = np.load(path, allow_pickle=True)
    return {"x2d": z["x2d"].astype(np.float64), "X": z["X"].astype(np.float64), "eye": z["eye"].astype(np.float64),
            "pose": z["pose"].astype(np.float64) if "pose" in z.files else None, "W": int(z["W"]), "H": int(z["H"])}
