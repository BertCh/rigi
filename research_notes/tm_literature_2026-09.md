# TM research program, study R1: literature delta (2026-09-27)

Scope: what the 2024–2026 literature adds beyond what this repo already covers. The existing coverage is in:
- `reports/Mountain photo georeferencing SoTA.md`
- `research_notes/matching_v2_research.md` (removed 2026-09-29; `git show 384df44:<path>`)
- `research_notes/analysis_algorithms_sota_2026.md` (removed 2026-09-29; same)
- `reports/matching-v2.md`
- `tools/matcher/v2/loma/REPORT.md`
- `reports/stage1.md`

Methods already covered there appear only when there is new information, including LandscapeAR, Baboud/Baatz/Brejcha, CrossLocate, LoMa, RoMa v2, MatchAnything, MINIMA, GeoCalib, AnyCalib, MoGe/DA3 licences, DINOv3 licence, MCLoc, Render2Loc, LAYS and Geo-LoFTR.

The research questions come from four known failure facts:
1. 15 of the 30 non-accepted dev photos have **zero** render-match support at any eye within 400 m.
2. The skyline global top-k is brittle to pitch-grid phase.
3. Stronger matchers also strengthen wrong basins (wc_0069, wc_0001, wc_0074).
4. Skyline scoring cannot locate the eye.

**Conventions**
- [V] means the licence was checked on the repo's LICENSE, the GitHub API or the HF card. A GitHub-API spot re-check was done today for Doppelgangers, Doppelgangers++, Slice-Loc, TEED, DexiNed, SAM 2, SAM 3, MapAnything, FG2, CCVPE and Lotus. [U] means unverified.
- Runtimes on the M3 Pro are estimates unless a repo report measured them.
- "No mountain evidence" means I searched and found none. It does not mean the method will fail.

Method: five parallel source-verified web sweeps (axes 1–6), with the results consolidated here.

---

## Executive summary

1. **The mountain-specific literature is still frozen at 2020–2022.** I found no 2024–26 paper reporting new GeoPose3K, CH1/CH2 or CrossLocate numbers, and no new alpine single-photo benchmark. The terms "MountainScape", "AlpineGeo" and "Swiss mountain localization dataset" do not exist as datasets. Every delta below is a transfer from urban, aerial, UAV, planetary or landmark work. **Our dev set is effectively the only benchmark for these ideas**, so every item is an experiment, not an adoption.

2. **The best leverage is on rejection, and it comes from negative evidence, not more inliers.**
   - InLoc/DensePV, DensePNV, Doppelgangers(++) and the Map-free protocol all gain by scoring *structure the render predicts that the photo lacks*, or by judging the pair jointly.
   - Our wrong-basin trap wc_0069 passes every positive-evidence signal we have: under LoMa it had 0.59° cue agreement, 3.2 px residual and 0.93 support.
   - The cheapest, licence-free verifier uses **depth-banded residuals**:
     - solve the pose from far inliers only, then test the residuals of the mid and near inliers;
     - add **predicted-but-unmatched occluding contours** from our depth buffers;
     - train on **mined hard negatives**: skyline top-k minus the correct pose, the ring views and ±4–5° decoys.
   - Evaluate by leave-one-photo-out "accepted-at-zero-gross".

3. **The pitch-grid phase problem has a textbook fix.**
   - Sample only yaw, which is an exact circular shift of the cylinder, and **solve pitch and roll in closed form per yaw** by robust 2×2 least squares on the skyline: v(u) ≈ h(ψ+u) − p − r·u.
   - Optionally, run a **max-pool branch-and-bound** over yaw × pitch. It gives an exact top-k and a *certified* margin between basins, which is also an abstain signal.
   - No 2024–26 paper does this for horizons, but the techniques (RAST, hierarchical chamfer) are classical and dependency-free.

