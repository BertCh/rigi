"""P1 position triage: title parsing + OSM gazetteer + DEM checks -> flags.json, proposals.json. Rules: PROTOCOL.txt."""
from __future__ import annotations
import json, math, re, sys, unicodedata
from pathlib import Path
import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "tools/matcher"))
import dem as DEM  # noqa: E402
import net  # noqa: E402
from fetch_gaz import dev_rows, gazetteer  # noqa: E402

# ---- constants (frozen in PROTOCOL.txt)
FAR_M, LOW_M, LOW_NEAR_M, LOS_TOL, HDG_DEG, GAZ_R, DISC_M, EYE_UP, EXIF_M = 400, 150, 1000, 20.0, 60.0, 40000, 30.0, 2.0, 150
R_EARTH, K = DEM.R_EARTH, DEM.K_REFR

GENERIC_LEAD = {"piz", "pizzo", "pic", "pointe", "punta", "mont", "monte", "mount", "mt", "munt", "cima", "dent", "aiguille",
                "grand", "gross", "grosser", "grosse", "klein", "kleiner", "le", "la", "les", "il", "der", "die", "das", "the"}
TAIL_GENERIC = {"gipfel", "summit", "sommet", "vetta", "kulm"}
STOP = {"to", "towards", "toward", "onto", "over", "across", "with", "and", "und", "nach", "gegen", "richtung", "auf", "mit",
        "vers", "sur", "et", "avec", "verso", "su", "con", "e", "in", "im", "bei", "near", "at", "aus", "gesehen"}


def fold(s: str, umlaut_ae=False) -> str:
    s = s.replace("ß", "ss").replace("ẞ", "ss")
    if umlaut_ae:
        for a, b in (("ä", "ae"), ("ö", "oe"), ("ü", "ue"), ("Ä", "Ae"), ("Ö", "Oe"), ("Ü", "Ue")):
            s = s.replace(a, b)
    s = unicodedata.normalize("NFKD", s)
    return "".join(c for c in s if not unicodedata.combining(c)).lower()


def toks(s: str) -> list[str]:
    return [t for t in re.split(r"[^a-z0-9]+", s) if t]


def variants(name: str) -> set[str]:
    out = set()
    for ae in (False, True):
        t = toks(fold(name, ae))
        if not t:
            continue
        for tt in (t, t[1:] if t[0] in GENERIC_LEAD and len("".join(t[1:])) >= 4 else None):
            if tt:
                out.add(" ".join(tt))
                out.add("".join(tt))
    return out


