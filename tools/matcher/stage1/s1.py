"""Stage-1 search library (T6): drives a vendored copy of the service's render worker and matching core.

Nothing under tools/matcher/server/ is imported at run time: `vendor/` holds a snapshot (see
vendor/SNAPSHOT.sha1) so another agent's edits there can't change these results mid-run. The stage-2
fused solve is the service's own code path (vendor/app_snapshot.assemble → fuse.fuse → fusion.py).
"""
from __future__ import annotations

import hashlib
import io
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
VENDOR = HERE / "vendor"
sys.dont_write_bytecode = True
for p in (str(VENDOR), str(HERE.parent), str(HERE)):
    if p not in sys.path:
        sys.path.insert(0, p)

import manifest_guard as _manifest_guard  # noqa: E402  stdlib-only (this directory)
import core  # noqa: E402  vendor/core.py
import fuse  # noqa: E402  vendor/fuse.py
import app_snapshot as APP  # noqa: E402  vendor/app_snapshot.py (assemble, constants)

import match as _M  # noqa: E402  tools/matcher/match.py (read-only; patched in memory below)

# LightGlue's adaptive POINT pruning (width_confidence) is flaky on MPS: after a pair with a different
# keypoint count, identical features sporadically match to 0 (or ~10) instead of ~1000 (reproduced on
# wc_0006: 3/12 and 9/20 failures; CPU and width_confidence=-1 are stable at 0/20). The service uses the
# default (pruning on). Stage 1 disables point pruning (depth early-exit kept): +~13 % match time.
# STAGE1_LG_PRUNE=1 restores the service behaviour.
if os.environ.get("STAGE1_LG_PRUNE") != "1":
    _orig_models = _M.models

    def _models_noprune(kind: str):
        if kind not in _M._models:
            from lightglue import ALIKED, DISK, LightGlue
            ext = (ALIKED(max_num_keypoints=4096, detection_threshold=0.01) if kind == "aliked" else DISK(max_num_keypoints=4096))
            _M._models[kind] = (ext.eval().to(_M.DEV), LightGlue(features=kind, width_confidence=-1).eval().to(_M.DEV))
        return _M._models[kind]
    _M.models = _models_noprune

# STAGE1_MANIFEST=<path> switches the manifest; v3 manifests are refused unless V3_ALLOW=1 and FROZEN.sha1 matches (manifest_guard.py)
MANIFEST = _manifest_guard.resolve_manifest(ROOT, os.environ)
SPLIT = ROOT / "tools/bench/split.json"
WORKER_PORT = int(os.environ.get("STAGE1_PORT", 8768))
TMP_ROOT = Path(os.environ.get("STAGE1_TMP", tempfile.gettempdir()))

DEG = math.pi / 180


def dang(a, b):
    return (a - b + 540.0) % 360.0 - 180.0


def hfov_from_vfov(vfov, aspect):
    return 2 * math.degrees(math.atan(math.tan(math.radians(vfov) / 2) * aspect))


def vfov_from_hfov(hfov, aspect):
    return 2 * math.degrees(math.atan(math.tan(math.radians(hfov) / 2) / aspect))


def code_stamp() -> dict:
    """Content hash of the stage-1 search code + vendored service snapshot + the knobs that change results."""
    h = hashlib.sha1()
    files = [HERE / f for f in ("pipeline.py", "s1.py", "skyglobal.py")] + sorted(p for p in VENDOR.iterdir() if p.suffix in (".py", ".mjs"))
    for f in files:
        h.update(f.name.encode())
        h.update(f.read_bytes())
    env = {"MATCHER_LG_DEVICE": core.LG_DEVICE, "SWEEP_KP": APP.SWEEP_KP, "STAGE1_LG_PRUNE": os.environ.get("STAGE1_LG_PRUNE", "0"),
           "SERVICE_SNAPSHOT": (VENDOR / "SNAPSHOT.sha1").read_text().split()[0][:12]}
    h.update(json.dumps(env, sort_keys=True).encode())
    return {"sha1": h.hexdigest()[:16], "env": env, "files": [f.name for f in files]}


def free_gb() -> float:
    st = os.statvfs(str(ROOT))
    return st.f_bavail * st.f_frsize / 1e9


