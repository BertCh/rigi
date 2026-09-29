"""H1 scoring: merge candidates (0.5 deg yaw/pitch, 2 m eye), pre-screen, COMMON support (LoMa-B single view at the
candidate's own render, residual < 6 px under the candidate pose), then fused-corr replay for kept clusters that have no
captured stage-2 correspondences. Resumable: runs/common/<pid>.json keyed by a content key.

    python score.py merge          -> runs/clusters.json (no rendering)
    python score.py common [ids]   -> runs/common/<pid>.json (render + LoMa; locks)
    python score.py replay [ids]   -> runs/replay/<pid>.json (+ corr npz; locks)
"""
from __future__ import annotations

import json
import math
import sys
import time
import traceback
from pathlib import Path

import numpy as np

import h1lib as H
from h1lib import log, jdump, dang

RUNS = H.RUNS
PRIO = {"S1": 0, "S5": 1, "S2": 2, "S3": 3, "S4": 4, "S0": 5}
KPRIO = {"fused": 0, "stage1": 1, "probe": 2, "solve": 3}
LOMA_RAW = H.ROOT / "tools/matcher/v2/out/dev_loma/raw"


def stated_z(pid):
    """Engine eye z on the stated-eye page (C0 cache meta; identical to the T6 records' eye)."""
    return float(json.load(open(H.tm_common.CACHE / pid / "meta.json"))["eye"][2])


def native_inl(r):
    n = r["native"]
    for k in ("fusedInliers", "solveInliers", "stage1Inliers", "windowInliers"):
        if n.get(k) is not None:
            return int(n[k])
    return -1


def close_eye(a, b, tol=2.0):
    e, n = H.enu_offset(a["lat"], a["lon"], b["lat"], b["lon"])
    if a["h"] is None or b["h"] is None:
        return math.hypot(e, n) <= tol and a["h"] is None and b["h"] is None
    return math.sqrt(e * e + n * n + (a["h"] - b["h"]) ** 2) <= tol


def same_pose(p, q, tol=0.5):
    return abs(dang(p["yaw"], q["yaw"])) <= tol and abs(p["pitch"] - q["pitch"]) <= tol


def prescreen(r):
    k, n = r["kind"], r["native"]
    if k == "fused":
        return r["matcher"] == "aliked" or (n.get("fusedInliers") or 0) >= 30
    v = native_inl(r)
    return v >= 30


def page_alt(r, man, zs):
    """altitudeM for the render page: 'manifest' (stated page) | None (engine default at lat/lon) | float."""
    e = man[r["pid"]]
    if r["eye"]["lat"] == e["lat"] and r["eye"]["lon"] == e["lon"]:
        if r["eye"]["h"] is None or abs(r["eye"]["h"] - zs) <= 0.05:
            return "manifest"
        return round(r["eye"]["h"], 2)
    if r.get("pageAlt") is not None:
        return r["pageAlt"]
    return None  # moved eyes (S3 / v2 / eyeprobe) ran with altitudeM None


def ckey(c):
    p, e = c["pose"], c["eye"]
    return f"{p['yaw']:.4f},{p['pitch']:.4f},{p['roll']:.4f},{p['vfov']:.4f}@{e['lat']:.7f},{e['lon']:.7f},{'None' if e['h'] is None else round(e['h'], 3)}"


def do_merge():
    man = {e["id"]: e for e in json.load(open(H.ROOT / "tools/bench/data/manifest.json"))}
    rows = json.load(open(RUNS / "candidates_raw.json"))
    # fill unknown probe eye heights from a full-T6 record at the same lat/lon
    known = {}
    for r in rows:
        if r["eye"]["h"] is not None:
            known.setdefault((r["pid"], r["eye"]["lat"], r["eye"]["lon"]), r["eye"]["h"])
    for r in rows:
        if r["eye"]["h"] is None and (r["pid"], r["eye"]["lat"], r["eye"]["lon"]) in known:
            r["eye"]["h"] = known[(r["pid"], r["eye"]["lat"], r["eye"]["lon"])]
            r["eyeHFilled"] = True
    rows.sort(key=lambda r: (r["pid"], PRIO[r["src"]], KPRIO[r["kind"]], -native_inl(r), r["rid"]))
    clusters = []
    by_pid = {}
    for r in rows:
        cl = by_pid.setdefault(r["pid"], [])
        hit = next((c for c in cl if same_pose(c["pose"], r["pose"]) and close_eye(c["eye"], r["eye"])), None)
        if hit is None:
            hit = {"pid": r["pid"], "pose": r["pose"], "eye": dict(r["eye"]), "members": [], "rep": r["rid"]}
            cl.append(hit)
            clusters.append(hit)
        hit["members"].append(r["rid"])
    rid = {r["rid"]: r for r in rows}
    zs = {}
    for i, c in enumerate(clusters):
        pid = c["pid"]
        if pid not in zs:
            zs[pid] = stated_z(pid)
        ms = [rid[m] for m in c["members"]]
        c["cid"] = f"{pid}_k{sum(1 for q in clusters[:i] if q['pid'] == pid):03d}"
        c["sources"] = sorted({m["src"] for m in ms}, key=lambda s: PRIO[s])
        c["screen"] = any(prescreen(m) for m in ms)
        c["pageAlt"] = page_alt(rid[c["rep"]], man, zs[pid])
        fused = [m for m in ms if m["kind"] == "fused"]
        c["nativeFusedMax"] = max((m["native"].get("fusedInliers") or 0 for m in fused), default=None)
        c["key"] = ckey(c)
    jdump(clusters, RUNS / "clusters.json")
    import collections
    print(len(rows), "rows ->", len(clusters), "clusters;", sum(c["screen"] for c in clusters), "screened;",
          collections.Counter(tuple(c["sources"]) for c in clusters).most_common(12))


