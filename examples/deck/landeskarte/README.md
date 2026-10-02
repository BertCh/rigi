<!-- Rigi -->
<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: Copyright (c) Rigi contributors -->

# Landeskarte Abendlicht

The Niederhorn above Lake Thun as a Swiss Landeskarte sheet that lifts into a summit panorama, where the real sun of 7 September 2026 moves across the relief and casts shadows as you drag the time ruler.

The panorama's last frame is the solved camera pose of a photo taken there. The cast shadows come from a horizon map computed by a luma.gl `GPUCommandGraph` on WebGPU, or by a CPU twin in a worker on WebGL2. Open a station to see where the camera stood, what the solver made of it and how far the photo's skyline sits from the DEM horizon.

The examples resolve `@luma.gl/*` and `@deck.gl/*` from this repository's vendored tarballs (`vendor/`), so run them from this repository (after `npm install` at the root); they are not meant to be copied out on their own.

Run `npm start` from this folder, or `node scripts/examples.mjs start deck/landeskarte` from the repository root. Select the backend with `?backend=webgpu` or `?backend=webgl`; without a query the example uses WebGPU when an adapter is available and WebGL2 otherwise. Other query flags: `?mode=plan|panorama`, `?t=HH:MM` (CEST wall clock, freezes the capture, no reveal), `?reveal=off`.

The gallery thumbnail (`thumbnail.jpg`, 480 by 320, the plan sheet with the Mapterhorn credit in frame) is rendered by `scripts/make-thumbnail.mjs` under the render lock; it is not committed yet and has to be regenerated and checked in before the gallery card shows an image.

## Scene API

`createLandeskarteScene(parent, options)` (`app.ts`) builds the scene in `parent` and returns it; `main.ts` also stores it on `window.landeskarteScene` for the smoke test.

- Options: the usual luma/deck device options (`backend`, canvas and device props, see `deck-example-device.ts`), plus `mode` (`'plan'` or `'panorama'`), `minutes` (UTC minutes since 2026-09-07T00:00Z), `reveal` (play the load reveal; off under webdriver and reduced motion), `onUpdate(diagnostics)` after each redraw, and three additions to the example contract: `controlsHost` and `drawersHost` (DOM hosts for the ruler, the layer switches and the two drawers; without them the scene is headless) and `onStatus(text)` (loading status lines).
- Returned: `deck`, `ready` (resolves when the first sheet is drawn, the reveal has started and the horizon map, shaded field and skyline ring have settled or a 120 s bound passed), `diagnostics`, `waitForFrame()`, `setMode(mode)` (resolves after the flight's last frame; a flight that is superseded or finalized resolves too), `setMinutes(utcMinutes)`, `setRefraction(k)`, `selectStation(id | null)`, `setLayer(name, on)`, `runParity()`, `snapshot()` (PNG `Blob` of the canvas; several calls may be pending) and `finalize()` (idempotent; settles every pending promise).
- Diagnostics, read by the smoke test: `frames`, `backend` (`'webgpu'`, `'webgl'` or `''`), `error`, `finalized`, `tilesRequested`, `tilesLoaded`, `tilesFailed`, `computeBackend` (`'graph'`, `'cpu-twin'` or `'none'`), `shadowPasses`, `graphNodeMs`, `parity` (a `ParityReport`, with the sun-hours and ring comparisons in `sunHours` and `ring` on WebGPU), `labelsPlaced`, `stationsLoaded`, `revealDone`, and beyond the spec's list `mode`, `minutes`, `sunAzimuth`, `sunElevation` and `pose` (the exact final pose of the last flight).

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

Only the tiles of the current view's quadtree selection are drawn, sorted by zoom, x and y so the draw order never depends on network arrival; while part of a new selection is still loading the previous tiles stay for at most 4 s, which can briefly overlap two zoom levels. The selection is made again when the canvas aspect changes. Labels, trails and stations are ordinary deck.gl `TextLayer`, `PathLayer`, `LineLayer` and `ScatterplotLayer` layers. Names and markers live in a second pixel-space `OrthographicView` selected by a `layerFilter` on the `screen-` id prefix, positioned by a CPU mirror of the viewport (`projectToScreen`, agreeing with deck's `viewport.project` to 2e-13 px). Trails are draped on the loaded DEM in world metres. deck.gl's `pixels` width units are one world unit per pixel in a perspective view, so trail widths are metres scaled by the distance from the eye (a width of n px at distance d is n times 2 tan(vfov / 2) / height times d). Everything on the page around the canvas (neatline, LV95 graticule ticks, scale bar from the camera's metres per pixel, a legend that lists only what is drawn, north arrow, imprint, the ruler) is DOM and SVG.

### The light pipeline

Two graphs share one z11 Terrarium mosaic (7 by 7 tiles, 94 km wide) centred on the summit.

