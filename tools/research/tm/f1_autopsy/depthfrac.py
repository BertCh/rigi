"""DEM depth composition of the frame at each photo's verified-correct ref pose (cache refs/<label>/xyz.npz).
Note: DEM only - trees/buildings/people in the photo are not in it; this is the *best case* terrain fraction."""
import json, sys
from pathlib import Path
import numpy as np
H = Path(__file__).parent; CACHE = H.parent/"cache"
M = json.load(open(H/"master.json"))
out = {}
for pid, r in M.items():
    if not (CACHE/pid/"DONE").exists() or not r["correctRefs"]: continue
    lab = r["correctRefs"][0]["label"]; d = CACHE/pid/"refs"/lab
    if not (d/"xyz.npz").exists(): continue
    z = np.load(d/"xyz.npz"); xyz = z["xyz"]; eye = np.array(json.load(open(d/"view.json"))["eye"])
    sky = ~(xyz != 0).any(2); dist = np.linalg.norm(xyz - eye, axis=2)
    n = sky.size
    f = dict(sky=float(sky.mean()), lt300=float(((dist < 300) & ~sky).sum()/n), m300_1k=float(((dist >= 300) & (dist < 1000) & ~sky).sum()/n),
             k1_5=float(((dist >= 1000) & (dist < 5000) & ~sky).sum()/n), gt5k=float(((dist >= 5000) & ~sky).sum()/n),
             medKm=float(np.median(dist[~sky])/1000) if (~sky).any() else None)
    out[pid] = {k: (round(v, 3) if isinstance(v, float) else v) for k, v in f.items()}
    good = r["t6"]["level"] == "HIGH" and r["t6"]["verdict"] == "correct"
    print(pid, "OK " if good else "BAD", out[pid])
json.dump(out, open(H/"depthfrac.json", "w"), indent=1)
