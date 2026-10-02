# src/lib/deck-webgpu: the WebGPU renderer (deck.gl on WebGPU, luma.gl 10)

The default engine since 2026-10-01 (b520b1d; decision record `reports/webgpu-default.md`); the WebGL
deck backend (`src/lib/deck`) is the fallback. `engine.ts` (`WebGpuEngine`) implements the whole
`Renderer` interface (`src/lib/renderer.ts`) on host-agnostic WGSL layer cores. Vendored luma
`10.0.0-alpha.2-rigi.6` and deck `9.4.0-rigi.3` (`vendor/*/README.md`).

## Architecture

**deck.gl hosts the frame; our own pass runner draws the 3D passes.** Layers are `GpuLayerCore`s on
plain luma.gl 10 (`Model`, WGSL). Two hosts run the same cores:

| Host | File | Used by |
|---|---|---|
| deck | `hosts/deck.ts` (+ `device.ts createWebgpuDeck`) | `WebGpuEngine` in the app; deck keeps device, canvas, views/viewports, controllers (map mode), animation loop, layer lifecycle |
| direct (no deck) | `hosts/direct.ts` | the roll map's WebGPU backend (`src/lib/roll/map/backend-webgpu.ts`, 0fbcab2a, browser-unverified) and the lab (`?host=direct`) |

- `hosts/passes.ts` runs the geometry and colour passes. On the deck host it is called from a deck
  Effect's `preRender` on the same command encoder, one submit, so we control clears, reversed-Z, MRT,
  MSAA resolve and pipeline state. deck's own canvas pass draws only the screen cores, through one thin
  `CoreLayer`.
- Only `hosts/deck.ts` and `device.ts` touch deck. Cores use `Model`, `ShaderModule`, `RenderPass` and
  build Models with `RIGI_WGSL_ASSEMBLER` (`pass.ts`), so deck's default-assembler state never reaches them.
- If the deck host fails to boot, PhotoWorkspace disposes the engine and runs the WebGL DeckEngine.

Why deck cannot run the passes itself (deck PR #10752 + vendored patches; re-checked on rigi.6, items below under **Upstream**):
`View clear: true` begins a pass inside the open one; `LayersPass` hard-codes `clearDepth: 1` (no
reversed-Z); `WEBGPU_DEFAULT_DRAW_PARAMETERS` are merged over the model's parameters (`blend: false`
cannot remove blend); no MSAA/resolve targets; no WGSL shader hooks for extensions (`LogDepthExtension`,
`TerrainExtension`; deck #10751 adds one vertex hook only). The app takes deck's full build (not
`visgl:webgl-only`, which strips every WebGPU branch).

## In the app (`src/lib/renderer-select.ts`, PhotoWorkspace)

| `?renderer=` | Engine |
|---|---|
| `auto` (default) | WebGpuEngine when the probe passes, else the WebGL DeckEngine |
| `webgpu` | the same, asked for explicitly (a fallback logs a console warning) |
| `deck` | the WebGL DeckEngine only |

- **Probe** (`probeWebGpu`, cached per page): `navigator.gpu`, a high-performance adapter with
  `float32-filterable` (= `device.ts REQUIRED_FEATURES`; keep equal), `maxTextureDimension2D` >= 8192,
  `maxColorAttachments` >= 2, `maxStorageBufferBindingSize` >= 128 MiB, and a device that is actually granted.
- `?webgpu=off`: auto/webgpu act as if `navigator.gpu` were missing (proves the fallback).
- **Init failure**: PhotoWorkspace awaits `engine.whenReady()`; on failure the engine is disposed, the canvas
  re-mounted (a canvas that held a WebGPU context cannot give WebGL2) and DeckEngine runs.
- **What ran**: workspace root `data-renderer` = `webgpu` | `deck`, `data-renderer-reason` (`pinned`,
  `auto: <adapter>`, `webgpu=off`, `fallback: <why>`); `__engine.backend === "webgpu"` tells the engines apart.
- **Compute**: both hosts call `src/lib/gpu/device.adoptRenderDevice` (`device.ts adoptForCompute`), so
  `getComputeDevice()` is the render device and look kernels bind the targets directly.
- **Harnesses** pin explicitly (`eval-app.mjs`, `deck-engine-smoke.mjs`, `leaderboard.mjs`,
  `geocam/eval-app-flags.mjs`: `--renderer webgpu|auto`, Chromium via `scripts/deck-webgpu/gpu-args.mjs`); a pinned
  webgpu that fell back fails the run. `scripts/deck-webgpu/app-load.mjs --renderer auto [--query webgpu=off]
  [--no-gpu] [ids…]` loads every GT photo and reports engine, adopted device and page errors.

