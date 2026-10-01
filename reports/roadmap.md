# Rigi roadmap

*Consolidated 2026-09-29; N7 added 2026-09-30; U and WAG rows and states updated 2026-10-01. This replaces `next-gen-roadmap.md` (now in [archive/](archive/)) and the sequencing in an earlier competitive roadmap that is no longer published. Current state and open decisions are in [status.md](status.md), and dead ends are in [negative-results.md](negative-results.md).*

## Position

- **The wedge.** Nobody ships automatic registration of existing photos against terrain. PeakVisor still aligns by hand, but its tutorial says it "will soon do this calibration automatically". The lead is timing, not a moat.
- **The asset is geometric truth:** a verified camera pose plus the real DEM. Learned and generative models sit *on top of* it and never replace it. Rigi supplies the geometry that generation is conditioned on, and it does not host a world model.
- **Sales order:** B2B first (railways, tourism boards, newsrooms, science), then a share-link web beta, then a pose API.

## Rules that apply to every item

1. Every accuracy claim is pre-registered and measured on sealed data. Dev numbers are never quoted as results.
2. Precision beats recall. A HIGH must be right; everything uncertain is a suggestion the user confirms.
3. Generated or warped pixels are display-only. They never feed the pose, confidence, benchmarks, the measurement readout or exports.
4. Classic view stays pixel-identical, and both renderers (WebGPU deck, the default since 2026-10-01, and WebGL deck via `?renderer=deck`) stay at parity. The three.js renderer was removed 2026-10-01.
5. Commercial-licence models only in the product path. Research licences stay behind dev flags.

## Now: unblock launch and spend evaluation data well

| # | Item | Gate / done when | State |
|---|---|---|---|
| N1 | **CI regression gate**: tsc, style-baseline, eval-app, deck smoke, nearfield/export checks, concord-off parity | Runs on every commit | **Built 2026-09-29**: `scripts/ci/run.mjs` (57 fast checks, ~30 s: tsc, biome ratchet, unit checks; 6 full: style-baseline, deck smoke, eval-app, eval-app-deck, settle-submits, graph-plumbing-ab) + `.github/workflows/ci.yml` (fast tier, `vite build`, examples site). Open: style-baseline SKIPs until a deck reference is captured; add licences/tiles3d checks when stable |
| N2 | **Licence register and swaps.** Replace or license Esri World Imagery (use outside Esri software needs an ArcGIS subscription); pre-extract or self-host Overpass (public limit ~10k queries/day across all users); self-host Mapterhorn PMTiles with per-source attribution; model licences from `step_inside_models_2026-09.md` | No public URL before this | Register + opt-in swaps done (`reports/licences.md`): per-source attribution (`?attrib=full`), imagery providers (`?imagery=esri\|swisstopo\|custom`), OSM peak pre-extract proven identical to Overpass (`?osmextract=on`), `VITE_MAPTERHORN_URL` + self-host steps. Open: owner decisions (Esri, OSM tiles, defaults), water/trails still Overpass |
| N3 | **Evaluation data plan.** Collect one ~100-photo set with trip sequences (overlapping neighbours) and seal it before opening `data_v3`. It serves propagation, the pano solve and the next matcher round. Decide the order in which claimants spend `data_v3` | Sealed by sha1 | Not started |
| N4 | **Fix the basin-gap calibration.** v034's 0.20 gap was tuned on v1 verdicts that later flipped: it rejects the correct wc_0063 (gap ≈ 0.18) and keeps the gross wc_0069 (≈ 0.21), and the threshold sits inside run-to-run noise (0.139–0.182) | Re-derive in the H2 veto prereg; don't hand-tune | Found in consolidation |
| N5 | **Re-annotate ground truth on Mapterhorn.** The GT poses and `demGround` were fitted on Terrarium, which is up to 81 m low at Niederhorn. That biases every comparison toward Terrarium and keeps the CPU eval default on it (`src/lib/geo/README.md`) | Then switch the eval and `/baseline` defaults | Not started |
| N6 | **deck.gl as the default renderer** ([deck-default.md](deck-default.md)) | Flip gate: photo interactions ≥ 55 fps, world orbit ≥ 45, eval-app deck ≥ three | **Done 2026-09-30** (3b121ae); superseded by the WebGPU default 2026-10-01 ([webgpu-default.md](webgpu-default.md)) and the three.js removal (583e2b7). Open: Windows/Safari smoke |
| N7 | **Code-review fixes** ([code-review-2026-09-30.md](code-review-2026-09-30.md)). Next: lock wrapper kill (CR-02), export geoid (CR-04), matcher origin check (CR-06), the Python-requirements half of the clean-clone build (CR-26) | Each fix sets its row to `fixed <commit>`; no new biome or tsc failures | 38 fixed + 3 obsolete of 75 (2026-10-01) |

