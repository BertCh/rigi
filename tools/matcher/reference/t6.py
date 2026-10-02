"""Policy "t6" for ad-hoc two-stage requests: the T6 stage-1 search + the frozen T6 confidence rule.

Port of tools/matcher/stage1/pipeline.run_photo (reports/stage1.md §2) onto the service's own render
worker and matching code, with the selection and confidence taken from tools/matcher/stage1/rule.py
(frozen RULE block, sha1 292fb74f…; checked by assert_rule() at service start). Per request:

  stage 1 (hypotheses)
    edges + sky   worker `edges` (photo edge maps + 360° horizonDirs) → skyglobal.SkyGlobal.search, top 4
    sweep40       the v0.3.x 40° sweep (9 views, pitch 0, request vfov), baseline if ≥ 30 inliers
    appseeds      app autoAlign from 9 yaws × 3 pitches (always run; baseline when the sweep fails)
    narrow        hfov < 25°: the v0.3.x narrow_stage1 on the same align runs (+ other seeds ≥ 30 inliers)
    sweepfine     FOV-aware sweep, one rotation per window of 3 adjacent views, top 4 with ≥ 15 inliers
  stage 2 (verification)
    the baseline hypothesis first, then fine sweep / sky interleaved, then the other baseline source;
    2° dedupe, at most 6, each through the service's own stage 2 (5-view fan + skyline export →
    correspond → assemble); basin gap (pose6 fast grid, no re-render) for untrusted positions on every
    candidate that is a-priori HIGH or has match support ≥ 0.5
  selection + confidence: rule.select / rule.confidence, unchanged.

Not applied (reports/stage1.md §10.5): the post-freeze "keep the baseline's fused pose within 2°" refinement.
Request fields yawSeeds / poseSeeds / seeds are not generators of the frozen method: they are ignored
under this policy and listed in stage1.ignored.
"""
from __future__ import annotations

import importlib.util
import json
import math
import os
import shutil
import sys
import time
from pathlib import Path

import numpy as np

import core
import fuse

HERE = Path(__file__).resolve().parent
STAGE1 = HERE.parent / "stage1"
ROOT = HERE.parent.parent.parent
FROZEN_RULE_SHA1 = "292fb74f35f6f402b5e81f1b832bac565edd6807"


def _load(name: str, path: Path):
    """Import a stage1 module by file (never via sys.path: stage1/ must not shadow server/core.py etc.)."""
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


R = _load("t6_rule", STAGE1 / "rule.py")  # frozen RULE block + select / confidence
SG = _load("t6_skyglobal", STAGE1 / "skyglobal.py")

# pipeline.py constants (T6 code stamp c2d406ea3c557e6e)
MAX_VERIFY = 6
SKY_K = 4
SWEEP_WIN_MIN_INL = 15
FINE_MIN_STEP = 8.0
UNKNOWN_HFOVS = (40.0, 62.0)
DEDUPE_DEG = 2.0
GAP_SUPPORT = 0.5  # basin gap also for candidates with match support ≥ 0.5 (match-dominant candidates)
MIN_HORIZON_DIRS = 500
# GPU skyline grid (session mt-image-bc, 2026-09-28): DEFAULT ON since 2026-10-01; T6_GPU_GRID=0 (or off/false) opts out.
# The worker's `edges`
# also returns the WebGPU grid's candidate cells and sg.grid is replaced by their exact numpy re-score
# (sky_gpu.grid_from_cands: identical best/arg). No WebGPU, an overflow or any error in the page → the CPU grid.
# Same off-values as render_worker.mjs (SKY_GPU).
GPU_GRID = os.environ.get("T6_GPU_GRID", "").strip().lower() not in ("0", "off", "false")


