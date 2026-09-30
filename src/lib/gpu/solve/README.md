# src/lib/gpu/solve: solvePose coarse grid on the GPU

Wired into the unknown-pose worker on 2026-09-30. `geo/solve.ts` gained `solvePoseAsync` with a `CoarseProvider`, and `geo/pipeline.ts` gained `cascadeAsync`. The worker passes `solveCoarse` when the page's `gpuEnabled()` allows it, sent as `solveGpu`; `?gpu=off` turns it off. It is on by default because the result is the CPU's by construction.

A/B of the real worker (`ABL_MODES=cpu unknown-horizon.mjs ablation`, normal vs under `with-gpu-off.mjs`): 12 photos × 5 conditions = 60 requests. All 60 are identical in pose, confidence, accept, stage and seeds. Solve time (total minus horizon) summed 187 s on the CPU vs 25 s with the GPU grid; the median request went from 870 to 339 ms, and the slowest from 13.1 s to about 1 s.

`solvePose` (`src/lib/geo/solve.ts`, `solveOnce`) starts with a coarse stage. It scores a dYaw × dPitch grid with a truncated-L1 cost over every second skyline column, keeps the best pitch for each yaw, and from the resulting yaw curve takes:
- the local minima,
- up to 3 LM seeds,
- `SolveResult.coarse`,
- `SolveResult.ambiguity`, which depends on the best cost, the runner-up cost and the median cost.

The unknown-pose cascade is where the grid gets big: 360° of yaw, and ±15° of pitch when gravity is unknown. There the grid is **90–98 % of solvePose's time**: 1.7–4.9 s per call on the dev photos, and the worker runs it up to 3 times, once per focal seed.

