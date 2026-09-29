"""The proposed wiring, end to end in Python: SkyGlobal.search with its grid replaced by an exact numpy
re-score of the GPU's certified candidate cells (out/gpu/skyglobal/<id>/cands.u32, written by
scripts/gpu/skyglobal-bench.mjs). Everything else (sky model, NMS, polish) is skyglobal.py unchanged.

  tools/matcher/.venv/bin/python tools/matcher/gpu_port/verify_gpu_cands.py [ids…]

Per photo: best/arg vs SkyGlobal.grid (must be bit-identical), top-k hyps vs ref.json (must be
identical), and the time of the candidate re-score. Writes out/gpu/skyglobal/cands-verify.json.
"""
from __future__ import annotations

import json
import math
import sys
import time

import numpy as np

from dump_skyglobal_fixtures import OUT, SKY_K, _load_sg, load

SG = _load_sg()


def grid_from_cands(sg, cands: np.ndarray):
    """A drop-in for SkyGlobal.grid(vfovs, pitches, rolls): the same expressions as grid(), evaluated only
    on the candidate (combo, yaw) cells, combos in grid()'s loop order (strict '>' keeps the first max)."""

    def grid(vfovs, pitches, rolls, ystep=0.5, astep=None):
        t0 = time.time()
        vmax = max(vfovs)
        hmax = 2 * math.degrees(math.atan(math.tan(math.radians(vmax) / 2) * sg.aspect))
        astep = astep or max(0.1, min(0.5, hmax / 120))
        ystep = max(astep, round(ystep / astep) * astep)
        prof = SG.horizon_profile(sg.dirs, astep)
        n = len(prof)
        sy = int(round(ystep / astep))
        yaws_i = np.arange(0, n, sy)
        ny = len(yaws_i)
        best = np.full(ny, -np.inf, np.float64)
        arg = np.zeros((ny, 3), np.float32)
        combo = cands // ny
        yaw = cands % ny
        order = np.lexsort((yaw, combo))
        combo, yaw = combo[order], yaw[order]
        seen = np.zeros(ny, bool)
        seen[yaw] = True
        if not seen.all():
            raise RuntimeError("GPU candidates miss a yaw: run the full grid")
        bounds = np.flatnonzero(np.r_[True, combo[1:] != combo[:-1], True])
        nP, nR = len(pitches), len(rolls)
        S = sg.Sc
        for a, b in zip(bounds[:-1], bounds[1:]):
            c = int(combo[a])
            ys = yaw[a:b]
            vi, rem = divmod(c, nP * nR)
            pi, ri = divmod(rem, nR)
            vf, p, r = vfovs[vi], pitches[pi], rolls[ri]
            hf = 2 * math.degrees(math.atan(math.tan(math.radians(vf) / 2) * sg.aspect))
            half = hf / 2 * 1.25 + 3
            ja = np.arange(-int(half / astep), int(half / astep) + 1)
            alpha = ja * astep
            El = prof[(yaws_i[ys][:, None] + ja[None, :]) % n]
            u, v, ok = SG.project_rel(alpha[None, :], El, p, r, vf, sg.aspect)
            x = np.clip(np.floor(u * sg.w).astype(np.int32), 0, sg.w - 1)
            y = np.clip(np.floor(v * sg.h).astype(np.int32), 0, sg.h - 1)
            val = np.where(ok, S[y, x], 0.0)
            cnt = ok.sum(1)
            cov = np.minimum(cnt / n / ((vf * sg.aspect / 360) * 0.6), 1)
            sc = np.where(cnt > max(3, 0.9 / astep), val.sum(1) / np.maximum(cnt, 1) * cov, 0.0)
            better = sc > best[ys]
            best[ys[better]] = sc[better]
            arg[ys[better]] = (vf, p, r)
        return {"yaw": yaws_i * astep, "best": best, "arg": arg, "astep": astep, "ms": round((time.time() - t0) * 1000)}

    return grid


def main():
    ids = sys.argv[1:] or sorted(p.name for p in OUT.iterdir() if (p / "cands.u32").exists())
    rows = []
    for pid in ids:
        m, ed = load(pid)
        ref = json.loads((OUT / pid / "ref.json").read_text())
        cands = np.fromfile(OUT / pid / "cands.u32", np.uint32).astype(np.int64)
        sg = SG.SkyGlobal(ed, m["aspect"])
        g = ref["grid"]
        pitches = np.arange(-15.0, 15.0 + 1e-9, g["pitches"][2])
        rolls = np.arange(-9.0, 9.0 + 1e-9, 1.5)
        full = sg.grid(g["vfovs"], pitches, rolls)
        fast = grid_from_cands(sg, cands)(g["vfovs"], pitches, rolls)
        same_grid = bool(np.array_equal(full["best"], fast["best"]) and np.array_equal(full["arg"], fast["arg"]))
        sg.grid = grid_from_cands(sg, cands)
        res = sg.search(m["vfov0"], m["focalKnown"], k=SKY_K)
        same_hyps = res["hyps"] == ref["hyps"]
        row = {"id": pid, "nCand": int(len(cands)), "nYaw": int(len(full["best"])), "gridIdentical": same_grid,
               "hypsIdentical": same_hyps, "fullGridMs": full["ms"], "candGridMs": fast["ms"], "refineMs": res["refineMs"]}
        rows.append(row)
        print(json.dumps(row), flush=True)
    (OUT / "cands-verify.json").write_text(json.dumps(rows, indent=1))
    bad = [r["id"] for r in rows if not (r["gridIdentical"] and r["hypsIdentical"])]
    print(f"{len(rows)} photos, {len(bad)} not identical: {bad}")


if __name__ == "__main__":
    main()
