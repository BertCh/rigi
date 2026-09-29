# LoMa vs ALIKED+LightGlue: photo↔render matcher A/B (dev split)

Candidate: **LoMa** (davnords/LoMa, ECCV 2026; DaD detector + DeDoDe-G descriptor on DINOv2 ViT-L + a LightGlue-style matcher; code MIT, matcher Apache-2.0, DINOv2 Apache-2.0).
Baseline: **ALIKED + LightGlue**, 4096 kp, LightGlue on CPU, as the service runs it (`s1.correspond(kind="aliked")`).
Data: the 50 DEV ids (`refs.dev_ids()`). No test ids, no data_v3. Renders come from the worker on :8771 with sat style. Both matchers see the same pixels.

## Recommendation

**Adopt LoMa-B with 4096 keypoints on MPS fp32 as the stage-2 and sweep matcher, behind a flag. Run an end-to-end pipeline A/B before making it the default. Do not run it on CPU.**

- **Better where it counts.** On the 30 photos with a correct ref, the 9-view sweep ranks the correct view first in 25/30 photos vs 23/30 for the baseline. The pooled sweep solve is correct in 22 vs 20. The median best-correct inlier count is 204 vs 136, and no wrong view reaches 100 inliers for either matcher.
  - LoMa turns the baseline's weak or zero support into usable support on wc_0009, wc_0011, wc_0046, wc_0072 and wc_0099. These are hazy or near-field photos.
  - It loses no photo that the baseline gets.
- **Oracle.** At the reference pose, the fan gives ≥ 30 inliers and < 2° in 27/30 photos vs 25/30. LoMa rescues wc_0034 and wc_0052, where ALIKED gets 0 and 6 inliers. Its rotations are about 2.5× tighter: the median error against a pooled consensus pose is 0.033° vs 0.086°.
- **Hard subsets.**
  - Haze: top-1 5/6 vs 4/6, with median best-correct 144 vs 25 inliers.
  - Winter: same hit rate (6/8), with twice the inliers.
  - Near: 14/19 vs 12/19.
- **Some failures are not the matcher's.** Five photos with a correct ref fail the sweep for all matchers: wc_0014, 0019, 0034, 0048 and 0055. The oracle works for most of them, so the sweep fails on eye or coverage, not on matching. Likewise wc_0002, 0006 and 0028 solve 6-10° from the ref for every matcher, which looks like a ref or eye disagreement.
- **Caveat for the accept rule.**
  - On photos with no correct ref, LoMa-4096 finds ≥ 100-inlier support on 5/20 photos, and 4 of those sit within 2.3° of a known wrong ref: wc_0001 (B), wc_0069 (A), wc_0070 (A) and wc_0074 (A). The baseline shows the same behaviour on wc_0001, 0069 and 0074.
  - A high inlier count alone is therefore not a safe accept signal with either matcher. Stronger matching makes this slightly more common (5 vs 3 photos).
  - **wc_0033** (haze) is new: 233 LoMa inliers at a pose (61.2, -5.8, -4.6) that matches no ref, while the baseline gets 9. It is worth a look.
- **Speed and memory.**
  - On MPS fp32 under shared-CPU load, LoMa-B 4096 matches a pair in about 1.8 s median (p90 2.0 s). The baseline takes about 2.1 s median (p90 4.3 s), because CPU LightGlue suffers most from load.
  - On CPU fp32, LoMa takes about 33 s per pair (21 s with the photo cached). That is not viable.
  - MPS memory is about 10 GB for B-4096 and 11.3 GB for LoMa-G. That is a real cost on this machine: LoMa should run in the one long-lived matcher process, not per request.
- **Determinism.**
  - LoMa gives identical matches across 5 repeats on each device and precision: CPU fp32, MPS fp32, MPS fp16, and G.
  - Across devices, MPS fp32 shares 867/876 matches with CPU fp32, and MPS fp16 shares 838/876.
  - For contrast, LightGlue on **MPS** is not deterministic: one run in 5 returned 0 matches. The service is right to keep LightGlue on CPU.
  - Use MPS fp32. fp16 saves only about 10% time and drifts more.
