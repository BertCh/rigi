# Rigi
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: Copyright (c) Rigi contributors
"""FUND E5 diagnostic (not gating): tools/matcher/dem.py's horizon at the study eyes, azimuth step 0.1.

    MATCHER_DEM_CACHE=<scratch dir> tools/matcher/.venv/bin/python tools/research/fund/e5_raycast/dempy_horizon.py \
        out/e5/eyes.json out/e5 [id,id,...]

dem.py has its own tile cache (webp, fetched from Mapterhorn when missing), its own bands (3 / 15 / 100 km at
z14 / z12 / z10), its own sampling and a 100 km cap: a different input from the mosaics, so this is reported
against the 100 km runs of the other marchers, not as a pass/fail input.
"""
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "tools" / "matcher"))
import dem as DM  # noqa: E402

eyes = json.load(open(sys.argv[1]))
out = Path(sys.argv[2])
only = set(sys.argv[3].split(",")) if len(sys.argv) > 3 and sys.argv[3] else None
# dem.py's own first sample is 5 m; the marchers' is 20 m. DMIN=20 aligns that one input (the file prefix says which).
DMIN = float(os.environ.get("DMIN", "5"))
PREFIX = "dempy" if DMIN == 20 else f"dempy{int(DMIN)}"
for e in eyes:
    if only and e["id"] not in only:
        continue
    f = out / f"{PREFIX}-{e['id']}.json"
    if f.exists():
        continue
    t0 = time.time()
    d = DM.Dem(e["lat"], e["lon"], extent_m=0.0)
    t1 = time.time()
    hz = d.horizon((0.0, 0.0, e["h"]), 0.0, 359.9, 0.1, dmin=DMIN)
    json.dump({"id": e["id"], "el": [float(x) for x in hz["el"]], "loadS": t1 - t0, "marchS": time.time() - t1}, open(f, "w"))
    print(e["id"], round(t1 - t0, 1), "s load", round(time.time() - t1, 1), "s march", flush=True)
