"""E2 stage A: raw photo<->variant matches (LoMa, ALIKED) over the scored views. Resumable. See PROTOCOL.txt.

    python match_run.py [--matchers loma,aliked] [--batch 6] [ids...]
Output raw/<matcher>/<pid>/<group>__<tag>__v<i>.npz (k0 photo px, k1 render px in the view FILE frame, pixel-centre
origin; conf; ms; fileW/H) - the X3 run_match.py format. v0 = cached rgb.jpg; v1..v5 = variants/<pid>/<key>__v<i>.jpg.
gpu_lock is held per batch of photos (models loaded inside, freed before release) so E1/E3 can interleave.
Does NOT import e2 common.py (stage-1 code imports tools/matcher/common.py under the name 'common').
"""
from __future__ import annotations
import argparse, contextlib, fcntl, gc, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
TM = HERE.parent.parent / "tm"
sys.path.insert(0, str(TM / "x3_modality"))
import matchers as MT  # noqa: E402  (env, sys.path, tm_common)
sys.path.insert(0, str(TM / "c0_cache"))
import cache_io as C  # noqa: E402
import tm_common  # noqa: E402
import numpy as np  # noqa: E402
import torch  # noqa: E402
from PIL import Image  # noqa: E402

RAW = HERE / "raw"
VAR = HERE / "variants"
VARIANTS = [0, 1, 2, 3, 4, 5]


def scored_views(meta):  # identical to geo.scored_views
    out = [("refs", r["label"]) for r in meta["correct_refs"]] + [("refs", r["label"]) for r in meta["wrong_refs"]]
    tags = {v["tag"] for v in meta["views"]["perturb"]}
    out += [("perturb", t) for t in ("yaw-8", "yaw-4", "yaw+4", "yaw+8") if t in tags]
    return out


def eval_ids():
    out = []
    for pid in tm_common.dev_ids():
        if C.done(pid):
            m = C.load_meta(pid)
            if m.get("correct_refs") and m.get("perturbBase"):
                out.append(pid)
    return out


def todo(mname, pid):
    meta = C.load_meta(pid)
    return [(g, t, i) for g, t in scored_views(meta) for i in VARIANTS
            if not (RAW / mname / pid / f"{g}__{t}__v{i}.npz").exists()]


def run_photo(m, mname, pid):
    tm_common.assert_dev(pid)
    photo = C.load_photo(pid)
    d = RAW / mname / pid
    d.mkdir(parents=True, exist_ok=True)
    n, tp = 0, time.time()
    views = {}
    for i in VARIANTS:  # variant outer, like X3's config outer
        for g, t in scored_views(C.load_meta(pid)):
            f = d / f"{g}__{t}__v{i}.npz"
            if f.exists():
                continue
            if (g, t) not in views:
                v = C.load_view(pid, g, t)
                H, W = v["rgb"].shape[:2]
                v["photo"] = np.array(Image.fromarray(photo).resize((W, H), Image.LANCZOS))
                views[(g, t)] = v
            v = views[(g, t)]
            H, W = v["rgb"].shape[:2]
            if i == 0:
                rimg = v["rgb"]
            else:
                p = VAR / pid / f"{g}__{t}__v{i}.jpg"
                if not p.exists():
                    print(f"  missing {p.name}", flush=True)
                    continue
                rimg = np.array(Image.open(p).convert("RGB"))
                assert rimg.shape[:2] == (H, W), (p, rimg.shape, H, W)
            ts = time.time()
            k0, k1, conf = m.match(v["photo"], rimg)
            ms = (time.time() - ts) * 1000
            np.savez_compressed(f, k0=np.asarray(k0, np.float32), k1=np.asarray(k1, np.float32),
                                conf=np.asarray(conf, np.float32), ms=ms, fileW=W, fileH=H)
            n += 1
    print(f"[{mname}] {pid}: {n} pairs in {time.time() - tp:.0f}s", flush=True)


@contextlib.contextmanager
def gpu_lock_blocking():
    """The SAME lock file as tm_common.gpu_lock() (tools/research/tm/.gpu.lock), but a blocking flock: tm_common polls
    with LOCK_NB every 2 s, and E1 releases/re-takes it back-to-back per photo, so polling starved this study for
    > 10 min on resume. A kernel-queued waiter is woken at the release."""
    f = open(TM / ".gpu.lock", "w")
    print("[e2] waiting (blocking) for gpu lock", flush=True)
    fcntl.flock(f, fcntl.LOCK_EX)
    print("[e2] gpu lock acquired", time.strftime("%H:%M:%S"), flush=True)
    try:
        yield
    finally:
        fcntl.flock(f, fcntl.LOCK_UN)
        f.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--matchers", default="loma,aliked")
    ap.add_argument("--batch", type=int, default=6)
    ap.add_argument("ids", nargs="*")
    a = ap.parse_args()
    ids = a.ids or eval_ids()
    # only photos whose variants are complete (appearance.py touches variants/<pid>/DONE after a full photo)
    ready = [p for p in ids if (VAR / p / "DONE").exists()]
    print("ready", len(ready), "of", len(ids), flush=True)
    for b in range(0, len(ready), a.batch):
        batch = ready[b:b + a.batch]
        if not any(todo(mn, p) for mn in a.matchers.split(",") for p in batch):
            continue
        with gpu_lock_blocking():
            for mname in a.matchers.split(","):
                if not any(todo(mname, p) for p in batch):
                    continue
                t0 = time.time()
                m = MT.get(mname)
                print(f"[{mname}] loaded in {time.time() - t0:.1f}s", flush=True)
                for pid in batch:
                    run_photo(m, mname, pid)
                del m
                gc.collect()
                if torch.backends.mps.is_available():
                    torch.mps.empty_cache()
    print("MATCH DONE", flush=True)


if __name__ == "__main__":
    main()
