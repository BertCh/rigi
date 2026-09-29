"""Step 2: metadata passes.

Pass A (cheap, all titles): size/mime/licence/categories/coordinates -> work/meta_a.json
Pass B (heavy, top-scored survivors): EXIF metadata + wikitext (heading) -> work/meta_b.json
Then writes work/candidates.json ranked for visual screening.

Usage: python 02_meta.py a | b | rank
"""
import html
import re
import sys
from collections import Counter, defaultdict

from common import api, in_ch, load, save

OK_LIC = re.compile(r"^(cc0|public domain|pd\b|pd-|cc[- ]by(-sa)?[- ]\d|cc by(-sa)? \d|cc-by|cc by-sa|cc by \d)", re.I)

NEG = re.compile(
    r"interior|innen|inside|innenraum|church|kirche|chapel|kapelle|eglise|église|chiesa|museum|"
    r"locomotive|lok\b|triebwagen|train\b|\bzug\b|bahnhof|station|gare\b|stazione|\bbus\b|postauto|tram|"
    r"flower|blume|blüte|flora|insect|butterfl|schmetterling|käfer|beetle|bird|vogel|cow\b|kuh|kühe|goat|"
    r"ziege|sheep|schaf|horse|pferd|dog\b|hund|marmot|murmeltier|steinbock|ibex|chamois|gemse|"
    r"sign\b|schild|plaque|tafel|inscription|map\b|karte|plan\b|poster|stamp|coat of arms|wappen|"
    r"hotel|restaurant|house|haus\b|chalet|facade|fassade|window|fenster|door|tür|roof|dach|"
    r"statue|monument|denkmal|fountain|sculpture|skulptur|grave|grab\b|memorial|"
    r"aerial|luftbild|luftaufnahme|drone|drohne|spelterini|flug|airplane|flugzeug|helicopter|"
    r"painting|gemälde|drawing|zeichnung|lithograph|engraving|postcard|postkarte|photochrom|"
    r"night|nacht|portrait|people|person|wedding|concert|festival|parade|football|"
    r"food|cheese|käse|mushroom|pilz|moss|lichen|rock sample|mineral|fossil|"
    r"street|strasse|straße|gasse|platz\b|square|bridge interior|tunnel|dam wall|"
    r"stitched|360°|equirectangular|hdr|composite|montage|collage|"
    r"\bcar\b|auto\b|truck|lkw|motorcycle|cable car cabin|gondel|kabine|ski lift|sessellift|"
    r"crop\b|cropped|highlight|edited|retouch|annotated|beschriftet|labelled|labeled|icon|logo|diagram|screenshot|scan\b|\bdoc\b|crystal|kristall",
    re.I)
POS = re.compile(
    r"view|blick|aussicht|ausblick|panorama|vue|vista|veduta|from\b|\bvon\b|\bvom\b|depuis|\bda\b|"
    r"mountain|berg|gipfel|summit|peak|piz\b|pizzo|dent\b|horn\b|stock\b|grat\b|mont\b|monte\b|"
    r"alps|alpen|alpes|alpi|glacier|gletscher|massif|massiv|range|kette|ridge|"
    r"eiger|mönch|jungfrau|matterhorn|weisshorn|dom\b|bernina|säntis|pilatus|rigi|titlis|"
    r"churfirsten|mythen|tödi|glärnisch|wetterhorn|schreckhorn|finsteraarhorn|bietschhorn|"
    r"dufourspitze|monte rosa|grand combin|dents du midi|niesen|stockhorn|blüemlisalp|"
    r"landscape|landschaft|paysage|valley|tal\b|see\b|lake|lac\b|lago",
    re.I)


def strip_html(s):
    s = re.sub(r"<[^>]+>", "", s or "")
    return html.unescape(s).strip()


def chunks(xs, n=50):
    for i in range(0, len(xs), n):
        yield xs[i:i + n]


