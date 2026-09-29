"""Integration proof for v0.4.0: replay test-run records of tools/bench/final through the running service.

  tools/matcher/.venv/bin/python tools/matcher/server/replay_final.py --port 8766 --arm A|B --out DIR ids...

Arm A → policy v034, arm B → policy t6. The request is built from the same inputs final.py's arms used
(tools/matcher/stage1/s1.Photo, condition "given"): the photo after the harness normalisation (the service
applies its own _upright_jpeg on top, as s1.upright_photo does), meta {lat, lon, altitudeM, positionSource},
prior.vfov when the focal is known (vfovDeg / hfovDeg / focal35mm, same formulas), else no prior (50° hfov,
free focal), yawHint = headingDeg (the weak heading: used by the narrow stage 1 only). No yaw, no gravity.
Writes DIR/<arm>/<id>.json (the service response) and compares confidenceLevel + the selected pose
(|Δ| ≤ 0.01° in yaw, pitch, roll, vfov) with tools/bench/final/out/<arm>/<id>.json. Test ids only with
REPLAY_ALLOW_TEST=1; nothing here tunes anything (the rule is frozen; this only checks equality).
"""
from __future__ import annotations

import argparse
import io
import json
import math
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[3]
MANIFEST = ROOT / "tools/bench/data/manifest.json"
FINAL = ROOT / "tools/bench/final/out"
ADHOC_DEFAULT_HFOV = 50.0
TOL = 0.01


def normalized_bytes(path: Path) -> bytes:
    """tools/matcher/stage1/s1.upright_photo, first step (the harness normalize.py)."""
    im = Image.open(path)
    orient = im.getexif().get(0x0112, 1)
    if not (im.format == "JPEG" and orient == 1 and max(im.size) <= 2048 and im.mode == "RGB"):
        im = ImageOps.exif_transpose(im).convert("RGB")
        s = 2048 / max(im.size)
        if s < 1:
            im = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
        b = io.BytesIO()
        im.save(b, "JPEG", quality=92)
        return b.getvalue()
    return path.read_bytes()


def request_for(e: dict, photo_file: Path, policy: str) -> dict:
    src = Path(e["file"])
    if not src.is_absolute():
        src = (MANIFEST.parent / src) if (MANIFEST.parent / src).exists() else (ROOT / src)
    raw = normalized_bytes(src)
    photo_file.write_bytes(raw)
    # the service's _upright_jpeg geometry (s1.upright_photo second step): size after EXIF transpose, long side ≤ 2048
    im = ImageOps.exif_transpose(Image.open(io.BytesIO(raw)))
    W0, H0 = im.size
    s = 2048 / max(W0, H0)
    if s < 1:
        W0, H0 = round(W0 * s), round(H0 * s)
    aspect = W0 / H0
    prior = {}
    if e.get("vfovDeg"):
        prior["vfov"] = float(e["vfovDeg"])
    elif e.get("hfovDeg"):
        prior["vfov"] = 2 * math.degrees(math.atan(math.tan(math.radians(float(e["hfovDeg"])) / 2) / aspect))
    elif e.get("focal35mm"):
        fpx = e["focal35mm"] * math.hypot(W0, H0) / 43.2666
        prior["vfov"] = 2 * math.degrees(math.atan(H0 / 2 / fpx))
    body = {"photoPath": str(photo_file), "meta": {"lat": e["lat"], "lon": e["lon"], "altitudeM": e.get("altitudeM"),
                                                  "positionSource": e.get("positionSource")},
            "prior": prior, "policy": policy, "timeoutMs": 600_000}
    if e.get("headingDeg") is not None:
        body["yawHint"] = float(e["headingDeg"])
    return body


def post(port: int, body: dict) -> dict:
    data = json.dumps(body).encode()
    for _ in range(200):
        req = urllib.request.Request(f"http://127.0.0.1:{port}/match", data=data, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=900) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as err:
            b = json.loads(err.read() or b"{}")
            if err.code == 503 and (b.get("error") or {}).get("code") == "busy":
                time.sleep(float(err.headers.get("Retry-After", 5)))
                continue
            return {"httpStatus": err.code, **b}
    raise RuntimeError("service busy for too long")


def dang(a, b):
    return (a - b + 540.0) % 360.0 - 180.0


def compare(rec: dict, res: dict) -> dict:
    rp, sp = rec.get("pose"), res.get("pose")
    lv_rec = rec.get("confidenceLevel")
    lv_svc = (res.get("confidenceLevel") or "").upper() or None
    if not rp or not sp:
        return {"poseEqual": rp is None and sp is None, "levelEqual": lv_rec == lv_svc, "levelRecord": lv_rec, "levelService": lv_svc}
    d = {"yaw": abs(dang(sp["yaw"], rp["yaw"]))}
    d.update({k: abs(sp[k] - rp[k]) for k in ("pitch", "roll", "vfov")})
    return {"poseEqual": all(v <= TOL for v in d.values()), "levelEqual": lv_rec == lv_svc, "levelRecord": lv_rec,
            "levelService": lv_svc, "dMax": max(d.values()), "d": d,
            "sourceRecord": rec.get("source"), "sourceService": res.get("selectedSource")}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8766)
    ap.add_argument("--arm", required=True, choices=["A", "B"])
    ap.add_argument("--out", required=True)
    ap.add_argument("--records", default=str(FINAL), help="dir with <arm>/<id>.json (default tools/bench/final/out)")
    ap.add_argument("ids", nargs="+")
    a = ap.parse_args()
    split = json.load(open(ROOT / "tools/bench/split.json"))
    test = set(split["test"])
    man = {e["id"]: e for e in json.load(open(MANIFEST))}
    policy = {"A": "v034", "B": "t6"}[a.arm]
    out = Path(a.out) / a.arm
    out.mkdir(parents=True, exist_ok=True)
    pdir = Path(a.out) / "photos"
    pdir.mkdir(parents=True, exist_ok=True)
    for pid in a.ids:
        if pid in test and os.environ.get("REPLAY_ALLOW_TEST") != "1":
            print(f"{pid}: test id refused (REPLAY_ALLOW_TEST=1)")
            continue
        rec = json.load(open(Path(a.records) / a.arm / f"{pid}.json"))
        body = request_for(man[pid], pdir / f"{pid}.jpg", policy)
        t0 = time.time()
        res = post(a.port, body)
        wall = round(time.time() - t0, 1)
        cmp = compare(rec, res)
        raw = rec.get("raw") or {}
        cmp["inputs"] = {"vfov0Record": raw.get("vfov0"), "vfovRequest": body["prior"].get("vfov"),
                         "vfovService": ((res.get("adhoc") or {}).get("priorUsed") or {}).get("vfov"),
                         "focalKnownRecord": raw.get("focalKnown"), "adhocIdService": (res.get("adhoc") or {}).get("id")}
        json.dump({"id": pid, "arm": a.arm, "policy": policy, "request": body, "wallSec": wall, "compare": cmp, "response": res},
                  open(out / f"{pid}.json", "w"), indent=1)
        print(pid, a.arm, policy, "level", cmp["levelRecord"], cmp["levelService"], "poseEqual", cmp["poseEqual"],
              "dMax", cmp.get("dMax"), "src", rec.get("source"), res.get("selectedSource"), "wall", wall,
              res.get("error") or "", flush=True)


if __name__ == "__main__":
    main()
