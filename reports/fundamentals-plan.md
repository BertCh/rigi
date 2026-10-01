# Back to fundamentals: what the rendering and matching stack is missing, and an experiment plan

*2026-09-29. Dev split only; nothing here spends `data_v3`. Inputs:*
- *a code audit of rendering and matching;*
- *two new literature and data sweeps. These deliberately skipped everything [tm_literature_2026-09.md](../research_notes/tm_literature_2026-09.md) already covers;*
- *the existing records: [status.md](status.md), [terrain-matching-research.md](terrain-matching-research.md), [tm-strategy.md](tm-strategy.md), [concordance-research.md](concordance-research.md) and [negative-results.md](negative-results.md).*

## 1. The short answer

The foundations are right. Geometry comes from the DEM and the pose. The skyline gives a global search over one hard dimension (yaw). Learned models sit on top and never underneath. The cheap single techniques have also been tried and logged.

What is missing is a **common core** that the techniques should share. The system grew by adding one estimator and one gate per failure. The audit counts:

| Mechanism | Separate implementations | Consequence |
|---|---|---|
| DEM horizon / skyline marchers | **8** (4 TS, 1 WGSL, 1 three.js raster, 1 Python, + ad-hoc) | The matcher's 360° horizon comes from the three.js 8-view raster. The app trusts horizon-fast/GPU instead. Last-bit differences move autoAlign |
| Terrain renderers | 5–6 (three, deck per-tile, deck batched, roll, tiles3d ×2) | three uses z14, deck z17. The near field disagrees, which forced `near-dem.ts` |
| Pose solvers over the same skyline+points problem | **5**, plus fusion and skyglobal twins | Each has its own robust loss and priors |
| Accept / confidence gates | **~12** hand-set thresholds (0.5, 0.75, 0.9/0.2, gap 0.15 vs 0.20, 30 inliers, T6 constants…) | **None is a likelihood.** The basin gap was tuned on labels that later flipped (N4) |
| Camera models | ~7 (TS + Python) | Only concord has k1. fx = fy everywhere else |
| Curvature/refraction | the same k = 0.13 copied ~15× in 3 different approximations | Consistent today, but fragile |

Three fundamentals would absorb most of this. A physical observation explains why the remaining failures cluster where they do:

- **F1. One probabilistic accept test instead of a gate stack.** Accept a pose when it explains evidence *it was not fitted to*, compared with the best alternative explanation. The null distribution comes from decoy poses we can generate without limit, not from hand-labelled negatives. Every successful ad-hoc signal so far is a special case of this:
  - 3-strip agreement;
  - far-solve → near residual;
  - the global basin gap;
  - Slice-Loc's NFA.

  The concordance failure is its violation: the gate scored on the cues it had fitted.
- **F2. One dense objective instead of sparse points plus a rotation-only solve.** Use feature-metric alignment of the photo against the render (PixLoc / PiLoT / MCLoc lineage). Refinement, concordance and verification then share one residual and one Hessian. The skyline search stays as the global front end, because a dense objective only has a ±10° basin.
- **F3. One geometric oracle.** A per-pixel ray cast of the heightfield (max-mip traversal, curvature and refraction applied per ray). It returns horizon, xyz, depth, visibility, land-cover id and ortho colour from a single kernel. It replaces the 8 marchers and the renderer-parity problem for *measurement* (display renderers stay as they are).
- **The physics:** *eye position is observable only through parallax, and parallax lives in the near and mid field.* Angular shift ≈ Δeye × (1/d_near − 1/d_far): a 10 m eye error moves a 300 m feature 1.9°, a 1 km feature 0.57°, and a 20 km feature 0.03°. The matcher discards everything under 250 m and renders the near field as bare-earth blur at z14. It therefore throws away exactly the pixels that carry the eye. This single fact explains three open problems:
  - the position-failure bucket (9/31 in F1);
  - the concordance drift ("the skyline can't see eye error");
  - the matching bucket (failing photos have 44% of the frame within 300 m, successes 16%).

