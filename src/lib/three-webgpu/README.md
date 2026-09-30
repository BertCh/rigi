# src/lib/three-webgpu: three.js on WebGPU (spike, 2026-09-30)

This is a spike. Nothing in it is wired into the app, and it adds no routes. It asks whether the
**three** renderer (`src/lib/engine.ts`, `materials.ts`, `terrain.ts`) can move to three 0.186's
`three/webgpu` (`WebGPURenderer`, TSL / NodeMaterial) the way `src/lib/deck-webgpu` is moving deck,
and whether it can share one `GPUDevice` with the compute layer (`src/lib/gpu/core`).

| File | What it is |
|---|---|
| `terrain-tsl.ts` | `materials.ts`' terrain shader in TSL: the classic hillshade (uStyle 0, no `LOOK_*`) plus the geometry output (uStyle 3) as an MRT attachment. It reads the **same** shared uniform record (`makeSharedUniforms`) through `onRenderUpdate` bridges and `uniformArray` by reference, so `style/three-apply.ts` and `writeRamp` drive both renderers. |
| `device.ts` | `createSharedRenderer(canvas, mode)`: `"luma-first"` (luma creates the device, three renders on `luma.handle`), `"three-first"` (three creates it, luma wraps `renderer.backend.device`), `"own"` (no sharing). The sharing modes call `adoptRenderDevice(luma)`. |
| `spike.ts` | `runSpike(input)`: loads the terrain for one pose exactly as `engine.init` does, renders WebGPU (canvas + MRT), runs a core compute kernel on the shared device over the geometry texture, renders the WebGL2 reference (the engine's `ShaderMaterial` on the same meshes), and compares the two. |
| `scripts/three-webgpu/spike.mjs` | Headless harness. It mounts `runSpike` on `/favicon.svg` and writes `out/gpu/followups/three-webgpu/{spike.json, webgpu.jpg, webgl.jpg, diff.png}`. |

```
npx vite dev --config scripts/gpu/vite.gpu.config.ts --port 3157 &
APP_URL=http://localhost:3157 node scripts/gpu/with-render-lock.mjs -- node scripts/three-webgpu/spike.mjs [IMG_7053] [modes=luma-first,sidecar,three-first,own]
```

## Result (IMG_7053 ground-truth pose, 1024×768, 160 tiles / 6.9 M triangles, Apple GPU / Metal, headless Chromium)

The run is in `out/gpu/followups/three-webgpu/spike.json`. The images are `webgpu.jpg`, `webgl.jpg`, and `diff.png` (|Δ| × 4).

**Colour, WebGPU+TSL vs WebGL2+`makeTerrainMaterial`.** Both use the same meshes, uniforms and camera, MSAA 4× and log depth, and the metric is max |ΔR,ΔG,ΔB| on 8-bit sRGB:

| | mean | p50 | p95 | p99 | max | exact | > 2 | > 8 | > 32 |
|---|---|---|---|---|---|---|---|---|---|
| all pixels | 0.17 | 0 | 1 | 2 | 95 | 90.1 % | 0.8 % | 0.2 % | 0.06 % |
| interior terrain (no silhouette within 1 px) | | 0 | | 2 | 17 | | | | |

The differences sit on silhouettes and triangle edges, where the two MSAA resolves disagree (`diff.png`). Interior shading agrees to within the rounding of the sRGB encode.

**Geometry, WebGPU MRT `geo` attachment vs WebGL2 uStyle 3 float target.** The MRT target is rgba32float and read back async. The WebGL2 target is FloatType and read back sync. Rows are flipped for the comparison.

| terrain px | mask agreement | range rel. p50 | p99 | > 1 % | xyz p50 | xyz p99 |
|---|---|---|---|---|---|---|
| 373 318 | **100 %** (0 / 0 one-sided) | 7.0e-8 | 4.8e-6 | 1 px | 0.25 mm | 4.3 cm |

**Shared device.** The compute side works in every sharing mode. A core kernel (`defineKernel` / `dispatch` / `readBack`) runs on the render device over a GPU copy of three's `geo` attachment. It counts hits and takes the max / min range, and matches the CPU twin over the async readback **exactly** (373 318 hits, 108 453.875 m, 171.771 m). `getComputeDevice() === renderDevice` holds in `luma-first`, `sidecar` and `three-first`, and is false in `own`.

| mode | maxStorageBufferBindingSize | float32-blendable | MSAA | compute on render device |
|---|---|---|---|---|
| luma-first (`webgpuAdapter.create` defaults) | 128 MiB | no | 4 | yes (adopt) |
| **sidecar** (three renders on `getComputeDevice()`) | **4 GiB − 4** | no | 4 | yes (same device) |
| three-first (luma wraps `renderer.backend.device`) | 128 MiB | yes | 4 | yes (adopt) |
| own | 128 MiB | yes | 4 | no |

**Timings (ms).** The GPU-side waits are `queue.onSubmittedWorkDone()` on WebGPU and a 1-px `readPixels` on WebGL. The two fences differ, so compare the numbers loosely. Each value is the mean of 20 warm frames. The luma-first column is the cold run: its first import compiles the TSL graph.

| | luma-first (cold) | sidecar | three-first | own | WebGL2 |
|---|---|---|---|---|---|
| renderer init | 3.5 | 1.7 | 2.3 | 4.4 | 6.5 |
| compileAsync | 33.5 | 22.8 | 19.2 | 18.2 | n/a |
| first frame | 24.8 | 22.6 | 22.7 | 23.9 | 30.6 |
| warm frame (canvas, MSAA 4×) | 5.01 | 3.88 | 3.79 | 3.63 | 4.84 |
| warm MRT frame (colour + geo, 1 pass, no MSAA) | 2.95 | 2.74 | 2.75 | 2.69 | n/a (2 passes) |
| geometry readback (12 MB) | 4.3 async | 3.1 async | 3.0 async | 2.8 async | 7.2 **sync** |

## Inventory: three renderer → WebGPU

Effort: **S** ≤ ½ day · **M** 1–2 days · **L** 3–5 days. Class: trivial TSL port / needs rework / blocker.

| # | Where | What | Class | Effort | Notes |
|---|---|---|---|---|---|
| 1 | engine.ts:489 | `WebGLRenderer({antialias, logarithmicDepthBuffer, preserveDrawingBuffer})` | needs rework | S | `WebGPURenderer({device, antialias, logarithmicDepthBuffer})` plus `await renderer.init()` in `Engine.init` (the constructor is sync). There is no `preserveDrawingBuffer`: see #13. |
| 2 | materials.ts terrain uber-shader, **classic hillshade + geometry** | `ShaderMaterial`, uStyle 0 / 3 | trivial TSL port | done | `terrain-tsl.ts`, about 100 lines. Parity numbers are above. |
| 3 | materials.ts: contours / bands (uStyle 2 / 4), casing, density fade | `fwidth`, ramps | trivial TSL port | S | TSL has `fwidth`. The ramps reuse `rampEval` from `terrain-tsl.ts`. |
| 4 | materials.ts: imagery (uStyle 1) and the photo drape / Truth tint | per-tile `map`, `uPhotoRange` shadow test, `uPhotoFg` | needs rework | M | terrain.ts writes `material.uniforms.map` per tile. That needs a per-tile NodeMaterial (or a `texture()` node swapped per tile) and a material interface in terrain.ts instead of the `ShaderMaterial` type. The geoRT feedback loop still has to be broken (a texture cannot be sampled while it is being rendered to), as it is today. |
| 5 | materials.ts `LOOK_*` defines: atmosphere, relief, alpine, tanaka, slope, harmonize, ink (look/glsl/*.ts, about 550 lines of GLSL) | `#ifdef` specialisation, `defineBlock` three bindings | needs rework | L | `#ifdef` becomes JS-time graph construction (rebuild the node graph when the look key changes). Either port each chunk to TSL, or embed the WGSL twins that deck-webgpu already maintains (`src/lib/deck-webgpu/wgsl.ts`, `terrain.ts`) through TSL `wgslFn`, so both WebGPU renderers share one WGSL source. `defineBlock` needs a third binding (TSL uniforms). |
| 6 | engine.ts:147 composite (`compositeFrag` + `compositeChunk` + `REVEAL_GLSL` + `TURBO_GLSL`, about 300 lines) | fullscreen `ShaderMaterial`, `texelFetch`, `textureSize`, int switches | needs rework | L | Mechanical (`textureLoad`, `textureSize`, `select` / `If`), but large. It is a TSL `QuadMesh` or post pass. |
| 7 | materials.ts:535 `makeSkyMesh` (atmosphere sky, VS writes clip positions) | `ShaderMaterial` | trivial TSL port | S | `vertexNode` plus the ported atmosphere functions (#5). |
| 8 | engine.ts render targets: geoRT (Float), layerRT (HalfFloat, samples 4), normalRT, statsRT, silRT, computeHorizon RT | `WebGLRenderTarget` | trivial | S | Replace with `RenderTarget`. rgba32float cannot be multisampled, which is the same as today (geoRT has no MSAA). MRT can merge geo + normal (and layer stats) into one pass: 2.7 ms for colour + geo above. |
| 9 | engine.ts `readRenderTargetPixels` ×4 (readGeometryNow, computeHorizon, layerStats, silhouetteScore) and nearfield/generate/cache-render.ts ×3 | **sync** readback | needs rework | M | WebGPU readback is async only (`readRenderTargetPixelsAsync`, rows top-first). `readback()` already returns a Promise. `silhouetteScore` is called inside a sync `.map` over alignment candidates (engine.ts:2050), so it and its caller become async. `computeHorizon` is the fallback path and could use the GPU horizon kernels instead. cache-render takes a `THREE.WebGLRenderer` by type. |
| 10 | engine.ts:1124 `renderer.capabilities.getMaxAnisotropy()` | WebGL API | trivial | S | `renderer.backend.getMaxAnisotropy()`, or a constant 16. |
| 11 | engine.ts `LineMaterial` / `LineSegments2` (trails) | examples/jsm/lines | trivial | S | Use `three/examples/jsm/lines/webgpu/LineSegments2.js` + `Line2NodeMaterial` (both ship in 0.186). |
| 12 | engine.ts frustum gizmo `MeshBasicMaterial` / `LineBasicMaterial`, OrbitControls | built-ins | trivial | 0 | WebGPURenderer converts built-in materials to node materials. The controls are renderer-agnostic. |
| 13 | engine.ts:2180 `exportImage` (`domElement.toBlob` after render, `drawImage(renderer.domElement)`) | relies on `preserveDrawingBuffer` | needs rework | S | Read the canvas in the same task as the render (the spike's `grab` does this), or render to an RGBA8 target and read it back async. |
| 14 | `DataTexture` / `CanvasTexture` with `flipY` (fgTex, occluder, masks) | texture upload | verify | S | `flipY` on DataTexture uploads is not verified on the WebGPU backend. If it is unsupported, flip on the CPU. |
| 15 | terrain.ts `Terrain.load(makeMaterial: → ShaderMaterial)`, `loadImagery` / `dispose` read `material.uniforms` | typing / coupling | needs rework | S | The spike passes a NodeMaterial with a `uniforms: {map, hasMap}` stub. A small material interface would remove the stub. |
| 16 | tiles3d/material.ts (Step Inside 3D Tiles) | `ShaderMaterial`: `dFdx` / `dFdy` normals, `instanceMatrix`, log-depth w bias, `gl_FragCoord` dither | needs rework | M | TSL has `dFdx` / `dFdy`, `instance`, a custom `depthNode` and `screenCoordinate`. 3d-tiles-renderer under WebGPURenderer is unverified. |
| 17 | nearfield/three-splats.ts (Gaussian splats) | GLSL3, `usampler2D` RGBA32UI + `uintBitsToFloat`, instanced quads, custom premultiplied blending, sorting | needs rework | L | Each piece has a TSL equivalent (`textureLoad` on a uint texture, `bitcast`, `instanceIndex`, `BlendMode`), but this is the largest single shader and the most sensitive to visual parity. |
| 18 | nearfield/step-camera.ts `PhotoSky` | small `ShaderMaterial` | trivial TSL port | S | |
| 19 | Vite dep optimisation of `three/webgpu`, `three/tsl` | build | **blocker until fixed** (config) | S | See Blockers, item 1. |

Total estimate for a full port at parity is about **15–20 dev-days**: 5 for the terrain looks, 4 for the composite, 3 for the async-readback ripple, 3 for splats, 2 for tiles3d, and 2–3 for the rest plus the parity harness.

## Blockers and traps found

1. **Vite dep re-optimisation creates two three cores (hard failure).** `three/webgpu` and `three/tsl` are not pre-bundled. The first import mid-session makes Vite re-optimise and reload ("optimized dependencies changed"). A page that already holds the old `three` chunk then gets a second three core. The symptoms are "Multiple instances of Three.js", a TSL "Maximum call stack size exceeded", and then a Tint pipeline failure ("swizzle view instruction still has usages after lowering"). The spike harness works around it by importing once and reloading. The real fix is `optimizeDeps.include: ["three/webgpu", "three/tsl"]` in `vite.config.ts`, which belongs to another session and is not edited here.
2. **MRT clears.** three clears every non-first MRT attachment to (0, 0, 0, **1**) unless the **renderer-level** MRT (`renderer.setMRT`) names a clear colour. A material-only `mrtNode` gives "w = 1 m" on every sky pixel. The first run showed a 47 % mask agreement for this reason. `geometryMRT()` sets `setClearColor("geo", 0, 0)`.
3. **Material MRT `output`.** With only a material `mrtNode`, NodeMaterial does not route `outputNode` into the `output` property, so `mrt({output, …})` renders the basic material colour. Pass the colour node explicitly (`terrain-tsl.ts`).
4. **Async-only readback.** This is the one API change that reaches outside the renderer (#9).
5. **luma 9.4 `webgpuAdapter.attach()` throws "not implemented".** `new WebGPUDevice(props, gpuDevice, adapter, adapterInfo)` works in its place, with a null adapter because no canvas context is created (`device.ts` "three-first").
6. **three-first gets default limits.** three requests `featureLevel: "compatibility"` and default limits (128 MiB storage bindings). Compute kernels sized for the sidecar's 4 GiB would fail validation there. Luma-created devices lack `float32-blendable`. That is harmless here because non-`output` MRT attachments use NoBlending.

## Recommended path

1. **Device: render on the compute sidecar** ("sidecar" mode). three takes `(await getComputeDevice()).handle` and inherits the raised limits and the optional compute features, with MSAA intact. `adoptRenderDevice` is then unnecessary. If gpu/core would rather own a distinct render device, it should expose a creator that uses the same limit policy ("luma-first" with `RAISED_LIMITS`). Avoid "three-first".
2. **Do not port engine.ts while deck-webgpu is landing.** deck is at parity, and its WebGPU port is the renderer track. If the three renderer must live on after that, port it behind its own renderer flag in this order:
   - (a) Fix the Vite optimizeDeps entry.
   - (b) Add a material interface in terrain.ts, plus the terrain looks in TSL with `wgslFn` over deck-webgpu's WGSL (one WGSL source for both WebGPU renderers).
   - (c) Make the readback API async (the engine and cache-render).
   - (d) Port the composite as a TSL quad pass, with MRT merging the geometry and normal passes.
   - (e) Port trails, the sky, the gizmo and export.
   - (f) Port tiles3d, then splats.

   Gate each step with this harness: colour interior p99 ≤ 2/255 and geometry mask 100 % / range p99 ≤ 1e-5 vs WebGL2.
3. Keep the WebGL2 engine as the reference twin. `?gpu=off` should keep selecting it.
