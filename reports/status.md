# Rigi: where things stand

*2026-10-02. Entry point. The plan is [roadmap.md](roadmap.md), dead ends are [negative-results.md](negative-results.md), the doc index is [README.md](README.md), and change history is `CHANGELOG.md`. When a number here disagrees with its linked source, the source wins. Update the date and the rows when a thread moves; keep cells to one or two sentences.*

## Threads

| Thread | State | Evidence | Next |
|---|---|---|---|
| **Registration** | App pipeline stable; matcher v0.4.0 is local only. Top-3 picker behind `?picker=on` (R4). Stage-1 render workers re-based on deck/WebGPU (wave 5 S1, browser-unverified) | App 12/14 within 1°, 0 false accepts (both engines). Held-out wild test 29/50 correct, HIGH 17/17. ~20% of wild photos auto-accept | R1 blind-verify the hard-negative pack → R2 veto prereg → R3 recall levers |
| **Fundamentals** ([fundamentals-plan.md](fundamentals-plan.md)) | Phase 0 done 2026-09-29: E0–E3 all killed | Better renders add no matches; held-out likelihood can't reject wrong eyes (E1 accepts 10/56 displaced-eye decoys) | Decide phase 1 (E4 dense refinement, E5 ray-cast oracle). Any future veto must pass the displaced-eye decoys |
| **Geometry-first camera** ([geometry-first-pose.md](geometry-first-pose.md)) | `src/lib/geocam` built, flags off. GA1 solver kept; GA2–GA5 killed | GA5 separates wrong basins (AUROC 0.94), catches 9/10 E1 wrong eyes at a 36% correct-pose cost | GA5 as an R2 veto candidate; eye cues wait for a learned contour detector |
| **Concordance** ([concordance-research.md](concordance-research.md)) | `src/lib/concord` (core, cues, priors, occl, app) behind `?concord=eye,occl`, off. Joint solve, warp and re-match removed 2026-09-30 | Focal table holdout 1.99% → 0.32% (n = 2); DSM occluder smear removal 46–59% (dev). Joint solve made holdout worse | Click the interior pins (`tools/concord/pins/PROTOCOL.txt`); every accuracy claim waits on them |
| **Step Inside** ([step-inside-results.md](step-inside-results.md)) | Near-field splats on both engines; `?nearfield=auto` probes the :8767 service. 3D Tiles behind `?tiles3d=` | Smear gate 15% vs 80% target. Propagation: 0/83 wrong pairs pass | v1.1 semantic + depth split (needs a permissive segmenter); end-to-end WebGPU run |
| **Renderer** ([webgpu-default.md](webgpu-default.md)) | deck.gl on WebGPU by default, WebGL2 deck fallback (`?renderer=deck`); three.js removed. Vendored luma `10.0.0-alpha.2-rigi.4`, deck `9.4.0-rigi.2` (843dfc0). Default look = **Landeskarte** since 9b2a6e8 (revert that commit alone for Classic). Opt-in looks: Nebelmeer, trails, weather, water, wind, terroir hatch, sketch ink, Imhof relief | World orbit 59–60 fps (DPR 2); deck-smoke Δyaw 0.00°; pose-view parity masks IoU 1 | Wave 5 browser pass (below); deck style-baseline capture; Windows/Safari smoke |
| **GPU compute** ([src/lib/gpu/README.md](../src/lib/gpu/README.md)) | `ComputeGraph` over luma's `GPUCommandGraph` is the only GPU path; under WebGPU the render device computes. Certified-f32 horizon/align, GPU terrain cull/decode, sky prep, unknown-pose grid, haze band/arg-min, GPU stats fold, `mosaicGpu` on by default; `skylineGpu`, `renderBundles`, `?colorTarget=rg11b10` opt-in | Waves 3–4 browser pass (2b, [results](../research_notes/whole-app-graph-2026-10-01/consolidated-pass-results.md)): **no revert candidate**, full tier 67 pass, eval-app 12/14 both engines. VRAM 371 → 241 MiB | WAG-next in the roadmap; wave 5 GPU items are browser-unverified |
| **Code health** ([code-review-2026-09-30.md](code-review-2026-09-30.md)) | CR backlog; CR-02, CR-04, CR-06 fixed in wave 5 (f2dfb49) | See the backlog's summary line | Roadmap N7 |
| **Tests and CI** ([scripts/ci/README.md](../scripts/ci/README.md)) | `node scripts/ci/run.mjs` fast tier (tsc, biome ratchet, unit checks, Vitest `unit` row) + full tier (browser). GitHub CI runs fast tier, `vite build`, examples site | Fresh clone builds and passes the fast tier without `data/` | Keep the fast tier green; browser checks in batched passes only |
| **Gipfelbuch** (`/gipfelbuch`) | 19 hand-drawn explainer pages on a Swiss field-notebook sheet, committed f5e51f3; live plates and photo spill in progress | Browser-unverified | Fix list: [gipfelbuch-comprehensive-review-2026-10-01.md](gipfelbuch-comprehensive-review-2026-10-01.md) |
| **Launch** | Landing, `/library`, `/gipfelbuch`, bundled demo set; prod builds drop `/dev` and `/lab`; fonts self-hosted; licence register done ([licences.md](licences.md)) | Nobody else ships automatic post-hoc registration | Owner licence decisions; Python half of CR-26; no hosted matcher, no iOS path |

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

