# Consolidation review after the luma graph / math.gl / browser-only moves (2026-10-02)

Question: after moving compute onto the luma compute graph, three.js onto math.gl, and the Python services, ORT and MediaPipe into `src/lib/nn`, what else should be consolidated, and what was left out?

Method: five read-only reviews run in parallel: math.gl, compute off the graph, migration leftovers, deck/loaders/rendering, and gpu/core + nn idioms. This builds on the luma-native dependency audit (outcome in [gpu-renderer.md](gpu-renderer.md)) and does not re-propose anything it rejected (`GPUMatMul`, `@loaders.gl/geotiff`, `@math.gl/geoid`, `@math.gl/sun`). Nothing was edited, measured, or run in a browser.

The only command run was `gpu-raw-lint` (PASS, 127). The headline claims (P0 items 3–5, P1 item 9, P2 item 13, `@luma.gl/effects` unused) were re-checked by hand. Claims marked *(unverified)* come from sub-reviewers and were not re-traced.

## Verdict

- **The compute structure is sound.** No GPU dispatch remains outside `ComputeGraph`; `gpu-raw-lint` passes at 127.
- **What's left is seams.** CPU work sits between GPU stages, one cached graph per module instead of per photo, and the new nn consumers don't use the composition API (`forwardInto` / `fromView`) that was built for them. Its only caller is `scripts/nn/interop.check.ts`.
- **The browser-only move dropped real behaviour.** There is no CPU path for Step Inside, CPU nn forwards run on the main thread, and several service features have no replacement.
- **math.gl is the wrong target for most duplicated math.** Rigi is row-major, uses `{lat, lon}`, and treats yaw as a compass bearing. The win is collapsing roughly 20 duplicated helpers into `camera/`, `geodesy.ts` and `linalg/`.

## P0: left out or broken

1. **Main-thread nn on the fallback path.** `CpuNn.forward` never yields (`nn/cpu.ts:238`). Under `?gpu=off` or without WebGPU, three things run on the UI thread:
   - **People masks:** `segment.ts:37-41`, which also needs a DOM canvas at `:172`.
   - **Matcher ALIKED/LightGlue:** `matcher/features.ts:12` imports `#/lib/features` directly, not the worker client. That is about 10 s per extraction plus 12–30 s per pair, per the `features/index.ts` header.
   - **StepInsideDemo ViTPose:** `StepInsideDemo.tsx:222`.

   Fix: worker clients for segment and features. The worker protocol already exists for features.

2. **Step Inside is GPU-only.** `local/client.ts` creates nn with `backend: "gpu"` only. Without WebGPU the feature disappears with "needs WebGPU" (`controller.ts:261-266`). The CPU lift fallback at `:375-387` can never run, because it needs a successful GPU depth pass first. The service used to work everywhere.

   **Decision:** accept this as WebGPU-only (consistent with "WebGPU primary") and say so in the UI and docs, or wire nn-CPU depth in a worker.

3. **Feature-matcher nets never recover from device loss.** `features/index.ts:57-71` caches `models` for the session. Two other consumers handle loss badly in a different way: `segment.ts:73-83` and `sky.worker.ts:88-100` drop permanently to CPU after a loss.

   Fix: one `getNn(device)` registry in `nn/index.ts`, dropped via `gpu/core/lifecycle.onLost`. `nearfield/local/client.ts:254` already follows this pattern.

4. **Rain and snow are WebGL2-only.** `deck/engine.ts:86,203,499` draws the weather layer. `deck-webgpu/engine.ts` never reads `style.world.weather`, and there is no WGSL `precipitation`. It is off by default, but the default engine silently draws nothing when it is turned on.

   Fix: port it to WGSL, or list it as a known gap in the deck-webgpu README.

