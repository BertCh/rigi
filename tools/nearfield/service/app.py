"""Near-field service for Step Inside (contract: src/lib/nearfield/types.ts; design: reports/step-inside-design.md).

    tools/nearfield/run.sh [--host 127.0.0.1] [--port 8767]

GET  /health      -> {ok, models, device, licences, loaded, sharp:{available, reason}, cache}
POST /depth       multipart: image, model? (moge2 | moge2b | da3), maxSide? (1024), fovX? (deg, MoGe only),
                  processRes? (da3, 756), nocache? -> NearFieldDepthWire JSON (base64 LE float16 depth/normal, u8 valid)
POST /gaussians   multipart: image, model? (lift | sharp), depthModel? (lift: moge2|moge2b|da3), maxSide?, stride? (2),
                  edgeRatio? (1.5, 0 = keep flying pixels), fovX? (deg), minOpacity? (sharp, 1/255), maxCount? (0 = all)
                  -> application/octet-stream .splat-v1 (camera frame). Headers X-Splat-Count, X-Model, X-Seconds,
                  X-NearField-Meta (JSON: width, height, intrinsicsNorm, fPx, fSource, stride...)
POST /multiview   multipart: images (2..16 parts, or images[]), poses? (JSON {c2w:[16 per image], intrinsicsNorm:[{fx,fy,cx,cy}]}),
                  processRes? (504) -> MultiViewWire JSON (c2w = camera-to-first-camera, row-major, OpenCV)
POST /inpaint     multipart: image (png/jpeg RGB), mask (png; > 127 = hole), maxSide? (1024), dilate? (px, 0), composite? (1)
                  -> image/png, same size as image; only hole pixels change when composite=1. LaMa big-lama (Apache-2.0).
                  Headers X-Model, X-Seconds, X-NearField-Meta (JSON: width, height, holeFrac, procWidth, procHeight,
                  inferSeconds, device, licence). P3 research flag: the output is GENERATED content (see inpaint.py).

Single inference at a time (Manager.lock); ThreadingHTTPServer keeps /health responsive during inference.
Env: NEARFIELD_IDLE_S (300), NEARFIELD_GPU_WAIT_S (900), NEARFIELD_CACHE_MB (1024), NEARFIELD_CACHE_DIR,
     NEARFIELD_DEVICE (mps|cpu|cuda), NEARFIELD_NO_GPU_LOCK=1 (tests only), NEARFIELD_SHARP_CKPT.
"""
from __future__ import annotations

import _env  # noqa: F401  (path setup first)

import argparse
import io
import json
import math
import os
import sys
import time
import traceback
from collections import OrderedDict
from email.parser import BytesParser
from email.policy import HTTP
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
from PIL import Image, ImageOps

import cache
import inpaint
import models
import splat
from models import ServiceError

MAX_BODY = int(os.environ.get("NEARFIELD_MAX_BODY", 512 * 1024 * 1024))  # 16 x 8192 px multiview jobs fit
# Origin allowlist: localhost / 127.0.0.1 / [::1] on any port, plus NEARFIELD_CORS (comma-separated exact origins)
EXTRA_ORIGINS = {o.strip() for o in os.environ.get("NEARFIELD_CORS", "").split(",") if o.strip()}
LOCAL_HOSTS = ("localhost", "127.0.0.1", "[::1]")
# Decompression-bomb cap, checked on the header before any pixel is decoded (16 x 8192 px multiview parts are 67 MP each)
MAX_PIXELS = int(os.environ.get("NEARFIELD_MAX_PIXELS", 100_000_000))


def host_ok(hostport: str | None) -> bool:
    h = (hostport or "").strip().lower()
    if h.startswith("["):
        host, close, port = h.partition("]")
        host += close
        port = port[1:] if port.startswith(":") else port and "x"
    else:
        host, _, port = h.partition(":")
    return host in LOCAL_HOSTS and (port == "" or port.isdigit())