def assert_rule() -> dict:
    """Service start: the RULE block must hash to the frozen sha1 (and match tools/bench/t6/RULE_FROZEN.sha1)."""
    got = R.rule_sha1()
    if got != FROZEN_RULE_SHA1:
        raise SystemExit(f"t6: stage1/rule.py RULE block sha1 {got} != frozen {FROZEN_RULE_SHA1}: refusing to start")
    f = ROOT / "tools/bench/t6/RULE_FROZEN.sha1"
    if f.exists() and f.read_text().split()[0] != got:
        raise SystemExit(f"t6: {f} does not match rule.py ({got}): refusing to start")
    return {"id": R.RULE_ID, "sha1": got}


def rule_info() -> dict:
    return {"id": R.RULE_ID, "sha1": R.rule_sha1()}


class Infra(RuntimeError):
    """Infrastructure failure inside a T6 run (empty horizon, worker error): the run is retried once."""


def dang(a, b):
    return (a - b + 540.0) % 360.0 - 180.0


def hfov_from_vfov(vfov, aspect):
    return 2 * math.degrees(math.atan(math.tan(math.radians(vfov) / 2) * aspect))


def vfov_from_hfov(hfov, aspect):
    return 2 * math.degrees(math.atan(math.tan(math.radians(hfov) / 2) / aspect))


def _p(pose):
    return {k: float(pose[k]) for k in ("yaw", "pitch", "roll", "vfov")}


def _fnum(x):
    return None if x is None else float(x)


# ------------------------------------------------------------------ one attempt

