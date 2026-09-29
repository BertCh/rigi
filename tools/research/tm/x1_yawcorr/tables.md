
**final_v2Breg — odd DEV photos with a correct ref (design subset)**

| arm | n | top-1 @3° | any-of-k @3° | top-1 @1° | any-of-k @1° | k | top-1 |Δyaw| p25/med/p75 | top-1 |Δyaw| > 30° |
|---|---|---|---|---|---|---|---|---|
| baseline skyline top-4 (SG.search) | 14 | 10 | 12 | 10 | 11 | 4 | 0.02/0.08/18.75 | 2 |
| feature raw (grid peaks) | 14 | 10 | 10 | 4 | 4 | 4 | 0.18/0.76/5.0 | 2 |
| feature + local pitch/roll refine | 14 | 10 | 10 | 5 | 5 | 4 | 0.22/0.61/5.35 | 2 |
| feature peaks + skyline polish | 14 | 10 | 10 | 7 | 7 | 4 | 0.04/0.19/2.9 | 2 |
| column-pooled 1-D feature | 14 | 5 | 6 | 1 | 1 | 4 | 0.72/10.82/131.58 | 6 |
| fused z(feat)+z(sky), skyline polish | 14 | 11 | 12 | 10 | 11 | 4 | 0.02/0.13/0.78 | 1 |
| fused, re-sorted by skyline score | 14 | 10 | 12 | 10 | 11 | 4 | 0.02/0.08/21.99 | 2 |
| baseline re-ranked by feature (tiebreak) | 14 | 10 | 12 | 9 | 11 | 4 | 0.02/0.13/8.09 | 3 |
| baseline top-2 + feature top-2 [post hoc] | 14 | 10 | 13 | 10 | 12 | 4 | 0.02/0.08/18.75 | 2 |
| baseline top-4 + feature top-2 (6 hyps) | 14 | 10 | 13 | 10 | 12 | 6 | 0.02/0.08/18.75 | 2 |
| baseline top-4 + feature top-4 (8 hyps) | 14 | 10 | 13 | 10 | 13 | 8 | 0.02/0.08/18.75 | 2 |

**final_v2Breg — even DEV photos with a correct ref (held-out)**

| arm | n | top-1 @3° | any-of-k @3° | top-1 @1° | any-of-k @1° | k | top-1 |Δyaw| p25/med/p75 | top-1 |Δyaw| > 30° |
|---|---|---|---|---|---|---|---|---|
| baseline skyline top-4 (SG.search) | 16 | 9 | 11 | 7 | 7 | 4 | 0.13/0.59/16.56 | 2 |
| feature raw (grid peaks) | 16 | 11 | 11 | 4 | 4 | 4 | 0.23/0.56/2.68 | 1 |
| feature + local pitch/roll refine | 16 | 11 | 11 | 8 | 8 | 4 | 0.08/0.35/2.99 | 1 |
| feature peaks + skyline polish | 16 | 10 | 10 | 8 | 8 | 4 | 0.06/1.03/3.19 | 1 |
| column-pooled 1-D feature | 16 | 7 | 7 | 3 | 3 | 4 | 0.51/5.14/25.33 | 4 |
| fused z(feat)+z(sky), skyline polish | 16 | 11 | 11 | 8 | 8 | 4 | 0.13/0.5/2.64 | 0 |
| fused, re-sorted by skyline score | 16 | 9 | 11 | 7 | 8 | 4 | 0.13/0.59/23.64 | 3 |
| baseline re-ranked by feature (tiebreak) | 16 | 10 | 11 | 6 | 7 | 4 | 0.29/0.87/5.63 | 2 |
| baseline top-2 + feature top-2 [post hoc] | 16 | 9 | 14 | 7 | 10 | 4 | 0.13/0.59/16.56 | 2 |
| baseline top-4 + feature top-2 (6 hyps) | 16 | 9 | 13 | 7 | 9 | 6 | 0.13/0.59/16.56 | 2 |
| baseline top-4 + feature top-4 (8 hyps) | 16 | 9 | 14 | 7 | 10 | 8 | 0.13/0.59/16.56 | 2 |

