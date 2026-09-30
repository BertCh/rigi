"""WMM2025 declination reference values for the TS port (src/lib/geocam/priors/wmm.ts) parity test.

    PYTHONPATH=tools/research/geo/.pylib tools/matcher/.venv/bin/python tools/research/geo/decl_ref.py

Source: pygeomag 1.1.0 with its bundled WMM_2025.COF (standard WMM2025, degree 12; NOT the high-resolution WMMHR).
Self-check first: pygeomag vs the official NOAA WMM2025 test values (copied from src/lib/geocam/priors/
wmm-test-values.ts, which quotes WMM2025_TestValues.txt) - aborts if |dD| > 0.01 deg.

Output out/geocam/python/decl_ref.json:
  {"format": "geocam-decl-ref/1", "model": "WMM2025", "source": "pygeomag 1.1.0 WMM_2025.COF",
   "units": {"lat/lon": "deg geodetic WGS84", "altM": "m above ellipsoid", "year": "decimal year (UTC)",
             "decl/incl": "deg (decl east +, incl down +)", "X/Y/Z/H": "nT (north, east, down, horizontal)"},
   "officialCheck": {"n", "maxAbsDeclErrDeg", "maxAbsXYZErrNT"},
   "points": [{"name", "lat", "lon", "altM", "year", "decl", "incl", "X", "Y", "Z", "H"}, ...]}
"""
from __future__ import annotations

import re
import time
from pathlib import Path

import geo_common as G  # noqa: F401  (.pylib on sys.path)
from pygeomag import GeoMag

PLACES = [
    # Switzerland / Alps (the product's region)
    ("Bern", 46.948, 7.447, 540), ("Geneva", 46.204, 6.143, 375), ("Zurich", 47.377, 8.540, 408),
    ("Basel", 47.559, 7.588, 260), ("Lugano", 46.004, 8.951, 273), ("Chur", 46.850, 9.532, 593),
    ("St. Moritz", 46.498, 9.838, 1822), ("Zermatt", 46.020, 7.749, 1608), ("Matterhorn", 45.9763, 7.6586, 4478),
    ("Jungfraujoch", 46.5475, 7.9853, 3466), ("Saentis", 47.2494, 9.3433, 2502), ("Piz Bernina", 46.3824, 9.9080, 4049),
    ("Pilatus", 46.9790, 8.2544, 2128), ("Thun", 46.758, 7.628, 560), ("Glarus Alps", 46.90117, 9.17801, 2103),
    ("Chamonix", 45.924, 6.869, 1035), ("Mont Blanc", 45.8326, 6.8652, 4808), ("Grenoble", 45.188, 5.724, 212),
    ("Innsbruck", 47.269, 11.404, 574), ("Bolzano", 46.498, 11.354, 262), ("Cortina", 46.540, 12.136, 1224),
    ("Munich", 48.137, 11.575, 519), ("Ljubljana", 46.056, 14.508, 295),
    # worldwide spot checks
    ("Reykjavik", 64.146, -21.942, 30), ("New York", 40.713, -74.006, 10), ("Denver", 39.739, -104.990, 1609),
    ("Anchorage", 61.218, -149.900, 30), ("La Paz", -16.500, -68.150, 3640), ("Ushuaia", -54.801, -68.303, 20),
    ("Cape Town", -33.925, 18.424, 10), ("Kathmandu", 27.717, 85.324, 1400), ("Everest", 27.9881, 86.9250, 8849),
    ("Tokyo", 35.690, 139.692, 40), ("Queenstown NZ", -45.031, 168.663, 330), ("Svalbard", 78.223, 15.647, 10),
]
YEARS = [2025.0, 2025.5, 2026.0, 2026.75, 2027.5, 2028.25, 2029.0, 2029.9]


def official_rows():
    src = (G.ROOT / "src/lib/geocam/priors/wmm-test-values.ts").read_text()
    rows = []
    for m in re.finditer(r"\[\s*(20\d\d\.\d+)\s*,([^\]]+)\]", src):
        vals = [float(m.group(1))] + [float(x) for x in m.group(2).split(",")]
        rows.append(vals)
    return rows


def main():
    gm = GeoMag(coefficients_file="wmm/WMM_2025.COF")
    rows = official_rows()
    errs, xyz = [], 0.0
    for yr, altKm, lat, lon, D, X, Y, Z in rows:
        r = gm.calculate(glat=lat, glon=lon, alt=altKm, time=yr)
        errs.append(abs(r.d - D))
        xyz = max(xyz, abs(r.x - X), abs(r.y - Y), abs(r.z - Z))
    assert rows and max(errs) <= 0.01 and xyz < 0.1, f"pygeomag vs official: max |dD| {max(errs)}, max |dXYZ| {xyz}"
    print(f"official WMM2025 test values: n={len(rows)} max|dD|={max(errs):.4f} deg (table rounds to 0.01), "
          f"max|dXYZ|={xyz:.4f} nT")
    pts = []
    for name, lat, lon, altM in PLACES:
        for yr in YEARS:
            r = gm.calculate(glat=lat, glon=lon, alt=altM / 1000.0, time=yr)
            pts.append({"name": name, "lat": lat, "lon": lon, "altM": altM, "year": yr, "decl": r.d, "incl": r.i,
                        "X": r.x, "Y": r.y, "Z": r.z, "H": r.h})
    out = {"format": "geocam-decl-ref/1", "model": "WMM2025", "source": "pygeomag 1.1.0 WMM_2025.COF",
           "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
           "units": {"lat/lon": "deg geodetic WGS84", "altM": "m above ellipsoid", "year": "decimal year (UTC)",
                     "decl/incl": "deg (decl east +, incl down +)", "X/Y/Z/H": "nT (north, east, down, horizontal)"},
           "officialCheck": {"n": len(rows), "maxAbsDeclErrDeg": max(errs), "maxAbsXYZErrNT": xyz}, "points": pts}
    G.jdump(out, G.PYOUT / "decl_ref.json")
    ch = [p for p in pts if p["name"] in ("Bern", "Zermatt", "Chur") and p["year"] in (2025.0, 2029.0)]
    for p in ch:
        print(f"  {p['name']:8s} {p['year']}  D={p['decl']:.4f}")
    print(f"wrote {Path(G.PYOUT / 'decl_ref.json')} ({len(pts)} points)")


if __name__ == "__main__":
    main()