## Next: registration trust and recall (0–3 months)

Recall is the bottleneck. About 20% of wild photos auto-accept, and the held-out HIGH precision is 1.00 (arm A).

| # | Item | Gate | State |
|---|---|---|---|
| R1 | **H1 blind verification** of the hard-negative pack (120 overlays, 27 photos; 2 batches × 2 verifiers) | Protocol in `tools/research/tm/h1_mine/` | Ready, not started |
| R2 | **H2 veto prereg**: MoGe-2 depth score, PnP shift, 3-strip agreement, XoFTR-depth. Needs ≥ 30 hard negatives for a ~10% miss-rate bound | Written threshold rule; results per negative kind | Waits on R1 |
| R3 | **Recall levers under the frozen veto**: LoMa-sat with its own rule, ALIKED+dehaze, X1 features top-2 as a generator | Dev, then the v3 prereg | Waits on R2 |
| R4 | **Top-3 picker / tap-a-peak UX**: the biggest product lever (top-4 hit 27/30 vs ~20/50 safe HIGH). Log every correction | Default-on once you've tried it | **Built** behind `?picker=on` / `always` (`src/lib/picker/README.md`), both renderers; upload (no-compass) path type-checked only. Corrections logged |
| R5 | **Pose propagation**: an accepted photo anchors overlapping neighbours as suggestions (0/83 wrong pairs pass; wc_0086 3/3 blind-correct, n = 1). DEM render check (GT error vs parallax) ran: **INCONCLUSIVE** by its frozen rule. 7059 (13 mm, cliff-edge eye) can't be skyline-fitted (bootstrap 5.9° vs 0.5° limit); 7063/7068 fit to 0.1° (`tools/nearfield/propagate/REPORT.txt`) | Your sign-off on `tools/nearfield/propagate/PREREG_DRAFT.txt`; held-out roll set from N3 | Library built; wired to `/roll` as suggestions only behind `?propagate=on` (service `tools/nearfield/propagate/run_service.sh`; `src/lib/roll/propagate/README.md`) |
| R6 | **v3 prereg**: fold in R2/R3 winners, add the missing `STAGE1_MANIFEST` switch and code stamps, port the stage-1 render workers off the removed three.js engine (or pin a pre-583e2b7 checkout), run the `V2_SUGGEST_ONLY` dry run | Your sign-off | Draft ([v3-prereg.md](v3-prereg.md)) |
| R7 | Measure the target input (iPhone with GPS, heading and gravity) at scale, including the 14 non-Swiss `data_v3` photos | Part of N3 | Not started |

## Fundamentals (FUND phase 0, dev only)

Plan and fixed kill criteria: [fundamentals-plan.md](fundamentals-plan.md) §3. Outputs in `tools/research/fund/<study>/REPORT.txt`. **Phase 0 finished 2026-09-29: all four killed.** Better renders (appearance, near field) don't add matches, and a generic held-out likelihood test can't reject wrong eyes. What's left: E4 (dense feature-metric refinement) and E5 (ray-cast oracle, a simplification track) are not gated by these results. The wrong-eye problem stays open.

| # | Item | State |
|---|---|---|
| E0 | Observability map (FOV/w\* for rotation, parallax information for the eye) | **Killed as pre-registered** (AUROC 0.60 / 0.50). Rotation half not validly tested (cache clipping); needs a pitched ring render. Post hoc: position failures have *more* near parallax, which fits "a wrong eye hurts where parallax is big" |
| E1 | A-contrario held-out-cue accept with a decoy null (incl. displaced eyes) | **Killed** (35 dev photos, 1102 hypotheses): recall 23/31 vs the current rule's 19/31, but 13 gross accepts incl. 10/56 displaced-eye decoys (ε = 1; ε = 0.01 still 7). Rotation/basin negatives are nearly clean (1/693); wrong eyes are the failure. Held-out scoring doesn't beat an in-sample fit (AUROC 0.82 vs 0.87). R1/R2 stand as planned. Displaced-eye decoys are the reusable asset: any future veto must pass them |
| E2 | Date-matched appearance (photo-time sun, snow, Sentinel-2) | **Killed** (30 dev photos): best median inlier gain +0.3% vs the 15% bar; no significant separation gain. The flat snow tint hurts snowy photos (−31% LoMa / −52% ALIKED, n = 6); S2 is neutral; the low-sun relight gives +3–6% (n = 6). Separation against E1 decoys still pending |
| E3 | Near-field fidelity (swissALTI3D z17 + DSM + SWISSIMAGE, mid-band eye solve) | **Killed** (all 30 refs): inliers < 2 km don't gain (mean log2 +0.10, CI spans 0); near (< 250 m) inliers barely exist (21 across 30 photos), so dropping the 250 m cut buys ~nothing. Eye beats GPS on 3/30 (bar 60%). Post hoc: the eye is recoverable to a few metres only on 3–4 photos with dense 250–2000 m matches |

