# Whole-image concordance: research and outcome

> **Status (2026-10-02).** Built 2026-09-29 as seven work packages (§7). Kept: `src/lib/concord/{core,cues,priors,occl,app}` behind `?concord=eye,occl,labels,drape` (all off; `labels` and `drape` act only with `occl`; module guide `src/lib/concord/README.md`). The C4 label and drape hooks landed 2026-10-02 but are unconsumed: no label renderer, drape layer or PhotoWorkspace call uses them yet. Removed 2026-09-30 as negative or unconsumed: the WP-D joint solve, WP-E display warp and WP-G re-match ([negative-results.md](negative-results.md#code-removed-in-the-2026-09-30-cleanup), recovery commit `a1845f5`). Every accuracy claim waits on the blind interior pins (`tools/concord/pins/PROTOCOL.txt`). The three.js hook sites named in older text (`engine.ts`, `materials.ts`) no longer exist; overlays and drape live in the deck engines.

Status: research synthesis, 2026-09-29. It is read-only: no repo files were changed. All pixel figures are at the **1600 px basis** unless marked "@4032". The measurements come from the CPU audit (local scratch, not published) run on the 14 photos with ground-truth poses, plus figures from the five SoTA streams.

---

## 1. Executive summary

**Main finding.** The skyline is accurate, but the skyline cannot detect camera **position** errors. Moving the eye 10 m changes the refit skyline RMS by only 0.2–2 px, because yaw, pitch and roll absorb the shift. Interior pixels still move, and the error grows as 1/distance. Pins under 6.5 km have a median residual of about 4.9 px; pins over 15 km have about 1.7 px. That gap is the "good on mountains, off in valleys" symptom. Ranked by the audit, interior misconcordance comes from:

1. **Eye position.** EXIF horizontal accuracy (hAcc) is 6–70 m, median 14 m. Median / p90 error after the skyline refit: 73/133 px at 50–500 m, 10.5/20 px at 0.5–2 km, 2.5/4.5 px at 2–5 km.
2. **Eye height and DEM datum.** Two streams disagree, and the disagreement is itself a finding:
   - The audit, using Terrarium, finds the GPS fix 35–68 m *above* DEM+1.6 at Niederhorn.
   - The nearfield stream, using current Mapterhorn z17, finds the same fixes 5–18 m *below* ground.
   - Ground truth stores `demGround` 1863 m at IMG_7059. Current Mapterhorn gives 1944.6 m, an 81 m difference.
   - Most of the "vertical ambiguity" (25 px at 0.5–2 km, 208 px at 50–500 m) is therefore probably a **coarse DEM plus the `max(GPS, DEM+1.6)` rule**, not a GPS fault. Across 10 Swiss and US fixes, iPhone GPSAltitude behaves like mean sea level (MSL) within about ±2–13 m in 8 cases. The app currently throws this measurement away.
3. **Objects not in the DEM** (trees, huts, buildings, terrain within 50 m). They cover 18–55% of below-skyline pixels in 8 of 13 photos, and trails and contours are drawn over them.
4. **Focal length.** The EXIF 35 mm value is rounded. iPhone 11 Pro main solves f = 3057–3101 against EXIF 3028 (+1.5–1.9%). That costs 7–16 px everywhere when f is not solved, and 2–4 px when it is.
5. **Radial distortion k1** (up to about 15 px at corners). The evidence is suggestive, not conclusive: the pins favour k1 ≈ +0.04 with the physical f ≈ 3036–3044, and the skyline cannot tell k1 and f apart. The principal point cannot be identified; leave it alone.
6. **Residual map, vector and DEM error** after all of the above: skyline rotation 1.5–3 px; DEM coarsening 17 px at 50–500 m; OSM trails off by 5–20 m; forest canopy (about 25–30 m) adds about 4 px on an 8.5 km ridge and about 36 px on a ridge at 2 km (@4032).

**Techniques ranked by value per effort:**

1. **An interior evaluation harness with holdout pins (the enabler).** Today the 14 GT photos have only 0–7 pins each, mostly peaks, so interior concordance cannot be measured. Add interior pins, report errors by distance and radius bands, use leave-one-out (LOO), and pre-register the acceptance rule.
2. **Eye priors that use the data we already have:**
   - GPSAltitude as a measurement: an altitude-contour prior, with σ about 3–8 m.
   - The near DEM (Mapterhorn z16/17) for eye ground everywhere.
   - A per-LensModel focal table to replace the rounded EXIF focal.

   Effort S. This removes most of the vertical and focal terms.
3. **Interior geometric cues:** interior occluding contours (the DEM range discontinuity chamfered against the photo edge distance transform), lake waterlines as `LevelCorr` (elevation-only constraints), and shoreline point-on-curve constraints. These are the only cues with eye parallax that need no learned matcher.
4. **A joint whole-frame robust LM.** State: yaw, pitch, roll, focal, eye E/N/U, and optionally k1. It combines the skyline, the interior cues and matcher inliers, with GPS and altitude priors. It is accepted only if the holdout pins improve and the skyline does not get worse. This is the OrthoLoC and Mikolka-Flöry recipe (2–3 px GCP residuals in the literature).
5. **Render → re-match → re-solve** (the AdHoP analogue, about +30% matches). Return the matcher inliers, which are computed today but dropped, and re-match lower-frame tiles at the refined pose.
6. **Occlusion from a surface model (DSM).** Stream swissSURFACE3D COGs in the browser: CORS is open and range reads work, so the earlier "needs local tiling" blocker is gone. Build one occluder-range texture in photo space so overlays dim behind trees and huts, and the drape stops smearing.
7. **A bounded, display-only residual warp field.** Fit a depth-guided TPS/GP field with posterior σ on the remaining residuals. Apply it through one pull-warp texture in both composites, plus a CPU inverse for labels, hover and the drape. It never feeds pose, benchmarks or exports, and it is off when confidence is LOW.
8. **Later:** semantic class render (swisstopo Light Base Map vector tiles) with a permissive segmenter (Talk2DINO or EoMT) for IoU verification and match masking; sun-shading NMI or shadow-terminator verification.

---

## 2. Error budget

px @1600. Median/p90 per distance band, measured after the skyline rotation refit unless stated.

| Source | Symptom | Magnitude / evidence | Fix (WP) |
|---|---|---|---|
| GPS horizontal eye error (hAcc 6–70 m, median 14) | Valleys, villages, near ridges and trails shifted sideways; skyline fine | 73/133 (50–500 m), 10.5/20 (0.5–2 km), 2.5/4.5 (2–5 km), <1 (>5 km). A 10 m shift changes skyline RMS by only 0.2–2 px | Interior-constrained eye solve (C+D); matcher points (G) |
| Eye height (`max(GPS, DEM+1.6)` rule; DEM datum) | Whole lower frame tilted or too high/low; worst on summits and cliff lips | 208/282, 25/34, 4.2/8.2, 2.2/3.4. Terrarium vs Mapterhorn z17 differ by up to 81 m at Niederhorn; GPS alt is MSL-like (8/10 within ±13 m) | Altitude-contour prior + near DEM (B); waterline level (C) |
| Focal from the rounded EXIF focal | Scale error, worst at frame bottom and edges | +1.5–1.9% bias → 7–16 px if unsolved; 2–4 px left after the vfov solve; ultrawide ×1.063 | LensModel focal table (B); joint LM (D) |
| Radial distortion k1 | Corners and bottom edge | Up to ~15 px at corners if k1 ≈ +0.04 (pins F ≈ 17, 1 param); skyline flat over k1 ∈ [−0.02, 0.04] | Distortion hook in the camera model (A), estimated only under corner evidence (D) |
| Principal point | — | Not identifiable (33/−73 px, unphysical) | Keep it centred unless the photo is cropped |
| Skyline rotation residual | Global | 1.5–3 px | Existing |
| DEM coarsening (z13→z11 proxy) | Near-field geometry | 17/26 (50–500 m), 1.3/5.3 (0.5–2 km) | Mapterhorn z16/17 near the eye everywhere (B) |
| DTM vs canopy / buildings | Contours below the treeline; silhouettes of forest edges; bias in match lifting | ~4 px on an 8.5 km ridge (pin note); ~36 px on a forested ridge at 2 km (@4032) | DSM/nDSM occluder (F); semantic masking of matches (G) |
| Objects not in the DEM | Trails and contours drawn over trees, grass and people in the bottom third | 18–55% of below-skyline pixels hit DEM within 50 m in 8/13 photos; Step Inside smear gate 4–15% vs an 80% target | Occluder range texture (F) |
| OSM trail geometry | Trail beside the visible path | 5–20 m | Phase 2: bounded vector snapping |
| Glacier / DEM epoch | Glacier tongues and moraines | DEM ~2016 median; tongues moved tens of metres since | Down-weight via RGI7 mask (phase 2) |
| Time/sun metadata | Shading and relit blends wrong | 1 h timezone error ≈ 15° azimuth | Phase 2 photometric |

The direct check is consistent with this budget. Lake far shores at 3.5–9 km (IMG_7033, IMG_7018) already sit within about 3–5 px at the GT pose, so the dominant problems are the 50 m – 2 km band and the image edges.

Note on units: the streams quote f ≈ 2900 px @4032 (horizontal-FOV convention). The app uses the diagonal convention (`focal.ts`, `FF35_DIAGONAL_MM`), which gives 3028. Use the app convention throughout.

---

## 3. Technique catalogue

Effort: S/M/L. "[U]" marks an unverified claim.

### 3.1 Camera model

| Technique | Evidence | Licence | Runtime | Effort | Risk |
|---|---|---|---|---|---|
| Per-LensModel focal table (prior mean + tight σ) | 7 photos: f = 3084 ± 17 vs EXIF 3028; skyline 3047–3105; ultrawide ×1.063 | own | lookup | S | Only iPhone 11 Pro measured; confounded with k1 |
| k1 as a post-pinhole distortion (division model) in normalised coords; pinhole remains the render model | Pin RMS 2.9→2.3 px with k1 = +0.042, f→physical 3036–3044; Mikolka-Flöry fixes the principal point with no distortion and still gets 2.1 px | own | analytic | M (as a hook) / L (full model change in ~40 files) | Weakly identified; can absorb eye/DEM error. Needs corner GCPs or a chessboard shot |
| Principal point only when cropped (ExifImageWidth ≠ pixels) | Not identifiable on uncropped photos | own | — | S | Correlates with yaw and roll |
| Undistort-the-photo remap (keep everything pinhole) | Standard; one GPU pass | own | 1 pass | M | Hover, Step Inside and export must use the remapped basis |
| No-EXIF priors: GeoCalib (k1, division model), AnyCalib | FoV error ~2°, worse than EXIF | Apache-2.0 (GeoCalib weights CC-BY-4.0) | ~4.7 s CPU | S (already scoped in matching-v2) | Only for no-EXIF photos |
| iPhone panorama as a cylindrical model with drift splines | `roll/mosaic/panorama.ts` has the cylinder maths; Hugin treats iPhone panos as cylindrical | own | vertex-shader projection | L | Apple pano projection unverified [U] |

Skip: Perspective Fields (Adobe NC), UniDepth/UniK3D (CC BY-NC), and Depth Pro focal estimation (apple-amlr licence, 64.6% of images within 25% focal error).

### 3.2 Dense / interior geometric refinement

| Technique | Evidence | Licence | Runtime | Effort | Risk |
|---|---|---|---|---|---|
| **Altitude-contour eye prior**: eye near the iso-band DEM(x, y)+1.6 ≈ GPSAltitude, within hAcc | Niederhorn fixes lie 5–18 m below the z17 DEM; the iso-band is 7–18 m away (inside hAcc); 7059/7063 altitudes agree within 4.4 m | own | <5 ms | S | Barometric drift; cable car or buildings; flat ground is uninformative. Use as a prior only |
| **Near DEM for eye ground and 50 m–2 km geometry** (Mapterhorn z16/17 via `near-dem.ts`) | z13→z11 proxy: 17 px at 50–500 m; engines differ today (three.js z14 vs deck z17) | Mapterhorn (approved) | streaming | S | High zooms only where national lidar exists |
| **Interior occluding-contour chamfer** (depth discontinuities in the render vs the photo edge DT, oriented, truncated, Huber) | EPO (2607.00579): DT edge objective beats bundle adjustment by +4 AUC outdoors; oriented chamfer (FDCM); interior silhouettes carry parallax | own (EPO licence NOASSERTION, so re-implement); TEED, DeepLSD MIT | 5–10 ms DT; +2–5k residuals | M | Texture, snowline and cloud-shadow edges pull the fit. Gate on orientation (±20°) and depth contrast (range ratio > 1.3, range > 300 m) |
| **Waterline level constraint** (far-shore row per column → `LevelCorr`) | Manual waterline pins: 6971 0.1–0.4 px, 6958 5–6.5 px; 7033/7018 far shores within 3–5 px; lakes in 6958/6971/7018/7033/7053/7086 | own | <1 s CPU ray march | M | Reeds, boats, haze; lake level (use median DEM in polygon or BAFU gauge); reservoirs |
| **Shoreline point-on-curve** (the ray meets the lake plane; distance to the shoreline polyline gives eye E/N) | Standard map-localisation DT compatibility (SASGeo); shores at 0.3–3 km carry parallax | own; OSM ODbL / swissTLM3D OGD | <20 ms | M | Unmapped quays, low water, segmentation bleed |
| **Joint whole-frame robust LM** (skyline + cues + points; eye/focal/k1 priors; covariance out) | OrthoLoC: 0.12°, 0.32 m, 1.6% focal via Huber LM over intrinsics and extrinsics; Mikolka-Flöry 7-param resection 2.1 px mean | own; OrthoLoC CC BY-NC-SA (method only); PoseLib BSD-3 | <50 ms/iter | M | Focal–eye ambiguity on far-only scenes. Require inlier spread (≥3 quadrants, ≥2 distance bands) and holdout gain |
| **Render → re-match → re-solve** (AdHoP) at the refined pose, tiled incl. corners and lower frame | OrthoLoC AdHoP: +30% matches, up to −63% translation error | method; LightGlue Apache, ALIKED BSD, LoMa (cleared) | 10–30 s on local service, opt-in | M | Season and snow gap; GPU lock contention |
| **Return matcher inliers** (`inliers[]` with u, v, ur, vr, xyz) | `MatchResult` returns statistics only | own | +0 s | S | Only when the service runs |
| **Semantic masking of DEM-lifted matches** (drop building/forest/water/glacier) | AeroMap3D: success 88.2→95.7%, mean error 16.2→14.1 m | idea; OSM ODbL | negligible | S | Too few inliers left in villages |
| Near-ground depth-to-DEM ICP for eye translation (MoGe-2 range ≤ 40–60 m) | MoGe ratio ≈ 1 at 15–30 m; eyes REPORT bounds the 7059/7063 baseline to <1 m | MIT / Apache | ~1 s service + <50 ms | M | Little near terrain in many photos; scale trades off against dU |
| Featuremetric keypoint refinement (PixSfM) | ~2–4 → ~1 px per match; untested on DEM renders | Apache-2.0 | 1–2 s service | M | Cross-modal drift; later |
| Lines (DeepLSD + GlueStick/LightGlueStick) for villages | Untested cross-modal; lines rare in nature | MIT/Apache | ~1 s | M | Low value outside settlements; later |
| Reflection-mirrored skyline (calm lakes) | Idea-level; common in the Lake Thun set | own | cheap | M | Calm water only; later |

### 3.3 Residual (non-rigid) overlay field

| Technique | Evidence | Licence | Runtime | Effort | Risk |
|---|---|---|---|---|---|
| **Pull-warp texture in both composites** (render-space reads at `vUv + W(vUv)`; photo-space reads unchanged) + CPU inverse | Every overlay goes through one composite UV; LOOK_REFINE is a precedent; iOS lacks float-linear filtering, so use RGBA8 with 16-bit fixed point and manual bilinear filtering | own | +1 fetch/px; inverse <5 ms | M | Touches `engine.ts` / `deck` (other owners); parity; style-baseline must stay exact when off |
| **Depth-guided GP / least-squares collocation** (kernel over u, v, log range) with posterior σ and hard bound | Classical photogrammetric residual interpolation; σ is free | own | 10–50 ms (≤1000 samples) | M | Over-smoothing; kernel tuned on the dev split only |
| Regularised TPS baseline / fast bilateral solver (log-range guide) | Barron & Poole FBS; OpenCV contrib | own / Apache | <20 ms | S–M | Same |
| Mesh warp (CPW/ARAP/MeshFlow) | Fold-free; better for pano seams | own | <10 ms | M | Duplicates GP; pick after the LOO study |
| Dense flow photo ↔ ortho render (SEA-RAFT, NeuFlow v2, WAFT, MegaFlow) | No cross-modal benchmark; trained same-modality | BSD-3/Apache code; weights trained on KITTI-derived data [U]; WAFT-DINOv3 has a custom licence | 0.3–1 s service [U] | L | Confident garbage in snow and haze. Phase 2, dev experiment only |
| Uncertainty map (UT19 propagation of the LM covariance + DEM σ) | PFG 2025: UT19 within 14.1% of Monte Carlo; silhouette masks recall 85–93% | method | 10–50 ms | S | Covariance under-estimated; inflate by effective sample size |

Honesty conclusion from the product survey: no AR or overlay product (Google VPS, PeakVisor, PeakFinder, PeakLens) warps overlays non-rigidly. A residual warp would be novel, so it must be display-only, bounded, σ-faded and labelled.

### 3.4 Semantic / vector concordance

| Technique | Evidence | Licence | Runtime | Effort | Risk |
|---|---|---|---|---|---|
| Map-class render (swisstopo Light Base Map MVT: ice, rock, wood, water, buildings with render_height; OSM or ESA WorldCover fallback); offline via the xyz cache | Brejcha 2018: semantics + edges beat edges alone; GeoPose3K renders labels | OGD; ODbL; CC-BY-4.0 | <10 ms pass | M | CORS on vectortiles.geo.admin.ch [U]; map dates; snow |
| Photo segmenter: Talk2DINO (DINOv2 + precomputed CLIP text) or EoMT ViT-S/B | EoMT CVPR'25 (MIT code); Talk2DINO ICCV'25 Apache | Talk2DINO cleanest; EoMT heads trained on ADE20K inherit NC dataset terms [legal check]; SAM 3 service only (custom licence, 889 MB browser build) | 100–400 ms WebGPU [U] | M | Alpine domain gap; snow/glacier/cloud |
| Semantic soft-IoU / three-state score (verifier + per-region disagreement map) | SASGeo R@1 94.5% vs 58.6%; tm experiment #7 | own | <10 ms | S | Few hard negatives |
| Semantics-aware skyline (canopy/building height on horizon cells in forest or buildings) | Furggelenstock "+4 px for trees"; 6958 crests 5–7 px | own | per sample | S | Canopy height varies; touches `horizon-fast` (other owner) |
| Trail/shoreline vector snapping (DP along the normal, ≤10–15 m metric bound) | Conflation literature; OSM trails off 5–20 m | own | 1–5 ms/trail | M | Snaps to streams or fences; show as "snapped" |
| Building/village anchors (extruded footprints) | AeroMap3D | ODbL/OGD | browser | M | Repeating chalets |
| Skip: OrienterNet, OSMLoc, MapLocNet, SNAP | BEV street-level; NC or unlicensed | — | — | — | — |

### 3.5 Near-field / depth / occlusion

| Technique | Evidence | Licence | Runtime | Effort | Risk |
|---|---|---|---|---|---|
| **swissSURFACE3D + swissALTI3D COG streaming** (2 m level via geotiff.js; nDSM = DSM − DTM) | STAC items checked; `Access-Control-Allow-Origin: *`; 512² internal tiles; no disk | swisstopo OGD (attribution); geotiff.js MIT | ~1–4 MB per 2 km radius | M | Epoch mismatch (2024 vs 2019/2025); Swiss only |
| **Occluder range texture in photo space** (min of DEM, DSM, anchored objects, people) for trails, contours, labels and drape visibility | Trails are occluded by terrain depth only today; `materials.ts:474` is DEM-only | own | negligible | M | Monocular depth at 100–300 m unreliable. Dim rather than hide |
| CHMv2 canopy + OSM building heights outside CH, aware of the tile source (GLO-30 is already a DSM) | CHMv2 R² 0.86; Mapterhorn `attribution.json` | CC-BY-4.0; ODbL; avoid FABDEM (NC) | 1–3 MB | L | Per-pixel source mask not exposed |
| Segment-wise scale field (generalises `anchor.ts` + `ground.ts`) | MTD 2026; image-adaptive scale fields 2026 | own | <100 ms | M | — |
| DEM-prompted completion (Prior-Depth-Anything **vits only**; MapAnything-apache) | PDA ICLR'26 | Apache (DA-V2 vitb/vitl are NC!) | service; MapAnything 4–5 GB (no download now) | M–L | LingBot-style prompt instability |
| Browser depth (MoGe-2 ViT-S ONNX, DA3-Small) | official MoGe ONNX path | MIT / Apache | 0.3–1 s [U]; 70–140 MB | M | ViT-S range compression |
| Skip in product: Depth Pro (apple-amlr), UniDepthV2 (NC-SA), Metric3D v2 (NC) | — | — | — | — | — |

### 3.6 Photometric / sun

| Technique | Evidence | Licence | Runtime | Effort | Risk |
|---|---|---|---|---|---|
| Sunlit shading and cast-shadow render-and-compare (NMI + terminator chamfer) as interior verifier; ±12 h time-offset search flags timezone errors | Corsini 2009 MI registration; shadow-based image-to-model registration; the relief field already exists (CPU + WGSL) | own | ~10 ms + a few 100 ms search | M | Canopy and cloud shadows; Smart HDR tone mapping (use a rank-based metric if needed); clear-sky share unknown |
| Per-photo snowline fit (replaces hard-coded 2900 m) | `ramps.ts` hard-codes it | own | <20 ms | S | Limestone and cloud confusion; run only after pose accept |
| Range-aware dehaze for matcher input; per-column airlight; haze residual at ridge-behind-ridge edges | Dehaze +2/30 ALIKED already measured | own | +10–20 ms | S | Noise at t < 0.2 |
| De-shaded/re-lit swissimage + sliced-OT class-aware transfer | Pitié IDT; Bonneel sliced OT | own; OGD | 5–15 ms | M | Clipped ortho shadows |
| Guided-filter local affine transfer; residual as concordance map | He et al.; already in repo | own | ~5 ms | S | Can hide misregistration; report before/after |
| Copernicus snow cover (FSC/GFSC) layer; Sentinel-2 same-season drape | Open data | Copernicus free (avoid EOX s2cloudless NC) | small fetch | M | CORS [U]; cloud gaps |
| Skip: Careaga intrinsics (academic), IC-Light V2 (NC), Harmonizer/SkyAR (NC-SA), DiffHarmony (no licence), Cosmos (7B). Only PCT-Net (MPL-2.0) is clean. | — | — | — | — | — |

---

## 4. Work packages (2026-09-29)

The 2026-09-29 plan split the build into seven flagged packages: WP-A foundation (extended camera `CameraX`, cue and field types, interior pin set, LOO evaluation harness), WP-B eye and intrinsics priors (altitude contour, near DEM, LensModel focal table), WP-C interior cues (occluding contours, waterlines, shorelines), WP-D joint whole-frame solver with a gate, WP-E display residual warp, WP-F DSM streaming and occluder range, WP-G matcher inliers and render → re-match. The WP-A types were frozen on day 0 and still define `src/lib/concord/core/types.ts` and `cues/types.ts`; the full package specs are in git (`git show 9e011141:reports/concordance-research.md`, §4). Outcomes are in §7.

**Phase 2 backlog** (none started): map-class render + a permissive segmenter + semantic IoU; shading NMI and time check; snowline fit; trail snapping; CHMv2 outside CH; no-EXIF GeoCalib/AnyCalib priors; a k1 calibration study; panorama camera model.

## 5. What not to do

- **Don't warp to hide pose error.**
  - No warp at LOW confidence; that is the wc_0069 trap.
  - No warp in the pose confidence, the verifier or the benchmarks.
  - No warp in exported pose/XMP/KML "measurement" outputs.
  - Label it display-only and "snapped".
- **Don't claim a gain from 14 photos with in-sample pins.**
  - Every accuracy number is LOO on dev pins, or on the frozen holdout photos, reported once.
  - Don't tune kernel lengths, σ or gate thresholds on holdout.
  - Pins are clicked blind to overlays.
- **GT may be stale.** `ground-truth.json` `demGround` (Terrarium-era) differs from current Mapterhorn by up to 81 m. Re-derive eye ground for evaluation and report the delta. Do not "fix" a GT file owned by another session.
- **Don't free k1, principal point and eye together** without corner and near-field cues (OrthoLoC focal/translation ambiguity). The principal point stays centred unless the photo is cropped.
- **Don't change `camera/index.ts` `Pose`** or the ~40 camera-model sites now. Wrap with `CameraX` and keep identity bit-exact.
- **Evaluation budget:** never touch sealed `data_v3` or the spent wild test set. Shadow-terminator or refine changes that affect the accept rule need their own prereg, as in `reports/v3-prereg.md`.
- **Licence traps:**
  - OrthoLoC code and data (CC BY-NC-SA): method only.
  - EPO (NOASSERTION): re-implement.
  - UniDepth/UniK3D and Metric3D v2: NC.
  - Depth Pro: apple-amlr.
  - Perspective Fields: Adobe NC.
  - SegFormer: NVIDIA NC.
  - EoMT heads trained on ADE20K: dataset terms; check before shipping.
  - DA-V2 vitb/vitl inside Prior-Depth-Anything: NC; use vits only.
  - MapAnything: the default weights are NC; use map-anything-apache.
  - RoMa-Ω: CC BY-SA.
  - DINOv3: custom licence.
  - FABDEM: NC.
  - EOX s2cloudless: NC-SA.
  - IC-Light V2, Harmonizer, SkyAR and Careaga intrinsics: NC or academic.
  - SGI2016 and BAFU terms are unverified; prefer RGI7 (CC-BY).
- **Disk:** no downloads in this phase. DSM is streamed per photo, not bulk-tiled. MapAnything, DA3-Large and SAM 3 are deferred.
- **Don't adopt OrienterNet-family BEV localisers** or single-image calibrators for EXIF photos; they are worse than EXIF.
- **Shared code:** renderer, `horizon-fast`, `align.ts` and matcher edits stay small, flagged hooks, a no-op when off.
- **Don't trust confident flow or cross-modal matches in snow or haze** without forward-backward checks, bounds and LOO gating.

---

## 6. Sources

**Registration, calibration, monoplotting**
- OrthoLoC: arxiv.org/html/2509.18350v2; github.com/deepscenario/OrthoLoC
- Mikolka-Flöry thesis (TU Wien 2026): repositum.tuwien.at/bitstream/20.500.12708/227604/1/…
- ISPRS OJ 2022 horizon orientation: sciencedirect.com/science/article/pii/S2667393222000151
- PFG 2025 monoplotting uncertainty: link.springer.com/article/10.1007/s41064-025-00359-6
- IJGIS 2021: tandfonline.com/doi/full/10.1080/13658816.2021.1871910
- Stockdale 2015 (WSL): erichiggs.ca/…/applied_geography_2015_stockdale.pdf
- MIAS QGIS 2024: onlinelibrary.wiley.com/doi/full/10.1111/tgis.13229
- Other monoplotting papers: sciencedirect.com/science/article/pii/S0098300425000652; …/S0198971524001030
- EPO: arxiv.org/html/2607.00579
- Render-and-Compare: arxiv.org/abs/2302.06287
- GeoCalib: github.com/cvg/GeoCalib; arxiv.org/html/2409.06704v2
- AnyCalib: arxiv.org/abs/2503.12701; github.com/javrtg/AnyCalib
- DiffCalib: github.com/zjutcvg/DiffCalib
- PerspectiveFields: github.com/jinlinyi/PerspectiveFields
- UniDepth: github.com/lpiccinelli-eth/UniDepth; UniK3D: arxiv.org/html/2503.16591v1
- Apple lens distortion: developer.apple.com/forums/thread/775111; developer.apple.com/documentation/avfoundation/avcameracalibrationdata/lensdistortionlookuptable
- iPhone ultrawide lens correction: ios.gadgethacks.com (ultra-wide lens correction)
- Hugin cylindrical: hugin.sourceforge.io/docs/manual/Cylindrical.html
- LTM: arxiv.org/html/2607.08711v1
- Differentiable heightfield rendering: dgp.toronto.edu/~hsuehtil/pdf/diff_hpt.pdf

**Matching, flow, warps**
- RoMa v2: arxiv.org/abs/2511.15706; github.com/Parskatt/romav2
- RoMa-Ω: arxiv.org/abs/2609.09507
- PoseLib: github.com/PoseLib/PoseLib
- XoFTR: github.com/OnderT/XoFTR; MINIMA: github.com/LSXI7/MINIMA
- DeepLSD: github.com/cvg/DeepLSD; GlueStick: github.com/cvg/GlueStick
- LightGlueStick: arxiv.org/pdf/2510.16438; github.com/aubingazhib/LightGlueStick
- LIMAP: github.com/cvg/limap
- Pixel-Perfect SfM: arxiv.org/abs/2108.08291; github.com/cvg/pixel-perfect-sfm; PixLoc: github.com/cvg/pixloc
- MapAnything: github.com/facebookresearch/map-anything; huggingface.co/facebook/map-anything-apache
- SEA-RAFT: github.com/princeton-vl/SEA-RAFT; arxiv.org/html/2405.14793v1; github.com/Kololu777/onnx-sea-raft
- WAFT: github.com/princeton-vl/WAFT; arxiv.org/abs/2506.21526
- MegaFlow: arxiv.org/abs/2603.25739; github.com/cvg/megaflow
- NeuFlow v2: arxiv.org/abs/2503.14880; github.com/neufieldrobotics/NeuFlow_v2; github.com/ibaiGorordo/ONNX-NeuFlowV2-Optical-Flow
- Other flow and matching papers: arxiv.org/pdf/2509.05297; arxiv.org/pdf/2509.24423; arxiv.org/html/2604.05689; arxiv.org/pdf/2401.13432
- UFM: github.com/UniFlowMatch/UFM; MatchAnything: github.com/zju3dv/MatchAnything
- UDIS2: github.com/nie-lang/UDIS2
- APAP: cs.adelaide.edu.au/~tjchin/apap/; Zaragoza CVPR 2013 PDF; github.com/EadCat/APAP-Image-Stitching
- MeshFlow: link.springer.com/chapter/10.1007/978-3-319-46466-4_48
- Content-preserving warps: history.siggraph.org (content-preserving warps)
- Fast bilateral solver: arxiv.org/pdf/1511.03296; github.com/kuan-wang/The_Bilateral_Solver
- optical-flow-web: github.com/Volcomix/optical-flow-web

**AR products**
- developers.google.com/ar/develop/geospatial; …/c/geospatial/anchors; …/c/geospatial/streetscape-geometry
- peakvisor.com/android_tutorial_en.html; peakfinder.com/mobile/manual/
- play.google.com/store/apps/details?id=com.peaklens.ar

**Semantics / vector**
- AeroMap3D: arxiv.org/pdf/2607.14009; SASGeo: arxiv.org/pdf/2607.07737
- SemCityLoc: arxiv.org/pdf/2606.27444
- Water IoU vs shoreline: doi.org/10.3390/geomatics6010021
- EoMT: github.com/tue-mps/eomt; huggingface.co/docs/transformers/model_doc/eomt_dinov3
- DINOv3: github.com/facebookresearch/dinov3; Talk2DINO: github.com/lorebianchi98/Talk2DINO
- EfficientSAM3: github.com/SimonZeng7108/efficientsam3; SAM 3 browser: huggingface.co/rusen/sam3-browser-int8; github.com/wkentaro/sam3-onnx; SAM 3 in Transformers: huggingface.co/docs/transformers/en/model_doc/sam3
- EdgeSAM: github.com/chongzhou96/EdgeSAM; EfficientSAM: github.com/yformer/EfficientSAM; Grounded-SAM-2: github.com/IDEA-Research/Grounded-SAM-2
- OneFormer: github.com/SHI-Labs/OneFormer; ADE20K: github.com/CSAILVision/ADE20K
- Semantic orientation (Brejcha): cphoto.fit.vutbr.cz/semantic-orientation/
- OSM re-localisation: arxiv.org/html/2603.01613v1; OSMLoc: arxiv.org/abs/2411.08665; github.com/WHU-USI3DV/OSMLoc
- SNAP: github.com/google-research/snap; OrienterNet: github.com/facebookresearch/OrienterNet; arxiv.org/abs/2603.19531
- swisstopo Light Base Map: docs.maptiler.com/schema/ch-swisstopo-lbm/; swisstopo.admin.ch/de/webkarten-light-base-map
- swissTLM3D: opendata.swiss/de/dataset/swisstlm3d; ESA WorldCover: worldcover2021.esa.int
- GLAMOS / SGI2016: glamos.ch/en/downloads; doi.glamos.ch/data/inventory/inventory_sgi2016_r2020.html
- BAFU hydrodaten: hydrodaten.admin.ch/de/seen-und-fluesse/stationen-und-daten/2093
- PRACTISE: gmd.copernicus.org/articles/9/307/2016/; hydrology time-lapse: frontiersin.org/…/feart.2023.960363/full; tc.copernicus.org/articles/18/3807/2024/
- Water reflection: arxiv.org/pdf/1906.10284
- GOOSE: github.com/FraunhoferIOSB/goose_dataset
- Other semantic papers: arxiv.org/pdf/1805.04949; Sem-iNeRF: sciopen.com/article/10.26599/CVM.2025.9450404

**Near-field / DSM / depth**
- swissSURFACE3D: data.geo.admin.ch/api/stac/v0.9/collections/ch.swisstopo.swisssurface3d-raster/items; swisstopo.admin.ch/en/height-model-swisssurface3d; opendata.swiss/en/dataset/swisssurface3d-raster-…
- swissBUILDINGS3D: swisstopo.admin.ch/en/landscape-model-swissbuildings3d-3-0-beta
- NFI vegetation height: envidat.ch/dataset/vegetation-height-model-nfi
- Meta/WRI canopy height: registry.opendata.aws/dataforgood-fb-forestsv2/; ai.meta.com/blog/world-resources-institute-dino-canopy-height-maps-v2/; huggingface.co/papers/2603.06382
- ETH global canopy height: langnico.github.io/globalcanopyheight/
- Mapterhorn: download.mapterhorn.com/attribution.json; spatialists.ch/posts/2025/09/02-mapterhorn-terrain-tiles/
- GEDTM30: pmc.ncbi.nlm.nih.gov/articles/PMC12296579/
- Depth Pro: github.com/apple/ml-depth-pro; huggingface.co/apple/DepthPro; arxiv.org/abs/2410.02073v2
- MoGe-2: arxiv.org/pdf/2507.02546; MoGe-3: arxiv.org/html/2607.17967v2; MoGe ONNX: github.com/microsoft/MoGe/blob/main/docs/onnx.md
- Prior-Depth-Anything: github.com/SpatialVision/Prior-Depth-Anything; arxiv.org/abs/2505.10565
- Marigold-DC: github.com/prs-eth/Marigold-DC
- MTD: arxiv.org/abs/2605.11578; image-adaptive scale fields: arxiv.org/abs/2605.07418
- TanDepth: arxiv.org/abs/2409.05142; ground-plane scale: arxiv.org/abs/1903.00912; arxiv.org/abs/2009.03787
- Depth Anything 3: arxiv.org/html/2511.10647v1; huggingface.co/depth-anything/DA3METRIC-LARGE; github.com/devin-lai/Depth-Anything-3-Onnx
- UniDepth: github.com/lpiccinelli-eth/unidepth; Metric3D: github.com/YvanYin/Metric3D/blob/main/LICENSE
- Apple altitude: developer.apple.com/documentation/corelocation/cllocation/ellipsoidalaltitude; developer.apple.com/forums/thread/125281

**Photometric**
- Corsini 2009 MI registration: vcgdata.isti.cnr.it/Publications/2009/CDPS09/Corsini_etal_Mutual_Information.pdf
- Shadow-based image-to-model registration: lacuna.tiptreesystems.com (shadow-based image-to-model registration)
- Wehrwein 3DV 2015: cs.cornell.edu/projects/shadows/files/wehrwein_3dv15_shadows.pdf
- Photo Sundial (ResearchGate)
- Glacier elevation change from shadows: tc.copernicus.org/articles/17/3535/2023/
- Copernicus snow: land.copernicus.eu/api/en/products/snow/fractional-snow-cover; land.copernicus.eu/en/products/snow/high-resolution-gap-filled-fractional-snow-cover; custom-scripts.sentinel-hub.com/custom-scripts/copernicus_services/hrsi/
- Theia snow: essd.copernicus.org/articles/11/493/2019/; Swiss snow time series: nature.com/articles/s41597-025-04961-6
- Snow from public photos: arxiv.org/pdf/1508.01055
- Sentinel-2 COGs: registry.opendata.aws/sentinel-2-l2a-cogs/; element84.com/earth-search/; eox.at/2025/03/sentinel-2-cloudless-2024/
- swissimage: swisstopo.admin.ch/en/orthoimage-swissimage-10; geocat.ch record 3f340030-…
- Glacier data: frontiersin.org/…/feart.2021.704189/full; tc.copernicus.org/articles/16/3249/2022/; RGI 7.0: nsidc.org/data/nsidc-0770/versions/7
- MKL-Harmonizer: arxiv.org/abs/2511.12785; other harmonisation papers: arxiv.org/pdf/2508.12519; dl.acm.org/citation.cfm?id=3323021; arxiv.org/pdf/2306.07176; SUNDIAL: arxiv.org/pdf/2312.16215
- Intrinsic: github.com/compphoto/Intrinsic; arxiv.org/abs/2409.13690
- IC-Light: github.com/lllyasviel/IC-Light (+ discussions/98)
- Diffusion renderer: github.com/nv-tlabs/diffusion-renderer; arxiv.org/pdf/2501.18590
- DiffHarmony: github.com/nicecv/DiffHarmony; Harmonizer: github.com/ZHKKKe/Harmonizer; PCT-Net: github.com/rakutentech/PCT-Net-Image-Harmonization; SkyAR: github.com/jiupinjia/SkyAR
- LUT nets: github.com/WontaeaeKim/LUTwithBGrid; huggingface.co/razordvrz/LUTwithBGrid-ONNX; github.com/HuiZeng/Image-Adaptive-3DLUT
- OpSeg: github.com/deyang2000/OpSeg; arxiv.org/pdf/2305.11513; github.com/bcmi/Awesome-Image-Harmonization
- SunCalc: github.com/mourner/suncalc
---

## 7. Results of the build (2026-09-29, same day)

Seven packages were built in parallel by workflow agents. An integration agent then added the flagged hooks, and an adversarial reviewer fixed one bug and scored the holdout photos once. Per-package detail is in `tools/concord/<pkg>/RESULT.txt`; the review and holdout table are in `tools/concord/review/RESULT.txt`.

| WP | Built | Verdict |
|---|---|---|
| A: harness | `src/lib/concord/core`, `scripts/concord/eval.ts`, split frozen 10 dev / 4 holdout (6019, 6958, 7086, 7130), 96 candidate landmarks | Infrastructure. The audit pin table reproduces bit-exactly. (The "≈ 4.9 px < 6.5 km" in §1 was mislabelled; the right figure is 3.74 px.) |
| B: priors | Focal table, eye prior | **Focal table positive**: holdout 1.99% → 0.32% (n = 2). **Altitude eye rule negative**: holdout median 12.0 → 13.4 px |
| C: cues | Contours, edge distance transform, waterlines | 74% sign agreement (bar 75%). At the GT pose, photo ridges sit 1.5–2.7 px beyond DEM silhouettes, consistent with canopy and DEM smoothing |
| D: joint solve | LM over rotation, focal and eye, with a gate | **Negative, unsafe as gated.** Holdout median 8.8 → 16.2 px. The gate's cue checks reuse the cues the solve fitted. Not wired into the app |
| E: warp | GP/TPS field, GLSL hook in both renderers | No gain (holdout 0 better / 8 worse). Wired behind `?concord=warp` but parked |
| F: DSM occluder | Own COG reader for swissSURFACE3D/swissALTI3D, occluder mask | **Positive (dev):** smear removal 46–59% vs 4–15%. Wired behind `?concord=occl` |
| G: re-match | Python service (removed) | Adds inliers (e.g. 78 → 215 in the lower half of 7086) but fails its acceptance as written |

**Review fix:** waterline pins had ray-marched into the flat lake surface instead of reaching the far shore, which made them score about 0 px at GT by construction. This is fixed in `scripts/concord/lib.ts`. A side finding: 6958's GT eye sits below the lake surface.

**What this teaches:**
1. The interior error is real (§1), but the existing pins are mostly peaks at the GT pose, which was fitted to them. Nothing can be proven or tuned without the blind interior pins.
2. A joint eye solve has enough freedom to trade eye position against rotation and still improve the skyline. Any gate has to score on held-out geometry that the fit never saw.
3. The wins that need no pins are the metadata and near-field data: the focal table and the swissSURFACE3D occluder.

**Next (open 2026-10-02):**
1. The owner clicks the interior pins (`tools/concord/pins/PROTOCOL.txt`); nothing below can be scored without them.
2. Re-score C on those pins; D and E only after restoring them from `a1845f5`, and D only with a gate that accepts on held-out pins or independent matcher points.
3. Decide whether the focal table becomes the default camera prior; today it applies only under `?concord=eye` (`src/lib/photos.ts getPhoto`).
4. Wire the C4 hooks: label renderers hide or dim `occludedLabels`, the deck / deck-webgpu drape layers skip `drapeMaskFromOccluder` pixels, PhotoWorkspace passes peak anchors to `runConcordDisplay`.
