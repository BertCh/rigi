"""Hypothesis selection policies over pipeline records (offline) + dev summary.

  python policy.py [--runs out/runs/dev] [--policy NAME]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import evaluate as E  # noqa: E402

HERE = Path(__file__).resolve().parent


def verified(r):
    return [c for c in r.get("candidates", []) if (c.get("fused") or {}).get("pose")]


def is_src(c, src):
    return c.get("source") == src or src in c.get("alsoFrom", [])


def baseline(r):
    """What the service does: stage 2 from the sweep40 seed if it had ≥ 30 inliers, else the app seeds."""
    s = r.get("baselineSeed")
    return next((c for c in verified(r) if is_src(c, s)), None)


def fscore(c):
    return (c.get("fused") or {}).get("fusionScore") or 0.0


def high(c):
    return (c.get("fused") or {}).get("level") == "high"


def high_first(r):
    """Any HIGH candidate (best fusionScore) else the baseline candidate."""
    hs = [c for c in verified(r) if high(c)]
    if hs:
        return max(hs, key=fscore)
    return baseline(r)


def best_score(r):
    """Best fusionScore over all verified candidates (HIGH preferred)."""
    vs = verified(r)
    if not vs:
        return None
    return max(vs, key=lambda c: (high(c), fscore(c)))


POLICIES = {"baseline": baseline, "high_first": high_first, "best_score": best_score}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", default=str(HERE / "out" / "runs" / "dev"))
    ap.add_argument("--rows", action="store_true")
    a = ap.parse_args()
    recs = E.load_records(Path(a.runs))
    for name, fn in POLICIES.items():
        s = E.summarize(recs, fn, name)
        print(json.dumps(s["summary"]))
        if a.rows:
            for x in s["rows"]:
                print("   ", x["id"], x["verdict"], "H" if x["high"] else "L", x["source"], x["checks"])


if __name__ == "__main__":
    main()
