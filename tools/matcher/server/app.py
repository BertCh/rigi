"""Summit Lens render-and-match escalation service (optional).

  tools/matcher/server/run.sh                 # or: TORCH_HOME=... .venv/bin/python server/app.py --port 8765

Stdlib HTTP server (no extra deps). Models (ALIKED + LightGlue) load once at start-up and stay
warm; the headless app renderer (render_worker.mjs) is a long-lived child process that keeps
Chromium and recently used /photo pages open. Jobs are serialised (one GPU, one renderer).

  GET  /health  → {ok, device, models, version, renderer, busy}
  POST /match   JSON  {photoId, prior:{yaw,pitch,roll,vfov}, offsets?, fused? (default true), freeFocal?, timeoutMs?}
                JSON  {photoPath | photoUrl, meta:{lat, lon, altitudeM?}, prior?:{yaw?, pitch?, roll?, vfov? | hfov?}, ...}
                      ad-hoc photo (not in photos.json): missing yaw → 360° search, missing pitch/roll → free
                      tilt, missing vfov/hfov → 50° hfov + free focal (two-stage, see match_adhoc)
                      policy?: "v034" | "t6"  ad-hoc two-stage search/confidence policy (default: env
                      MATCHER_POLICY, else v034). v034 = the v0.3.x search and a-priori HIGH + basin gap;
                      t6 = the T6 stage-1 search + frozen T6 rule (t6.py, reports/matcher-service.md)
                multipart/form-data with parts
                  request  JSON {prior, eye:[x,y,z], views:[{tag, pose:{yaw,pitch,roll,vfov}, W, H}], freeFocal?, timeoutMs?}
                           or, for an ad-hoc photo, {meta, prior?, ...} without views (same as the JSON ad-hoc mode)
                  photo    JPEG/PNG
                  rgb:<tag>  JPEG/PNG render (W×H), xyz:<tag>  float32 LE H×W×3 ENU, rows top→bottom, sky = 0
                  optional skyline cue: request.skyline {w, h, pose, confidence?} + skyline:{horizon,fine,fg,sky}
                  float32 parts, or request.photoId (the worker exports it from the app)
                → {ok, pose (fused), method, confidence (0.9 HIGH / 0.2 LOW), confidenceLevel, confidenceChecks,
                   cues, inliers, inlierFrac, residualPx, coverage, ..., timingMs, version}   (fused:false = v0.1)
                   ad-hoc: + policy; policy t6 (two-stage) also stage1{candidates[…]}, baseline, rule{id, sha1},
                   confidenceChecks.{apriori, matchDominant, gapOK, ambiguity, veto, unmet}
  errors        → {ok:false, error:{code, message}} with HTTP 400/404/413/503/504/500
"""
from __future__ import annotations

import argparse
import io
import json
import os
import queue
import shutil
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
from types import SimpleNamespace

import hashlib
import urllib.request

import numpy as np
from PIL import Image, ImageOps

sys.path.insert(0, str(Path(__file__).resolve().parent))
import core  # noqa: E402
import fuse  # noqa: E402
import t6 as T6  # noqa: E402  policy "t6" (T6 stage-1 search + frozen rule)

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent.parent
PHOTOS = ROOT / "public" / "photos"
DEFAULT_TIMEOUT_MS = int(os.environ.get("MATCHER_TIMEOUT_MS", 120_000))
MAX_BODY = 200 * 1024 * 1024
ALLOWED_ORIGINS = {o.strip() for o in os.environ.get(
    "MATCHER_CORS", "http://localhost:3100,http://127.0.0.1:3100").split(",") if o.strip()}

# CR-06: DNS-rebinding guard. Host must name a loopback host (any port) or one listed in MATCHER_HOSTS.
ALLOWED_HOSTS = {"localhost", "127.0.0.1", "[::1]", "::1"} | {
    h.strip().lower() for h in os.environ.get("MATCHER_HOSTS", "").split(",") if h.strip()}
# CR-06: photoPath / file:// photoUrl may only read below these roots (repo root + MATCHER_PHOTO_ROOTS, ':'-separated).
PHOTO_ROOTS = [ROOT] + [Path(r).expanduser() for r in os.environ.get("MATCHER_PHOTO_ROOTS", "").split(":") if r.strip()]


def host_allowed(host_header: str | None) -> bool:
    """True when the Host header's name (port stripped) is a loopback or MATCHER_HOSTS name."""
    h = (host_header or "").strip().lower()
    name = h[: h.index("]") + 1] if h.startswith("[") and "]" in h else h.rsplit(":", 1)[0] if h.count(":") == 1 else h
    return name in ALLOWED_HOSTS


def photo_path_allowed(pth: Path) -> bool:
    """True when `pth` lies below an allowed root, by lexical path or after resolving symlinks."""
    for cand in (Path(os.path.abspath(pth)), pth.resolve()):
        for root in PHOTO_ROOTS:
            for r in (Path(os.path.abspath(root)), root.resolve()):
                if cand == r or r in cand.parents:
                    return True
    return False


JOB_LOCK = threading.Lock()
STATE: dict = {"device": None, "warmupMs": None, "started": time.time(), "requests": 0}


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, retry_after: int | None = None, ticket: int | None = None):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message
        self.retry_after = retry_after
        self.ticket = ticket


# ---------- render worker (node) ----------