**final_v2Breg — all DEV photos with a correct ref (all)**

| arm | n | top-1 @3° | any-of-k @3° | top-1 @1° | any-of-k @1° | k | top-1 |Δyaw| p25/med/p75 | top-1 |Δyaw| > 30° |
|---|---|---|---|---|---|---|---|---|
| baseline skyline top-4 (SG.search) | 30 | 19 | 23 | 17 | 18 | 4 | 0.03/0.28/20.5 | 4 |
| feature raw (grid peaks) | 30 | 21 | 21 | 8 | 8 | 4 | 0.2/0.66/3.19 | 3 |
| feature + local pitch/roll refine | 30 | 21 | 21 | 13 | 13 | 4 | 0.2/0.47/3.88 | 3 |
| feature peaks + skyline polish | 30 | 20 | 20 | 15 | 15 | 4 | 0.05/0.33/3.22 | 3 |
| column-pooled 1-D feature | 30 | 12 | 13 | 4 | 4 | 4 | 0.6/7.24/74.77 | 10 |
| fused z(feat)+z(sky), skyline polish | 30 | 22 | 23 | 18 | 19 | 4 | 0.04/0.28/2.41 | 1 |
| fused, re-sorted by skyline score | 30 | 19 | 23 | 17 | 19 | 4 | 0.03/0.28/25.98 | 5 |
| baseline re-ranked by feature (tiebreak) | 30 | 20 | 23 | 15 | 18 | 4 | 0.05/0.38/8.51 | 5 |
| baseline top-2 + feature top-2 [post hoc] | 30 | 19 | 27 | 17 | 22 | 4 | 0.03/0.28/20.5 | 4 |
| baseline top-4 + feature top-2 (6 hyps) | 30 | 19 | 26 | 17 | 21 | 6 | 0.03/0.28/20.5 | 4 |
| baseline top-4 + feature top-4 (8 hyps) | 30 | 19 | 27 | 17 | 23 | 8 | 0.03/0.28/20.5 | 4 |

**final_v2Breg cfg=sat (all 30)**

| arm | n | top-1 @3° | any-of-k @3° | top-1 @1° | any-of-k @1° | k | top-1 |Δyaw| p25/med/p75 | top-1 |Δyaw| > 30° |
|---|---|---|---|---|---|---|---|---|
| feature raw (grid peaks) | 30 | 20 | 21 | 6 | 6 | 4 | 0.31/0.8/4.47 | 2 |
| feature + local pitch/roll refine | 30 | 20 | 22 | 13 | 13 | 4 | 0.23/0.65/4.77 | 2 |
| fused z(feat)+z(sky), skyline polish | 30 | 23 | 23 | 18 | 18 | 4 | 0.03/0.22/1.53 | 0 |
| baseline top-2 + feature top-2 [post hoc] | 30 | 19 | 27 | 17 | 22 | 4 | 0.03/0.28/20.5 | 4 |

**final_v2Breg cfg=hill (all 30)**

| arm | n | top-1 @3° | any-of-k @3° | top-1 @1° | any-of-k @1° | k | top-1 |Δyaw| p25/med/p75 | top-1 |Δyaw| > 30° |
|---|---|---|---|---|---|---|---|---|
| feature raw (grid peaks) | 30 | 18 | 20 | 5 | 5 | 4 | 0.44/0.95/5.52 | 4 |
| feature + local pitch/roll refine | 30 | 18 | 20 | 11 | 11 | 4 | 0.16/0.92/5.6 | 4 |
| fused z(feat)+z(sky), skyline polish | 30 | 20 | 22 | 16 | 18 | 4 | 0.05/0.35/3.67 | 3 |
| baseline top-2 + feature top-2 [post hoc] | 30 | 19 | 27 | 17 | 22 | 4 | 0.03/0.28/20.5 | 4 |

**final_v2Breg cfg=ring45 (all 30)**

