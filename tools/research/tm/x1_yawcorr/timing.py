"""X1 runtime: per-photo cost of the feature yaw correlation alone (no skyline polish / variants).
    python timing.py BACKBONE DEVICE [ids...]  -> results/timing_<bb>_<dev>.json
Stages: ring forward (24 views × sat+hill), photo forward, pano build + grid scoring (main cfg, 16 pitch × 5 roll × nvfov).
Machine is shared (other TM studies running), so numbers are upper bounds."""
from __future__ import annotations
import json, sys, time
import numpy as np
import x1lib as X
import run as R

bbn, dev = sys.argv[1], sys.argv[2]
ids = sys.argv[3:] or ["wc_0002", "wc_0017", "wc_0047", "wc_0059", "wc_0077"]
bb = X.Backbone(bbn, dev)
bb(np.zeros((224, 224, 3), np.uint8), 16, 16)  # warm-up
out = {}
for pid in ids:
    X.tm_common.assert_dev(pid)
    m = X.CI.load_meta(pid)
    fk = m["focal_known"]
    hf0 = m["hfov0"] if fk else 55.0
    dpp = float(np.clip(hf0 / 40, 0.5, 1.0)) if fk else 1.0
    grid = X.make_grid(dpp)
    t0 = time.time()
    ring, ringMs, _ = X.ring_tokens(bb, pid, dpp)
    Fp, (W, H), photoMs = X.photo_tokens(bb, pid, hf0, dpp)
    gh, gw = Fp.shape[:2]
    psky, pfg, _ = X.photo_masks(pid, gw, gh)
    t1 = time.time()
    wp = ((1 - psky) * (1 - pfg)).ravel()
    Fq = R.prep(Fp.reshape(-1, Fp.shape[-1]), wp)
    pan = {}
    for s in ("sat", "hill"):
        F, az, el, terr = ring[s]
        pan[s] = (R.prep(F, terr), az, el, terr)
    P = R.pca_fit([Fq] + [pan[s][0] for s in pan], 64)
    Fq = X.l2n(Fq @ P)
    sc = {s: X.Scorer(*X.build_pano(X.l2n(pan[s][0] @ P), *pan[s][1:], grid), grid) for s in pan}
    t2 = time.time()
    vfovs = [m["vfov0"]] if fk else [R.vfov_of(h, m["aspect"]) for h in (35, 45, 55, 65, 75)]
    n = 0
    for vf in vfovs:
        rays = X.cam_rays(W, H, vf, gw, gh).reshape(-1, 3)
        for p in R.PITCHES:
            for r in (-6, -3, 0, 3, 6):
                az, el = X.az_el(rays @ X.CI.pose_to_R({"yaw": 0.0, "pitch": float(p), "roll": float(r), "vfov": vf}))
                for s in sc:
                    sc[s].curve(Fq, wp, az, el)
                n += 1
    t3 = time.time()
    out[pid] = {"fk": fk, "ringFwdMs": round(ringMs), "photoFwdMs": round(photoMs), "loadAndMasksMs": round((t1 - t0) * 1000 - ringMs - photoMs),
                "panoMs": round((t2 - t1) * 1000), "gridMs": round((t3 - t2) * 1000), "nHyp": n, "totalMs": round((t3 - t0) * 1000)}
    print(pid, out[pid], flush=True)
json.dump(out, open(X.HERE / "results" / f"timing_{bbn}_{dev}.json", "w"), indent=1)
