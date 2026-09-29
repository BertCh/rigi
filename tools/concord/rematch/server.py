"""WP-G: render → re-match → re-solve loop, as a separate service on :8768 (stdlib HTTP, no new deps).

  tools/matcher/.venv/bin/python -B tools/concord/rematch/server.py [--port 8768] [--host 127.0.0.1]
  env: APP_URL (dev server, default http://localhost:3100), REMATCH_KEEP_WARM=1 (keep Chromium between
       requests; default off, Chromium is closed after every request and the render lock released)

Imports the matcher's building blocks (tools/matcher/match.py via tools/matcher/server/core.py:
ALIKED extract, LightGlue on CPU, lift, rotation RANSAC+LM) without editing them, and drives the
matcher's own render worker (tools/matcher/server/render_worker.mjs, protocol in its header) in a
private process group. Renders hold the machine-wide out/.render-lock (scripts/gpu/with-render-lock.mjs
semantics; a lock already held by an ancestor process, e.g. `with-render-lock -- rematch-eval`, counts).

POST /rematch   multipart/form-data: photo (JPEG/PNG), request (JSON):
    {cam: CameraX, lat, lon, photoId?, frameOrigin?: {lat, lon, alt}, tiles?: 4|6, iterations?: 1|2|3,
     mask?: bool, maskMode?: "lift"|"drop", minRangeM?, maxKp?}
  cam.eye and every returned world point are in frameOrigin's ENU frame (src/lib/geodesy.ts EnuFrame
  convention); default = the engine frame (photo lat/lon, h = 0).
  → {ok, iterations: [{n, medPx, coverage:{quadrants, bands}, nLower, views, changePx, ms}],
     inliers: [{u, v, ur, vr, world, resPx, cls?, depthM, liftM, iter, view}], cam, timingMs, notes}
GET /health
Loop: iteration 1 matches the full frame at cam; iteration k ≥ 2 re-renders the full frame plus
`tiles` narrow views at the refined rotation and re-matches (the AdHoP-style zoomed re-render). The
rotation is re-solved every iteration with the eye fixed at cam.eye (moving the eye is WP-D's job).
Stops when the median change is < 0.5 px @1600 or after `iterations`.
"""
from __future__ import annotations

import argparse
import io
import json
import math
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from email.parser import BytesParser
from email.policy import HTTP
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
MATCHER_SERVER = ROOT / "tools" / "matcher" / "server"
for p in (str(HERE), str(MATCHER_SERVER)):
    if p not in sys.path:
        sys.path.insert(0, p)

import numpy as np  # noqa: E402
import poselib  # noqa: E402
from PIL import Image, ImageOps  # noqa: E402

import core  # noqa: E402  tools/matcher/server/core.py (read-only import)
import mask as MASK  # noqa: E402
import tiles as T  # noqa: E402

M = core.M
VERSION = "concord-rematch/0.1.0 (WP-G)"
LOCK_DIR = ROOT / "out" / ".render-lock"
WORKER_JS = MATCHER_SERVER / "render_worker.mjs"
OUT_TMP = ROOT / "out" / "concord" / "rematch" / "tmp"
INLIER_PX = 8.0  # px @1600, 6-DoF RANSAC inlier threshold (the matcher uses 6 px @1024 ≈ 9.4 @1600)
DEDUP_PX = 3.0  # px @1600 grid for merging matches seen in overlapping views
MIN_RANGE_M = 100.0
JOB = threading.Lock()
DEBUG_DIR = Path(os.environ["REMATCH_DEBUG_DIR"]) if os.environ.get("REMATCH_DEBUG_DIR") else None


def log(*a):
    print("[rematch]", *a, file=sys.stderr, flush=True)


# ---------------------------------------------------------------- render lock


def _ancestors() -> set[int]:
    out, pid = set(), os.getpid()
    for _ in range(64):
        try:
            ppid = int(subprocess.run(["ps", "-o", "ppid=", "-p", str(pid)], capture_output=True, text=True).stdout)
        except ValueError:
            break
        if ppid <= 1 or ppid in out:
            break
        out.add(ppid)
        pid = ppid
    return out


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError):
        return False


