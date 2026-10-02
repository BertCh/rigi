# Back to fundamentals (FUND): what the rendering and matching stack is missing

*Plan 2026-09-29; phases 0 and 1 ran on dev 2026-09-29 and 2026-10-02. Dev split only; nothing here spends `data_v3`. Rules and per-study protocols: `tools/research/fund/README.txt`, `tools/research/fund/<id>/{PROTOCOL,REPORT}.txt`. Literature context: [tm_literature_2026-09.md](../research_notes/tm_literature_2026-09.md), [terrain-matching-research.md](terrain-matching-research.md). Sister plan for geometric cues: [geometry-first-pose.md](geometry-first-pose.md).*

**Status (2026-10-02).** Phase 0 (E0–E3) all killed. Phase 1: **E5 ray-cast oracle passed** (module `src/lib/raycast`, not wired, no flag), **E4 step 1 killed**, and the E0 rotation half re-run without clipping (E0r) killed. Phase 2 (E6–E8) is not started and waits on data decisions (§4). Every kill has a row in [negative-results.md](negative-results.md).

## 1. The diagnosis (2026-09-29)

The foundations are right: geometry comes from the DEM and the pose, the skyline gives a global search over yaw, learned models sit on top. What was missing is a **common core**. The 2026-09-29 audit counted 8 DEM horizon marchers, 5–6 terrain renderers, 5 pose solvers over the same skyline+points problem, ~12 hand-set accept gates (none a likelihood; the basin gap was tuned on labels that later flipped, roadmap N4), ~7 camera models (only concord has k1) and the refraction k = 0.13 copied ~15×. (Since then three.js was removed, 583e2b7, and the matcher moved into the browser, 8bb109d0, so some counts are lower.)

Three fundamentals would absorb most of it:
- **F1. One probabilistic accept test** instead of a gate stack: accept a pose when it explains evidence it was not fitted to, against the best alternative, with a null from generated decoy poses (3-strip agreement, far-solve → near residual, the global basin gap and Slice-Loc's NFA are special cases). Tested as E1: killed.
- **F2. One dense objective** (feature-metric alignment of photo vs render, PixLoc/PiLoT lineage) shared by refinement, concordance and verification; the skyline search stays the global front end. Tested as E4 step 1: killed (flat DINOv2 token cost).
- **F3. One geometric oracle:** a per-pixel max-mip heightfield ray cast with curvature and refraction per ray, returning horizon, xyz, depth, visibility. Tested as E5: **passed**; adoption is open.
- **The physics:** the eye is observable only through parallax, which lives in the near and mid field. Angular shift ≈ Δeye × (1/d_near − 1/d_far): a 10 m eye error moves a 300 m feature 1.9°, a 1 km feature 0.57°, a 20 km feature 0.03°. The matcher discards everything under 250 m. E0 confirmed that ≥ 99.9% of Σ(1/d)² sits below 250 m; E3 showed the matcher, not the render, fails to see the near field.

Beneath it sits **data**: every threshold is calibrated on ≤ 7 hard negatives, and no commercially licensed pose-labelled mountain dataset exists (GeoPose3K, LandscapeAR are non-commercial). §3 phase 2 lists three clean ways to make data.

## 2. What is not the answer

- Replacing the skyline search: 1-D yaw search with closed-form pitch/roll is right; X4 showed the near-ties are in the score, not the search.
- 3D foundation models, mono-depth geometry, generative translation, NeRF/3DGS localisation (all in negative-results).
- "Just a better matcher": LoMa strengthens wrong basins too (wc_0069).
- A differentiable rasteriser: render xyz once, reproject analytically.

## 3. Experiments (kill criteria fixed 2026-09-29, before any result)

| ID | Hypothesis | Kill criterion | Verdict (dev) |
|---|---|---|---|
| **E0 Observability map** | Solvability is predictable from geometry: FOV/w\* (skyline unique width) for rotation, eye information Σ(1/d)² for position | AUROC < 0.65 for both | **Killed**: AUROC 0.60 / 0.50. Σ(1/d)² measures the foreground (≥ 99.9% below 250 m) |
| **E0r** (2026-10-02) | E0's rotation half with an unclipped horizon-fast 360° skyline (E0's ring cache clipped 14/50 photos) | AUROC < 0.65 | **Killed**: 0.488 (n 16 vs 19, CI 0.29–0.69); no floor 0.05–0.5° reaches 0.65. Survives: the node 360° skyline script `scripts/research/e0r-skyline.ts` |
| **E1 A-contrario accept (F1)** | One held-out-cue likelihood test with a per-photo decoy null (masked basins, same-eye rotations > 3°, ref eyes displaced 50/150/400 m) matches the gate stack at 0 gross | Recall at 0 gross below the current rule, or any wrong-eye decoy accepted | **Killed**: 13 gross accepts, 10/56 displaced-eye decoys accepted; null degenerate (90% of hypotheses score 0) |
| **E2 Date-matched appearance** | Photo-time sun, snow (GFSC) and Sentinel-2 renders close the appearance gap | Median inlier gain < 15% and no separation gain | **Killed**: −0.8% to +0.3%; the flat snow tint erased rock texture. A slope-aware tint is untested |
| **E3 Near-field fidelity** | swissALTI3D z17 + DSM + SWISSIMAGE within 2 km and a mid-band free-eye solve make the eye observable | No gain in inliers < 2 km, or eye not better than GPS on ≥ 60% of refs | **Killed**: no inlier gain; eye better than GPS on 3/30 |
| **E4 Dense feature-metric refinement (F2)**, step 1 | LM over (yaw, pitch, roll, f) on frozen DINOv2 tokens, photo vs render, beats sparse match + rotation solve and gives a usable σ | Not better than the current median, or Spearman(σ, error) < 0.4, or the eye step drifts like 7130 | **Killed** (2026-10-02): median rotation error 0.50° → 1.70°, better on 1/12; Spearman 0.394, σ ~200× too small; refined cost below the GT cost in 92% of runs. Eye step not run. Survives: an offline far-field ray-march renderer validated to the GT skyline (0.3 px) |
| **E5 Ray-cast oracle (F3)** | One WGSL max-mip heightfield ray caster is exact and fast enough to serve horizon, xyz, visibility and matcher geometry | > 0.5 px unexplained disagreement, or > 50 ms per 1024×768 frame at 150 km | **Passed** (2026-10-02, n = 54 eyes): vs horizon-fast p95 0.19 px (p99 0.67; narrow-FOV excess explained post hoc by shared undersampling, 10× denser runs agree to 0.023 px); 18.7 ms median per frame on Dawn under load; GPU f32 vs CPU f64 horizon p95 5e-6°. Not run: the engine raster horizon (browser). Module `src/lib/raycast` (CPU f64 reference + WGSL on `gpu/core`), harness `scripts/research/e5-raycast.ts` |