def disk_guard(min_gb: float = 3.5, wait_s: float = 900):
    """Block until ≥ min_gb free (swap on this machine grows onto the nearly full disk); abort after wait_s."""
    t0 = time.time()
    while free_gb() < min_gb:
        if time.time() - t0 > wait_s:
            raise SystemExit(f"stage1: disk below {min_gb} GB free for {wait_s:.0f} s, aborting")
        print(f"stage1: {free_gb():.1f} GB free < {min_gb}, waiting", file=sys.stderr, flush=True)
        time.sleep(30)


def dev_ids() -> list[str]:
    return list(json.load(open(SPLIT))["dev"])


def test_ids() -> set[str]:
    return set(json.load(open(SPLIT))["test"])


def manifest() -> dict:
    return {e["id"]: e for e in json.load(open(MANIFEST))}


# ------------------------------------------------------------------ worker

class Worker:
    """Line-JSON client for vendor/worker.mjs (one Chromium, warm pages)."""

    def __init__(self, port: int = WORKER_PORT, max_pages: int = 1):
        env = {**os.environ, "MATCHER_PORT": str(port), "MATCHER_MAX_PAGES": str(max_pages)}
        self.log = open(TMP_ROOT / f"stage1-worker-{os.getpid()}.log", "a")
        self.p = subprocess.Popen(["node", str(VENDOR / "worker.mjs")], cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=self.log, text=True, bufsize=1, env=env)
        self.n = 0
        self.lock = threading.Lock()

    def call(self, req: dict, timeout: float = 600) -> dict:
        with self.lock:
            if self.p.poll() is not None:
                raise RuntimeError("worker exited")
            self.n += 1
            req = {**req, "id": self.n}
            self.p.stdin.write(json.dumps(req) + "\n")
            self.p.stdin.flush()
            box = {}

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

            t = threading.Thread(target=rd, daemon=True)
            t.start()
            t.join(timeout)
            if "r" not in box:
                self.close()
                raise TimeoutError(f"worker call timed out after {timeout}s")
            return box["r"]

    def close(self):
        try:
            self.p.kill()
        except Exception:  # noqa: BLE001
            pass


# ------------------------------------------------------------------ photo / request

def upright_photo(path: Path, out: Path) -> tuple[np.ndarray, int, int]:
    """harness normalize.py, then the service's _upright_jpeg (both steps, so the ad-hoc id and pixels
    match what the wild run sent)."""
    im = Image.open(path)
    orient = im.getexif().get(0x0112, 1)
    if not (im.format == "JPEG" and orient == 1 and max(im.size) <= 2048 and im.mode == "RGB"):
        im = ImageOps.exif_transpose(im).convert("RGB")
        s = 2048 / max(im.size)
        if s < 1:
            im = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
        b = io.BytesIO()
        im.save(b, "JPEG", quality=92)
        raw = b.getvalue()
    else:
        raw = path.read_bytes()
    im = ImageOps.exif_transpose(Image.open(io.BytesIO(raw))).convert("RGB")
    s = APP.ADHOC_MAX_SIDE / max(im.size)
    if s < 1:
        im = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
    im.save(out, "JPEG", quality=92)
    return np.array(im), im.width, im.height


