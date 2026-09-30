# Rigi roadmap

*Consolidated 2026-09-29. This replaces `next-gen-roadmap.md` (now in [archive/](archive/)) and the sequencing in the [competitive roadmap](<Rigi competitive landscape and roadmap.md>), which is kept as the dated market analysis. Current state and open decisions are in [status.md](status.md), and dead ends are in [negative-results.md](negative-results.md).*

## Position

- **The wedge.** Nobody ships automatic registration of existing photos against terrain. PeakVisor still aligns by hand, but its tutorial says it "will soon do this calibration automatically". The lead is timing, not a moat.
- **The asset is geometric truth:** a verified camera pose plus the real DEM. Learned and generative models sit *on top of* it and never replace it. Rigi supplies the geometry that generation is conditioned on, and it does not host a world model.
- **Sales order:** B2B first (railways, tourism boards, newsrooms, science), then a share-link web beta, then a pose API.

## Rules that apply to every item

1. Every accuracy claim is pre-registered and measured on sealed data. Dev numbers are never quoted as results.
2. Precision beats recall. A HIGH must be right; everything uncertain is a suggestion the user confirms.
3. Generated or warped pixels are display-only. They never feed the pose, confidence, benchmarks, the measurement readout or exports.
4. Classic view stays pixel-identical, and both renderers (three, deck) stay at parity.
5. Commercial-licence models only in the product path. Research licences stay behind dev flags.

## Now: unblock launch and spend evaluation data well

| # | Item | Gate / done when | State |
|---|---|---|---|
| N1 | **CI regression gate**: tsc, style-baseline, eval-app, deck smoke, nearfield/export checks, concord-off parity | Runs on every commit | **Built 2026-09-29**: `scripts/ci/run.mjs` (fast ~30 s: tsc, biome ratchet, 21 unit checks; full: style-baseline, deck smoke, eval-app) + `.github/workflows/ci.yml` (fast tier; not pushed yet). Open: style-baseline 0/16 is a stale baseline (trails off since 71e846e; identical at a7287da), re-capture it; add licences/tiles3d checks when stable |
| N2 | **Licence register and swaps.** Replace or license Esri World Imagery (use outside Esri software needs an ArcGIS subscription); pre-extract or self-host Overpass (public limit ~10k queries/day across all users); self-host Mapterhorn PMTiles with per-source attribution; model licences from `step_inside_models_2026-09.md` | No public URL before this | Register + opt-in swaps done (`reports/licences.md`): per-source attribution (`?attrib=full`), imagery providers (`?imagery=esri\|swisstopo\|custom`), OSM peak pre-extract proven identical to Overpass (`?osmextract=on`), `VITE_MAPTERHORN_URL` + self-host steps. Open: owner decisions (Esri, OSM tiles, defaults), water/trails still Overpass |
| N3 | **Evaluation data plan.** Collect one ~100-photo set with trip sequences (overlapping neighbours) and seal it before opening `data_v3`. It serves propagation, the pano solve and the next matcher round. Decide the order in which claimants spend `data_v3` | Sealed by sha1 | Not started |
| N4 | **Fix the basin-gap calibration.** v034's 0.20 gap was tuned on v1 verdicts that later flipped: it rejects the correct wc_0063 (gap ≈ 0.18) and keeps the gross wc_0069 (≈ 0.21), and the threshold sits inside run-to-run noise (0.139–0.182) | Re-derive in the H2 veto prereg; don't hand-tune | Found in consolidation |
| N5 | **Re-annotate ground truth on Mapterhorn.** The GT poses and `demGround` were fitted on Terrarium, which is up to 81 m low at Niederhorn. That biases every comparison toward Terrarium and keeps the CPU eval default on it (`src/lib/geo/README.md`) | Then switch the eval and `/baseline` defaults | Not started |
| N6 | **deck.gl as the default renderer** ([deck-default.md](deck-default.md)). Flip `renderer` to `deck`, keep `?renderer=three` as the escape hatch | Flip gate: photo interactions ≥ 55 fps, world orbit ≥ 45, eval-app deck ≥ three, correctness checks pass | **Not flipped 2026-09-30.** Photo view at parity (59–60 fps), eval-app 12/14 both; world orbit 29–39 fps fails. Next: canvas `antialias: false` (measured 59 fps), style-baseline re-capture, Firefox smoke, re-run the gate. WebGPU renderer is a separate track (`src/lib/deck-webgpu/README.md`) |

