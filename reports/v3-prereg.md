# Pre-registration DRAFT: one-shot evaluation on the frozen held-out set `data_v3`

**Status: DRAFT, NOT FROZEN, NOT EXECUTED.** Written 2026-09-26. Running it spends `tools/bench/data_v3` and needs the user's sign-off. No `data_v3` photo has been opened, rendered, matched or overlaid by this session. The only things read were `README.md`, `FROZEN.sha1` and the manifest's hash and stratum counts.

> **Update (2026-10-01):** still a draft (roadmap R6), and still unexecuted; `data_v3` is sealed. Two things changed under it. (1) The arms' runner cannot execute as written: `tools/matcher/stage1/vendor/worker.mjs` and `vendor_v03/render_worker.mjs` drive the three.js PhotoEngine API, removed 583e2b7 (deck/WebGPU is now the only renderer), so freezing needs either a pinned pre-583e2b7 app checkout for the private worker or a port to the deck engines and new code stamps (the port landed on wave5/S1, browser-unverified: both workers are copies of the ported service worker; code stamps change accordingly). (2) The status hub plans to fold in the H2 veto (R2) and recall-lever (R3) winners first, and to collect and seal a ~100-photo set before `data_v3` is opened (roadmap N3). The `STAGE1_MANIFEST` switch (step 1 below) is still missing; `V2_SUGGEST_ONLY` exists in `run_v2.py` but has not had its dry run.

The draft is frozen by filling in the `‹…›` fields, committing it, and recording its sha1 on the first line of every arm's run log. After that, any change goes in `reports/v3-prereg-addenda.md` and is labelled post hoc.

## Set

- **Set:** `tools/bench/data_v3`, 74 photos, ids `w3_0001`–`w3_0074`.
- **Manifest sha1:** `61d765bda1efb49e57695dec49cddbeb072287e0`.
- **Photo-listing digest:** `51d2e42c…`, frozen 2026-09-26T15:05:04Z.
- **Check before running:** the runner verifies both hashes against `FROZEN.sha1`. If either one differs, the run is refused.
- **Strata:** 60 Swiss photos and 14 non-Swiss, reported separately. 34 EXIF GPS and 40 manual position.

## Arms

All arms are run offline, the same way as the test run in `tools/bench/final`: one private headless worker, LightGlue on CPU, `SWEEP_KP=4096`, and the "given" condition (heading only as a weak hint, no gravity, `positionSource` from the manifest). No arm talks to the live service on :8765 or :8766.

| arm | definition | code stamp | rule |
|---|---|---|---|
| **A: v034** (service default) | CPU replay of the v0.3.4 service logic, as in test-prereg arm A | `a63228f452fdbb75` (pipeline `c2d406ea3c557e6e`), re-checked at freeze | service rule v0.3.4 |
| **B: t6** | T6 stage-1 search plus the frozen T6 rule, as in test-prereg arm B, equal to service `policy=t6` | `a5d380c36fcb0497` (pipeline `c2d406ea3c557e6e`) | `292fb74f35f6f402b5e81f1b832bac565edd6807` |
| **C: v2** | `tools/matcher/v2/run_v2.py`: B's record at the stated eye (the identical B record is reused, never re-run), then, only where B is not HIGH, the eye-position fallback (§v2 below). **Moved-eye results are reported as suggestions only: always LOW, never accepted** (`V2_SUGGEST_ONLY=1`). This follows the dev result in `reports/matching-v2.md` §3, where the only moved-eye HIGH was a verified near-miss | ‹run_v2 + viewpoints sha1 at freeze› | B's rule at the stated eye; moved eye forced LOW |
| **D: t6+LoMa** (conditional) | B with `V2_MATCHER=loma` (LoMa-B 4096, MPS fp32, one long-lived process) | ‹stamp› | **Included only if** a LoMa-specific rule is calibrated and frozen on dev first, and that rule's dev HIGH precision is 1.00 with dev correct ≥ B's. Under B's frozen rule LoMa makes 1 gross HIGH (wc_0069) and loses net HIGH recall on dev (`reports/matching-v2.md` §5). Otherwise D is dropped before freeze |