def pass_a():
    titles = load("titles.json")
    meta = load("meta_a.json", {})
    todo = [t for t in titles if t not in meta]
    print(f"pass A: {len(todo)} to fetch")
    for i, batch in enumerate(chunks(todo)):
        r = api({"action": "query", "titles": "|".join(batch),
                 "prop": "imageinfo|coordinates", "iiprop": "size|mime|extmetadata",
                 "iiextmetadatafilter": "LicenseShortName|LicenseUrl|Categories|Artist",
                 "coprimary": "all", "coprop": "type|name|dim|globe", "colimit": "max"})
        for p in r["query"]["pages"]:
            t = p["title"]
            ii = (p.get("imageinfo") or [{}])[0]
            em = ii.get("extmetadata", {})
            meta[t] = {
                "pageid": p.get("pageid"),
                "w": ii.get("width"), "h": ii.get("height"), "mime": ii.get("mime"),
                "lic": em.get("LicenseShortName", {}).get("value"),
                "licUrl": em.get("LicenseUrl", {}).get("value"),
                "cats": em.get("Categories", {}).get("value", ""),
                "artist": strip_html(em.get("Artist", {}).get("value", ""))[:200],
                "coords": p.get("coordinates", []),
            }
        for t in batch:
            meta.setdefault(t, {"missing": True})
        if i % 20 == 0:
            save("meta_a.json", meta)
            print(f"  {i * 50}/{len(todo)}")
    save("meta_a.json", meta)
    # coordinates list is capped per page (colimit shared); fine for our purpose


def pick_coord(coords):
    cam = [c for c in coords if c.get("type") == "camera" and c.get("globe", "earth") == "earth"]
    if cam:
        c = sorted(cam, key=lambda c: not c.get("primary"))[0]
        return c, "camera"
    obj = [c for c in coords if c.get("globe", "earth") == "earth"]
    if obj:
        c = sorted(obj, key=lambda c: not c.get("primary"))[0]
        return c, "object"
    return None, None


def score_a(t, m):
    """Return (score, reason) or (None, reason) if excluded."""
    if m.get("missing") or m.get("mime") != "image/jpeg":
        return None, "mime"
    if not m.get("lic") or not OK_LIC.match(m["lic"].strip()):
        return None, "license"
    w, h = m.get("w") or 0, m.get("h") or 0
    if min(w, h) < 1000:
        return None, "small"
    if max(w, h) / min(w, h) > 2.5:
        return None, "aspect"
    c, ctype = pick_coord(m.get("coords", []))
    if not c:
        return None, "nocoord"
    if not in_ch(c["lat"], c["lon"]):
        return None, "outside"
    text = t + " " + m.get("cats", "")
    if NEG.search(text):
        return None, "negkw"
    s = 0.0
    s += 3 if ctype == "camera" else -2
    s += min(len(POS.findall(text)), 5) * 1.0
    if w >= h:
        s += 0.5
    return s, "ok"


def rank_a():
    meta = load("meta_a.json")
    titles = load("titles.json")
    reasons = Counter()
    out = []
    for t, m in meta.items():
        s, why = score_a(t, m)
        reasons[why] += 1
        if s is None:
            continue
        c, ctype = pick_coord(m["coords"])
        out.append({"title": t, "score": s, "lat": c["lat"], "lon": c["lon"], "coordType": ctype,
                    "region": titles.get(t, {}).get("region", "?"), "artist": m["artist"]})
    print(reasons)
    out.sort(key=lambda x: -x["score"])
    return out


def parse_heading(wikitext):
    """Heading from {{Location|...|heading:X}} / {{Camera location|...|heading:X}}."""
    for m in re.finditer(r"\{\{\s*(camera location|location|location dec|location-Panorama)[^}]*\}\}", wikitext, re.I):
        tpl = m.group(0)
        hm = re.search(r"heading:\s*([A-Za-z0-9.\-]+)", tpl)
        if hm:
            return hm.group(1), tpl
        hm = re.search(r"\|\s*heading\s*=\s*([A-Za-z0-9.\-]+)", tpl)
        if hm:
            return hm.group(1), tpl
    return None, None


COMPASS = {k: i * 22.5 for i, k in enumerate(
    "N NNE NE ENE E ESE SE SSE S SSW SW WSW W WNW NW NNW".split())}


def heading_deg(h):
    if h is None:
        return None
    h = h.strip().upper()
    if h in COMPASS:
        return COMPASS[h]
    try:
        v = float(h)
        return v % 360 if -360 <= v <= 720 else None
    except ValueError:
        return None


def frac(v):
    if v is None:
        return None
    try:
        if "/" in str(v):
            a, b = str(v).split("/")
            return float(a) / float(b) if float(b) else None
        return float(v)
    except ValueError:
        return None


