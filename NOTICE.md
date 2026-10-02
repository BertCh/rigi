# Notice: what is and is not MIT

The source code of this repository is released under the MIT licence (`LICENSE`, "Copyright (c) 2026 Robert Christie and Rigi contributors"). **Nothing else here is.** This file lists what the `LICENSE` does not cover and where it came from. Details, decisions and the sources checked on 2026-10-01 are in `reports/licences.md`; the in-app credit text is generated from `src/lib/licences/attribution.ts`. "Unverified" marks a claim that could not be checked against a primary source.

## 1. Photographs and demo content

| Path | Owner / terms |
|---|---|
| `public/photos/` (gitignored, local only) | Photographs by Robert Christie. All rights reserved unless a file says otherwise. Not part of the repository; not licensed for reuse. |
| `public/demo/` (`photos`, `thumbs`, `shots`, `how`, `gipfelbuch`) | The Niederhorn demo set: photographs, thumbnails, screenshots and derived renders. These files are in the repository but are not covered by the MIT licence. Photographs (c) Robert Christie, all rights reserved unless stated. Screenshots and `atlas`/`how` renders also contain map data and imagery listed in section 2, with their attribution. |
| `public/baseline/` (gitignored) | Not in the repository; local evaluation photographs, not published or licensed. |
| `examples/deck/landeskarte/data/stations.json`, `examples/deck/landeskarte/data/photo-skylines.json` | Geometry derived from the Niederhorn demo photographs (camera positions and solved poses; per-photo skyline directions in azimuth/elevation). No pixels. Same owner as `public/demo/`; the solved poses are Rigi solver outputs, not ground truth. Publishing per-photo positions is an owner decision before the repository goes public. |
| `tools/bench/data*` | Benchmark photographs, some from Wikimedia Commons under per-file CC BY / CC BY-SA / public domain terms recorded in `tools/bench/data*/ATTRIBUTION.md`. Evaluation only; do not redistribute without the per-file credits. |
| `examples/deck/photo-drape/thumbnail.jpg`, `examples/deck/summit-view/thumbnail.jpg`, `examples/gpgpu/horizon-graph/thumbnail.jpg` | 480 px renders of the example scenes (examples/README.md: "a render of open map data; never a photo"). Two were inspected: they show hillshaded Mapterhorn terrain around Lake Thun, with the in-image credit "Terrain (c) Mapterhorn (swisstopo, Copernicus ...)" and no photograph. The horizon-graph thumbnail was not inspected; its example reads the same Mapterhorn Terrarium tiles. Data terms: section 2 (Mapterhorn and its underlying DEMs). |
| `public/terroir/thunersee/cover.png` | Baked land-cover raster of the Thunersee pack, built by `scripts/terroir/build-pack.ts` from swisstopo VECTOR25 and GK500 (swisstopo OGD, "(c) swisstopo"), OSM via Overpass (ODbL, "(c) OpenStreetMap contributors"), AWS Terrarium DEM (Mapzen / terrain-tiles attribution) and GLAMOS glacier inventory (CC BY 4.0); source list in `public/terroir/thunersee/pack.json` and `scripts/terroir/README.md`. A produced work derived from OSM data: attribution is required. |
| `public/favicon.svg`, `public/brand/` | Rigi brand assets, (c) Robert Christie, all rights reserved. If the brand panorama derives from the demo photographs, the same terms apply. |

You may not reuse these photographs without permission. Do not contribute photographs you do not own.

## 2. Map data, tiles and services

The app reads these at run time; they are not licensed by this repository. Credits shown in the UI and in exports come from `src/lib/licences/attribution.ts`.

