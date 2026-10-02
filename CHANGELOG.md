# Rigi CHANGELOG

Entries are factual and ordered newest first. There are no tagged releases yet; everything is under Unreleased until the first tag.

## Unreleased

### Vendored luma.gl rigi.3 (2026-10-01)
- luma.gl bumped to `10.0.0-alpha.2-rigi.3`: luma master `7289d961` plus #3313 (`attach()`, now with application-owned devices and canvases), #3302, #3287, #3328, a PipelineFactory compute-hash commit (`c80b7ce6`), #3333, #3334 and #3330 (details, checksums and rebuild recipe in `vendor/luma/README.md`; compute-hash patch in `vendor/luma/patches/`). `DeviceProps._ownsHandle` is gone (attached devices are never destroyed by luma; `attachWebGPUDevice` already destroys the `GPUDevice` itself), the engine comment that still named it is fixed.
- `@math.gl/core` and the packed luma manifests move to the published `5.0.0-alpha.10`; `@math.gl/polygon` and `@math.gl/web-mercator` are no longer direct dependencies (deck pulls them), and `overrides` pins the types-only `@math.gl/types` to `5.0.0-alpha.10` so one copy is installed. Browser-unverified until the render-lock gates run.

### WAG wave 4: more of the app on the luma graph, more GPU defaults (2026-10-01)

