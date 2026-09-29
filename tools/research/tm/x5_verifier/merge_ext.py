"""X5 (end, clearly labelled EXTERNAL): merge X2's per-ref mono-geometry score into X5 rows.

  ext_x2_combo_int_z = X2 moge_l combo_int (terrain-internal rank_t + ord_local + edge_int, each z-scored vs the pose's
                       own 68-yaw null) via x2_geom/analyze.get. X2's own veto: < 0.37 (tau from odd-id correct refs).
Refs only (X2 has no perturb/N7 score in the same form -> None). Output features_ext.json.
X4's strip agreement is a per-photo abstain signal about X4's own top hypothesis (not per pose), so it is only
quoted in the trap table of REPORT.txt, not merged.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
TM = HERE.parent
sys.path.insert(0, str(TM / "x2_geom"))
import analyze as X2  # noqa: E402

rows = json.load(open(HERE / "features.json"))
n = 0
cache = {}
for r in rows:
    r["ext_x2_combo_int_z"] = None
    if r["group"] != "refs":
        continue
    f = TM / "x2_geom/results" / f"{r['pid']}.json"
    if not f.exists():
        continue
    d = cache.setdefault(r["pid"], json.load(open(f)))
    for x in d["refs"]:
        if x["label"] == r["tag"]:
            v = X2.get(x, "moge_l", "combo_int", True)
            r["ext_x2_combo_int_z"] = v
            n += v is not None
json.dump(rows, open(HERE / "features_ext.json", "w"), indent=0)
print("merged X2 scores for", n, "refs")
