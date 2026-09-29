"""v3 step 0 (runs before 10_pool): extra metadata so the v3 pool is not starved in regions that v1's
top-2500 heavy pass barely reached, plus a small non-Swiss discovery.

  python3 05_extra_meta.py ch      -> work/meta_b_extra.json (heavy meta for top un-fetched CH titles in
                                      under-represented regions; v1 work/ is read-only)
  python3 05_extra_meta.py world   -> work/world_titles.json, work/world_meta_a.json, work/meta_b_extra.json
"""
import importlib.util
import json
import os
import sys
from collections import Counter

from common import HERE, OLD_WORK, api, load, save

spec = importlib.util.spec_from_file_location("meta_v1", os.path.join(HERE, "..", "collect", "02_meta.py"))
meta_v1 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(meta_v1)

WORLD = [  # (region, name, lat, lon)
    ("w-fr-alps", "Chamonix", 45.924, 6.870), ("w-fr-alps", "Lac Blanc", 45.980, 6.890),
    ("w-fr-alps", "Ecrins La Grave", 45.045, 6.305),
    ("w-it-alps", "Tre Cime", 46.618, 12.302), ("w-it-alps", "Seceda", 46.600, 11.725),
    ("w-it-alps", "Cervinia", 45.935, 7.630),
    ("w-at-alps", "Grossglockner", 47.075, 12.750), ("w-at-alps", "Zugspitze", 47.421, 10.985),
    ("w-si-alps", "Triglav", 46.380, 13.840),
    ("w-tatra", "Tatra Lomnica", 49.195, 20.215), ("w-tatra", "Kasprowy", 49.232, 19.982),
    ("w-pyrenees", "Ordesa", 42.650, -0.050), ("w-pyrenees", "Aiguestortes", 42.570, 0.950),
    ("w-canaries", "Teide", 28.272, -16.640),
    ("w-na", "Yosemite", 37.730, -119.573), ("w-na", "Rocky Mtn NP", 40.400, -105.750),
    ("w-na", "Glacier NP", 48.697, -113.718), ("w-na", "Moraine Lake", 51.322, -116.185),
]


def geosearch(lat, lon, radius=10000):
    r = api({"action": "query", "list": "geosearch", "gscoord": f"{lat}|{lon}", "gsradius": radius,
             "gslimit": 500, "gsnamespace": 6, "gsprimary": "all"})
    return [g["title"] for g in r.get("query", {}).get("geosearch", [])]


def fetch_a(titles, meta):
    todo = [t for t in titles if t not in meta]
    for batch in meta_v1.chunks(todo):
        r = api({"action": "query", "titles": "|".join(batch),
                 "prop": "imageinfo|coordinates", "iiprop": "size|mime|extmetadata",
                 "iiextmetadatafilter": "LicenseShortName|LicenseUrl|Categories|Artist",
                 "coprimary": "all", "coprop": "type|name|dim|globe", "colimit": "max"})
        for p in r["query"]["pages"]:
            ii = (p.get("imageinfo") or [{}])[0]
            em = ii.get("extmetadata", {})
            meta[p["title"]] = {
                "pageid": p.get("pageid"), "w": ii.get("width"), "h": ii.get("height"), "mime": ii.get("mime"),
                "lic": em.get("LicenseShortName", {}).get("value"), "licUrl": em.get("LicenseUrl", {}).get("value"),
                "cats": em.get("Categories", {}).get("value", ""),
                "artist": meta_v1.strip_html(em.get("Artist", {}).get("value", ""))[:200],
                "coords": p.get("coordinates", []),
            }
        for t in batch:
            meta.setdefault(t, {"missing": True})
    return meta