Built without browser runs (user's call: no render-lock waits); evidence is node checks, several on luma.gl's WebGPU device over Dawn in node. Every item below is **browser-unverified** until the consolidated pass (`research_notes/whole-app-graph-2026-10-01/consolidated-pass-wave4.md`); a regression there reverts that default.
- **First real luma `GPUProgram` users.** The haze grid arg-min (`haze-argmin.ts`, group `look-haze-argmin`): scalar ops for the tolerance, a `GPUConditionalOperation` gating the past-the-cap selection by GPU indirect dispatch, our kernels lowered into the program's graph; reads 2 KiB instead of 22 KiB (`?hazeArgminGpu=off`). The band-stats fold (`?statsFold=gpu|f64`): BAND_STATS → `GPUProgramSpMV` → BAND_FINALIZE in f32 on one graph, 256 B read back instead of 6.6 KB; f32 vs f64 stays under 1 LSB in emulation. New `gpu/core/program.ts` (`compileProgramGraph`, `GraphOperation`), `cachedGraphFrom`, and `cachedGraph(…, create)` for graphs that adopt a program compiler's graph. Band-stats subgroup reduction on by default where available (`?statsSubgroups=off`).
- **GPU airlight band** for the haze fit on the WebGPU texture path, default on (`?hazeBandGpu=off`): one submit, no range / P(sky) planes read back (graph break D16 removed); spot-checked per call, CPU band on a fault.
- **Sky GPU prep on by default** (`?skyGpuPrep`, replaces `DEFAULT_GPU_PREP`), now on a core ComputeGraph; fixes an upload-texture usage bug that made every browser prep fall back to the CPU. Earlier browser A/B (pre-port): 69/69 masks identical, segmentSky 88.1 → 77.6 ms median.
- **`unknownGpu` on by default**: the unknown-pose 360° horizon on the GPU march. Node gate on Dawn (`scripts/gpu/unknown-gpu-node.ts`, the worker's own code now in `src/lib/integration/unknown-pose-core.ts`): 0 new false or unverified accepts on GT-12 × 5 conditions and the 17 wild dev photos without heading; one knife-edge true accept lost (IMG_6971 noheading, which a ±3e-4° horizon jitter of the CPU path also loses).
- **Terrain loading no longer hangs**: tile fetches time out after 30 s (ancestor fallback), a tile that keeps failing is given up after 3 tries and drawn with a stand-in, and `DeckEngine.loadFullTerrain` reports success only once complete; the render worker / harness turn a failed full-terrain load into an error, never a row on the initial terrain.
- **Silhouette re-rank redraws a blank finalist** before scoring, on both engines: the main source of f64-vs-f64 differences between precision-gate runs.
- **Precision gate redesigned**: base, cand and a second base run on the same page per photo, judged on quality (accepts vs 304 blind-verified poses plus the GT-12 arm); identity is reported, not gated. New fast checks `terrain-stall`, `silhouette-mask`, `precision-gate-score`.
- **WebGPU terrain VRAM / uploads**: GPU-decoded tiles decode straight into a height-atlas layer they lease (one upload for layer + stats, no re-upload after a pan; ≤ 48 spare leases). Draped imagery gets a 256² tier for 256 px sources, compacts on idle via a graph copy node and releases 10 s after the look stops draping.
- New fast checks: `haze-band`, `haze-argmin`, `stats-fold`. Method: luma.gl's WebGPU device runs in node over Dawn (`webgpu` package), so real ComputeGraph code can be gated without a browser or the render lock.

### GPU graph paths on by default; WAG wave 3 (2026-10-01)

- **Defaults flipped** (each flag still turns the path off): certified-f32 horizon and align (`horizonPrecision`, `alignPrecision` = `certified-f32`), `terrainGpuCull` = on, `terrainGpuDecode` = on. WebGL and `?gpu=off` keep the CPU paths.
- Precision gate (`scripts/gpu/precision-gate.mjs`, 50 dev photos): INCONCLUSIVE by its bit-identity rule because the f64 baseline itself is not reproducible run to run (f64 vs f64 differs on 7/8 deck and 21/22 webgpu differing photos). GT-12 eval 12/12 identical in both modes; webgpu accepts 32 = 32; the deck "new accepts" are baseline noise (wc_0055) and a `loadFullTerrain` timeout on the initial terrain (wc_0052). Judged on quality, no difference, so certified-f32 became the default.
- WebGpuEngine gains `loadFullTerrain`, `loadSatellite` and `renderPoseView` (same contract as DeckEngine). The matcher render worker and the precision gate run full terrain and the fused render arm on `MATCHER_RENDERER=webgpu`. Against deck: masks identical (IoU 1), horizon Δ0 over 1800 directions, autoAlign Δyaw/Δpitch 0, geometry p95 ≤ 2 cm. The matcher satellite drape uses ~250 MiB more VRAM on WebGPU. Parity harness in `deck-webgpu`.
- Batched DEM height gathers from the resident height atlas: camera height, trails and peak snapping read heights on the GPU under `terrainGpuDecode`, bit-exact against `heightAt` (858 + 311 + 99 peaks and all trail vertices, 0 differences). Main-thread tile decodes at load 165–206 → 0. New core binding kind `texture-array`.
- geo-query-gpu on persistent pool slots via the new `ComputeGraph.runNow` (unleased run for transient-free graphs): 0.39 → 0.34 ms (verdicts + skyline) and 0.285 → 0.25 ms (gather) per call, byte-identical.
- Browser batch on e496c73: full tier 59 pass (graph-plumbing-ab only timed out in the lock queue; timeout raised to 3600 s), deck-smoke Δ0.00° WebGL vs WebGPU, eval-app 12/14 on both renderers, settle-submits confirms geo-query 2 → 1 submit per settle.

### Publication readiness (2026-10-01)

- A fresh clone builds and type-checks without the gitignored data: `photos.json` falls back to an empty list, and `data/ground-truth.json` loads through an optional `import.meta.glob`. CI gains a `vite build` step, `permissions: contents: read` and a `master`-only push trigger; the tsc `ciAllowed` and Biome error baselines are now empty.
- The Niederhorn demo set in `public/demo` (photos, thumbs, shots, step, atlas renders) is tracked, so the landing page works on a clone; it stays © Robert Christie, all rights reserved (NOTICE.md).
- Licences: upstream LICENSE files for the vendored luma.gl and deck.gl tarballs, plus their SHA-256 sums and rebuild recipe; Draco decoder (Apache-2.0) licence and source; NOTICE rows for the example thumbnails, the terroir cover and the EGM2008 geoid. `package.json` has licence, repository and engines metadata; `.gitattributes` and `.editorconfig` added.
- Docs: README quick start and requirements; internal coordination wording, session ids and machine-local paths removed from code comments, READMEs, reports and tool outputs; market/competitive notes and raw prototype dumps removed from `reports/` and `research_notes/`. User-Agent strings name the repository instead of a personal address (`RIGI_CONTACT` adds one); research scripts default to the system temp directory.
- The `/lab/deck-webgpu`, `/lab/deck-splats` and `/dev/how-scene` routes are dev-only, like the other dev and lab routes. Examples import `examples/gpu-args.mjs` instead of a repo script.

### WAG next wave: graph plumbing, precision gate, lazy CPU heights, haze tail (2026-10-01)

- silhouette-gpu, geo-query-gpu and the WebGPU splat sort run as core ComputeGraphs (`cachedGraph` groups `silhouette-mask`, `geo-query`, `splat-sort`) and appear in `/dev/graph`; outputs byte-identical (full-tier check `graph-plumbing-ab`). `GeoQueryGpu.verdictsAndSkyline()` replaces `verdicts()` + `skylineRows()`: one submit and one read per settle instead of two. Splat-sort profiling is reported per node. The manifest now marks terrain-gpu-cull opt-in, matching its flag.
- Precision gate for the opt-in certified-f32 stages: `scripts/gpu/precision-gate.mjs` (frozen dev split, f64 vs certified-f32, 0-false-accept rule). The matcher render worker takes `MATCHER_RENDERER`, `MATCHER_HORIZON_PRECISION`, `MATCHER_ALIGN_PRECISION` and records `pageFlags` and the precision path; `eval-app` gets `--horizon-precision`, `--align-precision`, `--json`. Only a 2-photo smoke has run (PASS).
- Certified-f32 horizon: per-(adapter, shader) spot-check ledger (first 3 calls check 64 outputs, then 8 per call with 1 in 32 at 64; a mismatch disables the key). Certified-f32 align: forced exact re-decisions are scored while the next submit runs; results identical, browser wall-clock gain not measured. Both stay opt-in.
- Haze fit CPU tail: bit-identical shortcuts (hoisted exponentials, a per-pass memo of revisited descent points, typed-array airlight sorts): −0.6–2.9 ms per fit in the WebGPU engine on 4 photos. New fast check `haze-tail`; `compute-bridge.check` reports `fit.stagesMs`.
- `getCpuHeights(tile)` (`src/lib/dem/cpu-heights.ts`) is the accessor for streamed DEM tile heights; default path bit-identical (fast check `cpu-heights`). New flag `terrainGpuDecode` (off): on WebGPU, DEM tiles decode on the GPU straight into the height atlas with CPU heights on demand; frames byte-identical but no gain yet (see negative results). `atlas-frames-check.mjs --query` runs a flag A/B on one tree.

### Photo-view VRAM on WebGPU: 371 → 241 MiB (WAG W1.6; 2026-10-01)

- Attribution first: `scripts/gpu/vram-attribution.mjs` (dev only, render lock) wraps `GPUDevice.createTexture` / `createBuffer` in an init script and lists every live allocation by label and creating call site next to luma's totals. At 4d92d3f the photo view (IMG_7086) held 106 MiB of terrain height arrays, an 85 MiB imagery array with no imagery in it, a 47 MiB base-grid buffer, 40 MiB of MSAA colour targets, 2 × 21 MiB of 1024 px geometry targets (view + query source), 15 MiB of idle 384 px silhouette sources and a 16 MiB photo texture.
- `ImageryArray` creates its texture array on the first tile with imagery (−85 MiB in the photo view; world mode and the imagery drape allocate it as before). Once created it is never freed (nor shrunk) until the engine is disposed.
- Batched terrain: the base-grid storage buffer is packed per tile (`deck-webgpu/base-slots.ts`; offset in the tile table's `t2.w`) instead of a fixed G = 64 slot per row (−32 MiB with the headroom below). A re-pack grows the buffer once the live slots pass 85 % of it, so swaps of tiles of different sizes near full don't re-pack again and again; tiles out of height layers or rows are dropped before the slots are placed. Fast-tier check `base-slots`.
- WebGpuEngine drops the silhouette re-rank's 384 px sources 2 s after the last `autoAlign` / `silhouetteScore` (−15 MiB); the next re-rank re-creates them, with the same result (browser check `scripts/deck-webgpu/sil-release-check.mjs`). The first `autoAlign` after more than 2 s idle therefore includes creating the sources (up to five sets of 384 px targets), which shows in `silTiming.ms`.
- luma "GPU Memory" (`scripts/gpu/vram-probe.mjs`, 3 photos): WebGPU 371.0 / 358.6 / 370.0 → 240.7 / 230.1 / 242.1 MiB (238.3 / 227.9 / 239.7 before the re-pack headroom); WebGL deck unchanged at 189.3 / 177.5 / 190.2. Frames byte-identical (`atlas-frames-check.mjs` vs 8be09fb: 21 poses over 3 photos incl. streaming pans and the world imagery drape; IMG_3304 world needed a re-run, as the first, cold-cache base run captured it with 301 of 356 imagery layers loaded); photo-view frame time and pan frame gaps unchanged within run-to-run noise.
### Certified-f32 align refine, opt-in (WAG W3.3; 2026-10-01)

- `?alignPrecision=certified-f32` (or `autoAlignAsync(…, { alignPrecision: "certified-f32" })`; default `f64`): autoAlign's coordinate descent as a GPU-driven loop (`src/lib/gpu/align/cert-*.ts`, `cert.wgsl.ts`): 48 rounds per submit, DECIDE → EVAL (f32, indirect) → EVAL2 (double-f32 re-check, indirect). A move is decided on the GPU only when certified intervals of the f64 score (written error bound in `cert.wgsl.ts`) separate; otherwise the CPU decides on exact f64 scores, and past 32 such decisions the call runs the f64 path.
- The result equals the f64 path's as long as every certified decision is correct. That rests on the bound and on the device meeting its arithmetic premise: the shared strict-IEEE probe (`src/lib/gpu/precision`) plus the same probe compiled inside EVAL2's own shader module, both read through a granular verdict (align takes no square roots; flushed subnormals are charged as slack). Per-call runtime checks sample it: random intervals re-scored exactly, every EVAL2 accept and every near-margin decision plus a random sample re-decided on exact scores. A failure runs the f64 path, and a broken bound turns the certified path off for the device. The CPU's replay of the move log reproduces the poses but does not detect a wrong decision.
- Node check `align-cert` (fast tier): bit-identical AlignResults on synthetic and real edge maps, also on a flush-to-zero machine, with ±3-ULP divisions, and with every comparison forced through EVAL2 or the CPU; faults are caught. Browser bench `scripts/gpu/align-f32-bench.mjs` (Apple GPU, headless Chromium, 19 dev photos × 5 priors): 0 differences from the f64 path and from `autoAlign`; 105,024 decisions, 19.5% decided in double-f32, 5 on the CPU; 4.8 submits per autoAlign; the mandatory exact re-decisions (~133 per autoAlign) make it slower than f64 (median autoAlign 37.2 → 40.1 ms; faster on 5 of 19 photos). The wild-set gate has not been run.

### Whole-app graph foundations, fusions and fixes (WAG; 2026-10-01)

- `gpu/core` `ComputeGraph` (06f7c27): GPU indirect conditions on kernel nodes, with a clear lint for skipped nodes (aliased outputs need a whole clear or same-gate readers; rewriting the indirect command breaks "same gate"; undeclared nodes count as users); adopting an external `GPUCommandGraph`; `add()` / raw / copy / render nodes audited (`declareNode` for raw `g.graph` nodes); `workload` + `preflight` / `fitsDeviceLimits`; texture passthroughs and texture bindings in `addKernel`; `listCachedGraphs`. Readback `stagePartialRead` (capacity copy, header map, then `[0,total)`). Existing graphs encode unchanged. Fast-tier check `gpu-clear-lint`.
- `gpu/ingest` (4d18dec): upload adapters and a Terrarium rgba8 → f32 heights kernel, f32-exact (0 heights and 0 RGBA bytes differ from the canvas/CPU decode on 1,155 cached tiles). No callers yet besides the atlas adapters.
- Photo prep planes stay resident on the WebGPU device and align's pose grid / pose bound bind them (00e1cca); the CPU `EdgeMap` is read lazily (idle prefetch after load) and only verified planes are ever bound. Upload per grid 2.53 → 0.95 MB; outputs bit-identical. Fast-tier check `photoprep-resident`.
- Settle fusion (ccc5722): the masks pass rides the query-geometry render's submit and band stats the stats render's (`queue.submit([render, work])` via the new `gpu/core` `submitWithDefault`, which calls luma default-encoder internals: recheck on the next luma bump). Non-frame submits per settle 9 → 7, masks and stats byte-identical, settle → labels latency unchanged. Engine option `settleFusion` (default on; `false` restores the old path). Checks `bridge-fusion` (fast), `settle-submits` (full, WebGPU).
- `SplatV1Loader` / `SplatPlyLoader` on the loaders.gl Loader contract (c388c48), fast-tier check `splat-loaders`.
- Fix (4d92d3f): `splatsort-scan-totals` declared a params binding its WGSL never read, so the `auto` layout dropped it and Dawn rejected the bind group: the default GPU splat sort always fell back to the worker. It runs on the GPU again (1M splats 3.1 ms). The kernel-layout check now runs in CI with a binding-use lint (`kernel-binding-use`, 58e2888).
- Post-default re-baseline and probes (819155d): `research_notes/whole-app-graph-2026-10-01/baseline-2026-10-01.md`; `scripts/gpu/{sky-worker-profile,splat-sort-bench,vram-probe,longtask-probe,haze-overflow-probe}.mjs`.
- `biome.json` migrated to the locked Biome CLI 2.4.5 (566e4e7).

### TextureArrayAtlas for the WebGPU terrain heights and imagery (WAG W2.2; 2026-10-01)

- `deck-webgpu/texture-array-atlas.ts`: one growable 2D-array texture with a layer free list under the batched terrain's r32float height arrays (was `HeightPool`) and `ImageryArray`. Layers are written through the `gpu/ingest` adapters (`uploadRaster` / `uploadBitmap` with `into`); a grow copies every mip of the old layers with `copyTextureToTexture`. The height arrays used to be re-created empty and re-uploaded from the CPU on a grow: on a pan that grows the 256² array (measured on IMG_7086, IMG_6958, IMG_3304) that removes 279–342 height uploads (70–86 MiB) and cuts the growing sync from 38–40 ms to 15 ms of main-thread time. Photo load is unchanged (every tile is fresh then). Default on, WebGPU only; WebGL is unchanged.
- Frames are byte-identical before and after (geometry, normal and colour targets, 21 poses over 3 photos including pans across the grow and the imagery drape): `scripts/deck-webgpu/atlas-frames-check.mjs`. Fast-tier check `atlas-layout` (`atlas-layout.check.ts`). Cost probe: `scripts/deck-webgpu/atlas-cost.mjs`.
- Not done: the uv-window ancestor fallback. `atlas-layout.ts` `ancestorWindow` gives the window and is checked against `dem/grid.ts` `ancestorCrop` bit for bit, but the CPU height consumers still need the cropped arrays (WAG W2.4), and a shader bilinear over the ancestor would not render the same bits as `ancestorCrop` + `downsample2` + bilinear. `ancestorCrop` costs 0 ms on the two Swiss photos and 55 ms per load / 82–95 ms per pan sequence on IMG_3304 (56–83 fallback tiles).

### Certified-f32 horizon stages, opt-in (WAG W3.1 precision half, P1; 2026-10-01)

- `?horizonPrecision=certified-f32` (default `f64`, needs the GPU march): the skyline's tan → degrees step (D7) and the worker's WGS84 ENU + 8192-column resample (D8) run on the GPU in double-f32 with a tracked error bound. Each output is certified only when every value within the bound rounds to the same f32; the rest are recomputed by the f64 code, so outputs are bit-identical to the f64 path. Function option `precision` on `computeHorizonGpu` and `skylineDirs`. Error analysis: `src/lib/gpu/horizon/README.md`.
- The worker's f64 direction stage moved verbatim to `gpu/horizon/dirs-cpu.ts` (bit-identical; checked against the old code).
- `src/lib/gpu/precision`: shared double-f32 arithmetic (TS emulation + `DF32_WGSL`) and `probeStrictIeee(device)`, the per-device strict-IEEE probe that gates every certified-f32 stage.
- Fast-tier checks `horizon-cert` (0 false certifications on synthetic and, when generated, DEM cases) and `ieee-probe`; browser bench `scripts/gpu/horizon-cert-bench.mjs`.
### Batched terrain: GPU cull and indirect draws (WAG W1.5; 2026-10-01)

- WebGPU: the batched terrain's per-frame frustum cull moved to a two-node `ComputeGraph` (`deck-webgpu/layers/terrain-cull.ts`): a conservative f32 sphere test, then a stable compaction into per-resolution instance buffers and indexed indirect records, drawn with `Model.setIndirectBuffer` (luma #3328, vendored rigi.2). No count is read back. Frames are byte-identical to the CPU cull (3 photos × 10 poses incl. the world view, geometry + normal + colour targets); the CPU cost per pass is about the same (~17–19 µs vs ~16–21 µs at ~350–390 tiles), so this is not a CPU saving at today's tile counts.
- Flag `terrainGpuCull` (default off, since it saves no CPU time at today's tile counts; WebGL, `?gpu=off` and `terrainGpuCull=off` keep the CPU cull). New optional layer hook `GpuLayerCore.prepass(ctx)`, called by `hosts/passes.ts` before the geometry / colour pass on the same encoder.
- Checks: fast tier `terrain-cull` (`layers/terrain-cull-math.check.ts`); browser gate `scripts/deck-webgpu/terrain-indirect-check.mjs` (render lock, `?renderer=webgpu`).

### Graph inspection and app graph manifest (WAG W0.2, W0.3; 2026-10-01)

- `gpu/core/inspect.ts` + `inspector.ts`: luma's `GPUCommandGraphInspector` (one per device) and the upstream preflight over every `cachedGraph`; `getGpuGraphProfile()` in `core/profile.ts` reports per-graph and per-node CPU encode / GPU p50 / p95, transient bytes, aliasing savings and the preflight fit. Opt-in (profiling on, or `/dev/graph` open); unobserved graphs encode as before.
- `/dev/graph` (dev only): the page's live compute graphs per device, joined with the manifest; worker-realm modules are listed as remote.
- `src/lib/gpu/app-graph/manifest.ts`: islands I0–I12 and the GPU modules (groups, resources, cadence, realm, readbacks), `registerIsland` for dynamic entries. Fast-tier checks `gpu-inspect`, `app-graph` (manifest ↔ `cachedGraph` groups) and `app-graph-table` (`research_notes/whole-app-graph-2026-10-01/islands.generated.md`, from `scripts/gpu/app-graph-table.ts`).

### loaders.gl data paths (WAG W2.5, W2.6; 2026-10-01)

- `?cogReader=loaders|own` (default `own`): swisstopo COG reads for `?concord=occl` through `@loaders.gl/geotiff` `GeoTIFFSourceLoader` behind the existing `swiss-cog.ts` API, falling back to the own reader when a file cannot be opened. Windows are bit-identical to the own reader on the Swiss dev photos' swissSURFACE3D / swissALTI3D COGs (CI `cog-reader`); under the 4.5 MB byte budget the readers keep different tile sets (64 KiB header blocks), so the default stays `own`.
- `cachedFetch` / `cachedFetchRange`: HTTP byte ranges through the tile cache, keyed by url + range (a server that ignores Range is sliced).
- SPZ (v2, v3, v4) and KSPLAT splats import through `@loaders.gl/splats` (`src/lib/nearfield/splat-loaders-ext.ts`), sniffed by `selectSplatLoader` and parsed with the new async `parseSplat`; `splat-loaders.ts` imports the package only on use (CI `splat-loaders-ext`).

### Type system (2026-10-01)

Review and open items: `reports/type-system-review-2026-10-01.md`.
- `src/lib/ontology/domain.ts` (generated from the concept catalogue): one type per concept (`Photo`, `Orientation`, `Horizon`, `Skyline`, `PoseEstimate`, `PeakLabel`, …) bound to its canonical realization; CI `ontology` fails when it is stale.
- One canonical `Vec3`, `Mat3`, `LatLon`, `SWNE`, `Size` and the new `ByteMask` replace 30+ local copies; `CascadeStage` and `HeightFn` are declared once.
- Same-name exports renamed: `ExifPhotoMeta`, `SkylineSolveResult` / `GcpSolveResult`, `RefineConfidence`, `PeakLabelPx` / `BaselinePeakLabel`, `GeoJsonPeak` / `RidgelinePeakInput`, `FitParams` / `GcpParams`, `CompositeLookStyle`. Catalogued types must have unique names (CI `ontology`).
- Storage keys are built with `storageKey()` everywhere (CI fails on a spelled-out registered key); `?style=` is read through `lib/flags`; the autoAlign and matcher-v0.1 bars go through `levelOf`.
- `Renderer`: members both engines implement are required; the unimplemented `nearFieldSampleAt` is removed. 35 exports with no importer are module-local.

### Cleanup pass (2026-10-01)

Inventory of removed, retained and refactored code: `reports/cleanup-2026-10-01.md`.
- Removed `src/lib/tiles3d/three-tiles.ts` (the three.js 3D Tiles adapter, no caller), the stale `three/webgpu` and `three/tsl` `optimizeDeps` entries, and the regenerable per-photo intermediates of the killed FUND E0–E3 studies and the near-field spike/smear runs (reports, protocols, results and scripts kept; recover with `git show 84edf95^:<path>`).
- Research harnesses under `tools/` no longer import the main tree by absolute path.
- Fast tier green again on a clean clone: formatting drift fixed, atlas pages and `reports/ontology.md` no longer cite the deleted `src/lib/engine.ts`, and the `export` check declares its gitignored photo input so a fresh checkout skips it instead of failing.
- Docs: present-tense references to the removed three.js renderer, `src/lib/render` and the removed concord checks fixed; CI check table regenerated; superseded banners on `reports/deck-default.md` and `reports/matcher-service.md`.

### luma.gl 10 and WebGPU by default (2026-09-28 to 2026-10-01)

Rendering
- WebGPU is the default renderer: `?renderer=auto` (the default) runs deck.gl on WebGPU (`WebGpuEngine`, `src/lib/deck-webgpu`) where the browser passes the probe, and deck.gl on WebGL2 (`DeckEngine`, `src/lib/deck`) otherwise. `?renderer=webgpu|deck` pins an engine, `?webgpu=off` forces the fallback. Decision record and open regression list: `reports/webgpu-default.md`.
- The three.js `PhotoEngine` and `?renderer=three` are removed. three.js remains for Step Inside splats, the 3D Tiles adapters and the P3 RGB-D cache.
- A mid-session WebGPU device loss that cannot rebuild switches `/photo` to the WebGL deck engine; `auto` routes terroir-styled views (land cover, contours) through WGSL on WebGPU.
- deck-webgpu: geometry diet; GPU label occlusion, skyline and point queries instead of a full 1024 px readback per settle; cached peak-label occlusion verdicts; no-MSAA colour pass while interacting with 4x MSAA on settle; idle prewarm of the interactive pipelines; trail dash; GPU splat sort with a worker fallback.
- Offscreen pose renders for the matcher and `lab.generate` run on the deck engines; every harness that pinned three is retargeted to deck/WebGPU.

GPU compute
- Compute runs on luma's `GPUCommandGraph` through the `ComputeGraph` in `src/lib/gpu/core`, and the graph is the only GPU path: horizon, eye search, solve, look passes (relief, haze, guided filter, band stats), sky refine, align pose grid and bounds, skyglobal grid, silhouette masks, GPU splat sort and ridgeline tracing. The pooled dispatch paths are removed.
- Pipelines are built through luma's engine `Kernel`/`Kernel.createAsync`; haze scan and offset steps use luma `GPUScan`.
- Under WebGPU the render device is also the compute device (`adoptRenderDevice`); look passes run on render targets with no CPU round trip. Auto-align refine pre-screens with certified score bounds and re-ranks silhouettes on the GPU.

Vendored dependencies
- luma.gl `10.0.0-alpha.2-rigi.1` (built from luma master `7d1d11e9` plus #3312, #3313, #3302, #3287 and a PipelineFactory compute-hash fix) and a deck.gl `9.4.0-beta.4` build (deck PR #10752 on master plus luma's WebGPU deck fixes) are installed from `vendor/`. Rebuild steps: `vendor/luma/README.md`, `vendor/deck/README.md`.
- luma.gl bumped to `10.0.0-alpha.2-rigi.2` (rigi.1 plus luma PR #3328, `Model.setIndirectBuffer`; patch in `vendor/luma/patches/luma-3328.patch`); `scripts/gpu/indirect-draw-check.mjs` checks a GPU-written indirect draw against a direct draw. Added `@loaders.gl/geotiff` and `@loaders.gl/splats` `^5.0.0-alpha.7` (not imported yet).
- Adopted luma `requiredLimits` (#3312) and `WebGPUAdapter.attach()` (#3313) for app-created devices.

Look and cartography
- Terroir cartography: land-cover shading and contours, legend, place card and roll hooks.
- Height-fog ("Nebelmeer") and precipitation looks ported from luma.gl #3325 (MIT, vis.gl contributors); see `NOTICE.md`.

Tooling
- `scripts/ci/run.mjs` regression gate (fast and full tiers) with a per-file Biome ratchet; render lock is a FIFO queue; CI child cleanup and its own dev port.
- Repository conventions follow luma.gl: `LICENSE` (MIT), `NOTICE.md`, `AGENTS.md`, `CONTRIBUTING.md` (with AI-assisted contributions), `CODE_OF_CONDUCT.md`, `.github` templates, SPDX headers, `examples/`.

Fixes
- Review fixes CR-54 to CR-68 (WebGL context restore, device free on boot failure, private sky copy before the grid await, silhouette-mask kernel on `gpu/core`, `faultDeflate` hook gated to dev); retryable `compileAsync`; DEM no-data fill and fetch retry; Step Inside pose re-check; upload region races.

### Earlier

- 2026-09-28: initial commit: Rigi app, pose pipeline, matcher, benchmark and research tooling, reports.
