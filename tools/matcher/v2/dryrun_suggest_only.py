# Rigi
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: Copyright (c) Rigi contributors
"""Dry run of V2_SUGGEST_ONLY=1 without rendering, matching or a worker.

Replays CACHED dev records (run_v2 output `<id>.json` + `raw/<id>.json`, read-only) through the same pure
finalisation run_v2 uses (finalize_v2.decide_moved_eye) in both modes, and checks the invariant the v3
pre-registration relies on:

  with suggest_only=1
    - the final record is the stated-eye result, never a moved-eye one (eyeMoved false, no moveM / eyeWhy)
    - a moved-eye pose appears only as `suggestion`, level LOW; positionTrusted is not set by it
    - final.level equals the stated-eye level (a moved eye never makes a photo HIGH)
    - the stated-eye record is byte-identical to the B record (json, sorted keys) when --b-dir is given
  with suggest_only=0 (parity check of the refactor): the replay reproduces the cached `final`.

  python3 tools/matcher/v2/dryrun_suggest_only.py [--out-dir DIR] [--b-dir DIR] [id ...]
    default out dir: tools/matcher/v2/out/dev; --b-dir: tools/bench/t6/out/raw; default ids: wc_0086 wc_0074.
    Dev ids only (w3_* and split-test ids are refused). Prints pass/fail per id and level transitions; no accuracy numbers.

What a real dry run still needs (batch, browser + matcher venv): run_v2.py with V2_SUGGEST_ONLY=1 on 2 dev photos.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import finalize_v2 as F  # noqa: E402


def rebuild_eye_results(out: dict, recs: dict):
    """(probes, eye_results) as run_v2 held them, from a cached record: probe dicts + per-eye raw records."""
    probes = [dict(p) for p in out.get("eyeProbe", [])]
    results = []
    for er in out.get("eyeResults", []):
        eye = er["eye"]
        key = f"eye:{eye['why']}:{round(eye['e'])},{round(eye['n'])}"
        p = next((q for q in probes if (q["why"], q["e"], q["n"]) == (eye["why"], eye["e"], eye["n"])), dict(eye))
        rk = recs[key]
        results.append((p, rk, F.summarize(rk)))
    return probes, results


def replay(out: dict, recs: dict, suggest_only: bool) -> dict:
    """The final dict run_v2 would produce for this cached record (stated record + per-eye records)."""
    rec0 = recs["stated"]
    final = {**F.summarize(rec0), "eyeMoved": False}
    if out.get("eyeResults"):
        probes, results = rebuild_eye_results(out, recs)
        final = F.decide_moved_eye(rec0, int(out["stated"]["sweepBest"]), probes, results, final, suggest_only)
    return final


def _norm(x):
    """JSON-comparable form: cached records stringified numpy bools ('True'), fresh ones are Python bools."""
    if isinstance(x, dict):
        return {k: _norm(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [_norm(v) for v in x]
    return str(x) if isinstance(x, bool) else x


def _strip(x: dict) -> dict:
    return {k: v for k, v in x.items() if k not in ("suggestion", "eyeMoved", "moveM", "eyeWhy", "eyeLatLon", "vetoed")}


def check_invariants(out: dict, recs: dict, b_rec: dict | None = None) -> dict:
    """Run the replay both ways; returns {violations: [...], transition: str, parity: bool}."""
    v = []
    on = replay(out, recs, True)
    off = replay(out, recs, False)
    stated = F.summarize(recs["stated"])
    if on.get("eyeMoved") or "moveM" in on or "eyeWhy" in on:
        v.append("moved-eye result accepted under suggest_only")
    if on["level"] != stated["level"]:
        v.append(f"final level {on['level']} != stated level {stated['level']}")
    if json.dumps(_strip(on), sort_keys=True, default=str) != json.dumps(_strip(stated), sort_keys=True, default=str):
        v.append("stated-eye summary changed")
    sug = on.get("suggestion")
    if sug and sug.get("level") != "LOW":
        v.append(f"suggestion level {sug.get('level')} is not LOW")
    if F.position_trusted({"positionSource": out.get("positionSource")}, on) != (out.get("positionSource") == "exif-gps"):
        v.append("positionTrusted differs from the stated-eye value")
    if b_rec is not None:
        a = {k: x for k, x in recs["stated"].items() if k != "reused"}
        b = {k: x for k, x in b_rec.items() if k != "reused"}
        if json.dumps(a, sort_keys=True, default=str) != json.dumps(b, sort_keys=True, default=str):
            v.append("stated-eye record is not byte-identical to B's")
    transition = "no moved-eye result"
    if off.get("eyeMoved"):
        transition = f"moved-eye {off['level']} (accepted without the flag) -> stated {on['level']}" + (
            f" + LOW suggestion (levelAtEye {sug['levelAtEye']})" if sug else " (NO suggestion)")
        if not sug:
            v.append("moved-eye result vanished without a suggestion")
    elif sug:
        transition = f"stated {on['level']} + LOW suggestion (levelAtEye {sug['levelAtEye']})"
    # the `suggestion` block was added after some dev records were written, so it is not part of the parity check
    parity = json.dumps(_norm({k: x for k, x in off.items() if k != "suggestion"}), sort_keys=True, default=str) == json.dumps(
        _norm({k: x for k, x in out["final"].items() if k != "suggestion"}), sort_keys=True, default=str)
    return {"violations": v, "transition": transition, "parity": parity}


def main(argv: list[str]) -> int:
    root = HERE.parents[2]
    out_dir, b_dir, ids, i = root / "tools/matcher/v2/out/dev", root / "tools/bench/t6/out/raw", [], 0
    while i < len(argv):
        if argv[i] == "--out-dir":
            out_dir, i = Path(argv[i + 1]), i + 2
        elif argv[i] == "--b-dir":
            b_dir, i = Path(argv[i + 1]), i + 2
        else:
            ids.append(argv[i])
            i += 1
    ids = ids or ["wc_0086", "wc_0074"]
    split = root / "tools/bench/split.json"
    test = set(json.loads(split.read_text())["test"]) if split.exists() else set()
    bad = [x for x in ids if x.startswith("w3_") or x in test]
    if bad:
        raise SystemExit(f"refused (dev ids only): {bad}")
    rc = 0
    for pid in ids:
        f, raw = out_dir / f"{pid}.json", out_dir / "raw" / f"{pid}.json"
        if not (f.exists() and raw.exists()):
            print(f"{pid}: SKIP (no cached record under {out_dir})")
            continue
        bf = b_dir / f"{pid}.json"
        res = check_invariants(json.load(open(f)), json.load(open(raw)), json.load(open(bf)) if bf.exists() else None)
        print(f"{pid}: {'PASS' if not res['violations'] else 'FAIL'} | {res['transition']} | refactor parity with cached final: {res['parity']}"
              f"{' | B record: ' + ('compared' if bf.exists() else 'not found (stated-eye identity vs B not checked)')}")
        for x in res["violations"]:
            print(f"  VIOLATION: {x}")
            rc = 1
    return rc


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
