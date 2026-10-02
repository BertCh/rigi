# Horizon graph

A WebGPU example that computes the 360° skyline seen from the Niederhorn (above Lake Thun,
Switzerland) on the GPU with `GPUCommandGraph`, checks it against an f32 CPU twin, and draws it as a
panorama silhouette with a luma.gl `Model`. The Eiger, Mönch and Jungfrau, 23–24 km away at
130–143°, form the highest part of the southern skyline.

Upstream, luma.gl's roadmaps call the program behind `GPUCommandGraph` Arisia.

The examples resolve `@luma.gl/*` and `@deck.gl/*` from this repository's vendored tarballs (`vendor/`), so run them from this repository (after `npm install` at the root); they are not meant to be copied out on their own.

Run `npm start` in this folder (npm puts the ancestor `node_modules/.bin` on `PATH`), or run
`npx vite examples/gpgpu/horizon-graph` from the repository root. The example needs network access
to fetch terrain tiles. `npm run test:visual` runs `scripts/visual-smoke.mjs` (in Rigi, wrap it in
`node scripts/gpu/with-render-lock.mjs --`).

## What it does

1. **Terrain.** 7 × 7 Mapterhorn z11 Terrarium tiles (3584² pixels, about 26 m per pixel here)
   are fetched around the viewpoint. Their raw RGBA bytes are uploaded as one `u32` storage buffer.
   The tiles reach at least 40 km in every direction, and rays stop at the mosaic edge.
2. **Graph.** One `GPUCommandGraph<{decodeHeights: boolean}>` declares three stages. Dependencies
   are inferred from each node's declared buffer uses:

   | Node | Work |
   | --- | --- |
   | `decode-terrarium` | `r·256 + g + b/256 − 32768` per pixel into an f32 `heights` buffer. A CPU `condition` skips it after the first encoding because `heights` is caller-owned and persists. |
   | `march-horizon` | One invocation per azimuth bin (default 2048). It walks a shared distance table (5 m to 45 km in 1,513 samples; 1,454 at the default 40 km), samples heights bilinearly, and keeps the largest `(h − h_eye)/d − d·(1 − k)/2R` with refraction k = 0.13. It writes the tangent and its distance. |
   | `tangent-extent-*` | `GPUReduction` with `operation: 'extent'` over the tangents, expanded into hierarchical passes. Its min/max sets the panorama's vertical range. |

   The application creates the command encoder, submits, and reads back with `Buffer.readAsync`.
   `GPUCommandGraphInspector.observeGraph` records each encoding. When the device has
   `timestamp-query` (the device is created with `featureLevel: 'max'`), the encoder gets a
   `timeProfilingQuerySet` and the infobox's "Graph readout" panel lists GPU milliseconds per node.
3. **Render.** Two `Model`s (a triangle strip and a line strip) read `horizonTangents` and
   `horizonDistances` straight from the graph's storage buffers in the vertex shader. The data
   makes no CPU round trip. Colour fades with skyline distance (aerial perspective). Compass ticks,
   elevation grid lines, peak labels and the hover readout are an SVG overlay.

Setters: `setAzimuthBins` rebuilds and recompiles the graph. The heights buffer is kept, so the
decode node is skipped. `setMaxDistance` re-encodes the same compiled graph with a new sample
count. `setHeading` and `setFieldOfView` redraw only.

## Verification

`computeHorizonOnCPU` repeats the march in TypeScript and rounds every step with `Math.fround`, in
the WGSL's order of operations. An f64 operation on f32 inputs, rounded once, is the correctly
rounded f32 result, so the twin is an exact IEEE-754 f32 reference. Three choices keep the GPU close
to it:

- **No GPU division.** WGSL allows 2.5 ULP for `/`, so the distance table stores `[d, 1/d]` pairs
  and the shader multiplies.
- **Eye-relative coordinates.** The ray offsets are added to the eye's position within its pixel,
  and the eye's integer pixel is added afterwards. Next to the eye, f32 resolution is therefore
  sub-millimetre, not about 2e-4 px. Heights are taken relative to the eye before interpolation.
  The subtraction is exact (Sterbenz), and an absolute-height rounding error divided by a 5 m
  distance would otherwise dominate.
- **`opaque()` around the eye-relative heights.** Metal compiles WGSL with fast math. Without the
  guard it re-associates `(h − h_eye)` terms in the bilinear blend and brings the absolute-height
  rounding back. XOR with a uniform zero cannot be folded.

