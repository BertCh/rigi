# vis.gl demo survey: what Rigi can learn (2026-10-02)

A read-only survey of the newest luma.gl, deck.gl, math.gl and loaders.gl demos and APIs against Rigi. Four parallel surveys, one per area; this page ranks what they found. No mt-image code was changed, and no browser, GPU or render-lock job ran. Every item below is a proposal, not measured in the app.

Sources: luma `origin/master` `931ec1c53` (2026-10-02, 70 commits past the local `vis.gl-upstream/luma.gl` checkout), deck.gl `origin/master`, math.gl master `ae022d93` (v5.0.0-alpha.11), loaders.gl `origin/master` `300f837c7`, the user's `deck-sky` project, and open PRs via `gh`. Prior reports read first so adopted or rejected items are not re-proposed: `luma-frontier-2026-10-01-late.md`, `luma-deck-upstream-2026-10-01.md`, `gpu-luma-native-2026-10-01.md`, `luma-native-dependency-audit-2026-10-02.md`, `realtime-investigation-2026-10-02.md`, `whole-app-graph-plan.md`.

| Survey | Scope | File |
|---|---|---|
| A | Compute and graph demos (`v10/gpgpu`, gpu-sort, gpu-trace-*, gpu-frustum-culling, gpu-data-analysis, gpt-2, fluid-foundry, inspector panel) | [a-compute.md](a-compute.md) |
| B | Rendering demos (showcase/*, effects, AA, shadows, a-buffer, splats, raster/Poisson/spectral labs, render bundles, multi-canvas) | [b-render.md](b-render.md) |
| C | deck.gl-on-luma demos (city-scene, weather, flow-particles, river-district, gpu-culled-trace), deck.gl master and PRs, deck-sky | [c-deck.md](c-deck.md) |
| D | math.gl, loaders.gl and luma API diff since rigi.6 | [d-apis.md](d-apis.md) |

## Headline

- **No lesson needs a vendor bump.** Every luma API the demos use that Rigi could adopt is already in `10.0.0-alpha.2-rigi.6`. There is no new runtime API on master since rigi.6 (D). The private packages (`deck-gpu-layers`, `scene`, `text`, `gltf`) are not needed.
- **The biggest wins come from rigi.6 graph APIs Rigi does not use yet:** budgeted multi-frame execution, the inspector's counters, in-encoder parameter writes, the autotuner and the indirect command buffers.
- **One hazard:** rebuilding the vendored luma on today's master would silently undo two local fixes (see P0).

## Ranked lessons

Effort: S < 1 day, M a few days, L larger. "Both engines" means a GLSL and a WGSL edit (AGENTS.md).

### P0: correctness and guard rails

| # | Lesson | Target | Effort | Source |
|---|---|---|---|---|
| 1 | **Re-vendor guard.** luma master still has the loop `reverseLowBits` that miscompiles on Apple/Metal (verified: master `gpu-fft-utils.ts:23` vs rigi.6 `dist/gpu-core/gpu-fft-utils.js:15` `reverseBits(`), and master `modules/splats` lacks #3340 (`selectView`), which the default Step Inside splat renderer uses. Add a check to the vendor rebuild that greps the built dist for `reverseBits(` and `selectView`, so a rebuild on master does not break the guided filter, the refine FFT and Step Inside. | `vendor/luma/README.md` rebuild steps, a fast-tier check | S | B |
| 2 | **3D Tiles screen-space error ignores field of view.** The installed `@loaders.gl/tiles` hard-codes `sseDenominator: 1.15`, which is right only for a 60° view (verified `dist.dev.js:7101`). At a 40° photo view Step Inside tiles load about 1.6× too coarse. Fixed upstream in loaders #4056, after alpha.7. Until then, scale `maximumScreenSpaceError` by `2·tan(fov/2)/1.15`. | `src/lib/tiles3d/tiles.ts:202` | S | D |
| 3 | **Time zone from longitude.** `offsetFromLongitude` (`src/lib/upload/exif.ts:297`) is `round(lon/15)` with no DST, so Swiss summer photos are 1 h off. The error feeds the sun path and roll time interpolation. `@math.gl/timezone` does a lazy zone lookup plus an `Intl` offset; skip its `/temporal` subpath, which pulls in a polyfill. | `src/lib/upload/exif.ts`, `terroir/ui/SunPath.tsx`, `roll/import` | S | D |
| 4 | **Two copies of `@math.gl/core` installed.** The app uses alpha.10; loaders.gl and `@math.gl/geospatial` pin alpha.9. `tiles3d/frame.ts` passes a `Matrix4` across that boundary. Pin every `@math.gl/*` to one version with `overrides`. | `package.json` | S | D |
| 5 | **Rain and snow are WebGL-only.** `style.world.weather` is built only in `src/lib/deck/engine.ts` (`weather-layer.ts`, GLSL). `src/lib/deck-webgpu` has no weather code (verified), so the default engine drops it. Port it as a world-view colour pass like `layers/flow.ts`, from luma's `precipitation` WGSL. | `src/lib/deck-webgpu/layers/` | M | C |

### P1: frame smoothness (feeds the real-time plan, RT-1..RT-3)

| # | Lesson | Target | Effort | Source |
|---|---|---|---|---|
| 6 | **Split long nn forwards across frames.** luma's `createExecution` plus `GPUCommandGraphExecutionBudgetController` runs a compiled graph in steps that fit a time budget learned from measured queue time (demo: gpu-trace-viewer `app.ts:6829-6865`). Rigi submits each forward in one go (`src/lib/nn/gpu/runtime.ts:595`) on the shared render device, so the ~470 ms depth forward can stall deck frames. Needs per-node cost annotations, a `ComputeGraph.runSliced` that waits on `createFence`, and a node/Dawn check that sliced output is bit-identical to one submit. This is RT-1.5 in the real-time plan. | `src/lib/nn/gpu/runtime.ts`, `src/lib/gpu/core` | M | A, D |
| 7 | **Build the splat LOD off the main thread and use per-device budgets.** `buildSplatLod` is synchronous (`splats-luma.ts:260`): 80–140 ms on Step Inside entry, about 4 s at the 2M cap. Move it to a worker as luma's demo does, and adopt its handheld budgets (2047 rows, 250k splats against a fixed 8192 and 2M). | `src/lib/deck-webgpu/layers/splats-luma.ts` | S–M | B |
| 8 | **Non-blocking readbacks in frame loops.** The Spatial Atlas demo picks through a readback ring and drops the request when no slot is free. Make that drop-when-busy mode an option on `gpu/core/readback.ts`, for the live tracker and per-frame picks. | `src/lib/gpu/core/readback.ts` | S–M | A, B |
| 9 | **One shared device for the landing embeds.** The multi-canvas demo gives one device a `PresentationContext` per canvas. Each Rigi embed boots its own device today, so scrolling back recompiles pipelines and refills atlases. Start with the roll map (direct host). | landing embeds, `roll` GPU backend | M | B |
| 10 | **Per-adapter kernel autotuning.** `GPUCommandGraphAutotuner` picks between equivalent kernels per GPU from timings. It would replace the nn↔luma crossover constants measured on one M3 (`luma-ops.ts:96,98`) and choose `GPUScan`'s strategy. Must be off for frozen benchmark runs. | `src/lib/nn/gpu/luma-ops.ts`, `gpu/core/graph.ts:445` | M | A |

### P2: code deletion and debuggability

| # | Lesson | Target | Effort | Source |
|---|---|---|---|---|
| 11 | **Write per-pass parameters inside the command encoder** (`writeBufferViaCommandEncoder`, as `gpu-query-compiler.ts:651-667` does). Collapses terrain-cull's per-encoder buffer ring and graveyard to one entry (~50 lines). | `terrain-cull.ts:276-313` | S–M | A |
| 12 | **`DrawCommandBuffer` / `DispatchCommandBuffer`** replace terrain-cull's hand-packed indirect records. | `terrain-cull.ts:71,110,171,247,310` | S | A |
| 13 | **Inspector counters.** Nothing calls `recordCounters`. Read GPU-written counts every ~30 frames, one in flight, never stalling: terrain-cull visible instances (none read back today), compaction counts, nn graph hit/miss. | `/dev/graph`, `terrain-cull.ts` | S | A |
| 14 | **Merge duplicated geodesy.** The ENU rotation exists three times and the ECEF→lat/lon inverse twice (`tiles3d/frame.ts`, `export/camera.ts`, `geodesy.ts`); `nearfield/lift.ts` `quatFromMatrix` copies `export/camera.ts` `mat3ToQuat`; there are three Web-Mercator copies (`dem/tiles.ts`, `terroir/roll/logic.ts`, `horizon-fast/mosaic.ts`). Use math.gl `Ellipsoid` and `Quaternion.fromMatrix3`; keep the fast `EnuFrame` path with its refraction lift and `rot3.ts`. | as listed | S | D |
| 15 | **`luma-watch.mjs` reports the rigi.4 base** (`7289d961`): its regex takes the first "base: luma master" line, and the rigi.5 and rigi.6 sections don't use that wording. | `scripts/upstream/luma-watch.mjs` | S | D |

### P3: look (opt-in, off the match path)

These change pixels, so none of them may touch the photo overlay, the match renders or export. They belong to world view and the landing page only.

| # | Lesson | Target | Effort | Source |
|---|---|---|---|---|
| 16 | **FXAA on the overlay layer at 1× MSAA.** Live mode keeps colour at 1× (`engine.ts:1017`), so contours, trails, ink and wind streaks alias over the video. Run luma's `fxaa` (WGSL and GLSL) on `ColorTargets.color` before the composite, never on the photo. | both engines | M | B |
| 17 | **Nebelmeer wisps and drift.** `look/nebelmeer/index.ts` already imports `heightFogFunctions`; `heightFog_getSpatialTransmittance` adds drifting fog, and density variation 0 reproduces today's output. | `look/nebelmeer` | S–M | B, C |
| 18 | **Sun glints on lakes:** the river material's broken-specular term (~6 lines), tied to the waves option. | `look/water/water.ts` | S | C |
| 19 | **Labelled vector index contours** with `GPURasterContours` (segments with no readback); the most visible gap in the default Landeskarte look. It imports from `@luma.gl/experimental`, which is private upstream. | `src/lib/terroir`, style | M–L | B |
| 20 | **3D Tiles load pacing** (deck PR #10784: spread tile setup over frames, keep the parent until all children draw) and render bundles for tiles3d, keeping `?renderBundles` off on terrain. Check for hitches first. | `src/lib/tiles3d` | S–M | B, C |

**Bloom (B and C disagree).** C proposes HDR bloom for summit glow and glints, since the WebGPU colour target is already linear `rgba16float`. B rejects it because it pushes the render away from the photo it must match. Resolution: never on the match path. A landing-only opt-in is acceptable but low value; not ranked.

## Watch list

- loaders #4090, #4089, #4092 (3D Tiles loading speed), merged #4067 (request scheduler); `@loaders.gl/tiles` alpha.8 removes lesson 2's workaround.
- math.gl #166/#167 (curve and mesh subdivision through projections); proj4 in alpha.11 (renamed `ProjectionEngine`, batch `projectFlat`, per-projection imports) may make exact LV95 cheap enough to replace the ~4 m approximation in `concord/occl/swiss-cog.ts`. Re-measure then.
- luma #3355 fixed the broken npm manifests, so returning from the vendored build to npm will not need the `overrides` workaround.
- GPU label culling (gpu-culled-trace) and deck #10698 greedy text collision for roll-map labels (need `@deck.gl/extensions`, not vendored); ShaderPlugin as a single GLSL/WGSL source for future looks; `GPUBatchSort` for batched nn top-k after a bench; `GPUTextureHistory` for frame-to-frame accumulation in live mode.
- Stars and moon from `deck-sky` for dusk photos: deck-sky has no LICENSE, and the star catalogue's source must be recorded in `reports/licences.md` before porting.
- city-scene's benchmark budget method (median +25 %, p95 +50 %, memory +5 %, zero steady-state allocation growth) for `scripts/deck-webgpu/bench.mjs`, run only in the batched browser pass.

## Already adopted or rejected (not re-proposed)

- **Adopted:** graph inspector with preflight and p50/p95 timings, GPU indirect conditions, compaction with indirect draws, sorts, scan/reduce/histogram, pass coalescing, `GPUGridIndex` (roll), gpu-raster ops, PBR Neutral tone mapping, 8× anisotropy, 1× MSAA during drags, pattern fills, point glow, sketch lines, styled paths, water waves, flow particles, height fog, float64 origin rebasing, the #3340 paged splat renderer (default; reverses the 10-01 negative result).
- **Rejected:**
  - TAA: the camera moves every frame in live mode, and the pass assumes forward depth while Rigi uses reversed-Z.
  - GTAO, SSAO and shadow maps: relief sky-view factor and horizon sweeps already do this better for terrain.
  - A-buffer/OIT: splats are sorted, and the multi-drape blends in one shader.
  - ACES tone mapping.
  - GPU scene and virtual geometry.
  - GPU text and picking: labels are DOM.
  - Screen-space reflections: no world-camera depth/normal buffer. A DEM ray-march for flat lakes is the better fit if ever wanted.
  - The Arrow/GeoArrow layers, dataframes, Parquet decoding and graph algorithms: no matching workload.
  - gpt-2's naive kernels: Rigi's nn runtime is well ahead.
- `@loaders.gl/geotiff`, `@math.gl/geoid` and `@math.gl/sun` stay rejected (dependency audit §8); nothing upstream changed that.

## Suggested next steps

1. Land the P0 items. All are S except weather; none needs the browser to write, and all ship browser-unverified for the next batch.
2. Take lesson 6 (sliced nn forwards) into the real-time plan as RT-1.5, with lessons 7 and 8 alongside.
3. Do the P2 items in one cleanup commit after the P1 work, since they touch the same `gpu/core` and terrain-cull files.