| arm | n | top-1 @3° | any-of-k @3° | top-1 @1° | any-of-k @1° | k | top-1 |Δyaw| p25/med/p75 | top-1 |Δyaw| > 30° |
|---|---|---|---|---|---|---|---|---|
| feature raw (grid peaks) | 30 | 12 | 16 | 2 | 3 | 4 | 0.86/11.17/38.03 | 10 |
| feature + local pitch/roll refine | 30 | 12 | 16 | 6 | 7 | 4 | 0.9/11.17/37.7 | 10 |
| fused z(feat)+z(sky), skyline polish | 30 | 20 | 21 | 17 | 18 | 4 | 0.05/0.35/3.78 | 3 |
| baseline top-2 + feature top-2 [post hoc] | 30 | 19 | 26 | 17 | 19 | 4 | 0.03/0.28/20.5 | 4 |

final_v2Breg correct-vs-wrong(other basin) ref preference: {'feat': '45/46', 'sky': '39/49', 'directSat': '48/49', 'directHill': '47/49', 'directMean': '48/49'}

**final_v2S — odd DEV photos with a correct ref (design subset)**

| arm | n | top-1 @3° | any-of-k @3° | top-1 @1° | any-of-k @1° | k | top-1 |Δyaw| p25/med/p75 | top-1 |Δyaw| > 30° |
|---|---|---|---|---|---|---|---|---|
| baseline skyline top-4 (SG.search) | 14 | 10 | 12 | 10 | 11 | 4 | 0.02/0.08/18.75 | 2 |
| feature raw (grid peaks) | 14 | 10 | 10 | 3 | 3 | 4 | 0.29/1.21/4.5 | 2 |
| feature + local pitch/roll refine | 14 | 9 | 9 | 5 | 5 | 4 | 0.44/0.96/4.78 | 2 |
| feature peaks + skyline polish | 14 | 11 | 11 | 9 | 9 | 4 | 0.06/0.14/1.26 | 2 |
| column-pooled 1-D feature | 14 | 6 | 7 | 2 | 2 | 4 | 0.84/2.54/38.6 | 4 |
| fused z(feat)+z(sky), skyline polish | 14 | 11 | 11 | 10 | 10 | 4 | 0.02/0.13/0.78 | 1 |
| fused, re-sorted by skyline score | 14 | 9 | 11 | 9 | 10 | 4 | 0.02/0.13/28.22 | 3 |
| baseline re-ranked by feature (tiebreak) | 14 | 10 | 12 | 9 | 11 | 4 | 0.02/0.13/83.63 | 4 |
| baseline top-2 + feature top-2 [post hoc] | 14 | 10 | 13 | 10 | 12 | 4 | 0.02/0.08/18.75 | 2 |
| baseline top-4 + feature top-2 (6 hyps) | 14 | 10 | 13 | 10 | 12 | 6 | 0.02/0.08/18.75 | 2 |
| baseline top-4 + feature top-4 (8 hyps) | 14 | 10 | 13 | 10 | 12 | 8 | 0.02/0.08/18.75 | 2 |

**final_v2S — even DEV photos with a correct ref (held-out)**

| arm | n | top-1 @3° | any-of-k @3° | top-1 @1° | any-of-k @1° | k | top-1 |Δyaw| p25/med/p75 | top-1 |Δyaw| > 30° |
|---|---|---|---|---|---|---|---|---|
| baseline skyline top-4 (SG.search) | 16 | 9 | 11 | 7 | 7 | 4 | 0.13/0.59/16.56 | 2 |
| feature raw (grid peaks) | 16 | 10 | 11 | 5 | 5 | 4 | 0.27/0.83/2.95 | 2 |
| feature + local pitch/roll refine | 16 | 10 | 11 | 8 | 8 | 4 | 0.13/0.62/3.26 | 2 |
| feature peaks + skyline polish | 16 | 10 | 11 | 8 | 9 | 4 | 0.18/0.57/4.01 | 2 |
| column-pooled 1-D feature | 16 | 4 | 5 | 2 | 2 | 4 | 0.64/8.92/32.95 | 4 |
| fused z(feat)+z(sky), skyline polish | 16 | 10 | 11 | 7 | 8 | 4 | 0.13/0.59/4.09 | 1 |
| fused, re-sorted by skyline score | 16 | 9 | 11 | 7 | 8 | 4 | 0.13/0.59/29.04 | 4 |
| baseline re-ranked by feature (tiebreak) | 16 | 10 | 11 | 6 | 7 | 4 | 0.29/0.87/5.63 | 2 |
| baseline top-2 + feature top-2 [post hoc] | 16 | 9 | 14 | 7 | 10 | 4 | 0.13/0.59/16.56 | 2 |
| baseline top-4 + feature top-2 (6 hyps) | 16 | 9 | 13 | 7 | 9 | 6 | 0.13/0.59/16.56 | 2 |
| baseline top-4 + feature top-4 (8 hyps) | 16 | 9 | 14 | 7 | 10 | 8 | 0.13/0.59/16.56 | 2 |