- **2048 vs 4096 keypoints.** LoMa-B at 2048 is about as accurate but has half the inliers and weaker sweep margins (median best-correct 106 vs 204). Its timing is about the same, because the DINOv2 descriptor dominates the cost. Use 4096.
- **LoMa-G.** It was only checked on the determinism pair: 905 vs 877 matches, 1.4× slower, 1.4 GB of weights. It is not worth it before B is integrated.

## Experiment 1: install and determinism
Pair: the photo and its satellite render at the correct ref pose, 1024 px wide. `det.py`, results in the scratch dir `det/results.jsonl`.

| config | matches | 5 repeats identical | s/pair | s/view (photo cached) | MPS mem GB |
|---|---|---|---|---|---|
| LoMa-B MPS fp32 2048 | 877 | yes | 2.6 | 1.37 | 9.8 |
| LoMa-B MPS fp16 2048 | 876 | yes | 2.2 | 1.21 | 9.3 |
| LoMa-B MPS fp32 4096 | 1720 | yes | 3.0 (first 6.1) | 2.75 | 10.1 |
| LoMa-G MPS fp32 2048 | 905 | yes | 3.1 | 1.91 | 11.3 |
| LoMa-B CPU fp32 2048 | 876 | yes | 33 | 21.3 | – |
| ALIKED (MPS) + LightGlue (CPU) 4096 | 1010 | yes | 1.4-2.0 | – | – |
| ALIKED (MPS) + LightGlue (MPS) 4096 | 1005 / **0** | **no** | 0.5-1.0 | – | – |

Load average was about 20 during these timings.

Cross-device matches shared with CPU fp32 (identical to 0.5 px): MPS fp32 867/876 and MPS fp16 838/876.

## Experiments 2-4 (MPS fp32; `ab.py`, tables from `report.py`)
records: 50; errors: none; load avg (1 min) during run: median 13, max 24

## Experiment 2: oracle recall

### All dev (n = 30 photos with a correct ref)

| matcher | view | median lifted | median inliers | median lifted ≤6 px of ref | median inlier frac ≤6 px of ref | median rot err ° | rot err < 1° | < 2° | ≥ 30 inl & < 2° | ms / pair (median) |
|---|---|---|---|---|---|---|---|---|---|---|
| ALIKED+LG 4096 | centre | 786 | 498 | 338 | 0.89 | 0.21 | 24 | 25 | 25 | 3062 |
| ALIKED+LG 4096 | fan | 2888 | 1746 | 1335 | 0.88 | 0.24 | 23 | 25 | 25 | 3062 |
| LoMa-B 2048 | centre | 674 | 321 | 276 | 0.80 | 0.31 | 25 | 26 | 25 | 2020 |
| LoMa-B 2048 | fan | 2458 | 1218 | 1067 | 0.80 | 0.32 | 27 | 28 | 27 | 2020 |
| LoMa-B 4096 | centre | 1254 | 699 | 596 | 0.79 | 0.28 | 26 | 27 | 27 | 1904 |
| LoMa-B 4096 | fan | 4766 | 2528 | 2182 | 0.81 | 0.29 | 25 | 27 | 27 | 1904 |

### All dev: agreement with a matcher-pooled consensus pose (n = 27 photos whose pooled consensus is within 3° of the ref)

| matcher | median lifted ≤ 6 px of consensus | median frac of lifted ≤ 6 px | median own-solve inliers | median frac of own inliers ≤ 6 px of consensus | median own rot err vs consensus ° | own err < 0.5° |
|---|---|---|---|---|---|---|
| ALIKED+LG 4096 | 1808 | 0.75 | 1831 | 0.98 | 0.086 | 24 |
| LoMa-B 2048 | 1280 | 0.53 | 1279 | 0.99 | 0.034 | 25 |
| LoMa-B 4096 | 2673 | 0.64 | 2675 | 0.99 | 0.033 | 26 |