### Flags (read only through `src/lib/flags`)

| Flag | Default | Effect here |
|---|---|---|
| `renderer`, `webgpu` | `auto`, `on` | above |
| `colorTarget` | `rgba16` | colour-pass format; `rg11b10` is downgraded to rgba16 (no destination alpha breaks the overlay and world sky), `rg11b10-unsafe` forces it |
| `gpu` | `on` | compute kill switch; `off` also keeps the CPU terrain cull and CPU Terrarium decode |
| `gpuFrameTimings` | `off` | per-pass GPU timings (below) |
| `deckDebug` | `off` | `Deck({debug: true})` on both engines |
| `renderBundles` | `off` | replay batched-terrain's GPU-culled draws from recorded render bundles (below) |
| `splatRenderer` | `luma` | Step Inside splats: `luma` = luma's splat stack; `rigi` = Rigi EWA shader + `gpu/splat-sort` |
| `tiles3d` | `off` | Step Inside 3D tiles (`layers/tiles3d.ts`, class-3 geometry write is off) |

Engine option `settleFusion` (default on) is not a URL flag.

## Targets (`targets.ts`), also the interface to the compute kernels

| Target | Format | Samples | Contents |
|---|---|---|---|
| `GeometryTargets.geometry` | `rgba32float` | 1 | xyz = ENU metres of the visible surface, w = range from the photo eye (m); cleared to 0 (w = 0 means sky) |
| `GeometryTargets.normal` | `rgba16float` | 1 | xyz = unit ENU normal, w = class (0 terrain, 1 trail, 2 object/splat, 3 tiles3d) |
| `GeometryTargets.depth` | `depth32float` | 1 | reversed-Z `near / viewDepth`, 0 = sky |
| `ColorTargets.colorMS` / `depthMS` | `rgba16float` / `depth32float` | 4 | transient, discarded after the resolve |
| `ColorTargets.color` | `rgba16float` | 1 | resolved colour, **linear**, **premultiplied** alpha (sky = 0,0,0,0) |

Geometry, normal and colour carry `STORAGE_BINDING | TEXTURE_BINDING | COPY_SRC` (kernels bind them directly).

- Geometry size is `geometrySize(aspect)`: 1024 px on the long side (matches `deck/geometry-pass.ts`), always the photo camera.
  The colour target is the canvas drawing buffer (DPR capped at 2; `setPixelRatioCap` for the live frame governor), view camera.
- Rows are **top-first** (WebGPU); the WebGL `GeometryTarget.read` is bottom-first.
- `rgba32float` binding needs `float32-filterable`; use `textureLoad` anyway.
- Kernels must not write a target that a later pass of the same frame reads: schedule after `runOffscreenPasses` or give them their own targets.
- **Interactive mode** (browser-unverified): `engine.noteInput` -> `host.setInteractive` -> `ColorTargets.setReduced`:
  during a drag the colour pass draws 1x straight into `color` (no resolve), the geometry readback waits, and
  `inputIdle` restores 4x with one "all" frame. Pipelines bake the sample count, so `pass.ts ModelCache` keeps one
  Model per (key, sample variant) (`setColorSamples(1)` while recording); `engine.scheduleWarm` builds them on idle.
  Exports and `renderOffscreen` use fresh 4x targets.

## Geometry queries (`geo-query-gpu.ts`, `geo-unpack.ts`, `silhouette-gpu.ts`)

The 1024 px query target is not read back in full on every settle. After the geometry pass, compute graphs
(core `cachedGraph` group `geo-query`, persistent pool slots, `ComputeGraph.runNow`) produce peak-label occlusion
verdicts (4 B/peak), skyline rows (4 B/column) and on-demand gathered texels (`sampleAtAsync`, 16 B/pixel).
Verdicts and skyline share one graph run. Results equal the CPU tests exactly (argument in `deck/geo-query.ts`;
`npx tsx scripts/gpu/geo-query-check.ts`). CPU planes are read lazily and unpacked on the GPU
(`geo-unpack` kernel; denormal/NaN texel words flag a permanent fallback to the full read): `ensureRange()` reads
the range plane only (4 B/px; look grid, stats, haze fit), `ensureFull()` also xyz (12 B/px; `readback()`,
`sampleAt` misses, Step Inside masks). Any failing kernel restores the full readback. `settle()` waits for the GPU
queries only. Silhouette re-rank masks are one graph per call (group `silhouette-mask`); their 384 px sources are
released 2 s after the last `autoAlign`/`silhouetteScore` (`SIL_IDLE_MS`). CI: `geo-unpack`.

