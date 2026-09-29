"""Fetch (and cache) the 40 km OSM gazetteer for every dev photo. Dev ids only."""
from __future__ import annotations
import json, sys
from pathlib import Path
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
sys.path.insert(0, str(HERE))
import net  # noqa: E402

R = 40000


def dev_rows():
    dev = set(json.load(open(ROOT / "tools/bench/split.json"))["dev"])
    return [e for e in json.load(open(ROOT / "tools/bench/data/manifest.json")) if e["id"] in dev]


def query(lat, lon, r=R):
    a = f"(around:{r},{lat:.6f},{lon:.6f})"
    return (f"[out:json][timeout:180];("
            f'nwr["name"]["natural"~"^(peak|volcano|saddle|ridge)$"]{a};'
            f'nwr["name"]["tourism"~"^(viewpoint|alpine_hut|wilderness_hut)$"]{a};'
            f'nwr["name"]["amenity"="shelter"]{a};'
            f'nwr["name"]["place"]{a};'
            f'nwr["name"]["railway"~"^(station|halt)$"]{a};'
            f'nwr["name"]["aerialway"="station"]{a};'
            f");out tags center;")


BBOX_LAT = (45.60, 46.20, 46.67, 47.20, 47.73)
BBOX_LON = (6.49, 7.60, 8.72, 9.84, 10.95)


def bbox_query(s, w, n, e):
    b = f"({s},{w},{n},{e})"
    return (f"[out:json][timeout:600][maxsize:1073741824];("
            f'nwr["name"]["natural"~"^(peak|volcano|saddle|ridge)$"]{b};'
            f'nwr["name"]["tourism"~"^(viewpoint|alpine_hut|wilderness_hut)$"]{b};'
            f'nwr["name"]["amenity"="shelter"]{b};'
            f'nwr["name"]["place"]{b};'
            f'nwr["name"]["railway"~"^(station|halt)$"]{b};'
            f'nwr["name"]["aerialway"="station"]{b};'
            f");out tags center;")


_ALL = None


def all_elements():
    """Union of 16 bbox tiles covering every dev photo +- 40 km (same feature classes as query()); deduped."""
    global _ALL
    if _ALL is None:
        seen = {}
        for i in range(4):
            for j in range(4):
                d = net.overpass(bbox_query(BBOX_LAT[i], BBOX_LON[j], BBOX_LAT[i + 1], BBOX_LON[j + 1]))
                for el in d.get("elements", []):
                    seen[(el["type"], el["id"])] = el
        _ALL = list(seen.values())
    return _ALL


def query_split(lat, lon, r=R):
    """DEVIATION (server load, before full results): place=* restricted to NODES; everything else as query()."""
    a = f"(around:{r},{lat:.6f},{lon:.6f})"
    qa = (f"[out:json][timeout:180];("
          f'nwr["name"]["natural"~"^(peak|volcano|saddle|ridge)$"]{a};'
          f'nwr["name"]["tourism"~"^(viewpoint|alpine_hut|wilderness_hut)$"]{a};'
          f'nwr["name"]["amenity"="shelter"]{a};'
          f'nwr["name"]["railway"~"^(station|halt)$"]{a};'
          f'nwr["name"]["aerialway"="station"]{a};'
          f");out tags center;")
    qb = f'[out:json][timeout:180];node["name"]["place"]{a};out tags;'
    return qa, qb


def gazetteer(e):
    """Uniform definition for all 50: the protocol classes, but place=* as nodes only (place ways/relations dropped
    also from the photos whose full query was cached before the switch)."""
    full = net._cached("ovp", query(e["lat"], e["lon"]))
    if full.exists():
        els = net.overpass(query(e["lat"], e["lon"]))["elements"]
    else:
        qa, qb = query_split(e["lat"], e["lon"])
        els = net.overpass(qa)["elements"] + net.overpass(qb)["elements"]
    seen = {}
    for el in els:
        if "place" in el.get("tags", {}) and el["type"] != "node" and not any(
                k in el["tags"] for k in ("natural", "tourism", "amenity", "railway", "aerialway")):
            continue
        seen[(el["type"], el["id"])] = el
    return {"elements": list(seen.values())}


def gazetteer_bbox(e):
    """UNUSED (bbox tiles timed out on the public Overpass). 40 km gazetteer. Per-photo around: queries (query()) were too slow on the public Overpass (~2-4 min each), so the
    union of bbox tiles is fetched once and filtered locally by node / way-centre distance <= 40 km."""
    import math
    out = []
    for el in all_elements():
        lat = el.get("lat", (el.get("center") or {}).get("lat"))
        lon = el.get("lon", (el.get("center") or {}).get("lon"))
        if lat is None:
            continue
        dy = (lat - e["lat"]) * 111195.0
        dx = (lon - e["lon"]) * 111195.0 * math.cos(math.radians(e["lat"]))
        if dx * dx + dy * dy <= R * R:
            out.append(el)
    return {"elements": out}


if __name__ == "__main__":
    rows = dev_rows()
    assert len(rows) == 50
    for i, e in enumerate(rows):
        d = gazetteer(e)
        print(i, e["id"], len(d.get("elements", [])), flush=True)