- **Ring** (WebGPU): `decode-terrarium`, then `march-horizon` (2048 azimuth bins, 5 m to 45 km from the summit eye, `(h - h_eye) / d - d (1 - k) / 2R`), then `peak-visibility` (one thread per peak). The eye is the DEM plus 1.6 m (the photo's lens sits 45 m below the DEM at the Niederhorn top, so a ring from the lens itself would be blocked by the ground at its feet). Its output feeds the label visibility (names are only placed where the summit clears the skyline) and the optional skyline overlay.
- **Shadow** (WebGPU): `decode-terrarium` over a 1024 by 1024 window (26.8 km), then `horizon-map`: 16 azimuths by 256 geometric samples from 26 m to 12 km, u16 angles over [-0.25, pi/2] rad, 33.5 MiB, one azimuth per dispatch with an awaited submit in between so no single submit runs long. On every sun change `shade-at-time` looks up and interpolates the horizon between azimuths, applies a smoothstep penumbra of 0.27 degrees and writes a byte buffer that is copied to an `r8unorm` texture (the buffer row pitch is 256 bytes). `ambient-field` (sky-view factor) runs once. `sun-hours` accumulates the 288 five-minute table steps in f32 and is read back once for the cursor read-out.
- **Shadow field in use.** The field is only drawn after its first shade at the real sun, so the kernel's placeholder sun (-10 degrees, everything shadowed) never shows.
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
- Browser, `node scripts/gpu/with-render-lock.mjs -- node examples/deck/landeskarte/scripts/visual-smoke.mjs` (the smoke test): ran during integration on one Apple-silicon Mac (headless Chromium, Metal). It was **not** re-run to completion after the last edits (a render freeze began): in two later runs the frozen-capture check (two screenshots of an idle `?t=` scene must be byte-identical) failed on WebGPU with about 687 differing pixels, at most 18 of 255, in the mid-distance terrain band, and the cause is not found. The numbers below come from the last run in which every check passed, on both backends, with 164 of 164 DEM tiles loaded and 0 failed. Treat them as measured once, not as a standing guarantee, and the frozen-capture determinism as unverified.

  | | WebGPU | WebGL2 |
  |---|---|---|
  | compute path | graph | CPU twin |
  | plan sheet | contour ink 20 308 px, no route red until a station is selected | contour ink 19 861 px, same |
  | selection | 436 route-red px | 299 route-red px |
  | lift | ends 0.000 m from the summit frame, roll -2.413 deg | same |
  | Stockhorn label | 0.00 px from the CPU projection | 0.00 px |
  | shadowed fraction of the terrain band | 0.040 at 11:00 UTC, 0.756 at 17:45 UTC | 0.036, 0.753 |
  | colour of the lit pixels (R/B) | 0.961 at 11:00 UTC, 1.073 at 16:30 UTC | 0.954, 1.073 |
  | frozen `?t=` capture | byte-identical twice | byte-identical twice |

  Across backends the 15:28 CEST panorama differs by a mean 3.25 of 255 per channel, and all 12 common labels sit at the same pixel. The default backend falls back to WebGL2 when `navigator.gpu` is absent.

  GPU horizon map against the CPU twin (window 256 by 256 texels, 16 azimuths, 1 048 576 angles): the largest difference is 6.4e-3 deg (one quantisation step is 1.6e-3 deg), 1 angle is over the 0.005 deg tolerance, 1 043 336 are bit-identical, and 0 shadow bits flip. The one outlier is most likely a sample on a texel edge that rounds to the neighbouring texel in f32 on one side only; this has not been confirmed, and the smoke test allows 1 in 10^5. The GPU skyline ring against its CPU twin differs by at most 1.6e-5 deg over 2048 bins. The GPU run takes 0.28 s and the twin 6.7 s in a worker.
  Three of the smoke heuristics were wrong for this look and were changed: the sky is a real blue and the terrain a pale map tone, so the sky need not be brighter (it must be a smooth, distinct tone); the sun's colour is read from the brightest quarter of the terrain rows at 16:30 UTC, because at 17:45 UTC the sun is 2 degrees up behind the hills and the panorama is almost all shade; and the Stockhorn is the nearest of the three OSM summits with that name.
  Not measured: per-node GPU milliseconds (headless Chromium offered no `timestamp-query`, so the proof drawer shows none), other GPUs and browsers, frame rates, and phone behaviour.

### Photo skylines

Baking cannot be reproduced from this repository alone: `scripts/bake-skylines.mjs` reads the private demo photos (`public/demo/photos/demo-NN.jpg`), the solved-pose JSON (`public/demo/gipfelbuch/`), the people masks and the U2-Net-P ONNX model in `public/models/` (the file name carries a hash; run the script from the repository root with `onnxruntime-web` and `@napi-rs/canvas` installed). `data/photo-skylines.json` is shipped as-is and the script is provenance, not a build step.

Each of the twelve photos carries two skylines baked as world directions through its solved pose (`data/photo-skylines.json`, geometry only, no pixels): the boundary of a neural sky segmentation (U2-Net-P, MIT, xiongzhu666/Sky-Segmentation-and-Post-processing, run offline with onnxruntime-web (the baking script needs the private demo photos and the model weights, see below), with MediaPipe selfie_multiclass_256 masks, Apache-2.0, used only to drop columns that touch a person) and Rigi's classical colour-model detector as the secondary line. The "Skyline (ML)" layer draws them on the panorama; selecting a station adds the station's median and 90th percentile residual against the ring's DEM horizon to its Wegweiser plate. `checks/skyline.check.ts` measures them offline, the median of |photo skyline - DEM horizon| in degrees (solved poses, so this is agreement with the solver, not independent ground truth):

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

The check asserts that among photos with confidence at least 0.7 the worst ML median stays under 1 degree (it is 0.36). The two photos below 0.7 confidence have the two largest median residuals (p90 is not ordered the same way: demo-04 classical is 6.92 at confidence 0.79). This is agreement between the photo's skyline and the solver's pose, not independent evidence of a pose error.

## Upstream notes

- `Deck.pickObject` throws "not implemented" on WebGPU; the example uses `pickObjectAsync` only. On both backends `pickObjectAsync` logs "Async pick readback returned only zero alpha values", and the hit and miss results are still correct.
- Copying a storage buffer into an `r8unorm` texture needs a 256-byte row pitch, and a render target needs `Texture.COPY_SRC` to be read back. `texture.readDataAsync` is deprecated and throws; `texture.readBuffer(...)` then `buffer.readAsync()` works.
- deck.gl's built-in view-state transitions could not be observed on a custom `View` with array props in our probe, so the lift is an app-driven rAF flight that sets the view state each frame.
- `ScatterplotLayer` is a flat disc and invisible edge-on in a perspective view at zero pitch; the example draws its markers in the pixel-space view instead.
- deck's `parameters` on a layer are applied over its models' own, so the sky dome needs `parameters: {depthCompare: 'always', depthWriteEnabled: false}` as a layer prop or it writes depth and hides the terrain.
- In a perspective viewport `widthUnits: 'pixels'` is not pixels (scale 1, see above); use metres and scale them.
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

- **Terrain**: [Mapterhorn](https://mapterhorn.com) Terrarium WebP tiles (`https://tiles.mapterhorn.com/{z}/{x}/{y}.webp`; the Terrarium elevation encoding, `R * 256 + G + B / 256 - 32768` m, was defined by Mapzen's terrain tiles), mainly swisstopo swissALTI3D (Swiss Open Government Data, credit "swisstopo") and Copernicus GLO-30 here; see [mapterhorn.com/attribution](https://mapterhorn.com/attribution). Credit in the page: (c) Mapterhorn. Copernicus notice, to be kept with the data: "(c) DLR e.V. 2010-2014 and (c) Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved". Check the Mapterhorn attribution page for the current wording before publishing.
- **Summits and trails**: OpenStreetMap contributors, available under the [ODbL](https://www.openstreetmap.org/copyright). `data/peaks-niederhorn.json` and `data/trails-niederhorn.json` are derivative extracts and are offered under the ODbL.
- **Stations and skylines**: pose-solver output on photos taken by the project author on 2026-09-07, geometry only. No photo pixel ships. Solved poses are not ground truth.
- **U2-Net-P** (sky segmentation): the architecture and original weights are U2-Net by Qin et al. ([xuebinqin/U-2-Net](https://github.com/xuebinqin/U-2-Net), Apache-2.0); the converted model comes from xiongzhu666/Sky-Segmentation-and-Post-processing (MIT, (c) xiongzhu666). The weights are not part of this example's files (they sit in `public/models/` of the Rigi repository); each notice stays with the file. Used offline to bake `data/photo-skylines.json`. MediaPipe selfie_multiclass_256: Apache-2.0, Google, masks only used to drop columns.
- **Fonts**: Fira Sans, Fira Sans Condensed and Fira Mono (SIL OFL 1.1, The Mozilla Foundation and Telefonica S.A.), Source Serif 4 (SIL OFL 1.1, Adobe), loaded from Google Fonts with a system fallback stack.
- **Palette**: the ink, contour, water, rock, peak and Wegweiser colours take their role-to-colour assignments from the Brezine colour chart as recorded in the Rigi repository (`src/brand/khipu.ts`); no artwork or data of the chart is copied, and I did not verify a public source link or its licence. `#bf2233` is kept as the single accent for the selected state.
- Code: MIT, (c) Rigi contributors.
