# Rigi: where things stand

*2026-10-02. Entry point. The plan is [roadmap.md](roadmap.md), dead ends are [negative-results.md](negative-results.md), the doc index is [README.md](README.md), change history is `CHANGELOG.md`. When a number here disagrees with its linked source, the source wins. Keep cells to one or two sentences and update the date when a thread moves.*

Most work landed on 2026-10-01/02 passed the fast tier only and is **browser-unverified**; it waits for one batch browser pass ([batch-ledger.md](batch-ledger.md)).

## Threads

| Thread | State | Evidence | Next |
|---|---|---|---|
| **Registration** | App pipeline stable. No backend: the render-and-match matcher (v0.4.0 port, `?matcherPolicy=v034\|t6`), ALIKED + LightGlue and pose propagation run in the browser (`src/lib/matcher`, `src/lib/features`; 8bb109d0). Top-3 picker behind `?picker=on` | App 12/14 within 1°, 0 false accepts (both engines). Held-out wild test 29/50 correct, HIGH 17/17. ~20% of wild photos auto-accept | R1 blind-verify the hard-negative pack → R2 veto prereg → R3 recall levers |
| **Fundamentals** ([fundamentals-plan.md](fundamentals-plan.md)) | Phase 0 (E0–E3) killed 09-29. Phase 1 ran 10-02: **E5 ray-cast oracle passed** on dev (`src/lib/raycast`, not wired); E4 step 1 and E0r killed | Held-out likelihood can't reject wrong eyes (E1 accepts 10/56 displaced-eye decoys) | E5 adoption decision; any future veto must pass the displaced-eye decoys |
| **Geometry-first camera** ([geometry-first-pose.md](geometry-first-pose.md)) | `src/lib/geocam` built, flags off. GA1 solver kept; GA2–GA5 and the skyline-parallax eye test (10-02) killed | GA5 separates wrong basins (AUROC 0.94), catches 9/10 E1 wrong eyes at a 36% correct-pose cost | GA5 as an R2 veto candidate |
| **Concordance** ([concordance-research.md](concordance-research.md)) | `src/lib/concord` behind `?concord=eye,occl,labels,drape`, off. Focal table applied under `eye`; C4 label/drape hooks landed, nothing consumes them | Focal table holdout 1.99% → 0.32% (n = 2); DSM occluder smear removal 46–59% (dev) | Click the interior pins (`tools/concord/pins/PROTOCOL.txt`); every accuracy claim waits on them |
| **Step Inside** ([step-inside-results.md](step-inside-results.md)) | Runs fully in the browser on WebGPU: MoGe-2 ViT-S depth on `src/lib/nn` (int8 download 36 MB, prefetch, terrain preview), lift on the compute graph, splats on luma's splat stack. Without WebGPU compute the panel says so. 3D Tiles behind `?tiles3d=`; people volumes behind `?nearfield=complete` | Smear gate 15% vs 80% target. Propagation: 0/83 wrong pairs pass | End-to-end browser run; v1.1 semantic + depth split (needs a permissive segmenter) |
| **Live camera** (`/live`) | Route, camera pump, orientation sensors, frame governor, clip replay; skyline pose tracker `src/lib/track` (output is a suggestion) | Plan and costs: [realtime-investigation-2026-10-02.md](realtime-investigation-2026-10-02.md) | Sign off the tracker gate ([tracker-gate-draft.md](tracker-gate-draft.md)) |
| **Renderer** ([webgpu-default.md](webgpu-default.md)) | deck.gl on WebGPU by default, WebGL2 deck fallback (`?renderer=deck`); three.js removed. Vendored luma `10.0.0-alpha.2-rigi.6`, deck `9.4.0-rigi.3`. Default look **Landeskarte** (9b2a6e8, revertable alone). `/roll` map and the landing map on WebGPU too | World orbit 59–60 fps (DPR 2); deck-smoke Δyaw 0.00°; pose-view parity masks IoU 1 (before the 10-02 waves) | Batch browser pass; deck style-baseline capture; Windows/Safari smoke |
| **GPU compute** ([gpu-renderer.md](gpu-renderer.md)) | `ComputeGraph` over luma's `GPUCommandGraph` is the only GPU path; luma gpgpu operators, gpu-raster ops and `src/lib/nn` forwards share one graph. No ML runtime ships. `skylineGpu` on; `renderBundles` opt-in | Waves 3–4 browser pass: no revert candidate, eval-app 12/14 both engines, VRAM 371 → 241 MiB. Later waves Dawn-checked in node only | Open items in [gpu-renderer.md](gpu-renderer.md) |
| **Gipfelbuch** ([gipfelbuch.md](gipfelbuch.md)) | 16 hand-drawn sheets (5f15c55) with live plates and photo spill; merged ids redirect | Browser-unverified | Open fixes and 8 decisions in [gipfelbuch.md](gipfelbuch.md) |
| **Cartography** ([swiss-cartography-review.md](swiss-cartography-review.md)) | Palette tokens, Landeskarte default, Imhof relief, hatch v2, swisstopo labels, self-hosted fonts | D1, D2, D7, D8 fixed; D3–D5, D9–D14 open | D3 (Landeskarte invisible on the satellite default) needs your call |
| **Code health** ([code-review-2026-09-30.md](code-review-2026-09-30.md)) | 68 fixed, 4 obsolete, 5 open (CR-13, 41, 46, 67, W2) | — | Roadmap N7 |
| **Tests and CI** ([scripts/ci/README.md](../scripts/ci/README.md)) | Fast tier (tsc, biome ratchet, node/Dawn checks, Vitest `unit`) + full tier (browser). GitHub CI runs the fast tier, `vite build`, examples site | Fresh clone builds and passes the fast tier without `data/` | Browser checks in batched passes only |
| **Launch** | Landing, `/library`, `/gipfelbuch`, demo set; prod builds drop `/dev` and `/lab`; fonts self-hosted; licence register ([licences.md](licences.md)) | Nobody else ships automatic post-hoc registration | Owner licence decisions; no iOS path |

