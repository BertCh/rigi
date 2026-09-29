# X3 — render modality × matcher: correspondences and true-vs-wrong separation (TM program)

*Written by the main session from X3's returned findings (the subagent could not write report files). Detailed tables are in `tables_final.md`, `tables_prune*.md`, `tables_verify.md` and `tables_runtime.md`.*

## Short answer
No combination clearly beats **LoMa-B on the sat render** on the 30 dev photos with a correct ref.

The one separation gain is a trade-off. Matching a depth-coded or hillshade render with MINIMA-XoFTR cuts support at known-wrong poses about 10×, but it loses 5 true-pose successes. Ranking-level AUC does not improve over `loma:sat`.

The only cheap win for the ALIKED baseline is photo dehazing: 24 → 26 of 30 successes.

## Set-up
- **Scope:** DEV only, shared cache, no rendering. Models over 4 GB ran under `gpu_lock()`.
- **Render modalities** (all derived offline): sat, hill, sat×hill, log-depth, camera normals, haze, snow, and edges (against photo Canny edges).
  - The haze model was fitted per photo from the photo and ring only, never a ref pose. 35 of 50 photos chose "no extra haze".
- **Photo-side variants:** CLAHE, dehaze, grayscale.

**Matchers:**
- ALIKED+LightGlue, with LightGlue on CPU.
- LoMa-B 4096 on MPS fp32.
- MINIMA-RoMa, MINIMA-XoFTR and MINIMA-LoFTR.
  - Licences: MINIMA Apache-2.0, XoFTR Apache-2.0, kornia LoFTR Apache-2.0, romatch MIT.
  - RoMa's DINOv2-L weights came from the LoMa checkpoint, so no extra download was needed.
  - All three MINIMA matchers were deterministic over 3 repeats.

**Not run:**
- MatchAnything: its upstream licence is now "Project Registration License v1.0".
- RoMa v2: needs gated DINOv3 weights and a Linux-only kernel.
- MASt3R: CC BY-NC.
- MINIMA-LightGlue: SuperPoint weights are non-commercial.

**Protocol:**
- Matches are lifted with the exact render intrinsics (fx ≠ fy). The photo side uses the service's square-f camera model (≤ 0.4 px difference).
- The pose comes from `match.solve_rotation`: 2-point RANSAC, 6 px threshold, then LM.
- A bug was fixed before any ring result was used: the photo focal on ring views had been taken from the ring's own 40° field of view.

**Pruning, then fixed choices:**
- Pruning photos: wc_0004, 0011, 0014, 0017, 0046, 0048, 0059, 0072, 0085, 0099.
- Pruning grid: 11 configs × 5 matchers on all refs plus ±2°/±8° yaw perturbations.
- Final: the 7 surviving combos on all 50 photos (refs, 12 perturbations, and 12 ring views at 30° steps).
- `mroma:hill` was picked over `mroma:haze` by judgement: all RoMa configs tied in pruning, and the geometry render was preferred.

## Pruning (10 photos): successes of 10 · median inliers

| config | ALIKED | LoMa | M-RoMa¹ | M-XoFTR | M-LoFTR |
|---|---|---|---|---|---|
| sat | 9 · 503 | 10 · 784 | 10 · 2524 | 10 · 538 | 9 · 246 |
| p_dehaze | 10 · 570 | 10 · 736 | 10 · 2622 | 10 · 514 | 10 · 234 |
| p_clahe | 10 · 570 | 10 · 750 | 10 · 2825 | 9 · 522 | 9 · 260 |
| haze | 7 · 483 | 10 · 784 | 10 · 2506 | 10 · 545 | 9 · 248 |
| hill | 1 · 0 | 10 · 336 | 10 · 2552 | 8 · 350 | 8 · 116 |
| normal | 1 · 0 | 9 · 226 | 10 · 2196 | 9 · 319 | 6 · 43 |
| depth | 0 · 0 | 0 · 0 | 9 · 2408 | 9 · 132 | 4 · 21 |
| edges | 2 · 4 | 1/3 · 16 | – | 3 · 22 | 0 · 0 |