class RenderLock:
    """out/.render-lock (mkdir-atomic). Re-entrant for a lock held by one of our ancestors."""

    def __init__(self):
        self.mine = False

    def acquire(self, timeout_s: float = 1800):
        t0 = time.time()
        anc = _ancestors()
        while True:
            try:
                LOCK_DIR.mkdir(parents=False)
                (LOCK_DIR / "owner").write_text(f"{os.getpid()} concord-rematch server")
                self.mine = True
                return
            except FileExistsError:
                try:
                    pid = int((LOCK_DIR / "owner").read_text().split()[0])
                except (OSError, ValueError, IndexError):
                    pid = 0
                if pid in anc:
                    self.mine = False
                    return
                if pid and not _alive(pid):
                    import shutil

                    shutil.rmtree(LOCK_DIR, ignore_errors=True)
                    continue
                if time.time() - t0 > timeout_s:
                    raise TimeoutError(f"render lock held by pid {pid}")
                time.sleep(2)

    def release(self):
        if self.mine:
            import shutil

            shutil.rmtree(LOCK_DIR, ignore_errors=True)
            self.mine = False


# ---------------------------------------------------------------- render worker (private process group)


class Worker:
    def __init__(self, port: int):
        env = {**os.environ, "MATCHER_PORT": str(port)}
        self.p = subprocess.Popen(
            ["node", str(WORKER_JS)],
            cwd=ROOT,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
            env=env,
            start_new_session=True,
        )
        self.n = 0

    def call(self, req: dict, timeout: float = 600) -> dict:
        self.n += 1
        req = {**req, "id": self.n}
        self.p.stdin.write(json.dumps(req) + "\n")
        self.p.stdin.flush()
        box: dict = {}

        def rd():
            while True:
                line = self.p.stdout.readline()
                if not line:
                    box["r"] = {"ok": False, "error": "worker exited"}
                    return
                try:
                    r = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if r.get("id") == self.n:
                    box["r"] = r
                    return

        th = threading.Thread(target=rd, daemon=True)
        th.start()
        th.join(timeout)
        if "r" not in box:
            self.close()
            raise TimeoutError(f"render worker timed out after {timeout}s")
        if not box["r"].get("ok"):
            raise RuntimeError(f"render worker: {box['r'].get('error')}")
        return box["r"]

    def close(self):
        try:
            os.killpg(self.p.pid, signal.SIGTERM)
            self.p.wait(5)
        except Exception:  # noqa: BLE001
            try:
                os.killpg(self.p.pid, signal.SIGKILL)
            except Exception:  # noqa: BLE001
                pass


class Renderer:
    def __init__(self, port: int):
        self.port = port
        self.w: Worker | None = None
        self.lock = RenderLock()

    def begin(self):
        self.lock.acquire()
        if self.w is None or self.w.p.poll() is not None:
            self.w = Worker(self.port)

    def end(self, keep: bool):
        if not keep and self.w is not None:
            self.w.close()
            self.w = None
        if not keep:
            self.lock.release()

    def render(self, base: dict, poses: list[dict], out_dir: Path) -> tuple[dict, list[core.View], dict]:
        r = self.w.call({**base, "cmd": "render", "poses": poses, "outDir": str(out_dir), "allowEmpty": True, "texUpload": True})
        views = []
        for v in r["views"]:
            W, H = v["W"], v["H"]
            xyz = np.fromfile(v["xyz"], np.float32).reshape(H, W, 3)
            rgb = np.array(Image.open(v["rgb"]).convert("RGB"))
            views.append(core.View(v["tag"], v["pose"], rgb, xyz))
        return r["meta"], views, r.get("timing", {})


# ---------------------------------------------------------------- matching


def match_view(photo: np.ndarray, cam_eng: T.Cam, v: core.View, eye: np.ndarray, max_kp: int, min_range: float):
    """Warp the photo into view v, ALIKED+LightGlue, lift render keypoints. → (photo uv, world, render px)."""
    H, W = v.xyz.shape[:2]
    pw, valid = T.warp_photo(photo, cam_eng, v.pose, W, H)
    if DEBUG_DIR is not None:
        DEBUG_DIR.mkdir(parents=True, exist_ok=True)
        stem = f"{int(time.time() * 1000) % 10**8}_{v.tag}"
        Image.fromarray(pw).save(DEBUG_DIR / f"{stem}_photo.jpg", quality=85)
        Image.fromarray(v.rgb).save(DEBUG_DIR / f"{stem}_render.jpg", quality=85)
    if valid.mean() < 0.05:
        return np.zeros((0, 2)), np.zeros((0, 3)), np.zeros((0, 2))
    fp = core.top_k(M.extract(core.KIND, pw), max_kp)
    fr = core.top_k(M.extract(core.KIND, v.rgb), max_kp)
    k0, k1 = core.lg_match(fp, fr)
    if len(k0) == 0:
        return np.zeros((0, 2)), np.zeros((0, 3)), np.zeros((0, 2))
    xi = np.clip(np.round(k0[:, 0]).astype(int), 0, W - 1)
    yi = np.clip(np.round(k0[:, 1]).astype(int), 0, H - 1)
    inside = valid[yi, xi]
    X, ok = M.lift(k1, v.xyz, eye, min_range)
    ok &= inside
    uv = T.view_px_to_photo_uv(cam_eng, v.pose, W, H, k0[ok] + 0.5)
    return uv, X[ok].astype(np.float64), k1[ok] + 0.5


