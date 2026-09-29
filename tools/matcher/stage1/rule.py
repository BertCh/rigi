"""T6 selection policy + confidence rule over stage-1 records (the text between the RULE markers is frozen:
its sha1 is in tools/bench/t6/RULE_FROZEN.sha1 and must match before any final evaluation / test run).

select(rec)        → the candidate whose fused pose is returned
confidence(rec, c) → ("HIGH"|"LOW", checks with failed[])
"""
from __future__ import annotations

import hashlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

# ==== RULE BEGIN ====
# Definitions, per verified candidate c (its stage-2 fused result, the service's own code path):
#   apriori(c)   = fusion.md a-priori HIGH: cueAgreeDeg < 1 ∧ skylineMedPx < 4 ∧ matchSupport ≥ 0.3
#   matchdom(c)  = "match-dominant": matchSupport ≥ 0.70 ∧ inliers ≥ 1000 (lifted matches within 6 px of the
#                  fused pose, 1024-px grid) ∧ fused pose within 0.3° (|Δyaw| + |Δpitch|) of the match-only pose
#   strong(c)    = matchSupport ≥ 0.5 ∧ inliers ≥ 300   (a competing basin with real match evidence)
#   gapOK(c)     = EXIF-GPS position, or basin gap ≥ 0.20 (pose6 grid on the stage-2 cue + matches; the v0.3.4
#                  service trigger, MATCHER_BASIN_GAP_MIN)
#   high(c)      = (apriori(c) ∨ matchdom(c)) ∧ gapOK(c)
# Selection:
#   1. if some candidate is high: among the high ones take the largest matchSupport·inliers;
#   2. else: the candidate with the largest matchSupport·inliers among strong ones;
#   3. else: the service's own stage-1 choice (the baseline candidate: sweep40 if ≥ 30 inliers, else the
#      app-skyline seed; narrow_stage1 for hfov < 25°).
# Confidence of the selected candidate s:
#   HIGH iff high(s) ∧ no ambiguity, where ambiguity = another verified candidate q with strong(q) whose fused
#   pose is > 2° (|Δyaw| + |Δpitch|) from s's fused pose.  Otherwise LOW.
AGREE_DEG, SKY_PX, SUPPORT = 1.0, 4.0, 0.3
MD_SUPPORT, MD_INLIERS, MD_MATCH_DEG = 0.70, 1000, 0.3
STRONG_SUPPORT, STRONG_INLIERS = 0.5, 300
GAP_MIN = 0.20
AMBIG_DEG = 2.0
# ==== RULE END ====

RULE_ID = "t6-rule-v1"


def rule_text() -> str:
    s = Path(__file__).read_text()
    a = s.index("# ==== RULE BEGIN ====")
    b = s.index("# ==== RULE END ====") + len("# ==== RULE END ====")
    return s[a:b]


def rule_sha1() -> str:
    return hashlib.sha1(rule_text().encode()).hexdigest()


def dang(a, b):
    return (a - b + 540.0) % 360.0 - 180.0


def verified(rec):
    return [c for c in rec.get("candidates", []) if (c.get("fused") or {}).get("pose")]


def _sup(c):
    return (c["fused"].get("checks") or {}).get("matchSupport") or 0.0


def _inl(c):
    return c["fused"].get("inliers") or 0


def _dist(p, q):
    return abs(dang(p["yaw"], q["yaw"])) + abs(p["pitch"] - q["pitch"])


def apriori(c):
    ch = c["fused"].get("checks") or {}
    return (ch.get("cueAgreeDeg") is not None and ch["cueAgreeDeg"] < AGREE_DEG and ch.get("skylineMedPx") is not None
            and ch["skylineMedPx"] < SKY_PX and _sup(c) >= SUPPORT)


def matchdom(c):
    m = ((c["fused"].get("cues") or {}).get("match") or {}).get("pose")
    return bool(m) and _sup(c) >= MD_SUPPORT and _inl(c) >= MD_INLIERS and _dist(c["fused"]["pose"], m) <= MD_MATCH_DEG


def strong(c):
    return _sup(c) >= STRONG_SUPPORT and _inl(c) >= STRONG_INLIERS


def gap_ok(rec, c):
    if rec.get("positionSource") == "exif-gps":
        return True
    g = (c["fused"].get("basinGap") or {}).get("gap")
    return g is not None and g >= GAP_MIN


def high(rec, c):
    return (apriori(c) or matchdom(c)) and gap_ok(rec, c)


def baseline(rec):
    s = rec.get("baselineSeed")
    return next((c for c in verified(rec) if c.get("source") == s or s in c.get("alsoFrom", [])), None)


def select(rec):
    vs = verified(rec)
    hs = [c for c in vs if high(rec, c)]
    if hs:
        return max(hs, key=lambda c: _sup(c) * _inl(c))
    st = [c for c in vs if strong(c)]
    if st:
        return max(st, key=lambda c: _sup(c) * _inl(c))
    return baseline(rec) or (vs[0] if vs else None)


def confidence(rec, c):
    ch = dict(c["fused"].get("checks") or {})
    failed = []
    if not apriori(c):
        failed.append("apriori")
    if not matchdom(c):
        failed.append("matchDominant")
    if not gap_ok(rec, c):
        failed.append("basinGap")
    amb = [q for q in verified(rec) if q is not c and strong(q) and _dist(q["fused"]["pose"], c["fused"]["pose"]) > AMBIG_DEG]
    if amb:
        failed.append("ambiguity")
    ch.update(apriori=apriori(c), matchDominant=matchdom(c), basinGap=(c["fused"].get("basinGap") or {}).get("gap"),
              gapOK=gap_ok(rec, c), ambiguity=len(amb), inliers=_inl(c), unmet=failed)
    return ("HIGH" if high(rec, c) and not amb else "LOW"), ch
