# Rigi: georeferenced mountain photos × map data

Rigi places a mountain photo in 3D and lines the terrain up with it. It starts from the photo's
EXIF prior: GPS, true-north heading, the Apple MakerNote gravity vector for pitch and roll, and the
35 mm-equivalent focal length. It then solves the camera against the DEM skyline. One solved camera
model drives three ways to combine the photo with map data:

| Mode | What it does |
|---|---|
| **Overlay** | Contours or elevation bands, ridgelines and skyline, occlusion-tested OSM peak labels, SAC-coloured hiking trails, a distance tint, and a hover readout of lat/lon/elevation/distance for any pixel |
| **Blend** | Replaces parts of the photo with a 3D satellite (swissimage/Esri), swisstopo topo, relief or bands render from the same viewpoint, through a lens, a swipe, a distance cut-off or a brush. Sky and people stay photographic |
| **In map** | Projects the photo onto 3D terrain, using the camera's range buffer as a shadow map, so only surfaces the camera saw get pixels. Orbit around, then *Fly into the photo* |

People in the foreground are segmented in the browser (MediaPipe `selfie_multiclass`), so overlays
skip them, blends keep them in front, and the projection doesn't smear them over the ground. Poses
export as pose JSON, XMP, COLMAP, KML/KMZ, GeoJSON footprints and annotated images (`src/lib/export`).

## Quick start

Requirements: Node 22 and a browser with WebGPU (recent Chrome, Edge or Safari) for the default engine; any WebGL2 browser gets the fallback engine. The Python matcher and near-field services are optional.

```bash
npm install
npm run dev     # http://localhost:3100
```

What works on a bare clone: the app builds and runs, `/upload` aligns any photo you drop in (HEIC or JPEG, processed in the browser against Mapterhorn DEM tiles fetched over the network), `/roll/import` builds a camera roll from your photos, `/atlas` and the `/lab/*` benches open, and the standalone [examples](examples/README.md) run. What needs more: the home page and `/library` list the photos in `public/photos/`, which you create with `npm run ingest` from HEIC files in `img/`. The evaluation harnesses (`scripts/eval*.ts`, `scripts/leaderboard.mjs`), `/baseline` and some CI checks read research data under `data/`, `public/photos/` and `public/baseline/`; these are gitignored, so without them those checks report SKIP in `node scripts/ci/run.mjs`. The Niederhorn demo set in `public/demo/` is included in the repository (all rights reserved, see NOTICE.md), so the landing page demo works on a bare clone. Step Inside and the matcher need their Python services (`npm run dev:all`).

## Built with luma.gl and deck.gl

Rigi is an application, and also a worked example of the luma.gl 10 / deck.gl stack on both GPU backends. What it exercises:

- **luma.gl 10 on WebGPU and WebGL2.** One luma `Device` per page. Under WebGPU the render device is also the compute device (`adoptRenderDevice`, `WebGPUAdapter.attach()` with `requiredLimits`), so GPU results feed rendering with no CPU round trip.
- **`GPUCommandGraph` compute.** `src/lib/gpu/core` wraps luma's `GPUCommandGraph` as a `ComputeGraph`: multi-pass compute with GPU-resident intermediates, built on luma's engine `Kernel`, `GPUScan`, a readback ring and a device pool. Horizon marching, pose search, haze/relief/band-stats look passes, sky refinement and splat sorting all run as graphs, and the graph is the only GPU path.
- **deck.gl custom views and layers on WebGPU and WebGL2.** Photo-matched camera views, a batched terrain layer, a geometry pass that writes range to a float target, composite and drape layers, trails, labels and Gaussian splats. `src/lib/deck-webgpu` (WGSL) and `src/lib/deck` (GLSL) implement one `Renderer` interface and are checked against each other (`scripts/deck-engine-smoke.mjs`).
- **WGSL and GLSL dual shaders.** Layers are written once per backend; `src/lib/deck-webgpu/layers/*.check.ts` compare the WGSL output with a CPU port of the GLSL.
- **Vendored luma.gl 10 alpha.** `vendor/luma` (`10.0.0-alpha.2-rigi.2`) and `vendor/deck` (a deck.gl `9.4.0-beta.4` build) carry the upstream fixes the app needs until they are published; each README lists the exact commits and how to rebuild.
- Shader modules ported from luma.gl (height fog, precipitation; MIT, vis.gl contributors) drive the "Nebelmeer" and weather looks; see `NOTICE.md`.