def dedup(uv: np.ndarray, cam: T.Cam) -> np.ndarray:
    W, H = T.px1600(cam)
    key = np.floor(uv[:, 0] * W / DEDUP_PX).astype(np.int64) * 100000 + np.floor(uv[:, 1] * H / DEDUP_PX).astype(
        np.int64
    )
    _, first = np.unique(key, return_index=True)
    keep = np.zeros(len(uv), bool)
    keep[first] = True
    return keep


def solve_iteration(uv: np.ndarray, X: np.ndarray, cam: T.Cam) -> tuple[T.Cam, np.ndarray, np.ndarray]:
    """6-DoF LO-RANSAC (PoseLib, known focal) classifies inliers — it tolerates eye error, so near points
    with parallax survive; then the rotation is re-fitted with the eye FIXED (M.solve_rotation) on those
    inliers. Returns (refined cam, inlier mask, residual px @1600 under the refined cam)."""
    Wb, Hb = T.px1600(cam)
    Wb, Hb = int(round(Wb)), int(round(Hb))
    n = len(uv)
    if n < 8:
        return cam, np.zeros(n, bool), np.full(n, np.inf)
    x2d = T.ideal_px(cam, uv, Wb, Hb)
    f0 = core.focal_px(cam.pose["vfov"], Hb)
    pc = {"model": "PINHOLE", "width": Wb, "height": Hb, "params": [f0, f0, Wb / 2, Hb / 2]}
    try:
        _pose, info = poselib.estimate_absolute_pose(
            x2d, X - cam.eye, pc, {"max_reproj_error": INLIER_PX, "max_iterations": 5000}, {}
        )
        inl = np.array(info["inliers"], bool)
        shift = float(np.linalg.norm(-_pose.R.T @ _pose.t))
    except Exception as e:  # noqa: BLE001
        log("poselib failed:", e)
        inl, shift = np.zeros(n, bool), math.inf
    if inl.sum() < 8 or shift > 300:
        s = M.solve_rotation(x2d, X, cam.eye, Wb, Hb, f0, False, thr=INLIER_PX)
        inl = s["inliers"] if s is not None else np.zeros(n, bool)
    s = M.solve_rotation(x2d[inl], X[inl], cam.eye, Wb, Hb, f0, False, thr=INLIER_PX * 2) if inl.sum() >= 6 else None
    new = cam
    if s is not None:
        pose = core.R_to_pose(s["R"], cam.pose["vfov"])
        new = cam.with_pose(pose)
    pr, front = T.project(new, X)
    res = np.hypot((pr[:, 0] - uv[:, 0]) * Wb, (pr[:, 1] - uv[:, 1]) * Hb)
    res[~front] = np.inf
    return new, inl, res


# ---------------------------------------------------------------- request


def pose_json(p: dict) -> dict:
    return {k: float(p[k]) for k in ("yaw", "pitch", "roll", "vfov")}