class Photo:
    """One ad-hoc photo as the harness sends it in condition `given` with --weak-heading:
    no yaw (360°), no gravity, focal from focal35mm/vfov/hfov else 50° hfov + free focal."""

    def __init__(self, pid: str, entry: dict | None = None, tmp: Path | None = None, cond: str = "given"):
        self.pid = pid
        self.e = entry or manifest()[pid]
        self.tmp = Path(tempfile.mkdtemp(prefix=f"stage1-{pid}-", dir=tmp or TMP_ROOT))
        src = Path(self.e["file"])
        if not src.is_absolute():
            src = (MANIFEST.parent / src) if (MANIFEST.parent / src).exists() else (ROOT / src)
        # the photo file outlives this object: a cached page may still fetch it (worker route)
        pdir = TMP_ROOT / "stage1-photos"
        pdir.mkdir(parents=True, exist_ok=True)
        self.file = pdir / f"{pid}.jpg"
        self.img, self.W0, self.H0 = upright_photo(src, self.file)
        self.aspect = self.W0 / self.H0
        e = self.e
        if e.get("vfovDeg"):
            vfov, fk = float(e["vfovDeg"]), True
        elif e.get("hfovDeg"):
            vfov, fk = vfov_from_hfov(float(e["hfovDeg"]), self.aspect), True
        elif e.get("focal35mm"):
            fpx = e["focal35mm"] * math.hypot(self.W0, self.H0) / 43.2666
            vfov, fk = 2 * math.degrees(math.atan(self.H0 / 2 / fpx)), True
        else:
            vfov, fk = vfov_from_hfov(APP.ADHOC_DEFAULT_HFOV, self.aspect), False
        self.vfov0, self.focal_known = vfov, fk
        self.hfov0 = hfov_from_vfov(vfov, self.aspect)
        # yaw / gravity: condition given = weak heading only (hint), no gravity (none in the wild set)
        self.cond = cond
        self.yaw_known = cond in ("full", "nogravity") and e.get("headingDeg") is not None
        self.yaw_hint = e.get("headingDeg") if cond == "given" else None
        self.grav_known = e.get("pitchDeg") is not None and e.get("rollDeg") is not None and cond in ("full", "noheading")
        self.p0 = {"yaw": float(e["headingDeg"]) if self.yaw_known else 0.0,
                   "pitch": float(e.get("pitchDeg") or 0.0) if self.grav_known else 0.0,
                   "roll": float(e.get("rollDeg") or 0.0) if self.grav_known else 0.0, "vfov": float(vfov)}
        self.narrow = self.hfov0 < APP.ADHOC_NARROW_HFOV
        aid = "adhoc-" + hashlib.sha1(self.file.read_bytes()).hexdigest()[:12]
        self.adhoc = {"id": aid, "photoFile": str(self.file), "region": None,
                      "meta": {"lat": e["lat"], "lon": e["lon"], "alt": e.get("altitudeM"), "width": self.W0, "height": self.H0,
                               "heading": self.p0["yaw"] if self.yaw_known else None, "pitch": self.p0["pitch"],
                               "roll": self.p0["roll"], "vfov": self.p0["vfov"]}}
        self.full = not self.yaw_known
        self.eye = None
        self._photo_small = {}

    def cleanup(self):
        shutil.rmtree(self.tmp, ignore_errors=True)


class Session:
    """Renders / exports for one photo through the worker (same page semantics as the service)."""

    def __init__(self, worker: Worker, ph: Photo):
        self.w, self.ph = worker, ph
        self.k = 0

    def _call(self, req, timeout=600):
        ph = self.ph
        if ph.narrow:
            req = {"drapeMaxM": APP.ADHOC_NARROW_DRAPE_M, **req}
        r = self.w.call({"adhoc": ph.adhoc, "fullTerrain": ph.full, **req}, timeout)
        self.reopened = r.get("reopened", 0)
        if getattr(self, "reopened0", None) is None:
            self.reopened0 = self.reopened
        if not r.get("ok"):
            raise RuntimeError(f"worker: {r.get('error')}")
        return r

    def render(self, poses: list[dict] | None = None, prior: dict | None = None, offsets=None, styles=("sat",),
               skyline=False, allow_empty=True):
        """→ (views [core.View with .hill], skyline dict or None, meta, timing)."""
        self.k += 1
        d = self.ph.tmp / f"r{self.k}"
        req = {"cmd": "render", "prior": prior or self.ph.p0, "styles": list(styles), "skyline": skyline,
               "allowEmpty": allow_empty, "outDir": str(d)}
        if poses is not None:
            req["poses"] = poses
        if offsets is not None:
            req["offsets"] = offsets
        try:
            r = self._call(req)
            views = []
            for v in r["views"]:
                xyz = np.fromfile(v["xyz"], np.float32).reshape(v["H"], v["W"], 3)
                rgb = np.array(Image.open(v["rgb"]).convert("RGB")) if v.get("rgb") else None
                vw = core.View(v["tag"], v["pose"], rgb, xyz)
                vw.hill = np.array(Image.open(v["hill"]).convert("RGB")) if v.get("hill") else None
                views.append(vw)
            sk = APP.load_skyline_files(r.get("skyline")) if r.get("skyline") else None
            self.ph.eye = r["meta"]["eye"]
            return views, sk, r["meta"], r.get("timing", {})
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def edges(self) -> dict:
        self.k += 1
        d = self.ph.tmp / f"e{self.k}"
        try:
            r = self._call({"cmd": "edges", "outDir": str(d)})
            w, h = r["w"], r["h"]
            f = r["files"]
            out = {"w": w, "h": h,
                   "dirs": np.fromfile(f["horizon"], np.float32).reshape(-1, 3).astype(np.float64),
                   "fine": np.fromfile(f["fine"], np.float32).reshape(h, w),
                   "coarse": np.fromfile(f["coarse"], np.float32).reshape(h, w),
                   "fg": np.fromfile(f["fg"], np.float32).reshape(h, w),
                   "rgb": np.fromfile(f["rgb"], np.uint8).reshape(h, w, 4)[..., :3].copy(),
                   "meta": r["meta"], "timing": r.get("timing")}
            self.ph.eye = r["meta"]["eye"]
            return out
        finally:
            shutil.rmtree(d, ignore_errors=True)

    @property
    def hmr_reopens(self) -> int:
        return (getattr(self, "reopened", 0) or 0) - (getattr(self, "reopened0", 0) or 0)

    def close(self):
        try:
            self.w.call({"cmd": "closeAll"}, 60)
        except Exception:  # noqa: BLE001
            pass

    def align(self, priors: list[dict]) -> dict:
        return self._call({"cmd": "align", "priors": priors})