**Settle fusion** (`settleFusion`, default on): the refined-masks pass is recorded on its own encoder during the
query geometry render and submitted with it (`gpu/core/queue.ts submitWithDefault`); `LookBridge.updateMasks`
adopts the result when its inputs still match (render, photo, masks, no blend cut). Band stats share their
256 px layer render's submit. Outputs byte-identical; only query sources wider than 512 px get the hook.
Checks: `compute-bridge-fusion`, `compute-bridge`; browser `scripts/deck-webgpu/settle-submits.mjs` (full `settle-submits`).

## Depth (`depth.ts`)

Reversed infinite-far Z, `depth32float`: clip.z = near, clip.w = view depth; clear to **0**, compare
**`greater-equal`** (replaces the GLSL `LogDepthExtension`). Use `REVERSED_Z.parameters` (opaque), `.testOnly`
(overlays), `.none` (full-screen passes inside a depth pass). A fragment that must write depth (splats,
impostors) writes `@builtin(frag_depth) = camera_depth_from_view_depth(z)` (disables early-Z). Sky trick: a
full-screen pass at clip.z = 0 with `greater-equal` draws only where nothing else did.

## Camera (`camera.ts`) and shared WGSL (`wgsl.ts`)

- `cameraModule` (`camera`, group 0): camera-**relative** reversed-Z `viewProj`, `eye`, `near`, `right/up/forward`,
  `tanHalfX/Y`, `aspect`, `viewport`, `offset`; helpers `camera_clip`, `camera_range`, `camera_view_depth`,
  `camera_ray`, `camera_depth_from_view_depth`. `photoCameraModule` (`photoCam`) is the same for the photo camera
  at geometry-target size (`photo_clip`, `photo_uv` v-down, `photo_range`); drape, occlusion, gizmo use it.
- CPU: `photoCamera`, `worldCamera`, `cameraUniforms`, `projectToPixel` (CPU twin, <= 0.05 px vs GPU), `sphereInView`.
- `wgsl.ts`: `colorWGSL` (`srgb_decode`, classic `srgb_encode` pow 0.41666, `srgb_encode_exact`, `to_linear` = the classic pow 2.2 ramp decode, `luminance`), `noiseWGSL` (`ign`, `hash12`, `gauss`), `enuWGSL`, `rampWGSL`, `fullscreenWGSL`, `fogModule`
  (`fog_apply`, `fog_shade`; fill with `fogFromLook(deckTerrainStyle(...))`). LOOK_ATMOSPHERE is not `fog_apply`: it is
  a terrain plugin (`layers/atm-sky.ts atmosphereFogPart`, `terrain-styles.ts finish`) that runs last and sets `TERRAIN_NO_FOG`.
- `textures.ts` (`imageTexture` rgba8unorm-srgb + mips, `maskTexture`, `floatTexture`, `placeholderTextures`);
  `readback.ts` (`TextureReader`, `readTextureBytes`, `readGeometry`, 256-byte rows, top-first).

## Atlases and terrain residency

- `texture-array-atlas.ts` `TextureArrayAtlas`: growable 2D array with a layer free list under `ImageryArray` and
  the batched terrain's r32float height arrays. Layers are written via `gpu/ingest` (`uploadRaster`/`uploadBitmap`
  with `into`); a grow re-creates the texture and copies every mip on a ComputeGraph copy node (`atlas-resize|<id>`);
  `compact()` / `compactLeased()` shrink on idle (4 s). Pure layout math: `atlas-layout.ts` (checks `atlas-layout`;
  frame gate `scripts/deck-webgpu/atlas-frames-check.mjs`).
- `imagery.ts` `ImageryArray`: two rgba8unorm-srgb arrays with per-layer mips, 256 px sources kept in a 256² array,
  larger resized to 512² (tier encoded by `atlas-layout.ts encodeImageryLayer`; `terrain_sample` samples both in
  uniform control flow). Created on first tile (until then a 1x1 empty array). Capacity grows to
  `maxTextureArrayLayers`; past it `planImageryOverflow` keeps the nearest tiles (`stats.evictions`, `stats.overflow`).
  A look without imagery releases layers after 10 s; `renderPoseView` holds them 120 s (`IMAGERY_POSE_VIEW_HOLD_MS`,
  `stats.holdDeferrals`; check `imagery-release`). Old textures from a compaction are destroyed 2 s later, so
  `?renderBundles=on` re-records and gather plans re-plan.
