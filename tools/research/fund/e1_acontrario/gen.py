"""E1 step 2: renders + LoMa evidence for REF / RING / YAW / DISPLACED hypotheses and horizon dirs for moved eyes.
Per photo: takes render_lock + gpu_lock, one worker (port 8796), closes it. Resumable: gen/<pid>/state.json.

    python gen.py [ids...] [--only ref,ring,yaw,disp,edges] [--deadline-utc YYYY-MM-DDTHH:MM]
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import time
import traceback

import numpy as np

import e1lib as E
from e1lib import dang, jdump

HP = json.load(open(E.HERE / "hyps_pool.json"))
DISTS = (50, 150, 400)
RING_HFOV = 40.0
YAW_OFFS = (-12, -6, 6, 12)
DISP_CUT = False  # DEVIATIONS.txt D1


def in_cut(i):
    """index into disp_eyes order (dist-major, bearing k minor): keep k == 0 (theta) at 150 and 400 m."""
    return i % 3 == 0 and DISTS[i // 3] in (150, 400)


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


class Ctx:
    def __init__(self):
        import h1lib as H
        self.H = H
        self.m = H.mods()  # s1.correspond -> LoMa (run_v2.use_loma), stage2 capture wrapper (inactive: no sink)
        self.s1, self.PL, self.LM = self.m["s1"], self.m["PL"], self.m["LM"]
        self.w = self.s1.Worker(port=int(E.os.environ["STAGE1_PORT"]))
        self.man = self.s1.manifest()

    def close(self):
        self.w.close()

    def reset(self):
        self.w.close()
        self.w = self.s1.Worker(port=int(E.os.environ["STAGE1_PORT"]))


def p4(p):
    return {k: float(p[k]) for k in ("yaw", "pitch", "roll", "vfov")}


def save_corr(pid, hid, corr, eye, pose, W=None, H=None):
    d = E.GEN / pid
    d.mkdir(parents=True, exist_ok=True)
    f = d / f"{hid}.npz"
    np.savez_compressed(f, x2d=np.asarray(corr["x2d"], np.float32), X=np.asarray(corr["X"], np.float32),
                        eye=np.asarray(eye, np.float64), pose=np.asarray([pose[k] for k in ("yaw", "pitch", "roll", "vfov")]),
                        W=np.int32(W or corr["W"]), H=np.int32(H or corr["H"]))
    return str(f.relative_to(E.HERE))


def common(ctx, se, ph, pose):
    """H1 common-support evidence: one sat render at pose + LoMa (correspond_loma, service lift)."""
    views, _, meta, _ = se.render(poses=[{"tag": "c", **pose}], styles=("sat",))
    eye = meta["eye"]
    if not views:
        return None, eye
    return ctx.LM.correspond_loma(ph.img, views, eye), eye


def solve_views(ctx, ph, se, poses, prefix, pid, st, key):
    """RING / YAW: render seeds, LoMa per view, single-view solve; >= 30 inliers -> common evidence at solved pose."""
    s1 = ctx.s1
    out = st.setdefault(key, [])
    done = {h["seedTag"] for h in out}
    todo = [p for p in poses if p["tag"] not in done]
    if not todo:
        return
    views, _, meta, _ = se.render(poses=todo, styles=("sat",))
    eye = meta["eye"]
    bytag = {v.tag: v for v in views}
    for p in todo:
        t0 = time.time()
        h = {"seedTag": p["tag"], "seed": p4(p), "kind": key.upper()}
        v = bytag.get(p["tag"])
        if v is None:
            h["empty"] = True
            out.append(h)
            continue
        corr = ctx.LM.correspond_loma(ph.img, [v], eye)
        prior = {"yaw": p["yaw"], "pitch": p["pitch"], "roll": p["roll"], "vfov": ph.vfov0}
        sol = {}
        if len(corr["x2d"]) >= 6:
            try:
                sol = s1.solve(corr, [v], eye, prior, not ph.focal_known)
            except Exception as ex:  # noqa: BLE001
                sol = {"error": str(ex)}
        sp = p4(sol["pose"]) if sol.get("pose") else prior
        if ph.focal_known:
            sp["vfov"] = ph.vfov0
        h.update(pose=sp, solveInliers=int(sol.get("inliers", 0) or 0), viewLifted=int(len(corr["x2d"])), eyeZ=float(eye[2]))
        if h["solveInliers"] >= 30:
            c2, eye2 = common(ctx, se, ph, sp)
            if c2 is not None:
                corr, eye = c2, eye2
                h["evidence"] = "common@solved"
            else:
                h["evidence"] = "view (common render empty)"
        else:
            h["evidence"] = "view"
        h["hid"] = f"{pid}_{prefix}{p['tag']}"
        h["corr"] = save_corr(pid, h["hid"], corr, eye, sp)
        h["nCorr"] = int(len(corr["x2d"]))
        h["ms"] = round((time.time() - t0) * 1000)
        out.append(h)


def disp_eyes(pid, e0):
    import dem as DEM
    rng = np.random.default_rng(E.SEED + int(pid.split("_")[1]))
    th = float(rng.uniform(0, 360))
    d = DEM.Dem(e0["lat"], e0["lon"], extent_m=600)
    eyes = []
    for dist in DISTS:
        for k in range(3):
            b = (th + 120 * k) % 360
            ee, nn = dist * math.sin(b * E.DEG), dist * math.cos(b * E.DEG)
            g = float(d.height(ee, nn))
            tag = f"d{dist}b{round(b)}"
            if not np.isfinite(g):
                eyes.append({"tag": tag, "rejected": "no DEM"})
                continue
            lon, lat = (float(x) for x in d.geo(ee, nn))
            eyes.append({"tag": tag, "dist": dist, "bearing": b, "e": ee, "n": nn, "lat": lat, "lon": lon, "ground": g,
                         "alt": round(g + 1.7, 2)})
    return eyes


def run_disp(ctx, pid, ph0, prior2, st):
    s1, PL = ctx.s1, ctx.PL
    e0 = ctx.man[pid]
    out = st.setdefault("disp", [])
    done = {h["tag"] for h in out}
    for i, ey in enumerate(disp_eyes(pid, e0)):
        if ey["tag"] in done:
            continue
        if DISP_CUT and not in_cut(i):  # DEVIATIONS.txt D1: {theta} x {150, 400} m only
            continue
        if ey.get("rejected"):
            out.append(ey)
            continue
        t0 = time.time()
        h = dict(ey)
        h["kind"] = "DISP"
        ent = {**e0, "lat": ey["lat"], "lon": ey["lon"], "altitudeM": ey["alt"]}
        ph = s1.Photo(pid, ent)
        se = s1.Session(ctx.w, ph)
        try:
            res, sk, corr, eye2 = PL.stage2(se, ph, prior2)
            fp = res.get("pose")
            fz = {"pose": fp, "level": res.get("confidenceLevel"), "method": res.get("method"), "checks": res.get("confidenceChecks"),
                  "fusionScore": res.get("fusionScore"), "inliers": res.get("inliers"), "inlierFrac": res.get("inlierFrac"),
                  "nLifted": res.get("nLifted"), "cues": res.get("cues"), "eye": list(map(float, eye2))}
            h["fused"] = fz
            h["eyeZ"] = float(eye2[2])
            if sk is not None:
                np.save(E.GEN / pid / f"dirs_{pid}_disp{ey['tag']}.npy", np.asarray(sk["dirs"], np.float32))
                h["dirs"] = f"gen/{pid}/dirs_{pid}_disp{ey['tag']}.npy"
            if fp:
                sup = (res.get("confidenceChecks") or {}).get("matchSupport") or 0
                if (res.get("confidenceLevel") == "high" or sup >= 0.5) and ph.e.get("positionSource") != "exif-gps":
                    try:
                        fz["basinGap"] = PL.basin_gap(ph, res, sk, corr, eye2)
                    except Exception as ex:  # noqa: BLE001
                        fz["basinGap"] = {"error": f"{type(ex).__name__}: {ex}"}
                pose = p4(fp)
                if ph.focal_known:
                    pose["vfov"] = ph.vfov0
                h["pose"] = pose
                c2, eye3 = common(ctx, se, ph, pose)
                h["hid"] = f"{pid}_disp{ey['tag']}"
                if c2 is not None:
                    h["corr"] = save_corr(pid, h["hid"], c2, eye3, pose)
                    h["nCorr"] = int(len(c2["x2d"]))
                    h["eyeZ"] = float(eye3[2])
            del sk, corr
        except Exception as ex:  # noqa: BLE001
            h["error"] = f"{type(ex).__name__}: {ex}"
            h["trace"] = traceback.format_exc()[-1500:]
            if "worker" in str(ex) or isinstance(ex, TimeoutError):
                se.close()
                ph.cleanup()
                raise
        finally:
            se.close()
            ph.cleanup()
        h["ms"] = round((time.time() - t0) * 1000)
        out.append(h)
        jdump(st, E.GEN / pid / "state.json")
        log(pid, "disp", ey["tag"], (h.get("fused") or {}).get("inliers"), (h.get("fused") or {}).get("level"), h.get("nCorr"),
            f"{h['ms'] / 1000:.0f}s", h.get("error", ""))


def run_edges(ctx, pid, st):
    """horizonDirs at every moved pool eye (one worker `edges` call per distinct page)."""
    s1 = ctx.s1
    e0 = ctx.man[pid]
    P = HP["photos"][pid]
    out = st.setdefault("edges", {})
    pages = {}
    for h in P["hyps"]:
        if (h.get("eyeDisplacementM") or 0) <= 2:
            continue
        z = np.load(h["corr"])
        key = f"{h['eye']['lat']:.7f},{h['eye']['lon']:.7f},{float(z['eye'][2]):.2f}"
        pages.setdefault(key, (h["eye"]["lat"], h["eye"]["lon"], round(float(z["eye"][2]), 2)))
    for key, (lat, lon, alt) in pages.items():
        if key in out:
            continue
        ph = s1.Photo(pid, {**e0, "lat": lat, "lon": lon, "altitudeM": alt})
        se = s1.Session(ctx.w, ph)
        try:
            ed = se.edges()
            f = E.GEN / pid / f"dirs_edges_{len(out):03d}.npy"
            np.save(f, np.asarray(ed["dirs"], np.float32))
            out[key] = {"dirs": str(f.relative_to(E.HERE)), "eye": list(map(float, ed["meta"]["eye"]))}
        except Exception as ex:  # noqa: BLE001
            out[key] = {"error": f"{type(ex).__name__}: {ex}"}
            if "worker" in str(ex):
                raise
        finally:
            se.close()
            ph.cleanup()
    jdump(st, E.GEN / pid / "state.json")


def cur_prior(pid):
    """P_lab displaced prior: the photo's own T6 ALIKED stated-eye rule.select pose (label-free)."""
    import rule as R
    rec = json.load(open(E.ROOT / "tools/matcher/v2/out/dev/raw" / f"{pid}.json"))["stated"]
    c = R.select(rec)
    return p4(c["fused"]["pose"]) if c else None