5. **Dead SHARP option.** `components/panel/flags.ts:113` offers `nearfield=sharp` (dev builds), but the flag accepts only `auto|on|complete|off` (`flags/index.ts:128`). Several other leftovers need removing:
   - the "research-only" badge (`StepInsidePanel.tsx:82-84`) can never show;
   - the help text at `flags.ts:107` still says "probes the splat service";
   - `useStepInside.ts:79` still mentions `=sharp`.

6. **No batch-ledger rows for the browser-only migration.** The six commits involved are 8bb109d, d8e99834, 73d751a8, 9c63b662, 056fa277 and c976fa4d. Ledger row 23 still lists a check that needs `:8767`. The next browser batch will miss all of them.

## P1: dropped service behaviour (decide: restore or record as removed)

7. **Near-field gaps:**
   - `timeoutMs` is declared (`nearfield/client.ts:12`) and passed (`roll-spot.ts:178`), but nothing reads it.
   - `signal` is not checked during inference.
   - Errors are reduced to `console.warn` + `null`, losing the old `{error, code}`.
8. **Features gone without a replacement:**
   - LaMa inpaint (`complete/index.ts:160-166`: NOT IMPLEMENTED);
   - DA3 multiview;
   - MoGe ViT-L/B sizes (the `model` option is accepted and ignored);
   - propagate `ess`/`da3`;
   - the service's 1 GB depth cache (now an in-memory `WeakMap<Blob>`, so nothing survives a reload);
   - matcher ETA/`Retry-After`, and a timeout cut from 120 s to 60 s *(unverified)*.

   Record each in `reports/negative-results.md` or the roadmap, so the gaps are deliberate.
9. **`skylineGpu` is still off** (`flags/index.ts:61`). The only blocker is 1/77 accept flips caused by a chaotic `refinePose` on a wrong-focal seed; the GPU rows match to 1.5e-5 px (`research_notes/wave5/skyline-gpu-flip.md`). Under the "flip working GPU paths" rule this is the clearest candidate. It needs your call and the wild-set A/B.
10. **Model download hygiene** *(unverified)*:
    - `vite build` copies all of `public/models` into `dist`, including parity-only `.onnx`/`.tflite`, all three MoGe variants, and ViTPose (172 MB).
    - An abort doesn't cancel a shared `fetchModel` download.
    - Only MoGe shows progress.
    - The first forward compiles pipelines lazily, with no warm-up.

## P2: compute that should move onto the graph

Ranked by how often it runs:

11. **People segmentation** (S, per photo):
    - `getImageData` (`segment.ts:179`);
    - CPU resample and normalise in (`segment/people.ts:66-80`) and out (`:146`);
    - CPU smoothstep, dilation and two blurs (`segment.ts:190-199`), then a re-upload.

    Copy the sky pattern: `fromBuffer` from photoprep, `nn.interpolate`, `GPURasterDilation`, and the box-sum helper.
12. **Sky prep → U²-Net → refine as one graph** (M, per photo). Today it is three awaited submits (`gpu/sky/prep.ts:349`, `sky/model.ts:167`, `gpu/sky/refine-graph.ts:360`), and it is the natural first production user of `forwardInto`.
13. **ALIKED** (M, per extraction):
    - four forwards with three readback→CPU→upload cycles (`features/aliked.ts:200-303`);
    - soft-argmax and `sddhCorners` on CPU;
    - `borderMask` rebuilt and uploaded on every call (`:191`).

    Padding K keeps it on GPU. LightGlue's per-layer early-stop reads are inherent; leave them.
14. **Step Inside local pipeline** (M, per photo, uncommitted code):
    - two `getImageData` reads (`local/client.ts:93-110`);
    - a full readback of z, mask and normal (`:141-147`);
    - CPU compose (`compose.ts:48`), then CPU depth rebuild + re-upload + readback in `lift-gpu.ts:221-303`.

    Run compose on the graph, read back only the 64² focal/shift grids, and hand the forward's view to the lift. Separately, `depth-net.ts:205` interpolates the pos-embed on CPU; it is memoised, so this is low priority.