# ------------------------------------------------------------------ rendering / matching
class Scorer:
    def __init__(self):
        self.m = H.mods()
        self.s1 = self.m["s1"]
        self.w = self.s1.Worker(port=H.PORT)
        self.man = self.s1.manifest()

    def reset(self):
        self.w.close()
        self.w = self.s1.Worker(port=H.PORT)

    def photo(self, pid, lat, lon, alt, psrc=None):
        e = self.man[pid]
        if alt == "manifest":
            ent = e
        else:
            ent = {**e, "lat": lat, "lon": lon, "altitudeM": alt}
            if psrc:
                ent["positionSource"] = psrc
        return self.s1.Photo(pid, ent)

    def common(self, c, ph, se):
        F, s1 = self.m["F"], self.s1
        pose = c["pose"]
        views, _, meta, _ = se.render(poses=[{"tag": "c", **pose}], styles=("sat",))
        eye = meta["eye"]
        out = {"eyeAchieved": [float(x) for x in eye]}
        if c["eye"]["h"] is not None:
            out["eyeDz"] = float(eye[2] - c["eye"]["h"])
            out["eyeFlag"] = abs(out["eyeDz"]) > 0.5
        if not views:
            out.update({"common_inl": 0, "lifted": 0, "empty": True})
            return out
        corr = self.m["LM"].correspond_loma(ph.img, views, eye)
        W, Hh = corr["W"], corr["H"]
        if len(corr["x2d"]):
            res = np.linalg.norm(F.match_resid(F.x_from_pose(pose, Hh), corr, np.asarray(eye, float)), axis=1)
        else:
            res = np.zeros(0)
        out["common_inl"] = int((res < F.SUPPORT_PX).sum())
        out["lifted"] = int(len(res))
        out["matches"] = int(sum(p["matches"] for p in corr["perView"]))
        try:
            sol = s1.solve(corr, views, eye, pose, not ph.focal_known) if len(res) >= 6 else {}
        except Exception as ex:  # noqa: BLE001
            sol = {"error": str(ex)}
        if sol.get("pose"):
            sp = sol["pose"]
            out["solveInliers"] = int(sol.get("inliers", 0))
            out["solvePose"] = {k: float(sp[k]) for k in ("yaw", "pitch", "roll", "vfov")}
            out["solveDriftDeg"] = float(math.hypot(dang(sp["yaw"], pose["yaw"]), sp["pitch"] - pose["pitch"]))
        d = H.CORR / c["pid"]
        d.mkdir(parents=True, exist_ok=True)
        f = d / f"{c['cid']}__single.npz"
        np.savez_compressed(f, x2d=corr["x2d"].astype(np.float32), X=corr["X"].astype(np.float32), resid=res.astype(np.float32),
                            eye=np.asarray(eye, np.float64), pose=np.asarray([pose[k] for k in ("yaw", "pitch", "roll", "vfov")]),
                            W=np.int32(W), H=np.int32(Hh), focalKnown=np.bool_(ph.focal_known))
        out["corrSingle"] = str(f.relative_to(H.HERE))
        return out


def grouped(clusters, ids):
    g = {}
    for c in clusters:
        if ids and c["pid"] not in ids:
            continue
        g.setdefault(c["pid"], []).append(c)
    return g


def page_groups(cs):
    pg = {}
    for c in cs:
        pg.setdefault((c["eye"]["lat"], c["eye"]["lon"], c["pageAlt"] if c["pageAlt"] is not None else "none"), []).append(c)
    return pg


