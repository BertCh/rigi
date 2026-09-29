## Main table (all dev photos)

| matcher | config | n | success (≥30 & <2°) | separated (Sc≥30 & Sc≥2W) | median D=log2((Sc+1)/(W+1)) | photos W≥30 | median inl | median inl frac | median err ° | median cons6 ratio (log2) | pull-back | inl@±2° / base | inl@±8° / base | no-correct: stay≥30 / ≥100 | max wrong-stay inl | AUC Sc vs wrong-stay (inl) | AUC (inl frac) | correct photos with Sc > max wrong-stay | ms/pair |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| loma | sat | 30 | 27 | 26 | 9.32 | 4 | 702 | 0.64 | 0.28 | 9.13 | 0.86 | 0.95 | 0.85 | 4/3 (of 20) | 743 | 0.90 | 0.87 | 14 | 1392 |
| aliked | p_dehaze | 30 | 26 | 25 | 8.24 | 3 | 470 | 0.73 | 0.20 | 8.19 | 0.86 | 0.95 | 0.77 | 3/3 (of 20) | 624 | 0.89 | 0.86 | 13 | 1621 |
| aliked | sat | 30 | 24 | 24 | 7.94 | 3 | 492 | 0.74 | 0.21 | 8.13 | 0.86 | 0.96 | 0.78 | 4/3 (of 20) | 616 | 0.86 | 0.82 | 12 | 2062 |
| mroma | hill | 30 | 27 | 23 | 3.25 | 30 | 1954 | 0.55 | 0.23 | 9.39 | 0.86 | 1.00 | 0.96 | 6/6 (of 20) | 1902 | 0.90 | 0.90 | 17 | 3565 |
| loma | hill | 30 | 22 | 22 | 7.85 | 1 | 334 | 0.64 | 0.29 | 8.08 | 0.86 | 0.97 | 0.84 | 4/3 (of 20) | 319 | 0.83 | 0.81 | 16 | 1395 |
| mxoftr | depth | 30 | 22 | 21 | 5.09 | 1 | 99 | 0.76 | 0.25 | 6.17 | 0.86 | 0.92 | 0.73 | 1/0 (of 20) | 67 | 0.89 | 0.83 | 20 | 730 |
| mxoftr | hill | 30 | 22 | 20 | 5.76 | 4 | 206 | 0.70 | 0.24 | 7.61 | 0.86 | 0.93 | 0.75 | 3/0 (of 20) | 58 | 0.88 | 0.86 | 19 | 966 |

| matcher | config | n (correct) | ring top-1 true | ring separated (true≥30 & ≥2×wrong) | median ring D | photos wrong-ring ≥30 / ≥100 | median best true ring inl | no-correct: ring near wrong ref ≥30 | no-correct: ring max ≥100 |
|---|---|---|---|---|---|---|---|---|---|
| loma | sat | 30 | 25 | 26 | 8.14 | 2 / 2 | 373 | 5 (of 20) | 6 |
| mroma | hill | 30 | 25 | 24 | 3.48 | 30 / 27 | 2210 | 4 (of 20) | 20 |
| aliked | p_dehaze | 30 | 21 | 21 | 6.54 | 1 / 1 | 208 | 3 (of 20) | 3 |
| loma | hill | 30 | 19 | 19 | 6.74 | 1 / 1 | 150 | 4 (of 20) | 3 |
| aliked | sat | 30 | 19 | 19 | 6.00 | 1 / 1 | 183 | 3 (of 20) | 3 |
| mxoftr | hill | 30 | 14 | 14 | 3.23 | 2 / 0 | 17 | 2 (of 20) | 0 |
| mxoftr | depth | 30 | 9 | 9 | 3.32 | 0 / 0 | 10 | 0 (of 20) | 0 |

## Subsets (photos with a correct ref): success / separated-from-known-wrong (Sc > max wrong-stay of ALL no-correct photos) / median Sc

| combo | all | haze | winter | near | tele |
|---|---|---|---|---|---|
| aliked:sat | 24/30 · 12 · 492 | 7/10 · 5 · 533 | 7/8 · 2 · 322 | 15/19 · 8 · 488 | 8/9 · 7 · 698 |
| aliked:p_dehaze | 26/30 · 13 · 470 | 9/10 · 5 · 638 | 7/8 · 2 · 387 | 15/19 · 8 · 494 | 8/9 · 7 · 726 |
| loma:sat | 27/30 · 14 · 702 | 9/10 · 6 · 826 | 7/8 · 4 · 718 | 17/19 · 9 · 689 | 9/9 · 6 · 835 |
| loma:hill | 22/30 · 16 · 334 | 8/10 · 5 · 304 | 6/8 · 5 · 530 | 12/19 · 10 · 334 | 8/9 · 6 · 334 |
| mroma:hill | 27/30 · 17 · 1954 | 9/10 · 7 · 2841 | 7/8 · 4 · 1761 | 17/19 · 11 · 1934 | 9/9 · 7 · 2691 |
| mxoftr:depth | 22/30 · 20 · 99 | 8/10 · 8 · 106 | 6/8 · 6 · 106 | 13/19 · 11 · 76 | 7/9 · 7 · 125 |
| mxoftr:hill | 22/30 · 19 · 206 | 7/10 · 6 · 180 | 6/8 · 6 · 313 | 14/19 · 11 · 194 | 8/9 · 6 · 255 |