def origin_ok(origin: str) -> bool:
    if origin in EXTRA_ORIGINS:
        return True
    scheme, sep, rest = origin.partition("://")
    return bool(sep) and scheme in ("http", "https") and host_ok(rest)
DEPTH_MODELS = ("moge2", "moge2b", "da3")
MGR: models.Manager | None = None
_raw_depth: OrderedDict[str, dict] = OrderedDict()  # small in-memory cache of raw depth results (for lift)


# ---------- request parsing ----------

def parse_multipart(ctype: str, raw: bytes) -> tuple[dict[str, str], dict[str, list[bytes]]]:
    msg = BytesParser(policy=HTTP).parsebytes(b"Content-Type: " + ctype.encode() + b"\r\n\r\n" + raw)
    fields: dict[str, str] = {}
    files: dict[str, list[bytes]] = {}
    if not msg.is_multipart():
        raise ServiceError(400, "bad_request", "expected multipart/form-data")
    for part in msg.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if not name:
            continue
        data = part.get_payload(decode=True) or b""
        if part.get_filename() is not None or name in ("image", "images", "images[]"):
            files.setdefault(name, []).append(data)
        else:
            fields[name] = data.decode("utf-8", "replace").strip()
            files.setdefault(name, []).append(data)
    return fields, files


def fnum(fields: dict, name: str, default, lo=None, hi=None, cast=float):
    v = fields.get(name)
    if v in (None, ""):
        return default
    try:
        x = float(v)
        if not math.isfinite(x):  # nan passes every range comparison, inf overflows int()
            raise ValueError(v)
        x = cast(x)
    except ValueError as e:
        raise ServiceError(400, "bad_param", f"{name}={v!r} is not a number") from e
    if (lo is not None and x < lo) or (hi is not None and x > hi):
        raise ServiceError(400, "bad_param", f"{name}={x} out of range [{lo}, {hi}]")
    return x


def open_image(b: bytes, what: str = "image") -> Image.Image:
    """Decode with a pixel cap (Image.open is lazy, so the size is known before any pixel is allocated)."""
    try:
        im0 = Image.open(io.BytesIO(b))
        too_big = im0.width * im0.height > MAX_PIXELS
        if not too_big:
            im0.load()
    except Exception as e:  # noqa: BLE001
        raise ServiceError(400, "bad_image" if what == "image" else "bad_mask", f"cannot decode {what}: {e}") from e
    if too_big:
        raise ServiceError(400, "image_too_large", f"{what} is {im0.width}x{im0.height}; the limit is {MAX_PIXELS} pixels")
    return im0


def decode_image(b: bytes, max_side: int | None) -> tuple[np.ndarray, Image.Image]:
    im0 = open_image(b)
    im = ImageOps.exif_transpose(im0).convert("RGB")
    if max_side:
        w, h = im.size
        s = max_side / max(w, h)
        if s < 1:
            im = im.resize((max(1, round(w * s)), max(1, round(h * s))), Image.BICUBIC)
    return np.asarray(im), im0


def resize_to(a: np.ndarray, W: int, H: int) -> np.ndarray:
    import cv2

    if a.shape[1] == W and a.shape[0] == H:
        return a
    return cv2.resize(a.astype(np.float32), (W, H), interpolation=cv2.INTER_NEAREST)


# ---------- inference ----------

def compute_depth(img_bytes: bytes, model: str, max_side: int, fov_x: float | None, process_res: int) -> dict:
    """Raw float32 depth on the maxSide grid of the (EXIF-rotated) photo. Serialised by MGR.lock."""
    with MGR.lock:
        return _compute_depth(img_bytes, model, max_side, fov_x, process_res)


