"""Shared helpers for the Commons benchmark collector (stdlib only)."""
import json
import os
import shutil
import sys
import time
import urllib.parse
import urllib.request

API = "https://commons.wikimedia.org/w/api.php"
UA = "SummitLensBench/0.1 (photo-to-DEM georeferencing benchmark; contact rgcgeog@gmail.com)"
HERE = os.path.dirname(os.path.abspath(__file__))
BENCH = os.path.dirname(HERE)
DATA = os.path.join(BENCH, "data")
WORK = os.path.join(BENCH, "collect", "work")  # intermediate json + contact sheets
MIN_INTERVAL = 0.55  # seconds between requests (<2 req/s)
_last = [0.0]


def _throttle():
    dt = time.time() - _last[0]
    if dt < MIN_INTERVAL:
        time.sleep(MIN_INTERVAL - dt)
    _last[0] = time.time()


def http_get(url, retries=4, data=None):
    for attempt in range(retries):
        _throttle()
        req = urllib.request.Request(url, data=data, headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < retries - 1:
                wait = int(e.headers.get("Retry-After", "0") or 0) or 5 * (attempt + 1)
                print(f"  HTTP {e.code}, retry in {wait}s", file=sys.stderr)
                time.sleep(wait)
                continue
            raise
        except urllib.error.URLError:
            if attempt < retries - 1:
                time.sleep(5)
                continue
            raise


def api(params):
    p = {"format": "json", "formatversion": "2", "maxlag": "5", **params}
    # POST avoids 414 URI Too Long for 50-title batches
    return json.loads(http_get(API, data=urllib.parse.urlencode(p).encode()))


def free_gb():
    return shutil.disk_usage("/System/Volumes/Data").free / 1e9


def check_disk(min_gb=4.0):
    f = free_gb()
    if f < min_gb:
        sys.exit(f"ABORT: only {f:.1f} GB free (< {min_gb} GB)")
    return f


# Rough Switzerland border polygon (lon, lat), hand-traced, ~1-3 km accuracy.
CH_POLY = [
    (7.59, 47.59), (7.70, 47.54), (7.95, 47.55), (8.22, 47.62), (8.42, 47.58),
    (8.47, 47.64), (8.60, 47.67), (8.57, 47.81), (8.72, 47.72), (8.87, 47.70),
    (8.86, 47.66), (9.02, 47.68), (9.17, 47.66), (9.38, 47.58), (9.53, 47.49),
    (9.65, 47.45), (9.56, 47.33), (9.53, 47.27), (9.48, 47.19), (9.48, 47.06),
    (9.61, 47.06), (9.87, 47.02), (10.10, 46.95), (10.23, 46.87), (10.35, 46.99),
    (10.47, 46.96), (10.49, 46.86), (10.40, 46.73), (10.49, 46.62), (10.45, 46.53),
    (10.30, 46.55), (10.16, 46.40), (10.14, 46.23), (10.05, 46.23), (9.95, 46.38),
    (9.71, 46.30), (9.55, 46.30), (9.42, 46.47), (9.28, 46.50), (9.24, 46.23),
    (9.05, 46.02), (9.02, 45.82), (8.93, 45.84), (8.88, 45.93), (8.80, 45.99),
    (8.72, 46.10), (8.60, 46.12), (8.45, 46.25), (8.44, 46.46), (8.30, 46.41),
    (8.08, 46.26), (7.87, 45.93), (7.54, 45.98), (7.30, 45.94), (7.04, 45.92),
    (6.95, 46.05), (6.80, 46.39), (6.60, 46.46), (6.31, 46.37), (6.31, 46.25),
    (6.18, 46.16), (5.96, 46.13),
    (6.06, 46.42), (6.10, 46.58), (6.43, 46.76), (6.70, 47.03), (6.95, 47.24),
    (6.99, 47.50), (7.13, 47.50), (7.20, 47.44), (7.38, 47.43), (7.55, 47.51),
]


def in_ch(lat, lon):
    inside = False
    n = len(CH_POLY)
    for i in range(n):
        x1, y1 = CH_POLY[i]
        x2, y2 = CH_POLY[(i + 1) % n]
        if (y1 > lat) != (y2 > lat):
            xi = x1 + (lat - y1) * (x2 - x1) / (y2 - y1)
            if lon < xi:
                inside = not inside
    return inside


def load(name, default=None):
    p = os.path.join(WORK, name)
    if not os.path.exists(p):
        return default
    with open(p) as f:
        return json.load(f)


def save(name, obj):
    os.makedirs(WORK, exist_ok=True)
    p = os.path.join(WORK, name)
    with open(p + ".tmp", "w") as f:
        json.dump(obj, f, indent=1, ensure_ascii=False)
    os.replace(p + ".tmp", p)
