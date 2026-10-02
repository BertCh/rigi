# Regression gate (roadmap N1)

One runner for every check the repo already had. It works with any number of concurrent sessions on
the tree and never changes app behaviour.

```sh
node scripts/ci/run.mjs fast                  # ~30 s: tsc, biome ratchet, Vitest unit suite, node/tsx checks (`--list` prints every id)
node scripts/ci/run.mjs full                  # + browser: style-baseline, deck smoke, eval-app, eval-app-deck, settle-submits, graph-plumbing-ab (~minutes)
node scripts/ci/run.mjs full --only deck-smoke,style-baseline
node scripts/ci/run.mjs fast --skip concord-occl --jobs 8
node scripts/ci/run.mjs --list                # every check id, tier, command and untracked inputs
node scripts/ci/install-hook.mjs              # OPTIONAL pre-push hook (fast tier); not installed by default
```

The runner exits 1 if any check is `FAIL` and 0 otherwise. Each run prints a table of check, tier,
status, time and note. Logs go to `out/ci/logs/<id>.log` and a JSON summary to `out/ci/last-run.json`.

| status | meaning | fails the gate |
|---|---|---|
| PASS | exit 0, gate satisfied | no |
| FAIL | new failure (or a known one under `--strict`) | **yes** |
| KNOWN | fails, but matches the baseline in `known-failures.json` | no |
| FIXED | listed as known but passes now. Delete it from the baseline | no |
| SKIP | a gitignored input it needs (`data/`, `public/photos/`, `out/…`) is missing, e.g. in CI | no |

## Checks

