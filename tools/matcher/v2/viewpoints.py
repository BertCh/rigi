"""Photo-independent viewpoint prior: where around a stated position would a photographer plausibly stand?
People photograph mountains from summits, crests, open slopes and viewpoints, not from inside a slope
facing a bank. Candidates = the stated eye + local maxima of 'openness' (share of azimuths whose horizon is
> 1 km away, at eye height) and of relative height, on a grid within `radius`, NMS-thinned.

    candidates(lat, lon, radius=400, k=5) -> [{"lat","lon","e","n","ground","open","rel","why"}]
"""
from __future__ import annotations
import math, sys
from pathlib import Path
import numpy as np
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import dem as DEM  # noqa: E402

EYE_AGL = 1.7


def openness(d: DEM.Dem, e, n, astep=5.0, far=1000.0):
    g = float(d.ground(e, n))
    hz = d.horizon((e, n, g + EYE_AGL), 0, 360 - astep, astep, dmax=15000.0)
    return float((hz["dist"] > far).mean()), g


def candidates(lat, lon, radius=400.0, step=25.0, k=4, nms=120.0, dem: DEM.Dem | None = None):
    d = dem or DEM.Dem(lat, lon, extent_m=radius + 100)
    r = np.arange(-radius, radius + 1e-6, step)
    E, N = np.meshgrid(r, r)
    ok = E ** 2 + N ** 2 <= radius ** 2
    pts = np.stack([E[ok], N[ok]], 1)
    G = d.ground(pts[:, 0], pts[:, 1])
    rows = []
    for (e, n), g in zip(pts, G):
        o, _ = openness(d, e, n)
        rows.append({"e": float(e), "n": float(n), "ground": float(g), "open": o})
    g0 = float(d.ground(0.0, 0.0))
    o0, _ = openness(d, 0.0, 0.0)
    gmax = max(r["ground"] for r in rows)
    for r in rows:
        r["rel"] = (r["ground"] - g0)
        dist = math.hypot(r["e"], r["n"])
        # prefer open spots near the stated position; summits/crests get a small height bonus
        r["prior"] = r["open"] - 0.25 * dist / radius + 0.1 * max(0.0, r["rel"]) / max(1.0, gmax - g0)
    rows.sort(key=lambda r: -r["prior"])
    out = [{"e": 0.0, "n": 0.0, "ground": g0, "open": o0, "rel": 0.0, "prior": None, "why": "stated"}]
    for r in rows:
        if len(out) >= k:
            break
        if all(math.hypot(r["e"] - q["e"], r["n"] - q["n"]) >= nms for q in out):
            out.append({**r, "why": "open"})
    # local high points (the crest / summit the pin was probably meant for), within 100 m and 250 m
    for rr, why in ((100.0, "high100"), (250.0, "high250"), (radius, "summit")):
        near = [r for r in rows if math.hypot(r["e"], r["n"]) <= rr + 1e-6]
        if not near:
            continue
        top = max(near, key=lambda r: r["ground"])
        if top["ground"] > g0 + 3 and all(math.hypot(top["e"] - q["e"], top["n"] - q["n"]) >= 10.0 for q in out):
            out.append({**top, "why": why})
    for c in out:
        c["lon"], c["lat"] = (float(x) for x in d.geo(c["e"], c["n"]))
    return out


if __name__ == "__main__":
    import json, time
    sys.path.insert(0, str(HERE.parent / "stage1"))
    import s1
    man = s1.manifest()
    for pid in sys.argv[1:]:
        t = time.time()
        e = man[pid]
        cs = candidates(e["lat"], e["lon"])
        print(pid, f"{time.time()-t:.1f}s", [(c["why"], round(c["e"]), round(c["n"]), round(c["ground"]), round(c["open"], 2)) for c in cs])