## Perturbation response (median over photos with a correct ref; solved inliers relative to the base-ref solve / share of solves returning < 1° of the ref / median cons6 at the rendered offset pose)

| combo | yaw-8 | yaw-4 | yaw-2 | yaw-1 | yaw+1 | yaw+2 | yaw+4 | yaw+8 | pitch-2 | pitch-1 | pitch+1 | pitch+2 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| aliked:sat | 0.85 / 0.77 / 0 | 0.92 / 0.77 / 0 | 0.96 / 0.77 / 0 | 0.97 / 0.80 / 0 | 0.98 / 0.77 / 0 | 0.96 / 0.80 / 0 | 0.91 / 0.77 / 0 | 0.71 / 0.67 / 0 | 0.94 / 0.80 / 0 | 0.98 / 0.80 / 0 | 0.99 / 0.80 / 0 | 0.98 / 0.77 / 0 |
| aliked:p_dehaze | 0.82 / 0.77 / 0 | 0.92 / 0.77 / 0 | 0.96 / 0.77 / 0 | 0.97 / 0.77 / 0 | 0.97 / 0.77 / 1 | 0.95 / 0.77 / 0 | 0.89 / 0.77 / 0 | 0.73 / 0.67 / 0 | 0.97 / 0.77 / 0 | 0.96 / 0.77 / 0 | 1.00 / 0.80 / 0 | 1.00 / 0.77 / 0 |
| loma:sat | 0.87 / 0.80 / 0 | 0.93 / 0.83 / 0 | 0.96 / 0.83 / 0 | 0.99 / 0.80 / 1 | 0.97 / 0.87 / 2 | 0.93 / 0.80 / 0 | 0.90 / 0.80 / 0 | 0.84 / 0.80 / 0 | 0.97 / 0.87 / 0 | 0.99 / 0.87 / 0 | 1.00 / 0.80 / 0 | 0.98 / 0.83 / 0 |
| loma:hill | 0.83 / 0.80 / 0 | 0.92 / 0.80 / 0 | 0.97 / 0.80 / 0 | 0.99 / 0.77 / 1 | 0.95 / 0.80 / 0 | 0.96 / 0.80 / 0 | 0.93 / 0.80 / 0 | 0.84 / 0.77 / 0 | 1.00 / 0.80 / 0 | 1.00 / 0.77 / 0 | 0.99 / 0.77 / 0 | 1.03 / 0.80 / 0 |
| mroma:hill | 0.99 / 0.80 / 0 | 1.01 / 0.83 / 0 | 1.00 / 0.83 / 0 | 1.00 / 0.83 / 2 | 0.98 / 0.80 / 0 | 0.99 / 0.83 / 0 | 1.01 / 0.80 / 0 | 0.93 / 0.80 / 0 | 0.99 / 0.80 / 0 | 1.01 / 0.80 / 0 | 0.99 / 0.83 / 0 | 1.04 / 0.83 / 0 |
| mxoftr:depth | 0.72 / 0.70 / 0 | 0.89 / 0.77 / 0 | 0.91 / 0.80 / 0 | 0.99 / 0.80 / 0 | 0.92 / 0.80 / 0 | 0.94 / 0.83 / 0 | 0.91 / 0.80 / 0 | 0.73 / 0.73 / 0 | 0.97 / 0.80 / 0 | 1.00 / 0.83 / 0 | 0.99 / 0.77 / 0 | 0.92 / 0.83 / 0 |
| mxoftr:hill | 0.74 / 0.70 / 0 | 0.86 / 0.77 / 0 | 0.91 / 0.80 / 0 | 0.95 / 0.77 / 0 | 0.96 / 0.77 / 0 | 0.94 / 0.77 / 0 | 0.88 / 0.73 / 0 | 0.77 / 0.80 / 0 | 0.95 / 0.80 / 0 | 0.93 / 0.77 / 0 | 0.93 / 0.73 / 0 | 0.93 / 0.77 / 0 |

