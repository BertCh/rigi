"""Shared helpers for the TM research program. See README.md for the rules."""
from __future__ import annotations
import contextlib, fcntl, json, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
CACHE = HERE / "cache"
sys.path.insert(0, str(ROOT / "tools/matcher/v2"))
sys.path.insert(0, str(ROOT / "tools/matcher/stage1"))


@contextlib.contextmanager
def _lock(name: str, wait_log: str):
    f = open(HERE / f".{name}.lock", "w")
    t0 = time.time()
    while True:
        try:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            if time.time() - t0 > 5:
                print(f"[tm] waiting for {wait_log} lock…", file=sys.stderr, flush=True)
                t0 = time.time() + 55
            time.sleep(2)
    try:
        yield
    finally:
        fcntl.flock(f, fcntl.LOCK_UN)
        f.close()


def render_lock():
    """Hold for the whole lifetime of an s1.Worker (one render worker machine-wide)."""
    return _lock("render", "render")


def gpu_lock():
    """Hold while a heavy (> 4 GB) MPS model is loaded."""
    return _lock("gpu", "gpu")


def dev_ids() -> list[str]:
    s = json.load(open(ROOT / "tools/bench/split.json"))
    return sorted(s["dev"])


def assert_dev(pid: str):
    assert pid in set(dev_ids()), f"{pid} is not a dev id"