# ------------------------------------------------------------------ matching helpers

RETRIES: list = []  # (view tag, matches after retry) — reported per photo


def _lg(kind, fp, fr):
    """LightGlue as the v0.3 service runs it: core.lg_match (CPU unless MATCHER_LG_DEVICE != cpu) for ALIKED;
    DISK (diagnosis only) via match.py on the model device with point pruning off."""
    import match as M
    if kind == "aliked":
        return core.lg_match(fp, fr)
    k0, k1, _ = M.match(kind, fp, fr)
    return k0, k1


def correspond(photo: np.ndarray, views, eye, kind="aliked", style="sat", max_side=None, max_kp=None):
    """core.correspond generalised: extractor kind (aliked|disk), render style (sat|hill|blend) and an
    optional working resolution (long side). Same lifting / xyz checks as the service."""
    import match as M
    t0 = time.time()
    eye = np.asarray(eye, float)
    H, W = views[0].xyz.shape[:2]
    if photo.shape[:2] != (H, W):
        photo = np.array(Image.fromarray(photo).resize((W, H), Image.LANCZOS))
    scale = 1.0
    if max_side and max(W, H) != max_side:
        scale = max_side / max(W, H)
    rs = (lambda im: np.array(Image.fromarray(im).resize((round(W * scale), round(H * scale)), Image.LANCZOS))) if scale != 1 else (lambda im: im)
    bad = [v.tag for v in views if core.check_view(v, eye) > 2.0]
    if bad:
        raise ValueError(f"xyz buffer does not reproject under its pose for views {bad} (stale/mismatched render)")
    pimg = rs(photo)
    topk = (lambda f: core.top_k(f, max_kp)) if max_kp else (lambda f: f)
    fp = topk(M.extract(kind, pimg))
    X2, X3, per = [], [], []
    for v in views:
        if style == "sat":
            rimg = v.rgb
        elif style == "hill":
            rimg = v.hill
        elif style == "blend":
            rimg = (0.5 * v.rgb.astype(np.float32) + 0.5 * v.hill.astype(np.float32)).astype(np.uint8)
        else:
            raise ValueError(style)
        if rimg is None:
            continue
        r_img = rs(rimg)
        fr = topk(M.extract(kind, r_img))
        k0, k1 = _lg(kind, fp, fr)
        if len(k0) == 0 and core.LG_DEVICE != "cpu" and fp["keypoints"].shape[1] >= 200 and fr["keypoints"].shape[1] >= 200:
            # MPS under memory pressure (shared GPU, heavy swap) sporadically returned 0 matches for a pair
            # that matches fine on a re-run: re-extract both sides once and re-match.
            fp = topk(M.extract(kind, pimg))
            fr = topk(M.extract(kind, r_img))
            k0, k1 = _lg(kind, fp, fr)
            RETRIES.append((v.tag, int(len(k0))))
        k0 = (k0 + 0.5) / scale - 0.5
        k1 = (k1 + 0.5) / scale - 0.5
        X, ok = M.lift(k1, v.xyz, eye)
        per.append({"tag": v.tag, "matches": int(len(k0)), "lifted": int(ok.sum())})
        X2.append(k0[ok] + 0.5)
        X3.append(X[ok])
    x2d = np.concatenate(X2) if X2 else np.zeros((0, 2))
    X = np.concatenate(X3) if X3 else np.zeros((0, 3))
    return {"x2d": x2d, "X": X, "W": W, "H": H, "perView": per, "matchMs": round((time.time() - t0) * 1000)}


def solve(corr, views, eye, prior, free_focal):
    return core.solve(corr, views, eye, prior, free_focal=free_focal)


def pose_err(p, q):
    return abs(dang(p["yaw"], q["yaw"])), abs(p["pitch"] - q["pitch"])