def _compute_depth(img_bytes: bytes, model: str, max_side: int, fov_x: float | None, process_res: int) -> dict:
    k = cache.key("rawdepth", [img_bytes], {"m": model, "s": max_side, "f": fov_x, "p": process_res})
    if k in _raw_depth:
        _raw_depth.move_to_end(k)
        return _raw_depth[k]
    rgb, _ = decode_image(img_bytes, max_side)
    H, W = rgb.shape[:2]
    with MGR.lock:
        net = MGR.get(model)
        t0 = time.time()
        r = net.depth(rgb, fov_x) if model in models.MOGE else net.depth(rgb, process_res)
        MGR.sync()
        sec = time.time() - t0
        MGR.last_used = time.time()
    d = resize_to(r["depth"], W, H)
    valid = resize_to(r["valid"].astype(np.float32), W, H) > 0.5
    nrm = r.get("normal")
    if nrm is not None:
        nrm = resize_to(nrm, W, H)
    out = {"rgb": rgb, "width": W, "height": H, "depth": np.where(valid, d, 0).astype(np.float32), "valid": valid,
           "normal": nrm, "intrinsicsNorm": r.get("intrinsicsNorm"), "model": r["model"], "seconds": sec}
    _raw_depth[k] = out
    while len(_raw_depth) > 4:
        _raw_depth.popitem(last=False)
    return out


def ep_depth(fields, files):
    img = one_image(files)
    model = fields.get("model") or "moge2"
    if model not in DEPTH_MODELS:
        raise ServiceError(400, "bad_model", f"model must be one of {DEPTH_MODELS}")
    max_side = fnum(fields, "maxSide", 1024, 64, 4096, int)
    fov_x = fnum(fields, "fovX", None, 1, 179)
    process_res = fnum(fields, "processRes", 756, 140, 2016, int)
    t0 = time.time()
    r = compute_depth(img, model, max_side, fov_x, process_res)
    wire = {"width": r["width"], "height": r["height"], "model": r["model"], "seconds": round(time.time() - t0, 3),
            "depthF16": splat.f16_b64(r["depth"]), "validU8": splat.u8_b64(r["valid"])}
    if r["intrinsicsNorm"]:
        wire["intrinsicsNorm"] = {k: float(v) for k, v in r["intrinsicsNorm"].items()}
    if r["normal"] is not None:
        wire["normalF16"] = splat.f16_b64(r["normal"])
    return "application/json", {"X-Model": r["model"]}, json.dumps(wire).encode()


def ep_gaussians(fields, files):
    img = one_image(files)
    model = fields.get("model") or "lift"
    t0 = time.time()
    if model == "lift":
        dm = fields.get("depthModel") or "moge2"
        if dm not in DEPTH_MODELS:
            raise ServiceError(400, "bad_model", f"depthModel must be one of {DEPTH_MODELS}")
        max_side = fnum(fields, "maxSide", 1024, 64, 4096, int)
        stride = fnum(fields, "stride", 2, 1, 64, int)
        edge = fnum(fields, "edgeRatio", 1.5, 0, 100)
        fov_x = fnum(fields, "fovX", None, 1, 179)
        r = compute_depth(img, dm, max_side, fov_x, fnum(fields, "processRes", 756, 140, 2016, int))
        K = r["intrinsicsNorm"]
        if K is None:
            raise ServiceError(500, "no_intrinsics", f"{dm} gave no intrinsics")
        g = splat.lift_gaussians(r["rgb"], r["depth"], r["valid"], K, r["normal"], stride=stride, edge_ratio=edge)
        body = splat.encode_splat_v1(g["positions"], g["scales"], g["rotations"], g["colors"], g["provenance"])
        meta = {"width": r["width"], "height": r["height"], "intrinsicsNorm": K, "depthModel": r["model"], "stride": stride,
                "grid": g["grid"], "cells": g["cells"], "depthSeconds": round(r["seconds"], 3)}
        name, n = f"lift/{r['model']}", g["kept"]
    elif model == "sharp":
        ok, why = models.sharp_status()
        if not ok:
            raise ServiceError(501, "sharp_unavailable", why)
        rgb, im0 = decode_image(img, fnum(fields, "maxSide", 4096, 256, 8192, int))
        h, w = rgb.shape[:2]
        fov_x = fnum(fields, "fovX", None, 1, 179)
        if fov_x:
            f_px, fsrc = (w / 2) / np.tan(np.radians(fov_x) / 2), "fovX"
        else:
            f_px, fsrc = models.sharp_fpx_from_exif(im0, w, h)
        min_op = fnum(fields, "minOpacity", 1 / 255, 0, 1)
        max_count = fnum(fields, "maxCount", 0, 0, 50_000_000, int)
        with MGR.lock:
            net = MGR.get("sharp")
            t1 = time.time()
            pos, scl, q, col, op = net.predict(rgb, float(f_px))
            MGR.sync()
            inf_s = time.time() - t1
            MGR.last_used = time.time()
        keep = (op >= min_op) & np.isfinite(pos).all(1) & np.isfinite(scl).all(1)
        idx = np.nonzero(keep)[0]
        if max_count and len(idx) > max_count:
            idx = idx[np.argsort(-op[idx], kind="stable")[:max_count]]
            idx.sort()
        rgba = np.concatenate([np.clip(col[idx] * 255 + 0.5, 0, 255), np.clip(op[idx, None] * 255 + 0.5, 0, 255)], 1).astype(np.uint8)
        body = splat.encode_splat_v1(pos[idx], scl[idx], q[idx], rgba, splat.PROV_RECONSTRUCTED)
        meta = {"width": w, "height": h, "fPx": float(f_px), "fSource": fsrc,
                "intrinsicsNorm": {"fx": float(f_px / w), "fy": float(f_px / h), "cx": 0.5, "cy": 0.5},
                "predicted": int(len(op)), "inferSeconds": round(inf_s, 3), "licence": "research-only (Apple ML Research Model License)"}
        name, n = net.name, len(idx)
    else:
        raise ServiceError(400, "bad_model", "model must be 'lift' or 'sharp'")
    sec = round(time.time() - t0, 3)
    meta["seconds"] = sec
    return "application/octet-stream", {"X-Splat-Count": str(n), "X-Model": name, "X-Seconds": str(sec),
                                        "X-NearField-Meta": json.dumps(meta)}, body


