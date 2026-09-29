"""H1 hard-negative mining: shared helpers (see PROTOCOL.txt). Thin wrappers only; no edits to tools/matcher/**."""
from __future__ import annotations

import inspect
import json
import math
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
TM = HERE.parent
SCRATCH = Path(os.environ.get("H1_SCRATCH", "/private/tmp/claude-501/-Users-robertchristie-Documents-GitHub-mt-image/"
                                            "7c1a30aa-cc2d-419d-8481-cfc760239e03/scratchpad/h1"))
os.environ["STAGE1_TMP"] = str(SCRATCH / "tmp")
os.environ.setdefault("STAGE1_PORT", "8793")
(SCRATCH / "tmp").mkdir(parents=True, exist_ok=True)
sys.path.insert(0, str(TM))
import tm_common  # noqa: E402

import numpy as np  # noqa: E402

ROOT = tm_common.ROOT
RUNS = HERE / "runs"
CORR = HERE / "corr"
LOGS = HERE / "logs"
PORT = int(os.environ["STAGE1_PORT"])
SEED = 20260928
DEG = math.pi / 180


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def jdump(obj, f: Path):
    f.parent.mkdir(parents=True, exist_ok=True)
    tmp = f.with_suffix(f.suffix + ".tmp")
    with open(tmp, "w") as fh:
        json.dump(obj, fh, indent=1, default=_default)
    os.replace(tmp, f)


def _default(o):
    if isinstance(o, (np.floating,)):
        return float(o)
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, np.ndarray):
        return o.tolist()
    return str(o)


def dang(a, b):
    return (a - b + 540.0) % 360.0 - 180.0


def enu_offset(lat0, lon0, lat, lon):
    """Local equirectangular offset (m) of (lat, lon) from (lat0, lon0) — fine at <= 3 km."""
    R = 6371008.8
    return ((lon - lon0) * DEG * R * math.cos(lat0 * DEG), (lat - lat0) * DEG * R)


def eye_dist(a: dict, b: dict) -> float:
    e, n = enu_offset(a["lat"], a["lon"], b["lat"], b["lon"])
    return math.sqrt(e * e + n * n + (a["h"] - b["h"]) ** 2)


# ---------------------------------------------------------------- production modules (lazy)
_M = {}


def mods():
    """Import s1 / pipeline / rule / run_v2 and route s1.correspond through LoMa (run_v2.use_loma)."""
    if _M:
        return _M
    import s1
    import pipeline as PL
    import rule as R
    import run_v2 as V2
    global ALIKED_CORR
    ALIKED_CORR = s1.correspond  # the T6 ALIKED path (for replaying ALIKED records only)
    V2.use_loma()
    import matcher as LM  # tools/matcher/v2/loma/matcher.py (on sys.path after use_loma)
    import fusion as F
    import match as MM
    _M.update(s1=s1, PL=PL, R=R, V2=V2, LM=LM, F=F, MM=MM)
    _install_stage2_capture(PL)
    _install_masked_run_photo(PL)
    return _M


CAP: dict = {"sink": None}
ALIKED_CORR = None


def _install_stage2_capture(PL):
    if getattr(PL, "_h1_cap", False):
        return
    orig = PL.stage2

    def stage2_cap(se, ph, prior2):
        res, sk, corr, eye = orig(se, ph, prior2)
        if CAP["sink"] is not None:
            CAP["sink"].append({"prior": dict(prior2), "x2d": np.asarray(corr["x2d"], np.float32),
                                "X": np.asarray(corr["X"], np.float32), "W": corr["W"], "H": corr["H"],
                                "perView": corr.get("perView"), "eye": list(map(float, eye)),
                                "pose": res.get("pose"), "inliers": res.get("inliers")})
        return res, sk, corr, eye
    PL.stage2 = stage2_cap
    PL._h1_cap = True


def _install_masked_run_photo(PL):
    """PL.run_photo_h1 = PL.run_photo's own source + one inserted line (seed filter before dedupe)."""
    if hasattr(PL, "run_photo_h1"):
        return
    src = inspect.getsource(PL._orig_run_photo if hasattr(PL, "_orig_run_photo") else PL.run_photo)
    anchor = "        uniq = []\n"
    assert src.count(anchor) == 1, "run_photo source changed: anchor not unique"
    src = src.replace("def run_photo(", "def run_photo_h1(", 1)
    src = src.replace(anchor, "        rec['h1Masked'] = [c for c in cands if not _H1_KEEP(c)]\n"
                              "        cands = [c for c in cands if _H1_KEEP(c)]\n" + anchor, 1)
    exec(compile(src, "<pipeline.run_photo_h1>", "exec"), PL.__dict__)
    PL._H1_KEEP = lambda c: True


def manifest():
    return mods()["s1"].manifest()


def save_fused(pid: str, cid: str, cap: dict, extra: dict | None = None) -> str:
    d = CORR / pid
    d.mkdir(parents=True, exist_ok=True)
    f = d / f"{cid}__fused.npz"
    pv = cap.get("perView") or []
    np.savez_compressed(f, x2d=cap["x2d"], X=cap["X"], W=np.int32(cap["W"]), H=np.int32(cap["H"]),
                        eye=np.asarray(cap["eye"], np.float64),
                        prior=np.asarray([cap["prior"][k] for k in ("yaw", "pitch", "roll", "vfov")], np.float64),
                        perViewLifted=np.asarray([p.get("lifted", 0) for p in pv], np.int32),
                        meta=json.dumps({"perView": pv, "pose": cap.get("pose"), "inliers": cap.get("inliers"), **(extra or {})},
                                        default=_default))
    return str(f.relative_to(HERE))


def attach_caps(pid: str, tag: str, cands: list, caps: list) -> None:
    """Match captured stage-2 calls to verified candidates by their prior; save the fused corr npz."""
    used = set()
    for i, c in enumerate(cands):
        if not c.get("fused"):
            continue
        for j, cp in enumerate(caps):
            if j in used:
                continue
            if all(abs(float(cp["prior"][k]) - float(c["pose"][k])) < 1e-9 for k in ("yaw", "pitch", "roll", "vfov")):
                used.add(j)
                c["corrFused"] = save_fused(pid, f"{tag}_c{i}", cp)
                break


def pose4(p):
    return {k: float(p[k]) for k in ("yaw", "pitch", "roll", "vfov")}
