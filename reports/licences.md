# Licence register (roadmap N2)

> 2026-09-29. This is the gate before any public URL (roadmap N2 → L1). It covers every external data, tile, API and model source that the app, the pipeline and the tools call. Model licences for Step Inside are recorded in [`research_notes/step_inside_models_2026-09.md`](../research_notes/step_inside_models_2026-09.md). This page links to them and does not copy them. The earlier short table is the "Licensing and data risk register" in `reports/Rigi competitive landscape and roadmap.md`, and this page replaces it.
>
> Code for this item is in `src/lib/licences/` (attribution, imagery providers and flags), `src/lib/osm/extract.ts` and `tools/osm/extract-peaks.mjs` (the Overpass pre-extract), and `scripts/licences-check.ts` (the checks). **Every new behaviour is opt-in, and the defaults are unchanged.**

## Decisions the owner still has to make

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
| **Mapterhorn terrain tiles** (`tiles.mapterhorn.com/{z}/{x}/{y}.webp`) | `src/lib/dem/sources.ts:46` (MAPTERHORN, used by every DEM consumer: three and deck terrain, CPU and GPU horizon, workers, scripts, bench); `tools/matcher/dem.py:27`; `tools/nearfield/eyes/eyes_dem.py:73` | Code BSD-3. The data carries each source's licence ([attribution.json](https://download.mapterhorn.com/attribution.json), 151 sources: mostly CC BY 4.0, OGD, Licence Ouverte 2.0, DL-DE-BY-2.0, public domain, Copernicus). The hosted endpoint is Cloudflare-sponsored, and no production usage policy is published | Data yes, with attribution. For the **hosted endpoint at scale**, ask Mapterhorn or self-host | TileJSON asks for `<a href="https://mapterhorn.com/attribution">© Mapterhorn</a>`. CC BY sources also need the producer named | **Done:** per-source list in `src/lib/licences/attribution.ts`; base URL configurable through `VITE_MAPTERHORN_URL` / `MAPTERHORN_URL` (default unchanged); self-host steps below | Yes (4) |
| AWS Terrarium (`elevation-tiles-prod`) | `src/lib/dem/sources.ts:31`; used only by `/baseline` (`src/baseline-ui/pipeline.worker.ts:24`) and research scripts (`scripts/lib/node-io.ts`, `scripts/concord/*`) | AWS Open Data. Sources and attribution per the Tilezen joerd docs (SRTM, GMTED, ETOPO1, NED, EU-DEM, and others) | Yes | "Terrain tiles: Mapzen/Tilezen, AWS Open Data" plus the joerd source list | Keep it off product paths. It is not shown in the main app | No |
| **Esri World Imagery** (`server.arcgisonline.com/.../World_Imagery`) | `src/lib/licences/imagery.ts:28` (all satellite drape: `src/lib/terrain.ts:32`, `src/lib/deck/terrain-data.ts:444`, the roll map through deck terrain-data); matcher `aliked:sat` renders | Esri Master Agreement / ArcGIS basemap terms. Use outside Esri software needs an ArcGIS account, and later API-key billing. Storage, offline use and derived products are restricted | **Not cleared** for a public app, exported composites, or server-side analysis without an ArcGIS subscription | "Esri, Maxar, Earthstar Geographics, and the GIS User Community" (+ "Powered by Esri") | **Done:** provider abstraction (`?imagery=` / `VITE_IMAGERY_PROVIDER`: `default`, `esri`, `swisstopo`, `custom`). Esri stays the default | **Yes (1, 6)** |
| **swisstopo SWISSIMAGE** (WMTS 3857) | `src/lib/licences/imagery.ts:30` (CH satellite drape at z ≥ 8 by default; the only source under `?imagery=swisstopo`) | Swiss OGD (since 2021-03-01): free, commercial use allowed | Yes. Fair use of `wmts.geo.admin.ch` applies; ask swisstopo before very heavy traffic | "© swisstopo" | Keep. This is the licence-clean satellite option inside CH | No |
| swisstopo Pixelkarte (colour map) | `src/lib/licences/imagery.ts:32` (topo drape in CH) | OGD | Yes | "© swisstopo" | Keep | No |
| swisstopo STAC / COG (swissALTI3D, swissSURFACE3D and others) | `src/lib/concord/occl/swiss-cog.ts:122` (concordance occluders, flag-gated) | OGD | Yes | "© swisstopo" | Keep | No |
| swisstopo base vector tiles | `tools/concord/rematch/mask.py:29` (research; removed 2026-09-30) | OGD | Yes | "© swisstopo" (+ OSM where the tiles contain it) | Research only | No |
| **OSM raster tiles** (`tile.openstreetmap.org`) | `src/lib/licences/imagery.ts:34` (topo drape outside CH and the in-CH fallback); `src/lib/upload/SlippyMap.tsx:132`; `src/lib/roll/mosaic/RollMiniMap.tsx:149` | Data ODbL. Tiles fall under the [OSMF Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/): no heavy use, no bulk prefetch, a valid Referer is required, and service is not guaranteed | Light interactive use only. **Not for a public app at scale** | "© OpenStreetMap contributors" linked to /copyright. Present on both maps and in the credit line | Move to a tile provider or self-host before launch | Yes (5) |
| **Overpass API** (public instances: overpass-api.de, private.coffee, kumi.systems, mail.ru) | `src/lib/overpass.ts:6` (transport); `src/lib/upload/region.ts:327` (region peaks), `:333` (water), `:404` (trails); `src/baseline-ui/pipeline.worker.ts:162`; `scripts/lib/overpass.ts:27`, `scripts/ingest.mjs:318`, `tools/bench/harness/lib/geo.ts:346`, `scripts/brand/rigi.ts:252`, research `tools/research/tm/*` | Data ODbL. The public instance allows about 10k queries/day and about 1 GB/day **across all users**. Mirrors have their own policies | **Not for a public app at scale** | "© OpenStreetMap contributors" | **Done (opt-in):** static pre-extract (`tools/osm/extract-peaks.mjs` → `public/osm/`; `?osmextract=1` / `VITE_OSM_EXTRACT=1`), with Overpass as the fallback outside coverage. Water and trails still use Overpass (see "Left open") | Yes (3) |
| OSM data derived into exports (GeoJSON peaks, labels in PNG) | `src/lib/export/geojson.ts`, `src/lib/export/annotate.ts:5` | ODbL. Produced Works (images) need attribution. A published derivative DB (the extract) must be offered under ODbL | Yes, with attribution | "© OpenStreetMap contributors" | The PNG footer already credits OSM. With `?attrib=full` the footer is per-source | No |
| Nominatim | `tools/research/tm/p1_position/net.py:51` (research only) | [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/): at most 1 request/s, no heavy use | Not for product use | OSM | Research only. Keep it out of the app | No |
| Wikimedia Commons (benchmark photos) | `tools/bench/collect*/common.py:10` | Per-file CC BY / BY-SA / PD, recorded in `tools/bench/data*/ATTRIBUTION.md` | Evaluation only. Do not redistribute without the per-file credits | Per file (already recorded) | Keep | No |
| Google Photorealistic 3D Tiles | `src/lib/tiles3d` behind `?tiles3d=google` (S3; off by default), US billing key in `.env.local` | Display only. No analysis, alignment, export or caching | Never for measurement (hidden from Truth view and exports; never read back) | Google logo (**not bundled yet**) + per-tile credits (`Tiles3DCredit.tsx`) | Add the official logo and referrer-restrict the key before L1. See `reports/step-inside-google-3d-tiles.md` | Rendering accepted by the owner 2026-09-29 |
| swisstopo 3D Tiles (swissBUILDINGS3D, vegetation) | `src/lib/tiles3d` behind `?tiles3d=swisstopo` | OGD: commercial use, processing and analysis OK | Yes | "© swisstopo" (in `Tiles3DCredit.tsx`) | None | No |
| Google Fonts CSS (Fraunces, Manrope) | `src/styles.css:1` | OFL fonts | Yes. **GDPR:** loading from Google leaks visitor IPs (LG München 2022). Self-host the fonts for an EU launch | None (OFL) | Self-host the woff2 files before L1 (small; no dependency needed) | No |
| jsDelivr CDN (MediaPipe WASM) | `src/lib/segment.ts:26` | Apache-2.0 (tasks-vision) | Yes. Third-party CDN (privacy and availability) | NOTICE | Consider self-hosting the WASM before L1 | No |

