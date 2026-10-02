<!-- Rigi -->
<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: Copyright (c) Rigi contributors -->

# GPU and compute pipeline: luma-native pass (2026-10-01, session mt-image-07)

Goal (user): "make the system as luma native and bleeding edge as possible": review the GPU and compute pipeline, research the latest luma.gl, deck.gl and loaders.gl branches and pre-releases, plan, implement with Sonnet subagents. Runs under cook mode ([batch-ledger.md](batch-ledger.md)): fast gates only, every landed commit is browser-unverified and has a ledger row.

## 1. Where we start

- Vendored luma `10.0.0-alpha.2-rigi.3` (master `7289d961` + 7 PRs + the compute-hash fix) and deck `9.4.0-rigi.1`. Every `src/lib/gpu/**` module already runs on `ComputeGraph` over `GPUCommandGraph`. WebGPU deck is the default renderer. Render bundles, indirect draws, timestamps, `attach()` and `requiredLimits` are in use.
- What is left is not a migration but a tail: raw-handle escapes, infrastructure that duplicates luma (or itself), one large CPU hop, hand-packed uniforms, private casts, and raw GL in the WebGL fallback.

## 2. Upstream state (researched 2026-10-01)

| Library | npm | Branches / PRs | Verdict |
|---|---|---|---|
| luma.gl | `beta` = 10.0.0-alpha.2, `latest` = 9.4.2, no canary | master still `7289d961` (= our base); our 7 vendored PR heads unchanged. New: #3345 (compat-mode devices request real adapter limits), #3340 (progressive RAD splats, +2.4k lines), #3338 (zero-size storage binding invalidates a submit), #3332 (storage offset alignment), #3286/#3288/i#3329 (shader assembler; may break deck shim) | Vendor #3345 into rigi.4; copy #3338/#3332 as guards in `gpu/core`; #3340 spike only; watch the assembler PRs |
| deck.gl | `latest` 9.4.0, `beta` 9.4.0-beta.4 | #10779 (version-based invalidation of binary attributes rewritten in place), #10778 + #10782 (`_onFrameTimings` per-pass GPU timestamps; `debug` forwarded to device creation), #10753 (pad 8/16-bit x3 attributes on WebGPU), #10776 (external f64 buffers on WebGPU), #10751 (TerrainExtension WebGPU height fit), #10752 (our luma-10 bump; CI green, still draft) | Vendor #10779, #10778, #10782, #10753, #10776 into deck rigi.2; #10751 spike later |
| loaders.gl | `beta` 5.0.0-alpha.7 (ours) | master has #4088 `GeoTIFFRasterLoader` (typed bands, nodata, GeoKeys), not published; 3D Tiles perf drafts #4089/#4090/#4092 | Watch; adopt `GeoTIFFRasterLoader` for `?cogReader=loaders` when alpha.8 ships. App imports only `@loaders.gl/splats` and `@loaders.gl/geotiff` |
| math.gl | `beta` 5.0.0-alpha.10 (ours) | new TS `@math.gl/proj4` (PR #165, batch kernels, geoid grids) | Watch for LV95/geoid |

## 3. Plan

Wave 1: independent packages in sandboxes (`git clone --shared` + CoW `node_modules`), file-disjoint, landed hunk-only:

| WP | Package | Files |
|---|---|---|
| W1 | Core dead-path removal: unused `dispatch`/`dispatchAll`, `passProps` profiling, the per-spec PipelineFactory workaround (rigi.3 hashes `entryPoint`/`constants`); zero-size binding + storage-offset alignment guards (luma #3338/#3332 ideas) | `gpu/core/{kernel,profile,queue,graph,selftest}.ts`, two `scripts/gpu` pages |
| W2 | Geometry query: GPU unpack kernel replaces the 16 MB rgba32f readback + CPU unpack per settled pose; one texture reader in deck-webgpu | `deck-webgpu/{layers/geometry-source,readback,compute-bridge,engine}.ts` + new kernel/check |
| W3 | `look/textures.ts` onto core `defineKernel`/`cachedGraph`; async compile for page-side graphs | `gpu/look/textures.ts`, `deck-webgpu/texture-array-atlas.ts`, `layers/flow.ts`, `gpu/ingest/terrarium-tile.ts` |
| W4 | Public-API swaps: raw texture upload in sky prep, `generateMipmapsWebGPU` casts → one helper, `onSubmittedWorkDone` → `createFence`, sidecar device via luma props | `gpu/sky/prep.ts`, `deck-webgpu/{textures,hosts/deck,hosts/direct}.ts`, `layers/{multi-drape,tiles3d}.ts`, `roll/map/drape-atlas.ts`, `gpu/core/device.ts` |
| W5 | Delete the in-house splat radix (luma `GPUSort` is default) and its flag; `.splat` via loaders.gl | `gpu/splat-sort/**`, `flags/index.ts` (one entry), `nearfield/splat-loaders*.ts` |
| W6 | Uniforms through luma `ShaderBlockWriter` (bit-equality check); pool `height-gather` buffers | new `gpu/core/uniform-block.ts`, `deck-webgpu/{geo-query-gpu,silhouette-gpu,layers/terrain-cull,height-gather}.ts`, `gpu/horizon/scene-profile.ts` |
| W7 | Retire the legacy three `Terrain` class (moves `heightFromTile`/`TerrainTile` to `dem/`) | `src/lib/terrain*.ts`, `routes/lab.generate.tsx`, ontology realizations, one engine import |
| W8 | Matcher `T6_GPU_GRID` default on (env opt-out); bit-identical on 4 photos, 5–23 ms vs 3.5–8 s | `tools/matcher/stage1/vendor_v03/render_worker.mjs` + docs |

Wave 2: vendor bump (one agent, sequential): luma rigi.4 = rigi.3 + #3345 + local `CommandEncoder.clearBuffer`, `Device.submit` with extra command buffers, a no-queue-wait read, `RenderBundleEncoder` MSAA; deck rigi.2 = rigi.1 + #10779 #10778 #10782 #10753 #10776. Then retire `pool.clear` raw handle, the private-API submit in `queue.ts`, the native bundle encoder, and move frame timings onto deck's `_onFrameTimings`.

Wave 3: WebGL fallback onto luma (PBO readbacks → `Texture.readBuffer` + fences; `silhouette-gl`, `range-gpu`, `panoGL` → luma `Model`), per-tile layer uniform out of the draw loop (render-bundle prerequisite), and a CI lint that forbids new raw `.handle` / `navigator.gpu` outside an allowlist.

Not planned: 3D Tiles on deck `Tileset3D` (needs `@deck.gl/geo-layers` in the vendored set; L), three → math.gl for pure math (not GPU), loaders.gl DEM pipeline (in-house GPU decode is already better), the certified-f32 horizon A→B→C fusion (L, needs timing runs).

## 4. Outcomes

All landed on fast gates only (cook mode), each commit `(WIP, browser-unverified)`. Every numerics-bearing change is either a pure data-movement change or proven byte-identical in a node/tsx check.

| WP | Commit | Outcome | Evidence (no browser) |
|---|---|---|---|
| W4 | 504ede0 | Sky prep upload on luma `createTexture` / `copyExternalImage` / `copyTextureToBuffer` / `device.submit`; one `generateTextureMipmaps` helper replaces 3 `as unknown as` casts; frame waiters on `device.createFence()`; the compute sidecar is created by `webgpuAdapter.create` (`optionalFeatures`, `requiredLimits`). Left: a peek adapter for limit maxima, ORT's attached device | tsc, fast tier |
| W1 | b0f0d38 | Removed unused `dispatch`/`dispatchAll` and the `passProps` profiler (test pages use `core/test-dispatch.ts`); kernels share the device `PipelineFactory` (rigi.3+ hashes `entryPoint`/constants); new `checkStorageBindings` guard (zero-size binding, `minStorageBufferOffsetAlignment`), after luma #3338/#3332 | `gpu-binding-guard` |
| W7 | 357e9c6 | `heightFromTile` → `dem/height-from-tile.ts`; the legacy three `Terrain` moved next to its only user (`/lab/generate`) as `nearfield/generate/three-terrain*.ts`; ontology realization repointed | `ontology`, `gipfelbuch` |
| W6 | 36e9aed | `gpu/core/uniform-block.ts` `defineUniformBlock` on luma `makeShaderBlockLayout` + `ShaderBlockWriter` (`wgsl-uniform`); geo-query, silhouette, terrain-cull migrated; height-gather pools its 3 per-gather buffers | `gpu-uniform-block` (byte-identical) |
| W5 | 1dca4c1 (+a0586a5) | In-house splat radix deleted (luma `GPUSort` was already default), `splatSortGpgpu` retired with a warning; plain `.splat` via `@loaders.gl/splats` `SPLATLoader`. −430 lines | `splat-sort-check` (220 cases), `splat-loaders-ext` |
| W8 | e7f3ecc | Matcher T6 skyline grid on the GPU by default (`T6_GPU_GRID=0` opts out; CPU fallback unchanged) | `t6-gpu-grid-default`. Matcher owner sign-off still open |
| W2 | 4ab7152 | Geometry target unpacked on the GPU (copy/select-only WGSL): range-only consumers (haze fit, look grid, stats) read 4 MB instead of 16 MB + a CPU loop; full reads 16 MB without stride copy or loop. One texture-readback helper with pooled staging. Correction to the audit: the settle path already skipped the full read; the saving is on the on-demand reads | `geo-unpack` (byte-identical vs CPU loop incl. NaN/Inf/−0/denormal) |
| W3 | 96a6a6f, f54be3d | `look/textures.ts` on core `defineKernel` / `cachedGraph` (group `look-tex`, visible to the manifest and inspector); async compile for page-side graphs (terrarium, flow, atlas); LookBridge prewarms pipelines so the first fused encode compiles from cache; `kernelAsync` no longer orphans a `createAsync` rejection | `bridge-fusion`, `app-graph`, `haze-tail`, `stats-fold` |
| V1 | 843dfc0 | **luma `10.0.0-alpha.2-rigi.4`** = rigi.3 + #3345 + four local commits: `CommandEncoder.clearBuffer`, `Device.submit(cb?, additionalCommandBuffers?)`, `Buffer.mapAndReadAsync(…, {waitForSubmittedWork})`, `RenderBundleEncoder` `sampleCount > 1`. **deck `9.4.0-rigi.2`** = rigi.1 + #10779 #10778 #10782 #10753 #10776. Bundles in `~/mt-image-archive/2026-10-01-rigi4/` | `npm ls` one copy each, tsc, fast tier |
| V2 | 0e6a872 | Adopted: `pool.clear` → `clearBuffer`; `queue.ts` private finaliser → `device.submit(undefined, extras)`; `readback.ts` raw `mapAsync` → `mapAndReadAsync({waitForSubmittedWork:false})`; native MSAA bundle encoder → luma. Not adopted: deck `_onFrameTimings` (times only deck's layers pass, misses our geometry/colour passes), `debug` (no app flag), #10779 (no layer feeds deck's attribute manager) | `gpu-inspect`, `gpu-clear-lint`, `bridge-fusion`, `kernel-binding-use` |
| X2 | eb149b5 | WebGL silhouette mask and roll-map range on luma `Model`s (std140 blocks, `readBuffer`): raw gl 73 → 1 and 96 → 1. `panoGL.ts` skipped (own context, sync constructor) | `silhouette-mask` (CPU emulation only) |
| X4 | 5aea8a6 | 13 look / precision uniform structs on `defineUniformBlock` (`look/uniform-blocks.ts`) | `gpu-uniform-block-look` (1345 cases) |
| X3 | ec2d315 | 8 align / solve-fold / horizon structs on `defineUniformBlock` (`gpu/{align,solve,horizon}/uniforms.ts`), incl. certified-f32 paths | `gpu-uniform-block-a` (2315 cases incl. NaN payloads) |
| X5 | 8d5f643, 37b41b9 | Fast-tier ratchet `gpu-raw-lint` (`scripts/ci/gpu-raw-lint.mjs` + `gpu-raw-baseline.json`, a `why` per allowlisted file): raw WebGPU, native `.handle` use, casts to private members, raw `gl.` per file in `src/lib`; fails only on increases. Count before wave 3 → after this pass: **705 → 339** escapes; `silhouette-gl.ts` and `range-gpu.ts` 0 raw gl, `pool.ts`, `readback.ts`, `render-bundle.ts` 0 handle uses, `queue.ts` 0 private members | ratchet tested both ways |
| X1 | 888be38 | WebGL fallback PBO readbacks (geometry, composite layers) on `texture.readBuffer` + `Buffer.readAsync` via one `readTextureQuiet`; raw gl in `src/lib/deck` 183 → 154 | tsc, biome only |

### Still raw on purpose, or next

- `mapAndReadAsync` copies into a new array; luma WebGL `getWebGLUsage` ignores read hints (pack buffers get `STATIC_DRAW`, the old code used `STREAM_READ` because of a Chrome slow path). Candidate for rigi.5: map `Buffer.MAP_READ` to `STREAM_READ`.
- Hand-packed uniforms that remain live in the files that own the kernel inputs: solve `packCoarse`, horizon march / skyglobal `ub`, photoprep `photoPrepDims`, colour-stats `statsParamWords`, `haze.ts` / `haze-band.ts`, `relief.ts`.
- `panoGL.ts` (own WebGL context) and the MSAA renderbuffer blit stay raw; the deck `engine.ts` owner can pass luma textures to `SilhouetteMaskGL` instead of handles.
- deck `_onFrameTimings` adoption waits for a deck hook that covers non-layer passes; #10751 (TerrainExtension WebGPU height fit) and luma #3340 (progressive splats) stay spikes.
- loaders.gl `GeoTIFFRasterLoader` (#4088) when `5.0.0-alpha.8` ships; `@math.gl/proj4` for LV95/geoid.

### What the browser batch must check

Per commit, in [batch-ledger.md](batch-ledger.md). Highest risk first: X1 (WebGL readback timing and bytes), V2 (readback latency, fused submits with `__RIGI_GPU_CHECKS__`, MSAA bundle replay, device loss), X2 (silhouette A/B under WebGL, roll-map atlas state), W2 (GPU planes = CPU planes on a real render; denormal flag stays 0), W4 (sidecar limits/features, idle release), W3 (first-frame fusion), W8 (matcher poses with `T6_GPU_GRID` unset vs `0`).
