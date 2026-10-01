"""X5: render the two wc_0086 verification candidates that the C0 cache lacks (moved eye), in C0 cache format.

  N7  v2 HIGH pose at the moved eye (25 m E, engine eye = dem+1.6) — verified WRONG (near-miss), tools/matcher/v2/verify
  T8  same pose at the stated eye (the cache frame)                 — also in key.json (no verdict used here)
Holds tm_common.render_lock(); private port 8791. Output extra/wc_0086/<tag>/{view.json,rgb.jpg,hill.png,xyz.npz}
(frame = ENU at that render's own lat/lon; eye in view.json).
"""
from __future__ import annotations

import json
import os
import tempfile
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
TM = HERE.parent
os.environ["STAGE1_PORT"] = "8791"
os.environ.setdefault("STAGE1_TMP", os.path.join(tempfile.gettempdir(), "rigi-x5-stage1-tmp"))
Path(os.environ["STAGE1_TMP"]).mkdir(parents=True, exist_ok=True)
sys.path.insert(0, str(TM))
sys.path.insert(0, str(TM / "c0_cache"))
import tm_common  # noqa: E402
import s1  # noqa: E402
import build as B  # noqa: E402

PID = "wc_0086"
key = json.load(open(tm_common.ROOT / "tools/matcher/v2/verify/key.json"))["candidates"]


def main():
    tm_common.assert_dev(PID)
    out = HERE / "extra" / PID
    out.mkdir(parents=True, exist_ok=True)
    e = s1.manifest()[PID]
    with tm_common.render_lock():
        w = s1.Worker(port=8791)
        b = B.Builder(w)
        try:
            for tag in ("N7", "T8"):
                c = key[tag]
                assert c["pid"] == PID
                ent = {**e, "lat": c["eye"]["lat"], "lon": c["eye"]["lon"]}
                ent["altitudeM"] = None if tag == "N7" else e.get("altitudeM")
                ph = s1.Photo(PID, entry=ent)
                pose = {"tag": tag, **{k: float(c["pose"][k]) for k in ("yaw", "pitch", "roll", "vfov")}}
                recs = b.render_set(ph, [pose], out, "extra", None, {tag: {"candEye": c["eye"], "kind0": c["kind"]}})
                print(tag, "eye", recs[0]["eye"], "cand h", c["eye"]["h"], "selfTest", recs[0].get("selfTest"), flush=True)
                ph.cleanup()
        finally:
            w.close()


if __name__ == "__main__":
    main()