class Run:
    """One T6 attempt. `J` is the request context built by app.match_adhoc (worker call, photo, priors,
    flags, the service's correspond / assemble / stage / cancel hooks)."""

    def __init__(self, J):
        self.J = J
        self.k = 0
        self.reopened = [None, None]  # first / last worker reopen counter seen
        self.T = {}

    # worker ---------------------------------------------------------
    def call(self, req: dict) -> dict:
        if req.get("cmd") == "render":
            req = {"texUpload": True, **req}
        r = self.J.call(req)
        ro = r.get("reopened")
        if ro is not None:
            if self.reopened[0] is None:
                self.reopened[0] = ro
            self.reopened[1] = ro
        return r

    @property
    def hmr_reopens(self) -> int:
        a, b = self.reopened
        return 0 if a is None else int(b - a)

    def _dir(self, tag):
        self.k += 1
        return self.J.tmp / f"t6_{tag}{self.k}"

    def render(self, *, prior=None, offsets=None, poses=None, skyline=False, allow_empty=True):
        J = self.J
        d = self._dir("r")
        req = {"cmd": "render", "prior": prior or J.p0, "styles": ["sat"], "skyline": skyline, "allowEmpty": allow_empty,
               "outDir": str(d)}
        if poses is not None:
            req["poses"] = poses
        if offsets is not None:
            req["offsets"] = offsets
        try:
            r = self.call(req)
            views = J.load_views(r)
            sk = J.load_skyline(r.get("skyline")) if r.get("skyline") else None
            return views, sk, r["meta"], r.get("timing", {})
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def edges(self) -> dict:
        d = self._dir("e")
        try:
            req = {"cmd": "edges", "outDir": str(d)}
            if GPU_GRID:  # default: the page also computes the GPU grid's candidate cells (sky_gpu.py)
                req["skyGrid"] = {"vfov0": self.J.p0["vfov"], "focalKnown": bool(self.J.focal_known), "aspect": self.J.aspect}
            r = self.call(req)
            w, h, f = r["w"], r["h"], r["files"]
            gpu = None
            if GPU_GRID and f.get("cands") and r.get("skyGrid"):
                try:
                    gpu = {**r["skyGrid"], "cands": np.fromfile(f["cands"], np.uint32)}
                except Exception:  # noqa: BLE001  (no candidates → the CPU grid)
                    gpu = None
            out = {"w": w, "h": h,
                    "dirs": np.fromfile(f["horizon"], np.float32).reshape(-1, 3).astype(np.float64),
                    "fine": np.fromfile(f["fine"], np.float32).reshape(h, w),
                    "coarse": np.fromfile(f["coarse"], np.float32).reshape(h, w),
                    "fg": np.fromfile(f["fg"], np.float32).reshape(h, w),
                    "rgb": np.fromfile(f["rgb"], np.uint8).reshape(h, w, 4)[..., :3].copy(),
                    "meta": r["meta"], "timing": r.get("timing")}
            if GPU_GRID:
                out["gpuGrid"] = gpu
            return out
        finally:
            shutil.rmtree(d, ignore_errors=True)

    # generators -------------------------------------------------------
    def fine_sweep(self, eye):
        """pipeline.fine_sweep: views every max(8°, 0.5·hfov) at the photo vfov (unknown focal: hfov 40° and 62°);
        one rotation per window of 3 adjacent views; top 4 distinct windows with ≥ 15 inliers."""
        J = self.J
        hyps = []
        vfovs = [J.p0["vfov"]] if J.focal_known else [vfov_from_hfov(h, J.aspect) for h in UNKNOWN_HFOVS]
        t0 = time.time()
        nviews = 0
        for vf in vfovs:
            hf = hfov_from_vfov(vf, J.aspect)
            step = max(FINE_MIN_STEP, 0.5 * hf)
            n = max(9, int(math.ceil(360 / step)))
            step = 360 / n
            poses = [{"tag": f"f{i}", "yaw": i * step, "pitch": 0.0, "roll": 0.0, "vfov": vf} for i in range(n)]
            views, _, _, _ = self.render(poses=poses)
            nviews += len(views)
            if not views:
                continue
            c = J.correspond(J.photo, views, eye, deadline=J.deadline)
            counts = [p["lifted"] for p in c["perView"]]
            starts = np.r_[0, np.cumsum(counts)]
            tags = [p["tag"] for p in c["perView"]]
            for i in range(len(views)):
                idx = np.concatenate([np.arange(starts[(i + d) % len(views)], starts[(i + d) % len(views) + 1]) for d in (-1, 0, 1)])
                if len(idx) < 12:
                    continue
                sub = {**c, "x2d": c["x2d"][idx], "X": c["X"][idx]}
                prior = {"yaw": views[i].pose["yaw"], "pitch": 0.0, "roll": 0.0, "vfov": vf}
                s = core.solve(sub, views, eye, prior, free_focal=not J.focal_known, deadline=J.deadline)
                if s.get("pose") and s.get("inliers", 0) >= SWEEP_WIN_MIN_INL:
                    hyps.append({"source": "sweepfine", "pose": _p(s["pose"]), "inliers": int(s["inliers"]),
                                 "inlierFrac": s.get("inlierFrac"), "window": tags[i], "vfovRender": vf})
            del views, c
        hyps.sort(key=lambda h: -h["inliers"])
        out = []
        for h in hyps:
            if all(abs(dang(h["pose"]["yaw"], q["pose"]["yaw"])) > 2 or abs(h["pose"]["pitch"] - q["pose"]["pitch"]) > 2 for q in out):
                out.append(h)
        return out[:4], {"views": nviews, "ms": round((time.time() - t0) * 1000), "vfovs": vfovs}

    def narrow_stage1(self, ra: dict):
        """The v0.3.x narrow_stage1 on the align runs `ra`: seeds = heading (if known) / yaw hint + the app's
        top-3 separated skyline alternatives; each matched against a 3×3 fan at the photo's FOV.
        → (baseline candidate, other seeds with ≥ 30 inliers, info)   [pipeline.narrow_stage1]"""
        J = self.J
        A = J.consts
        hf, p0 = J.hfov, J.p0
        seeds = []
        if J.yaw_known:
            seeds.append({"yaw": p0["yaw"], "pitch": p0["pitch"], "roll": p0["roll"], "source": "heading"})
        if J.yaw_hint is not None:
            seeds.append({"yaw": float(J.yaw_hint), "pitch": p0["pitch"], "roll": p0["roll"], "source": "yaw-hint"})
        alts = sorted((a for x in ra["runs"] for a in x.get("alternatives", []) if a.get("pose")), key=lambda a: -a["total"])
        for a in alts:
            if len([q for q in seeds if q["source"] == "app-skyline"]) >= 3:
                break
            if all(abs(dang(a["pose"]["yaw"], q["yaw"])) > 2 * hf for q in seeds):
                seeds.append({**{k: a["pose"][k] for k in ("yaw", "pitch", "roll")}, "source": "app-skyline"})
        seeds = seeds[:A["ADHOC_NARROW_MAX_SEEDS"]]
        dy, dp = 0.8 * hf, 0.8 * p0["vfov"]
        tried, best = [], None
        for sd in seeds:
            views, eye = [], None
            for j, pp in enumerate((0.0,) if J.grav_known else (-dp, 0.0, dp)):
                vs, _, meta, _ = self.render(prior={"yaw": sd["yaw"], "pitch": sd["pitch"] + pp, "roll": sd["roll"], "vfov": p0["vfov"]},
                                             offsets=[round(-dy, 4), 0, round(dy, 4)])
                for v in vs:
                    v.tag = f"{v.tag}_p{j}"
                views += vs
                eye = meta["eye"]
            if not views:
                tried.append({"seed": sd, "pose": None, "inliers": 0})
                continue
            c = J.correspond(J.photo, views, eye, deadline=J.deadline, max_kp=A["SWEEP_KP"])
            r = core.solve(c, views, eye, {**p0, "yaw": sd["yaw"]}, free_focal=not J.focal_known, deadline=J.deadline)
            tried.append({"seed": sd, "pose": r.get("pose"), "inliers": r.get("inliers", 0)})
            if r.get("pose") is not None and (best is None or r.get("inliers", 0) > best[1].get("inliers", 0)):
                best = (sd, r)
        info = {"seeds": seeds, "tried": [{**t, "pose": t["pose"] and _p(t["pose"])} for t in tried]}

        def cand(pose, inl):
            p2 = _p(pose)
            if J.focal_known:
                p2["vfov"] = p0["vfov"]
            return {"pose": p2, "inliers": inl}
        if best is not None and best[1].get("inliers", 0) >= A["ADHOC_STAGE1_MIN_INLIERS"]:
            base = cand(best[1]["pose"], best[1]["inliers"])
            info["used"] = best[0]["source"]
        elif seeds:
            sd = next((q for q in seeds if q["source"] == "app-skyline"), seeds[0])
            base = {"pose": {"yaw": sd["yaw"], "pitch": sd["pitch"], "roll": sd["roll"], "vfov": p0["vfov"]}, "inliers": 0}
            info["used"] = f"fallback:{sd['source']}"
        else:
            base = None
        others = [cand(t["pose"], t["inliers"]) for t in tried if t["pose"] and t["inliers"] >= A["ADHOC_STAGE1_MIN_INLIERS"]
                  and (best is None or t["pose"] is not best[1].get("pose"))]
        return base, others, info

    # verification -----------------------------------------------------
    def stage2(self, prior2: dict):
        """The service's stage 2 at prior2 (app.match_adhoc's second half; skyline export required)."""
        J = self.J
        views, sk, meta, _ = self.render(prior=prior2, offsets=J.offs2, skyline=True, allow_empty=False)
        eye = meta["eye"]
        corr = J.correspond(J.photo, views, eye, deadline=J.deadline)
        res = J.assemble(corr, views, eye, prior2, sk, fused=True, free_focal=not J.focal_known, meta=None,
                         deadline=J.deadline, sky_note=None if sk else "app has no horizon/edge map")
        return res, sk, corr, eye

    def basin_gap(self, res, sk, corr, eye):
        """pose6 basin gap on the stage-2 cue + matches: exactly the v0.3.x basin_gap_check call (fast mode,
        regime "manual"), at the request position."""
        import dem as _dem
        import pose6

        J = self.J
        t0 = time.time()
        J.stage("basinGap")
        _dem.CANCEL = J.check_cancel
        try:
            prob = pose6.Problem("adhoc", corr["W"], corr["H"], sk, corr if len(corr["x2d"]) else None, eye, J.lat, J.lon,
                                 res["pose"], J.focal_known, "manual", fast=True)
        finally:
            _dem.CANCEL = None
        bg = pose6.basin_gap(prob, cancel=J.check_cancel)
        g = bg["grid"]
        return {"gap": _fnum(bg["gap"]), "ms": round((time.time() - t0) * 1000),
                "grid": {"step": g["step"], "best": g["best"], "second": g["second"]} if g else None}

    def _sky_search_gpu(self, sg, gg):
        """Unless T6_GPU_GRID=0: sg.search with sg.grid replaced by the exact numpy re-score of the page's GPU
        candidate cells (sky_gpu.grid_from_cands, identical best/arg). Any failure → the CPU grid."""
        J = self.J
        rec = {"used": False}
        if gg is not None:
            try:
                import sky_gpu  # only imported when the GPU grid is enabled

                sg.grid = sky_gpu.grid_from_cands(SG, sg, gg["cands"], gg.get("nYaw"), gg.get("nCombo"))
                sres = sg.search(J.p0["vfov"], J.focal_known, k=SKY_K)
                rec = {"used": True, "pageMs": round(float(gg.get("ms", 0)), 1), "gpuMs": round(float(gg.get("gpuMs", 0)), 1),
                       "nCand": int(gg.get("nCand", len(gg["cands"]))), "rescoreMs": sres["gridMs"]}
                return {**sres, "gpuGrid": rec}
            except Exception as e:  # noqa: BLE001  (keep the CPU grid)
                sg.__dict__.pop("grid", None)
                rec = {"used": False, "error": f"{type(e).__name__}: {e}"[:200]}
        sres = sg.search(J.p0["vfov"], J.focal_known, k=SKY_K)
        return {**sres, "gpuGrid": rec}

    # the whole attempt -------------------------------------------------
    def run(self) -> dict:
        J, T = self.J, self.T
        A = J.consts
        p0 = J.p0
        rec = {"positionSource": "exif-gps" if not J.untrusted else (J.position_source or "untrusted"),
               "focalKnown": J.focal_known, "vfov0": p0["vfov"], "hfov0": J.hfov, "narrow": J.narrow}
        # --- photo evidence + horizon (no autoAlign): skyline global search
        ts = time.time()
        J.stage("t6:edges")
        ed = self.edges()
        eye = ed["meta"]["eye"]
        rec["horizonDirs"] = int(len(ed["dirs"]))
        if len(ed["dirs"]) < MIN_HORIZON_DIRS:  # a page whose 360° horizon never got traced (dev-server reload)
            raise Infra(f"worker: page has an empty horizon ({len(ed['dirs'])} dirs)")
        J.stage("t6:sky")
        sg = SG.SkyGlobal(ed, J.aspect)
        if GPU_GRID:
            sres = self._sky_search_gpu(sg, ed.get("gpuGrid"))
        else:
            sres = sg.search(p0["vfov"], J.focal_known, k=SKY_K)
        del ed
        cands = [{"source": "sky", "rank": i, "pose": h["pose"], "skyScore0": h["score"]} for i, h in enumerate(sres["hyps"])]
        rec["sky"] = {"gridMs": sres["gridMs"], "refineMs": sres["refineMs"], "grid": sres["grid"]}
        if GPU_GRID:  # gridMs is then the numpy re-score of the candidate cells
            rec["sky"]["gpuGrid"] = {**sres["gpuGrid"], "hyps": sres["hyps"]}
        T["sky"] = round((time.time() - ts) * 1000)
        # --- baseline: the service sweep
        ts = time.time()
        base_seed = None
        s40 = {}
        if not J.narrow:  # the service runs the 40° sweep only for hfov ≥ 25° (narrow: narrow_stage1 below)
            views, _, _, tim = self.render(prior=p0, offsets=A["ADHOC_360_OFFSETS"] if J.full else [-20, -10, 0, 10, 20])
            if views:
                c40 = J.correspond(J.photo, views, eye, deadline=J.deadline, max_kp=A["SWEEP_KP"])
                s40 = core.solve(c40, views, eye, p0, free_focal=not J.focal_known, deadline=J.deadline)
            rec["sweep40"] = {"inliers": s40.get("inliers", 0), "pose": s40.get("pose") and _p(s40["pose"]), "renderTiming": tim}
            del views
        if s40.get("pose") and s40.get("inliers", 0) >= A["ADHOC_STAGE1_MIN_INLIERS"]:
            p2 = _p(s40["pose"])
            if J.focal_known:
                p2["vfov"] = p0["vfov"]
            cands.append({"source": "sweep40", "pose": p2, "inliers": int(s40["inliers"])})
            base_seed = "sweep40"
        T["sweep40"] = round((time.time() - ts) * 1000)
        # --- baseline: app skyline seeds (the service computes these only when the sweep fails; T6 always does)
        ts = time.time()
        seeds = [{"yaw": float(y), "pitch": p0["pitch"] + (0.0 if J.grav_known else dp), "roll": p0["roll"], "vfov": p0["vfov"]}
                 for y in A["ADHOC_360_OFFSETS"] for dp in ((0.0,) if J.grav_known else A["ADHOC_SEED_PITCHES"])]
        ra = self.call({"cmd": "align", "priors": seeds})
        best = max((x for x in ra["runs"] if x.get("pose")), key=lambda x: x["score"], default=None)
        if best:
            cands.append({"source": "appseeds", "pose": _p(best["pose"]), "appScore": best["score"]})
            if base_seed is None and not J.narrow and J.full:
                base_seed = "appseeds"
        if J.narrow:  # the service's narrow_stage1 (same seeds, 3×3 fans, best by inliers)
            nb, nalt, ninfo = self.narrow_stage1(ra)
            rec["narrowStage1"] = ninfo
            if nb:
                cands.append({**nb, "source": "narrow"})
                base_seed = "narrow"
            cands += [{**x, "source": "narrowalt"} for x in nalt]
        if base_seed is None:  # the service's stage-2 prior when stage 1 finds nothing: the request prior
            cands.append({"source": "prior", "pose": dict(p0)})
            base_seed = "prior"
        rec["baselineSeed"] = base_seed
        T["appseeds"] = round((time.time() - ts) * 1000)
        # --- FOV-aware fine sweep
        ts = time.time()
        if not J.narrow:
            J.stage("t6:sweepfine")
            fh, finfo = self.fine_sweep(eye)
            rec["sweepfine"] = finfo
            for h in fh:
                p2 = dict(h["pose"])
                if J.focal_known:
                    p2["vfov"] = p0["vfov"]
                cands.append({**h, "pose": p2})
        T["sweepfine"] = round((time.time() - ts) * 1000)
        # --- order for verification: the baseline seed first (the service result is always reproduced),
        # then fine-sweep (by inliers) and sky (by score) hypotheses interleaved, then the other baseline source
        base = [c for c in cands if c["source"] == base_seed]
        fine = sorted([c for c in cands if c["source"] == "sweepfine"], key=lambda c: -c.get("inliers", 0))
        sky = sorted([c for c in cands if c["source"] == "sky"], key=lambda c: c.get("rank", 0))
        fine = fine + sorted([c for c in cands if c["source"] == "narrowalt"], key=lambda c: -c.get("inliers", 0))
        rest = [c for c in cands if c["source"] in ("sweep40", "appseeds") and c["source"] != base_seed]
        inter = []
        for i in range(max(len(fine), len(sky))):
            inter += fine[i:i + 1] + sky[i:i + 1]
        cands = base + inter + rest
        uniq = []
        for c in cands:
            dup = next((u for u in uniq if abs(dang(c["pose"]["yaw"], u["pose"]["yaw"])) < DEDUPE_DEG
                        and abs(c["pose"]["pitch"] - u["pose"]["pitch"]) < DEDUPE_DEG), None)
            if dup:
                dup.setdefault("alsoFrom", []).append(c["source"])
                continue
            uniq.append(c)
        rec["nCandidates"] = len(uniq)
        rec["candidates"] = uniq
        # --- verification
        ts = time.time()
        for i, c in enumerate(uniq[:MAX_VERIFY]):
            t1 = time.time()
            J.stage("t6:verify")
            try:
                res, sk, corr, eye2 = self.stage2(c["pose"])
            except (J.Cancelled, core.Deadline):
                raise
            except J.ApiError as e:
                if e.status in (503, 504):  # renderer died / request budget: not a per-candidate failure
                    raise
                c["error"] = f"{e.code}: {e.message}"
                continue
            except Exception as e:  # noqa: BLE001  (e.g. a bad render for this hypothesis)
                c["error"] = f"{type(e).__name__}: {e}"[:300]
                continue
            fp = res.get("pose")
            c["res"] = res  # the full stage-2 response (returned if this candidate is selected)
            c["fused"] = {"pose": fp, "level": res.get("confidenceLevel"), "method": res.get("method"),
                          "checks": res.get("confidenceChecks"), "fusionScore": res.get("fusionScore"),
                          "inliers": res.get("inliers"), "inlierFrac": res.get("inlierFrac"), "nLifted": res.get("nLifted"),
                          "fusedFrom": res.get("fusedFrom"), "cues": res.get("cues"), "eye": eye2}
            if fp:
                c["fused"]["skyScore"] = float(sg.score_pose(fp, fine=True))
                sup = (res.get("confidenceChecks") or {}).get("matchSupport") or 0
                if (res.get("confidenceLevel") == "high" or sup >= GAP_SUPPORT) and J.untrusted:
                    try:
                        c["fused"]["basinGap"] = self.basin_gap(res, sk, corr, eye2)
                    except (J.Cancelled, core.Deadline):
                        raise
                    except Exception as e:  # noqa: BLE001  (gap unavailable → gapOK false)
                        c["fused"]["basinGap"] = {"error": f"{type(e).__name__}: {e}"[:200]}
            c["ms"] = round((time.time() - t1) * 1000)
            del sk, corr
        T["verify"] = round((time.time() - ts) * 1000)
        rec["hmrReopens"] = self.hmr_reopens
        return rec