¹ RoMa samples 5000 dense matches, so its counts are not comparable with the others.

Snow, sat×hill and gray were neutral to slightly negative. The edges modality failed with every matcher.

## Final: 30 photos with a correct ref (32 correct and 128 wrong ref renders)

| combo | success (≥ 30 inl & < 2°) | median inl | ring: top view correct | AUC (inliers / fraction) | max support at a wrong ref | correct refs above that max | ms/pair |
|---|---|---|---|---|---|---|---|
| aliked:sat | 24/30 | 492 | 19 | 0.909 / 0.905 | 616 | 13/32 | 2046 |
| aliked:p_dehaze | 26/30 | 470 | 21 | 0.926 / 0.923 | 624 | 14 | 1475 |
| **loma:sat** | **27/30** | 702 | **25** | **0.942** / 0.939 | 743 | 15 | 1395 |
| loma:hill | 22/30 | 334 | 19 | 0.895 / 0.892 | 319 | 17 | 1396 |
| mroma:hill | 27/30 | 1954¹ | 25 | 0.942 / **0.941** | 1902¹ (fraction 0.49) | 19 by fraction | 3553 |
| **mxoftr:depth** | 22/30 | 99 | 9 | 0.910 / 0.902 | **67** | **21** | 789 |
| mxoftr:hill | 22/30 | 206 | 14 | 0.911 / 0.910 | 79 | 19 | 991 |

Load average was 15–65 during these runs, so treat the timings as rough.

## Findings

**Wrong refs at the same eye are mostly harmless.** Solves from wrong-ref renders and ±8° perturbations mostly pull back to the true pose (about 80% end up within 1°). Support measured at the offset pose itself drops to about 0 by ±1–2°.

**Strong wrong basins are rare and texture-driven.**

| photo / wrong ref | ALIKED sat | LoMa sat | XoFTR depth |
|---|---|---|---|
| wc_0074 A | 616 | 743 | 13 |
| wc_0001 B | 342 | 492 | 22 |
| wc_0069 A | 161 | 306 | 7 |

LoMa on hillshade still gives these 161–319 inliers, so a geometry-only render is not enough; the matcher matters too.

**Post hoc: texture matcher proposes, XoFTR-on-depth verifies (≥ 30 inliers).**
- With LoMa-sat proposing, the accepted correct/wrong refs go from 29/7 to 24/1.
- With ALIKED+dehaze proposing, they go from 28/6 to 23/1.
- This rests on about 3 wrong-basin photos, so it is a hypothesis to pre-register, not a result.

## Caveats
- **Refs no matcher reproduces:** wc_0002 (A, 8.8° from C) and wc_0028 (T6A, 1.2° from B). These count as wrong support against every combo.
- **Focal-induced wrong basins:** wc_0006's wrong refs have vfov 68–70° against 61.7° for the correct one. That is a focal-prior problem, not a matching one.
- **Ring as a sweep proxy:** the ring uses a fixed 40° FOV, which penalises tele shots.
- **RoMa counts:** RoMa always gets 50–70 noise inliers from its 5000 samples, so compare it by inlier fraction.
- **Grayscale:** gray = sat for XoFTR and LoFTR, which convert to grayscale internally.
- **Crashes:** one LoMa MPS segfault and one killed ALIKED run were resumed; the outputs are complete.

## Files
- **Code:** `modalities.py`, `matchers.py`, `run_match.py`, `run_retry.sh`, `evaluate.py`, `analyze.py`, `report_tables.py`, `verify_combo.py` (post hoc), `_viz.py`.
- **Results:** `results_{prune,final}.json`, `summary_{prune,final}.json`, the `tables_*.md` files, `raw/` (199 MB), `params/`, `logs/`.
- **Weights:** `../weights`, `../.pylib`.
