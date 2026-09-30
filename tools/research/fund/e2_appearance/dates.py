"""Step 0: capture timestamps for the dev photos, trust flags, photo-time sun. -> dates.json

Source: tools/bench/data/manifest.json `dateTaken` (Commons EXIF DateTimeOriginal, harvested at collection time; the cached
photo.jpg and the bench JPEGs carry no EXIF, and no OffsetTimeOriginal was kept). Interpreted as Europe/Zurich civil time
(all dev photos are in CH or at the CH/IT border, same zone). Trust rule (fixed before scoring):
  date_ok  : a dateTaken exists, parses, is not in the future, year >= 2000
  time_ok  : date_ok and the sun is >= 2 deg above the horizon at the stated time (a clock that puts the photo at night
             is wrong); time-of-day is otherwise UNVERIFIABLE (camera clocks, DST) -> reported as a caveat
Variants (ii)-(iv) need time_ok; (iii) snow needs only date_ok.
"""
import json
from datetime import datetime
from common import dev_manifest, eval_ids, local_to_utc, sun_position, OUT

man = dev_manifest()
ev = set(eval_ids())
out = {}
for pid, x in sorted(man.items()):
    r = {"dateTaken": x.get("dateTaken"), "camera": x.get("camera"), "season": x["tags"].get("season"),
         "weather": x["tags"].get("weather"), "lat": x["lat"], "lon": x["lon"], "eval": pid in ev}
    try:
        t = datetime.fromisoformat(x["dateTaken"])
        r["date_ok"] = 2000 <= t.year and t <= datetime(2026, 9, 29)
    except Exception:  # noqa: BLE001
        r["date_ok"] = False
    if r["date_ok"]:
        tu = local_to_utc(x["dateTaken"])
        r["utc"] = tu.isoformat()
        s = sun_position(tu, x["lat"], x["lon"])
        r["sun"] = {"az": round(s["az"], 2), "el": round(s["el"], 2)}
        r["time_ok"] = s["el"] >= 2
    else:
        r["time_ok"] = False
    out[pid] = r
json.dump(out, open(OUT / "dates.json", "w"), indent=1)
e = [r for r in out.values() if r["eval"]]
print("dev", len(out), "date_ok", sum(r["date_ok"] for r in out.values()), "time_ok", sum(r["time_ok"] for r in out.values()))
print("eval", len(e), "date_ok", sum(r["date_ok"] for r in e), "time_ok", sum(r["time_ok"] for r in e))
for p, r in out.items():
    if r["eval"]:
        print(p, r["dateTaken"], r.get("sun"), r["time_ok"], r["season"], r["weather"])