**final_v2S — all DEV photos with a correct ref (all)**

| arm | n | top-1 @3° | any-of-k @3° | top-1 @1° | any-of-k @1° | k | top-1 |Δyaw| p25/med/p75 | top-1 |Δyaw| > 30° |
|---|---|---|---|---|---|---|---|---|
| baseline skyline top-4 (SG.search) | 30 | 19 | 23 | 17 | 18 | 4 | 0.03/0.28/20.5 | 4 |
| feature raw (grid peaks) | 30 | 20 | 21 | 8 | 8 | 4 | 0.27/0.98/3.96 | 4 |
| feature + local pitch/roll refine | 30 | 19 | 20 | 13 | 13 | 4 | 0.2/0.76/4.16 | 4 |
| feature peaks + skyline polish | 30 | 21 | 22 | 17 | 18 | 4 | 0.07/0.31/3.71 | 4 |
| column-pooled 1-D feature | 30 | 10 | 12 | 4 | 4 | 4 | 0.62/6.75/41.96 | 8 |
| fused z(feat)+z(sky), skyline polish | 30 | 21 | 22 | 17 | 18 | 4 | 0.04/0.28/2.64 | 2 |
| fused, re-sorted by skyline score | 30 | 18 | 22 | 16 | 18 | 4 | 0.04/0.35/28.63 | 7 |
| baseline re-ranked by feature (tiebreak) | 30 | 20 | 23 | 15 | 18 | 4 | 0.05/0.38/11.61 | 6 |
| baseline top-2 + feature top-2 [post hoc] | 30 | 19 | 27 | 17 | 22 | 4 | 0.03/0.28/20.5 | 4 |
| baseline top-4 + feature top-2 (6 hyps) | 30 | 19 | 26 | 17 | 21 | 6 | 0.03/0.28/20.5 | 4 |
| baseline top-4 + feature top-4 (8 hyps) | 30 | 19 | 27 | 17 | 22 | 8 | 0.03/0.28/20.5 | 4 |

**final_v2S cfg=sat (all 30)**

| arm | n | top-1 @3° | any-of-k @3° | top-1 @1° | any-of-k @1° | k | top-1 |Δyaw| p25/med/p75 | top-1 |Δyaw| > 30° |
|---|---|---|---|---|---|---|---|---|
| feature raw (grid peaks) | 30 | 18 | 20 | 5 | 5 | 4 | 0.27/1.13/8.06 | 4 |
| feature + local pitch/roll refine | 30 | 18 | 21 | 11 | 13 | 4 | 0.25/1.19/8.17 | 4 |
| fused z(feat)+z(sky), skyline polish | 30 | 20 | 22 | 16 | 18 | 4 | 0.04/0.35/3.69 | 3 |
| baseline top-2 + feature top-2 [post hoc] | 30 | 19 | 27 | 17 | 22 | 4 | 0.03/0.28/20.5 | 4 |

**final_v2S cfg=hill (all 30)**

| arm | n | top-1 @3° | any-of-k @3° | top-1 @1° | any-of-k @1° | k | top-1 |Δyaw| p25/med/p75 | top-1 |Δyaw| > 30° |
|---|---|---|---|---|---|---|---|---|
| feature raw (grid peaks) | 30 | 15 | 17 | 6 | 6 | 4 | 0.33/1.4/20.97 | 5 |
| feature + local pitch/roll refine | 30 | 14 | 16 | 11 | 11 | 4 | 0.25/1.3/20.87 | 5 |
| fused z(feat)+z(sky), skyline polish | 30 | 18 | 20 | 15 | 16 | 4 | 0.05/0.5/8.84 | 5 |
| baseline top-2 + feature top-2 [post hoc] | 30 | 19 | 25 | 17 | 20 | 4 | 0.03/0.28/20.5 | 4 |