15. **Look `photoPixels` canvas re-raster** (M, existing item W1.1/P2):
    - `look/composite.ts:122` feeds `deck-webgpu/compute-bridge.ts:736`, `haze-controller.ts:134` and `gpu/look/capture.ts:115,131`.
    - Also, `deck-webgpu/engine.ts:1319` calls `prep.cpu()` eagerly, so the ~3.5 MB readback happens on every photo *(unverified)*.
16. **Smaller items:**
    - matcher per-view W·H scans (`matcher/core.ts:109`, `context.ts:293,336`) *(unverified)*;
    - roll clear-air full readback + CPU gains (`roll-map.ts:690-697`, `drape-clear.ts`) *(unverified)*;
    - the skyline Viterbi still reads back five planes even with the flag on (`gpu/skyline/index.ts:301`).

Fine as is: body fit (behind flags), f64 LM, the WebGL-only CPU twins (splat sort, DEM decode, row culling), and the nn int8 dequant (one GPU pass at load).

## P3: compute-layer infrastructure

17. **Memory:** there are three pool mechanisms and no budget.
    - `core/pool.ts` grows and never shrinks.
    - Each `GpuNn` keeps its own power-of-two free list (4+ instances), invisible to `poolStats`.
    - Graph caches are LRU by count, not bytes (core 4, nn 48 shared by every model; LightGlue and ALIKED shapes may thrash, *(unverified)*).

    Fix: one shared bucketed pool, a `deviceBytes()` ledger, and a purge on an out-of-memory submit.
18. **No cancellation of in-flight graphs.** `ComputeGraph.run`, `withLease` and nn submits take no `AbortSignal`, so a photo change leaves stale graphs holding leases. Fix: skip the submit and drop the readback when the signal is already aborted (M).
19. **Nine look kernels are declared twice.** `look/textures.ts:139-222` re-declares the `gf-*`, `band-stats` and `hz-*` kernels already in `guided-filter.ts`, `color-stats.ts` and `haze.ts`. Pipelines are cached per spec object, so the warm-up likely builds each kernel twice. Import the existing specs instead (S).
20. **WGSL snippets to share:**
    - 11 hand-written workgroup tree reductions in 8 files → one `core/wgsl/reduce.ts`, with tie-break and an optional subgroup path. `GPUReduction` can't replace them: they are fused, or need a first-index tie-break.
    - Haze radix select duplicates `GPUHistogram` + `GPUSegmentedScan` → one radix-select op, kept bit-identical.
    - The box-sum `GPUConvolution` closure appears twice (`sky/refine-graph.ts:195`, `look/guided-filter-graph.ts:99`).
    - `fn span` appears twice; the Terrarium decode appears twice (`gpu/ingest/terrarium.ts:65`, `terrarium-tile.ts:89`).
21. **Make nn an upstream contributor** (L). nn imports Rigi `gpu/core` throughout and lowers through `ComputeGraph.addKernel`. To be upstreamable as `@luma.gl/experimental` it needs:
    - a thin graph adapter;
    - forwards exposed as `getCommandNodes` contributors;
    - no `cachedGraph` or leases.
22. **Weight VRAM.** int8 is expanded to f16/f32 at load, so it shrinks downloads but not VRAM. Dequantising inside the GEMM loaders would roughly halve weight VRAM (M, *(unverified)*). Activations are always f32.
23. **gpu/core vs luma:** nothing can be deleted today. `readback.ts`, `pool.ts`, `profile.ts` and `uniform-block.ts` are thin or supersets; upstream packets c1–c4, d, f and g each shrink core once merged.

## P4: math consolidation (into Rigi modules; math.gl only where noted)

