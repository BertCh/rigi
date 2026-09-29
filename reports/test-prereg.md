# Pre-registration: single test-set run (T5 + T6)

**Status: FROZEN (2026-09-26).** This file was frozen when the run started. Its sha1 goes in the first line of every arm's run log, and any later changes go in `reports/test-prereg-addenda.md`.

- **Written:** 2026-09-26, by session mt-image-f0; approved by the lead (mt-image-30).
- **This run spends the frozen test half.** The 50 ids listed as `test` in `tools/bench/split.json` (file sha1 `f0225b9024964a93383a904e38f15f3e51a05318`; id-list hash `62f4e93582f79876d8ee4bb7be422f6e90222014`) have not been used for development. After this run, changes to T6 or T5 can't be re-validated on them.

## Arms

| arm | definition | code stamp | rule sha1 |
|---|---|---|---|
| A | CPU replay of the current matcher service v0.3.4 logic (T6's pipeline with the T6-only generators off, verifying only the service's own stage-1 choice): fused skyline + render-match, `MATCHER_SWEEP_KP=4096`, LightGlue on CPU. HIGH = the service's rule ∧ (EXIF ∨ basinGap ≥ 0.20) | `a63228f452fdbb75` (pipeline `c2d406ea3c557e6e`) | service rule as of v0.3.4 |
| B | T6 stage-1 search plus the frozen T6 HIGH rule (match-dominant HIGH and ambiguity veto) | `a5d380c36fcb0497` (pipeline `c2d406ea3c557e6e`) | `292fb74f35f6f402b5e81f1b832bac565edd6807` |
| C | T5 pose6 position refinement applied to B's final pose; photos where B has no pose count as no pose | `fb97fbed958a7173` | B's rule plus the pose6 confidence rule as frozen in `tools/bench/t5/RULE_FROZEN.sha1`. At freeze, pose6.py hashed `1ad03962…`. It is now `f31f601f…`, changed in non-rule code only (threaded grid, cancellation, fast mode). The rule text and the constants BASIN_GAP 0.15, CONFIRM_PX 4 and MIN_GAIN 5 are identical, and the runner checks the rule text before arm C. C runs only after B has finished |

**Common to all arms:**
- **Inputs:** the photos run under the wild benchmark's "given" condition. There is no gravity for any photo. A manifest heading is used only as a weak hint. `meta.positionSource` comes from the manifest.
- **Time cap:** a hard wall-time cap of **600 s per photo**. A timeout counts as **no pose**, which is scored as a failure: not correct and not accepted.
- **Execution:** one arm runs at a time, with a single private headless worker. The run never talks to the live service on :8765.
- **Runner:** `tools/bench/final/run_arm.sh <arm> <ids…>`, with `FINAL_ALLOW_TEST=1`.

## Rerun policy

- **Infrastructure failures only.** A photo is rerun only if it failed for infrastructure reasons: a crash, OOM, worker death, swap stall past the cap caused by machine state (logged with `vm.swapusage`), or the disk guard stopping the run.
- **Same code.** Every rerun uses the **same code stamp**, and each one is logged with its reason.
- **Method failures stay.** A wrong pose, LOW confidence, a timeout without an infrastructure cause, or no pose is never rerun.
- **Frozen after the first test pose.** No change to any parameter, threshold or rule once the first test pose has been produced. That includes the T6 median-yaw selection fix, which is reported separately as a post-hoc analysis.

## Ground truth

**Blind visual verification**, using the same protocol as `reports/bench-wild.md`: the C1–C4 checklist, with "near-miss" counted as wrong.

- **Rendering:** overlays are drawn on the Mapterhorn DEM at the eye (lat, lon, h) each arm actually used.
- **Inheritance:** a pose inherits an existing v2 or cascade-MT verdict only if it is within **0.5° in yaw and pitch and 2 m in eye** of an already-verdicted cluster.
- **Blinded pack:** every other pose from every arm goes into **one mixed pack** with random candidate labels.
- **What verifiers never see:** arm labels, confidence, dev results or any key.
- **Decoy duplicates:** the pack includes decoys, meaning the same photo and pose again under a different random id (about 10% of candidates, at least 5). Verifier self-consistency on these is reported.
- **Overlap:** about 30% of photos are judged by two verifiers. Disagreement → **unsure**.
- **No unseen images:** a verdict can't rest on an image the verifier didn't see ("not-seen" → unsure).

