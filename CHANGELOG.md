# Rigi CHANGELOG

Entries are factual and ordered newest first. There are no tagged releases yet; everything is under Unreleased until the first tag.

## Unreleased

### Graph inspection and app graph manifest (WAG W0.2, W0.3; 2026-10-01)

- `gpu/core/inspect.ts` + `inspector.ts`: luma's `GPUCommandGraphInspector` (one per device) and the upstream preflight over every `cachedGraph`; `getGpuGraphProfile()` in `core/profile.ts` reports per-graph and per-node CPU encode / GPU p50 / p95, transient bytes, aliasing savings and the preflight fit. Opt-in (profiling on, or `/dev/graph` open); unobserved graphs encode as before.
- `/dev/graph` (dev only): the page's live compute graphs per device, joined with the manifest; worker-realm modules are listed as remote.
- `src/lib/gpu/app-graph/manifest.ts`: islands I0–I12 and the GPU modules (groups, resources, cadence, realm, readbacks), `registerIsland` for dynamic entries. Fast-tier checks `gpu-inspect`, `app-graph` (manifest ↔ `cachedGraph` groups) and `app-graph-table` (`research_notes/whole-app-graph-2026-10-01/islands.generated.md`, from `scripts/gpu/app-graph-table.ts`).

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