def ep_multiview(fields, files):
    imgs = files.get("images", []) + files.get("images[]", [])
    if not 2 <= len(imgs) <= 16:
        raise ServiceError(400, "bad_request", f"multiview needs 2..16 'images' parts, got {len(imgs)}")
    process_res = fnum(fields, "processRes", 504, 140, 1008, int)
    max_side = fnum(fields, "maxSide", 2048, 256, 8192, int)
    rgbs = [decode_image(b, max_side)[0] for b in imgs]
    ext = intr = None
    poses_raw = (files.get("poses") or files.get("poses.json") or [None])[0]
    if poses_raw:
        try:
            pj = json.loads(poses_raw)
            c2w = np.asarray(pj["c2w"], np.float64).reshape(len(imgs), 4, 4)
            kn = pj["intrinsicsNorm"]
            assert len(kn) == len(imgs)
        except Exception as e:  # noqa: BLE001
            raise ServiceError(400, "bad_poses", f"poses must be JSON {{c2w:[16 per image], intrinsicsNorm:[{{fx,fy,cx,cy}} per image]}}: {e}") from e
        ext = np.linalg.inv(c2w).astype(np.float32)
        intr = np.zeros((len(imgs), 3, 3), np.float32)
        for i, (k, im) in enumerate(zip(kn, rgbs)):
            h, w = im.shape[:2]
            intr[i] = [[k["fx"] * w, 0, k["cx"] * w], [0, k["fy"] * h, k["cy"] * h], [0, 0, 1]]
    t0 = time.time()
    with MGR.lock:
        net = MGR.get("da3")
        p = net.run(rgbs, process_res, ext, intr)
        MGR.sync()
        MGR.last_used = time.time()
    E = np.asarray(p.extrinsics, np.float64)  # world-to-camera, (N,3,4) or (N,4,4)
    if E.shape[-2] == 3:
        E = np.concatenate([E, np.tile([[[0, 0, 0, 1]]], (len(E), 1, 1))], 1)
    w2c0 = E[0]
    cams, depths = [], []
    for i in range(len(imgs)):
        d = np.asarray(p.depth[i], np.float32)
        h, w = d.shape
        valid = np.isfinite(d) & (d > 0)
        if getattr(p, "sky", None) is not None:
            valid &= ~(np.asarray(p.sky[i]) > 0.5)
        K = np.asarray(p.intrinsics[i], np.float64)
        kn = {"fx": K[0, 0] / w, "fy": K[1, 1] / h, "cx": K[0, 2] / w, "cy": K[1, 2] / h}
        c2w_rel = w2c0 @ np.linalg.inv(E[i])
        cams.append({"c2w": [float(x) for x in c2w_rel.reshape(-1)], "intrinsicsNorm": {k: float(v) for k, v in kn.items()}})
        depths.append({"width": w, "height": h, "intrinsicsNorm": cams[-1]["intrinsicsNorm"],
                       "depthF16": splat.f16_b64(np.where(valid, d, 0)), "validU8": splat.u8_b64(valid)})
    wire = {"model": net.name, "cameras": cams, "depths": depths, "seconds": round(time.time() - t0, 3)}
    return "application/json", {"X-Model": net.name}, json.dumps(wire).encode()


