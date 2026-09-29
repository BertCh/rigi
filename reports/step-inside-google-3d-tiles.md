# Google Photorealistic 3D Tiles in Step Inside: investigation

Date: 2026-09-29. This is a research-only investigation: no code was changed. It draws on four parallel research briefs (Google terms, pricing and coverage; rendering libraries and compositing; state of the art; a codebase integration map), plus direct probes of the endpoints. It builds on [step-inside-design.md](step-inside-design.md) and [step-inside-results.md](step-inside-results.md). The cross-project picture is in [status.md](status.md). Every Google policy page was fetched on 2026-09-29. The Maps Platform ToS was last modified on 2026-08-26 and the Service Specific Terms on 2026-06-10. **UNVERIFIED** marks anything not confirmed from a primary source or from code.

## Verdict

1. **Technically it's feasible and moderately cheap.** In three.js it takes a few days. deck.gl needs about a week for a custom layer.
   - `3d-tiles-renderer` 0.5.3 imports and configures cleanly against our three 0.186.1 (tested in a scratchpad).
   - three.js log depth works with the tile materials as they are, so our splats composite against the tiles through the existing depth-test path.
   - deck.gl's stock `Tile3DLayer` can't work inside our CARTESIAN `PhotoView`. The parity path is one shared three.js tile loader plus a thin deck layer that writes our log depth.
2. **Legally, the only thing we could do with Google tiles is show them as an attributed backdrop, and even that is in doubt.** Google's terms allow "visualization" only.
   - **Forbidden:**
     - using Google depth to place, scale or verify anything;
     - putting Google content in `.ply` exports, PNG exports or video exports (apart from 30 s promotional clips);
     - persistent caching;
     - feeding Google renders to the matcher or any ML.
   - **The global ToS (for Swiss or UK billing) also forbids use "with or near a non-Google Map".** A Step Inside scene is, by construction, a non-Google map: Mapterhorn DEM, swissimage/Esri drape, OSM peaks and trails. That clause alone needs a written answer from Google before anything ships.
   - **EEA billing accounts get a 403.** This applies to projects created after 2025-07-08 with an EEA billing address, or projects materially modified after that date. Google confirms it officially. Austria and Liechtenstein are EEA; Switzerland and the UK are not.
3. **It doesn't fix any of Step Inside's measured weaknesses.**
   - The smear gate (4–15% against 80%) and the placement of huts and trees at 100–300 m both need **measured** near-field geometry, and measurement is exactly what the terms forbid.
   - Google would only add pixels, not truth. Those pixels also can't appear in the Truth view as anything but "not ours, not audited".
   - That cuts against Rigi's "geometric truth" positioning.
4. **The alpine value is doubtful.** Google's photogrammetric surface is city-centric. Outside towns it falls back to coarse terrain, and it's reported inadequate below about 150 m viewing height. Per-site coverage at our photo locations (Niederhorn, Rigi, Pilatus, Zermatt, Grindelwald, Säntis) is **UNVERIFIED** and needs a key to probe.
5. **The same stack solves the actual problem with licence-clean data.** swisstopo serves open 3D Tiles (swissBUILDINGS3D, vegetation, swissTLM3D) and quantized-mesh terrain from `3d.geo.admin.ch`, with `CORS *` (verified today). The licence is Swiss open government data, which allows commercial use, analysis and processing with attribution. swissSURFACE3D minus swissALTI3D (lidar, 0.5 m) gives heights above ground directly. **Those can be measured, cached, exported and used for anchoring.**

**Recommendation.**
- Build a **source-agnostic 3D Tiles layer** for Step Inside.
- Prove it on **swisstopo first**, and wire swisstopo buildings, vegetation and nDSM into the depth split. That is the smear-gate fix.
- Add Google only as an **optional, display-only "Google backdrop"** behind a flag. Ship it only once two things are in place:
  - a non-EEA billing entity;
  - a written answer from Google on the "non-Google map" clause.

Until then, the prior decision stands: keep Google content out of alignment and exports entirely (competitive roadmap risk register).

## 1. What Google 3D Tiles are, mechanically

