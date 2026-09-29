# X2 — monocular geometry (MoGe-2 / DA3) as a verifier and search cue (TM program)

*Written by the main session from X2's returned findings (the subagent could not write report files).*
DEV only, no rendering. Scores come from the C0 cache; files are listed at the end.

## Verdict
- **Useful as a verifier.** The rule is MoGe-2 ViT-L `combo_int.z`: terrain-only depth scores, normalised against the same pose at 68 other yaws. The veto threshold is 0.37, set as the minimum over the odd ids' correct refs.
  - It vetoes the only gross HIGH on dev, LoMa's wc_0069.
  - It vetoes 0 of the 19 T6 correct HIGHs and 0 of the 18 LoMa correct HIGHs.
  - Among matcher poses with ≥ 100 inliers, it vetoes 7 of 18 gross poses (every wc_0069 and wc_0074 pose) and 1 of 78 correct ones.
- **Useful as a yaw cue, but only tested with pitch, roll and focal fixed at their true values.**
  - Depth edges including the skyline find the right yaw (within 2°) on 28 of 30 photos in a full 360° scan. The peak is sharp: half-width about 6°, about −1σ at ±1° and −4 to −5σ at ±8°.
  - Terrain-only edges manage 19 of 29.
  - Depth rank correlation gives a broad basin (half-width about 24°) and finds the right yaw on 26 of 30, so it pairs naturally with depth edges as coarse then fine.
- **What it catches and what it misses.**
  - It catches a wrong eye that puts a near obstacle in the render: wc_0069 A and wc_0074 A.
  - It cannot separate near-miss eyes whose far layers still match: wc_0001 B and wc_0070 A.
- **Recommendation:** add `combo_int.z` as a flagged HIGH veto, using ViT-B for cost, and run a dev-calibrated A/B. Also try it as a yaw prior or sweep re-ranker. No training is needed.

## Discrimination on verified refs (MoGe-L)
Refs: 32 correct and 128 wrong; 23 photos have both. The "all" column gives pooled AUROC / per-photo "correct beats wrong" rate / photos where the best correct beats the best wrong.

| score | odd (design) | even (held out) | all |
|---|---|---|---|
| sky mask agreement | 0.96 | 0.93 | 0.95 / 0.95 / 21 of 23 |
| rank correlation, sky = far | 0.91 | 0.93 | 0.92 / 0.93 / 20 of 23 |
| depth edges incl. skyline | 0.99 | 0.95 | 0.97 / 0.93 / 20 of 23 |
| depth edges, terrain only | 0.90 | 0.91 | 0.91 / 0.89 / 17 of 22 |
| normals | 0.87 | 0.74 | 0.81 / 0.87 / 17 of 23 |
| `combo_int.z` | 0.94 | 0.86 | 0.91 / 0.89 / 16 of 22 |

Much of the easy separation comes from the sky mask alone.

## Traps (`combo_int.z`, percentile against the correct refs)

| trap | score (percentile) | vetoed? | what the render shows |
|---|---|---|---|
| wc_0001 B | 1.32 (17%) | no | the right peaks from a slightly wrong place |
| wc_0069 A | −1.49 (0%) | **yes** | a hillside fills about 60% of the frame |
| wc_0070 A | 1.15 (10%) | no | the right peaks from a slightly wrong place |
| wc_0074 A | −0.51 (0%) | **yes** | a wall artefact next to the eye; the correct pose is 225 m away |

## Models and runtime
- **MoGe-2 ViT-L (MIT):**
  - Time: 1.9 s per photo on MPS unloaded, 4.2 s median under load; 10–11 s on CPU.
  - FOV estimate: a median 20.7° too wide, so unusable.
- **MoGe-2 ViT-B (MIT):**
  - Time: 0.7–1.0 s per photo on MPS, 6–7 s on CPU.
  - FOV estimate: a similar bias.
- **DA3-Base (Apache-2.0):**
  - Time: 0.8 s per photo on MPS, 11–15 s on CPU.
  - FOV estimate: a median error of 7.4°.
  - Close to MoGe-L on refs, but it falsely vetoes 2 of the 19 correct HIGHs.
- **FOV context:** EXIF focal matches the refs to a median of 0.55°, so neither model's FOV is useful as a prior.
- **Scoring:** about 20 ms per pose.

## Method
- **Grid:** scores are computed at stride 4 on the render grid (about 256 px wide). Render depth comes from the cached xyz; normals come from xyz differences.
- **Sky mask:** MoGe-L's is used for every model, because DA3 has none.
- **Normalisation:** each pose is scored against the same pitch, roll and FOV at 68 other yaws (5° steps, ±10° excluded).
- **Combos:**
  - `combo.z` averages rank correlation, local ordinal accuracy and depth edges including the skyline.
  - `combo_int.z` averages the terrain-only versions of those three.
- **Panorama from the ring:** resampling agrees with exact renders to a median 0.0013 in log depth, with 99.9% sky agreement.
- **Design:** `tune.py` searched 48 settings on the 12 odd photos available at the time. A robust middle setting was taken rather than the best one: 100 m near mask, prediction edge threshold 0.10, render edge threshold 0.15, σ = 2 px. Combos and the veto rule were fixed before the even ids were scored.
- **Where truth ranks among its perturbations:**
  - yaw: 28/30 (edges), 26/30 (rank correlation), 17/28 (terrain-only edges);
  - pitch: 30/30, 30/30, 22/28.
- **Matcher poses:** AUROC of correct against gross is 0.86 (`combo_int.z`, normals), 0.85 (terrain-only edges) and 0.84 (rank correlation). Missed gross poses: wc_0001, 0070, 0002 and 0005, none of them HIGH.

## Caveats
- **Small sample:** 32 correct refs, 4 traps and 1 HIGH-wrong; both vetoed traps are the same kind of failure. Because the threshold is the minimum over about 14 refs, expect some false vetoes in practice.
- **Ring-panorama coverage:** it covers only a vertical band (a median 69% of a ref's pixels). Raw scores there are not comparable to full renders, and this caused all 5 false vetoes on wc_0006. Use the `.z` scores for such poses.
- **Near-field mask:** MoGe underestimates km-range depth about 10×, so a 300 m mask would remove most terrain. 100 m was chosen on the odd ids.
- **Not tested:** wc_0086, the moved-eye gross HIGH (no moved-eye renders in the cache).
- **wc_0033 (post hoc):** LoMa's unverified pose (yaw 61.0°, 1219 inliers) scores 2.82, above the correct-ref median.
- **Intrinsics fix:** 16 photos were scored before it; the effect is under 0.1 grid px.
- **Cost:** eval takes a median 75 s per photo on CPU. Disk: 233 MB here, plus 2.1 GB of weights and 39 MB in `.pylib_x2`.

## Files
`results_{all,odd,even}.json`, `veto.json`, `veto_finals.json`, `veto.txt`, `extras.json`, `tune_odd.json`, `figs/{example,perturb,scans,refs_combo}.png`.
