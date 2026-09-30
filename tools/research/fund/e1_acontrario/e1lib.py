"""E1 shared helpers (see PROTOCOL.txt). Imports the H1 production-path wrappers read-only."""
from __future__ import annotations

import json
import math
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
TM = ROOT / "tools/research/tm"
H1 = TM / "h1_mine"
SCR = Path(os.environ.get("E1_SCRATCH", "/private/tmp/claude-501/-Users-robertchristie-Documents-GitHub-mt-image/"
                                         "f5495a3b-2ed1-4bba-8c27-9bc20cbfbc05/scratchpad/e1"))
os.environ["H1_SCRATCH"] = str(SCR)
os.environ["STAGE1_PORT"] = os.environ.get("E1_PORT", "8796")
SCR.mkdir(parents=True, exist_ok=True)
sys.path.insert(0, str(TM))
sys.path.insert(0, str(H1))
sys.path.insert(0, str(ROOT / "tools/matcher/v2"))
sys.path.insert(0, str(ROOT / "tools/matcher/stage1"))
sys.path.insert(0, str(ROOT / "tools/matcher"))
import tm_common  # noqa: E402

GEN = HERE / "gen"
DEG = math.pi / 180
SEED = 20260929
P_LAB = ["wc_0001", "wc_0069", "wc_0070", "wc_0074", "wc_0086"]


def dang(a, b):
    return (a - b + 540.0) % 360.0 - 180.0


def enu_offset(lat0, lon0, lat, lon):
    R = 6371008.8
    return ((lon - lon0) * DEG * R * math.cos(lat0 * DEG), (lat - lat0) * DEG * R)


def eye_dist(a: dict, b: dict) -> float:
    e, n = enu_offset(a["lat"], a["lon"], b["lat"], b["lon"])
    return math.sqrt(e * e + n * n + (a["h"] - b["h"]) ** 2)


def rot_far(p, q, tol=3.0):
    """> tol deg in yaw OR pitch (H1 construction rule)."""
    return abs(dang(p["yaw"], q["yaw"])) > tol or abs(p["pitch"] - q["pitch"]) > tol


def same_pose(p, q, tol=0.5):
    return abs(dang(p["yaw"], q["yaw"])) <= tol and abs(p["pitch"] - q["pitch"]) <= tol


def jdump(obj, f: Path):
    f.parent.mkdir(parents=True, exist_ok=True)
    tmp = f.with_suffix(f.suffix + ".tmp")
    import numpy as np

    def d(o):
        if isinstance(o, (np.floating,)):
            return float(o)
        if isinstance(o, (np.integer,)):
            return int(o)
        if isinstance(o, np.ndarray):
            return o.tolist()
        if isinstance(o, (np.bool_,)):
            return bool(o)
        return str(o)
    with open(tmp, "w") as fh:
        json.dump(obj, fh, indent=1, default=d)
    os.replace(tmp, f)


def manifest():
    return {e["id"]: e for e in json.load(open(ROOT / "tools/bench/data/manifest.json"))}


def stated_z(pid):
    return float(json.load(open(tm_common.CACHE / pid / "meta.json"))["eye"][2])


def p_ref():
    import refs
    return [p for p in sorted(tm_common.dev_ids()) if refs.correct_refs(p)]


def analysed():
    return p_ref() + P_LAB