def kill_group(pgid: int, proc: subprocess.Popen | None = None, grace_s: float = 3.0):
    import signal

    try:
        os.killpg(pgid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        return
    t = time.time() + grace_s
    while time.time() < t:
        try:
            os.killpg(pgid, 0)  # any member left?
        except (ProcessLookupError, PermissionError):
            break
        time.sleep(0.1)
    else:
        try:
            os.killpg(pgid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    if proc is not None:
        try:
            proc.wait(5)
        except subprocess.TimeoutExpired:
            pass


class Renderer:
    def __init__(self):
        self.proc: subprocess.Popen | None = None
        self.lines: queue.Queue = queue.Queue()
        self.seq = 0
        self.lock = threading.Lock()
        self.outstanding = 0  # commands sent whose reply hasn't been read yet (abandoned ones included)
        self.last_line = time.time()

    def _start(self):
        if self.proc is not None:
            self.kill()  # never let a replaced worker (and its Chromium) outlive its handle
        # own process group: kill() takes node AND its Chromium children down together
        self.proc = subprocess.Popen(
            ["node", str(HERE / "render_worker.mjs")], cwd=str(ROOT), stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=sys.stderr, text=True, bufsize=1, start_new_session=True)
        q = self.lines = queue.Queue()
        self.outstanding = 0
        self.last_line = time.time()
        out = self.proc.stdout

        def pump():
            for line in out:
                q.put(line)
            q.put(None)
        threading.Thread(target=pump, daemon=True).start()

    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def kill(self):
        """Kill the worker's whole process group (node + Playwright's Chromium): SIGTERM (the worker
        closes its browser), wait up to 3 s, then SIGKILL. Works even if node itself already exited."""
        p = self.proc
        self.proc = None
        if p is None:
            return
        kill_group(p.pid, p)


    def send_nowait(self, req: dict):
        """Fire-and-forget command (e.g. release): queued behind whatever the worker is doing; its reply is
        discarded by id like any late reply. Never blocks a finishing job behind an abandoned render."""
        with self.lock:
            if not self.alive():
                return
            self.seq += 1
            self.proc.stdin.write(json.dumps({**req, "id": self.seq}) + "\n")
            self.proc.stdin.flush()
            if not self.outstanding:
                self.last_line = time.time()
            self.outstanding += 1

    def call(self, req: dict, timeout_s: float, check: bool = True) -> dict:
        """One request/reply with the worker, serialised by self.lock and matched on this call's own id.
        If THIS request's budget runs out, the reply is abandoned (a late reply is discarded by id) and
        only this request gets a 504; the worker keeps its warm pages. The worker is killed and restarted
        only when it is truly hung: no line at all for HUNG_S while a command is outstanding."""
        stage(f"render:{req.get('cmd', 'render')}", check)
        end = time.time() + timeout_s
        if not self.lock.acquire(timeout=max(0.0, timeout_s)):
            raise ApiError(504, "timeout", "render step not started within this request's budget (renderer busy)")
        try:
            if not self.alive():
                self._start()
            if self.outstanding and time.time() - self.last_line > HUNG_S:
                self.kill()  # abandoned command never answered: really hung
                self._start()
            self.seq += 1
            my_id = self.seq
            self.proc.stdin.write(json.dumps({**req, "id": my_id}) + "\n")
            self.proc.stdin.flush()
            if not self.outstanding:
                self.last_line = time.time()
            self.outstanding += 1
            while True:
                left = end - time.time()
                if left <= 0:
                    if time.time() - self.last_line > HUNG_S:
                        self.kill()
                        raise ApiError(504, "timeout", f"render worker hung (no reply for {HUNG_S:.0f} s): restarted")
                    raise ApiError(504, "timeout", "render step exceeded this request's budget (reply abandoned; renderer kept)")
                try:
                    line = self.lines.get(timeout=min(left, 1.0))
                except queue.Empty:
                    if check:
                        ctx = QUEUE["running"]
                        if ctx is not None and ctx.client_gone():  # abandon the reply (id-matched)
                            raise Cancelled(f"client disconnected during stage {ctx.stage}")
                    continue
                if line is None:
                    self.kill()
                    raise ApiError(503, "renderer_died", "render worker exited (is Playwright installed?)", retry_after=5)
                self.last_line = time.time()
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if "id" in msg:
                    self.outstanding = max(0, self.outstanding - 1)
                if msg.get("id") == my_id:
                    return msg
                # else: a late reply to an earlier call that gave up; drop it
        finally:
            self.lock.release()


HUNG_S = float(os.environ.get("MATCHER_RENDER_HUNG_S", 300))  # ≈ 2× the worst render/page-load step
RENDERER = Renderer()

# /health renderer probe (v0.4.0): a background thread asks the worker to open and evaluate a throwaway
# page every PROBE_S while the renderer is idle, so a dead browser (worker process up, Chromium unusable)
# no longer reports alive:true. /health only reads the cached result (it never waits on the renderer).
PROBE_S = float(os.environ.get("MATCHER_RENDER_PROBE_S", 30))
PROBE = {"ok": None, "at": None, "ms": None, "error": None}


def probe_renderer():
    if not RENDERER.alive() or RENDERER.lock.locked() or JOB_LOCK.locked():
        return  # not started yet (photoId mode starts it on demand) or busy: keep the last result
    try:
        r = RENDERER.call({"cmd": "health"}, 15, check=False)
        ok, err, ms = bool(r.get("ok")), (None if r.get("ok") else str(r.get("error"))[:300]), r.get("ms")
    except ApiError as e:
        if e.status == 504 and "busy" in e.message:
            return
        ok, err, ms = False, f"{e.code}: {e.message}"[:300], None
    if not ok and PROBE["ok"] is not False:
        print(f"[matcher] renderer probe failed: {err}", file=sys.stderr)
    PROBE.update(ok=ok, at=time.time(), ms=ms, error=err)


def probe_loop():
    while True:
        time.sleep(PROBE_S)
        try:
            probe_renderer()
        except Exception as e:  # noqa: BLE001
            PROBE.update(ok=False, at=time.time(), ms=None, error=f"{type(e).__name__}: {e}"[:300])


def renderer_health() -> dict:
    proc = RENDERER.alive()
    alive = proc and PROBE["ok"] is not False
    return {"alive": alive, "process": proc, "browserOk": PROBE["ok"], "probeError": PROBE["error"],
            "probeAgeS": None if PROBE["at"] is None else round(time.time() - PROBE["at"]), "probeMs": PROBE["ms"],
            "app": os.environ.get("APP_URL", "http://localhost:3100")}
core.TICK_HOOK = lambda: check_cancel()  # client-gone / deadline checks between views inside matching


# ---------- job context: stage checkpoints, cancellation, bounded queue ----------

class Cancelled(Exception):
    """The client disconnected: stop at the next stage boundary."""


_TL = threading.local()
QUEUE = {"lock": threading.Lock(), "running": None, "waiting": 0, "waiting_kinds": []}
# Queue tickets (fairness): every 503 carries a ticket; the job lock and the waiter slot go to the
# oldest ACTIVE ticket first (active = presented back at least once). id -> {"kind", "expires", "active"}.
TICKETS: dict = {}
TICKET_SEQ = [0]
TICKET_SLACK_S = 15.0
QUEUE_WAIT_S = float(os.environ.get("MATCHER_QUEUE_WAIT_S", 5))
# typical stage sequences and durations (s), measured on the M3 Pro (reports/matcher-service.md): the
# queue ETA is the running stage's remaining typical time plus the typical time of the stages after it
STAGE_SEQ = {
    "photoId": [("start", 0), ("render:render", 10), ("match", 6), ("solve", 0.5), ("fusion", 3)],
    "multipart": [("start", 0), ("match", 6), ("solve", 0.5), ("fusion", 3)],
    "adhoc": [("start", 0), ("render:render", 25), ("match", 7), ("solve", 1), ("render:render", 12), ("match", 6),
              ("solve", 0.5), ("fusion", 3), ("basinGap", 8), ("render:release", 1)],
    # policy t6 (reports/stage1.md §8: median 85 s, p90 110 s)
    "adhoc-t6": [("start", 0), ("t6:edges", 15), ("t6:sky", 6), ("render:render", 15), ("render:align", 5),
                 ("t6:sweepfine", 20), ("t6:verify", 45)],
}


OVERRUN_FACTOR = 1.0


class JobCtx:
    def __init__(self, kind: str, deadline: float, client_gone=None):
        self.kind, self.deadline, self.client_gone = kind, deadline, client_gone or (lambda: False)
        self.t0 = time.time()
        self.stage, self.stage_t0, self.pos = "queued", self.t0, 0

    def enter(self, name: str):
        seq = STAGE_SEQ.get(self.kind, [])
        for i in range(self.pos, len(seq)):
            if seq[i][0] == name:
                self.pos = i
                break
        self.stage, self.stage_t0 = name, time.time()

    def eta_s(self) -> float:
        """Estimated seconds until this job finishes."""
        seq = STAGE_SEQ.get(self.kind, [])
        if not seq:
            return 30.0
        cur = seq[self.pos][1] if self.stage == seq[self.pos][0] else 0.0
        in_stage = time.time() - self.stage_t0
        # an overrunning stage is expected to take about as long again as it already has (a slow page
        # load or a busy CPU rarely finishes the moment it passes the table value)
        stage_left = cur - in_stage if in_stage < cur else max(in_stage * OVERRUN_FACTOR, 1.0)
        rest = stage_left + sum(d for _, d in seq[self.pos + 1:])
        # the later stages are slow too when this job is running slow overall
        el = time.time() - self.t0
        done_typ = sum(d for _, d in seq[:self.pos]) + min(in_stage, cur)
        if done_typ > 0 and el > done_typ:
            rest *= min(3.0, el / done_typ)
        return max(1.0, min(rest, self.deadline - time.time()))


def expected_total(kind: str) -> float:
    return sum(d for _, d in STAGE_SEQ.get(kind, [("", 30.0)]))


def stage(name: str, check: bool = True):
    """Stage boundary: record the stage; cancel if the client is gone or the request deadline passed."""
    ctx = getattr(_TL, "ctx", None)
    if ctx is None:
        return
    ctx.enter(name)
    if check:
        check_cancel()


def check_cancel():
    """Also called from inside long stages (core.correspond's per-view tick)."""
    ctx = QUEUE["running"]
    if ctx is None:
        return
    if ctx.client_gone():
        raise Cancelled(f"client disconnected during stage {ctx.stage}")
    if time.time() > ctx.deadline:
        raise core.Deadline()


def eta_new_job() -> float | None:
    """Seconds until a newly arriving job could start (None when idle)."""
    r = QUEUE["running"]
    if r is None and not QUEUE["waiting"]:
        return None
    return (r.eta_s() if r else 0.0) + sum(expected_total(k) for k in QUEUE["waiting_kinds"])


def queue_status() -> dict:
    r = QUEUE["running"]
    eta = eta_new_job()
    return {"waiting": QUEUE["waiting"], "tickets": len(TICKETS), "etaS": None if eta is None else round(eta, 1),
            "running": {"stage": r.stage, "elapsedS": round(time.time() - r.t0, 1)} if r else None}


def _prune_tickets():
    now = time.time()
    for k in [k for k, v in TICKETS.items() if v["expires"] < now]:
        del TICKETS[k]


def _presented_ticket() -> int | None:
    """The request's X-Queue-Ticket, if it is still valid; presenting it makes the ticket active."""
    t = getattr(_TL, "ticket", None)
    try:
        t = int(t) if t is not None else None
    except (TypeError, ValueError):
        return None
    if t in TICKETS:
        TICKETS[t]["active"] = True
        return t
    return None


def _older_ticket_waiting(mine: int | None) -> bool:
    """Is there an ACTIVE ticket (one that has been presented back at least once) older than this
    request's — or any active ticket, for a request without one? Tickets that are never presented
    (clients that ignore them) don't block anybody."""
    return any(v["active"] and (mine is None or k < mine) for k, v in TICKETS.items())


# Ticketless 503s: held up to TARPIT_S before answering (at most TARPIT_MAX at once, the rest answered
# immediately) and summarised in the log every 30 s instead of one line each.
TARPIT_S = float(os.environ.get("MATCHER_TARPIT_S", "2"))
_TARPIT = threading.BoundedSemaphore(int(os.environ.get("MATCHER_TARPIT_MAX", "16")))
_TICKETLESS = {"n": 0, "since": time.time()}
_TICKETLESS_LOCK = threading.Lock()


def _note_ticketless_busy() -> None:
    with _TICKETLESS_LOCK:
        _TICKETLESS["n"] += 1
        now = time.time()
        if now - _TICKETLESS["since"] >= 30:
            print(f"[matcher] {_TICKETLESS['n']} ticketless busy 503s in the last {now - _TICKETLESS['since']:.0f} s",
                  file=sys.stderr)
            _TICKETLESS.update(n=0, since=now)


def _busy(msg: str, kind: str = "photoId") -> ApiError:
    """503 busy with Retry-After = seconds until this client's turn, and a queue ticket (reused if the
    request presented a valid one) that expires at ~2× Retry-After + slack."""
    import math

    _prune_tickets()
    mine = _presented_ticket()
    eta = eta_new_job() or 0.0
    eta += sum(expected_total(v["kind"]) for k, v in TICKETS.items() if v["active"] and (mine is None or k < mine))
    ra = int(min(60, max(1, math.ceil(eta if eta > 0 else 5))))
    if mine is None:
        TICKET_SEQ[0] += 1
        mine = TICKET_SEQ[0]
    TICKETS[mine] = {"kind": kind, "expires": time.time() + 2 * ra + TICKET_SLACK_S,
                     "active": TICKETS.get(mine, {}).get("active", False)}
    return ApiError(503, "busy", msg, retry_after=ra, ticket=mine)


# ---------- request handling ----------

def _num_pose(p, name="prior") -> dict:
    if not isinstance(p, dict):
        raise ApiError(400, "bad_request", f"{name} must be an object {{yaw,pitch,roll,vfov}}")
    out = {}
    for k in ("yaw", "pitch", "roll", "vfov"):
        v = p.get(k)
        if not isinstance(v, (int, float)) or not np.isfinite(v):
            raise ApiError(400, "bad_request", f"{name}.{k} must be a finite number")
        out[k] = float(v)
    if not VFOV_MIN < out["vfov"] < 150:
        raise ApiError(400, "bad_request", f"{name}.vfov out of range")
    return out


def _timeout(body: dict) -> float:
    ms = body.get("timeoutMs", DEFAULT_TIMEOUT_MS)
    if not isinstance(ms, (int, float)) or ms <= 0:
        raise ApiError(400, "bad_request", "timeoutMs must be a positive number")
    return min(float(ms), 600_000) / 1000


def _read_img(data: bytes, what: str) -> np.ndarray:
    try:
        return np.array(Image.open(io.BytesIO(data)).convert("RGB"))
    except Exception as e:  # noqa: BLE001
        raise ApiError(400, "bad_image", f"{what}: cannot decode image ({e})") from e


def _run_job(fn, deadline: float, kind: str = "photoId"):
    """At most one running job and one waiter. A waiter gets the lock within QUEUE_WAIT_S or a prompt
    503 busy with Retry-After = the running job's estimated remaining time (≤ 60 s)."""
    ctx = JobCtx(kind, deadline, getattr(_TL, "client_gone", None))
    with QUEUE["lock"]:
        _prune_tickets()
        mine = _presented_ticket()
        if _older_ticket_waiting(mine):
            # fairness: an older ticket holder goes first, even if the lock happens to be free right now
            raise _busy("another client holds an older queue ticket", kind)
        got = JOB_LOCK.acquire(blocking=False)
        if not got:
            if QUEUE["waiting"] >= 1:
                raise _busy("another match is running and one is already queued", kind)
            QUEUE["waiting"] += 1
            QUEUE["waiting_kinds"].append(kind)
    if not got:
        try:
            got = JOB_LOCK.acquire(timeout=max(0.0, min(QUEUE_WAIT_S, deadline - time.time())))
        finally:
            with QUEUE["lock"]:
                QUEUE["waiting"] -= 1
                QUEUE["waiting_kinds"].remove(kind)
        if not got:
            with QUEUE["lock"]:
                raise _busy("another match is running", kind)
    with QUEUE["lock"]:
        if mine is not None:
            TICKETS.pop(mine, None)  # served
    QUEUE["running"] = ctx
    _TL.ctx = ctx
    try:
        stage("start")
        return fn()
    except core.Deadline as e:
        raise ApiError(504, "timeout", "matching exceeded the request timeout") from e
    finally:
        _TL.ctx = None
        QUEUE["running"] = None
        release_memory()
        JOB_LOCK.release()


def release_memory():
    """After every job: drop per-request arrays (views, DEM mosaics, horizon caches) and hand the MPS
    allocator's cached blocks back — otherwise RSS ratchets up to several GB across requests."""
    import gc

    gc.collect()
    try:
        import torch

        if torch.backends.mps.is_available():
            torch.mps.empty_cache()
    except Exception:  # noqa: BLE001
        pass
    # macOS keeps freed large blocks resident as MALLOC_LARGE_REUSABLE (counted in RSS, not in the
    # physical footprint) until the kernel needs them; hand them back now so RSS reflects real use
    if sys.platform == "darwin":
        try:
            import ctypes

            ctypes.CDLL("libSystem.B.dylib").malloc_zone_pressure_relief(None, 0)
        except Exception:  # noqa: BLE001
            pass


def load_skyline_files(sk: dict | None) -> dict | None:
    """Worker skyline export (files) → fusion's in-memory skyline dict."""
    if not sk:
        return None
    rd = lambda k: np.fromfile(sk["files"][k], np.float32)  # noqa: E731
    return fuse.skyline_from_arrays(sk["w"], sk["h"], rd("fine"), rd("fg"), rd("sky"), rd("horizon"), sk["app"])


def _correspond(*a, **k):
    stage("match")
    return core.correspond(*a, **k)


def assemble(corr: dict, views, eye, prior: dict, sk: dict | None, *, fused: bool, free_focal: bool,
             meta: dict | None, deadline: float, sky_note: str | None = None) -> dict:
    """Legacy render-match result, upgraded to the fused pose + a-priori HIGH/LOW rule when fused."""
    stage("solve")
    legacy = core.solve(corr, views, eye, prior, free_focal=free_focal, deadline=deadline, meta_for_score=meta)
    legacy["method"] = "render-match"
    if not fused:
        return legacy
    if time.time() > deadline:
        raise core.Deadline()
    mcue = ({"pose": legacy["pose"], "inliers": legacy["inliers"], "residualPx": legacy.get("residualPx")}
            if legacy.get("pose") else None)
    low = {"confidence": fuse.LOW_CONF, "confidenceLevel": "low", "matchConfidence": legacy.get("confidence")}
    if sk is None:
        return {**legacy, **low, "confidenceChecks": {"cueAgreeDeg": None, "skylineMedPx": None, "matchSupport": None},
                "cues": {"skyline": None, "match": mcue}, "skylineUnavailable": sky_note or "no skyline cue"}
    stage("fusion")
    fr = fuse.fuse(prior, eye, corr["W"], corr["H"], sk, corr, meta_for_score=meta)
    timing = {**legacy["timingMs"], "fusion": fr["fusionMs"]}
    if fr["fusedPose"] is None:
        return {**legacy, **low, "timingMs": timing, "confidenceChecks": fr["checks"], "cues": fr["cues"]}
    pose = fr["fusedPose"]
    W, H = corr["W"], corr["H"]
    out = {k: legacy[k] for k in ("nLifted", "perView") if k in legacy}
    if len(corr["x2d"]):
        e = np.linalg.norm(fuse.F.match_resid(fuse.F.x_from_pose(pose, H), corr, np.asarray(eye, float)), axis=1)
        inl = e < fuse.F.SUPPORT_PX
        out.update(inliers=int(inl.sum()), inlierFrac=round(float(inl.mean()), 4),
                   residualPx=round(float(np.sqrt(np.mean(e[inl] ** 2))), 3) if inl.any() else None,
                   coverage=round(core.coverage(corr["x2d"][inl], W, H), 3))
    else:
        out.update(inliers=0, inlierFrac=0.0, residualPx=None, coverage=0.0)
    high = fr["level"] == "high"
    out.update(
        pose=pose, method="fused",
        confidence=fuse.HIGH_CONF if high else fuse.LOW_CONF, confidenceLevel=fr["level"],
        confidenceChecks=fr["checks"], cues=fr["cues"], fusionScore=fr["fusionScore"],
        matchConfidence=legacy.get("confidence"), fusedFrom=fr["start"],
        deltaYawFromPrior=round(core.dang(pose["yaw"], prior["yaw"]), 3),
        focalPx=round(core.focal_px(pose["vfov"], H), 2), size={"W": W, "H": H}, timingMs=timing,
    )
    if "vsGroundTruth" in fr:
        out["vsGroundTruth"] = fr["vsGroundTruth"]
    return out


MAX_OFFSETS = 12
VFOV_MIN = 1.5  # was 5; narrow (tele) ad-hoc views use the seeded stage 1 below


def _offsets(body: dict, default=(-20, -10, 0, 10, 20)) -> list:
    offsets = body.get("offsets", list(default))
    if not (isinstance(offsets, list) and 1 <= len(offsets) <= MAX_OFFSETS and all(isinstance(o, (int, float)) for o in offsets)):
        raise ApiError(400, "bad_request", f"offsets must be a list of 1–{MAX_OFFSETS} yaw offsets (deg)")
    return offsets


def match_photo_id(body: dict) -> dict:
    pid = body.get("photoId")
    if not isinstance(pid, str) or not pid.replace("_", "").replace("-", "").isalnum():
        raise ApiError(400, "bad_request", "photoId must be a photo id like IMG_7155")
    photo_path = PHOTOS / f"{pid}.jpg"
    if not photo_path.exists():
        raise ApiError(404, "unknown_photo", f"no public/photos/{pid}.jpg")
    prior = _num_pose(body.get("prior"))
    offsets = _offsets(body)
    fused = body.get("fused", True) is not False
    timeout_s = _timeout(body)
    t0 = time.time()
    deadline = t0 + timeout_s

    def job():
        tmp = Path(tempfile.mkdtemp(prefix="matcher-"))
        try:
            tq = time.time()
            r = RENDERER.call({"cmd": "render", "photoId": pid, "prior": prior, "offsets": offsets, "skyline": fused,
                               "outDir": str(tmp)}, max(1.0, deadline - time.time()))
            if not r.get("ok"):
                raise ApiError(502, "render_failed", r.get("error", "render failed"))
            render_ms = (time.time() - tq) * 1000
            views = []
            for v in r["views"]:
                xyz = np.fromfile(v["xyz"], np.float32).reshape(v["H"], v["W"], 3)
                views.append(core.View(v["tag"], v["pose"], np.array(Image.open(v["rgb"]).convert("RGB")), xyz))
            sk = load_skyline_files(r.get("skyline"))
            photo = np.array(Image.open(photo_path).convert("RGB"))
            meta = r["meta"]
            corr = _correspond(photo, views, meta["eye"], deadline=deadline)
            res = assemble(corr, views, meta["eye"], prior, sk, fused=fused, free_focal=bool(body.get("freeFocal")),
                           meta=meta, deadline=deadline, sky_note=None if sk else "app has no horizon/edge map")
            res["timingMs"] = {"render": round(render_ms), **r.get("timing", {}), **res["timingMs"]}
            res["eye"] = meta["eye"]
            return res
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    res = _run_job(job, deadline)
    res["timingMs"]["total"] = round((time.time() - t0) * 1000)
    return res


def _f32(parts: dict, name: str, n: int | None = None) -> np.ndarray:
    b = parts.get(name)
    if b is None:
        raise ApiError(400, "bad_request", f"missing part {name}")
    if len(b) % 4 or (n is not None and len(b) != n * 4):
        raise ApiError(400, "bad_request", f"{name}: expected {'' if n is None else n} float32 values, got {len(b)} bytes")
    return np.frombuffer(b, "<f4")


def match_multipart(ctype: str, raw: bytes) -> dict:
    t0 = time.time()
    msg = BytesParser(policy=HTTP).parsebytes(b"Content-Type: " + ctype.encode() + b"\r\n\r\n" + raw)
    parts = {}
    for part in msg.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if name:
            parts[name] = part.get_payload(decode=True) or b""
    if "request" not in parts or "photo" not in parts:
        raise ApiError(400, "bad_request", "multipart needs parts 'request' (JSON) and 'photo'")
    try:
        req = json.loads(parts["request"])
    except json.JSONDecodeError as e:
        raise ApiError(400, "bad_request", f"request part is not JSON: {e}") from e
    if isinstance(req, dict) and "meta" in req and "views" not in req:
        return match_adhoc(req, parts["photo"])
    prior = _num_pose(req.get("prior"))
    eye = req.get("eye")
    if not (isinstance(eye, list) and len(eye) == 3 and all(isinstance(x, (int, float)) for x in eye)):
        raise ApiError(400, "bad_request", "eye must be [x,y,z] in the engine's ENU frame")
    vs = req.get("views")
    if not isinstance(vs, list) or not 1 <= len(vs) <= 9:
        raise ApiError(400, "bad_request", "views must list 1–9 {tag, pose, W, H}")
    fused = req.get("fused", True) is not False
    timeout_s = _timeout(req)
    deadline = t0 + timeout_s
    views = []
    for v in vs:
        tag = str(v.get("tag"))
        W, H = int(v.get("W", 0)), int(v.get("H", 0))
        if f"rgb:{tag}" not in parts or f"xyz:{tag}" not in parts:
            raise ApiError(400, "bad_request", f"missing parts rgb:{tag} / xyz:{tag}")
        xb = parts[f"xyz:{tag}"]
        if W <= 0 or H <= 0 or len(xb) != W * H * 12:
            raise ApiError(400, "bad_request", f"xyz:{tag} must be float32 H×W×3 = {W * H * 12} bytes, got {len(xb)}")
        xyz = np.frombuffer(xb, "<f4").reshape(H, W, 3)
        views.append(core.View(tag, _num_pose(v.get("pose"), f"views[{tag}].pose"), _read_img(parts[f"rgb:{tag}"], f"rgb:{tag}"), xyz))
    if len({v.xyz.shape for v in views}) != 1:
        raise ApiError(400, "bad_request", "all views must share one W×H")
    photo = _read_img(parts["photo"], "photo")
    # skyline cue: (1) caller-supplied app evidence, (2) exported by the worker for request.photoId, (3) none
    sky_json = req.get("skyline")
    sk_inline = None
    if fused and isinstance(sky_json, dict):
        w, h = int(sky_json.get("w", 0)), int(sky_json.get("h", 0))
        if w <= 0 or h <= 0:
            raise ApiError(400, "bad_request", "skyline.w/h must be the edge-map size")
        app = {"prior": prior, "pose": _num_pose(sky_json.get("pose"), "skyline.pose"),
               "confidence": sky_json.get("confidence"), "accepted": sky_json.get("accepted")}
        sk_inline = fuse.skyline_from_arrays(w, h, _f32(parts, "skyline:fine", w * h), _f32(parts, "skyline:fg", w * h),
                                             _f32(parts, "skyline:sky", w * h), _f32(parts, "skyline:horizon"), app)
    pid = req.get("photoId")
    parse_ms = (time.time() - t0) * 1000

    def job():
        sk, note, sky_ms = sk_inline, None, 0
        if fused and sk is None:
            if isinstance(pid, str) and (PHOTOS / f"{pid}.jpg").exists():
                tmp = Path(tempfile.mkdtemp(prefix="matcher-"))
                try:
                    ts = time.time()
                    r = RENDERER.call({"cmd": "render", "photoId": pid, "prior": prior, "views": False, "skyline": True,
                                       "outDir": str(tmp)}, max(1.0, deadline - time.time()))
                    sk = load_skyline_files(r.get("skyline")) if r.get("ok") else None
                    note = None if sk else f"skyline export failed: {r.get('error', 'no horizon/edge map')}"
                    sky_ms = round((time.time() - ts) * 1000)
                finally:
                    shutil.rmtree(tmp, ignore_errors=True)
            else:
                note = "no skyline parts and no photoId to export them for"
        corr = _correspond(photo, views, eye, deadline=deadline)
        res = assemble(corr, views, eye, prior, sk, fused=fused, free_focal=bool(req.get("freeFocal")), meta=None,
                       deadline=deadline, sky_note=note)
        if sky_ms:
            res["timingMs"] = {"skylineExport": sky_ms, **res["timingMs"]}
        return res

    try:
        res = _run_job(job, deadline, "multipart")
    except ValueError as e:
        raise ApiError(400, "bad_render", str(e)) from e
    res["timingMs"] = {"parse": round(parse_ms), **res["timingMs"], "total": round((time.time() - t0) * 1000)}
    return res



# ---------- ad-hoc photos (not in public/photos/photos.json) ----------

ADHOC_MAX_SIDE = 2048
ADHOC_DEFAULT_HFOV = 50.0
ADHOC_360_OFFSETS = [0, 40, 80, 120, 160, 200, 240, 280, 320]
ADHOC_STAGE1_MIN_INLIERS = 30
# T5 fixed 0.15 a priori on pose6's own inputs (re-rendered around the fused pose). On the service's own
# stage-2 inputs the dev gaps shift: wc_0063 (gross error) 0.175, lowest verified-correct HIGH 0.215
# (wc_0069). 0.20 is therefore TUNED ON DEV (1 negative, 6 positives, thin margins) — see
# reports/position.md "Service changes"; override with MATCHER_BASIN_GAP_MIN.
ADHOC_MAX_HINT_SEEDS = 4
# stage-1 searches (360° sweep, narrow seeds, hint seeds): keypoint cap (env). Default 4096 again: at 2048
# the sweep on dev wc_0009 fell from 32 to 19 inliers (< 30), took the app-skyline fallback and a wrong pose
SWEEP_KP = int(os.environ.get("MATCHER_SWEEP_KP", 4096))  # 2048 in v0.3.1–0.3.3: reverted (wc_0009 dropped below 30 inliers)


def parse_hint_seeds(body: dict) -> list:
    """yawSeeds: [yaw, ...] and/or poseSeeds: [{yaw, pitch?, roll?}, ...] (deg). Invalid entries are ignored."""
    out = []
    ys = body.get("yawSeeds")
    if isinstance(ys, list):
        out += [{"yaw": float(y), "source": "yawSeeds"} for y in ys if isinstance(y, (int, float)) and not isinstance(y, bool)]
    ps = body.get("poseSeeds")
    if isinstance(ps, list):
        for p in ps:
            if isinstance(p, dict) and isinstance(p.get("yaw"), (int, float)):
                d = {"yaw": float(p["yaw"]), "source": "poseSeeds"}
                for k in ("pitch", "roll"):
                    if isinstance(p.get(k), (int, float)):
                        d[k] = float(p[k])
                out.append(d)
    return out[:ADHOC_MAX_HINT_SEEDS]


BASIN_GAP_MIN = float(os.environ.get("MATCHER_BASIN_GAP_MIN", 0.20))
POLICIES = ("v034", "t6")
# force the GPU upload of freshly draped textures (+ gl.finish) on every ad-hoc render; policy t6 always does.
# Off by default so that v034 renders exactly as v0.3.5 (reports/matcher-service.md, "wc_0018").
TEX_UPLOAD = os.environ.get("MATCHER_TEX_UPLOAD") == "1"
DEFAULT_POLICY = os.environ.get("MATCHER_POLICY", "v034")
POSITION_UNCERTAIN_M = 50.0


def position_untrusted(meta_in: dict, body: dict) -> bool:
    """Basin-gap trigger applies only when the caller says the position isn't an EXIF GPS fix:
    meta.positionSource present and != "exif-gps", or positionUncertainM > 50 (request or meta).
    Requests without either field are treated as trusted (unchanged behaviour)."""
    src = meta_in.get("positionSource")
    unc = body.get("positionUncertainM", meta_in.get("positionUncertainM"))
    return (isinstance(src, str) and src != "exif-gps") or (isinstance(unc, (int, float)) and unc > POSITION_UNCERTAIN_M)


def basin_gap_check(res: dict, corr: dict, sk: dict | None, meta: dict, focal_known: bool, deadline: float) -> None:
    """Position-grid basin gap (pose6.basin_gap, fast mode) from the service's OWN stage-2 skyline cue
    and matches — no new renders (re-rendering around the answer self-confirms, reports/position.md).
    Only runs on a HIGH result; gap < BASIN_GAP_MIN, or a check that can't run, downgrades to LOW."""
    import pose6  # tools/matcher/pose6.py

    t0 = time.time()
    checks = res.setdefault("confidenceChecks", {})
    checks["positionTrusted"] = False
    stage("basinGap")
    if res.get("confidenceLevel") != "high" or res.get("pose") is None:
        checks["basinGap"] = None
        return
    gap, err = None, None
    try:
        if sk is None:
            raise RuntimeError("no skyline cue")
        if time.time() > deadline - 5:
            raise RuntimeError("no time left before the request deadline")
        c = corr if corr is not None and len(corr["x2d"]) else None
        import dem as _dem

        _dem.CANCEL = check_cancel
        try:
            prob = pose6.Problem("adhoc", corr["W"], corr["H"], sk, c, meta["eye"], meta["frame"]["lat"], meta["frame"]["lon"],
                                 res["pose"], focal_known, "manual", fast=True)
        finally:
            _dem.CANCEL = None
        r = pose6.basin_gap(prob, cancel=check_cancel)
        gap = r["gap"]
        checks["basinGrid"] = {"step": r["grid"]["step"], "best": r["grid"]["best"], "second": r["grid"]["second"]} if r["grid"] else None
    except (Cancelled, core.Deadline):
        raise
    except Exception as e:  # noqa: BLE001
        err = f"{type(e).__name__}: {e}"[:200]
    checks["basinGap"] = None if gap is None else round(float(gap), 4)
    ms = round((time.time() - t0) * 1000)
    res.setdefault("timingMs", {})["basinGap"] = ms
    if gap is None or gap < BASIN_GAP_MIN:
        res["confidenceLevel"] = "low"
        res["confidence"] = fuse.LOW_CONF
        res["lowReason"] = "basinGap" if gap is not None else f"basinGap unavailable ({err})"
ADHOC_SEED_PITCHES = (-8.0, 0.0, 8.0)
ADHOC_NARROW_HFOV = 25.0  # below this, a 40° sweep can't overlap the photo: seeded local fans instead
ADHOC_NARROW_MAX_SEEDS = 6
ADHOC_NARROW_DRAPE_M = 150_000  # tele views look far: drape imagery out to the DEM radius


def _opt_num(d: dict, k: str):
    v = d.get(k)
    if v is None:
        return None
    if not isinstance(v, (int, float)) or not np.isfinite(v):
        raise ApiError(400, "bad_request", f"{k} must be a finite number or null")
    return float(v)


def _load_photo_bytes(body: dict, data: bytes | None) -> bytes:
    if data is not None:
        return data
    if isinstance(body.get("photoPath"), str):
        pth = Path(body["photoPath"]).expanduser()
        if not photo_path_allowed(pth):
            raise ApiError(403, "forbidden", "photoPath is outside the allowed photo roots (set MATCHER_PHOTO_ROOTS)")
        if not pth.is_file():
            raise ApiError(404, "not_found", f"photoPath {pth} not found")
        return pth.read_bytes()
    url = body.get("photoUrl")
    if isinstance(url, str) and url.startswith("file://"):
        return _load_photo_bytes({"photoPath": url[7:]}, None)
    if isinstance(url, str) and url.startswith(("http://", "https://")):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "summit-lens-matcher/0.3 (local benchmark)"})
            with urllib.request.urlopen(req, timeout=30) as r:
                b = r.read(MAX_BODY + 1)
        except Exception as e:  # noqa: BLE001
            raise ApiError(400, "bad_image", f"photoUrl: download failed ({e})") from e
        if len(b) > MAX_BODY:
            raise ApiError(413, "too_large", "photoUrl body too large")
        return b
    raise ApiError(400, "bad_request", "ad-hoc mode needs photoPath, photoUrl or a multipart 'photo' part")


