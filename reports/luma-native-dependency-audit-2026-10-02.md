# Luma-native dependency audit (2026-10-02)

Question: we keep pulling in libraries to solve problems; how far is Rigi from running natively on the luma.gl compute graph, in the style of that ecosystem, and what should change? Read-only analysis of master at `5d0e5d8`, plus the `browser/*` worktrees, the vendored luma `10.0.0-alpha.2-rigi.6` / deck `9.4.0-rigi.3`, and upstream luma master `b6f86464` (2026-10-02), deck, loaders.gl and math.gl. Nothing was changed or measured. Builds on [gpu-luma-native-2026-10-01.md](gpu-luma-native-2026-10-01.md), [luma-frontier-2026-10-01-late.md](luma-frontier-2026-10-01-late.md) and [whole-app-graph-plan.md](whole-app-graph-plan.md).

## 1. Verdict

- **The structure is already luma-native.** Every compute path runs on `GPUCommandGraph` through `src/lib/gpu/core` (`ComputeGraph`, which wraps the graph; it is not a copy of it). About 25 gpgpu operators are in real use (`GPUSort`, `GPUFFT1D`, `GPUConvolution`, `GPUProgram`, `GPUKMeans`, …). No private-member casts remain, and `gpu-raw-lint` is at 127 escapes in 9 allowlisted files (705 → 339 → 127). 117 of those are raw `gl.` calls on the WebGL2 fallback.
- **The foreign weight is concentrated in ML and decoding.** There are 2 ML runtimes (`onnxruntime-web` for the sky U²-Net, `@mediapipe/tasks-vision` for people masks), 3 localhost Python services (matcher on :8765, near-field on :8767, propagate on :8769), and 2 decoders (`libheif-js`, `exifr`). Everything else in `package.json` is UI or framework, ecosystem-native (loaders.gl, math.gl), or dev-only.
- **There are no runtime CDN fetches left.** `segment.ts` now loads its wasm through Vite `?url` and its `.tflite` models from `public/models` (5a1042f, landed while this audit ran).
- **The biggest unused asset is already vendored: `@luma.gl/experimental/gpu-raster`.** It is in rigi.6 and has zero imports in `src/`. It covers convolution, Gaussian/box blur, Sobel/Scharr edges, morphology, connected components, Otsu/threshold, histogram and equalisation, global and region statistics, contours, buffer↔texture conversion, and a halo tile cache. Rigi has hand-written versions of several of these.
- **luma has no ML layer.** Upstream has no tensor, operator or model-loader module, and no roadmap item for one. `examples/experimental/gpt-2` is a one-off: five WGSL kernels, one submit per dispatch, and no graph. The `src/lib/nn` runtime being built in the browser-only pass is therefore new ground. It should be shaped so it can become a luma experimental module.
- **The gpgpu, experimental and engine compute code on luma master is unchanged since rigi.6,** so nothing new needs vendoring for compute. Since then, #3313 has merged (it can come off the "swap to npm" list) and deck #10752 moved its head to `43a38d6b`. `luma-watch.mjs` does not track deck PR heads.

## 2. What "luma style" means for compute today

This was read from luma master source and docs, not inferred.