- `base-slots.ts`: the batched terrain's base-grid storage is packed (one 2·(G+1)² vec4 slot per tile at an
  offset in the table row, `t2.w`); 47 -> ~17 MiB in the photo view (check `base-slots`).
- `scripts/gpu/vram-attribution.mjs` lists live textures/buffers by label and creating call site (dev only).

## Compute interop (`src/lib/gpu`)

- **GPU cull + indirect draws** (`layers/terrain-cull.ts`, on by default on WebGPU; `?gpu=off` and WebGL keep the CPU
  cull): a conservative f32 twin of `sphereInView` flags tiles per mesh resolution, luma `GPUCompaction` compacts the
  visible rows into the slot's instance buffer and writes the count into the slot's indirect record;
  `BatchedTerrainCore.draw` uses `Model.setIndirectBuffer` in seg order. Recorded by the optional
  `GpuLayerCore.prepass(ctx)`, which `hosts/passes.ts` calls on the pass's encoder before the render pass. Checks:
  `terrain-cull`, `terrain-cull-dawn` (`scripts/gpu/terrain-cull-dawn.ts`, node + Dawn: lists equal the CPU twin; 13-17
  compute passes, ~0.4-0.9 ms vs ~0.15-0.3 ms encode+submit at 400 tiles, noisy machine), browser
  `scripts/deck-webgpu/terrain-indirect-check.mjs`.
- **Render bundles** (`render-bundle.ts`, `?renderBundles=on`, default off): batched terrain's culled draws replay from
  recorded bundles (separate MSAA and 1x variants). Pixels identical (`scripts/gpu/render-bundle-dawn.ts`, check
  `render-bundle-dawn`); opt-in until a batch pass measures a CPU gain (`research_notes/wave5/render-bundles.md`).
  Re-records on any bound-resource, pipeline, target or atlas change (keys compared by identity).
- **Terrain LOD on GPU** (`GPUVirtualGeometrySelection`): not built. The streamer already emits a non-overlapping
  leaf cover, so a GPU selection would equal the frustum cull.
- **GPU Terrarium decode** (`terrain-gpu-decode.ts`, default on when `gpuEnabled()`; WebGL and `?gpu=off` use the CPU
  decode): 256/512 px stand-alone tiles decode from the `ImageBitmap` straight into a height-atlas layer the tile
  leases (`TextureArrayAtlas.writeTerrariumLeased`, `AtlasLease`/`TileLayerRef`, ref-counted; the streamer's spare
  meshes keep up to 48 leases) and only 32 B of statistics return; any out-of-range sample keeps the CPU path. CPU
  heights exist only when a consumer calls `getCpuHeights(tile)` (`dem/cpu-heights.ts`). Gates: `ingest.check.ts`,
  `scripts/gpu/terrarium-ingest-check.mjs`, `atlas-frames-check.mjs`. Counters `globalThis.__rigiTerrainGpuDecode`.
  Measured before the leased-decode change (2026-10-01, Apple/Metal, IMG_7086/6958/7018): atlas 353-416 MB at ready on vs 95-110 off.
  Not re-measured since.
- **GPU height gathers** (`height-gather.ts` `HeightGather.heightsAt`): answers `TerrainSet.heightAt` bit for bit
  (NaN = null) without materialising lazy tiles; plan/blend stay on the CPU in f64, the kernel copies the four corner
  texels (group `height-gather`). Wired for camera DEM height, `buildTrails`, peak snapping (`snapPeaksNear`) and the
  lake floor; `snapOne` and Step Inside ground keep `heightAt`. Gates: `height-gather`,
  `scripts/deck-webgpu/height-gathers-probe.mjs`; counters `__rigiHeightGathers`. Measured 2026-10-01: main-thread
  tile materialisations within 8 s of ready 206/165/177 -> 0, parity bit for bit.
- Splat order: with `splatRenderer=rigi`, `SplatsCore`'s order buffer comes from `gpu/splat-sort` (GPU default,
  worker fallback after two bad sorts, a throw or device loss).
- Hook waiting for compute: `RIDGES_WGSL` (binding-free edge mask).

## Layer contract (`pass.ts`)

```ts
interface GpuLayerCore {
  id: string;
  passes: readonly ("geometry" | "color" | "screen")[];
  order?: number;                 // within a pass, low first
  screenParameters?: RenderPipelineParameters;
  prepass?(ctx): void;            // compute on the pass's encoder before the render pass
  draw(ctx: PassContext): void;   // never begin/end passes or submit
  visible?(): boolean;
  destroy(): void;
}
```

