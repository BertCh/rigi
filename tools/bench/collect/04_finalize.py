"""Step 4: download the hand-screened selection at 2048 px long edge and write the manifest + attribution.

Input : work/candidates.json, collect/selection.json (hand-made screening result, see below)
Output: data/photos/<id>.jpg, data/manifest.json, data/ATTRIBUTION.md

selection.json: list of {"idx": <candidate index>, "season": "winter"|"summer", "weather": "clear"|"cloudy"|
"clouds_on_skyline", "skyline": "near"|"far"|"mixed", "foreground": [..], "hard": bool, "notes": str}
Run with tools/matcher/.venv/bin/python (needs PIL).
"""
import io
import json
import os
import re

from PIL import Image, ImageOps

from common import DATA, HERE, check_disk, http_get, load

LONG = 2048


def thumb_url(url, width):
    parts = url.split("/wikipedia/commons/")
    name = parts[1].split("/")[-1]
    return f"{parts[0]}/wikipedia/commons/thumb/{parts[1]}/{width}px-{name}"


def fetch_resized(c):
    w, h = c["w"], c["h"]
    if max(w, h) <= LONG:
        data = http_get(c["url"])
    else:
        # thumb width that gives a 2048 long edge
        tw = LONG if w >= h else round(LONG * w / h)
        try:
            data = http_get(thumb_url(c["url"], tw))
        except Exception:
            data = http_get(c["url"])  # original, resized in memory, never stored
    im = Image.open(io.BytesIO(data))
    im = ImageOps.exif_transpose(im).convert("RGB")
    if max(im.size) > LONG:
        s = LONG / max(im.size)
        im = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
    return im


def exif_date(s):
    if not s:
        return None
    m = re.match(r"(\d{4}):(\d{2}):(\d{2})[ T](\d{2}:\d{2}:\d{2})", s)
    return f"{m[1]}-{m[2]}-{m[3]}T{m[4]}" if m else s


def position_info(lat, lon, c):
    """(positionSource, positionNote|None): is the Commons location backed by EXIF GPS (within 100 m)?"""
    import math

    def num(v):
        try:
            return float(v)
        except (TypeError, ValueError):
            return None
    glat, glon = num(c.get("gpsLat")), num(c.get("gpsLon"))
    note = []
    if glat is not None and glon is not None and not (glat == 0 and glon == 0):
        d = math.hypot((glat - lat) * 111320, (glon - lon) * 111320 * math.cos(math.radians(lat)))
        if d <= 100:
            src = "exif-gps"
        else:
            src = "manual"
            note.append(f"EXIF GPS present but differs from template by {d:.0f} m; template position used "
                        "(likely corrected or moved by hand)")
    else:
        src = "manual"
    t = c["title"].lower()
    if "panoramio" in t:
        note.append("panoramio import (position placed on Panoramio map)")
    if "flickr" in (c.get("desc") or "").lower() or "unsplash" in t:
        note.append("reuse import (Flickr/Unsplash), position likely added later by hand")
    if src == "manual" and not note and glat is None:
        note.append("no EXIF GPS; coordinate set by uploader")
    return src, ("; ".join(note) or None)


def focal_class(f35):
    if not f35:
        return "unknown"
    return "tele" if f35 >= 70 else ("wide" if f35 <= 28 else "normal")


def lic_url(c):
    if c.get("licUrl"):
        return c["licUrl"]
    l = (c.get("lic") or "").lower()
    if l.startswith("public domain") or l.startswith("pd"):
        return "https://creativecommons.org/publicdomain/mark/1.0/"
    if l.startswith("cc0"):
        return "https://creativecommons.org/publicdomain/zero/1.0/"
    return None


def nearest_region(lat, lon):
    import importlib
    pts = importlib.import_module("01_discover").POINTS
    return min(pts, key=lambda p: (p[2] - lat) ** 2 + ((p[3] - lon) * 0.69) ** 2)[0]