| photo | tags | ALIKED+LG 4096 centre inl | LoMa-B 2048 centre inl | LoMa-B 4096 centre inl | ALIKED+LG 4096 fan inl / rot° vs ref | LoMa-B 2048 fan inl / rot° vs ref | LoMa-B 4096 fan inl / rot° vs ref |
|---|---|---|---|---|---|---|---|
| wc_0002 | near | 99 | 58 | 125 | 388 / 10.19 | 230 / 10.21 | 498 / 10.16 |
| wc_0004 |  | 1741 | 840 | 1891 | 7341 / 0.04 | 3546 / 0.04 | 8103 / 0.03 |
| wc_0006 | near | 406 | 211 | 473 | 1487 / 1.65 | 882 / 1.51 | 1987 / 1.47 |
| wc_0009 | near | 948 | 386 | 834 | 2210 / 0.03 | 998 / 0.03 | 2177 / 0.05 |
| wc_0011 | near | 683 | 466 | 1247 | 1736 / 0.19 | 1318 / 0.11 | 3514 / 0.18 |
| wc_0014 | haze,near | 733 | 417 | 1072 | 2136 / 0.33 | 1418 / 0.25 | 3745 / 0.21 |
| wc_0017 |  | 681 | 319 | 722 | 2137 / 0.22 | 1138 / 0.11 | 2607 / 0.11 |
| wc_0019 | near | 983 | 456 | 1108 | 3557 / 0.24 | 1710 / 0.13 | 4231 / 0.13 |
| wc_0020 | winter,near | 654 | 291 | 689 | 2196 / 0.36 | 1029 / 0.41 | 2450 / 0.38 |
| wc_0027 | near | 491 | 234 | 468 | 1831 / 0.43 | 845 / 0.34 | 1666 / 0.26 |
| wc_0028 |  | 93 | 74 | 128 | 462 / 6.50 | 343 / 6.57 | 608 / 6.49 |
| wc_0034 | near | 0 | 57 | 75 | 0 / – | 151 / 0.81 | 226 / 1.26 |
| wc_0046 | haze | 30 | 132 | 269 | 86 / 0.16 | 447 / 0.23 | 1028 / 0.29 |
| wc_0047 | near | 683 | 430 | 987 | 2739 / 0.57 | 1838 / 0.55 | 4057 / 0.56 |
| wc_0048 | winter,near | 1154 | 521 | 1154 | 3763 / 0.21 | 1783 / 0.19 | 4120 / 0.20 |
| wc_0052 | haze,near | 0 | 25 | 46 | 6 / 23.46 | 72 / 0.56 | 220 / 0.29 |
| wc_0054 |  | 579 | 356 | 709 | 2584 / 0.13 | 1598 / 0.26 | 3032 / 0.23 |
| wc_0055 | winter,near | 7 | 0 | 6 | 7 / 6.12 | 13 / 0.88 | 20 / 7.25 |
| wc_0059 | winter,near | 183 | 323 | 749 | 829 / 0.09 | 1279 / 0.10 | 2724 / 0.11 |
| wc_0063 | near | 285 | 315 | 658 | 1186 / 0.04 | 1254 / 0.15 | 2675 / 0.21 |
| wc_0067 | winter,near | 571 | 527 | 1155 | 1756 / 0.10 | 1898 / 0.14 | 4315 / 0.12 |
| wc_0071 | winter,near | 200 | 122 | 250 | 522 / 1.28 | 461 / 0.81 | 930 / 0.66 |
| wc_0072 | haze | 44 | 93 | 165 | 138 / 0.23 | 337 / 0.38 | 655 / 0.43 |
| wc_0076 | near | 367 | 313 | 620 | 1314 / 0.16 | 1183 / 0.37 | 2346 / 0.34 |
| wc_0077 | haze,near | 1583 | 825 | 1815 | 5828 / 0.30 | 2990 / 0.31 | 6653 / 0.35 |
| wc_0082 |  | 794 | 434 | 957 | 2911 / 0.55 | 1679 / 0.44 | 3661 / 0.44 |
| wc_0085 | winter,haze | 305 | 350 | 810 | 1233 / 0.33 | 1444 / 0.52 | 3224 / 0.45 |
| wc_0088 |  | 1333 | 534 | 1341 | 4282 / 0.24 | 1738 / 0.25 | 4290 / 0.24 |
| wc_0094 |  | 506 | 264 | 587 | 1885 / 0.05 | 1060 / 0.34 | 2275 / 0.24 |
| wc_0099 | winter | 330 | 402 | 686 | 863 / 0.32 | 1310 / 0.29 | 2259 / 0.34 |

