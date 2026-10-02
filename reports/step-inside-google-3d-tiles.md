# 3D Tiles in Step Inside: Google licence analysis and the swisstopo path

*Investigation and build 2026-09-29; "As built" updated 2026-10-02. Every Google policy page was fetched on 2026-09-29 (Maps Platform ToS last modified 2026-08-26, Service Specific Terms 2026-06-10). **UNVERIFIED** marks anything not confirmed from a primary source or code. Related: [step-inside-design.md](step-inside-design.md), [step-inside-results.md](step-inside-results.md), module README [src/lib/tiles3d/README.md](../src/lib/tiles3d/README.md), roadmap S3.*

## Decisions (owner, 2026-09-29)

1. Billing is a **US** Google Cloud account (non-EEA), so tiles are served. The key lives in `.env.local` as `VITE_GOOGLE_TILES_KEY`; it has **no referrer restriction** yet.
2. Rendering Google tiles in deck.gl is accepted; the ToS "non-Google map" question is **not pursued**.
3. Start with swisstopo.

Display-only rules for Google (no measurement, no exports, no persistent cache, attribution) are enforced regardless, because they cost nothing.

## As built (2026-10-02)

Behind `?tiles3d=off|swisstopo|buildings|google|all` (default off), in `src/lib/tiles3d/`, on both deck.gl engines: WebGL2 `tiles3d/deck-layer.ts`, WebGPU `deck-webgpu/layers/tiles3d.ts`, fed by one `Tiles3DSet` selector. Since dd05828f the loader is **`@loaders.gl/tiles` `Tileset3D`** driven by Rigi's own `EnuViewport` (the original `3d-tiles-renderer` + three.js build is gone); Draco decodes in a worker from `public/tiles3d/draco/`.

| Piece | State |
|---|---|
| Near-field mask | Viewport far plane at the 3 km radius; tiles beyond are never requested |
| Fill blend (default) | Inside the photo frame the photo stays the truth; tiles fill outside the frame, behind people and Object pixels, and in disocclusions (`?tiles3dBlend=over` for alignment checks) |
| Clear zones | Tiles fade in over 25–40 m from the photo eye and 5–10 m from the camera (GPS eyes are 7–37 m off) |
| Truth view | swisstopo tints as survey-grade data; Google is hidden |
| Exports | Google forced off during any world/step capture; PNG export refused while Google is on screen |
| Credits | `components/nearfield/Tiles3DCredit.tsx`: Google per-tile copyrights sorted by occurrence, swisstopo credit, "visual only, not measured" |
| Google logo gate | `googleTilesPublicUseAllowed` drops Google from non-dev builds until the official logo ships (`config.ts`, `logoPresent` hard-coded false) |
| T2 object prior | `?tiles3dObjects=on`: nDSM (swissSURFACE3D − swissALTI3D) promotes Far/Terrain cells to Object (`nearfield/object-prior.ts`, `object-evidence.ts`). The swisstopo tile-hit-range half is not built. `applyObjectPrior` throws on any display-only source, so Google can never reach the split. Thresholds uncalibrated |
| Checks | CI `tiles3d` (geoid, placement, datum table, flags); browser `scripts/tiles3d/step-tiles-check.mjs` |

**Measured 2026-09-29 (on the old build; not re-run since the loaders.gl port, browser-unverified):**
- **Datum.** Google is true ellipsoidal ECEF: with N = 50.4 m the p25 of (mesh − DEM) is −0.35 m. swisstopo's Cesium tilesets put MSL heights in the ellipsoid slot (like Rigi), so they need N = 0 (building bases a median 2.8 m below the DEM; with N they'd be buried 53 m). The correction is per source (`config.ts` `heights`). Uncorrected, Google floats 47–55 m above the DEM in Switzerland (EGM2008 N: 50.5 m Niederhorn, 54.7 m Zermatt, 48.4 m Rigi; `geoid.ts`).
- **Isolation.** `sampleAt` bit-identical with tiles on and off; eval-app unchanged (12/14 within 1°, median 6.5 px).
- **Cost.** 132 Google + 90 swisstopo tiles settle in 13–15 s on deck; deck step view 16.2 fps without tiles, 15.4 fps with Google (the step view, not the tiles, is the cost).

