# Notice: what is and is not MIT

The source code of this repository is released under the MIT licence (`LICENSE`, "Copyright (c) 2026 Robert Christie and Rigi contributors"). **Nothing else here is.** This file lists what the `LICENSE` does not cover, where it came from, and what is still to be confirmed. Details and decisions behind the data rows are in `reports/licences.md`; the in-app credit text is generated from `src/lib/licences/attribution.ts`.

"To confirm" means the licence was not verified for this file and must be checked before the item is redistributed.

## 1. Photographs and demo content

| Path | Owner / terms |
|---|---|
| `public/photos/` (gitignored, local only) | Photographs by Robert Christie. All rights reserved unless a file says otherwise. Not part of the repository; not licensed for reuse. |
| `public/demo/` (`photos`, `thumbs`, `shots`, `how`, `atlas`) | The Niederhorn demo set: photographs, thumbnails, screenshots and derived renders. Photographs (c) Robert Christie, all rights reserved unless stated. Screenshots and `atlas`/`how` renders also contain map data and imagery listed in section 2, with their attribution. |
| `public/baseline/` (gitignored) | Benchmark photographs. Provenance: to confirm per file. |
| `tools/bench/data*` | Benchmark photographs, some from Wikimedia Commons under per-file CC BY / CC BY-SA / public domain terms recorded in `tools/bench/data*/ATTRIBUTION.md`. Evaluation only; do not redistribute without the per-file credits. |
| `public/favicon.svg`, `public/brand/` | Rigi brand assets, (c) Robert Christie, all rights reserved. To confirm whether the brand panorama derives from the demo photographs. |

You may not reuse these photographs without permission. Do not contribute photographs you do not own.

## 2. Map data, tiles and services

The app reads these at run time; they are not licensed by this repository. Credits shown in the UI and in exports come from `src/lib/licences/attribution.ts`.

