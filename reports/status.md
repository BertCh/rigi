# Rigi: where things stand

*2026-09-29. This is the entry point. The plan is in [roadmap.md](roadmap.md), dead ends are in [negative-results.md](negative-results.md), and every doc is indexed in [README.md](README.md). When a number here disagrees with the linked source, the source wins. Update the date and the tables when a thread moves.*

## Threads

| Thread | State | Headline evidence | Next step |
|---|---|---|---|
| **Registration** | App pipeline stable. Matcher v0.4.0 runs locally only. Terrain-matching research done. Hard-negative pack built (120 overlays, 27 photos), not yet verified | App: 12/14 within 1°, 0 false accepts. Held-out wild test: 29/50 correct, HIGH 17/17 (arm A). ~20% of wild photos auto-accept | Blind-verify the pack → veto prereg → recall levers ([roadmap](roadmap.md) R1–R3) |
| **Concordance** (whole-frame fit) | Research done; WP-A..G being built under `src/lib/concord` (session f3) | The skyline can't see eye error (10 m shift = 0.2–2 px of skyline). Interior error 73 px at 50–500 m, 2.5 px at 2–5 km. Lens focal table cuts focal error 1.85%→0.54% | You click interior pins; then the joint solve is measured |
| **Step Inside** (near-field 3D) | Built in both renderers; opt-out via `?nearfield=off` | Smear gate 4% (three) / 15% (deck) vs 80%. Pose propagation: 0/83 wrong pairs pass | Semantic + depth split (v1.1); propagation prereg |
| **Launch** | Two commits; no CI; licences open; no iOS path; no hosted matcher | Still nobody else ships automatic post-hoc registration | CI gate + licence swaps before any public URL |

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
| Propagation DEM-render check (GT error vs parallax) | `tools/nearfield/propagate/` | Nothing |
| Smear v1.1 re-measure | `tools/nearfield/smear/labels.json` | Choice of a permissively licensed segmenter |
| Completion P0 (slab diagnosis first) | `research_notes/completion_integration_2026-09.md` §3 | Provenance decision (below) |

## Decisions waiting on you

1. **Evaluation data:** collect the ~100-photo set now? In what order do claimants spend `data_v3`?
2. **Propagation prereg** sign-off, and which camera-roll viewpoints form its held-out set.
3. **Top-3 picker / tap-a-peak:** build it? It is the biggest recall lever.
4. **Imagery licence:** replace Esri World Imagery outside Switzerland, or buy ArcGIS access?
5. **Step Inside v1.1** in the beta as opt-in, or wait for the smear gate?
6. **Completion provenance:** reuse `generated`, or add a new code (which needs the `isMeasurable` allow-list fix)?
7. **Funding:** one GEN3C rented-GPU run; gated downloads for completion P1 (3DB, SAM 3D).
8. **3D Tiles in Step Inside** ([step-inside-google-3d-tiles.md](step-inside-google-3d-tiles.md)):
   - Add `3d-tiles-renderer`, and build the shared tiles layer on swisstopo first (roadmap S3)?
   - Google backdrop: only possible from a non-EEA (CH/UK) billing account. It needs Google's written answer on the "non-Google map" clause. Pursue it or drop it?

## Housekeeping

- **Disk:** 12 GB free (98% full). About 3.5 GB of weights and packages in `tools/research/tm` can be pruned. Check `df -h` before model downloads or renders.
- **GPU:** one browser or render job at a time (`node scripts/gpu/with-render-lock.mjs -- <cmd>`). The near-field service holds the lock until it unloads when idle.
- **Uncommitted:** this page, roadmap, negative-results, concordance, and the completion notes.
