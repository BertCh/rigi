<!-- Rigi -->
<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: Copyright (c) Rigi contributors -->

# Landeskarte Abendlicht

The Niederhorn above Lake Thun as a Swiss Landeskarte sheet that lifts into a summit panorama and ends exactly on the solved frame of a photo taken there on 7 September 2026. Drag the time ruler and the real sun of that day moves across the relief, with cast shadows from a GPU horizon map (a luma.gl `GPUCommandGraph` on WebGPU, a CPU twin in a worker on WebGL2). Open a station to see where the camera stood, what the solver made of it and how far the photo's skyline sits from the DEM horizon.

The examples resolve `@luma.gl/*` and `@deck.gl/*` from this repository's vendored tarballs (`vendor/`), so run them from this repository (after `npm install` at the root); they are not meant to be copied out on their own.

Run `npm start` from this folder, or `node scripts/examples.mjs start deck/landeskarte` from the repository root. Select the backend with `?backend=webgpu` or `?backend=webgl`; without a query the example uses WebGPU when an adapter is available and WebGL2 otherwise. Other query flags: `?mode=plan|panorama`, `?t=HH:MM` (CEST wall clock, freezes the capture, no reveal), `?reveal=off`.

## How it works

### The experience

One canvas, one sheet, one clock. Nothing is scripted and the wheel always scrolls the page; the canvas takes `touch-action: pan-y`, a pointer drag pans the plan or looks around the panorama, and the arrow keys do the same when the canvas has focus.

- **Plan.** A perspective camera 40 km up with an 8 degree lens, looking straight down, so it reads flat. Light is fixed at NW 315 degrees and there is no cast shadow (the legend says so).
- **Panorama.** The same view class, flown by an app-driven rAF flight (`views/flight.ts`: eye interpolated in log altitude, yaw the short way round, the last frame is the target itself) to the lens of photo `demo-01`: yaw 260.72, pitch -3.525, roll -2.413, vertical field of view 52.11 degrees, the eye at the photo's EXIF position. `diagnostics.pose` is the exact final pose.
- **Light.** The time ruler (05:00 to 20:00 CEST, with the 15:28 to 15:48 window magnified 12 times and the twelve photo ticks at their true times) drives the sun, the cast shadows, the sky and the grade.
- **Stations.** Hover or click one of the twelve open triangles: the view wedge at the solved yaw and field of view, a Feldbuch ray labelled with its bearing, and a Wegweiser plate with the time, the solved heading, the EXIF compass delta and the solver confidence. Poses below 0.7 confidence draw dimmed. The text says "solved", never "verified".
- **Numbers.** A closed drawer: the clicked summit's distance, bearing, elevation angle and curvature drop `(1 - k) d^2 / 2R` (37.7 m at 23.5 km), the refraction slider k, the sun's azimuth, elevation and air mass, and the sun hours with first and last light of the ground under the cursor. A second drawer, "Beweis", shows the backend, the compute path, per-node GPU milliseconds and the GPU against CPU-twin parity, with a button that runs the comparison.

### Relief and ink

`TerrainLayer` (`terrain/terrain-layer.ts`) is a custom deck.gl `Layer` with WGSL and GLSL shaders, ported from the summit-view example: one instanced draw of a 129 by 129 grid per Terrarium DEM tile, the 512 px tile bytes decoded in the vertex shader from an `rgba8unorm` 2d-array texture. The fragment shader re-reads the DEM bilinearly, so contours do not depend on the 4 pixel mesh, and composes small pure snippets that exist twice, as WGSL and GLSL:

- `lk_relief`: Imhof-style multidirectional relief (four lights from 225 to 360 degrees, NW weighted 1.6) and a hypsometric tint from our own palette (`terrain/lut.ts`, the same stops draw the legend key).
- `lk_ink`, `lk_scree`, `lk_hachure`: three-ink contours (100 m index, 20 m minor, thinned by `fwidth` so they never moiré), scree stipple and rock stripes by slope belt. Derivatives are computed before any branch and passed in as arguments.
- `lk_grade`, `lk_atmosphere`: the panorama's signed `n.l` cool/warm grade, sun colour from the air mass, cast shadow and sky-view ambient from the shadow field, and analytic single-scatter aerial perspective (Rayleigh and Mie, `geo/atmosphere.ts` holds the same numbers for the CPU). The shaders say "physically inspired single scatter", not more.

The sky (`layers/sky-layer.ts`) is a full-screen layer drawn first that rebuilds each pixel's view ray from the camera basis, so it follows the roll-capable view exactly; in plan it is the paper. The optional Nebelmeer (`layers/nebelmeer-layer.ts`, off by default) is an analytic translucent slab at the lake level. It does not use luma's `heightFog` module, which fogs surfaces by their own height and has no slab geometry, so no `heightFog` notice applies.

One curvature convention everywhere: `up = elevation - (1 - k) (e^2 + n^2) / 2R`, `R = 6371008.8`, `k = 0.13`. The same `1 - k` goes to the terrain, the Nebelmeer, the trails, the labels and the ring. With the flat/curved switch off, `k = 1`.