## Experiment 3: sweep discrimination

### All dev (n = 30 photos with a correct ref)

| matcher | top-1 view is correct | median best-correct inl | median best-wrong inl | median ratio correct/wrong | ratio ≥ 2 | best-wrong ≥ 100 | pooled 9-view solve correct (< max(2°, 0.1·hfov), ≥ 30 inl) |
|---|---|---|---|---|---|---|---|
| ALIKED+LG 4096 | 23/30 | 136 | 0 | 115.50 | 23 | 0 | 20 |
| LoMa-B 2048 | 25/30 | 106 | 0 | 47.71 | 25 | 0 | 22 |
| LoMa-B 4096 | 25/30 | 204 | 0 | 169.00 | 25 | 0 | 22 |

| photo | tags | ALIKED+LG 4096 correct / wrong (top-1) | LoMa-B 2048 correct / wrong (top-1) | LoMa-B 4096 correct / wrong (top-1) | ALIKED+LG 4096 pooled inl / rot° | LoMa-B 2048 pooled inl / rot° | LoMa-B 4096 pooled inl / rot° |
|---|---|---|---|---|---|---|---|
| wc_0002 | near | 96 / 0 (Y) | 58 / 0 (Y) | 117 / 0 (Y) | 176 / 10.3 | 107 / 10.3 | 215 / 10.2 |
| wc_0004 |  | 1103 / 0 (Y) | 663 / 0 (Y) | 1350 / 0 (Y) | 1798 / 0.2 | 1117 / 0.2 | 2295 / 0.2 |
| wc_0006 | near | 141 / 0 (Y) | 107 / 0 (Y) | 203 / 0 (Y) | 327 / 5.8 | 265 / 5.8 | 474 / 5.8 |
| wc_0009 | near | 21 / 0 (Y) | 94 / 6 (Y) | 212 / 0 (Y) | 32 / 0.4 | 164 / 0.2 | 323 / 0.2 |
| wc_0011 | near | 0 / 0 (n) | 55 / 0 (Y) | 119 / 0 (Y) | 0 / – | 55 / 0.8 | 120 / 0.6 |
| wc_0014 | haze,near | 0 / 0 (n) | 0 / 0 (n) | 0 / 0 (n) | 0 / – | 0 / – | 0 / – |
| wc_0017 |  | 15 / 0 (Y) | 39 / 0 (Y) | 87 / 0 (Y) | 15 / 3.8 | 39 / 3.7 | 86 / 4.4 |
| wc_0019 | near | 0 / 0 (n) | 0 / 0 (n) | 0 / 0 (n) | 0 / – | 0 / – | 0 / – |
| wc_0020 | winter,near | 604 / 0 (Y) | 261 / 6 (Y) | 614 / 0 (Y) | 604 / 0.3 | 261 / 0.5 | 614 / 0.4 |
| wc_0027 | near | 81 / 0 (Y) | 106 / 6 (Y) | 205 / 0 (Y) | 81 / 0.5 | 106 / 0.5 | 205 / 0.5 |
| wc_0028 |  | 138 / 0 (Y) | 75 / 0 (Y) | 164 / 0 (Y) | 140 / 1.3 | 91 / 1.3 | 206 / 1.3 |
| wc_0034 | near | 0 / 0 (n) | 0 / 0 (n) | 0 / 0 (n) | 0 / – | 0 / – | 0 / – |
| wc_0046 | haze | 15 / 0 (Y) | 90 / 0 (Y) | 182 / 0 (Y) | 15 / 0.3 | 134 / 0.2 | 297 / 0.3 |
| wc_0047 | near | 451 / 0 (Y) | 256 / 8 (Y) | 611 / 0 (Y) | 666 / 0.7 | 430 / 1.6 | 997 / 1.4 |
| wc_0048 | winter,near | 0 / 0 (n) | 0 / 6 (n) | 0 / 13 (n) | 0 / – | 6 / 160.7 | 13 / 121.7 |
| wc_0052 | haze,near | 0 / 0 (n) | 6 / 0 (Y) | 6 / 0 (Y) | 0 / – | 7 / 6.6 | 6 / 6.3 |
| wc_0054 |  | 299 / 0 (Y) | 158 / 6 (Y) | 252 / 7 (Y) | 408 / 1.4 | 228 / 1.2 | 476 / 1.3 |
| wc_0055 | winter,near | 0 / 0 (n) | 0 / 0 (n) | 0 / 0 (n) | 8 / 140.4 | 6 / 66.6 | 0 / – |
| wc_0059 | winter,near | 135 / 0 (Y) | 174 / 7 (Y) | 333 / 0 (Y) | 135 / 0.2 | 238 / 0.6 | 645 / 0.2 |
| wc_0063 | near | 278 / 0 (Y) | 304 / 0 (Y) | 659 / 0 (Y) | 361 / 0.1 | 500 / 0.3 | 1060 / 0.2 |
| wc_0067 | winter,near | 283 / 11 (Y) | 465 / 0 (Y) | 1054 / 0 (Y) | 306 / 0.5 | 777 / 0.2 | 1713 / 0.2 |
| wc_0071 | winter,near | 193 / 0 (Y) | 114 / 0 (Y) | 199 / 6 (Y) | 187 / 0.7 | 181 / 3.4 | 360 / 3.0 |
| wc_0072 | haze | 35 / 0 (Y) | 49 / 0 (Y) | 114 / 0 (Y) | 35 / 0.3 | 33 / 0.7 | 114 / 0.5 |
| wc_0076 | near | 450 / 0 (Y) | 341 / 11 (Y) | 739 / 5 (Y) | 689 / 0.6 | 627 / 0.7 | 1312 / 0.8 |
| wc_0077 | haze,near | 144 / 0 (Y) | 87 / 0 (Y) | 174 / 0 (Y) | 144 / 1.1 | 92 / 0.4 | 181 / 0.7 |
| wc_0082 |  | 598 / 0 (Y) | 319 / 0 (Y) | 665 / 8 (Y) | 628 / 0.7 | 359 / 0.7 | 747 / 0.7 |
| wc_0085 | winter,haze | 153 / 0 (Y) | 123 / 0 (Y) | 307 / 0 (Y) | 280 / 0.4 | 249 / 0.9 | 524 / 0.8 |
| wc_0088 |  | 830 / 0 (Y) | 325 / 7 (Y) | 790 / 0 (Y) | 830 / 0.2 | 327 / 0.2 | 800 / 0.2 |
| wc_0094 |  | 368 / 0 (Y) | 209 / 0 (Y) | 429 / 0 (Y) | 603 / 0.0 | 383 / 0.5 | 778 / 0.3 |
| wc_0099 | winter | 74 / 0 (Y) | 184 / 0 (Y) | 306 / 0 (Y) | 77 / 1.0 | 186 / 1.1 | 313 / 1.1 |