Beneath all of it sits **data**. Every threshold is calibrated on ≤ 7 hard negatives, so the system can only be hand-tuned. The new sweep found no commercially licensed pose-labelled mountain dataset: GeoPose3K and the LandscapeAR data are non-commercial. It did find three clean ways to *make* data (§4). With enough of it, F1's null and F2's features can be learned instead of hand-set.

## 2. What is *not* the answer

These are either already logged as negative or ruled out by the new sweep:

- **Replacing the skyline search.** 1-D search over yaw, with closed-form pitch and roll, is the right global method. The fix is its scoring function, not the search. X4 showed that exact search doesn't help, because "the near-ties are in the score".
- **3D foundation models, mono-depth geometry, generative translation, NeRF/3DGS localisation.** All are in negative-results with reasons.
- **"Just a better matcher".** LoMa already strengthens wrong basins (wc_0069). A better matcher without F1 adds gross HIGHs.
- **A differentiable rasteriser.** Not needed. Render xyz once, then reproject analytically (PixLoc style). Silhouettes are handled by the skyline term.

## 3. Experiments

Rules:
- dev split only;
- every study writes `tools/research/fund/<id>/REPORT.txt`, plus a row in negative-results if it fails;
- the kill criteria below are fixed now, before any results.

"Replaces" names what a positive result would let us delete. Phase 0 needs no new infrastructure and reuses the C0 render cache and the H1 records.

### Phase 0: cheap tests of the premises (≈ 1 week, parallel)

| ID | Hypothesis | Method | Metric | Kill criterion | Cost |
|---|---|---|---|---|---|
| **E0 Observability map** | Solvability is predictable from geometry alone: skyline uniqueness vs FOV for rotation, and parallax Fisher information for the eye | Per dev photo at the ref pose, from the cached xyz: (a) the unique-width w\* of the 360° skyline (smallest window whose best wrong-azimuth match exceeds the residual floor), and FOV/w\*; (b) eye information I_eye = Σ_pixels (1/d)² over non-sky pixels, split by depth band; (c) the same with the < 250 m band removed | AUROC for predicting F1's failure buckets: rotation failures from FOV/w\*, position failures from I_eye | AUROC < 0.65 for both | 1–2 days |
| **E1 A-contrario accept (F1)** | One held-out-cue likelihood-ratio test matches the T6/v034 gate stack at 0 gross, with no hand-set thresholds | For each candidate pose: fit on cue set A, score on the disjoint set B, and swap (skyline+far vs mid/near patches; left vs right strips). Build a per-photo null from decoys: the masked-basin alternatives (S5), same-eye rotations > 3° (construction negatives), and **eyes of verified refs displaced by 50/150/400 m and re-solved** (the dangerous kind, with truth known). NFA = N_tests × P_null(score ≥ observed); accept when log NFA < 0 | Accepted-at-zero-gross on dev, per negative kind (basin vs eye), against the current rule on the same candidates | Recall at 0 gross below the current rule, or any wrong-eye decoy accepted | 2–3 days |
| **E2 Date-matched appearance** | Most of the appearance gap is physics we can predict: snow on the day, sun direction, haze | At the ref pose, render 4 variants: (i) current; (ii) × hillshade lit by the photo-time sun (`look/sun.ts` already computes it; matcher renders use a fixed sun and a default date); (iii) + Copernicus GFSC snow mask (60 m daily, gap-filled, free for commercial use) tinting the ortho; (iv) + nearest clear Sentinel-2 L2A (CORS-open via Earth Search). Not the same as X3, whose snow and haze were generic, unfitted post-processing | LoMa and ALIKED inliers at the true pose, and true-vs-decoy separation (E1 score) | Median inlier gain < 15% **and** no separation gain | 2 days |
| **E3 Near-field fidelity** | Rendering the near and mid field properly makes the eye observable and recovers the matching bucket | Within 2 km: swissALTI3D at z17 plus the swissSURFACE3D DSM (the C4 COG reader exists), SWISSIMAGE at 25 cm, and drop the 250 m match cut. Measure mid/near inliers, then run a free-centre solve on **mid-band** correspondences with the far-fixed rotation | (a) inliers < 2 km; (b) eye error vs ref eye compared with GPS error, on the 30 refs; (c) F1 matching-bucket photos that gain support | No gain in (a), **or** (b) not better than GPS on ≥ 60% of refs | 3 days |

