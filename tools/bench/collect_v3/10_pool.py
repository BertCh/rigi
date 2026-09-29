"""v3 step 1 (Swiss pool): re-rank the v1 metadata (read-only, ../collect/work) EXCLUDING every photo in the
v1 benchmark (tools/bench/data/manifest.json) and its near-duplicates (same author + within 3 km + same day).

Output: work/pool_ch.json (ranked, region round-robin; no truncation to 640 as in v1)
Usage: python3 10_pool.py
"""
import importlib.util
import json
import math
import os
import re
from collections import Counter, defaultdict

from common import HERE, OLD_DATA, OLD_WORK, in_ch, load, save

spec = importlib.util.spec_from_file_location("meta_v1", os.path.join(HERE, "..", "collect", "02_meta.py"))
meta_v1 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(meta_v1)  # pure helpers only (score_a, pick_coord)


def old(name):
    with open(os.path.join(OLD_WORK, name)) as f:
        return json.load(f)


def day(s):
    m = re.search(r"(\d{4})[:-](\d{2})[:-](\d{2})", s or "")
    return f"{m[1]}-{m[2]}-{m[3]}" if m else None


def norm_author(a):
    return re.sub(r"[^a-z0-9]", "", (a or "").lower())[:24]


def dist_m(a, b, c, d):
    return math.hypot((a - c) * 111320, (b - d) * 111320 * math.cos(math.radians(a)))


def used_v1():
    with open(os.path.join(OLD_DATA, "manifest.json")) as f:
        m = json.load(f)
    return m


def is_near_dup(c, used):
    a, d = norm_author(c.get("artistFull") or c.get("artist")), day(c.get("dateExif") or c.get("dateDesc"))
    for u in used:
        if norm_author(u["author"]) != a:
            continue
        if dist_m(c["lat"], c["lon"], u["lat"], u["lon"]) > 3000:
            continue
        ud = day(u.get("dateTaken"))
        if d is None or ud is None or d == ud:  # unknown date + same author + same place -> treat as dup
            return u["id"]
    return None


def main():
    meta_a, meta_b, titles = old("meta_a.json"), old("meta_b.json"), old("titles.json")
    meta_b = {**load("meta_b_extra.json", {}), **meta_b}
    used = used_v1()
    used_titles = {u["title"] for u in used}
    reasons = Counter()
    out = []
    for t, m in meta_a.items():
        s, why = meta_v1.score_a(t, m)
        reasons[why] += 1
        if s is None:
            continue
        b = meta_b.get(t)
        if not b:
            reasons["no_meta_b"] += 1
            continue
        if b["panoTpl"]:
            reasons["pano"] += 1
            continue
        sw = (b.get("software") or "").lower()
        if any(k in sw for k in ("hugin", "ptgui", "autopano", "microsoft ice", "image composite")):
            reasons["stitch_sw"] += 1
            continue
        c, ctype = meta_v1.pick_coord(m["coords"])
        e = {"title": t, "score": s, "lat": c["lat"], "lon": c["lon"], "coordType": ctype,
             "region": titles.get(t, {}).get("region", "?"), "artist": m["artist"], **b}
        if t in used_titles:
            reasons["v1_used"] += 1
            continue
        dup = is_near_dup(e, used)
        if dup:
            reasons["v1_neardup"] += 1
            continue
        if b["headingDeg"] is not None or b["gpsDir"] is not None:
            e["score"] += 3
        if b["focal35mm"] or b["focalMm"]:
            e["score"] += 2
        if b["focal35mm"] and b["focal35mm"] >= 70:
            e["score"] += 1.5
        out.append(e)
    out.sort(key=lambda x: -x["score"])
    # diversity: max 2 per ~2 km cell, max 5 per artist; also max 1 per (artist, day) to avoid intra-set dups
    cell, art, artday = Counter(), Counter(), Counter()
    byreg = defaultdict(list)
    for c in out:
        k = (round(c["lat"] / 0.02), round(c["lon"] / 0.03))
        ad = (norm_author(c["artist"]), day(c.get("dateExif") or c.get("dateDesc")) or c["title"])
        if cell[k] >= 2 or art[c["artist"]] >= 5 or artday[ad] >= 1:
            continue
        cell[k] += 1; art[c["artist"]] += 1; artday[ad] += 1
        byreg[c["region"]].append(c)
    final, regs = [], sorted(byreg)
    while any(byreg.values()):
        for r in regs:
            if byreg[r]:
                final.append(byreg[r].pop(0))
    print(reasons)
    print({r: sum(1 for c in final if c["region"] == r) for r in regs})
    save("pool_ch.json", final)
    print(len(final), "CH pool candidates")
    world(used, used_titles)


def world(used, used_titles):
    """Non-Swiss pool from 05_extra_meta.py world; camera coords outside CH only, <= 12 per region."""
    wt, ma, mb = load("world_titles.json", {}), load("world_meta_a.json", {}), load("meta_b_extra.json", {})
    meta_v1.in_ch = lambda lat, lon: True
    out = []
    for t, m in ma.items():
        s, _ = meta_v1.score_a(t, m)
        b = mb.get(t)
        if s is None or not b or b["panoTpl"] or t in used_titles:
            continue
        c, ctype = meta_v1.pick_coord(m["coords"])
        if ctype != "camera" or in_ch(c["lat"], c["lon"]):
            continue
        sw = (b.get("software") or "").lower()
        if any(k in sw for k in ("hugin", "ptgui", "autopano", "microsoft ice", "image composite")):
            continue
        e = {"title": t, "score": s, "lat": c["lat"], "lon": c["lon"], "coordType": ctype,
             "region": wt[t]["region"], "artist": m["artist"], **b}
        if is_near_dup(e, used):
            continue
        e["score"] += (3 if (b["headingDeg"] is not None or b["gpsDir"] is not None) else 0) + \
            (2 if (b["focal35mm"] or b["focalMm"]) else 0)
        out.append(e)
    out.sort(key=lambda x: -x["score"])
    cell, art, per = Counter(), Counter(), Counter()
    final = []
    for c in out:
        k = (round(c["lat"] / 0.02), round(c["lon"] / 0.03))
        if cell[k] >= 2 or art[c["artist"]] >= 2 or per[c["region"]] >= 12:
            continue
        cell[k] += 1; art[c["artist"]] += 1; per[c["region"]] += 1
        final.append(c)
    print(dict(per))
    save("pool_world.json", final)
    print(len(final), "world pool candidates")


if __name__ == "__main__":
    main()
