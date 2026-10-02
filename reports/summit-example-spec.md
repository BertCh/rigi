<!-- Rigi -->
<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: Copyright (c) Rigi contributors -->

# Build spec: examples/deck/landeskarte (Landeskarte Abendlicht)

*2026-10-01. Output of the spec-synthesizer stage. Read-only inputs: seven surveys, six concepts, three judge panels. Nothing here is built or measured. Every number marked "target" is a bound to assert, not an observation.*

## 0. Decision

Judge totals (4 criteria x up to 10; design + luma/deck showcase + feasibility + emotional fit):

| Concept | Total |
|---|---|
| Landeskarte Abendlicht (winner) | 33.0 |
| Niederhorn, 7 September (time-scrubbable day) | 29.5 |
| Sonnenstand (compute light engine) | 28.0 |
| Landeskarte Niederhorn (tilting sheet) | 26.5 |
| Niederhorn Atlas (globe to summit) | 20.5 |
| Concordance Field | 18.0 |

Winner: **Abendlicht**. Folder: `examples/deck/landeskarte`. Id `deck/landeskarte`, factory `createLandeskarteScene`, global `window.landeskarteScene`, env prefix `LANDESKARTE_`.

Grafted from the runners-up (all cheap, none changes the hero):
- From *Niederhorn day*: non-linear time ruler with a "Gipfelrast" bracket and photo ticks at true takenAt, `?t=HH:MM` freeze hook, keyboard scrub with aria-valuetext, Wegweiser plate, thin-space thousands. Not taken: scroll-mapped clock (scroll trap), reconstructed ascent route with Naismith timing, multi-photo drape atlas.
- From *Sonnenstand*: one shared horizon-map precompute, so scrubbing time is an O(1) lookup; sun-hours cursor read-out; parity panel with "Run CPU twin"; sizing the map under the 128 MiB binding limit before any shader is written; integer kernels must match exactly.
- From *Landeskarte Niederhorn*: reveal order on load (paper, relief, contours, labels in tier order), Feldbuch rays with bearing labelled along the ray, index-contour labels that break the line. Not taken: ortho-to-perspective projection lerp (untested on WebGPU); we use a narrow-FOV perspective at altitude as "plan" and fly the same view class instead.
- From *Atlas*: first-wave feasibility probes under the render lock, a tiny backend/feature badge, custom Widget-free DOM controls (no @deck.gl/widgets in the vendored build).
- From *Concordance*: BAKED/LIVE tag on every data layer in the legend (one line each).

## 1. Meta-analysis (what the app and domain give us)

- **Stack.** Rigi is Vite + React + TanStack Start on vendored luma.gl `10.0.0-alpha.2-rigi.2` and deck.gl `9.4.0-beta.4` (core + layers only: no widgets, geo-layers, extensions). WebGPU default, WebGL2 fallback. An example may import only public `@luma.gl/*` and `@deck.gl/*`, never `src/`; the app's own renderer (`src/lib/deck-webgpu`) is therefore a reference to port from, not to import.
- **Contract.** `scripts/examples.mjs` treats any dir with `package.json` as an example. Required: README (title + first paragraph become the gallery card), `app.ts` factory returning `{deck, ready, diagnostics, waitForFrame, finalize}`, `main.ts`, `index.html`, `style.css`, `mobile-support.ts`, `package.json`, `tsconfig.json`, `vite.config.ts`, `thumbnail.jpg` (open map data only, never a photo), `scripts/visual-smoke.mjs`. Style is luma (2 spaces, single quotes, no trailing commas, 100 columns). SPDX headers on every file. CI runs only `examples.mjs check` (tsc) and the site build; browser smoke is manual under the render lock.
- **Proven pieces to copy and adapt (Rigi MIT):** `summit-view` (Terrarium instanced terrain Layer with WGSL+GLSL, `dem-tiles.ts` quadtree and CPU mirror, roll-capable `SummitView`, two-view `layerFilter` with `screen-` prefix, labels with DEM-march occlusion); `photo-drape` (Effect.preRender offscreen pass, roll OrbitView, LinearInterpolator flight, exact frame at flight end); `horizon-graph` (GPUCommandGraph: decode Terrarium, 2048-bin march, GPUReduction, inspector + timestamps, `Math.fround` twin, `opaque()` guard, 9.3e-6 deg measured against a 1e-3 deg bound). Shared luma-owned files (`deck-example-device.ts`, `example-support.ts`, `example-infobox.css`, `example-theme.ts`) keep their headers and are imported by relative path.
- **Data.** `public/demo`: 12 photos (2048x1536 or portrait), taken 2026-09-07 13:28:04Z to 13:48:08Z (15:28 to 15:48 CEST, GPS time), all at the summit (46.7100 to 46.7108 N, 7.7732 to 7.7747 E, 1918 to 1942 m). Solved poses in `manifest.json` (`source: 'solved'`, confidence 0.63 to 1.0). demo-01 solved pose: yaw 260.72, pitch -3.525, roll -2.413, vfov 52.11, 4:3. The EXIF heading is off by up to 19 deg, so use solved poses only. demo-09 EXIF altitude 1183 m is wrong; its eye is 1935.4 m. There is **no GPX**: the EXIF cluster is a 20 minute summit stay. `trails.json` is 2.7 MB of region-wide OSM ways (`{sac, name, coords:[[lon,lat]]}`); `manifest.region.peaks` has 2637 OSM peaks.
- **Domain rules already settled in the repo** (design book, terroir report, user feedback): Imhof NW light 315/45 with no cast shadows in plan relief; three-ink contours (brown, black, blue); Brezine palette roles with red as the single accent; true furniture only; minimal strokes (no card outlines, no coloured shadows); no wheel capture and `touch-action: pan-y`; no tours or wizards; label floor 11 px; the Berann palette is copyrighted, so derive our own.
- **Constraints that shape the design.** Deck on WebGPU has no WGSL shader hooks, broken `View clear`, hard-coded `clearDepth 1` and less-equal, forced premultiplied blend, `pickAsync` only, and last-write-wins uniforms per Model per submit. Perspective-view `pixels` units are wrong, so text goes in an ortho overlay view. `GPUCommandGraph` is experimental (both `compile` and `compileAsync` needed; hand-sized timestamp QuerySet; compute hash ignores entryPoint/constants outside rigi.2, so every kernel gets distinct source and no override constants). Metal fast-math forbids bit-parity claims for floats.
- **Environment.** Disk is 98% full (9.1 GiB free; ENOSPC seen in surveys). Tree is dirty (atlas to gipfelbuch rename uncommitted; clear-air, landing-perf, WAG wave 4 unverified). Bake only from `public/demo/manifest.json`, `trails.json` and `gipfelbuch/demo-NN.json` read paths; depend on no uncommitted app code.