def do_common(ids):
    clusters = json.load(open(RUNS / "clusters.json"))
    od = RUNS / "common"
    od.mkdir(exist_ok=True)
    with H.tm_common.render_lock(), H.tm_common.gpu_lock():
        S = Scorer()
        t0 = time.time()
        try:
            for pid, cs in grouped(clusters, ids).items():
                f = od / f"{pid}.json"
                done = json.load(open(f)) if f.exists() else {}
                todo = [c for c in cs if c["screen"] and c["key"] not in done]
                if not todo:
                    continue
                tp = time.time()
                for (lat, lon, alt), gcs in page_groups(todo).items():
                    alt = None if alt == "none" else alt
                    for att in range(2):
                        ph = S.photo(pid, lat, lon, alt)
                        se = H.mods()["s1"].Session(S.w, ph)
                        try:
                            for c in gcs:
                                if c["key"] in done:
                                    continue
                                ts = time.time()
                                try:
                                    r = S.common(c, ph, se)
                                except Exception as ex:  # noqa: BLE001
                                    if "worker" in str(ex) or isinstance(ex, TimeoutError):
                                        raise
                                    r = {"error": f"{type(ex).__name__}: {ex}"}
                                r["ms"] = round((time.time() - ts) * 1000)
                                r["cid"] = c["cid"]
                                done[c["key"]] = r
                            break
                        except Exception as ex:  # noqa: BLE001
                            log(pid, "page group failed:", str(ex)[:200])
                            S.reset()
                        finally:
                            se.close()
                            ph.cleanup()
                    jdump(done, f)
                log(pid, len(todo), "scored", f"{time.time() - tp:.0f}s", "max common",
                    max((v.get("common_inl", 0) for v in done.values()), default=0))
        finally:
            S.w.close()
        log("common done", round(time.time() - t0), "s")


def do_replay(ids):
    """Fused-corr replay (native matcher, recorded stage-2 prior) for kept clusters lacking a captured fused set."""
    clusters = json.load(open(RUNS / "clusters.json"))
    rows = {r["rid"]: r for r in json.load(open(RUNS / "candidates_raw.json"))}
    kept = json.load(open(RUNS / "kept_cids.json"))
    od = RUNS / "replay"
    od.mkdir(exist_ok=True)
    man = {e["id"]: e for e in json.load(open(H.ROOT / "tools/bench/data/manifest.json"))}
    with H.tm_common.render_lock(), H.tm_common.gpu_lock():
        S = Scorer()
        s1, PL = S.s1, S.m["PL"]
        loma_corr = s1.correspond
        aliked_corr = H.ALIKED_CORR
        t0 = time.time()
        try:
            for pid, cs in grouped(clusters, ids).items():
                f = od / f"{pid}.json"
                done = json.load(open(f)) if f.exists() else {}
                for c in cs:
                    if c["cid"] not in kept or c["cid"] in done:
                        continue
                    fused = [rows[m] for m in c["members"] if rows[m]["kind"] == "fused"]
                    if not fused or any(m.get("corrFused") for m in fused):
                        continue
                    m = max(fused, key=lambda r: r["native"].get("fusedInliers") or 0)
                    zs = stated_z(pid)
                    alt = page_alt(m, man, zs)
                    psrc = None if alt == "manifest" else "moved"
                    ts = time.time()
                    ph = S.photo(pid, m["eye"]["lat"], m["eye"]["lon"], alt, psrc)
                    se = s1.Session(S.w, ph)
                    s1.correspond = aliked_corr if m["matcher"] == "aliked" else loma_corr
                    H.CAP["sink"] = []
                    try:
                        res, sk, corr, eye2 = PL.stage2(se, ph, m["prior"])
                        cp = H.CAP["sink"][-1]
                        path = H.save_fused(pid, f"{c['cid']}_replay", cp, {"replayOf": m["detail"], "matcher": m["matcher"]})
                        rp = res.get("pose") or {}
                        done[c["cid"]] = {"member": m["detail"], "matcher": m["matcher"], "corrFused": path,
                                          "replayInliers": res.get("inliers"), "recordedInliers": m["native"].get("fusedInliers"),
                                          "replayPose": rp, "replayPoseDiffDeg": (math.hypot(dang(rp["yaw"], m["pose"]["yaw"]), rp["pitch"] - m["pose"]["pitch"]) if rp else None),
                                          "eyeDz": float(eye2[2] - m["eye"]["h"]) if m["eye"]["h"] is not None else None,
                                          "ms": round((time.time() - ts) * 1000)}
                    except Exception as ex:  # noqa: BLE001
                        done[c["cid"]] = {"member": m["detail"], "error": f"{type(ex).__name__}: {ex}"}
                        if "worker" in str(ex):
                            S.reset()
                    finally:
                        H.CAP["sink"] = None
                        s1.correspond = loma_corr
                        se.close()
                        ph.cleanup()
                    jdump(done, f)
                    log(pid, c["cid"], done[c["cid"]].get("replayInliers"), "vs", done[c["cid"]].get("recordedInliers"), done[c["cid"]].get("error", ""))
        finally:
            S.w.close()
        log("replay done", round(time.time() - t0), "s")


if __name__ == "__main__":
    cmd = sys.argv[1]
    ids = set(sys.argv[2:])
    {"merge": lambda: do_merge(), "common": lambda: do_common(ids), "replay": lambda: do_replay(ids)}[cmd]()
