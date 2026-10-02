# Rigi
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: Copyright (c) Rigi contributors
"""v2 finalisation (finalize_v2.py) and the V2_SUGGEST_ONLY dry-run replay, on synthetic records only."""
import copy
import json
import sys
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import dryrun_suggest_only as D  # noqa: E402
import finalize_v2 as F  # noqa: E402


def cand(yaw=70.0, support=0.8, inliers=1500, gap=0.5, source="sweep40", eye_h=900.0):
    """A verified candidate that is a-priori HIGH when gapOK (rule.py apriori: cue < 1°, sky < 4 px, support ≥ 0.3)."""
    return {"source": source, "inliers": inliers,
            "fused": {"pose": {"yaw": yaw, "pitch": -5.0, "roll": 0.0, "vfov": 40.0}, "inliers": inliers,
                      "checks": {"cueAgreeDeg": 0.5, "skylineMedPx": 2.0, "matchSupport": support}, "basinGap": {"gap": gap}}}


def rec(cands, lat=46.0, lon=8.0, source="manual", seed="sweep40"):
    return {"lat": lat, "lon": lon, "eye": [0, 0, 900.0], "positionSource": source, "baselineSeed": seed, "candidates": cands}


def probe(why="high100", e=100.0, n=0.0, best=1000):
    return {"why": why, "e": e, "n": n, "lat": 46.001, "lon": 8.001, "best": best}


def case(moved_cands, stated_cands=None, source="manual", probes_best=(1000,)):
    """Cached-record shape (run_v2 out + raw recs) with one moved eye per probe."""
    stated = rec(stated_cands if stated_cands is not None else [cand(support=0.2, inliers=50, gap=0.0)], source=source)
    probes = [probe(why=f"p{i}", e=100.0 * (i + 1), best=b) for i, b in enumerate(probes_best)]
    recs = {"stated": stated}
    results = []
    for p, mc in zip(probes, moved_cands):
        rk = rec(mc, lat=p["lat"], lon=p["lon"], source="moved")
        recs[f"eye:{p['why']}:{round(p['e'])},{round(p['n'])}"] = rk
        results.append({"eye": {k: p[k] for k in ("why", "e", "n", "lat", "lon", "best")}, "summary": F.summarize(rk)})
    out = {"id": "syn", "positionSource": source, "stated": {"sweepBest": 10, "summary": F.summarize(stated)},
           "eyeProbe": probes, "eyeResults": results}
    out["final"] = D.replay(out, recs, False)
    return out, recs


class Finalize(unittest.TestCase):
    def test_moved_eye_high_is_accepted_without_the_flag(self):
        out, recs = case([[cand()]])
        f = D.replay(out, recs, False)
        self.assertTrue(f["eyeMoved"])
        self.assertEqual(f["level"], "HIGH")
        self.assertFalse(F.position_trusted({"positionSource": "exif-gps"}, f))

    def test_suggest_only_turns_moved_eye_high_into_a_low_suggestion(self):
        out, recs = case([[cand()]])
        f = D.replay(out, recs, True)
        self.assertFalse(f["eyeMoved"])
        self.assertEqual(f["level"], "LOW")  # the stated-eye level
        self.assertEqual(f["suggestion"]["level"], "LOW")
        self.assertEqual(f["suggestion"]["levelAtEye"], "HIGH")
        self.assertNotIn("moveM", f)
        res = D.check_invariants(out, recs)
        self.assertEqual(res["violations"], [])
        self.assertTrue(res["transition"].startswith("moved-eye HIGH (accepted without the flag) -> stated LOW"))
        self.assertTrue(res["parity"])

    def test_margin_and_ambiguity_vetoes(self):
        out, recs = case([[cand()]], probes_best=(12,))  # 12 < 1.5 × max(1, stated best 10)
        self.assertFalse(D.replay(out, recs, False)["eyeMoved"])
        out, recs = case([[cand(yaw=70.0), cand(yaw=80.0, source="narrow")]])  # a strong rival basin 10° away
        self.assertFalse(D.replay(out, recs, False)["eyeMoved"])

    def test_no_eyes_leaves_stated_result_untouched(self):
        stated = rec([cand()], source="exif-gps")
        f = F.decide_moved_eye(stated, 10, [], [], {**F.summarize(stated), "eyeMoved": False}, True)
        self.assertEqual(f["level"], "HIGH")
        self.assertNotIn("suggestion", f)
        self.assertTrue(F.position_trusted({"positionSource": "exif-gps"}, f))

    def test_stated_eye_record_must_match_b(self):
        out, recs = case([[cand()]])
        b = copy.deepcopy(recs["stated"])
        b["reused"] = "somewhere"  # provenance key is ignored
        self.assertEqual(D.check_invariants(out, recs, b)["violations"], [])
        b["lat"] += 1e-9
        self.assertIn("stated-eye record is not byte-identical to B's", D.check_invariants(out, recs, b)["violations"])

    def test_invariant_check_detects_an_accepting_finaliser(self):
        out, recs = case([[cand()]])
        real = F.decide_moved_eye
        try:
            F.decide_moved_eye = lambda rec0, base, probes, results, final, so: real(rec0, base, probes, results, final, False)
            self.assertTrue(D.check_invariants(out, recs)["violations"])
        finally:
            F.decide_moved_eye = real

    def test_summary_of_empty_record_is_low(self):
        self.assertEqual(F.summarize(rec([]))["level"], "LOW")

    def test_cli_refuses_v3_ids(self):
        with self.assertRaises(SystemExit):
            D.main(["w3_0001"])

    def test_frozen_constants_unchanged(self):
        self.assertEqual((F.EYE_MIN_INL, F.EYE_RATIO, F.EYE_TOP, F.EYE_MARGIN, F.AMBIG_DEG), (100, 3.0, 2, 1.5, 2.0))
        self.assertTrue(json.dumps(F.EYE_RATIO))


if __name__ == "__main__":
    unittest.main()