| Idiom | Upstream | Rigi today |
|---|---|---|
| Kernel | engine `Kernel` (`new Kernel(device, {source, shaderLayout})` / `Kernel.createAsync`), with bindings passed per dispatch: `kernel.dispatch(pass, {bindings, x, y, z})` | `defineKernel` builds on engine `Kernel`, but `encodeDispatch` (`gpu/core/kernel.ts:259`) calls `setPipeline/setBindings/dispatch` itself, and layouts are hand-written `[name, kind][]` |
| Graph node | `createGPUComputeCommandNode({resources:[{buffer, usage}], compile → {encode, destroy}})`; the graph owns the pass | `ComputeGraph` adds the same thing plus clear/read nodes and a lint for clearing transients |
| Reusable algorithm | "contributor" class with `getCommandNodes(graph)`, added via `graph.add(op)`; scratch space from `createTransientView`; inputs are `GraphDataView`s owned by that graph | Rigi ops are functions over its own buffers. They are not contributors, and they do not take or produce `GraphDataView`s, so they don't compose with luma ops in one graph |
| Shaders | Generated WGSL strings with view offsets baked in as `const` and `enable subgroups;` only when supported. **gpu-core does not use the shadertools `ShaderModule` / `ShaderInputs` system** | 94 kernels as raw WGSL with `${COMMON}` / `${PARAMS}` interpolation. This matches upstream compute style; no need to force shadertools into compute |
| Uniforms | Rare; parameters go in storage buffers or literals | 40 `defineUniformBlock` uses over `makeShaderBlockLayout` + `ShaderBlockWriter` (public API, fine). `packCoarse` (`gpu/solve/index.ts:192`) still packs words by hand |
| Readback | `GPUReadbackRing` (`tryAcquire` / `acquire`, ticket as a buffer override); never read back only to feed a later GPU pass | Own ring with slots that grow on demand and partial-range maps (`gpu/core/readback.ts`); a superset worth upstreaming |
| WebGL2 fallback | No graph on WebGL by design. Either gpgpu `Operation` handlers per backend (`backendRegistry`), or a second renderer per backend as `@luma.gl/splats` does | Same choice made per feature: CPU reference twin + GPU kernel (`*-cpu.ts`, `*emulate.ts`). Consistent with upstream |

Takeaway: the remaining style gap is about **composition**, not shader syntax. Rigi ops should be contributors over `GraphDataView`s, so that a Rigi op, a gpgpu op and a gpu-raster op can sit in one graph with no glue buffers.

## 3. Dependency inventory

| Package | Use (files) | Verdict | Effort |
|---|---|---|---|
| `onnxruntime-web` | Sky U²-Net-P (4.5 MB fp16) in `sky/model.ts` and `sky/sky.worker.ts`; `models/ort.ts` shares our WebGPU device through a patched adapter (`:47-63`); about 10 MB JSEP wasm | **Replace** with `src/lib/nn`: conv / BN-fold / ReLU / sigmoid / resize / concat as graph kernels, fed directly by `gpu/photoprep` planes. Closes WAG island I6 | M |
| `@mediapipe/tasks-vision` | People masks (`segment.ts`): selfie-multiclass (16 MB) + DeepLab-v3 (2.7 MB), with its own wasm/WebGL runtime | **Replace** after nn: DeepLab first (depthwise conv, ASPP), multiclass second; convert tflite to safetensors offline | M (after nn) |
| Python matcher / near-field / propagate | `matcher-client.ts:11`, `nearfield/client.ts`, `roll/propagate/client.ts:15` | **Being replaced** by the browser-only pass (L1–L6: ALIKED + LightGlue, MoGe-2, solvers in TS, nn on the graph) | L (in flight) |
| `libheif-js` | HEIC decode in a worker, only where the browser can't (everything but Safari) | **Keep.** No WGSL path for HEVC. Possible later: a HEIF container parser + WebCodecs `VideoDecoder` + tile assembly in luma, but no Firefox HEVC support, so libheif stays the fallback | — |
| `exifr` | EXIF / GPS / focal length (`upload/exif.ts`, `geo/photo-meta.ts`) | **Keep.** Not a GPU problem, and loaders.gl 5 has no EXIF parser. If replaced, upstream a small TIFF-directory parser to loaders.gl `images` | S, low value |
| `d3-contour` (dev) | 4 offline bake scripts that need closed rings for SVG | **Keep.** `GPURasterContours` emits segments only: no rings, no stitching across tiles | — |
| `@napi-rs/canvas` (dev) | 31 scripts and checks | **Keep.** Test harness; kernels already run in node over Dawn | — |
| `@loaders.gl/{3d-tiles,tiles,draco,splats,core}` | tiles3d, near-field splats | Idiomatic (Draco wasm local) | — |
| `@loaders.gl/{gltf,images,loader-utils,schema}` | 0 direct imports | Listed but unused: make them peers or drop them | S |
| `@math.gl/{core,geospatial,proj4}` | camera, pose, tiles3d, LV95 | Idiomatic since the three.js removal | — |
| **Not yet used:** `@loaders.gl/geotiff`, `@math.gl/geoid`, `@math.gl/sun` | — | Adopt: `GeoTIFFSourceLoader` for `concord/occl/swiss-cog.ts` (plan W2.5, never landed); `geoid` for `tiles3d/geoid.ts`; `sun` for the sun maths in terroir/style | S each |
| React, TanStack, Tailwind, lucide, clsx, nitro; Playwright, Vitest, etc. | UI / dev | Out of scope | — |

