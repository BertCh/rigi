"""Self-test: start the service on a random port with a throwaway cache, hit every endpoint, validate, print timings.

    tools/matcher/.venv/bin/python tools/nearfield/service/selftest.py [--skip-sharp] [--keep-cache] [--inpaint-only]
Exit code 0 = all checks passed (a 501 from /gaussians?model=sharp counts as pass only if /health says sharp is unavailable).
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(HERE))
import splat  # noqa: E402

PHOTO = ROOT / "public/photos/IMG_7018.jpg"
MV_PHOTOS = [ROOT / "public/photos" / n for n in ("IMG_7018.jpg", "IMG_7033.jpg", "IMG_6971.jpg")]
FAILS: list[str] = []


def check(cond: bool, msg: str):
    print(("  ok   " if cond else "  FAIL ") + msg, flush=True)
    if not cond:
        FAILS.append(msg)


def multipart(fields: dict, files: list[tuple[str, str, bytes]]) -> tuple[bytes, str]:
    b = uuid.uuid4().hex
    out = []
    for k, v in fields.items():
        out.append(f'--{b}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    for name, fn, data in files:
        out.append(f'--{b}\r\nContent-Disposition: form-data; name="{name}"; filename="{fn}"\r\nContent-Type: image/jpeg\r\n\r\n'.encode() + data + b"\r\n")
    out.append(f"--{b}--\r\n".encode())
    return b"".join(out), f"multipart/form-data; boundary={b}"


def post(base, path, fields, files, timeout=900):
    body, ct = multipart(fields, files)
    req = urllib.request.Request(base + path, data=body, headers={"Content-Type": ct}, method="POST")
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, dict(r.headers), r.read(), time.time() - t0
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read(), time.time() - t0


def f16(s: str) -> np.ndarray:
    return np.frombuffer(base64.b64decode(s), "<f2").astype(np.float32)


def u8(s: str) -> np.ndarray:
    return np.frombuffer(base64.b64decode(s), np.uint8)


def check_depth_wire(w: dict, label: str, want_normal: bool):
    W, H = w["width"], w["height"]
    d, v = f16(w["depthF16"]), u8(w["validU8"])
    check(d.size == W * H and v.size == W * H, f"{label}: depth/valid sizes {d.size},{v.size} == {W}x{H}")
    vf = v.astype(bool)
    check(0.05 < vf.mean() <= 1.0, f"{label}: valid fraction {vf.mean():.3f}")
    check(bool(np.isfinite(d[vf]).all() and (d[vf] > 0).all()), f"{label}: valid depths finite and > 0")
    q = np.percentile(d[vf], [5, 50, 95]) if vf.any() else [0, 0, 0]
    print(f"       {label}: {W}x{H} model={w['model']} depth p5/50/95 = {q[0]:.1f}/{q[1]:.1f}/{q[2]:.1f} "
          f"K={json.dumps(w.get('intrinsicsNorm'))} seconds={w['seconds']}")
    if want_normal:
        n = f16(w["normalF16"]) if "normalF16" in w else None
        check(n is not None and n.size == 3 * W * H, f"{label}: normals present, 3*W*H")
        if n is not None and n.size == 3 * W * H:
            nn = np.linalg.norm(n.reshape(-1, 3)[vf], axis=1)
            check(abs(float(np.median(nn)) - 1) < 0.02, f"{label}: normal median length {np.median(nn):.3f} ~ 1")
    return W, H


def check_splat(body: bytes, hdr: dict, label: str, max_count=None):
    g = splat.decode_splat_v1(body)
    n = g["count"]
    check(n > 0 and str(n) == hdr.get("X-Splat-Count"), f"{label}: count {n} matches X-Splat-Count")
    check(g["frame"] == "camera" and g["origin"] == (0.0, 0.0, 0.0), f"{label}: camera frame, zero origin")
    exp = 40 + n * (12 + 12 + 16 + 4 + 1)
    exp = (exp + 3) // 4 * 4
    check(len(body) == exp, f"{label}: byte length {len(body)} == {exp}")
    P = g["positions"].reshape(-1, 3)
    S = g["scales"].reshape(-1, 3)
    Q = g["rotations"].reshape(-1, 4)
    check(bool(np.isfinite(P).all() and np.isfinite(S).all() and np.isfinite(Q).all()), f"{label}: all finite")
    check(float(np.median(P[:, 2])) > 0, f"{label}: median z {np.median(P[:, 2]):.2f} > 0 (in front of camera)")
    check(bool((S > 0).all()), f"{label}: scales > 0 (linear)")
    qn = np.linalg.norm(Q, axis=1)
    check(bool(np.abs(qn - 1).max() < 1e-3), f"{label}: unit quaternions (max dev {np.abs(qn - 1).max():.2e})")
    check(bool((g["provenance"] == splat.PROV_RECONSTRUCTED).all()), f"{label}: provenance = reconstructed")
    if max_count:
        check(n <= max_count, f"{label}: count <= {max_count}")
    meta = json.loads(hdr.get("X-NearField-Meta", "{}"))
    print(f"       {label}: N={n:,} bytes={len(body)/1e6:.1f}MB z p5/50/95={np.percentile(P[:, 2], [5, 50, 95]).round(2).tolist()} "
          f"scale med={np.median(S, 0).round(4).tolist()} alpha med={int(np.median(g['colors'][3::4]))} meta={json.dumps(meta)[:300]}")


def _inpaint_files(with_arrays=False):
    from io import BytesIO

    from PIL import Image

    im = Image.open(PHOTO).convert("RGB")
    im.thumbnail((640, 640))
    rgb = np.asarray(im)
    H, W = rgb.shape[:2]
    hole = np.zeros((H, W), bool)
    hole[H // 3: H // 3 + H // 5, W // 4: W // 4 + W // 4] = True  # a block in the middle of the terrain
    hole[:, -W // 10:] = True  # an out-of-frustum strip on the right
    pbio, mbio = BytesIO(), BytesIO()
    im.save(pbio, "PNG")
    Image.fromarray((hole * 255).astype(np.uint8)).save(mbio, "PNG")
    files = [("image", "view.png", pbio.getvalue()), ("mask", "mask.png", mbio.getvalue())]
    return (files, rgb, hole) if with_arrays else files


class _InpaintOnlyDone(Exception):
    pass


def check_inpaint(base, h, timings):
    """POST /inpaint (LaMa): only hole pixels change, the fill is not a flat colour, cache hit on repeat, 400s on bad input."""
    from io import BytesIO

    from PIL import Image

    files, rgb, hole = _inpaint_files(with_arrays=True)
    H, W = hole.shape
    if not h.get("inpaint", {}).get("available"):
        st, hdr, body, dt = post(base, "/inpaint", {}, files)
        check(st == 501, f"/inpaint unavailable -> 501 ({st})")
        return
    st, hdr, body, dt = post(base, "/inpaint", {}, files)
    check(st == 200 and hdr.get("Content-Type") == "image/png", f"/inpaint: status {st} {body[:200] if st != 200 else ''}")
    timings["inpaint 640px (cold, incl. load)"] = dt
    if st != 200:
        return
    out = np.asarray(Image.open(BytesIO(body)).convert("RGB"))
    meta = json.loads(hdr["X-NearField-Meta"])
    check(out.shape == rgb.shape, f"/inpaint: output size {out.shape} == input {rgb.shape}")
    check(bool((out[~hole] == rgb[~hole]).all()), "/inpaint composite: every non-hole pixel is unchanged")
    fill = out[hole].astype(np.float32)
    check(float(fill.std()) > 3.0, f"/inpaint: the fill is not flat (std {fill.std():.1f})")
    diff = np.abs(out[hole].astype(int) - rgb[hole].astype(int)).mean()
    check(diff > 1.0, f"/inpaint: hole pixels changed (mean |diff| {diff:.1f})")
    check(abs(meta["holeFrac"] - hole.mean()) < 1e-3 and "Apache" in meta["licence"], f"/inpaint meta holeFrac {meta['holeFrac']} + licence")
    print(f"       inpaint: {W}x{H} hole {hole.mean():.3f} proc {meta['procWidth']}x{meta['procHeight']} "
          f"device={meta['device']} infer={meta['inferSeconds']}s")
    st, hdr, body2, dt = post(base, "/inpaint", {}, files)
    check(st == 200 and hdr.get("X-Cache") == "hit" and body2 == body, "/inpaint repeat is a cache hit")
    st, hdr, body3, dt = post(base, "/inpaint", {"composite": "0", "nocache": "1"}, files)
    check(st == 200, f"/inpaint composite=0: status {st}")
    timings["inpaint 640px (warm)"] = dt
    st, *_ = post(base, "/inpaint", {}, files[:1])
    check(st == 400, f"/inpaint without mask -> 400 ({st})")
    bad = BytesIO()
    Image.fromarray(np.zeros((10, 10), np.uint8)).save(bad, "PNG")
    st, *_ = post(base, "/inpaint", {}, [files[0], ("mask", "m.png", bad.getvalue())])
    check(st == 400, f"/inpaint mask size mismatch -> 400 ({st})")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-sharp", action="store_true")
    ap.add_argument("--keep-cache", action="store_true")
    ap.add_argument("--inpaint-only", action="store_true", help="health + /inpaint only (no depth / splat models)")
    a = ap.parse_args()
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    cdir = tempfile.mkdtemp(prefix="nf_selftest_cache_")
    env = {**os.environ, "NEARFIELD_CACHE_DIR": cdir, "PYTHONDONTWRITEBYTECODE": "1", "PYTORCH_ENABLE_MPS_FALLBACK": "1", "HF_HUB_OFFLINE": "1"}
    log = open(Path(cdir) / "server.log", "w")
    proc = subprocess.Popen([sys.executable, str(HERE / "app.py"), "--port", str(port)], env=env, stdout=log, stderr=subprocess.STDOUT)
    timings = {}
    try:
        t0 = time.time()
        while True:
            try:
                with urllib.request.urlopen(base + "/health", timeout=2) as r:
                    h = json.loads(r.read())
                break
            except Exception:  # noqa: BLE001
                if proc.poll() is not None or time.time() - t0 > 60:
                    raise SystemExit("server did not start; log: " + (Path(cdir) / "server.log").read_text()[-3000:])
                time.sleep(0.3)
        timings["startup"] = time.time() - t0
        print(f"[health] {json.dumps(h)[:600]}")
        check(h["ok"] and h["device"] in ("mps", "cpu", "cuda"), "health ok + device")
        check("licences" in h and "sharp" in h["licences"], "health lists licences")

        # CORS preflight
        req = urllib.request.Request(base + "/depth", method="OPTIONS", headers={"Origin": "http://localhost:3100"})
        with urllib.request.urlopen(req) as r:
            check(r.status == 204 and r.headers.get("Access-Control-Allow-Origin") == "*", "CORS preflight 204 + ACAO *")

        check_inpaint(base, h, timings)
        if a.inpaint_only:
            raise _InpaintOnlyDone

        img = PHOTO.read_bytes()
        for model, normal in (("moge2", True), ("moge2b", True), ("da3", False)):
            st, hdr, body, dt = post(base, "/depth", {"model": model}, [("image", PHOTO.name, img)])
            check(st == 200, f"/depth {model}: status {st} {body[:200] if st != 200 else ''}")
            if st == 200:
                check(hdr.get("Access-Control-Allow-Origin") == "*", f"/depth {model}: CORS header")
                check_depth_wire(json.loads(body), f"/depth {model}", normal)
            timings[f"depth {model} (cold, incl. load)"] = dt
        st, hdr, body, dt = post(base, "/depth", {"model": "moge2"}, [("image", PHOTO.name, img)])
        check(st == 200 and hdr.get("X-Cache") == "hit", f"/depth moge2 repeat is a disk-cache hit ({hdr.get('X-Cache')})")
        timings["depth moge2 (cache hit)"] = dt
        st, hdr, body, dt = post(base, "/depth", {"model": "moge2", "maxSide": "768", "fovX": "60"}, [("image", PHOTO.name, img)])
        check(st == 200, f"/depth moge2 maxSide=768 fovX=60: status {st}")
        if st == 200:
            w = json.loads(body)
            check(max(w["width"], w["height"]) == 768, f"maxSide respected ({w['width']}x{w['height']})")
            fx_exp = 0.5 / np.tan(np.radians(30))
            check(abs(w["intrinsicsNorm"]["fx"] - fx_exp) < 0.02, f"fovX honoured: fx_norm {w['intrinsicsNorm']['fx']:.3f} ~ {fx_exp:.3f}")
        timings["depth moge2 768 (reload after da3)"] = dt

        # /inpaint (LaMa) and /depth (MoGe) at the same time: both use MPS; they must be serialised in-process
        # (an overlap aborted the service with an MTLCommandBuffer assertion before inpaint.MPS_LOCK existed)
        import threading

        res = {}

        def _dep():
            res[f"d{threading.get_ident()}"] = post(base, "/depth", {"model": "moge2", "nocache": "1", "maxSide": "640"}, [("image", PHOTO.name, img)])

        def _inp():
            res["i"] = post(base, "/inpaint", {"nocache": "1"}, _inpaint_files())

        ths = [threading.Thread(target=f) for f in (_dep, _inp, _dep)]
        for t_ in ths:
            t_.start()
        for t_ in ths:
            t_.join()
        sts = {k: v[0] for k, v in res.items()}
        check(all(v == 200 for v in sts.values()) and len(sts) == 3,
              f"concurrent /depth x2 + /inpaint: {sts} {[v[2][:200] for v in res.values() if v[0] != 200]}")
        with urllib.request.urlopen(base + "/health", timeout=5) as r:
            check(json.loads(r.read())["ok"], "service alive after concurrent MPS requests")

        st, hdr, body, dt = post(base, "/gaussians", {"model": "lift"}, [("image", PHOTO.name, img)])
        check(st == 200, f"/gaussians lift: status {st} {body[:200] if st != 200 else ''}")
        if st == 200:
            meta = json.loads(hdr["X-NearField-Meta"])
            check_splat(body, hdr, "/gaussians lift", max_count=meta["cells"])
        timings["gaussians lift (moge2 depth from RAM)"] = dt
        st, hdr, body, dt = post(base, "/gaussians", {"model": "lift", "stride": "4", "depthModel": "moge2"}, [("image", PHOTO.name, img)])
        check(st == 200, f"/gaussians lift stride=4: status {st}")
        if st == 200:
            check_splat(body, hdr, "/gaussians lift s4")
        timings["gaussians lift stride4 (moge2 depth from RAM)"] = dt

        if not a.skip_sharp:
            st, hdr, body, dt = post(base, "/gaussians", {"model": "sharp"}, [("image", PHOTO.name, img)])
            if h["sharp"]["available"]:
                check(st == 200, f"/gaussians sharp: status {st} {body[:300] if st != 200 else ''}")
                if st == 200:
                    check_splat(body, hdr, "/gaussians sharp")
            else:
                check(st == 501, f"/gaussians sharp unavailable -> 501 ({body[:200]!r})")
            timings["gaussians sharp (cold, incl. load)"] = dt
            if st == 200:
                st, hdr, body, dt = post(base, "/gaussians", {"model": "sharp", "fovX": "65", "maxCount": "500000"}, [("image", PHOTO.name, img)])
                check(st == 200, f"/gaussians sharp fovX=65 maxCount=500000: status {st}")
                if st == 200:
                    check_splat(body, hdr, "/gaussians sharp capped", max_count=500000)
                timings["gaussians sharp (warm)"] = dt

        mv = [("images", p.name, p.read_bytes()) for p in MV_PHOTOS]
        st, hdr, body, dt = post(base, "/multiview", {}, mv)
        check(st == 200, f"/multiview x3: status {st} {body[:300] if st != 200 else ''}")
        if st == 200:
            w = json.loads(body)
            check(len(w["cameras"]) == 3 and len(w["depths"]) == 3, "multiview: 3 cameras + 3 depths")
            c0 = np.array(w["cameras"][0]["c2w"]).reshape(4, 4)
            check(np.allclose(c0, np.eye(4), atol=1e-4), "multiview: camera 0 c2w == identity")
            for i, (c, d) in enumerate(zip(w["cameras"], w["depths"])):
                M = np.array(c["c2w"]).reshape(4, 4)
                R = M[:3, :3]
                check(np.allclose(R @ R.T, np.eye(3), atol=1e-3), f"multiview cam{i}: rotation orthonormal")
                dd = f16(d["depthF16"])
                check(dd.size == d["width"] * d["height"], f"multiview depth{i}: size {d['width']}x{d['height']}")
                ang = np.degrees(np.arccos(np.clip((np.trace(R) - 1) / 2, -1, 1)))
                print(f"       cam{i}: t={M[:3, 3].round(3).tolist()} rot={ang:.1f}deg K={c['intrinsicsNorm']}")
        timings["multiview x3 da3 (reload)"] = dt

        # sanity of the pose convention: two overlapping crops of one photo must come back with a small relative rotation
        from io import BytesIO

        from PIL import Image

        im = Image.open(PHOTO).convert("RGB")
        W0, H0 = im.size
        crops = []
        for x0 in (0, int(W0 * 0.08)):
            bio = BytesIO()
            im.crop((x0, 0, x0 + int(W0 * 0.92), H0)).save(bio, "JPEG", quality=92)
            crops.append(("images", f"crop{x0}.jpg", bio.getvalue()))
        st, hdr, body, dt = post(base, "/multiview", {}, crops)
        check(st == 200, f"/multiview crops: status {st}")
        if st == 200:
            M = np.array(json.loads(body)["cameras"][1]["c2w"]).reshape(4, 4)
            ang = float(np.degrees(np.arccos(np.clip((np.trace(M[:3, :3]) - 1) / 2, -1, 1))))
            print(f"       crops: cam1 t={M[:3, 3].round(3).tolist()} rot={ang:.2f}deg")
            check(ang < 15, f"multiview crops: relative rotation {ang:.1f}deg < 15 (pose convention sane)")
            # the second crop is shifted right, so its forward axis (c2w column 2) must point to +x in camera 0 (OpenCV)
            check(M[0, 2] > 0, f"multiview crops: right-shifted crop looks to +x (fwd={M[:3, 2].round(3).tolist()})")
        timings["multiview 2 crops (warm)"] = dt

        # known poses are passed to DA3 (Umeyama path, needs the evo shim in _env.py) and echoed back relative to cam 0
        th = np.radians(20)
        c2w1 = np.eye(4)
        c2w1[:3, :3] = [[np.cos(th), 0, np.sin(th)], [0, 1, 0], [-np.sin(th), 0, np.cos(th)]]
        c2w1[:3, 3] = [0.5, 0, 0]
        kn = {"fx": 0.8, "fy": 0.8 * (W0 * 0.92) / H0, "cx": 0.5, "cy": 0.5}
        poses = json.dumps({"c2w": [np.eye(4).ravel().tolist(), c2w1.ravel().tolist()], "intrinsicsNorm": [kn, kn]})
        st, hdr, body, dt = post(base, "/multiview", {"poses": poses}, crops)
        check(st == 200, f"/multiview with poses: status {st} {body[:300] if st != 200 else ''}")
        if st == 200:
            M = np.array(json.loads(body)["cameras"][1]["c2w"]).reshape(4, 4)
            check(np.allclose(M, c2w1, atol=1e-3), f"multiview poses: cam1 c2w echoes the given pose (max err {np.abs(M - c2w1).max():.2e})")
        timings["multiview 2 crops + poses"] = dt

        st, hdr, body, dt = post(base, "/depth", {"model": "nope"}, [("image", PHOTO.name, img)])
        check(st == 400, f"bad model -> 400 ({st})")
        st, hdr, body, dt = post(base, "/depth", {}, [("image", "x.jpg", b"not a jpeg")])
        check(st == 400, f"bad image -> 400 ({st})")

        with urllib.request.urlopen(base + "/health") as r:
            h2 = json.loads(r.read())
        print(f"[health after] loaded={h2['loaded']} gpuLockHeld={h2['gpuLockHeld']} cache={h2['cache']}")
    except _InpaintOnlyDone:
        pass
    finally:
        proc.terminate()
        try:
            proc.wait(20)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()
        if not a.keep_cache:
            import shutil

            shutil.rmtree(cdir, ignore_errors=True)
        else:
            print("cache + server log kept in", cdir)
    print("\n[timings]")
    for k, v in timings.items():
        print(f"  {k:42s} {v:7.2f}s")
    print(f"\n{'PASS' if not FAILS else 'FAIL'}: {len(FAILS)} failed checks")
    for f in FAILS:
        print("  -", f)
    sys.exit(1 if FAILS else 0)


if __name__ == "__main__":
    main()