Labels, trails and stations are ordinary deck.gl `TextLayer`, `PathLayer`, `LineLayer` and `ScatterplotLayer` layers. Names and markers live in a second pixel-space `OrthographicView` selected by a `layerFilter` on the `screen-` id prefix, positioned by a CPU mirror of the viewport (`projectToScreen`, agreeing with deck's `viewport.project` to 2e-13 px). Trails are draped on the loaded DEM in world metres. Everything on the page around the canvas (neatline, LV95 graticule ticks, scale bar from the camera's metres per pixel, a legend that lists only what is drawn, north arrow, imprint, the ruler) is DOM and SVG.

### The light pipeline

Two graphs share one z11 Terrarium mosaic (7 by 7 tiles, 94 km wide) centred on the summit.

- **Ring** (WebGPU): `decode-terrarium`, then `march-horizon` (2048 azimuth bins, 5 m to 45 km from the summit eye, `(h - h_eye) / d - d (1 - k) / 2R`), then `peak-visibility` (one thread per peak). Its output feeds the label visibility (names are only placed where the summit clears the skyline) and the optional skyline overlay.
- **Shadow** (WebGPU): `decode-terrarium` over a 1024 by 1024 window (26.8 km), then `horizon-map`: 16 azimuths by 256 geometric samples from 26 m to 12 km, u16 angles over [-0.25, pi/2] rad, 33.5 MiB, one azimuth per dispatch with an awaited submit in between so no single submit runs long. On every sun change `shade-at-time` looks up and interpolates the horizon between azimuths, applies a smoothstep penumbra of 0.27 degrees and writes a byte buffer that is copied to an `r8unorm` texture (the buffer row pitch is 256 bytes). `ambient-field` (sky-view factor) runs once. `sun-hours` accumulates the 288 five-minute table steps in f32 and is read back once for the cursor read-out.
- **CPU twin** (WebGL2, no compute): the same 16 by 256 horizon map at 256 by 256 texels (stride 4) in a worker, with `Math.fround` in the kernel's operation order, then the same shade on every `setSun`, written with `texture.writeData`. The twin is also the checkable specification of the kernels: `checks/parity.check.ts` compares it to a direct double-precision march.
- **One consumer.** The terrain fragment shader only ever samples a `ShadowField` (shadow plus ambient), whichever side filled it, so it never branches on the backend. If compute fails the field is null and the terrain draws without cast shadow.

Each kernel has its own source string (no override constants) and binds at most six storage buffers. The horizon map bakes k = 0.13; the refraction slider re-runs the ring but not the shadow map.

### Math

- Sun: NOAA/Meeus solar position with Bennett refraction, no elevation clamp; direct sun colour from Kasten-Young air mass. The sun table is 288 five-minute samples; the ruler works in UTC minutes from 2026-09-07T00:00Z and shows CEST.
- Frame: local east/north/up metres at the summit eye from small-angle polynomials of the offsets on the WGS84 radii of curvature (`geo/geodesy.ts`); `geo/lv95.ts` is the swisstopo approximate Swiss grid formula for the graticule.
- Shadow test: a cell is lit when the sun's elevation clears the horizon angle `atan(max_i (h(p + d_i u) - h(p)) / d_i - d_i (1 - k) / 2R)` in the sun's azimuth, smoothed over +-0.27 degrees.

## Verification

What was run, and what was not. Nothing here is a claim about other machines or GPUs.

- Static: `npx tsc --noEmit -p examples/deck/landeskarte`, `npx biome check --write` on every source file, `node scripts/ci/spdx.mjs`.
- CPU checks, `node examples/deck/landeskarte/scripts/run-checks.mjs`: 12 of 12 pass. Selected numbers: the sun against an independent Meeus formulation, max azimuth difference 0.029 deg and elevation 0.009 deg over 768 instants, and the repository's reference values to 0.005 deg; sunset 19:59 CEST. The CPU ring twin against a double-precision march, max 7.7e-6 deg over 2048 bins. The horizon-map twin against a double-precision march, max 2.9e-5 rad (one quantisation step is 2.8e-5 rad). `sampleHeight` against an analytic terrain, 0.06 m. The CPU viewport mirror against deck's `project`, 2.4e-13 px. The label placer: no overlaps and no leader crossings over a 24-yaw sweep (374 names, 3073 pairs).
- Browser, `node scripts/gpu/with-render-lock.mjs -- node examples/deck/landeskarte/scripts/visual-smoke.mjs` (the smoke test): @@SMOKE@@

### Photo skylines

Each of the twelve photos carries two skylines baked as world directions through its solved pose (`data/photo-skylines.json`, geometry only, no pixels): the boundary of a neural sky segmentation (U2-Net-P, MIT, xiongzhu666/Sky-Segmentation-and-Post-processing, run offline with onnxruntime-web, with MediaPipe selfie_multiclass_256 masks, Apache-2.0, used only to drop columns that touch a person) and Rigi's classical colour-model detector as the secondary line. The "Skyline (ML)" layer draws them on the panorama; selecting a station adds the station's median and 90th percentile residual against the ring's DEM horizon to its Wegweiser plate. `checks/skyline.check.ts` measures them offline, the median of |photo skyline - DEM horizon| in degrees (solved poses, so this is agreement with the solver, not independent ground truth):