**Open:** the official Google Maps logo (16–19 dp) before any public URL; the T2 tile-hit-range half and a smear-gate re-measure on `tools/nearfield/smear/labels.json`; photo drape onto swisstopo facades; an iOS memory budget; a Google coverage survey beyond IMG_7018; referrer-restricting the key.

## Verdict

1. **Technically feasible and cheap**, now built on both engines.
2. **Legally, Google tiles can only be an attributed backdrop, and even that is in doubt.** Google allows "visualization" only. Forbidden: Google depth to place, scale or verify anything; Google content in `.ply`, PNG or video exports (apart from 30 s promotional clips); persistent caching; Google renders into the matcher or any ML. The global ToS (CH or UK billing) also forbids use "with or near a non-Google Map", and a Step Inside scene is a non-Google map by construction. EEA billing accounts get a 403 (Austria and Liechtenstein are EEA; Switzerland and the UK are not).
3. **Google fixes none of Step Inside's measured weaknesses.** The smear gate and hut/tree placement at 100–300 m need measured near-field geometry, which the terms forbid.
4. **Alpine value is doubtful:** Google's photogrammetric surface is city-centric and reported inadequate below about 150 m viewing height. Coverage at our photo sites is **UNVERIFIED**.
5. **swisstopo solves the actual problem with licence-clean data** (§5): open 3D Tiles and lidar nDSM that can be measured, cached, exported and used for anchoring.

Recommendation, unchanged: swisstopo first and into the split (T2); Google only as an optional display-only backdrop, shipped only with a non-EEA billing entity and a written answer on the "non-Google map" clause. Google content stays out of alignment and exports entirely ([negative-results.md](negative-results.md), [licences.md](licences.md)).

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
| (d) Hover lat/lon/elevation on Google pixels | **Unclear.** Google's own CesiumJS sample shows altitude from `pickPosition` on tiles, so a transient display seems tolerated. Logging, storing or exporting picked values would be extraction. Our readout reads the DEM geometry buffer, which sits behind a Google building (§4) | [use-renderer sample](https://developers.google.com/maps/documentation/tile/use-renderer) |
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

## 4. Rules for any third-party surface

- **Provenance:** a display-only source class on the tiles layer, never a splat `PROVENANCE_CODE`. swisstopo surfaces are survey-grade and may tint; Google surfaces are never recoloured (hidden in Truth view).
- **Readout:** `sampleAt` reads the DEM geometry buffer, so hovering a Google building reports the DEM behind it; suppress the readout on Google pixels. swisstopo pixels may use the tile surface.
- **Exports:** force Google off, re-render, then capture. GeoJSON stays DEM-based; splat export uses `scene.splats` only.
- **Never in** (hard rule for Google, enforced in code; the right places for swisstopo): auto-align and the GPU horizon, concordance, the matcher, the anchoring functions (`nearFieldDemRangeFrom`, `fitAnchor`, `groundObjects`, split).

## 5. The licence-clean path: swisstopo on the same stack

| Data | Endpoint (probed 2026-09-29) | Use in Step Inside |
|---|---|---|
| swissBUILDINGS3D 3.0 (LOD2+) | `https://3d.geo.admin.ch/ch.swisstopo.swissbuildings3d.3d/v1/tileset.json`, which points to `20260520/tileset.json` (3D Tiles 1.0, b3dm). HTTP 200, `access-control-allow-origin: *` | Huts and buildings as Object, with correct range, whatever the monocular depth says. Photo drape onto facades. Hole fill |
| Vegetation 3D | `…/ch.swisstopo.vegetation.3d/v1/tileset.json` (200, JSON, `refine: ADD`) | Tree positions and heights to class and ground tree splats |
| swissTLM3D | `…/ch.swisstopo.swisstlm3d.3d/v1/tileset.json` (200) | Poles, lifts, infrastructure |
| swisstopo terrain | `…/ch.swisstopo.terrain.3d/v1/layer.json` (200; quantized-mesh-1.0, `octvertexnormals`, maxzoom 18, version 20250101) | Alternative near-camera DEM for the cliff-lip anchoring (finding 6) |
| swissSURFACE3D Raster minus swissALTI3D | 0.5 m COGs over CORS, which stream with no local tiling ([roadmap.md](roadmap.md) C4, owned elsewhere as concordance WP-F) | An nDSM heights-above-ground mask for the smear split, both in and beyond 150 m. **Reuse C4's signal; don't build a second one** |

