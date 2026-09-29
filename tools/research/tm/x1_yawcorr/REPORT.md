# X1 — dense-feature yaw correlation (TM program)

*Written by the main session from X1's returned findings (the subagent could not write report files). Tables also in `tables.md`; data in `results/x1_results.json`.*

## Set-up
- DEV only, offline, shared cache.
- **Method:**
  1. The 24-view ring (sat + hillshade) becomes a cylindrical feature panorama.
  2. The photo's features are placed on the same angular grid.
  3. Each yaw is scored by FFT correlation, once per pitch/roll/FOV guess, using centred 64-D features with sky masked.
- **Baseline:** recomputed at 3° and 1°; it equals `prior_ab.json` on 50/50 photos (23/30 any-of-4, 19/30 top-1). `_prior_ab.py` stores its hit flag at 2°.
- **Design:** chosen on odd ids only and then frozen: DINOv2 ViT-B/14 with registers, sat + hill, 64-D, fusion weight 1. Even ids are the held-out set.
- **One post-hoc arm:** baseline top-2 + feature top-2 was defined after the odd results. It also holds on the even ids.

## Results (30 photos with a correct ref; frozen DINOv2-B-reg)

| arm | top-1@3° | any-of-k@3° | top-1@1° | any@1° | held-out even (16): top-1 / any @3° |
|---|---|---|---|---|---|
| baseline skyline (k=4) | 19 | 23 | 17 | 18 | 9 / 11 |
| feature raw | 21 | 21 | 8 | 8 | 11 / 11 |
| feature + local pitch/roll refine | 21 | 21 | 13 | 13 | 11 / 11 |
| feature peaks + skyline polish | 20 | 20 | 15 | 15 | 10 / 10 |
| column-pooled 1-D | 12 | 13 | 4 | 4 | 7 / 7 |
| fused feature + skyline, skyline polish | **22** | 23 | **18** | 19 | 11 / 11 |
| baseline re-ranked by feature | 20 | 23 | 15 | 18 | 10 / 11 |
| **baseline top-2 + feature top-2, k=4 [post hoc]** | 19 | **27** | 17 | **22** | 9 / **14** |
| baseline top-4 + feature top-4 (k=8) | 19 | 27 | 17 | 23 | 9 / 14 |

**Top-1 yaw error.** Features: median 0.66°, p75 3.2°, p90 18°. Skyline: median 0.28°, p75 20°, p90 57°. Features are coarser at the peak but have a much shorter wrong-basin tail.

**Complementarity (any-of-4 @3°):**
- Only the features hit wc_0009, 0048, 0052 and 0094. On wc_0009 the skyline scores the true pose negative.
- Only the skyline hits wc_0006, 0011, 0028, 0034, 0055 and 0063.
- Both miss wc_0046, 0071 and 0072.

**ViT-S** (same settings): raw 20/21, fused 21/22, union 27/30, at about half the cost.

## Design phase (odd ids, 14 photos with a ref; baseline 10 top-1 / 12 any-of-4)

| backbone | raw top-1 / any-of-4 @3° | fused top-1 / any-of-4 @3° |
|---|---|---|
| DINOv2 ViT-S/14 | 10/10 | 11/11 |
| DINOv2 ViT-B/14 | 9/9 | 11/12 |
| DINOv2 ViT-B/14-reg (chosen) | 10/10 | 11/12 |
| DINOv3 ViT-S/16 | 6/7 | 10/11 |
| DINOv3 ViT-B/16 | 8/8 | 10/11 |

- DINOv3 is not worth its licence here.
- ViT-L was stopped after 2 photos. RADIO, SigLIP and the LoMa trunk were not tried.

**Ablations:**
- Sky mask and roll fan: about neutral.
- 16-D: hurts.
- 2-D grid correlation beats column pooling: 21 vs 12 top-1.
- The ring must overlap: 8 views every 45° drops raw to 12/16. The service's own 9 × 40° ring was not tested.
- Sat alone: raw 20/21, fused 23/23. Hill alone: raw 18/20.

## Wrong refs
- **Feature score at the exact ref pose:** prefers the correct ref over a wrong one (> 3° away) in **45/46** pairs. The skyline manages 39/49.
- **Direct photo↔ref-render similarity:** prefers the correct ref in **48/49** pairs. The only miss is wc_0002 C vs A, 8.6° apart.
- **The 20 photos without a correct ref:** the feature top-1 lands within 3° of a known-wrong ref on 0/20; the skyline does on 3/20 (wc_0013, 0037, 0070).
  - Feature top-1: wc_0001 110.5°, wc_0069 357.7°, wc_0070 265.2°, wc_0074 219.8°. None of these is verified.

## Runtime
Medians over 5 photos on a loaded machine; ring rendering excluded.

| backbone, device | ring features | total per photo |
|---|---|---|
| ViT-S, MPS | 3.9 s | 7 s |
| ViT-B-reg, MPS | 6.4 s | 12.5 s |
| ViT-S, CPU | 11.4 s | 14.5 s |
| ViT-B-reg, CPU | 24.1 s | 29 s |

- The yaw search adds 1.3 s, or 5.5 s with unknown focal. The skyline search took 10.4 s in the same conditions.
- MPS is bit-identical across repeats and matches CPU (cos ≥ 0.9999998).
- Ring features depend only on the eye, so they can be cached per location.

## Verdict
1. **Integrate as an extra hypothesis generator:** feature top-2 alongside the skyline's top 2, verified by stage 2. That takes 23 → 27 of 30 (held out 11 → 14 of 16) at equal budget. It needs a dense, overlapping 24-view sat ring.
2. **Not a replacement:** +2 top-1 @3°, but worse @1° (13 vs 17), and it loses 6 skyline photos. The best single list is fusion: +3 top-1, no any-of-4 gain.
3. **Tiebreaker: no. Verifier: promising.** Photo↔render similarity was 48/49 on ref pairs, but it is untested as a stage-2 check.
4. **Caveat:** n=30 (16 held out), and the gains are 3–4 photos.

Files: `x1lib.py`, `run.py`, `sky_cache.py`, `analyze.py`, `tables.py`, `timing.py`, `run_design.sh`, `tables.md`, `results/*.json`. Weights and packages: `../.pylib/x1`, `../weights/{torchhub,hf}` (about 1.3 GB).
