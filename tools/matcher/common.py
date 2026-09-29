"""Shared helpers: app pose conventions (src/lib/pose.ts), render I/O, scoring (scripts/eval-app.mjs)."""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
RENDERS = HERE / "out" / "renders"
D = math.pi / 180


# ---------- pose conventions (mirror of src/lib/pose.ts) ----------

def pose_basis(p: dict):
    y, pt, r = p["yaw"] * D, p["pitch"] * D, p["roll"] * D
    f = np.array([math.sin(y) * math.cos(pt), math.cos(y) * math.cos(pt), math.sin(pt)])
    r0 = np.array([math.cos(y), -math.sin(y), 0.0])
    u0 = np.cross(r0, f)
    right = r0 * math.cos(r) - u0 * math.sin(r)
    up = u0 * math.cos(r) + r0 * math.sin(r)
    return f, right, up


def pose_to_R(p: dict) -> np.ndarray:
    """World(ENU) → OpenCV camera (x right, y down, z forward)."""
    f, right, up = pose_basis(p)
    return np.stack([right, -up, f])


def R_to_pose(R: np.ndarray, vfov: float) -> dict:
    right, up, f = R[0], -R[1], R[2]
    yaw = math.atan2(f[0], f[1]) / D
    pitch = math.asin(max(-1.0, min(1.0, f[2]))) / D
    y = yaw * D
    r0 = np.array([math.cos(y), -math.sin(y), 0.0])
    u0 = np.cross(r0, f)
    roll = math.atan2(-float(right @ u0), float(right @ r0)) / D
    return {"yaw": yaw % 360, "pitch": pitch, "roll": roll, "vfov": vfov}


def focal_px(vfov: float, H: float) -> float:
    return (H / 2) / math.tan(vfov * D / 2)


def vfov_from_f(f: float, H: float) -> float:
    return 2 * math.atan((H / 2) / f) / D


def project_point(p: dict, aspect: float, eye, pt):
    """Mirror of projectPoint(): normalised (u, v) with v down, or None if behind."""
    f, right, up = pose_basis(p)
    v = np.asarray(pt, float) - np.asarray(eye, float)
    z = v @ f
    if z <= 0:
        return None
    t = math.tan(p["vfov"] * D / 2)
    x = (v @ right) / z / (t * aspect)
    y = (v @ up) / z / t
    return 0.5 + x / 2, 0.5 - y / 2


def pin_error(p: dict, meta: dict) -> float | None:
    """Mean pin reprojection error in px on a basis-wide image (engine.pinError)."""
    gt = meta.get("gt")
    if not gt:
        return None
    aspect, basis, eye = meta["aspect"], gt["basis"], meta["eye"]
    errs = []
    for pin in gt["pins"]:
        pr = project_point(p, aspect, eye, pin["world"])
        if pr is None:
            errs.append(math.inf)
            continue
        errs.append(math.hypot((pr[0] - pin["u"]) * basis, (pr[1] - pin["v"]) * basis / aspect))
    return sum(errs) / max(len(errs), 1)


def dang(a: float, b: float) -> float:
    return ((a - b) % 360 + 540) % 360 - 180


def score(p: dict | None, meta: dict) -> dict:
    gt = meta.get("gt")
    if p is None or not gt:
        return {}
    g = gt["pose"]
    return {
        "dYaw": dang(p["yaw"], g["yaw"]),
        "dPitch": p["pitch"] - g["pitch"],
        "dRoll": p["roll"] - g["roll"],
        "pinPx": pin_error(p, meta),
    }


# ---------- render I/O ----------

def load_meta(pid: str) -> dict:
    return json.loads((RENDERS / pid / "meta.json").read_text())


def list_tags(pid: str, prefix: str | None = None) -> list[str]:
    tags = sorted(p.stem for p in (RENDERS / pid).glob("*.json") if p.stem not in ("meta",) and not p.stem.startswith("timing"))
    return [t for t in tags if prefix is None or t.startswith(prefix)]


def load_render(pid: str, tag: str):
    d = RENDERS / pid
    info = json.loads((d / f"{tag}.json").read_text())
    W, H = info["W"], info["H"]
    xyz = np.fromfile(d / f"{tag}_xyz.f32", np.float32).reshape(H, W, 3)
    return info, xyz


def render_path(pid: str, tag: str, style: str) -> Path:
    jpg = RENDERS / pid / f"{tag}_{style}.jpg"
    return jpg if jpg.exists() else RENDERS / pid / f"{tag}_{style}.png"
