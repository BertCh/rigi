"""H1 generation: S2 (X1 seeds -> T6+LoMa stage 2), S5 (masked-basin full T6+LoMa), S3 (LoMa eye probe + full T6
at top eyes), S4 (displaced-eye pilot). Resumable: runs/<S>/<pid>.json. Holds render_lock + gpu_lock throughout.

    python gen.py S2|S5|S3a|S3b|S4 [ids...] [--deadline-utc HH:MM]
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import sys
import time
import traceback
import urllib.parse
import urllib.request

import numpy as np

import h1lib as H
from h1lib import log, jdump, pose4, dang

X1 = json.load(open(H.TM / "x1_yawcorr/results/final_v2Breg.json"))
LOMA_RAW = H.ROOT / "tools/matcher/v2/out/dev_loma/raw"


def stated_loma(pid):
    return json.load(open(LOMA_RAW / f"{pid}.json"))["stated"]


def correct_at_stated(pid):
    import refs
    z = float(json.load(open(H.tm_common.CACHE / pid / "meta.json"))["eye"][2])
    return [r for r in refs.correct_refs(pid) if r["eyeH"] is not None and abs(r["eyeH"] - z) <= 2.0], z


class Ctx:
    def __init__(self):
        self.m = H.mods()
        self.w = self.m["s1"].Worker(port=H.PORT)

    def reset(self):
        self.w.close()
        self.w = self.m["s1"].Worker(port=H.PORT)


def fused_rec(res, eye2):
    return {"pose": res.get("pose"), "level": res.get("confidenceLevel"), "method": res.get("method"),
            "checks": res.get("confidenceChecks"), "fusionScore": res.get("fusionScore"), "inliers": res.get("inliers"),
            "inlierFrac": res.get("inlierFrac"), "nLifted": res.get("nLifted"), "fusedFrom": res.get("fusedFrom"),
            "eye": eye2}


def stage2_list(ctx, pid, ph, seeds, tag):
    """Stage 2 (T6+LoMa) at each seed; returns candidate dicts (T6-like) with fused + saved corr."""
    s1, PL = ctx.m["s1"], ctx.m["PL"]
    se = s1.Session(ctx.w, ph)
    out = []
    try:
        for i, sd in enumerate(seeds):
            c = {"source": sd.get("source", tag), "pose": pose4(sd), **{k: v for k, v in sd.items() if k not in ("yaw", "pitch", "roll", "vfov")}}
            t1 = time.time()
            H.CAP["sink"] = []
            try:
                res, sk, corr, eye2 = PL.stage2(se, ph, c["pose"])
                c["fused"] = fused_rec(res, eye2)
                if H.CAP["sink"]:
                    c["corrFused"] = H.save_fused(pid, f"{tag}_c{i}", H.CAP["sink"][-1])
            except Exception as e:  # noqa: BLE001
                c["error"] = f"{type(e).__name__}: {e}"
            finally:
                H.CAP["sink"] = None
            c["ms"] = round((time.time() - t1) * 1000)
            out.append(c)
    finally:
        se.close()
    return out


# ------------------------------------------------------------------ S2
def run_S1(ctx, pid):
    """Re-run of T6+LoMa at the stated eye, only for photos whose dev_loma record failed (wc_0023)."""
    H.CAP["sink"] = []
    try:
        rec = ctx.m["V2"].run_t6(ctx.w, pid, ctx.m["s1"].manifest()[pid])
        H.attach_caps(pid, "S1", rec.get("candidates") or [], H.CAP["sink"])
    finally:
        H.CAP["sink"] = None
    return rec


def run_S2(ctx, pid):
    s1 = ctx.m["s1"]
    x = X1.get(pid)
    if not x or "cfg" not in x:
        return {"id": pid, "error": "no X1 record"}
    hy = x["cfg"]["main"].get("rawFine") or []
    ph = s1.Photo(pid)
    try:
        seeds = []
        for r, h in enumerate(hy[:2]):
            p = pose4(h)
            if ph.focal_known:
                p["vfov"] = ph.p0["vfov"]
            seeds.append({**p, "source": "x1feat", "rank": r, "x1score": h.get("score")})
        cands = stage2_list(ctx, pid, ph, seeds, "S2")
        return {"id": pid, "focalKnown": ph.focal_known, "lat": ph.e["lat"], "lon": ph.e["lon"], "candidates": cands}
    finally:
        ph.cleanup()


# ------------------------------------------------------------------ S5
def run_S5(ctx, pid):
    PL = ctx.m["PL"]
    refs_c, z = correct_at_stated(pid)
    if not refs_c:
        return {"id": pid, "skip": "no correct ref at the stated eye"}
    yaws = [r["pose"]["yaw"] for r in refs_c]
    PL._H1_KEEP = lambda c: all(abs(dang(c["pose"]["yaw"], y)) > 10.0 for y in yaws)
    H.CAP["sink"] = []
    try:
        rec = PL.run_photo_h1(ctx.w, pid)
        H.attach_caps(pid, "S5", rec.get("candidates") or [], H.CAP["sink"])
    finally:
        H.CAP["sink"] = None
        PL._H1_KEEP = lambda c: True
    rec["h1MaskYaws"] = yaws
    rec["matcher"] = "loma"
    return rec


# ------------------------------------------------------------------ S3
def s3_ids():
    R, V2 = H.mods()["R"], H.mods()["V2"]
    out = []
    for pid in sorted(H.tm_common.dev_ids()):
        if V2.summarize(stated_loma(pid))["level"] != "HIGH":
            out.append(pid)
    return out


def run_S3a(ctx, pid):
    """Probe all viewpoint candidates (LoMa fine sweep), full T6+LoMa at the top-1 eye with best >= 100."""
    s1, V2 = ctx.m["s1"], ctx.m["V2"]
    import viewpoints as VP
    e = s1.manifest()[pid]
    t0 = time.time()
    vps = VP.candidates(e["lat"], e["lon"])[1:]
    probes = V2.probe_eyes(ctx.w, pid, e, vps)
    tp = time.time() - t0
    good = sorted([p for p in probes if p["best"] >= 100], key=lambda p: -p["best"])
    rec = {"id": pid, "probes": probes, "probeMs": round(tp * 1000), "eyeRecs": {}}
    for p in good[:1]:
        rec["eyeRecs"][eye_key(p)] = run_eye_t6(ctx, pid, e, p, "S3a")
    rec["good"] = [eye_key(p) for p in good]
    return rec


def eye_key(p):
    return f"{p['why']}:{round(p['e'])},{round(p['n'])}"


def run_eye_t6(ctx, pid, e, p, tag):
    V2 = ctx.m["V2"]
    ent = {**e, "lat": p["lat"], "lon": p["lon"], "altitudeM": None, "positionSource": "moved"}
    H.CAP["sink"] = []
    try:
        rk = V2.run_t6(ctx.w, pid, ent)
        H.attach_caps(pid, f"{tag}_{p['why']}", rk.get("candidates") or [], H.CAP["sink"])
    finally:
        H.CAP["sink"] = None
    rk["h1Eye"] = {k: p[k] for k in ("why", "e", "n", "lat", "lon", "best")}
    return rk


def run_S3b(ctx, pid):
    f = H.RUNS / "S3a" / f"{pid}.json"
    if not f.exists():
        return {"id": pid, "skip": "no S3a"}
    a = json.load(open(f))
    e = ctx.m["s1"].manifest()[pid]
    good = sorted([p for p in a.get("probes", []) if p["best"] >= 100], key=lambda p: -p["best"])
    rec = {"id": pid, "eyeRecs": {}}
    for p in good[1:2]:
        rec["eyeRecs"][eye_key(p)] = run_eye_t6(ctx, pid, e, p, "S3b")
    return rec


# ------------------------------------------------------------------ S4
def s4_ids():
    s1 = H.mods()["s1"]
    man = s1.manifest()
    ok = [p for p in sorted(H.tm_common.dev_ids()) if correct_at_stated(p)[0]]
    ex = [p for p in ok if man[p].get("positionSource") == "exif-gps"]
    mn = [p for p in ok if p not in ex]
    return (ex + mn)[:20]


def overpass_nearest(lat, lon, radius=3000):
    q = (f"[out:json][timeout:25];(node(around:{radius},{lat},{lon})[natural=peak][name];"
         f"node(around:{radius},{lat},{lon})[tourism=viewpoint][name];);out body;")
    url = "https://overpass-api.de/api/interpreter?data=" + urllib.parse.quote(q)
    req = urllib.request.Request(url, headers={"User-Agent": "rigi-research/0.1 (+https://github.com/BertCh/rigi)"})
    js = json.load(urllib.request.urlopen(req, timeout=40))
    best = None
    for el in js.get("elements", []):
        e, n = H.enu_offset(lat, lon, el["lat"], el["lon"])
        d = math.hypot(e, n)
        if d < 150:  # the stated eye itself (not a displacement)
            continue
        if best is None or d < best[0]:
            best = (d, el)
    return best


def s4_eyes(pid):
    import dem as DEM
    s1 = H.mods()["s1"]
    e0 = s1.manifest()[pid]
    rng = np.random.default_rng(H.SEED + int(pid.split("_")[1]))
    th = float(rng.uniform(0, 360))
    d = DEM.Dem(e0["lat"], e0["lon"], extent_m=3200)
    eyes = []
    for dist in (300, 800, 2000):
        for b in (th, th + 180):
            ee, nn = dist * math.sin(b * H.DEG), dist * math.cos(b * H.DEG)
            g = float(d.ground(ee, nn))
            if not np.isfinite(g):
                eyes.append({"why": f"d{dist}b{round(b % 360)}", "rejected": "no DEM"})
                continue
            lon, lat = (float(x) for x in d.geo(ee, nn))
            eyes.append({"why": f"d{dist}b{round(b % 360)}", "e": ee, "n": nn, "lat": lat, "lon": lon, "ground": g, "h": g + 2.0, "dist": dist})
    try:
        nb = overpass_nearest(e0["lat"], e0["lon"])
        if nb:
            dd, el = nb
            ee, nn = H.enu_offset(e0["lat"], e0["lon"], el["lat"], el["lon"])
            g = float(d.ground(ee, nn))
            tg = el.get("tags", {})
            eyes.append({"why": "osm", "e": ee, "n": nn, "lat": el["lat"], "lon": el["lon"], "ground": g, "h": g + 2.0,
                         "dist": dd, "osm": {"id": el["id"], "name": tg.get("name"), "kind": tg.get("natural") or tg.get("tourism")}})
        else:
            eyes.append({"why": "osm", "rejected": "none within 3 km"})
    except Exception as ex:  # noqa: BLE001
        eyes.append({"why": "osm", "rejected": f"overpass failed: {type(ex).__name__}: {ex}"})
    return eyes


def run_S4(ctx, pid):
    s1, PL = ctx.m["s1"], ctx.m["PL"]
    e0 = s1.manifest()[pid]
    eyes = s4_eyes(pid)
    rec = {"id": pid, "eyes": []}
    for ey in eyes:
        if ey.get("rejected"):
            rec["eyes"].append(ey)
            continue
        t0 = time.time()
        ent = {**e0, "lat": ey["lat"], "lon": ey["lon"], "altitudeM": round(ey["h"], 2), "positionSource": "displaced"}
        ph = s1.Photo(pid, ent)
        r = dict(ey)
        try:
            se = s1.Session(ctx.w, ph)
            try:
                eye = se.render(poses=[{"yaw": 0, "pitch": 0, "roll": 0, "vfov": ph.vfov0}])[2]["eye"]
                r["eyeAchieved"] = eye
                hy, _, info = PL.fine_sweep(se, ph, eye)
                r["sweep"] = {"hyps": hy, "info": info}
            finally:
                se.close()
            seeds = []
            for h in hy[:2]:
                p = pose4(h["pose"])
                if ph.focal_known:
                    p["vfov"] = ph.p0["vfov"]
                seeds.append({**p, "source": "sweepfine", "inliers": h["inliers"]})
            r["candidates"] = stage2_list(ctx, pid, ph, seeds, f"S4_{ey['why']}")
        except Exception as ex:  # noqa: BLE001
            r["error"] = f"{type(ex).__name__}: {ex}"
            r["trace"] = traceback.format_exc()[-1500:]
        finally:
            ph.cleanup()
        r["ms"] = round((time.time() - t0) * 1000)
        rec["eyes"].append(r)
        log(pid, "S4", ey["why"], r.get("eyeAchieved"), [c.get("fused", {}).get("inliers") for c in r.get("candidates", [])], r.get("error", ""))
    return rec


STAGES = {"S1": run_S1, "S2": run_S2, "S5": run_S5, "S3a": run_S3a, "S3b": run_S3b, "S4": run_S4}


def default_ids(stage):
    if stage in ("S2",):
        return sorted(H.tm_common.dev_ids())
    if stage == "S5":
        return [p for p in sorted(H.tm_common.dev_ids()) if correct_at_stated(p)[0]]
    if stage in ("S3a", "S3b"):
        return s3_ids()
    if stage == "S4":
        return s4_ids()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("stage", choices=list(STAGES))
    ap.add_argument("ids", nargs="*")
    ap.add_argument("--deadline-utc", default=None, help="stop starting new photos after this UTC time (YYYY-MM-DDTHH:MM)")
    a = ap.parse_args()
    dl = dt.datetime.fromisoformat(a.deadline_utc).replace(tzinfo=dt.timezone.utc) if a.deadline_utc else None
    with H.tm_common.render_lock(), H.tm_common.gpu_lock():
        ctx = Ctx()
        ids = a.ids or default_ids(a.stage)
        for pid in ids:
            H.tm_common.assert_dev(pid)
        log(a.stage, len(ids), "photos", ids)
        od = H.RUNS / a.stage
        od.mkdir(parents=True, exist_ok=True)
        tst = time.time()
        try:
            for pid in ids:
                f = od / f"{pid}.json"
                if f.exists():
                    continue
                if dl and dt.datetime.now(dt.timezone.utc) > dl:
                    log("deadline reached; stopping before", pid)
                    break
                ctx.m["s1"].disk_guard(3.0)
                t0 = time.time()
                rec = None
                for att in range(2):
                    try:
                        rec = STAGES[a.stage](ctx, pid)
                        err = str(rec.get("error", ""))
                        if "worker" in err or "timed out" in err:
                            raise RuntimeError(err)
                        break
                    except Exception as ex:  # noqa: BLE001
                        rec = {"id": pid, "error": f"{type(ex).__name__}: {ex}", "trace": traceback.format_exc()[-2000:]}
                        log(pid, "attempt", att + 1, "failed:", rec["error"][:200])
                        ctx.reset()
                rec["h1Stage"] = a.stage
                rec["h1WallS"] = round(time.time() - t0, 1)
                jdump(rec, f)
                log(a.stage, pid, f"{rec['h1WallS']}s", rec.get("error", rec.get("skip", "")))
        finally:
            ctx.w.close()
        log(a.stage, "done in", round(time.time() - tst), "s")


if __name__ == "__main__":
    main()
