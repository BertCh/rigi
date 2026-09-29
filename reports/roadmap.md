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
| N1 | **CI regression gate**: tsc, style-baseline, eval-app, deck smoke, nearfield/export checks, concord-off parity | Runs on every commit | Checks exist; no CI |
| N2 | **Licence register and swaps.** Replace or license Esri World Imagery (use outside Esri software needs an ArcGIS subscription); pre-extract or self-host Overpass (public limit ~10k queries/day across all users); self-host Mapterhorn PMTiles with per-source attribution; model licences from `step_inside_models_2026-09.md` | No public URL before this | Models done; tiles and Overpass open |
| N3 | **Evaluation data plan.** Collect one ~100-photo set with trip sequences (overlapping neighbours) and seal it before opening `data_v3`. It serves propagation, the pano solve and the next matcher round. Decide the order in which claimants spend `data_v3` | Sealed by sha1 | Not started |
| N4 | **Fix the basin-gap calibration.** v034's 0.20 gap was tuned on v1 verdicts that later flipped: it rejects the correct wc_0063 (gap ≈ 0.18) and keeps the gross wc_0069 (≈ 0.21), and the threshold sits inside run-to-run noise (0.139–0.182) | Re-derive in the H2 veto prereg; don't hand-tune | Found in consolidation |
| N5 | **Re-annotate ground truth on Mapterhorn.** The GT poses and `demGround` were fitted on Terrarium, which is up to 81 m low at Niederhorn. That biases every comparison toward Terrarium and keeps the CPU eval default on it (`src/lib/geo/README.md`) | Then switch the eval and `/baseline` defaults | Not started |

## Next: registration trust and recall (0–3 months)

Recall is the bottleneck. About 20% of wild photos auto-accept, and the held-out HIGH precision is 1.00 (arm A).

| # | Item | Gate | State |
|---|---|---|---|
| R1 | **H1 blind verification** of the hard-negative pack (120 overlays, 27 photos; 2 batches × 2 verifiers) | Protocol in `tools/research/tm/h1_mine/` | Ready, not started |
| R2 | **H2 veto prereg**: MoGe-2 depth score, PnP shift, 3-strip agreement, XoFTR-depth. Needs ≥ 30 hard negatives for a ~10% miss-rate bound | Written threshold rule; results per negative kind | Waits on R1 |
| R3 | **Recall levers under the frozen veto**: LoMa-sat with its own rule, ALIKED+dehaze, X1 features top-2 as a generator | Dev, then the v3 prereg | Waits on R2 |
| R4 | **Top-3 picker / tap-a-peak UX**: the biggest product lever (top-4 hit 27/30 vs ~20/50 safe HIGH). Log every correction | Your decision | Not built |
| R5 | **Pose propagation**: an accepted photo anchors overlapping neighbours as suggestions (0/83 wrong pairs pass; wc_0086 3/3 blind-correct, n = 1). First run a DEM render check to separate GT error from parallax | Your sign-off on `tools/nearfield/propagate/PREREG_DRAFT.txt`; held-out roll set from N3 | Library built, not wired to UI |
| R6 | **v3 prereg**: fold in R2/R3 winners, add the missing `STAGE1_MANIFEST` switch and code stamps, run the `V2_SUGGEST_ONLY` dry run | Your sign-off | Draft ([v3-prereg.md](v3-prereg.md)) |
| R7 | Measure the target input (iPhone with GPS, heading and gravity) at scale, including the 14 non-Swiss `data_v3` photos | Part of N3 | Not started |

## Next: whole-image concordance and the near field (0–4 months, parallel)

The skyline is accurate, but it can't see eye-position error. Interior error grows as 1/distance, so valleys and villages drift while the ridgelines fit. Plan: [concordance-research.md](concordance-research.md) (session f3).

| # | Item | State |
|---|---|---|
| C1 | **Interior pin harness** (WP-A): holdout pins by distance band, leave-one-out. This enables everything below | In progress (session f3); accuracy claims wait on you clicking the pins (`tools/concord/pins/PROTOCOL.txt`) |
| C2 | Eye and intrinsics priors (WP-B): per-LensModel focal table (focal error 1.85%→0.54% dev, 1.99%→0.32% holdout, n = 2); near-eye Mapterhorn z16/17 ground. iPhone GPSAltitude is MSL (EGM2008). The altitude-contour rule failed holdout | Partly positive |
| C3 | Interior cues + joint solver (WP-C/D): occluding contours, waterlines, then a robust LM over rotation, focal and eye, accepted only if holdout pins improve and the skyline doesn't get worse | In progress, results pending pins |
| C4 | **Shared near-field study (WP-F)**: swissSURFACE3D minus swissALTI3D marks buildings and trees. One signal for concordance occluders, the matcher's near-field failures (failures have 44% of the frame within 300 m vs 16% for successes), and the Step Inside smear split. COGs stream over CORS, so no local tiling is needed. Use epoch-matched DSM/DTM tiles | In progress (`?concord=occl` planned), not measured |
| C5 | Re-match loop (WP-G, :8768) and display warp (WP-E). The warp showed 0.00 px gain on current pins | In progress; the warp is likely parked |
| S1 | **Step Inside v1.1**: semantic + depth split, re-measured on `tools/nearfield/smear/labels.json` (target ≥ 80%, now 4–15%); fix cliff-lip and near-camera anchoring (IMG_7059/7063) and three/deck anchor parity; ship only at anchor quality ≥ 0.35 | Blocked on picking a permissively licensed segmenter |
| S3 | **3D Tiles layer in Step Inside** ([step-inside-google-3d-tiles.md](step-inside-google-3d-tiles.md) §7). Build a source-agnostic `src/lib/tiles3d` on `3d-tiles-renderer`: T0 three.js on swisstopo buildings/vegetation, T1 deck parity, T2 feed tiles plus C4's nDSM into S1's Object class (a segmenter substitute inside CH). T3, an optional display-only Google backdrop, is licence-blocked. Watch for the ~50 m geoid (N) offset and isolate tiles from every offscreen pass | Needs your OK for the dependency; T3 needs a non-EEA billing account and Google's answer |
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