def fetch_b(titles, metab):
    import re
    todo = [t for t in titles if t not in metab]
    print(f"heavy meta: {len(todo)} to fetch")
    for batch in meta_v1.chunks(todo):
        r = api({"action": "query", "titles": "|".join(batch),
                 "prop": "imageinfo|revisions", "iiprop": "url|metadata|extmetadata",
                 "iiextmetadatafilter": "DateTimeOriginal|ImageDescription|Artist|LicenseShortName|LicenseUrl",
                 "rvprop": "content", "rvslots": "main"})
        for p in r["query"]["pages"]:
            ii = (p.get("imageinfo") or [{}])[0]
            md = {x["name"]: x["value"] for x in (ii.get("metadata") or []) if not isinstance(x["value"], list)}
            em = ii.get("extmetadata", {})
            wt = p["revisions"][0]["slots"]["main"].get("content", "") if p.get("revisions") else ""
            h, tpl = meta_v1.parse_heading(wt)
            frac = meta_v1.frac
            metab[p["title"]] = {
                "url": ii.get("url", "").split("?")[0], "pageUrl": ii.get("descriptionurl"),
                "focalMm": frac(md.get("FocalLength")), "focal35mm": frac(md.get("FocalLengthIn35mmFilm")),
                "make": md.get("Make"), "model": md.get("Model"), "software": md.get("Software"),
                "dateExif": md.get("DateTimeOriginal"),
                "gpsAlt": frac(md.get("GPSAltitude")), "gpsAltRef": md.get("GPSAltitudeRef"),
                "gpsDir": frac(md.get("GPSImgDirection")),
                "gpsLat": md.get("GPSLatitude"), "gpsLon": md.get("GPSLongitude"),
                "dateDesc": meta_v1.strip_html(em.get("DateTimeOriginal", {}).get("value", ""))[:80],
                "desc": meta_v1.strip_html(em.get("ImageDescription", {}).get("value", ""))[:300],
                "artistFull": meta_v1.strip_html(em.get("Artist", {}).get("value", ""))[:200],
                "headingRaw": h, "headingDeg": meta_v1.heading_deg(h), "locTpl": tpl,
                "panoTpl": bool(re.search(r"\{\{\s*(panorama|pano360|stitched|photomontage|retouched)", wt, re.I)),
            }
        save("meta_b_extra.json", metab)
    return metab


def ch():
    with open(os.path.join(OLD_WORK, "meta_a.json")) as f:
        meta_a = json.load(f)
    with open(os.path.join(OLD_WORK, "meta_b.json")) as f:
        meta_b = json.load(f)
    with open(os.path.join(OLD_WORK, "titles.json")) as f:
        titles = json.load(f)
    want = {"appenzell": 150, "jura": 150, "glarus": 120, "vaud": 120, "central": 100, "ticino": 100}
    scored = []
    for t, m in meta_a.items():
        if t in meta_b:
            continue
        s, _ = meta_v1.score_a(t, m)
        if s is None:
            continue
        scored.append((s, t, titles.get(t, {}).get("region", "?")))
    scored.sort(reverse=True)
    n, pick = Counter(), []
    for s, t, r in scored:
        if r in want and n[r] < want[r] and s >= 3:  # camera coord (+3) and at least one positive keyword
            n[r] += 1; pick.append(t)
    print("CH extra:", dict(n))
    fetch_b(pick, load("meta_b_extra.json", {}))


def world():
    wt = load("world_titles.json", {})
    for region, name, lat, lon in WORLD:
        if any(("geo:" + name) in v["src"] for v in wt.values()):
            continue
        ts = geosearch(lat, lon)
        for t in ts:
            if t.lower().endswith((".jpg", ".jpeg")):
                e = wt.setdefault(t, {"src": [], "region": region})
                e["src"].append("geo:" + name)
        print(name, len(ts))
        save("world_titles.json", wt)
    ma = fetch_a(list(wt), load("world_meta_a.json", {}))
    save("world_meta_a.json", ma)
    meta_v1.in_ch = lambda lat, lon: True  # score_a without the CH border test
    per, pick = Counter(), []
    scored = sorted(((meta_v1.score_a(t, m)[0] or -99, t) for t, m in ma.items()), reverse=True)
    for s, t in scored:
        r = wt[t]["region"]
        if s >= 3 and per[r] < 60:  # camera-coord only
            per[r] += 1; pick.append(t)
    print("world heavy:", dict(per))
    fetch_b(pick, load("meta_b_extra.json", {}))


if __name__ == "__main__":
    {"ch": ch, "world": world}[sys.argv[1]]()