### Photos with NO correct ref (n = 20): strong (≥ 100-inlier) single-view support

| photo | tags | ALIKED+LG 4096 best inl (view yaw) | LoMa-B 2048 best inl (view yaw) | LoMa-B 4096 best inl (view yaw) | LoMa-B 4096 views ≥ 100 inl: view yaw → solved (yaw, pitch, roll), inl | within 3° of a wrong ref? |
|---|---|---|---|---|---|---|
| wc_0001 | winter | 207 (120°) | 66 (120°) | 201 (120°) | 120° → (101.6, 4.0, 1.6), 201 | B (0.5°) |
| wc_0005 |  | 0 (0°) | 33 (200°) | 65 (200°) | none | – |
| wc_0010 | winter,near | 0 (0°) | 0 (0°) | 0 (0°) | none | – |
| wc_0013 | near | 0 (0°) | 0 (0°) | 0 (0°) | none | – |
| wc_0015 | winter,haze,near | 8 (200°) | 0 (0°) | 12 (240°) | none | – |
| wc_0023 |  | 0 (0°) | 19 (200°) | 32 (200°) | none | – |
| wc_0033 | haze | 9 (80°) | 119 (80°) | 233 (80°) | 80° → (61.2, -5.8, -4.6), 233 | – |
| wc_0035 | haze | 0 (0°) | 0 (0°) | 0 (0°) | none | – |
| wc_0037 | winter,near | 0 (0°) | 0 (0°) | 0 (0°) | none | – |
| wc_0040 | winter,near | 0 (0°) | 16 (240°) | 47 (240°) | none | – |
| wc_0053 | winter,near | 0 (0°) | 10 (320°) | 6 (200°) | none | – |
| wc_0058 | near | 0 (0°) | 5 (240°) | 6 (120°) | none | – |
| wc_0069 | haze | 156 (320°) | 150 (280°) | 280 (320°) | 280° → (280.9, -8.7, 0.4), 258; 320° → (281.1, -8.5, 0.4), 280 | A (0.2°), A (0.4°) |
| wc_0070 | near | 84 (320°) | 186 (320°) | 349 (320°) | 0° → (320.3, -0.2, -0.8), 286; 320° → (320.3, -0.2, -0.9), 349 | A (2.2°), A (2.3°) |
| wc_0073 | winter | 7 (240°) | 0 (0°) | 0 (0°) | none | – |
| wc_0074 |  | 449 (240°) | 260 (240°) | 530 (240°) | 240° → (261.1, -10.8, 0.3), 530; 280° → (261.5, -10.7, -1.4), 465 | A (1.2°), A (0.5°) |
| wc_0086 | near | 0 (0°) | 0 (0°) | 0 (0°) | none | – |
| wc_0087 | winter,haze | 0 (0°) | 0 (0°) | 0 (0°) | none | – |
| wc_0095 |  | 0 (0°) | 0 (0°) | 0 (0°) | none | – |
| wc_0098 | winter,near | 0 (0°) | 7 (120°) | 12 (120°) | none | – |