def rematch(renderer: Renderer, photo: np.ndarray, req: dict) -> dict:
    t_all = time.time()
    notes: list[str] = []
    n_tiles = int(req.get("tiles", 6))
    if n_tiles not in (4, 6):
        raise ValueError("tiles must be 4 or 6")
    n_iter = int(req.get("iterations", 2))
    if n_iter not in (1, 2, 3):
        raise ValueError("iterations must be 1, 2 or 3")
    use_mask = bool(req.get("mask", False))
    mask_mode = req.get("maskMode", "drop")
    max_kp = int(req.get("maxKp", 2048))
    min_range = float(req.get("minRangeM", MIN_RANGE_M))
    photo_id = req.get("photoId")
    if photo_id is None:
        raise ValueError("photoId is required (ad-hoc photos: not implemented in v0.1; see RESULT.txt)")
    base = {"photoId": photo_id}
    timing: dict = {"renderMs": 0, "matchMs": 0, "solveMs": 0, "maskMs": 0}
    keep = os.environ.get("REMATCH_KEEP_WARM") == "1"
    OUT_TMP.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="rm-", dir=OUT_TMP))
    t_lock = time.time()
    renderer.begin()
    timing["lockWaitMs"] = round((time.time() - t_lock) * 1000)
    try:
        cam_in = T.Cam.from_json(req["cam"])
        # iteration-1 render first: it tells us the engine frame and eye
        t0 = time.time()
        meta, views, rt = renderer.render(base, [{"tag": "full1", **pose_json(cam_in.pose)}], tmp / "i1")
        timing["renderMs"] += round((time.time() - t0) * 1000)
        timing["pageLoadMs"] = rt.get("loadMs")
        fe = meta["frame"]
        eng = T.EnuFrame(fe["lat"], fe["lon"], fe["h"])
        fo = req.get("frameOrigin")
        usr = T.EnuFrame(fo["lat"], fo["lon"], fo["alt"]) if fo else eng
        to_eng, to_usr = T.frame_converter(usr, eng), T.frame_converter(eng, usr)
        eye_eng = to_eng(cam_in.eye)[0]
        cam = T.Cam(dict(cam_in.pose), eye_eng, cam_in.aspect, dict(cam_in.intr))
        render_eye = np.array(meta["eye"], float)
        d_eye = float(np.linalg.norm(render_eye - eye_eng))
        if d_eye > 1.0:
            notes.append(f"renders use the app eye, {d_eye:.1f} m from cam.eye (lifting is exact; appearance only)")
        if abs(meta["aspect"] - cam.aspect) > 1e-3:
            notes.append(f"cam.aspect {cam.aspect:.4f} != engine aspect {meta['aspect']:.4f}")

        iters, final = [], None
        prev = cam
        for it in range(1, n_iter + 1):
            ti = time.time()
            if it > 1:
                specs = [T.ViewSpec("full", dict(prev.pose))] + T.tile_views(prev, n_tiles)
                t0 = time.time()
                _, views, _ = renderer.render(
                    base, [{"tag": s.tag, **pose_json(s.pose)} for s in specs], tmp / f"i{it}"
                )
                timing["renderMs"] += round((time.time() - t0) * 1000)
            t0 = time.time()
            UV, XX, TAG, per_view = [], [], [], {}
            for v in views:
                uv, X, _rpx = match_view(photo, prev, v, prev.eye, max_kp, min_range)
                per_view[v.tag] = int(len(uv))
                UV.append(uv)
                XX.append(X)
                TAG += [v.tag] * len(uv)
            timing["matchMs"] += round((time.time() - t0) * 1000)
            uv = np.concatenate(UV) if UV else np.zeros((0, 2))
            X = np.concatenate(XX) if XX else np.zeros((0, 3))
            tag = np.array(TAG, object)
            k = dedup(uv, prev) if len(uv) else np.zeros(0, bool)
            uv, X, tag = uv[k], X[k], tag[k]
            # semantic classes (always computed; applied to the solve only with mask=true)
            t0 = time.time()
            rng = np.linalg.norm(X - prev.eye, axis=1)
            lat, lon = eng.to_latlon(X) if len(X) else (np.zeros(0), np.zeros(0))
            Xl, keepm, cls, mst = MASK.apply_mask(X, lat, lon, rng, mask_mode)
            lift_m = Xl[:, 2] - X[:, 2]
            timing["maskMs"] += round((time.time() - t0) * 1000)
            if use_mask:
                uv_s, X_s, tag_s = uv[keepm], Xl[keepm], tag[keepm]
                cls_s = [c for c, kk in zip(cls, keepm) if kk]
                lift_s = lift_m[keepm]
            else:
                uv_s, X_s, tag_s, cls_s, lift_s = uv, X, tag, cls, lift_m
            t0 = time.time()
            new, inl, res = solve_iteration(uv_s, X_s, prev)
            timing["solveMs"] += round((time.time() - t0) * 1000)
            depth = np.linalg.norm((X_s - new.eye)[:, :2], axis=1)
            cov = T.coverage(uv_s[inl], depth[inl])
            change = T.median_change_px(prev, new)
            iters.append(
                {
                    "n": int(inl.sum()),
                    "nMatches": int(len(uv_s)),
                    "medPx": float(np.median(res[inl])) if inl.any() else None,
                    "coverage": cov,
                    "nLower": int((uv_s[inl][:, 1] >= 0.5).sum()),
                    "views": len(views),
                    "perView": per_view,
                    "changePx": round(change, 3),
                    "mask": mst,
                    "ms": round((time.time() - ti) * 1000),
                }
            )
            render_pose = dict(prev.pose)
            final = (new, uv_s[inl], X_s[inl], res[inl], tag_s[inl], [c for c, kk in zip(cls_s, inl) if kk],
                     lift_s[inl], depth[inl], it)
            log(f"{photo_id} iter {it}: {iters[-1]['n']} inliers / {len(uv_s)} ({cov}), change {change:.2f} px")
            prev = new
            if it > 1 and change < 0.5:
                break
    finally:
        renderer.end(keep)
        try:
            import shutil

            shutil.rmtree(tmp, ignore_errors=True)
        except Exception:  # noqa: BLE001
            pass

    new, uv, X, res, tag, cls, lift_m, depth, it = final
    # ur, vr: where the lifted point sits in the last iteration's full-frame render (app eye, pinhole)
    pr, _ = T.project(T.Cam(render_pose, render_eye, new.aspect), X)
    Xu = to_usr(X) if len(X) else np.zeros((0, 3))
    inliers = [
        {
            "u": float(uv[i, 0]),
            "v": float(uv[i, 1]),
            "ur": float(pr[i, 0]),
            "vr": float(pr[i, 1]),
            "world": [float(a) for a in Xu[i]],
            "resPx": float(res[i]),
            **({"cls": cls[i]} if cls[i] else {}),
            "depthM": float(depth[i]),
            "liftM": float(lift_m[i]),
            "iter": it,
            "view": str(tag[i]),
        }
        for i in range(len(uv))
    ]
    out_cam = {
        "pose": pose_json(new.pose),
        "eye": [float(a) for a in to_usr(new.eye)[0]],
        "aspect": new.aspect,
        "intr": new.intr,
    }
    timing["totalMs"] = round((time.time() - t_all) * 1000)
    return {
        "ok": True,
        "iterations": iters,
        "inliers": inliers,
        "cam": out_cam,
        "renderEye": [float(a) for a in to_usr(render_eye)[0]],
        "timingMs": timing,
        "notes": notes,
        "version": VERSION,
    }


