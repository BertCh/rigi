# Rigi: georeferenced mountain photos × map data

Rigi places a mountain photo in 3D and lines the terrain up with it. It starts from the photo's EXIF
prior (GPS, true-north heading, the Apple MakerNote gravity vector, the 35 mm-equivalent focal
length), then solves the camera against the DEM skyline. One solved camera drives three ways to
combine the photo with map data:

| Mode | What it does |
|---|---|
| **Overlay** | Contours or elevation bands, ridgelines and skyline, occlusion-tested OSM peak labels, SAC-coloured trails, a distance tint, and a lat/lon/elevation/distance readout for any pixel |
| **Blend** | Replaces parts of the photo with a 3D satellite, topo, relief or bands render from the same viewpoint, through a lens, a swipe, a distance cut-off or a brush. Sky and people stay photographic |
| **In map** | Projects the photo onto 3D terrain with the camera's range buffer as a shadow map, so only surfaces the camera saw get pixels. Orbit around, then *Fly into the photo* |

**Step Inside** adds near-field Gaussian splats anchored to the DEM (depth from MoGe-2 in the
browser). Poses export as pose JSON, XMP, COLMAP, KML/KMZ, GeoJSON and annotated images
(`src/lib/export`). The default look is the Landeskarte style (`?style=classic` for the original).

Everything runs in the browser: there is no backend. Skyline solve, the ALIKED + LightGlue matcher,
sky and people segmentation, Step Inside depth and pose propagation all run on Rigi's own neural-net
runtime (`src/lib/nn`) on the luma.gl compute graph, with CPU fallbacks.

## Quick start

Node 22 and a browser with WebGPU (recent Chrome, Edge or Safari) for the default engine; any WebGL2
browser gets the fallback engine.

```bash
npm install
node scripts/models/fetch.mjs   # model weights into public/models (gitignored; sha256-verified)
npm run dev                     # http://localhost:3100
```

On a bare clone the landing page (bundled Niederhorn demo roll in `public/demo/`), `/upload`,
`/roll/import`, `/gipfelbuch` and the [examples](examples/README.md) work. `/library` and the home
photo list need `public/photos/`, built with `npm run ingest` from HEIC files in `img/`. Evaluation
harnesses and some CI checks read gitignored research data (`data/`, `public/photos/`,
`public/baseline/`) and report SKIP without it.

## Routes

| Route | What it is |
|---|---|
| `/` | Landing page: scroll showcase on the bundled demo roll |
| `/library` | Bundled photos by region and local uploads |
| `/photo/$id` | The workspace (`src/components/PhotoWorkspace.tsx`): auto-align, second opinion, manual align, modes, style, Step Inside, export |
| `/upload` | Any photo (HEIC via libheif in a worker, EXIF via exifr); photos without compass, gravity or focal take the unknown-pose path |
| `/roll`, `/roll/import`, `/roll/$id` | Camera rolls (`src/lib/roll`): a day's photos clustered into spots, with a mosaic, per-spot panoramas and every photo draped on one terrain map |
| `/live` | Real-time camera view with orientation sensors (`src/lib/live`); `?liveSource=<clip>` replays a recording |
| `/s/$code` | Read-only share view (beta, `?share=on`) |
| `/gipfelbuch`, `/gipfelbuch/$concept`, `/gipfelbuch/print` | Explainer: 16 concept sheets and a printable edition |
| `/baseline`, `/lab/*`, `/dev/*` | Dev-only (stub in production builds): CPU pipeline debug UI, WebGPU engine and splat benches, GPU app-graph inspector, explainer and Gipfelbuch previews, demo-roll exporter |

Routes are file routes in `src/routes`; `src/routeTree.gen.ts` is generated (`npm run generate-routes`).

## Key flags

All flags are declared in `src/lib/flags/index.ts` (the only reader), carried across navigation and
settable from the photo sidebar's **Experimental & dev** section. Booleans are `on`/`off`; harnesses
override per realm with `globalThis.__RIGI_FLAGS__`.

| Flag | Effect |
|---|---|
| `?renderer=auto\|webgpu\|deck` | `auto` (default): deck.gl on WebGPU where the probe passes, else WebGL2; the others pin an engine. `?webgpu=off` forces the fallback |
| `?gpu=off` | GPU compute kill switch (CPU twins everywhere) |
| `?style=<preset>` | Look preset (`src/lib/style/presets.ts`): swiss/landeskarte (default), classic, minimal, topo-map, night, terroir, … |
| `?nearfield=auto\|on\|complete\|off` | Step Inside: offered when WebGPU and the depth model are present (never under automation), forced on, on with completion heuristics, or off |
| `?matcherPolicy=v034\|t6` | Matcher search policy (default `v034`) |
| `?picker=on\|always`, `?eyesearch=on\|auto`, `?concord=eye,occl` | Alignment aids: top-3 picker / tap-a-peak, GPU eye search, concordance priors |
| `?propagate=on` | `/roll`: pose propagation suggestions |
| `?tiles3d=buildings\|swisstopo\|google\|all` | 3D Tiles in Step Inside (`src/lib/tiles3d`) |
| `?theme=auto\|light\|dark` | Colour theme |