**final_v2S cfg=ring45 (all 30)**

| arm | n | top-1 @3° | any-of-k @3° | top-1 @1° | any-of-k @1° | k | top-1 |Δyaw| p25/med/p75 | top-1 |Δyaw| > 30° |
|---|---|---|---|---|---|---|---|---|
| feature raw (grid peaks) | 30 | 9 | 14 | 3 | 4 | 4 | 1.59/14.29/29.89 | 8 |
| feature + local pitch/roll refine | 30 | 9 | 14 | 6 | 8 | 4 | 1.84/14.26/30.06 | 8 |
| fused z(feat)+z(sky), skyline polish | 30 | 17 | 20 | 14 | 17 | 4 | 0.03/0.57/14.5 | 4 |
| baseline top-2 + feature top-2 [post hoc] | 30 | 19 | 25 | 17 | 20 | 4 | 0.03/0.28/20.5 | 4 |

final_v2S correct-vs-wrong(other basin) ref preference: {'feat': '42/46', 'sky': '39/49', 'directSat': '47/49', 'directHill': '48/49', 'directMean': '48/49'}

**Design phase (odd ids, 14 photos with a correct ref): backbone sweep, cfg main (sat+hill, terrain-masked, PCA-64)**

| backbone | photos | raw top-1/any4 @3° | +local refine top-1/any4 @3° | @1° top-1 (refined) | fused top-1/any4 @3° | base2+feat2 @3° | colpool top-1 @3° |
|---|---|---|---|---|---|---|---|
| dinov2_vits14 | 14 | 10/10 | 9/9 | 5 | 11/11 | 13 | 6 |
| dinov2_vitb14 | 14 | 9/9 | 9/9 | 3 | 11/12 | 13 | 6 |
| dinov2_vitb14_reg | 14 | 10/10 | 10/10 | 5 | 11/12 | 13 | n/a |
| dinov3_vits16 | 14 | 6/7 | 7/8 | 2 | 10/11 | 12 | 6 |
| dinov3_vitb16 | 14 | 8/8 | 7/7 | 3 | 10/11 | 11 | n/a |
| dinov2_vitl14 | incomplete (2) | | | | | | |
| (baseline skyline) | 14 | 10/12 | | 10 | | | |

**Ablation (odd ids, 14 photos with a correct ref, DINOv2-B/14-reg)**

| cfg | raw top-1/any4 @3° | refined top-1 @1° | fused top-1/any4 @3° | base2+feat2 @3° |
|---|---|---|---|---|
| main | 10/10 | 5 | 11/12 | 13 |
| pca128 | 10/10 | 5 | 12/12 | 13 |
| all | 10/11 | 6 | 11/11 | 14 |
| photoAll | 9/10 | 4 | 11/12 | 13 |
| roll0 | 10/10 | 5 | 11/12 | 13 |
| pca16 | 6/7 | 3 | 10/11 | 12 |
| ring45 | 4/5 | 2 | 10/10 | 12 |
timing_dinov2_vitb14_reg_cpu {'ringFwdMs': 24131.0, 'photoFwdMs': 775.0, 'panoMs': 373.0, 'gridMs': 1237.0, 'totalMs': 29092.0}
timing_dinov2_vitb14_reg_mps {'ringFwdMs': 6402.0, 'photoFwdMs': 251.0, 'panoMs': 394.0, 'gridMs': 1267.0, 'totalMs': 12461.0}
timing_dinov2_vits14_cpu {'ringFwdMs': 11399.0, 'photoFwdMs': 416.0, 'panoMs': 180.0, 'gridMs': 1173.0, 'totalMs': 14454.0}
timing_dinov2_vits14_mps {'ringFwdMs': 3940.0, 'photoFwdMs': 177.0, 'panoMs': 273.0, 'gridMs': 1375.0, 'totalMs': 6959.0}