Repository conventions follow luma.gl: `AGENTS.md`, `CONTRIBUTING.md` (including AI-assisted contributions), `CODE_OF_CONDUCT.md`, `.github` templates, SPDX headers (`node scripts/ci/spdx.mjs`) and a `CHANGELOG.md`.

## Examples

Standalone luma.gl / deck.gl examples live in [`examples/`](examples/README.md): a deck.gl summit view on WebGPU and WebGL2 (`deck/summit-view`), a photo drape with a shadow-map effect and a fly-into-the-photo orbit view (`deck/photo-drape`), and a luma `GPUCommandGraph` horizon compute graph (`gpgpu/horizon-graph`). See `examples/README.md` for the index and run commands.

## License

The code is MIT, Copyright (c) 2026 Robert Christie and Rigi contributors: see [`LICENSE`](LICENSE). Photographs, map data and tiles, ML models, the vendored luma.gl and deck.gl builds, and code ported from other projects have their own terms: see [`NOTICE.md`](NOTICE.md). Contributions: [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Architecture

Vite + React 19 + TanStack Router/Start (file routes in `src/routes`, `src/routeTree.gen.ts` generated
by `npm run generate-routes`).

| Route | What it is |
|---|---|
| `/` | Home: bundled photos by region, local uploads, the brand panorama |
| `/photo/$id` | The workspace (`src/components/PhotoWorkspace.tsx`): auto-align, second opinion, manual align, modes, style, export |
| `/upload` | Upload any photo (HEIC via libheif in a worker, EXIF via exifr). Photos with no compass, gravity or focal take the unknown-pose path |
| `/roll`, `/roll/import`, `/roll/$id` | Camera rolls (`src/lib/roll/**`): a whole day's photos clustered into rolls and spots, with a mosaic, per-spot panoramas, and every photo draped on one deck.gl terrain map |
| `/baseline` | Debug UI for the CPU pipeline (`src/baseline-ui`): horizon, skyline detection, solve, peaks |
| `/lab/splats`, `/lab/deck-splats`, `/lab/generate` | Step Inside dev benches: splats in each renderer, and P3 generation (`?nearfield=gen`, GT poses only) |
| `/lab/deck-webgpu` | The WebGPU deck renderer in isolation (`WebGpuEngine`, `src/lib/deck-webgpu`); the app uses it by default via `?renderer=auto` |

**Renderers.** `src/lib/renderer.ts` is the engine interface that PhotoWorkspace and the export layer
use. Both backends are deck.gl on luma.gl, picked by `src/lib/renderer-select.ts` and loaded on demand:

- **deck.gl on WebGPU** (`src/lib/deck-webgpu`, `WebGpuEngine`) is the default (`?renderer=auto`) where the
  browser passes the WebGPU probe.
- **deck.gl on WebGL2** (`src/lib/deck`, `DeckEngine`) is the automatic fallback and the escape hatch
  (`?renderer=deck`, or `?webgpu=off`). `scripts/deck-engine-smoke.mjs` checks Δyaw ≤ 0.5° and label
  overlap between the two.

Each draws Mapterhorn tiles with a geometry pass (ENU xyz + range, read back for `sampleAt`, labels,
occlusion and auto-align), a layer pass and a composite pass. The three.js PhotoEngine (`?renderer=three`)
was removed on 2026-10-01; that value now falls back to the default with a console warning. three.js is
still used where it is the right tool: Step Inside splats (`src/lib/nearfield`), the 3D Tiles adapters
(`src/lib/tiles3d`), `/lab/splats` and the P3 RGB-D cache (`/lab/generate`).

**Look and style.** Both backends share them.

- `src/lib/style` holds the `ViewStyle` schema, defaults and presets. The presets are classic,
  minimal, topo-map, night, high-contrast, photo-matched, swiss, berann, topo-ink and slope. The
  module also has the store (`?style=` plus a cross-tab localStorage) and one apply module per backend.
- `src/lib/look` holds the photographic look. It covers the atmosphere and haze fit, the sun, the relief
  field, the GLSL blocks, the CPU composite (refined masks, colour harmonisation, grain) and the peak
  label ranking and layout.

**Geo cascade (CPU).** `src/lib/geo` (see its README) contains the prior camera, the 360° DEM horizon, the
photo skyline (Viterbi), `solvePose` and the tap-the-peaks solver. `geo/pipeline.ts` chains
`solvePose` → `refinePose` on reject (`src/lib/refine`: FFT init plus robust LM with a confidence
gate). Around it sit several helpers:

- `src/lib/horizon-fast` is the fast horizon march.
- `src/lib/sky` is the U²-Net sky segmentation, with an ONNX model in a worker.
- `src/lib/dem` handles DEM sources and decoding.
- `src/lib/pose6dof` is the 6-DoF GCP solver and eye refinement, the building block for photos without GPS.

**Integration worker.** `src/lib/integration/unknown-pose.worker.ts` runs the cascade in a Web Worker
on its own 360° Mapterhorn scene. It serves two cases:

1. **The second opinion for photos with full metadata** (`second-opinion.ts`). The cascade runs with
   default options.
2. **Photos whose heading, gravity or focal is unknown** (`unknown-pose.ts`). The unknowns are freed
   through the solver options: a 360° yaw search, free tilt, and three focal seeds, with a stricter
   0.75 accept bar.

**Matcher service** (`tools/matcher`; `reports/matcher-service-v040.md`). This is
an optional Python service on :8765 that does render-and-match (ALIKED + LightGlue against app
renders from a headless Chromium worker), fused with the skyline cue. The app reaches it through
`src/lib/matcher-client.ts` (`VITE_MATCHER_URL`) and degrades silently when it is down.

- **Endpoints:** `POST /match` (a bundled photoId, an ad-hoc photo, or a multipart request) and `GET /health`.
- **Queueing:** one job runs at a time. Otherwise the service answers `503 busy` with a queue ticket.
- **v0.4.0 policies:** `v034` (default) is the v0.3.x search with an a-priori HIGH and a basin-gap
  check. `t6` (opt-in, `timeoutMs` ≥ 300 s) is the T6 two-stage search with a frozen confidence rule.
- **Product accept rule** (`matchAccepted`): a match counts only when it is HIGH and either the
  EXIF GPS is trusted or it lies within 0.5° of the skyline cascade.

**Step Inside** (`src/lib/nearfield`, `reports/step-inside-results.md`). Near-field Gaussian splats anchored
to the DEM with a per-photo depth curve and object grounding, a step-in camera that starts on the photo, a
Truth tint, a hover readout on objects, and georeferenced `.ply`/`.splat` export (generated content is
always stripped). It is on by default in both renderers and needs the near-field service
(`tools/nearfield/run.sh`, :8767: depth, Gaussians, multiview, inpainting). Pose propagation between
overlapping photos is wired into `/roll` as suggestions only, behind `?propagate=on`
(`src/lib/roll/propagate/README.md`).

**Other modules.**

- `src/lib/gpu`: GPU compute on luma's `GPUCommandGraph` (`src/lib/gpu/core` `ComputeGraph`): auto-align grid, horizon, eye search, solve, look passes, sky refine, splat sort. It is the only GPU path (the CPU twin is the fallback), and under WebGPU it runs on the render device. See its README.
- `src/lib/concord`: whole-image concordance (focal-table eye prior, DSM occluder). See `reports/concordance-research.md`; the killed parts are listed in `reports/negative-results.md`.
- `src/lib/reveal`: the overlay bloom-in on load.
- `src/lib/cache`: the tile cache.
- `src/lib/upload`, `src/lib/export`, `src/lib/pose6dof`: have API READMEs.

**URL flags and ports**

| Flag | Effect |
|---|---|
| `?renderer=auto\|webgpu\|deck` | Engine: `auto` (default) = deck.gl on WebGPU where the browser passes the probe, else WebGL2; `webgpu` / `deck` pin one. `?backend=webgpu\|webgl` is luma.gl's example-style alias. `?webgpu=off` forces the WebGL fallback |
| `?style=<preset>` | View style preset |
| `?nearfield=off\|on\|sharp` | Step Inside: hide, force on (headless browsers too), or the dev-only SHARP model (research licence). Default `auto` |
| `?gpu=off` | GPU compute kill switch (CPU twins everywhere) |
| `?gpuHorizon=off`, `?lookgpu=off` | Turn off the GPU horizon or the GPU look passes (both on by default) |
| `?eyesearch=on\|auto`, `?unknownGpu=on` | Opt-in GPU eye search / GPU unknown-pose horizon |
| `?terrain=tiles` | deck: per-tile terrain instead of batched |
| `?reveal=off\|<preset>` | Load animation |
| `?concord=eye,occl` | Concordance: focal-table eye prior, DSM occluder dimming |

Every flag is declared in `src/lib/flags` (typed, the only reader), carried across navigation by the root route, and settable from the photo sidebar's **Experimental & dev** section. Booleans are `on`/`off`. Harnesses override per realm with `globalThis.__RIGI_FLAGS__ = { gpu: "off", … }`.

| Port | Service |
|---|---|
| 3100 | Dev server (`npm run dev`, or `npm run dev:all` with both backends) |
| 3110 | Private Vite server for GPU and near-field browser checks (`scripts/gpu/vite.gpu.config.ts`) |
| 8765 | Matcher (`tools/matcher/server/run.sh`) |
| 8767 | Near-field service (`tools/nearfield/run.sh`) |

## The pose pipeline today

**Photos with compass, gravity and focal** (PhotoWorkspace):

1. **Prior:** GPS position, compass yaw, gravity pitch/roll, and focal from the 35 mm equivalent on the
   diagonal (`FF35_DIAGONAL_MM` = 43.2666, `src/lib/camera/focal.ts`, crop-aware). The eye sits at
   max(GPS altitude, DEM + 1.6 m).
2. **Auto-align** (`src/lib/align.ts`, GPU): trace the 360° DEM horizon from the geometry buffer, then
   search a coarse yaw×pitch grid, then run coordinate descent on yaw, pitch, roll and FOV against a
   sky-aware edge map. The top five are re-ranked by inner silhouettes.
3. **Preview** (`choosePreview` in `second-opinion.ts`): the auto-align result if its confidence is
   above 0.2, else a near-compass alternative (within 4° yaw and 1.5° pitch), else the prior. The
   workspace is ready (`[data-ready]`) about 3.7 s after navigation.
4. **Second opinion** (`secondOpinion`): the CPU cascade runs in the worker with a 20 s deadline.
   - If it agrees within 1°, the pose is marked **verified**.
   - If it accepts a different pose, it overrules the preview (**refined**).
   - If it rejects and `shouldEscalate` fires, the photo is marked **unverified**, and the matcher is
     asked when it is up. Its pose is taken only under the product rule (**matched**).

**Uploads with unknowns:** the cascade runs with those unknowns freed. If it rejects, the photo goes to
fused `/match` in ad-hoc mode, which is taken only at HIGH. If that fails too, the photo is marked
**unverified** and you finish by dragging or pinning peaks (Levenberg–Marquardt: one pin solves yaw
and pitch, two add roll, three add FOV).

**Measured accuracy**

| What | Set | Result | Source |
|---|---|---|---|
| App pipeline, final pose | 14 control-point photos | 12/14 within 1° yaw, 0 false accepts, median \|Δyaw\| 0.23°, 7.5 px; t-ready 3.7 s, t-final 4.0 s (max 27.5 s) | `reports/pipeline-ab.md` |
| Same, `node scripts/eval-app.mjs` (2026-09-26) | 19 rows, 14 with pins | 12/14 within 1° yaw; median auto px error 6.5 (1600 px) | P5 consolidation run |
| Pipeline variants `cascade`, `skyfirst`, `wide` | same 14 | none better. cascade and skyfirst had a worse median, wide gained nothing. The variants were removed; `current` is the only path | `reports/pipeline-ab.md` |
| CPU classic+cascade (the second-opinion solver) | 12 GT photos | 11/12 correct accepts, 0 false, median 0.20° | `reports/leaderboard.md` |
| App GPU aligner alone | 12 GT photos | 10/12, 1 false accept (one photo, 2.98° off) that the second opinion fixes | `reports/leaderboard.md` |
| Matcher, held-out test (`v034` policy) | 50 frozen wild photos | 29/50 correct, HIGH 17/17 (precision 1.00), product rule 11/11, median 35 s | `reports/test-results.md` |
| Matcher, `t6` policy | same | 30/50, HIGH 22/24 with 2 unsure. Post hoc, 1 of the 2 was judged wrong, so v034 stays the default | `reports/test-results.md`, `test-addendum.md` |
| Matching v2 (eye fallback, calibration priors, LoMa) | 50 dev photos | not shipped: each adds gross HIGHs or nothing | `reports/matching-v2.md` |

The leaderboard (12 GT photos, 2026-09-25) and eval-app (14 pinned photos) use different sets and
harnesses, so don't compare their numbers directly.

## Commands

```bash
npm install
npm run ingest            # img/*.HEIC → public/photos/*.jpg + photos.json + region-*.json (SKIP_OSM=1: no Overpass)
npm run dev               # dev server on http://localhost:3100
npm run dev:all           # dev server + matcher (:8765) + near-field (:8767); reuses anything already up,
                          #   skips a backend without tools/matcher/.venv. Pick some: node scripts/dev.mjs --be=nearfield
npm run build             # production build (vite build)
node scripts/examples.mjs list   # standalone luma.gl/deck.gl examples: start <id> | check | build | smoke
node scripts/ci/spdx.mjs  # SPDX headers on first-party files
npx tsc --noEmit -p .     # typecheck
npm run check             # biome check on the whole configured tree (biome.json: src, scripts, tools/**/*.{ts,mjs,js})
npx biome check --write <files>   # format and lint the files you changed

# accuracy
npx tsx scripts/eval.ts                      # CPU solvePose vs data/ground-truth.json → out/eval/
SOLVER=cascade npx tsx scripts/eval.ts       # the cascade (also: skyfirst; HORIZON=fast; DEM=mapterhorn)
node scripts/eval-app.mjs [photoId ...]      # the app's final pose vs data/control-points.json (needs :3100)
node scripts/leaderboard.mjs                 # every method re-scored on one GT snapshot → reports/leaderboard.md

# regression gate (scripts/ci/README.md): one runner for every check
node scripts/ci/run.mjs fast                 # ~30 s: tsc, biome ratchet, ~34 unit checks
node scripts/ci/run.mjs full                 # + browser checks (style-baseline, deck smoke, eval-app, eval-app-deck), via the render lock
node scripts/ci/run.mjs --list               # every check, its command and inputs

# matcher service (optional; needs tools/matcher/.venv and weights)
tools/matcher/server/run.sh --port 8765      # env MATCHER_POLICY=v034|t6

node scripts/shot.mjs <url> out.png --wait-for "[data-ready]"   # headless WebGL screenshot
node scripts/gpu/with-render-lock.mjs -- <cmd>                # wrap every browser job: one GPU job at a time
#   FIFO queue; RENDER_LOCK_PRIORITY=1 jumps it for a job someone is waiting on. Never omit the `--`
node scripts/gpu/with-render-lock.mjs -- node scripts/nearfield/step-inside-e2e.mjs [--renderer=deck] [--dead] <ids>
```

**Brand.** The home page panorama (the view south from Rigi Kulm, drawn as depth-layered ridgelines, with visibility-tested OSM peaks) and the logo mark (Rigi Kulm summit contours) are generated from the same DEM. To regenerate them, run `npx tsx scripts/brand/rigi.ts` (add `--preview` to also write PNGs to `.cache/brand/`). It writes `public/brand/rigi-panorama.json`, `src/brand/rigi-mark.json` and `public/favicon.svg`.

## Docs

- [reports/status.md](reports/status.md): where every thread stands, and the open decisions.
- [reports/roadmap.md](reports/roadmap.md): the plan.
- [reports/negative-results.md](reports/negative-results.md): what didn't work.
- [reports/code-review-2026-09-30.md](reports/code-review-2026-09-30.md): the code-health backlog (numbered CR-nn items).
- [reports/README.md](reports/README.md): an index of every report, research note and module README.

Data: terrain © Mapterhorn, imagery © swisstopo / Esri, peaks & trails © OpenStreetMap contributors.
