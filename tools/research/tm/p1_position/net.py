"""Polite cached Overpass / Nominatim access for P1. Every response cached under cache/ by query hash."""
from __future__ import annotations
import hashlib, json, time, urllib.parse, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
CACHE = HERE / "cache"
CACHE.mkdir(exist_ok=True)
UA = "mt-image-research-P1/0.1 (position triage study; low volume, cached; python urllib)"
_last = [0.0]
OVERPASS = ["https://overpass-api.de/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter"]


def _wait():
    dt = time.time() - _last[0]
    if dt < 1.1:
        time.sleep(1.1 - dt)
    _last[0] = time.time()


def _cached(kind, key):
    return CACHE / f"{kind}_{hashlib.sha1(key.encode()).hexdigest()[:16]}.json"


def overpass(q: str) -> dict:
    f = _cached("ovp", q)
    if f.exists():
        return json.load(open(f))
    err = None
    for attempt in range(6):
        url = OVERPASS[attempt % len(OVERPASS)]
        _wait()
        try:
            req = urllib.request.Request(url, data=urllib.parse.urlencode({"data": q}).encode(), headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=400) as r:
                d = json.loads(r.read())
            if "error" in (d.get("remark") or "").lower():
                raise RuntimeError(d["remark"])
            json.dump({"query": q, **d}, open(f, "w"))
            return d
        except Exception as e:  # noqa: BLE001
            err = e
            print("overpass retry", attempt, url, repr(e)[:120], flush=True)
            time.sleep(10 * (attempt + 1))
    raise RuntimeError(f"overpass failed: {err}")


def nominatim(q: str, lat: float, lon: float, dlat: float, dlon: float) -> list:
    params = {"q": q, "format": "jsonv2", "limit": 10, "bounded": 1,
              "viewbox": f"{lon - dlon},{lat + dlat},{lon + dlon},{lat - dlat}"}
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(params)
    f = _cached("nom", url)
    if f.exists():
        return json.load(open(f))["results"]
    _wait()
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        d = json.loads(r.read())
    json.dump({"url": url, "results": d}, open(f, "w"))
    return d