Other foreign compute:
- **CPU workers:**
  - `integration/unknown-pose.worker.ts`: f64 LM, kept on CPU for precision.
  - `nearfield/splat-sort.worker.ts`: may be vestigial now that `GPUSort` is the default. Not verified.
  - `dem/decode.worker.ts`: has a GPU twin in `gpu/ingest/terrarium*`. Check which one is the default.
- **2D canvas `getImageData` readbacks:** about 15 sites. Most are deliberate byte-parity oracles. `align.ts:84`, `look/haze-controller.ts:217`, `nearfield/scene.ts:415` and `sky/index.ts:280` re-rasterise photos that `gpu/photoprep` already holds on the GPU (plan item W1.1).

## 4. Hand-rolled code that `gpu-raster` / gpgpu already provide

These are candidates to check, not proven equivalents; each needs a tolerance gate against the existing CPU twin.

| Rigi code | Upstream equivalent in rigi.6 |
|---|---|
| Guided filter and box filters in `gpu/look/*`, `sky/core.ts` | `GPURasterConvolution` / box blur (the guided filter itself is a composition of box filters) |
| Gradient / edge features for skyline and horizon (`gpu/skyline`, `geo/skyline.ts` fallback) | `GPURasterEdges` (Sobel / Scharr) |
| Mask refine (dilate / erode / fill) in `look/composite.ts`, sky mask post-processing | `GPURasterMorphology`, `GPURasterConnectedComponents` |
| Colour and band statistics (`look/color-stats.ts`, `gpu/look`) | `GPURasterStatistics` / `GlobalStatistics` / `Histogram` |
| Sky / cloud thresholding | `GPURasterThreshold` (Otsu) |
| DEM tiles with halos (`gpu/ingest`, horizon mosaic) | `GPURasterTileCache` (halo tiles) — compare before adopting |
| Ridgeline extraction (`roll/mosaic/ridgelines.worker.ts`) | `GPURasterContours` (segments, on GPU) |
| 2D FFT, matmul, transpose, elementwise | `GPUFFT2D`, `GPUMatMul`, `GPUTranspose`, `GPUElementwise`: unused, and natural nn building blocks |