## Register: models

| Model | Where (file:line) | Code / weights licence | Commercial / hosted | Action |
|---|---|---|---|---|
| U²-Net-P sky segmentation (`public/models/skyseg-u2netp.*.onnx`) | `src/lib/sky/model.ts:16` | MIT (xiongzhu666/Sky-Segmentation-and-Post-processing, see `src/lib/sky/README.md`) | Yes | Include the MIT notice in the credits page |
| MediaPipe selfie_multiclass_256 and DeepLab v3 (`.tflite`, Google storage) | `src/lib/segment.ts:29`, `:31` | Apache-2.0 (MediaPipe model cards; not re-verified in this pass) | Yes | Re-check the model cards and record them in the credits |
| libheif / libde265 (HEIC decode) | `src/lib/upload/licenses.ts` | LGPL-3.0 | Yes, with the LGPL notices and replaceable linking (it is a separate WASM, so that holds) | Already credited on `/upload` |
| ALIKED + LightGlue, DISK, RoMa (matcher service) | `tools/matcher/match.py:41`, `:59` | LightGlue Apache-2.0; ALIKED BSD-3; RoMa MIT (DINOv2 backbone Apache-2.0); DISK not verified | Server-side | Verify DISK before hosting L4 |
| **Step Inside models** (SHARP, MoGe-2, DA3, LaMa, VGGT, and others) | `tools/nearfield/service/models.py:20` (the in-service licence strings) | **See [`research_notes/step_inside_models_2026-09.md`](../research_notes/step_inside_models_2026-09.md).** In short: MoGe-2 is MIT, DA3-BASE is Apache-2.0, LaMa big-lama is Apache-2.0, **SHARP weights are research-only**, and DA3 Giant, MASt3R, DUSt3R and VGGT-1B (non-Commercial) are NC | SHARP must stay behind a dev flag and never ship. VGGT-1B-Commercial needs the application | Keep this table and that note in sync |
| Avoid list | — | FABDEM (NC), OrienterNet (CC BY-NC), SegFormer ADE20k (NVIDIA NC), DA3 Large-1.1 (conflicting) | No | Never add these to product paths |