def main():
    cands = load("candidates.json")
    meta_a = load("meta_a.json")
    sel = json.load(open(os.path.join(HERE, "selection.json")))
    pdir = os.path.join(DATA, "photos"); os.makedirs(pdir, exist_ok=True)
    manifest = []
    for n, s in enumerate(sel, 1):
        c = dict(cands[s["idx"]])
        assert c["title"] == s.get("title", c["title"]), f"candidates.json changed: {s}"
        c.update({k: v for k, v in meta_a[c["title"]].items() if k in ("lic", "licUrl", "w", "h")})
        pid = f"wc_{n:04d}"
        fn = f"photos/{pid}.jpg"
        path = os.path.join(DATA, fn)
        if not os.path.exists(path):
            if n % 10 == 1:
                check_disk()
            im = fetch_resized(c)
            im.save(path, quality=88, optimize=True)
        im = Image.open(path)
        heading = c.get("headingDeg")
        if heading is None and c.get("gpsDir") is not None:
            heading = c["gpsDir"] % 360
        alt = c.get("gpsAlt")
        if alt is not None and str(c.get("gpsAltRef")) == "1":
            alt = -alt
        f35 = c.get("focal35mm") or None
        e = {
            "id": pid, "file": fn, "source": "commons", "title": c["title"],
            "pageUrl": c.get("pageUrl"), "author": c.get("artistFull") or c.get("artist"),
            "license": c["lic"], "licenseUrl": lic_url(c),
            "lat": round(c["lat"], 6), "lon": round(c["lon"], 6), "coordType": c["coordType"],
        }
        if alt is not None and 190 < alt < 4700:  # CH elevation range; 0 / junk dropped
            e["altitudeM"] = round(alt, 1)
        if heading is not None:
            e["headingDeg"] = round(heading, 1)
            e["headingSource"] = "template" if c.get("headingDeg") is not None else "exif"
            if e["headingSource"] == "template":
                e["headingRaw"] = c.get("headingRaw")  # compass letters (e.g. "SW") = 22.5 deg quantised
        if c.get("focalMm"):
            e["focalMm"] = round(c["focalMm"], 2)
        if f35:
            e["focal35mm"] = f35
        cam = " ".join(x for x in (c.get("make"), c.get("model")) if x)
        if cam:
            e["camera"] = cam.strip()
        e["positionSource"], pnote = position_info(e["lat"], e["lon"], c)
        if pnote:
            e["positionNote"] = pnote
        e["width"], e["height"] = im.width, im.height
        d = exif_date(c.get("dateExif")) or (c.get("dateDesc") or None)
        if d:
            e["dateTaken"] = d
        e["tags"] = {
            "focalClass": focal_class(f35),
            "skylineDist": s.get("skyline", "unknown"),
            "season": s["season"], "weather": s["weather"],
            "headingKnown": heading is not None, "focalKnown": bool(f35 or c.get("focalMm")),
            "focal35Known": bool(f35),
            "foreground": sorted({"people" if f == "person" else f for f in s.get("foreground", [])}), "hard": bool(s.get("hard")),
            "region": nearest_region(c["lat"], c["lon"]), "notes": s.get("notes", ""),
        }
        manifest.append(e)
        print(pid, c["title"])
    with open(os.path.join(DATA, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
    lines = ["# Attribution", "",
             "Photos from Wikimedia Commons, resized to 2048 px on the long edge (JPEG q88). "
             "No other modifications. Each photo remains under its original licence; see the linked file page.", "",
             "| id | title | author | licence |", "|---|---|---|---|"]
    for e in manifest:
        t = e["title"].replace("|", "\\|")
        a = (e["author"] or "unknown").replace("|", "\\|").replace("\n", " ")
        lic = f"[{e['license']}]({e['licenseUrl']})" if e.get("licenseUrl") else e["license"]
        lines.append(f"| {e['id']} | [{t}]({e['pageUrl']}) | {a} | {lic} |")
    with open(os.path.join(DATA, "ATTRIBUTION.md"), "w") as f:
        f.write("\n".join(lines) + "\n")
    print(len(manifest), "photos")


if __name__ == "__main__":
    main()
