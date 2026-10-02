<!-- Rigi -->
<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: Copyright (c) Rigi contributors -->

# Roll map on WebGPU: plan (2026-10-02)

**Status (2026-10-02, later the same day): implemented, uncommitted and browser-unverified.** P1–P7 landed as the backend split in `src/lib/roll/map/backend*.ts` (see the `roll-map-webgpu` row in `reports/batch-ledger.md`). Differences from this plan: the WebGPU backend uses a `DirectHost` plus a lazily created second deck for extras (not a `DeckHost` variant); pins are a new `PinCore`; the range hand-off goes through a storage buffer and `copyBufferToTexture` (no storage-texture usage on the atlas); the device-loss path falls back to WebGL2 instead of rebuilding. P8 (flip the default) is in effect through `auto`.

Research only; nothing was changed in `src/`. Line numbers are as of master `65b1907` plus the dirty tree.

## 1. Summary

- `RollMapEngine` (`src/lib/roll/map/roll-map.ts:247`) calls `new Deck({canvas, …})` with no `deviceProps`, so deck builds its bundled WebGL2 adapter even when `resolveRenderer()` chose WebGPU. Everything it draws is GLSL or raw WebGL2.
- **Most of the WGSL already exists.** `src/lib/deck-webgpu/layers/multi-drape.ts` (986 lines) is a finished port of `multi-drape-layer.ts`, including `WebGpuDrapeAtlas` (`:167`), `CLEAR_AIR_WGSL`, a node check (`multi-drape.check.ts`, CI id `layer-multi-drape`) and a browser check. Its header says "this core exists for when /roll moves to WebGPU" and "nothing here is wired". `BatchedTerrainCore`, `GizmoCore`, `ImageryArray`, the world camera mode and the off-frame `GeometrySource` also exist.
- **What is missing** is the wiring plus four pieces: (a) a world-view host for the roll map (the `DeckHost` hard-codes `PhotoView`), (b) the GPU range-map hand-off (`RangeGpu` is raw WebGL2, `range-gpu.ts:123`), (c) the pins and the deck "extras" layers (terroir names, cameras, Spot 3D splats) on a WebGPU deck, (d) `drape-clear` / `drape-gains` device checks.
- Recommendation: build it as `RollMapEngine` taking a **host** (WebGPU: `createWebgpuDeck` + roll cores; WebGL2: today's path unchanged), selected with `resolveRenderer()`. Do not share one device with Step Inside (section 3).
- Step Inside cannot simply reuse `terrain.bin`; a small adapter covers the far and context tiles only (section 4).

## 2. Inventory of GPU-touching pieces

Legend: RE = reusable as is, PORT = port exists but must be wired or extended, NEW = write.

| # | Piece (file:line) | Today | Language / API | GPU readback / raw gl | WebGPU status |
|---|---|---|---|---|---|
| 1 | Deck construction (`roll-map.ts:247`) | `new Deck` on deck's WebGL2 adapter | deck 9.4 | none | PORT: `createWebgpuDeck` (`deck-webgpu/device.ts:172`) with `adoptForCompute`, feature check, timeout, onError routing. Needs a world-view variant (below). |
| 2 | `WorldView`, `WorldViewport`, `WorldCamera` (`deck/world-view.ts:65,100,138`) | deck `View` + three.js camera maths on CPU | none (pure CPU) | none | RE. `WorldView` is a deck view and device-agnostic; `WorldCamera` is CPU only. The WebGPU engine already has a world orbit mode (`engine.ts:277, 756`, `frame.view "world"`). |
| 3 | Terrain (`deck/terrain-layer.ts`, 1220 lines, used at `roll-map.ts:1099`) | `TerrainLayer`, GLSL uber-shader, batched tile grid, `elevRange`, imagery as `ImageBitmap` map by tile id | luma `Model` on deck | none | RE: `BatchedTerrainCore` (`layers/batched-terrain.ts:696`, WGSL) + `ImageryArray` (`imagery.ts:124`) + `terrain-styles.ts` (`style`/`look` equivalents). Roll feeds it `set.tiles` with `mesh.grid` (`roll-terrain.ts:137`), the same data the engine's terrain takes. Needs: `nearFade 0`, `projectPhoto 0`, `offscreen false` modes (all expressible as core look props, verify), and `elevRange` (`localElevRange`, `engine.ts:1274` already does this). `cpuBitmaps: true` (`roll-map.ts:1026`) is a WebGL workaround; drop it on WebGPU. |
| 4 | Drape (`multi-drape-layer.ts`, 843 lines) | `DrapeTileLayer extends Layer`, `#version 300 es` VS/FS (`:167,:193`), per-tile uniform block (`:838`), 4 photo atlases + r32float range atlas + r8 mask atlas | GLSL via deck `project32` | none | PORT: `layers/multi-drape.ts` (WGSL, storage tables instead of per-tile uniform ranges, camera-relative matrices). Needs: wiring per its header, then the browser check on a real roll. |
| 5 | Drape atlas (`drape-atlas.ts`, 302 lines) | luma `Texture`s, `generateMipmapsWebGL()` only if `device.type === "webgl"` (`:214`) | luma API | `setRangeGpu` takes a `RangeGpu` (`:236`) | PORT: `WebGpuDrapeAtlas` (`multi-drape.ts:167`) adds mips. `setRangeGpu(k, gpu: RangeGpu, …)` is typed to the WebGL class; the WebGPU path needs an alternative (row 7). |
| 6 | Clear air texture (`drape-clear.ts`, 435 lines) | RGBA32F params texture (4 texels per photo), `hazeFitAsync` (graph kernels) or CPU fit | luma texture + `look/haze-fit` | range map readback only for the fit (`roll-map.ts:640`, `src.readDrawn`) | RE for the texture (plain luma `Texture`, no `device.type` branch; `grep webgl` finds none). `CLEAR_AIR_WGSL` consumes it. The fit already runs through `gpu/core` kernels and `getComputeDevice()`, which is the adopted render device. |
| 7 | Range map render (`GpuGeometrySource`, `deck/geometry-pass.ts`, used at `roll-map.ts:565, 1311`) | WebGL framebuffer + PBO readbacks, row flip | luma + raw gl (`gpu-raw-lint` entry for `geometry-pass.ts`) | `drawOnly`, `readDrawn`, `render` | PORT: `layers/geometry-source.ts` `webgpuGeometryFactory` (WebGPU, TextureReader, rows already top-first, uses `BatchedTerrainCore` through the photo camera). `rangeMapFor()` (`roll-map.ts:1296`, public API used by roll features) maps to its `render(pose)` + `range`. API gaps: `drawOnly`/`src.texture` (target stays on GPU) must be exposed; `GeometryTargets.geometry` is rgba32float with w = range, 0 = sky. |
| 8 | `RangeGpu` (`range-gpu.ts`, 290 lines) | two raw WebGL2 GLSL programs (copy target into the range-atlas cell with sky fix-up; 8x8 max-pool to the COARSE grid), `readPixels` + `glFence` + `readbackQuiet` (`:253-266`); `ok` is false unless `device.type === "webgl"` (`:123`) | raw gl (listed in `gpu-raw-lint.mjs:108`) | readback of 1/64 of the texels | NEW: a `gpu/core` graph. Kernel 1: `rgba32float`.w to `r32float` atlas cell (render pass or `copyTextureToTexture` cannot do the channel pick, so a tiny fullscreen pass or a compute kernel with storage-texture write; `r32float` storage write needs no extra feature). Kernel 2: 8x8 max-pool to a small storage buffer, read through the readback ring (`gpu/core/readback`). Same semantics: keep a texel when `0 < r < +Inf`, else write +0 (`range-gpu.ts` header). Reuse the pattern of `geo-unpack.ts` / `geo-query-gpu.ts` (cachedGraph, pool slots, `runNow`). Both ~60 WGSL lines. |
| 9 | Gizmos / frustums (`WorldGizmoLayer`, `world-view.ts:349`, deck `BitmapLayer` + lines) | deck composite | GLSL | none | PORT: `layers/gizmo.ts` `GizmoCore` (`:327`, order 20), props `GIZMO_DEFAULTS` (`:87`) are the same fields (pose, eye, aspect, plane opacity, line and pin colour/radius, thumbnail). Check it takes many instances (the roll draws one per photo, up to MAX_PHOTOS) and a per-instance image. |
| 10 | Pins (`ScatterplotLayer` + `LogDepthExtension`, `roll-map.ts:1169`) | deck layer, `depthCompare: always` | GLSL; `LogDepthExtension` (`world-view.ts:324`) is a GLSL shader hook | none | NEW (small): either a `PinCore` (instanced billboard discs, ~80 WGSL lines, overlay, no depth) or deck's own `ScatterplotLayer` on the WebGPU deck without the extension (`parameters` already disable depth, so the log-depth hook is not needed on a no-depth layer). README: layer extensions have no WGSL hooks. Prefer the deck layer if it renders under deck 9.4 WebGPU (spike); else `PinCore`. |
| 11 | Pick (`roll-map.ts:1257`) | `deck.getViewports()[0].project(eye)` | CPU | none | RE if the host still exposes a deck viewport; else call `WorldViewport.project` directly. |
| 12 | Extras (`setExtraLayers`: `terroir/roll/roll-map-extras.ts` TextLayer / PathLayer / PolygonLayer / ScatterplotLayer; `nearfield/roll/roll-spot.ts:407` `DeckSplatLayer`) | deck GLSL layers added after the drape | GLSL | `deck-splat-layer.ts` raw gl (blit) | **Largest unknown.** Needs deck 9.4 WGSL for Text/Path/Polygon/Scatterplot (vendored #10752 is meant to provide this; unverified in this repo) and a WebGPU splat layer (`deck-webgpu/layers/splats.ts` exists as a core, not as a deck layer). Plan: gate extras by backend; on WebGPU first ship without them or only the ones a spike proves, keep them on the WebGL2 path. |
| 13 | Sky / canvas background | `canvas.style.backgroundColor = WORLD_SKY` (`roll-map.ts:256`) | CSS | none | RE: keep. (`atm-sky` / `photo-sky` cores exist, but the map is deliberately a flat sky.) |
| 14 | `useDevicePixels` (`:251, :942`) | deck prop | none | none | Host option `pixelRatioCap` (`DeckHost.create(canvas, pose, pixelRatioCap)`). |
| 15 | Device loss | none for the roll map (the WebGL map does not rebuild) | | | NEW: reuse the engine's pattern, section 3. |
| 16 | `drape-gains.ts` (363 lines) | CPU solve (Cholesky/IRLS), samples from the range maps | CPU | none | RE. |
| 17 | Mask atlas (`atlas.setMask`) | `writeData` into an r8 texture | luma | none | RE. |

Raw gl in the roll map today: only `range-gpu.ts` (`glOf`, `glFence`, `readbackQuiet`, `readbackBuffer` from `deck/geometry-pass`) and, transitively, `deck/geometry-pass.ts`. `gpu-raw-lint` therefore counts `range-gpu.ts` (`scripts/ci/gpu-raw-lint.mjs:108`); on WebGPU that file's WebGL programs become the fallback only.

## 3. Device acquisition, host, device loss

**Host shape.** Two options:
1. *DeckHost with a world view.* Add a `createRollDeckHost(canvas, …)` next to `hosts/deck.ts` that calls `createWebgpuDeck` with `views: [new WorldView({id:"world", near:0.5, far:600_000})]`, an Effect whose `preRender` runs `hosts/passes.ts` (colour pass only: no geometry target is needed for the map, only for range maps via `GeometrySource`), and keeps deck's canvas pass for deck layers. This keeps deck layers (extras, pins) alive and matches what the photo engine does (`DeckHost.create`, `hosts/deck.ts:92`).
2. *DirectHost* (`hosts/direct.ts`): no deck at all; cannot draw the extras (TextLayer etc.).

Pick option 1 (extras are real features: terroir names, cameras, Spot 3D). Cost: `DeckHost` assumes `PhotoView` plus an `OrthographicView` "screen" and `layerFilter: viewport.id === "screen"` (`hosts/deck.ts:100-112`); the roll host needs the colour pass camera from `WorldViewport` (`Host.view` / `frameView = "world"` already exist in the interface, `hosts/direct.ts:44-56`) and a layer filter that passes the deck extras in the "world" viewport.

**Device.** Use `createWebgpuDeck` (`device.ts:172`), never raw `new Deck`: it requests the limits and features (`float32-filterable` is required: the r32float range atlas and the geometry target are bound filterable; `renderRequiredLimits` for `maxTextureArrayLayers`), rejects on failure or after 15 s, runs `assertRequiredFeatures`, and calls `adoptForCompute` so `getComputeDevice()` is the render device (haze fit, range kernels, gains run on it).

**Selection and fallback.** In `LiveRollMap.tsx` and `RollMap.tsx`, call `resolveRenderer()` (the same function `StepInsideDemo.tsx:144` uses) and pass `backend` into `RollMapEngine`. Fallback ladder: `resolveRenderer` says deck -> today's WebGL path; WebGPU chosen but `createWebgpuDeck` rejects -> dispose, re-mount the canvas (a canvas that held a WebGPU context cannot give WebGL2; the pattern is in README "Init failure"), run WebGL2. Respect `?renderer=deck|webgpu` and `?webgpu=off`. Expose `data-renderer` on the map root like the workspace does.

**Device loss.** Mirror `WebGpuEngine.onDeviceLost` (`engine.ts:1057`): `device.lost.then` rebuilds host + cores + atlas on the same canvas, with a loss cap (`MAX_DEVICE_LOSSES`). The atlas, `DrapeClear` texture, and imagery array are device objects: the roll map keeps their CPU sources (`pixels`, `masks`, `imagery` bitmaps, `rangeQueue`) so rebuild means re-uploading and re-rendering range maps. Baked seeds make that cheap on the landing (`photoSeed` coarse grids need no render, the atlas range cell does). WebGL2 context loss is not handled by the roll map today; if wanted, reuse `deck/device-lost.ts` `watchContextLoss` (separate small item).

**One device for the live map and Step Inside: not worth it.**
- `liveSlot.ts` (header, `EVICT_AFTER_MS = 1200`) keeps one live GPU embed on screen, evicting the others after a 1.2 s delay; the roll map and Step Inside are both `useLiveEmbed` consumers, so at steady state there is one device.
- The overlap is a scroll transition of ~1.2 s; sharing would save one device creation (hundreds of ms, once per visit to the other section) but demands a luma device with more than one canvas context (`createCanvasContext` is per device in `createRenderDevice`/`createWebgpuDeck`), a refcounted device owner that survives either engine's `finalize()`/`destroy()` (both call `device.destroy()` on failure paths, `device.ts:240`), and coordinated loss recovery. Memory: the roll atlas (about 240 MB for 60 photos, `drape-atlas.ts` header) and Step Inside's resources would be resident together only if the slot rule failed, which sharing does not fix.
- It also complicates `adoptForCompute`, which is a single global slot (`gpu/device.ts:113`: last adopted wins; the loser's `lost` handler only clears if it is still current). Two devices overlapping for 1.2 s is benign today: the later adopter wins, and destroying the earlier one does not clear it. Keep that behaviour but add a check (section 6) that the landing never leaves `adoptedRenderDevice()` pointing at a destroyed device when the roll map is evicted after Step Inside started.
- Cheaper wins: keep `EVICT_AFTER_MS`, prewarm `peekWebGPUAdapter` once, and let Step Inside await the roll map's `dispose` (device destroyed) before creating its own if the transition shows jank.

## 4. Can Step Inside reuse the roll map's baked terrain seed?

**The two paths.**

| | Roll map (`roll-terrain.ts`) | Step Inside (`deck-webgpu/engine.ts:1357`, `deck/terrain-stream.ts`) |
|---|---|---|
| Selection | `selectRollTiles` (`roll-terrain.ts:59`): split while within `lod 1.5` x size of any viewpoint or `0.8` x size of the roll centre; `minZoom 8`, `maxZoom 16`; radius `max(40 km, roll.radiusM + 30 km)` (`roll-map.ts:480`) | `TerrainStreamer`/`selectDemTiles` (`terrain-data.ts:411`): quadtree from the photo, `lod 2` inside the view wedge (`lodOutside 0.6`), `minZoom 7`, `maxZoom 17`, radius 120 km (`terrain-stream.ts:165-173`); re-selects on wedge changes; also builds a 360 degree query set |
| Source | `loadDemTile` (Mapterhorn, 512 px tiles, `dem/sources.ts:92`), seeded by `terrain.bin` (14.3 MB gzip) | same `loadDemTile`; WebGPU path may GPU-decode into height-atlas layers (`gpuDecodeLoader`, `engine.ts:1383`, flag `gpu`) |
| Downsample | per tile to the mesh need: `while size > 2*seg && size > 256: downsample2` (`roll-terrain.ts:127`), seg 128 near / 96 far, so **every stored tile is at most 256 px** | `fitStreamTile` (`terrain-stream.ts:96`) with `segmentsFor`: seg 256 for focus tiles near the eye (keeps 512 px), 128 focus far, 128/64 outside the wedge |
| Tile id | `tileId(key)` | the same `tileId` |
| Output | `TileMesh` per tile with `grid` | the same `TileMesh` (`buildMesh` / `buildLiteMesh`) |

**Seed contents** (`roll-seed.ts:11-14, 160-200`): the DEM raster of every selected tile **after** the roll's downsample, lossless (1/128 m integers, planar predictor, zigzag varints), keyed by tile id. Quantisation is exact because Mapterhorn decode and the 2x box filter give multiples of 1/128.

**Verdict: feasible and worthwhile for the far and context tiles, not for the near field.**
- `StreamOptions.loadTile` (`terrain-stream.ts:66`) is the seam: `(key, seg, opts) => raster | null`, and the streamer already retries and gives up per tile. An adapter `seededStreamTile(seed, fallback)` returns `fitStreamTile(seeded, seg)` when the seeded raster is at least as large as `2 * seg` needs (it can only be downsampled, never upsampled), else calls `fallback` (`defaultStreamTile` or `gpuDecodeTileLoader`).
- Coverage mismatch: the seed has no z17 tile (roll `maxZoom 16`) and its z16 tiles are 256 px (half the Step need of 512 px at seg 256). Within roughly 1.5 tile sizes of the Step photo the stream still goes to the network. Context tiles (z8-z14, seg 64/128, need at most 256 px) and the many mid-field tiles hit the seed; only if the Step photo is one of the roll's viewpoints does the roll selection also refine around it.
- The streamer re-selects with the view wedge; tiles it asks for that are not in the seed simply fall through, so a stale or partial seed costs a download, as with the roll map's own fall back (`roll-terrain.ts:106`).
- GPU decode: the WebGPU engine's default loader decodes bitmaps straight into height-atlas layers; a seeded raster has CPU `heights` only. Either run the engine with the CPU loader for seeded tiles (`gpuDecodeLoader` returns undefined when `gpu` is off, and rasters with `heights` are accepted: `terrain-stream.ts:339-350`) or upload seeded heights into the layer (`terrain-gpu-decode.ts`); the first is a one-line adapter, the second is extra work and only worth it if the CPU upload shows up in profiles.
- Cache sharing: the seed's rasters live in `RollMapOptions.seed.terrain()` (decoded on demand; the big parts are not memoised, `roll-map-seed.ts` header). To share between the two embeds, memoise the decoded `Map<string, DemRaster>` in a module (`~16 M` samples, 64 MB as Float32) and release it with the live slot. Alternative: re-fetch (HTTP cache).
- Better option if the near field matters (it does for the Step demo): bake a **Step terrain seed** in `scripts/demo/bake-step.mjs` by recording the tiles `TerrainStreamer` actually loaded for the baked pose (full 512 px) and writing them with the existing `encodeTerrainSeed`; one codec, no roll coupling. Size is unmeasured; the roll seed (14.3 MB for the whole roll country) is the reference point, so measure before committing. Reusing the roll seed is a cheap partial first step and does not preclude this.
- Datum and frame: both rasters are Mapterhorn MSL heights (`dem/load.ts:122`); `buildMesh(frame, …)` takes each engine's own `EnuFrame` (roll centre vs photo), so nothing frame-dependent is stored in the seed. No conflict.

## 5. Phases, effort, risks

Effort in focused engineer-days (browser verification excluded, it runs in the batch pass per AGENTS.md).

| Phase | Work | Days |
|---|---|---|
| P0 spike | On the vendored deck 9.4 WebGPU: does `ScatterplotLayer`, `TextLayer`, `PathLayer`, `PolygonLayer` render (extras, pins)? Does a deck world view work with our colour-pass Effect (mix of our passes and deck layers in one frame)? Decide `PinCore` vs deck layer. Record in a short note. | 1 |
| P1 host | `RollMapEngine` takes a backend; `createRollDeckHost` (world view, colour pass only, layerFilter, pixelRatioCap, `requestRender` coalescing via `frame-coalescer.ts`); `resolveRenderer` wiring + fallback in `LiveRollMap.tsx` and `RollMap.tsx`; `data-renderer`. | 2 |
| P2 terrain + imagery | `BatchedTerrainCore` + `ImageryArray` from `set.tiles` / imagery bitmaps / basemap look (`basemapLook`, `elevRange`); WebGPU imagery path in `imageryFor` (no `cpuBitmaps`). | 1.5 |
| P3 drape | Wire `createMultiDrape`, `WebGpuDrapeAtlas`, `DrapeClear` texture, drape photos; atlas versions to `requestRender`. | 1.5 |
| P4 range maps | `webgpuGeometryFactory` for `rangeInto`/`rangeMapFor`; NEW range-hand-off graph (copy + 8x8 max-pool + readback ring) replacing `RangeGpu` on WebGPU; keep `RangeGpu` for WebGL2; seeded photos skip the render. A `range-hand-off.check.ts` proving byte equality with the CPU `rangeMapFrom` + `coarsen` result (the pattern of `geo-unpack.check.ts`). | 3 |
| P5 overlays | `GizmoCore` per photo, pins, pick via `WorldViewport.project`, extras gated per backend (ship with those the spike proved). | 2 + 1 per extras family that needs a port |
| P6 loss + fallback | Device-loss rebuild, loss cap, canvas re-mount on failed init, dispose order (atlas, clear texture, host) so the live slot can evict cleanly. | 1.5 |
| P7 Step terrain seed (optional) | `loadTile` adapter over the roll seed (0.5 day); or bake-step recording + `encodeTerrainSeed` (1.5 days). | 0.5-1.5 |
| P8 flip default | After the batch pass: the landing and `/roll` default to WebGPU through `auto`. | 0.5 |

Total about 12-14 days for the map itself, plus extras families (Text, Spot 3D splats) if they cannot ride the deck WebGPU layers.

**Risks.**
1. Deck 9.4 WebGPU may not render `TextLayer` / `PathLayer` / `PolygonLayer` (no WGSL for their shaders in the vendored tree; layer extensions have no WGSL hooks, README). Mitigation: P0 spike; extras stay on the WebGL path (or are ported to cores) otherwise.
2. A deck world view next to our own pass runner has the clear/depth traps already documented in the README (view `clear: true` breaks the pass; `LayersPass` hard-codes `clearDepth: 1`, so reversed-Z only applies to our cores, deck overlays must use `depthCompare: always`).
3. `float32-filterable` is required and the probe demands it; devices without it already fall back to WebGL, so behaviour matches the photo engine.
4. The drape's memory: the atlases (about 240 MB for 60 photos) plus the render targets; `maxTextureDimension2D >= 8192` is probed already; the 4096² atlas side stays valid.
5. Colour parity: the WGSL drape composites in linear light (documented in `multi-drape.ts` header: partial alpha mixes slightly brighter in the midtones). The landing's look is judged by eye, so this needs a visual pass (not a numeric gate).
6. Range-map precision: the max-pool, sky fix-up (`0 < r < +Inf`) and the cull coarse grid must be bit-identical, else the drape's tile candidate lists differ; the node check above guards it.
7. Compute-device adoption is a single global; two live devices during a scroll transition rely on "last adopter wins" (section 3).
8. WebGPU readback is async only (`mapAsync`); `rangeMapFor()` already awaits, but callers that assumed synchronous behaviour after `drawOnly` need review.

## 6. Gates (CI and browser)

Fast tier, per change (no browser; AGENTS.md policy):
- `npx tsc --noEmit -p .`, `npx biome check --write <files>`, `node scripts/ci/spdx.mjs`.
- Existing: `layer-multi-drape` (`scripts/ci/checks.mjs:767`), `layer-drape`, `gpu-raw-lint` (ratchet; the `range-gpu.ts` count must not rise, `scripts/ci/gpu-raw-lint.mjs:108`), `geo-unpack`, the layers' node checks.
- New rows (every `*.check.ts` needs a row, `scripts/ci/__tests__/checks.spec.ts`): `range-hand-off` (node WebGPU over Dawn, byte equality against the CPU path), a Vitest spec for the backend selection and fallback ladder in `RollMapEngine` (fake `createWebgpuDeck` rejecting), a spec for the seeded `loadTile` adapter (hit at `size >= 2*seg`, miss falls through, `fitStreamTile` downsample).

Full tier, batched per wave and under the render lock (`node scripts/gpu/with-render-lock.mjs -- …`):
- Browser check of `multi-drape.check.ts runMultiDrapeCheck()` against a real roll, `deck-smoke` / `deck-engine-smoke.mjs` (not directly applicable to the map, but run to prove the photo engine and the shared `createWebgpuDeck` did not regress), `style-baseline`, `settle-submits`.
- New browser check `roll-map-parity` (pin `--renderer webgpu` and `--renderer deck`, as every harness must): load the landing's sample roll with the baked seed, take a fixed set of world poses via `engine.world`, compare WebGL2 vs WebGPU frames with a tolerance (SSIM or mean absolute difference per tile; not bit-exact, per the maximalist rule) and assert `data-renderer`. Also assert pin pick returns the same photo ids for a fixed set of pointer positions, `rangeMapFor` agrees with the WebGL range (max abs difference in metres on a coarse grid), and a forced device loss (`simulateDeviceLoss` pattern from the engine) restores a frame.
- Landing: scroll the live embeds (roll map, then Step Inside) with `liveSlot` eviction; assert exactly one live WebGPU device at steady state and that compute adoption never points at a destroyed device.
- Land marked **browser-unverified** and list in `reports/batch-ledger.md` for the next batch, per policy.

## 7. Recommended order

P0 (spike) -> P1 + P2 -> P3 -> P4 -> P5 -> P6 -> flip default (P8) after a batch pass. P7 is independent and can land any time after P1 on either engine; start with the `loadTile` adapter over the existing roll seed (small, testable in node) and decide on the dedicated Step seed after measuring how many tiles still stream.