# ------------------------------------------------------------------ response

def _veto(rec, c, checks):
    if not (R.apriori(c) or R.matchdom(c)):
        return None
    if not R.gap_ok(rec, c):
        bg = c["fused"].get("basinGap") or {}
        return "basinGap" if bg.get("gap") is not None else f"basinGap unavailable ({bg.get('error', 'not computed')})"
    if checks.get("ambiguity"):
        return "ambiguity"
    return None


def _cand_summary(rec, c, sel, base):
    fu = c.get("fused") or {}
    out = {"source": c["source"], "alsoFrom": c.get("alsoFrom", []), "hypothesis": _p(c["pose"]),
           "selected": c is sel, "baseline": c is base}
    for k in ("inliers", "rank", "skyScore0", "appScore", "window"):
        if k in c:
            out["hypothesis" + k[0].upper() + k[1:]] = c[k]
    if c.get("error"):
        out["error"] = c["error"]
    if fu.get("pose"):
        lvl, ch = R.confidence(rec, c)
        out.update(pose=fu["pose"], level=lvl.lower(), levelApriori=fu.get("level"), checks=ch,
                   basinGap=fu.get("basinGap"), skyScore=fu.get("skyScore"), ms=c.get("ms"))
    elif "fused" in c:
        out.update(pose=None, level=None, levelApriori=fu.get("level"), checks=fu.get("checks"), ms=c.get("ms"))
    else:
        out["verified"] = False
    return out