## Architecture

- **Engines.** `src/lib/renderer.ts` is the engine interface; `src/lib/renderer-select.ts` picks
  deck.gl on WebGPU (`src/lib/deck-webgpu`, WGSL, default) or deck.gl on WebGL2 (`src/lib/deck`,
  GLSL, fallback). Features are ported to both; `scripts/deck-engine-smoke.mjs` checks they agree.
  Cameras are math.gl (`src/lib/camera`), 3D Tiles stream through loaders.gl. There is no three.js.
- **GPU compute.** `src/lib/gpu/core` wraps luma's `GPUCommandGraph` as a `ComputeGraph`; it is the
  only GPU compute path and under WebGPU shares the render device.
- **Pose pipeline.** EXIF prior → GPU auto-align (`src/lib/align.ts`) → CPU skyline cascade as a
  second opinion in a worker (`src/lib/geo`, `src/lib/refine`, `src/lib/integration`) → the in-browser
  matcher (`src/lib/matcher`) when the cascade rejects, accepted only under the product rule (HIGH, and
  trusted GPS or within 0.5° of the cascade) → manual pins as the last resort.
- **Vendored stack.** `vendor/luma` (luma.gl `10.0.0-alpha.2-rigi.6`) and `vendor/deck` (deck.gl
  `9.4.0-rigi.3`) carry unmerged upstream fixes; their READMEs list the commits and rebuild steps.

Module READMEs sit next to the code (`src/lib/*/README.md`); `reports/README.md` indexes them.

## Measured accuracy

| What | Set | Result | Source |
|---|---|---|---|
| App pipeline, final pose | 14 control-point photos | 12/14 within 1° yaw, 0 false accepts, median \|Δyaw\| 0.23° | `reports/pipeline-ab.md` |
| CPU cascade (second opinion) | 12 GT photos | 11/12 correct accepts, 0 false, median 0.20° | `reports/leaderboard.md` |
| Matcher, held-out test (`v034`) | 50 frozen wild photos | 29/50 correct, HIGH 17/17, product rule 11/11 | `reports/test-results.md` |

The sets and harnesses differ, so the rows are not directly comparable. Current state of every
thread: `reports/status.md`.

## Commands

```bash
npm run build                     # production build
npx tsc --noEmit -p .             # typecheck
npx biome check --write <files>   # format and lint what you changed
npm test                          # Vitest unit specs
node scripts/ci/run.mjs fast      # regression gate without a browser (~30 s); `--list` prints every check
node scripts/ci/run.mjs full      # + browser checks, through the render lock
node scripts/ci/spdx.mjs          # SPDX headers
node scripts/examples.mjs list    # standalone examples: start <id> | check | build | smoke | site
npx tsx scripts/eval.ts           # CPU solvePose vs data/ground-truth.json (SOLVER=cascade|skyfirst)
node scripts/eval-app.mjs --renderer webgpu [ids]   # app pose vs data/control-points.json (needs :3100)
```

Browser and GPU jobs go through `node scripts/gpu/with-render-lock.mjs -- <cmd>`; the testing policy
is in [`AGENTS.md`](AGENTS.md) and the check table in [`scripts/ci/README.md`](scripts/ci/README.md).

## Docs

- [reports/status.md](reports/status.md): where every thread stands; [reports/roadmap.md](reports/roadmap.md): the plan; [reports/negative-results.md](reports/negative-results.md): what didn't work; [reports/README.md](reports/README.md): index of reports, research notes and module READMEs.
- [AGENTS.md](AGENTS.md) (agent and contributor workflow), [CONTRIBUTING.md](CONTRIBUTING.md), [CHANGELOG.md](CHANGELOG.md).

## License

Code: MIT, Copyright (c) 2026 Robert Christie and Rigi contributors ([`LICENSE`](LICENSE)). Photographs,
map data, model weights, vendored builds and ported code have their own terms: [`NOTICE.md`](NOTICE.md).

Data: terrain © Mapterhorn, imagery © swisstopo / Esri, peaks & trails © OpenStreetMap contributors.
