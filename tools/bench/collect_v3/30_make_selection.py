"""v3 step 3: screen_notes.txt (hand screening of work/sheets/*.jpg) -> selection.json.

Greedy stratified pick: 60 Swiss + up to 15 non-Swiss. At each step take the accepted candidate whose strata are
furthest below target (focal class, season, skyline distance, weather, hard, heading known, position source,
region), subject to caps: <= 2 per author, <= 1 per ~2 km cell, <= 1 per (author, day), <= 8 per Swiss region,
<= 2 per non-Swiss region. Deterministic (ties -> lower index).
Extra disjointness guard vs the v1 set (on top of 10_pool's same-author/3 km/same-day rule): drop any candidate
within 150 m of a v1 camera position, or by a v1 author within 2 km of that author's v1 photo (any date).

screen_notes.txt line: idx season weather(clear|cloudy|cos) skyline(near|far) foreground(comma list|none) hard(0/1) notes
"""
import json
import math
import os
import re
from collections import Counter

from common import HERE, OLD_DATA, in_ch, load

N_CH, N_WORLD = 60, 15
TARGET = {  # proportions (v1 balance)
    "fc": {"tele": 0.32, "normal": 0.30, "wide": 0.20, "unknown": 0.18},
    "season": {"summer": 0.62, "winter": 0.38},
    "skyline": {"near": 0.55, "far": 0.45},
    "weather": {"clear": 0.56, "clouds_on_skyline": 0.22, "cloudy": 0.22},
    "hard": {True: 0.42, False: 0.58},
    "head": {True: 0.55, False: 0.45},
    "pos": {"exif-gps": 0.45, "manual": 0.55},
}


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def pos_source(c):
    glat, glon = num(c.get("gpsLat")), num(c.get("gpsLon"))
    if glat is None or glon is None or (glat == 0 and glon == 0):
        return "manual"
    d = math.hypot((glat - c["lat"]) * 111320, (glon - c["lon"]) * 111320 * math.cos(math.radians(c["lat"])))
    return "exif-gps" if d <= 100 else "manual"


def day(c):
    m = re.search(r"(\d{4})[:-](\d{2})[:-](\d{2})", c.get("dateExif") or c.get("dateDesc") or "")
    return m.group(0) if m else None


def norm_author(a):
    return re.sub(r"[^a-z0-9]", "", (a or "").lower())[:24]


def v1_conflict(c, v1):
    for u in v1:
        d = math.hypot((u["lat"] - c["lat"]) * 111320, (u["lon"] - c["lon"]) * 111320 * math.cos(math.radians(c["lat"])))
        if d < 150:
            return f"{u['id']} same spot {d:.0f} m"
        if d < 2000 and norm_author(u["author"]) == norm_author(c.get("artistFull") or c["artist"]):
            return f"{u['id']} same author {d:.0f} m"
    return None


def rows():
    cands = load("candidates.json")
    v1 = json.load(open(os.path.join(OLD_DATA, "manifest.json")))
    out = []
    for line in open(os.path.join(HERE, "screen_notes.txt")):
        if not line[:1].isdigit():
            continue
        idx, season, weather, sky, fg, hard, notes = line.rstrip("\n").split(None, 6)
        c = cands[int(idx)]
        why = v1_conflict(c, v1)
        if why:
            print(f"  drop {idx} ({why})")
            continue
        f35 = c.get("focal35mm")
        fc = "unknown" if not f35 else "tele" if f35 >= 70 else "wide" if f35 <= 28 else "normal"
        out.append({"idx": int(idx), "title": c["title"], "season": season,
                    "weather": {"cos": "clouds_on_skyline"}.get(weather, weather), "skyline": sky,
                    "foreground": [] if fg == "none" else fg.split(","), "hard": hard == "1", "notes": notes,
                    "_fc": fc, "_head": c.get("headingDeg") is not None or c.get("gpsDir") is not None,
                    "_pos": pos_source(c), "_region": c["region"], "_artist": c["artist"],
                    "_swiss": in_ch(c["lat"], c["lon"]), "_cell": (round(c["lat"] / 0.02), round(c["lon"] / 0.03)),
                    "_day": day(c)})
    return out


def attrs(r):
    return {"fc": r["_fc"], "season": r["season"], "skyline": r["skyline"], "weather": r["weather"],
            "hard": r["hard"], "head": r["_head"], "pos": r["_pos"]}


def greedy(pool, n, region_cap, taken):
    sel, cnt = [], {k: Counter() for k in TARGET}
    reg = Counter()
    while len(sel) < n:
        best, best_s = None, None
        for r in pool:
            if r in sel:
                continue
            if taken["artist"][r["_artist"]] >= 2 or r["_cell"] in taken["cell"] or \
                    (r["_artist"], r["_day"]) in taken["artday"] or reg[r["_region"]] >= region_cap:
                continue
            k = len(sel) + 1
            s = sum(TARGET[a][v] * k - cnt[a][v] for a, v in attrs(r).items())
            s += 0.5 * (region_cap - reg[r["_region"]]) / region_cap  # spread regions
            if best_s is None or s > best_s + 1e-9:
                best, best_s = r, s
        if best is None:
            break
        sel.append(best)
        for a, v in attrs(best).items():
            cnt[a][v] += 1
        reg[best["_region"]] += 1
        taken["artist"][best["_artist"]] += 1
        taken["cell"].add(best["_cell"])
        taken["artday"].add((best["_artist"], best["_day"]))
    return sel


def main():
    rs = rows()
    taken = {"artist": Counter(), "cell": set(), "artday": set()}
    ch = greedy([r for r in rs if r["_swiss"]], N_CH, 8, taken)
    world = greedy([r for r in rs if not r["_swiss"]], N_WORLD, 2, taken)
    for name, sel in (("CH", ch), ("world", world)):
        print(f"== {name}: {len(sel)} of {sum(1 for r in rs if r['_swiss'] == (name == 'CH'))} accepted")
        for k in ("_fc", "season", "skyline", "weather", "hard", "_head", "_pos", "_region"):
            print(" ", k, dict(Counter(r[k] for r in sel)))
    sel = ch + world  # Swiss first, then non-Swiss (ids w3_0001.. follow this order)
    json.dump([{k: v for k, v in r.items() if not k.startswith("_")} for r in sel],
              open(os.path.join(HERE, "selection.json"), "w"), indent=1, ensure_ascii=False)
    print(len(sel), "selected")


if __name__ == "__main__":
    main()