def ep_inpaint(fields, files):
    img = one_image(files)
    mk = (files.get("mask") or [None])[0]
    if not mk:
        raise ServiceError(400, "bad_request", "multipart part 'mask' is required")
    ok, why = inpaint.status()
    if not ok:
        raise ServiceError(501, "inpaint_unavailable", why)
    rgb, _ = decode_image(img, None)
    m = np.asarray(open_image(mk, "mask").convert("L"))
    H, W = rgb.shape[:2]
    if m.shape != (H, W):
        raise ServiceError(400, "bad_mask", f"mask {m.shape[1]}x{m.shape[0]} != image {W}x{H}")
    t0 = time.time()
    out, info = inpaint.fill(rgb, m > 127, fnum(fields, "maxSide", 1024, 64, 4096, int), fnum(fields, "dilate", 0, 0, 64, int),
                             fields.get("composite", "1") not in ("0", "false"))
    bio = io.BytesIO()
    Image.fromarray(out).save(bio, "PNG", compress_level=1)
    sec = round(time.time() - t0, 3)
    meta = {"width": W, "height": H, **info, "seconds": sec, "licence": inpaint.LICENCE}
    return "image/png", {"X-Model": inpaint.NAME, "X-Seconds": str(sec), "X-NearField-Meta": json.dumps(meta)}, bio.getvalue()


def one_image(files) -> bytes:
    im = files.get("image")
    if not im or not im[0]:
        raise ServiceError(400, "bad_request", "multipart part 'image' is required")
    return im[0]


def health() -> dict:
    ok_sharp, why = models.sharp_status()
    ok_lama, why_lama = inpaint.status()
    avail = ["moge2", "moge2b", "da3", "lift"] + (["sharp"] if ok_sharp else []) + (["lama"] if ok_lama else [])
    return {"ok": True, "models": avail, "device": MGR.dev, "loaded": MGR.key, "gpuLockHeld": MGR.gpu.held,
            "licences": {**models.LICENCES, "lama": inpaint.LICENCE}, "sharp": {"available": ok_sharp, "reason": why},
            "inpaint": {"available": ok_lama, "reason": why_lama, "loaded": inpaint.LAMA.m is not None},
            "endpoints": {"depth": list(DEPTH_MODELS), "gaussians": ["lift", "sharp"], "multiview": ["da3"], "inpaint": ["lama"]},
            "cache": cache.stats()}


ROUTES = {"/depth": ep_depth, "/gaussians": ep_gaussians, "/multiview": ep_multiview, "/inpaint": ep_inpaint}
CACHE_IMAGES = {"/depth": lambda f: f.get("image", []), "/gaussians": lambda f: f.get("image", []),
                "/multiview": lambda f: f.get("images", []) + f.get("images[]", []) + f.get("poses", []) + f.get("poses.json", []),
                "/inpaint": lambda f: f.get("image", []) + f.get("mask", [])}


