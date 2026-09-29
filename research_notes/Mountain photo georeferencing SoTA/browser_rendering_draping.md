# Browser Rendering, Label Overlay & Photo Draping Pipelines (TS/Vite/React, as of Sept 2026)

Scope: (a) synthetic terrain views from a DEM matching a photo camera, (b) occlusion-aware label/vector overlays, (c) projective draping of the photo onto terrain, plus the inverse (monoplotting), auxiliary buffers, in-browser ML, and browser-vs-backend split.

Note on method: about 20 search/fetch calls. Several version facts came from summarising fetchers and are flagged where they look unreliable. Engineering patterns that come from the researcher's own domain knowledge rather than a fetched source are under **Inferences**, not Cited Findings.

---

## Q1. Stack comparison: which engines support a ground-level photo-matched camera (precise lat/lon/alt, yaw/pitch/roll/FOV), 100–200 km views, earth curvature, and depth precision?

### Takeaway
The two strongest fits are **three.js plus NASA-AMMOS `3d-tiles-renderer`** (full camera control, WGS84 ellipsoid, quantized-mesh/Cesium ion/Google tiles, R3F bindings, reversed-Z or log depth) and **CesiumJS** (ECEF globe, curvature and horizon handled natively, hybrid log-depth/multi-frustum, `pickPosition`). MapLibre can now pitch up to 180° and roll, which allows first-person views, but it remains a map engine with limited control over shaders and buffers. deck.gl is fine for 2.5D overlays but is a weak fit for horizon-level 150 km views.

