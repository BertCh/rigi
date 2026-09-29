"""Fixtures + profile for the WebGPU port of the T6 skyline global search (src/lib/gpu/skyglobal).

Standalone: imports tools/matcher/stage1 (s1.py, skyglobal.py) read-only, never edits them.

  edges  <ids…>   worker `edges` (browser; run under scripts/gpu/with-render-lock.mjs, APP_URL=:3110)
                  → out/gpu/skyglobal/<id>/{dirs.f32, fine.f32, coarse.f32, fg.f32, rgb.u8, meta.json}
  ref    <ids…>   pure numpy: SkyGlobal exactly as t6.py calls it (search(vfov0, focal_known, k=4)),
                  with a per-step profile, plus reference outputs for parity:
                  ref.json (profile, grid params, peaks, hyps), best.f64 / arg.f32 (per-yaw grid winner),
                  sky.f32 / Sc.f32 / Sf.f32 (pre-step maps) and, with --full, grid.f32 (score per
                  combo × yaw, combo order = the grid's loop order vfov → pitch → roll)

Dev photos only (tools/bench/split.json "dev"); test ids are refused.
"""
from __future__ import annotations

import json
import math
import os
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
OUT = ROOT / "out/gpu/skyglobal"
STAGE1 = HERE.parent / "stage1"
SKY_K = 4  # t6.py


def _dev() -> list[str]:
    return list(json.load(open(ROOT / "tools/bench/split.json"))["dev"])


def _load_sg():
    import importlib.util
    spec = importlib.util.spec_from_file_location("gp_skyglobal", STAGE1 / "skyglobal.py")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def dump_edges(ids):
    os.environ.setdefault("STAGE1_PORT", "8779")
    os.environ.setdefault("APP_URL", "http://localhost:3110")
    sys.path.insert(0, str(STAGE1))
    import s1  # noqa: E402  (read-only import: Photo / Session / Worker)
    w = s1.Worker()
    try:
        for pid in ids:
            t0 = time.time()
            ph = s1.Photo(pid)
            try:
                se = s1.Session(w, ph)
                ed = se.edges()
            except Exception as e:  # noqa: BLE001
                print(f"{pid}: edges failed: {e}", flush=True)
                ph.cleanup()
                continue
            d = OUT / pid
            d.mkdir(parents=True, exist_ok=True)
            ed["dirs"].astype(np.float32).tofile(d / "dirs.f32")  # the worker's float32, exactly
            for k in ("fine", "coarse", "fg"):
                ed[k].astype(np.float32).tofile(d / f"{k}.f32")
            np.ascontiguousarray(ed["rgb"], np.uint8).tofile(d / "rgb.u8")
            meta = {"id": pid, "w": int(ed["w"]), "h": int(ed["h"]), "nDirs": int(len(ed["dirs"])), "aspect": ph.aspect,
                    "vfov0": ph.vfov0, "focalKnown": bool(ph.focal_known), "hfov0": ph.hfov0, "W0": ph.W0, "H0": ph.H0,
                    "workerTiming": ed.get("timing"), "edgesMs": round((time.time() - t0) * 1000)}
            (d / "meta.json").write_text(json.dumps(meta, indent=1))
            print(f"{pid}: {meta['w']}x{meta['h']} dirs {meta['nDirs']} vfov0 {ph.vfov0:.2f} focal {ph.focal_known} "
                  f"({meta['edgesMs']} ms)", flush=True)
            ph.cleanup()
    finally:
        w.close()


def load(pid):
    d = OUT / pid
    m = json.loads((d / "meta.json").read_text())
    w, h = m["w"], m["h"]
    ed = {"w": w, "h": h,
          "dirs": np.fromfile(d / "dirs.f32", np.float32).reshape(-1, 3).astype(np.float64),
          "fine": np.fromfile(d / "fine.f32", np.float32).reshape(h, w),
          "coarse": np.fromfile(d / "coarse.f32", np.float32).reshape(h, w),
          "fg": np.fromfile(d / "fg.f32", np.float32).reshape(h, w),
          "rgb": np.fromfile(d / "rgb.u8", np.uint8).reshape(h, w, 3)}
    return m, ed


def full_grid(SG, sg, vfovs, pitches, rolls, ystep=0.5):
    """SkyGlobal.grid's loop, keeping every combo's per-yaw score (float64)."""
    vmax = max(vfovs)
    hmax = 2 * math.degrees(math.atan(math.tan(math.radians(vmax) / 2) * sg.aspect))
    astep = max(0.1, min(0.5, hmax / 120))
    ystep = max(astep, round(ystep / astep) * astep)
    prof = SG.horizon_profile(sg.dirs, astep)
    n = len(prof)
    sy = int(round(ystep / astep))
    yaws_i = np.arange(0, n, sy)
    rows = []
    for vf in vfovs:
        hf = 2 * math.degrees(math.atan(math.tan(math.radians(vf) / 2) * sg.aspect))
        half = hf / 2 * 1.25 + 3
        ja = np.arange(-int(half / astep), int(half / astep) + 1)
        alpha = ja * astep
        El = prof[(yaws_i[:, None] + ja[None, :]) % n]
        for p in pitches:
            for r in rolls:
                u, v, ok = SG.project_rel(alpha[None, :], El, p, r, vf, sg.aspect)
                x = np.clip(np.floor(u * sg.w).astype(np.int32), 0, sg.w - 1)
                y = np.clip(np.floor(v * sg.h).astype(np.int32), 0, sg.h - 1)
                val = np.where(ok, sg.Sc[y, x], 0.0)
                cnt = ok.sum(1)
                cov = np.minimum(cnt / n / ((vf * sg.aspect / 360) * 0.6), 1)
                rows.append(np.where(cnt > max(3, 0.9 / astep), val.sum(1) / np.maximum(cnt, 1) * cov, 0.0))
    return np.array(rows), prof