def _upright_jpeg(raw: bytes, out: Path) -> tuple[np.ndarray, int, int]:
    """EXIF-orientation-applied RGB, long side ≤ 2048, written as JPEG (what the page loads)."""
    try:
        im = ImageOps.exif_transpose(Image.open(io.BytesIO(raw))).convert("RGB")
    except Exception as e:  # noqa: BLE001
        raise ApiError(400, "bad_image", f"photo: cannot decode image ({e})") from e
    s = ADHOC_MAX_SIDE / max(im.size)
    if s < 1:
        im = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
    im.save(out, "JPEG", quality=92)
    return np.array(im), im.width, im.height


def match_adhoc(body: dict, photo_data: bytes | None = None) -> dict:
    """Ad-hoc photo: JPEG + {lat, lon, altitudeM?} + optional heading / gravity / focal.

    The worker opens /photo/<adhoc-id> with Playwright request interception (photos.json module,
    photo, region), so the app code is untouched. Unknowns:
      - no yaw (heading):  stage 1 renders 9 views every 40° around the horizon (full terrain loaded)
                           and solves render-match (2-point rotation RANSAC, no yaw/tilt prior needed);
      - no pitch/roll:     prior pitch = roll = 0; stage 1 renders the usual ±20° fan at pitch 0;
      - no focal:          vfov from a 50° hfov, stage 1 solves with free focal.
    Stage 2 is the ordinary fused request (skyline cue from the app's autoAlign + 5-view match fan)
    with the stage-1 pose as its prior. If stage 1 finds < 30 inliers and yaw is unknown, the
    stage-2 prior comes from the app's own skyline score over yaw seeds every 40° × pitch seeds.
    With everything known it is a single fused stage, identical to photoId mode.
    Note: in two-stage mode the skyline cue is seeded from the match cue, so the HIGH rule's
    agreement check is less independent than in single-stage mode."""
    t0 = time.time()
    meta_in = body.get("meta")
    if not isinstance(meta_in, dict):
        raise ApiError(400, "bad_request", "ad-hoc mode needs meta {lat, lon, altitudeM?}")
    lat, lon = _opt_num(meta_in, "lat"), _opt_num(meta_in, "lon")
    if lat is None or lon is None or not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise ApiError(400, "bad_request", "meta.lat / meta.lon required")
    alt = _opt_num(meta_in, "altitudeM")
    if alt is None:
        alt = _opt_num(meta_in, "alt")
    pin = body.get("prior") or {}
    if not isinstance(pin, dict):
        raise ApiError(400, "bad_request", "prior must be an object")
    yaw, pitch, roll = _opt_num(pin, "yaw"), _opt_num(pin, "pitch"), _opt_num(pin, "roll")
    vfov, hfov = _opt_num(pin, "vfov"), _opt_num(pin, "hfov")
    fused = body.get("fused", True) is not False
    policy = body.get("policy", DEFAULT_POLICY)
    if policy not in POLICIES:
        raise ApiError(400, "bad_request", f"policy must be one of {', '.join(POLICIES)}")
    untrusted_pos = position_untrusted(meta_in, body)
    timeout_s = _timeout(body)
    deadline = t0 + timeout_s
    raw = _load_photo_bytes(body, photo_data)
    tmp = Path(tempfile.mkdtemp(prefix="matcher-adhoc-"))
    aid = None
    try:
        photo_file = tmp / "photo.jpg"
        photo, W0, H0 = _upright_jpeg(raw, photo_file)
        aspect = W0 / H0
        focal_known = vfov is not None or hfov is not None
        if vfov is None:
            h = hfov if hfov is not None else ADHOC_DEFAULT_HFOV
            vfov = 2 * np.degrees(np.arctan(np.tan(np.radians(h) / 2) / aspect))
        if not VFOV_MIN < vfov < 150:
            raise ApiError(400, "bad_request", "vfov out of range")
        yaw_known, grav_known = yaw is not None, pitch is not None and roll is not None
        p0 = {"yaw": yaw if yaw_known else 0.0, "pitch": pitch if grav_known else 0.0,
              "roll": roll if grav_known else 0.0, "vfov": float(vfov)}
        aid = "adhoc-" + hashlib.sha1(photo_file.read_bytes()).hexdigest()[:12]
        adhoc = {"id": aid, "photoFile": str(photo_file), "region": body.get("region"),
                 "meta": {"lat": lat, "lon": lon, "alt": alt, "width": W0, "height": H0,
                          "heading": yaw if yaw_known else None, "pitch": p0["pitch"], "roll": p0["roll"], "vfov": p0["vfov"]}}
        full = not yaw_known
        hfov_deg = float(2 * np.degrees(np.arctan(np.tan(np.radians(vfov) / 2) * aspect)))
        narrow = hfov_deg < ADHOC_NARROW_HFOV
        yaw_hint = _opt_num(body, "yawHint")
        extra_seeds = body.get("seeds") if isinstance(body.get("seeds"), list) else []
        hint_seeds = parse_hint_seeds(body)  # yawSeeds / poseSeeds: search hints only
        extra_seeds = extra_seeds + [{**h, "source": h.get("source", "yawSeeds")} for h in hint_seeds]
        two_stage = not (yaw_known and grav_known and focal_known)
        assumed = {"yawKnown": yaw_known, "gravityKnown": grav_known, "focalKnown": focal_known,
                   "priorUsed": p0, "yaw360": full, "twoStage": two_stage,
                   "defaultHfov": None if focal_known else (hfov or ADHOC_DEFAULT_HFOV),
                   "hfov": round(hfov_deg, 3), "narrow": narrow}

        def load_views(r):
            views = []
            for v in r["views"]:
                xyz = np.fromfile(v["xyz"], np.float32).reshape(v["H"], v["W"], 3)
                views.append(core.View(v["tag"], v["pose"], np.array(Image.open(v["rgb"]).convert("RGB")), xyz))
            return views

        def call(req):
            if narrow:
                req = {"drapeMaxM": ADHOC_NARROW_DRAPE_M, **req}
            if TEX_UPLOAD and req.get("cmd") == "render":
                req = {"texUpload": True, **req}
            r = RENDERER.call({"adhoc": adhoc, "fullTerrain": full, **req}, max(1.0, deadline - time.time()))
            if not r.get("ok"):
                raise ApiError(502, "render_failed", r.get("error", "render failed"))
            return r

        def narrow_stage1(stages, prior2):
            """Narrow FOV: seeds (request seeds, yaw hint / heading, the app's top skyline hypotheses
            over 360° × pitch seeds), each matched against a 3×3 fan of renders at the photo's own FOV
            (yaw ±0.8·hfov, pitch ±0.8·vfov when gravity is unknown). Best seed by RANSAC inliers."""
            ts = time.time()
            seeds = []
            for sd in extra_seeds[:ADHOC_NARROW_MAX_SEEDS]:
                if isinstance(sd, dict) and isinstance(sd.get("yaw"), (int, float)):
                    seeds.append({"yaw": float(sd["yaw"]), "pitch": float(sd.get("pitch") or p0["pitch"]), "roll": float(sd.get("roll") or p0["roll"]),
                                  "source": str(sd.get("source", "request"))})
            if yaw_known:
                seeds.append({"yaw": p0["yaw"], "pitch": p0["pitch"], "roll": p0["roll"], "source": "heading"})
            if yaw_hint is not None:
                seeds.append({"yaw": yaw_hint, "pitch": p0["pitch"], "roll": p0["roll"], "source": "yaw-hint"})
            yaws = [p0["yaw"]] if yaw_known else ADHOC_360_OFFSETS
            pr = [{"yaw": float(y), "pitch": p0["pitch"] + (0.0 if grav_known else dp), "roll": p0["roll"], "vfov": p0["vfov"]}
                  for y in yaws for dp in ((0.0,) if grav_known else ADHOC_SEED_PITCHES)]
            ra = call({"cmd": "align", "priors": pr})
            alts = sorted((a for x in ra["runs"] for a in x.get("alternatives", []) if a.get("pose")), key=lambda a: -a["total"])
            for a in alts:
                if len([q for q in seeds if q["source"] == "app-skyline"]) >= 3:
                    break
                if all(abs(core.dang(a["pose"]["yaw"], q["yaw"])) > 2 * hfov_deg for q in seeds):
                    seeds.append({**{k: a["pose"][k] for k in ("yaw", "pitch", "roll")}, "source": "app-skyline"})
            seeds = seeds[:ADHOC_NARROW_MAX_SEEDS]
            stages.append({"stage": "narrow-seeds", "seeds": seeds, "ms": round((time.time() - ts) * 1000)})
            dy, dp = 0.8 * hfov_deg, 0.8 * p0["vfov"]
            best = None
            tried = []
            for i, sd in enumerate(seeds):
                if time.time() > deadline - 30:
                    break
                t1 = time.time()
                views = []
                for j, pp in enumerate((0.0,) if grav_known else (-dp, 0.0, dp)):
                    d = tmp / f"n{i}_{j}"
                    r1 = call({"cmd": "render", "prior": {"yaw": sd["yaw"], "pitch": sd["pitch"] + pp, "roll": sd["roll"], "vfov": p0["vfov"]},
                               "offsets": [round(-dy, 4), 0, round(dy, 4)], "skyline": False, "allowEmpty": True, "outDir": str(d)})
                    vs = load_views(r1)
                    for v in vs:
                        v.tag = f"{v.tag}_p{j}"
                    views += vs
                    eye = r1["meta"]["eye"]
                    shutil.rmtree(d, ignore_errors=True)
                if not views:  # the whole fan is sky: seed pitched too high
                    tried.append({"source": sd["source"], "seed": {k: sd[k] for k in ("yaw", "pitch", "roll")}, "pose": None,
                                  "inliers": 0, "nLifted": 0, "note": "all views empty (sky)", "ms": round((time.time() - t1) * 1000)})
                    continue
                corr1 = _correspond(photo, views, eye, deadline=deadline, max_kp=SWEEP_KP)
                s1 = core.solve(corr1, views, eye, {**p0, "yaw": sd["yaw"]}, free_focal=not focal_known, deadline=deadline)
                tried.append({"source": sd["source"], "seed": {k: sd[k] for k in ("yaw", "pitch", "roll")}, "pose": s1.get("pose"),
                              "inliers": s1.get("inliers", 0), "nLifted": s1.get("nLifted"), "residualPx": s1.get("residualPx"),
                              "ms": round((time.time() - t1) * 1000)})
                if s1.get("pose") is not None and (best is None or s1.get("inliers", 0) > best[1].get("inliers", 0)):
                    best = (sd, s1)
            ok = best is not None and best[1].get("inliers", 0) >= ADHOC_STAGE1_MIN_INLIERS
            stages.append({"stage": "narrow-match", "tried": tried, "used": ok, "seedSource": best[0]["source"] if ok else None,
                           "pose": best[1].get("pose") if best else None, "inliers": best[1].get("inliers") if best else 0,
                           "ms": round(sum(t["ms"] for t in tried))})
            if ok:
                p2 = {k: float(best[1]["pose"][k]) for k in ("yaw", "pitch", "roll")}
                p2["vfov"] = float(best[1]["pose"]["vfov"]) if not focal_known else p0["vfov"]
                return p2
            if seeds:  # no match support: fall back to the best seed (app skyline order / request order)
                sd = next((q for q in seeds if q["source"] == "app-skyline"), seeds[0])
                stages[-1]["fallbackSeed"] = sd["source"]
                return {"yaw": sd["yaw"], "pitch": sd["pitch"], "roll": sd["roll"], "vfov": p0["vfov"]}
            return prior2

        page_override = {}

        def seeded_stage1(stages, seeds):
            """yawSeeds/poseSeeds first: a local fan (yaw ±hfov/2) at the photo's FOV around each seed,
            render-match RANSAC; the first seed with ≥ ADHOC_STAGE1_MIN_INLIERS inliers and a solved yaw
            inside its fan (consistent rotation) becomes the stage-2 prior and the 360° sweep is
            skipped. Otherwise the normal sweep runs. The HIGH/LOW rule is untouched (hint only)."""
            ts = time.time()
            tried = []
            for i, sd in enumerate(seeds[:ADHOC_MAX_HINT_SEEDS]):
                if time.time() > deadline - 30:
                    break
                t1 = time.time()
                pr = {"yaw": sd["yaw"], "pitch": sd.get("pitch", p0["pitch"]), "roll": sd.get("roll", p0["roll"]), "vfov": p0["vfov"]}
                d = tmp / f"h{i}"
                half = round(0.5 * hfov_deg, 4)
                # a wedge page around the seed (heading = seed): no 360° terrain load, no 40 km drape
                seeded = {**adhoc, "meta": {**adhoc["meta"], "heading": pr["yaw"]}}
                r1 = call({"cmd": "render", "prior": pr, "offsets": [-half, 0, half], "skyline": False, "allowEmpty": True,
                           "outDir": str(d), "adhoc": seeded, "fullTerrain": False})
                views = load_views(r1)
                eye = r1["meta"]["eye"]
                shutil.rmtree(d, ignore_errors=True)
                s1 = {}
                if views:
                    corr1 = _correspond(photo, views, eye, deadline=deadline, max_kp=SWEEP_KP)
                    s1 = core.solve(corr1, views, eye, pr, free_focal=not focal_known, deadline=deadline)
                pose = s1.get("pose")
                consistent = pose is not None and abs(core.dang(pose["yaw"], pr["yaw"])) <= hfov_deg
                ok = consistent and s1.get("inliers", 0) >= ADHOC_STAGE1_MIN_INLIERS
                tried.append({"seed": pr, "source": sd.get("source"), "pose": pose, "inliers": s1.get("inliers", 0),
                              "consistent": consistent, "ok": ok, "ms": round((time.time() - t1) * 1000)})
                if ok:
                    p2 = {k: float(pose[k]) for k in ("yaw", "pitch", "roll")}
                    p2["vfov"] = float(pose["vfov"]) if not focal_known else p0["vfov"]
                    # stage 2 can reuse the seed's wedge page if its ±20° fan stays inside the wedge
                    if abs(core.dang(p2["yaw"], pr["yaw"])) <= 12.0:
                        page_override.update(adhoc=seeded, fullTerrain=False)
                    stages.append({"stage": "hint-seeds", "tried": tried, "used": True, "prior2": p2, "ms": round((time.time() - ts) * 1000)})
                    return True
            stages.append({"stage": "hint-seeds", "tried": tried, "used": False, "ms": round((time.time() - ts) * 1000)})
            return False

        def job():
            stages = []
            prior2 = dict(p0)
            timing = {}
            if two_stage and narrow:
                prior2 = narrow_stage1(stages, prior2)
                timing["stage1"] = round(sum(s["ms"] for s in stages))
            elif two_stage and hint_seeds and seeded_stage1(stages, hint_seeds):
                prior2 = stages[-1]["prior2"]
                timing["stage1"] = round(sum(s["ms"] for s in stages))
            elif two_stage:
                ts = time.time()
                offs = ADHOC_360_OFFSETS if full else [-20, -10, 0, 10, 20]
                d1 = tmp / "s1"
                r1 = call({"cmd": "render", "prior": p0, "offsets": offs, "skyline": False, "outDir": str(d1)})
                views1 = load_views(r1)
                eye = r1["meta"]["eye"]
                corr1 = _correspond(photo, views1, eye, deadline=deadline, max_kp=SWEEP_KP)
                s1 = core.solve(corr1, views1, eye, p0, free_focal=not focal_known, deadline=deadline)
                shutil.rmtree(d1, ignore_errors=True)
                ok1 = s1.get("pose") is not None and s1.get("inliers", 0) >= ADHOC_STAGE1_MIN_INLIERS
                stages.append({"stage": "match-sweep", "offsets": offs, "pose": s1.get("pose"), "inliers": s1.get("inliers"),
                               "inlierFrac": s1.get("inlierFrac"), "residualPx": s1.get("residualPx"), "used": ok1,
                               "ms": round((time.time() - ts) * 1000), "renderTiming": r1.get("timing")})
                if ok1:
                    prior2 = {k: float(s1["pose"][k]) for k in ("yaw", "pitch", "roll")}
                    prior2["vfov"] = float(s1["pose"]["vfov"]) if not focal_known else p0["vfov"]
                elif full:
                    ts = time.time()
                    seeds = [{"yaw": float(y), "pitch": p0["pitch"] + (0.0 if grav_known else dp), "roll": p0["roll"], "vfov": p0["vfov"]}
                             for y in ADHOC_360_OFFSETS for dp in ((0.0,) if grav_known else ADHOC_SEED_PITCHES)]
                    ra = call({"cmd": "align", "priors": seeds})
                    best = max((x for x in ra["runs"] if x.get("pose")), key=lambda x: x["score"], default=None)
                    if best:
                        prior2 = dict(best["pose"])
                    stages.append({"stage": "skyline-seeds", "seeds": len(seeds), "pose": best and best["pose"],
                                   "score": best and best["score"], "used": best is not None, "ms": round((time.time() - ts) * 1000)})
                timing["stage1"] = round(sum(s["ms"] for s in stages))
            ts = time.time()
            d2 = tmp / "s2"
            offs2 = _offsets(body, [round(k * hfov_deg, 4) for k in (-0.5, -0.25, 0, 0.25, 0.5)] if narrow else (-20, -10, 0, 10, 20))
            r = call({"cmd": "render", "prior": prior2, "offsets": offs2, "skyline": fused, "outDir": str(d2), **page_override})
            views = load_views(r)
            sk = load_skyline_files(r.get("skyline"))
            meta = r["meta"]
            corr = _correspond(photo, views, meta["eye"], deadline=deadline)
            res = assemble(corr, views, meta["eye"], prior2, sk, fused=fused, free_focal=not focal_known, meta=None,
                           deadline=deadline, sky_note=None if sk else "app has no horizon/edge map")
            if fused and untrusted_pos:
                basin_gap_check(res, corr, sk, meta, focal_known, deadline)
            shutil.rmtree(d2, ignore_errors=True)
            res["timingMs"] = {**timing, "render": round((time.time() - ts) * 1000), **r.get("timing", {}), **res["timingMs"]}
            res["eye"] = meta["eye"]
            res["adhoc"] = {"id": aid, "size": {"W": W0, "H": H0}, **assumed, "stage2Prior": prior2, "stages": stages}
            return res

        use_t6 = policy == "t6" and two_stage and fused

        def job_t6():
            J = SimpleNamespace(
                call=call, load_views=load_views, load_skyline=load_skyline_files, photo=photo, aspect=aspect, p0=p0,
                focal_known=focal_known, full=full, narrow=narrow, hfov=hfov_deg, yaw_known=yaw_known, grav_known=grav_known,
                yaw_hint=yaw_hint, untrusted=untrusted_pos, position_source=meta_in.get("positionSource"), lat=lat, lon=lon,
                offs2=_offsets(body, [round(k * hfov_deg, 4) for k in (-0.5, -0.25, 0, 0.25, 0.5)] if narrow else (-20, -10, 0, 10, 20)),
                tmp=tmp, deadline=deadline, correspond=_correspond, assemble=assemble, stage=stage, check_cancel=check_cancel,
                ApiError=ApiError, Cancelled=Cancelled,
                release=lambda: RENDERER.send_nowait({"cmd": "release", "adhocId": aid}),
                ignored=[k for k in ("yawSeeds", "poseSeeds", "seeds") if body.get(k)],
                consts={"ADHOC_360_OFFSETS": ADHOC_360_OFFSETS, "SWEEP_KP": SWEEP_KP, "ADHOC_STAGE1_MIN_INLIERS": ADHOC_STAGE1_MIN_INLIERS,
                        "ADHOC_SEED_PITCHES": ADHOC_SEED_PITCHES, "ADHOC_NARROW_MAX_SEEDS": ADHOC_NARROW_MAX_SEEDS})
            res = T6.run(J)
            res["rule"] = T6.rule_info()
            res["adhoc"] = {"id": aid, "size": {"W": W0, "H": H0}, **assumed, "stage2Prior": res.pop("stage2Prior", None), "stages": []}
            return res

        def job_and_release():
            try:
                return job_t6() if use_t6 else job()
            finally:
                # inside the job lock: the next request's render calls can't interleave with this
                try:
                    RENDERER.send_nowait({"cmd": "release", "adhocId": aid})
                except Exception:  # noqa: BLE001
                    pass

        try:
            res = _run_job(job_and_release, deadline, "adhoc-t6" if use_t6 else "adhoc")
        except ValueError as e:
            raise ApiError(400, "bad_render", str(e)) from e
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    res["timingMs"]["total"] = round((time.time() - t0) * 1000)
    res["policy"] = policy
    if policy == "t6" and not use_t6:
        res["policyNote"] = ("single fused stage (heading, gravity and focal known): no stage-1 search, v034 confidence"
                             if fused else "fused:false: legacy render-match, no T6 rule")
    return res