## 2. Concept and experience

**One canvas, one sheet, one clock.** The Niederhorn (1963 m) above Thunersee as a Swiss Landeskarte sheet in plan, which lifts into a Berann-style panorama from the summit and carries the real light of 7 Sep 2026 from sunrise to sunset. It is a map you can scrub through the afternoon of the hike. The 12 photos appear only as geometry (open-triangle stations, view wedges, Feldbuch rays); no photo pixel ships.

Experience (not a tour: every control is optional and free-order; no scroll mapping; wheel always scrolls the page; canvas `touch-action: pan-y`; drag orbits/pans):

1. **Load / reveal.** Paper ground (`#f4f4f4` 90% + `#ffdb8b` 10%). Terrain streams nearest-first. Reveal order: relief fades up from flat paper, contours draw in, labels settle in tier order (areas, lines, points), furniture last. Frozen under `navigator.webdriver` and `prefers-reduced-motion`, and via `?reveal=off`.
2. **Plan sheet.** Imhof NW multi-azimuth relief, hypsometric LUT, three-ink contours (100 m index, 20 m minor, index labels break the line), slope-belt rock stripes and scree stipple, flat Thunersee at 558 m without contours, trails by SAC class, 12 stations. Legend states "Licht: NW 315 deg, kein Schatten".
3. **Lift.** One segmented control Plan | Panorama (also `?mode=`). The camera flies (deck `LinearInterpolator`) from 40 km up, vfov 8 deg, pitch -90, to the summit eye (46.7102 N, 7.7733 E, DEM + 1.6 m), yaw 260.72, pitch -3.525, roll -2.413, vfov 52.11. Shading crossfades to the panorama grade (signed n.l cool/warm cel palette, haze toward sky hue, bottom 22% darkened, cast shadows allowed). The flight ends exactly on the demo-01 frame (eye 0.00 m from target, roll -2.413). Labels hand over to Imhof panorama form: navy name + tabular altitude above the skyline, hairline leaders that never cross.
4. **Light.** Time ruler 05:00 to 20:00 CEST (non-linear: the 15:28 to 15:48 window magnified about 12x as a "Gipfelrast" bracket with 12 photo ticks). Dragging moves the sun (NOAA/Meeus), cast shadows from the GPU horizon map crawl over the flanks, the grade goes warm to cool, sky dome and aerial perspective follow. Cursor read-out: "Sonne 7 h 12 min, erstes Licht 08:41, letztes Licht 17:32" (from the sun-hours reduction). Alpenglow on Eiger/Moench/Jungfrau (az 130 to 143, 23 to 24 km) is a bonus of the lighting, not a scripted beat. Optional Nebelmeer (luma `heightFog`, base 558 m) toggle, off by default.
5. **Stations.** Hover/click (async pick) a station: wedge at solved yaw/vfov, Feldbuch ray labelled with bearing, Wegweiser plate (yellow, condensed) with takenAt in CEST, solved yaw vs EXIF-heading delta (demo-01 +9.29 deg, demo-09 -18.55 deg) and confidence. Dimmed style for confidence below 0.7 (demo-07, demo-08, demo-11). Text says "solved", never "verified".
6. **Numbers drawer (on demand).** Picked peak: haversine distance and bearing, elevation angle, curvature drop (1-k)d^2/2R (37.7 m at 23.5 km), k slider 0 to 0.20 with a flat / curved / refracted skyline toggle, sun az/el, optical depth. Plus the "proof" strip: GPU vs CPU-twin parity (max error in deg, count over tolerance), per-node GPU ms, backend badge. One toggle, closed by default.
7. **Furniture, always true.** Neatline with corner ticks, LV95 graticule ticks, scale bar from camera resolution, legend of drawn symbols only, one north arrow, Blatt box, Siegfried-style imprint (Aufnahme: Mapterhorn, swisstopo, OSM; Revision: luma graph; Stich: luma.gl + deck.gl), vertical-exaggeration caption in panorama (value 1.0, stated). Snapshot PNG button.

Look rules: Brezine roles only (ink `#131313`, contour brown `#95500c`, rock black `#2b2724`, water `#30626b` / `#3f7fb3`, route red `#bf2233` as the single accent, peak navy `#002f55`, Wegweiser `#ffdb8b`/`#e59e1f`). Fonts: Fira Sans (+ Condensed), Source Serif 4 title, Fira Mono tabular, via a Google Fonts `<link>` with a system fallback stack (offline renders with fallback, no bundling). No outlines around sections; space separates; no coloured shadows; jitter at most 0.9 px on furniture only, never on terrain.

## 3. Architecture