| id | tier | what it guards | command |
|---|---|---|---|
| tsc | fast | types across `src/`, `scripts/`, `tools/` (this includes `src/lib/renderer.check.ts`: the deck engines satisfy `Renderer`) | `tsc --noEmit --pretty false` |
| biome | fast | lint + format + import order, as a per-file ratchet | `biome check --reporter=json <files>` |
| unit | fast | the Vitest unit suite: every `*.spec.ts` / `*.spec.tsx` (pure CPU, no GPU / network / gitignored data; conventions in `src/test/README.md`), including `scripts/ci/__tests__/checks.spec.ts`, which tests this registry and fails on an unregistered check script | `vitest run` |
| style-check | fast | CLASSIC style = today's constants, ramps, presets, `?style=` | `scripts/style-check.ts` |
| models | fast | model weights: manifest sha256 per present file, `createOrtSession` runs the sky model on WASM in node; SKIPs without `public/models` | `src/lib/models/models.check.ts` |
| labels | fast | peak labels: classic byte-identical, no overlaps | `src/lib/look/__tests__/labels.check.ts` |
| haze-fit | fast | `fitHaze` recovers J, A, β | `src/lib/look/__tests__/haze-fit.test.ts` |
| haze-tail | fast | the GPU haze fit's CPU tail (`hazeFitTail`) equals `fitHaze` bit for bit on 16 synthetic scenes; `pathFrom` = `atmPath`, `robustSkyExact` = `robustSky`; one-ULP teeth (no GPU) | `src/lib/gpu/look/haze-tail.check.ts` |
| haze-band | fast | GPU airlight band: the WGSL's integer logic, emulated, equals `airlightBand` on synthetic and adversarial planes (NaN, ±0, subnormals, threshold neighbours); `verifyBand` catches injected faults; the band-path tail equals `fitHaze` (no GPU) | `src/lib/gpu/look/haze-band.check.ts` |
| haze-argmin | fast | haze grid arg-min as a luma GPUProgram: the program's integer min / candidate / rank logic, emulated (random atomic order), gives the same candidates as the whole grid on 405 adversarial grids (ties, NaN, ±∞, ±0, tolerance neighbours, past the 256 cap = the GPU-gated selection); `decodePick`'s per-call checks catch injected faults; the program lowers on a stub device with `select` the only GPU-indirect-gated node (no GPU) | `src/lib/gpu/look/haze-argmin.check.ts` |
| bridge-fusion | fast | WAG W1.2 settle fusion: mask texture pool and prepared-masks adoption rules (no GPU) | `src/lib/deck-webgpu/compute-bridge-fusion.check.ts` |
| annotate-selftest | fast | `solveFromControlPoints` (output `FAIL` counts, since it always exits 0) | `scripts/annotate-selftest.ts` |
| eye-check | fast | pose6dof eye refinement, analytic ridge | `src/lib/pose6dof/eye.check.ts` |
| pose6dof | fast | pose6dof solvers + real control points (`--quick`) | `scripts/test-pose6dof.ts` (needs `data/`) |
| refine-test | fast | refine Jacobians, FFT, synthetic recovery | `scripts/refine-test.ts` |
| ingest | fast | GPU Terrarium decode arithmetic: f32 twin bit-equal to `decodeTerrarium` over all 2^24 RGB, f32-exact partials, ingest layout math; the tile kernel (flag `terrainGpuDecode`: decode + 2× downsample + stats) twin bit-equal to `decodeTerrarium` + `downsampleHeights2` + `heightStats`, its out-of-range count equal to `validateTile`'s fills. The browser byte/height gate is `scripts/gpu/terrarium-ingest-check.mjs` (not in the registry) | `src/lib/gpu/ingest/ingest.check.ts` |
| cpu-heights | fast | Lazy CPU heights view (WAG W2.4, `dem/cpu-heights.ts`): `getCpuHeights` materialises once; `heightStats` equals the batch-grid and colour-ramp scans it replaces; batch grid from stats equals from heights; lazy `TerrainSet` queries equal eager ones; downsample plumbing equals the old loop | `src/lib/dem/cpu-heights.check.ts` |
| height-gather | fast | GPU height gathers (WAG W2.4, `deck-webgpu/height-gather.ts`): `gridCorners` + `blendCorners` equal `sampleGrid`; plan, emulated kernel and finish equal `TerrainSet.heightAt` bit for bit on eager, lazy and non-resident tiles; a bad nonce, a failed run or a changed slot falls back to `heightAt`; `replayHeights` over `buildTrailSegments` and `localMaxOf` equals the direct calls | `src/lib/deck-webgpu/height-gather.check.ts` |
| kernel-binding-use | fast | every `defineKernel` spec (src/lib/gpu, src/lib/deck-webgpu): spec.layout agrees with the WGSL `@group(0) @binding` declarations and every declared binding is referenced from the entry point or a helper it calls (a phony `_ = name;` counts), since luma's 'auto' layout drops unused bindings and Dawn rejects the bind group (4d92d3f). Kernels built inside functions and raw `createComputePipeline` callers are not covered | `scripts/gpu/kernel-layout-check.mjs` |
| terrain-cull | fast | batched-terrain GPU cull (WAG W1.5): the f32 twin of the WGSL frustum test keeps every sphere the CPU `sphereInView` keeps (random + on-plane ± ε spheres), compaction order = `visibleRows`' groups, WGSL binding layouts. The browser pixel gate is `scripts/deck-webgpu/terrain-indirect-check.mjs` (not in the registry) | `src/lib/deck-webgpu/layers/terrain-cull-math.check.ts` |
| export | fast | export/interchange (XMP, GeoJSON, KML, COLMAP…) | `scripts/test-export.ts` (needs `public/photos/`) |
| splat-loaders / -ext | fast | splat loaders: `.splat-v1` round trip, PLY; SPZ (v2/v3/v4), KSPLAT (levels 0/1) and plain `.splat` through `@loaders.gl/splats` on hand-built fixtures | `src/lib/nearfield/splat-loaders*.check.ts` |
| nearfield-core / -export / -generate / -spot / -eyes / -propagate, splat-sort | fast | Step Inside core; generated splats never exported; propagation parity with Python; depth sort | `src/lib/nearfield/**`, `tools/nearfield/propagate/propagate.check.ts`, `scripts/nearfield/splat-sort-test.ts` |
| nearfield-service | fast | near-field service caps and error paths (CR-05), in-process Python unittest, no model load; SKIPs without `tools/matcher/.venv` | `tools/nearfield/service/tests/test_caps.py` |
| tiles3d | fast | 3D Tiles source-agnostic layer (datum, tile selection) | `src/lib/tiles3d/tiles3d.check.ts` |
| photoprep | fast | GPU photo prep path (`4 100000` args) | `src/lib/gpu/photoprep/photoprep.check.ts` |
| photoprep-resident | fast | Photo prep residency: lazy CPU read, memo, pins, LRU, device mismatch (fake device) | `src/lib/gpu/photoprep/resident.check.ts` |
| align-cert | fast | Certified-f32 align refine in emulation: AlignResult bit-identical to autoAlign, runtime checks catch a broken bound | `src/lib/gpu/align/cert.check.ts` |
| gpu-clear-lint | fast | ComputeGraph clear lint: the partial/atomic rule and the GPU-condition rule (same gate, command rewrite, unaudited nodes, whole clears) | `src/lib/gpu/core/clear-lint.check.ts` |
| gpu-binding-guard | fast | storage binding guards (`gpu/core/binding-guard.ts`): zero-size binding and `minStorageBufferOffsetAlignment` rejected at encode time (pure helper, no GPU) | `src/lib/gpu/core/binding-guard.check.ts` |
| gpu-uniform-block | fast | `defineUniformBlock` packs byte-identically to the former hand-packed uniform words (geo-query, silhouette, terrain-cull; edge values) | `src/lib/gpu/core/uniform-block.check.ts` |
| gpu-uniform-block-look | fast | the look / precision `defineUniformBlock` layouts (guided filter, texture gathers, haze prep / pass / count, relief heights P and Tile row, ieee probe) pack byte-identically to the former hand-packed words; edge values | `src/lib/gpu/core/uniform-block-look.check.ts` |
| gpu-raw-lint | fast | ratchet keeping GPU code luma-native: counts raw `navigator.gpu` / `requestAdapter` / `requestDevice`, native `.handle` use (`mapAsync`, `onSubmittedWorkDone`, `getCurrentTexture`, `.handle.queue`), casts to private members and raw `gl.` calls per file in `src/lib/**` (not tests / `*.check.ts`); fails when a count rises over `scripts/ci/gpu-raw-baseline.json`, prints decreases as improved (`--write` regenerates it, keeping each entry's `why`) | `scripts/ci/gpu-raw-lint.mjs` |
| gpu-uniform-block-a | fast | align (cert, pose-bound, pose-grid), solve fold and horizon (certified, ridges, mosaic mip) uniform packers are byte-identical to the former hand-packed words | `src/lib/gpu/core/uniform-block-a.check.ts` |
| gpu-uniform-block-b | fast | horizon march, skyglobal, skyline, sky prep / refine and splat-sort uniform packers (`gpu/*/uniforms.ts`) are byte-identical to the former hand-packed words (-0, NaN payloads, subnormals, u32 max; 13.6k cases) | `src/lib/gpu/core/uniform-block-b.check.ts` |
| gpu-inspect | fast | graph inspection (`gpu/core/inspect.ts`, `inspector.ts`): stats / preflight / inspector-sample summary, observation through the upstream `GPUCommandGraphInspector`, `getGpuGraphProfile`, device-loss cleanup (fake device, no GPU) | `src/lib/gpu/core/inspect.check.ts` |
| app-graph | fast | app graph manifest ↔ code: every `cachedGraph` group in `src/lib/gpu/**` and `src/lib/deck-webgpu/**` is declared in `gpu/app-graph/manifest.ts` and vice versa; island ids, unique ids, paths | `src/lib/gpu/app-graph/app-graph.check.ts` |
| app-graph-table | fast | `research_notes/whole-app-graph-2026-10-01/islands.generated.md` matches the manifest (regenerate with `--write`) | `scripts/gpu/app-graph-table.ts --check` |
| ieee-probe | fast | shared certified-f32 arithmetic (`gpu/precision`): df32 ops within budget, strict-IEEE probe verifier accepts the emulated machine and rejects broken ones | `src/lib/gpu/precision/ieee-probe.check.ts` |
| horizon-cert | fast | certified-f32 horizon stages on the f32 emulation: 0 false certifications, finished output bit-identical to the f64 path, probe verifier; DEM cases when `out/gpu/horizon-cert/real-cases.json` exists (`scripts/gpu/horizon-cert-cases.ts`) | `src/lib/gpu/horizon/certified.check.ts` |
| examples | fast | `examples/` type check (`scripts/examples.mjs check`) | `node scripts/examples.mjs check` |
| ontology | fast | ontology layer: provenance axes, crosswalks | `src/lib/ontology/ontology.check.ts` (needs `public/photos/`) |
| matcher-rule-replay | fast | T6 frozen rule (TS) replayed over recorded runs: source, level, pose equal Python | `src/lib/matcher/rule-replay.check.ts` (needs `tools/bench/final/out/B`) |
| gipfelbuch | fast | `/gipfelbuch` graph data | `src/lib/gipfelbuch/gipfelbuch.check.ts` |
| gipfelbuch-contrast | fast | Gipfelbuch ink contrast gate: text inks at least 4.5:1 on paper and paper-deep; relief (BL) and MG never used as text colour; palette.ts agrees with the Brezine codes | `src/components/gipfelbuch/swiss/contrast.check.ts` |
| terroir-labels / -viz / -roll / -pack | fast | terroir cartography: labels, viz, roll, packs | `src/lib/terroir/*/*.check.ts`, `scripts/terroir/pack.check.ts` |
| geocam-map / -priors / -lakes / -integrity | fast | geometry-first pose modules (flags off by default) | `src/lib/geocam/*/*.check.ts` |
| concord-core / -priors / -cues / -app / -occl | fast | concordance modules kept after the 2026-09-30 cleanup (synthetic, offline). The joint, warp and re-match checks went with their code (a1845f5) | `src/lib/concord/*/*.check.ts` |
| cache-range | fast | tile cache HTTP byte ranges: one entry per url + range, memory repeats, shared in-flight requests, 200-ignoring servers sliced (mocked server) | `src/lib/cache/range.check.ts` |
| terrain-stall | fast | terrain loads that never complete: an always-failing tile is retried (`TILE_LOAD_ATTEMPTS`) then given up on, so the set completes (`stats.failed`); a stalled tile fetch fails as a `TimeoutError` after `fetchTimeoutMs` and the DEM loader falls back to the ancestor (mocked loader / server) | `src/lib/deck/terrain-stream.check.ts` |
| silhouette-mask | fast | silhouette re-rank mask: CPU emulation of the GPU predicate equals the CPU scorer (`Object.is`), zero-texture / stale-nonce fallbacks, `redrawIfBlank` | `scripts/gpu/silhouette-mask-check.ts` |
| bridge-compute, layer-* (atm-sky, composite, drape, geometry-source, gizmo, multi-drape, photo-sky, ridges, splats, terrain-styles, tiles3d, trail), align-refine-guard, nebelmeer, precipitation, picker-candidates, roll-propagate | fast | node check scripts that existed but had no registry row (found by the registry spec, 2026-10-01) | their `*.check.ts` / `*.test.ts` |
| spdx | fast | every first-party file carries `SPDX-License-Identifier` + `SPDX-FileCopyrightText`; `--strict`: ports and other licences resolved by hand | `scripts/ci/spdx.mjs --strict` |
| wgsl-compile | fast | every WGSL program variant the app can assemble compiles on Dawn in node through luma.gl | `scripts/gpu/wgsl-compile-all.ts` |
| haze-scan-sg, render-bundle-dawn, color-target-dawn | fast | Dawn-in-node spikes kept as gates: subgroup haze scan bit-equal to the serial scan; render bundles equal direct draws; `?colorTarget=rg11b10` vs rgba16float per channel | `scripts/gpu/*.ts` |
| haze-band-dawn | fast | Dawn-in-node: the haze fit's `GPUGather`s and airlight band on synthetic scenes: band indices and K equal `airlightBand` (synthetic scenes, random laced planes, the all-sky fallback), gathered words equal CPU indexing of the GPU planes, `HazeFit` vs CPU `fitHaze` (max rel diff, NaN), fallback-band capacity buckets; prints per-path timings. SKIP without `DAWN_DIR` | `scripts/gpu/haze-band-dawn.ts` |
| terrarium-stats-dawn | fast | Dawn-in-node gate: the Terrarium tile kernel plus its three `GPUReduction` stats nodes on synthetic tiles (256/512, down 1/2, NO_DATA and out-of-range samples) vs the CPU twin: heights bit for bit, invalid and lo/hi/lo7/hi7 exact up to the sign of zero. SKIP without `DAWN_DIR` | `scripts/gpu/terrarium-stats-dawn.ts` |
| sky-refine-conv-dawn | fast | Dawn-in-node gate: the sky refine (luma `GPUConvolution` box means) vs the CPU `refineToWorking` on 8 synthetic cases (float mask 1e-4, bytes within 1, flips at 128 within 1e-4). SKIP without `DAWN_DIR` | `scripts/gpu/sky-refine-conv-dawn.ts` |
| skyglobal-compaction-dawn | fast | Dawn-in-node gate: the skyglobal grid with FLAGS + luma `GPUCompaction` on 4 seeded scenes vs the CPU twin: candidate set = `hi >= maxLo(yaw)`, list ascending and identical run to run, {best, arg} and the search result equal, forced tail read and cap fallback. SKIP without `DAWN_DIR` | `scripts/gpu/skyglobal-compaction-dawn.ts` |
| skyglobal-rescore-dawn | fast | Dawn-in-node gate: `gridGpu({ rescore: "gpu" })` (RESCORE + PICK on the compute graph, float32) vs `gridCpu` on the same 4 scenes: arg agreement >= 0.99, max relative error of best <= 1e-4, top-1 `searchGpu` hypothesis within 0.05 deg, only count + per-yaw results read, cap fallback, default cpu path unchanged. SKIP without `DAWN_DIR` | `scripts/gpu/skyglobal-rescore-dawn.ts` |
| skyline-conv-dawn | fast | Dawn-in-node gate: the GPU skyline feature graph (box blurs on luma `GPUConvolution` + clamp-to-edge fix) vs the CPU `computeFeatures` / `heuristicSky` (<= 1e-5) and `detectSkylineGpu` rows vs `detectSkyline` (<= 0.05 px, same finiteness) on synthetic images. SKIP without `DAWN_DIR` | `scripts/gpu/skyline-conv-dawn.ts` |
| refine-fft-dawn | fast | Dawn-in-node gate: the GPU yaw correlation of `refinePose` (one luma `GPUFFT1D` per signal in a core graph) vs the f64 CPU twin: `globalInit` modes and PSR, `refinePoseAsync` vs `refinePose`. SKIP without `DAWN_DIR` | `scripts/gpu/refine-fft-dawn.ts` |
| fft1d-lengths-dawn | fast | Dawn-in-node gate: luma `GPUFFT1D` forward and inverse at every power of two 2^1..2^13 and 2^16 vs the f64 FFT (guards the Metal bit-reversal fix and the 65536 length). SKIP without `DAWN_DIR` | `scripts/gpu/fft1d-lengths-dawn.ts` |
| photo-look-dawn, roll-coverage-dawn, roll-spatial-dawn | fast | Dawn-in-node gates for wave H (2026-10-02): photo palette (unpack kernel + `GPUKMeans`) and group-by-look / similar looks (`GPUKMeans`, `GPUSimilaritySearch`) vs their CPU twins, incl. ≥ 95 % recovery of known groups; roll coverage grid (`GPUGridAggregation`) mass/cell deltas and who-sees-here (`GPUBVH` + `GPUBVHQuery`) vs brute force; roll building neighbour pairs (`GPUGridIndex`) and capture order (`GPUSegmentedSort`) equal to the CPU. SKIP without `DAWN_DIR` | `scripts/gpu/*-dawn.ts` |
| terrain-cull-dawn | fast | Dawn-in-node gate: the terrain cull graph (flag kernel + per-slot `GPUCompaction`) vs the CPU twin, exact and stable, with old-vs-new timings. SKIP without `DAWN_DIR` | `scripts/gpu/terrain-cull-dawn.ts` |
| guided-filter-conv-dawn | fast | Dawn-in-node gate: the look guided filter (luma `GPUConvolution` box means, 1-3 jobs sharing a guide) vs the CPU `guidedFilter` on 8 synthetic cases incl. w or h < 2r+1 (q 1e-4, bytes within 1) plus a NaN-locality case. `GF_OLD_OUT=<file>` records / compares against another build. SKIP without `DAWN_DIR` | `scripts/gpu/guided-filter-conv-dawn.ts` |
| color-stats-dawn | fast | Dawn-in-node A/B of the band statistics at 512x384 / 1600x1200 / 3000x2000: BAND_STATS + aggregation fold vs the CPU twin (tolerances, median wall times). SKIP without `DAWN_DIR` | `scripts/gpu/color-stats-dawn.ts` |
| relief-gradient-dawn | fast | Dawn-in-node check of the GPU relief field (shadow, sky view, curvature, normal with luma `GPUFiniteDifference2D` gradient) at res 512 / 1024 / 2048 against the CPU twin: byte-diff histogram per channel, median wall times, texture path bytes equal the read path. SKIP without `DAWN_DIR` | `scripts/gpu/relief-gradient-dawn.ts` |
| photoprep-hist-dawn | fast | Dawn-in-node run of the GPU photo prep's edge graph at 512x384 / 1024x768 / 2048x1536: luma `GPUHistogram` radix-select digits and `GPUGroupAggregation` sky colour counts; the four planes equal emulate.ts exactly (integer counts), median wall times. SKIP without `DAWN_DIR` | `scripts/gpu/photoprep-hist-dawn.ts` |
| ransac-dawn | fast | Dawn-in-node run of the GPU RANSAC scorer (`src/lib/gpu/ransac`: K hypotheses × N correspondences in one graph, arg-max on the GPU, winner read back) vs its f64 CPU twin in the chord / angular / reproj modes (incl. a 2-D grid past 65535 hypotheses), and the async pose6dof solvers vs the sync ones. SKIP without `DAWN_DIR` | `scripts/gpu/ransac-dawn.ts` |
| nn-parity | fast | Dawn-in-node parity of the `src/lib/nn` GPU backend (WGSL kernels on one ComputeGraph per forward) against its CPU reference on seeded random tensors: every op family (implicit-GEMM conv / convTranspose / deformable conv, flash attention, norms, interpolate, gridSample, topk, layout), a transformer block in one forward, the graph cache, eager ops, f16 weights. Max rel error <= 1e-4. SKIP without `DAWN_DIR` | `scripts/nn/parity.check.ts` |
| haze-argmin-dawn, haze-lists-dawn, stats-fold-dawn, height-atlas-dawn | fast | Dawn-in-node gates: the haze arg-min `GPUProgram` on both sides of its indirect gate vs `emulatePick`; the haze fit's `GPUSort`/`GPUHistogram`/`GPUScan`/`GPUGather` 72-list compaction (lists exact vs the CPU emulation, the three graph paths' fits vs `fitHaze`); the band-stats `GPUGroupAggregation` fold on a default and a core device plus the layout-failure marker; height-atlas `compactLeased` reads back every live layer byte-identical at its remapped index, and `nearestWithin` on a 256-layer core device. SKIP without `DAWN_DIR` | `scripts/gpu/*-dawn.ts` |
| sky-graph-idle, realm-flags, imagery-release | fast | worker and residency lifecycles (fake timers / worker-like realm): the sky worker releases its graphs after 30 s idle and never in flight; explicit page flags forward to worker realms (default messages unchanged); the imagery hold defers the 10 s release | `src/lib/{sky,gpu/core,deck-webgpu}/*.check.ts` |
| render-lock-signals | fast | killing `with-render-lock.mjs` also kills the wrapped job and its children (private temp lock dir) | `scripts/gpu/with-render-lock.check.ts` |
| mosaic-mips, stats-fold, skyline-stages | fast | CPU twins of GPU stages: mosaic max-mip pyramid = `gridMips`; band-stats fold = `reduceBands`; skyline stage split = `detectSkyline` | `src/lib/gpu/{horizon,look,skyline}/*.check.ts` |
| atlas-layout, base-slots, frame-timings | fast | deck-webgpu bookkeeping: texture-array atlas layers and grow copies, packed base-grid slots, GPU frame-timing query ring | `src/lib/deck-webgpu/*.check.ts` |
| theme | fast | light/dark: the pre-paint boot script and `resolveTheme()` agree in every precedence case | `src/lib/theme/__tests__/theme.check.ts` |
| strokes, flow, imhof, water-waves | fast | opt-in looks: ridge sketch / trail strokes, wind-drift field + WGSL layout, Imhof relief reference properties, lake waves (GLSL and WGSL tables agree) | `src/lib/look/**/*.check.ts`, `waves.test.ts` |
| features | fast | browser ALIKED + LightGlue vs PyTorch lightglue: per-layer maps, keypoint repeatability, descriptor cosine, match IoU (SKIPs without the fixtures in `out/features-parity` or the weights) | `src/lib/features/__tests__/parity.check.ts` |
| terroir-pattern, terroir-hatch | fast | terroir pattern fills and hatch: CPU mirror coverage, splice off by default, GLSL / WGSL constants agree | `src/lib/terroir/*.check.ts` |
| palette-cvd | fast | the roll viewpoint palette stays separable under simulated colour-vision deficiency and clear of the selection orange | `src/lib/roll/mosaic/__tests__/palette-cvd.check.ts` |
| export-geoid-default | fast | engine exports default the geoid separation to EGM2008 at the frame origin | `src/lib/export/geoid-default.check.ts` |
| stage1-worker-snapshot, t6-gpu-grid-default | fast | matcher stage-1: render worker snapshots match what `make_worker_snapshot.mjs` generates (no drift); the T6 GPU skyline grid is on by default and its `T6_GPU_GRID` opt-out agrees in the render worker and `t6.py` | `tools/matcher/stage1/__tests__/*.check.ts` |
| range-webgpu | fast | WebGPU range hand-off (`RangeGpuWebGpu`): reference rule == the old CPU path (unpack, rangeMapFrom, coarsen) on sky / NaN / Inf / negative / denormal words and odd sizes; with `DAWN_DIR`, the cell copy into an r32float atlas (neighbours untouched) and the coarse grid are byte-equal to it on a Dawn device. GPU half SKIPs without `DAWN_DIR` | `src/lib/roll/map/range-webgpu.check.ts` |
| geo-unpack | fast | GPU unpack of the geometry target: the WGSL logic as a TS reference is byte-equal to the CPU unpack on sky / NaN / Inf / denormal / -0 words; odd words fall back to the CPU | `src/lib/deck-webgpu/geo-unpack.check.ts` |
| gipfelbuch-notebook, tafel, tafel-sheets | fast | Gipfelbuch notebook covers every node once; Tafel projector lands on solved rows; every node has sheet figures and one chapter | `src/components/gipfelbuch/{notebook,tafel}/*.check.ts` |
| precision-gate-score | fast | the precision gate's scoring on synthetic rows: identity vs the f64 noise floor (base vs base2 on one page), quality arm against the tracked blind verdicts (verified-wrong accepts fail, lost verified-correct accepts fail, unverified new accepts need verification), GT-12 arm | `scripts/gpu/precision-gate.check.mjs` |
| style-baseline | full | **classic pixel identity + geometry hash** on the WebGL deck route (`?renderer=deck`, SwiftShader). No `?style`/`?concord` flag is set, so this row is also the **concord-off parity** gate. **Needs a deck reference** (see below); SKIPs until one exists | `scripts/style-baseline.mjs check --url …` |
| deck-smoke | full | `?renderer=deck` (WebGL, reference) vs `?renderer=webgpu` parity: \|Δyaw\| ≤ 0.5°, label overlap ≥ 0.6 | `scripts/deck-engine-smoke.mjs --url … --out out/ci/… --renderer webgpu` |
| settle-submits | full | WAG W1.2 settle fusion (`?renderer=webgpu` pinned): masks + band stats byte-identical with `settleFusion` off / on; submits per settle and settle-to-labels latency reported, not gated | `scripts/deck-webgpu/settle-submits.mjs IMG_7086 --url … --renderer webgpu` |
| graph-plumbing-ab | full | WAG graph plumbing (`--renderer webgpu` pinned): silhouette-gpu and geo-query-gpu on core ComputeGraphs vs a replica of their former raw dispatches; read-backs byte-identical, timing reported, not gated | `scripts/gpu/graph-plumbing-ab.mjs --url … --renderer webgpu` |
| eval-app | full | app auto-alignment vs control points on the default engine (`--renderer webgpu`). Gate: `N/M within 1° yaw` ≥ `evalAppWebgpu.minWithin1deg`; advisory until that baseline exists | `scripts/eval-app.mjs --renderer webgpu` (`APP_URL=…`) |
| eval-app-deck | full | the same accuracy run on the WebGL deck fallback (`--renderer deck`) | `scripts/eval-app.mjs --renderer deck` |