24. **Pose ↔ axes/R.**
    - The forward direction is copied 6× (canonical `camera/index.ts:38`; copies in `matcher/geometry.ts:16`, `pins/seed.ts:61`, `components/site/lineArt.ts:205`, and 3 Gipfelbuch pages).
    - The inverse is written 5 times (`matcher/geometry.ts:51`, `nearfield/propagate.ts:37`, `deck-webgpu/hosts/deck.ts:348`, `pose6dof/project.ts:219` (which degrades sooner near ±90° pitch), `pins/seed.ts:58`).
    - The cam→ENU transpose is copied 2× (`camera/index.ts:158`, `nearfield/lift.ts:229`).

    Add `poseToR`, `rToPose` and `camToEnu` to `camera/` (M). Keep `matcher/geometry`'s row-major `Float64Array`, which mirrors Python.
25. **ENU/ECEF.**
    - The ENU rotation is copied 3× (`geodesy.ts:59`, `tiles3d/frame.ts:17`, `export/camera.ts:155`).
    - ECEF→geodetic has 3 implementations (Bowring `geodesy.ts:117`, 8-iteration `export/camera.ts:168`, math.gl ellipsoid at `tiles3d/viewport.ts:118`).

    Export `enuRotation` and `ecefToGeodetic` from `geodesy.ts` (S).