## Next: registration trust and recall (0–3 months)

Recall is the bottleneck. About 20% of wild photos auto-accept, and the held-out HIGH precision is 1.00 (arm A).

| # | Item | Gate | State |
|---|---|---|---|
| R1 | **H1 blind verification** of the hard-negative pack (120 overlays, 27 photos; 2 batches × 2 verifiers) | Protocol in `tools/research/tm/h1_mine/` | Ready, not started |
| R2 | **H2 veto prereg**: MoGe-2 depth score, PnP shift, 3-strip agreement, XoFTR-depth. Needs ≥ 30 hard negatives for a ~10% miss-rate bound | Written threshold rule; results per negative kind | Waits on R1 |
| R3 | **Recall levers under the frozen veto**: LoMa-sat with its own rule, ALIKED+dehaze, X1 features top-2 as a generator | Dev, then the v3 prereg | Waits on R2 |
| R4 | **Top-3 picker / tap-a-peak UX**: the biggest product lever (top-4 hit 27/30 vs ~20/50 safe HIGH). Log every correction | Default-on once you've tried it | **Built** behind `?picker=on` / `always` (`src/lib/picker/README.md`), both renderers; upload (no-compass) path type-checked only. Corrections logged |
| R5 | **Pose propagation**: an accepted photo anchors overlapping neighbours as suggestions (0/83 wrong pairs pass; wc_0086 3/3 blind-correct, n = 1). DEM render check (GT error vs parallax) ran: **INCONCLUSIVE** by its frozen rule. 7059 (13 mm, cliff-edge eye) can't be skyline-fitted (bootstrap 5.9° vs 0.5° limit); 7063/7068 fit to 0.1° (`tools/nearfield/propagate/REPORT.txt`) | Your sign-off on `tools/nearfield/propagate/PREREG_DRAFT.txt`; held-out roll set from N3 | Library built; wired to `/roll` as suggestions only behind `?propagate=on` (service `tools/nearfield/propagate/run_service.sh`; `src/lib/roll/propagate/README.md`) |
| R6 | **v3 prereg**: fold in R2/R3 winners, add the missing `STAGE1_MANIFEST` switch and code stamps, run the `V2_SUGGEST_ONLY` dry run | Your sign-off | Draft ([v3-prereg.md](v3-prereg.md)) |
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
| GA0 | Quick fixes: magnetic declination, GPS hAcc prior, eye ≥ lake level, matcher inliers returned to app | **Built** behind `geoDecl`/`geoLakeFloor`/`geoLakes` (off); no regression, no gain on dev (all true-north). Matcher patch proposed to f0; the unused `geoInliers` request flag was removed 2026-09-30 |
| GA1 | One MAP solver (GPS/gravity/compass/focal priors) with Laplace covariance; pycolmap test → GTSAM reference → TS port | **Built** (`src/lib/geocam/map`, GTSAM parity 2e-5°). Pitch pass; σ ~2.5× over-confident (not killed). Not wired to the pose. pycolmap free-eye test negative |
| GA2 | Per-photo observability (CRLB) gate: the eye moves only where observable | **Killed** (ρ 0.498 < 0.5) |
| GA3 | Occlusion-crossing (T-junction) eye cue: novel, render-only test first | **Killed** on real photos (wrong eye wins 93%); works on renders. Needs a learned contour detector (GC3) |
| GA4 | Lakes as known planes (polygons already downloaded, then discarded) | **Killed** on eye-Z (16.9 m vs 5 m; cue bias); coverage 22% |
| GA5 | Integrity: leave-one-cue-family-out protection level + viewshed/eye-on-DSM veto | **Killed** at zero loss (12/33 correct rejected), but wrong-basin AUROC 0.94 and 9/10 E1 wrong eyes caught: carry into R2 as a veto-panel candidate |
| GB/GC | Vector chamfer, cast shadows, trip joint solve fitted to the DSM; render-trained geometry-channel matcher, webcams, pseudo-labels | Gated on phase A |