def ref(ids, full=False, reps=1):
    SG = _load_sg()
    for pid in ids:
        m, ed = load(pid)
        prof_ms = {}
        best_total = None
        for _ in range(reps):
            T = {}
            t0 = time.perf_counter()
            t = time.perf_counter()
            lbl = SG.scan_labels(ed["rgb"], ed["fg"])
            T["scanLabels"] = time.perf_counter() - t
            t = time.perf_counter()
            sky = SG.fit_sky(ed["rgb"], ed["fg"], lbl)
            T["fitSky"] = time.perf_counter() - t
            t = time.perf_counter()
            Sc = SG.score_map(ed["coarse"], sky, ed["fg"], fine=False)
            Sf = SG.score_map(ed["fine"], sky, ed["fg"], fine=True)
            T["scoreMaps"] = time.perf_counter() - t
            t = time.perf_counter()
            sg = SG.SkyGlobal(ed, m["aspect"])  # the constructor as t6 runs it (repeats the three steps)
            T["ctor"] = time.perf_counter() - t
            assert np.array_equal(sg.Sc, Sc) and np.array_equal(sg.Sf, Sf)
            t = time.perf_counter()
            res = sg.search(m["vfov0"], m["focalKnown"], k=SKY_K)
            T["search"] = time.perf_counter() - t
            T["grid"] = res["gridMs"] / 1000
            T["refine"] = res["refineMs"] / 1000
            T["nmsEtc"] = T["search"] - T["grid"] - T["refine"]
            T["total"] = T["ctor"] + T["search"]
            T["wall"] = time.perf_counter() - t0
            if best_total is None or T["total"] < best_total:
                best_total, prof_ms = T["total"], {k: round(v * 1000, 1) for k, v in T.items()}
        d = OUT / pid
        g = res["grid"]
        vfovs = g["vfovs"]
        p0, p1, ps = g["pitches"]
        pitches = np.arange(-15.0, 15.0 + 1e-9, ps)
        rolls = np.arange(-9.0, 9.0 + 1e-9, 1.5)
        assert abs(pitches[-1] - p1) < 1e-12
        gg = sg.grid(vfovs, pitches, rolls)
        gg["best"].astype(np.float64).tofile(d / "best.f64")
        gg["arg"].astype(np.float32).tofile(d / "arg.f32")
        sky.astype(np.float32).tofile(d / "sky.f32")
        Sc.tofile(d / "Sc.f32")
        Sf.tofile(d / "Sf.f32")
        # count of refine score evaluations (for the profile): wrap score_pose
        calls = [0]
        orig = SG.SkyGlobal.score_pose

        def counted(self, pose, fine=True):
            calls[0] += 1
            return orig(self, pose, fine)
        SG.SkyGlobal.score_pose = counted
        res2 = sg.search(m["vfov0"], m["focalKnown"], k=SKY_K)
        SG.SkyGlobal.score_pose = orig
        assert res2["hyps"] == res["hyps"]
        info = {"id": pid, "profileMs": prof_ms, "refineEvals": calls[0], "grid": g,
                "nYaw": int(len(gg["yaw"])), "nCombo": len(vfovs) * len(pitches) * len(rolls),
                "hyps": res["hyps"], "k": SKY_K}
        if full:
            G, prof = full_grid(SG, sg, vfovs, pitches, rolls)
            gb = G.max(0)
            assert np.array_equal(np.where(np.isfinite(gg["best"]), gg["best"], -np.inf), gb), "full grid != grid()"
            G.astype(np.float32).tofile(d / "grid.f32")
            prof.tofile(d / "prof.f64")
            info["gridShape"] = list(G.shape)
        (d / "ref.json").write_text(json.dumps(info, indent=1))
        print(f"{pid}: {json.dumps(prof_ms)} evals {calls[0]} combos {info['nCombo']} yaws {info['nYaw']}", flush=True)


def main():
    a = sys.argv[1:]
    if not a or a[0] not in ("edges", "ref"):
        raise SystemExit(__doc__)
    mode, rest = a[0], a[1:]
    full = "--full" in rest
    reps = 1
    if "--reps" in rest:
        reps = int(rest[rest.index("--reps") + 1])
        del rest[rest.index("--reps"): rest.index("--reps") + 2]
    ids = [x for x in rest if not x.startswith("--")]
    dev = _dev()
    if not ids or ids == ["all"]:
        ids = dev if mode == "edges" else sorted(p.name for p in OUT.iterdir() if (p / "meta.json").exists())
    bad = [x for x in ids if x not in dev]
    if bad:
        raise SystemExit(f"not dev photos (frozen split): {bad}")
    (dump_edges if mode == "edges" else lambda i: ref(i, full, reps))(ids)


if __name__ == "__main__":
    main()