26. **3×3 kernels:**
    - `mul3` ×6, `transpose3` ×4, Rodrigues ×3 (keep `body/anny.ts`'s on purpose);
    - `body/fit.ts:690 solveSpd` is byte-for-byte `linalg.choleskySolve`;
    - `eyes.ts:123`, `peakfix/fit.ts:244` and two Gipfelbuch demos have their own solvers.

    Move these into `linalg/` and `pose6dof/ransac/rot3.ts` (S–M).
27. **Matrix→quaternion:** `export/camera.ts:187` and `nearfield/lift.ts:235` are identical except for the w ≥ 0 sign. `quatFromZ` is copied 2× (`lift.ts:216`, `complete/people.ts:477`) (S).
28. **Web-Mercator:** inline copies in `TopoBoard.tsx:45`, `gipfelbuch/pages/dem-source.tsx:172`, `terroir/roll/logic.ts:126` and 5 scripts → `dem/tiles.ts`. Not `@math.gl/web-mercator`, which uses 512-unit worlds and a different clamp (S).
29. **Distances:**
    - `routes/upload.tsx:70` is a verbatim copy of `geodesy.distanceBearing`;
    - `terroir/labels/peakTiers.ts:45` is an equirectangular "hav" with R=6371000;
    - three sites hard-code 111320;
    - the lat/lon box around a point appears 3×.

    Point them at `geodesy.ts` (S).
30. **Opportunistic:**
    - about 40 local `DEG` constants, and two exported `DEG` (`geodesy.ts:23`, `ontology/core/quantity.ts:39`);
    - about 92 inline modulo wraps where `wrap360`/`wrap180` exist; skip `gpu/horizon` and `gpu/align` f32 twins;
    - the LV95 PROJ string copied 2× with different argument orders (`scripts/lib/lv95.ts:11`, `concord/occl/swiss-cog.ts:88`);
    - Douglas–Peucker 6× (`@math.gl/polygon` has none);
    - `Mat3` names three different types (rename the `Float64Array` form `Mat3F64`).
31. **math.gl hygiene:** no hot-loop allocation problems. `nearfield/step-camera.ts` allocates `Vector3`/`Quaternion` per tick though module scratch exists at `:111`, and `ViewCamera.viewMatrix()` / `projectionMatrix()` allocate on every call (low).

## P5: rendering, deck and loaders

32. **The world-view drape occlusion differs between engines.**
    - WebGL2 (`deck/terrain-layer.ts` ~526-546): one sample and a hard 0.5 people cut.
    - WebGPU (`deck-webgpu/layers/drape.ts:236-330`) and the roll multi-drape: 2×2 vote, slope slack and a soft cut.

    Port the vote to GLSL (S).
33. **Shared colour and noise snippets:**
    - GLSL sRGB decode is copied about 6× → add `SRGB_DECODE_GLSL` to `look/glsl/common.ts`. Its `TO_LINEAR_GLSL` has no importers.
    - WGSL sRGB bypasses `colorWGSL` in about 7 places (`layers/composite.ts:520` is a pure duplicate). `deck-webgpu/wgsl.ts:29 to_linear` uses pow 2.2 against the exact curve elsewhere; confirm that is intended.
    - CPU sRGB is copied about 12× → `lib/color/srgb.ts`, except copies bit-matched to kernels.
    - The IGN/hash noise is hand-copied into WGSL (`composite.ts:524-533`), and the sin-hash appears in `look/trail-stroke.ts` and `look/sketch-ridges.ts` → `noiseWGSL`.
34. **Vendor trim at the next rebuild:**
    - `@luma.gl/effects` (`package.json:46`) has zero imports.
    - luma #3326, #3132 and #3337 have no `src/` user (confirm splats doesn't reach them via `gpu-data`).
    - deck #10751, #10783, #10779, #10753 and #10776 have no user (`@deck.gl/extensions` is not vendored).
    - luma #3313 and #3351 are already merged upstream.
35. **`@loaders.gl/tiles` `Tileset2D`** (installed) could replace `cache/queue.ts`, `lru.ts`, part of `tile-cache.ts` and the queue/retry code in `deck/terrain-stream.ts:108-320`. Keep `selectDemTiles` and the mesh fitting. Prototype it, gated on `deck/terrain-stream.check.ts` (M; the risk is the tuned priority order).
36. **Retire the 945-line fallback splat shader** in `deck-webgpu/layers/splats.ts` once the browser batch shows `@luma.gl/splats` never fails (M).
37. **Stale docs:**
    - The deck-webgpu README says "/roll stays WebGL" (line 421; `roll/map/backend-webgpu.ts` exists now) and its flow-layer note (line 412) is out of date.
    - `gpu/app-graph/manifest.ts` still says the sky model is ORT ("external", `:164,559-604`) and that `roll-webgl` is CPU and needs a port (`:847-856`), so `/dev/graph` misreports both.
    - ORT and MediaPipe are still mentioned in: `README.md:14,97`, `sky/README.md:12,21`, `gpu/README.md:156` (`shareOrtDevice`), `gpu/core/README.md:281,292,335`, `gpu/core/luma.ts:13,75`, `gpu/device.ts:26,202`, and `gpu/sky/refine-graph.ts:23,325` (graph id `sky-refine/ort-prob`).
    - Near-field and roll comments still describe the service: `nearfield/controller.ts:249-251`, `roll/spot.ts`.
    - `reports/status.md:14` says rigi.4/deck rigi.2; it is now rigi.6/rigi.3.

Already correct, keep as is: views and cameras on deck `View`/`Viewport` and math.gl; exact-range picking; 1-D horizon label packing; `Tileset3D` without `Tile3DLayer`; GPU DEM decode; the kept shadertools ports (`precipitation`, `sketchStroke`, `riverWaterMaterial`).

## Test and CI gaps

- **New modules with no spec:**
  - `nn/gpu/{k-quant,k-attention,k-gemm,k-reduce,k-spatial,luma-ops}.ts`, `nn/cpu-fast.ts`;
  - `features/{features.worker,protocol}.ts`;
  - `matcher/{assemble,basin-dem,basin-gpu,binding,solve-offthread,solve.worker}.ts`;
  - `body/{back-depth,vitpose}.ts`.
- **Check-like scripts not in `checks.mjs`:**
  - `scripts/gpu/{geo-query,relief-heights,ridges,indirect-draw,deck-load,sky-prep,splat-sort}-check`, `core-selftest`, `unknown-gpu-gate`;
  - `scripts/nearfield/{camera-modes,deck-splat-lab}-check`, `scripts/nn/wgsl-lint.ts`;
  - the 12 `examples/deck/landeskarte/checks/*.check.ts`.
- **Rows that SKIP on a clean clone:** `features` and `style-baseline` (generated `out/` inputs); `u2netp-parity` and `people-parity` (need `tools/matcher/.venv`).

## Browser-unverified backlog, highest risk first

1. Sky + people masks on nn (every photo), and the main-thread CPU path (P0.1).
2. The in-browser matcher: the T6 GPU grid default, worker solves, ALIKED/LightGlue. It has no ledger row.
3. Step Inside fully local, plus the uncommitted int8/prefetch/preview.
4. Roll map on WebGPU as the `auto` default.
5. three.js removal: math.gl camera, tiles3d on loaders.gl.
6. rigi.6 wave 2 defaults.
7. gpu/core interop, raster Sobel and dilation, GPUFFT1D yaw, shadertools fog and dash.

## Suggested order

1. **Quick wins (S, no behaviour risk):**
   - ledger rows (P0.6), the SHARP cleanup (P0.5), stale manifest and docs (P5.37);
   - the duplicate look kernel specs (P3.19), the `solveSpd` → `choleskySolve` swap and `distBearing` (P4).
2. **Fallback correctness (M):**
   - worker-offload segment and features (P0.1);
   - the `getNn` device-loss registry (P0.3);
   - decide Step Inside without WebGPU (P0.2) and weather on WebGPU (P0.4).
3. **Graph seams (M):**
   - people segmentation on GPU in/out (P2.11);
   - sky as one graph via `forwardInto` (P2.12);
   - ALIKED K-padding (P2.13);
   - Step Inside compose on the graph (P2.14).
4. **Infrastructure (M):** cancellation (P3.18), the shared pool and memory ledger (P3.17), the reduce snippet (P3.20).
5. **Math consolidation (S–M):** P4.24–29 in one pass, with specs for each moved helper.
6. **Decisions for the owner:**
   - `skylineGpu=on` (P1.9);
   - restore or record each dropped service feature (P1.8);
   - vendor trim (P5.34);
   - a `Tileset2D` prototype (P5.35).

## Outcome of the implementation pass (2026-10-02, session mt-image-91)

The user's direction was to be maximal on luma and the GPU, to accept GPU-only features, and to use Opus coordinators driving Sonnet workers. Six lanes landed about 40 commits on master. Lane reports are in that session's scratchpad. Everything that touches rendering or the GPU is **browser-unverified**, and each landing has a row in `reports/batch-ledger.md`.

Before the lanes started, the ended session f6's uncommitted Step Inside download work (int8 weights, prefetch, terrain preview, people volumes) was committed as `a8a5539b`.

| Item | Result | Commits |
|---|---|---|
| P0.1 main-thread CPU nn | Features, people masks and the ViTPose demo are GPU-only, and the matcher goes through the features worker. The sky worker keeps its off-thread CPU path | c42b18d7, ab04f6e5, d997548c |
| P0.2 Step Inside without WebGPU | GPU-only, with the button disabled and a "needs WebGPU" chip; the dead CPU lift is removed | 7f34f216 |
| P0.3 device loss | `getNn(consumer, device)` registry (`src/lib/nn/registry.ts`), dropped on loss; sky no longer falls back to the CPU for good | 5c48c9ab, c42b18d7 |
| P0.4 weather on WebGPU | Uses luma's WGSL `precipitation` module, keeping Rigi's world-anchored lattice; `weather-dawn` check added | 3083f8c2 |
| P0.5, P0.6, P1.8 hygiene | SHARP option removed; stale ORT/MediaPipe/service text removed; dropped service features listed as follow-ups in `roadmap.md`; ledger rows written for the migration commits | 4343c156, a6f39555, eeb47811 |
| P1.7 Step Inside robustness | `NearFieldError` codes, timeout and abort, single-flight per-photo jobs, idle unload after 5 min, and a persistent depth cache (Cache Storage, LRU 256 MB) | 7f34f216, 298d30c7 |
| P1.9 + P2.16 skyline | `skylineGpu` on by default (node A/B: 0 decision changes on GT-12 and wild-dev); fits, Viterbi and column finish run as one graph; 48–78 ms vs 68–114 ms for the old hybrid | f720c646, c5dac9fc |
| P1.10 downloads | Shared-download abort refcount, progress from workers, `nn.warm` warm-up (first forward on the people model 162 → 61 ms), 23.7 MB of parity-only models out of the build | 67fdd433 |
| P2.11 people masks | Texture in, one nn forward, one readback; within 1/255 of the old CPU post-process | ab04f6e5 |
| P2.12 sky | prep → U²-Net → refine as one ComputeGraph (first production use of `forwardInto`); bit-identical masks | 21219a36 |
| P2.13 ALIKED | One forward with fixed K slots; soft-argmax and SDDH run on the GPU | 95a07ee0 |
| P2.14 Step Inside depth | GPU prep, net, compose, normals and lift on the graph, reading back only the 64² samples; warm time ~393–494 → 329–418 ms | a3848dc1 |
| P2.15 look photo | Bridge photo grids resampled on the GPU from the engine texture. The eager `prep.cpu()` stays because auto-align and the picker need the CPU EdgeMap | 725ad12b |
| P2.16 matcher scans, roll clear-air | One memoised scan per view; clear-air range decimated on the GPU (readback 8.3 MB → 130 KB at 1080p) | 56403250, 9ece1366 |
| P3.17 memory | Shared bucketed buffer pool (nn included), `deviceBytes()` ledger with nn weights, graph-cache byte budget, purge on OOM | 7efe096c, 4af2c389 |
| P3.18 cancellation | AbortSignal on `withLease`, `run`/`runNow` and `readBack`, wired into basin-grid and eye horizon. **Partial:** photoprep and look have no per-photo signal yet | 2dfa9245 |
| P3.19, P3.20 kernels and WGSL | 11 duplicate look kernel ids removed; one `core/wgsl/reduce.ts` used by 11 reductions (bit-identical); shared box-sum, `span` and Terrarium decode | eeb47811, 1f846b0b |
| P3.22 int8 resident | Dequantization inside the weight loads, 70 → 36 MB VRAM. ~12% slower over Dawn, so it is **opt-in** (`quantResident`) | def642d0 |
| P4 math | `camera/` pose↔R and cam→ENU; `geodesy` ENU and ECEF; `linalg` 3×3 helpers and quaternion; shared Web-Mercator, distances, LV95, Douglas–Peucker; one `DEG`; `Mat3F64`. Specs show ≤ 1e-12 against the old copies | e672506c, 03182cca, ab7ce19e, b0869f8a |
| P5.32 drape vote | The WebGL drape uses the WebGPU 2×2 vote and soft people cut | d5bfe07c |
| P5.33 colour and noise snippets | One copy per language; `src/lib/color/srgb.ts` replaces 14 CPU copies | a7f7f9ef, 2e9ce3c2 |
| P5.35 loaders.gl | `Tileset2D` rejected (single priority, no retry, memory-only cache). The terrain queue moved to loaders.gl `RequestScheduler` instead (`terrainScheduler`, default `loaders`, same order as the old queue in specs) | 4e25fdaa |
| P5.36 splat fallback shader | Kept: it is the only path for oversize clouds, the live GPU splat source and the geometry option | — |
| Extra | ViTPose-B int8 default (172 → 87 MB, 0.08 px median keypoint error); 23 check rows registered (161 → 184) and new matcher specs | 722e0591, 190f81ed |

Still open:
- per-photo AbortControllers for photoprep and look;
- a lazy `prep.cpu()`;
- matcher render targets fed to ALIKED on the GPU;
- tuning `quantResident` so it can become the default;
- whether vitpose and anny ship in the build;
- whether the sky worker's CPU model becomes GPU-only too;
- the vendor trim (P5.34);
- the browser batch for all of the above.
