"""X3 stage A: raw photo<->render matches for (modality config x matcher) over cached views. Resumable.

    python run_match.py --matchers aliked,mloftr --configs sat,hill --ids wc_0004 ... --views prune [--tag prune]
    views: prune = all refs (correct + wrong) + perturb yaw-8, yaw-2, yaw+2, yaw+8
           refs  = all refs only
           ring  = the 12 ring views y000, y030, ..., y330 (default eye, pitch 0, hfov 40°): a 360° sweep
           full  = all refs + all 12 perturb + ring
Output: raw/<matcher>/<pid>/<group>__<tag>__<config>.npz  (k0 photo px, k1 render px in the render FILE frame,
        pixel-centre origin; conf; ms; fileW/H) + params/<pid>.json (per-photo modality parameters).
Heavy matchers (loma, mroma) hold tm_common.gpu_lock() for the process lifetime (model resident).
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import matchers as MT  # noqa: E402  (sets env, sys.path)
sys.path.insert(0, str(MT.TM / "c0_cache"))
import cache_io as C  # noqa: E402
import modalities as MD  # noqa: E402
import tm_common  # noqa: E402
import contextlib  # noqa: E402

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

RAW = HERE / "raw"
PARAMS = HERE / "params"
PRUNE_PERTURB = ["yaw-8", "yaw-2", "yaw+2", "yaw+8"]
PRUNE_IDS = ["wc_0004", "wc_0011", "wc_0014", "wc_0017", "wc_0046", "wc_0048", "wc_0059", "wc_0072", "wc_0085", "wc_0099"]


def photo_params(pid, photo):
    f = PARAMS / f"{pid}.json"
    if f.exists():
        return json.load(open(f))
    ring = [C.load_view(pid, "ring", f"y{y:03d}") for y in range(0, 360, 15)]
    p = MD.fit_params(photo, ring)
    PARAMS.mkdir(exist_ok=True)
    json.dump(p, open(f, "w"), indent=1)
    return p


RING12 = [f"y{y:03d}" for y in range(0, 360, 30)]


def view_list(meta, mode):
    if mode == "ring":
        return [("ring", t) for t in RING12]
    out = [("refs", r["label"]) for r in meta["correct_refs"] + meta["wrong_refs"]]
    if mode == "full":
        out += [("ring", t) for t in RING12]
    if meta.get("perturbBase"):
        tags = [v["tag"] for v in meta["views"]["perturb"]]
        if mode == "prune":
            tags = [t for t in tags if t in PRUNE_PERTURB]
        elif mode == "refs":
            tags = []
        out += [("perturb", t) for t in tags]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--matchers", required=True)
    ap.add_argument("--configs", default=",".join(MD.CONFIGS))
    ap.add_argument("--ids", default=",".join(PRUNE_IDS))
    ap.add_argument("--views", default="prune")
    a = ap.parse_args()
    ids = a.ids.split(",")
    cfgs = a.configs.split(",")
    mnames = a.matchers.split(",")
    for pid in ids:
        tm_common.assert_dev(pid)
    for mname in mnames:
        lock = tm_common.gpu_lock() if mname in MT.HEAVY else contextlib.nullcontext()
        with lock:
            t0 = time.time()
            m = MT.get(mname)
            print(f"[{mname}] loaded in {time.time() - t0:.1f}s", flush=True)
            for pid in ids:
                if not C.wait_done(pid):
                    print(f"{pid}: not in cache, skipped", flush=True)
                    continue
                meta = C.load_meta(pid)
                photo = C.load_photo(pid)
                params = photo_params(pid, photo)
                d = RAW / mname / pid
                d.mkdir(parents=True, exist_ok=True)
                n = 0
                tp = time.time()
                vcache: dict = {}
                for c in cfgs:  # config outer: the matcher's photo-feature cache stays warm
                    rm, pm = MD.CONFIGS[c]
                    for grp, tag in view_list(meta, a.views):
                        f = d / f"{grp}__{tag}__{c}.npz"
                        if f.exists():
                            continue
                        if (grp, tag) not in vcache:
                            v = C.load_view(pid, grp, tag)
                            if not v.get("empty"):
                                H, W = v["rgb"].shape[:2]
                                v["photo"] = np.array(Image.fromarray(photo).resize((W, H), Image.LANCZOS))
                            vcache[(grp, tag)] = v
                        v = vcache[(grp, tag)]
                        if v.get("empty"):
                            continue
                        H, W = v["rgb"].shape[:2]
                        rimg = MD.render_modality(rm, v, params)
                        pimg = MD.photo_modality(pm, v["photo"])
                        ts = time.time()
                        k0, k1, conf = m.match(pimg, rimg)
                        ms = (time.time() - ts) * 1000
                        np.savez_compressed(f, k0=np.asarray(k0, np.float32), k1=np.asarray(k1, np.float32),
                                            conf=np.asarray(conf, np.float32), ms=ms, fileW=W, fileH=H)
                        n += 1
                print(f"[{mname}] {pid}: {n} pairs in {time.time() - tp:.0f}s", flush=True)
            del m


if __name__ == "__main__":
    main()