Caveat: gpu-raster is in `@luma.gl/experimental` (API churn risk; watch draft #3084) and WebGPU-only. The CPU twins stay as the WebGL2 path.

## 5. The nn runtime (browser-only pass, unit L6)

State: `src/lib/nn` exists only in the `browser/nn` worktree (`types.ts` and `shape.ts`, uncommitted; no backend or kernels yet). `browser/features` codes against a local copy of the interface. The plan is one `ComputeGraph` per `forward()`, fp16 safetensors and a CPU reference backend; that fits the house style.

Recommendations, **before kernels are written**:
1. Make nn tensors `GraphDataView`s, and build each layer as a contributor (`getCommandNodes`), so nn graphs compose with photoprep, gpu-raster and gpgpu nodes with no copy.
2. Lower the f32 ops to luma: `GPUMatMul`, `GPUElementwise`, `GPUTranspose`, `GPUReduction`, `GPUSort` (top-k), and `GPUFFT1D`/`GPUFFT2D` (LaMa FFC). Write custom WGSL only for f16, conv2d / depthwise, fused attention, layernorm and gridSample.
3. First target: U²-Net-P sky, because it is small, has an existing ORT oracle to gate against, and deletes ORT. Then DeepLab-v3 (which deletes MediaPipe), then ALIKED / LightGlue and MoGe-2.
4. Lay it out as an upstreamable `@luma.gl/experimental` module, plus a "segmentation" example in luma's example layout under `examples/`. luma has nothing in this space, and the gpu-raster roadmap already plans shared FFT and convolution.

## 6. Ranked moves

| # | Move | Why | Effort |
|---|---|---|---|
| 1 | Shape `src/lib/nn` on `GraphDataView` + contributors + gpgpu ops (§5) | Cheapest now, expensive to retrofit; decides whether ML is graph-native | S (design) |
| 2 | U²-Net-P on nn → retire `onnxruntime-web` and the `models/ort.ts` adapter hack | Removes a 10 MB runtime and a device-sharing hack; sky becomes graph-resident | M |
| 3 | Land the browser-only pass (matcher, near-field, propagate in the browser) | Removes the three Python services; keeps the "local computation" promise | L (in flight) |
| 4 | Adopt `gpu-raster` where §4 shows it fits (guided / box filter, edges, morphology, statistics), each behind a tolerance gate | Deletes hand-written kernels; ecosystem-standard ops | M |
| 5 | MediaPipe → nn (DeepLab first) | Removes the last ML runtime | M |
| 6 | `refine/fft-gpu.ts`: drop the 2048-point four-step split, the 512-point retry and the spot-check workaround now that rigi.6 fixes the Metal bit-reversal and allows FFT1D up to 65536. Prove it in the Dawn harness first (`scripts/gpu/refine-fft-dawn.ts`) | Simpler code on a straight luma path | S |
| 7 | Rigi ops as contributors over `GraphDataView`; `kernel.ts` dispatches via `Kernel.dispatch` and derives layouts from `getShaderLayoutFromWGSL` | Composition with luma ops; less wrapper code | M |
| 8 | Import, rather than keep our ports of, the shadertools `heightFog`, `precipitation` and `pathDash` (now exported with WGSL + GLSL in rigi.6) | Less ported shader code to maintain | S |
| 9 | `@loaders.gl/geotiff` for `swiss-cog.ts`; `@math.gl/geoid`, `@math.gl/sun`; drop the 4 unused loaders.gl entries | Ecosystem-native, small | S |
| 10 | Prepare upstream packets, **held for the owner's OK** (no visgl posts without it): FFT bit-reversal fix (a correctness bug on Metal for everyone), FFT1D length, `clearBuffer` / `submit` / `mapAndRead` patches, clear/read graph nodes + transient lint, growable readback ring, export of `setGPUComputeDispatchWorkgroups`, error scopes without `debug`, later the nn module | Shrinks the vendored patch set; what makes "in the ecosystem" real | M |

Not worth doing:
- **`libheif-js`:** no reasonable GPU path for HEVC.
- **`exifr`:** not a compute problem.
- **`d3-contour` and `@napi-rs/canvas`:** offline or test-only.
- **The f64 LM refinement in `refine/robust.ts` and `unknown-pose.worker.ts`:** small, and needs f64 precision.
- **Shadertools modules for compute kernels:** upstream gpu-core doesn't use them either.

## 7. Small fixes found along the way

- `src/lib/gpu/core/README.md:3` still says rigi.3.
- `vendor/luma/README.md`: #3313 has merged upstream (`6cb33926a`); move it off the "swap to npm" list.
- `scripts/upstream/luma-watch.mjs` should also watch deck PR heads (#10752 moved today).
- luma docs bug: the gpu-raster quick-start uses `new GPUCommandGraph({device, id})`, but the constructor is `(device, props)`. This is a candidate upstream doc fix.
- deck #10697 (camera roll in core / maplibre) is relevant to photo roll; the WebGPU aggregation layers (#10471, #10472) are merged but `@deck.gl/aggregation-layers` is not vendored.

## Verification

Read-only. The only command run was `node scripts/ci/gpu-raw-lint.mjs` (PASS, 127). Upstream state was read on 2026-10-02 via `gh`, scratch clones and `node scripts/upstream/luma-watch.mjs`. No equivalence between Rigi kernels and gpu-raster operators has been measured; §4 is a list of candidates.

## 8. Outcome of the implementation wave (2026-10-02, same day)

A coordinator session ran ten Sonnet units in worktrees (rules and unit reports in that session's scratchpad), after the browser-only pass had landed `src/lib/nn`. Everything below is landed on master and **browser-unverified**; evidence is node/Dawn only.

| Move | Result | Commits |
|---|---|---|
| 1, 2, 4: nn shape + U²-Net-P → retire ORT | Sky U²-Net-P runs on `src/lib/nn` from fp16 safetensors (2.3 MB), sharing one device with the GPU prep and refine (`GpuNn.fromBuffer` / `bufferOf`); mask max error vs ORT 1.7e-3. ~150 ms on WebGPU vs 3–5 s ORT wasm. `models/ort.ts` deleted; `onnxruntime-web` is a devDependency (parity oracle, Landeskarte bake) | 0d9a2c5, 306812e, 9056c6e |
| 5: MediaPipe → nn | DeepLab-v3 (1.4 MB) and selfie-multiclass (8.2 MB) on `src/lib/nn` (`src/lib/segment/`); P(person) max error 1.1e-4 / 9.6e-3 vs TFLite; `@mediapipe/tasks-vision` removed | 213b2e6, 9056c6e |
| nn composes with luma | `nn.fromView` / `forwardInto` / `toView` share a ComputeGraph with gpu-raster / gpgpu nodes without copies (`nn-interop`). Adopted `GPUTranspose`, `GPUElementwise`, `GPUReduction` (10× on long rows), `GPUSort` top-k (3.5×). **Rejected `GPUMatMul`**: 325 vs nn's 1469 GFLOP/s at 1024³. New `rfft2`/`irfft2` on `GPUFFT2D` | 7107c0b, ec7e9a8, 9c269f1 |
| No-WebGPU fallback (regression found on the way) | nn CPU backend: register-tiled conv + fast resize/pool/elementwise; U²-Net-P 384 px 28 s → 5.7 s, selfie-multiclass 5.9 → 2.0 s; sky CPU input back to 384 px. Still ~1.5× slower than ORT wasm SIMD; closing that needs hand-written wasm SIMD (not built) | c207f123, c0b6142a |
| 4: gpu-raster | Haze-prep dilations on `GPURasterDilation` (exact). Skyline Sobel via `GPURasterGradientMagnitude` landed **opt-in only** (p99 7 px row shift vs the hand gradient). Rejected: guided filter (already `GPUConvolution`; raster blur needs 3× passes), band stats (one fused pass beats per-band raster stats), ridgelines contours (polar march, not a level set) | 5c5cac3, 19fd7a1, 4791be9 |
| 7: contributors | `ComputeGraph.add` takes gpgpu `getCommandNodes` contributors **and** gpu-raster `addToGraph` ops (the vendored raster ops use the older shape); `KernelOp`, `importView` / `transientView` / `viewRange`; `defineKernel` derives layouts from WGSL (133 kernels match); dispatch through engine `Kernel.dispatch`. `packCoarse` was already on `defineUniformBlock` | 812f12f, 9f07221 |
| 6: FFT | Single 8192-point `GPUFFT1D` per signal; four-step, 512 retry and DFT stage deleted. Every length 2^1..2^16 correct on Metal (≤ 5.1e-7); the 16384 grid now runs on GPU | d1be4be |
| 8: shadertools | `heightFogFunctions` (Nebelmeer) and `pathDash` (trails, both engines) imported; `precipitation`, `sketchStroke`, `riverWaterMaterial` kept (Rigi diverged on purpose) | d0cd4bf |
| 9: ecosystem packages | **All three rejected** after prototypes: `@loaders.gl/geotiff` (exact pixels, but no per-tile byte budget and ~8% over-fetch), `@math.gl/geoid` (global PGM only, 13–19 MB vs 198 KB regional grid), `@math.gl/sun` (0.27° azimuth / 0.86° altitude error vs NOAA + refraction). Added and removed again; the 4 unimported loaders.gl entries are dropped | 93f6d1a, 9056c6e |
| 10: upstream packets | `reports/upstream-packets-2026-10-02/` (a–h, patches apply to luma master; FFT bit-reversal bug reproduced on unpatched master). Nothing posted. `luma-watch.mjs` tracks 19 luma + 9 deck PR heads | 44e4947 |
| Housekeeping | Haze fit reads the shared per-image raster cache. `align.ts` canvas downscale kept (photoprep's bit-exact contract); GPU DEM decode already default; splat-sort worker still reachable | d4c8c34 |

Third-party runtime dependencies for compute are now `libheif-js` (HEIC, no GPU path) and `exifr` (not compute); no ML runtime ships. Browser batch: sky and people masks on `?renderer=webgpu` and `?renderer=deck` / `?gpu=off` (CPU backend timings, no 60 s stall), haze fit with and without people masks, Nebelmeer and dashed trails on both engines, unknown-pose yaw (GPU vs `?gpu=off`), Step Inside depth and feature matching (nn now uses luma ops), first-forward compile stalls.
