"""Cache the worker's pose-free photo edge maps (+ the manifest-eye horizonDirs) per photo → .cache/edges/<id>.npz.
Usage: cache_edges.py id [id ...]   (dev ids only unless V2_ALLOW_TEST=1; v3 ids only via STAGE1_MANIFEST + V3_ALLOW=1, see stage1/manifest_guard.py)"""
import os, sys, json
from pathlib import Path
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "stage1"))
import numpy as np
import s1

OUT = HERE / ".cache" / "edges"; OUT.mkdir(parents=True, exist_ok=True)
ids = sys.argv[1:]
if os.environ.get("V2_ALLOW_TEST") != "1":
    bad = set(ids) & s1.test_ids()
    assert not bad, f"test ids refused: {bad}"
w = s1.Worker(port=int(os.environ.get("V2_PORT", 8769)))
try:
    for pid in ids:
        if (OUT / f"{pid}.npz").exists():
            continue
        ph = s1.Photo(pid)
        ss = s1.Session(w, ph)
        for att in range(3):
            try:
                ed = ss.edges(); break
            except RuntimeError as ex:
                print(pid, "retry", ex, flush=True)
        else:
            print(pid, "FAILED", flush=True); continue
        np.savez_compressed(OUT / f"{pid}.npz", fine=ed["fine"], coarse=ed["coarse"], fg=ed["fg"], rgb=ed["rgb"], dirs=ed["dirs"],
                            meta=json.dumps({**ed["meta"], "vfov0": ph.vfov0, "focalKnown": ph.focal_known, "aspect": ph.aspect,
                                             "lat": ph.e["lat"], "lon": ph.e["lon"], "positionSource": ph.e["positionSource"]}))
        print(pid, ed["w"], ed["h"], ed["meta"]["eye"], flush=True)
        ph.cleanup()
finally:
    w.close()