Measured on an Apple-silicon Mac (headless Chromium, Metal) at 2048 bins:

| | max \|Δ elevation\| | bins > 1e-3° | bit-identical bins |
| --- | --- | --- | --- |
| naive (absolute pixels, `/`, no guard) | 1.6e-3° | 1 | 383 |
| eye-relative pixels and `1/d` table | 4.4e-4° | 0 | 287 |
| plus eye-relative heights | 2.0e-4° | 0 | 693 |
| plus `opaque()` on those heights (shipped) | **9.3e-6°** | **0** | 887 |
| plus `opaque()` on every product (not shipped) | 5.9e-6° | 0 | 1958 |

The documented bound, asserted by the visual smoke test, is that **no bin differs by more than
1e-3°** (`MISMATCH_TOLERANCE_DEGREES`). Observed differences are about 100× smaller: 9.3e-6°, or
3.4 milli-arcseconds. They come from fused multiply-adds, which the GPU may form under fast math.
The diagnostics also report the largest distance in f32 ULPs (596 here). That count is large only
because ULPs shrink near a tangent of 0, so the bound is stated in degrees.

Timings on the same machine (2048 bins, 1,454 samples per ray): graph GPU time 1.7–2.8 ms
from timestamp queries (decode about 1 ms, march 1–1.9 ms, reduction under 0.03 ms), against a CPU
twin of 60–65 ms (single-threaded JS, decode included). At 4096 bins: GPU about 1.9 ms, CPU about
84 ms (march only).

## Geometry and limits

- Sphere of radius 6,371 km. Ray positions use a local Web Mercator expansion to second order in
  the northward offset. The residual is about `n³/R²`, roughly 2 m at 40 km.
- The skyline is the bilinear z11 surface. Summits narrower than a pixel are rounded off.
- The eye is the phone GPS fix (1919 m). It is raised to 1.6 m above the DEM where the DEM is
  higher; at this fix the DEM reads 1931.6 m. That fix is on the south slope below the summit, so
  the summit ridge rises to 11.8° to the north and tops the full 360° profile.

## Upstream notes

API observations from this example, collected for luma.gl:

- **Compute nodes need both `compile` and `compileAsync`.** `GPUCommandGraphComputeNode.compile`
  is required even when the application only calls `compileAsync()`. A node built from
  `Kernel.createAsync` has to duplicate the synchronous path (here `makeKernelCompiler`). A
  `GPUCommandGraph.addKernelPass({kernel, bindings, workgroupCount})` helper would remove the
  boilerplate. `GPUReduction` has the same helper internally as `addKernelPass`.
- **No public typed binding for imported whole buffers.** `getViewBinding` is exported but takes a
  `GraphDataView`. Kernels bound to whole imported buffers resolve each handle by hand in `encode`.
- **Timestamp queries need a hand-sized `QuerySet`.** Per-node GPU timings work only when the
  caller creates a `QuerySet` and passes `timeProfilingQuerySet` to `createCommandEncoder`. The
  graph's `preflight` already knows its node count, so it could size or own that query set. If the
  set is too small, later passes go untimed without a warning (`_applyTimeProfilingToPassProps`
  returns the props unchanged).
- **Fast math in WGSL on Metal** is not a luma issue, but GPU/CPU twins hit it. A shadertools
  helper (an `opaque`/`exact` function bound to a zero uniform) and a note in the GPGPU docs would
  save the next author some time.
- Known: in 10.0.0-alpha.2, the `PipelineFactory` compute-pipeline cache ignores
  `entryPoint`/`constants` (fixed in Rigi's vendored `10.0.0-alpha.2-rigi.3` build, not yet upstream).
  This example does not depend on override constants. Every kernel has
  its own source.

## Data sources and licences

- **Terrain:** Mapterhorn terrain tiles (`https://tiles.mapterhorn.com/{z}/{x}/{y}.webp`,
  Terrarium encoding). Tile code is BSD-3. Data follows the licence of each underlying DEM
  (Copernicus GLO-30, swisstopo swissALTI3D OGD and others). Credit "© Mapterhorn"; see
  <https://mapterhorn.com/attribution>.
- **Peaks:** summit positions and elevations from OpenStreetMap, © OpenStreetMap contributors,
  [ODbL](https://www.openstreetmap.org/copyright).
- `../../example-support.ts`, `../../example-infobox.css` and `../../example-theme.ts` are copied
  from luma.gl (MIT, © vis.gl contributors). The rest of this folder is MIT, © Rigi contributors.