E0 decides where the effort goes. If position failures are predicted by low I_eye, E3 is the lever. If rotation failures are predicted by FOV/w\*, the lever is more field of view: multi-photo, or the pano solve from roadmap R5/tm-strategy B§3. E0 also becomes a product signal, "ask for a second photo".

### Phase 1: the core techniques (≈ 2–3 weeks, gated on phase 0)

| ID | Hypothesis | Method | Metric | Kill criterion | Replaces if positive |
|---|---|---|---|---|---|
| **E4 Dense feature-metric refinement (F2)** | One dense LM on frozen DINOv2-S features (Apache) beats sparse match + rotation solve, and supplies a usable covariance | Start from the skyline/T6 pose. Coarse-to-fine LM over (yaw, pitch, roll, f) on the residual between the photo features and the render features reprojected through the render xyz, with learned-free confidence weights (feature-norm ratio), plus 3×3 perturbed restarts. Step 2: free the eye with GPS/DEM priors, **using E3 renders only**. The gate is E1, never the fitted residual | Median rotation error vs refs; Spearman(σ_pred, true error); concord holdout pins once clicked | Not better than the current median, or Spearman < 0.4, or the eye step reproduces 7130's 200 m drift | 3 of the 5 solvers (refine, pose6dof, concord joint). Also the concord warp, because the residual field then comes from one model |
| **E5 Ray-cast oracle (F3)** | One WGSL max-mip heightfield ray caster (curvature + refraction per ray) is exact and fast enough to serve horizon, xyz, visibility and matcher renders | Build it on the existing mosaic tiles in `src/lib/gpu`. Parity-test it against horizon-fast, the GPU horizon, the engine raster horizon and `dem.py` on all benchmark eyes. Then emit xyz / land-cover id / ortho-sampled colour for the matcher at 1024 px | Skyline disagreement per implementation; ms per 1024×768 frame at 150 km on the M3 | > 0.5 px unexplained disagreement, or > 50 ms per frame | The 8 marchers, the 4 visibility tests and `near-dem.ts`. The matcher no longer needs headless Chromium for geometry. Display renderers are unaffected |

E4 and E5 are independent. E4 can run on the C0 cache immediately. E5 is a code-simplification track, and its parity test is useful even if it is never adopted, because it will show which of the 8 marchers is wrong.

### Phase 2: learn instead of tune (gated on data, ≈ 1–2 months)

| ID | Method | Kill criterion |
|---|---|---|
| **E6 Data engine** | (a) **Render↔render appearance pairs** at identical poses (summer ortho / GFSC snow / Sentinel-2 / haze / sun). This is unlimited and licence-clean, the MARTIAN and AerialMegaDepth recipe. (b) **Webcams:** fixed pose, thousands of frames across seasons, weather and light, which is exactly our failure mix. Solve each camera once; perturbed and neighbouring-camera poses then give hard negatives with known truth. Needs written permission (Roundshot §5.7 research clause, foto-webcam.eu). (c) **CC crowd photos** (Commons, Flickr CC-BY/BY-SA, Mapillary for the near field), auto-posed, with only disagreements blind-verified (the tm-strategy §6 flywheel). Keep the frozen dev/test regions out of every training pool | (a) is always possible. (b) and (c) are your decisions |
| **E7 Domain adapter** | A small adapter in front of the frozen matcher (the AeroMap3D recipe: 62→99% registration from ~34k synthetic pairs), or feature fine-tuning for E4. Train on E6(a) first, then (b) and (c) | < 10% relative gain in dev inliers or accepted recall |
| **E8 Learned likelihood** | Replace E1's hand-chosen test statistic with a pair scorer trained on E6 negatives (the Doppelgangers idea, clean backbone). E1's decoy null stays as the calibration | No gain over E1 at 0 gross |

## 4. Sequencing, decisions, and what this changes in the roadmap

```
E0 ──┬─> decides the E3-vs-FOV emphasis
E1 ──┼─> becomes the gate for E3/E4/E7 and supersedes the H2 veto panel design (R2)
E2 ──┤
E3 ──┴─> E4 step 2 (eye)          E5 (independent, simplification)
                   └─> E6 → E7 → E8
```