## Next: whole-image concordance and the near field (0–4 months, parallel)

The skyline is accurate, but it can't see eye-position error. Interior error grows as 1/distance, so valleys and villages drift while the ridgelines fit. Plan: [concordance-research.md](concordance-research.md) (session f3).

| # | Item | State |
|---|---|---|
| C1 | **Interior pin harness** (WP-A): holdout pins by distance band, leave-one-out. This enables everything below | Built (`scripts/concord/eval.ts`; split frozen 10 dev / 4 holdout). 96 candidate landmarks listed; accuracy claims wait on you clicking the pins (`tools/concord/pins/PROTOCOL.txt`, `out/concord/pins/click.html`) |
| C2 | Eye and intrinsics priors (WP-B): per-LensModel focal table (focal error 1.85%→0.54% dev, 1.99%→0.32% holdout, n = 2); near-eye Mapterhorn z16/17 ground. iPhone GPSAltitude is MSL (EGM2008). The altitude-contour eye rule is worse on holdout (12.0→13.4 px) | Focal table wired behind `?concord=eye` (only reaches `cameraFromMeta`; the app prior comes from photos.json, so wiring there is next). Eye rule dropped |
| C3 | Interior cues + joint solver (WP-C/D): occluding contours, waterlines, then a robust LM over rotation, focal and eye | **Negative as gated.** Synthetic recovery is exact, but on holdout the gated solve was worse (median 8.8→16.2 px; 7130's eye moved 200 m while the skyline improved). The gate scores on the same cues it fitted. Not wired. Needs a gate that checks held-out pins, plus the pins themselves |
| C4 | **Shared near-field study (WP-F)**: swissSURFACE3D minus swissALTI3D marks buildings and trees. One signal for concordance occluders, the matcher's near-field failures, and the Step Inside smear split. COGs stream over CORS (own COG reader, no new dependency; ≤ 4.5 MB per photo) | Wired behind `?concord=occl` (dims overlays behind trees/huts, both renderers). Smear removal 46–59% on dev labels (vs 4–15%), mostly from two lakeside photos. Drape and label hooks need `materials.ts`; trail/contour criterion pending |
| C5 | Re-match loop (WP-G, :8768) and display warp (WP-E) | Re-match adds inliers but fails its acceptance as written. Warp showed no gain (holdout 0 better / 8 worse). Both removed 2026-09-30 (recoverable from `a1845f5`, see [negative-results.md](negative-results.md#code-removed-in-the-2026-09-30-cleanup)) |
| S1 | **Step Inside v1.1**: semantic + depth split, re-measured on `tools/nearfield/smear/labels.json` (target ≥ 80%, now 4–15%); fix cliff-lip and near-camera anchoring (IMG_7059/7063) and three/deck anchor parity; ship only at anchor quality ≥ 0.35 | Blocked on picking a permissively licensed segmenter |
| S3 | **3D Tiles layer in Step Inside** ([step-inside-google-3d-tiles.md](step-inside-google-3d-tiles.md) §7). Build a source-agnostic `src/lib/tiles3d` on `3d-tiles-renderer`: T0 three.js on swisstopo buildings/vegetation, T1 deck parity, T2 feed tiles plus C4's nDSM into S1's Object class (a segmenter substitute inside CH). T3 is an optional display-only Google backdrop. Datum: Google is ellipsoidal (−N ≈ 50 m); swisstopo stores MSL (N = 0) | **T0, T1 and T3 built 2026-09-29** behind `?tiles3d=` (US billing; you accepted rendering). Next: T2, and the Google logo before L1 |
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

## Parked

- Multi-photo fusion as a product goal.
- Hosting any world model; LingBot-World v2 (non-commercial).
- VGGT beyond filing for the commercial checkpoint.
- DEM-prompted depth, until its range instability is solved.
- The display warp field, unless interior pins show a gain.
- T6 as the default policy; T5 position refinement (opt-in only).
- A world model as a synthetic-negative engine: one bounded study at most.