Phase 2 (learn instead of tune; not started, gated on data):

| ID | Method | Kill criterion |
|---|---|---|
| **E6 Data engine** | (a) render↔render appearance pairs at identical poses (ortho / GFSC snow / Sentinel-2 / haze / sun), unlimited and licence-clean; (b) webcams: fixed pose, thousands of frames, needs written permission (Roundshot, foto-webcam.eu); (c) CC crowd photos auto-posed, only disagreements blind-verified. Keep frozen dev/test regions out of every pool | (a) always possible; (b), (c) are owner decisions |
| **E7 Domain adapter** | A small adapter in front of the frozen matcher (AeroMap3D recipe) trained on E6 | < 10% relative gain in dev inliers or accepted recall |
| **E8 Learned likelihood** | Replace E1's statistic with a pair scorer trained on E6 negatives; E1's decoy null as calibration | No gain over E1 at 0 gross |

## 4. What follows

- **Verification stays on the H1 → H2 path** (roadmap R1/R2): E1 did not absorb it, and the displaced-eye decoys are the test any future veto must pass. GEO's GA5 solution separation is the strongest veto candidate ([geometry-first-pose.md](geometry-first-pose.md)).
- **E5 adoption** is open: whether matcher geometry, visibility tests and `near-dem.ts` move onto `src/lib/raycast` (the matcher already runs in the browser, so the "off headless Chromium" question is gone). Follow-ups: ortho colour / land-cover id outputs, a quiet-machine timing batch, engine raster parity in a browser batch.
- **E4 re-test** only under a new protocol (f fixed, a different dense map, a skyline channel).
- **Decisions for the owner:** webcam outreach (Roundshot, foto-webcam.eu) for E6(b); MatchAnything's terms allow commercial use once registered, so it is a possible E7 baseline.

## 5. Sources (new in this sweep)

- **Dense / render-and-compare:** PixLoc (Apache) https://github.com/cvg/pixloc · MCLoc https://arxiv.org/abs/2404.10438 · PiLoT https://arxiv.org/abs/2603.20778 · FoundPose https://arxiv.org/abs/2311.18809 · AlignPose https://arxiv.org/html/2512.20538v1 · MegaPose (Apache)
- **Principled accept:** Slice-Loc NFA (Apache) https://arxiv.org/html/2508.05369 · AC-RANSAC https://www.ipol.im/pub/art/2016/147/article.pdf · MAGSAC++ (BSD) · visual measurement integrity https://arxiv.org/abs/1909.08537 · protection levels for vision-based pose https://arxiv.org/abs/2608.10023
- **Illumination-matched maps:** Geo-LoFTR https://arxiv.org/html/2502.09795 · LuNaMaps https://ntrs.nasa.gov/citations/20210024816 · Mars 2020 LVS https://ntrs.nasa.gov/citations/20230006986
- **Heightfield ray casting:** Tevs et al. I3D'08 http://www.tevs.eu/project_i3d08.html · Dick et al. EG'09 https://www.cs.cit.tum.de/fileadmin/w00cfj/cg/Research/Publications/2009/GPU_Ray-Casting/EG09AreasTerrain.pdf · HORAYZON https://gmd.copernicus.org/articles/15/6817/2022/
- **Sim-to-real matchers:** MINIMA (Apache) https://github.com/LSXI7/MINIMA · MatchAnything https://github.com/zju3dv/MatchAnything · AeroMap3D https://arxiv.org/abs/2607.14009 · MARTIAN https://arxiv.org/html/2605.29647 · AerialMegaDepth https://arxiv.org/abs/2504.13157
- **Data:** GeoPose3K (research only) https://cphoto.fit.vutbr.cz/geoPose3K/ · LandscapeAR (non-commercial) https://github.com/brejchajan/LandscapeAR · CrossLocate https://cphoto.fit.vutbr.cz/crosslocate/ · Portenier et al. 2020 https://tc.copernicus.org/articles/14/1409/2020/ · Roundshot conditions https://www.roundshot.com/public/upload/assets/2713/Livecam-service-conditions.pdf · foto-webcam.eu https://www.foto-webcam.eu/webcam/infos/ · Copernicus FSC/GFSC https://land.copernicus.eu/api/en/products/snow/fractional-snow-cover · Sentinel-2 via Earth Search https://element84.com/earth-search/ · Mapillary commercial terms https://www.mapillary.com/commercialterms