| Photo | confidence | ML - DEM median (p90) | classical - DEM median (p90) |
|---|---|---|---|
| demo-01 | 0.81 | 0.120 (0.59) | 0.130 (0.35) |
| demo-02 | 1.00 | 0.335 (0.61) | 0.189 (1.19) |
| demo-03 | 0.89 | 0.265 (1.32) | 0.167 (0.32) |
| demo-04 | 0.79 | 0.131 (0.62) | 0.194 (6.92) |
| demo-05 | 1.00 | 0.071 (0.32) | 0.093 (0.50) |
| demo-06 | 0.71 | 0.106 (0.24) | 0.157 (0.34) |
| demo-07 | 0.67 | 0.691 (3.36) | 0.473 (1.02) |
| demo-08 | 0.63 | 0.430 (2.53) | 0.401 (2.36) |
| demo-09 | 1.00 | 0.150 (1.98) | 0.157 (0.77) |
| demo-10 | 1.00 | 0.320 (1.19) | 0.112 (0.35) |
| demo-11 | 0.84 | 0.360 (1.17) | 0.353 (0.98) |
| demo-12 | 0.97 | 0.334 (1.10) | 0.350 (1.06) |

The check asserts that among photos with confidence at least 0.7 the worst ML median stays under 1 degree (it is 0.36). The two photos below 0.7 confidence are the two with the largest residuals, which is what a pose error should look like.

## Upstream notes

- `Deck.pickObject` throws "not implemented" on WebGPU; the example uses `pickObjectAsync` only. On both backends `pickObjectAsync` logs "Async pick readback returned only zero alpha values", and the hit and miss results are still correct.
- Copying a storage buffer into an `r8unorm` texture needs a 256-byte row pitch, and a render target needs `Texture.COPY_SRC` to be read back. `texture.readDataAsync` is deprecated and throws; `texture.readBuffer(...)` then `buffer.readAsync()` works.
- deck.gl's built-in view-state transitions could not be observed on a custom `View` with array props in our probe, so the lift is an app-driven rAF flight that sets the view state each frame.
- `ScatterplotLayer` is a flat disc and invisible edge-on in a perspective view at zero pitch; the example draws its markers in the pixel-space view instead.
- A custom `View` whose `ControllerType` throws needs `controller: false` on the `Deck`; input goes through `views/orbit-controls.ts` so the wheel is never captured.
- luma's `heightFog` module is exported and has no slab geometry; it is not used (see the Nebelmeer above).

## Known limits

- The summit eye is the photo's EXIF position, 45 m below the DEM at the Niederhorn top, so terrain within the 80 m near plane is clipped.
- Tile layers are capped at 256 (the WebGPU array-layer limit): after much panning or looking around the nearest, newest tiles are the ones that may not draw.
- The panorama look-around ignores roll, and the horizon map bakes k = 0.13.
- Snapshot saves the canvas only, not the DOM furniture.
- Station coordinates are the solver's, rounded to 6 decimals; publishing per-photo coordinates is a decision for whoever publishes this.

## Packages

`package.json` lists the versions this example is written against: deck.gl 9.4.0-beta.4, luma.gl 10.0.0-alpha.2 and math.gl 5 alpha. Inside the Rigi repository they resolve to the root install, which vendors those versions. The Vite config adds no source aliases and the example imports only public `@luma.gl/*` and `@deck.gl/*` API.

## Data and licences

- **Terrain**: [Mapterhorn](https://mapterhorn.com) Terrarium WebP tiles (`https://tiles.mapterhorn.com/{z}/{x}/{y}.webp`), mainly swisstopo swissALTI3D (Swiss OGD) and Copernicus GLO-30 here; see [mapterhorn.com/attribution](https://mapterhorn.com/attribution). Credit: (c) Mapterhorn.
- **Summits and trails**: OpenStreetMap contributors, available under the [ODbL](https://www.openstreetmap.org/copyright). `data/peaks-niederhorn.json` and `data/trails-niederhorn.json` are derivative extracts and are offered under the ODbL.
- **Stations and skylines**: pose-solver output on photos taken by the project author on 2026-09-07, geometry only. No photo pixel ships. Solved poses are not ground truth.
- **U2-Net-P** (sky segmentation): MIT, (c) xiongzhu666, from Sky-Segmentation-and-Post-processing; used offline to bake `data/photo-skylines.json`. MediaPipe selfie_multiclass_256: Apache-2.0, Google, masks only used to drop columns.
- **Fonts**: Fira Sans, Fira Sans Condensed and Fira Mono (SIL OFL 1.1, The Mozilla Foundation and Telefonica S.A.), Source Serif 4 (SIL OFL 1.1, Adobe), loaded from Google Fonts with a system fallback stack.
- **Palette**: the ink, contour, water, rock, peak and Wegweiser colours follow the Brezine colour chart roles, with `#bf2233` kept as the single accent for the selected state.
- Code: MIT, (c) Rigi contributors.
