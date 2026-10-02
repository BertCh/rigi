# Rigi
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: Copyright (c) Rigi contributors
"""Code stamps for evaluation arms (single source of the algorithm; final.py's A/B/C stamps use it too).

stamp = sha1 over, for every listed file in order, `<repo-relative path><file bytes>`, then the JSON of the env knobs
(sort_keys) → first 16 hex chars. This is exactly the algorithm final.code_stamp used for the test run
(arm B `a5d380c36fcb0497`, pipeline `c2d406ea3c557e6e` is stage-1's own s1.code_stamp). The git sha and dirty flag
are reported next to the stamp but are NOT hashed (as before), so a stamp depends on file content only.

  python3 tools/bench/final/stamps.py <A|B|C|V2> [--json]
  V2 = the v3 arm C: tools/matcher/v2/run_v2.py + finalize_v2.py + viewpoints.py on top of arm B's files.

Stdlib only. Records carry `armStamp` (and run-log headers print it): see header_line().
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
MATCHER = ROOT / "tools/matcher"
STAGE1 = MATCHER / "stage1"
V2 = MATCHER / "v2"

ARM_FILES = {
    "common": [HERE / "final.py", HERE / "run_arm.sh", MATCHER / "match.py", MATCHER / "common.py", MATCHER / "fusion.py"],
    "A": [STAGE1 / f for f in ("pipeline.py", "s1.py", "skyglobal.py")] + [MATCHER / "pose6.py", MATCHER / "dem.py"],
    "B": [STAGE1 / f for f in ("pipeline.py", "s1.py", "skyglobal.py", "rule.py", "policy.py", "finalize.py")] + [MATCHER / "pose6.py", MATCHER / "dem.py"],
    "C": [MATCHER / f for f in ("pose6.py", "pose6_inputs.py", "dem.py", "worker_client.py")] + [STAGE1 / "vendor_v03" / "render_worker.mjs"],
    # v3 arm C: B's stage-1 code plus the v2 eye fallback (V2 reuses B's records, so B's files are part of it)
    "V2": [STAGE1 / f for f in ("pipeline.py", "s1.py", "skyglobal.py", "rule.py", "manifest_guard.py")]
    + [V2 / f for f in ("run_v2.py", "finalize_v2.py", "viewpoints.py")] + [MATCHER / "dem.py"],
}
ENV_KEYS = ["MATCHER_LG_DEVICE", "MATCHER_SWEEP_KP", "MATCHER_BASIN_GAP_MIN", "STAGE1_LG_PRUNE", "FINAL_WALL_S", "FINAL_C_LG"]
V2_ENV_KEYS = ["MATCHER_LG_DEVICE", "MATCHER_SWEEP_KP", "STAGE1_LG_PRUNE", "V2_MATCHER", "V2_PRIORS", "V2_SUGGEST_ONLY", "V2_NO_FALLBACK"]


def arm_files(arm: str) -> list[Path]:
    files = list(ARM_FILES["common"] + ARM_FILES[arm])
    if arm in ("A", "B", "V2"):
        files += sorted(p for p in (STAGE1 / "vendor").iterdir() if p.suffix in (".py", ".mjs", ".sha1"))
    return files


def stamp_files(root: Path, files: list[Path], env: dict) -> dict:
    """The stamp algorithm: sha1 over (relative path, bytes) per file, then the env JSON. `files` order is significant."""
    h = hashlib.sha1()
    per = {}
    for f in files:
        b = Path(f).read_bytes()
        rel = str(Path(f).relative_to(root))
        per[rel] = hashlib.sha1(b).hexdigest()[:12]
        h.update(rel.encode())
        h.update(b)
    h.update(json.dumps(env, sort_keys=True).encode())
    return {"sha1": h.hexdigest()[:16], "env": env, "files": per}


def arm_stamp(arm: str, environ: dict | None = None, wall_s: int | None = None) -> dict:
    environ = os.environ if environ is None else environ
    keys = V2_ENV_KEYS if arm == "V2" else ENV_KEYS
    env = {k: environ.get(k) for k in keys}
    if arm != "V2":
        env["FINAL_WALL_S"] = str(wall_s if wall_s is not None else int(environ.get("FINAL_WALL_S", 600)))
    return stamp_files(ROOT, arm_files(arm), env)


def git_state(root: Path = ROOT) -> dict:
    def run(*a):
        return subprocess.run(["git", "-C", str(root), *a], capture_output=True, text=True, timeout=20).stdout.strip()
    try:
        return {"sha": run("rev-parse", "HEAD"), "dirty": bool(run("status", "--porcelain", "--", "tools/matcher", "tools/bench/final"))}
    except (OSError, subprocess.SubprocessError):
        return {"sha": None, "dirty": None}


def full_stamp(arm: str, environ: dict | None = None) -> dict:
    s = arm_stamp(arm, environ)
    return {**s, "arm": arm, "git": git_state()}


def header_line(stamp: dict, prereg_sha1: str | None = None) -> str:
    """First line of an arm's run log: prereg sha1 (when given), arm, stamp, git sha."""
    g = stamp.get("git") or {}
    parts = [f"prereg {prereg_sha1}" if prereg_sha1 else None, f"arm {stamp.get('arm')}", f"stamp {stamp['sha1']}",
             f"git {g.get('sha')}{'+dirty' if g.get('dirty') else ''}"]
    return "# " + " ".join(p for p in parts if p)


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) != 1 or args[0] not in ARM_FILES or args[0] == "common":
        raise SystemExit("usage: stamps.py <A|B|C|V2> [--json]")
    st = full_stamp(args[0])
    print(json.dumps(st, indent=1) if "--json" in sys.argv else header_line(st, os.environ.get("PREREG_SHA1")))