## Experiment 4: hard subsets

### winter: oracle (n = 8 photos with a correct ref)

| matcher | view | median lifted | median inliers | median lifted ≤6 px of ref | median inlier frac ≤6 px of ref | median rot err ° | rot err < 1° | < 2° | ≥ 30 inl & < 2° | ms / pair (median) |
|---|---|---|---|---|---|---|---|---|---|---|
| ALIKED+LG 4096 | centre | 422 | 318 | 281 | 0.92 | 0.33 | 7 | 7 | 7 | 2676 |
| ALIKED+LG 4096 | fan | 1376 | 1048 | 1024 | 0.91 | 0.32 | 6 | 7 | 7 | 2676 |
| LoMa-B 2048 | centre | 526 | 336 | 326 | 0.90 | 0.32 | 6 | 6 | 6 | 1795 |
| LoMa-B 2048 | fan | 2020 | 1294 | 1184 | 0.81 | 0.35 | 8 | 8 | 7 | 1795 |
| LoMa-B 4096 | centre | 999 | 719 | 686 | 0.84 | 0.38 | 7 | 7 | 7 | 1787 |
| LoMa-B 4096 | fan | 3648 | 2587 | 2485 | 0.85 | 0.36 | 7 | 7 | 7 | 1787 |

### winter: consensus (n = 7 photos whose pooled consensus is within 3° of the ref)

| matcher | median lifted ≤ 6 px of consensus | median frac of lifted ≤ 6 px | median own-solve inliers | median frac of own inliers ≤ 6 px of consensus | median own rot err vs consensus ° | own err < 0.5° |
|---|---|---|---|---|---|---|
| ALIKED+LG 4096 | 1235 | 0.79 | 1233 | 0.99 | 0.066 | 6 |
| LoMa-B 2048 | 1315 | 0.66 | 1310 | 0.99 | 0.026 | 7 |
| LoMa-B 4096 | 2725 | 0.73 | 2724 | 0.99 | 0.022 | 7 |

### winter: sweep (n = 8 photos with a correct ref)