Full-tier checks run one at a time through `node scripts/gpu/with-render-lock.mjs -- …`. That wrapper
waits for the machine-wide render lock and for memory headroom, and the wait counts against the check's
timeout. The runner starts its own `vite dev --port 3130 --strictPort`, which gets its own dep cache
`node_modules/.vite-3130` (see `vite.config.ts`), and stops it at the end. If something already answers
on that port, the runner reuses it. `--url http://localhost:3100` uses an existing server instead.

Left out on purpose:
- `scripts/gpu/*` benches and parity checks: they need a GPU and dumped fixtures, and they are research
  checks, not a gate.
- `scripts/nearfield/*.mjs` browser labs: long, and they need the near-field service on :8767.
- `tools/nearfield/service/selftest.py`: needs the Python env.
- `occl.check.ts --live`: network.

Any of these can be added to `checks.mjs` as another entry.

## Known-failures baseline (`known-failures.json`)

The gate compares each run against this baseline. It does not demand zero: pre-existing failures that
belong to other owners are recorded here, and only new ones fail. Fix the cause, then delete the entry.
Don't add an entry just to get your own change through.

The `checks`, `tsc` and `biome.errors` baselines are currently empty; the ratchet machinery stays so
a new known failure can be recorded. pose6dof and export SKIP in CI (they read gitignored `data/` and
`public/photos/`), and style-baseline, deck-smoke and eval-app are not run in CI (they need the photos,
DEM tiles over the network and the stored ~10 MB pixel baseline).