| Item | Fact | Source |
|---|---|---|
| Root | `https://tile.googleapis.com/v1/3dtiles/root.json?key=…`. Child URIs are relative and carry `?session=…`, which must be re-attached to every tile request. A keyless probe today returns 403 `PERMISSION_DENIED` | [3d-tiles](https://developers.google.com/maps/documentation/tile/3d-tiles), [create-renderer](https://developers.google.com/maps/documentation/tile/create-renderer) |
| Session | "at least three hours of tile requests from a single root tileset request", then a new root request | same |
| Content | OGC 3D Tiles, glTF/GLB, Draco. JPEG textures, `KHR_materials_unlit` (baked lighting), skirts (**UNVERIFIED**, community reports) | [Cesium forum](https://community.cesium.com/t/unreal-5-1-problem-with-google-photorealistic-3d-tiles-when-ignoring-khr-materials-unlit/25592) |
| Frame | ECEF, WGS84 **ellipsoidal** heights. It's a DSM: trees and buildings are baked in, with no separate bare earth | [Cesium community](https://community.cesium.com/t/google-photorealistic-3d-tileset-terrain-data/23924) |
| Attribution | Collect `asset.copyright` from every displayed tile, then aggregate, sort by occurrence and show in one line. The "Google Maps" logo must be 16–19 dp high with 10/10/10/5 dp clear space, and must not be overlapped by other logos | [policies](https://developers.google.com/maps/documentation/tile/policies) |
| Pricing | Enterprise SKU. 1,000 free per month, then $6.00 per 1,000 (falling to $2.40 above 5M). In practice the root request is what's billed, though Google's pages are worded inconsistently (open question 5). Limits: 10,000 root requests per day, 12,000 QPM tile rate | [pricing](https://developers.google.com/maps/billing-and-pricing/pricing), [usage](https://developers.google.com/maps/documentation/tile/usage-and-billing) |
| Cost for us | About one root request per Step Inside entry, plus one per 3 h. Hobby scale is effectively free. 100k entries a month ≈ $600 | derived |
| Coverage | Country-level "good" for CH, AT, FR, IT, DE. Surface data is limited to the "blue" areas on the 3D Maps coverage page. Google Earth coverage doesn't imply tile coverage (Cesium staff, 2026-03) | [coverage](https://developers.google.com/maps/coverage), [3D coverage](https://developers.google.com/maps/documentation/javascript/3d/coverage), [thread](https://community.cesium.com/t/differences-with-google-maps-and-earth-on-covering-3dtiles/45582) |
| Alternatives from Google | `Map3DElement` (`gmp-map-3d`) is a closed renderer: camera APIs, markers and extension-free glTF models only. No shader hook, no shared depth, no splats. Cesium ion resells the tiles, but its flow-down terms are **stricter** (they keep "no use with non-Google maps" for everyone and forbid Google content in any document) | [3d-map ref](https://developers.google.com/maps/documentation/javascript/reference/3d-map), [Cesium B-2](https://cesium.com/legal/terms-for-google/) |

## 2. The licence analysis

### Controlling text (exact quotes)

- **Map Tiles API policies:**
  - "You may not use Map Tiles API for any non-visualization use cases, such as: Image analysis / Machine interpretation / Object detection or identification / Geodata extraction or resale / Offline uses".
  - "you must not pre-fetch, index, store, or cache any Content except under the limited conditions stated in the terms".
  - "You may overlay your own 3D objects on Photorealistic 3D Tiles as long as the 3D objects aren't extracted, traced, or otherwise derived by hand or machine from Photorealistic 3D Tiles".
  - For hybrid scenes: "you must clearly state in your UI attribution string or user flow which part of the scene originates from Google Maps data".
  - Promotional video: "no more than 30 seconds", marked "for promotional purposes only".
- **Global ToS §3.2.3** ([terms](https://cloud.google.com/maps-platform/terms)):
  - (a) no export, extraction or scraping, and no "pre-fetch, index, store, reshare, or rehost";
  - (b) no caching except as the Service Specific Terms permit, and those have no Map Tiles carve-out;
  - (c)(vii) no use "to improve machine learning and artificial intelligence models, including to train, test, validate or fine-tune";
  - **(e) "Customer will not use the Google Maps Core Services with or near a non-Google Map in a Customer Application."** The term "non-Google Map" is undefined.
- **EEA ToS §3.3.2** ([EEA terms](https://cloud.google.com/terms/maps-platform/eea)) drops (e), **but** EEA projects can't get 3D Tiles at all: "Photorealistic 3D tiles are not available. The Map Tiles API will throw a 403 HTTP error" ([EEA map-tiles](https://developers.google.com/maps/comms/eea/map-tiles)). Whether terms apply is decided by the billing address, not the viewer's location. Nothing indicates that Google blocks by viewer IP (**UNVERIFIED**).

### Rigi use cases

| Use | Verdict | Why |
|---|---|---|
| (a) Google tiles as a backdrop in Step Inside | **Unclear, leaning allowed** with logo, sorted credits and an in-UI "Google surfaces" legend. The blocker is ToS §3.2.3(e): our DEM, drape and OSM layers share the scene. Lowest-risk form: hide our DEM mesh and drape wherever Google tiles render, and don't show non-Google base imagery in that view | policies, hybrid clause; ToS (e) |
| (b) Splats depth-occluded by the Google mesh | **Likely allowed**: ordinary rendering and compositing | overlay clause |
| (c) Google depth for anchoring, scaling, grounding, the depth split or pose checks | **Forbidden** | "machine interpretation", "geodata extraction", "derived by hand or machine"; (c)(vii) for any ML use |
| (d) Hover lat/lon/elevation on Google pixels | **Unclear.** Google's own CesiumJS sample shows altitude from `pickPosition` on tiles, so a transient display seems tolerated. Logging, storing or exporting picked values would be extraction. Our readout currently reads the DEM geometry buffer, which would sit behind a Google building. See §4.5 | [use-renderer sample](https://developers.google.com/maps/documentation/tile/use-renderer) |
| (e) PNG or video export containing tiles | **Forbidden** as a user feature | ToS (a); video rule; Cesium flow-down |
| (f) `.ply` / `.splat` export | **Allowed only if** nothing in it came from Google, including scale or pose derived from Google depth. Today's pipeline satisfies this automatically as long as (c) is respected | ToS (a), (c) |
| (g) Service-worker, disk or IndexedDB tile cache | **Forbidden.** Only the browser HTTP cache, honouring `Cache-Control` | policies; ToS (a), (b) |
| (h) Google renders into the matcher, concordance, sky/segment models, benchmarks or training | **Forbidden** | ToS (c)(vii); policies |
| (i) Projecting our photo onto the Google mesh, or tinting Google surfaces in Truth view | **Unclear.** "Modify" in the ToS is about attribution, but recolouring Google content risks brand confusion. Recommendation: never recolour Google pixels. Hide them in Truth view or show them untinted with a legend | ToS §3.2.2(b); EEA SST §2 |

Research use gives no shelter here. The Map Tiles policies have no research exemption. The academic datasets built on Google Earth (CityDreamer's GoogleEarth set, AerialMegaDepth, Bearing-UAV-90K) rely on the Earth Studio allowance ("research, education, film and nonprofit"), and that allowance doesn't carry over to a product.

## 3. What Google tiles would and wouldn't buy Step Inside

| Step Inside problem (from the results) | Would Google tiles help? |
|---|---|
| Smear gate: huts and trees at 100–300 m classed Far (finding 5) | **No.** The fix is to class them from surface geometry, which is measurement. swisstopo nDSM or buildings can do it legally |
| Monocular range compression and the anchor curve (findings 1–2) | **No.** Fitting depth to a Google DSM is forbidden (c) |
| Cliff-lip anchoring at IMG_7059 (finding 6) | **No**, for the same reason. swissSURFACE3D/ALTI3D at 0.5 m would help |
| Disocclusion holes when you step off the camera | **Visually, partly.** Google texture fills the holes behind splats when viewed from off-axis. But GEN3C-style conditioning on Google renders is forbidden (c)(vii). Filling from a swissimage-textured swisstopo mesh is allowed |
| The far field beyond the drape looks flat and "map-like" | **Yes, where coverage is photogrammetric.** Towns and villages look photoreal. On peaks it's roughly the DEM we already have, with baked lighting that clashes with the photo's sun and season (winter photo, summer mesh) |
| The share-beta "wow" moment | **Possibly**, but screenshots and videos of it can't be exported (e), which hurts shareability |

## 4. Integration design (if we proceed)

### 4.1 Module and loader

- Put the new code in `src/lib/tiles3d/**`, a source-agnostic module with `source: "swisstopo-buildings" | "swisstopo-vegetation" | "google"`.
- **Dependency:** `3d-tiles-renderer@0.5.3` (Apache-2.0; peer `three >=0.167`). Adding it to package.json needs your OK, because package.json is shared across sessions. Draco comes from `three/examples/jsm/libs/draco`.
- Plugins:
  - **Google auth:** `GoogleCloudAuthPlugin({ apiToken, autoRefreshToken: true })`, imported from `3d-tiles-renderer/core/plugins`; the old import path is deprecated.
  - **glTF and memory:** `GLTFExtensionsPlugin({ dracoLoader, rtc: true })`, `TileCompressionPlugin({ disableMipmaps: false })` (mipmaps prevent grazing-angle shimmer at ground level), `TilesFadePlugin` (dithered, so tiles stay opaque) and `UnloadTilesPlugin`.
  - **Region:** a small custom `NearFieldMask` plugin that culls tiles outside an ECEF sphere through `calculateTileViewError`. Don't use `LoadRegionPlugin`. Its regions *force-load* everything inside them and use a metric error target.
  - **Avoid** `BatchedTilesPlugin`: it forces one shared material, which breaks per-tile material patches.
- LOD: `errorTarget` ≈ 12 for a ground-level, narrow-FOV photo camera. The library reads `camera.projectionMatrix` directly, so our off-axis photo projection works for tile selection.
- **API key:** use `import.meta.env.VITE_GOOGLE_TILES_KEY`, referrer-restricted and API-restricted. No key exists in the repo or the environment today. The flag is `?tiles3d=off|swisstopo|google`, then `rigi.tiles3d`, then off by default, following the existing URL → localStorage → default convention (`gpu/device.ts:21-25`, `deck/terrain-mode.ts:22-31`).

### 4.2 Frame and vertical datum (a 50 m trap)

- The ENU frame is `new EnuFrame(photo.lat, photo.lon, 0)` (`engine.ts:551`, `deck/engine.ts:306`; `geodesy.ts:36-107`) with the origin at ellipsoid height 0.
- **Rigi feeds orthometric Mapterhorn heights into the ellipsoid formula as if they were ellipsoidal** (N = 0; `export/camera.ts:38-43`). Google tiles, and swisstopo's Cesium 3D Tiles (**UNVERIFIED**, but they're built for CesiumJS), are in true ellipsoidal ECEF.
- Unless corrected, they will float **about 47–54 m above our DEM** in Switzerland (EGM2008 N; verify with PROJ `us_nga_egm08_25.tif`).
- Placement: `tiles.group.matrix = ENU_from_ECEF(lat, lon, h0 = N)`, which subtracts N. Set `matrixAutoUpdate = false`.
  - three.js composes the matrices in float64 on the CPU, so ECEF magnitude causes no precision loss.
  - The `EnuFrame.fromGeo` refraction lift (k = 0.13) is 4 cm at 2 km, so we can ignore it inside the near field.
- **Check it empirically on every load:** take the median of (tile surface − DEM) on open ground (≥ 5 samples), and warn if it's more than 3 m.
  - This is a **diagnostic, not a placement input**. For Google, even this readback is arguably measurement, so run it only on swisstopo, or only in dev.
  - Measure the constant N offset once on swisstopo data and apply it everywhere.

### 4.3 three.js engine

- **Layer isolation is mandatory.** Every three.js offscreen pass renders the whole `this.scene` on layer 0:
  - the range/geometry buffer (`renderGeometry`, `engine.ts:1402-1423`), which feeds `sampleAt` and the drape shadow map;
  - the horizon fallback (`computeHorizon`, `:948-975`);
  - the silhouette re-rank (`silhouetteScore`, `:2020-2045`);
  - the stats and normal passes (`:1255`, `:1286`).

  Put the tiles on a new `TILES3D_LAYER = 8`, next to `NEARFIELD_LAYER = 7` (`:117`, `:629`), and enable it on `worldCam` **only while stepping**, since `worldCam` also serves world mode.
- Render loop: rendering is on demand (`requestRender`, `:1392`). Call `tiles.update()` in `renderWorld` before `renderer.render(this.scene, this.worldCam)` (`:1772`). Hook `load-model` → `requestRender()`, the same way the splat-sort polling works (`:2270-2284`).
- Compositing order already works: the opaque tiles write log depth, and the splats test without writing depth (`three-splats.ts:10-12`). The photo sky sphere sits at `0.999999·w` (`step-camera.ts:366-412`), behind the tiles.
- DEM/tile overlap:
  - Inside the mask, bias the DEM down 0.5–1 m, or hide DEM tiles that are fully covered, to avoid z-fighting.
  - Google is a DSM, so where it's higher it wins the depth test.
  - Fade from tiles to DEM at 1.5–2.5 km with a dithered smoothstep in a `load-model` material patch.
  - Run the existing `terrain.nearFade` in reverse on the DEM side.
- **Photo drape onto tiles** (projective, `materials.ts:460-490`): for swisstopo this is legal and valuable.
  - The photo camera's range buffer must then include the tiles, or the DEM-only visibility test paints the photo onto tree trunks. Render them into `geoRT` on a separate pass variant, not layer 0.
  - Tighten the bias from `seen*1.015 + 15` to about `seen*1.003 + 0.3` for 20–200 m surfaces.
  - For Google, don't drape (§2 row i).

### 4.4 deck.gl engine

- `Tile3DLayer` won't work here. Tile selection (`@loaders.gl/tiles/.../frame-state.ts`) needs longitude/latitude viewport fields, `unprojectPosition` and a 60° FOV constant (`sseDenominator 1.15`). Its sub-layers draw in `METER_OFFSETS`, which comes out wrong in our CARTESIAN `PhotoViewport` (`deck/photo-view.ts:24-60`).
- **Parity approach:**
  - Run the same `TilesRenderer` headless, driven by a three.js `PerspectiveCamera` that mirrors `PhotoViewport` / `WorldViewport` (projection and `matrixWorld`). It becomes the single tile selector for both engines, so both engines load identical tiles.
  - A new `src/lib/deck/tiles3d-layer.ts` (a `Layer` subclass) caches one luma `Model` per tile mesh on `load-model` and frees it on `dispose-model`. It draws with `modelMatrix = ENU_from_ECEF · tileMatrix` (float64 on the CPU).
  - The layer writes `gl_FragDepth = log2(1 + w) · logDepthFC` with `LOG_DEPTH_FAR = 1e9` (`terrain-layer.ts:56,284,395`), with depthWrite on and `less-equal`, or reuses `LogDepthExtension` (`world-view.ts:312-331`).
  - Insert it in `worldLayers()` **before the splats** (`deck/engine.ts:2026-2028`: "everything opaque must be in the depth buffer first").
- The offscreen passes are already safe: `PhotoCompositor` and `geometry-pass.ts` draw only layers that pass `isTerrainTile` (`composite.ts:339-342`; `geometry-pass.ts:50-60`). The new layer must **not** subclass `TerrainTileLayer`.
- deck.gl gotcha: route per-frame tile arrivals through `updateLayers` in world mode, not `updateComposite`. The composite cache only applies to photo mode (see the deck-renderer memory).

### 4.5 Provenance, readout and exports

- **Provenance:** add a display-only source class, additively in `types.ts`. For example, `ThirdPartySurface = "google" | "swisstopo"` on the tiles layer, not a new `PROVENANCE_CODE`, so splat exports never see it.
  - swisstopo surfaces are genuinely `dem`-grade truth (lidar or cadastral models), and can tint as a new "survey model" class.
  - Google surfaces are **not tinted**. They're hidden in Truth view, or shown with a legend reading "Google Maps 3D, visual only".
- **Hover readout:** `sampleAt` reads the DEM geometry buffer (`engine.ts:1789`, `deck/engine.ts:1222-1245`). With tiles excluded from it, hovering a Google building reports the DEM behind it.
  - Render a cheap "tile coverage" mask (tile layer only, id colour) in step mode.
  - On Google pixels, show "Google surface, no measurement" and suppress the readout.
  - On swisstopo pixels, the readout can use the tile surface. That means adding the tiles to a step-mode geometry pass, which is legal.
- **Exports:**
  - three.js `exportImage` in world or step mode captures the live canvas (`engine.ts:2117-2127`), so it **would capture Google tiles**.
  - deck.gl exports the photo composite when stepping from photo view and captures the world canvas only in `mode === "world"` (`deck/engine.ts:2066-2089`). That's already an engine asymmetry.
  - Both must force the Google layer off, then re-render, then capture.
  - GeoJSON uses `sampleAt`, so it stays DEM-based. COLMAP, pose, XMP and KMZ don't touch the scene. Splat export uses `scene.splats` only (`export/splat.ts:417-429`).
  - Add a `export-check.ts` assertion: "no tiles3d:google layer visible during capture".
- **Attribution UI:** today attribution is static text only (`PhotoWorkspace.tsx:1630-1633`). Google needs a new on-canvas component: the logo plus the sorted `tiles.getAttributions()` string, never overlapped. swisstopo needs "© swisstopo" added to the static line.
- **Never in:**
  - auto-align or GPU horizon (`gpu/align`, `horizon-fast-app.ts`, which don't touch the scene);
  - concordance (`src/lib/concord`);
  - the matcher;
  - the anchoring functions: `nearFieldDemRangeFrom` (`near-dem.ts:141-174`), `fitAnchor`, `groundObjects`, `split`.

  For Google this is a hard rule enforced by a check. For swisstopo, these are exactly the places where it *should* go (§5).

### 4.6 Performance (estimates, **UNVERIFIED**; measure first)

- A ground-level Google view at `errorTarget` 12–20 is roughly:
  - 150–400 visible tiles;
  - 0.5–2 M triangles;
  - one draw call per tile mesh;
  - 100–300 MB of GPU memory.

  The 2.5 km mask and the narrow photo FOV should put us at the low end.
- Next to 1M splats (35–45 fps today in three.js, 38 in deck), expect tiles to cost 1–3 ms on desktop.
- Draco decoding runs in workers. Cap `parseQueue.maxJobs` to avoid upload hitches.
- iOS: Safari tab memory is the binding limit. Set `lruCache.maxBytesSize` to about 150 MB and cap splats at 200–300k. deck.gl issues #7430 and #9079 report iOS crashes with Google tiles.
- Instrument with `tiles.stats`, `visibleTiles.size`, `lruCache.cachedBytes` and `renderer.info`.
- Use the render lock for any browser runs.

## 5. The licence-clean path: swisstopo on the same stack

| Data | Endpoint (probed 2026-09-29) | Use in Step Inside |
|---|---|---|
| swissBUILDINGS3D 3.0 (LOD2+) | `https://3d.geo.admin.ch/ch.swisstopo.swissbuildings3d.3d/v1/tileset.json`, which points to `20260520/tileset.json` (3D Tiles 1.0, b3dm). HTTP 200, `access-control-allow-origin: *` | Huts and buildings as Object, with correct range, whatever the monocular depth says. Photo drape onto facades. Hole fill |
| Vegetation 3D | `…/ch.swisstopo.vegetation.3d/v1/tileset.json` (200, JSON, `refine: ADD`) | Tree positions and heights to class and ground tree splats |
| swissTLM3D | `…/ch.swisstopo.swisstlm3d.3d/v1/tileset.json` (200) | Poles, lifts, infrastructure |
| swisstopo terrain | `…/ch.swisstopo.terrain.3d/v1/layer.json` (200; quantized-mesh-1.0, `octvertexnormals`, maxzoom 18, version 20250101) | Alternative near-camera DEM for the cliff-lip anchoring (finding 6) |
| swissSURFACE3D Raster minus swissALTI3D | 0.5 m COGs over CORS, which stream with no local tiling ([roadmap.md](roadmap.md) C4, owned by session f3 as concordance WP-F) | An nDSM heights-above-ground mask for the smear split, both in and beyond 150 m. **Reuse C4's signal; don't build a second one** |

- Licence: swisstopo OGD allows data to be "used, distributed and made accessible… enriched and processed and also used commercially", with the attribution "© swisstopo" ([terms](https://www.swisstopo.admin.ch/en/terms-of-use-free-geodata-and-geoservices)). FSDI fair use is about 20k users/day ([FSDI](https://www.geo.admin.ch/en/general-terms-of-use-fsdi)).
- Outside Switzerland:
  - Tirol publishes DGM/DOM lidar at 0.5 m (likely CC BY 4.0, **UNVERIFIED**).
  - Elsewhere, the semantic segmenter from Step Inside v1.1 remains the fallback.
  - Cesium OSM Buildings (LOD1) runs through ion and carries streaming-only terms, so it's a weak substitute.
- Quality compared with Google (**UNVERIFIED**, qualitative): swisstopo geometry is better than Google everywhere in Switzerland (lidar, 0.5 m, cadastral buildings). Its appearance is worse: no facade texture, and the ortho drape smears on steep faces. For Rigi, geometry matters more than appearance, and we already have the photo for texture.

## 6. State of the art relevant here (2025–2026)

- **Splats became a standard geospatial payload.**
  - The Khronos `KHR_gaussian_splatting` release candidate came out in Feb 2026, with an SPZ compression companion. Ratification was targeted for Q2 2026 (**UNVERIFIED** whether it has happened).
  - CesiumJS 1.139 implements it, and splat 3D Tiles with LOD arrived in Apr 2026 ([Cesium blog](https://cesium.com/blog/2026/04/27/3d-gaussian-splats-lod/)).
  - `3d-tiles-renderer` can read splat content in 3D Tiles.
  - This makes the design doc's "later, 3D Tiles" export concrete. We can publish the georeferenced near-field splats as a 3D Tiles 1.1 tileset next to swisstopo meshes. That's a B2B deliverable with no Google dependency.
- **Mesh-plus-splat compositing** is settled practice: opaque meshes first, writing depth, then sorted splats tested against depth with premultiplied "over" blending. Spark 2.0, GaussianSplats3D and our own renderers all do this. LODGE (NeurIPS 2025, arXiv 2505.23158) adds opacity cross-fades at LOD seams. Hybrid Mesh-Gaussian (IJCAI 2025, arXiv 2506.06988) jointly optimises mesh for planar regions and Gaussians for detail. That's relevant if P2 roll spots ever get a real multi-view capture.
- **Using a mesh as a "3D cache" for generation.** GEN3C (arXiv 2503.03751; code Apache-2.0, NVIDIA Open Model License weights) and Skyfall-GS (arXiv 2510.15869) fill disocclusions consistently by conditioning on renders of known geometry. **On swisstopo meshes this is legal.** On Google it's forbidden (§2 row h). That's a better input for the existing GEN3C adapter than the monocular 3D cache.
- **Aerial–ground registration.** AerialMegaDepth (CVPR 2025, arXiv 2504.13157) lifts DUSt3R aerial–ground registration from under 5% to about 56% within 5°, by training on Google Earth mesh renders co-registered with ground photos. That's not usable as-is (Google data). A **swisstopo re-creation**, rendering swissSURFACE3D + swissimage at our benchmark poses, is a plausible matcher-research lead for the TM program (owned elsewhere; noted only).
- **How products mix a photo with a 3D basemap.**
  - Smapshot (EPFL/HEIG-VD, swisstopo-native, closest prior art) uses a frustum billboard with an opacity slider.
  - Cesium uses projective texturing with shadow-map visibility.
  - Street View and Look Around fly to the pose and then crossfade.

  Step Inside already does projective drape plus fly-to-pose, and the Truth view is a provenance-aware version of the swipe comparison. Google Immersive View's splats (Galaxy XR, Sep 2025) are **not** available through the Tiles API, and nothing indicates Google will serve splat tiles.
- **Colour, season and seam matching:**
  - Reinhard/Lαβ transfer or a per-tile 3×3 colour matrix on co-visible pixels;
  - sun direction from EXIF time and the solved pose;
  - multi-band or Poisson seam blending;
  - "Let There Be Color" seam levelling.

  All are standard, and all are legal on swisstopo. **On Google tiles every one of them counts as image analysis**, so a Google backdrop has to stay colour-mismatched: baked summer lighting against the photo's sun and snow.

## 7. Phased plan

| Phase | Scope | Exit gate |
|---|---|---|
| **T0: shared tiles layer on swisstopo, three.js** | `src/lib/tiles3d/**`: loader, `NearFieldMask`, the ENU+N matrix, layer 8 isolation, fade to DEM, attribution line. `?tiles3d=swisstopo` in step mode. Needs your OK for the `3d-tiles-renderer` dependency | Buildings and trees sit on the DEM within 1 m on 5 CH photos. style-baseline 16/16, eval-app unchanged, a nearfield check proves tiles are absent from `renderGeometry`, horizon, silhouette and export. Holds 60 fps at 200k splats |
| **T1: deck.gl parity** | `deck/tiles3d-layer.ts` fed by the shared selector, log depth | deck smoke 4/4. Same tile set as three.js. Visual parity on the 5 photos |
| **T2: swisstopo into the split (the real win)** | Building and vegetation tiles (and optionally nDSM) mark Object pixels. Tile range grounds object splats. swisstopo tile range added to the step-mode geometry pass for the readout. Photo drape onto facades | Re-measure the smear gate on the existing `tools/nearfield/smear/labels.json`, with the frozen labels and the same metric as the results doc, against the 80% target |
| **T3: Google backdrop (optional)** | `?tiles3d=google`, display-only: the DEM and drape are hidden under Google coverage, no recolouring, Google is hidden in Truth view, the readout is suppressed on Google pixels, exports force it off, the logo and credits component is shown. **Blocked** on decisions 1–2 below | A check suite proves Google content never reaches `sampleAt`, anchoring, split, align, concordance, matcher, any export, or a persistent cache. Legal sign-off recorded |

## Decisions for you

1. **Billing entity.** Google 3D Tiles are only available to a **non-EEA** billing account (CH or UK), and a new EEA project gets a 403. Do you have, or want, a Swiss or UK GCP billing account for this? If it's Austria-based or another EEA country, T3 is off the table: only the closed `Map3DElement` remains, and that can't host our splats or DEM.
2. **The "non-Google map" clause.** Under the global ToS, T3 needs a written answer from Google (open question 1 below). Do you want to ask, or drop T3?
3. **The dependency.** Is it OK to add `3d-tiles-renderer@0.5.3` (Apache-2.0) to package.json? It's needed for T0 whichever data source we use.
4. **Sequencing.** T2 overlaps with roadmap C4 (the shared nDSM near-field study, session f3) and S1 (smear v1.1). Proposal: T2 uses C4's nDSM mask plus the streamed building and vegetation tiles as S1's Object signal. That could stand in for S1's missing segmenter inside Switzerland. Should T0–T2 go ahead as part of S1?

## Open questions for Google (sales or legal)

1. Is a scene combining 3D Tiles with our own DEM mesh, photo drape and OSM overlays "use with or near a non-Google Map" (§3.2.3(e))? Does hiding our DEM wherever Google tiles show change that?
2. Is depth-occluding our own 3D content against the Google mesh "visualization", as opposed to "machine interpretation"?
3. Is a transient on-screen coordinate or elevation readout from picking allowed (Google's own sample does it)?
4. May users export screenshots or short clips with attribution, outside the 30 s promotional rule?
5. Billing: is only the root request billed? The SKU page says "Request that returns a 3D tile".
6. Does a CH-billed project stay non-EEA when most end users are in the EEA?
7. For Cesium ion's resale: are the tiles served to EEA ion accounts, and what does a public-app licence cost?

## Sources

The main Google pages, all fetched 2026-09-29:
- [Map Tiles API policies](https://developers.google.com/maps/documentation/tile/policies)
- [3D Tiles overview](https://developers.google.com/maps/documentation/tile/3d-tiles)
- [create a renderer](https://developers.google.com/maps/documentation/tile/create-renderer)
- [use a renderer](https://developers.google.com/maps/documentation/tile/use-renderer)
- [usage and billing](https://developers.google.com/maps/documentation/tile/usage-and-billing)
- [pricing](https://developers.google.com/maps/billing-and-pricing/pricing)
- [global ToS](https://cloud.google.com/maps-platform/terms)
- [EEA ToS](https://cloud.google.com/terms/maps-platform/eea)
- [EEA Map Tiles notice](https://developers.google.com/maps/comms/eea/map-tiles)
- [EEA FAQ](https://developers.google.com/maps/comms/eea/faq)
- [coverage](https://developers.google.com/maps/coverage)

Libraries:
- [3DTilesRendererJS](https://github.com/NASA-AMMOS/3DTilesRendererJS): v0.5.3, source read in the scratchpad (`GoogleCloudAuth.js`, `TilesRendererBase`, the plugin contracts).
- deck.gl `examples/website/google-3d-tiles`.
- `@loaders.gl/tiles` 4.5.2 `frame-state.ts`, from local node_modules.

swisstopo:
- [3D Tiles docs](https://docs.geo.admin.ch/visualize-data/3d-tiles.html)
- [terrain service](https://docs.geo.admin.ch/visualize-data/terrain-service.html)

Prior Rigi decisions:
- [Rigi competitive landscape and roadmap.md](<Rigi competitive landscape and roadmap.md>) (risk register: "Never use for alignment or exports")
- [research_notes/Rigi competitive landscape and roadmap/platforms_infrastructure.md](<../research_notes/Rigi competitive landscape and roadmap/platforms_infrastructure.md>) §6