- **E1 overlaps R1/R2 and should absorb them.** H1's blind-verified pack becomes the *validation* set for an a-contrario test, not the calibration set of a hand-tuned veto panel. Construction and displaced-eye decoys supply the calibration, so the "≥ 30 hard negatives" blocker mostly disappears. Blind verification is still needed to measure label noise and the natural-negative miss rate.
- **E3 and C4 share the DSM work.** One near-field layer then serves matching, concordance occluders and the Step Inside split. This is status.md's "near field is the shared bottleneck", now with a mechanism: parallax.
- **E4 is the redesign that concordance C3 was waiting for.** It uses the same objective, with a gate that cannot score its own fit.
- **Decisions for you:**
  1. Approve phase 0 (E0–E3). It is dev-only and uses no new licences: GFSC and Sentinel-2 are free for commercial use with attribution.
  2. Webcam outreach: Roundshot/Seitz and foto-webcam.eu for ML-training permission.
  3. MatchAnything was ruled out earlier as a "registration licence". Its terms actually allow free commercial project use *once registered*, so it is worth reconsidering as an E7 baseline.
  4. If E5 passes, whether the matcher's geometry moves off headless Chromium. That is the app pipeline's call.

## 5. Sources (new in this sweep)

- **Dense / render-and-compare:**
  - PixLoc (Apache): https://github.com/cvg/pixloc
  - MCLoc: https://arxiv.org/abs/2404.10438
  - PiLoT: https://arxiv.org/abs/2603.20778
  - FoundPose: https://arxiv.org/abs/2311.18809
  - AlignPose: https://arxiv.org/html/2512.20538v1
  - MegaPose (Apache)
- **Principled accept:**
  - Slice-Loc NFA (Apache): https://arxiv.org/html/2508.05369
  - AC-RANSAC: https://www.ipol.im/pub/art/2016/147/article.pdf
  - MAGSAC++ (BSD)
  - Visual measurement integrity: https://arxiv.org/abs/1909.08537
  - Protection levels for vision-based pose estimation: https://arxiv.org/abs/2608.10023
- **Illumination-matched maps:**
  - Geo-LoFTR: https://arxiv.org/html/2502.09795
  - LuNaMaps: https://ntrs.nasa.gov/citations/20210024816
  - Mars 2020 LVS: https://ntrs.nasa.gov/citations/20230006986
- **Heightfield ray casting:**
  - Tevs et al. I3D'08: http://www.tevs.eu/project_i3d08.html
  - Dick et al. EG'09: https://www.cs.cit.tum.de/fileadmin/w00cfj/cg/Research/Publications/2009/GPU_Ray-Casting/EG09AreasTerrain.pdf
  - HORAYZON: https://gmd.copernicus.org/articles/15/6817/2022/
- **Sim-to-real matchers:**
  - MINIMA (Apache): https://github.com/LSXI7/MINIMA
  - MatchAnything: https://github.com/zju3dv/MatchAnything
  - AeroMap3D: https://arxiv.org/abs/2607.14009
  - MARTIAN: https://arxiv.org/html/2605.29647
  - AerialMegaDepth: https://arxiv.org/abs/2504.13157
- **Data:**
  - GeoPose3K (CC-BY-NC-ND preprint; research only): https://cphoto.fit.vutbr.cz/geoPose3K/
  - LandscapeAR (non-commercial): https://github.com/brejchajan/LandscapeAR
  - CrossLocate: https://cphoto.fit.vutbr.cz/crosslocate/
  - Portenier et al. 2020, 297 Swiss webcams: https://tc.copernicus.org/articles/14/1409/2020/
  - Roundshot service conditions: https://www.roundshot.com/public/upload/assets/2713/Livecam-service-conditions.pdf
  - foto-webcam.eu: https://www.foto-webcam.eu/webcam/infos/
  - Copernicus FSC/GFSC: https://land.copernicus.eu/api/en/products/snow/fractional-snow-cover
  - Sentinel-2 via Earth Search: https://element84.com/earth-search/
  - Mapillary commercial terms: https://www.mapillary.com/commercialterms