### Cited Findings
**three.js**
- Latest stable was r184 (16 Apr 2026) per Wikipedia at the time of that snapshot — [Wikipedia](https://en.wikipedia.org/wiki/Three.js). The GitHub releases page fetched in Sept 2026 lists **r186** as the latest. Its notes mention WebGPURenderer rendering to texture arrays, TSL compute `updateBefore/updateAfter`, point shadows fixed with logarithmic depth, "honor renderOrder with reversed depth buffer", "unbind PIXEL_PACK_BUFFER after async readback", and "unfilterable float32 StorageTextures". The fetcher reported the date as "Sept 24, 2024", which is clearly wrong because r184 was April 2026. Treat r186 as roughly Aug–Sept 2026 — [three.js releases](https://github.com/mrdoob/three.js/releases)
- WebGPURenderer has been usable without extra configuration since about r171 (Sept 2025). It falls back automatically to a WebGL2 backend when WebGPU is unavailable — [utsubo 2026 overview](https://www.utsubo.com/blog/threejs-2026-what-changed); [three.js manual: WebGPURenderer](https://threejs.org/manual/en/webgpurenderer.html)
- Reverse-Z: WebGLRenderer has a `reverseDepthBuffer` constructor flag that needs `EXT_clip_control` and silently falls back when the extension is missing. The forum notes a naming confusion between `reverseDepthBuffer` and `reversedDepthBuffer` — [three.js forum](https://discourse.threejs.org/t/reversedepthbuffer-works-instead-of-reverseddepthbuffer/90954); [PR #29579](https://github.com/mrdoob/three.js/pull/29579)
- Reverse-Z with a [0,1] clip range is "a strict improvement to logarithmic depth buffer where supported, … in both performance and accuracy. Also works well with MSAA, unlike logarithmic depth" (Cody Bennett, implementer) — [X post](https://x.com/Cody_J_Bennett/status/1836809843509747897). WebGPURenderer also has reversed-depth fixes, e.g. polygonOffset — [PR #34581](https://github.com/mrdoob/three.js/pull/34581)

**NASA-AMMOS 3DTilesRendererJS (`3d-tiles-renderer`)**
- Renderer for 3D Tiles "using three.js, Babylon.js, and r3f". Plugins include QuantizedMeshPlugin (quantized-mesh plus overlays), TMS/XYZ, WMTS, WMS, GeoJSON, Vector Tiles, Load Region, TilesFadePlugin, and auth plugins CesiumIonAuthPlugin and GoogleCloudAuthPlugin. Controls are GlobeControls and EnvironmentControls — [GitHub README](https://github.com/NASA-AMMOS/3DTilesRendererJS)
- The ellipsoid defaults to WGS84. TilesRenderer has a `surface` field that maps cartographic coordinates onto tile geometry, with a projection surface added for flat maps (PR #1728). ImageOverlayPlugin works with QuantizedMesh, though a crash bug is reported in "free-flight" navigation (#1756) — [releases](https://github.com/NASA-AMMOS/3DTilesRendererJS/releases); [PR #1728](https://github.com/NASA-AMMOS/3DTilesRendererJS/pull/1728); [issue #1756](https://github.com/NASA-AMMOS/3DTilesRendererJS/issues/1756)

**CesiumJS**
- Monthly releases: 1.142 (June 2026), 1.143 (July 2026) and 1.144 (Aug 2026) — [Cesium Aug 2026 release blog](https://cesium.com/blog/2026/08/04/cesium-releases-in-august-2026/)
- Since 1.45, Cesium uses a hybrid multi-frustum and logarithmic depth buffer. With log depth, the globe renders in a single frustum. The multi-frustum is used only when `Scene#logarithmicDepthBuffer` is false. When it is true, `logarithmicDepthFarToNearRatio` applies — [Cesium blog: log depth](https://cesium.com/blog/2018/05/24/logarithmic-depth/); [Scene docs](https://cesium.com/learn/ion-sdk/ref-doc/Scene.html)
- `pickPosition` reconstructs position from the depth buffer. GlobeDepth and PickDepth are different buffers, and accuracy problems occur when `depthTestAgainstTerrain` is false — [issue #8179](https://github.com/CesiumGS/cesium/issues/8179)
- Cesium World Terrain is a quantized-mesh tileset with terrain-specific LOD simplification and geometric error, plus water-mask and normals extensions — [Cesium World Terrain](https://cesium.com/platform/cesium-ion/content/cesium-world-terrain/). MapTiler also sells or serves a global quantized-mesh Terrain 3D dataset — [MapTiler](https://docs.maptiler.com/schema-raster/terrain-3d/)
- Cesium previewed vector tiles for 3D Tiles in Sept 2026 — [Cesium blog](https://cesium.com/blog/2026/09/02/vector-tiles-technology-preview-cesium-and-3d-tiles/)

**MapLibre GL JS**
- The current MapOptions docs say: `maxPitch` "The maximum pitch of the map (0-180)", default 60; `roll` "measured in degrees counter-clockwise about the camera boresight"; `centerClampedToGround` "If true, the elevation of the center point will automatically be set to the terrain elevation". No fov option appears in MapOptions — [MapOptions docs](https://maplibre.org/maplibre-gl-js/docs/API/type-aliases/MapOptions/)
- History: the maximum was 85° from 2021, with values above 60 marked "experimental"; feature request #4870 asked for 180 to support first-person views — [issue #4870](https://github.com/maplibre/maplibre-gl-js/issues/4870); [discussion #763](https://github.com/maplibre/maplibre-gl-js/discussions/763)
- Open bug (#8292): `map.project()` returns incorrect points for locations behind the camera, and DOM markers render in the sky — [issue #8292](https://github.com/maplibre/maplibre-gl-js/issues/8292). A summarising fetch of CHANGELOG.md reported a v6.x line with a fix for project-behind-camera (6.8.0), "Pick terrain coordinates with a CPU raycast against the DEM" (6.6.0), and an ESM-only distribution. **These v6 entries are unverified** because the fetcher output was inconsistent — [CHANGELOG](https://raw.githubusercontent.com/maplibre/maplibre-gl-js/main/CHANGELOG.md)

**deck.gl / loaders.gl**
- TerrainLayer builds meshes from height-map images such as terrain-RGB and loads them per tile through TileLayer — [TerrainLayer](https://deck.gl/docs/api-reference/geo-layers/terrain-layer). TerrainExtension (experimental) drapes 2D layers onto the terrain surface and now supports GlobeView — [TerrainExtension](https://deck.gl/docs/api-reference/extensions/terrain-extension); [What's new](https://deck.gl/docs/whats-new). MaskExtension supports FirstPersonView — [whats-new.md](https://github.com/visgl/deck.gl/blob/master/docs/whats-new.md)
- `@loaders.gl/terrain` TerrainLoader: `options.terrain.tesselator` chooses `'martini'` (fast, square 2^n+1 grids only) or `'delatin'` (slower, supports non-square). It supports skirts via `skirtHeight` and includes a QuantizedMeshLoader — [loaders.gl terrain](https://loaders.gl/docs/modules/terrain/api-reference/terrain-loader); [skirt issue #712](https://github.com/visgl/loaders.gl/issues/712)

**giro3d / iTowns**
- Giro3D (Oslandia) is TypeScript on three.js and WebGL, described as the successor or fork of iTowns (IGN). It supports high-resolution terrain with elevation querying and profiles — [Giro3D README](https://github.com/giro3d-org/Giro3D/blob/main/README.md); [Oslandia](https://oslandia.com/en/2023/02/09/les-nouveautes-sur-giro3d/)

### Inferences
- **Recommended primary stack:** three.js (WebGLRenderer with `reverseDepthBuffer: true` or `logarithmicDepthBuffer: true`), plus `3d-tiles-renderer` for streamed terrain, plus `@react-three/fiber` for React integration. For a fixed photo site, an alternative is to fetch terrain-RGB tiles in a radius of about 200 km yourself and mesh them with Martini or Delatin (loaders.gl). This gives deterministic, complete geometry for the solver, whereas screen-space-error LOD streaming is tuned to the current view and may drop detail you need for skyline fidelity.
- **Camera-relative (floating origin) coordinates are mandatory.** ECEF values are about 6.4e6 m and float32 gives roughly 0.5 m resolution there. Define an East-North-Up (ENU) frame at the camera, transform terrain vertices into ENU in float64 on the CPU, then upload float32. Build the camera from yaw/pitch/roll in ENU. Use a vertical FOV derived from focal length, `fovY = 2·atan(h/2f)`, and set `camera.filmOffset` or a custom projection matrix for the principal point.
- **Earth curvature and refraction:** if you mesh in true ECEF or ENU (not a flat Mercator plane), curvature is automatic. It amounts to about 1.77 km of drop at 150 km (d²/2R); a standard refraction coefficient of k≈0.13 reduces the effective drop by about 13%. Refraction is not modelled by any engine, so apply it by computing drop with an effective radius R/(1−k).
- **Depth precision:** with near=1 m and far=250 km, a standard float24 depth buffer is inadequate. Reverse-Z with a float32 depth attachment (`DepthTexture` with `FloatType`) is best. Log depth works but breaks early-Z and interacts poorly with custom shaders unless you include `logdepthbuf` chunks. In Cesium, prefer `logarithmicDepthBuffer=true`, which is the default on WebGL2.
- **MapLibre** is good for a quick matching preview, and v5+ roll and pitch up to 180 help. But it gives no access to custom depth or ID buffers, has no explicit FOV-from-intrinsics option in MapOptions, and its LOD tiling and fog are tuned for maps. Not recommended as the solver renderer.
- **Babylon.js** is viable (3d-tiles-renderer has Babylon support) but the ecosystem is smaller for this use case. **three-geo, geo-three and three-tile** are simpler terrain tile loaders on flat Mercator planes; they are fine for demos but lack curvature and ellipsoid handling.

### Gaps
- Could not confirm exact MapLibre v5/v6 version numbers for when `maxPitch` 180 and `roll` shipped, or the status of the v6 changelog entries.
- Did not verify whether 3d-tiles-renderer officially supports WebGPURenderer in Sept 2026.
- No benchmark found comparing Cesium and three.js on 200 km ground-level horizon rendering.

---

## Q2. Auxiliary buffers for the pose solver (depth, XYZ/ECEF, normals, skyline, ID) and readback

### Takeaway
Render into multiple render targets (MRT) with float32 attachments, then read back asynchronously: `readRenderTargetPixelsAsync` in three.js (WebGL2 PBO) or storage textures and buffers under WebGPU. Recent three.js releases are fixing exactly these async-readback and float32-storage paths.

### Cited Findings
- r186 notes include "unbind PIXEL_PACK_BUFFER after async readback" and support for "unfilterable float32 StorageTextures" — [three.js releases](https://github.com/mrdoob/three.js/releases)
- Cesium `pickPosition` gives the world position at a pixel from depth. It depends on globe depth and `depthTestAgainstTerrain` — [Scene docs](https://cesium.com/learn/ion-sdk/ref-doc/Scene.html); [issue #8179](https://github.com/CesiumGS/cesium/issues/8179)

### Inferences
- **Pattern (three.js WebGL2):** use a `WebGLRenderTarget(w, h, { count: 3, type: FloatType })`. Attachment 0 holds ENU XYZ (RGBA32F, with alpha as a valid mask). Attachment 1 holds normals and view distance. Attachment 2 holds a peak or feature ID (R32UI or encoded float). Render with a custom `ShaderMaterial` using `layout(location=N) out`. Read with `await renderer.readRenderTargetPixelsAsync(rt, 0, 0, w, h, Float32Array, /*textureIndex*/)`. Requires `EXT_color_buffer_float`, which is universal on WebGL2 desktop and most mobiles.
- Storing **camera-relative XYZ** in float32 keeps centimetre precision within 200 km. Store range (distance) rather than NDC depth to avoid nonlinearity.
- **Skyline:** per image column, take the topmost pixel whose alpha (terrain hit) is 1. This is trivial on the CPU after readback or in a small compute pass. To get sub-pixel skylines, supersample or render only a thin band at higher resolution. Occluding **silhouette edges** inside the image come from depth discontinuities, e.g. a Sobel filter on log-range.
- **WebGPU:** use a TSL `compute()` node writing into `StorageBufferAttribute`, then call `renderer.getArrayBufferAsync(attr)` to read it back. This is useful for reductions such as skyline extraction on the GPU.
- Render auxiliary buffers at solver resolution, e.g. 1024 px wide. Readback of 1024×768×16 bytes is about 12 MB and takes a few milliseconds.

### Gaps
- No measured readback latency benchmarks for WebGPU vs WebGL2 PBO were found.

---

## Q3. Label placement (peaks): projection, visibility tests, decluttering

### Takeaway
Project peak ECEF or ENU points with the solved camera, then test visibility against the rendered range buffer with a tolerance. A CPU DEM ray-march is a fallback for off-screen or high-accuracy cases. Declutter PeakFinder-style: sort by prominence and distance, place labels in a band above the skyline, and connect them with leader lines.

### Cited Findings
- MapLibre's `project()` has a behind-camera bug and DOM markers render in the sky (#8292). Label placement code must cull points behind the camera itself — [issue #8292](https://github.com/maplibre/maplibre-gl-js/issues/8292)

### Inferences
- **Visibility test:** compute the peak's range `r_p` from the camera and sample the range buffer at the projected pixel, including a 3×3 neighbourhood. Treat the peak as visible if `r_buf ≥ r_p − tol`, with tol of about max(30 m, 0.002·r_p). Summits sit exactly on silhouettes, so also test a point about 5–10 m below the summit and accept if either is visible. Also allow for DEM smoothing that lowers peaks by tens of metres at 30 m resolution.
- **Ray-march alternative:** step along the camera-to-peak segment in the heightfield, with steps proportional to distance, accounting for curvature. This is more robust than a depth buffer for thin ridges, and is cheap for about 1,000 peaks in a Web Worker.
- **Decluttering:** filter by prominence (e.g. OSM `natural=peak` joined with a prominence dataset) and by angular size. Greedily place labels in a y-band above the skyline column max. Use vertical leader lines and resolve collisions by one-dimensional x-interval packing, allowing labels to be rotated 90°. Render labels as HTML or SVG over the canvas (crisp text, accessible) rather than in WebGL.
- Keep labels in image pixel space tied to the photo's intrinsics, not the viewer's canvas.

### Gaps
- No primary documentation of PeakFinder's algorithm was found (it is proprietary).

---

## Q4. Vector overlays (trails, boundaries, contours) with occlusion

### Takeaway
Drape vectors onto terrain, either by sampling DEM heights along densified polylines or with deck.gl TerrainExtension or 3d-tiles-renderer's GeoJSON and vector-tile overlays. Render them with depth testing against the terrain depth using fat lines (Line2) and a small depth bias. Generate contours in the terrain fragment shader from elevation.

### Cited Findings
- deck.gl TerrainExtension fits 2D layers such as GeoJSON streets onto an elevation model — [TerrainExtension](https://deck.gl/docs/api-reference/extensions/terrain-extension)
- 3d-tiles-renderer provides GeoJSON and Vector Tiles (Mapbox and Protomaps) overlay plugins alongside QuantizedMeshPlugin — [README](https://github.com/NASA-AMMOS/3DTilesRendererJS)
- In WebGPURenderer, polygonOffset had to be fixed for reversed depth buffers, so depth biasing for decals and lines is sensitive to the depth mode — [PR #34581](https://github.com/mrdoob/three.js/pull/34581)

### Inferences
- **Line rendering:** three.js `Line2`/`LineMaterial` (examples/jsm/lines) or MeshLine for screen-space width. Densify polylines to 10–30 m and set z = DEM + 2–5 m, or use a view-space depth offset proportional to distance to prevent z-fighting at 100 km.
- **Occlusion over the photo:** render the terrain depth-only (colorWrite=false), then draw the lines with depthTest on. Composite the colour result over the photo with alpha. Optionally show occluded segments dashed or faded with a second pass using `depthFunc = GreaterDepth`.
- **GPU contours:** in the terrain shader use `float c = elev / interval; float line = 1.0 - smoothstep(0.0, fwidth(c)*1.5, abs(fract(c-0.5)-0.5));`. This gives anti-aliased isolines at any distance. Use an index contour every fifth line.
- **Ridge lines** can be derived from DEM curvature or flow accumulation offline, or taken from OSM `natural=ridge`/`arete`.

### Gaps
- No benchmarks were found for fat-line rendering of large trail networks in a first-person view.

---

## Q5. Projective texture mapping (draping the photo), sky masking, blending, export, Gaussian splats

### Takeaway
Use a shadow-map-style projective texture. Render a depth or range map from the photo camera, then in the terrain shader project each fragment into the photo, compare its range with the stored range (visibility), reject sky-masked pixels, and weight by incidence angle. `three-projected-material` is a starting point but lacks visibility testing. Gaussian splatting of a single photo is not a good fit; a textured mesh or orthophoto is.

### Cited Findings
- `three-projected-material` (marcofugaro, now maintained under lume) projects a texture from a camera onto meshes. It supports instancing and multiple projections and preserves the image aspect ratio — [lume/three-projected-material](https://github.com/lume/three-projected-material); [marcofugaro](https://github.com/marcofugaro/three-projected-material); [Codrops tutorial](https://tympanus.net/codrops/2020/01/07/playing-with-texture-projection-in-three-js/)
- Cesium community viewshed and visibility analysis is commonly built on ShadowMap with a custom camera and frustum — [Cesium community viewshed thread](https://community.cesium.com/t/cesium-visibility-analysis-viewshed-shadowmap-line-of-sight/31530); [PerspectiveFrustum](https://cesium.com/learn/cesiumjs/ref-doc/PerspectiveFrustum.html)
- Spark.js is a three.js and WebGL2 3DGS renderer that runs on desktop, mobile and WebXR. It mixes splats with meshes and supports procedural splat generation and editing on the GPU (a "shader graph" system) plus formats ply, spz, splat, ksplat and sogs — [sparkjs.dev](https://sparkjs.dev/); [GitHub](https://github.com/sparkjsdev/spark); [procedural splats](https://sparkjs.dev/docs/procedural-splats/)

### Inferences
- **Algorithm (three.js):**
  1. Pass A: render the terrain from the photo camera into a R32F range target, `rangeTex`.
  2. Pass B: render the terrain from any viewer camera. In the fragment shader:
     - `uvw = photoProj * photoView * worldPos` gives photo UV and range.
     - Discard if outside [0,1], or if `range > texture(rangeTex, uv).r * (1 + eps)` (occluded).
     - Discard if `texture(skyMask, uv) > 0.5`.
     - Weight `w = clamp(dot(N, -dirToPhotoCam), 0, 1)^k` to suppress grazing-angle stretching.
     - Output `photo(uv)` blended with base imagery by `w`.
  3. Use slope-scaled epsilon, because grazing terrain at 100 km produces acne similar to shadow maps.
- **Multi-photo blending:** use a texture array with an accumulated weighted average (weights from incidence, resolution in m/pixel, and distance), or a winner-take-all choice of the best ground sample distance (GSD) per fragment.
- **Lens distortion:** undistort the photo first on the CPU or in a WebGL pass, or apply the Brown-Conrady model inverse per fragment.
- **Orthophoto or GeoTIFF export:** render with an orthographic top-down camera over an ENU or UTM grid into a float or RGBA target, read back, and write GeoTIFF in the browser (e.g. the `geotiff` npm package's `writeArrayBuffer`) or on a Python backend (rasterio). For textured 3D, export glTF from the mesh with baked UVs using GLTFExporter, and tile it offline (e.g. with Cesium ion or py3dtiles).
- **Gaussian splatting from one photo:** it is technically possible to emit one flat, surface-aligned splat per photo pixel or per DEM cell (position from the XYZ buffer, colour from the photo, scale from GSD) using Spark procedural splats. But this adds no information over projective texturing. Splats are view-dependent reconstructions that need multi-view optimisation. Verdict: a novelty only; use the textured mesh.

### Gaps
- No published browser implementation of visibility-aware photo draping on DEMs was found. The Cesium viewshed and ShadowMap route is the closest documented analogue.

---

## Q6. Inverse: pixel → ray → terrain intersection (monoplotting) in the browser

### Takeaway
The simplest and most exact approach is to read the precomputed XYZ buffer at the pixel, which is an O(1) lookup. For sub-pixel accuracy or pixels without a buffer, march the ray against the DEM heightfield in a Worker. Monoplotting is an established technique (the WSL Monoplotting Tool).

### Cited Findings
- Monoplotting relates the camera, image and DEM so that a ray from the camera centre through an image point intersects the DEM at the ground point. The WSL Monoplotting Tool (Bozzini et al.) is the reference implementation (desktop) — [WSL Monoplotting Tool](https://www.wsl.ch/en/services-produkte/monoplotting-tool/); [Bozzini et al. paper](https://www.researchgate.net/publication/270365695_A_New_Monoplotting_Tool_to_Extract_Georeferenced_Vector_Data_and_Orthorectified_Raster_Data_from_Oblique_Non-Metric_Photographs); [IntechOpen chapter](https://www.intechopen.com/chapters/61775)
- Cesium: `scene.pickPosition` (depth-based) or `globe.pick(ray)` (geometry-based) — [Scene docs](https://cesium.com/learn/ion-sdk/ref-doc/Scene.html)

### Inferences
- In three.js, `Raycaster` against huge terrain meshes is slow unless you use `three-mesh-bvh`. Prefer XYZ-buffer lookup or a heightfield march (coarse steps growing with distance, then bisection), and convert ENU to geodetic with float64 maths.
- Present uncertainty: at grazing angles a 1 px error maps to hundreds of metres, so show a range along the ray (the pixel footprint).

### Gaps
- No open-source browser monoplotting app was found.

---

## Q7. In-browser ML: sky segmentation and feature matching

### Takeaway
Sky segmentation in the browser is practical: a small SegFormer or DeepLab model via transformers.js v3 or ONNX Runtime Web with WebGPU. Photo-to-render feature matching with SuperPoint and LightGlue runs in ORT-Web, but the WebGPU EP has an open correctness bug (no matches), so WASM or WebNN is currently required. That makes matching slow, and a server GPU is preferable for it.

### Cited Findings
- fabio-sim/LightGlue-ONNX exports SuperPoint/DISK + LightGlue to ONNX (TensorRT and OpenVINO support) — [GitHub](https://github.com/fabio-sim/LightGlue-ONNX)
- onnxruntime issue #25227 (ORT Web 1.22.0): SuperPoint+LightGlue on the **WebGPU EP detects keypoints but produces no matches**, while WASM and WebNN are correct. The issue was unresolved at the time of fetching — [issue #25227](https://github.com/microsoft/onnxruntime/issues/25227)
- ORT Web offers WebGPU, WebGL, WebNN and WASM execution providers. Its docs call WebGPU "experimental" in places — [ORT Web docs](https://onnxruntime.ai/docs/tutorials/web/); [WebGPU EP](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html). IMG.LY reports about a 20× speed-up for background removal with the WebGPU EP versus multi-threaded CPU — [IMG.LY](https://img.ly/blog/browser-background-removal-using-onnx-runtime-webgpu/)
- Transformers.js v3 (Oct 2024) added WebGPU via `device: 'webgpu'` and supports SegFormer and SAM architectures — [HF blog](https://www.huggingface.co/blog/transformersjs-v3); [docs](https://huggingface.co/docs/transformers.js/en/index)
- SAM 2 has been run in WebGPU in the browser — [Lucas Gelfond, SAM2 WebGPU](https://lucasgelfond.online/software/webgpu-sam2/)
- WebGPU shader compilation dominates cold start; warm up with a dummy inference — [SitePoint benchmarks](https://www.sitepoint.com/webgpu-vs-webasm-transformers-js/) (secondary source)

### Inferences
- **Sky mask:** SegFormer-B0 ADE20K (the "sky" class) at 512 px takes roughly 100–300 ms on a laptop with WebGPU. Refine it with the rendered skyline prior, i.e. restrict the boundary search to near the predicted horizon. SAM or SAM2 is useful for interactive corrections. Phones are feasible but slower, with memory constraints that suggest quantized int8 or fp16 models.
- **Matching photo to synthetic render** (cross-domain, e.g. a shaded DEM vs a real photo) is hard even for LightGlue. Skyline or silhouette alignment is usually more robust for mountains. Run LightGlue on the server or through WASM with a small number of keypoints.
- Run all ML in a Web Worker with an OffscreenCanvas to keep React responsive. Configure Vite to serve the `.wasm` and `.mjs` files for ORT and set COOP/COEP headers for multithreaded WASM (SharedArrayBuffer).

### Gaps
- No verified phone benchmarks were found for SegFormer or LightGlue in ORT-Web. The claim that WebGPU is supported in Firefox 130+ and Safari 17.4+ comes from a low-quality blog and is unverified (Safari WebGPU shipped by default later, in Safari 26); verify before relying on it.

---

## Q8. Where to do heavy lifting: browser vs Python backend vs serverless GPU

### Takeaway
Do interactive rendering, auxiliary buffers, labels, overlays, draping preview and monoplotting in the browser. Put DEM preprocessing, global pose search, LightGlue matching and GeoTIFF or 3D Tiles export on a Python backend (FastAPI with rasterio and PyTorch) or on serverless GPU (Modal or Replicate) for bursty ML.

### Cited Findings
- LightGlue-ONNX performance is best with TensorRT and ORT CUDA rather than torch.compile, which favours a server GPU for matching — [LightGlue-ONNX](https://github.com/fabio-sim/LightGlue-ONNX)
- The browser WebGPU EP has a correctness bug for LightGlue — [ORT #25227](https://github.com/microsoft/onnxruntime/issues/25227)

### Inferences
- **Browser:** terrain meshing (Martini/Delatin in a Worker), rendering, MRT readback, skyline extraction, and a local refinement solver (Levenberg–Marquardt on skyline and control-point residuals in TypeScript or WASM). Also sky segmentation (small model), labels, drape preview, and monoplotting.
- **Backend:** DEM tile fetching and caching and coarse horizon-profile precomputation (e.g. a 360° horizon at candidate positions), global pose initialisation (thousands of renders or a skyline database), LightGlue or other heavy matchers, high-resolution orthophoto and GeoTIFF generation (rasterio), and 3D Tiles packaging.
- **Serverless GPU** (Modal, Replicate) suits sporadic ML jobs and avoids idle GPU cost. Cold starts of roughly seconds are acceptable for "solve pose" as a user action.
- With TanStack Start, server functions can proxy DEM and tiles and hide API keys (Cesium ion or MapTiler tokens).

### Gaps
- No primary cost or latency comparison of Modal vs Replicate for this workload was gathered.