class Handler(BaseHTTPRequestHandler):
    server_version = "SummitLensMatcher/0.1"

    def log_message(self, fmt, *args):
        if getattr(self, "_quiet", False):
            return
        sys.stderr.write(f"[matcher] {self.address_string()} {fmt % args}\n")

    def _cors(self):
        origin = self.headers.get("Origin")
        if origin and (origin in ALLOWED_ORIGINS or "*" in ALLOWED_ORIGINS):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Queue-Ticket")
            self.send_header("Access-Control-Max-Age", "600")
            self.send_header("Access-Control-Expose-Headers", "Retry-After, X-Queue-Ticket")

    def _json(self, status: int, obj: dict, headers: dict | None = None):
        body = json.dumps(obj).encode()
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self._cors()
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            sys.stderr.write(f"[matcher] client went away before the {status} response\n")

    def client_gone(self) -> bool:
        """True once the client has closed its end (readable socket with EOF, or a socket error)."""
        import select
        import socket

        try:
            r, _, _ = select.select([self.connection], [], [], 0)
            if not r:
                return False
            return self.connection.recv(1, socket.MSG_PEEK) == b""
        except OSError:
            return True

    def _err(self, e: ApiError):
        if e.status == 503 and e.code == "busy" and not self.headers.get("X-Queue-Ticket"):
            # ticketless busy clients that re-poll immediately (~40 req/s seen) are slowed down and not
            # logged line-by-line; ticket-honouring clients are answered at once
            self._quiet = True
            _note_ticketless_busy()
            if _TARPIT.acquire(blocking=False):
                try:
                    time.sleep(min(TARPIT_S, float(e.retry_after or TARPIT_S)))
                finally:
                    _TARPIT.release()
        extra = {"Retry-After": str(e.retry_after)} if e.retry_after else {}
        body = {"ok": False, "error": {"code": e.code, "message": e.message}, "version": core.VERSION}
        if e.ticket is not None:
            extra["X-Queue-Ticket"] = str(e.ticket)
            body["ticket"] = str(e.ticket)
            body["retryAfterS"] = e.retry_after
        self._json(e.status, body, extra or None)

    def do_OPTIONS(self):  # noqa: N802
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):  # noqa: N802
        if self.path.split("?")[0] != "/health":
            return self._err(ApiError(404, "not_found", "GET /health or POST /match"))
        rend = renderer_health()
        self._json(200, {
            # ok:false when the renderer probe says the browser is unusable (the app treats the service as down)
            "ok": PROBE["ok"] is not False, "device": STATE["device"], "version": core.VERSION,
            "models": {"extractor": "ALIKED-n16 (4096 kp)", "matcher": "LightGlue (aliked)", "fusion": "fusion.py joint Huber LM, λ=1", "warm": STATE["device"] is not None,
                       "warmupMs": STATE["warmupMs"]},
            "renderer": rend,
            "capabilities": ["photoId", "multipart", "adhoc"],
            "policy": {"default": DEFAULT_POLICY, "available": list(POLICIES), "t6Rule": T6.rule_info()},
            "busy": JOB_LOCK.locked(), "queue": queue_status(), "uptimeS": round(time.time() - STATE["started"]), "requests": STATE["requests"],
        })

    def do_POST(self):  # noqa: N802
        if self.path.split("?")[0] != "/match":
            return self._err(ApiError(404, "not_found", "GET /health or POST /match"))
        # CR-06: reject rebinding (bad Host), foreign browser origins, and non-JSON bodies. A text/plain POST
        # is a no-preflight "simple" request from any site, so JSON must be declared as application/json.
        origin = self.headers.get("Origin")
        if not host_allowed(self.headers.get("Host")):
            return self._err(ApiError(403, "forbidden", "Host not allowed (set MATCHER_HOSTS)"))
        if origin and origin not in ALLOWED_ORIGINS and "*" not in ALLOWED_ORIGINS:
            return self._err(ApiError(403, "forbidden", "Origin not allowed (set MATCHER_CORS)"))
        _ctype = self.headers.get("Content-Type", "").split(";")[0].strip().lower()
        if _ctype not in ("application/json", "multipart/form-data"):
            return self._err(ApiError(415, "unsupported_media_type", "Content-Type must be application/json or multipart/form-data"))
        STATE["requests"] += 1
        _TL.client_gone = self.client_gone
        _TL.ticket = self.headers.get("X-Queue-Ticket")
        try:
            with QUEUE["lock"]:  # queue full: answer before reading/decoding the body
                if JOB_LOCK.locked() and QUEUE["waiting"] >= 1:
                    raise _busy("another match is running and one is already queued")
            n = int(self.headers.get("Content-Length") or 0)
            if n <= 0:
                raise ApiError(400, "bad_request", "empty body")
            if n > MAX_BODY:
                raise ApiError(413, "too_large", f"body over {MAX_BODY} bytes")
            raw = self.rfile.read(n)
            ctype = self.headers.get("Content-Type", "")
            if ctype.startswith("multipart/form-data"):
                res = match_multipart(ctype, raw)
            else:
                try:
                    body = json.loads(raw)
                except json.JSONDecodeError as e:
                    raise ApiError(400, "bad_request", f"body is not JSON: {e}") from e
                if not isinstance(body, dict):
                    raise ApiError(400, "bad_request", "body must be a JSON object")
                res = match_adhoc(body) if ("meta" in body and "photoId" not in body) else match_photo_id(body)
            self._json(200, {"ok": res.get("pose") is not None, **res, "version": core.VERSION})
        except Cancelled as e:
            sys.stderr.write(f"[matcher] job cancelled: {e}\n")
            self._err(ApiError(499, "client_closed", str(e)))  # nobody is listening; logged only
        except ApiError as e:
            self._err(e)
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            self._err(ApiError(500, "internal", f"{type(e).__name__}: {e}"))
        finally:
            _TL.client_gone = None
            _TL.ticket = None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default=os.environ.get("MATCHER_HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("MATCHER_PORT", 8765)))
    ap.add_argument("--no-warm-renderer", action="store_true", help="don't launch Chromium until the first photoId request")
    a = ap.parse_args()
    os.environ["MATCHER_PORT"] = str(a.port)  # render_worker blocks its pages from calling back into us
    if DEFAULT_POLICY not in POLICIES:
        raise SystemExit(f"MATCHER_POLICY must be one of {', '.join(POLICIES)} (got {DEFAULT_POLICY!r})")
    rule = T6.assert_rule()  # the frozen T6 rule block must hash to 292fb74f… or the service doesn't start
    print(f"[matcher] ad-hoc policy default {DEFAULT_POLICY}; t6 rule {rule['id']} sha1 {rule['sha1']} verified", file=sys.stderr)
    # reap the render worker's process group however we exit (SIGKILL is covered by the worker's own
    # stdin-EOF handler: when this process dies, its pipe closes and the worker closes Chromium and exits)
    import atexit
    import signal

    atexit.register(RENDERER.kill)

    def _on_signal(signum, _frame):
        RENDERER.kill()
        sys.exit(128 + signum)

    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)
    w = core.warmup()
    STATE.update(device=w["device"], warmupMs=w["warmupMs"])
    release_memory()
    print(f"[matcher] models warm on {w['device']} in {w['warmupMs']} ms", file=sys.stderr)
    if not a.no_warm_renderer:
        try:
            RENDERER.call({"cmd": "ping"}, 30, check=False)
        except ApiError as e:
            print(f"[matcher] renderer not available ({e.message}); photoId mode will retry", file=sys.stderr)
        probe_renderer()
    threading.Thread(target=probe_loop, daemon=True).start()
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    srv.daemon_threads = True
    print(f"[matcher] listening on http://{a.host}:{a.port}", file=sys.stderr)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        RENDERER.kill()


if __name__ == "__main__":
    main()