## Per photo: correct-ref photos Sc (base-ref inliers if < 2°, ✗ = not success) / W (max inliers of any solve ≥ 3° from the ref: wrong refs, perturb, ring); no-correct photos: max inliers of a wrong-ref solve that stays < 2° on the wrong ref

| photo | subsets | aliked:sat | aliked:p_dehaze | loma:sat | loma:hill | mroma:hill | mxoftr:depth | mxoftr:hill |
|---|---|---|---|---|---|---|---|---|
| wc_0001 | winter,tele | wrong 342 | wrong 321 | wrong 492 | wrong 319 | wrong 1718 | wrong 22 | wrong 36 |
| wc_0002 | near | 0 / 166 ✗ | 0 / 163 ✗ | 0 / 189 ✗ | 27 / 29 ✗ | 0 / 1167 ✗ | 0 / 25 ✗ | 0 / 79 ✗ |
| wc_0004 | haze | 1727 / 7 | 1681 / 6 | 1910 / 0 | 443 / 0 | 3947 / 324 | 195 / 0 | 479 / 8 |
| wc_0005 | tele | wrong 0 | wrong 0 | wrong 65 | wrong 36 | wrong 325 | wrong 0 | wrong 0 |
| wc_0006 | near | 403 / 195 | 388 / 187 | 468 / 248 | 0 / 9 ✗ | 1162 / 751 | 35 / 36 | 58 / 37 |
| wc_0009 | haze,near,tele | 950 / 0 | 901 / 0 | 835 / 0 | 334 / 0 | 3270 / 279 | 76 / 0 | 43 / 0 |
| wc_0010 | winter,near | wrong 0 | wrong 0 | wrong 0 | wrong 0 | wrong 215 | wrong 0 | wrong 0 |
| wc_0011 | near,tele | 673 / 0 | 696 / 8 | 1245 / 0 | 334 / 0 | 4268 / 181 | 269 / 4 | 519 / 8 |
| wc_0013 | near,tele | wrong 18 | wrong 10 | wrong 0 | wrong 27 | wrong 0 | wrong 0 | wrong 0 |
| wc_0014 | haze,near,tele | 756 / 0 | 831 / 0 | 1080 / 0 | 274 / 0 | 4238 / 169 | 129 / 0 | 255 / 0 |
| wc_0015 | haze,winter,near | wrong 0 | wrong 0 | wrong 0 | wrong 0 | wrong 0 | wrong 0 | wrong 0 |
| wc_0017 | tele | 698 / 0 | 726 / 0 | 751 / 0 | 338 / 0 | 2691 / 191 | 180 / 0 | 424 / 0 |
| wc_0019 | near,tele | 988 / 0 | 976 / 0 | 1109 / 0 | 381 / 6 | 2509 / 202 | 69 / 0 | 219 / 0 |
| wc_0020 | winter,near,tele | 652 / 0 | 642 / 0 | 689 / 0 | 545 / 0 | 1923 / 83 | 125 / 0 | 448 / 0 |
| wc_0023 | tele | wrong 0 | wrong 0 | wrong 0 | wrong 0 | wrong 0 | wrong 0 | wrong 0 |
| wc_0027 | near,tele | 488 / 0 | 494 / 0 | 470 / 0 | 193 / 0 | 1787 / 106 | 12 / 0 ✗ | 36 / 23 |
| wc_0028 | haze | 0 / 97 ✗ | 160 / 94 | 0 / 162 ✗ | 0 / 24 ✗ | 0 / 641 ✗ | 0 / 23 ✗ | 0 / 41 ✗ |
| wc_0033 | haze | wrong 0 | wrong 0 | wrong 0 | wrong 0 | wrong 0 | wrong 0 | wrong 0 |
| wc_0034 | near,tele | 0 / 0 ✗ | 0 / 0 ✗ | 71 / 34 | 0 / 11 ✗ | 382 / 665 | 0 / 5 ✗ | 0 / 0 ✗ |
| wc_0035 | haze | wrong 0 | wrong 0 | wrong 0 | wrong 0 | wrong 0 | wrong 0 | wrong 0 |
| wc_0037 | winter,near,tele | wrong 0 | wrong 0 | wrong 0 | wrong 0 | wrong 342 | wrong 0 | wrong 0 |
| wc_0040 | winter,near,tele | wrong 0 | wrong 0 | wrong 0 | wrong 0 | wrong 0 | wrong 0 | wrong 0 |
| wc_0046 | haze | 29 / 0 ✗ | 38 / 0 | 277 / 0 | 136 / 0 | 2412 / 264 | 69 / 0 | 19 / 0 ✗ |
| wc_0047 | near | 686 / 0 | 656 / 0 | 962 / 8 | 502 / 11 | 1974 / 348 | 112 / 6 | 399 / 6 |
| wc_0048 | winter,near,tele | 1166 / 0 | 1109 / 0 | 1158 / 0 | 799 / 0 | 3953 / 200 | 359 / 0 | 523 / 0 |
| wc_0052 | haze,near | 0 / 8 ✗ | 0 / 0 ✗ | 58 / 0 | 0 / 0 ✗ | 1934 / 327 | 127 / 8 | 106 / 8 |
| wc_0053 | winter,near | wrong 0 | wrong 0 | wrong 0 | wrong 0 | wrong 0 | wrong 0 | wrong 0 |
| wc_0054 |  | 575 / 0 | 642 / 0 | 715 / 0 | 154 / 0 | 2394 / 278 | 212 / 0 | 182 / 0 |
| wc_0055 | winter,near | 0 / 6 ✗ | 0 / 4 ✗ | 0 / 11 ✗ | 0 / 0 ✗ | 335 / 326 | 0 / 0 ✗ | 0 / 0 ✗ |
| wc_0058 | near | wrong 0 | wrong 0 | wrong 0 | wrong 0 | wrong 0 | wrong 0 | wrong 0 |
| wc_0059 | winter,near | 174 / 0 | 243 / 0 | 747 / 27 | 730 / 0 | 2173 / 219 | 135 / 0 | 450 / 0 |
| wc_0063 | near | 279 / 0 | 275 / 0 | 642 / 0 | 535 / 0 | 977 / 77 | 30 / 0 | 194 / 0 |
| wc_0067 | winter,near | 570 / 7 | 574 / 10 | 1152 / 8 | 899 / 0 | 2303 / 159 | 183 / 0 | 350 / 0 |
| wc_0069 | haze | wrong 161 | wrong 120 | wrong 306 | wrong 161 | wrong 664 | wrong 7 | wrong 58 |
| wc_0070 | near | wrong 93 | wrong 0 | wrong 0 | wrong 0 | wrong 0 | wrong 67 | wrong 0 |
| wc_0071 | winter,near | 193 / 14 | 219 / 0 | 255 / 0 | 0 / 227 ✗ | 0 / 706 ✗ | 16 / 9 ✗ | 0 / 72 ✗ |
| wc_0072 | haze | 43 / 0 | 71 / 0 | 166 / 0 | 33 / 0 | 349 / 184 | 0 / 0 ✗ | 7 / 9 ✗ |
| wc_0073 | haze,winter | wrong 0 | wrong 0 | wrong 0 | wrong 0 | wrong 0 | wrong 0 | wrong 0 |
| wc_0074 | haze | wrong 616 | wrong 624 | wrong 743 | wrong 208 | wrong 1902 | wrong 13 | wrong 43 |
| wc_0076 | near | 376 / 5 | 352 / 0 | 632 / 0 | 12 / 7 ✗ | 1061 / 450 | 20 / 0 ✗ | 27 / 6 ✗ |
| wc_0077 | haze,near | 1567 / 0 | 1601 / 0 | 1817 / 0 | 901 / 0 | 3451 / 152 | 180 / 0 | 780 / 6 |
| wc_0082 |  | 791 / 7 | 824 / 8 | 966 / 0 | 519 / 0 | 2062 / 228 | 151 / 6 | 328 / 0 |
| wc_0085 | haze,winter | 310 / 0 | 445 / 0 | 816 / 0 | 516 / 0 | 1599 / 375 | 86 / 17 | 276 / 4 |
| wc_0086 | haze,near | wrong 0 | wrong 0 | wrong 0 | wrong 0 | wrong 0 | wrong 0 | wrong 0 |
| wc_0087 | haze,winter | wrong 0 | wrong 0 | wrong 0 | wrong 0 | wrong 0 | wrong 0 | wrong 0 |
| wc_0088 | haze | 1328 / 0 | 1335 / 0 | 1328 / 0 | 596 / 0 | 3635 / 172 | 338 / 8 | 1113 / 7 |
| wc_0094 |  | 496 / 0 | 420 / 0 | 590 / 0 | 369 / 0 | 1810 / 149 | 220 / 0 | 406 / 8 |
| wc_0095 |  | wrong 0 | wrong 0 | wrong 0 | wrong 0 | wrong 0 | wrong 0 | wrong 0 |
| wc_0098 | winter,near | wrong 0 | wrong 0 | wrong 0 | wrong 0 | wrong 0 | wrong 0 | wrong 0 |
| wc_0099 | winter | 333 / 5 | 329 / 0 | 687 / 0 | 190 / 0 | 903 / 163 | 86 / 7 | 74 / 6 |