To update the baseline, run `node scripts/ci/run.mjs full --biome all --update-baseline`. It rewrites
`biome.errors` (only with `--biome all`) and, for each eval-app row that ran, `evalAppWebgpu` / `evalAppDeck`:
`minWithin1deg` becomes the observed count minus one (noise margin), `lastObserved` records the run, and
other hand-written fields (`note`) are kept. Review the diff before keeping it: a bad run lowers the
minimum. To record only the deck baseline, add `evalAppDeck` by hand (observed − 1) rather than
rerunning `--update-baseline` over everything. The `checks` and `tsc` entries are edited by hand.

`eval-app-deck` (eval-app with `--renderer deck`, the WebGL2 engine) runs in the full tier and
gates like `eval-app` against `evalAppDeck`. Without an `evalAppDeck` entry it would be advisory: every
failure, including a crash, a timeout or an engine mismatch, reports KNOWN and does not fail the gate.

`eval-app` metrics are noisy from run to run (background second opinion, tile timing), so
`minWithin1deg` is set a little below the observed count. See `evalAppDeck` in the JSON for the last
observed value.

`style-baseline` runs `?renderer=deck`; its reference lives in `out/lead/style-baseline` and is captured once,
deliberately, on a tree whose classic look is known good (the row SKIPs until it exists):

