"""E2 shared helpers: paths, dev ids, sun ephemeris (port of src/lib/look/sun.ts), rasterio from fund/.pylib."""
from __future__ import annotations
import json, math, sys
from pathlib import Path
from datetime import datetime
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
FUND = HERE.parent
ROOT = FUND.parents[2]
TM = ROOT / "tools/research/tm"
sys.path.insert(0, str(TM))
sys.path.insert(0, str(TM / "c0_cache"))
sys.path.append(str(FUND / ".pylib"))  # appended: never shadow the venv's numpy/torch
import tm_common  # noqa: E402
import cache_io as C  # noqa: E402

D = math.pi / 180
OUT = HERE


def dev_manifest() -> dict:
    dev = set(tm_common.dev_ids())
    return {x["id"]: x for x in json.load(open(ROOT / "tools/bench/data/manifest.json")) if x["id"] in dev}


def eval_ids() -> list[str]:
    """Dev photos with a correct ref and a perturb base (the scored set)."""
    out = []
    for pid in tm_common.dev_ids():
        if not C.done(pid):
            continue
        m = C.load_meta(pid)
        if m.get("correct_refs") and m.get("perturbBase"):
            out.append(pid)
    return out


def sun_position(t_utc: datetime, lat: float, lon: float):
    """NOAA/Meeus low-precision ephemeris, line-for-line port of src/lib/look/sun.ts sunPosition."""
    jd = t_utc.timestamp() / 86400 + 2440587.5
    T = (jd - 2451545) / 36525
    L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360
    M = 357.52911 + T * (35999.05029 - 0.0001537 * T)
    e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T)
    Cc = (math.sin(M * D) * (1.914602 - T * (0.004817 + 0.000014 * T)) + math.sin(2 * M * D) * (0.019993 - 0.000101 * T)
          + math.sin(3 * M * D) * 0.000289)
    omega = 125.04 - 1934.136 * T
    lam = L0 + Cc - 0.00569 - 0.00478 * math.sin(omega * D)
    eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60
    eps = eps0 + 0.00256 * math.cos(omega * D)
    decl = math.asin(math.sin(eps * D) * math.sin(lam * D))
    y = math.tan(eps / 2 * D) ** 2
    eot = (4 / D) * (y * math.sin(2 * L0 * D) - 2 * e * math.sin(M * D) + 4 * e * y * math.sin(M * D) * math.cos(2 * L0 * D)
                     - 0.5 * y * y * math.sin(4 * L0 * D) - 1.25 * e * e * math.sin(2 * M * D))
    utc_min = t_utc.hour * 60 + t_utc.minute + t_utc.second / 60
    tst = ((utc_min + eot + 4 * lon) % 1440 + 1440) % 1440
    ha = (tst / 4 - 180) * D
    phi = lat * D
    cz = math.sin(phi) * math.sin(decl) + math.cos(phi) * math.cos(decl) * math.cos(ha)
    zen = math.acos(min(1, max(-1, cz)))
    el = 90 - zen / D
    if el > -1:
        el += 1.02 / (60 * math.tan((el + 10.3 / (el + 5.11)) * D))
    az = (math.atan2(math.sin(ha), math.cos(ha) * math.sin(phi) - math.tan(decl) * math.cos(phi)) / D + 180 + 360) % 360
    ce = math.cos(el * D)
    return {"az": az, "el": el, "dir": [ce * math.sin(az * D), ce * math.cos(az * D), math.sin(el * D)]}


def local_to_utc(s: str, tz="Europe/Zurich") -> datetime:
    t = datetime.fromisoformat(s).replace(tzinfo=ZoneInfo(tz))
    return t.astimezone(ZoneInfo("UTC"))


def sun_dir(az, el):
    ce = math.cos(el * D)
    return [ce * math.sin(az * D), ce * math.cos(az * D), math.sin(el * D)]