## Attribution: what is implemented

`src/lib/licences/attribution.ts` is the single registry:

- `attributionFor({lat, lon, radiusKm = 150, imagery, provider, osm})` returns the ordered credits: Mapterhorn; every Mapterhorn source whose coverage bbox intersects the view (Copernicus GLO-30 always, then swissALTI3D, IGN, INGV TINITALY, the Italian regions, BEV/geoland, Bavaria, BW, Slovenia and so on, taken from `attribution.json` v0.0.13); then the imagery credits for the active provider (swisstopo, Esri or custom); then OSM. Mapterhorn does not expose which source fed each pixel, so bboxes are generous. Over-crediting is harmless; under-crediting is not.
- `attributionLine(q, {compact})` gives one line for the UI or the PNG footer (compact uses producer abbreviations). `attributionText(q)` gives one credit per line with licence and link, for sidecars.
- **Wiring (opt-in, `?attrib=full` or `VITE_ATTRIBUTION=full`):** the sidebar credit (`src/components/PhotoWorkspace.tsx:1657` → `src/lib/licences/CreditLine.tsx`) and the annotated-PNG footer (`src/lib/export/engine-export.ts:356`). In classic mode `CreditLine` renders the old `<p>` with the same class and text, verified in the browser DOM (below).
- The two slippy maps (`SlippyMap`, `RollMiniMap`) show only OSM tiles and already carry the linked OSM credit.

Example (Rigi, satellite, compact PNG footer):
`Terrain © Mapterhorn (Copernicus, swisstopo, Kt. Zürich, IGN, INGV, RAVA, Reg. Piemonte, Reg. Lombardia, PAT Trento, Prov. Bozen, BEV/geoland.at, LDBV Bayern, LGL-BW) · Imagery © swisstopo, Esri, Maxar, Earthstar Geographics, and the GIS User Community · © OpenStreetMap contributors`

## Imagery providers

`src/lib/licences/imagery.ts` → `imageryTileUrls(kind, z, x, y, lat, lon, provider?)`. Both renderers call it, the three path at `src/lib/terrain.ts:32` and the deck path at `src/lib/deck/terrain-data.ts:444`.

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