def response(J, rec: dict, attempts: list) -> dict:
    sel = R.select(rec)
    base = R.baseline(rec)
    stage1 = {"baselineSeed": rec.get("baselineSeed"), "nCandidates": rec.get("nCandidates"), "verified": len(R.verified(rec)),
              "maxVerify": MAX_VERIFY, "sweep40": rec.get("sweep40"), "sweepfine": rec.get("sweepfine"), "sky": rec.get("sky"),
              "narrowStage1": rec.get("narrowStage1"), "horizonDirs": rec.get("horizonDirs"),
              "positionSource": rec["positionSource"], "ignored": J.ignored, "attempts": attempts,
              "candidates": [_cand_summary(rec, c, sel, base) for c in rec.get("candidates", [])]}
    if sel is None:
        return {"pose": None, "method": "t6", "confidence": fuse.LOW_CONF, "confidenceLevel": "low",
                "reason": "no verified hypothesis", "confidenceChecks": {}, "cues": None, "stage1": stage1,
                "timingMs": dict(J.t6_timing)}
    lvl, checks = R.confidence(rec, sel)
    res = dict(sel["res"])
    high = lvl == "HIGH"
    checks = {**checks, "basinGap": _fnum(checks.get("basinGap")), "gapOK": bool(checks.get("gapOK"))}
    veto = _veto(rec, sel, checks)
    checks["veto"] = veto
    if checks.get("ambiguity"):
        checks["ambiguousWith"] = [
            {"source": q["source"], "pose": q["fused"]["pose"], "matchSupport": R._sup(q), "inliers": R._inl(q),
             "distDeg": round(R._dist(q["fused"]["pose"], sel["fused"]["pose"]), 3)}
            for q in R.verified(rec) if q is not sel and R.strong(q) and R._dist(q["fused"]["pose"], sel["fused"]["pose"]) > R.AMBIG_DEG]
    bg = (sel["fused"].get("basinGap") or {}).get("grid")
    if bg:
        checks["basinGrid"] = bg
    if J.untrusted:
        checks["positionTrusted"] = False  # as v0.3.x: set only for untrusted positions
    res.update(confidence=fuse.HIGH_CONF if high else fuse.LOW_CONF, confidenceLevel="high" if high else "low",
               confidenceChecks=checks, stage1=stage1, selectedSource=sel["source"])
    res.pop("lowReason", None)
    if not high and veto:
        res["lowReason"] = veto
    res["eye"] = sel["fused"]["eye"]
    res["baseline"] = ({"source": base["source"], "pose": base["fused"]["pose"], "confidenceLevelApriori": base["fused"].get("level")}
                       if base else None)
    res["stage2Prior"] = _p(sel["pose"])
    return res