Single Deck on a luma device (`getDeckExampleProps`, `?backend=webgpu|webgl`), two Views with `layerFilter` (`screen-` prefix): custom roll-capable perspective `LandeskarteView` (plan and panorama are the same class, different view state) and an `OrthographicView` id `screen` for labels, markers and wedges. Local ENU metres (`COORDINATE_SYSTEM.CARTESIAN`) with origin at the summit eye. One curvature convention everywhere: `up = elev - (1-k)(e^2+n^2)/(2R)`, `R = 6371008.8`, `k = 0.13` (also change the horizon kernels from the horizon-graph example's 6 371 000).

**Light pipeline (the luma showpiece).**
- Graph R ("ring", WebGPU): `decode-terrarium` (shared) then `march-horizon` (2048 bins, 5 m to 45 km, 1513 samples, from the summit eye on the 7x7 z11 mosaic) then `peak-visibility` (one thread per peak) then GPUReduction extent. Output buffers feed the skyline ring overlay and label visibility.
- Graph S ("shadow", WebGPU): `decode-terrarium` window crop (1024 x 1024 px of the same mosaic, 26.8 km, centred on the summit) then `horizon-map` (16 azimuths x 256 geometric samples 26 m to 12 km, u16 angles, **33.5 MiB**, run one azimuth per dispatch across frames to avoid watchdog) then, on each sun change, `shade-at-time` (lookup + azimuth interpolation + smoothstep penumbra of 0.27 deg) writing a 1024^2 r8 field, copied to an `r8unorm` texture. Sun-hours: one `sun-hours` kernel accumulating over 288 five-minute steps into f32 (read once for the cursor map, 4 MiB).
- **Unified consumer:** the terrain fragment shader only ever samples a `ShadowField` texture (shadow, plus sky-view ambient in a second channel). WebGPU fills it from graph S; WebGL2 fills it from the CPU twin at 256^2 x 16 az, built once in a worker in chunks and cached, labelled "CPU twin" in the badge. Compute failure never breaks rendering: no field means "no cast shadow".
- 8 storage buffers per stage limit: each kernel binds at most 6 buffers. No override constants; each kernel has its own source string.

**Frozen interfaces (wave 0).** `types.ts` is written first by the integrator in a 30 minute step and then treated as read-only. It contains: `Frame`, `SunSample`, `Station`, `Peak`, `TrailWay`, `TerrainUniforms` (field order = WGSL struct order = GLSL std140 block order; vec3 members followed by explicit `pad` floats), `ShadowField`, `RingResult`, `Diagnostics`, `SceneOptions`, and the shader snippet names below. Agents never edit another agent's file; shared files are owned by the integrator only (`app.ts`, `main.ts`, `index.html`, `style.css`, `mobile-support.ts`, `package.json`, `tsconfig.json`, `vite.config.ts`, `types.ts`, README rows in `examples/README.md`, `NOTICE.md`, `.gitignore`).

Scaffold facts: `mobile-support.ts` is exactly one line per key in single quotes, `backends: ['webgpu', 'webgl2']`, `mobileMode: 'reduced'`, `mobileProfile: 'large-data'`. `tsconfig.json` `include: ['*.ts', '*/*.ts']`, `exclude: ['dist']` (subfolders silently escape tsc otherwise). No `package.json` in any subfolder. All `.ts`/`.mjs` carry `// Rigi` / `// SPDX-License-Identifier: MIT` / `// SPDX-FileCopyrightText: Copyright (c) Rigi contributors` (CSS block form; HTML comment form).

### Module list (20 owners; one file set per agent)

Common types referenced below live in `types.ts`. `ENU = [east, north, up]` metres from the summit origin, f64 on CPU.

**A0 integrator** (`app.ts`, `main.ts`, `index.html`, `style.css`, `mobile-support.ts`, `package.json`, `tsconfig.json`, `vite.config.ts`, `types.ts`, `README.md`, shared-file edits).
- `createLandeskarteScene(parent: HTMLDivElement, options?: DeckExampleDeviceOptions & {mode?: 'plan'|'panorama'; minutes?: number; reveal?: boolean}): LandeskarteScene` where `LandeskarteScene = {deck: Deck; ready: Promise<void>; diagnostics: Diagnostics; waitForFrame(): Promise<void>; setMode(m): Promise<void>; setMinutes(utcMinutes: number): void; setRefraction(k: number): void; selectStation(id: string|null): void; setLayer(name: LayerName, on: boolean): void; runParity(): Promise<ParityReport>; snapshot(): Promise<Blob>; finalize(): void}`. `finalize` idempotent. `Diagnostics = {frames; backend: 'webgpu'|'webgl'|''; error: string; finalized: boolean; tilesRequested; tilesLoaded; tilesFailed; computeBackend: 'graph'|'cpu-twin'|'none'; shadowPasses; graphNodeMs: Record<string,number>; parity: ParityReport|null; labelsPlaced; stationsLoaded; revealDone: boolean}`.
- `main.ts`: resolves backend, `#backend` select, `window.landeskarteScene`, `?t=HH:MM` (CEST) freeze, `pagehide` finalize, `body.dataset.ready = 'true' | 'unsupported'` (use `preflightExampleSupport` like horizon-graph for the WebGPU-less compute message, but rendering still starts on WebGL).

**A1 geodesy** (`geo/geodesy.ts`, `geo/lv95.ts`, `checks/geo.check.ts`).
- `EARTH_R = 6371008.8`, `REFRACTION_K = 0.13`, `makeFrame(lat, lon, h): Frame` with `toEnu(lat, lon, h): ENU`, `toGeo(enu): {lat; lon; h}`; `curvatureDrop(d: number, k = REFRACTION_K): number`; `geometricHorizon(h: number, k?): number`; `haversine(a, b): {distance: number; bearing: number}`; `elevationAngle(from: ENU, to: ENU, k?): number` (deg, curvature-corrected); `wgs84ToLv95(lat, lon, h?): {e: number; n: number}`, `lv95ToWgs84(e, n)`.
- Dependencies: none.

**A2 sun** (`geo/sun.ts`, `checks/sun.check.ts`).
- `sunPosition(date: Date, lat: number, lon: number): {azimuth: number; elevation: number}` (deg, azimuth clockwise from north, NOAA/Meeus, Bennett refraction, **no elevation clamp**); `sunDirection(az, el): ENU`; `sunColor(el): [number, number, number]` (Rayleigh+Mie air mass, Kasten-Young); `buildSunTable(dayUtcMs: number, lat, lon, stepMin = 5): SunSample[]` (288 entries for the day); `sunriseSunset(table): {rise: number; set: number}` as UTC minutes.

**A3 atmosphere CPU** (`geo/atmosphere.ts`, `checks/atmosphere.check.ts`).
- Constants `BETA_R0 = [5.8e-6, 13.5e-6, 33.1e-6]`, `BETA_M0 = 21e-6`, `H_R = 8000`, `H_M = 1200`, `MIE_G = 0.76`; `atmPath(h0, h1, L, H): number`; `transmittance(h0, h1, L, strength): [number, number, number]`; `applyAtmosphere(c, airlight, T)`; `cornetteShanks(cosT, g)`. Mirrors A9's shader constants; A9 imports the constants from here (`import {BETA_R0, ...}`).

**A4 data + bake** (`scripts/bake-data.mjs`, `data/scene-data.ts`, `data/load.ts`, `data/*.json` outputs).
- Bake clips and rounds (5 decimals) `public/demo/trails.json` to bbox 46.66..46.76 N, 7.70..7.85 E and `manifest.region.peaks` to peaks within line-of-sight candidates (ele above 1600 m or named in the NAME_TYPO list, at most 120), plus 12 stations from `manifest.photos` and `manifest.poses` (lat/lon rounded to 4 decimals, alt override demo-09 = 1935.4, summit eye rounded). Every JSON starts with `_licence` stamp (ODbL for OSM-derived; "poses are Rigi solver outputs, not verified"). Targets: trails-niederhorn.json at most 300 KB, peaks at most 40 KB, stations at most 10 KB.
- `scene-data.ts` exports `SUMMIT_EYE: {lat; lon; h: number}`, `LAKE_THUN_ELEVATION = 558`, `DAY_UTC_MS` (2026-09-07T00:00:00Z), `NIEDERHORN_BBOX`, `SUMMIT_FRAME_VIEW: {yaw: 260.72; pitch: -3.525; roll: -2.413; vfov: 52.11; aspect: 4/3}` (all with provenance comments).
- `load.ts`: `loadStations(): Promise<Station[]>`, `loadPeaks(): Promise<Peak[]>`, `loadTrails(): Promise<TrailWay[]>` (fetch via `new URL('./x.json', import.meta.url)`, try/catch, empty on failure).
- No photos, masks, skyline rows or splats are copied. Reads only `manifest.json`, `trails.json`.

**A5 DEM tiles** (`terrain/dem-tiles.ts`, `checks/dem.check.ts`).
- Adapted from summit-view. `selectTiles(frame: Frame, view: ViewPose, opts?): TileKey[]` (quadtree z14 near, z9 to 150 km, wedge cull, nearest first); `class TileStreamer {constructor(onTile, signal: AbortSignal); request(keys: TileKey[]): void; stats: {requested; loaded; failed}}` (6 concurrent, Mapterhorn `https://tiles.mapterhorn.com/{z}/{x}/{y}.webp`, 512 px); `decodeTerrarium(r, g, b): number`; `sampleHeight(tiles, enu: [number, number]): number | null` (CPU mirror, bilinear at pixel centres); `isVisible(from: ENU, to: ENU, tiles): boolean` (sight-line march with curvature, for label occlusion); `loadMosaic(zoom = 11, radiusTiles = 3): Promise<{width: number; height: number; heights: Float32Array; metersPerPixel: number; originEnu: [number, number]}>`.

**A6 terrain layer** (`terrain/terrain-layer.ts`, `terrain/terrain-module.ts`).
- `class TerrainLayer extends Layer<TerrainLayerProps>`; props `{id; tiles: LoadedTile[]; uniforms: TerrainUniforms; lut: Texture; shadowField: ShadowField | null; noise: Texture; revealProgress: number}`. One instanced indexed draw over a 129x129 grid plus skirt, rgba8unorm 2d-array atlas decoded in the vertex shader (`textureLoad`), curvature drop, own `WGSLShaderAssembler`, premultiplied output, explicit `indexCount`. `export const terrainModule: ShaderModule<TerrainUniforms>` with `uniformTypes` in the frozen order.
- A6 composes the fragment: computes `dpdx/dpdy` inputs (`fwidthElev`, `fwidthRange`) **before any branch**, then calls snippets `lk_relief`, `lk_hypso`, `lk_ink`, `lk_scree`, `lk_hachure`, `lk_atmosphere`, `lk_grade`. Lake mask where `elev <= lakeLevel + 0.5` and normal.z above 0.9999.

**A7 relief shading** (`terrain/relief.wgsl.ts`, `terrain/relief.glsl.ts`, `terrain/lut.ts`).
- Snippet strings exporting identical-signature functions: `lk_relief(normal: vec3, elevM: f32, rangeM: f32, panoramaMix: f32) -> vec4` (rgb tone, a = shade L) using reliefMdow (4 lights az 225+45i, alt 45, weight `(0.2+sin^2(aspect-az))`, x1.6 on the NW light, mix `0.55*smoothstep(0.05,0.4,slope)`, strength capped), aerial contrast `mix(0.78, hs, mix(0.55,1,smoothstep(600,3000,elev)))`, tone `mix(vec3(.62,.72,.98), vec3(1.05,1,.88), smoothstep(.25,1,L))`; `lk_hypso(elevM: f32, shade: f32) -> vec3`. `lut.ts`: `bakeHypsometricLut(device): Texture` (256 x 64 rgba8unorm, our own palette, flats handled by the caller) and `bakeBlueNoise(device, size = 64): Texture`.

**A8 ink** (`terrain/ink.wgsl.ts`, `terrain/ink.glsl.ts`).
- `lk_ink(elevM, fwidthElev, slope, aspect, shade, rangeM, isLake) -> vec4` (premultiplied; 100 m index heavy, 20 m minor, adaptive thinning from `fwidthElev` with `smoothstep` fades, three-ink class colour by elevation belts: brown soil, black rock above the rock belt 2450 m or slope above 40 deg, blue on ice/water; AA `1 - smoothstep(w/2, w/2+1, abs(fract(e-0.5)-0.5)/fwidth)`; no loops with break); `lk_scree(uv, tone, slope, noise)`; `lk_hachure(posEnu, aspect, slope, shade)` (45 deg stripes, 3 px shade / 5 px lit). Derivatives only as arguments.

**A9 atmosphere + grade shaders** (`terrain/atmo.wgsl.ts`, `terrain/atmo.glsl.ts`, `layers/sky-layer.ts`, `layers/sky.wgsl.ts`, `layers/sky.glsl.ts`).
- `lk_atmosphere(color: vec3, eye: vec3, frag: vec3, sunDir: vec3) -> vec3` (analytic path, same constants as A3); `lk_grade(color: vec3, nDotL: f32, shadow: f32, ambient: f32, sunColor: vec3, panoramaMix: f32) -> vec3` (plan mix 0: fixed NW light, no shadow term; panorama: signed n.l cel palette with complementary shade hue, haze hue toward sky, bottom-22% darken is a CSS-free in-shader term via `viewportY`). `class SkyLayer extends Layer` (full-screen, drawn first, Preetham-like gradient, aureole, warm low-sun band; props `{sunDir; sunColor; eye; modeMix}`). Labelled "physically inspired single scatter" in README.

**A10 ring graph** (`compute/mosaic.ts`, `compute/ring-graph.ts`, `compute/ring-shaders.ts`).
- `createRingGraph(device: Device, mosaic: Mosaic, peaks: Peak[], eye: Frame, opts?: {timestamps?: boolean}): RingGraph` with `RingGraph = {run(k: number, eyeHeight: number): Promise<RingResult>; inspectorRows(): NodeRow[]; destroy(): void}` and `RingResult = {tangents: Float32Array; elevationDeg: Float32Array; peakVisible: Uint32Array; peakMarginDeg: Float32Array}`. Reuses the horizon-graph recipe (`[d,1/d]` table, eye-relative heights, `opaque()` XOR guard, compile + compileAsync wrapper, inspector, timestamp QuerySet sized to node count, `Buffer.readAsync`). Shares the mosaic buffer handle with A11 via `getMosaicBuffer(): Buffer`.

**A11 shadow graph** (`compute/shadow-graph.ts`, `compute/shadow-shaders.ts`).
- `createShadowGraph(device: Device, mosaicBuffer: Buffer, mosaicInfo: MosaicInfo): ShadowGraph`; `ShadowGraph = {buildHorizonMap(onProgress?): Promise<void>; setSun(az: number, el: number, k: number): void; field: ShadowField; sunHours(table: SunSample[]): Promise<Float32Array>; inspectorRows(): NodeRow[]; destroy(): void}`. `ShadowField = {texture: Texture; sizeMeters: number; originEnu: [number, number]; backend: 'graph'|'cpu-twin'}` (r8 shadow in a 1024^2 texture plus ambient in a second r8 texture). Binds at most 6 buffers per kernel; angles are u16 quantised over -0.25..pi/2 rad (quantisation step stated in README).

**A12 CPU twins + parity** (`compute/cpu-twins.ts`, `compute/shadow-cpu.worker.ts`, `compute/parity.ts`, `checks/parity.check.ts`).
- `computeHorizonCpu(mosaic, eye, k, bins): Float32Array` (Math.fround in shader operation order, `opaque()` mirrored as identity with a comment); `computeHorizonMapCpu(mosaic, window, azimuths, samples): Uint16Array`; `shadeAtTimeCpu(map, az, el): Uint8Array`; `peakVisibilityCpu(...)`; `createCpuShadowField(device, mosaic): Promise<ShadowField>` (worker, 256^2 x 16 az, chunked, cached); `compareParity(gpu, cpu, toleranceDeg): ParityReport = {maxAbsDeg; overTolerance; bitIdentical; total; shadowFlips; flipsWithinUlpBand: boolean}`.

**A13 views and flight** (`views/landeskarte-view.ts`, `views/flight.ts`).
- `class LandeskarteView extends View` with viewport from SummitView (yaw, pitch, roll, vfov, eye ENU, near 80 m, far 200 km, standard-Z) and `controller: {scrollZoom: false, dragRotate: true, touchZoom: false}` semantics (custom handlers, wheel untouched). `getPlanPose(): ViewPose` (eye 40 km up, pitch -90, vfov 8); `getPanoramaPose(stationId?): ViewPose`; `flyTo(scene: LandeskarteView, from: ViewPose, to: ViewPose, ms: number): Transition` using `LinearInterpolator` over `['eye','yaw','pitch','roll','vfov']` with yaw unwrapped; `projectToScreen(pose, enu, size): [number, number, number] | null` (exact CPU mirror of the viewport used by labels and tests); `makeScreenView(): OrthographicView`; `layerFilter(args): boolean`.

**A14 sky and fog layers** are inside A9 for sky; fog is **A14** (`layers/nebelmeer-layer.ts`, `layers/nebelmeer.wgsl.ts`, `layers/nebelmeer.glsl.ts`): `class NebelmeerLayer extends Layer` (translucent slab or fragment term using the shadertools `heightFog` module via public module API; props `{baseHeight = 558; density; falloff; time; enabled}`; keeps the vis.gl notice). Optional toggle; default off. Cut if feasibility probe fails.

**A15 labels** (`overlay/labels.ts`, `overlay/typography.ts`, `checks/labels.check.ts`).
- `NAME_TYPO` tiers (peak-major 1.25x/700, peak 1.0x/600, minor 0.86x/500, lake 1.05 italic tracked), `placeLabels(input: {peaks: Peak[]; lakes: LakeLabel[]; project: (enu) => [number, number, number] | null; visible: (id: string) => boolean; viewport: {width: number; height: number}; minPx: 11}): PlacedLabel[]` (areas, then lines, then points; greedy rank-tiered declutter 1.14:1:0.88; upper-right preference; non-crossing leaders by azimuth sort), `toTextLayers(placed, mode): Layer[]` (ids prefixed `screen-`, TextLayer with sdf, `outlineWidth` as paper halo, `characterSet` set for umlauts, hairline leaders as LineLayer 0.6 px with a 1.5 px end dot, round dots). Visibility input comes from A10 `peakVisible` or A5 `isVisible`.

**A16 vector layers** (`overlay/trail-layer.ts`, `overlay/station-layer.ts`).
- `makeTrailLayers(trails: TrailWay[], mode): Layer[]` (cased tri-stripe blaze for `sac` mountain_hiking/alpine, yellow diamond style for hiking, thin grey dashes for the rest; red `#bf2233` only for the selected way; metre widths in plan, screen pixels in overlay), `makeStationLayers(stations, selectedId, project, mode): Layer[]` (open 5 px triangles with a centre dot, wedges at solved yaw/vfov, Feldbuch rays with bearing text rotated along the ray and flipped to read uphill), `pickStation(deck, x, y): Promise<string | null>` using `deck.pickObjectAsync` with a request counter that discards stale results.

**A17 furniture** (`ui/furniture.ts`, `ui/furniture.css`, `checks/furniture.check.ts`).
- `createFurniture(host: HTMLElement): Furniture` with `update(state: {pose: ViewPose; viewport: {w; h}; mode; drawnSymbols: SymbolId[]; originFrame: Frame}): void; destroy(): void`. Neatline with corner ticks (no boxed outlines), LV95 graticule ticks via A1, scale bar computed from camera resolution (`metersPerPixel` at the view centre, rounded to 1/2/5 x 10^n, never hard-coded), legend listing only `drawnSymbols`, one north arrow, Blatt box, imprint, cartouche "Niederhorn 1 963 m, 7. September 2026" (thin-space thousands, Source Serif 4), Wegweiser plate renderer `renderWegweiser(station): HTMLElement`, elevation key from the real LUT. Pure DOM/SVG; seeded jitter at most 0.9 px (sfc32 seeded by element id). Checks that the scale bar value equals `metersPerPixel * pixelLength` within 1%.

**A18 controls and panels** (`ui/controls.ts`, `ui/time-axis.ts`, `ui/numbers-panel.ts`, `ui/hud.ts`, `ui/controls.css`, `checks/time-axis.check.ts`).
- `time-axis.ts`: pure `minutesToX(utcMin: number): number` and inverse `xToMinutes(x: number): number` (piecewise linear, Gipfelrast 13:28 to 13:48Z magnified about 12x, monotone; the check proves round trip within 1e-9 and monotonicity), `photoTicks(stations): {x: number; id: string}[]`.
- `controls.ts`: `createControls(host, handlers: {onMode; onMinutes; onK; onLayer; onSnapshot}): Controls` (segmented Plan|Panorama, ruler with keyboard (arrows, Home, End) and `aria-valuetext`, sun-arc glyph, k slider, layer toggles incl. Nebelmeer); `numbers-panel.ts`: `createNumbersPanel(host): {update(state: NumbersState): void}`; `hud.ts`: `createHud(host): {update(d: Diagnostics): void}` (backend badge, compute path badge "graph" or "CPU twin", per-node ms table, parity table, "Run CPU twin" button wired to `scene.runParity`). Closed by default.

**A19 verification harness** (`scripts/visual-smoke.mjs`, `scripts/make-thumbnail.mjs`, `scripts/run-checks.mjs`).
- Copy the summit-view smoke template (Playwright, vite server, `GPU_ARGS` from `examples/gpu-args.mjs`, `LANDESKARTE_EXAMPLE_URL`/`_SCREENSHOTS`/`_BACKEND`). Behaviour in section 6. `run-checks.mjs` runs every `checks/*.check.ts` with `npx tsx`. Thumbnail: 480 px plan-mode render with the Mapterhorn credit visible in the image, no photo.

Dependency order for the integrator: A1, A2, A3 (pure, wave 1); A4, A5 (data, wave 1); A7, A8, A9 against frozen snippet names (wave 1); A6 consumes A7 to A9 strings (wave 1, stubs ok); A10, A11, A12 against frozen buffer/field types (wave 1); A13, A15, A16, A17, A18, A14 (wave 1, against `types.ts`); A0 integrates in wave 2; A19 and review in wave 3.

## 4. Assets, bake scripts, licences

| Asset | Source | Size target | Licence/credit |
|---|---|---|---|
| `data/trails-niederhorn.json` | `public/demo/trails.json` clipped by `scripts/bake-data.mjs` | at most 300 KB | OpenStreetMap, ODbL: credit on screen "(c) OpenStreetMap contributors"; README states the extract is a derivative database offered under ODbL |
| `data/peaks-niederhorn.json` | `manifest.region.peaks` filtered | at most 40 KB | OSM, ODbL, same credit |
| `data/stations.json` | `manifest.photos` + `manifest.poses`: id, takenAt (UTC), pose, f35, vfov, holding, confidence, lat/lon at 4 decimals | at most 10 KB | Rigi solver output; owner decision needed before publishing per-photo coordinates (summit cluster is already public in the existing examples) |
| Terrain | live `tiles.mapterhorn.com` Terrarium WebP | n/a | "(c) Mapterhorn" with underlying sources (swisstopo swissALTI3D OGD, Copernicus GLO-30); no published usage policy |
| LUT, blue noise | generated in code | 0 | n/a |
| Fonts | Google Fonts link (Fira Sans, Fira Sans Condensed, Source Serif 4, Fira Mono; all OFL) | 0 bundled | OFL, credited in README |
| Palette | Brezine chart hexes | 0 | credit Ascher/Brezine (Khipu Field Guide) in README |
| `thumbnail.jpg` | plan render, `scripts/make-thumbnail.mjs` | 15 to 35 KB | open map data only, in-image credit; add to NOTICE.md and `examples/README.md` |

Deliberately not shipped: photos, people masks, sky masks, skyline rows, MoGe depth planes, splats, swisstopo `sheet/relief.jpg` (relief is derived from the DEM in-shader instead), Google or Esri imagery. No photo copy in the example dir; no optional photo loader either (nothing drapes). Bake runs offline (`node examples/deck/landeskarte/scripts/bake-data.mjs`), outputs are committed, each carries a `_licence` stamp. Disk is near full: bake outputs are small, but free space before running Playwright (screenshots).

## 5. Math appendix

Constants: `R = 6371008.8 m`, `k = 0.13` (slider 0 to 0.20; real range 0.08 to 0.20, stated as a parameter, not a fact).

- **Terrarium:** `h = 256 R8 + G8 + B8/256 - 32768`; pixel (128,0,0) decodes to 0 m. Mapterhorn 512 px tiles, z11 at lat 46.71: 26.2 m/px ground; Web Mercator `sec(lat) = 1.46` is already folded into `getPixelsPerMeter`; second-order Mercator expansion error about 2 m at 40 km.
- **Curvature/refraction:** drop `(1-k) d^2 / (2R)`. Table: 6.8 m at 10 km, 37.7 m at 23.5 km, 109 m at 40 km, 683 m at 100 km. Geometric horizon from 1919 m: `sqrt(2 R h / (1-k)) = 167.6 km`. Tangent along a ray: `(h - h_eye)/d - d(1-k)/(2R)`.
- **Horizon (summit ring):** 2048 azimuth bins, distance table 5 m to 45 km, 1513 samples stored as `[d, 1/d]`, eye-relative pixel coordinates and heights (exact by Sterbenz), `opaque(v) = bitcast<f32>(bitcast<u32>(v) ^ uniforms.zero)`. Eye at DEM + 1.6 m (DEM reads 1931.6 m at the 1919 m fix, so the eye is a DEM-relative choice; stated).
- **Horizon map:** `H(cell, a_j) = atan(max_i tangent_i)` for 16 azimuths `a_j = 22.5 j deg`, 256 samples geometric 26 m to 12 km. Shadow: `lit = smoothstep(H(az) - 0.27deg, H(az) + 0.27deg, sunEl)` with `H(az)` linearly interpolated in azimuth (coarse; 16 vs 32 azimuth trade stated; 32 costs 67 MiB). Ambient sky-view `SVF = 1 - mean(sin(max(H_j, 0)))` (Kennelly and Stewart). Cost estimate 1M cells x 16 az x 256 samples = 4.3e9 steps, run sliced; **not measured**.
- **Sun-hours:** `sum_t lit_t * 5 min` over 288 steps; first/last light from the lit time series.
- **Sun:** NOAA/Meeus low precision (about 0.01 deg): Julian date, `L0`, `M`, equation of centre, apparent longitude, obliquity, declination, equation of time, hour angle, Bennett refraction for `el > -1`, azimuth clockwise from north. Repo outputs to reproduce (46.7102 N, 7.7733 E): 13:28:04Z az 222.14 el 41.63; 13:48:08Z az 227.86 el 39.20; 17:00Z az 269.16 el 8.98; sunset about 17:50Z. These are outputs of the repo's `sun.ts`, **not** independent references, so A2 must add a second, independent formulation in the check (e.g. a direct Meeus ch. 25 implementation written fresh, or hand-entered values from the NOAA calculator obtained by the owner).
- **Atmosphere:** `atmPath(h0,h1,L,H) = exp(-h0/H) L (1-e^-x)/x`, `x = (h1-h0)/H`, `|x| < 1e-3` gives `1 - x/2`; `T = exp(-strength (betaR dR + betaM dM))`; `C T + A (1-T)`; Cornette-Shanks Mie, g = 0.76. Single scatter, no ozone, so no blue-hour claim.
- **Imhof relief:** weights `w_i = (0.2 + sin^2(aspect - az_i)) (i==2 ? 1.6 : 1)`, `az_i = 225 + 45 i`, alt 45; blend factor `0.55 smoothstep(0.05, 0.4, slope)`; strength capped (multidirectional shading over-emphasises detail in mountains).
- **Contours:** `line = 1 - smoothstep(w/2, w/2+1, abs(fract(e - 0.5) - 0.5)/fwidth(e))` on level `e = elev/interval`; thin out when `fwidth(elev) > 0.1 interval` (so minor lines are never closer than about 10 px).
- **LV95:** swisstopo approximate formulas (about 1 m). Reference: Bern old observatory 46.951082877 N, 7.438632495 E gives E 2 600 000, N 1 200 000.
- **Camera:** `focalPx = f35 hypot(w,h) / 43.2666`, `vfov = 2 atan(h / (2 focalPx))`; projection of a station ray endpoints uses the solved yaw/pitch/roll; yaw clockwise from north, pitch up positive, roll turns the image clockwise.
- **Scale bar:** `metersPerPixel = 2 d tan(vfov/2) / viewportHeight` at distance `d` to the view-centre ground point (plan: altitude); never hard-coded.

Tolerances to assert (all targets until measured; record observed values in README):

| Check | Tolerance |
|---|---|
| Ring horizon, GPU vs `Math.fround` twin | max abs elevation 1e-3 deg (horizon-graph observed 9.3e-6) |
| Horizon map angle, GPU vs twin | 5e-3 deg including u16 quantisation step (about 2.9e-5 rad per step); report max, count over, bit-identical |
| Shadow bit | at most 0.5% of cells differ; every differing cell within 0.05 deg of the threshold; count reported |
| Peak visibility, histogram, compaction | exact |
| Sun vs repo values / independent formulation | 0.05 deg / 0.3 deg |
| ENU round trip | 1 mm |
| Curvature table | 0.1 m of the closed form |
| LV95 round trip / Bern reference | 1.5 m / 2 m |
| Terrarium known pixel | exact |
| `atmPath` vs numeric integration (1e4 steps) | 1e-4 relative |
| Time axis round trip | 1e-9, strictly monotone |
| Scale bar vs pixels | 1% |

## 6. Verification plan

1. **Static gates** (in order): `npx biome check --write examples/deck/landeskarte` (luma style via the `examples/**` override), `node scripts/ci/spdx.mjs --strict`, `node scripts/examples.mjs check` (tsc; include widened), `node scripts/examples.mjs build`, `node scripts/examples.mjs site` (thumbnail present, no stray jpg), then `node scripts/ci/run.mjs fast` after final formatting.
2. **CPU twins as tsx checks, no browser:** `npx tsx examples/deck/landeskarte/checks/<name>.check.ts` for geo, sun, atmosphere, dem, labels, furniture, time-axis, parity (CPU side: twin vs brute-force march; horizon-map vs direct per-cell march on a 64 x 64 sample). Run by `scripts/run-checks.mjs`. Optionally registering a fast-tier entry in `scripts/ci/checks.mjs` is outside the example and needs the owner's OK.
3. **`scripts/visual-smoke.mjs`, via `node scripts/examples.mjs smoke deck/landeskarte`** (wraps `scripts/gpu/with-render-lock.mjs`; never kill other jobs): a fresh chromium per backend (`webgpu`, then `webgl`). Asserts: `diagnostics.backend` equals the request; `error === ''`; `frames > 0`; `tilesLoaded >= 0.9 * tilesRequested` (ignore `tiles.mapterhorn.com` console errors); `computeBackend` is `graph` on webgpu and `cpu-twin` on webgl; in-page pixel stats decoded with `createImageBitmap` + `OffscreenCanvas`: plan sheet not blank and paper-luma mean in a band, contour-ink pixels present, red route pixels present only when a way is selected, panorama sky luma above terrain luma, shadowed fraction at 17:45Z greater than at 11:00Z, sunset R/B warmer than noon; summit label error below 1% of canvas width against the CPU projection (`projectToScreen`) of the OSM peak; after `setMode('panorama')` flight end, eye 0.00 m from target and roll -2.413 deg; `shadowPasses` equals expected count; label positions agree across backends within 1 px; WebGPU vs WebGL mean abs diff on the same state screenshot under a threshold to be measured (do not assume 8/255); screenshots per state (plan, panorama, 11:00Z, 15:28 CEST, 17:45Z); `finalize()` twice with no error; context with `navigator.gpu` removed lands on `webgl` and `#backend` reads `webgl`; the honesty strings "solved" and the "k = " parameter label are in the DOM; frozen `?t=` capture is deterministic (two shots equal).
4. **Feasibility probes first (wave 0.5, under the render lock):** each of these has been read from code only and must be proven before dependents proceed: `TextLayer` sdf + `outlineWidth` on WebGPU in the ortho overlay; `IconLayer`/`PathLayer`/`LineLayer` on WebGPU; `pickObjectAsync`; `heightFog` in a custom Layer; GPU storage-to-texture copy into `r8unorm` feeding the terrain fragment shader on WebGPU; `LinearInterpolator` over an array eye prop. Failures cut the dependent feature (see non-goals) and are recorded under README "Upstream notes".
5. **README states plainly** which gates ran and which numbers were not measured (AGENTS.md "Merge preparation").

## 7. Non-goals

- No photos, photo-derived pixels, masks, depth planes, splats, or photo thumbnail; no photo drape, Compare divider, or fly-into-photo (the photo frame is the framing target only).
- No pose solving, matchers, ORT, or any runtime ML; solved poses are shown as "solved", never "verified". ML-derived layers are explicitly out; the README explains why and lists the baked-ML option for a later example.
- No reconstructed ascent route, Naismith timing, or GPX claim; trails are context only.
- No scroll-mapped or autoplaying clock; no tour, wizard, or step chips; no wheel capture.
- No true Jenny rock facets (live stripe/stipple stand-ins only), no Tanaka illuminated contours (stretch only if time), no cover-class raster.
- No viewshed raster, flow accumulation, particles, precipitation, indirect draw, RenderBundle, `PostProcessEffect`, globe view (all stretch or later; indirect draw and PostProcess need a passing probe and an "Upstream notes" entry).
- No ortho-to-perspective projection lerp (plan is a narrow-FOV perspective at altitude).
- No `src/` import, no `@deck.gl/widgets|geo-layers|extensions`, no new vendored package, no package.json in helper folders.
- No offline DEM bundle (needs network for Mapterhorn; smoke tolerates 10% tile failure).
- No claim of bit-identical GPU/CPU floats; no claim of physically exact atmosphere; no blue-hour or ozone.

## 8. Risks (ranked)

1. **Shader parity and the frozen contract.** WGSL plus GLSL twins across A6 to A9 share one uniform struct and snippet names; drift breaks one backend. Mitigation: `types.ts` and snippet signatures frozen in wave 0; derivatives computed in A6 only; contour loop has no `break`.
2. **Horizon map size and cost.** 16 az x 1M cells x 256 samples is unmeasured; limits (8 storage buffers, 128 MiB). Mitigation: 33.5 MiB u16, sliced dispatches, 1024 window, fall back to 512 window and 8 az.
3. **WebGPU-only experimental compute, WebGL2 fallback.** GPUCommandGraph quirks, rigi.2-only fixes (compute hash). Mitigation: distinct kernel sources, no override constants, CPU-twin worker field at 256^2 labelled in the badge, consumer samples one texture on both backends.
4. **Unproven stock layers on WebGPU** (TextLayer sdf, IconLayer, pickAsync, heightFog Layer). Mitigation: wave 0.5 probes; cut list order: Nebelmeer, hachure, scree, index-label line break, sun-hours cursor map.
5. **Plan-to-panorama coherence.** Two lighting rules and two palettes must read as one product. Mitigation: explicit legend line per mode, shared hue plan owned by A9, crossfade over the flight.
6. **Licence and privacy.** Photo coordinates (stations) need owner OK; OSM extract is ODbL; Mapterhorn has no usage policy. Mitigation: geometry only, 4-decimal rounding, credits on screen and in README.
7. **Sun check is self-referential** (repo `sun.ts` has no independent test). Mitigation: A2 second formulation, 0.3 deg bound.
8. **Process.** Dirty shared tree, full disk, 20 agents. Mitigation: bake only from `manifest.json` and `trails.json`; disjoint file sets; integrator alone touches shared files; wave plan 0 (types), 0.5 (probes), 1 (parallel build), 2 (integrate), 3 (verify); browser jobs only through the render lock.
