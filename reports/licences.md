# Licence register (roadmap N2)

> 2026-09-29. This is the gate before any public URL (roadmap N2 → L1). It covers every external data, tile, API and model source that the app, the pipeline and the tools call. Model licences for Step Inside are recorded in [`research_notes/step_inside_models_2026-09.md`](../research_notes/step_inside_models_2026-09.md). This page links to them and does not copy them. This page replaces an earlier short licensing and data risk register.
>
> Code for this item is in `src/lib/licences/` (attribution, imagery providers and flags), `src/lib/osm/extract.ts` and `tools/osm/extract-peaks.mjs` (the Overpass pre-extract), and `scripts/licences-check.ts` (the checks). **Every new behaviour is opt-in, and the defaults are unchanged.**

## Decisions (2026-10-01 closure pass)

Owner instruction: "whatever makes the most sense". Primary sources were read on 2026-10-01.

- **Esri World Imagery (item 1): kept as default for development and local use, with its credit shown.** Esri's data-attribution text for World Imagery is "Sources: Esri, Maxar, Earthstar Geographics, and the GIS User Community" (doc.arcgis.com/en/data-appliance/latest/imagery-elevation/world-imagery.htm); basemap attribution is required in deployed apps, plus "Powered by Esri" when Esri APIs or services are used (developers.arcgis.com/documentation/esri-and-data-attribution/). The classic UI line (`CLASSIC_UI_LINE`) and the export footer (`DEFAULT_ATTRIBUTION`) only said "Esri"; both now carry the full source credit (the full mode already did). The export footer is longer, so browser gates that compare footer pixels need a re-run. Unverified: the exact access terms of the key-less `server.arcgisonline.com` tile URL (the Esri legal pages did not return the clause; a search summary says an ArcGIS account is required and commercial use excluded). A public production deployment should therefore use an ArcGIS Location Platform key via `?imagery=custom` or `?imagery=swisstopo`. Server-side analysis of Esri pixels (item 6) stays not cleared.
- **Mapterhorn (item 4):** mapterhorn.com/attribution says only "Mapterhorn uses the following open-data sources" and links `attribution.json`; the Data Access page lists the zxy endpoint `https://tiles.mapterhorn.com/{z}/{x}/{y}.webp` and thanks Cloudflare for "R2 Object Storage, Workers, and bandwidth"; the GitHub README says "Code: BSD-3". The TileJSON attribution is `© Mapterhorn` with that link. No usage, rate-limit or production-traffic policy is published. Decision: keep the credit, self-host for sustained high traffic (steps below) or contact the maintainers.
- **MediaPipe models:** run on `src/lib/nn` from fp16 safetensors converted by `scripts/models/mediapipe-seg.py` (2026-10-02); the `@mediapipe/tasks-vision` runtime (Apache-2.0) was removed. The selfie_multiclass_256 model card PDF states "LICENSED UNDER Apache License, Version 2.0". The DeepLab v3 model has no model card on the MediaPipe page (it points to TensorFlow Hub); its licence is unverified.
- **onnxruntime-web 1.30.0:** package.json `MIT`. Since 2026-10-02 a devDependency only (sky parity oracle, Landeskarte offline bake); nothing ships it, so `public/licenses/onnxruntime-*` were removed. Re-add the notices if a shipped path ever imports it again.
- **DISK:** github.com/cvlab-epfl/disk `LICENSE.txt` is "Apache License, Version 2.0" (GitHub API: Apache-2.0); the matcher uses it through LightGlue's `DISK` extractor.
- **GEN3C:** huggingface.co/nvidia/GEN3C-Cosmos-7B: "released under the NVIDIA Open Model License", "ready for commercial/non-commercial use"; rights terminate if technical limitations or guardrails are bypassed. Rigi does not run it. `remote.ts` builds request packages and makes no network call; `inpaint-client.ts` is a `fetch` client for the local service. Neither contains upstream code.
- **Terroir packs:** `public/terroir/thunersee/pack.json` has a credit, licence and URL for each of six sources. Closed.
- **3D tiles credits:** Google Map Tiles policy (developers.google.com/maps/documentation/tile/policies) requires clear Google Maps attribution with the logo and the data copyrights, not overlapped, and forbids caching, offline use, image analysis and deriving 3D objects. `Tiles3DCredit.tsx` shows the copyrights and, when the official file `public/tiles3d/google-maps-logo.png` exists (Google supplies it; not in the repository, see `public/tiles3d/README.md`), the logo; without it a plain "Google Maps" text label that is not the logo: a gap, acceptable only while `?tiles3d=google` is off by default and unreferenced publicly. swisstopo's terms (swisstopo.admin.ch terms of use) require one of the source references, including "©swisstopo", and allow commercial use; the app shows "Buildings © swisstopo". Closed.
- **`public/baseline/`:** not in the repository; local evaluation photographs.

