"""Optimised path for roll spots: train Brush (Apache-2.0, tools/nearfield/brush/bin) on each leave-one-out fold.

Input: the folds written by spot-harness.mjs, tools/nearfield/roll/out/<spot>/fold_<held-out>/brush[-<variant>]/
(COLMAP text model in sparse/0, opaque images + masks/<stem>.png whose alpha = the near-field mask, init.ply = the
fast-path fusion).
With a masks/ image Brush multiplies the loss by the mask (alpha_is_mask): sky, people and the DEM-covered far field
are ignored. (RGBA images without masks are premultiplied: Brush then trained BLACK splats over people.) SH degree 0.
Output: fold_<h>/brush_out/<dataset>.ply (+ .log).

    tools/matcher/.venv/bin/python tools/nearfield/roll/brush_loo.py [--spot region-0-vp4] [--steps 3000] [--only fold_IMG_7063]

Brush runs on the Metal GPU: it takes the shared TM GPU lock (tools/research/tm/tm_common.gpu_lock) per run.
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
BRUSH = HERE.parent / "brush/bin/brush-app-aarch64-apple-darwin/brush_app"
sys.path.insert(0, str(ROOT / "tools/research/tm"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--spot", default="region-0-vp4")
    ap.add_argument("--steps", type=int, default=3000)
    ap.add_argument("--only", default=None, help="one fold dir name, e.g. fold_IMG_7063")
    ap.add_argument("--extra", default="", help="extra Brush CLI args")
    a = ap.parse_args()
    if not BRUSH.exists():
        sys.exit(f"Brush binary missing: {BRUSH} (see tools/nearfield/brush/README.txt)")
    from tm_common import gpu_lock  # noqa: E402

    spot = HERE / "out" / a.spot
    for fold in sorted(spot.glob("fold_*")):
        if a.only and fold.name != a.only:
            continue
        for ds in sorted(fold.glob("brush*")):
            if not ds.is_dir() or ds.name == "brush_out" or not (ds / "sparse/0/images.txt").exists():
                continue
            out = fold / "brush_out"
            out.mkdir(exist_ok=True)
            tmp = out / f"_{ds.name}"
            shutil.rmtree(tmp, ignore_errors=True)
            tmp.mkdir()
            cmd = [str(BRUSH), str(ds), "--total-steps", str(a.steps), "--sh-degree", "0", "--export-every", str(a.steps),
                   "--export-path", str(tmp), "--export-name", "final.ply", "--eval-every", str(10 * a.steps), "--seed", "42",
                   *a.extra.split()]
            t0 = time.time()
            with gpu_lock():
                r = subprocess.run(cmd, capture_output=True, text=True)
            sec = time.time() - t0
            (out / f"{ds.name}.log").write_text(" ".join(cmd) + f"\n# {sec:.1f} s, exit {r.returncode}\n" + r.stdout[-4000:] + r.stderr[-4000:])
            got = tmp / "final.ply"
            if r.returncode == 0 and got.exists():
                got.replace(out / f"{ds.name}.ply")
                print(f"{fold.name}/{ds.name}: {a.steps} steps in {sec:.1f} s")
            else:
                print(f"{fold.name}/{ds.name}: FAILED (exit {r.returncode}), see {out / (ds.name + '.log')}")
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