| matcher | top-1 view is correct | median best-correct inl | median best-wrong inl | median ratio correct/wrong | ratio ≥ 2 | best-wrong ≥ 100 | pooled 9-view solve correct (< max(2°, 0.1·hfov), ≥ 30 inl) |
|---|---|---|---|---|---|---|---|
| ALIKED+LG 4096 | 6/8 | 144 | 0 | 104.50 | 6 | 0 | 6 |
| LoMa-B 2048 | 6/8 | 148 | 0 | 78.75 | 6 | 0 | 6 |
| LoMa-B 4096 | 6/8 | 306 | 0 | 306.50 | 6 | 0 | 6 |

winter, no correct ref: 9 photos; any sweep view ≥ 100 inl: ALIKED+LG 4096 1, LoMa-B 2048 0, LoMa-B 4096 1

### haze: oracle (n = 6 photos with a correct ref)

| matcher | view | median lifted | median inliers | median lifted ≤6 px of ref | median inlier frac ≤6 px of ref | median rot err ° | rot err < 1° | < 2° | ≥ 30 inl & < 2° | ms / pair (median) |
|---|---|---|---|---|---|---|---|---|---|---|
| ALIKED+LG 4096 | centre | 233 | 174 | 169 | 0.90 | 0.29 | 5 | 5 | 5 | 3189 |
| ALIKED+LG 4096 | fan | 902 | 686 | 676 | 0.92 | 0.31 | 5 | 5 | 5 | 3189 |
| LoMa-B 2048 | centre | 366 | 241 | 214 | 0.84 | 0.28 | 6 | 6 | 5 | 2456 |
| LoMa-B 2048 | fan | 1565 | 932 | 834 | 0.86 | 0.35 | 6 | 6 | 6 | 2456 |
| LoMa-B 4096 | centre | 700 | 540 | 472 | 0.82 | 0.33 | 6 | 6 | 6 | 1893 |
| LoMa-B 4096 | fan | 2752 | 2126 | 1884 | 0.84 | 0.32 | 6 | 6 | 6 | 1893 |

### haze: consensus (n = 6 photos whose pooled consensus is within 3° of the ref)

| matcher | median lifted ≤ 6 px of consensus | median frac of lifted ≤ 6 px | median own-solve inliers | median frac of own inliers ≤ 6 px of consensus | median own rot err vs consensus ° | own err < 0.5° |
|---|---|---|---|---|---|---|
| ALIKED+LG 4096 | 686 | 0.72 | 686 | 0.98 | 0.158 | 5 |
| LoMa-B 2048 | 933 | 0.57 | 932 | 0.99 | 0.044 | 6 |
| LoMa-B 4096 | 2130 | 0.70 | 2126 | 0.99 | 0.035 | 6 |

### haze: sweep (n = 6 photos with a correct ref)

| matcher | top-1 view is correct | median best-correct inl | median best-wrong inl | median ratio correct/wrong | ratio ≥ 2 | best-wrong ≥ 100 | pooled 9-view solve correct (< max(2°, 0.1·hfov), ≥ 30 inl) |
|---|---|---|---|---|---|---|---|
| ALIKED+LG 4096 | 4/6 | 25 | 0 | 25.00 | 4 | 0 | 3 |
| LoMa-B 2048 | 5/6 | 68 | 0 | 68.00 | 5 | 0 | 4 |
| LoMa-B 4096 | 5/6 | 144 | 0 | 144.00 | 5 | 0 | 4 |

haze, no correct ref: 5 photos; any sweep view ≥ 100 inl: ALIKED+LG 4096 1, LoMa-B 2048 2, LoMa-B 4096 2

### near: oracle (n = 19 photos with a correct ref)