## Metrics (all arms; all 50 test photos, plus breakdowns)

**Headline metrics:**
- **Correct:** the number of photos whose final pose is verified correct.
- **HIGH:** the number of HIGH poses, precision = correct ÷ (correct + wrong), and the number of gross HIGH errors (HIGH and verified wrong).
- **Product rule:** accept iff HIGH ∧ (EXIF GPS ∨ the pose agrees with the Mapterhorn cascade within 0.5° in yaw and pitch). The cascade poses come from the existing `wild-cascade-mt` run. Report accepts, precision and recall, where recall = accepted-correct ÷ photos with any verified-correct pose from any arm or the cascade.
- **Stated hypothesis, the looser rule:** accept iff HIGH ∧ (EXIF GPS ∨ basinGap ≥ 0.20). Report its precision and recall against the product rule.
- **Runtime:** median and p90 per photo, plus the timeout count.

**Breakdowns:** EXIF GPS vs manual position; near vs far skyline; heading known vs unknown.

**Uncertainty:** every precision and recall comes with a **Wilson 95% interval**. Note that with about 20 accepts, an observed 1.00 is compatible with a true value of about 0.84.

## Adoption pass bar (for B, and for C over B)

B is adopted in the service only if **all** of these hold on test:
1. **EXIF photos:** HIGH precision ≥ 0.95, with **0** gross HIGH errors.
2. **Product rule:** precision 1.00, with recall ≥ arm A's.
3. **Manual-position photos:** no increase in gross HIGH errors over arm A.

C (position refinement) is adopted as a default only if it meets the same bar **and** has more correct poses than B. Otherwise it stays opt-in.

The looser rule is adopted only if its test precision is 1.00 with **0** gross errors, and recall is above the product rule's. The Wilson interval is stated alongside.

## Final dev tables (for reference; dev is not test)

Source: T6 agent, from `reports/stage1.md`. Covers 50 dev photos. All blind verdicts are in and none are pending. The T6 rule is unchanged (`292fb74f…`). Recall is out of the **30** dev photos that have any verified-correct pose.

**Per-rule results** ("acc" = accepted, "rec" = recall):

| | GPU-era wild | CPU replay (v0.3.4 logic) | T6 frozen |
|---|---|---|---|
| correct | 23 | 25 | 26 (+2 unsure) |
| HIGH correct / wrong / unsure | 15 / 1 (wc_0069) / 0 | 16 / 1 (wc_0069) / 0 | 19 / 0 / 1 (wc_0076) |
| product rule: HIGH ∧ (EXIF ∨ cascade agrees, 0.75 gate) | 9 acc, prec 1.00, rec 9/30 | 9, 1.00, 9/30 | 12, 1.00, 12/30 |
| looser rule: HIGH ∧ (EXIF ∨ gap ≥ 0.20) | 14, 1.00, 14/30 | 16, 0.94, 15/30 | 20, 1.00, 19/30 (+1 unsure) |
| fused/cascade agreement | 7/7 correct | 6/6 | 7/7 |
| runtime per photo | 17–28 s | about 35 s (arm A dry run 53–65 s) | median 85 s, p90 110 s |

**Correct by stage-1 seed** (T6 / replay):
- 360° sweep (sweep40): 23 photos, 16 / 16 correct; HIGH 13 / 11.
- App-skyline seed: 17 photos, 3 / 2 correct; HIGH 1 / 0.
- Narrow FOV: 10 photos, 7 / 7 correct; HIGH 6 / 6.

**GT-12**, heading and gravity removed, scored against pin GT on 11 photos:

| | median \|Δyaw\| / \|Δpitch\| / \|Δroll\| | within 1° yaw | HIGH (false) |
|---|---|---|---|
| ablation fused | 0.162 / 0.121 / 0.303 | 10/11 | 7 (0) |
| CPU replay | 0.146 / 0.124 / 0.308 | 10/11 | 8 (0) |
| T6 | 0.196 / 0.124 / 0.274 | 11/11 | 9 (0) |

T6's median yaw error is higher on GT-12 because its frozen selection picks a different solve within the same basin on IMG_6971 and IMG_7059. A fix is written up but deliberately not applied; it will be reported post hoc.

**Dry run (dev only, wc_0014 and wc_0019):** all 6 records came back ok and HIGH. Wall time was 65/53 s for A, 93/90 s for B and 144/156 s for C.
