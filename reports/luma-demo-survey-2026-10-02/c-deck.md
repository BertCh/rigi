# Survey C: deck/luma demos → lessons for Rigi (2026-10-02)

Read-only survey. Sources: luma master snapshot a `git archive` of luma `origin/master` 931ec1c53 (2026-10-02) (examples/deck/*, examples/arrow/*,
modules/deck-gpu-layers, modules/deck-arrow-layers); deck.gl `origin/master` `d1b0ae43` + open PRs;
deck.gl-community `origin/master`; `~/Documents/GitHub/deck-sky`. Prior work excluded per
`reports/luma-deck-upstream-2026-10-01.md`, `reports/luma-frontier-2026-10-01-late.md`,
`src/lib/deck-webgpu/README.md`, `vendor/deck/README.md`.

**Availability baseline.** I compared the export lists of luma master `modules/{effects,shadertools,engine,gpgpu}/src/index.ts`
with the rigi.6 tarballs' `dist/index.d.ts`, and the file trees of effects/shadertools/engine/gpgpu/experimental. They
are the same, apart from comments. Everything public that the luma deck examples use is therefore already in
`10.0.0-alpha.2-rigi.6`. That covers `precipitation`, `heightFog` (including wisps), `riverWaterMaterial`, bloom,
`createSSRCompositeShaderPass`, `createVolumetricFogCompositeShaderPass`, `ShaderPassRenderer`, `filterShaderPlugin`,
`GPUCompaction`, `GPUTextSelection`, `DrawCommandBuffer` and `experimental/geospatial`. The exception is
`modules/deck-gpu-layers` (`@deck.gl-community/gpu-layers`), which is `private` and not vendored, so its code would have
to be ported (it is MIT, vis.gl). luma's pinned deck patch (`.yarn/patches/@deck.gl-core-npm-9.4.0-707f3fb147.patch`)
was last changed at `7d1d11e91`, and its WebGPU hunks are already in deck rigi.1 and later. No deck bump is needed
for any item below.

## Ranked lessons

| # | Lesson | Rigi target | Upstream source | Benefit | Effort | Risk | Availability |
|---|---|---|---|---|---|---|---|
| 1 | **Weather (rain/snow) is WebGL-only, so it does nothing on the default WebGPU engine.** `style.world.weather` is built only in `src/lib/deck/engine.ts:3308` (`WeatherLayer`, GLSL, `src/lib/deck/weather-layer.ts`). `src/lib/deck-webgpu/` has no weather code. Port it as a colour-pass core (world view only, no depth write, `less-equal` against our reversed-Z depth) in the same way as `layers/flow.ts`. Rigi's own lattice/CPU-modulo precipitation (`look/weather/precipitation.ts`) can stay the oracle; emit WGSL from it, or start from luma's `precipitation` WGSL | new `src/lib/deck-webgpu/layers/weather.ts`, `deck-webgpu/engine.ts`, `look/weather/precipitation.ts` (WGSL twin), check row | luma `modules/deck-gpu-layers/src/layers/weather-particle-layer{,-shaders}.ts`, `examples/deck/weather/` | Restores a documented opt-in look on the primary engine (status.md lists "weather" as an opt-in look) | M | Low (opt-in, world/landing only) | rigi.6 now (`precipitation` WGSL public). The deck-gpu-layers layer is a port |
| 2 | **Nebelmeer wisps and drift.** `look/nebelmeer/index.ts` already imports `heightFogFunctions` and states that "the wisp functions go unused". `heightFog_getSpatialTransmittance(camera, position, up, density, base, falloff, variation, wispScale, time, velocity, evolution)` (12 ray samples of warped noise) gives a drifting, living sea of fog. Add `nebelmeer.{variation, wispScale, drift}` (default 0 gives the current analytic path byte-for-byte; the function short-circuits on `variation <= 0`). Pass vectors whose `dot(·, up)` equals our curvature-corrected altitude. Drift direction comes from `world.wind` | `look/nebelmeer/index.ts`, `look/glsl/atmosphere.ts`, `deck-webgpu/layers/atm-sky.ts`, `style/{types,schema,defaults}.ts` | luma `shadertools/src/modules/lighting/height-fog/height-fog-functions.ts:43-70,104-130`; `examples/deck/weather/README.md` (Fog variation / drift, clock rules) | The signature Swiss inversion look comes alive in the world view and landing scenes | S–M | Low; perf cost only when on (12 noise taps per fragment whose ray crosses the layer). Keep it out of the photo overlay and exports, as `atmosphere.nebelmeer` already is | rigi.6 now |
| 3 | **Sun glints on lakes.** Rigi's lake already has Schlick Fresnel plus a sky gradient (`look/water/water.ts:46-51,79-80`). It lacks the river material's "broken specular", `pow(max(dot(N,H),0),64) * (0.25 + 0.75·fresnel)` (`river-water-shaders.ts:110-119`), which uses the photo's sun (`look/sun.ts`). Glints follow the wave normal, so tie it to `world.water: 'waves'` | `look/water/water.ts`, `look/water/waves.ts`, `deck/terrain-layer.ts` chunk, `deck-webgpu/layers/terrain-styles.ts` | luma `shadertools/src/modules/lighting/water-material/river-water-shaders.ts`; `examples/deck/city-scene/README.md` | Lakes read as water at a glance; cheap | S | Low (world view only, behind `LOOK_WATER_WAVES`) | rigi.6 (port of ~6 lines) |
| 4 | **Perf budgets with a zero-allocation-growth gate.** city-scene keeps a hardware baseline JSON (adapter info, per-case median, worst-round p95, tracked MiB). Budget rule: median +25 %, p95 +50 %, memory +5 %, and **zero growth in tracked allocations during steady sampling**. The method: 30 warm-up frames, 120 measured, 3 rotated rounds, one redraw per rAF, then wait on the queue. Rigi's `scripts/deck-webgpu/bench.mjs` reports numbers but has no budgets (no `budget`/`growth` in it). `scripts/gpu/vram-attribution.mjs` already counts allocations | `scripts/deck-webgpu/bench.mjs` (+ `bench-baselines/apple-*.json`), `scripts/ci/checks.mjs` full-tier row | luma `examples/deck/city-scene/benchmarks/{README.md,apple-m2-webgpu.json}`, `examples/deck/city-scene/scripts/benchmark.mjs` | Turns the batch browser pass into a regression gate for frame time and leaks (useful after the rigi.N waves) | M | Low; runs only in batch passes under the render lock | n/a (process) |
| 5 | **HDR bloom on the WebGPU colour target (world view / landing only).** Rigi's `ColorTargets.color` is already linear `rgba16float`, which is exactly what scene-buffers' bloom wants. Summit glow (`layers/glow.ts`), the sun disk in `atm-sky` and lake glints (#3) would bloom without clipping. Use `bloom` / `bloomCompositeShaderPass` through `ShaderPassRenderer` on our resolved texture before present. It is not a `ShaderPassEffect`, so it is hand-wired like the composite | `deck-webgpu/layers/composite.ts` or a new screen core, `style` field | luma `examples/deck/scene-buffers/`, `modules/deck-gpu-layers/src/effects/shader-pass-effect.ts`, `@luma.gl/effects` bloom | Matches the "luma maximalist" direction; dusk/night looks | M | Medium: must never touch the overlay, export or harness pixels (gate it out under webdriver, as reveal is). WebGPU only (fine: WebGL is the fallback) | rigi.6 now |
| 6 | **Tile content pacing in Step Inside 3D tiles.** deck #10784 adds `_maxTileProcessingTime`: content creation is spread across frames under a soft budget, and the parent stays until **every** child model has drawn (`onFirstDraw`). Rigi's own traversal (`src/lib/tiles3d/deck-tiles.ts`, `content.ts`, `deck-layer.ts`) has no per-frame budget (grep found none). Check for hitches before porting | `src/lib/tiles3d/deck-tiles.ts`, `content.ts` | deck PR #10784 `modules/geo-layers/src/tile-3d-layer/tile-processing-scheduler.ts` (draft, stacked on #10782) | Smoother `?tiles3d=` loading | S–M | Low (opt-in feature) | Pattern port; no bump (Rigi does not use Tile3DLayer) |
| 7 | **Lake reflections of the mountains.** luma's SSR (`createSSRCompositeShaderPass`, camera reprojection, quality presets) is available, but Rigi's `GeometryTargets` are rendered for the photo pose only (README rule 13), so the world camera has no depth/normal G-buffer. A Rigi-specific alternative is better than SSR here: lakes are flat at a known altitude, so ray-march the reflected ray against the DEM height atlas in the lake shader. There are no screen-edge gaps, and it works on both engines | `look/water/water.ts`, `deck-webgpu/layers/terrain-styles.ts` (height atlas access), `deck/terrain-layer.ts` | luma `examples/deck/city-scene/{river-reflection-effect.ts,README.md}`; `@luma.gl/effects` SSR | Iconic "Bachalpsee mirror" world-view shot | L | Medium (per-fragment march cost; WGSL derivative/uniform-control-flow rules, as in `waves.ts`) | rigi.6 for SSR; the DEM march is our own |
| 8 | **Night sky (stars, moon) for dusk photos and landing scenes**, from the user's own deck-sky: `StarsLayer` (instanced quads, so it works on WebGPU, which has no point size), J2000 catalog plus `celestialToEnuMatrix(date, lat, lon)`, dusk crossfade over a ~5° sun-elevation band, Kasten-Young air-mass reddening | new `deck-webgpu/layers/stars.ts` + GLSL twin, `look/sun.ts` | `deck-sky/src/atmosphere/{stars-layer,stars-catalog,celestial,moon-layer}.ts` | Night look; the photo timestamp already gives the sun | M | Low technically. **deck-sky has no LICENSE file**, and the star catalogue needs provenance in `reports/licences.md` before porting | Own code |
| 9 | **GPU label culling (watch).** gpu-culled-trace builds one graph with `GPUCompaction` + `GPUTextSelection` that writes a `DrawCommandBuffer`, so text is culled and drawn indirectly with no readback. Rigi's roll-map names do greedy CPU collision (`src/lib/terroir/roll/roll-map-extras.ts:9,450-480`), which is fine at roll scale. Revisit only if label counts grow by orders of magnitude. deck #10698 (`collisionGreedy` for TextLayer) needs `@deck.gl/extensions`, which is not vendored | `terroir/roll/roll-map-extras.ts` | luma `examples/deck/gpu-culled-trace/gpu-trace-culling-effect.ts`; deck #10698 | — | M | — | rigi.6 has the primitives; #10698 is open |
| 10 | **ShaderPlugin (watch).** `filterShaderPlugin` / `clipShaderPlugin` inject vertex inputs, varyings and fragment code portably into both GLSL and WGSL assemblers (`shadertools/src/lib/shader-plugin.ts`). Rigi writes each look twice (define/feature gating in `terroir/hatch.ts`, `look/water/waves.ts`). A plugin could become the single source for future cross-engine looks. Not worth a retrofit | new looks only | luma `examples/arrow/arrow-filtering/arrow-filtering-renderer.ts:163` | Less GLSL/WGSL drift | M | Low | rigi.6 |

### Already adopted (one line each)
- `patternFill` (pattern-fills): `terroir/pattern.ts`, `terroir/hatch.ts` (LF2).
- `pointGlow` (point-glow): `look/labels/glow.ts`, `deck-webgpu/layers/glow.ts` (LF2).
- `sketchStroke`/`makeEdgeGeometry` (sketch-edges): `look/sketch-ridges.ts` (DEM ridges instead of mesh edges, LF2).
- `makeStrokeGeometry`/`pathDash`/glow (styled-paths): `look/trail-stroke.ts`, trail dash U2 (`makeStrokeGeometry` itself ruled out).
- `riverWaterMaterial` waves (city-scene): `look/water/waves.ts` (LF3). SSR skipped (LF3); see #7 for a revisit.
- `FlowParticleSimulation` (flow-particles): `look/flow`, `deck-webgpu/layers/flow.ts` (LF4), with long-frame clamp `MAX_ADVANCE_S` already in.
- `heightFog` integral: Nebelmeer (U1). `precipitation`: WebGL only (U3); see #1.
- `selectionOutline` / `SceneBufferEffect` (scene-buffers): evaluated, not adopted (README §selectionOutline). Our `GeometryTargets` are the GBuffer equivalent.
- luma deck patch (pick rect / readback flip, `depth24plus`, orientation `select`): deck rigi.1 `f1bc66ce`. Unchanged upstream since `7d1d11e91`.
- deck #10778 `_onFrameTimings`, #10782 `debug`, #10751/#10783 (TerrainExtension, not wired), #10753/#10776/#10779/#10780: vendored in rigi.2/rigi.3.
- `GPUGridIndex` (luspatial-taxi's query core): already used for roll neighbour pairs (`scripts/gpu/roll-spatial-dawn.ts`).
- `GPUCommandGraphInspector` (gpu-graph-explorer, culled-trace stats): `src/lib/gpu/core/inspector.ts`.
- Float64 origin rebasing (arrow-float64-precision): Rigi already places in CPU f64 and uploads ENU-sized values (camera-relative; `tiles3d/README.md`).
- Mapterhorn terrain (deck #10718 migrates examples to Mapterhorn + VersaTiles): Mapterhorn already used; VersaTiles ruled out (z12).

## Per-demo notes

**luma examples/deck**
- *weather*: `WeatherParticleLayer` = `precipitation` + `heightFog`, metre frame, `surfaceTexture` (r32float max-height map,
  row 0 south) excludes particles under roofs. For Rigi, depth testing against the terrain is enough; the mask only helps
  overhangs. The clock pauses when the tab is hidden and uses elapsed time. Redraws stop when every effect is off (Rigi's
  `kickWorld` behaves the same). `createVolumetricFogCompositeShaderPass` (height mode from depth) is an alternative to
  per-material fog. Rigi fogs inside the terrain material, which is correct for the haze fit, so skip it.
- *city-scene*: river style (crossing ripples, Fresnel 3.2 exponent, glints, sky gradient around `skyUpDirection`).
  SSR with camera reprojection; history is reset on cuts, resize and quality change; after a change it renders a bounded
  run of 22–45 frames, then goes idle. Depth history is packed into RGBA8 to avoid float-filterable (Rigi requires
  float32-filterable anyway). The benchmark method is #4.
- *scene-buffers*: `SceneBufferEffect` captures participating layers into a GBuffer per view, with optional history and
  selection (~17 B/px per view). Bloom keeps HDR radiance until tone mapping. Our equivalent is `targets.ts` + `hosts/passes.ts`.
- *flow-particles*: since LF4, `FlowFieldAtlas` tiles (4×64² blocks, per-tile unload) and "changing currents" snapshots every
  0.5 s of simulated time. Useful only if Rigi ever streams a real wind field (deck.gl-community `examples/geo-layers/wind`
  interpolates stations with Delaunay; that would be a product and data decision).
- *pattern-fills / point-glow / sketch-edges / styled-paths*: adopted (above). styled-paths adds round/miter caps and joins
  and a dash `phase` (animated "marching" routes would be a uniform-only change in `trail.ts` if wanted).
- *luspatial-taxi*: `GPUGridIndex` + `GPUPointSpatialQuery` + `GPUProjection` + indirect draw of matches, with a counter
  readback. Overkill for roll scale; Rigi already uses `GPUGridIndex`.
- *gpu-culled-trace*, *gpu-graph-explorer*: see #9; the inspector is adopted.
- *river-district-layer.ts*: the shared fixture adapter pattern (the layer borrows the app's buffers, owns only its model). Rigi's core contract already does this.

**luma examples/arrow, modules/deck-arrow-layers**: not applicable. Rigi has no Arrow tables, and roll/peaks are small JS
arrays. temporal-starfield (Arrow timestamps to relative f32 blink phases) is a cute idea for #8 twinkle but needs no Arrow.
arrow-filtering's `filterShaderPlugin` is #10.

**modules/deck-gpu-layers**: the GPUVector layer family (Scatterplot/Path/Text/... over caller-owned GPU buffers, chunked
draws) is the deck v10 direction. Rigi's custom cores already own their buffers. `WaterSurfaceLayer` and
`WeatherParticleLayer` are the reusable bits (#1, #3). The package is private, so code must be ported with the vis.gl header kept.

**deck.gl upstream**: master `d1b0ae43` has only pydeck/docs changes since our base `35854250`, so there is nothing to
take. Open PRs relevant to us: #10784 (#6), #10698 (#9, watch), #10741–#10745 custom projections (already on the watch list
for the step map), #10750 (globe-only), #10752 head moved to `43a38d6b` (master merge only; `vendor/deck/README.md` already
notes it). No new WebGPU examples in `examples/` or `test/apps` in the last 6 weeks (only globe and dash-style test apps).

**deck.gl-community**: `FlameTrailLayer` fitted to WebGPU terrain (#773) and its terrain demo (#769) are not relevant to
our own trail layer. `path-marker-layer` (direction arrows along paths) could mark trail direction; low value. The
playground and widgets are not relevant.

**deck-sky**: Hillaire LUT sky, AP froxel LUT, volumetric clouds (Nubis, HRRR/Himawari ingestion), moon, stars, night
lights, TAA. Rigi's analytic atmosphere is tied to the haze fit and must stay. Only the night-sky pieces (#8) transfer
cheaply. `AtmosphereSunLight` (sun colour through transmittance) is already covered by `look/sun.ts sunColor`.