def pass_b(n_top=2500):
    cands = rank_a()
    # diversity pre-cap: at most 25 per artist, keep order
    per_artist = Counter()
    keep = []
    for c in cands:
        if per_artist[c["artist"]] >= 25:
            continue
        per_artist[c["artist"]] += 1
        keep.append(c)
    keep = keep[:n_top]
    metab = load("meta_b.json", {})
    todo = [c["title"] for c in keep if c["title"] not in metab]
    print(f"pass B: {len(keep)} kept, {len(todo)} to fetch")
    for i, batch in enumerate(chunks(todo)):
        r = api({"action": "query", "titles": "|".join(batch),
                 "prop": "imageinfo|revisions", "iiprop": "url|metadata|extmetadata",
                 "iiextmetadatafilter": "DateTimeOriginal|ImageDescription|Artist|LicenseShortName|LicenseUrl",
                 "rvprop": "content", "rvslots": "main"})
        for p in r["query"]["pages"]:
            ii = (p.get("imageinfo") or [{}])[0]
            md = {x["name"]: x["value"] for x in (ii.get("metadata") or []) if not isinstance(x["value"], list)}
            em = ii.get("extmetadata", {})
            wt = ""
            if p.get("revisions"):
                wt = p["revisions"][0]["slots"]["main"].get("content", "")
            h, tpl = parse_heading(wt)
            metab[p["title"]] = {
                "url": ii.get("url", "").split("?")[0],
                "pageUrl": ii.get("descriptionurl"),
                "focalMm": frac(md.get("FocalLength")),
                "focal35mm": frac(md.get("FocalLengthIn35mmFilm")),
                "make": md.get("Make"), "model": md.get("Model"),
                "software": md.get("Software"),
                "dateExif": md.get("DateTimeOriginal"),
                "gpsAlt": frac(md.get("GPSAltitude")), "gpsAltRef": md.get("GPSAltitudeRef"),
                "gpsDir": frac(md.get("GPSImgDirection")),
                "gpsLat": md.get("GPSLatitude"), "gpsLon": md.get("GPSLongitude"),
                "dateDesc": strip_html(em.get("DateTimeOriginal", {}).get("value", ""))[:80],
                "desc": strip_html(em.get("ImageDescription", {}).get("value", ""))[:300],
                "artistFull": strip_html(em.get("Artist", {}).get("value", ""))[:200],
                "headingRaw": h, "headingDeg": heading_deg(h), "locTpl": tpl,
                "panoTpl": bool(re.search(r"\{\{\s*(panorama|pano360|stitched|photomontage|retouched)", wt, re.I)),
            }
        if i % 10 == 0:
            save("meta_b.json", metab)
            print(f"  {i * 50}/{len(todo)}")
    save("meta_b.json", metab)


def rank_final(n=640):
    cands = rank_a()
    metab = load("meta_b.json", {})
    out = []
    for c in cands:
        b = metab.get(c["title"])
        if not b:
            continue
        if b["panoTpl"]:
            continue
        sw = (b.get("software") or "").lower()
        if any(k in sw for k in ("hugin", "ptgui", "autopano", "microsoft ice", "image composite")):
            continue
        s = c["score"]
        if b["headingDeg"] is not None or b["gpsDir"] is not None:
            s += 3
        if b["focal35mm"] or b["focalMm"]:
            s += 2
        if b["focal35mm"] and b["focal35mm"] >= 70:
            s += 1.5  # tele is rarer, boost
        out.append({**c, **b, "score": s})
    out.sort(key=lambda x: -x["score"])
    # spatial + artist diversity: max 2 per ~2 km cell, max 6 per artist, spread over regions
    cell, art = Counter(), Counter()
    byreg = defaultdict(list)
    for c in out:
        k = (round(c["lat"] / 0.02), round(c["lon"] / 0.03))
        if cell[k] >= 2 or art[c["artist"]] >= 6:
            continue
        cell[k] += 1; art[c["artist"]] += 1
        byreg[c["region"]].append(c)
    # round-robin across regions
    final = []
    regs = sorted(byreg)
    while len(final) < n and any(byreg.values()):
        for r in regs:
            if byreg[r]:
                final.append(byreg[r].pop(0))
    print({r: sum(1 for c in final if c["region"] == r) for r in regs})
    save("candidates.json", final[:n])
    print(f"{len(final[:n])} candidates for screening")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "a"
    {"a": pass_a, "b": pass_b, "rank": rank_final}[cmd]()