def run_photo(ctx, pid, only):
    s1 = ctx.s1
    P = HP["photos"][pid]
    f = E.GEN / pid / "state.json"
    st = json.load(open(f)) if f.exists() else {"pid": pid}
    (E.GEN / pid).mkdir(parents=True, exist_ok=True)
    ph = s1.Photo(pid)
    st["vfov0"], st["focalKnown"], st["aspect"], st["narrow"] = ph.vfov0, ph.focal_known, ph.aspect, ph.narrow
    try:
        if "ref" in only:
            refs_out = st.setdefault("ref", [])
            done = {h["hid"] for h in refs_out}
            for r in P["refsToRender"]:
                if r["hid"] in done:
                    continue
                t0 = time.time()
                alt = r["pageAlt"]
                php = ph if alt == "manifest" else s1.Photo(pid, {**ctx.man[pid], "altitudeM": alt})
                se = s1.Session(ctx.w, php)
                try:
                    c, eye = common(ctx, se, php, r["pose"])
                finally:
                    se.close()
                    if php is not ph:
                        php.cleanup()
                h = {**r, "eyeZ": float(eye[2]), "ms": round((time.time() - t0) * 1000)}
                if c is not None:
                    h["corr"] = save_corr(pid, r["hid"], c, eye, r["pose"])
                    h["nCorr"] = int(len(c["x2d"]))
                refs_out.append(h)
                jdump(st, f)
                log(pid, "ref", r["hid"], h.get("nCorr"))
        se = s1.Session(ctx.w, ph)
        try:
            if "ring" in only:
                t0 = time.time()
                vf = s1.vfov_from_hfov(RING_HFOV, ph.aspect)
                poses = [{"tag": f"y{i * 15:03d}", "yaw": float(i * 15), "pitch": 0.0, "roll": 0.0, "vfov": vf} for i in range(24)]
                solve_views(ctx, ph, se, poses, "ring", pid, st, "ring")
                jdump(st, f)
                log(pid, "ring", len(st["ring"]), f"{time.time() - t0:.0f}s", "solves>=30:", sum(1 for h in st["ring"] if h.get("solveInliers", 0) >= 30))
            if "yaw" in only and P["Pref"]:
                t0 = time.time()
                import refs
                r0 = refs.correct_refs(pid)[0]
                poses = [{"tag": f"o{d:+d}", **{k: float(r0["pose"][k]) for k in ("pitch", "roll", "vfov")},
                          "yaw": float((r0["pose"]["yaw"] + d) % 360)} for d in YAW_OFFS]
                solve_views(ctx, ph, se, poses, "yaw", pid, st, "yaw")
                jdump(st, f)
                log(pid, "yaw", len(st["yaw"]), f"{time.time() - t0:.0f}s")
        finally:
            se.close()
        if "disp" in only:
            if P["Pref"]:
                import refs
                prior2 = p4(refs.correct_refs(pid)[0]["pose"])
                st["dispPrior"] = {"from": "refs.correct_refs[0]", "pose": prior2}
            else:
                prior2 = cur_prior(pid)
                st["dispPrior"] = {"from": "T6 ALIKED stated rule.select", "pose": prior2}
            if prior2:
                if ph.focal_known:
                    prior2["vfov"] = ph.vfov0
                run_disp(ctx, pid, ph, prior2, st)
        if "edges" in only:
            run_edges(ctx, pid, st)
    finally:
        ph.cleanup()
        jdump(st, f)
    return st


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ids", nargs="*")
    ap.add_argument("--only", default="ref,ring,yaw,disp,edges")
    ap.add_argument("--deadline-utc", default=None)
    ap.add_argument("--disp-cut", action="store_true")
    a = ap.parse_args()
    global DISP_CUT
    DISP_CUT = a.disp_cut
    only = set(a.only.split(","))
    ids = a.ids or E.analysed()
    for pid in ids:
        E.tm_common.assert_dev(pid)
    dl = dt.datetime.fromisoformat(a.deadline_utc).replace(tzinfo=dt.timezone.utc) if a.deadline_utc else None
    T0 = time.time()
    for pid in ids:
        mk = E.GEN / pid / f"DONE_{'_'.join(sorted(only))}"
        if mk.exists():
            continue
        if dl and dt.datetime.now(dt.timezone.utc) > dl:
            log("deadline reached before", pid)
            break
        with E.tm_common.render_lock(), E.tm_common.gpu_lock():
            import s1
            s1.disk_guard(3.0)
            ctx = Ctx()
            t0 = time.time()
            try:
                for att in range(2):
                    try:
                        run_photo(ctx, pid, only)
                        mk.parent.mkdir(parents=True, exist_ok=True)
                        mk.write_text(time.strftime("%Y-%m-%dT%H:%M:%S"))
                        break
                    except Exception as ex:  # noqa: BLE001
                        log(pid, "attempt", att + 1, "failed:", f"{type(ex).__name__}: {ex}"[:300])
                        traceback.print_exc()
                        ctx.reset()
            finally:
                ctx.close()
            log("PHOTO", pid, f"{time.time() - t0:.0f}s", "total", f"{(time.time() - T0) / 60:.1f} min")


if __name__ == "__main__":
    main()
