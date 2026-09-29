"""Turn hand screening notes (screen_notes.txt, made by viewing work/sheets/*.jpg) into selection.json,
choosing a balanced subset of <= MAX photos.

screen_notes.txt line: idx season weather(clear|cloudy|cos) skyline(near|far) foreground(comma list|none) hard(0/1) notes
"""
import json
from collections import Counter

from common import load

MAX = 100
cands = load("candidates.json")
rows = []
for line in open("screen_notes.txt"):
    if not line[:1].isdigit():
        continue
    idx, season, weather, sky, fg, hard, notes = line.rstrip("\n").split(None, 6)
    c = cands[int(idx)]
    f35 = c.get("focal35mm")
    fc = "unknown" if not f35 else "tele" if f35 >= 70 else "wide" if f35 <= 28 else "normal"
    head = c.get("headingDeg") is not None or c.get("gpsDir") is not None
    rows.append({"idx": int(idx), "title": c["title"], "season": season,
                 "weather": {"cos": "clouds_on_skyline"}.get(weather, weather), "skyline": sky,
                 "foreground": [] if fg == "none" else fg.split(","), "hard": hard == "1", "notes": notes,
                 "_fc": fc, "_head": head, "_region": c["region"], "_artist": c["artist"]})

# priority: rare strata first (normal focal, unknown focal, no heading, winter, far, jura), then the rest
def prio(r):
    p = 0
    p += 1.0 if not r["_head"] else 0.8
    p += 1.0 if r["season"] == "winter" else 0
    p += 0.7 if r["skyline"] == "far" else 0
    p += 0.8 if r["hard"] else 0
    p += 2 if r["_region"] == "jura" else 0
    return -p

rows.sort(key=prio)
QUOTA = {"tele": 32, "normal": 30, "wide": 20, "unknown": 18}  # sums to MAX
sel, art, reg, fcq = [], Counter(), Counter(), Counter()
for r in rows:
    if art[r["_artist"]] >= 3 or reg[r["_region"]] >= 15 or fcq[r["_fc"]] >= QUOTA[r["_fc"]]:
        continue
    sel.append(r); art[r["_artist"]] += 1; reg[r["_region"]] += 1; fcq[r["_fc"]] += 1
sel.sort(key=lambda r: r["idx"])
for k in ("_fc", "_head", "_region", "_artist"):
    print(k, Counter(r[k] for r in sel))
for k in ("season", "weather", "skyline", "hard"):
    print(k, Counter(r[k] for r in sel))
json.dump([{k: v for k, v in r.items() if not k.startswith("_")} for r in sel],
          open("selection.json", "w"), indent=1, ensure_ascii=False)
print(len(sel), "selected of", len(rows))
