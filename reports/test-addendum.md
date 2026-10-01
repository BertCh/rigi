# POST-HOC addendum: blind re-verification of arm B's two unsure HIGH accepts

**POST-HOC.** This addendum was not part of the pre-registration (`reports/test-prereg.md`, sha1 `ad6d7087…`). It does not change `reports/test-results.md` (sha1 `8cd85f0a…`) or any score file (`tools/bench/final/scores.json`, sha1 `56400f8e…`). The pre-registered result stays as reported: B passes conditional on 2 unsure.

- **Written:** 2026-09-26 15:03 UTC, before any overlay in this addendum was rendered or judged.
- **Scope:** arm B's final poses for **wc_0003** and **wc_0038**, both HIGH and accepted, both EXIF GPS, both verdicted "unsure" in the test run.
- **Decided by:** the project owner and the user.

## Decision rule (stated before any verdict was collected)

- **Both correct:** if both photos are confirmed correct by both verifiers, the project owner flips the service default to **t6**.
- **Either wrong:** if either photo is judged wrong, the default stays **v034**.
- **Disagreement:** if the verifiers disagree, the photo stays unsure and the default stays **v034**.

A verdict that rests on an image the verifier did not see ("not-seen") counts as unsure.

## Protocol

- **Fresh verifiers:** 2 per photo, 4 in total. None of them took part in the test-run verification.
- **Checklist:** the fixed C1–C4 checklist from `reports/bench-wild.md`. C1: the line covers ≥ 70% of the visible skyline. C2: vertical fit within 1.5% of image height. C3: features align (peaks, notches, labels). C4: no tilt. "Near-miss" counts as wrong.
- **Rendering:** `tools/bench/harness/overlay.ts` on the Mapterhorn DEM, at exactly the eye (lat, lon, h) that B used, as recorded in `tools/bench/final/out/B/<id>.json`.
- **Neutral header:** the header shows only a neutral label such as "candidate K4". There are no pose numbers, eye or photo id, because the last pack leaked pose numbers through the header.
- **Candidates per photo:** 3 in total.
  - (a) B's pose.
  - (b) A duplicate of B's pose under a different label, re-rendered at a slightly different width so the files are not pixel-identical.
  - (c) A wrong decoy: B's pose with yaw perturbed by a clearly-wrong but not absurd amount.
- **Labels:** labels and order are shuffled. The key is in `key.json`, which verifiers never see.

<!-- RESULTS BELOW WERE ADDED AFTER VERDICTS WERE COLLECTED -->

## Pack as built

- **Seed:** `f9f318873e80b417`.
- **Files:** the builder is `tools/bench/final/addendum/build_pack.ts`, the overlays are in `tools/bench/final/addendum/pack/`, the key is `tools/bench/final/addendum/key.json`, and the raw verdicts are in `tools/bench/final/addendum/verdicts/v1–v4.json`.
- **Rendering:** every overlay was drawn at B's recorded eye.
  - wc_0003: 46.928502, 6.724747, h 1462.54 m, confirmed as the rendered eye.
  - wc_0038: 45.929767, 9.019178, h 1653.12 m, confirmed as the rendered eye.
- **Wrong decoy:** B's yaw moved by −3° for wc_0003 (vfov 8.3°, a narrow telephoto frame) and by +5° for wc_0038 (vfov 47°).
- **Verifier assignment:** v1 and v2 judged wc_0003 (candidates Q9, R2, T5). v3 and v4 judged wc_0038 (J8, U2, V7). Each verifier worked in its own directory and saw only the photo and its three overlays. They ran two at a time.
- **Seen images:** every verifier saw every image. There were no "not-seen" verdicts.
- **Rendering check:** the new wc_0038 overlay puts the line in the same place as test-pack candidate `tecbfe2`, which is the same cluster, within 0.03° yaw and pitch. The rendering has not changed since the test run.

## Verdicts (key applied after all four verdict files were written)

| photo | candidate | truth | v1 | v2 | v3 | v4 |
|---|---|---|---|---|---|---|
| wc_0003 | Q9 | **B pose** | correct | **wrong** (pitch-offset: line about 3–4% of height above left/middle ridges, labels off summits) | | |
| wc_0003 | T5 | B pose, duplicate | correct | wrong (same as Q9) | | |
| wc_0003 | R2 | wrong decoy (yaw −3°) | wrong (roll, wrong-direction) | wrong (roll, wrong-direction) | | |
| wc_0038 | J8 | **B pose** | | | **wrong** (pitch-offset: line in hazy sky about 5–9% of height above visible ridge; Monte Tamaro, 23 km, in blank sky) | **wrong** (pitch-offset: about 5–7% of height above hazy skyline; labels in sky) |
| wc_0038 | U2 | B pose, duplicate | | | wrong (same as J8) | wrong (same as J8) |
| wc_0038 | V7 | wrong decoy (yaw +5°) | | | wrong | wrong |

**Per-photo verdicts on B's pose:**
- **wc_0003: UNSURE.** v1 found the line correct: it traces Mont Blanc and the Chablais ridge, with height error under 1% and one right-hand peak shifted about 0.7% sideways. v2 found it wrong, 3–4% too high on the left and middle. The verifiers disagree, so the photo stays unsure. This is the same split as in the test run.
- **wc_0038: WRONG.** Both verifiers independently judged it wrong, with a pitch offset of about 5–9% of image height and C1–C3 failing. Both said the hazy skyline was faint but visible enough to judge. In the test run a single verifier had called this pose "unsure" ("line lies in haze band; Tamaro bump plausibly matches").

## Decoy consistency

- **Duplicates:** all 4 verifiers gave the same verdict to B and its duplicate, 4 of 4. This time the headers carried no pose numbers, and the duplicates were rendered at different widths, so the files were not pixel-identical. These pairs are a fairer self-consistency check than the test pack's.
- **Wrong decoys:** all 4 verifiers rejected the wrong decoy, 4 of 4.
- **wc_0038 caveat:** v3 and v4 rejected all three candidates. The decoy therefore does not show that they can tell a correct pose from a wrong one on this photo, only that they were consistent.
- **wc_0003:** v1 separated B (correct) from the decoy (wrong). v2 rejected everything.

## Outcome under the pre-stated rule

- **Result:** one photo, wc_0038, is judged **wrong** by both verifiers, and the other, wc_0003, stays **unsure** because the verifiers disagree. Either one alone is enough, under the rule stated above, for the **service default to stay v034**. The flip to t6 is not triggered.
- **For information only (POST-HOC, does not change the pre-registered scoring):** if wc_0038 counted as a gross HIGH error, B's EXIF HIGH precision would be 9/10 = 0.90 with one gross error, and B would fail pre-registered criteria 1 (≥ 0.95, 0 gross) and 2 (product-rule precision 1.00). `reports/test-results.md` and `tools/bench/final/scores.json` are unchanged.
- **Record location:** `reports/test-results.md` pointed any adjudication to `reports/test-prereg-addenda.md`. This record is in `reports/test-addendum.md`, as the project owner and the user instructed.