def run(J) -> dict:
    """Policy t6 for one request, with one whole-run retry on an infrastructure failure or a dev-server
    reload (HMR page reopen) mid-run (pipeline.main's policy)."""
    attempts = []
    rec = None
    t0 = time.time()
    for attempt in (1, 2):
        run_ = Run(J)
        ta = time.time()
        try:
            rec = run_.run()
        except (J.Cancelled, core.Deadline):
            raise
        except J.ApiError as e:
            if e.status in (400, 404, 413, 504) or attempt == 2:
                raise
            attempts.append({"error": f"{e.code}: {e.message}"[:300], "ms": round((time.time() - ta) * 1000)})
        except Exception as e:  # noqa: BLE001
            if attempt == 2:
                raise
            attempts.append({"error": f"{type(e).__name__}: {e}"[:300], "ms": round((time.time() - ta) * 1000)})
        else:
            attempts.append({"hmrReopens": rec["hmrReopens"], "ms": round((time.time() - ta) * 1000), "timingMs": run_.T})
            if rec["hmrReopens"] == 0 or attempt == 2:
                break
            print(f"[matcher] t6: dev-server reload mid-request ({rec['hmrReopens']} page reopen(s)); re-running once", file=sys.stderr)
        J.release()  # start the retry on a fresh page
        rec = None
    J.t6_timing = {**attempts[-1].get("timingMs", {}), "t6": round((time.time() - t0) * 1000)}
    out = response(J, rec, attempts)
    out["timingMs"] = {**J.t6_timing, **{k: v for k, v in (out.get("timingMs") or {}).items() if k not in J.t6_timing}}
    return json.loads(json.dumps(out, default=_plain))  # numpy scalars → JSON types (the handler has no default)


def _plain(o):
    if isinstance(o, np.generic):
        return o.item()
    if isinstance(o, np.ndarray):
        return o.tolist()
    raise TypeError(f"not JSON serialisable: {type(o).__name__}")