class Handler(BaseHTTPRequestHandler):
    server_version = "RigiNearField/1"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quieter
        sys.stderr.write("[nearfield] %s %s\n" % (self.address_string(), fmt % args))

    def _cors(self):
        origin = self.headers.get("Origin")
        if origin and origin_ok(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Expose-Headers", "X-Splat-Count, X-Model, X-Seconds, X-NearField-Meta, X-Cache")
        self.send_header("Access-Control-Max-Age", "600")

    def _send(self, status: int, ctype: str, body: bytes, headers: dict | None = None):
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        if self.close_connection:
            self.send_header("Connection", "close")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _err(self, e: ServiceError):
        self._send(e.status, "application/json", json.dumps({"error": e.code, "message": e.message}).encode())

    def _guard(self) -> bool:
        """Block DNS rebinding (Host must be local) and cross-origin callers (Origin, when sent, must be allowed)."""
        origin = self.headers.get("Origin")
        if not host_ok(self.headers.get("Host")) or (origin and not origin_ok(origin)):
            self.close_connection = True
            self._err(ServiceError(403, "forbidden", "host or origin not allowed"))
            return False
        return True

    def do_OPTIONS(self):  # noqa: N802
        if not self._guard():
            return
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):  # noqa: N802
        if not self._guard():
            return
        if self.path.split("?")[0] in ("/health", "/"):
            self._send(200, "application/json", json.dumps(health()).encode())
        else:
            self._err(ServiceError(404, "not_found", self.path))

    def do_POST(self):  # noqa: N802
        if not self._guard():
            return
        path = self.path.split("?")[0]
        body_unread = True  # an error before the body is read would leave it in the keep-alive stream: close instead
        try:
            fn = ROUTES.get(path)
            if fn is None:
                raise ServiceError(404, "not_found", path)
            try:
                n = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                n = -1
            if n < 0:
                raise ServiceError(400, "bad_length", "Content-Length must be a non-negative integer")
            if n == 0 or n > MAX_BODY:
                raise ServiceError(413 if n > MAX_BODY else 411, "bad_length", f"Content-Length {n}")
            raw = self.rfile.read(n)
            body_unread = False
            fields, files = parse_multipart(self.headers.get("Content-Type", ""), raw)
            nocache = fields.get("nocache") in ("1", "true")
            params = {k: v for k, v in fields.items() if k != "nocache"}
            ck = cache.key(path, CACHE_IMAGES[path](files), params)
            hit = None if nocache else cache.get(ck)
            if hit:
                ctype, hdrs, body = hit
                hdrs = {**hdrs, "X-Cache": "hit"}
            else:
                ctype, hdrs, body = fn(fields, files)
                try:
                    cache.put(ck, ctype, hdrs, body)
                except OSError:  # disk full / unwritable cache dir must not discard a computed result
                    traceback.print_exc()
                hdrs = {**hdrs, "X-Cache": "miss"}
            self._send(200, ctype, body, hdrs)
        except ServiceError as e:
            self.close_connection = self.close_connection or body_unread
            self._err(e)
        except Exception:  # noqa: BLE001
            traceback.print_exc()  # details stay in the service log; the client gets no exception text or paths
            self.close_connection = self.close_connection or body_unread
            self._err(ServiceError(500, "internal", "internal error (see the service log)"))


def main():
    global MGR
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8767)
    a = ap.parse_args()
    MGR = models.Manager()
    # one MPS user at a time: LaMa shares the Manager's lock (a concurrent /inpaint + /multiview crashed Metal with
    # "A command encoder is already encoding to this command buffer", 2026-09-28)
    inpaint.LAMA.lock = MGR.lock
    inpaint.MPS_LOCK = MGR.lock  # LaMa shares the process's single MPS inference lane (see inpaint.py)
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    srv.daemon_threads = True
    print(f"[nearfield] listening on http://{a.host}:{srv.server_address[1]} device={MGR.dev}", file=sys.stderr, flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        MGR.unload()


if __name__ == "__main__":
    main()