1. **One file per layer** in `layers/<name>.ts`: a class implementing `GpuLayerCore` plus plain setters. No imports
   between `layers/*` files unless a port names the dependency.
2. **Pipelines per pass.** Models come from `ModelCache` with `passModelProps(kind, {depth, blend})` (geometry/colour)
   or `screenModelProps(ctx.target)` keyed by `targetKey(ctx)`. Spread them whole: they carry `shaderAssembler:
   RIGI_WGSL_ASSEMBLER` (otherwise luma's shared assembler and deck's modules leak in). Indexed draws: set an explicit
   `indexCount` (luma #3291). Uniform writes land before the submit, so **never draw one Model with different uniforms
   twice in a frame**: one model per pass kind; per-draw data in vertex attributes or storage buffers.
3. **Uniforms** in a luma `ShaderModule`: `source` (WGSL struct + `@group(0) @binding(auto) var<uniform> <name>`),
   `uniformTypes` in the same order, `bindingLayout: [{name, group: 0}]`; keep `@binding(auto)`. Set with
   `model.shaderInputs.setProps({camera: ctx.camera, <name>: {...}})`. Pad structs to 16 bytes with `padN` fields.
4. **Textures**: `@group(0) @binding(auto) var t: texture_2d<f32>;` + sampler, bind with `model.setBindings({t})`.
   Sample in **uniform control flow** (before any branch/`discard`) or use `textureSampleLevel/Grad`.
5. **Geometry pass** outputs `struct { @location(0) xyzr: vec4<f32>, @location(1) normal: vec4<f32> }`, opaque with
   `REVERSED_Z.parameters`. Draw only what the photo camera should "see" for queries, align and drape.
6. **Colour pass** outputs `@location(0) vec4<f32>`: linear, **premultiplied** (averaging straight alpha in the MSAA
   resolve fringes sky edges; it also means splats and trails need no merge pass). Overlays use
   `passModelProps("color", {depth: "test", blend: true})` (one, one-minus-src-alpha). Call `fog_apply` on lit
   surfaces. The compositor does `photo·(1 − a) + rgb`.
7. **Screen pass** runs on the canvas (bgra8unorm; no depth in the direct host, deck's canvas has depth24plus), encodes
   sRGB itself, reads `ctx.color` and `ctx.geometry`.
8. **No depth parameters on depth-less targets** (luma adds a depth-stencil state as soon as any is set).
9. **Terrain shading parts**: `terrain.setShaderParts(shading, plugins)` with `TerrainShaderPart`s. Shading defines
   `fn terrain_base(s: TerrainSample) -> vec4<f32>` and `defines.TERRAIN_SHADING`; a plugin defines
   `fn <apply>(c, s) -> vec4<f32>`. `TerrainSample` carries everything needing uniform control flow (imagery samples,
   `dElev`, `dEnuDx/Dy`). Example: `lab.ts footprintPlugin`.
10. **Never create a mipmapped texture inside `draw()`**: luma's `generateMipmapsWebGPU` encodes its own passes and
    submits, invalidating the open pass. Upload in a setter, or draw one frame with `mips: false` and swap after
    (`layers/tiles3d.ts flushMips`). Same for anything else that submits (`Texture.readBuffer`, the geometry source's `render()`).
11. **Per-draw uniforms on a shared Model**: keep camera/frame values in ShaderModules and put the per-draw block in a
    small uniform `Buffer` per object bound before each draw (`layers/tiles3d.ts`); rewrite only on change. Instanced
    data goes in storage or instance buffers.
12. **Frame view**: `ctx.frame.view` is `"world"` in colour/screen passes when the colour camera is the orbit camera
    (`host.frameView`); the geometry pass always sees `"photo"`.
13. **Texture sample types**: luma reflects `texture_2d<f32>` as `'float'`, so `r32float`/`rgba32float` bindings need
    `float32-filterable` (requested in `device.ts`). Devices without it need an `unfilterable-float` layout override (not implemented).

A port is done when its isolation check passes with no validation errors, its screenshots match `/photo/<id>?renderer=deck`
on the same photo and pose, and geometry-pass ports keep `checkGeometry().maxErrPx <= 0.1`.

## Layers (`layers/*.ts`; isolation checks in `layers/<name>.check.ts`)

| Layer | Replaces (WebGL) | Pass | Parity evidence |
|---|---|---|---|
| `terrain.ts` (shared WGSL, `TerrainLook`, `TerrainShaderPart`) | terrain-layer fs | geometry, colour | vertex stage supplied by the batched core |
| `batched-terrain.ts` | batched-terrain-layer | geometry, colour | 99.84-99.97 % identical px vs the retired per-tile core, reproj <= 0.053 px |
| `terrain-styles.ts` | terrain-layer fs, look GLSL | shading part | 22/22 programs; hillshade <= 0.18 %, imagery <= 0.08 % vs CPU port of the GLSL |
| `terrain-cull.ts`, `terrain-cull-math.ts` | CPU cull | prepass | see Compute interop |
| `drape.ts` | projectPhoto / truth | plugin | grazing acne 17.7 % -> 0 %; no pixel A/B of the world drape; `clearAir` inverts the photo haze on the sample (world view only, `look/clear-air.ts`); the WebGL engine uses the same 2x2 vote + slope slack + soft people cut (`deck/terrain-layer.ts` `drapeSeen`, shared `deck/drape-vote.ts`) |
| `trail.ts` | TrailLayer | colour | position/width/occlusion/premul checks; class-1 normal write undecided |
| `flow.ts` | `deck/flow-layer.ts` | colour | `style.world.wind` (default off). WebGPU: one-node `ComputeGraph` advects 16k particles in `prepass`; WebGL2 runs the CPU twin `look/flow/sim.ts FlowSim` (~1.6 ms per 16k) |
| `weather.ts` | `deck/weather-layer.ts` | colour | `style.world.weather` (default off). Positions from luma's shadertools `precipitation` WGSL; Rigi's world-anchored lattice and f64 drift go in through its uniforms (`lumaUniformsFor`, spec `look/weather/__tests__/luma-equivalence.spec.ts`); Dawn check `weather-dawn`; browser-unverified |
| `composite.ts` | PhotoCompositor | screen | <= 0.53/255 vs CPU copy of the GLSL, 20/20 cases |
| `ridges.ts` | composite ridges/skyline/ink | WGSL lib | 0 bad px, max err 1e-5; texel-edge ties shift 1 row |
| `atm-sky.ts` | AtmSkyLayer | colour | <= 1/255 vs the GLSL compiled on WebGL2 |
| `photo-sky.ts` | PhotoSkyLayer | colour | max err 0 vs CPU model |
| `gizmo.ts` | WorldGizmoLayer | colour | 10/10 checks; linear-light blending differs slightly |
| `splats.ts` + `splats-luma.ts` | DeckSplatLayer + SplatColorPass | colour (+ geometry class 2, off) | 0 px > 2/255 vs CPU model (rigi EWA path) |
| `tiles3d.ts` | Tiles3DDeckLayer | colour (+ geometry class 3, off) | 15/15 checks |
| `geometry-source.ts` | GpuGeometrySource | geometry, off-frame | exact vs frame pass; reproj 0.052 px |
| `multi-drape.ts` | roll MultiDrapeLayer | colour | median 1.2e-4 vs CPU copy; clear air + exposure via `setClearAir(DrapeClear.texture)` |
| `pins.ts`, `pins-pack.ts` | roll map `pins` ScatterplotLayer | colour, last | `PinCore` / `createPins`; stroked billboard sprites in CSS px × DPR; ignores depth (check `layer-pins`) |
| `glow.ts` | `deck/glow-layer.ts` | screen (order 50) | see below |
| `engine.ts` WebGpuEngine | DeckEngine | | ranges identical to WebGL (median/p90 diff 0), 14/14 labels |

(Parity rows measured 2026-09-30 on Apple Metal.)

**Splats.** Default `splatRenderer=luma` (30bb006a, browser-unverified): `nearfield/splat-lod.ts buildSplatLod` makes an
LoD tree, `@luma.gl/splats` (luma PR #3340) does progressive RAD selection (`SplatRADHierarchyManager`) and
`GPUPagedSplatRenderer.prepare(encoder)` runs projection, cull, one global GPU radix sort and the gather in the colour-pass
prepass; `splats-luma.ts` draws one indirect draw per ordered segment. Falls back automatically to the Rigi EWA path
when the luma stack fails to build or prepare, and the Rigi path is always used for the geometry-pass contribution.
The WebGL engine uses `nearfield/deck-splat-layer.ts`.

**Roll map on WebGPU** (`src/lib/roll/map/backend-webgpu.ts`, selected by `backend-select.ts` from the resolved renderer;
a start error or device loss falls back to WebGL once): a direct host draws `BatchedTerrainCore` + `ImageryArray` +
`TerrainStyles`, `MultiDrapeCore`, one `GizmoCore` per gizmo, `PinCore`, then presents to the canvas keeping alpha;
deck extras (terroir names, halos, prior fans) go through a deck on the same device (`webgpu-deck-overlay.ts`) and must
use `depthCompare: "always"`. Range maps: `range-webgpu.ts` (check `range-webgpu`). Browser-unverified.

**Glow markers** (`layers/glow.ts`): `style.labels.glow` (absent = off; `GLOW_DEFAULT` in `look/labels/glow.ts`) draws
additive sprites with luma's `pointGlow` module at the `engine.peakLabels` (u, v) handed over via
`engine.setGlowMarkers`. Display-only (no export, no world view). luma's `selectionOutline` was evaluated and not
adopted: peaks are points with no per-peak region mask.

## Per-pass GPU timings (`frame-timings.ts`, `?gpuFrameTimings=on`)

Opt-in, WebGPU only, needs `timestamp-query`. `hosts/passes.ts` and the direct host's screen pass spread
`passTimestamps(device, name)` into `beginRenderPass`; a frame leases one 64-slot query set from a ring of 4
(`frame-timings-core.ts`, check `frame-timings`). Results: `engine.onFrameTimings(cb)`, `engine.frameTimingsMean`, the
table on `/dev/graph`. All sets in flight, more than 32 passes or a readback error drops the frame. deck's own canvas pass
is not timed by this path. Not browser-verified.

## Matcher hooks (`loadFullTerrain`, `loadSatellite`, `renderPoseView`)

Optional `Renderer` members used by `src/lib/matcher` and the precision gate; `renderer.check.ts` asserts both engines have them.
- `loadFullTerrain()`: wedge becomes 360° (`fullWedge`), query terrain swaps to the full set, horizon re-traced (CPU);
  tiles beyond `maxTextureArrayLayers` are dropped (`metrics().terrain.overflow`).
- `loadSatellite(maxDistM, retries)`: fetches the render set's satellite tiles in range.
- `renderPoseView(pose)`: geometry from a private `WebGpuGeometrySource`, colour from `renderOffscreen({pose, cores: [terrain]})`
  converted by `poseViewRgba` (sky #b9cde0); near discard off, look replace + satellite.

Parity (`scripts/deck-webgpu/pose-view-parity.mjs`, 2026-10-01, IMG_7155/6958/7018, yaw -20/0/+20, Apple Metal): same
tiles, bit-identical 360° horizon, identical terrain/sky masks, |Δxyz| p95 0.005-0.020 m, RGB mean |Δ| 0.9-2.9/255,
autoAlign |Δyaw| 0. Matcher on both engines accepts HIGH on all three, fused poses within 0.018° yaw / 0.005° pitch /
0.012° vfov. VRAM with the matcher satellite drape: 978-1021 MiB (deck 726-783), ~1.33 MiB per 512² layer with mips.

## Measured (2026-09-30, `scripts/deck-webgpu/bench.mjs`, Chrome / Apple Metal, 1080×810, IMG_7086/6958/7018)

| Metric | WebGL | WebGPU |
|---|---|---|
| time to first terrain frame | 2.6-3.3 s | 2.4-2.5 s |
| pipelined frame (60 pose changes) | 5.4-7.2 ms | 5.9-6.8 ms |
| pan frame waited to completion | 8.8-10.5 ms | 12.5-14.7 ms (completion-latency floor) |
| world orbit (2.5 s drag) | 60 fps, one 33 ms frame on 2 of 3 | 60 fps, none > 16.8 ms |
| GPU memory, photo view / after world view | 175-188 / 675-688 MiB | 350-398 / 777-825 MiB |
| export diff overlay / replace (mean abs) | n/a | 0.78-0.95 / 0.27-0.39 of 255 |
| peak labels | n/a | identical sets |

Memory is the first thing to shrink (batched-terrain buffers, MSAA colour target, per-size geometry targets).

## Running

```bash
npm run dev                                # :3100
# every browser job through the render lock (batched passes only, see AGENTS.md):
node scripts/gpu/with-render-lock.mjs -- node scripts/deck-webgpu/engine-lab.mjs IMG_7086 [--host deck|direct]
node scripts/gpu/with-render-lock.mjs -- node scripts/deck-webgpu/bench.mjs --photos IMG_7086,IMG_6958,IMG_7018 --out <dir>
node scripts/gpu/with-render-lock.mjs -- node scripts/deck-webgpu/smoke.mjs IMG_7086 [--host deck|direct]   # foundation (?core=1)
```

- **Engine lab** `/lab/deck-webgpu?photo=IMG_7086` (`lab-engine.ts`): `&host=deck|direct &mode=overlay|replace|world
  &overlay=contours|bands|slope|none &map=satellite|topo|hillshade|bands &debug=geometry|normal|depth &yaw= &pitch=
  &roll= &vfov= &align=1 &trails=1 &labels=0 &size=<w>x<h>`. Harness: `window.__engine`, `window.__deckWebgpuLab`
  (`ready`, `stats()`, `frame()`, `setPose()`, `setView()`, `setSettings()`, `labels()`), `body[data-ready]`.
- **Foundation lab** `?core=1`: terrain + present only, hook `checkGeometry()`; `smoke.mjs` writes `out/deck-webgpu/smoke-<id>-<host>.{json,png}`.
- **Layer checks**: node parts `npx tsx src/lib/deck-webgpu/layers/<name>.check.ts`; in a page,
  `await (await import('/src/lib/deck-webgpu/layers/<name>.check.ts')).run…()`. `engine.check.ts runEngineCheck({photo, host, parity})`
  is the end-to-end check against the WebGL DeckEngine.
- Fast-tier ids touching this module: `terrain-cull`, `terrain-cull-dawn`, `height-gather`, `atlas-layout`, `geo-unpack`,
  `base-slots`, `frame-timings`, `imagery-release`, `render-bundle-dawn`, `layer-pins`, `range-webgpu`, `height-atlas-dawn`.

## Known gaps

- `WebGpuEngine.backend` is `'webgpu'`: tools that poke WebGL deck internals (`deckInstance.layerManager`, compositor) must check it.
- Step Inside map mode uses deck's MapController only on the deck host (`setExtraViews`); on the direct host `StepCamera` runs its own.
- Step Inside (splats, photo sky, 3D tiles) is not exercised end to end by the harness (no near-field scene/tiles config); per-layer checks cover them.
- Full-resolution export allocates a 4x MSAA rgba16float target at photo size (hundreds of MB at 12 MP); tile it via the camera offset.
- Colour space: WebGPU blends in linear light into rgba16float, WebGL blended sRGB bytes; translucent edges (gizmo, world splats, multi-drape feathers) differ slightly by design.
- `float32-filterable` is required; Chrome on Apple Metal is the only tested platform (Firefox/Safari untested).
- LOOK_HARMONIZE band stats in world mode render without the drape; exact parity unverified.
- Retiring the WebGL deck layers waits for Safari/Firefox WebGPU; see `reports/webgpu-default.md`.

## Upstream: luma.gl / deck.gl issues (each open one has a local workaround)

Last re-checked on `10.0.0-alpha.2-rigi.3`; not re-verified on rigi.6.

**deck.gl**: (1) view `clear: true` opens a pass inside the open one; (2) `LayersPass` hard-codes `clearDepth: 1` /
`less-equal` (no reversed-Z); (3) `WEBGPU_DEFAULT_DRAW_PARAMETERS` merge over model parameters; (4) no `sampleCount` /
resolve in `LayersPass`; (5) no WGSL shader hooks (deck #10751 adds one vertex hook); (6) the `visgl:webgl-only` build
silently strips WebGPU. Fixed only in luma's own deck patch (#3325), dormant for us: WebGPU Y-origin in `getGLViewport`,
pick-pass `scissorY`, `DeckPicker` readback flip, `depth24plus` on `deck-renderbuffer-0`, `project_get_orientation_matrix`
`select` order.

**luma.gl**: (7) `Model.draw()` does not forward `firstInstance`/`baseVertex` (one compact instance buffer per group);
(8) `generateMipmapsWebGPU` submits inside an open pass; (9) WGSL reflection maps `texture_2d<f32>` to `'float'`
(the `shaderLayout` `sampleType` override works, reflection still derives `'float'`); (10) uniform writes are
`queue.writeBuffer` (a Model drawn twice shows the last values; wants a dynamic-offset uniform ring); (11) the WGSL
preprocessor lacks `&&`/`||`/`==` (combined defines computed on the CPU, `compositeDefines()`); (12) uniform layout
validation checks names and order only; (13) `copyExternalImage` with an `HTMLImageElement` uses `.width` (prefer
`naturalWidth`); (14) a luma "read texture -> typed array, top-first" helper would replace per-app readers.
