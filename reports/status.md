# Rigi: where things stand

*2026-09-30. This is the entry point. The plan is in [roadmap.md](roadmap.md), dead ends are in [negative-results.md](negative-results.md), and every doc is indexed in [README.md](README.md). When a number here disagrees with the linked source, the source wins. Update the date and the tables when a thread moves.*

## Threads

| Thread | State | Headline evidence | Next step |
|---|---|---|---|
| **Registration** | App pipeline stable. Matcher v0.4.0 runs locally only. Terrain-matching research done. Hard-negative pack built (120 overlays, 27 photos), not yet verified. Top-3 picker / tap-a-peak built behind `?picker=on` (R4). Propagation DEM render check: **inconclusive** (R5) | App: 12/14 within 1°, 0 false accepts. Held-out wild test: 29/50 correct, HIGH 17/17 (arm A). ~20% of wild photos auto-accept | Blind-verify the pack → veto prereg → recall levers ([roadmap](roadmap.md) R1–R3). FUND E1 may replace the veto panel design |
| **Fundamentals** (FUND phase 0, [fundamentals-plan.md](fundamentals-plan.md)) | **Phase 0 finished 2026-09-29: E0–E3 all killed** (E1–E3 were cut off by the shutdown and resumed the same evening). Dev only, `tools/research/fund/` | E0 **killed as pre-registered** (AUROC 0.60 rotation / 0.50 position, both < 0.65). But the rotation half is confounded by skyline clipping in the pitch-0 ring cache (13/13 heavily clipped photos read as "never unique"). Post hoc, position failures have *more* near-field parallax at the stated eye (0.71, p = 0.04). E2 killed: date-matched sun/snow/S2 renders gain ≤ 0.3% median inliers (bar 15%). E3 killed: hi-res near-field renders don't add < 2 km inliers, and the eye beats GPS on 3/30. E1 killed: a-contrario accept lifts recall 19→23/31 but accepts 10/56 displaced-eye decoys | Decide on phase 1: E4 dense refinement and/or E5 ray-cast oracle. Wrong-eye rejection is the open problem; the displaced-eye decoys are the test any future veto must pass |
| **Geometry-first camera** (GEO phase A, [geometry-first-pose.md](geometry-first-pose.md)) | Built 2026-09-30 in `src/lib/geocam`; kept after the 2026-09-30 cleanup: `map` (GA1), `integrity` (GA5), `priors`, `lakes` (4 CI check suites; flags `geoDecl`/`geoLakeFloor`/`geoLakes` off, app unchanged). GA2–GA4 code and `geoInliers` removed ([negative-results.md](negative-results.md#code-removed-in-the-2026-09-30-cleanup)). Dev only, `tools/research/geo/` | GA1 MAP solver: pitch pass, σ ~2.5× over-confident. GA2/GA3/GA4/GA5 **killed**: T-junctions work on renders but not on photos; lake cues carry a 4 px bias (≈11 m); GA5 protection level separates wrong basins (AUROC 0.94) and catches 9/10 of E1's wrong eyes, but at a 36% correct-pose cost | GA5 as a candidate in the R2 veto prereg; eye cues wait for a learned contour detector (GC3) |
| **Concordance** (whole-frame fit) | Kept under `src/lib/concord`: core, cues, priors (focal table), occl, app; flags `?concord=eye,occl` (off by default). The warp (WP-E), joint solve (WP-D) and re-match loop (WP-G) code was removed 2026-09-30 ([negative-results.md](negative-results.md#code-removed-in-the-2026-09-30-cleanup)) | Focal table: holdout 1.99%→0.32% (n = 2). DSM occluder: smear removal 4–15% → 46–59% (dev). The joint solve made holdout **worse** (8.8→16.2 px median; 7130's eye moved 200 m) and is unsafe as gated. Warp: no gain (0/8 holdout pins better) | You click interior pins (`tools/concord/pins/PROTOCOL.txt`); any new solve must gate on held-out pins (restore from `a1845f5` if useful) |
| **Step Inside** (near-field 3D) | Built in both renderers; opt-out via `?nearfield=off` | Smear gate 4% (three) / 15% (deck) vs 80%. Pose propagation: 0/83 wrong pairs pass | Semantic + depth split (v1.1); propagation prereg |
| **Renderer** (deck.gl default, [deck-default.md](deck-default.md)) | **Not flipped** (2026-09-30); default stays three, `?renderer=deck` opt-in. deck photo view now at three parity | Photo drag / Blend lens 10–26 → 59–60 fps; export 2× slower → faster than three; eval-app 12/14 on both. Flip gate fails on world orbit (29–39 fps vs ≥ 45): the multisampled deck canvas; `antialias: false` measured 59 fps | Canvas antialias off + DPR 1 pixel diff, re-capture style-baseline, Firefox smoke, re-run the gate, then flip |
| **Launch** | Two commits; CI fast tier written (`.github/workflows/ci.yml`, `scripts/ci/`), not yet pushed; licence register + opt-in swaps done, owner decisions open; no iOS path; no hosted matcher | Still nobody else ships automatic post-hoc registration | CI gate + licence swaps before any public URL |

## What the threads teach together

1. **The near field is the shared bottleneck.** Matching fails on foreground-heavy frames, Step Inside's split misses huts and trees at 100–300 m, and concordance finds 18–55% of below-skyline pixels hit non-DEM objects. One signal (swissSURFACE3D minus swissALTI3D, streamable as COGs) serves all three.
2. **Multi-photo is the recall frontier.** Propagation, the joint panorama solve and the top-3 picker are the only directions with positive evidence past the single-photo ceiling.
3. **Data, not ideas, is the limit.** The veto is calibrated on ≤ 7 hard negatives, propagation has no held-out set, and concordance has no interior pins. The v034 basin gap was tuned on labels that later flipped (roadmap N4).
4. **Learned single-photo geometry was the weak link everywhere** (mono depth scale, anchor-as-verifier, generative fill). Keep it on top of the DEM, never under it.

## Evaluation budget

| Set | State | Claimants |
|---|---|---|
| Wild test half (50) | Spent | — |
| `data_v3` (74 photos, 14 non-Swiss) | Sealed; draft [v3-prereg.md](v3-prereg.md) | v3 matcher, H2 veto, recall levers. Too few co-located pairs for propagation |
| New ~100-photo collection with trip sequences | Proposed | Propagation, pano solve, data_v4. Seal it before v3 is opened |
| Concordance interior pins | Not clicked | Every concordance accuracy claim |

## Ready to run now

| Work | Where | Blocked on |
|---|---|---|
| H1 blind verification | `tools/research/tm/h1_mine/REPORT.txt` ("How to run the verifiers") | Nothing |
| Style-baseline re-capture (0/16 identical back to a7287da: trails off by default since 71e846e, baseline never re-captured; [deck-default.md](deck-default.md)) | `node scripts/ci/run.mjs full --only style-baseline` | Owner of `out/lead/style-baseline` |
| Smear v1.1 re-measure | `tools/nearfield/smear/labels.json` | Choice of a permissively licensed segmenter |
| Completion P0 (slab diagnosis first) | `research_notes/completion_integration_2026-09.md` §3 | Provenance decision (below) |

## Decisions waiting on you

1. **Evaluation data:** collect the ~100-photo set now? In what order do claimants spend `data_v3`?
2. **Propagation prereg** sign-off, and which camera-roll viewpoints form its held-out set.
3. **Top-3 picker / tap-a-peak:** built behind `?picker=on` (`src/lib/picker/README.md`). Turn it on by default once you've tried it? Picks are logged, and they need blind verification before they enter any benchmark.
4. **Imagery licence:** replace Esri World Imagery outside Switzerland, or buy ArcGIS access?
5. **Step Inside v1.1** in the beta as opt-in, or wait for the smear gate?
6. **Completion provenance:** reuse `generated`, or add a new code (which needs the `isMeasurable` allow-list fix)?
7. **Funding:** one GEN3C rented-GPU run; gated downloads for completion P1 (3DB, SAM 3D).
8. ~~3D Tiles in Step Inside~~: answered 2026-09-29. US billing; rendering accepted; swisstopo first. Built behind `?tiles3d=` ([step-inside-google-3d-tiles.md](step-inside-google-3d-tiles.md), roadmap S3). Open: T2 (tiles into the split) and the official Google logo before any public URL.

## Housekeeping

- **Disk:** ~33 GB free (93%) after the 2026-09-30 prune of ~6 GB of gitignored caches, killed-research weights (GeoCalib/AnyCalib, tm matcher weights) and research `.pylib`s. Do **not** prune `tools/research/tm/weights/x2` or `.pylib_x2`: the near-field service loads MoGe-2/DA3 from there. Remaining optional prunes: `tools/research/tm/cache` (2.4 GB, keep `wc_0054/meta.json`), `tools/nearfield/service/weights/sharp_*.pt` (2.6 GB, research licence). Check `df -h` before model downloads or renders.
- **GPU:** one browser or render job at a time (`node scripts/gpu/with-render-lock.mjs -- <cmd>`). The near-field service holds the lock until it unloads when idle.
- **2026-09-30 cleanup pass** (mt-image-80): format/imports, style-check fixed, dead exports and duplicated helpers removed, killed experiments deleted (see [negative-results.md](negative-results.md) "Code removed"), load-path perf (warm ready ~2.0 → ~1.2 s; three terrain decode/mesh in workers; 3D Tiles and roll lazy-loaded).