## Ready to run

| Work | Where | Blocked on |
|---|---|---|
| Wave 5 + 10-02 browser pass: Landeskarte default, Imhof/hatch v2 (compile the WebGL2 twins), `mosaicGpu`, chrome/fonts, how-it-works theme, Gipfelbuch | Rows in [batch-ledger.md](batch-ledger.md), each step through `scripts/gpu/with-render-lock.mjs` | An owner (cook mode: coordinator only) |
| Deck style-baseline capture (the check SKIPs until it exists; the default look changed) | `node scripts/ci/run.mjs full --only style-baseline` | Same pass |
| H1 blind verification | `tools/research/tm/h1_mine/REPORT.txt` | Nothing |
| Smear v1.1 re-measure | `tools/nearfield/smear/labels.json` | A permissively licensed segmenter |

## Decisions waiting on you

1. **Evaluation data:** collect the ~100-photo set now? Order of claimants on `data_v3`?
2. **Propagation prereg** sign-off and its held-out viewpoints.
3. **Top-3 picker:** default-on after you try `?picker=on`?
4. **Imagery licence:** replace Esri World Imagery outside Switzerland, or buy ArcGIS access?
5. **Step Inside v1.1** as an opt-in beta, or wait for the smear gate?
6. **Completion provenance:** reuse `generated` or add a code?
7. **Funding:** one GEN3C rented-GPU run; gated downloads for completion P1.
8. **WAG P2/P3** ([whole-app-graph-plan.md](whole-app-graph-plan.md) §5): defer photo rasterisation parity (recommended); keep WebGL as a CPU-crossing fallback (recommended), which decides whether `/roll` moves to WebGPU. Memo: [p3-roll-webgpu-memo.md](../research_notes/gpu-pod-d-2026-10-02/p3-roll-webgpu-memo.md) (recommends compute first, render port later behind a flag).
9. **Landeskarte as the default look:** keep after the browser pass, or revert 9b2a6e8?

## Housekeeping

- **Disk** runs near full; check `df -h` before renders or model downloads. Never prune `tools/research/tm/weights/x2` or `.pylib_x2` (the near-field service loads from there).
- **GPU jobs** go through `node scripts/gpu/with-render-lock.mjs -- <cmd>` (FIFO, lock in `~/.cache/rigi`), one step at a time, in batched passes only. Kill only your own PIDs.
- **Cleanup records:** [cleanup-2026-10-01.md](cleanup-2026-10-01.md) (what was removed and what is kept on purpose; read before any dead-code pass) and [negative-results.md](negative-results.md#code-removed-in-the-2026-09-30-cleanup).