def hav(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R_EARTH * math.asin(math.sqrt(a))


def ftype(tags):
    for k in ("natural", "tourism", "amenity", "place", "railway", "aerialway"):
        if k in tags:
            return f"{k}={tags[k]}"
    return "?"


class Gaz:
    def __init__(self, elements):
        self.idx: dict[str, list] = {}
        self.feats = []
        for el in elements:
            tg = el.get("tags", {})
            lat = el.get("lat", (el.get("center") or {}).get("lat"))
            lon = el.get("lon", (el.get("center") or {}).get("lon"))
            if lat is None:
                continue
            names = {tg[k] for k in tg if k in ("name", "alt_name", "short_name", "official_name", "loc_name")
                     or re.fullmatch(r"name:(de|fr|it|rm|en)", k)}
            names = {x.strip() for n in names for x in n.split(";") if x.strip()}
            f = {"osm": f"{el['type']}/{el['id']}", "name": tg.get("name"), "type": ftype(tg), "lat": lat, "lon": lon,
                 "peak": tg.get("natural") in ("peak", "volcano"), "ele": tg.get("ele")}
            self.feats.append(f)
            f["full"] = set()
            for n in names:
                for v in variants(n):
                    self.idx.setdefault(v, []).append(f)
                f["full"] |= {" ".join(toks(fold(n, ae))) for ae in (False, True)}

    def exact(self, q: str, peaks_only=False):
        r = []
        for v in {q, q.replace(" ", "")} | ({" ".join(q.split()[1:])} if q.split()[0] in GENERIC_LEAD and len(q.replace(" ", "")) - len(q.split()[0]) >= 4 else set()):
            r += [f for f in self.idx.get(v, []) if not peaks_only or f["peak"]]
        return list({id(f): f for f in r}.values())

    def prefix(self, q: str):
        if len(q.replace(" ", "")) < 5:
            return []
        return [f for f in self.feats if any(n.startswith(q + " ") for n in f["full"])]


# ---- title parsing
CUES = [r"as seen from", r"seen from", r"view from", r"looking \w+ from", r"from the summit of", r"from the top of",
        r"on top of", r"at the summit of", r"summit of", r"top of", r"from",
        r"(?:blick|aussicht|sicht|panorama|gipfelpanorama|gipfelblick) (?:vom|von der|von den|von)",
        r"gipfelpanorama", r"gipfelblick", r"vom", r"von der", r"von den", r"ab dem", r"ab der", r"ab",
        r"(?<!blick )(?<!sicht )(?<!aussicht )(?<!panorama )auf dem", r"(?<!blick )(?<!sicht )(?<!aussicht )(?<!panorama )auf der",
        r"von(?= [^,;()\[\]]+? (?:aus|gesehen)\b)",
        r"vue? depuis", r"depuis(?: le| la| l'| les)?", r"vu (?:du|de la|de l'|des)", r"(?:au )?sommet (?:du|de la)",
        r"(?:visto|vista|veduta|panorama) (?:dall'|dalla|dallo|dal|da)", r"cima (?:del|della)",
        r"dall'|dalla|dallo|dal|dai|dagli|dalle|dad|da"]
CUE_RE = re.compile(r"(?<![a-z0-9])(?:" + "|".join(f"(?:{c})" for c in CUES) + r")(?![a-z0-9])")
SUFFIX_RE = re.compile(r"^(.+?)\s*(?:-|–|—)?\s*(?:summit view|view|aussicht|blick|panorama|vue|vista|gipfelpanorama|gipfelaussicht)(?![a-z0-9])")
DELIM_RE = re.compile(r"[,;()\[\].:]| - | – | — |\d")
TARGET_CUE_RE = re.compile(r"(?<![a-z])(blick auf|view of|view to|view towards|vue sur|vers|richtung|verso|vista su)(?![a-z])")


def norm_title(t: str) -> str:
    t = re.sub(r"^file:", "", t, flags=re.I)
    t = re.sub(r"\.(jpe?g|png|tiff?|webp)$", "", t, flags=re.I)
    t = t.replace("_", " ")
    t = re.sub(r"\b(img|dsc|dscf|dscn|dji|pict|p\d{5,}|imgp)[ _-]?\d*\b", " ", t, flags=re.I)
    t = re.sub(r"\b\d{4}[-.]\d{2}[-.]\d{2}\b", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def captures(tl: str):
    """tl = folded title -> [(cue, capture_text, span)]"""
    out = []
    for m in CUE_RE.finditer(tl):
        rest = tl[m.end():]
        d = DELIM_RE.search(rest)
        cap = rest[:d.start()] if d else rest
        tk = toks(cap)
        cut = [i for i, t in enumerate(tk) if t in STOP]
        tk = tk[:cut[0]] if cut else tk
        if tk:
            ends = [mm.end() for mm in re.finditer(r"[a-z0-9]+", cap)]
            out.append({"cue": m.group(0), "text": " ".join(tk), "span": (m.start(), m.end() + ends[len(tk) - 1])})
    m = SUFFIX_RE.match(tl)
    if m:
        tk = toks(m.group(1))
        if tk and len(tk) <= 5:
            out.append({"cue": "suffix-view", "text": " ".join(tk), "span": (0, m.end())})
    return out


def resolve_vp(g: Gaz, cap: str, lat, lon):
    tk = cap.split()
    tries = [tk]
    if tk and tk[-1] in TAIL_GENERIC and len(tk) > 1:
        tries.append(tk[:-1])
    tk2 = [re.sub(r"(gipfel|kulm)$", "", tk[0])] + tk[1:] if tk and re.search(r".{4,}(gipfel|kulm)$", tk[0]) else None
    if tk2:
        tries.append(tk2)
    for t in tries:
        for n in range(min(5, len(t)), 0, -1):
            q = " ".join(t[:n])
            if len(q.replace(" ", "")) < 3:
                continue
            hits = g.exact(q)
            if hits:
                return pick_nearest(hits, lat, lon, f"gaz-exact:{q}")
    for t in tries:
        hits = g.prefix(" ".join(t))
        if hits:
            return pick_nearest(hits, lat, lon, f"gaz-prefix:{' '.join(t)}")
    # Nominatim fallback
    dlat = GAZ_R / (R_EARTH * math.pi / 180)
    dlon = dlat / math.cos(math.radians(lat))
    res = net.nominatim(cap, lat, lon, dlat, dlon)
    hits = [{"osm": f"{r.get('osm_type')}/{r.get('osm_id')}", "name": r.get("name") or r.get("display_name"),
             "type": f"{r.get('category')}={r.get('type')}", "lat": float(r["lat"]), "lon": float(r["lon"]), "peak": r.get("type") in ("peak", "volcano")}
            for r in res]
    hits = [h for h in hits if hav(lat, lon, h["lat"], h["lon"]) <= GAZ_R]
    if hits:
        return pick_nearest(hits, lat, lon, f"nominatim:{cap}")
    return None


def pick_nearest(hits, lat, lon, how):
    h = min(hits, key=lambda f: hav(lat, lon, f["lat"], f["lon"]))
    return {k: h[k] for k in ("osm", "name", "type", "lat", "lon", "peak")} | {"how": how, "nMatches": len(hits),
                                                                             "distM": round(hav(lat, lon, h["lat"], h["lon"]), 1)}


def find_targets(g: Gaz, tl: str, vp_spans):
    """Peak names anywhere in the folded title outside VP spans; longest first, non-overlapping."""
    words = [(m.group(0), m.start(), m.end()) for m in re.finditer(r"[a-z0-9]+", tl)]
    used = [False] * len(words)
    found = []
    for n in range(5, 0, -1):
        for i in range(0, len(words) - n + 1):
            if any(used[i:i + n]):
                continue
            s, e = words[i][1], words[i + n - 1][2]
            if any(a <= s < b for a, b in vp_spans):
                continue
            q = " ".join(w[0] for w in words[i:i + n])
            if len(q.replace(" ", "")) < 4:
                continue
            hits = g.exact(q, peaks_only=True)
            if hits:
                for j in range(i, i + n):
                    used[j] = True
                found.append((q, hits))
    return found


# ---- DEM helpers
_mos = {}


def z_feat(lat, lon):
    """max Mapterhorn z14 DEM over a 30 m disc (absolute metres)."""
    key = (round(lat, 3), round(lon, 3))
    if key not in _mos:
        dd = 0.004
        _mos[key] = DEM.Mosaic(14, lat - dd, lat + dd, lon - dd * 1.5, lon + dd * 1.5)
    m = _mos[key]
    mlat = 1 / (R_EARTH * math.pi / 180)
    mlon = mlat / math.cos(math.radians(lat))
    r = np.arange(-DISC_M, DISC_M + 0.1, 3.0)
    E, N = np.meshgrid(r, r)
    ok = E ** 2 + N ** 2 <= DISC_M ** 2
    h = m.sample(lon + E[ok] * mlon, lat + N[ok] * mlat)
    return float(np.max(h))


def los(d: DEM.Dem, eye_z, lat, lon, zt):
    """-> (visible, max excess m, where m, dist m, bearing deg)"""
    e = (lon - d.lon0) / d.mlon
    n = (lat - d.lat0) / d.mlat
    D = math.hypot(e, n)
    zt_enu = zt - (1 - K) * D * D / (2 * R_EARTH)
    step = max(5.0, 0.0025 * D)
    s = np.arange(30.0, D - 60.0, step)
    if len(s) == 0:
        return True, 0.0, 0.0, D, math.degrees(math.atan2(e, n)) % 360
    E, N = e * s / D, n * s / D
    h = np.empty_like(s)
    lo = 0.0
    for dm, mos in d.mos:
        sel = (s >= lo) & (s < dm)
        lo = dm
        if sel.any():
            lo_, la_ = d.geo(E[sel], N[sel])
            h[sel] = mos.sample(lo_, la_)
    h = h - (1 - K) * s * s / (2 * R_EARTH)
    line = eye_z + (zt_enu - eye_z) * s / D
    ex = h - line
    k = int(np.argmax(ex))
    return bool(ex[k] <= LOS_TOL), float(ex[k]), float(s[k]), D, math.degrees(math.atan2(e, n)) % 360


def angdiff(a, b):
    return abs((a - b + 540) % 360 - 180)


def cache_eye(pid):
    f = ROOT / "tools/research/tm/cache" / pid / "meta.json"
    return json.load(open(f))["eye"][2] if f.exists() else None


def run_photo(e):
    pid, lat, lon = e["id"], e["lat"], e["lon"]
    g = Gaz(gazetteer(e)["elements"])
    d = DEM.Dem(lat, lon, extent_m=0.0)
    ground = float(d.ground(0.0, 0.0))
    alt = e.get("altitudeM")
    eye = max(alt if alt is not None else ground, ground + 1.6)
    ceye = cache_eye(pid)
    title = norm_title(e["title"])
    tl = fold(title)
    caps = captures(tl)
    vps = []
    for c in caps:
        r = resolve_vp(g, c["text"], lat, lon)
        if r:
            r["zFeat"] = round(z_feat(r["lat"], r["lon"]), 1)
            vps.append({**c, "span": list(c["span"]), "feature": r})
        else:
            vps.append({**c, "span": list(c["span"]), "feature": None})
    vp_osm = {v["feature"]["osm"] for v in vps if v["feature"]}
    tg = []
    for q, hits in find_targets(g, tl, [tuple(v["span"]) for v in vps]):
        f = pick_nearest(hits, lat, lon, f"target:{q}")
        if f["osm"] in vp_osm:
            continue
        rec = {"q": q, "feature": f}
        if 200 <= f["distM"] <= GAZ_R:
            zt = z_feat(f["lat"], f["lon"])
            vis, exc, where, D, brg = los(d, eye, f["lat"], f["lon"], zt)
            rec.update(zFeat=round(zt, 1), visible=vis, excessM=round(exc, 1), blockAtM=round(where), bearing=round(brg, 1))
            if e.get("headingDeg") is not None:
                rec["offHeading"] = round(angdiff(brg, float(e["headingDeg"])), 1)
        tg.append(rec)
    flags, reasons, cands = [], [], []
    for v in vps:
        f = v["feature"]
        if not f:
            continue
        if f["distM"] > FAR_M:
            flags.append("F-far")
            reasons.append(f"viewpoint '{v['text']}' -> {f['name']} ({f['type']}) {f['distM']:.0f} m away")
            cands.append({"lat": f["lat"], "lon": f["lon"], "h": round(f["zFeat"] + EYE_UP, 1), "reason": f"F-far: {f['name']} {f['distM']:.0f} m"})
        elif f["distM"] <= LOW_NEAR_M and eye < f["zFeat"] - LOW_M:
            flags.append("F-low")
            reasons.append(f"eye {eye:.0f} m is {f['zFeat'] - eye:.0f} m below {f['name']} ({f['zFeat']:.0f} m) {f['distM']:.0f} m away")
            cands.append({"lat": f["lat"], "lon": f["lon"], "h": round(f["zFeat"] + EYE_UP, 1), "reason": f"F-low: {f['name']} +{f['zFeat'] - eye:.0f} m"})
    for t in tg:
        if "visible" not in t:
            continue
        if not t["visible"]:
            flags.append("F-vis")
            reasons.append(f"target {t['feature']['name']} ({t['feature']['distM']/1000:.1f} km) blocked by {t['excessM']:.0f} m at {t['blockAtM']} m")
        if t.get("offHeading") is not None and t["offHeading"] > HDG_DEG:
            flags.append("F-vis")
            reasons.append(f"target {t['feature']['name']} bearing {t['bearing']:.0f} is {t['offHeading']:.0f} deg off heading")
    exif = None
    if alt is not None:
        exif = round(alt - ground, 1)
        if abs(exif) > EXIF_M:
            reasons.append(f"EXIF alt {alt:.0f} vs DEM {ground:.0f} ({exif:+.0f} m)")
    flags = sorted(set(flags))
    return {"pid": pid, "title": e["title"], "titleNorm": title, "lat": lat, "lon": lon, "positionSource": e["positionSource"],
            "headingDeg": e.get("headingDeg"), "altitudeM": alt, "ground": round(ground, 1), "eye": round(eye, 1),
            "cacheEye": ceye, "exifMinusGround": exif, "fExif": exif is not None and abs(exif) > EXIF_M,
            "viewpoints": vps, "targets": tg, "flags": flags, "suspect": bool(flags), "reasons": reasons, "candidates": cands}


if __name__ == "__main__":
    rows = dev_rows()
    only = set(sys.argv[1:])
    out = []
    for e in rows:
        if only and e["id"] not in only:
            continue
        r = run_photo(e)
        out.append(r)
        print(r["pid"], r["flags"], "|", r["titleNorm"][:60], "|", [(v["text"], v["feature"] and v["feature"]["name"], v["feature"] and v["feature"]["distM"]) for v in r["viewpoints"]],
              [(t["feature"]["name"], t["feature"]["distM"], t.get("visible"), t.get("offHeading")) for t in r["targets"]], flush=True)
    if not only:
        json.dump(out, open(HERE / "flags.json", "w"), indent=1, ensure_ascii=False)
        props = [{"pid": r["pid"], "eye": {"lat": c["lat"], "lon": c["lon"], "h": c["h"]}, "reason": c["reason"]}
                 for r in out for c in r["candidates"]]
        json.dump(props, open(HERE / "proposals.json", "w"), indent=1, ensure_ascii=False)