| matcher | view | median lifted | median inliers | median lifted ≤6 px of ref | median inlier frac ≤6 px of ref | median rot err ° | rot err < 1° | < 2° | ≥ 30 inl & < 2° | ms / pair (median) |
|---|---|---|---|---|---|---|---|---|---|---|
| ALIKED+LG 4096 | centre | 773 | 491 | 334 | 0.86 | 0.29 | 14 | 15 | 15 | 3126 |
| ALIKED+LG 4096 | fan | 2670 | 1736 | 1213 | 0.86 | 0.31 | 13 | 15 | 15 | 3126 |
| LoMa-B 2048 | centre | 685 | 315 | 277 | 0.77 | 0.28 | 15 | 16 | 15 | 2036 |
| LoMa-B 2048 | fan | 2363 | 1183 | 1054 | 0.75 | 0.34 | 17 | 18 | 17 | 2036 |
| LoMa-B 4096 | centre | 1335 | 689 | 625 | 0.78 | 0.28 | 16 | 17 | 17 | 1903 |
| LoMa-B 4096 | fan | 4445 | 2450 | 2227 | 0.80 | 0.29 | 15 | 17 | 17 | 1903 |

### near: consensus (n = 17 photos whose pooled consensus is within 3° of the ref)

| matcher | median lifted ≤ 6 px of consensus | median frac of lifted ≤ 6 px | median own-solve inliers | median frac of own inliers ≤ 6 px of consensus | median own rot err vs consensus ° | own err < 0.5° |
|---|---|---|---|---|---|---|
| ALIKED+LG 4096 | 1723 | 0.76 | 1756 | 0.97 | 0.076 | 14 |
| LoMa-B 2048 | 1249 | 0.50 | 1254 | 0.98 | 0.027 | 15 |
| LoMa-B 4096 | 2673 | 0.61 | 2675 | 0.99 | 0.033 | 16 |

### near: sweep (n = 19 photos with a correct ref)

| matcher | top-1 view is correct | median best-correct inl | median best-wrong inl | median ratio correct/wrong | ratio ≥ 2 | best-wrong ≥ 100 | pooled 9-view solve correct (< max(2°, 0.1·hfov), ≥ 30 inl) |
|---|---|---|---|---|---|---|---|
| ALIKED+LG 4096 | 12/19 | 96 | 0 | 81.00 | 12 | 0 | 11 |
| LoMa-B 2048 | 14/19 | 94 | 0 | 31.00 | 14 | 0 | 12 |
| LoMa-B 4096 | 14/19 | 199 | 0 | 147.80 | 14 | 0 | 12 |

near, no correct ref: 10 photos; any sweep view ≥ 100 inl: ALIKED+LG 4096 0, LoMa-B 2048 1, LoMa-B 4096 1


**Metric notes.**
- "rot err" compares against the verified ref pose. The refs come from other pipeline versions, eye heights and focal lengths, so agreement within 6 px of the raw ref is limited for both matchers. The consensus table measures precision against a pose solved from all matchers' pooled matches.
- In the sweep, a view is "correct" if it is the view nearest a correct ref's yaw, or it solves within 3° of a ref and less than one hfov away. A view is "wrong" if it is at least one hfov from every correct ref.
- ms/pair is the matcher time per view, including the photo's own features on the first view, measured under shared load.

## Files
- `matcher.py`
  - `match_loma(photo_rgb, view_rgb) -> (kp_photo Nx2, kp_view Nx2, conf N)`: pixel-centre origin, the same as ALIKED/LightGlue keypoints in `s1.correspond`. It was checked on real data: it gives 876 matches on the det pair on CPU.
  - Cropping 24 px gives a median offset of (23.99, 0.01).
  - Matching a half-resolution image against the full-resolution one gives median(k_full − 2·k_half) = (0.49, 0.50). This is the +0.5 expected for pixel-centre coordinates.
  - `correspond_loma(photo, views, eye)` returns the same dict as `s1.correspond`.
  - The device and precision are chosen with `LOMA_DEVICE`, `LOMA_PREC`, `LOMA_MODEL` and `LOMA_KP`.
- `det.py`: experiment 1, covering determinism, timing and the cross-device check.
- `ab.py`: experiments 2-4, one JSON record plus the lifted-match npz files per photo. It skips only complete, valid records, so it can resume.
- `report.py`: the tables above.

The main run was interrupted by a filesystem outage after 28 photos and resumed for the remaining 22 with an identical config. All 50 records are complete, with no errors.

Weights live in `~/.cache/torch/hub/checkpoints`: loma_B.pt 723 MB, loma_G.pth 1.4 GB, dad.pth 25 MB.