## Decisions (original list; the items above close 1, 4 and 6 as far as is possible without the owner paying for an ArcGIS key or hosting)

1. **Esri World Imagery.** Keep it (with an ArcGIS Location Platform account and key, under Esri's terms), replace it, or ship SWISSIMAGE-only. Today it is the global satellite default and the fallback inside Switzerland. `?imagery=swisstopo` is licence-clean inside CH, but outside CH it leaves tiles undraped. `custom` accepts any licensed XYZ provider (MapTiler, Mapbox, and so on) through env.
2. **Turn on per-source attribution by default** (`?attrib=full` → default). The only change is the credit text in the sidebar and the PNG footer. It is a one-line flip in `src/lib/licences/config.ts`. It is off for now because this pass must not change the defaults.
3. **OSM pre-extract by default.** Ship `public/osm/peaks-ch.json` (about 5 MB raw, estimated from the test extract) and flip `osmExtractEnabled`. For covered areas the output was identical to Overpass (see below). Publishing the file makes it an ODbL Derivative Database, so it has to be offered under ODbL.
4. **Mapterhorn at production traffic.** Either ask Mapterhorn for their hosted-tile usage policy or self-host (see below). The self-host storage bill is the real question: the CH z13–17 archive alone is 615 GB.
5. **OSM raster tiles** (topo drape outside CH, the /upload pin map, the /roll mini-map). These fall under the OSMF tile usage policy, which does not allow heavy or commercial-scale use. Choose a commercial provider or self-host before launch.
6. **Server-side imagery analysis.** The matcher's `aliked:sat` configs render Esri or swisstopo imagery and match photos against it. For Esri that is analysis of basemap pixels outside Esri software, so it needs the same decision as item 1, only stricter. SWISSIMAGE is OGD and allows it.

## Register: data, tiles and APIs

"Public hosting" means a free public web app at scale, with exports.

| Source | Where it is used (file:line) | Licence / terms | Public hosting / commercial | Attribution required | Action | Owner decision? |
|---|---|---|---|---|---|---|
| **Mapterhorn terrain tiles** (`tiles.mapterhorn.com/{z}/{x}/{y}.webp`) | `src/lib/dem/sources.ts:50` (MAPTERHORN, used by every DEM consumer: deck terrain on WebGPU and WebGL2, CPU and GPU horizon, workers, scripts, bench); `tools/matcher/dem.py:27`; `tools/nearfield/eyes/eyes_dem.py:73` | Code BSD-3. The data carries each source's licence ([attribution.json](https://download.mapterhorn.com/attribution.json), 151 sources: mostly CC BY 4.0, OGD, Licence Ouverte 2.0, DL-DE-BY-2.0, public domain, Copernicus). The hosted endpoint is Cloudflare-sponsored, and no production usage policy is published | Data yes, with attribution. For the **hosted endpoint at scale**, ask Mapterhorn or self-host | TileJSON asks for `<a href="https://mapterhorn.com/attribution">© Mapterhorn</a>`. CC BY sources also need the producer named | **Done:** per-source list in `src/lib/licences/attribution.ts`; base URL configurable through `VITE_MAPTERHORN_URL` / `MAPTERHORN_URL` (default unchanged); self-host steps below | Yes (4) |
| AWS Terrarium (`elevation-tiles-prod`) | `src/lib/dem/sources.ts:31`; used only by `/baseline` (`src/baseline-ui/pipeline.worker.ts:24`) and research scripts (`scripts/lib/node-io.ts`, `scripts/concord/*`) | AWS Open Data. Sources and attribution per the Tilezen joerd docs (SRTM, GMTED, ETOPO1, NED, EU-DEM, and others) | Yes | "Terrain tiles: Mapzen/Tilezen, AWS Open Data" plus the joerd source list | Keep it off product paths. It is not shown in the main app | No |
| **Esri World Imagery** (`server.arcgisonline.com/.../World_Imagery`) | `src/lib/licences/imagery.ts:28` (all satellite drape: `src/lib/terrain.ts`, `src/lib/deck/terrain-data.ts` for both deck engines, the roll map through deck terrain-data); matcher `aliked:sat` renders | Esri Master Agreement / ArcGIS basemap terms. Use outside Esri software needs an ArcGIS account, and later API-key billing. Storage, offline use and derived products are restricted | **Not cleared** for a public app, exported composites, or server-side analysis without an ArcGIS subscription | "Esri, Maxar, Earthstar Geographics, and the GIS User Community" (+ "Powered by Esri") | **Done:** provider abstraction (`?imagery=` / `VITE_IMAGERY_PROVIDER`: `default`, `esri`, `swisstopo`, `custom`). Esri stays the default | **Yes (1, 6)** |
| **swisstopo SWISSIMAGE** (WMTS 3857) | `src/lib/licences/imagery.ts:30` (CH satellite drape at z ≥ 8 by default; the only source under `?imagery=swisstopo`) | Swiss OGD (since 2021-03-01): free, commercial use allowed | Yes. Fair use of `wmts.geo.admin.ch` applies; ask swisstopo before very heavy traffic | "© swisstopo" | Keep. This is the licence-clean satellite option inside CH | No |
| swisstopo Pixelkarte (colour map) | `src/lib/licences/imagery.ts:32` (topo drape in CH) | OGD | Yes | "© swisstopo" | Keep | No |
| swisstopo relief shading (`ch.swisstopo.swissalti3d-reliefschattierung` WMTS z14, baked once) | `scripts/gipfelbuch/data-sheet.ts` -> `public/demo/gipfelbuch/sheet/relief.jpg` (greyscale, about 130 KB); contours and lake in `sheet.json` derived from Mapterhorn z13 DEM; peaks and places from swissNAMES3D via the Thunersee terroir pack | OGD (derived data) | Yes | "Relief © swisstopo · DEM Mapterhorn", shown in `SheetMap` | Keep | No |
| swisstopo STAC / COG (swissALTI3D, swissSURFACE3D and others) | `src/lib/concord/occl/swiss-cog.ts:122` (concordance occluders, flag-gated) | OGD | Yes | "© swisstopo" | Keep | No |
| swisstopo base vector tiles | `tools/concord/rematch/mask.py:29` (research; removed 2026-09-30) | OGD | Yes | "© swisstopo" (+ OSM where the tiles contain it) | Research only | No |
| **OSM raster tiles** (`tile.openstreetmap.org`) | `src/lib/licences/imagery.ts:34` (topo drape outside CH and the in-CH fallback); `src/lib/upload/SlippyMap.tsx:132`; `src/lib/roll/mosaic/RollMiniMap.tsx:149` | Data ODbL. Tiles fall under the [OSMF Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/): no heavy use, no bulk prefetch, a valid Referer is required, and service is not guaranteed | Light interactive use only. **Not for a public app at scale** | "© OpenStreetMap contributors" linked to /copyright. Present on both maps and in the credit line | Move to a tile provider or self-host before launch | Yes (5) |
| **Overpass API** (public instances: overpass-api.de, private.coffee, kumi.systems, mail.ru) | `src/lib/overpass.ts:6` (transport); `src/lib/upload/region.ts:327` (region peaks), `:333` (water), `:404` (trails); `src/baseline-ui/pipeline.worker.ts:162`; `scripts/lib/overpass.ts:27`, `scripts/ingest.mjs:318`, `tools/bench/harness/lib/geo.ts:346`, `scripts/brand/rigi.ts:252`, research `tools/research/tm/*` | Data ODbL. The public instance allows about 10k queries/day and about 1 GB/day **across all users**. Mirrors have their own policies | **Not for a public app at scale** | "© OpenStreetMap contributors" | **Done (opt-in):** static pre-extract (`tools/osm/extract-peaks.mjs` → `public/osm/`; `?osmextract=1` / `VITE_OSM_EXTRACT=1`), with Overpass as the fallback outside coverage. Water and trails still use Overpass (see "Left open") | Yes (3) |
| OSM data derived into exports (GeoJSON peaks, labels in PNG) | `src/lib/export/geojson.ts`, `src/lib/export/annotate.ts:5` | ODbL. Produced Works (images) need attribution. A published derivative DB (the extract) must be offered under ODbL | Yes, with attribution | "© OpenStreetMap contributors" | The PNG footer already credits OSM. With `?attrib=full` the footer is per-source | No |
| Nominatim | `tools/research/tm/p1_position/net.py:51` (research only) | [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/): at most 1 request/s, no heavy use | Not for product use | OSM | Research only. Keep it out of the app | No |
| Wikimedia Commons (benchmark photos) | `tools/bench/collect*/common.py:10` | Per-file CC BY / BY-SA / PD, recorded in `tools/bench/data*/ATTRIBUTION.md` | Evaluation only. Do not redistribute without the per-file credits | Per file (already recorded) | Keep | No |
| Google Photorealistic 3D Tiles | `src/lib/tiles3d` behind `?tiles3d=google` (S3; off by default), US billing key in `.env.local` | Display only. No analysis, alignment, export or caching | Never for measurement (hidden from Truth view and exports; never read back) | Google logo slot wired (`public/tiles3d/google-maps-logo.png`, **file not bundled**: Google supplies it) + per-tile credits (`Tiles3DCredit.tsx`) | Add the official logo file and referrer-restrict the key before L1. See `reports/step-inside-google-3d-tiles.md` | Rendering accepted by the owner 2026-09-29 |
| swisstopo 3D Tiles (swissBUILDINGS3D, vegetation) | `src/lib/tiles3d` behind `?tiles3d=swisstopo` | OGD: commercial use, processing and analysis OK | Yes | "© swisstopo" (in `Tiles3DCredit.tsx`) | None | No |
| Google Fonts CSS (Fraunces, Manrope, Fira Sans, Fira Sans Condensed, IBM Plex Mono; loaded by `src/routes/__root.tsx`). Already self-hosted (OFL 1.1, table in `public/fonts/gipfelbuch/LICENSES.md`): Fira Sans, Fira Sans Condensed, Fira Mono, Source Serif 4, Architects Daughter, Shantell Sans (Gipfelbuch). Kalam is only a local fallback name (not loaded) | `src/routes/__root.tsx` | OFL fonts | Yes. **GDPR:** loading from Google leaks visitor IPs (LG München 2022). Self-host the fonts for an EU launch | None (OFL) | Self-host the remaining woff2 files (Fraunces, Manrope, IBM Plex Mono, and the Fira weights the classic UI uses) before L1 (small; no dependency needed) | No |
| ~~jsDelivr CDN (MediaPipe WASM)~~ | none: self-hosted 2026-10-02, then the MediaPipe runtime was removed the same day (people masks run on `src/lib/nn`) | Apache-2.0 (tasks-vision) | n/a | NOTICE | Done (removed) | No |

## Register: models

| Model | Where (file:line) | Code / weights licence | Commercial / hosted | Action |
|---|---|---|---|---|
| U²-Net-P sky segmentation (`public/models/skyseg-u2netp-nn.*.safetensors` on `src/lib/nn`, made by `scripts/models/u2netp.py` from `skyseg-u2netp.*.onnx`) | `src/lib/sky/model.ts:16` | MIT (xiongzhu666/Sky-Segmentation-and-Post-processing, see `src/lib/sky/README.md`) | Yes | Include the MIT notice in the credits page |
| MediaPipe selfie_multiclass_256 and DeepLab v3 (fp16 safetensors `public/models/{selfie-multiclass,deeplab-v3}-nn.*` on `src/lib/nn`, made by `scripts/models/mediapipe-seg.py` from the pinned `.tflite` files in `scripts/models/manifest.json`) | `src/lib/segment/people.ts` | Apache-2.0 (selfie_multiclass_256 card verified 2026-10-01; DeepLab v3 unverified, see Decisions) | Yes | Credit in the credits page |
| libheif / libde265 (HEIC decode) | `src/lib/upload/licenses.ts` | LGPL-3.0 | Yes, with the LGPL notices and replaceable linking (it is a separate WASM, so that holds) | Already credited on `/upload` |
| ALIKED-n16 (`public/models/aliked-n16.*.safetensors`; browser features, matcher and propagation) | `src/lib/features/aliked.ts`; producer `scripts/models/aliked-lightglue.py` | BSD-3-Clause (Shiaoming/ALIKED) | Yes (shipped, downloaded on first use) | Keep the BSD notice in NOTICE.md and the credits |
| LightGlue (ALIKED) (`public/models/lightglue-aliked.*.safetensors`) | `src/lib/features/lightglue.ts`; same producer | Apache-2.0 (cvg/LightGlue v0.1_arxiv) | Yes (shipped) | Credit in NOTICE.md |
| MoGe-2 ViT-S normal (`public/models/moge2-vits-normal.*.safetensors`; Step Inside depth) | `src/lib/nearfield/local/depth-net.ts`; producer `scripts/models/moge2-vits.py` | MIT (Ruicheng/moge-2-vits-normal); DINOv2-S backbone Apache-2.0 | Yes (shipped, 70 MB on first use) | Credit in NOTICE.md |
| DISK, RoMa (offline research only; the matcher service was removed 2026-10-02) | `tools/matcher/match.py` | DISK Apache-2.0 (verified 2026-10-01); RoMa MIT (DINOv2 backbone Apache-2.0) | Not shipped | None |
| **Near-field research models** (SHARP, MoGe-2 ViT-L, DA3, LaMa, VGGT, and others; research only, none shipped since the near-field service was removed 2026-10-02) | `tools/nearfield/*` studies | **See [`research_notes/step_inside_models_2026-09.md`](../research_notes/step_inside_models_2026-09.md).** In short: MoGe-2 is MIT, DA3-BASE is Apache-2.0, LaMa big-lama is Apache-2.0, **SHARP weights are research-only**, and DA3 Giant, MASt3R, DUSt3R and VGGT-1B (non-Commercial) are NC | Not shipped (`?nearfield=sharp` removed); SHARP must never ship. VGGT-1B-Commercial needs the application | Keep this table and that note in sync |
| Avoid list | — | FABDEM (NC), OrienterNet (CC BY-NC), SegFormer ADE20k (NVIDIA NC), DA3 Large-1.1 (conflicting) | No | Never add these to product paths |

## Register: npm libraries (data loaders)

Libraries that parse data at run time, with their notable transitive dependencies (licences read from the installed `node_modules/*/package.json`, 2026-10-01). Both loaders.gl packages are imported only on demand (dynamic `import()`), so they land in their own chunks.

| Package (version) | Where (file) | Licence | Notable transitive dependencies | Action |
|---|---|---|---|---|
| `@loaders.gl/splats` (5.0.0-alpha.7) | `src/lib/nearfield/splat-loaders-ext.ts` (SPZ / KSPLAT import) | MIT (vis.gl contributors) | `apache-arrow` 21.2.0 **Apache-2.0** (ships `NOTICE.txt`, which must travel with a distributed bundle); `flatbuffers` 25.9.23 **Apache-2.0**; `tslib` 0BSD; `@loaders.gl/compression` MIT with `fflate` 0.7.4, `fzstd` 0.1.1, `hysnappy`, `snappyjs` (MIT); `zod` 4.6.5 MIT | Reproduce the Arrow NOTICE in the credits / licence report |

## Register: vendored and bundled files (added 2026-10-01)

| Item | Source | Licence / terms | Status |
|---|---|---|---|
| `vendor/luma/*.tgz`, `vendor/deck/*.tgz` | Unofficial builds of visgl/luma.gl and visgl/deck.gl (commits and PRs in each README) | MIT, vis.gl contributors; texts in `vendor/luma/LICENSE` and `vendor/deck/LICENSE`, verbatim from upstream | Closed: licence files added; SHA-256 sums are in each README |
| `public/tiles3d/draco/` (`draco_decoder.wasm`, `draco_wasm_wrapper.js`) | Google Draco, copied byte-identical from three.js 0.186.1 `examples/jsm/libs/draco/` | Apache-2.0; `LICENSE` and `README.md` in the folder | Closed. Draco release number is not stated in the files |
| `examples/**/thumbnail.jpg` | 480 px renders of the example scenes; photo-drape and summit-view inspected: hillshaded Mapterhorn terrain, no photograph | Mapterhorn and underlying DEM terms | horizon-graph thumbnail not inspected |
| `public/terroir/thunersee/cover.png` | Baked by `scripts/terroir/build-pack.ts` from swisstopo VECTOR25/GK500, OSM, AWS Terrarium, GLAMOS | swisstopo OGD, ODbL, Mapzen attribution, CC BY 4.0 (see `pack.json`) | Attribution required |
| `src/lib/tiles3d/geoid-data.ts` | `scripts/tiles3d/make-geoid.py`: EGM2008 (NGA) from PROJ's `us_nga_egm08_25` grid | EGM2008 is a US-government NGA product; PROJ-data grid licensing per the PROJ-data README | Closed on the evidence in the generating script |

## Attribution: what is implemented

`src/lib/licences/attribution.ts` is the single registry:

- `attributionFor({lat, lon, radiusKm = 150, imagery, provider, osm})` returns the ordered credits: Mapterhorn; every Mapterhorn source whose coverage bbox intersects the view (Copernicus GLO-30 always, then swissALTI3D, IGN, INGV TINITALY, the Italian regions, BEV/geoland, Bavaria, BW, Slovenia and so on, taken from `attribution.json` v0.0.13); then the imagery credits for the active provider (swisstopo, Esri or custom); then OSM. Mapterhorn does not expose which source fed each pixel, so bboxes are generous. Over-crediting is harmless; under-crediting is not.
- `attributionLine(q, {compact})` gives one line for the UI or the PNG footer (compact uses producer abbreviations). `attributionText(q)` gives one credit per line with licence and link, for sidecars.
- **Wiring (opt-in, `?attrib=full` or `VITE_ATTRIBUTION=full`):** the sidebar credit (`src/components/PhotoWorkspace.tsx` `<CreditLine>` → `src/lib/licences/CreditLine.tsx`) and the annotated-PNG footer (`src/lib/export/engine-export.ts:356`). In classic mode `CreditLine` renders the old `<p>` with the same class and text, verified in the browser DOM (below).
- The two slippy maps (`SlippyMap`, `RollMiniMap`) show only OSM tiles and already carry the linked OSM credit.
- **Surfaces (2026-10-02, Pod E, browser-unverified):** `src/lib/licences/MapAttribution.tsx` renders the table as a compact linked credit for map and render surfaces (landing `LiveRollMap`; `compact` collapses it to an "i" button). The `TopoBoard` swisstopo credit and the landing footer line are generated from the table. The roll map credit comes from `RollMapTerroir` (`attributionLine`). "Save image" in the workspace now writes the same annotated PNG as Export → PNG, so every saved image carries the footer. While Step Inside draws 3D tiles the footer appends the tiles' own credit line; `GOOGLE_3D_TILES_CREDIT` and `SWISSTOPO_3D_TILES_CREDIT` are in the table, and a PNG export is refused while Google tiles are on screen (Map Tiles policies: display only).

Example (Rigi, satellite, compact PNG footer):
`Terrain © Mapterhorn (Copernicus, swisstopo, Kt. Zürich, IGN, INGV, RAVA, Reg. Piemonte, Reg. Lombardia, PAT Trento, Prov. Bozen, BEV/geoland.at, LDBV Bayern, LGL-BW) · Imagery © swisstopo, Esri, Maxar, Earthstar Geographics, and the GIS User Community · © OpenStreetMap contributors`

## Imagery providers

`src/lib/licences/imagery.ts` → `imageryTileUrls(kind, z, x, y, lat, lon, provider?)`. It is called from `src/lib/terrain.ts` (`imageryUrl`) and from `src/lib/deck/terrain-data.ts`, which both deck engines (WebGPU and WebGL2) use for the drape. (Updated 2026-10-01: the three.js path was removed in 583e2b7.)

| `?imagery=` / `VITE_IMAGERY_PROVIDER` | Satellite | Topo |
|---|---|---|
| `default` (unset) | CH and z ≥ 8: SWISSIMAGE → Esri fallback; otherwise Esri. **Byte-identical to the pre-N2 URLs** | CH: Pixelkarte → OSM; otherwise OSM |
| `esri` | Esri everywhere | unchanged |
| `swisstopo` | SWISSIMAGE inside CH only. **No Esri pixels anywhere**; tiles outside CH stay undraped | unchanged |
| `custom` + `VITE_IMAGERY_URL` (`{z}/{x}/{y}`, `{-y}`) + `VITE_IMAGERY_ATTRIBUTION` | the licensed provider | unchanged |

Note that the task framed swisstopo as opt-in, but the default has always used SWISSIMAGE first inside CH. The default was kept as it is.

## OSM pre-extract

- **Build:** `node tools/osm/extract-peaks.mjs [--bbox s,w,n,e] [--name id]`. The default bbox is CH + 60 km (`45.2,5.1,48.4,11.3`): 28 one-degree tile queries, run sequentially with a 5 s pause, with a User-Agent set (overpass-api.de answers **HTTP 406** to Node's default UA). Output is `public/osm/peaks-<id>.json` plus the `public/osm/extracts.json` manifest. The file holds peaks (`natural~peak|volcano`) and `tourism=viewpoint` nodes, ascending by id, with only the tags the app reads.
- **Serve:** `src/lib/osm/extract.ts`. `namedPeaksInBBox(bbox)` reproduces the upload-region query; `peaksAround(lat, lon, r)` reproduces the /baseline `around` query using Overpass's sphere, R = 2e7/π m (WGS84's 6378137 m dropped 5 rim nodes out of 1105 in testing). Both return `null` unless one extract **wholly contains** the query area, and the caller then falls back to Overpass.
- **Wired (opt-in `?osmextract=1` / `VITE_OSM_EXTRACT=1`):** `src/lib/upload/region.ts:325` (region peaks). The /baseline worker is not wired, because workers cannot see the page flag. The function exists for it.
- **Size:** the central-CH test extract (46.4–47.65 N, 7.4–9.35 E, 2.4 deg²) holds 4590 peaks and 2448 viewpoints in 591 KiB. Scaled to the 19.8 deg² default, that is about 5 MB raw, roughly 1.5 MB gzipped. The full extract was **not** run, because the disk is at 98 %.
- **Refresh:** re-run the script (monthly is plenty for peaks). Keep `osmBase` in the file for provenance.

## Self-hosting Mapterhorn (steps; not executed)

1. Install the `pmtiles` CLI ([go-pmtiles releases](https://github.com/protomaps/go-pmtiles/releases); a single binary, no npm dependency).
2. Check the size first: `pmtiles extract --dry-run --bbox=5.1,45.2,11.3,48.4 https://download.mapterhorn.com/planet.pmtiles ch-low.pmtiles` (z0–12; the planet file is 356 GB), then the z13–17 archives that intersect the bbox. For CH these are `6-33-22.pmtiles` (615 GB, z13–18), `6-32-22`, `6-33-23` and `6-34-22`. The file list with bounds is at `download.mapterhorn.com/download_urls.json` (v0.0.13).
3. `pmtiles extract --bbox=… <archive> part-N.pmtiles` for each archive, then `pmtiles merge planet-part.pmtiles part-*.pmtiles rigi-dem.pmtiles`.
4. Serve z/x/y: `pmtiles serve . --cors='*'` (URL `http://host:8080/rigi-dem/{z}/{x}/{y}.webp`), or upload to object storage behind the Protomaps Cloudflare Worker or an equivalent.
5. Point the app at it: `VITE_MAPTERHORN_URL=https://dem.example/rigi-dem/{z}/{x}/{y}.webp` (browser build); `MAPTERHORN_URL=…` for Node scripts, `tools/matcher/dem.py` and `tools/nearfield/eyes/eyes_dem.py`. It must serve the same 512 px Terrarium WebP tiles. Missing tiles must return 404 or 204, because the loader falls back to the ancestor tile.
6. Credit is unchanged: self-hosting does not change the data licences. Keep `© Mapterhorn` and the per-source list.
7. Outside the extract bbox, either keep the public endpoint as a fallback (this needs a two-URL loader, not built) or accept that coverage is limited to the bbox.

## Verification (2026-09-29)

`npx tsx scripts/licences-check.ts` printed **all passed**:

- Imagery `default`: identical URL lists to verbatim copies of the pre-N2 code on 13,600 tile×kind cases (z3–19, Alps-weighted and global).
- The `swisstopo` provider has no Esri URL, and the `esri` provider gives Esri inside CH.
- `MAPTERHORN.url` is unchanged without the env variable.
- Attribution: a Rigi view credits mapterhorn, glo30, swissalti3d, swisstopo, esri and osm. An Everest view credits only mapterhorn, glo30, esri and osm.
- **Extract identity against live overpass-api.de** (same server as the extract, osm_base 21:41Z against 21:55Z):
  - Rigi Kulm region: 2866 = 2866 nodes; `parsePeaks` output identical, same order.
  - Pilatus region: 2981 = 2981 nodes; identical.
  - `around` 40 km of Rigi: 1105 = 1105; `parseOverpassPeaks` output identical.
- **Trap:** a first run whose live answer came from the `kumi.systems` mirror differed by about 10 nodes, because that mirror serves an older snapshot. The public mirrors disagree with each other.

Browser (dev :3100, through the render lock): `/photo/IMG_3304` renders the same credit `<p>` as before (`class="text-[10px] leading-relaxed text-white/30"`, same text, no `data-credits`). With `?attrib=full` it renders the per-source line.

## Left open

- The water-names and trails Overpass queries (`region.ts:333`, `:404`) still hit Overpass. Exact `out geom` bbox semantics would need geometry in the extract, which is too big; a names-only approximation would not be provably identical.
- The /baseline worker extract path is not wired, because the worker has no page flag.
- No two-URL DEM fallback for a partial self-host.
- Esri, OSM tiles and the Mapterhorn usage policy are owner decisions (above).
