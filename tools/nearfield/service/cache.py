"""Disk cache: key = sha1(endpoint, sha1(image bytes)..., sorted params). LRU by mtime, capped (default 1 GB)."""
from __future__ import annotations

import hashlib
import json
import os
import threading
from pathlib import Path

import _env

_lock = threading.Lock()


def cap_bytes() -> int:
    return int(float(os.environ.get("NEARFIELD_CACHE_MB", "1024")) * 1024 * 1024)


def key(endpoint: str, images: list[bytes], params: dict) -> str:
    h = hashlib.sha1()
    h.update(endpoint.encode())
    for b in images:
        h.update(hashlib.sha1(b).digest())
    h.update(json.dumps(params, sort_keys=True, default=str).encode())
    return h.hexdigest()


def _path(k: str) -> Path:
    return _env.CACHE_DIR / k[:2] / f"{k}.bin"


def get(k: str) -> tuple[str, dict, bytes] | None:
    p = _path(k)
    try:
        raw = p.read_bytes()
        os.utime(p)  # LRU touch
    except OSError:
        return None
    try:
        nl = raw.index(b"\n")
        meta = json.loads(raw[:nl])
        return meta["ctype"], meta.get("headers", {}), raw[nl + 1:]
    except (ValueError, KeyError, TypeError):  # truncated / corrupt entry: treat as a miss and drop it
        try:
            p.unlink()
        except OSError:
            pass
        return None


def put(k: str, ctype: str, headers: dict, body: bytes):
    if len(body) > cap_bytes() // 4:
        return  # never let one entry dominate the cache
    p = _path(k)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(f".tmp{os.getpid()}.{threading.get_ident()}")  # per thread: identical concurrent requests raced here
    tmp.write_bytes(json.dumps({"ctype": ctype, "headers": headers}).encode() + b"\n" + body)
    os.replace(tmp, p)
    evict()


def stats() -> dict:
    files = list(_env.CACHE_DIR.glob("*/*.bin")) if _env.CACHE_DIR.exists() else []
    return {"entries": len(files), "bytes": sum(f.stat().st_size for f in files), "capBytes": cap_bytes(), "dir": str(_env.CACHE_DIR)}


def evict():
    with _lock:
        if not _env.CACHE_DIR.exists():
            return
        files = []
        for f in _env.CACHE_DIR.glob("*/*.bin"):
            try:
                st = f.stat()
                files.append((st.st_mtime, st.st_size, f))
            except OSError:
                pass
        total = sum(s for _, s, _ in files)
        cap = cap_bytes()
        for _, s, f in sorted(files):
            if total <= cap:
                break
            try:
                f.unlink()
                total -= s
            except OSError:
                pass
