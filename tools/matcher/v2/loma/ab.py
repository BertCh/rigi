"""A/B: ALIKED+LightGlue (service baseline) vs LoMa on DEV photos (experiments 2-4 of the LoMa brief).

Per dev photo (one worker render per view set, both matchers on the same pixels):
  oracle  for the first correct ref (refs.correct_refs): the service's stage-2 fan at the ref pose
          (prior = ref, offsets = ±hfov/2,±hfov/4,0 if narrow else ±20,±10,0) — the centre view is the
          render AT the ref pose. Each matcher: rotation-only RANSAC solve (s1.core.solve = the service
          solve) on the centre view alone and on the pooled 5-view fan.
  sweep   the service's 9-view 40° sweep at the manifest eye (prior = photo p0, offsets 0..320). Per view:
          rotation solve on that view alone (prior yaw = view yaw) → inliers, solved pose.
Baseline matching = s1.correspond(kind="aliked") (4096 kp, LightGlue on CPU, point pruning off as in s1).
LoMa = matcher.correspond_loma (device/precision from LOMA_* env).
Lifted correspondences are saved per view (npz) so metrics can be recomputed without re-rendering.

    python ab.py [ids...] [--out DIR] [--force]      (default: all dev ids)
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRATCH = Path(os.environ.get("LOMA_SCRATCH", "/private/tmp/claude-501/-Users-robertchristie-Documents-GitHub-mt-image/"
                                              "75c91a88-da3f-430c-b0e0-21fa75f9d390/scratchpad/loma"))
os.environ.setdefault("STAGE1_TMP", str(SCRATCH / "tmp"))
os.environ.setdefault("STAGE1_PORT", "8771")
(SCRATCH / "tmp").mkdir(parents=True, exist_ok=True)
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE.parent.parent / "stage1"))

import numpy as np  # noqa: E402
import s1  # noqa: E402
import refs  # noqa: E402
import matcher as L  # noqa: E402
import fusion as F  # noqa: E402
from common import pose_to_R  # noqa: E402

SPLIT_TEST = s1.test_ids()


def rot_err(p, q) -> float:
    """Angle (deg) of R_p R_q^T."""
    R = pose_to_R(p) @ pose_to_R(q).T
    return math.degrees(math.acos(max(-1.0, min(1.0, (np.trace(R) - 1) / 2))))


def resid_px(corr, pose, eye):
    if len(corr["x2d"]) == 0:
        return np.zeros(0)
    return np.linalg.norm(F.match_resid(F.x_from_pose(pose, corr["H"]), corr, np.asarray(eye, float)), axis=1)


def subset(corr, i0, i1):
    return {**corr, "x2d": corr["x2d"][i0:i1], "X": corr["X"][i0:i1]}


def view_slices(corr):
    n = [p["lifted"] for p in corr["perView"]]
    s = np.r_[0, np.cumsum(n)]
    return [(int(s[i]), int(s[i + 1])) for i in range(len(n))]


def solve_stats(corr, views, eye, prior, free_focal, ref=None):
    """Service rotation-only solve (2-pt RANSAC + LM, 6 px) → inliers, pose; vs ref: rot err, inliers within 6 px of ref."""
    r = s1.core.solve(corr, views, eye, prior, free_focal=free_focal)
    out = {"lifted": int(len(corr["x2d"])), "inliers": int(r.get("inliers", 0)), "pose": r.get("pose"),
           "inlierFrac": r.get("inlierFrac"), "coverage": r.get("coverage")}
    if ref is not None:
        e = resid_px(corr, ref, eye)
        out["liftedAtRef6"] = int((e < 6).sum())  # lifted matches consistent with the ref pose
        if r.get("pose") is not None:
            out["rotErr"] = round(rot_err(r["pose"], ref), 3)
            # RANSAC inliers of the solved pose that are also within 6 px under the ref pose
            es = resid_px(corr, r["pose"], eye)
            inl = es < 6
            out["inlAtRef6"] = int((inl & (e < 6)).sum())
            out["inlAtRef6Frac"] = round(float((inl & (e < 6)).sum() / max(1, inl.sum())), 4)
    return out


def run_matchers(ph, views, eye, kinds):
    res = {}
    for kind in kinds:
        t0 = time.time()
        if kind == "aliked":
            c = s1.correspond(ph.img, views, eye, kind="aliked")
        else:  # "loma" (LOMA_KP keypoints) or "loma4096" etc.
            c = L.correspond_loma(ph.img, views, eye, num_kp=int(kind[4:]) if kind[4:] else None)
        c["ms"] = round((time.time() - t0) * 1000)
        res[kind] = c
    return res


def render_retry(se, **kw):
    last = None
    for attempt in range(3):
        try:
            return se.render(**kw)
        except Exception as e:  # noqa: BLE001  HMR reloads on the shared dev server
            last = e
            print(f"  render retry {attempt + 1}: {type(e).__name__}: {str(e)[:120]}", flush=True)
            time.sleep(3)
    raise last


def save_corr(d: Path, name: str, corr: dict):
    np.savez_compressed(d / f"{name}.npz", x2d=corr["x2d"].astype(np.float32), X=corr["X"],
                        per=json.dumps(corr["perView"]), W=corr["W"], H=corr["H"])


def run_photo(w, pid, out: Path, kinds):
    ph = s1.Photo(pid)
    se = s1.Session(w, ph)
    d = out / pid
    d.mkdir(parents=True, exist_ok=True)
    rec = {"id": pid, "focalKnown": ph.focal_known, "hfov0": ph.hfov0, "vfov0": ph.vfov0, "narrow": ph.narrow,
           "tags": {k: v for k, v in ph.e.get("tags", {}).items() if k != "region"}, "loma": {"device": L.DEVICE, "prec": L.PREC,
           "model": L.MODEL, "kp": L.NUM_KP}}
    ff = not ph.focal_known
    try:
        cr = refs.correct_refs(pid)
        rec["correctRefs"] = [{"pose": r["pose"], "label": r["label"], "eyeH": r["eyeH"]} for r in cr]
        rec["wrongRefs"] = [{"pose": r["pose"], "label": r["label"]} for r in refs.wrong_refs(pid)]
        # ---------------- oracle (exp 2)
        if cr:
            ref = {k: float(cr[0]["pose"][k]) for k in ("yaw", "pitch", "roll", "vfov")}
            hf = s1.hfov_from_vfov(ref["vfov"], ph.aspect)
            offs = [round(k * hf, 4) for k in (-0.5, -0.25, 0, 0.25, 0.5)] if ph.narrow else [-20, -10, 0, 10, 20]
            views, _, meta, tim = render_retry(se, prior=ref, offsets=offs, styles=("sat",), allow_empty=False)
            eye = meta["eye"]
            ci = [i for i, o in enumerate(offs) if o == 0][0]
            rec["oracle"] = {"ref": ref, "offsets": offs, "eye": eye, "renderMs": tim}
            mres = run_matchers(ph, views, eye, kinds)
            for kind, c in mres.items():
                save_corr(d, f"oracle_{kind}", c)
                sl = view_slices(c)
                cc = subset(c, *sl[ci])
                rec["oracle"][kind] = {
                    "ms": c["ms"], "msPerPair": round(c["ms"] / len(views)), "perView": c["perView"],
                    "centre": solve_stats(cc, [views[ci]], eye, ref, ff, ref),
                    "fan": solve_stats(c, views, eye, ref, ff, ref)}
            del views
        # ---------------- sweep (exp 3)
        views, _, meta, tim = render_retry(se, prior=ph.p0, offsets=s1.APP.ADHOC_360_OFFSETS, styles=("sat",))
        eye = meta["eye"]
        rec["sweep"] = {"eye": eye, "yaws": [v.pose["yaw"] for v in views], "tags": [v.tag for v in views],
                        "vfov": ph.p0["vfov"], "renderMs": tim}
        if views:
            mres = run_matchers(ph, views, eye, kinds)
            for kind, c in mres.items():
                save_corr(d, f"sweep_{kind}", c)
                sl = view_slices(c)
                per = []
                for i, v in enumerate(views):
                    cv = subset(c, *sl[i])
                    st = solve_stats(cv, [v], eye, {**ph.p0, "yaw": v.pose["yaw"]}, ff)
                    st["refConsistent"] = None
                    if cr and st["pose"] is not None:
                        st["refRotErr"] = round(min(rot_err(st["pose"], {k: float(r["pose"][k]) for k in ("yaw", "pitch", "roll", "vfov")})
                                                    for r in cr), 3)
                    if cr:  # lifted matches of this view consistent (6 px) with the nearest correct ref
                        st["liftedAtRef6"] = int(max((resid_px(cv, {k: float(r["pose"][k]) for k in ("yaw", "pitch", "roll", "vfov")}, eye) < 6).sum()
                                                     for r in cr))
                    per.append({"tag": v.tag, "yaw": v.pose["yaw"], "matches": c["perView"][i]["matches"], **st})
                rec["sweep"][kind] = {"ms": c["ms"], "msPerPair": round(c["ms"] / len(views)), "views": per,
                                      "pooled": solve_stats(c, views, eye, ph.p0, ff)}
        del views
    except Exception as e:  # noqa: BLE001
        rec["error"] = f"{type(e).__name__}: {e}"
        rec["trace"] = traceback.format_exc()[-2000:]
    finally:
        rec["hmrReopens"] = se.hmr_reopens
        se.close()
        ph.cleanup()
    return rec


def complete(f: Path, kinds) -> bool:
    """A record counts as done only if it parses, has no error, and has sweep results for every matcher
    (a record written while the disk was unreadable may be truncated or an error stub)."""
    try:
        r = json.load(open(f))
    except Exception:  # noqa: BLE001  missing / truncated
        return False
    if "error" in r or "sweep" not in r:
        return False
    return not r["sweep"].get("yaws") or all(k in r["sweep"] for k in kinds)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ids", nargs="*")
    ap.add_argument("--out", default=str(SCRATCH / "runs" / "main"))
    ap.add_argument("--kinds", default="aliked,loma,loma4096")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    dev = refs.dev_ids()
    ids = a.ids or dev
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    kinds = a.kinds.split(",")
    L.model()
    w = s1.Worker(port=int(os.environ["STAGE1_PORT"]))
    try:
        for pid in ids:
            assert pid in dev and pid not in SPLIT_TEST, f"{pid}: dev ids only"
            f = out / f"{pid}.json"
            if complete(f, kinds) and not a.force:
                continue
            s1.disk_guard()
            t0 = time.time()
            for attempt in range(3):
                rec = run_photo(w, pid, out, kinds)
                if "error" not in rec:
                    break
                print(f"{pid}: attempt {attempt + 1} failed: {rec['error'][:200]}", flush=True)
                if "worker" in rec["error"] or "Timeout" in rec["error"]:
                    w.close()
                    w = s1.Worker(port=int(os.environ["STAGE1_PORT"]))
            rec["attempts"] = attempt + 1
            rec["wallS"] = round(time.time() - t0, 1)
            rec["loadavg"] = os.getloadavg()
            json.dump(rec, open(f, "w"), indent=1, default=float)
            o = rec.get("oracle", {})
            print(pid, "oracle", {k: (o[k]["fan"]["inliers"], o[k]["fan"].get("rotErr")) for k in kinds if k in o},
                  "sweep best", {k: max((v["inliers"] for v in rec["sweep"][k]["views"]), default=0) for k in kinds if k in rec.get("sweep", {})},
                  f"{rec['wallS']}s load {rec['loadavg'][0]:.0f}", rec.get("error", ""), flush=True)
    finally:
        w.close()


if __name__ == "__main__":
    main()