## Geometry-first camera (GEO, dev only)

Plan and kill criteria: [geometry-first-pose.md](geometry-first-pose.md) §5; phase A results §8 (2026-09-30). Reports: `tools/research/geo/REPORT_GA*.txt`.

| # | Item | State |
|---|---|---|
| GA0 | Quick fixes: magnetic declination, GPS hAcc prior, eye ≥ lake level, matcher inliers returned to app | **Built** behind `geoDecl`/`geoLakeFloor`/`geoLakes` (off); no regression, no gain on dev (all true-north). Matcher patch proposed; the unused `geoInliers` request flag was removed 2026-09-30 |
| GA1 | One MAP solver (GPS/gravity/compass/focal priors) with Laplace covariance; pycolmap test → GTSAM reference → TS port | **Built** (`src/lib/geocam/map`, GTSAM parity 2e-5°). Pitch pass; σ ~2.5× over-confident (not killed). Not wired to the pose. pycolmap free-eye test negative |
| GA2 | Per-photo observability (CRLB) gate: the eye moves only where observable | **Killed** (ρ 0.498 < 0.5) |
| GA3 | Occlusion-crossing (T-junction) eye cue: novel, render-only test first | **Killed** on real photos (wrong eye wins 93%); works on renders. Needs a learned contour detector (GC3) |
| GA4 | Lakes as known planes (polygons already downloaded, then discarded) | **Killed** on eye-Z (16.9 m vs 5 m; cue bias); coverage 22% |
| GA5 | Integrity: leave-one-cue-family-out protection level + viewshed/eye-on-DSM veto | **Killed** at zero loss (12/33 correct rejected), but wrong-basin AUROC 0.94 and 9/10 E1 wrong eyes caught: carry into R2 as a veto-panel candidate |
| GB/GC | Vector chamfer, cast shadows, trip joint solve fitted to the DSM; render-trained geometry-channel matcher, webcams, pseudo-labels | Gated on phase A |

## Next: whole-image concordance and the near field (0–4 months, parallel)

The skyline is accurate, but it can't see eye-position error. Interior error grows as 1/distance, so valleys and villages drift while the ridgelines fit. Plan: [concordance-research.md](concordance-research.md) 