4. **Cross-view ground↔aerial yaw methods do not transfer.**
   - With limited FOV, unknown yaw and a new area, CCVPE's median yaw error is **63.8°**.
   - FG2 (CVPR'25) reaches a 5.45° median but a **31.4° mean** (VIGOR, unknown yaw). That heavy tail looks exactly like our gross errors.
   - Their code is GPL/AGPL. Only one idea is worth borrowing: **Slice-Loc's per-strip pose plus a-contrario NFA agreement** (Apache-2.0 [V]).

5. **3D foundation models (VGGT, MapAnything, π³, the MASt3R family) have no km-scale or DEM evidence.**
   - They regress rotation with no correspondences. The "Emergent Extreme-View" bias-tuning paper brings the median rotation error on non-overlapping pairs down to about 10–14°.
   - Sky2Ground (CVPR'26) reports that adding overhead views *hurts* them.
   - So they are at best a coarse basin vote for the zero-support photos.
   - The only commercially usable weights are **VGGT-1B-Commercial (gated)** and **MapAnything-apache** [V]. Everything in the DUSt3R lineage (Reloc3r, CUT3R, MUSt3R, Fast3R, AerialMegaDepth's MASt3R fine-tunes) is non-commercial.

6. **Monocular depth is bad at km scale, but its ordering may still work.**
   - "Honey, I Shrunk the Arc de Triomphe" (2026) documents far-range scale collapse in MoGe-2, DA3 and Metric3D v2.
   - RealOOB (Aug 2026) finds depth models unreliable *exactly at occlusion boundaries*, and finds that modern edge detectors do as well there.
   - The surviving hypothesis is **occlusion-ordinal agreement**: at rendered depth jumps, the photo's predicted depth must agree on which side is nearer. Combine it with a TEED (MIT [V]) edge chamfer against rendered *interior* occluding contours.
   - This is also the only geometry cue with parallax, so it may help locate the eye, where the skyline cannot.

7. **UAV ortho+DSM localisation (OrthoLoC, NeurIPS'25; AnyVisLoc 2025) contributes one cheap trick: re-warp, then re-match (AdHoP).**
   - It gives up to +95% more matches and −63% translation error, with the largest gains for weak matchers.
   - Our analogue is to **re-render at the provisional pose and re-match**.
   - The inlier *gain* is also a candidate verification feature: correct poses should gain more than wrong basins.
   - OrthoLoC also warns that solving focal and translation jointly collapses recall from 75.4% to 21.8%.

8. **Two cheap, non-ML recall levers for the zero-support photos:**
   - **OSM photographer-location priors.** Sample candidate eyes on paths, peaks, huts, viewpoints and aerialway stations within 1–3 km, filtered by viewshed. Today `viewpoints.py` only uses open spots and high points within 400 m.
   - **SAM 3 text-prompted semantics** ("snow", "cloud", "rock face", "forest", "lake"), compared with rendered swissTLM3D land cover: Brejcha-2018-style semantic IoU with a modern segmenter, plus a cloud mask to remove false skyline segments.
   - The SAM 3 licence permits commercial use with military/ITAR exclusions. GitHub reports it as NOASSERTION because it is a custom licence.

9. **Things to skip:**
   - diffusion or CycleGAN photo↔render translation (no terrain evidence, and it can invent ridges);
   - NeRF/3DGS localisation: GS-CPR, Skyfall-GS (Inria NC) and LSGS-Loc all need multi-view scene training or CUDA;
   - nvdiffrast (NVIDIA NC);
   - UniDepth (CC BY-NC), DSINE (research-only), PiDiNet (research-only);
   - conformal *guarantees*. With about 3 natural wrong-basin photos, conformal methods can only set a threshold; they cannot certify α.

---

## Axis 1: photo↔render matching with 3D foundation models, and domain-gap tricks

**Key finding:** no paper tests VGGT, MASt3R, MapAnything, π³ or Reloc3r on photo↔DEM-render pairs, or on any scene with km-scale depth.

| Method | Venue / year | What it does, with numbers | Code / weights licence | Size / M3 runtime | Cheap experiment |
|---|---|---|---|---|---|
| **Emergent Extreme-View Geometry in 3DFMs** ([arXiv 2511.22686](https://arxiv.org/html/2511.22686), [page](https://cornell-vailab.github.io/Ext-3DFMs/)) | arXiv 2025 (Cornell) | Tunes only about 80k bias parameters. Median rotation error on non-overlapping pairs (sELP): VGGT 92.9° → 14.2°, π³ 45.2° → 12.0°, WorldMirror 69.0° → 9.7°. In the wild, VGGT 31.6° → 12.7° | Paper CC-BY; code "will be released" [U]. The recipe can be applied to commercially usable base weights | – | See the VGGT/MapAnything row |
| **Sky2Ground / SkyNet** ([arXiv 2603.13740](https://arxiv.org/abs/2603.13740)) | CVPR 2026 | **Adding satellite views often degrades MASt3R, DUSt3R, MapAnything and VGGT.** SkyNet, a VGGT extension trained with a curriculum, gains +9.6 points on rotation@5° | Not released [U] | – | A warning about ortho-draped renders |
| **AerialMegaDepth** ([arXiv 2504.13157](https://arxiv.org/html/2504.13157), [repo](https://github.com/kvuong2711/aerial-megadepth)) | CVPR 2025 | Google-Earth mesh renders mixed with MegaDepth, used to fine-tune DUSt3R/MASt3R for aerial↔ground. MASt3R rotation@5° goes from 3.4% to 49.5% | Repo has no LICENSE [V]; HF weights are fine-tuned from Naver NC weights, so effectively NC | ViT-L | Research only |
| **VGGT-1B-Commercial** ([HF](https://huggingface.co/facebook/VGGT-1B-Commercial)) | 2025 | Feed-forward pose, depth and point maps from N views | Gated commercial licence (no military use) | 1B; ~1–4 s MPS for 2–10 views, ~4–5 GB fp32 [U] | **E-A1:** run [photo + render at the true pose] and [photo + the 9 ring views] on the 30 dev refs. Measure relative-rotation error and ring-view argmax. On wc_0069/0001/0074, check whether the wrong-basin render gives a clearly non-zero predicted relative rotation while the correct one gives about 0°. Satellite vs hillshade |
| **MapAnything-apache** ([repo](https://github.com/facebookresearch/map-anything), [HF](https://huggingface.co/facebook/map-anything-apache)) | 2025, apache weights Jan 2026 | Like VGGT, but **accepts known pose, intrinsics and depth for some views as inputs**, so our render's xyz could anchor the solve and only the photo's pose would be regressed | Code Apache-2.0 [V], weights Apache-2.0 [V] | 1B; similar runtime [U] | **E-A2:** same as E-A1, with the render's pose and depth supplied. This is the only model that natively consumes our buffers |
| π³ ([repo](https://github.com/yyfz/Pi3)) | 2025 | – | Code BSD-3; weights "academic use", commercial "contact authors" [V] | – | Skip |
| Reloc3r, CUT3R, MUSt3R, Fast3R, TTT3R | 2025–26 | Relative-pose regressors and streaming reconstruction | CC BY-NC-SA / Naver NC / FAIR NC; TTT3R bundles CUT3R [V] | – | Skip (licence) |
| **OrthoLoC + AdHoP** ([arXiv 2509.18350](https://arxiv.org/html/2509.18350v2), [repo](https://github.com/deepscenario/OrthoLoC)) | NeurIPS 2025 D&B | UAV↔ortho+DSM benchmark. Visual domain shift alone triples translation error; visual plus structural shift is 7×. **AdHoP** (warp the reference by a first homography, then re-match) gives up to +95% matches and −63% translation error. Recall@1 m/1° 75.4% → **21.8%** when focal is also free | CC BY-NC-SA 4.0 (the idea is free) | ~2.6 s/sample on GPU | **E-A3:** re-render at the first-pass pose, re-match with ALIKED+LG / LoMa, re-solve, and log the inlier gain at correct vs wrong-basin poses |
| AerialExtreMatch ([repo](https://github.com/Xecades/AerialExtreMatch)) | 2025 | 1.5M rendered UAV↔satellite pairs, 32 difficulty levels | Code MIT [V]; data [U] | – | A template for render-trained matchers. Its viewpoints are nadir/oblique, not horizontal |
| PiLoT ([arXiv 2603.20778](https://arxiv.org/abs/2603.20778)) | 2026 | Trained on synthetic data only; claims zero-shot sim-to-real UAV↔3D map | Repo 404 [U] | – | Watch |
| MoonAnything ([arXiv 2604.00682](https://arxiv.org/html/2604.00682)) | 2026 | MASt3R/VGGT do **not** transfer zero-shot to real lunar imagery | – | – | More evidence for "don't expect zero-shot" |
| Diffusion/ControlNet or CycleGAN photo↔render translation | – | Only generic sim-to-real papers (driving, construction). **No terrain correspondence or pose gain reported** | – | – | Skip: hallucinated ridges are exactly our failure mode |

**Assessment.** A 3DFM will not reach the sub-degree accept tolerance. Its possible role is to vote among the 9 ring views on the 15 zero-support photos, or to veto a wrong basin. It is worth one afternoon (E-A1/E-A2), with a pre-set kill criterion: median rotation error above 10° on the correct-ref photos.

---

## Axis 2: global orientation without pairwise matching

**Key finding:** no new learned horizon or terrain descriptor has appeared since 2020. Only lunar/planetary work is active (a simulated lunar horizon-segment matcher, [IEEE 10609750](https://ieeexplore.ieee.org/document/10609750/), no code; WARG; a planetary cross-view benchmark), and none of it has code usable for us.

### Cross-view ground↔aerial yaw

| Method | Venue | Yaw numbers (unknown orientation) | Licence |
|---|---|---|---|
| CCVPE ([arXiv 2303.05915](https://arxiv.org/html/2303.05915), [repo](https://github.com/tudelft-iv/CCVPE)) | TPAMI 2023 | VIGOR pano: median 6.6° same-area, 13.6° cross-area. **KITTI limited FOV, cross-area: median 63.8°, mean 77.8°.** With a ±10° prior: 0.84° | GPL-3.0 [V] |
| FG2 ([arXiv 2503.18725](https://arxiv.org/abs/2503.18725), [repo](https://github.com/vita-epfl/FG2)) | CVPR 2025 | VIGOR cross-area: **median 5.45°, mean 31.4°**. Frozen DINOv2 → BEV points → Procrustes + RANSAC | GPL-3.0 [V] |
| Loc² ([arXiv 2509.09792](https://arxiv.org/html/2509.09792), [repo](https://github.com/vita-epfl/Loc2)) | 2025 | 9.5° / 11.7° (same / cross area); the **inlier ratio tracks pose error** | AGPL-3.0 [V] |
| **Slice-Loc** ([arXiv 2508.05369](https://arxiv.org/abs/2508.05369), [repo](https://github.com/bnothing/Slice-Loc)) | 2025 | Splits the query into slices, poses each, and accepts via **a-contrario NFA on slice agreement**. Mean yaw 3.42° → 1.24°; after the NFA filter, under 3% of cases are more than 10 m off | **Apache-2.0 [V]** |
| HC-Net, Boosting3DoF, GeoFlow | 2023–26 | All assume a yaw prior (±10–45°) | none / MIT (gated weights) / none [V] |
| OrienterNet | CVPR 2023 | Exhaustive search over 256 rotations against OSM | CC-BY-NC [V] |

**Verdict:** these methods are trained on streets and are either copyleft or show a heavy tail, so do not adopt any of them. **Borrow Slice-Loc's idea:** estimate yaw independently on 3–5 vertical photo strips and count agreement within ε°. The count is an NFA-style abstain signal against wrong-ridge latching.

### Search-design fixes (classical, no dependency)

1. **Closed-form pitch/roll per yaw.**
   - For each yaw ψ (dense, parabolic sub-sample peak), fit v_photo(u) ≈ h_DEM(ψ+u) − p − r·u using the exact rotation for wide FOV, with 2–3 Huber/Tukey IRLS iterations.
   - Loop over 5–9 focal values outside.
   - This removes the pitch grid entirely. Cost: 3600 yaws × a 2×2 solve on about 1000 columns, under 0.5 s in numpy.
2. **Max-pool branch-and-bound** over yaw × pitch (× focal) on a pyramid of the edge/skyline likelihood ([rotation-space search background](https://www.researchgate.net/publication/220659423_Global_Optimization_through_Rotation_Space_Search)).
   - It gives an exact top-k and a **certified gap** to the best peak outside ±3°.
   - Small certified gaps mark ambiguous photos. That is a principled version of our basinGap.
3. **Dense foundation-feature correlation over yaw.** This carries over from `matching_v2_research.md` Q3 and is still unrun. The new supporting evidence is FoundPose ([arXiv 2311.18809](https://arxiv.org/abs/2311.18809), CC-BY-NC, so the idea only), B2TFPose ([arXiv 2609.06726](https://arxiv.org/abs/2609.06726), frozen DINOv3 beats trained methods on BOP synthetic↔real) and FG2/Loc² (frozen DINOv2 bridges ground↔aerial). What's new here:
   - (a) resample photo and render features into a shared (azimuth, elevation) grid using our xyz buffers;
   - (b) score each peak as **z = (peak − median)/MAD against a circular-shift null**;
   - (c) test it specifically on the 15 zero-support photos, where it is the only non-skyline appearance cue that needs no correspondences.
4. SO(3) spherical-harmonic correlation (Makadia/Daniilidis) is unnecessary, because yaw is exactly circular and pitch/roll are small.

---

## Axis 3: geometry-only cues

### Monocular depth and normals at km range

Evidence, read skeptically:
- **Scale collapse at distance.** "Honey, I Shrunk the Arc de Triomphe!" ([arXiv 2606.02379](https://arxiv.org/abs/2606.02379)) shows MoGe-2, DA3 and Metric3D v2 underestimate distant landmarks and landscapes.
- **Far-range evaluation stops at about 150 m.** SLIM ([arXiv 2605.26456](https://arxiv.org/abs/2605.26456)) evaluates to 150 m, where MoGe-2's relative error drops 39–51% only once sparse LiDAR is injected.
- **Occlusion boundaries.** RealOOB ([arXiv 2608.30820](https://arxiv.org/abs/2608.30820), Aug 2026; 40 edge/occlusion estimators and 6 depth models) finds strong depth models unreliable at true occlusion boundaries, and finds edge detectors competitive there.
- **Where depth errors sit.** Depth2Pose ([arXiv 2605.19797](https://arxiv.org/abs/2605.19797)): large depth errors are in the distant textureless background. That is harmless for them but is where our signal lives.
- **DEM plus depth.** TanDepth ([arXiv 2409.05142](https://arxiv.org/abs/2409.05142)) uses global-DEM points to scale UAV relative depth. That is DEM→depth, not pose verification; no code found.
- **Unused ground truth.** **GeoPose3K ships DEM-rendered depth and normals for about 3k Alps photos, and no paper evaluates a depth foundation model on it.** Our dev set plus cached buffers is the same test.

Commercially usable models [V unless noted]:

| Model | Licence | Notes |
|---|---|---|
| DA3-S/B/Metric | Apache | – |
| MoGe-2 incl. `moge-2-vits-normal` | MIT | Outputs normals |
| Lotus depth/normal | Apache code and weights | Single step, ~2–4 s MPS [U] |
| StableNormal | Apache | – |
| Marigold v1-1 | Apache code; OpenRAIL++-M weights | – |
| PromptDA, Prior-Depth-Anything | Apache | Accept a low-res depth "prompt", which could be our render |
| DAPM | MIT | UAV any-pose |

Not usable: UniDepth v1/v2 (CC BY-NC), DSINE (Imperial research-only), GeoWizard (no licence). Metric3D is ambiguous: the code is BSD-2 but the weights are untagged and the README asks for commercial inquiries.

### Interior ridges and occlusion contours

- **No 2023–26 paper uses learned interior ridge or occlusion edges for DEM pose.** The prior art is all older: Tzeng CVPRW'13, Fedorov MVA'16 / PeakLens, Braun CEUR'15, PFG 2020 webcam silhouettes, Porzi.
- **Usable edge detectors:**
  - **TEED** (MIT [V], about 58k params, under 50 ms CPU);
  - **DexiNed** (MIT [V], ~35M params);
  - DiffusionEdge (Apache code, heavy).
- **Not usable:** PiDiNet (research-only [V]), UAED/MuGE and EDMB (no licence).
- BSDS scores say nothing about haze or snow ridges.

### Experiments (per photo: correct pose vs yaw ±1/3/8°, pitch ±1°, eye +250 m / +1 km, and the pipeline's wrong-basin candidates)

- **E-G1, occlusion-ordinal agreement (top pick).**
  - Find rendered log-depth jumps greater than 0.3, and sample pixel pairs ±6 px along each contour normal.
  - Score the fraction where DA3-S or MoGe-2 predicted depth agrees on which side is nearer, weighted by jump size.
  - Report it separately for contours under 2 km and over 5 km.
- **E-G2, TEED chamfer to rendered interior occluding contours.**
  - Mask out sky and the skyline band, and add an orientation penalty.
  - Normalise by shuffled contours.
  - Add a variant keeping only edges that coincide with a predicted-depth gradient.
  - Also sweep a 400 m eye grid: is the true eye a local optimum? Near ridges have parallax.
- **E-G3, depth-rank Spearman ρ** (predicted inverse depth vs rendered 1/depth, split under/over 3 km). Expected to be weak for eye shifts.
- **E-G4, normal cosine under 2 km** (MoGe-2 normal or Lotus vs normals from xyz gradients).
- Metrics:
  - AUROC for correct vs wrong-basin;
  - whether wc_0069/0001/0074 are rejected at an operating point that keeps ≥ 95% of current accepts.
- **Kill criterion:** AUROC below 0.65 on wrong-basin negatives.

---

## Axis 4: verification and confidence

| Method | Venue | Numbers | Licence | Use for us |
|---|---|---|---|---|
| **Doppelgangers** ([repo](https://github.com/RuojinCai/doppelgangers)) | ICCV 2023 | Pair classifier on aligned images plus keypoint and match masks, so it learns where matches are *missing*. AP 0.956 in domain, **0.69 out of domain** (Mapillary) | **MIT [V]**; weights hosted at Cornell, licence [U] | Retrain on photo↔render pairs with our ALIKED/LoMa masks. Positives: refs. Negatives: mined wrong basins. A few thousand pairs, minutes on MPS |
| **Doppelgangers++** ([arXiv 2412.05826](https://arxiv.org/abs/2412.05826), [repo](https://github.com/doppelgangers25/doppelgangers-plusplus)) | CVPR 2025 | Transformer head on frozen MASt3R features. AP 0.968 on Mapillary out of domain | **CC BY-NC-SA 4.0** [V] (GitHub API: NOASSERTION) on MASt3R NC | **Research oracle only.** Zero-shot on correct vs wrong-basin renders for wc_0069/0001/0074. If it separates them, that justifies building a clean version (DINOv2 / DA3-B backbone) |
| **DensePV / DensePNV** ([InLoc](https://arxiv.org/pdf/1803.10368), [Taira ICCV'19](https://arxiv.org/pdf/1908.04598)) | CVPR'18 / ICCV'19 | Render at each candidate and score per-pixel dense-descriptor similarity (+ normals, + semantic masking of transient classes). DensePNV beats DensePV by more than 5 points on InLoc | MATLAB, [U] | **"DensePV-lite"**: per-depth-band descriptor/edge agreement, using the **minimum band** as the feature, plus the fraction of strong rendered depth edges with no photo edge within r px. About 50 lines, under 1 s per pose |
| AC-RANSAC / ORSA ([IPOL](https://github.com/pmoulon/IPOL_AC_RANSAC)) | 2012 | NFA < 1 acceptance | openMVG MPL-2.0 [U] | Rejects weak junk, **not** structured doppelgangers. Use as a feature, plus the ratio against the runner-up basin |
| MAGSAC++ / SupeRANSAC ([2506.04803](https://arxiv.org/abs/2506.04803)) | 2020 / 2025 | Marginalised score, not a probability | [U] | Feature only |
| **Map-free protocol** ([benchmark](https://research.nianticlabs.com/mapfree-reloc-benchmark)) | ECCV 2022 | Each pose comes with a confidence; reports precision against coverage | Code Niantic NC [V]; the protocol is free | Adopt the metric: **maximum coverage at precision 1.0**, per photo, with a Wilson CI |
| **SUE** ([arXiv 2404.00546](https://arxiv.org/abs/2404.00546), [repo](https://github.com/MubarizZaffar/SUE)) | CVPR 2024 | The spatial spread of the top-k retrieved poses predicts VPR failure (AUC-PR 0.885 vs 0.797 for L2). Geometric-verification inlier counts beat learned uncertainty (BTL, STUN) | [U] | Feature: angular spread of hypotheses within 80% of the top score. **Compute it under ALIKED even when LoMa produces the pose**, because LoMa erased wc_0069's competing basin |
| To Match or Not to Match ([arXiv 2504.06116](https://arxiv.org/abs/2504.06116)) | CVPRW 2025 | Inlier counts reliably predict when re-ranking helps | [U] | Supports inliers as a confidence *baseline* |
| RIC-Loc ([arXiv 2607.04722](https://arxiv.org/abs/2607.04722), [repo](https://github.com/SNU-DLLAB/ric_loc)) | 2026 | A pose from each reference view; consensus dispersion plus track covariance gives ground-truth-free failure detection (risk–coverage) | [U]; depends on VGGT | Idea: **solve independently per ring view and per depth band**, and use the dispersion as a feature |
| Conformal: adaptive geodesic CP ([2605.00233](https://arxiv.org/abs/2605.00233)), ConformalKeypoint ([repo](https://github.com/NVlabs/ConformalKeypoint)) | 2026 / CVPR'23 | Coverage of the hardest quartile rises from about 75% to 93% (egocentric) | no code / [U] | **A threshold-setting method only.** With about 3 natural wrong-basin photos, no finite-sample guarantee at α=0.05 is attainable, and mined negatives are not exchangeable with natural failures |

**Recommended verifier protocol** (dev only; test half untouched; feature list pre-registered in the v3 pre-registration style):

1. **E0: build the dataset.** Refs are positives. Negatives are the known-wrong refs, blind-pack decoys, and **mined negatives**: skyline top-4 minus the correct pose, and ±4–5° decoys re-refined through the same RANSAC. A mined pose counts as wrong if it lies more than 3° from every verified cluster.
2. **E1: features.**
   - Inliers and support.
   - Spatial coverage: hull fraction and 4×4 occupancy.
   - Inlier range distribution: median, IQR, near/mid/far fractions.
   - **Far-solve → mid/near residual.**
   - Skyline residual and `cueAgreeDeg`.
   - Top-2 distinct-basin ratio and SUE dispersion.
   - ALIKED-vs-LoMa disagreement.
   - DensePV-lite minimum band score and predicted-but-unmatched fraction.
   - log NFA.
   - E-G1 / E-G2 scores.
3. **E2: models.** Rank single features by AUROC, then fit an L2 logistic regression on at most 4 features chosen by nested leave-one-photo-out. The metric is **accepted-at-zero-gross**. Report wc_0069/0001/0074 individually.
4. **E3: pair classifier.** Doppelgangers++ zero-shot as an oracle, then a retrained MIT Doppelgangers.
5. **E4: deployment.** Use the result as a **veto added on top of the frozen T6 rule**, and freeze the threshold by a conformal-style dev quantile. This is the prerequisite for giving LoMa its own arm.

---

## Axis 5: eye position, priors and benchmarks

- **Benchmarks.** Nothing new since GeoPose3K, CH1/CH2, CrossLocate and LandscapeAR. Their best numbers are the ones already in the SoTA report.
  - The nearest active field is UAV absolute localisation against ortho+DSM:
    - **AnyVisLoc** ([arXiv 2503.10692](https://arxiv.org/abs/2503.10692), [repo](https://github.com/UAV-AVL/Benchmark); dataset NC). Best baseline 74.1% within 5 m. It covers some mountain and grassland scenes, and has a ~30 m satellite-DSM configuration that is the closest analogue to a coarse DEM.
    - **OrthoLoC** (see Axis 1).
    - **OrthoTrack** ([arXiv 2606.25245](https://arxiv.org/pdf/2606.25245), [repo](https://github.com/cvg/orthotrack), video, licence [U]).
    - **AeroMap3D** ([arXiv 2607.14009](https://arxiv.org/pdf/2607.14009)): filters correspondences with OSM semantics.
    - **DECO** ([arXiv 2608.22289](https://arxiv.org/pdf/2608.22289)): mono-depth co-visibility to choose keypoints.
  - All of these are near-nadir with textured, overlapping ground, so their numbers do not transfer to horizontal views with multi-km depth.
- **Photographer-location priors: no published method for DEM photo localisation.** Only scenic-density proxies exist ([Flickr scenicness, arXiv 1804.03506](https://arxiv.org/pdf/1804.03506); [OpenStreetView-5M](https://arxiv.org/pdf/2404.18873)). OSM is ODbL, which allows commercial use with attribution.
  - **E-E1 (prior strength):** for the 30 dev refs, compare the distance from the reference eye to the nearest OSM path/peak/hut/viewpoint/aerialway station against the distance from the reference eye to the EXIF GPS.
  - **E-E2 (candidates):** on the 15 zero-support photos, sample eyes on OSM features within 1–3 km, at z = DEM + 1.7 m and slope below 40°.
    - Keep eyes whose viewshed contains the peaks implied by the skyline-yaw fit, take the top ~50, and run the existing fine sweep.
    - Success: support recovered on at least 3 of 15. Any accept still goes through the verifier (Axis 4), because moved-eye accepts have already produced one gross HIGH (wc_0086).
- **Observability.**
  - OrthoLoC's focal/translation ambiguity (recall 75% → 22% when focal is free) is the UAV analogue of what we saw with moved eyes. Do not free eye position and focal together without near-field inliers.
  - The only geometry signal with parallax is interior occluding contours (E-G2).
- **Planetary TRN** (crater TRN [2606.14776](https://arxiv.org/abs/2606.14776), ShadowNav [2405.01673](https://arxiv.org/html/2405.01673), lunar DEM-anchored SLAM [2603.17229](https://arxiv.org/abs/2603.17229)): nadir views, or normals from SLAM rather than one image. Not transferable.

## Axis 6: other

- **Semantic segmentation.** Brejcha 2018 found the information lives in regions; this is a modern redo.

  | Model | Licence | Notes |
  |---|---|---|
  | **SAM 3** ([repo](https://github.com/facebookresearch/sam3), [HF](https://huggingface.co/facebook/sam3), [paper](https://arxiv.org/html/2511.16719v1)) | Custom SAM License [V]: commercial, royalty-free; no military/ITAR use; ship the licence when redistributing; gated | Text prompts. 0.9B, ~3–8 s per image MPS [U] |
  | **SAM 2.1** | Apache-2.0 [V] | Prompt-only; refines sky/cloud edges from our sky seeds |
  | **SegEarth-OV3** ([arXiv 2512.08730](https://arxiv.org/abs/2512.08730)) | – | A training-free way to get SAM 3 "stuff" classes; aerial only |

  - I found no ground-level alpine segmentation dataset; WeatherProof ([arXiv 2312.09534](https://arxiv.org/html/2312.09534v1)) comes closest.
  - **E-S1:** run SAM 3 with ~7 prompts on the 50 dev photos. Render class maps (swissTLM3D land cover, whose terms are [U], plus a snow proxy from elevation and season) at the correct, wrong-basin and ring poses, and score class IoU.
    - Success: IoU is higher for the correct pose on wc_0069/0001/0074, and on at least 80% of refs against their top wrong candidate.
    - Separately, test the cloud mask as a skyline-search pre-filter.
- **Render reliability mask** (from LSGS-Loc, [arXiv 2604.05402](https://arxiv.org/html/2604.05402); its Laplacian mask cut translation error from 0.98 m to 0.37 m):
  - **E-S2:** before matching, drop satellite-render pixels with low Laplacian energy or DEM slope above ~50°, where the ortho is smeared on cliffs. Measure inlier precision at correct vs wrong poses.
- **Differentiable rendering:** PyTorch3D (BSD [U]) is slow on DEM meshes, and nvdiffrast is NVIDIA NC. There is no terrain evidence. A finite-difference Gauss–Newton step through our own renderer is equivalent. Low priority.
- **3DGS/NeRF:** GS-CPR (CC BY-NC-SA [V]), LSGS-Loc (depends on Reloc3r), Skyfall-GS (Inria NC [V], CUDA, urban), Sat-NeRF/EO-NeRF (need multi-date RPC stereo). Skip.

---

## Ranked experiments (top 9)

Impact is scored on (a) recall of correct poses and (b) rejection of wrong-basin errors, from 0 to 3 as a judgement call. All runs are on the dev split with cached renders and xyz.

| # | Experiment | (a) recall | (b) rejection | Cost | New deps / licence | Kill criterion |
|---|---|---|---|---|---|---|
| 1 | **Mined-negative verifier (Axis 4 E0–E2).** Depth-band residuals (far-solve → mid/near residual) + DensePV-lite predicted-but-unmatched contours + SUE dispersion under ALIKED + NFA; logistic regression with ≤ 4 features; leave-one-photo-out "accepted-at-zero-gross"; veto on top of T6 | 1 (unlocks LoMa arm, looser rule) | **3** | 1–2 days | none | wc_0069 not separable, or loses > 1 current accept |
| 2 | **Closed-form pitch/roll per yaw + max-pool branch-and-bound certified gap.** Also strip-consistency (Slice-Loc NFA) | **2** (fixes pitch-grid phase) | 2 (certified gap and strip agreement as abstain signals) | 0.5–1 day | none (Slice-Loc Apache, idea only) | Top-4 hit rate < the current 23/30, or top-k changes under a half-step grid shift |
| 3 | **Occlusion-ordinal agreement (E-G1) + TEED interior-contour chamfer (E-G2)**, incl. a 400 m eye-grid test | 1–2 (only cue with eye parallax) | **2–3** | 1 day | DA3-S (Apache) or MoGe-2 (MIT); TEED MIT [V] | AUROC < 0.65 on wrong-basin negatives |
| 4 | **Re-render → re-match at the provisional pose** (AdHoP analogue); inlier gain as a feature | 2 (more inliers on weak photos) | 2 (gain correct ≫ wrong?) | 0.5 day | none | Gain distributions overlap for correct vs wrong |
| 5 | **Cylindrical DINOv2/v3 feature correlation over yaw** with a circular-shift z-score; focus on the 15 zero-support photos and on eye offsets of 200/400/1000 m | **2–3** (the only appearance cue with no correspondences) | 1–2 (independent cue for fusion) | 1 day | DINOv2 Apache / DINOv3 custom (commercial OK) | Yaw within 3° on < 50% of refs at the true eye |
| 6 | **OSM photographer-prior eyes within 1–3 km + viewshed filter** on the 15 zero-support photos | **2–3** if the prior holds | 0 (needs #1 before any accept) | 0.5–1 day | OSM ODbL | Median distance from reference eye to OSM feature > 50 m, or support on < 3 of 15 |
| 7 | **SAM 3 semantic class IoU against rendered land cover + cloud mask** | 1 (cloud → skyline) | 2 | 1 day | SAM 3 licence (commercial, gated) [V]; swissTLM3D terms [U] | IoU does not rank correct > wrong on ≥ 80% |
| 8 | **VGGT-1B-Commercial / MapAnything-apache coarse rotation + wrong-basin veto** (photo + render with known pose, depth and intrinsics) | 1–2 (basin vote when matchers give 0) | 1 | 0.5 day | Gated commercial / Apache [V] | Median rotation error > 10° on correct-ref pairs |
| 9 | **Doppelgangers++ zero-shot oracle**, then retrain MIT Doppelgangers on photo↔render match masks | 0 | 2 (if it transfers) | 1 day | D++ NC (research only); Doppelgangers MIT [V] | Zero-shot fails to separate wc_0069/0001/0074 |

**Suggested order:** #1 and #2 first (no dependencies; they target the frozen-rule blockers directly). Then #3 and #4, whose features feed #1's verifier. Then #5 and #6 for the zero-support recall problem. #7–#9 are optional.

---

## Full source list

**Axis 1**
- AerialMegaDepth: https://arxiv.org/html/2504.13157, https://github.com/kvuong2711/aerial-megadepth, https://huggingface.co/kvuong2711/checkpoint-aerial-mast3r
- Extreme-view 3DFMs: https://arxiv.org/html/2511.22686, https://cornell-vailab.github.io/Ext-3DFMs/
- Sky2Ground: https://arxiv.org/abs/2603.13740
- Cross-View Splatter: https://arxiv.org/html/2605.19656
- VGA (CVPR'26 notes): https://en.papernotes.org/CVPR2026/3d_vision/vga_empowering_aerial-ground_localization_by_visual_geometry_alignment/
- MoonAnything: https://arxiv.org/html/2604.00682
- Planetary VFM cross-view: https://arxiv.org/abs/2601.09107
- Lunar DEM-anchored SLAM: https://arxiv.org/abs/2603.17229
- OrthoLoC: https://arxiv.org/html/2509.18350v2, https://github.com/deepscenario/OrthoLoC, https://deepscenario.github.io/OrthoLoC/
- PiLoT: https://arxiv.org/abs/2603.20778
- AerialExtreMatch: https://github.com/Xecades/AerialExtreMatch
- Reloc3r: https://github.com/ffrivera0/reloc3r
- CUT3R: https://github.com/CUT3R/CUT3R
- TTT3R: https://github.com/Inception3D/TTT3R
- Fast3R: https://github.com/facebookresearch/fast3r/blob/main/LICENSE
- MUSt3R: https://github.com/naver/must3r
- π³: https://github.com/yyfz/Pi3, https://huggingface.co/yyfz233/Pi3
- MapAnything: https://github.com/facebookresearch/map-anything, https://huggingface.co/facebook/map-anything-apache
- VGGT-1B-Commercial: https://huggingface.co/facebook/VGGT-1B-Commercial
- VGGT-Long: https://github.com/DengKaiCQ/VGGT-Long
- HD-VGGT: https://arxiv.org/pdf/2603.27222
- 3DFMs on aerial blocks: https://arxiv.org/abs/2507.14798
- Diffusion sim2real: https://arxiv.org/html/2505.16360v1

**Axis 2**
- FG2: https://arxiv.org/abs/2503.18725, https://github.com/vita-epfl/FG2
- CCVPE: https://arxiv.org/html/2303.05915, https://github.com/tudelft-iv/CCVPE
- Loc²: https://arxiv.org/html/2509.09792, https://github.com/vita-epfl/Loc2
- HC-Net: https://github.com/xlwangDev/HC-Net
- Boosting3DoF: https://github.com/YujiaoShi/Boosting3DoFAccuracy
- GeoFlow: https://arxiv.org/pdf/2603.21943
- Slice-Loc: https://arxiv.org/abs/2508.05369, https://github.com/bnothing/Slice-Loc
- OrienterNet: https://github.com/facebookresearch/OrienterNet
- C-BEV: https://arxiv.org/abs/2312.08060
- BEV-VPR circular correlation: https://arxiv.org/pdf/2305.13814
- Lunar horizon matching: https://ieeexplore.ieee.org/document/10609750/
- WARG: https://arxiv.org/abs/2606.10602
- Planetary cross-view benchmark: https://arxiv.org/abs/2606.29821
- LunarLoc: https://arxiv.org/abs/2506.16940
- ALPER: https://www.sciencedirect.com/science/article/pii/S0094576525006186
- FoundPose: https://arxiv.org/abs/2311.18809
- B2TFPose: https://arxiv.org/abs/2609.06726
- Rotation-space branch-and-bound: https://www.researchgate.net/publication/220659423_Global_Optimization_through_Rotation_Space_Search

**Axis 3**
- Depth and occlusion papers:
  - https://arxiv.org/abs/2606.02379
  - https://arxiv.org/abs/2605.26456
  - https://arxiv.org/abs/2608.30820
  - https://arxiv.org/abs/2605.19797
  - https://arxiv.org/abs/2409.05142
  - https://arxiv.org/abs/2607.21438
  - https://arxiv.org/abs/2607.17967
  - https://arxiv.org/abs/2604.09352
- GeoPose3K: https://cphoto.fit.vutbr.cz/geoPose3K/
- Brejcha camera elevation (2016): https://arxiv.org/pdf/1607.03305
- Tzeng CVPRW'13: https://openaccess.thecvf.com/content_cvpr_workshops_2013/W07/papers/Tzeng_User-Driven_Geolocation_of_2013_CVPR_paper.pdf
- Fedorov MVA'16: https://link.springer.com/article/10.1007/s00138-016-0808-0
- Braun CEUR'15: https://ceur-ws.org/Vol-1366/paper5.pdf
- PFG 2020 webcam silhouettes: https://link.springer.com/content/pdf/10.1007/s41064-020-00093-1.pdf
- Ridge-line + skyline geolocation (GMU): https://c4i.gmu.edu/~pcosta/F15/data/fileserver/file/472116/filename/Paper_1570111401.pdf
- GED: https://arxiv.org/pdf/2410.03080
- SAUGE: https://arxiv.org/pdf/2412.12892
- Licences:
  - UniDepth: https://github.com/lpiccinelli-eth/UniDepth/blob/main/LICENSE
  - Metric3D: https://github.com/YvanYin/Metric3D/blob/main/LICENSE, https://huggingface.co/JUGGHM/Metric3D
  - Marigold: https://github.com/prs-eth/Marigold, https://huggingface.co/prs-eth/marigold-normals-v1-1
  - Lotus: https://github.com/EnVision-Research/Lotus
  - DSINE: https://github.com/baegwangbin/DSINE/blob/main/LICENSE
  - StableNormal: https://github.com/Stable-X/StableNormal
  - GeoWizard: https://github.com/fuxiao0719/GeoWizard
  - TEED: https://github.com/xavysp/TEED
  - DexiNed: https://github.com/xavysp/DexiNed
  - PiDiNet: https://github.com/hellozhuo/pidinet/blob/master/LICENSE
  - DiffusionEdge: https://github.com/GuHuangAI/DiffusionEdge
  - UAED/MuGE: https://github.com/ZhouCX117/UAED_MuGE
  - EDMB: https://github.com/Li-yachuan/EDMB
  - MoGe-2 normal: https://huggingface.co/Ruicheng/moge-2-vits-normal
  - PromptDA: https://github.com/DepthAnything/PromptDA
  - Prior-Depth-Anything: https://github.com/SpatialVision/Prior-Depth-Anything
  - Marigold-DC: https://github.com/prs-eth/Marigold-DC
  - DAPM: https://github.com/ThisIsLT/DAPM

**Axis 4**
- Doppelgangers: https://github.com/RuojinCai/doppelgangers, https://doppelgangers-3d.github.io/
- Doppelgangers++: https://arxiv.org/abs/2412.05826, https://github.com/doppelgangers25/doppelgangers-plusplus
- Taira ICCV'19: https://arxiv.org/pdf/1908.04598
- InLoc: https://arxiv.org/pdf/1803.10368
- Semantic pose verification: https://arxiv.org/abs/2203.16945
- Map-free: https://github.com/nianticlabs/map-free-reloc, https://research.nianticlabs.com/mapfree-reloc-benchmark
- SUE: https://arxiv.org/abs/2404.00546, https://github.com/MubarizZaffar/SUE
- To Match or Not to Match: https://arxiv.org/abs/2504.06116
- RIC-Loc: https://arxiv.org/abs/2607.04722, https://github.com/SNU-DLLAB/ric_loc
- Conformal: https://arxiv.org/abs/2605.00233, https://github.com/NVlabs/ConformalKeypoint, https://arxiv.org/html/2505.01810
- AC-RANSAC: https://github.com/pmoulon/IPOL_AC_RANSAC, https://openmvg.readthedocs.io/en/latest/openMVG/robust_estimation/robust_estimation/, https://www.ipol.im/pub/art/2022/357/article_lr.pdf
- MAGSAC++ / SupeRANSAC: https://arxiv.org/abs/1912.05909, https://arxiv.org/abs/2506.04803
- RANSAC 2025 tutorial: https://danini.github.io/ransac-2025-tutorial/
- Matching uncertainty: https://arxiv.org/abs/2608.08685

**Axes 5–6**
- AnyVisLoc: https://github.com/UAV-AVL/Benchmark, https://arxiv.org/abs/2503.10692
- OrthoTrack: https://arxiv.org/pdf/2606.25245, https://github.com/cvg/orthotrack
- AeroMap3D: https://arxiv.org/pdf/2607.14009
- DECO: https://arxiv.org/pdf/2608.22289
- UAVD4L: https://github.com/RingoWRW/UAVD4L
- GTA-UAV: https://github.com/Yux1angJi/GTA-UAV
- UAV-VisLoc: https://github.com/IntelliSensing/UAV-VisLoc
- GS-CPR: https://github.com/XRIM-Lab/GS-CPR
- LSGS-Loc: https://arxiv.org/html/2604.05402
- GSplatLoc: https://github.com/haksorus/gsplatloc
- GS-CPE: https://arxiv.org/pdf/2608.10938
- Skyfall-GS: https://github.com/jayin92/Skyfall-GS, https://github.com/jayin92/Skyfall-GS/blob/main/LICENSE_inria.md
- Sat-NeRF: https://github.com/centreborelli/satnerf
- EO-NeRF: https://github.com/rogermm14/eonerf_code
- SAM 2: https://github.com/facebookresearch/sam2
- SAM 3: https://github.com/facebookresearch/sam3/blob/main/LICENSE, https://huggingface.co/facebook/sam3
- SegEarth-OV3: https://arxiv.org/abs/2512.08730
- OneFormer: https://huggingface.co/shi-labs/oneformer_ade20k_swin_large
- Mask2Former: https://github.com/facebookresearch/Mask2Former/blob/main/LICENSE
- CLIPSeg: https://github.com/timojl/clipseg
- WeatherProof: https://arxiv.org/html/2312.09534v1
- nvdiffrast: https://github.com/NVlabs/nvdiffrast/blob/main/LICENSE.txt
- PyTorch3D: https://github.com/facebookresearch/pytorch3d
- Crater TRN: https://arxiv.org/abs/2606.14776
- ShadowNav: https://arxiv.org/html/2405.01673
- Flickr scenicness: https://arxiv.org/pdf/1804.03506
- OpenStreetView-5M: https://arxiv.org/pdf/2404.18873
- Fedorov MAED'14: https://dl.acm.org/doi/10.1145/2661821.2661825
- CrossLocate: https://cphoto.fit.vutbr.cz/crosslocate/