- Licence: swisstopo OGD allows data to be "used, distributed and made accessible… enriched and processed and also used commercially", with the attribution "© swisstopo" ([terms](https://www.swisstopo.admin.ch/en/terms-of-use-free-geodata-and-geoservices)). FSDI fair use is about 20k users/day ([FSDI](https://www.geo.admin.ch/en/general-terms-of-use-fsdi)).
- Outside Switzerland:
  - Tirol publishes DGM/DOM lidar at 0.5 m (likely CC BY 4.0, **UNVERIFIED**).
  - Elsewhere, the semantic segmenter from Step Inside v1.1 remains the fallback.
  - Cesium OSM Buildings (LOD1) runs through ion and carries streaming-only terms, so it's a weak substitute.
- Quality compared with Google (**UNVERIFIED**, qualitative): swisstopo geometry is better than Google everywhere in Switzerland (lidar, 0.5 m, cadastral buildings). Its appearance is worse: no facade texture, and the ortho drape smears on steep faces. For Rigi, geometry matters more than appearance, and we already have the photo for texture.

## 6. State of the art (2025–2026, condensed)

- **Splats as a geospatial payload:** Khronos `KHR_gaussian_splatting` RC (Feb 2026, SPZ companion; ratification **UNVERIFIED**); CesiumJS 1.139 implements it, splat 3D Tiles with LOD (Apr 2026). Georeferenced near-field splats could ship as a 3D Tiles 1.1 tileset next to swisstopo meshes, a B2B deliverable with no Google dependency.
- **Mesh-plus-splat compositing** is settled: opaque meshes first writing depth, then sorted splats depth-tested with premultiplied "over". LODGE (arXiv 2505.23158) for LOD seams; Hybrid Mesh-Gaussian (arXiv 2506.06988).
- **Mesh as a 3D cache for generation:** GEN3C (arXiv 2503.03751; Apache-2.0 code, NVIDIA Open Model License weights), Skyfall-GS (arXiv 2510.15869). Legal on swisstopo meshes, forbidden on Google.
- **Aerial–ground registration:** AerialMegaDepth (CVPR 2025) trains on Google Earth renders (not usable); a swisstopo re-creation is a plausible TM research lead.
- **Photo + 3D basemap products:** Smapshot (swisstopo-native frustum billboard), Cesium projective texturing, Street View / Look Around fly-and-crossfade. Google Immersive View splats are not available through the Tiles API.
- **Colour and seam matching** (Reinhard, per-tile colour matrix, Poisson seams) is legal on swisstopo and counts as image analysis on Google, so a Google backdrop must stay colour-mismatched.

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

Libraries: `@loaders.gl/tiles` / `@loaders.gl/3d-tiles` (current loader); [3DTilesRendererJS](https://github.com/NASA-AMMOS/3DTilesRendererJS) v0.5.3 (the 09-29 build); deck.gl `examples/website/google-3d-tiles`.

swisstopo:
- [3D Tiles docs](https://docs.geo.admin.ch/visualize-data/3d-tiles.html)
- [terrain service](https://docs.geo.admin.ch/visualize-data/terrain-service.html)

Prior Rigi decisions:
- Earlier risk register decision: never use Google data for alignment or exports (see [licences.md](licences.md))