| # | Item | State |
|---|---|---|
| C1 | **Interior pin harness** (WP-A; kept): holdout pins by distance band, leave-one-out. This enables everything below | Built (`scripts/concord/eval.ts`; split frozen 10 dev / 4 holdout). 96 candidate landmarks listed; accuracy claims wait on you clicking the pins (`tools/concord/pins/PROTOCOL.txt`, `out/concord/pins/click.html`) |
| C2 | Eye and intrinsics priors (WP-B): per-LensModel focal table (focal error 1.85%→0.54% dev, 1.99%→0.32% holdout, n = 2); near-eye Mapterhorn z16/17 ground. iPhone GPSAltitude is MSL (EGM2008). The altitude-contour eye rule is worse on holdout (12.0→13.4 px) | Focal table wired behind `?concord=eye` (only reaches `cameraFromMeta`; the app prior comes from photos.json, so wiring there is next). Eye rule dropped |
| C3 | Interior cues (WP-C, kept) + joint solver (WP-D, **code removed 2026-09-30**): occluding contours, waterlines, then a robust LM over rotation, focal and eye | **Negative as gated.** Synthetic recovery is exact, but on holdout the gated solve was worse (median 8.8→16.2 px; 7130's eye moved 200 m while the skyline improved). The gate scores on the same cues it fitted. Not wired. Needs a gate that checks held-out pins, plus the pins themselves |
| C4 | **Shared near-field study (WP-F)**: swissSURFACE3D minus swissALTI3D marks buildings and trees. One signal for concordance occluders, the matcher's near-field failures, and the Step Inside smear split. COGs stream over CORS (own COG reader, no new dependency; ≤ 4.5 MB per photo) | Wired behind `?concord=occl` (dims overlays behind trees/huts, both renderers). Smear removal 46–59% on dev labels (vs 4–15%), mostly from two lakeside photos. Drape and label hooks belong in the deck terrain/drape layers (`materials.ts` is gone); trail/contour criterion pending |
| C5 | **Code removed.** Re-match loop (WP-G, :8768) and display warp (WP-E) | Re-match adds inliers but fails its acceptance as written. Warp showed no gain (holdout 0 better / 8 worse). Both removed 2026-09-30 (recoverable from `a1845f5`, see [negative-results.md](negative-results.md#code-removed-in-the-2026-09-30-cleanup)) |
| S1 | **Step Inside v1.1**: semantic + depth split, re-measured on `tools/nearfield/smear/labels.json` (target ≥ 80%, now 4–15%); fix cliff-lip and near-camera anchoring (IMG_7059/7063) and WebGL2/WebGPU anchor parity; ship only at anchor quality ≥ 0.35 | Blocked on picking a permissively licensed segmenter |
| S3 | **3D Tiles layer in Step Inside** ([step-inside-google-3d-tiles.md](step-inside-google-3d-tiles.md) §7). Build a source-agnostic `src/lib/tiles3d` on `3d-tiles-renderer`: T0 three.js on swisstopo buildings/vegetation (three.js since removed), T1 deck parity (deck WebGL2 and WebGPU layers; WebGPU unverified in a browser), T2 feed tiles plus C4's nDSM into S1's Object class (a segmenter substitute inside CH). T3 is an optional display-only Google backdrop. Datum: Google is ellipsoidal (−N ≈ 50 m); swisstopo stores MSL (N = 0) | **T0, T1 and T3 built 2026-09-29** behind `?tiles3d=` (US billing; you accepted rendering). Next: T2, and the Google logo before L1 |
| S2 | **Completion P0** (`?nearfield=complete`, not built yet): diagnose the slabs first, then group-id plumbing, edge snap, behind-layer LaMa. Gate: holes −50%, source view unchanged, ≥ 70% blind preference. Needs a provenance decision (reuse `generated` vs a new code). Specs: `research_notes/completion_integration_2026-09.md` | Research only |

## Later: beta, pilots, service (3–18 months)

| # | Item | Depends on |
|---|---|---|
| L1 | **Share-link web beta**: watermarked image + link, iOS location-toggle coaching; Step Inside opt-in on accepted photos | N1, N2, R4; S1 for Step Inside |
| L2 | **Pilots**: railway or tourism board (summit viewpoint as a navigable, correctly placed scene), newsroom/OSINT, science pose-initialiser | L1 |
| L3 | **iOS rendering path** (half-float or WebGPU). Splats make the gap bigger | Before L1 reaches iOS users |
| L4 | **Hosted robustness tier**: the matcher as a queued service. GPU enablers exist in `src/lib/gpu` | Licence of the imagery used in renders (N2) |
| L5 | Pose API + embeddable viewer; GCP / no-GPS mode; measurement outputs (the readout already works on near-field objects) | L2 demand |
| L6 | Webcam/archive registration, global coverage with per-region validated accuracy | L4 |
| L7 | Completion P1 (3DB/MHR people, SAM 3D Objects, TripoSplat) | S2; gated downloads |
| L8 | **GEN3C geometry-fidelity test**: one rented-GPU run on 3–5 accepted photos. Pass = generated ridgelines stay within a few px of the DEM projection → "fly beyond the frame", labelled `generated`. Fail → stop | Your funding decision; adapter ready in `src/lib/nearfield/generate/` |
| L9 | Native/AR app | Only if pilots demand it |

## Backlog: upstream-alignment follow-ups (2026-10-01)

Source: [luma-deck-upstream-2026-10-01.md](luma-deck-upstream-2026-10-01.md). Each needs an owner opt-in and stays off the overlay and accuracy path.

| # | Item | Gate / state |
|---|---|---|
| U1 | **`nebelmeer-fog-layer`** (M, look/**): port the MIT `heightFog_getRayTransmittance` (GLSL and WGSL) into `look/glsl/atmosphere.ts`, `look/atmosphere.ts` and `deck-webgpu/layers/atm-sky.ts`, fed the curvature-corrected `enuAltitude`. Opt-in style, density 0 by default. Frozen haze-fit and accuracy paths untouched. Later `fog-wisps-animation`, only after this | STYLE pixel-identical with the layer off; EVAL unchanged. **Landed 2026-10-01** (e3ff426, `atmosphere.nebelmeer`, density 0 = classic; [luma-deck-upstream-2026-10-01.md](luma-deck-upstream-2026-10-01.md)). Classic-identity pass on all renderers still owed |
| U2 | **`trail-pathdash`** (M): pathDash coverage only, via a cumulative-distance attribute in `deck/trail-layer.ts` and `deck-webgpu/layers/trail.ts`. Not `makeStrokeGeometry`. Behind a style option | STYLE pixel-identical with it off. **Landed 2026-10-01** (1152622, a1caafb; `style.trails.dash`, deck WebGL + WebGPU) |
| U3 | **Upstream contributions** (report §4): deck WebGPU origin fixes (`getGLViewport` y, pick `scissorY`, picker readback flip, `depth24plus`, `project.wgsl` orientation `select` bug); deck LayersPass clear/depth control and `deck.finalize()` destroying its own device; a review comment on #10740 (stale `@math.gl/core` import); luma `mapAndReadAsync` and `CommandEncoder.clearBuffer`; luma packaging (`patch:` dependency, `~9.4` peer ranges); `Model.draw` `firstInstance` and mipmap `submit` inside a pass; WGSL `&&`/`||` and uniform alignment checks; gpgpu clear/readback graph nodes; support for #3312 and #3313 | None blocking. Not started (posting upstream needs the user's direct OK) |
| U4 | **Weather and lake water** (upstream-review items called U3/U4 in the report): luma precipitation port and `terrain.albedo.water` → `LOOK_WATER` | Opt-in, deck world view for weather. **Landed 2026-10-01** (5c02363, `style.world.weather`) |

## Whole-app graph (WAG, 2026-10-01)

Source: [whole-app-graph-plan.md](whole-app-graph-plan.md) (evidence in `research_notes/whole-app-graph-2026-10-01/`). Goal: every GPU island runs as a compiled luma graph, islands on the page device fuse per cadence, ingest feeds resident resources once, and one manifest plus the inspector shows the whole app. Rules:
- WebGPU only; WebGL stays a CPU-crossing fallback.
- CPU twins stay the reference.
- Plumbing changes are BIT.
- Precision changes follow decision P1 (answered 2026-10-01: certified f32 per stage).

| # | Item | Gate / state |
|---|---|---|
| WAG-0 | Foundations: `ComputeGraph` widening, inspector + `/dev/graph`, app graph manifest, luma rigi.2 (+#3328), readback partial map, post-default re-baseline | **Done 2026-10-01**: 06f7c27 (W0.1/W0.5), 927cb01 (W0.2/W0.3), c5b2aa1 (W0.4, rigi.2 + `@loaders.gl/geotiff`/`splats`), 819155d (W0.6 baseline + probes). Open: `/dev/graph` never viewed with live app graphs; observation overhead unmeasured; atlas generation from the manifest not done |
| WAG-1 | Same-device fusions | **Done or closed 2026-10-01.** W1.1 photoprep planes resident (00e1cca; upload per grid 2.53 → 0.95 MB). W1.2 settle fusion (ccc5722; 9 → 7 submits, latency unchanged). W1.5 GPU terrain cull + indirect draws (6d6160a; byte-identical but no CPU saving at ~350–390 tiles; default on since 3225064 under the GPU-first rule). W1.4 closed (haze head overflow 0/152 fits). W1.7 closed (the sky worker's 67 ms is ORT's GPU tail). W1.3 moved under P1 earlier. W1.6 VRAM 371 → 241 MiB in the photo view (lazy imagery array, packed base grid, idle silhouette release; byte-identical frames). Left: atlases never shrink; world-mode imagery ~512 MiB |
| WAG-2 | Ingest | W2.2 `TextureArrayAtlas` (49bd403; pan grow sync −24.5 ms, byte-identical; the uv-window ancestor fallback is not wired because it can't be byte-identical). W2.3 GPU Terrarium decode (4d18dec kernel; wired into the WebGPU height atlas behind `terrainGpuDecode`, default on since 3225064, e686c1c/4a4000b: frames byte-identical, copyExternalImage bytes = canvas bytes on 1871 cached tiles, but no gain as built, see negative results). W2.5 `GeoTIFFSourceLoader` behind `?cogReader=loaders` (9d8a307; default stays `own`: under the 4.5 MB budget `?concord=occl` differs on 3/4 photos). W2.6 splat loaders incl. SPZ/KSPLAT (c388c48, 9d8a307). **W2.1 DemStore: negative, not landed** (decodes per photo 548 → 547; see [negative-results.md](negative-results.md#gpu-and-performance)). W2.4 lazy `getCpuHeights` **landed** (b849236, bit-identical; fast check `cpu-heights`): every streamed-tile height reader goes through `dem/cpu-heights.ts`; camera height, trails and peak snapping now gather on the GPU (7f6f62b, 1e18f79; main-thread decodes at load 165–206 → 0); lake floor still reads `heightAt` |
| WAG-3 | Device consolidation and certified f32 (P1 answered: certified f32 per stage) | Certified-f32 horizon, `?horizonPrecision=certified-f32` (default since 3225064) (f1a21df; bit-identical on 19 photos, currently slower than f64 because of its per-call spot check). Certified-f32 align refine, `?alignPrecision=certified-f32` (default since 3225064) (W3.3; 0 differences on 19 photos × 5 priors, currently ~8% slower than f64 because every near-margin decision is re-checked exactly). **Horizon / eye on the page device: negative, not built** (the worker's result already waits 1–2 s for photo prep, and the page holds none of the needed heights at native resolution). Before any default change: the EVAL / wild-set gate under the 0-false-accept rule, with the flags on. **Gate ready** (1269d91): `scripts/gpu/precision-gate.mjs` runs the frozen dev split f64 vs certified-f32 (render worker env `MATCHER_RENDERER` / `MATCHER_HORIZON_PRECISION` / `MATCHER_ALIGN_PRECISION`); 50-photo dev run: inconclusive by its bit-identity rule (the f64 baseline isn't reproducible run to run), see WAG-wave3. The sealed wild-set gate has not run. Overhead cuts: horizon spot-check ledger (d0263e2; stage C check 1.75 → 0.27 ms in node; saves only with several photos per tab), align prewarms forced exact re-decisions during the next submit (1c68fea; results identical, browser wall-clock not measured). Band-stats fold and haze tail under P1: **negative** (see negative results); haze got bit-identical CPU shortcuts instead (9ab891b: cpuBins + cpuRefine −0.6–2.9 ms per fit, fast check `haze-tail`) |
| WAG-plumb | Remaining raw dispatches onto `ComputeGraph` | **Done 2026-10-01**: silhouette-gpu, geo-query-gpu and the GPU splat sort run as `cachedGraph` groups `silhouette-mask` / `geo-query` / `splat-sort` (0360d34, 5ed81e0, 24fa549), byte-identical against the raw path (full-tier `graph-plumbing-ab`); verdicts + skyline share one submit per settle (confirmed by `settle-submits`: 2 → 1); geo-query on pooled slots (ca487bf, 3e38ed1) |
| WAG-wave3 | Defaults + WebGPU matcher parity | **Done 2026-10-01**: certified-f32 horizon/align, `terrainGpuCull` and `terrainGpuDecode` default on (user rule: prefer working GPU-graph paths; judge on quality, not bit-identity). WebGpuEngine `loadFullTerrain` / `renderPoseView`; atlas height gathers; pooled geo-query. Open: deck (WebGL) `loadFullTerrain` timeout trap (the WebGPU one is fixed in 1fdd1da; `deck/engine.ts` sets fullWedge before the wait, so a retry returns at once on the initial terrain; seen 14× in the gate); gate redesign (same-page base/cand); `terrainGpuDecode` load time not measured; matcher drape VRAM +250 MiB on WebGPU |
| WAG-4 | Semantics: `GPUProgram` lowerings for scalar/vector stages | Not started. The former upstream asks (clear contract, read node, per-run scalars, public `GPUScalar`, texture program values, compute-hash fix) stay **local by the user's choice** (2026-10-01): no PRs or issues to visgl; our changes live in this repo and the vendored rigi builds |

## Parked

- Multi-photo fusion as a product goal.
- Hosting any world model; LingBot-World v2 (non-commercial).
- VGGT beyond filing for the commercial checkpoint.
- DEM-prompted depth, until its range instability is solved.
- The display warp field, unless interior pins show a gain.
- T6 as the default policy; T5 position refinement (opt-in only).
- A world model as a synthetic-negative engine: one bounded study at most.
