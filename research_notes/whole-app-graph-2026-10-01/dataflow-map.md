# Rigi dataflow map: today's pipeline, as input to a "whole app = one luma.gl command graph" plan

Date: 2026-10-01. Tree: master @ b1b4d9d plus a dirty working tree. This was a read-only pass.

Paths are relative to `src/lib` unless they start with `src/`.

- **Verified directly:** the orchestration, the device registry, the ComputeGraph catalogue, the flag defaults, and a spot-check of the subagent line numbers (`DEFAULT_GPU_PREP`, `GEOMETRY_DEBOUNCE_MS`, `RAYS_PER_SUBMIT`/`MAX_PAGES`, `releaseWhenIdle`).
- **From four parallel read-only sweeps:** the remaining line numbers. Treat a `~` line as approximate.
- **Costs:** estimates, not measurements, unless stated.

---

## 0. Ground rules of the current system (what a graph plan inherits)

| Fact | Where |
|---|---|
| Default engine is `?renderer=auto`. It uses WebGpuEngine (`deck-webgpu/engine.ts`) when the probe passes. The fallback is the WebGL DeckEngine (`deck/engine.ts`). three.js PhotoEngine is gone. | `renderer-select.ts`, `flags/index.ts:40` |
| One ComputeGraph abstraction exists: `gpu/core/graph.ts` `ComputeGraph`, a wrapper over luma gpgpu `GPUCommandGraph`. It is cached per shape via `cachedGraph(device, group, key)`. It has `importBuffer`/`importTexture`, `transientBuffer`, `addKernel` (buffers only), `clearNode`, `readNode`, `condition` (a CPU per-run skip), and `encode(enc)` (record without submit). | `gpu/core/graph.ts:1-30, 167-490, 627` |
| Texture-reading kernels are added through a helper, because `addKernel` covers buffers only. | `gpu/look/textures.ts:316` |
| All readbacks go through one ring (`stageReads` copies into a MAP_READ slot on the caller's encoder, then one `mapAsync`). | `gpu/core/readback.ts:114,165,198` |
| Compute device registry: one device per realm. `getComputeDevice()` returns the adopted render device if one is alive, else a lazily created sidecar with raised limits. Null means the CPU twin runs. | `gpu/core/device.ts:72,109,202-221` |
| WebGpuEngine calls `adoptRenderDevice(device)`. On the default path, page-realm compute therefore runs on the render device: one queue, shareable buffers and textures. | `deck-webgpu/device.ts:265` |
| WebGL engine: page compute uses the sidecar, and every crossing is CPU arrays. | |
| House rule: every kernel keeps a CPU twin, which is the reference. Pure plumbing migrations must be bit-identical. | `gpu/core/README.md` |
| Flags: `gpu`, `gpuHorizon` and `lookgpu` are on. `unknownGpu` is off (0-false-accept rule). `eyesearch` is off. `tiles3d` is off. `terrain` is `batched`. Sky GPU prep is off (`DEFAULT_GPU_PREP=false`, `sky/index.ts:70`). | `flags/index.ts:50-60` |

### ComputeGraph / kernel catalogue (production, non-bench)

| Group (cachedGraph id) | File | Realm, device | Nodes |
|---|---|---|---|
| `photoprep` (edge + sky) | `gpu/photoprep/index.ts:392,304,455` | page, render dev (or sidecar) | lumab, edge, clear-hist/hist/select ×3 (radix 97th pct), norm, coarse-row1/col1/row2/col2, fine-row/col; sky: scan, clear-sky-counts, sky-hist, sky-table, sky-gather, sky-row, sky-col, sky-cum; `readNode read` |
| `align-pose` | `gpu/align/graph.ts:46-84` | page | clear-out → POSE_GRID or POSE_BOUND → `readNode read` |
| `horizon-march` | `gpu/horizon/graph.ts:88-136` | horizon-fast worker; unknown-pose worker (opt-in); eye worker | clear-stats → march → `readNode read[out,stats]` |
| `horizon-ridges` | `gpu/horizon/ridges.ts:205-231` | ridgelines worker (/roll) | one kernel + read |
| `solve-coarse` | `gpu/solve/graph.ts:179-222` | unknown-pose worker | clear-blocks → coarse → clear-rows → fold → `readNode rows` (or `blocks`) |
| `sky-refine` | `gpu/sky/refine-graph.ts:103-190` | sky worker (ORT's device) | lo-h, lo-v, lo-h2, lo-v2, up-h, up-v, pack, `readNode read` |
| `skyglobal` | `gpu/skyglobal/graph.ts:115,162` | not wired | — |
| `look-haze-prep/grid/compact/gather` | `gpu/look/haze-graph.ts:172,405,480,532` | page | prep, GPUScan offsets, grid, compaction, band gather; several readNodes |
| `look-tex-*` (masksTex, bandStatsTex, hazePrepTex) | `gpu/look/textures.ts:687,1000,1223,1451` | page, render dev (bridge) | gather (texture-in), guided filter H0/V0/H1/V1, pack, copyBufferToTexture; band partials; haze prep |
| guided filter, colour stats (array path) | `gpu/look/guided-filter-graph.ts:83,119`, `color-stats-graph.ts:55,88` | page (sidecar on WebGL) | — |
| relief (+heights) | `gpu/look/relief-graph.ts:139,196,245`, `relief-heights.ts:514` | page | copy tile layers, RELIEF_HEIGHTS gather, shadow (atomic), down, svf, sum, pack |
| **Raw kernels, not graphs** | | | |
| sky prep | `gpu/sky/prep.ts:159-222` | sky worker | prep-unpack/alpha/h/v/norm via dispatchAll (opt-in) |
| geo-query (verdict / skyline / gather) | `deck-webgpu/geo-query-gpu.ts:36-200` | page, render dev | stageReads :200 |
| silhouette mask | `deck-webgpu/silhouette-gpu.ts:~100-184` | page, render dev | stageReads :184 |
| splat sort | `gpu/splat-sort/index.ts:231-286` | page, render dev | depth, key, radix ×2 (tile/scan/scatter); no readback |

---

## 1. Text DAG of the /photo pipeline (default WebGPU engine)

`[M]` = main thread, `[W:x]` = worker x. `G` = GPU, `C` = CPU, `R` = readback, `U` = upload, `★` = CPU decision on a GPU result.

```
UPLOAD (/upload, once)                                   [M] C
  File ─► readExif(exifr) ─► decodeImage(createImageBitmap | heic.worker libheif) ─► canvas rescale ≤2048 ─► JPEG Blob
       ─► buildPhotoMeta ─► IndexedDB ─► fetchRegion(Overpass) ─► navigate /photo/$id

/photo  PhotoWorkspace.tsx:459 engine lifecycle → WebGpuEngine.init (deck-webgpu/engine.ts:1170)
  ├─► [W:horizon-fast] startFastHorizon (integration/horizon-fast-app.ts:127)      ── parallel ──
  │     main: fetchDemBytes ─► worker: decode+validate (C) ─► buildMosaic+mips (C, 10–100s MB)
  │     ─► U mosaics ─► G horizon-march (chunks) ─► R out+stats ─► ★ C f64 atan, WGS84 ENU, 8192-col resample
  │     ─► postMessage dirs Float32Array(8192×3) ─► page          (heightFromTile z14 → setEye first)
  ├─► [M] TerrainStreamer (deck/terrain-stream.ts): selectDemTiles (C f64) ─► fetch ─► [W:dem pool ≤4] WebP decode
  │     + decodeTerrarium (C) ─► [M] validate/crop/downsample (C) ─► buildBatchGrid (C f64) | buildMesh (C f64, tiles mode)
  │     ─► U HeightPool r32float layers + base rows + table (batched-terrain.ts:291,417,437)
  │     loadImagery ─► OffscreenCanvas mosaic (C) ─► U copyExternalImage into imagery array + mips
  ├─► [M] img.decode() ─► U photo texture (textures.ts:52)
  ├─► [M] segmentForeground (segment.ts:214, MediaPipe GPU delegate on its OWN WebGL ctx) ─► fg mask (C array)
  ├─► region JSON ─► peaks/trails (C)
  ├─► photoPixels canvas 512px getImageData (C) ─► U ─► G photoprep graph ─► R ≈3.5 MB (coarse,fine,sky,skyCum)
  │     ★ verify vs CPU (first 3, then 1/32) ─► EdgeMap (CPU arrays)
  └─► horizon dirs (fast) or CPU profile horizon (10 s timeout ★)

POSE (once per photo; or user "refine")
  A. full metadata ─► autoAlignAsync (gpu/align) [M]
       fitPriorSkyGpu: C skylineRows+bandLimits ─► U lim ─► G photoprep "sky" ─► R sky+skyCum (~1.4 MB)
       ─► U coarse/fg/dirs (once), skyCum, poses ─► G align-pose GRID ─► R 10 KB ─► ★ C coarseHypotheses (re-score, top 5)
       ─► loop ~40 rounds: ★ C Descent.speculate ─► U poses ─► G POSE_BOUND ─► R ~6 KB ─► ★ C skip/exact f64 re-score
       ─► silhouette re-rank: G geometry render ×N finalists (384px) ─► G mask kernel ─► R 18 KB/pose ─► ★ C scoreFromMask
       ─► choosePreview (★ conf > 0.2)
     then secondOpinion ─► [W:unknown-pose] (below) ─► verdict may replace the pose
  B. missing heading/gravity/focal ─► resolveUnknownPose (integration/unknown-pose.ts) [M getImageData 800px] ─► [W:unknown-pose]
       detectSkyline (C, ~0.6 s) ─► sceneHorizon: CPU march (default) | G horizon-march (unknownGpu, opt-in)
       ─► per focal seed (≤3) × {local, full360}: U obs/yaws ─► G solve-coarse ─► R rows ≤57 KB
          ─► ★ C selectBounded / certified ε / exact f64 coarseRow re-scores, maybe R blocks ≤60 KB
          ─► C LM (geo/lm.ts, ≤25 it × ≤3 seeds) ─► ★ accept ≥0.5/0.75, tilt gate
          ─► on reject: C refinePose (FFT M=8192, IRLS, RANSAC; all f64)
       ─► ★ C seed ambiguity/de-dup ─► HTTP matcher :/match on reject (server)

PER CAMERA CHANGE / PER FRAME (render device, one submit per frame; hosts/passes.ts)
  geometry pass (rgba32float xyz+range 1024) ─► 4×MSAA colour pass (terrain, trails, sky, splats, tiles3d)
  ─► screen pass CompositeCore (photo ⊕ colour ⊕ geometry ⊕ mask texture) ─► canvas            [per frame]
  query source (90 ms debounce, own 1024 targets, own submit) ─► G geo-query verdict/skyline/gather
       ─► R 4 B/peak + 4 B/column (+20 B/undecided px) ─► ★ C planOcclusion/resolveOcclusion, snapPeaksNear,
       placePeakLabels ─► React onRender ─► layoutLabels (C) ─► PeakLabelsSvg               [per settled pose]
       (fallback / needFull: R full 12.6 MB rgba32f + C unpack)
  look bridge (compute-bridge.ts; same device, separate submits after the render):
       masksTex (G gather + guided filters + pack ─► mask texture; U blend-cut f32 from C range array)  [per fresh geometry]
       bandStatsTex (offscreen colour 256px ─► G ─► R 6.6 KB ─► C f64 finalizeBands ─► uniforms)          [settled, 120 ms timer]
       haze: G hazePrepTex+compact ─► R head/lists/range+pSky ─► ★ C airlightBand ─► G gather ─► R ─► G grid ─► R 22 KB
             ─► C f64 hazeFitTail (4×24×8 evalPhys) ─► uniforms                                         [per pose/eye/fg]
       relief: G relief-heights graph from resident HeightPool ─► 2×1024² rgba8 textures                 [per 30° yaw / sun / tiles]
  sky (style needs P(sky) only): [M] 1024px getImageData/ImageBitmap ─► [W:sky] ORT U²-Net-P (webgpu EP | wasm)
       ─► G sky-refine graph ─► R ~0.8 MB u8 mask ─► [M] setSkyMask ─► U r8 texture                    [once per photo]
  labels contrast: lumaMapFrom 256px getImageData (C)                                              [once per photo]
```

---

## 2. Stage tables

### 2.1 Ingest

| Stage | Entry | Thread | GPU/CPU | In → Out | Cadence |
|---|---|---|---|---|---|
| prepareUpload | `upload/index.ts:65` ← `src/routes/upload.tsx:123`, `roll.import.tsx:164` | M | C | File → UploadDraft | once/photo |
| EXIF | `upload/exif.ts:82` (exifr ×2); `geo/photo-meta.ts:73` only from baseline-ui | M | C | bytes → ExifTags → LocalPhotoMeta (`exif.ts:300`) | once |
| decode | `upload/decode.ts:210`, `:63` createImageBitmap; HEIC `heic.worker.ts:29` | M / W:heic | C (codec, libheif WASM) | Blob → upright JPEG ≤2048 + 360 px thumb | once |
| region | `upload/region.ts:262` | M | C (net) | → RegionData (peaks, water, trails) | once per 0.05° cell |
| photo decode in engine | `deck-webgpu/engine.ts:1197-1200` | M | codec | blob URL → HTMLImageElement | once/photo |

### 2.2 Photoprep (edge map)

| Stage | Entry | Thread | GPU/CPU | In → Out | Cadence |
|---|---|---|---|---|---|
| canvas downscale | `align.ts:68` photoPixels | M | C (Skia defines the bits, kept CPU deliberately) | img → RGBA u8 512×h | once/photo |
| fg resample | `align.ts:82` | M | C | MediaPipe mask → f32 w·h | once |
| edge graph | `gpu/photoprep/index.ts:530` edgeMapGpu → `:392` buildEdgeGraph; called `deck-webgpu/engine.ts:1250` | M | G photoprep (u32 soft-f64, bit-exact) | rgba, fg, lim → coarse, fine, sky f32 w·h; skyCum w·(h+1) | once/photo |
| prior sky refit | `photoprep/index.ts:673` ← `gpu/align/index.ts:212` | M | C skylineRows + bandLimits (`plan.ts:39`, O(w·h)) then G "sky" | → sky, skyCum | per autoAlign |
| (WebGL engine) | `deck/engine.ts:905` buildEdgeMap | M | **C only** | | once |

### 2.3 DEM and imagery

| Stage | Entry | Thread | GPU/CPU | In → Out | Cadence |
|---|---|---|---|---|---|
| tile select | `deck/terrain-data.ts:379`, `terrain-stream.ts:129` | M | C f64 | wedge → TileChoice[] z7–17, 120 km | per ≥2° view change |
| fetch | `dem/load.ts:97` (ancestor fallback loop) | M | net | Mapterhorn WebP 512 | per tile, conc. 10 |
| decode | `dem/load.ts:27` → `worker-pool.ts` → `dem/decode.worker.ts:7` → `dem/image.ts:25` | W:dem (≤4) | codec + C decodeTerrarium | → f32 512² (1 MB) | per tile |
| repair / crop / downsample | `dem/load.ts:134,139`, `terrain-stream.ts:230` | M | C | f32 → f32 | per tile |
| batch grid / mesh | `batched-terrain-grid.ts:60` (default) / `terrain-data.ts:210` buildMesh (tiles mode, 10–25 ms) | M | C f64 | heights → base grid / vertices | per tile |
| upload heights | `deck-webgpu/layers/batched-terrain.ts:291` HeightPool r32float 2d-array; `:417` base; `:437/451` table | M → render dev | U | 1 MB/tile | per fresh tile |
| imagery | `terrain-data.ts:500` loadImagery → `deck-webgpu/imagery.ts:167` copyExternalImage + layerMips | M | C mosaic + U + G mips | ImageBitmap → 512² array layer | per tile |
| camera height | `terrain.ts:95` heightFromTile z14 | M | C | → eye alt | once |
| duplicate DEM consumers | horizon-fast worker `horizon-fast-app.ts:192`; unknown-pose worker `:153`; ridgelines worker; roll terrain `roll/map/roll-terrain.ts:97` | workers / M | C each, own decode | | each re-fetches and re-decodes |
| CPU terrain queries | `terrain-data.ts:105` heightAt, `:127` localMax (81 samples/peak), `:165` raycast | M | C | | per peak / query |

### 2.4 Sky, horizon, solve, align, refine, eye

| Stage | Entry | Thread | GPU/CPU | In → Out | Cadence |
|---|---|---|---|---|---|
| foreground (people) | `segment.ts:214` segmentForeground (MediaPipe, GPU delegate) | M | G on **MediaPipe's own context** + C fallback | img → FgMask | once/photo |
| sky segmentation | `sky/index.ts:258` ← `src/components/PhotoWorkspace.tsx:276-289` (only if `needsPhotoSky`) | M rasterise 1024 (`:192-231`), W:sky `sky.worker.ts:170` | ORT U²-Net-P webgpu EP (512 in) or wasm (384); G sky-refine graph | RGBA → P(sky) lw·lh → u8 mask W·H | once/photo |
| sky prep | `gpu/sky/prep.ts:159` | W:sky | G raw kernels (opt-in, off) | ImageBitmap → ORT input planes | once |
| app horizon | `integration/horizon-fast-app.ts:127` ← `deck-webgpu/engine.ts:1178` | W:horizon-fast | C mosaics + G horizon-march (gpuHorizon on); CPU fallback `horizon-fast/march.ts:378`; final 10 s timeout → CPU profile horizon `engine.ts:2163-2185` | mosaics → 7200 az × (el, dist) → dirs f32 8192×3 | once per photo per eye |
| edge map | §2.2 | | | | |
| autoAlign | `gpu/align/index.ts:~190` ← `deck-webgpu/engine.ts:2811` | M | G align-pose GRID + BOUND; C twin `align.ts:725` | EdgeMap, dirs, prior → AlignResult (≤5 alts) | per load / refine click |
| silhouette re-rank | `deck-webgpu/engine.ts:2877` → `silhouette-gpu.ts` | M | G render 384 px ×N + mask kernel; C score | → re-ranked alts | per autoAlign |
| pins solve | `align.ts` solvePins ← `PhotoWorkspace.tsx:928` | M | C | pins → pose | per pin edit |
| unknown pose / second opinion | `integration/unknown-pose.ts:154` (worker), `resolveUnknownPose`; `unknown-pose.worker.ts:298` | M getImageData 800 (`:201`) → W:unknown-pose | C detectSkyline (`geo/skyline.ts:470`); horizon CPU (default) or G; G solve-coarse; C LM; C refine | photo + prior → pose + verdict | once/photo (+ per runAlign) |
| solve coarse | `geo/solve.ts:222` → `gpu/solve/index.ts:368` | W:unknown-pose | G solve-coarse | obs ≈400, yaw×pitch ≤3601×301 → rows | ≤3 seeds × (local+full) |
| solve fine | `geo/solve.ts:447`, `geo/lm.ts:76` | W:unknown-pose | C f64 | seeds → pose | per solveOnce |
| refine on reject | `geo/pipeline.ts:~120` → `refine/index.ts:121` | W:unknown-pose | C f64 FFT + IRLS + RANSAC | | on reject |
| fused horizon→solve | `gpu/solve/fused.ts` | W:unknown-pose | G march → C atan → resident hz → G coarse | | only with unknownGpu |
| matcher | `matcher-client.ts:290-312` | M → HTTP | server | | on reject |
| eye search | `gpu/eye/client.ts:~55` → `suggest.worker.ts` → `pose6dof/eye.ts:336` | W:eye | C detectSkyline 800 px + C LM; G horizon-march batches (~200 eyes, then 6/iter ×≤12) | → eye shift | per click (flag off) |

### 2.5 Render (WebGPU default; WebGL fallback in brackets)

| Stage | Entry | Device | In → Out | Cadence |
|---|---|---|---|---|
| frame schedule | `deck-webgpu/engine.ts:1080` | M | scope "all" or "screen" | per change |
| geometry pass | `deck-webgpu/hosts/passes.ts:46` | render | terrain → rgba32float xyz+range, normal rgba16f, depth32f (1024) | per "all" frame |
| colour pass | `passes.ts` runColorPass | render | 4× MSAA rgba16f (1× while interacting, `INPUT_IDLE_MS=150`) | per frame |
| screen pass | `layers/composite.ts` CompositeCore / `present.ts` | render | → canvas | per frame |
| host | `hosts/deck.ts` (deck effect) or `hosts/direct.ts` (rAF) | | one encoder, one submit | per frame |
| [WebGL] | `deck/composite.ts:352` PhotoCompositor.preRender; geometry r32f; `deck/geometry-pass.ts` | deck GL2 | same roles | per frame |
| export | `deck-webgpu/engine.ts:3633` exportImage → renderOffscreen → readTexture `:3744-3758` → C putImageData + 2D labels | render | W·H·4 | per export |

### 2.6 Look passes

| Pass | Entry | GPU/CPU | In → Out | Cadence |
|---|---|---|---|---|
| masks | `engine.ts:1680` updateLook → `compute-bridge.ts` updateMasks → `gpu/look/textures.ts:687` masksTex | G (texture-in) + small C cut plane | geometry tex, photo rgba8 512, P(sky)/people r8 → rgba8 mask tex | per fresh geometry / style |
| band stats | `engine.ts:1768` scheduleStats → renderOffscreen 256 → `textures.ts:1000` | G + R 6.6 KB + C f64 fold | → ColorStats uniforms | settled render (harmonize) |
| haze | `engine.ts:1847` fitHaze → bridge.fitHaze → `gpu/look/haze-graph.ts:~796` | G prep/compact/gather/grid + C `airlightBand` (`gpu/look/haze.ts:432`) + C f64 `hazeFitTail` (`haze.ts:484-760`) | → haze params | per pose / eye / fg |
| relief | `engine.ts:1638` → `look/relief/field.ts:331` → `gpu/look/relief-heights.ts` | G from resident heights | → 2× 1024² rgba8 | per 30° yaw / sun / tiles |
| [WebGL look] | `look/composite.ts:176`, `look/haze-controller.ts`, `deck/engine.ts:1273,1413,1512` | readPixels → C arrays → sidecar kernels → R → C pack → createTexture | | same |

### 2.7 Labels and occlusion

| Stage | Entry | GPU/CPU | Cadence |
|---|---|---|---|
| query render | `deck-webgpu/layers/geometry-source.ts:309` (debounce `GEOMETRY_DEBOUNCE_MS=90`, `:62`) | G own targets + submit | per settled pose |
| verdicts / skyline / gather | `deck-webgpu/geo-query-gpu.ts:36,63,81,144,200`; driven by `engine.ts:2374` queryOnDraw ("diet", default on) | G + R small | per settled pose; gather on demand (hover, sampleAtAsync) |
| plan / resolve | `deck/geo-query.ts` planOcclusion / resolveOcclusion / skylineFromRows | C f64 (threshold `range·0.97−50`) | per settled pose |
| snap + place | `deck/scene.ts:101` snapPeaksNear, `:150` placePeakLabels; `engine.ts:2655` peakLabels | C | per onRender emit |
| layout + SVG | `look/labels/layout.ts:461-700`, `PeakLabelsSvg.tsx` | C / DOM | per engine frame (memoised) |
| contrast | `look/labels/contrast.ts:30` lumaMapFrom | C | once/photo |
| [WebGL] | `deck/geometry-pass.ts:445-459` readPixels PBO + `:236-270` C unpack (xyz rebuild); C sampleAt loop | | per settled pose |

### 2.8 Roll, nearfield, tiles3d

| Stage | Entry | Thread / device | GPU/CPU | Cadence |
|---|---|---|---|---|
| roll align | `roll/align/align.ts:132,185` | W:unknown-pose per photo, serial | C cascade (150 s deadline) | per photo |
| roll map | `roll/map/roll-map.ts:208` own Deck | M, **deck WebGL2 only** | G render | per frame |
| range maps | `roll-map.ts:465,523` + `roll/map/range-gpu.ts:255,275` (raw GL2 max-pool) | GL2 | G + R coarse ~4 KB/photo (`:327`), full ~1 MB if clearAir (`roll-map.ts:552`) | per photo |
| drape atlas | `roll/map/drape-atlas.ts:108,197-212` | GL2 | U photo cells + mips | per photo |
| clear air / gains | `roll/map/drape-clear.ts:243` (haze on sidecar via `gpu/look/hooks.ts:45`), `drape-gains.ts:214` | M | C IRLS + Cholesky; G haze | per photo, debounced |
| tile candidates | `roll/map/multi-drape-layer.ts:551,712-787` | M | C cull → slot buffer U | on change |
| ridgelines | `roll/mosaic/viewpointTerrain.ts:52` → `ridgelines.worker.ts:62-120` | W:ridgelines (own device) | C mosaic (~100 MB) + G horizon-ridges + C trace | per viewpoint |
| panorama | `roll/mosaic/panoGL.ts:70,184` | own raw GL2 + Canvas2D | | rAF |
| nearfield service | `nearfield/client.ts:123-243` (:8767) | M → HTTP | server models; C decode | per photo |
| scene build | `nearfield/scene.ts:266-333` (anchor, ground, lift, toEnu) | M, sync | **C only** (tens to hundreds of ms) | per accepted pose |
| near DEM | `nearfield/near-dem.ts:50,131` | M | C ray profiles (CpuGeometrySource) | per pose |
| step masks | `nearfield/deck-step.ts:50` | M | C dilate ×2 | per scene / pose |
| splat pack | `deck-webgpu/layers/splats.ts:538` / `nearfield/deck-splat-layer.ts:108` | M | C → U | per cloud |
| splat sort | WebGPU `gpu/splat-sort/index.ts:231` (render dev, no readback); WebGL `nearfield/splat-sort.worker.ts:25` | M / W:splat-sort | G / C | on ≥1° or 1 m view change |
| tiles3d | `tiles3d/deck-tiles.ts:40`, `tiles.ts:81,208` (3d-tiles-renderer, DRACO workers), `frame.ts:12` C f64, `geoid.ts:51` | M | C selection per stepping frame; U per mesh | flag off |

---

## 3. CPU↔GPU boundaries

### 3.1 Readbacks (default path first)

| # | Site | Bytes | Cadence | Consumer |
|---|---|---|---|---|
| R1 | `gpu/photoprep/index.ts:441` readNode (`:435` variant) | ≈3.5 MB (coarse, fine, sky, skyCum + 32 B) | once/photo | CPU EdgeMap, then **re-uploaded** by align |
| R2 | photoprep "sky" refit | ≈1.4 MB | per autoAlign | align skyCum (re-uploaded each call) |
| R3 | `gpu/align/graph.ts:75` | grid 10 KB; bound ≈6 KB × ~40 rounds | per autoAlign | CPU hypotheses / descent |
| R4 | `deck-webgpu/silhouette-gpu.ts:184` | 18 KB/pose | per autoAlign | CPU scoreFromMask |
| R5 | `deck-webgpu/geo-query-gpu.ts:200` | 4 B/peak + 4 B/col (~4 KB) + 20 B/undecided px | per settled pose / hover | labels |
| R6 | `deck-webgpu/readback.ts:36-37` full geometry (needFull / diet fail) | W·H·16 ≈ 12.6 MB | haze CPU parts, sampleAt, rangeGrid, nearfield | CPU range array |
| R7 | `gpu/look/haze-graph.ts:276,513,553,425`, tail `:697`; `:360` readBack | head ~0.3N·8 + 2.6 KB; range+pSky 2·N·4 (N≈512×384 → ~1.5 MB); grid 22 KB; tail on overflow | per pose / eye / fg | CPU airlightBand + f64 tail |
| R8 | band stats partials (`gpu/look/color-stats-graph.ts:55` / bridge) | 6.6 KB | settled render | f64 fold |
| R9 | `deck-webgpu/compute-bridge.ts:568-569` relief | 2×4 MiB | diagnostics only | — |
| R10 | `gpu/sky/refine-graph.ts:186` | ~0.8 MB | once/photo | mask → main thread → re-upload r8 |
| R11 | `sky/model.ts:255` ORT getData | lw·lh·4 | when ORT is not on the shared device | |
| R12 | `gpu/sky/prep.ts:275,284,293` | 4 B; verify ~2.8 MB+ | once / first 3 | gate |
| R13 | `gpu/horizon/graph.ts:114` (`index.ts:399` decode) | nE·nAz·8 + nE·12 (57.6 KB per eye) | per chunk | f64 atan |
| R14 | `gpu/solve/graph.ts:204,220` | rows ≤57 KB; blocks ≤60 KB | per coarse call | certified selection |
| R15 | `gpu/horizon/ridges.ts:231` | ridge tops | per viewpoint (/roll) | trace |
| R16 | `gpu/skyglobal/*` | — | unwired | |
| R17 | `deck-webgpu/engine.ts:3534,3744-3758` readTexture | W·H·4 (export) / W·H·8 (CPU stats path) | per export / bridge-off | |
| R18 | `deck-webgpu/layers/composite.ts:1188` getImageData of the brush canvas | 2D | per stroke | U brush |
| WebGL | `deck/geometry-pass.ts:435-459,601`; `deck/composite.ts:599-603,846,911,1033`; `deck/silhouette-gl.ts:206-211`; `roll/map/range-gpu.ts:317-327` | readPixels / PBO | | |
| 2D canvas pixel reads (CPU decode duplicated) | `align.ts:78` (512), `sky/index.ts:227` (1024), `integration/unknown-pose.ts:201` (800), `look/labels/contrast.ts:46` (256), `look/composite.ts:118` photoPixels (bridge), `look/haze-controller.ts:213`, `gpu/eye/samples.ts:22`, `dem/image.ts:21` (every DEM tile), `nearfield/scene.ts:394`, `roll/map/drape-clear.ts:199` | | | the same photo is rasterised **at least 5×** at different sizes |

### 3.2 Uploads

| Site | What | Cadence |
|---|---|---|
| `gpu/photoprep/index.ts:239,465` | rgba, fg, lim, dims (≈1.4 MB) | once/photo |
| `gpu/align/pose-grid.ts:~165-178`, `pose-bound.ts:216-240` | coarse, fine, fg, dirs (once); skyCum (per call); poses (per round) | per autoAlign |
| `gpu/horizon/index.ts:161-163`, `graph.ts:141-144` | mosaic pages (tens to hundreds of MB), per-chunk params | per photo per worker |
| `gpu/solve/graph.ts:150,288-300` | hz 28.8 KB resident; obs, yaws, uniforms | per coarse call |
| `gpu/sky/prep.ts:204-222` | copyExternalImageToTexture W·H·4 | once (opt-in) |
| `gpu/sky/refine-graph.ts:~232-260` | gl, gp, rgba (CPU if no GPU prep), lut | once/photo |
| `deck-webgpu/textures.ts:52`; `layers/composite.ts:~1137-1200` | photo (mipped), brush, people/occluder masks | once / per stroke |
| `deck-webgpu/imagery.ts:167` | imagery 512² layers | per tile |
| `deck-webgpu/layers/batched-terrain.ts:291,417,437,451` | heights r32f, base, table | per tile |
| `deck-webgpu/terrain.ts:351-420` | tiles-mode meshes (~2.4 MB/tile) | per tile (non-default) |
| `deck-webgpu/compute-bridge.ts:486` | photo rgba8 per grid (from canvas), r8 masks, blend-cut f32 | per (photo, grid) / per mask change / per update |
| `deck-webgpu/layers/terrain-styles.ts:915,1029` | relief (CPU path), terroir cover | per change |
| trails / splats / tiles3d / multi-drape | `layers/trail.ts:230`, `splats.ts:538-548,624,729`, `tiles3d.ts:675-717,835`, `multi-drape.ts:785-864` | per data change |
| `gpu/core/pool.ts` pooledStorage / pooledUniform | generic (haze-graph 18 sites, skyglobal, sky-refine, solve, relief) | per run |
| roll | `roll/map/drape-atlas.ts:179-219,287`, `drape-clear.ts:132,352`, `multi-drape-layer.ts:834`, `roll/mosaic/panoGL.ts:117,165` | per photo / per change |

### 3.3 CPU decisions between GPU stages (graph breakers)

| # | Site | Decision | Fusable? |
|---|---|---|---|
| D1 | `gpu/photoprep/index.ts:590-635`, `shouldVerify :224`, `checkReadback :478` | gates, nonce echo, random CPU verify → disable GPU | debug only; can move out-of-band |
| D2 | `photoprep plan.ts:39` bandLimits + `align` skylineRows | CPU limits before the sky graph | yes: per-column scan → kernel |
| D3 | `align.ts:651-703` coarseHypotheses | re-score near-best cells, per-column argmax, NMS ≥2°, top 5 | yes: segmented argmax + NMS kernels; exact f64 re-score is the obstacle |
| D4 | `align.ts:776-860` autoAlignRefined + `gpu/align/index.ts:136-165` | ~40 rounds of speculate → bound → skip/exact; SkipVerifier; RefineBoundViolation | **hard**: data-dependent loop; could become a fixed-round GPU loop with indirect dispatch |
| D5 | `deck-webgpu/engine.ts:2877-2941` silhouette | per-pose CPU score + nonce re-read | yes: score in kernel against resident edge.coarse |
| D6 | choosePreview (`PhotoWorkspace.tsx:614`) conf > 0.2 | app policy | stays CPU (tiny) |
| D7 | `gpu/horizon/index.ts:326-366,399-466` | f64 segments, az sin/cos, Mercator split; atan → elevation f64; iteration-cap throw | needs df64 or accepting f32 (breaks bit-identity) |
| D8 | `horizon-fast-app.worker.ts:149-215` | WGS84 ENU per sample, 8192-column resample | same as D7 |
| D9 | `gpu/solve/graph.ts:316-339`, `solve/index.ts:104,250` | NaN fallback, threshold-flagged rows → blocks re-run, certified ε, exact f64 coarseRow | partly (indirect re-run); f64 exactness is the blocker |
| D10 | `geo/solve.ts:416-502` | top-3 seeds, LM ≤25, accept thresholds, full-360 fallback | LM on GPU is possible (4 params, 400 obs) but control flow is CPU-shaped |
| D11 | `geo/pipeline.ts:~120`, `refine/*` | escalate → FFT/IRLS/RANSAC (f64) | GPU FFT exists in gpgpu (GPUFFT1D) but f64 |
| D12 | `unknown-pose.worker.ts:250-296` | seed ambiguity, dedup, accept | CPU policy |
| D13 | `pose6dof/eye.ts:476-557` | grid argmin, eye LM, minGain | batched GPU; loop CPU |
| D14 | `sky.worker.ts:240-290`, `sky/prep.ts` prepGate | model / EP / refine device / verify | ORT owns dispatch |
| D15 | `deck/geo-query.ts` planOcclusion / resolveOcclusion | CPU projection + undecided → gather | yes: projection in-kernel; f64 projection is the obstacle |
| D16 | `gpu/look/haze.ts:432` airlightBand; `:484-760` hazeFitTail | sky pixel select; f64 coordinate descent 4×24×8 | biggest per-pose CPU stage; candidate for f32 GPU (needs a parity decision) |
| D17 | band stats f64 fold | 6.6 KB | trivial GPU reduce if f32 is accepted |
| D18 | haze head size adaptive (0.27N+512 then 1.5× last) + overflow second round trip | | indirect dispatch |
| D19 | `geometry-source.ts:454-551` debounce / generations / renderSeq pairing | scheduling, not data | belongs in the graph scheduler |
| D20 | `deck-webgpu/layers/splats.ts:552-613` sort fallback | one-way | n/a |
| D21 | roll: `range-gpu.ts:105` GPU/CPU path; `multi-drape-layer.ts:712-781` cull vs coarse grid; `drape-gains.ts` IRLS | | cull fusable once on WebGPU |
| D22 | `terrain-stream.ts` emit / evict / stand-ins; `dem/load.ts` ancestor loop | data management | stays CPU (loader side) |

### 3.4 Device and realm crossings

| Realm | Device | Owns | Crossing |
|---|---|---|---|
| page | WebGPU render device (adopted for compute) | render, photoprep, align, silhouette, geo-query, look bridge, relief, splat sort | — |
| page (WebGL engine) | deck WebGL2 + WebGPU sidecar | all of the above split; CPU arrays between | readPixels → upload |
| page | MediaPipe's own GL context | foreground segmentation | CPU mask |
| page /roll | own Deck WebGL2 + raw GL2 programs + PanoGL GL2 + sidecar (haze) | roll map | CPU |
| W:horizon-fast | own WebGPU device (terminated after the march) | horizon-march | dirs Float32Array via postMessage |
| W:unknown-pose | own device, `releaseWhenIdle` (`unknown-pose.worker.ts:44`) | solve-coarse (+ horizon if unknownGpu) | pose via postMessage |
| W:sky | own device, shared with ORT's webgpu EP if the shim works, else ORT's device | ORT + sky-refine | u8 mask via postMessage |
| W:eye | own device during a search | horizon-march batches | result |
| W:ridgelines | own device | horizon-ridges | typed arrays |
| W:dem pool, W:heic, W:splat-sort, W:terrain-tile (lab only) | none | decode / sort | transfer |

`device.ts` header: a typical /photo load uses page + horizon-fast + unknown-pose (+ eye, + ORT) = **3–5 devices, no shared buffers**. The DEM is fetched and decoded independently in at least 3 realms (page streamer, horizon-fast worker, unknown-pose worker).

---

## 4. Heavy numeric CPU code on hot paths with no GPU twin

| Code | Site | Cost (est.) | Cadence |
|---|---|---|---|
| haze f64 tail | `gpu/look/haze.ts:484-760` (+ `airlightBand :432`) | largest per-pose CPU stage | per pose / eye |
| detectSkyline | `geo/skyline.ts:470` | ~0.6 s @640 px | per photo (unknown-pose, eye) |
| mosaic build + mips | `horizon-fast/mosaic.ts:397,671`; `scene-profile.ts` mosaicsFromSampler; ridgelines worker | tens to hundreds of ms, up to ~100 MB | per photo per worker |
| CPU horizon march (unknown-pose default) | `horizon-fast/march.ts:378` | 0.3–1 s+ | per photo |
| LM fine solve | `geo/solve.ts:447`, `geo/lm.ts:76` | few to ~10 ms | per seed |
| refinePose FFT/IRLS/RANSAC | `refine/init.ts:191`, `refine/robust.ts:120,542,681,777` | tens to hundreds of ms ×3 seeds | on reject |
| align exact re-scores / Descent | `align.ts:651-860` | ~40 rounds | per autoAlign |
| eye fitRotationToHorizon + LM | `pose6dof/eye.ts:114,493-557` | tens of ms per batch | per search |
| DEM decode + validate + crop | `dem/decode.ts:13,86-190`, `dem/grid.ts:28` | 1–10 ms/tile (worker) | per tile |
| buildMesh / buildBatchGrid / interleave | `deck/terrain-data.ts:210`, `batched-terrain-grid.ts:60`, `deck-webgpu/terrain.ts:371` | 1–25 ms/tile **main thread** | per tile |
| peak snap localMax | `deck/terrain-data.ts:127`, `deck/scene.ts:101` | 81 heightAt/peak | per peak (cached) |
| label layout | `look/labels/layout.ts:461-700`, `classic.ts` | per emit | per frame (memoised) |
| full-geometry unpack | `deck-webgpu/layers/geometry-source.ts:~370`; WebGL `deck/geometry-pass.ts:236-270` | 1024×768 loop | per needFull / every WebGL readback |
| noise sigma, band inputs (CPU path) | `look/color-stats.ts:94-213` | | once / bridge-off |
| nearfield scene build | `nearfield/scene.ts:266-333`, `anchor.ts:166-470`, `ground.ts`, `lift.ts:52` | tens to hundreds of ms main thread | per accepted pose |
| stepMasks dilate, near-DEM profiles | `nearfield/deck-step.ts:24,50`, `near-dem.ts:131` | W·H·(2r+1)² ×2 | per pose |
| splat pack | `layers/splats.ts:538` | O(n) | per cloud |
| roll gains / cull | `roll/map/drape-gains.ts:86,214`, `multi-drape-layer.ts:787` | | per change |
| tiles3d selection + float conversion | `tiles3d/tiles.ts:208`, `deck-layer.ts floats()` | | per stepping frame |
| CpuGeometrySource ray march | `deck/cpu-geometry.ts` | ~10 ms/pose | fallback only |
| photo rasterisations | see the 2D-canvas row in §3.1 | few ms each | 5+ per photo |

---

## 5. Proposed graph islands

Each island is a unit that could plausibly become one compiled `ComputeGraph` (or render+compute graph) with a single submit and at most one readback.

| Island | Contents | Cadence | Realm today | Natural home |
|---|---|---|---|---|
| **I0 Loaders** (not a graph) | upload decode/EXIF, region fetch, DEM fetch + WebP decode, imagery fetch, 3D-tiles fetch / DRACO, nearfield service, matcher | per photo / per tile | M + decode workers | loaders.gl-style loaders that emit GPU-ready payloads (ImageBitmap → copyExternalImage; DEM bytes → r32f layer) |
| **I1 Terrain residency** | HeightPool r32f array + imagery array + mips + batch grid table; the relief-heights graph builds from it | per tile | page render dev | already GPU-resident; move buildBatchGrid min/max + terrarium decode to a kernel (decode the WebP via ImageBitmap → texture → a "terrarium→height" kernel) |
| **I2 Photo prep** | photo texture → luma/edge/radix-select/blur/sky-fit (photoprep) + masks inputs (512 grid) + lumaMap + sky-model input planes | once/photo | page (photoprep), W:sky (sky prep), plus 5 CPU canvas reads | one graph from a single photo texture; outputs stay resident (EdgeMap planes as buffers) |
| **I3 Horizon** | mosaic build + horizon-march + atan/ENU resample → dirs | once per photo per eye | W:horizon-fast (+ W:unknown-pose, W:eye) | could read I1's resident HeightPool instead of CPU mosaics, if moved to the page device |
| **I4 Align** | prior sky fit → POSE_GRID → hypotheses → POSE_BOUND rounds → silhouette renders + mask score | per autoAlign | page | one graph per round, or a GPU-driven loop with indirect dispatch; consumes I2 + I3 resident |
| **I5 Unknown-pose solve** | skyline detect → horizon → solve-coarse → LM → refine | once/photo | W:unknown-pose | separate island (worker) unless the worker is folded into the page device |
| **I6 Sky model** | ORT U²-Net + sky-refine | once/photo | W:sky (ORT device) | external (ORT owns dispatch); output should be a texture on the render device |
| **I7 Frame** | geometry → colour → composite (already one encoder, one submit) | per frame | page render dev | already an island |
| **I8 Queries** | query geometry render + geo-query verdict/skyline/gather + silhouette (shared targets) | per settled pose | page | append to I7's encoder on settle frames instead of a separate submit |
| **I9 Look** | masksTex, bandStatsTex, haze prep/compact/gather/grid, relief | per settled pose / style | page (bridge) | one graph per settle, after I8; the haze tail is the break |
| **I10 Labels** | plan/resolve occlusion, snap, place, layout, SVG | per emit | M, C | CPU/DOM by nature; feed from I8's small readback |
| **I11 Nearfield** | splat pack + GPU sort + draw; scene build is CPU | per pose / per view | page | sort already GPU; scene build is a CPU island |
| **I12 Roll** | range maps, drape atlas, cull, gains, panorama | per photo / per frame | page, **WebGL2 only** + W:ridgelines | needs a WebGPU port first |

### What blocks fusing neighbouring islands

| Seam | Blocker | Kind |
|---|---|---|
| I0 → I1 | WebP / JPEG decode is browser-codec; DEM terrarium decode happens on CPU in workers; imagery mosaics are built in OffscreenCanvas | realm + codec (copyExternalImage of an ImageBitmap removes most of it) |
| I0/I2 photo rasterisation | Skia `drawImage` downscale defines the bits for photoprep, look masks and sky (the bit-identity rule); 5+ separate canvas reads | **parity policy**, not technology: a GPU box/mip filter ≠ drawImage |
| I2 → I4 | R1: photoprep planes read back (3.5 MB), then re-uploaded by align; D1 verify | removable (same device on the default path): keep the planes resident, verify out-of-band |
| I2 ↔ I6 | sky runs in a worker on ORT's device; refine reads back and posts a u8 mask; prep is off | **device/realm** (ORT webgpu EP cannot take an external luma device on the page without the shim, and it runs off-thread); also texture vs buffer (ORT IO is buffers) |
| I1 → I3 | the horizon worker owns a separate device and builds CPU mosaics from separately decoded DEM bytes | **device/realm**; plus the mosaic format (max-mips pages) ≠ the HeightPool layout |
| I3 → I4 | dirs need f64 atan, WGS84 ENU and 8192-column resampling on the CPU (D7, D8); postMessage | **f64** + realm |
| I4 internal | ~40 data-dependent rounds (D4), CPU coarseHypotheses (D3), exact f64 re-scores, SkipVerifier | **CPU control flow + f64 exactness** |
| I4 → I7 | silhouette re-rank renders through the render pipeline (geometry pass at 384 px per pose) then scores on CPU (D5) | texture (render target) → buffer kernel → CPU; fusable |
| I5 → I4/I7 | separate worker device; LM/refine f64; app-level accept policy; matcher HTTP | **realm + f64 + CPU policy** |
| I7 → I8 | query geometry has its own targets and its own submit (90 ms debounce, renderSeq pairing) | scheduling only; could share the encoder |
| I8 → I10 | label projection f64 (D15), React | CPU by design; only small reads |
| I8 → I9 | haze needs the CPU range array (needFull, R6, 12.6 MB) for airlightBand / pointAt ENU | **f64 + CPU control flow** (D16, D18) |
| I9 internal | haze: GPU → CPU airlightBand → GPU → CPU f64 tail → GPU grid → CPU refinement; band stats f64 fold | **f64** (deliberate CPU exactness); adaptive head size → indirect dispatch |
| I9 → I7 | look outputs feed the composite as textures / uniforms; masks already GPU-resident; haze/stats come back as uniforms through the CPU | uniforms via the CPU; could be storage-buffer-fed |
| ComputeGraph itself | `addKernel` is buffer-only; texture kernels go through a helper (`textures.ts:316`); render passes are not graph nodes; `condition` is CPU-evaluated; compiled graphs have fixed transient sizes (shape-keyed cache) | **texture vs buffer + no render nodes + static shapes** |
| WebGL fallback | every crossing is CPU arrays (sidecar ≠ GL device) | must stay a CPU-island path, or the single-graph design is WebGPU-only |
| Roll (I12) | deck WebGL2 + raw GL2 programs | device (needs a WebGPU port) |
| MediaPipe foreground | its own GL context | device (external, like ORT) |
| Bit-identity house rule | every GPU stage must equal its CPU twin bit for bit (photoprep soft-f64 in u32, horizon hz bits, certified bounds) | **policy**: fusion that changes reduction order or precision breaks it; needs per-island parity decisions |

### Suggested ordering (cheapest fusions first)

1. **Keep photoprep planes resident and feed align directly.** This removes R1/R2 (~5 MB) and the re-upload, on one device. Verification would move out-of-band.
2. **Do the I7+I8+I9 settle frame in one encoder.** Query render, verdicts, masks and band stats run in one submit. Readbacks would be only the small label buffers and stats partials.
3. **Do the silhouette score in a kernel.** This removes the per-pose CPU scoring (D5).
4. **Single-source the photo rasterisation.** Use one photo texture plus a GPU downscale ladder. Under the current parity rule this needs an explicit decision to re-baseline the CPU twins on GPU-produced pixels.
5. **Bring the horizon onto the page device over the resident HeightPool.** This collapses the horizon-fast worker device and its duplicate DEM decode. It needs f32 or df64 for atan/ENU (a parity decision).
6. **Haze f64 tail and align descent rounds.** These are the deepest CPU loops. Leave them as explicit graph breaks (one readback each) until there is a precision policy.
7. **Leave as separate islands:** ORT sky, MediaPipe, the unknown-pose worker (f64 LM/refine, policy), and roll on WebGL.
