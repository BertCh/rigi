# What didn't work

*Consolidated 2026-09-29; updated 2026-10-01. One line per experiment: what was tried, the key numbers, and why it was dropped. Follow the source for detail. "Removed" sources were deleted in the 2026-09-29 doc consolidation; to read one, run `git show 384df44:<path>`. The code of killed experiments was deleted on 2026-09-30; rows marked "Code removed" say where to recover it, and [the list at the end](#code-removed-in-the-2026-09-30-cleanup) has every removed path.*

Don't re-run anything here without a new reason. Most entries were measured on small dev sets, so "dropped" means "not worth it at current evidence", not "impossible".

## Registration: app pipeline

| Tried | Result | Source |
|---|---|---|
| luma `GPUFFT1D` for the refine yaw correlation (LF5, 2026-10-01) | Not adopted: capped at 2048 points while the yaw grid is 8192; all FFT work in one `globalInit` is 5.8 ms on the CPU (f64); a 7×2048 GPU batch with readback (0.5–1.2 ms) is slower than the CPU (0.36 ms); luma's own impulse oracle failed on Dawn 0.3. Revisit only with a 4-step decomposition and a measured need | `scripts/gpu/fft-gpgpu-dawn.ts` |
| luma `GPUVirtualGeometrySelection` / `GPUScene` for terrain LOD (LF5, 2026-10-01) | Design note only: needs a complete static hierarchy, our tile stream is sparse and streamed; the cull gains nothing at 350–390 tiles | `research_notes/luma-frontier-2026-10-01/virtual-geometry-vs-terrain-cull.md` |
| `?pipeline=` variants `cascade` / `skyfirst` / `wide` vs `current` | cascade median 0.228→0.376°; skyfirst +0.084° and t-final 11.2 s; wide identical. Variants and `pose-policy.ts` removed | [pipeline-ab.md](pipeline-ab.md) |
| Agreement gates (2-of-3 methods) | None beat cascade alone; 2.3× cost, +1 escalation | [leaderboard.md](leaderboard.md) |
| Raising the app auto-align confidence bar | Didn't fix IMG_7130 | leaderboard.md |
| CPU ONNX sky mask + solvePose | False accept IMG_7053 at −5.61°; full U²-Net (176 MB) no better | leaderboard.md, `src/lib/sky/README.md` |
| Cascade on Terrarium DEM | 14 correct vs 25 on Mapterhorn (wild set) | [bench-wild.md](bench-wild.md) |
| 360° cascade at the 0.5 bar | IMG_7053 false accept at −123.7°; margin rule recovered 0 photos. Hence the 0.75 unknown-yaw bar | [bench-ablation.md](bench-ablation.md) |
| App auto-align with no heading | 3/11 correct, 7 false accepts | [bench-ablation.md](bench-ablation.md) |
| Looser accept rule HIGH ∧ (EXIF ∨ gap ≥ 0.20) | 22/34 recall, not adopted | rigi_internal_audit.md (removed) |
| VSWEEP: pitch-only vertical pass after the yaw sweep, on matched skyline peaks (2026-10-01) | KILLED as registered: peak arm fires on only 2–5 of 14 GT photos (1–8 peaks per frame) and moves the median ≤ 0.04° (GT noise 0.2–0.4°); dense vertical sweep not clean either (1–2 photos worse > 0.15° on Terrarium). It recovers a ±1° pitch start error but also dragged IMG_7068 0.7–0.9° wrong. Code kept in `scripts/vsweep` | [tools/research/vsweep/REPORT.md](../tools/research/vsweep/REPORT.md) |

## Registration: render-and-match and fusion

| Tried | Result | Source |
|---|---|---|
| Hillshade renders for matching | ALIKED 8/11, DISK 5/11; 6-DoF off by up to 145°; sat+hill blend only +8%. Satellite renders kept | matcher.md (removed), [stage1.md](stage1.md) |
| 6-DoF PnP / P4Pf instead of rotation-only | Worse pitch (0.22–0.42° vs 0.07°), spurious centre shifts | matcher.md (removed) |
| RoMa v1, DISK | RoMa 25–40 s/pair, no better; DISK 10.4° miss, 19/24 at oracle | matcher.md (removed), stage1.md |
| Fusion variants (λ sweep, per-direction residuals, adaptive σ) | Flat over λ 0.25–4; per-direction drifted tens of degrees; adaptive σ picked wrong poses | [fusion.md](fusion.md) |
| LightGlue on Apple MPS | Nondeterministic (0/2/13 matches); moved to CPU | [archive/matcher-service.md](archive/matcher-service.md) |
| SWEEP_KP 2048 | wc_0009, wc_0006 go wrong for negligible time; reverted to 4096 | archive/matcher-service.md |
| 360° drape to 120 km | 90 s cold page; capped at 40 km | [bench-ablation.md](bench-ablation.md) |
| Render-match at hfov ≲ 10° | 0–10 inliers, always LOW | [bench-ablation.md](bench-ablation.md) |
| T5 pose6 position refinement (test arm C) | No near-miss converted; HIGH precision 0.56 vs 0.85 target; false HIGH wc_0019 (support inflated 0.13→0.73); test recall 9 vs 11. Stays opt-in | position.md (removed), [test-results.md](test-results.md) |
| Skyline-only basin gap, coarser grid | Separates worse; gap 0.21→0.12 | position.md (removed) |
| T6 two-stage as default (test arm B) | 30/50 but HIGH 22/24; wc_0038 wrong post hoc → EXIF HIGH precision 0.90. v034 stays default | [test-addendum.md](test-addendum.md) |
| T6 same-basin selection swap | GT median yaw 0.146→0.196°; not applied | stage1.md |
| Skyline global search as a candidate generator | 2 picks, 1 correct | stage1.md |

## Registration: matching v2 and the terrain-matching (TM) programme

| Tried | Result | Source |
|---|---|---|
| Eye-position fallback | 0 correct HIGH, 1 gross (wc_0086), 196 s vs 85 s; 15/30 photos have zero support at any eye. Suggestion only | [matching-v2.md](matching-v2.md) |
| Skyline score / sweep support as an eye locator | True eye ranks 43rd of 113; a wrong eye 127 m away wins on wc_0054 | matching-v2.md |
| GeoCalib / AnyCalib gravity + FOV priors | Pitch fan loses 4 hits; snapped fan ≈ 0 s net after 4.7 s cost; roll r = 0.00. Off | `tools/matcher/v2/calib/REPORT.md` |
| LoMa as drop-in matcher | wc_0069 becomes a gross HIGH (19/0 → 18/1), 1.6× slower; CPU 33 s/pair | `tools/matcher/v2/loma/REPORT.md` |
| X1 learned yaw features (DINOv2 column-pooled, DINOv3, ring) | Column-pooled 12 vs 21 hits; DINOv3 worse; 8×45° ring 12/16 | `tools/research/tm/x1_yawcorr/REPORT.md` |
| X2 monocular depth as prior or veto | FOV off +20.7° (MoGe) / 7.4° (DA3) vs 0.55° EXIF; DA3 false-vetoes 2/19; blind to near-miss eyes | `tools/research/tm/x2_geom/REPORT.md` |
| X3 render modalities (snow, haze, normals, edges; XoFTR-on-depth) | No gain; edges fail with every matcher; XoFTR loses 5 successes. MatchAnything, MASt3R, RoMa v2, MINIMA-LG ruled out on licence | `tools/research/tm/x3_modality/REPORT.md` |
| X4 branch-and-bound skyline search | 20 vs 23 top-4 hits, 2–5× slower; certified gap useless | `tools/research/tm/x4_bnb/REPORT.md` |
| X5 learned negative-evidence verifier | Hard-wrong AUROC 0.40–0.69; vetoes kill 3–19 correct HIGHs | `tools/research/tm/x5_verifier/REPORT.txt` |
| P1 title-geocode position triage | Precision 0.25, recall 0.33, flags 6/30 solved photos | `tools/research/tm/p1_position/REPORT.txt` |
| H1 S5 masked-basin rerun (negative mining) | Stage-2 fan pulls seeds back to the true basin; only 3 negatives | `tools/research/tm/h1_mine/REPORT.txt` |
| v1 verification with Terrarium overlays | Wrong numbers (precision 0.72) and a wrong "GPS parallax" story; protocol rebuilt on Mapterhorn | bench-wild.md |
| FUND E0: predict failures from geometry (FOV/w\* for rotation, Σ(1/d)² eye information) | Killed as pre-registered: AUROC 0.60 / 0.50 (< 0.65). The rotation half is confounded by skyline clipping in the pitch-0 ring cache, so it is untested rather than refuted. ≥ 99.9% of Σ(1/d)² sits below 250 m, so that metric measures the foreground, not the eye | `tools/research/fund/e0_observability/REPORT.txt` |
| FUND E0r: rotation half of E0 re-run with an unclipped horizon-fast 360° skyline (−hfov/w\*, stated eye, floor 0.10°) | Killed as pre-registered: dev AUROC 0.488 (n 16 vs 19, CI 0.29–0.69), < 0.65; no floor 0.05–0.5° reaches 0.65. The E0 clipping confound is removed (w\* = 360 for 0/50, was 14/50) and the group medians collapse (7 vs 8°). Closes the untested caveat of E0 | `tools/research/fund/e0r_rotation/REPORT.txt` |
| FUND E2: date-matched appearance renders (photo-time sun, snow composite, Sentinel-2) | Killed: median inlier gain −0.8% to +0.3% (bar 15%), no separation gain, 30 dev photos. The flat snow tint wipes out rock texture (−31/−52% on 6 snowy photos). Tests this implementation, not snow physics: a texture-preserving, slope-aware tint is untested | `tools/research/fund/e2_appearance/REPORT.txt` |
| FUND E3: hi-res near field (swissALTI3D z17 + DSM + SWISSIMAGE) and a mid-band free-eye solve | Killed on 30 refs: no gain in inliers < 2 km (log2 +0.10 [−0.34, +0.53]); matches < 250 m almost absent in any render; eye better than GPS on 3/30 (bar 60%). The matcher, not the render, is what fails to see the near field | `tools/research/fund/e3_nearfield/REPORT.txt` |
| FUND E1: a-contrario held-out-cue accept with a per-photo decoy null | Killed: 23/31 recall but 13 gross accepts, 10/56 displaced-eye decoys accepted (ε = 1); ε = 0.01 still 7 gross. 90% of hypotheses score 0, so the null is degenerate; the min over held-out directions zeroes 7/33 correct poses. Best label-tuned threshold: 12/31 at 0 gross (current rule 19/31) | `tools/research/fund/e1_acontrario/REPORT.txt` |
| FUND E4 step 1: dense feature-metric refinement (frozen DINOv2 ViT-B tokens, photo vs offline render, LM over yaw/pitch/roll/f, 3×3 restarts) | Killed on dev: primary median rotation error 0.50° (pipeline start) → 1.70° refined, better on 1/12; Spearman(σ_pred, error) 0.394 over 102 runs (bar 0.4), σ ~200× too small. 10° starts improve (7.4 → 5.3°) but never reach 0.3°; refined cost is below the GT-pose cost in 92% of runs (flat token cost). Eye step not evaluated (needs E3 renders). GT noise 0.2–0.4° | `tools/research/fund/e4_featuremetric/REPORT.txt` |

## Step Inside and near-field 3D

| Tried | Result | Source |
|---|---|---|
| MoGe-2 metric scale for placement | DEM/model ratio 0.98 at 15–30 m, 2.9 at 100–300 m, 6.6 at 0.3–1 km; FOV ×1.56. Replaced by per-photo DEM curve + grounding (0.34→0.13 log error) | `tools/nearfield/spike/{SUMMARY,PLACEMENT}.txt` |
| Single-scale / affine / mode-of-log anchors | 0.217 / 0.11 vs < 0.10 gate; mode-of-log put wc_0076 14× too far | spike/SUMMARY.txt |
| Range-binned and default depth splits | False Object on distant ranges (10/16 clean photos); flags meadows, snow, shores | spike, PLACEMENT |
| Depth-only object split (P1 smear gate ≥ 80%) | 4.4% (three) / 15.0% (deck). Huts, trees at 100–300 m classed Far; nearRadius 300/500 reaches 47% with 3–18% collateral | `tools/nearfield/smear/REPORT.txt` |
| Anchor fit as a pose verifier | AUC 0.73 vs wrong basins, 0.55 at ±2°. Trust label only | [step-inside-results.md](step-inside-results.md) |
| Anchor quality gate ≥ 0.2–0.35 | Removes every object-rich photo; lowered to 0.15 as a label | spike |
| Unifying both renderers on near-DEM z16 | IMG_7059 anchor 0.95 → 0.00 (demo photo regression) | smear/REPORT.txt |
| LingBot-Depth-DC with a DEM prompt | Terrain interpolates well; wc_0020 collapses; raw-metre prompt breaks beyond 50 m; objects within ×1.25: 53% vs 87% grounding | `tools/nearfield/depthprompt/NOTES.txt` |
| P2 multi-view fusion at roll spots (Brush, DA3) | LOO near-field coverage 0–7%; GPS eyes off 7–37 m; floaters. Dropped as a product goal | step-inside-results.md |
| Eye refinement for roll spots | Spec variant passes 0 pairs; metric variant 1 pair, gain confounded with absolute placement. Default off | `tools/nearfield/eyes/REPORT.txt` |
| DA3 /multiview and essential matrix for propagation | DA3 median 3.65°, 43° on non-overlap, no confidence; E-matrix degenerate under rotation (up to 179.9°) | `tools/nearfield/propagate/REPORT.txt` |
| LaMa on large out-of-frame areas (P3) | Smears, ghost backpacks. Thin disocclusions only | `tools/nearfield/generate/NOTES.txt` |
| int4 MoGe-2 ViT-S download (round to nearest, groups of 32, clip search) | ViT linears int4: depth 16% median off fp16, mask IoU down to 0.64; MLPs only: still 16%. int8 per row kept (0.6% after scale alignment) | [step-inside-download.md](step-inside-download.md) |
| Normals from depth instead of MoGe's normal head | ~20° median from the head at 2/4/8 px steps (same for fp16 depth): kept the head in the default q8 file; `q8lite` opt-in | step-inside-download.md |
| Hosted world models (LingBot-World v2, Lyra 2, FlashWorld, HunyuanWorld/Voyager, WorldSplat), VGGT-1B, DA3 GS head | Non-commercial, EU-excluded, or no weights | `research_notes/step_inside_models_2026-09.md` |

## Concordance (whole-image fit)

| Tried | Result | Source |
|---|---|---|
| Display warp field (WP-E: GP/TPS residual field in u, v, log-range, applied to the composite's render-space reads) | 0.00 px LOO gain on existing (mostly > 5 km) pins. Code removed 2026-09-30 (`git show a1845f5:src/lib/concord/field/fit.ts`; the shader hook was `WARP_GLSL` in `field/glsl.ts`) | [concordance-research.md](concordance-research.md) (a parallel workstream) |
| Altitude-contour eye rule | Worse on holdout: median 12.0→13.4 px, p90 18→36. The prior code stays (`src/lib/concord/priors/altitude.ts`, used by the geocam priors); the study script was removed 2026-09-30 (`git show a1845f5:scripts/concord/priors-study.ts`) | `tools/concord/priors/RESULT.txt`, `tools/concord/review/RESULT.txt` |
| Joint whole-frame solve (WP-D: skyline + interior cues + priors, gated) | Holdout median 8.8→16.2 px; 7130's eye moved 200 m (2.9σ) while the skyline improved and the pins went 10→30 px. The gate scores on the cues it fitted, so it can't catch this. From the GT start it drifts 3–6 px off the pin-fitted poses. Never wired into the app. Code removed 2026-09-30 (`git show a1845f5:src/lib/concord/solve/joint.ts`); its cue residuals live on in `src/lib/geocam/map/joint-residual.ts` | `tools/concord/solve/RESULT.txt`, `tools/concord/review/RESULT.txt` |
| Display warp on holdout (`?concord=warp`) | 0 better / 8 worse pins (LOO at the GT pose, 1.20→1.41 px). The flag value is gone; `?concord=warp` now logs "not a valid value". Code removed 2026-09-30 (`git show a1845f5:src/lib/concord/app/display.ts`) | `tools/concord/review/RESULT.txt` |
| Render → re-match loop with semantic masking (WP-G, service on :8768) | Inliers up 2.9–15× from iteration 1 to 3 (7086 lower half 78→215), 17–20 s per photo on CPU LightGlue. Fails its acceptance as written: ≥ 25% more lower-half inliers only on 7131 and 7053 (the other 3 have none to gain), ≥ 2 more quadrants on 0/5; the building/forest "lift" overcorrects (dy 0 → −4…−8 px), so "drop" was the default. Its only consumer was the joint solve. Code removed 2026-09-30 (`git show a1845f5:tools/concord/rematch/server.py`, `…:src/lib/concord/match/client.ts`) | `tools/concord/rematch/RESULT.txt` |

## Geometry-first camera (GEO phase A, 2026-09-30)

| Tried | Result | Source |
|---|---|---|
| Free eye from appearance matches (pycolmap with GPS prior, PoseLib 6-DoF, P4Pf, up2p) | Drift 180–270 m at correct poses; σ 14–86× over-confident; flags every decoy and every correct pose (AUROC 0.49) | `tools/research/geo/REPORT_PNP.txt` |
| GA0 matcher inliers returned to the app (`?geoInliers`) | No consumer: nothing read the returned correspondences (GA1 was never wired) and the matcher patch was only proposed (`out/geocam/ga0/matcher-correspondences.patch`). Flag removed 2026-09-30 (`git show a1845f5:src/lib/matcher-client.ts`) | `tools/research/geo/REPORT_GA0.txt` |
| GA2 σ_eye (CRLB) as the eye gate | ρ 0.498 < 0.5; 25% of displaced-eye decoys confidently wrong. Code removed 2026-09-30 (`git show a1845f5:src/lib/geocam/observe/fisher.ts`, `…:scripts/geocam/ga2-eval.ts`) | `tools/research/geo/REPORT_GA2.txt` |
| GA3 occlusion-crossing (T-junction) eye cue | Renders: true-eye argmin 6/6 but a 10–20 m well. Real photos: median improvement −0.83, wrong eye wins 93%; only 6/40 refs eligible. Code removed 2026-09-30 (`git show a1845f5:src/lib/geocam/tjunc/junctions.ts`, `…:scripts/geocam/ga3-common.ts`) | `tools/research/geo/REPORT_GA3.txt` |
| GA4 lake waterline/shore for eye height | Median eye-Z 16.9 m vs 5 m; −4.4 px constant cue bias ≈ 11 m of height at 2–8 km. Code removed 2026-09-30 (`git show a1845f5:src/lib/geocam/lakes/factors.ts`, `…:scripts/geocam/ga4-eval.ts`); the lake floor prior (`lakeFloorFactor`) moved to `src/lib/geocam/map/factors.ts` | `tools/research/geo/REPORT_GA4.txt` |
| GA5 solution-separation integrity as a zero-loss veto | Rejects 12/33 correct poses; wrong-basin AUROC 0.94, wrong-eye 0.83; viewshed veto 2/754. Kept as a veto-panel candidate | `tools/research/geo/REPORT_GA5.txt` |
| GA1 MAP solver σ calibration | Not killed: rotation (err/σ)² 6.0, eye 3.5 vs [0.5, 2]; mostly wrong-basin starts | `tools/research/geo/REPORT_GA1.txt` |
| Skyline parallax as a wrong-eye test (SKYPAR, 2026-10-02) | Killed as pre-registered (dev, n = 787): rejects 2/19 positives the current gate accepts, 21/56 displaced-eye decoys (37.5%), 3/10 E1-NFA-accepted ones (needs 5). χ² uncalibrated (all 14 non-abstained POS exceed it, median 2404), first-order model breaks at 150–400 m vs a 2–4 km ridge, 58% of POS abstain (far-only skyline). Code removed 2026-10-02 (`git show 31752b8:src/lib/geocam/integrity/skyline-parallax.ts`, `…:scripts/geocam/skypar-eval.ts`) | `tools/research/geo/skypar/REPORT.txt`, `research_notes/skyline-parallax-2026-10-02/README.md` |

## GPU and performance

| Tried | Result | Source |
|---|---|---|
| GPU silhouette re-rank | 3–10 ms saved; judged not worth it on 2026-09-28. **Superseded:** the re-rank runs on the GPU since 202f767 (identical scores) | `research_notes/gpu_compute_plan_2026-09.md` |
| GPU horizon for unknown-pose | ~120 ms saved; was opt-in under the 0-false-accept rule until 2026-10-01, now default on (node gate on Dawn: 0 new false or unverified accepts; browser-unverified) | gpu_compute_plan |
| TS port of the skyglobal polish | Flips 3/50 results; stays in numpy | gpu_compute_plan |
| deck: world-camera frustum culling alone (`matrixCuller`, no back-face cull) | World orbit 12.5 / 10.1 / 8.9 → 12.6 / 10.2 / 8.4 fps: fill-bound, not vertex-bound. Kept (cheap) but the gain came from back-face culling + vertex log depth | [deck-default.md](deck-default.md) |
| deck: 16-bit far-tile indices (`index-width.ts`) | Photo drag 27.0 / 21.0 / 20.7 vs 27.0 / 21.3 / 20.7 fps, world orbit identical; kept, harmless (unwired since 422a2c8, deleted 2026-10-02) | deck-default.md |
| deck: aligning on the coarse-first (z ≤ 14) preview | Not accuracy-neutral: wiring the preview into the query terrain moved auto-align yaw by 0.01–0.04° (IMG_6958, 7155, 7018). Coarse-first is display-only; the query terrain, horizon and auto-align wait for the full set | deck-default.md |
| deck colour-pass micro-fixes: MSAA RGBA8 instead of RGBA16F, `invalidateFramebuffer` after resolve, polygon offset off, no `discard`, per-tile instead of batched draws | No change (78.6–84 ms vs 80 ms p50). The cost was MSAA fill plus `gl_FragDepth` and no culling | deck-default.md |
| deck: flight frames swapping only the gizmo (0e206b1) | No fps gain (fly-in 39→40, 38→38): GPU-bound. Kept for CPU | deck-default.md |
| 2026-10-01: luma `heightFog` (#3325) to replace the haze or the haze fit | Not adopted. It is a layered height-fog integral, not our atmosphere model, and nothing in it reproduces the haze-fit quality score (`haze-fit.ts:509-550`). Only the Nebelmeer ray-transmittance is worth porting, as an opt-in layer with density 0 (roadmap `nebelmeer-fog-layer`) | [luma-deck-upstream-2026-10-01.md](luma-deck-upstream-2026-10-01.md) (N13) |
| 2026-10-01: deck #10697 map `roll` to replace PhotoView | Not adopted. The PR is open and PhotoView stays. We only pin `roll: 0` in the Step Inside map-camera LIMITS as a guard | [luma-deck-upstream-2026-10-01.md](luma-deck-upstream-2026-10-01.md) (N13) |
| 2026-10-01: deck `TextLayer` + `collisionGreedy` (#10698) instead of the classic labels | Not adopted. Classic labels must stay pixel-identical (STYLE gate). #10698 and #10750 also conflict on TextLayer. Revisit for roll-map 3D labels only after both land | [luma-deck-upstream-2026-10-01.md](luma-deck-upstream-2026-10-01.md) (N13) |
| 2026-10-01: `makeStrokeGeometry` for trails | Ruled out. Its strokes are planar-XY in local units and can't do draped, screen-width trails. Only pathDash coverage is worth porting (roadmap `trail-pathdash`) | [luma-deck-upstream-2026-10-01.md](luma-deck-upstream-2026-10-01.md) (N13) |
| 2026-10-01: VersaTiles as an Esri imagery replacement | Ruled out. Coverage stops at z12. At most a z ≤ 12 far-field filler | [luma-deck-upstream-2026-10-01.md](luma-deck-upstream-2026-10-01.md) (N13) |
| 2026-10-01: deck `PathLayer` / `PathStyle` (luma-deck upstream) | Not adopted. They live in a private, unpublished `@deck.gl-community/gpu-layers` package, and our trail layers already cover the need | [luma-deck-upstream-2026-10-01.md](luma-deck-upstream-2026-10-01.md) (N13) |
| 2026-10-01: DemStore, decode each DEM tile once per realm (WAG W2.1) | Not landed. Decodes per photo 548 → 547 (IMG_7053) and 595 → 594 (IMG_7131). The plan's "decoded 5+ times" was wrong: 451 distinct tiles, 97 repeats per load. 34 repeats are terrain vs horizon on the page, which an LRU only catches holding nearly every tile (514 decodes at 812 MB heap); 61 are page vs the unknown-pose worker, which needs a protocol change. Horizon latency neutral; heap +30 MB even at a 32 MiB budget | a local archive (not published) (`wp-c-demstore.patch`, `LEDGER.md`) |
| 2026-10-01: horizon march (and eye search) on the page device over resident heights (WAG W3.1 device half, W3.2) | Not built. The worker's directions are ready 970–1977 ms before the engine needs them; the page holds 0 terrain tiles when the march runs and none of the 69–75 needed tiles at native 512 px even later (streamed tiles are downsampled, so never bit-identical). Replaying the job on the page device is bit-identical but costs 140–320 ms of main thread plus frame contention; the worker device itself costs ~2 ms. Eye search is dominated by many small serial batches, which a device move doesn't fix | `scripts/gpu/page-horizon-measure.mjs` (WAG ledger) |
| 2026-10-01: GPU frustum cull + indirect draws for the batched terrain (WAG W1.5) | Byte-identical frames, but no CPU saving at ~350–390 tiles (terrain core 0.15–0.19 vs 0.12–0.14 ms per frame); the graph encode is a flat cost that could pay off only at much larger tile counts. Default on since 3225064 anyway (GPU-first rule, no quality cost) | 6d6160a |
| 2026-10-01: loaders.gl `GeoTIFFSourceLoader` as the default COG reader (WAG W2.5) | Kept opt-in (`?cogReader=loaders`). Windows are bit-identical, but decode is ~10× slower in Node and its 64 KiB header blocks leave fewer tiles under the 4.5 MB occluder budget, so `?concord=occl` differs on 3/4 photos | 9d8a307 |
| 2026-10-01: haze head overflow (W1.4) and the sky worker's 67 ms (W1.7) | Closed without building. Overflow 0/152 observed fits (2.2% simulated on photos with sky ≥ 0.04). The 67 ms is ORT's GPU work landing in the first refine readback (drain 67.7 ms, refine 4.0 ms); no residency change recovers it | `research_notes/whole-app-graph-2026-10-01/baseline-2026-10-01.md` |
| 2026-10-01: certified-f32 GPU fold of the band stats (WAG P1, I9) | Not built. The CPU f64 fold costs 1.9–2.9 µs per settle (plus ~1 µs finalize); the folded `ColorStats` reaches the composite as uniforms through the CPU, so a GPU fold cannot remove the 6.6 KB readback (at best 0.6 KB) and would add a dispatch; stats run on a 120 ms debounced async timer. Revisit only if `ColorStats` becomes GPU-resident | WAG P1 work, [whole-app-graph-plan.md](whole-app-graph-plan.md) |
| 2026-10-01: certified-f32 haze refine and cpuBins on the GPU (WAG P1, D16/D18) | Not built. In the f64 descent 32% (median; min 0.76%) of decisions have relative gaps < 1e-6 and 41% < 1e-5 (12 synthetic fits), so f32 certifies no whole fit; cpuBins are f64 sums of exp/log. Bit-identical CPU shortcuts landed instead (9ab891b) | WAG haze-cert work, [whole-app-graph-plan.md](whole-app-graph-plan.md) |
| 2026-10-01: GPU airlight band (D16), exact integer kernels | Built, bit-identical on 4 photos, not landed: gpuPrep median difference ~−0.1 ms against ±5 ms noise on Apple GPU. Patch not published | WAG haze-cert work, [whole-app-graph-plan.md](whole-app-graph-plan.md) |
| 2026-10-01: GPU Terrarium decode into the height atlas (W2.3, `terrainGpuDecode`) | Landed off. Heights and frames are byte-identical, but synchronous CPU readers (camera height, lake floor, trails, peak snapping) still decode ~50% of query tiles within 8 s, now on the main thread (298–349 ms per photo vs workers today), and the small atlas uploads ~4× the bytes (1.17 vs 0.29 GB over a 7-pose walk). Needs GPU gathers for the hot `heightAt` callers first. **Update:** gathers landed for camera height, trails and peak snapping (7f6f62b, 1e18f79; main-thread decodes at load → 0) and the flag is on by default since 3225064; still open: ~4× upload bytes, load time unmeasured | e686c1c, 4a4000b |
| 2026-10-01: precision gate with a bit-identity rule (f64 vs certified-f32 on the frozen dev split) | Unusable as a rule: the f64 baseline itself differs run to run (7/8 deck and 21/22 WebGPU differing photos are f64-vs-f64 noise). GT-12 12/12 identical in both modes; judged on quality instead, and certified-f32 became the default. A redesign (same-page base and candidate) is open | 3225064, `scripts/gpu/precision-gate.mjs`, CHANGELOG "WAG wave 3" |
| 2026-10-01: readback-free ColorStats on WebGPU (composite reads a storage buffer) | Not built. After the GPU fold the 256 B readback costs nothing measurable (0.44 vs 0.44 ms per call, 1 photo) and it would touch three WGSL harmonize consumers | WAG wave 4 stats-graph |
| 2026-10-01: a GPU indirect condition for the haze head-overflow read | Does not fit: WebGPU copy and map sizes must be known on the CPU, so a GPU gate could only skip work the CPU already skips; the round trip stays | WAG wave 4 haze-graph |
| 2026-10-01: GPU decode writing only the 256 px r32f result to cut the 4× upload bytes | Premise false: the decode already writes only the r32f layer; the 4× is its rgba8 512² input. The duplicate uploads (load-time stats, draw-time decode, re-entry after pans) were removed instead | WAG wave 4 perf-vram |
| 2026-10-01 (LF6): port luma.gl #3340 paged progressive RAD splat selection, or deck #10627 worker SplatLayer, into `deck-webgpu/layers/splats.ts` | Not built, nothing shipped. #3340 changes only `modules/splats` (`gpu-paged-splat-renderer`, `splat-rad-hierarchy`, `splat-residency`), which is not among the vendored rigi.3 packages (core, effects, engine, gpgpu, shadertools, webgl, webgpu). Its selection needs a hierarchical RAD source (parent/child counts, geometric error, paged chunks); Step Inside clouds are flat single-shot lifts (about 39k splats on IMG_7018, 200k to 1M only in stress runs), fully resident, with one fixed camera-driven sort (GPU radix, already no readback). There is no level-of-detail tree to select from, first-frame time is the lift service, not residency, and a port would be a re-implementation of unmerged code with nothing to page. The borrowed-pass `draw()` pattern is already how `splats.ts` works (a GpuLayerCore drawing in the host colour pass via `passModelProps`). Not benchmarked: no module to run it against. Revisit if Step Inside ever serves a streamed or hierarchical splat scene (RAD/LoD files) and #3340 has merged and been vendored | luma.gl PR 3340; deck PR 10627; `reports/luma-frontier-2026-10-01-late.md` |
| 2026-10-02: `?colorTarget=rg11b10` (rg11b10ufloat colour pass, half the colour VRAM) | Unusable as designed: the format has no alpha channel, so the photo overlay turns opaque and the world sky (blended under with one-minus-dst-alpha) never draws; confirmed on Dawn. Plain `rg11b10` now falls back to rgba16float with a warning (bd6cc97); `rg11b10-unsafe` kept for experiments | `research_notes/gpu-pod-d-2026-10-02/g3-batch-checklist.md` |
| 2026-10-02: `@math.gl/proj4` 5.0.0-alpha.10 for LV95/geoid | It is identical to proj4 2.22 (≤ 6e-9 m). Our swisstopo approximate formulas (`concord/occl/swiss-cog.ts`) are within 0.72/0.34 m (E/N) forward and 3.9/2.8 m inverse over 966 Swiss grid points, against the rigorous EPSG:2056 transform. The library costs 18.2 KB min+gzip for the somerc core (50.5 KB full) against about 0.3 KB, is about 20× slower per point, and ships no geoid (CHGeo2004/EGM are caller-supplied), so it cannot replace `tiles3d/geoid.ts`. The only client use is a flagged 2 m DSM occluder, where GPS eye error is 7–37 m. Revisit for rigorous LHN95 heights, a Swiss NTv2 grid, or as a devDependency for the build scripts. Evidence: `swiss-cog.spec.ts` rigorous references; eval script in coordinator D's scratchpad. |
| 2026-10-02: Vendored luma gpgpu catalogue, second sweep | The sweep found no k-means, batched/segmented sort or 2-D FFT site in the app. `GPUConvolution` (zero/wrap boundaries only), `GPUHistogram` (single histogram, no digit-prefix selection), `GPUGroupAggregation` (CAS float sums, so not deterministic), `GPUReduction` (no argmin) and `GPUCompaction` (skyglobal CANDS: 1.5 M scanned to keep about 800; terrain cull: one fused per-frame dispatch over ≤ 390 tiles) fail on numerics or structure. `GPUGather` and `GPUIndexedRangeCompaction` for the haze gathers and haze-band would be bit-exact but low value (open follow-up). |
| 2026-10-02: luma `GPUFFT1D` bit reversal on macOS Dawn (2026-10-02) | The portable bit-reversal pass returns wrong permutations for lengths 2^4, 2^6–2^8, 2^10 and 2^11; 2^1–2^3, 2^5 and 2^9 are correct. A loop-free `reverseBits(v) >> (32 − n)` fixes every length. Do not trust `GPUFFT1D`, `GPUFFT2D` or `GPUConvolution`'s FFT strategy on a device that has not passed a spot check. Evidence: `scratchpad/patches/E/fftprobe.evidence.ts`. |
| 2026-10-02: Reduction primitives for solve COARSE / align pose-grid (2026-10-02): not adopted | These are reductions fused into the producing kernel, with no materialised grid and no consumer for a global extremum. Swapping in a luma reduction would add passes and change no number. |
| 2026-10-02: LF6 amendment (luma #3340 progressive splats) | Amend the LF6 row: superseded 2026-10-02 (coordinator G): #3340 vendored in rigi.6 and adopted by building a synthetic LoD tree (`nearfield/splat-lod.ts`), since the flat clouds have none; the original "nothing to page" observation still holds for typical clouds (one page under 65 536 rows). |
| 2026-10-02: GPU terrain LOD via `GPUVirtualGeometrySelection` (2026-10-02): not built | The streamer's leaf cover leaves nothing to select (`terrain-stream.ts` emit; `selectDemTiles`). It needs resident parents, which cost about 1/3 more tiles. |
| 2026-10-02: Per-pixel `GPUGroupAggregation` band stats: 3–15× slower | (CAS float adds on 4 addresses) and less accurate (2.8e-4). Only the fold over per-workgroup partials is adopted. |
| 2026-10-02: Haze radix-select digit histogram as one `GPUHistogram` (12N keys, 295k bins): exact but about 19× slower per pass | Not adopted. |

## Rejected directions (strategy)

- **Mono depth or single-image splats as the geometry source**: learned single-photo geometry was the weak link in every experiment. Geometry comes from the DEM and pose.
- **World models as a platform**: licences plus a mismatch (plausible ≠ correct). Inverted into "Rigi supplies the 3D cache" (GEN3C test, [roadmap.md](roadmap.md)).
- **Google Photorealistic 3D Tiles as a geometry or measurement source**: confirmed forbidden on 2026-09-29 ([step-inside-google-3d-tiles.md](step-inside-google-3d-tiles.md)).
  - The ToS allows visualisation only: no anchoring, split, readout logging, alignment, ML, exports or persistent cache.
  - EEA billing accounts get a 403.
  - A display-only backdrop remains possible but blocked on the global ToS "with or near a non-Google Map" clause.
  - The same benefits come licence-clean from swisstopo 3D Tiles and the nDSM (roadmap S3, C4).
- **FABDEM, SegFormer, UniDepth, Depth Pro, Perspective Fields**: non-commercial licences.
- **OrienterNet-style BEV localisers**: wrong domain for summit photos.
- **Consumer subscription against PeakVisor, racing AI identifier apps, Strava/Komoot feeds, law-enforcement sales**: avoided on strategic grounds.

## Code removed in the 2026-09-30 cleanup

Every path below still exists at commit **`a1845f5`** (master before the cleanup). To read one, run `git show a1845f5:<path>`; to restore a directory, run `git checkout a1845f5 -- <path>`. The RESULT/REPORT records under `tools/` were kept.

| Removed | What it was | Result row |
|---|---|---|
| `src/lib/concord/field/` (`fit.ts`, `glsl.ts`, `readback.ts`, `index.ts`, `field.check.ts`), `scripts/concord/field-eval.ts`, `tools/concord/field/glsl-check.mts` | WP-E display warp: field fit, GLSL hook, CPU inverse | Display warp (both rows) |
| `?concord=warp` and its plumbing: warp branch of `src/lib/concord/app/display.ts`, `setWarp` / `renderUVOf` on `Renderer`, the `tWarp`/`uWarp*` uniforms in `src/lib/engine.ts`, `warpTex`/`warpScale`/`warpOn` in `src/lib/deck/composite{,-shader}.ts`, the warp label mapping in `src/lib/deck/engine.ts`, the sidebar option | App wiring of the warp. The composites now read render space at `uvG = vUv`, the exact warp-off path | Display warp |
| `src/lib/concord/solve/` (`joint.ts`, `gate.ts`, `refine.ts`, `index.ts`, `joint.check.ts`), `scripts/concord/solve-eval.ts` | WP-D joint whole-frame solver and gate | Joint whole-frame solve |
| `src/lib/concord/match/client.ts`, `scripts/concord/rematch-eval.ts`, `tools/concord/rematch/{server,tiles,mask}.py` | WP-G re-match service (:8768) and client | Render → re-match loop |
| `scripts/concord/priors-study.ts` | WP-B fitting study (the priors themselves are kept) | Altitude-contour eye rule |
| `src/lib/geocam/observe/` (`fisher.ts`, `gate.ts`, `heldout.ts`, `index.ts`, `observe.check.ts`), `scripts/geocam/ga2-eval.ts` | GA2 CRLB eye gate | GA2 |
| `src/lib/geocam/tjunc/` (`junctions.ts`, `measure.ts`, `factor.ts`, `layered.ts`, `index.ts`, `tjunc.check.ts`), `scripts/geocam/ga3-{common,dev,synth}.ts` | GA3 T-junction eye cue | GA3 |
| `src/lib/geocam/lakes/factors.ts` (waterline/shore factors), `lakes-factors.check.ts`, `scripts/geocam/ga4-eval.ts` | GA4 lake eye-height factors | GA4 |
| `geoInliers` flag, `returnCorrespondences` request field and `correspondences` response type in `src/lib/matcher-client.ts` | GA0 matcher-inlier request | GA0 matcher inliers |
| CI checks `concord-joint`, `concord-field`, `geocam-observe`, `geocam-tjunc`, `geocam-lakes-factors` (`scripts/ci/checks.mjs`) | Checks of the removed code. `concord-app` (`src/lib/concord/app/app.check.ts`) now carries the "`?concord` defaults off" assertion | — |
| `scripts/nearfield/deck-splats-check.mjs` | One-off browser check referenced nowhere (not in CI, docs or code) | — (not experiments) |

Moved rather than removed: the joint solver's cue residuals (`JointCue`, `cueResidualPx`, `focalPx1600`, `horizonEl`, `basisPx`, the read `JOINT_DEFAULTS` fields) to `src/lib/geocam/map/joint-residual.ts`; `lakeFloorFactor` to `src/lib/geocam/map/factors.ts`; the concord display's fail-closed `isLowConfidence` to `src/lib/concord/app/confidence.ts`.

Kept on purpose: `src/lib/concord/{core,cues,priors,occl,app}` (`?concord=eye,occl`, and the cue extraction the GA1/GA5 evals use); `src/lib/geocam/{core,map,integrity,priors,lakes}` (GA1 solver, GA5 veto candidate, `geoDecl`/`geoLakeFloor`/`geoLakes`); `scripts/concord/{lib,eval}.ts`, `scripts/geocam/{lib,ga0-audit,ga1-eval,ga1-fixtures,ga5-eval,eval-app-flags}`.
