# src/lib/deck-webgpu — the WebGPU renderer (deck.gl on WebGPU, luma.gl 10)

Experimental (2026-09-30). The deck backend (`src/lib/deck`, WebGL2) is being moved to WebGPU.
Every layer of the WebGL DeckEngine is ported (see **Status**), and `engine.ts` (`WebGpuEngine`)
implements the whole `Renderer` interface on them. It is wired into `PhotoWorkspace` behind
`?renderer=auto|webgpu` with an automatic WebGL fallback (see **In the app**); the lab route
(`/lab/deck-webgpu`) remains the bench / debug consumer.

## Approach (decided by `spike.ts`, `/lab/deck-webgpu?spike=1`)

**deck.gl (vendored from PR #10752) on a WebGPU device hosts the frame; our own pass runner
draws the 3D passes.**
Layers are host-agnostic `GpuLayerCore`s on plain luma.gl 10 (`Model`, WGSL). The same cores
also run under a luma-direct host with no deck at all (`hosts/direct.ts`). That host is the
fallback when deck's full build isn't bundled, and it is also the A/B reference.

What the spike showed with Chrome and Metal (first on deck 9.4.0 / luma 9.4.2; re-run on
luma 10.0.0-alpha.2 + the vendored deck PR #10752, `vendor/deck/README.md`, with the same results):

| Check | Result |
|---|---|
| `Deck({deviceProps: {type: 'webgpu'}})`, our `PhotoView` / `PhotoViewport`, an `OrthographicView`, `layerFilter` | works |
| custom WGSL layer through deck's `project32` (`COORDINATE_SYSTEM.CARTESIAN`) | works |
| custom WGSL layer on our own camera module (camera-relative, reversed-Z) | works when the layer's `props.parameters` carry the depth / blend state |
| `_LayersPass` into our rgba32float + depth32float target, readback | works only with the optional `float32-blendable` feature and a pass-through blend override |
| `_LayersPass` into a 4× MSAA rgba16float target + a separate resolve pass | works (`sampleCount` must be set on the model by hand) |
| View `clear: true` on WebGPU | **broken**: it begins a render pass inside the open one, so the command buffer is invalid |
| reversed-Z in deck's canvas pass | not possible: `LayersPass` hard-codes `clearDepth: 1` |
| `WEBGPU_DEFAULT_DRAW_PARAMETERS` | premultiplied blending + `less-equal` are merged **over** the model's parameters; `blend: false` cannot remove the blend state |
| layer extensions (`LogDepthExtension`, `TerrainExtension`) | no WGSL hooks (`SHADER_HOOKS_WGSL = []` in #10752; deck #10751 adds one vertex hook, no fs / depth hook) |
| deck's default WGSL modules (`geometry`) | registered on luma's shared default assembler, so they leaked into every Model built without an explicit `shaderAssembler`; our Models use `RIGI_WGSL_ASSEMBLER` (pass.ts) and assemble the same WGSL under both hosts |
| the app's vite config | resolves deck's `visgl:webgl-only` build, which has **all** WebGPU branches compiled out |

Hence:
- deck keeps what works: the device, canvas, views and viewports, controllers (map mode), the
  animation loop and the layer lifecycle.
- Our `hosts/passes.ts` runs the geometry and colour passes. It is called from a deck Effect's
  `preRender`, on the same command encoder, with one submit. So we control clears, reversed-Z,
  MRT, MSAA resolve and pipeline state.
- deck's canvas pass draws only the screen cores, through one thin `CoreLayer`.

We are on luma 10.0.0-alpha.2 with deck vendored from PR #10752. Moving to a published deck 10
should be mechanical: only `hosts/deck.ts` and `device.ts` touch deck. Cores use `Model`,
`ShaderModule` and `RenderPass` and nothing else, and build their Models with pass.ts's own
`WGSLShaderAssembler`, so deck's default-assembler state never reaches them.

**Deck's full build in the app.** `vite.config.ts` no longer takes deck's `visgl:webgl-only`
condition, so the deck host runs on every dev server and in production builds
(`RIGI_DECK_BUILD=webgl-only` restores the old resolution; WebGpuEngine then runs on the direct
host). `scripts/deck-webgpu/vite.webgpu.config.ts` is kept for :3111 and is now equivalent.

## In the app (src/lib/renderer-select.ts, PhotoWorkspace)

| `?renderer=` | Engine |
|---|---|
| `auto` (default) | WebGpuEngine when the probe passes, else the WebGL DeckEngine |
| `webgpu` | the same, asked for explicitly (a fallback logs a console warning) |
| `deck` | the WebGL DeckEngine only (the escape hatch) |
| `three` | retired (the three.js PhotoEngine was removed 2026-10-01): warns and runs `auto` |

- **Probe** (`probeWebGpu`, cached per page): `navigator.gpu`, a high-performance adapter with
  `float32-filterable` (= `device.ts REQUIRED_FEATURES`; keep them equal), `maxTextureDimension2D`
  ≥ 8192, `maxColorAttachments` ≥ 2, `maxStorageBufferBindingSize` ≥ 128 MiB, and a device that is
  actually granted (then destroyed).
- **`?webgpu=off`**: auto / webgpu behave as if `navigator.gpu` were missing. Use it to prove the
  WebGL fallback on a WebGPU machine.
- **Init failure**: PhotoWorkspace awaits `engine.whenReady()` before starting the engine. If the
  host fails to boot, the engine is disposed, the canvas is re-mounted (a canvas that held a WebGPU
  context cannot give a WebGL2 one) and DeckEngine runs on it.
- **What ran**: the workspace root carries `data-renderer` = `webgpu` | `deck` | `three` and
  `data-renderer-reason` (`pinned`, `auto: <adapter>`, `webgpu=off`, `fallback: <why>`).
  `__engine.backend === "webgpu"` tells WebGpuEngine apart from DeckEngine (both have kind `deck`).
- **Compute**: both hosts hand their device to `src/lib/gpu/device.adoptRenderDevice`, so
  `getComputeDevice()` is the render device. `app-load.mjs` checks this per photo.
- **Harnesses** pin explicitly: `eval-app.mjs`, `deck-engine-smoke.mjs`, `leaderboard.mjs`,
  `geocam/eval-app-flags.mjs` take `--renderer webgpu|auto` (and launch Chromium with
  `gpu-args.mjs`); a pinned webgpu that fell back fails the run.
  `node scripts/gpu/with-render-lock.mjs -- node scripts/deck-webgpu/app-load.mjs --renderer auto
  [--query webgpu=off] [--no-gpu] [ids…]` loads every GT photo and reports the engine, the adopted
  device and page errors.

## Targets (`targets.ts`) — also the interface to the compute kernels (src/lib/gpu)

| Target | Format | Samples | Usage | Contents |
|---|---|---|---|---|
| `GeometryTargets.geometry` | `rgba32float` | 1 | RENDER, TEXTURE_BINDING, STORAGE_BINDING, COPY_SRC | xyz = ENU metres of the visible surface, w = range from the photo eye (m); cleared to 0 (w = 0 means sky) |
| `GeometryTargets.normal` | `rgba16float` | 1 | same | xyz = unit ENU normal, w = class (0 terrain, 1 trail, 2 object/splat, 3 tiles3d) |
| `GeometryTargets.depth` | `depth32float` | 1 | RENDER, TEXTURE_BINDING, COPY_SRC | reversed-Z: `near / viewDepth`, 0 = sky |
| `ColorTargets.colorMS` | `rgba16float` | 4 | RENDER | transient; discarded after the resolve |
| `ColorTargets.depthMS` | `depth32float` | 4 | RENDER | transient |
| `ColorTargets.color` | `rgba16float` | 1 | RENDER, TEXTURE_BINDING, STORAGE_BINDING, COPY_SRC | resolved colour, **linear** light, **premultiplied** alpha (sky = 0,0,0,0) |

- The geometry target is `geometrySize(aspect)`: 1024 px on the long side, which matches
  `deck/geometry-pass.ts`. It always uses the photo camera.
- The colour target is the canvas drawing buffer, with DPR capped at 2. It uses the view camera
  (photo, or the world orbit camera).
- Rows are **top-first**: row 0 is the top of the image (WebGPU). The WebGL `GeometryTarget.read`
  is bottom-first.
- rgba32float is not filterable unless the device has `float32-filterable`. Use `textureLoad`.


**Geometry diet (`geo-query-gpu.ts`, `deck/geo-query.ts`).** The 1024 px query target is no longer read back in full (~12 MB) on every settle. After the geometry pass the engine runs compute passes over `GeometryTargets.geometry`: peak-label occlusion verdicts (4 B per peak), the skyline rows (4 B per column) and, on demand, gathered texels (16 B per pixel, `sampleAtAsync`, hover). Undecided samples (denormal texels, never produced in practice) are resolved on the CPU from gathered texels, so the results equal the CPU tests exactly (argument in `deck/geo-query.ts`; `npx tsx scripts/gpu/geo-query-check.ts`). The full copy (`range`, `xyz`) is read lazily by `WebGpuGeometrySource.ensureFull()` for the consumers that sample many pixels (`readback()`, `sampleAt` misses, CPU look fallbacks, a fitted haze, Step Inside masks). `settle()` waits for the GPU queries only. `geometryDiet: false`, or any failing kernel, restores the full readback per render.

## Depth (`depth.ts`)

Reversed infinite-far Z with `depth32float`: clip.z = near, clip.w = view depth. Clear to **0**
and compare with **`greater-equal`**. This replaces the GLSL `LogDepthExtension` /
`gl_FragDepth = log2(w)·FC` trick. Use `REVERSED_Z.parameters` (opaque), `.testOnly` (overlays)
and `.none` (full-screen passes inside a depth pass).

If a fragment must write depth (splats, impostors), write
`@builtin(frag_depth) = camera_depth_from_view_depth(z)`. This disables early-Z, so use it sparingly.

Sky trick: a full-screen pass at clip.z = 0 with `greater-equal` and depth attached draws **only**
where nothing else did.

## Camera (`camera.ts`)

- `cameraModule` (`camera`, bind group 0): `viewProj` (camera-**relative**, reversed-Z), `eye`,
  `near`, `right` / `up` / `forward`, `tanHalfX/Y`, `aspect`, `viewport`, `offset` (principal
  point in NDC).
- WGSL helpers: `camera_clip(enu)`, `camera_range`, `camera_view_depth`, `camera_ray(ndc)`,
  `camera_depth_from_view_depth`.
- `photoCameraModule` (`photoCam`) is the same block again for the photo camera, sized to the
  geometry target: `photo_clip`, `photo_uv(enu)` (v down, z = w), `photo_range`. Drape,
  occlusion and gizmo use it.
- CPU side:
  - `photoCamera({pose, eye, …})` and `worldCamera(WorldViewState)` build a `CameraState`.
  - `cameraUniforms(state)` gives the uniform values.
  - `projectToPixel(u, enu)` is the CPU twin of the shader (tested: ≤ 0.05 px against the GPU).
  - `sphereInView` is the frustum cull.

## Shared WGSL (`wgsl.ts`)

- `colorWGSL`: `srgb_decode`, `srgb_encode`, `to_linear`, `luminance`.
- `enuWGSL`: helpers for bearing and elevation angle.
- `rampWGSL`: `ramp_eval`, the style ramps in `rampU` layout.
- `fullscreenWGSL`: `fullscreenVertex` → `FullscreenOut {uv (v down), ndc}`.
- `fogModule` (`fog`): `fog_apply(linear, range)` and `fog_shade(normal)`. Fill it with
  `fogFromLook(deckTerrainStyle(...))`. LOOK_ATMOSPHERE does NOT swap `fog_apply` (it needs the
  world position): it is a terrain plugin (`layers/atm-sky.ts atmosphereFogPart` /
  `terrain-styles.ts` `finish`) that runs last and sets `TERRAIN_NO_FOG`.
- `textures.ts`:
  - `imageTexture` (rgba8unorm-srgb + mips: the photo)
  - `maskTexture` (r8unorm)
  - `floatTexture` (r32float)
  - `placeholderTextures`
- `readback.ts`: `TextureReader` (staging buffer, 256-byte row alignment, top-first rows) and
  `readGeometry`.
- `imagery.ts`: `ImageryArray` is the imagery as one rgba8unorm-srgb 2D array, with 512² layers
  and per-layer mips. Capacity grows up to `maxTextureArrayLayers` (`featureLevel: 'max'`).

## Layer contract (`pass.ts`)

```ts
interface GpuLayerCore {
  id: string;
  passes: readonly ("geometry" | "color" | "screen")[];
  order?: number;                 // within a pass, low first (opaque before transparent)
  screenParameters?: RenderPipelineParameters;
  draw(ctx: PassContext): void;   // never begin/end passes or submit
  visible?(): boolean;
  destroy(): void;
}
```

1. **One file per layer** in `layers/<name>.ts`. Export a class implementing `GpuLayerCore`, plus
   plain setters for its data (`setSegments(...)`, `setCloud(...)`, …). Do not import from other
   `layers/*` files, except where a port entry names the dependency. Shared needs go into the
   foundation: ask the foundation owner.
2. **Pipelines per pass.** Create models through `ModelCache` with
   `passModelProps(kind, {depth, blend})` for geometry / colour. For screen, use
   `screenModelProps(ctx.target)` keyed by `targetKey(ctx)`. Both carry `shaderAssembler:
   RIGI_WGSL_ASSEMBLER`; spread them whole (a Model built without it gets luma's shared default
   assembler and, under the deck host, deck's default modules). Indexed draws: set an explicit
   `indexCount` (luma #3291: an indexed draw uses `indexCount`, else a `vertexCount` that was
   ever set, else the whole index buffer, so a stale `vertexCount` silently becomes the index
   count). WebGPU uniform writes land before
   the submit, so **never draw one Model with different uniforms twice in a frame**. Use one
   model per pass kind. Per-draw data goes in vertex attributes or storage buffers, not in a
   shared UBO (see `terrain.ts`: the imagery layer is baked per vertex).
3. **Uniforms** go in a luma `ShaderModule` with `source` (WGSL struct +
   `@group(0) @binding(auto) var<uniform> <name>`), `uniformTypes` in the **same order**, and
   `bindingLayout: [{name, group: 0}]`. Keep `@binding(auto)`: since luma #3304 a module may pin a
   group-0 slot ≥ 100 (< 100 stays the application's), but auto is what every core here relies
   on and what the assembler's binding registry keeps stable. Set them with
   `model.shaderInputs.setProps({camera: ctx.camera,
   <name>: {...}})`. Pad structs to 16 bytes with named `padN` fields.
4. **Textures**: declare them with `@group(0) @binding(auto) var t: texture_2d<f32>;` +
   `var tSampler: sampler;` and bind with `model.setBindings({t: texture})` (the sampler comes
   from the texture). Sample in **uniform control flow** (WGSL rule): before any branch or
   `discard`, or with `textureSampleLevel/Grad`.
5. **Geometry pass** outputs are
   `struct { @location(0) xyzr: vec4<f32>, @location(1) normal: vec4<f32> }` (see Targets), opaque
   with `REVERSED_Z.parameters`. Draw here only what the photo camera should "see" for
   queries / align / drape.
6. **Colour pass** output is `@location(0) vec4<f32>`: linear, **premultiplied** (rgb·a, a), 4×
   MSAA. Premultiplied because the MSAA resolve averages samples, and averaging straight alpha
   fringes at sky edges. It also means splats and trails need no merge pass: that was the WebGL
   path's straight-alpha `SplatColorPass`. Use
   `passModelProps("color", {depth: "test", blend: true})` for overlays (one,
   one-minus-src-alpha). Call `fog_apply` on lit surfaces. The compositor does
   `photo·(1 − a) + rgb`.
7. **Screen pass** runs on the canvas (bgra8unorm, no depth in the direct host; deck's canvas has
   depth24plus) and encodes sRGB itself. It reads `ctx.color` and `ctx.geometry`.
8. **No depth parameters on depth-less targets.** luma adds a depth-stencil state as soon as any
   depth parameter is set.
9. **Terrain shading parts.** Styles, drape and truth plug into `TerrainCore` without editing it:
   `terrain.setShaderParts(shading, plugins)` with `TerrainShaderPart`s. The shading defines
   `fn terrain_base(s: TerrainSample) -> vec4<f32>` and sets `defines.TERRAIN_SHADING`. A plugin
   defines `fn <apply>(c: vec4<f32>, s: TerrainSample) -> vec4<f32>`. `TerrainSample` carries
   everything that needs uniform control flow: imagery samples and the derivatives `dElev`,
   `dEnuDx/Dy`. See `lab.ts footprintPlugin` for a working drape-style plugin (photoCam + an
   occlusion test against the geometry target).
10. **Test in the lab**: add a query switch to `lab.ts` / the route (append-only; keep others'
    switches). Run the smoke (below). A port is done when:
    - the smoke passes with `errors: []`;
    - its screenshots match the WebGL deck renderer on the same photo and pose
      (`/photo/<id>?renderer=deck`);
    - geometry-pass ports keep `checkGeometry().maxErrPx ≤ 0.1`.
11. **Never create a mipmapped texture inside `draw()`.** luma 9.4.2's `generateMipmapsWebGPU`
    encodes its own render passes and submits, which invalidates the open pass ("CommandEncoder
    locked while RenderPassEncoder … is open" / "Parent encoder already finished"). Upload in a
    setter (pass the device to the factory: composite, gizmo), or draw one frame with
    `mips: false` and swap the mipmapped texture in after the frame (`layers/tiles3d.ts
    flushMips`). The same applies to anything else that submits (`Texture.readBuffer`, the
    geometry source's `render()`): never from inside a pass callback.
12. **Per-draw uniforms on a shared Model** (many tiles, one pipeline): keep camera / frame values
    in ShaderModules (uploaded once per pass) and put the per-draw block in its own small uniform
    `Buffer` per object, bound with `model.setBindings({tileData: buf})` before each draw
    (`layers/tiles3d.ts`). It costs one bind group per draw; rewrite the buffer only on change.
    Instanced data (terrain rows, splats, trails) goes in storage or instance buffers instead.
13. **Frame view.** `ctx.frame.view` is `"world"` in the colour and screen passes when the host's
    colour camera is the orbit camera (`host.frameView`, set by the engine). The geometry pass
    always sees `"photo"` (hosts/passes.ts forces it). World-only cores may also keep their own
    `view` prop (gizmo) — both agree under the engine.
14. **Texture sample types.** luma 9.4 reflects `texture_2d<f32>` as sampleType `'float'`, so
    binding an `r32float` / `rgba32float` texture (geometry target, batched heights, range atlas)
    needs the device feature `float32-filterable` (requested in `device.ts`; Apple has it). Use
    `textureLoad` on them anyway. Devices without it need an `unfilterable-float` layout
    override (not implemented; see **Upstream**).

## Running

```bash
df -h .                                    # disk first
npx vite dev --config scripts/deck-webgpu/vite.webgpu.config.ts --port 3111   # deck full build
# every browser job through the render lock, one at a time:
node scripts/gpu/with-render-lock.mjs -- node scripts/deck-webgpu/engine-lab.mjs IMG_7086 [--host deck|direct]
node scripts/gpu/with-render-lock.mjs -- node scripts/deck-webgpu/bench.mjs --photos IMG_7086,IMG_6958,IMG_7018 --out <dir>
node scripts/gpu/with-render-lock.mjs -- node scripts/deck-webgpu/smoke.mjs IMG_7086 [--host deck|direct]   # foundation (?core=1)
node scripts/gpu/with-render-lock.mjs -- node scripts/deck-webgpu/spike.mjs
```

- **Engine lab (default)**: `/lab/deck-webgpu?photo=IMG_7086` — `WebGpuEngine` with every layer
  (`lab-engine.ts`). Query: `&host=deck|direct &mode=overlay|replace|world
  &overlay=contours|bands|slope|none &map=satellite|topo|hillshade|bands &terrain=batched|tiles
  &debug=geometry|normal|depth &yaw= &pitch= &roll= &vfov= &align=1 &trails=1 &labels=0
  &size=<w>x<h>`. Toolbar: view mode (overlay / replace / world orbit), overlay / map style,
  debug view, fly-to-photo, DOM peak labels. Harness: `window.__engine` (the Renderer, as the
  app's DEV handle), `window.__deckWebgpuLab` (`ready`, `stats()`, `frame()`, `setPose()`,
  `setView()`, `setSettings()`, `labels()`), `body[data-ready]`.
- **Foundation lab** `?core=1`: terrain + present only
  (`&view=color|geometry|normal|depth&imagery=…&plugin=footprint`), hook `checkGeometry()`.
  `smoke.mjs` uses it (writes `out/deck-webgpu/smoke-<id>-<host>.{json,png}`).
- **Per-layer isolation checks** (`layers/*.check.ts`): from any page on the dev server,
  `await (await import('/src/lib/deck-webgpu/layers/<name>.check.ts')).run…()`; the node-only
  parts run with `npx tsx src/lib/deck-webgpu/layers/<name>.check.ts`. `engine.check.ts
  runEngineCheck({photo, host, parity})` is the end-to-end check against the WebGL DeckEngine.
- On :3100 / :3110 (app vite config, deck `visgl:webgl-only`) everything falls back to the
  direct host automatically.

## Compute interop (mt-image-03, src/lib/gpu)

- `device.ts adoptForCompute(device)` is the only coupling point. It calls
  `src/lib/gpu/device.adoptRenderDevice(device)` for both hosts, so look kernels run on the render
  device and bind the targets above directly: `STORAGE_BINDING` is set on geometry, normal and
  colour.
- `SplatsCore`'s order buffer is written by the GPU radix sort with `sortBackend: "gpu"`
  (`src/lib/gpu/splat-sort`, the worker stays the default and fallback).
- Hooks waiting for compute: `BatchedTerrainCore.cull(ctx, tiles)` (GPU cull + indirect draws),
  `RIDGES_WGSL` (binding-free, runs in
  `@compute` as-is: an edge-mask pass).
- Kernels must not write a target that a later pass of the same frame reads. Schedule them after
  `runOffscreenPasses` (colour pass done), or give them their own targets.

## Status (2026-09-30)

Every row has an isolation check (`layers/<name>.check.ts`, real WebGPU on Apple Metal, no
validation errors) and is composed by `engine.ts`. "Parity" is the evidence against the WebGL
path; "in-app A/B" means compared inside the running engine against `/photo/<id>?renderer=deck`.

| Layer (file) | Replaces (WebGL) | Passes | Parity evidence | In-app A/B | Open |
|---|---|---|---|---|---|
| foundation (`device`, `camera`, `depth`, `targets`, `pass`, `hosts/*`) | `deck/engine.ts` pass plumbing, LogDepthExtension | all | GPU geometry re-projects ≤ 0.053 px | yes (engine) | Firefox / Safari untested |
| `terrain.ts` TerrainCore | TerrainTileLayer | geometry, color | reference for batched | yes (`?terrain=tiles`) | — |
| `layers/batched-terrain.ts` | batched-terrain-layer | geometry, color | 99.84–99.97 % identical px vs TerrainCore, reproj ≤ 0.053 px | yes (default) | CPU cull; needs float32-filterable |
| `layers/terrain-styles.ts` | terrain-layer fs, look GLSL | (shading part) | 22/22 programs; hillshade ≤ 0.18 %, imagery ≤ 0.08 % vs CPU port of the GLSL | yes (overlay / replace styles) | atmosphere eye convention to confirm |
| `layers/drape.ts` | projectPhoto / truth | (plugin) | Step Inside frame reproduces the photo; grazing acne 17.7 % → 0 % | world view screenshots | no pixel A/B of the world drape |
| `layers/trail.ts` | TrailLayer (LineSegments2) | color | position / width / occlusion / premul checks | yes (`&trails=1`) | class-1 normal write undecided |
| `layers/composite.ts` | PhotoCompositor + composite shader | screen | ≤ 0.53/255 vs CPU copy of the GLSL, 20/20 cases | yes (export diff, see Measured) | interactive: colour pass 1× (below) |
| `layers/ridges.ts` | composite ridges / skyline / ink | (WGSL lib) | 0 bad px, max err 1e-5 vs GLSL CPU port | via composite | texel-edge ties shift 1 row |
| `layers/atm-sky.ts` | AtmSkyLayer, applyAtmosphere | color | ≤ 1/255 vs the GLSL compiled on WebGL2 | world view | — |
| `layers/photo-sky.ts` | PhotoSkyLayer | color | max err 0 vs CPU model | not run (needs Step Inside scene) | — |
| `layers/gizmo.ts` | WorldGizmoLayer | color | 10/10 checks | world view screenshots | linear-light blending differs slightly |
| `layers/splats.ts` | DeckSplatLayer + SplatColorPass | color (+ geometry class 2, off) | 0 px > 2/255 vs CPU model | not run (needs :8767 scene) | worker sort untested on WebGPU; smear gate unmeasured |
| `layers/tiles3d.ts` | Tiles3DDeckLayer | color (+ geometry class 3, off) | 15/15 checks | not run (needs `?tiles3d=`) | class-3 default is a product call |
| `layers/geometry-source.ts` | GpuGeometrySource (geometry-pass.ts) | geometry, off-frame | exact vs the frame pass; reproj 0.052 px | yes (queries, labels) | direct host only for the check |
| `layers/multi-drape.ts` | /roll MultiDrapeLayer | color | median 1.2e-4 vs CPU copy of the GLSL | n/a (/roll stays WebGL) | only if /roll moves |
| `engine.ts` WebGpuEngine | DeckEngine | — | ranges identical to WebGL (median/p90 diff 0), 14/14 labels | lab + bench | see gaps |
| `lab-engine.ts` + route | — | — | `engine-lab.mjs`: errors [] | — | — |

## Measured (2026-09-30, `scripts/deck-webgpu/bench.mjs`, Chrome / Apple Metal, 1080×810)

WebGPU engine (deck host) vs the WebGL DeckEngine (`/photo/<id>?renderer=deck`) on IMG_7086,
IMG_6958, IMG_7018, same pose, settings and canvas size:

| Metric | WebGL | WebGPU |
|---|---|---|
| time to first terrain frame | 2.6–3.3 s | 2.4–2.5 s |
| pipelined frame (60 pose changes, one GPU sync) | 5.4–7.2 ms | 5.9–6.8 ms |
| pan frame waited to completion | 8.8–10.5 ms | 12.5–14.7 ms (completion-latency floor; deck-host CPU ≈ 0.2–0.4 ms) |
| world orbit (2.5 s drag) | 60 fps, one 33 ms frame on 2 of 3 photos | 60 fps, no frame > 16.8 ms |
| GPU memory, photo view (luma stats) | 175–188 MiB | 350–398 MiB |
| GPU memory after world view | 675–688 MiB | 777–825 MiB |
| export diff, overlay (mean abs / px > 16) | — | 0.78–0.95 / 0.6–1.2 % |
| export diff, replace (satellite lens) | — | 0.27–0.39 / 0.03–0.17 % |
| peak labels | — | identical sets on all three photos |

Full write-up, screenshots and diff heat maps: the session's `deck-webgpu-results.md`
(re-run `bench.mjs` to regenerate). Memory is the first thing to shrink (batched-terrain
buffers, the MSAA colour target, the per-size geometry targets).

## Known gaps

- **Renderer interface.** `WebGpuEngine` implements all of `Renderer`; deviations:
  `kind` is `'deck'` (the type only allows three / deck) with `backend: 'webgpu'`, so tools that
  poke WebGL deck internals (`deckInstance.layerManager`, compositor) must check `backend`.
- **Step Inside map mode** runs on deck's MapController only on the deck host (`setExtraViews`,
  now implemented); on the direct host `StepCamera` runs its own map mode.
- **Not exercised end to end:** Step Inside (splats, photo sky, 3D tiles), because the harness has
  no near-field scene / tiles config; the per-layer checks cover them in isolation.
- **Interactive mode (unmeasured, no browser run yet):** `engine.noteInput` → `host.setInteractive`
  → `ColorTargets.setReduced`: while a drag / lens burst runs the colour pass draws 1× straight
  into the resolve-format `color` target (lazy 1× depth + framebuffer, no resolve), the geometry
  readback waits, and `inputIdle` restores 4× MSAA with one "all" frame after the (bounded)
  readback. Pipelines bake the sample count, so `pass.ts` `ModelCache` keeps one Model per
  (key, sample variant): `runColorPass` sets `setColorSamples(1)` while recording and
  `passModelProps("color")` reads it; both variants live side by side, created lazily on first
  use (`engine.scheduleWarm` builds them on idle, 400 ms after a full frame and whenever `pass.ts modelEpoch` changes: one layer per idle slice drawing into an 8×8 scratch target; luma 10 alpha.2's async compile only covers Models created under `beginAsyncCompilation`, which draw-time creation cannot use). The look (`scheduleLook`) is
  already debounced past the drag. Exports and `renderOffscreen` use fresh targets, always 4×.
- **Full-resolution export** allocates a 4× MSAA rgba16float target at photo size (hundreds of MB
  at 12 MP, as the WebGL renderImage). Tile it via the camera offset.
- **Colour space:** WebGPU blends in linear light into rgba16float; WebGL blended sRGB bytes on
  the canvas. Translucent edges (gizmo, splats in the world view, multi-drape feathers) are
  slightly different by design.
- **Device features:** `float32-filterable` is required (rule 14); Chrome on Apple Metal is the
  only tested platform.
- **Band stats** (LOOK_HARMONIZE) in world mode render without the drape (as WebGL roughly did);
  exact parity unverified. The compute band-stats shader `look-band-stats-sg` in src/lib/gpu fails
  to compile on the adopted device (`value nan cannot be represented as 'f32'`), so the CPU path is
  used (mt-image-03).

## Staged plan to replace the WebGL DeckEngine

1. **Now (done):** every layer ported with an isolation check; `WebGpuEngine` implements
   `Renderer`; lab + bench (`bench.mjs`) against `/photo/<id>?renderer=deck`.
2. **Opt-in in the app** (owners of PhotoWorkspace / flags / vite.config): add `?renderer=webgpu`
   (snippet in `engine.ts` WIRING and below), falling back to the WebGL DeckEngine when
   `WebGpuEngine.available()` is not ok. Make the `visgl:webgl-only` condition conditional (or
   drop it: about +124 KB on the WebGL deck path) so the deck host runs in the app.
3. **Parity gate on the eval sets:** run `scripts/deck-engine-smoke.mjs`, `eval-app`,
   the wild benchmark and the Step Inside e2e with `renderer=webgpu`; require the WebGL numbers
   (Δyaw ≤ 0.5°, label Jaccard ≥ 0.6, export diffs at today's levels), plus the splat smear gate and
   a 3D-tiles A/B.
4. **Default on for WebGPU-capable browsers (done 2026-10-01, ahead of the step-3 gate by the
   user's call):** `?renderer=auto` is the default; `?renderer=deck` is the WebGL escape hatch.
   Parity regressions found at the flip are fixed after it.
5. **Retire WebGL deck layers** (terrain-layer, batched-terrain-layer, composite*, trail-layer,
   world-view layers, deck-splat-layer, tiles3d deck-layer, geometry-pass) once Safari / Firefox
   ship WebGPU on the supported OS versions; move `/roll` last (`layers/multi-drape.ts` is ready).
6. **luma 10 / deck 10:** we run luma 10.0.0-alpha.2 with deck vendored from PR #10752 (its
   packaging needs the `.npmrc` / `overrides` workarounds, `vendor/deck/README.md`). Only
   `hosts/deck.ts` and `device.ts` touch deck; swap to npm when deck publishes on luma 10, then
   drop the workarounds listed below.

Integration snippet (PhotoWorkspace owner):

```ts
const wantWebGpu = getFlag("renderer") === "webgpu";          // flag owner adds the value
let engine: Renderer;
if (wantWebGpu) {
  const { WebGpuEngine } = await import("#/lib/deck-webgpu/engine");
  engine = (await WebGpuEngine.available()).ok
    ? new WebGpuEngine(canvas, photo)                          // fresh canvas: no WebGL context on it
    : new DeckEngine(canvas, photo);
} else engine = /* existing three / deck selection */;
```

## Upstream: luma.gl / deck.gl issues and PR ideas

Found on deck.gl 9.4.0 / luma.gl 9.4.2, Chrome, Apple Metal; re-checked against luma
10.0.0-alpha.2 (= luma master `7d1d11e9` in core / webgpu / engine) and deck PR #10752 (what we
vendor). Each open one has a local workaround.

**deck.gl**
1. *View `clear: true` on WebGPU opens a render pass inside the open one* → invalid command
   buffer. PR: clear through the pass's `loadOp` (or end / reopen the pass) in `LayersPass`.
2. *`LayersPass` hard-codes `clearDepth: 1` and depthCompare `less-equal`* → reversed-Z is
   impossible in deck's own passes. PR: `clearDepth` / depth parameters on `View` or `LayersPass`
   props (reversed-Z is the WebGPU-native way to get precision at 400 km ranges).
3. *`WEBGPU_DEFAULT_DRAW_PARAMETERS` are merged over the model's parameters*; `blend: false`
   cannot remove the blend state, so float targets need `float32-blendable`. PR: merge defaults
   under model / layer parameters and honour `blend: false`.
4. *No `sampleCount` / resolve targets in `LayersPass`.* PR: MSAA framebuffer + `resolveTargets`.
5. *No WGSL shader hooks (`SHADER_HOOKS_WGSL = []`)*, so extensions (LogDepth, Terrain, …) cannot
   port. deck #10751 adds one WGSL vertex hook and no fragment / depth hook, which is not enough for
   TerrainExtension (not adopted). PR: the remaining WGSL counterparts of `DECKGL_FILTER_*` hooks.
6. *The `visgl:webgl-only` export condition removes every WebGPU branch silently*; a WebGPU Deck
   then fails obscurely. PR: a runtime error when `deviceProps.type === 'webgpu'` on the
   webgl-only build, or an exported build marker (`device.ts` `deckBuild()` infers the build
   from `project.source`, null in webgl-only).

*Pending re-vendor* (fixed in luma's own deck patch, `.yarn/patches/@deck.gl-core-npm-9.4.0-707f3fb147.patch`
from luma #3325 / `7d1d11e9`; not in deck master, #10752 or any open deck PR; dormant for us today
— full-canvas views, no picking — but needed before the WebGPU renderer ships): WebGPU Y-origin in
`getGLViewport`, the pick pass `scissorY`, the `DeckPicker` readback flip / row order, a
`depth24plus` attachment on `deck-renderbuffer-0`, and the `project.wgsl`
`project_get_orientation_matrix` `select` argument order (NaN for a vertical up vector).

**luma.gl**
7. *`Model.draw()` does not forward `firstInstance` / `baseVertex`* to `renderPass.draw` → one
   compact instance buffer per group instead of offsets into one (batched terrain). Still present
   in 10.0.0-alpha.2.
8. *`generateMipmapsWebGPU` encodes its own passes and submits* → calling it while a render pass
   is open breaks the frame. PR: take a `CommandEncoder` (or queue the work for the next submit);
   at least document it. Still present in 10.0.0-alpha.2.
9. *WGSL reflection maps `texture_2d<f32>` to sampleType `'float'`* → `r32float` / `rgba32float`
   bindings need `float32-filterable`. PR: derive `unfilterable-float` when the WGSL only uses
   `textureLoad` on it, or accept a per-binding `sampleType` override in `shaderLayout`.
10. *Uniform writes are `queue.writeBuffer`*: a Model drawn twice in one submit with different
    uniforms shows the last values in both draws. PR: a dynamic-offset uniform ring in
    `UniformStore` (per-draw uniforms without one Model per pass / one buffer per object).
11. *WGSL preprocessor has no compound expressions*: `#ifdef` / `#ifndef` / `#else` and a simple
    `#if NAME` / `#if !NAME` / `#if defined(NAME)` work in 10.0.0-alpha.2, but `&&` / `||` / `==` do
    not → combined defines are still computed on the CPU (`compositeDefines()`). PR: expression
    support as in the GLSL path.
12. *Uniform layout validation:* since 10.0.0-alpha.2 field names and order are checked against
    the WGSL struct (`validateShaderModuleUniformLayout`, which throws); std140 vs WGSL alignment
    and field types are still unchecked and fail silently (vec3 + scalar packing). PR: extend the
    check to types and offsets.
13. *`copyExternalImage` with an `HTMLImageElement`* uses the given width / height; callers pass
    `.width` (layout size in the DOM). Doc note: prefer `naturalWidth`.
14. *`TextureReader`-style async readback* (staging buffer pool, 256-byte rows) is re-implemented
    by every app; a luma helper for "read texture → typed array, top-first" would help.