# ---------------------------------------------------------------- HTTP


def parse_multipart(ctype: str, raw: bytes) -> dict[str, bytes]:
    msg = BytesParser(policy=HTTP).parsebytes(b"Content-Type: " + ctype.encode() + b"\r\n\r\n" + raw)
    parts = {}
    for part in msg.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if name:
            parts[name] = part.get_payload(decode=True) or b""
    return parts


def make_handler(renderer: Renderer):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code: int, obj: dict):
            b = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(b)))
            origin = self.headers.get("Origin")
            if origin and origin.startswith(("http://localhost:", "http://127.0.0.1:")):
                self.send_header("Access-Control-Allow-Origin", origin)
            self.end_headers()
            self.wfile.write(b)

        def do_OPTIONS(self):  # noqa: N802
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin", "*"))
            self.send_header("Access-Control-Allow-Methods", "POST, GET")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()

        def do_GET(self):  # noqa: N802
            if self.path.startswith("/health"):
                return self._send(200, {"ok": True, "version": VERSION, "busy": JOB.locked(), "device": M.DEV})
            self._send(404, {"ok": False, "error": {"code": "not_found", "message": self.path}})

        def do_POST(self):  # noqa: N802
            if not self.path.startswith("/rematch"):
                return self._send(404, {"ok": False, "error": {"code": "not_found", "message": self.path}})
            if not JOB.acquire(blocking=False):
                return self._send(503, {"ok": False, "error": {"code": "busy", "message": "one job at a time"}})
            try:
                n = int(self.headers.get("Content-Length", 0))
                raw = self.rfile.read(n)
                parts = parse_multipart(self.headers.get("Content-Type", ""), raw)
                req = json.loads(parts["request"])
                im = ImageOps.exif_transpose(Image.open(io.BytesIO(parts["photo"]))).convert("RGB")
                out = rematch(renderer, np.array(im), req)
                self._send(200, out)
            except (KeyError, ValueError) as e:
                self._send(400, {"ok": False, "error": {"code": "bad_request", "message": str(e)}})
            except Exception as e:  # noqa: BLE001
                traceback.print_exc()
                self._send(500, {"ok": False, "error": {"code": "internal", "message": str(e)}})
            finally:
                JOB.release()

    return H


def main():
    a = argparse.ArgumentParser()
    a.add_argument("--port", type=int, default=8768)
    a.add_argument("--host", default="127.0.0.1")
    args = a.parse_args()
    t0 = time.time()
    w = core.warmup()
    log(f"warm in {time.time() - t0:.1f}s: {w}")
    renderer = Renderer(args.port)
    srv = ThreadingHTTPServer((args.host, args.port), make_handler(renderer))

    def stop(*_):
        if renderer.w is not None:
            renderer.w.close()
        renderer.lock.release()
        os._exit(0)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    log(f"{VERSION} on http://{args.host}:{args.port}")
    srv.serve_forever()


if __name__ == "__main__":
    main()
