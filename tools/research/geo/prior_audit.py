"""Camera-prior audit (DEV split only): how far the metadata prior sits from the blind-verified pose.

    python3 tools/research/geo/prior_audit.py [--json out/geocam/prior-audit.json]

For every dev photo with a verified-correct reference (tools/matcher/v2/refs.py, which asserts dev ids)
it compares the manifest's heading (EXIF GPSImgDirection or the Commons location template) with the
reference yaw, and the FocalLengthIn35mmFormat prior with the reference vfov (35 mm diagonal 43.2666 mm,
as src/lib/camera/focal.ts; cropped photos are treated as uncropped, unlike the app's crop-aware
vfovFromF35, so a crop shows up as focal error here). It reports the error distributions against the live solve's windows
(src/lib/geo/solve.ts: local yaw ±25° with σ 15°, focal σ 6 %). Read-only; no test-half or data_v3 input.
These are calibration observations for reports/archive/steps-2026-10-02/camera-prior.md, not results.
The manifest (tools/bench/data) is gitignored: without it the script prints SKIP and exits 0.
"""
from __future__ import annotations

import argparse
import json
import math
import statistics as st
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
MANIFEST = ROOT / "tools/bench/data/manifest.json"
FF35_DIAGONAL_MM = 43.2666  # src/lib/camera/focal.ts
SOLVE_YAW_WINDOW_DEG = 25.0  # src/lib/geo/solve.ts yawRange default
SOLVE_FOCAL_SIGMA = 0.06  # src/lib/geo/solve.ts DEFAULT_SIGMA.focal


def wrap180(d: float) -> float:
    return ((d + 180.0) % 360.0) - 180.0


def focal_ratio(f35: float, width: int, height: int, ref_vfov_deg: float) -> float:
    """Reference focal / prior focal, both in 35 mm-equivalent mm (> 1: the scene is narrower than EXIF says)."""
    vertical_mm = FF35_DIAGONAL_MM * height / math.hypot(width, height)
    ref_f35 = vertical_mm / 2.0 / math.tan(math.radians(ref_vfov_deg) / 2.0)
    return ref_f35 / f35


def summarise(values: list[float]) -> dict:
    if not values:
        return {"n": 0}
    s = sorted(values)
    return {
        "n": len(s),
        "median": round(st.median(s), 3),
        "p90": round(s[min(len(s) - 1, math.ceil(0.9 * len(s)) - 1)], 3),
        "max": round(s[-1], 3),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", type=Path, default=None)
    args = ap.parse_args()
    if not MANIFEST.exists():
        print(f"SKIP: {MANIFEST.relative_to(ROOT)} missing (gitignored bench data)")
        return 0
    sys.path.insert(0, str(ROOT / "tools/matcher/v2"))
    import refs  # noqa: E402  (asserts dev ids)

    manifest = {m["id"]: m for m in json.load(open(MANIFEST))}
    heading_err: dict[str, list[float]] = {}
    focal: list[float] = []
    rows = []
    for pid in refs.dev_ids():
        correct = refs.correct_refs(pid)
        if not correct:
            continue
        m = manifest[pid]
        pose = correct[0]["pose"]
        row = {"id": pid, "headingSource": m.get("headingSource"), "camera": m.get("camera")}
        if m.get("headingDeg") is not None:
            d = wrap180(pose["yaw"] - m["headingDeg"])
            row["headingErrDeg"] = round(d, 2)
            heading_err.setdefault(str(m.get("headingSource")), []).append(abs(d))
        if m.get("focal35mm") and pose.get("vfov"):
            r = focal_ratio(m["focal35mm"], m["width"], m["height"], pose["vfov"])
            row["focalRatio"] = round(r, 4)
            focal.append(r)
        rows.append(row)

    out = {
        "split": "dev",
        "photosWithRef": len(rows),
        "heading": {
            src: {
                **summarise(v),
                "withinSolveWindow": sum(x <= SOLVE_YAW_WINDOW_DEG for x in v),
                "near180": sum(x >= 150 for x in v),
            }
            for src, v in heading_err.items()
        },
        "focal": {
            **summarise([abs(r - 1) for r in focal]),
            "medianRatio": round(st.median(focal), 4) if focal else None,
            "withinSigma": sum(abs(r - 1) <= SOLVE_FOCAL_SIGMA for r in focal),
            "within2Sigma": sum(abs(r - 1) <= 2 * SOLVE_FOCAL_SIGMA for r in focal),
        },
        "rows": rows,
    }
    print(json.dumps({k: v for k, v in out.items() if k != "rows"}, indent=2))
    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