| File | What it does |
|---|---|
| `cpu.ts` | Re-exports `planCoarse` (solveOnce's inputs: observations, accumulated yaw/pitch grids, truncation, sigmas) and `coarseCost` (one cell) from `geo/solve.ts`, which its own `coarseStage` uses, so there is no copy to drift. `coarseRow` scores a row exactly. `coarseCpu` is the whole-grid twin. `selectCoarse` / `finish` do solveOnce's selection and ambiguity. `fullSearchOptions` gives the 360° pass's options. |
| `coarse.wgsl.ts` | One dispatch. Each workgroup takes one yaw row and one block of 256 pitches, and writes the block's minimum cost plus the first/last pitch within 2.5ε of it. |
| `index.ts` | `coarseGpu(device, plan)` returns `CoarseResult` + stats. `solveCoarse(prior, horizon, sky, opts)` is the drop-in: GPU when there is a compute device, CPU otherwise, `null` when there is no skyline. Also `warmSolveGpu` and `costBound`. |
| `bench.ts` | The browser side of `scripts/gpu/solve-bench.mjs`. |

## Why the result is identical by construction

This follows the same pattern as skyglobal: the GPU bounds and scores, then the CPU re-scores the candidates exactly.
1. **Error bound.** `costBound` certifies ε ≥ |f32 GPU cost − f64 exact cost| for every cell, with a ×4 safety factor. It accounts for:
   - the (bin, fraction) azimuth split,
   - interpolation error times the steepest profile step,
   - the error of summing nObs terms in order,
   - the priors.

   Measured on the bench, the error is at most **5e-3 ε**.
2. **Row intervals.** Each row minimum g gives an interval [g − ε, g + ε] for the exact row minimum.
3. **Bounded selection.** `selectBounded` runs solveOnce's selection on those intervals and makes a decision only when the intervals settle it. When they don't, the CPU re-scores the rows involved exactly with `coarseRow` and re-runs the step. The steps are:
   - local-minimum tests;
   - the best-first walk (stable ties) through the seeds and the runner-up, which also checks that no unvisited row could sort before the last one read;
   - the median, where only rows whose interval meets the rank-k band [L, U] are re-scored.
4. **Pitch band.** A re-score covers only the row's pitch band. Any pitch outside the band has a GPU cost above g + 2ε, so its exact cost is strictly above the exact row minimum. The band therefore contains the row's *first* minimum, which is what solveOnce's strict `<` picks.

Typical re-scoring work is 4–33 rows and about 1 cell per row. The bench also runs every case with ε × 100: up to 2706 of 3601 rows get re-scored, and the result is still identical, which exercises every branch.

Readback is 16 B per (row, pitch block), at most 60 KB. A top-K readback (GPUSort) was not used because the selection needs the whole yaw curve: local minima and the median.

## Bench (`scripts/gpu/solve-bench.mjs`, 2026-09-30, Apple GPU, headless Chromium)

The bench used 5 photos (IMG_6958, 7018, 7063, 7068, 7131) under the worker's 4 option sets (known / nogravity / noheading / none), 20 cases in total:
- **Parity with the CPU twin.** GPU = CPU twin on all 20 cases: coarse, seeds (dy, dp, c), runner-up, median and ambiguity. The ε × 100 stress run also matches on all 20.
- **Parity with solvePose.** The twin equals `solvePose`'s own `coarse` and `ambiguity` bit for bit on all 20 cases.

| condition | grid | CPU grid | GPU warm | grid share of solvePose |
|---|---|---|---|---|
| known (±25°, ±3°) | 350–501 × 42–61 | 47–122 ms | 0.9–1.5 ms | 71–84 % |
| nogravity (±15° pitch) | 350–501 × 210–301 | 226–631 ms | 0.9–1.8 ms | 87–91 % |
| noheading (360°) | 2518–3601 × 42–61 | 336–967 ms | 2.7–5.0 ms | 91–96 % |
| none (360° × ±15°) | 2518–3601 × 210–301 | 1.68–4.79 s | 2.8–5.4 ms | 94–98 % |

A cold call, which includes the pipeline compile on the first photo, takes 6–10 ms.

## Integration note (for the owners of geo/ and integration/)

1. **`src/lib/geo/solve.ts`** (geo owner):
   - Split `solveOnce` into `coarseStage(cam0, horizon, obs, opts) → { seeds, coarse, ambiguity }`, which is today's code verbatim, and the fine stage, which consumes those three values.
   - Export `coarseCost`, or the stage itself, so that `cpu.ts` imports it instead of rebuilding it. Done (2026-09-30): `planCoarse`, `coarseCost`, `CoarsePlan` and `DEFAULT_SIGMA` are exported and `coarseStage` runs on them.
   - Add `solvePoseAsync(prior, horizon, sky, opts, coarse?)`. It calls `await coarse(prior, horizon, sky, onceOpts)` with the options solveOnce receives. For the 360° pass those are `fullSearchOptions(opts)` (the accept threshold is not part of the coarse stage). It falls back to `coarseStage` when `coarse` resolves `null` or is not given.
   - The sync `solvePose` stays as it is: CPU, and the reference.
2. **`src/lib/geo/pipeline.ts`**: add `cascadeAsync`, which is `cascade` with `await solvePoseAsync(…, solveCoarse)`. refinePose stays on the CPU. Its FFT correlation (`refine/init.ts`) is already cheap and is not a grid.
3. **`src/lib/integration/unknown-pose.worker.ts`** (integration owner):
   - Use `cascadeAsync` when the request opts in. Reuse `req.gpu` / `unknownGpuOptIn`, so `?gpu=off` disables it through `getComputeDevice()`.
   - Call `warmSolveGpu(device)` on the `prepare` message, next to the horizon.
   - The three focal seeds run one after another. Each saves 1.7–4.8 s on "none", so a no-heading / no-gravity / unknown-focal upload goes from about 5–15 s of solve to well under 100 ms of grid.
   - `/roll` batch align goes through the same worker path.
4. Nothing else changes. When the device is missing or lost, `solveCoarse` resolves the CPU grid. It also falls back to the CPU for:
   - a non-finite horizon,
   - `nH · step ≠ 360`,
   - more than 65535 yaw rows,
   - a selection inconsistency, which would mean the bound was violated. This has never been seen, and `stats.fellBack` records it.
