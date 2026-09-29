"""Eye-position search (v2 stage 0): the stated camera position is often wrong by 10s–100s of metres
(hand-placed Commons pins, EXIF drift, eye inside a slope). Near terrain then hides the real skyline
and every render-based stage fails with ~0 inliers regardless of matcher.

For candidate eyes on a grid around the stated position (z = ground + EYE_AGL), compute the 360° DEM
horizon (dem.Dem.horizon, ~0.07 s) and score the photo's pose-free skyline evidence against it with the
app's own scorePose integrand over yaw × pitch × roll × FOV (skyglobal.SkyGlobal.grid). Returns the
top (eye, pose) hypotheses; they are PROPOSALS only — stage 2 (render + match + fuse) at that eye decides.
"""
from __future__ import annotations
import json, math, sys, time
from pathlib import Path
import numpy as np
HERE = Path(__file__).resolve().parent
for p in (str(HERE.parent), str(HERE.parent / "stage1")):
    if p not in sys.path:
        sys.path.insert(0, p)
import dem as DEM  # noqa: E402
import skyglobal as SG  # noqa: E402

EYE_AGL = 1.7


def load_edges(pid: str) -> tuple[dict, dict]:
    z = np.load(HERE / ".cache" / "edges" / f"{pid}.npz")
    m = json.loads(str(z["meta"]))
    ed = {"w": int(z["fine"].shape[1]), "h": int(z["fine"].shape[0]), "fine": z["fine"], "coarse": z["coarse"], "fg": z["fg"],
          "rgb": z["rgb"], "dirs": z["dirs"].astype(np.float64)}
    return ed, m


def grid_eyes(radius: float, step: float) -> np.ndarray:
    r = np.arange(-radius, radius + 1e-6, step)
    E, N = np.meshgrid(r, r)
    ok = E ** 2 + N ** 2 <= radius ** 2 + 1e-6
    return np.stack([E[ok], N[ok]], 1)


class EyeSearch:
    def __init__(self, ed: dict, meta: dict, radius: float = 600.0):
        self.m = meta
        self.sg = SG.SkyGlobal(ed, meta["aspect"])
        self.dem = DEM.Dem(meta["frame"]["lat"], meta["frame"]["lon"], extent_m=radius + 100)
        self.vfov0 = meta["vfov0"]
        self.fk = meta["focalKnown"]

    def fov_set(self):
        a = self.m["aspect"]
        if self.fk:
            return [self.vfov0]
        return [2 * math.degrees(math.atan(math.tan(math.radians(hf) / 2) / a)) for hf in (40, 55, 70)]

    def score_eye(self, en, pitches, rolls, astep=0.5):
        e, n = float(en[0]), float(en[1])
        g = float(self.dem.ground(e, n))
        eye = (e, n, g + EYE_AGL)
        hz = self.dem.horizon(eye, 0, 360 - astep, astep)
        self.sg.dirs = hz["dirs"]
        r = self.sg.grid(self.fov_set(), pitches, rolls, ystep=1.0, astep=astep)
        i = int(np.argmax(r["best"]))
        # second-best yaw basin (> 10° away) for a per-eye margin
        d = np.abs((r["yaw"] - r["yaw"][i] + 540) % 360 - 180)
        b2 = float(np.max(np.where(d > 10, r["best"], -np.inf)))
        vf, p, ro = (float(x) for x in r["arg"][i])
        # openness: fraction of azimuths whose horizon is > 1 km away
        bb = r["best"][np.isfinite(r["best"])]
        return {"en": [e, n], "eye": list(eye), "score": float(r["best"][i]), "second": b2,
                "med": float(np.median(bb)), "std": float(np.std(bb)), "p90": float(np.percentile(bb, 90)),
                "pose": {"yaw": float(r["yaw"][i]), "pitch": p, "roll": ro, "vfov": vf},
                "open": float((hz["dist"] > 1000).mean()), "hzElMean": float(np.mean(hz["el"])), "ms": r["ms"]}

    def search(self, radius=600.0, step=50.0, coarse_pitch=(-12, 12, 1.5), rolls=(-4.5, -1.5, 1.5, 4.5), top=8):
        t0 = time.time()
        P = np.arange(coarse_pitch[0], coarse_pitch[1] + 1e-9, coarse_pitch[2])
        R = np.array(rolls, float)
        rows = [self.score_eye(en, P, R) for en in grid_eyes(radius, step)]
        rows.sort(key=lambda r: -r["score"])
        at0 = next((r for r in rows if r["en"] == [0.0, 0.0]), None)
        return {"rows": rows, "top": rows[:top], "stated": at0, "ms": round((time.time() - t0) * 1000)}


if __name__ == "__main__":
    pid = sys.argv[1]
    rad = float(sys.argv[2]) if len(sys.argv) > 2 else 300
    step = float(sys.argv[3]) if len(sys.argv) > 3 else 50
    ed, m = load_edges(pid)
    es = EyeSearch(ed, m, rad)
    t = time.time()
    one = es.score_eye((0, 0), np.arange(-12, 12.1, 1.5), np.array([-4.5, -1.5, 1.5, 4.5]))
    print("one eye", round(time.time() - t, 2), "s", {k: one[k] for k in ("score", "second", "pose", "open")})
    res = es.search(rad, step)
    print("n eyes", len(res["rows"]), "total", res["ms"], "ms")
    print("stated", {k: res["stated"][k] for k in ("score", "pose")} if res["stated"] else None)
    for r in res["top"]:
        print(" ", [round(x) for x in r["en"]], round(r["eye"][2]), round(r["score"], 4), round(r["second"], 4), {k: round(v, 1) for k, v in r["pose"].items()}, round(r["open"], 2))
