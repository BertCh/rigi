"""X5 stage A: ALIKED+LightGlue(CPU) photo<->render matches for every cached view (refs, perturb, ring), lifted to
3-D through the cached half-res xyz with match.lift's checks (sky / < 250 m / 5x5-range-spread discontinuity).

    python match_all.py [--shard i/n] [ids...]
Output raw/<pid>/<group>__<tag>.npz:
    x2d  (N,2) photo points in the view's NATIVE continuous px (pixel-centre = i+0.5)  [all LightGlue matches]
    u2d  (N,2) render points, native continuous px
    X    (N,3) lifted world xyz (nan where not ok);  ok (N,) bool
Conventions follow s1.correspond (photo resized to the render image size, ALIKED 4096 kp det 0.01 on the model
device, LightGlue on CPU via core.lg_match) — DEV ids only; cache read-only; no rendering.
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
HERE = Path(__file__).resolve().parent
TM = HERE.parent
sys.path.insert(0, str(TM))
sys.path.insert(0, str(TM / "c0_cache"))
import tm_common  # noqa: E402
import s1  # noqa: E402,F401  (vendor path, match.py patches)
import core  # noqa: E402
import match as M  # noqa: E402
import cache_io as C  # noqa: E402
import numpy as np  # noqa: E402
import torch  # noqa: E402
from PIL import Image  # noqa: E402

torch.set_num_threads(int(os.environ.get("X5_THREADS", "3")))
RAW = HERE / "raw"


def views_of(meta):
    out = [("refs", r["label"]) for r in meta["correct_refs"] + meta["wrong_refs"]]
    out += [("perturb", v["tag"]) for v in meta["views"].get("perturb", [])]
    # ring: every 2nd view (30° steps, hfov 40° -> 10° overlap) to halve CPU LightGlue cost under machine load
    out += [("ring", v["tag"]) for v in meta["views"]["ring"] if not v.get("empty") and int(v["tag"][1:]) % 30 == 0]
    if (HERE / "extra" / meta["pid"]).exists():
        out += [("extra", d.name) for d in sorted((HERE / "extra" / meta["pid"]).iterdir()) if (d / "view.json").exists()]
    groups = os.environ.get("X5_GROUPS", "refs,perturb,ring").split(",")
    return [x for x in out if x[0] in groups]


def load_extra(pid, tag):
    import json
    vd = HERE / "extra" / pid / tag
    rec = json.load(open(vd / "view.json"))
    rec["xyz"] = np.load(vd / "xyz.npz")["xyz"]
    rec["rgb"] = np.array(Image.open(vd / "rgb.jpg").convert("RGB"))
    rec["hill"] = np.array(Image.open(vd / "hill.png"))
    return rec


def lift_half(u2d, xyz, eye):
    """u2d native continuous px -> xyz grid index coords (stride 2: sample (r,c) = native (2c+.5, 2r+.5))."""
    kp = (u2d - 0.5) / 2.0
    return M.lift(kp, xyz, np.asarray(eye, float))


def run(pid):
    tm_common.assert_dev(pid)
    meta = C.load_meta(pid)
    photo = C.load_photo(pid)
    od = RAW / pid
    od.mkdir(parents=True, exist_ok=True)
    feats = {}
    for g, t in views_of(meta):
        f = od / f"{g}__{t}.npz"
        if f.exists():
            continue
        v = load_extra(pid, t) if g == "extra" else C.load_view(pid, g, t)
        if v.get("empty"):
            continue
        t0 = time.time()
        rgb = v["rgb"]
        h, w = rgb.shape[:2]
        s = v["files"]["rgb"]["scale"]
        if (w, h) not in feats:
            pim = np.array(Image.fromarray(photo).resize((w, h), Image.LANCZOS))
            feats[(w, h)] = M.extract("aliked", pim)
        fp = feats[(w, h)]
        fr = M.extract("aliked", rgb)
        k0, k1 = core.lg_match(fp, fr)
        x2d = (k0 + 0.5) / s
        u2d = (k1 + 0.5) / s
        X, ok = lift_half(u2d, v["xyz"], v["eye"])
        X = X.astype(np.float64)
        X[~ok] = np.nan
        np.savez_compressed(f, x2d=x2d.astype(np.float32), u2d=u2d.astype(np.float32), X=X.astype(np.float64), ok=ok)
        print(f"{pid} {g}/{t}: {len(k0)} matches, {int(ok.sum())} lifted, {time.time() - t0:.1f}s", flush=True)


if __name__ == "__main__":
    args = sys.argv[1:]
    shard = None
    if args and args[0] == "--shard":
        shard = tuple(int(x) for x in args[1].split("/"))
        args = args[2:]
    ids = args or tm_common.dev_ids()
    if shard:
        ids = [p for i, p in enumerate(ids) if i % shard[1] == shard[0]]
    for pid in ids:
        run(pid)
    print("DONE", flush=True)
