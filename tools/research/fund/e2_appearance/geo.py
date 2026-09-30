"""ENU <-> lon/lat (same equirectangular mapping as tools/matcher/dem.py Dem.geo) and view loading at file resolution."""
from __future__ import annotations
import math, sys
import numpy as np
from common import C, TM, D
sys.path.insert(0, str(TM / "x3_modality"))
from modalities import _full_xyz  # noqa: E402  read-only reuse (upsample stride-2 xyz to file size + sky mask)

R_EARTH = 6371008.8


class Frame:
    def __init__(self, lat0, lon0):
        self.lat0, self.lon0 = lat0, lon0
        self.mlat = 1 / (R_EARTH * D)
        self.mlon = 1 / (R_EARTH * D * math.cos(lat0 * D))

    def geo(self, e, n):
        return self.lon0 + np.asarray(e) * self.mlon, self.lat0 + np.asarray(n) * self.mlat

    def enu(self, lon, lat):
        return (np.asarray(lon) - self.lon0) / self.mlon, (np.asarray(lat) - self.lat0) / self.mlat


def view_geom(view):
    """xyz (H,W,3) at rgb file resolution, sky mask, range (nan at sky)."""
    H, W = view["rgb"].shape[:2]
    xyz, sky = _full_xyz(view, W, H)
    d = np.linalg.norm(xyz.astype(np.float64) - np.asarray(view["eye"], float), axis=2)
    d[sky] = np.nan
    return xyz, sky, d


def scored_views(meta):
    """(group, tag, role) for the scored set: all correct refs, all wrong refs, perturb yaw+-4, yaw+-8."""
    out = [("refs", r["label"], "correct") for r in meta["correct_refs"]]
    out += [("refs", r["label"], "wrong") for r in meta["wrong_refs"]]
    tags = {v["tag"] for v in meta["views"]["perturb"]}
    out += [("perturb", t, "perturb") for t in ("yaw-8", "yaw-4", "yaw+4", "yaw+8") if t in tags]
    return out