| Source | Terms |
|---|---|
| Mapterhorn terrain tiles (tiles.mapterhorn.com) | Tile code BSD-3; data under the licence of each underlying national DEM (credit "(c) Mapterhorn", https://mapterhorn.com/attribution). No hosted-tile usage or rate policy is published (mapterhorn.com, its Data Access and Attribution pages and the GitHub README were read 2026-10-01); a high-traffic deployment should self-host (`reports/licences.md`) or ask the maintainers. |
| Underlying DEMs in Mapterhorn | Copernicus GLO-30 (free and open); swisstopo swissALTI3D (OGD); Kanton Zurich DTM (CC0); IGN RGE ALTI / LiDAR HD (Licence Ouverte 2.0); INGV TINITALY, Valle d'Aosta, Piemonte, Lombardia, BEV/geoland.at, Land Kaernten, Land Salzburg, Bayern DGM1, ARSO Slovenia (CC BY 4.0); PA Trento (CC BY 2.5); Bozen (CC0); LGL Baden-Wuerttemberg (dl-de/by-2-0). |
| swisstopo SWISSIMAGE, Pixelkarte, STAC/COG, 3D Tiles | Swiss open government data; commercial use allowed; attribution "(c) swisstopo". |
| swisstopo relief shading (swissALTI3D Reliefschattierung WMTS) | Baked into `public/demo/gipfelbuch/sheet/relief.jpg` with contours derived from Mapterhorn DEM (`sheet.json`, `scripts/gipfelbuch/data-sheet.ts`). Swiss open government data; commercial use allowed; attribution "(c) swisstopo", shown on the map as "Relief © swisstopo · DEM Mapterhorn". |
| Esri World Imagery | Esri terms (ArcGIS account required). Decision: kept as the default for development and local use, because the default (classic) UI line and the PNG export footer now carry Esri's required source credit ("Esri, Maxar, Earthstar Geographics, and the GIS User Community"). A public production deployment should use an ArcGIS Location Platform key (`?imagery=custom` with env) or `?imagery=swisstopo`, which uses no Esri pixels. Not for server-side analysis (`aliked:sat`) without an Esri licence. |
| OpenStreetMap data, Overpass API, OSM raster tiles | Data (c) OpenStreetMap contributors, ODbL 1.0. Tiles follow the OSMF tile usage policy (not for heavy or commercial-scale use). `public/osm/*.json` are Overpass extracts and therefore ODbL derivative databases. |
| Google Photorealistic 3D Tiles (`?tiles3d=google`, off by default) | Google Map Tiles policies: display only, no analysis, alignment, export or caching; per-tile copyrights and the Google Maps logo must be shown. The app shows the copyrights and the word "Google" but not the logo (gap; see section 5). |
| Google Fonts CSS (Fraunces, Manrope, Fira Sans, Fira Sans Condensed, IBM Plex Mono, Caveat, Shantell Sans, Architects Daughter, Kalam) | SIL Open Font License. Loaded from Google; self-hosting is planned. |
| EGM2008 geoid undulations (`src/lib/tiles3d/geoid-data.ts`) | Generated by `scripts/tiles3d/make-geoid.py` from PROJ's `us_nga_egm08_25` grid (EGM2008, a US National Geospatial-Intelligence Agency product, US-government work). The grid is fetched through PROJ-data; its licensing is stated in the PROJ-data README (https://github.com/OSGeo/PROJ-data). Resampled to 0.1 and 1 degree int16 grids. |
| Wikimedia Commons (benchmark photos) | Per-file licences, see section 1. |

`public/terroir/` packs are derived from the map data above. `public/terroir/thunersee/pack.json` lists each source with its licence, URL and credit (swisstopo, GLAMOS CC BY 4.0, OSM ODbL, AWS Terrarium/Mapzen).

## 3. Machine-learning models and runtimes

| Component | Licence |
|---|---|
| MediaPipe `tasks-vision` (npm 1.0.1), `selfie_multiclass_256` and DeepLab v3 `.tflite` models fetched at run time | Apache-2.0: package.json `"license": "Apache-2.0"`; the selfie_multiclass_256 model card (storage.googleapis.com/mediapipe-assets/Model%20Card%20Multiclass%20Segmentation.pdf) states "Apache License, Version 2.0". DeepLab v3 has no model card on the MediaPipe page; its licence is unverified (a TensorFlow Hub model) |
| U2-Net-P sky model, `public/models/skyseg-u2netp.*.onnx`, converted from upstream ncnn weights (`src/lib/sky/model.ts`, `src/lib/sky/README.md`) | MIT (xiongzhu666/Sky-Segmentation-and-Post-processing); keep the MIT notice with the file |
| onnxruntime-web | MIT (package.json, version 1.30.0). The package ships no LICENSE or notices file; its README points to upstream (github.com/microsoft/onnxruntime). The shipped `ort-wasm-simd-threaded.jsep.wasm` is built from that repository, whose `ThirdPartyNotices.txt` lists bundled components (Apache-2.0, BSD, MIT, MPL-2.0 pieces). Include that file with a distributed bundle |
| Baked skylines in `examples/deck/landeskarte/data/photo-skylines.json` | Produced offline by `examples/deck/landeskarte/scripts/bake-skylines.mjs` with the U2-Net-P model above (MIT, keep its notice) on onnxruntime-web; MediaPipe `selfie_multiclass_256` masks (Apache-2.0) only drop columns. The output is geometry; the provenance is stamped in the file's `_provenance`. |
| libheif / libde265 via libheif-js 1.23.2 (HEIC decode) | LGPL-3.0, used unmodified as a separate replaceable WASM; notice in `src/lib/upload/licenses.ts` |
| Matcher service: ALIKED, LightGlue, RoMa, DISK (`tools/matcher`, server side) | LightGlue Apache-2.0; ALIKED BSD-3; RoMa MIT (DINOv2 backbone Apache-2.0); DISK Apache-2.0 (cvlab-epfl/disk `LICENSE.txt`, "Apache License Version 2.0"; used through LightGlue's extractor) |
| Step Inside models (`tools/nearfield`): MoGe-2 (MIT code and weights), Depth Anything 3 Base/Small (Apache-2.0), LaMa big-lama (Apache-2.0), TripoSplat (MIT), others | See `research_notes/step_inside_models_2026-09.md`. **Do not ship** research-only or non-commercial weights: Apple SHARP weights (research licence, dev-only `?nearfield=sharp`), VGGT-1B, MASt3R, DUSt3R, DA3 Giant/Nested (CC BY-NC), DA3 Large-1.1 (conflicting). Generated near-field content is stripped from exports. |
| Research tooling checkouts under `tools/research/**` (including vendored Python packages in dot-directories such as `.pylib*`) | Each keeps its own licence (for example three.js MIT in `tools/research/tm/.pylib_x2/moge/**`). Not first-party code. |

## 4. Vendored packages

| Path | What | Licence |
|---|---|---|
| `vendor/luma/*.tgz` | luma.gl `10.0.0-alpha.2-rigi.3` (core, effects, engine, gpgpu, shadertools, webgl, webgpu) built from visgl/luma.gl master `7289d961` plus PRs #3313, #3302, #3287, #3328, #3333, #3334, #3330 and a PipelineFactory compute-hash commit (`c80b7ce6`); unofficial build, see `vendor/luma/README.md` | MIT, Copyright (c) vis.gl contributors |
| `vendor/deck/*.tgz` | deck.gl `9.4.0-rigi.1` build (`@deck.gl/core`, `@deck.gl/layers`) from commit `4a2223f3c993bc1c41114d33d130b05769d84672`: deck master `35854250` merged with PR #10752 (`0d8b1664`), plus the WebGPU hunks of luma.gl's deck patch and PR #10780 | MIT, Copyright (c) vis.gl contributors |

Both are third-party code with local build changes; their provenance and rebuild steps are in `vendor/luma/README.md` and `vendor/deck/README.md`. Their upstream licence texts are in `vendor/luma/LICENSE` and `vendor/deck/LICENSE` (verbatim from the upstream repositories). The vendored packages are not covered by Rigi's `LICENSE` copyright line.

| `public/tiles3d/draco/` | Google Draco decoder (`draco_decoder.wasm`, `draco_wasm_wrapper.js`), copied byte-identical from three.js 0.186.1 `examples/jsm/libs/draco/`; Draco release number not stated in the files | Apache-2.0, Copyright Google; text in `public/tiles3d/draco/LICENSE`, provenance in its `README.md` |

Other npm dependencies keep their own licences (React, TanStack, three.js and 3d-tiles-renderer, loaders.gl, math.gl, exifr, lucide-react, Tailwind CSS and others); see `package.json` and `package-lock.json`. Run a licence report before distributing a built bundle.

Data loaders with non-MIT pieces among their dependencies (detail in `reports/licences.md`, "Register: npm libraries"):

| Package | Used for | Licence | Non-MIT dependencies |
|---|---|---|---|
| `@loaders.gl/geotiff` 5.0.0-alpha.7 (with `geotiff` 2.1.3) | swisstopo COG reads (`?cogReader=loaders`) | MIT, Copyright (c) vis.gl contributors | `lerc` (Apache-2.0), `web-worker` (Apache-2.0), `pako` (MIT AND Zlib), `zstddec` (MIT AND BSD-3-Clause), `xml-utils` (CC0-1.0) |
| `@loaders.gl/splats` 5.0.0-alpha.7 | SPZ / KSPLAT splat import | MIT, Copyright (c) vis.gl contributors | `apache-arrow` (Apache-2.0, has a `NOTICE.txt` to reproduce), `flatbuffers` (Apache-2.0), `tslib` (0BSD) |

## 5. Code copied or ported from other projects

| Where | From | Licence |
|---|---|---|
| `examples/example-infobox.css`, `examples/example-support.ts`, `examples/example-theme.ts`, `examples/deck/deck-example-device.ts` (and example code derived from the luma.gl examples) | visgl/luma.gl examples | MIT, Copyright (c) vis.gl contributors; headers kept |
| `src/lib/look/nebelmeer/index.ts` (height fog) | luma.gl `heightFog`, luma master `7d1d11e9`, #3325 | MIT, Copyright (c) vis.gl contributors |
| `src/lib/terroir/pattern.ts` (scree dots, rock and glacier hatching) | luma.gl `patternFill`, luma master `7289d961`, #3320 | MIT, Copyright (c) vis.gl contributors |
| `src/lib/look/sketch-ridges.ts`, `src/lib/look/trail-stroke.ts` (sketch and pencil strokes) | luma.gl `sketchStroke`, luma master `7289d961`, #3318 | MIT, Copyright (c) vis.gl contributors |
| `src/lib/deck-webgpu/layers/trail.ts`, `src/lib/deck/trail-layer.ts` (trail dash coverage) | luma.gl `pathDash`, luma master `7289d961`, #3322 | MIT, Copyright (c) vis.gl contributors |
| `src/lib/look/water/waves.ts` (lake wave normals) | luma.gl `riverWaterMaterial`, luma master `7289d961`, #3311 | MIT, Copyright (c) vis.gl contributors |
| `src/lib/look/flow/field.ts` (particle advection) | luma.gl experimental `FlowParticleSimulation`, luma master `7289d961`, #3324 | MIT, Copyright (c) vis.gl contributors |
| `src/lib/look/weather/precipitation.ts`, `src/lib/deck/weather-layer.ts` | luma.gl #3325 `precipitation` shadertools module | MIT, vis.gl contributors |
| `src/lib/sky/model.ts` | wrapper for the U2-Net-P sky model | MIT (model licence, see section 3) |
| `src/lib/nearfield/generate/remote.ts`, `inpaint-client.ts` | clients for GEN3C, LingBot-World and LaMa services; `inpaint-client.ts` is a thin `fetch` client for the local near-field service; `remote.ts` only builds request packages (no network calls) in the documented input formats of GEN3C (code Apache-2.0; weights nvidia/GEN3C-Cosmos-7B under the NVIDIA Open Model License, per its Hugging Face card: "ready for commercial/non-commercial use", rights end if guardrails are bypassed) and LingBot-World | Rigi's own code (MIT); read 2026-10-01, no upstream code copied |
| `src/components/nearfield/Tiles3DCredit.tsx`, `src/lib/tiles3d/` | credit handling for Google Map Tiles and swisstopo 3D Tiles, per their policies; geoid grid in `geoid-data.ts`: EGM2008 via PROJ, see section 2 | Rigi's own code (MIT). Credit handling: swisstopo credit shown ("Buildings © swisstopo"; swisstopo's terms allow "©swisstopo"); Google per-tile copyrights shown, Google logo not yet (off by default; add before enabling publicly); geoid data: see section 2 |

Files that already carry another licence or copyright notice are left alone by `scripts/ci/spdx.mjs` and listed by it for review. Internal ports between Rigi's own backends (for example WGSL ports of GLSL layers, `scripts/leaderboard.mjs`'s port of `src/lib/pose.ts`) are first-party code and MIT.

## 6. Contact

Licensing questions or corrections: open a GitHub issue.