- **C calibration priors:** **OFF** (`reports/matching-v2.md` §4: near-neutral recall, and no net time saving once GeoCalib's own CPU cost is counted).
- **B and C share records:** because C reuses B's stated-eye record and never accepts a moved eye, C's accepts are **identical to B's by construction**. C is evaluated only on its suggestions.

### v2 constants (frozen from dev; not tuned on v3)

| constant | value | meaning |
|---|---|---|
| viewpoints | `viewpoints.candidates(lat, lon, radius=400, step=25, k=4, nms=120)` plus high100/high250/summit | photo-independent candidate eyes |
| `EYE_MIN_INL` | 100 | minimum fine-sweep window inliers at a candidate eye |
| `EYE_RATIO` | 3.0 | a candidate eye must beat the stated eye's best stage-1 inliers by this factor |
| `EYE_TOP` | 2 | full T6 is run at the top 2 eyes only |
| `EYE_MARGIN` | 1.5 | the chosen eye's sweep support must exceed every other eye's (and the stated eye's) by this factor |
| `AMBIG_DEG` | 2.0 | cross-eye ambiguity: any strong candidate at another eye farther than this from the pose vetoes HIGH |
| moved-eye position | `positionSource = "moved"`, `positionTrusted = false`, level forced LOW | a suggestion, never an accept |

## Supporting runs (part of the evaluation, run once)

- **Mapterhorn cascade** (`tools/bench/harness/cascade.ts`, `configured` variant, the acc75 gate) at the stated eye for all 74 photos. This input to the product rule does not exist yet for v3.
- **Cascade at the moved eye:** for each photo where C reports a moved-eye suggestion, the cascade is run a second time at that moved eye (lat, lon, h) exactly.

## Required implementation before freeze (dev only, no v3 access)

1. **Manifest switch:** the stage-1 runner reads `tools/bench/data/manifest.json` hard-coded in `s1.MANIFEST`. Add a `STAGE1_MANIFEST` switch that takes a manifest path. v3 ids are refused unless `V3_ALLOW=1` is set, and the switch checks `FROZEN.sha1`.
2. **Stamps:** stamp arm C's code, and list the stamps in the Arms table above.
3. **Dry run:** do a dry run on 2 dev photos per arm, in the same way as the test run. For C, include wc_0086 and wc_0074, and check that `V2_SUGGEST_ONLY=1` turns wc_0086's moved-eye HIGH into a LOW suggestion. That code path was added after the dev run and has not been executed yet.

## Time cap and reruns

- **Time caps:** 600 s per photo for arms A and B. For arm C the cap is 600 s at the stated eye plus **1500 s** for the fallback. A timeout counts as no pose for that stage, and if the fallback times out, the stated-eye result stands.
- **Reruns:** the rerun policy is identical to `reports/test-prereg.md`. Only infrastructure failures are rerun, with the same stamp, and every rerun is logged. A method failure is never rerun.
- **Arm order:** arms run one at a time, B before C, because C reuses B's records.

## Ground truth: blind verification

The protocol is the one from `reports/test-prereg.md`, with the hardening from `reports/test-addendum.md`.

**Checklist and verdicts:**
- Verifiers use the C1–C4 checklist from `reports/bench-wild.md`.
- A "near-miss" counts as wrong.
- A verdict that rests on an image the verifier did not see counts as unsure.

**Rendering:**
- Overlays are drawn with `tools/bench/harness/overlay.ts` on the **Mapterhorn** DEM at the **exact eye each arm used** (lat, lon, h).
- The photo is padded with equal black bands top and bottom, and the vfov widened to match (`tools/matcher/v2/verify/build_pack.ts`, `PACK_PAD=1`). This way the overlay's title bar never hides a skyline. On dev the unpadded bar hid wc_0086's skyline.
- For a moved-eye pose, this is the moved eye. The rendered eye is recorded in the key and checked against the arm's record within 0.5 m.

**Blinding:**
- **Headers are neutral:** only "candidate K4". There are no pose numbers, eye, photo id, arm, confidence, source or eye-moved flag.
- **Mixed pack:** every pose from every arm that does not inherit a verdict goes into one pack, labelled in a seeded random order. The key is kept in `key.json`, and verifiers never see it.
- **Inheritance within v3 only:** a pose inherits another pose's v3 verdict only if it lies within 0.5° in yaw and pitch **and** its eye is within 2 m in 3-D. So an A or B pose never inherits from C's moved-eye pose, or the other way round.

**Controls:**
- **Duplicates:** about 10% of candidates, and at least 5, are the same pose re-rendered at a different width (not pixel-identical).
- **Wrong decoys:** at least 5 are wrong decoys, a real pose with yaw perturbed by 3–5° (narrow frames 3°, others 5°).
- **Reporting:** the self-consistency on duplicates and the rejection rate on decoys are both reported.

**Verifiers:**
- Verifiers are fresh agents, each with its own scratch directory, and none of them ran or saw any arm.
- About 30% of photos, plus **every moved-eye suggestion**, get two independent verifiers.
- If the two disagree, the verdict is unsure.

## Metrics

Metrics are reported for all 74 photos, for Swiss 60 and non-Swiss 14 separately, and for EXIF vs manual.

**Correct:**
- The number of photos whose final pose is verified correct.
- Recall denominator: photos with a verified-correct pose from any arm or from the cascade (either eye).

**HIGH:**
- Count and precision, where precision = correct ÷ (correct + wrong), with unsure listed separately.
- **Gross HIGH errors:** HIGH and verified wrong.

**Product rule:** accept iff HIGH ∧ (EXIF GPS ∧ eye not moved ∨ cascade agrees).
- "Cascade agrees" means the arm's pose is within 0.5° in yaw and pitch of an accepted cascade pose with confidence ≥ 0.75, **computed at the same eye**.
- For A, B and C at the stated eye, that is the stated-eye cascade.
- **Moved-eye agreement is defined at the moved eye:** a moved-eye pose agrees only with the cascade run at that moved eye, so the 2 m eye tolerance is satisfied by construction. This fixes the test-run limitation in which pose6 could never agree, because it moved the eye. Here it is informational only, since C's moved-eye results are never accepted.

**Looser rule:** accept iff HIGH ∧ (EXIF GPS ∧ eye not moved ∨ basinGap ≥ 0.20).

**Moved-eye block (C only):**
- The number of photos with a moved-eye suggestion, and the move distance (median and max).
- Suggestions verified correct / wrong / unsure, overall and among photos where A and B have no correct pose.
- Cascade agreement at the moved eye, reported as information only.

**Other metrics:**
- **Runtime:** median and p90 per photo for each arm. For C, report the fallback time on its own as well.
- **Wilson 95% intervals** on every precision and recall.

## Pass criteria (fixed)

**B (t6)** is adopted as the service default only if **all** of these hold on v3. These are the test-prereg criteria unchanged.
1. **EXIF photos:** HIGH precision ≥ 0.95 and **0** gross HIGH errors.
2. **Product rule:** precision **1.00**, and recall ≥ A's.
3. **Manual-position photos:** gross HIGH errors ≤ A's.

**C (v2 suggestions)** is never an accept arm. The "try this viewpoint" suggestion may ship (opt-in, LOW, clearly labelled) only if both of these hold:
4. **Suggestion quality:** among photos where B is not correct and C gives a moved-eye suggestion, the suggestion is verified correct on ≥ 50%, with a Wilson interval stated. The C1–C4 checklist applies at the moved eye, with two verifiers and "either wrong → wrong".
5. **Suggestion precision:** C's suggestion is never shown for a photo where B is HIGH (true by construction; checked).

**D (t6+LoMa)**, if it is included, is judged against B on criteria 1–3 and must have more correct poses than B to be adopted.

**Unsure verdicts** are shown as a sensitivity check: the result with every unsure taken as wrong is reported alongside the main result. The pass or fail decision uses the main result, and any case that depends on unsures is labelled "conditional", as in the test run.

## What will NOT be done

- No threshold, constant, viewpoint parameter, prior or rule changes after the first v3 pose is produced.
- No looking at v3 overlays except by the blind verifiers.
- No second run. Any re-analysis is labelled post hoc.
