"""Minimal client for tools/matcher/server/render_worker.mjs (used as-is, never edited).

One JSON object per line on stdin/stdout; see the header of render_worker.mjs for the protocol.
Needs the dev server (APP_URL, default http://localhost:3100).
"""
from __future__ import annotations

import json
import os
import subprocess
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORKER = ROOT / "tools" / "matcher" / "server" / "render_worker.mjs"


class Worker:
    def __init__(self, port: int = 8799):
        env = {**os.environ, "MATCHER_PORT": str(port)}
        self.p = subprocess.Popen(["node", str(WORKER)], cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, text=True, bufsize=1, env=env)
        self.n = 0
        self.lock = threading.Lock()

    def call(self, req: dict, timeout: float = 600) -> dict:
        with self.lock:
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
