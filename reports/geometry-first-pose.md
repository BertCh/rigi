# Geometry-first camera: using the 3D geodata to pin the whole camera

> **2026-09-30:** the GA2 (`geocam/observe`), GA3 (`geocam/tjunc`) and GA4 (`geocam/lakes/factors.ts`) code and the `geoInliers` flag were removed; GA1 (`map`), GA5 (`integrity`), `priors` and `lakes` remain. See [negative-results.md](negative-results.md#code-removed-in-the-2026-09-30-cleanup).

*2026-09-29. This report rests on four research sweeps run in parallel:*
- *geometric cues beyond the skyline;*
- *camera-pose libraries and estimators;*
- *2024–26 localisation against 3D maps (UAV, planetary TRN, render-only training);*
- *a read-only audit of which geometry the repo already holds but discards.*

*The sweeps skipped everything that [fundamentals-plan.md](fundamentals-plan.md), [terrain-matching-research.md](terrain-matching-research.md) and `research_notes/tm_literature_2026-09.md` already cover. Nothing here spends test data or edits shared code. It extends FUND (E0–E8); it does not replace it. Numbers quoted from papers belong to their own domains unless marked as ours.*

## 1. The short answer

**Our advantage is exact 3D geometry: DEM, DSM, buildings, lakes, trails and the sun. The pipeline uses one thin slice of it, the far skyline, which cannot see the eye.**

The physics:
- An eye error δ moves a feature at distance d by about δ/d.
- A 10 m eye error shifts a 10 km ridge by about 3 px and a 1 km feature by about 29 px (60° FOV, 3000 px).
- In the far field, eye translation, rotation and focal are nearly collinear. This is the UAV literature's "multicollinearity", and it is why P4Pf gave worse pitch plus spurious centre shifts.
- **What separates them is the *difference* between depth layers.** Rotation cancels exactly and focal nearly cancels when the two features are adjacent in the image.

FUND E0's Cramér–Rao computation agrees. The geometry holds eye information at the 0.3–0.5 m level, and ≥99.9% of it lies below 250 m, which is exactly what we discard. So the limit is fidelity and outliers, not information.

The code audit shows the assets are mostly already here and thrown away:
- **Lake polygons:** downloaded and reduced to names (`src/lib/upload/region.ts:348`).
- **Ridge crests:** computed and only drawn (`src/lib/geo/horizon.ts:76`).
- **Horizon depth per azimuth:** dropped before `scorePose` (`src/lib/integration/horizon-fast-app.worker.ts:140`).
- **Matcher points:** everything under 250 m and every depth-edge pixel is removed (`tools/matcher/match.py:34,109`).
- **Inliers:** never returned to the app (`src/lib/integration/matcher-client.ts`).
- **nDSM and swisstopo 3D Tiles:** display-only.
- **Snapped OSM peaks:** only used for manual pins.
- **Sun:** the ephemeris exists but is not a pose cue.
- **Magnetic heading:** flagged but never corrected (`src/lib/upload/exif.ts:397`).

**No off-the-shelf "camera positioner" solves this.** The mature geoscience tools (ImGRAFT, glimpse, Smapshot, Portenier 2020) all run weighted least squares (LM) with the position fixed or strongly regularised by priors, and none has an accept test. The right structure has three layers:
1. **Minimal solvers** (PoseLib, already a dependency) generate candidates.
2. **One MAP solver** with GPS, gravity, compass and focal priors and a Laplace covariance scores them. Use GTSAM as the reference and port the dense 10×10 LM to TS.
3. **An a-contrario accept test** (E1) decides.

The first two report *which DoF the photo actually determined*. The third decides whether the pose is real at all.

## 2. What is new here (not in earlier sweeps)

Ranked by expected value for pose accuracy and robustness:

| # | Idea | What it pins | Evidence | Our assets | Effort |
|---|---|---|---|---|---|
| **G1** | **Occlusion crossings / depth-layer parallax.** Where a near ridge (d₁) cuts a far one (d₂), their image offset shifts by δ(1/d₁ − 1/d₂). Rotation cancels and focal nearly does, so each DEM-predicted T-junction is a direct 2-D measurement of the eye. Ridge-order flips add discrete constraints | Eye XY and Z, from the 300 m–3 km mid-field | **No published method found.** Nearest: Talluri & Aggarwal CVPR'91 visibility regions; HorizonNet 2.5 m from 360° island horizons (arXiv 2608.30471); Tzeng CVPRW'13 ~100 m. First-principles, so novel and falsifiable | Render range buffer, `engine.ts` silhouettes, concord contours (<300 m cut at `concord/cues/contours.ts:53`) | 1–2 wk |
| **G2** | **Per-photo observability (Fisher/CRLB) as a gate.** Jacobian of every cue's predicted pixels with respect to yaw, pitch, roll, f, E, N, U, taken by finite differences through the renderer. Invert JᵀJ to get σ per DoF | Decides *whether* the eye may move at all | Standard theory; no mountain paper (a gap). E0 already computed eye CRLB | geoRT xyz, `refine` σ model | 3–5 d |
| **G3** | **MAP solver with priors + Laplace covariance** replacing 5 solvers. Factors:<br>• GPS (hAcc)<br>• gravity (1–2°)<br>• compass as yaw + bias with a Student-t tail and declination applied<br>• EXIF-table focal<br>• skyline, 2D–3D reprojection and cue factors under Cauchy loss<br>Match-induced over-confidence is handled by grid-thinning plus MAD rescale or a block bootstrap | All DoF, with honest σ. "Eye unobserved" comes out of the maths instead of `minParallaxPx`-style heuristics | GTSAM (BSD) has every factor type; pycolmap 4.2 `estimate_and_refine_absolute_pose` now takes a position prior and returns a 6×6 covariance; ImGRAFT and glimpse use the same design | `pose6dof` LM (no production caller), `refine`, `concord/solve/joint.ts` | 1–2 wk |
| **G4** | **Lakes as known horizontal planes.** Waterline depression θ ≈ (h_eye − h_lake)/d gives σ_h ≈ d·σ_θ, about 1.4 m at 2 km and 2 px (our arithmetic). The projected shoreline shape adds XY. Calm reflections check pitch and roll | Eye Z (strong), XY and pitch (moderate); 200 m–5 km | Classical dip geometry; no mountain paper. Concord cues exist, with bias −1.3 to −4 px; the mirror-axis variant was worse | `concord/cues/water.ts` (offline only); polygons already fetched by `region.ts`; swisstopo lake gauges | ~1 wk |
| **G5** | **Vector geodata by directional chamfer.** swissTLM3D/OSM trails, roads, rivers, cableways and buildings are projected in 3D and scored against a distance transform of edges or per-class segmentation. Weight each class by stability: glaciers and forest edges move | Eye plus rotation at 50 m–2 km, exactly the near field the matcher drops | Arth 2015; line-distance-function localisation LDL/FGPL (Apache code); AeroMap3D uses OSM to filter matches (+7.5 pts); SemCityLoc (ECCV'26) 9.9→2.6 m against city models | Trails in `region.ts:92`, swissTLM3D OGD, buildings in `tiles3d` | ~2 wk |
| **G6** | **Integrity: solution separation / protection level** (GNSS RAIM, applied in TRN). Re-solve with each cue subset left out: sectors, distance bands, skyline vs matches. The spread bounds the error. Accept only if the protection level is under the alert limit | Catches wrong basins and wrong eyes that fit *some* evidence | Aviation/TRN standard; Mars 2020 LVS; RAIM for map-matching | Any solver; complements E1's NFA (a tight covariance can still be a wrong eye) | 3–5 d |
| **G7** | **Physical and visibility priors, as verification only.** The eye sits on the DSM + ~1.6 m (unless flagged as a drone or cable car). A viewshed check: every matched far feature must be visible from the eye, and no DEM foreground may cover it. Trail, summit and hut likelihood is used as a tie-break | Vetoes impossible eyes; turns the eye search into 2-D | Talluri '91; OrienterNet-style map priors. "Priors off" in matching v2, so these must be veto/tie-break, not pull | `horizon-fast/visibility.ts`, nDSM, OSM | 2–4 d |
| **G8** | **Cast-shadow contours at photo time.** Sharp shadow lines at low sun are geometric edges independent of snow and albedo. The clock offset is solved as a nuisance: the sun moves 0.25° per minute, which also catches timezone bugs | Rotation plus eye at 0.5–5 km; sunny photos only | Lunar TRN (ShadowNav, arXiv 2405.01673); building shadow registration | `look/sun.ts`, cast-shadow kernel `gpu/look/relief.wgsl.ts` | ~1 wk |
| **G9** | **Multi-photo joint solve, then fit to the terrain.** A trip's photos give baseline parallax. Recover relative poses and points up to a similarity transform, then fit that 7-DoF transform to swissSURFACE3D with the gravity and GPS priors (ICP), plus a height-above-DSM term | Eye for the whole set, plus interior points (what concord lacked) | DEM-anchored SLAM (arXiv 2603.17229); DEM-constrained bundle adjustment (ISPRS 2017); USGS HSfM | `/roll`, `propagate`, MapAnything-**Apache** (commercial checkpoint) | 2–3 wk; needs N3 trip data |
| **G10** | **A geometry-aware matcher trained only on our renders.** Swiss renders (SWISSIMAGE on swissALTI3D, date-sun, snow line by altitude and slope, haze) with a depth/normal channel on the render side, the Geo-LoFTR idea re-implemented (their weights are NC) | Matching recall; verification margin | PiLoT (arXiv 2603.20778): trained on renders only, 1.27 m / 0.47° on unseen real UAV data. Geo-LoFTR +31.8% under hard light. Caution from PoI (arXiv 2502.04843): render labels need filtering | Renderer, C0 cache | 3–6 wk (= FUND E6(a)/E7, now with a geometry channel) |

**Quick, nearly free fixes found by the audit:**
- apply magnetic declination when `headingMagnetic` is set;
- feed GPS `hAcc` into the priors;
- return matcher inliers to the app;
- lower bound: eye ≥ lake level (this would have caught the 6958 GT-eye-under-lake error);
- turn snapped OSM peaks into automatic point correspondences, gated by DEM visibility.

## 3. Libraries: what to adopt

| Tool | Licence | Use |
|---|---|---|
| **PoseLib** (already a dependency) | BSD-3 | Candidates: `up2p`/`up1p2pl` (gravity-upright) for eye proposals when near points exist, `p35pf`/`p5pfr` for unknown focal. Our own 1-point yaw and 2-bearing rotation solvers stay: they are the right far-field minimal solvers |
| **pycolmap 4.2** | BSD | Fast check: absolute pose with a position prior plus covariance, a drop-in for `solve_pnp_exif` |
| **GTSAM** | BSD | Golden reference MAP solver (GPSFactor, Pose3AttitudeFactor, compass with bias, Cal3 focal, custom skyline factors, `Marginals`) |
| **OpenMVG AC-RANSAC / SupeRANSAC** | MPL-2.0 / MIT | Reference oracles for E1's NFA. Port the ~60-line NFA onto our kernels |
| **PoseGravity** | BSD-3 (immature) | Closed-form pose from points plus lines with known gravity. Lines = DEM ridge segments (feeds G1 and G5) |
| **MapAnything-Apache** | Apache-2.0 | G9 relative geometry; also a one-day test of seeding refine from 3–5 posed RGB+depth renders |
| **glimpse** (Welty) | no licence, so ideas only | Horizon factors with curvature and refraction in a joint glacier-camera solve: the closest prior art |
| **Not usable:** MASt3R/DUSt3R, UniK3D, FoundPose, π3 weights, Geo-LoFTR weights, Reloc3r (likely NC) | NC | — |
| **Not worth it:** OpenGV/Theia (stale), Ceres.js (no covariance), browser LM libraries, WebGPU LM (none exist) | — | The problem is ≤10 parameters, so extend `src/lib/geo/lm.ts` |
| **Low value:** fine-grained ground↔aerial 3-DoF (FG², PIDLoc, BevSplat), per-region scene-coordinate regression (R-SCoRe/GLACE) | — | Flat-ground, city-block scale; wrong regime |

## 4. Guard-rails learned from our own failures

1. **Never let the eye move without independent evidence.** The concord joint solve moved 7130's eye 200 m while the skyline improved, because the gate scored the cues it had fitted. So:
   - the eye moves only if G2 says it is observable (σ_eye < ~15 m);
   - a held-out cue family must confirm the move (E1's split-cue test);
   - the protection level must pass (G6).
2. **Eye priors are vetoes and tie-breaks, not pulls** (matching v2: priors off; the altitude-contour rule was worse on holdout).
3. **Focal from the EXIF table, not freed jointly with the eye.** OrthoLoC (NeurIPS'25) finds focal+pose joint recall of only 21.8%, and our P4Pf failure agrees. Free focal only when G2 shows it is separable.
4. **Dev split only; kill criteria written first.** The same rules as `tools/research/fund/README.txt`.

## 5. Experiment plan (GEO phase)

Phase A needs no new data or licences and runs after E1–E3 free the render lock.

| ID | Test | Kill criterion (fixed now) |
|---|---|---|
| **GA0 Quick fixes** | Declination, hAcc, eye ≥ lake level, inliers returned | Any regression on eval-app or style-baseline |
| **GA1 MAP solver** (G3) | pycolmap-with-prior afternoon test, then GTSAM reference, then TS port. On GT and dev refs: pitch within 0.02° of the current 0.07°; all-far photos report σ_EN ≥ 0.8·σ_GPS; median (err/σ)² in [0.5, 2] | Pitch worse, or covariance over-confident by more than 3× |
| **GA2 Observability gate** (G2) | Per-photo σ per DoF; Spearman(σ_eye, actual eye error on displaced-eye decoys) | ρ < 0.5 |
| **GA3 T-junction eye** (G1) | Render-only first: the residual surface is convex with its minimum within 10 m of truth. Then dev refs with the eye displaced ±25/50/100 m: recovered error ≤ 50% of the displacement on photos with ≥ 3 predicted crossings within 3 km | Median improvement < 20%, or a non-true eye wins on > 15% |
| **GA4 Lakes** (G4) | Wire the downloaded polygons in; eye-Z from waterline plus shore on dev lake photos. Also report the fraction of wild photos with a usable lake | Median eye-Z error > 5 m, or coverage < 5% |
| **GA5 Integrity** (G6 + G7) | Leave-one-cue-family-out protection level plus a viewshed/eye-on-DSM veto, run on H1/E1 decoys | Rejects < 30% of wrong-basin/wrong-eye decoys at ≤ 2 pts true-accept loss |

Phase B follows only if phase A passes:
- **GB1 Vector chamfer** (G5), kill if the median eye gain is < 25% on photos with ≥ 200 px of trail or road within 1 km.
- **GB2 Shadows** (G8).
- **GB3 Trip joint solve** (G9), which needs the N3 trip set and should be sealed first.

Phase C, data (merges into FUND E6/E7):
- **GC1:** the Swiss render corpus plus a geometry-channel matcher (G10).
- **GC2:** webcams as real posed photos across seasons. This is the only real appearance ground truth, and it needs Roundshot / foto-webcam permission (a decision already listed).
- **GC3:** pseudo-labels (inner contours, T-junctions, vectors) projected through a-contrario-accepted poses to train the contour detector G1 needs.

```
E1 (NFA) ─────────────┐
GA0 → GA1 (MAP+σ) → GA2 (gate) → GA3 T-junction, GA4 lakes → GA5 integrity → GB*
                                   └── E3 near-field fidelity feeds GA3/GB1
```

## 6. Where this changes the plan

- **GA1 absorbs** FUND F2's "shared Hessian" goal in its simplest form, and deletes three to four of the five pose solvers.
- **GA2 plus GA5 give E1 a second leg.** NFA answers "is this real?"; covariance plus protection level answers "which DoF, and how well?". Together they are the principled replacement for the ~12 hand gates.
- **GA3 and GA4 are the redesign concordance C3 needs.** They are eye cues that are *not* the fitted skyline, and they are observable exactly where concord drifted.
- **Product:** the per-DoF σ gives an honest UI ("direction locked, position ±40 m"), and G2 tells us when to ask for a second photo.

## 7. Sources (new in this sweep)

- **Geometry and eye:**
  - HorizonNet: https://arxiv.org/abs/2608.30471
  - Talluri & Aggarwal CVPR'91: https://mlanthology.org/cvpr/1991/talluri1991cvpr-positional
  - Tzeng CVPRW'13: https://openaccess.thecvf.com/content_cvpr_workshops_2013/W07/html/Tzeng_User-Driven_Geolocation_of_2013_CVPR_paper.html
  - UAV multicollinearity: https://arxiv.org/abs/2512.16314
  - MoDOT occlusion boundaries: https://arxiv.org/abs/2505.21231
  - RealOOB: https://arxiv.org/abs/2608.30820
  - Arth 2015: https://arxiv.org/abs/1503.02675
  - FGPL: https://arxiv.org/abs/2403.19904 (code https://github.com/82magnolia/panoramic-localization)
  - AeroMap3D: https://arxiv.org/abs/2607.14009
  - SemCityLoc: https://arxiv.org/abs/2606.27444
  - Loc²: https://arxiv.org/abs/2509.09792
  - ShadowNav: https://arxiv.org/abs/2405.01673
  - Average Shading Gradients: https://arxiv.org/abs/1906.10882
  - Censible (JPL ICRA'24): https://www-robotics.jpl.nasa.gov/media/documents/2024_Global_Localization_ICRA.pdf
  - CrossLoc: https://openaccess.thecvf.com/content/CVPR2022/html/Yan_CrossLoc_Scalable_Aerial_Localization_Assisted_by_Multimodal_Synthetic_Data_CVPR_2022_paper.html
- **Estimators:**
  - PoseLib: https://github.com/PoseLib/PoseLib
  - pycolmap: https://pypi.org/project/pycolmap/
  - GTSAM: https://github.com/borglab/gtsam
  - SupeRANSAC: https://github.com/danini/superansac
  - OpenMVG: https://github.com/openMVG/openMVG
  - PoseGravity: https://arxiv.org/abs/2405.12646
  - UP1PfAC/UP2PfORI: https://arxiv.org/abs/2608.20056
  - glimpse: https://github.com/ezwelty/glimpse
  - ImGRAFT: https://github.com/grinsted/ImGRAFT
  - Smapshot: https://github.com/MediaComem/smapshot-georeferencer
  - Portenier 2020: https://tc.copernicus.org/articles/14/1409/2020/
- **Map localisation:**
  - PiLoT: https://arxiv.org/abs/2603.20778
  - PiLoT v2: https://arxiv.org/abs/2606.31098
  - OrthoLoC: https://arxiv.org/abs/2509.18350
  - Geo-LoFTR: https://arxiv.org/abs/2502.09795
  - PoI: https://arxiv.org/abs/2502.04843
  - DEM-anchored lunar SLAM: https://arxiv.org/abs/2603.17229
  - DEM-constrained BA: https://isprs-archives.copernicus.org/articles/XLII-2-W6/235/2017/
  - MapAnything: https://github.com/facebookresearch/map-anything
  - FastForward: https://nianticspatial.github.io/fastforward/
  - crater TRN: https://arxiv.org/abs/2606.14776
  - RAIM for map-matching: https://navi.ion.org/content/69/2/navi.518
  - DESPINA: https://isprs-annals.copernicus.org/articles/XI-2-2026/881/2026/
  - R-SCoRe: https://arxiv.org/abs/2501.01421

## 8. Results of GEO phase A (2026-09-30, dev only)

The build is in `src/lib/geocam/**` with 7 synthetic check suites registered in CI (fast tier: all pass). Evaluation scripts are in `scripts/geocam/`. The Python reference is in `tools/research/geo/`. Rules were frozen in `tools/research/geo/PROTOCOL.txt` before scoring, and each study has a `REPORT_GA*.txt` there. With every `geo*` flag off the app is unchanged: eval-app matches the logged runs at 12/14 within 1°. style-baseline is 0/16, but that failure predates this work (trail-overlay pixels, geometry hashes identical).

| Study | Verdict | Key numbers | What survives |
|---|---|---|---|
| **GA0 quick fixes** | **Pass** (no regression) — **no measured gain** | WMM2025 declination matches all 100 NOAA test values (worst 0.005°). But every bundled photo is true-north, so declination changes nothing on dev. The lake floor binds for 0 of 10 dev photos | Flags `geoDecl`, `geoLakeFloor`, `geoLakes`, `geoInliers`, `geoMap` (off). Matcher-inliers patch *proposed* to the matcher maintainers (`out/geocam/ga0/matcher-correspondences.patch`), not applied |
| **Python afternoon test** (pycolmap / PoseLib on existing correspondences) | **Negative** | A free eye from appearance matches drifts 180–270 m at correct poses. Its covariance is 14–86× over-confident. It flags 46/46 decoys *and* 32/32 correct poses (distance AUROC 0.49). Post hoc: P4Pf centre-shift magnitude separates decoys at AUROC 0.87 | pycolmap 4.2.1 does take a position prior (with `gradient_tolerance` 1e-10). GTSAM reference matches the TS solver to 2e-5° / 1 mm / 0.02% σ |
| **GA1 MAP solver + Laplace σ** | **Not killed, not passed** | Pitch: median 0.162° vs 0.260° for the start (pass). All-far σ_EN ≥ 0.8·σ_GPS on 2 of 3 photos. Rotation (err/σ)² = 6.0, eye 3.5 (target [0.5, 2]; kill > 9) | `solveMap` with per-factor losses, correlated-DEM cluster whitening (without it the all-far check fails) and per-family information. Over-confidence comes mostly from wrong-basin starts a local σ can't see. On summits the ground prior moves the eye, not the image |
| **GA2 observability gate** | **Killed** (by a hair) | Spearman ρ(σ_eye, eye error) = 0.498 vs 0.5 (CI 0.34–0.65). 14 of 56 displaced-eye decoys are confidently wrong (σ < 15 m, > 50 m off) | `crlb`, `heldOutFamily`, `eyeMayMove`. σ alone cannot gate the eye |
| **GA3 T-junction eye cue** | **Killed** | Only 6 of 40 refs have ≥ 3 crossings within 3 km. Real photos: median improvement −0.83, a wrong eye wins 93%. Render-only: argmin at the true eye 6/6, but a narrow 10–20 m well (convex on 1 of 6) | The physics holds on renders. On photos, junction edges are lost in clutter (forest, snow bands, rock). The differential residual cancels only normal-direction shifts |
| **GA4 lakes as planes** | **Killed** on eye-Z; coverage passes | Median eye-Z error 16.9 m (CI 6.3–32.7) vs 5 m. Waterline cues carry a constant −4.4 px bias at 2–8 km, which aliases to about 11 m of eye height. 22% of wild dev photos show a usable lake | `waterlineFactors` (bias profiled out), `lakeFloorFactor` |
| **GA5 integrity** (solution separation + viewshed) | **Killed** at the frozen point | Rejects 89% of displaced-eye decoys and 9/10 of the E1 wrong eyes, but also 12/33 correct poses (zero allowed). Wrong-basin AUROC 0.94, wrong-eye 0.83. The viewshed veto catches 2/754 | `protectionLevel`, `bubbleTest`. The strongest separator found for wrong basins. Post hoc (vs the current gate's accepts) it loses 0 correct poses and rejects 74% of the remaining decoys, but that operating point needs its own prereg |

### What phase A taught

1. **Our geometry carries the eye information in principle, but not through current observations.** Ridge crossings recover the true eye on renders (6/6 argmin) and fail on real photos. Waterlines have the right geometry, but a few pixels of detector bias equals metres of height. Appearance matches carry almost none of it (E3, pycolmap). **The bottleneck is measurement fidelity of interior contours**, not the estimator. The same conclusion reached from a different direction as E0's Cramér–Rao result.
2. **Honest uncertainty is achievable where the model is right.** It needs correlated-DEM whitening, per-family information and the GTSAM-verified solver. It is not achievable across basins: every covariance is local. A global check has to come first.
3. **GA5's solution separation is the one new signal with real discrimination** (wrong basin 0.94, wrong eye 0.83, and it catches 9/10 of the eyes that fooled E1's NFA). Its failure is the price in correct poses at a zero-loss rule, driven by poses with few correspondences.

### What next (proposals, not started)

- **G5a:** GA5 protection level as a *component* of the H2 veto prereg (roadmap R2), preregistered at "loss relative to the current gate" with a minimum-correspondence clause. This is the only phase-A output with a plausible product path.
- **G5b:** eye from ridge crossings and waterlines, *only* with a learned contour detector trained on pseudo-labels from accepted poses (GC3). Re-test on the same frozen GA3/GA4 rules; don't re-tune them.
- **G5c:** keep `solveMap` as the shared solver for future cue work. Do not wire it into the app pose (guard-rail 4.1). `geoMap` stays a display-only σ readout candidate.
- **Parked:** declination and the lake floor stay behind their flags. They are correct but gain nothing on the current photo set; revisit with magnetic-heading uploads.