## What the threads teach together

1. **The near field is the shared bottleneck.** Matching fails on foreground-heavy frames, Step Inside misses huts and trees at 100–300 m, and 18–55% of below-skyline pixels hit non-DEM objects. One signal (swissSURFACE3D − swissALTI3D) serves all three.
2. **Multi-photo is the recall frontier.** Propagation, the panorama solve and the top-3 picker are the only directions with positive evidence past the single-photo ceiling.
3. **Data, not ideas, is the limit.** The veto rests on ≤ 7 hard negatives, propagation has no held-out set, concordance has no interior pins.
4. **Learned single-photo geometry goes on top of the DEM, never under it.**

## Evaluation budget

| Set | State | Claimants |
|---|---|---|
| Wild test half (50) | Spent | — |
| `data_v3` (74 photos, 14 non-Swiss) | Sealed; draft [v3-prereg.md](v3-prereg.md) | v3 matcher, H2 veto, recall levers |
| New ~100-photo set with trip sequences | Proposed (N3) | Propagation, pano solve, data_v4. Seal before opening v3 |
| Concordance interior pins | Not clicked | Every concordance accuracy claim |
| Live tracker clips | Gate draft only | `src/lib/track` beyond "suggestion" |

## Ready to run

| Work | Where | Blocked on |
|---|---|---|
| Batch browser pass over every ledger row (renderer, GPU waves, nn runtime, in-browser matcher and Step Inside, roll map WebGPU, Gipfelbuch) | [batch-ledger.md](batch-ledger.md), each step through `scripts/gpu/with-render-lock.mjs` | An owner |
| Deck style-baseline capture (the check SKIPs; the default look changed) | `node scripts/ci/run.mjs full --only style-baseline` | Same pass |
| H1 blind verification | `tools/research/tm/h1_mine/REPORT.txt` | Nothing |
| Smear v1.1 re-measure | `tools/nearfield/smear/labels.json` | A permissively licensed segmenter |

## Decisions waiting on you

1. **Evaluation data:** collect the ~100-photo set now? Order of claimants on `data_v3`?
2. **Propagation prereg** sign-off and its held-out viewpoints; **tracker gate** sign-off.
3. **Top-3 picker:** default-on after you try `?picker=on`?
4. **Imagery licence:** replace Esri World Imagery outside Switzerland, or buy ArcGIS access?
5. **Step Inside v1.1** as an opt-in beta, or wait for the smear gate?
6. **Completion provenance:** reuse `generated` or add a code (blocks behind-layer inpainting)?
7. **Funding:** one GEN3C rented-GPU run; gated downloads for completion P1.
8. **E5 ray-cast oracle:** adopt into the matcher (headless geometry, ortho colour output)?
9. **Landeskarte default** (keep after the browser pass, or revert 9b2a6e8) and cartography D3.
10. **Product defaults from the step reviews:** `geoDecl`, eye height 1.6 vs 1.8 m, roll bias window, `?firstOverlay=prior`, unverified-export mark (list in [roadmap.md](roadmap.md) P-rows).

## Housekeeping

- **Disk** runs near full; check `df -h` before renders or model downloads. Never prune `tools/research/tm/weights/x2` or `.pylib_x2` (`scripts/models/moge2-vits.py` imports MoGe from there).
- **GPU jobs** go through `node scripts/gpu/with-render-lock.mjs -- <cmd>`, one step at a time, in batched passes only. Kill only your own PIDs.
- **Before a dead-code pass** read [cleanup-2026-10-01.md](cleanup-2026-10-01.md) (removals register and kept-on-purpose list).
