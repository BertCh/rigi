"""Pose-propagation relative-rotation service (roadmap R5; default http://127.0.0.1:8769).

The same estimator as the P2 research (run_propagate.py `rot`): ALIKED (2048 kp) + LightGlue on CPU at a
1024 px long side, 2-point pure-rotation RANSAC on bearing vectors (4 px, 2000 iters, seed 0), Kabsch
refinement, plus the backward (B->A) estimate for the fwd/bwd check. It only returns a relative rotation
and its evidence; composing the pose and applying PROPAGATE_GATE happens in the browser
(src/lib/nearfield/propagate.ts), and the result is ALWAYS a suggestion there.

  GET  /health  -> {ok, method, device, cache}
  POST /relrot  JSON {a: <base64 image>, b: <base64 image>, vfovA: deg, vfovB: deg}
                -> {method:"rot", relR:[9], inliers, n, rmsPx, bwd:{relR, inliers, rmsPx} | null,
                    fwdBwdDeg | null, sizeA:[W,H], sizeB:[W,H], seconds}
                relR maps A-camera to B-camera coordinates (OpenCV axes), row-major.
                vfovA = the anchor's ACCEPTED pose vfov; vfovB = the target's EXIF vfov (as in the study).

Differences from the study's load(): EXIF orientation is applied (uploads may carry it; the bundled photos
have none, so they load identically). Results are cached in memory only (the disk is nearly full).

Run: tools/nearfield/propagate/run_service.sh [--port 8769]
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import math
import sys
import threading
import time
import traceback
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import run_propagate as rp  # noqa: E402  (K_of, rot_ransac, lg_models, MAXS: the frozen study code)

MAX_BODY = 60 * 1024 * 1024
LOCK = threading.Lock()  # one CPU inference at a time
FEATS: OrderedDict[str, tuple] = OrderedDict()  # image sha1 -> (PIL image, ALIKED features)
RESULTS: OrderedDict[str, dict] = OrderedDict()
N_FEATS, N_RESULTS = 24, 256


def decode(b64: str) -> tuple[str, Image.Image]:
    raw = base64.b64decode(b64.split(",", 1)[-1])
    h = hashlib.sha1(raw).hexdigest()
    if h in FEATS:
        FEATS.move_to_end(h)
        return h, FEATS[h][0]
    im = ImageOps.exif_transpose(Image.open(io.BytesIO(raw))).convert("RGB")
    s = rp.MAXS / max(im.size)
    if s < 1:
        im = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
    return h, im


def features(h: str, im: Image.Image):
    import torch
    if h in FEATS and FEATS[h][1] is not None:
        return FEATS[h][1]
    ext, _ = rp.lg_models()
    t = torch.from_numpy(np.asarray(im)).permute(2, 0, 1).float()[None] / 255
    f = ext.extract(t)
    FEATS[h] = (im, f)
    FEATS.move_to_end(h)
    while len(FEATS) > N_FEATS:
        FEATS.popitem(last=False)
    return f


def match(fa, fb):
    _, m = rp.lg_models()
    r = m({"image0": fa, "image1": fb})
    mm = r["matches"][0].numpy()
    return fa["keypoints"][0].numpy()[mm[:, 0]], fb["keypoints"][0].numpy()[mm[:, 1]]


def rot_angle(R: np.ndarray) -> float:
    return math.degrees(math.acos(max(-1.0, min(1.0, (np.trace(R) - 1) / 2))))


def relrot(body: dict) -> dict:
    for k in ("a", "b", "vfovA", "vfovB"):
        if k not in body:
            raise ValueError(f"missing field {k}")
    vfa, vfb = float(body["vfovA"]), float(body["vfovB"])
    if not (5 < vfa < 170 and 5 < vfb < 170):
        raise ValueError("vfov out of range")
    ha, a = decode(body["a"])
    hb, b = decode(body["b"])
    key = f"{ha}:{hb}:{vfa:.4f}:{vfb:.4f}"
    if key in RESULTS:
        RESULTS.move_to_end(key)
        return {**RESULTS[key], "cache": "hit"}
    t0 = time.time()
    fa, fb = features(ha, a), features(hb, b)
    KA, KB = rp.K_of(vfa, a.width, a.height), rp.K_of(vfb, b.width, b.height)
    ka, kb = match(fa, fb)
    r = rp.rot_ransac(ka, kb, KA, KB)
    kb2, ka2 = match(fb, fa)
    rb = rp.rot_ransac(kb2, ka2, KB, KA)
    fwd_bwd = rot_angle(rb["R"] @ r["R"]) if (r and rb) else None
    out = {
        "method": "rot",
        "relR": None if r is None else [float(x) for x in np.asarray(r["R"]).ravel()],
        "inliers": 0 if r is None else r["inliers"],
        "n": int(len(ka)),
        "rmsPx": None if r is None else r["rmsPx"],
        "bwd": None if rb is None else {"relR": [float(x) for x in np.asarray(rb["R"]).ravel()],
                                         "inliers": rb["inliers"], "rmsPx": rb["rmsPx"]},
        "fwdBwdDeg": fwd_bwd,
        "sizeA": [a.width, a.height],
        "sizeB": [b.width, b.height],
        "seconds": round(time.time() - t0, 3),
    }
    RESULTS[key] = out
    while len(RESULTS) > N_RESULTS:
        RESULTS.popitem(last=False)
    return {**out, "cache": "miss"}


class Handler(BaseHTTPRequestHandler):
    server_version = "RigiPropagate/1"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("[propagate] %s\n" % (fmt % args))

    def _send(self, status: int, obj: dict):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):  # noqa: N802
        self._send(204, {})

    def do_GET(self):  # noqa: N802
        if self.path.split("?")[0] in ("/health", "/"):
            self._send(200, {"ok": True, "method": "rot", "device": "cpu", "loaded": rp._lg is not None,
                             "cache": {"features": len(FEATS), "results": len(RESULTS)}})
        else:
            self._send(404, {"error": "not_found"})

    def do_POST(self):  # noqa: N802
        if self.path.split("?")[0] != "/relrot":
            return self._send(404, {"error": "not_found"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n <= 0 or n > MAX_BODY:
                return self._send(413, {"error": "bad_length"})
            body = json.loads(self.rfile.read(n))
            with LOCK:
                out = relrot(body)
            self._send(200, out)
        except ValueError as e:
            self._send(400, {"error": "bad_request", "message": str(e)})
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            self._send(500, {"error": "internal", "message": f"{type(e).__name__}: {e}"})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8769)
    a = ap.parse_args()
    import torch
    torch.set_grad_enabled(False)
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    srv.daemon_threads = True
    print(f"[propagate] listening on http://{a.host}:{srv.server_address[1]}", file=sys.stderr, flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
