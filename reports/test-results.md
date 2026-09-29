# Test-set results: the single pre-registered run

- **Pre-registration:** `reports/test-prereg.md`, sha1 `ad6d7087d27ba9de467149237884ac58a36d4b73`, frozen before the run and recorded on the first line of `tools/bench/final/out/drive.log`.
- **Split:** `tools/bench/split.json`, sha1 `f0225b90…`, 50 test photos.
- **Run:** 2026-09-26, 09:12–12:03 UTC.
- **Scorer:** `tools/bench/score/score_final.py`, which writes `tools/bench/final/scores.json`.

## Verdict

**Arm B (T6) passes every pre-registered adoption criterion as scored, but two of its accepts are "unsure", and the pass depends on them. Arm C (pose6 on top of B) fails. The looser accept rule meets its pre-registered bar.**

| arm | correct (of 50) | HIGH: correct / accepted, gross | product rule: correct / accepted, recall | looser rule: correct / accepted, recall | median / p90 time |
|---|---|---|---|---|---|
| A: current service v0.3.4 (CPU replay) | 29 [0.44–0.71] | 17 / 17, 0 gross, precision 1.00 [0.82–1] | 11 / 11, 11/34 [0.19–0.49] | 17 / 17, 17/34 [0.34–0.66] | 35 s / 47 s |
| **B: T6** | **30** [0.46–0.72] | **22 / 24 (2 unsure)**, 0 gross, precision 1.00 [0.85–1] | **15 / 17 (2 unsure)**, 15/34 [0.29–0.61] | **22 / 24 (2 unsure)**, **22/34** [0.48–0.79] | 84 s / 101 s |
| C: pose6 on B | 31 [0.48–0.74] | 19 / 20 (1 unsure), 0 gross | 9 / 10 (1 unsure), 9/34 [0.15–0.43] | 19 / 20 (1 unsure), 19/34 | 89 s / 143 s |

- **Brackets** are Wilson 95% intervals.
- **Precision** = correct ÷ (correct + wrong). Unsure verdicts are excluded and listed separately.
- **Recall** is out of the 34 test photos with any verified-correct pose, from any arm or the cascade.
- **No failures:** 0 timeouts, 0 infrastructure failures and 0 reruns. Every arm ran with a single code stamp matching the pre-registration.

### Pre-registered pass bar

| criterion | B | C |
|---|---|---|
| EXIF HIGH precision ≥ 0.95 | ✓ 9/9 decided (**2 unsure**) | ✓ 6/6 decided (1 unsure) |
| EXIF gross HIGH = 0 | ✓ | ✓ |
| product-rule precision = 1.00 | ✓ 15/15 decided (2 unsure) | ✓ |
| product-rule recall ≥ A (11) | ✓ 15 | **✗ 9** |
| manual-position gross HIGH ≤ A (0) | ✓ 0 | ✓ 0 |
| C only: correct > B | – | ✓ 31 > 30 |
| **result** | **PASS, conditional on 2 unsure** | **FAIL** |

- **Sensitivity:** B's two unsure HIGHs are both EXIF photos:
  - **wc_0003:** two verifiers disagreed, correct vs wrong; the Mont Blanc and Chablais line runs close to the 1.5% limit.
  - **wc_0038:** the far skyline is too hazy to check.
- **If both were wrong,** B's EXIF HIGH precision would be 9/11 = 0.82 and criterion 1 would fail. The pre-registration sends disagreements to "unsure" and names no tie-break, so resolving them now would be a **post-hoc addendum**. That decision rests with the lead and the user.
- **Why C fails recall:** the pre-registered cascade agreement needs the camera eye to match within 2 m. pose6 moves the eye, which breaks agreement even when the rotations agree. This is a limitation of the agreement definition, recorded here but not corrected, since the rule is frozen. C adds +1 correct pose (31 vs 30) at +5 s median and +42 s p90.

### Looser rule (the stated hypothesis): HIGH ∧ (EXIF ∨ basinGap ≥ 0.20)

- **Pre-registered bar:** test precision 1.00, 0 gross, recall above the product rule.
- **B result:** 22/22 decided (2 unsure), 0 gross, recall **22/34** against the product rule's 15/34. **Met, subject to the same 2 unsure.**
- **Caution:** with 22 accepts, a precision of 1.00 is consistent with a true precision as low as about 0.85.

## Breakdowns (arm B; A in brackets)

| stratum | n | correct | HIGH correct/accepted (gross) | product rule | looser rule |
|---|---|---|---|---|---|
| EXIF GPS | 21 | 14 (14) | 9/11 (5/5), 0 gross | 9/11 (5/5) | 9/11 (5/5) |
| manual | 29 | 16 (15) | 13/13 (12/12), 0 gross | 6/6 (6/6) | 13/13 (12/12) |
| near skyline | 28 | 16 (16) | 11/11 (11/11) | 7/7 (7/7) | 11/11 (11/11) |
| far skyline | 22 | 14 (13) | 11/13 (6/6) | 8/10 (4/4) | 11/13 (6/6) |
| heading known | 25 | 21 (20) | 15/17 (11/11) | 8/10 (5/5) | 15/17 (11/11) |
| heading unknown | 25 | 9 (9) | 7/7 (6/6) | 7/7 (6/6) | 7/7 (6/6) |

In the "/n" cells the gap between correct and accepted is the 2 unsure accepts, not wrong ones. **No arm has a single gross HIGH error on test.**

## Reading

- **B's gain is in confident coverage, not raw accuracy.** B has 1 more correct pose than A (30 vs 29; the intervals overlap completely), but 5 more HIGH poses and 4 more product-rule accepts. On test, as on dev, T6 turns more correct answers into trustworthy ones; it doesn't find many new ones.
- **The current service (A) is already safe:** 17/17 HIGH with 0 gross errors on test.
- **Cost:** B roughly doubles to triples server time per escalation: median 35 s → 84 s.
- **pose6 (C)** adds one correct pose, loses confident accepts under the pre-registered agreement rule, and fails the bar. Position refinement stays opt-in.

## Verification quality

- **Inherited verdicts:** 107 of 150 arm-poses inherited a verdict from an existing blind-verified cluster (within 0.5° in yaw and pitch and 2 m eye).
- **Blind pack:** the remaining 43 arm-poses shared 31 distinct candidates. Those went into a blinded pack with 5 decoy duplicates, 36 candidates judged by 3 paced verifiers. No verdict rests on an unseen image.
- **Overlap agreement:** 11 of 12 overlapping pairs agreed; the one disagreement (wc_0003) became "unsure".
- **Decoys:** 4 of 5 were judged consistently. **Caveat:** the overlay header prints the pose numbers, so verifiers could, and did, recognise decoys by their identical headers. The decoy check therefore overstates independent consistency. Future packs should leave pose numbers out of the header.

## Not in this report (post-hoc, separate)

- T6's median-yaw selection fix (`reports/stage1.md`), which was deliberately not applied.
- Any adjudication of the 2 unsure accepts. If it is done, it goes in `reports/test-prereg-addenda.md` and must be labelled post hoc.