```sh
node scripts/gpu/with-render-lock.mjs -- node scripts/style-baseline.mjs capture --url http://localhost:3100
```

`check` refuses a `baseline.json` that does not say `"renderer": "deck"`.

## Biome scope

- `--biome all` checks every tracked file plus untracked files that aren't gitignored. This is the default under `CI=1` and in the workflow.
- `--biome changed` checks only files that differ from `merge-base(HEAD, upstream or origin/master)`, plus untracked files. This is the local default and what the hook uses.

Both scopes skip gitignored trees such as `tools/research/tm/.pylib*`. Plain `npx biome check .` does
not skip them, because `biome.json` has `vcs.enabled: false`.

## CI

`.github/workflows/ci.yml` runs `node scripts/ci/run.mjs fast --biome all` on push and PR, with
Node 22 (the repo pins nothing; `@types/node` is ^22) and `npm ci`. Playwright browsers are not
downloaded. The logs are uploaded as the `ci-logs` artifact.

To simulate a fresh checkout locally, copy `git ls-files -co --exclude-standard` into a scratch dir,
symlink `node_modules`, and run `CI=1 node scripts/ci/run.mjs fast` there.

## Pre-push hook (optional)

`node scripts/ci/install-hook.mjs` writes `.git/hooks/pre-push`, which runs
`node scripts/ci/run.mjs fast --biome changed`. It won't overwrite another hook unless you pass
`--force`, `--uninstall` removes it, and `git push --no-verify` skips it once. Nothing installs the hook
automatically.