| Source | Terms |
|---|---|
| Mapterhorn terrain tiles (tiles.mapterhorn.com) | Tile code BSD-3; data under the licence of each underlying national DEM (credit "(c) Mapterhorn", https://mapterhorn.com/attribution). Production-traffic policy: to confirm with Mapterhorn. |
| Underlying DEMs in Mapterhorn | Copernicus GLO-30 (free and open); swisstopo swissALTI3D (OGD); Kanton Zurich DTM (CC0); IGN RGE ALTI / LiDAR HD (Licence Ouverte 2.0); INGV TINITALY, Valle d'Aosta, Piemonte, Lombardia, BEV/geoland.at, Land Kaernten, Land Salzburg, Bayern DGM1, ARSO Slovenia (CC BY 4.0); PA Trento (CC BY 2.5); Bozen (CC0); LGL Baden-Wuerttemberg (dl-de/by-2-0). |
| swisstopo SWISSIMAGE, Pixelkarte, STAC/COG, 3D Tiles | Swiss open government data; commercial use allowed; attribution "(c) swisstopo". |
| Esri World Imagery | Esri terms (ArcGIS Location Platform account required for production). Owner decision pending: keep, replace, or SWISSIMAGE only (`?imagery=swisstopo` uses no Esri pixels). Not for server-side analysis without the same decision. |
| OpenStreetMap data, Overpass API, OSM raster tiles | Data (c) OpenStreetMap contributors, ODbL 1.0. Tiles follow the OSMF tile usage policy (not for heavy or commercial-scale use). `public/osm/*.json` are Overpass extracts and therefore ODbL derivative databases. |
| Google Photorealistic 3D Tiles (`?tiles3d=google`, off by default) | Google Map Tiles policies: display only, no analysis, alignment, export or caching; per-tile copyrights must be shown. |
| Google Fonts CSS (Fraunces, Manrope) | SIL Open Font License. Loaded from Google; self-hosting is planned. |
| Wikimedia Commons (benchmark photos) | Per-file licences, see section 1. |

`public/terroir/` packs are derived from the map data above (OSM, swisstopo): to confirm the exact per-pack attribution in each `pack.json`.

## 3. Machine-learning models and runtimes

| Component | Licence |
|---|---|
| MediaPipe `tasks-vision` (npm 1.0.1), `selfie_multiclass_256` and DeepLab v3 `.tflite` models fetched at run time | Apache-2.0 (model cards not re-verified: to confirm) |
| U2-Net-P sky model, `public/models/skyseg-u2netp.*.onnx`, converted from upstream ncnn weights (`src/lib/sky/model.ts`, `src/lib/sky/README.md`) | MIT (xiongzhu666/Sky-Segmentation-and-Post-processing); keep the MIT notice with the file |
| onnxruntime-web | MIT (npm package licence; to confirm for the shipped WASM) |
| libheif / libde265 via libheif-js 1.23.2 (HEIC decode) | LGPL-3.0, used unmodified as a separate replaceable WASM; notice in `src/lib/upload/licenses.ts` |
| Matcher service: ALIKED, LightGlue, RoMa, DISK (`tools/matcher`, server side) | LightGlue Apache-2.0; ALIKED BSD-3; RoMa MIT (DINOv2 backbone Apache-2.0); DISK: to confirm |
| Step Inside models (`tools/nearfield`): MoGe-2 (MIT code and weights), Depth Anything 3 Base/Small (Apache-2.0), LaMa big-lama (Apache-2.0), TripoSplat (MIT), others | See `research_notes/step_inside_models_2026-09.md`. **Do not ship** research-only or non-commercial weights: Apple SHARP weights (research licence, dev-only `?nearfield=sharp`), VGGT-1B, MASt3R, DUSt3R, DA3 Giant/Nested (CC BY-NC), DA3 Large-1.1 (conflicting). Generated near-field content is stripped from exports. |
| Research tooling checkouts under `tools/research/**` (including vendored Python packages in dot-directories such as `.pylib*`) | Each keeps its own licence (for example three.js MIT in `tools/research/tm/.pylib_x2/moge/**`). Not first-party code. |

## 4. Vendored packages

| Path | What | Licence |
|---|---|---|
| `vendor/luma/*.tgz` | luma.gl `10.0.0-alpha.2-rigi.2` (core, effects, engine, gpgpu, shadertools, webgl, webgpu) built from visgl/luma.gl master `7d1d11e91d8c0936b1bf32a302dc760c04e7a0ae` plus PRs #3312, #3313, #3302, #3287, #3328 (head `30f08edae5a86ed013bcbe97bcfe837348c138fc`) and commit `5e1b72ed20b3fd8e1fa94d1a60c713661d0642a6` (rigi-vendor) | MIT, Copyright (c) vis.gl contributors |
| `vendor/deck/*.tgz` | deck.gl `9.4.0-beta.4` build (`@deck.gl/core`, `@deck.gl/layers`) from commit `f1bc66cede34768f6c10fa15681119bc669a2efb`: deck master `ce0808d0` merged with PR #10752 (`0d8b1664`), plus the WebGPU hunks of luma.gl's deck patch | MIT, Copyright (c) vis.gl contributors |

Both are third-party code with local build changes; their provenance and rebuild steps are in `vendor/luma/README.md` and `vendor/deck/README.md`. Their upstream licence files travel inside the tarballs (to confirm they are present; if not, add them). The vendored packages are not covered by Rigi's `LICENSE` copyright line.

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
| `src/lib/look/weather/precipitation.ts`, `src/lib/deck/weather-layer.ts` | luma.gl #3325 `precipitation` shadertools module | MIT, vis.gl contributors |
| `src/lib/sky/model.ts` | wrapper for the U2-Net-P sky model | MIT (model licence, see section 3) |
| `src/lib/nearfield/generate/remote.ts`, `inpaint-client.ts` | clients for GEN3C, LingBot-World and LaMa services; the files cite their upstream licences (Apache-2.0 code; GEN3C weights under NVIDIA terms, to confirm) | no upstream code copied: to confirm |
| `src/components/nearfield/Tiles3DCredit.tsx`, `src/lib/tiles3d/` | credit handling for Google Map Tiles and swisstopo 3D Tiles, per their policies; geoid grid in `geoid-data.ts`: source and licence to confirm | to confirm |

Files that already carry another licence or copyright notice are left alone by `scripts/ci/spdx.mjs` and listed by it for review. Internal ports between Rigi's own backends (for example WGSL ports of GLSL layers, `scripts/leaderboard.mjs`'s port of `src/lib/pose.ts`) are first-party code and MIT.

## 6. Contact

Licensing questions or corrections: open a GitHub issue.
