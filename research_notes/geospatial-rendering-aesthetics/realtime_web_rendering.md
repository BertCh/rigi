# Real-time web rendering for geospatial and terrain visuals (2024–2026)

Scope note: the earlier internal note `research_notes/rendering_aesthetics_sota.md` already covers Hillaire 2020 LUTs, Bruneton precompute, takram `AerialPerspective`, analytic height fog, CDLOD/Martini, reversed-Z, and WebGPU browser availability as of mid-2025. These notes cover only what is newer or was not covered there. Research budget was about 20 tool calls, so several sub-questions are listed under Gaps rather than answered.

## Atmosphere, lighting, clouds and terrain shadows

### Takeaway
takram `three-geospatial` is still the only open, production-leaning browser stack that bundles physically based atmosphere, aerial perspective and volumetric clouds for geospatial scenes. It is mid-rewrite to WebGPU/TSL: the atmosphere and core packages are done, while clouds, crepuscular rays, volumetric shadows and TAA are still in progress. On the commercial side, Mapbox GL JS v3 has the most complete "premium lighting" feature set in a map SDK (3D lights, shadows, emissive strength, AO, precipitation, LUT colour themes). None of it can be lifted into deck.gl.

### Cited Findings
- takram three-geospatial packages and status:
  - `@takram/three-atmosphere` ("an implementation of Precomputed Atmospheric Scattering") — Beta
  - `@takram/three-clouds` ("Geospatial volumetric clouds") — Beta
  - `@takram/three-geospatial` (core) — Alpha
  - `@takram/three-geospatial-effects` — Alpha
  - Licence MIT; about 1.7k GitHub stars.
  - [GitHub repo](https://github.com/takram-design-engineering/three-geospatial)
- takram WebGPU migration:
  - The README describes it as "a complete rewrite of the API due to the transition from shader-chunk-based post-processing to a node-based approach".
  - Atmosphere and core are already done for WebGPU.
  - Still planned for WebGPU:
    - faster, physically plausible atmosphere LUTs
    - accurate large-scale atmospheric lighting
    - crepuscular rays and volumetric shadows
    - geometry-based lens glare
    - temporal antialiasing
    - screen-space shadows
  - [GitHub repo](https://github.com/takram-design-engineering/three-geospatial)
- Mapbox GL JS v3 lighting and effects:
  - v3.0 introduced the Standard style, "a new realistic 3D lighting system, building shadows", a 3D Lights API (directional plus ambient), `*-emissive-strength` properties, and flood lighting on extrusion walls and the ground. WebGL1 was dropped, so WebGL2 is mandatory. — [Mapbox GL JS releases](https://github.com/mapbox/mapbox-gl-js/releases?page=3)
  - Precipitation: experimental `snow` and `rain` style properties arrived in 3.9.0 (adjustable intensity, direction and colour). — [Mapbox CHANGELOG](https://raw.githubusercontent.com/mapbox/mapbox-gl-js/main/CHANGELOG.md)
  - Terrain lighting: 3.7.0 "Improve terrain hillshade lighting anchored to viewport" and "Improve shadow casting from 3D models". — [CHANGELOG](https://raw.githubusercontent.com/mapbox/mapbox-gl-js/main/CHANGELOG.md)
  - Shadow work across 3.9–3.25:
    - shadow-acne and double-shadow fixes (3.9)
    - shadows for elevated lines (3.12)
    - fix for striping artifacts "on some GPU configurations" (3.13)
    - performance passes (3.17, 3.24)
    - a `shadow-draw-before-layer` property for the directional light (3.18)
    - per-model `lightOverrides` (3.25)
    - [CHANGELOG](https://raw.githubusercontent.com/mapbox/mapbox-gl-js/main/CHANGELOG.md)
  - Fill-extrusion ambient occlusion exists. 3.29 fixed AO wrongly drawn on elevated extrusions, and 3.21 made clip layers clip the AO. — [CHANGELOG](https://raw.githubusercontent.com/mapbox/mapbox-gl-js/main/CHANGELOG.md)
- MapLibre GL JS v5:
  - Adds globe projection, terrain on the globe, and a merged sky/atmosphere implementation with an optional realistic atmosphere in globe mode.
  - Sky and fog are unified under `map.setSky()`.
  - [MapLibre Newsletter Dec 2024](https://maplibre.org/news/2025-01-05-maplibre-newsletter-december-2024/); [MapLibre globe+atmosphere example](https://maplibre.org/maplibre-gl-js/docs/examples/display-a-globe-with-an-atmosphere/)

### Inferences
- The fastest premium-sky path for Rigi's three.js renderer is still takram. Because of the WebGPU rewrite, though, a WebGL-era integration (shader-chunk API) would need porting again later. If the three path moves to WebGPURenderer, wait for, or target, the node-based takram API.
- The Mapbox feature list gives a good checklist of what "premium" means in a map SDK in 2026:
  - a directional sun with shadows
  - emissive night lighting
  - AO on 3D features
  - LUT colour themes
  - weather particles
  - hillshade anchored to the viewport
- deck.gl has `LightingEffect` with directional shadows. It has nothing comparable for atmosphere, AO or LUT grading, so those would be custom `PostProcessEffect`s.

### Gaps
- Not found in this pass: shipped web demos of horizon-based or ray-marched heightfield terrain shadows (as opposed to cascaded shadow maps), GTAO on terrain specifically, and cloud shadows on terrain in the browser. The takram clouds package probably has cloud shadows, but this was not confirmed from the source.
- No sourced information was found on sun, moon or star rendering in takram, or on time-of-day APIs beyond the takram feature list.

## Post-processing pipelines

### Takeaway
three.js now ships a full TSL node post stack that runs on WebGPU with a WebGL2 fallback: GTAO, SSGI, SSR, TRAA, bloom, motion blur, LUT, film grain, chromatic aberration, outline and denoise. pmndrs `postprocessing` remains the mature choice for WebGLRenderer only. In deck.gl, `PostProcessEffect` has worked in interleaved mode since 9.2, but deck has no built-in TAA, AO or tone-mapping stack.

### Cited Findings
- Built-in three.js TSL post nodes:
  - `fxaa()`, `smaa()`, `traa()` (temporal AA)
  - `ao()` (GTAO), `ssgi()`, `ssr()`
  - `bloom()`, `anamorphic()`, `chromaticAberration()`, `rgbShift()`
  - `lut3D()`, `film()` (grain), `denoise()`, `motionBlur()`
  - `sobel()`, `outline()`
  - box/gaussian/hash blur, `afterImage()`, `renderOutput()`
  - No dedicated sky or atmosphere post node is listed.
  - [three.js TSL wiki](https://github.com/mrdoob/three.js/wiki/Three.js-Shading-Language)
- A 2026 migration guide:
  - Moving three.js to WebGPU means swapping WebGLRenderer for `WebGPURenderer` (from `three/webgpu`), porting GLSL to TSL, and moving post-processing to `RenderPipeline`. The guide targets r186.
  - `outputColorTransform` (default true) applies tone mapping automatically.
  - [Utsubo migration guide](https://www.utsubo.com/blog/webgpu-threejs-migration-guide)
  - This is a secondary source; the class rename (`PostProcessing` → `RenderPipeline`) should be checked against current three.js docs.
- AgX in three.js is described as "intended to be more neutral and preserve colors better" than the other tone mappers. — [three.js forum, Tone Mapping Overview](https://discourse.threejs.org/t/tone-mapping-overview/75204), via search snippet, not fetched in full.
- pmndrs `postprocessing`:
  - An `EffectComposer` that merges effects into single fullscreen-triangle passes.
  - About 20 effects: bloom, DOF with vignette, LUT colour grading, chromatic aberration, SSAO/N8AO, tone mapping and more.
  - Designed for WebGL, with HalfFloat high-precision buffers.
  - No WebGPU support is stated in the README.
  - [pmndrs/postprocessing](https://github.com/pmndrs/postprocessing)
- deck.gl 9.2 (7 Oct 2025): "PostProcessEffect now works correctly in interleaved mode". — [deck.gl What's New](https://deck.gl/docs/whats-new)
- Mapbox ships LUT-based colour themes (`color-theme`, `*-use-theme`, from 3.9) and has kept optimising them (3.15, 3.24). — [Mapbox CHANGELOG](https://raw.githubusercontent.com/mapbox/mapbox-gl-js/main/CHANGELOG.md)

### Inferences
- For the three path, the quickest route to a "premium" look is WebGPURenderer plus TSL:
  - `traa()` + `ao()` + `bloom()` + `lut3D()` + `film()`
  - AgX or Neutral output
  - All of these are first-party, so no third-party post dependency is needed.
  - The cost is that every custom GLSL `ShaderMaterial` must be rewritten in TSL (already noted in the earlier note).
- For deck.gl, a minimal premium post chain is achievable with custom luma `ShaderPass`es inside `PostProcessEffect`: tone map + LUT + grain + vignette. TAA would need a history buffer and camera jitter, which deck does not expose out of the box.

### Gaps
- No sourced per-effect cost numbers (ms/frame on M-series or iPhone) were found for TRAA, GTAO or SSGI in three.js.
- No authoritative source was found for Khronos PBR Neutral availability across engines (three.js has `NeutralToneMapping` per general knowledge, but it was not verified here).
- Tilt-shift and DOF for map views: no geospatial-specific source found.

## Engine landscape

### Takeaway
- Cesium is now the reference for streamed world-scale Gaussian splats, via the KHR_gaussian_splatting glTF extensions inside 3D Tiles with hierarchical LOD (April 2026).
- Mapbox Standard leads on stylised premium 3D. Its recent work includes landmark model LOD, elevated roads, procedural buildings, Appearances and LUT themes.
- deck.gl reached 9.4 (Sept 2026) with every official layer running on WebGPU, but still calls it experimental.
- Google's Map3DElement (Photorealistic 3D Maps in Maps JS) is pre-GA per the sources found.

### Cited Findings
- Cesium Gaussian splats:
  - Earlier experimental support: CesiumJS 1.131 added experimental SPZ-compressed splats in 3D Tiles under the draft `KHR_spz_gaussian_splats_compression`. That extension was later removed in favour of `KHR_gaussian_splatting` and `KHR_gaussian_splatting_compression_spz_2`. — [Radiance Fields](https://radiancefields.com/cesium-brings-khr_gaussian_splatting-support-to-cesiumjs-and-unreal-engine); [Cesium Nov 2025 releases](https://cesium.com/blog/2025/11/03/cesium-releases-in-november-2025/)
  - The April 2026 Cesium post announces splats with hierarchical LOD across CesiumJS, Cesium for Unreal and Cesium ion:
    - "3D Tiles as a spatial index and glTF as the payload"
    - "specialized shaders for volumetric rendering and high-performance sorting using WebAssembly"
    - SPZ cuts size "by up to 90% compared to standard PLY files"
    - to be added to the proposed 3D Tiles 2.0 OGC community standard
    - [Cesium blog, 27 Apr 2026](https://cesium.com/blog/2026/04/27/3d-gaussian-splats-lod/)
  - A search-engine summary attributes a CesiumJS 1.144 maintenance release (1 Aug 2026) with SPZ and splat fixes. This was not verified from a primary source.
- Mapbox GL JS changelog, 3.10 → 3.32:
  - landmark icons (3.11)
  - elevated lines, promoted to stable in 3.19
  - experimental Appearances API (3.16), made stable in 3.28
  - procedural buildings and indoor ("upcoming 3D features", 3.16)
  - landmark model LOD (3.24, 3.26, 3.30)
  - `raster-allow-draping` (3.29)
  - terrain moved out of the core ESM module (3.30)
  - 3.32 exposes projection/view matrices and the globe clipping plane to `CustomLayerInterface`, which makes custom 3D layers (for example three.js or deck.gl inside Mapbox) easier
  - [Mapbox CHANGELOG](https://raw.githubusercontent.com/mapbox/mapbox-gl-js/main/CHANGELOG.md)
- deck.gl releases:
  - 9.1 (21 Jan 2025): GlobeView with MapLibre integration; all shaders moved to uniform buffers.
  - 9.2 (7 Oct 2025): WebGPU "early preview" for a few layers.
  - 9.3 (13 Apr 2026): TerrainController; TerrainExtension on GlobeView; TextLayer clipping.
  - 9.4 (5 Sep 2026):
    - "All official layers now support WebGPU, including MVTLayer and Tile3DLayer"
    - TerrainLayer correct on GlobeView
    - GlobeView pitch/bearing
    - procedural hatch patterns in FillStyleExtension
    - yet "WebGPU support remains experimental and is not yet recommended for production"
  - [deck.gl What's New](https://deck.gl/docs/whats-new)
- Google Photorealistic 3D Maps in Maps JS (Map3DElement):
  - Supports polylines, polygons, extrusions, 3D models, camera path animations and markers.
  - A `mode` option (HYBRID / SATELLITE) is required.
  - The docs mark it "Preview (pre-GA)".
  - [Google 3D Maps overview](https://developers.google.cn/maps/documentation/javascript/3d/overview); [3D Maps support](https://developers.google.cn/maps/documentation/javascript/3d-maps-support?hl=en)
  - The GA status as of late 2026 could not be confirmed.
- FATMAP was closed by Strava on 1 Oct 2024. PeakVisor positions itself as the replacement and claims a better 3D engine (vendor claim). — [PeakVisor](https://peakvisor.com/de/news/FATMAP-alternative.html)

### Inferences
- deck.gl 9.4 is the first release in which an all-WebGPU deck scene is plausible, including Tile3DLayer for Google or swisstopo tiles. Given the "not production" label, Rigi's WebGL2 default should stay, with WebGPU behind a flag. That fits the existing `src/lib/deck-webgpu` port.
- Splats-in-3D-Tiles is now a Khronos/OGC-track standard. A Rigi near-field splat ("Step Inside") could be exported as a KHR_gaussian_splatting glTF and so interoperate with Cesium.

### Gaps
- Not researched within budget:
  - iTowns, Giro3D, Potree 2, Felt and Kepler/Foursquare visual features
  - Apple Maps Flyover rendering details
  - PeakFinder and Outdooractive renderers
  - Google 3D Maps lighting and time-of-day controls
- Mapbox release dates per version were not extracted. The search snippet suggested v3.21 ≈ April 2026 and v3.26-rc ≈ July 2026, which is unverified.

## Gaussian splatting, neural rendering, WebGPU terrain compute, and line/label quality

### Takeaway
Spark 2.0 (World Labs, MIT, three.js) is the leading web splat renderer: LoD Splat Tree, streaming, 100M+ splats over plain WebGL2, including iOS. Cesium covers the georeferenced, tiled case. deck.gl 9.4 added analytic antialiasing to path, line, arc and point-cloud layers, which removes the need for MSAA for crisp wide lines.

### Cited Findings
- Spark 2.0 Developer Preview (21 Feb 2026):
  - LoD Splat Tree, the RAD streamable format, GPU virtual page tables, and global splat sorting across objects.
  - "stream ultra-large-scale 3D worlds containing over 100 million splats to any device via WebGL2, including desktops, iOS, Android, and VR".
  - Formats: PLY (incl. compressed), SPZ, SPLAT, KSPLAT, SOG.
  - [Spark](https://sparkjs.dev/); [GitHub sparkjsdev/spark](https://github.com/sparkjsdev/spark); [Radiance Fields, Spark 2.0 preview](https://radiancefields.com/world-labs-previews-spark-2.0)
  - Spark v2.2.0 later added faster LoD traversal and Rust decoders. — [Radiance Fields](https://radiancefields.com/spark-v2.2.0-adds-faster-lod-traversal-rust-decoders)
- deck.gl 9.4: "PathLayer, LineLayer, ArcLayer, and PointCloudLayer implement analytic antialiasing for smooth edges without MSAA". 9.3 added TextLayer per-object clipping and sticky text; 9.2 added `backgroundBorderRadius`. — [deck.gl What's New](https://deck.gl/docs/whats-new)
- Mapbox fixed line-quality issues in 3.22 ("Skip sub-pixel line dilution for intentionally thin lines") and in 3.19 (elevated line bevel joins). — [Mapbox CHANGELOG](https://raw.githubusercontent.com/mapbox/mapbox-gl-js/main/CHANGELOG.md)

### Inferences
- Upgrading Rigi to deck 9.4 would sharpen ridge lines and peak leader lines for free. That is relevant to panorama overlays.
- Spark runs on WebGL2, so it avoids the WebGPU availability problem on older iOS. It is the safer choice for the near-field splat viewer.

### Gaps
- No sourced 2025–26 work was found on:
  - WebGPU compute terrain (GPU clipmaps, virtual texturing, compute tessellation) in shipping web engines
  - MSDF text in deck.gl (TextLayer is still SDF per general knowledge; not verified)
  - neural or learned rendering in the browser
  - gsplat.js or SuperSplat updates

## Performance and WebGPU availability

### Takeaway
WebGPU ships by default in Chrome/Edge, Safari 26 (macOS, iOS, iPadOS and visionOS 26) and Firefox 141+ on Windows, with Firefox 145+ on Apple Silicon macOS. This is unchanged from the earlier note. Both deck.gl and three.js keep WebGL2 as the safe production path. Splat engines reach mobile through WebGL2.

### Cited Findings
- "Safari version 26 ships with WebGPU support … macOS Tahoe 26, iOS 26, iPadOS 26 and visionOS 26". Firefox 141 has it on Windows, and Firefox 145 on macOS Tahoe ARM64. — [web.dev](https://web.dev/blog/webgpu-supported-major-browsers)
- deck.gl 9.4 WebGPU is "experimental and … not yet recommended for production". — [deck.gl What's New](https://deck.gl/docs/whats-new)
- three.js WebGPURenderer falls back to WebGL2 automatically (see the earlier note). TSL post nodes work on both backends. — [three.js TSL wiki](https://github.com/mrdoob/three.js/wiki/Three.js-Shading-Language)
- Spark claims 100M-splat streaming on iOS and Android via WebGL2 through LoD and paging. — [Radiance Fields](https://radiancefields.com/world-labs-previews-spark-2.0)
- Mapbox repeatedly lists "Improve shadow rendering performance" (3.17, 3.24) and lazy-loads precipitation and procedural buildings (3.23). This suggests these effects are costly enough to need optimisation and code splitting. — [Mapbox CHANGELOG](https://raw.githubusercontent.com/mapbox/mapbox-gl-js/main/CHANGELOG.md)

### Inferences
- A "premium" post stack costs a fixed amount per pixel, so on Retina iPhones the main lever is internal render scale. Running at DPR 1–1.5 with TAA upsampling is the usual approach. This is general practice and was not sourced here.

### Gaps
- No measured 60 fps budgets were found for MacBook vs iPhone covering atmosphere, clouds, GTAO or TRAA in three.js or takram. takram's README gives no perf numbers.
- Firefox WebGPU on Linux and Android as of late 2026 was not confirmed.
