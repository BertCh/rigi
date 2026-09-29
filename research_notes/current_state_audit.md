# mt-image: current-state technical audit

Snapshot taken 2026-09-24, about 22:45 local time. The audit was read-only. Other sessions were editing `src/lib/engine.ts`, `align.ts`, `terrain.ts`, `materials.ts`, `components/PhotoWorkspace.tsx` and `data/control-points.json` while it ran, so line numbers in those files may be off by a few tens of lines. Function names are given for each reference. `npx tsc --noEmit` and `npx biome lint src` are both clean.

Measurements were run in the scratchpad or against the running dev server at `:3100`. Nothing was written to `out/` or `public/`.

- Node timing and sensitivity script: `scratchpad/timing.mts`
- Browser engine timing: `scratchpad/engine-timing.mjs`
- Mapterhorn ground spot-check: `scratchpad/mh.mts`
- `node scripts/eval-app.mjs`, which only prints

---

## 0. Architecture at a glance: three parallel stacks

| | **Engine** (`/photo/$id`) | **Baseline** (`/baseline` plus `scripts/*`) | **deck.gl** (`/deck`) |
|---|---|---|---|
| Code | `lib/engine.ts`, `align.ts`, `terrain.ts`, `materials.ts`, `pose.ts`, `geodesy.ts`, `segment.ts` | `lib/geo/*`, `baseline-ui/*`, `scripts/lib/*` | `lib/deck/*`, `routes/deck.tsx` |
| DEM | **Mapterhorn** 512 px WebP (swissALTI3D in CH), quadtree z7–14, 120 km radius (`terrain.ts:7`, `load` ~l.210) | **AWS Terrarium** 256 px PNG at z13 (≤4 km), z11 (≤40 km) and z10 (≤150 km) (`geo/terrain.ts:5,131`) | **AWS Terrarium** 256 px, z7–12 (`deck/terrain-data.ts:5,291`) |
| Horizon | GPU: 8 float renders at 50° hfov, 1024×1536, topmost pixel per column (`engine.computeHorizon` ~l.417) | CPU ray-march: 7200 azimuths × ~1300 range samples (`geo/horizon.ts:36`) | none (CPU raycast range map only, `deck/scene.ts:50`) |
| Pose parameterisation | `Pose{yaw,pitch,roll,vfov}` (`pose.ts`) | `Camera{f,east,north,up}` (`geo/camera.ts`) | `Pose` |
| Sky / skyline | Colour histogram P(sky) plus an edge map; no explicit skyline (`align.ts buildEdgeMap/fitSkyModel/scanLabels`) | Polynomial sky field plus Viterbi skyline (`geo/skyline.ts`) | none |
| Auto-align | Dense score along the projected DEM skyline; grid, then coordinate descent, then inner-silhouette re-rank (`align.ts autoAlign`, `engine.autoAlign/silhouetteScore`) | Grid over detected skyline rows, then Cauchy LM (`geo/solve.ts`) | none |
| Manual / control points | `align.ts solvePins` (LM, own code) | `geo/control-points.ts` (LM via `geo/lm.ts`, supports level points) plus a UI fallback LM (`baseline-ui/control-points.ts`) | drag only |
| Eye height | `alt` if within 30 m of the DEM, else DEM + 1.8 (`engine.ts` init ~l.326) | `max(GPS alt, DEM + 1.6)` (`pipeline-node.ts:43`, `baseline.ts:133`, `pipeline.worker.ts:218`, `annotate-lib.ts:74`) | DEM + 2 (`deck.tsx:144`) |
| Threading | Everything on the main thread | Web Worker (browser) or Node | Main thread (chunked) |

The geodesy is consistent across all three stacks. ECEF→ENU carries the true curvature, and `+k·d²/2R` lifts by refraction (`geodesy.ts:60`). This matches the `d²/2R_eff` drop with `R_eff = R/(1−k)`, k = 0.13, used in `geo/horizon.ts:47,70` and `geo/peaks.ts:104`. The EXIF priors agree: yaw, pitch, roll and FOV from `ingest.mjs orientationFromGravity` and from `geo/camera.ts gravityInDisplayFrame` match to 0.01° on all 13 photos.

Beyond that, almost every component exists two to four times, and the copies use **different DEMs and different eye-height rules**. That is the single largest structural problem (see D1 and D2).

---

## A. Analysis and algorithms

### A1. Prior

- **Gravity → pitch/roll.** `ingest.mjs:89 orientationFromGravity` chooses a holding orientation from gravity and aspect ratio, not from the EXIF Orientation tag. That is the recommended approach. `geo/camera.ts:45 gravityInDisplayFrame` uses a per-Orientation switch. Both give identical numbers on this set, including the portrait shots (IMG_7068 and IMG_7108).
- **Heading** is `GPSImgDirection`. `GPSImgDirectionRef` is ignored in `ingest.mjs:203` and `geo/camera.ts:102 cameraFromMeta`. The baseline UI only *displays* "(magnetic)" (`BaselinePage.tsx:580`). The iPhone writes T in practice, but an M photo would be about 3° off in Switzerland, uncorrected.
- **Focal length** is the diagonal 35 mm-equivalent: `f_px = f35·diag/43.27` (`ingest.mjs:187`, `geo/camera.ts:67`). Correct. However, `FocalLengthIn35mmFormat` is an integer, so f carries up to about ±2% quantisation. The 13 mm ultra-wide (IMG_7059, hfov 106°) uses a pure pinhole model with **no distortion terms anywhere**.
- **Position**: GPS latitude and longitude are held fixed everywhere. `hAccuracy` (7–70 m on this set) is used only to set the engine's `nearFade` default (`PhotoWorkspace.tsx:22`). No stack models position uncertainty.

### A2. Horizon computation

**Engine** (`engine.computeHorizon` ~l.417–455):

- Eight perspective renders (yaw 0–315° in 45° steps, 50° hfov, about 70° vfov) into a 1024×1536 `FloatType` target.
- Each render is read back synchronously, then scanned per column for the topmost covered pixel. That gives 8192 unit directions.
- Angular resolution is about 0.049°/px horizontally and 0.046°/px vertically, about 1.3 px at the 26 mm focal length on the 2048-px images.
- The ±35° vertical window means a skyline above +35° elevation is clipped. The `y < H−1` guard drops the direction instead of recording it.
- It measured **80–110 ms** in headless Chrome with Metal.

The horizon is only as good as the meshes (`terrain.ts buildMesh` ~l.270):

- Vertices are **bilinear point samples** at `seg` = 96/128/256 per tile (`sampleGrid`, l.126 and l.286).
- A z10 tile (26.8 km, 52 m/px source) is meshed at about 210 m spacing, a z11 tile at about 105 m.
- Summits between vertices are cut, so skylines from roughly 10–60 km are biased low. The bias is small (about 0.5–2 px at f ≈ 1540 px) but systematic.
- LOD is distance-only (`selectTiles`, lod = 2), not screen-space-error-driven.
- **New:** tiles are loaded only inside a yaw wedge of ±(hfov/2 + 32°) (`Terrain.load` with `wedge`, engine init ~l.311). The 360° horizon is therefore wrong outside the wedge. See D6.

**Baseline** (`geo/horizon.ts:36`):

- For each of 7200 azimuths it marches `destination()` great-circle points from 20 m to 150 km.
- The step is `max(10 m, 0.4%·d)`, so about 160 m at 40 km.
- Each point takes a bilinear sample at the level for that distance (`TERRAIN_LEVELS`, `geo/terrain.ts:131`).
- It also records inner "ridge crests" when terrain re-emerges above the running maximum (`minOcclusion` 8%).
- It measured **3.5–4.5 s per photo** in Node (table in B6), with trig in the innermost loop.
- Coarse levels (z11 at about 50 m/px out to 40 km) smooth summits. The GT script already uses finer levels (`annotate-lib.ts:49 GT_TERRAIN_LEVELS`).

I measured the effect of those finer levels. Projecting both horizons with the prior camera at 800 px width, the mean |Δrow| is **0.02–0.33 px** and the maximum is **0.7–3.8 px**. So DEM *resolution* at z11 vs z12 is minor. The DEM *source* and the eye height are not (A3).

### A3. Eye height and DEM source: the dominant error on the summit photos

I measured this. The Niederhorn photos IMG_7053–7086 are on a cliff edge. At the GPS fix, the three sources give these ground heights:

| photo | GPS alt | AWS Terrarium ground | Mapterhorn z14 ground | Mapterhorn min/max within ±40 m |
|---|---|---|---|---|
| IMG_7053 | 1924.0 | 1887.7 | 1934.5 | 1874 / 1944 |
| IMG_7059 | 1932.7 | 1863.3 | 1945.0 | 1878 / 1952 |
| IMG_7063 | 1928.3 | 1859.3 | 1945.8 | 1872 / 1952 |
| IMG_7068 | 1942.2 | 1903.3 | 1947.6 | 1892 / 1952 |
| IMG_7086 | 1936.7 | 1922.9 | 1943.6 | 1926 / 1958 |

- AWS Terrarium is **40–85 m too low** at these sites. The baseline therefore thinks the camera is 36–69 m above ground (`summary.json` eye − demGround).
- The engine's 30 m rule instead snaps the eye to Mapterhorn + 1.5 m.
- Holding the prior pose fixed, switching the baseline eye from `max(GPS, DEM+1.6)` to DEM+1.6 moves the projected skyline by **50.7 px (IMG_7059) and 116 px (IMG_7063)** mean at 800 px width. It moves 11 px on IMG_7068, 4 px on IMG_7130 and ≤1.6 px elsewhere.
- **IMG_7059, 7063 and 7068 are exactly the three photos the baseline rejects as low-confidence.** The near-field skyline is wrong, not the detector.
- The GPS uncertainty disk (±37 m on IMG_7059) spans about 80 m of relief at a cliff edge. So "snap to DEM at the GPS point" is itself fragile.

### A4. Sky and skyline extraction

**Engine** (`align.ts buildEdgeMap` l.47, `scanLabels` l.108, `fitSkyModel`):

- The work is done at 512 px width.
- The edge map combines luminance and "blueness" vertical gradients. Positive sky-above-darker-below edges are favoured; the reverse polarity gets weight 0.35. It is normalised by the 97th percentile, then box-blurred to coarse and fine versions.
- P(sky) comes from a 12³ RGB histogram ratio with class-proportional pseudo-counts.
- The seed labels come from a scanline heuristic: the first strong colour change from the top (`diff>40`). Above it is sky; a band below it is terrain, but only if it is within 10% of the prior-pose skyline. The bottom 20% is always terrain.
- The model is refitted from `skylineRows(prior)` (l.345). Note that "Refine" passes `this.pose` as `prior` (`engine.autoAlign(false)`), so Refine learns from the current, possibly wrong, pose.
- No explicit skyline is produced.

**Baseline** (`geo/skyline.ts detectSkyline` l.474), at 800 px:

- Features: 3×3 denoise, texture (blurred gradient), and a signed vertical colour step over 3 rows and 5 columns.
- A heuristic sky prior (blue & bright, or bright & grey & smooth), with green suppressed.
- A robust IRLS quadratic/cubic colour field for the sky (`fitSkyModel` l.276, 8-term basis, Cauchy).
- A per-pixel sky likelihood that accepts brighter/greyer pixels as cloud and rejects darker/more saturated ones as haze-covered terrain (`modelSky` l.331).
- **Viterbi** over rows with a truncated-L1 transition, done as an O(h) distance transform (l.382), then one refit and a second Viterbi pass.
- A sub-pixel parabola, per-column weights (contrast × polarity × sky-above × terrain-below), and run/spike suppression.
- It measured 113–321 ms at 800 px.

Failure modes, ranked by expected frequency in Alpine phone photos:

1. **Snow or bright rock against a white or overcast sky.** The cloud rule (`modelSky` l.364–367; the heuristic at l.210) treats bright, grey, smooth pixels as sky, so snowy summits fall into the sky. The same happens in the engine's colour histogram when snow and cloud share bins.
2. **Foreground above the skyline** (trees, buildings, poles, cable cars, fences). Only *people* are masked (`segment.ts`). The baseline returns NaN where a column has no sky at the top (l.516). The engine scores whatever edge the DEM line crosses.
3. **Blue haze on distant ridges.** Handled by the "darker than extrapolated sky" rule in the baseline. The engine's 12-bin histogram cannot separate them.
4. **Sunset or warm skies.** `green = g−b > 0` suppression (`skyline.ts:214,368`) kills orange skies, and the blueness edge term in `align.ts:82` is meaningless there.
5. **Clouds covering peaks.** Both methods pick the cloud edge. The baseline down-weights spikes (l.565–589). The engine relies on the P(sky) contrast.
6. **Only the outer skyline is used.** Inner silhouettes are ignored by the baseline. The engine now adds `silhouetteScore` as a re-ranker only (see A5).

### A5. Alignment and scoring

**Engine** (`align.ts autoAlign` l.279; `engine.autoAlign` ~l.815):

- **Objective:** the mean over projected horizon directions of `0.5·edge + (P̄sky above − P̄sky below)`, times `(1−fg)`, times a coverage factor (`scorePose` l.251). A quadratic prior penalty is subtracted: `0.04(Δyaw/20)² + 0.08(Δpitch/2.5)² + 0.08(Δroll/4)² + 0.1(Δvfov/8%)²` (l.280).
- The coverage factor uses `vfov·aspect` as hfov (approximate) and divides by all 360° directions.
- **Search:**
  - A 101 (yaw ±25° at 0.5°) × 25 (pitch ±6° at 0.5°) grid on the coarse map, stride 3.
  - Up to 5 local maxima at least 2° apart.
  - Coordinate descent (±step per axis, halving, 60 iterations) on yaw, pitch, roll and vfov, first coarse then fine.
  - Then a re-rank by `score + 0.5·silhouetteScore`. That term is the mean coarse-edge strength along rendered inner silhouettes, which costs one 384-px float render plus a synchronous readback per hypothesis.
- **Confidence:** `clamp(4·margin)·clamp(2.5·score)`, where margin is the relative score gap to the best hypothesis more than 1.5° away. The UI accepts above 0.2 (`PhotoWorkspace.tsx:93`). This is heuristic and uncalibrated.
- **Weaknesses:**
  - The roll and pitch priors are weak relative to the score scale. IMG_6958 auto-aligns with a **roll error of −3.2°** against GT, leaving 25 px error, even though the gravity prior was within 0.4°.
  - Coordinate descent on a noisy score cannot recover coupled yaw/roll or pitch/vfov.
  - Nothing is solved in f and pitch jointly with a Jacobian.

**Baseline** (`geo/solve.ts solvePose` l.160):

- **Observations:** detected skyline columns with weight > 0.05.
- **Coarse stage:** a small-angle grid, yaw ±25° and pitch ±3° at 1.5 px steps. The cost is a weighted truncated L1 of the elevation residual, capped at 12 px, plus priors. Up to 3 seeds.
- **Fine stage:** `geo/lm.ts` LM on [yaw, pitch, roll, log f]. The loss is Cauchy with scale 4 px, applied to *sqrt(w)-scaled* residuals, so low-weight columns effectively get a larger scale. Gaussian priors σ = (15°, 1.5°, 1.5°, 6%) are scaled by √Σw. log f is clamped to ±0.15.
- Residuals are *vertical* (elevation) only. On steep skyline flanks this over-penalises small yaw errors; a normal-distance or chamfer residual would be better.
- **Confidence:** the product of inlier fraction, coverage, (1 − ambiguity) and horizon relief, zeroed by a 3° tilt gate. Accepted at ≥ 0.5. This is well designed in structure, but also uncalibrated.

**Cross-check against control-point GT** (from `eval-app.mjs`, run by me; GT solved in the engine on Mapterhorn):

| photo | GT Δyaw vs prior | baseline Δyaw (accepted?) | baseline error | engine auto Δyaw error | engine auto px err @1600 |
|---|---|---|---|---|---|
| IMG_6958 | −2.97 | −2.87 (yes, 1.00) | +0.10 | −0.04 | 25.3 (roll −3.2°) |
| IMG_6971 | +9.10 | +9.59 (yes, 0.51) | +0.49 | +0.20 | 8.5 |
| IMG_7018 | −8.30 | −8.05 (yes, 0.77) | +0.25 | −0.33 | 8.9 |
| IMG_7033 | −0.69 | −0.67 (yes, 0.98) | +0.02 | +0.16 | 5.9 |
| IMG_7053 | +4.75 | +4.66 (yes, 0.83) | −0.09 | +0.23 | 6.8 |
| IMG_7063 | −5.22 (GT solve degenerate, residual ∞) | +0.51 (rejected, 0.48) | ? | 5.75 (unreliable) | ∞ |
| IMG_7068 | −1.50 | −0.48 (rejected, 0.38) | +1.02 | −0.22 | 4.0 |

The compass prior is off by 0.7–9.1° (median about 4.75°). Both automatic solvers fix yaw to ≤0.5° when they accept. The baseline's rejections are correct: 7068 is 1° off, and 7063 is unresolved.

### A6. Control points and LM

- **`align.ts solvePins`** (l.393):
  - LM with a forward-difference Jacobian and a Marquardt diagonal.
  - 1 pin solves yaw and pitch; 2 pins add roll; 3 or more add vfov.
  - The priors on roll and vfov are **0.5 "px" per degree**, essentially none.
  - **`projectUV` has no behind-camera guard.** Division by a negative z yields a mirrored projection that LM can fit. `eval-app` on IMG_7063 converges to **Δroll = 169°** with infinite residual. This is a real bug (D3).
- **`geo/control-points.ts solveFromControlPoints`**:
  - Proper behind-camera residual (`BEHIND_PX`).
  - "Level" points (known elevation, unknown azimuth) for waterlines.
  - A σ = 10% f prior.
  - Tested by `annotate-selftest.ts`.
- **`baseline-ui/control-points.ts solveFallback`** is a third copy of the solver.
- **`engine.controlPins`** (~l.783) accepts only `peak` and `az/el` points. It silently drops `level` and `lat/lon` points, so the engine's "GT" for IMG_6958 and IMG_6971 uses fewer constraints than `annotate.ts` does.

### A7. Peak visibility and labels

There are four implementations:

1. **Engine** (`peakLabels` ~l.729):
   - Tests visibility by sampling the geometry buffer 0.004 and 0.009 below the summit, visible if range ≥ 0.97·r − 50.
   - Ranks by `3·prominence + ele − 0.012·range`. Prominence is mostly null in OSM.
   - Declutters with a fixed 0.07×0.08 normalised box, independent of text length. Maximum 28 labels.
   - Peaks are snapped to the DEM local maximum within 60–250 m (`buildPeaks` ~l.357).
   - **Peaks outside the loading wedge are dropped and never rebuilt** (D6).
2. **`geo/peaks.ts viewPeaks`**: ray-march line of sight with a 0.05° tolerance. Height is `max(DEM localMax, OSM ele)`, so OSM ele above the DEM puts the label above the rendered summit. Layout keeps horizontal spacing only.
3. **`baseline-ui/peaks.ts`**: fallback ray-march with a 0.1° tolerance, OSM ele over the DEM, and `placeLabels` stacking labels in up to 6 levels with measured widths. This is the best label layout in the repo.
4. **deck** (`deck/scene.ts visiblePeaks/declutter`): CPU raycast LOS with a 30 m target lift, and box-based declutter.

### A8. Segmentation

`segment.ts` runs MediaPipe `selfie_multiclass_256x256` (GPU delegate with CPU fallback) at 512 long side:

- Person probability is `1 − background`, passed through `smoothstep(0.3, 0.6)`, dilated by 1% of width, then box-blurred twice.
- Failure modes:
  - The model is trained on selfies, so small or distant hikers are under-segmented.
  - Non-person occluders are not segmented at all.
  - The dilation leaves a soft halo about 5 px wide at 512.
- Deeplab and "combined" paths exist but are unused (dead options).
- It runs on the main thread, sharing the GPU with three.js.

---

## B. Processing and efficiency

### B1. Thread placement

- **Engine: everything runs on the main thread.** That covers tile decode (`decodeTerrarium` via OffscreenCanvas `getImageData`, `terrain.ts:101`), meshing (`buildMesh`), MediaPipe inference, `buildEdgeMap`, `computeHorizon`, `autoAlign` and imagery mosaicking.
  - Meshing costs 162–201 tiles and **3.4–4.1 M vertices** per photo (measured), with `frame.fromGeo`'s ECEF trig per vertex, `index.push` into JS arrays, and `computeVertexNormals`.
  - "Ready" takes about **10–12 s** cold. Tile network time dominates, but the build is not yielded to the UI.
- Baseline: the worker (`pipeline.worker.ts`) owns tiles, horizon, peaks, skyline and solve. Good.
- deck: the range map (192×144 CPU raycasts) and `visiblePeaks` run on the main thread. The range map is chunked with `setTimeout`; `visiblePeaks` is not.

### B2. GPU readbacks: all synchronous

- **`renderGeometry`** (~l.502): a 1024×768 RGBA32F target, `readRenderTargetPixels` = **12.6 MB, 7–10 ms, blocking**. It runs on **every pose change**, including every pointer-move during drag and every slider tick.
- **`computeHorizon`**: 8 × 1024×1536 RGBA32F = 8 × 25 MB of readback, blocking.
- **`silhouetteScore`**: one 384×288 float readback per hypothesis, up to 5 per autoAlign.
- `preserveDrawingBuffer: true` was just added for `exportImage`. It costs a buffer copy per frame; turn it on only while exporting.
- **Fix:**
  - Use three r186 `readRenderTargetPixelsAsync` (PBO plus fence) and read back only on pointer-up or idle.
  - During drag, compute labels analytically (`projectPoint` plus cached visibility) and hover with a **1×1 readback** at the cursor.
  - Pack the geometry buffer as R32F range plus RG16F oct-normal, or recover XYZ from range and the pixel ray (`unprojectDir`). That makes it 4× smaller.
  - Compute the horizon with **one cylindrical (equirectangular-in-azimuth) render**, or in a compute-style pass that reduces to a 1-D max per column on the GPU. Read back 8192 floats, not 200 MB.

### B3. Tile fetch, decode and cache

- Pool concurrency is 24 (engine) or 12 (deck). There is no IndexedDB or Cache-API layer; it relies on the HTTP cache.
- Each stack re-decodes different DEMs for the same place: Mapterhorn in the engine, AWS in the baseline and deck. `geo/terrain.ts` hard-codes `TILE_SIZE = 256` (l.8) and `deck/terrain-data.ts sampleGrid` hard-codes 256 (l.55). **Switching either to Mapterhorn 512 silently corrupts heights.**
- Retained CPU memory in the engine is about **93–109 MB of `heights`** (full-res kept for z ≥ 13, `terrain.ts` keep rule ~l.256), plus JS copies of every geometry array (three keeps them after upload).
- **Allocation hot spot:** every tile builds a fresh `index: number[]` (up to 394k entries for seg = 256), calls `setIndex` twice, and builds its skirt arrays with `Array.from`. The index buffer is identical for all tiles with the same `seg`, so **share one `BufferAttribute` per seg**.
- Meshing: consider **Martini/RTIN** (error-bounded adaptive mesh). It gives 5–10× fewer vertices at the same silhouette error, and peak-preserving decimation.

### B4. Redundant work

- Two horizons are computed per photo in different ways, with different DEMs and different eye rules.
- Peaks come from a static per-region JSON (engine, from ingest with a 60 km bbox) and from a live Overpass call (baseline, 50 km radius, three mirrors).
- `PhotoWorkspace`'s `onRender` listener calls `setLabels(engine.peakLabels())` and `setCandidates(engine.peaksInFrame())` on **every frame** (l.62–69). That is a full React re-render of the workspace each frame during drag.
- `renderNow` sets `brushTex.needsUpdate = true` every frame (~l.563), which re-uploads a 512×384 canvas even when not in brush mode.
- `renderWorld` allocates `new THREE.Color` every frame.

### B5. Baseline ray-march cost

`computeHorizon` makes about 9.4 M `destination()` calls (each with asin, atan2 and 4 trig functions) plus 9.4 M bilinear samples and Map lookups by string key (`pixel()` builds `` `${z}/${tx}/${ty}` `` per sample, `geo/terrain.ts:100`).

To fix it:

- Precompute per-azimuth unit vectors in a local tangent plane.
- Step in fractional tile coordinates.
- Cache the current tile reference.
- Use numeric keys.

A 10–20× speed-up is plausible. Alternatively, reuse the engine's GPU horizon.

### B6. Measured stage times

| stage | where | time |
|---|---|---|
| horizon ray-march (7200 az) | baseline, Node | 3.5–4.5 s |
| skyline detect (800 px) | baseline | 113–321 ms |
| solvePose | baseline | 42–231 ms |
| cold tiles → ready | engine, browser | 10–12 s |
| GPU horizon (8 renders + readback) | engine | 80–110 ms |
| geometry pass + sync readback | engine, per pose change | 7–10 ms |
| autoAlign incl. silhouette re-rank | engine | 110–140 ms |
| Refine (±6°) | engine | 35–62 ms |

---

## C. Rendering and aesthetics

### C1. Terrain shader (`materials.ts`; deck port in `deck/terrain-layer.ts`)

- **Hillshade:**
  - `shade = 0.25·(0.5 + 0.5·n.z) + 0.85·max(n·sun, 0)` (l.117).
  - A fixed sun at azimuth about 231° and altitude about 50° (`uSunDir` l.16). That is a south-west light: the opposite of the cartographic NW convention, and unrelated to the photo's actual sun.
  - No ambient occlusion, sky-view factor, slope/aspect softening or shadows.
- **Hypsometric ramp** (`hypso` l.90): five constants fed through `colorspace_fragment`. They are treated as *linear* values, so after sRGB encoding they read washed-out and pastel (0.36 becomes about 0.63).
- **The deck port does no linear↔sRGB handling.** The same constants render darker and different there, and imagery is sampled as UNORM.
- **Normals:** three uses `computeVertexNormals` per tile, so edges lack neighbours, which **creates shading seams at every tile border**. deck uses central differences clamped at edges, with the same issue.
- **Fixes:**
  - Compute normals from the source heights with a 1-px border taken from neighbour tiles (or from the 512² grid before decimation).
  - Precompute sky-view factor or horizon-based AO per tile into a texture.
  - Offer a **photo-matched sun** (SunCalc from `takenAt` plus lat/lon) and a multi-directional (MDOW) relief style.
  - Define the ramps in sRGB and convert in the shader.

### C2. Contours and bands

- The contour isoline is `fract/fwidth` (`contourLine` l.128). Minor lines fade when denser than about 3 px; majors are every 5th line, 1.8× width. They fade with range from 4 to 25 km and get the new `uNearFade`.
- Colour is `coolRamp` (teal → violet → magenta → cream) by elevation. **There is no dark casing or halo.** Thin cyan and violet lines vanish over bright sky-lit snow and haze, and there are no index-contour labels.
- Bands are floor(elev/(interval·5)) tinted by coolRamp × shade at alpha 0.55–0.95, faded to 0 below 60–450 m.
- **Fixes:**
  - A two-pass casing: a dark line at about 2× width and 35% alpha under a light line.
  - Contour width that scales with log-range.
  - Index labels placed along contours in screen space (sample contour crossings in the geometry buffer).
  - A perceptually uniform ramp (e.g. OKLCH), or luminance matched to the photo so bands do not flatten depth.

### C3. Ridgelines and silhouettes (composite, `engine.ts` compositeFrag ~l.123–147)

- Ridgelines come from the max |Δ log range| over ±1.25 texels of the **1024-px nearest-filtered** geometry buffer, which is upsampled to screen.
- Lines are therefore blocky and aliased, and their thickness depends on the ratio of screen size to 1024.
- `isSkyline` is a single-texel test, so the orange skyline stroke flickers.
- **Fix:** render log-range into an MRT attachment of the MSAA `layerRT`, at screen resolution, and do the Sobel there. Or extract silhouettes as geometry (projected horizon polyline plus ridge crests from `geo/horizon.ts ridges`) and draw them with `LineMaterial`, which gives analytic AA and consistent width.

### C4. Imagery drape (`terrain.ts loadImagery`)

- Tile mosaics are 256·2^extra px (extra 2 below 4 km, 1 below 40 km).
- swissimage or pixelkarte in Switzerland, otherwise Esri or OSM.
- `CanvasTexture` with mipmaps and ClampToEdge. **Visible seams at tile borders** come from clamp plus mip bleed.
- No colour matching to the photo. swissimage is summer-bright and cool; the photos vary.
- Built on the main thread with DOM canvases.
- **Fixes:**
  - Pad each mosaic with a 1-tile gutter, or use a shared texture atlas or virtual texture.
  - Use `OffscreenCanvas` in a worker with `transferToImageBitmap`, as deck already does.
  - For Blend, add **photo-matched colour transfer**: Reinhard/Lab mean-std per distance band, computed over pixels both views agree are terrain.

### C5. Compositing and blend modes (compositeFrag)

- **Overlay:** `mix(photo, layer, a·opacity·(1−fg))`, then ridges; an optional turbo depth tint.
- **Blend:** the mask comes from swipe, lens, range or brush. "Keep sky" multiplies by `layer.a`, i.e. the **rendered DEM coverage, not the photo's sky**.
  - Wherever the DEM skyline sits above the true skyline (DEM smoothing, the 1–2 px alignment residual, or trees and buildings on the skyline), map pixels paint into the real sky.
  - Where it sits below, a sliver of photo sky shows through under the map.
  - The hairline around the mask edge is a white 0.6 overlay.
- There is no photo sky mask at all in the engine, although the baseline detector computes one (`SkylineObservation.sky`).
- **Fixes, ranked:**
  1. Compute a photo sky probability (reuse `skyline.ts` or a small SegFormer sky model) and use `m *= (1 − photoSky)`. Refine the edge with a **guided filter** on photo luminance for hair-thin ridge edges.
  2. Build a "foreground occluder" mask where the photo is non-sky above the DEM skyline (trees, buildings) and keep the photo there.
  3. Feather people edges with a guided filter instead of blur plus dilation.

The deck path composites by CSS opacity over an `<img>`, with no fg or sky masks (`deck.tsx` ~l.646).

### C6. Atmosphere and haze

`haze()` is `mix(col, uHazeColor, 1 − exp(−1.8e-5·range·uHaze))`, capped at 0.85 (l.123). It uses a single fixed colour `#b9cde0` with no altitude dependence (dense low valleys vs clear summits) and no photo matching.

For Blend this is the second-biggest realism gap after sky edges. **Fit the extinction coefficient and airlight from the photo.** For pixels with known range (geometry buffer) and a terrain classification, regress photo luminance against range. A dark-channel-prior-style fit, `I = J·t + A(1−t)`, `t = exp(−β·d)`, gives β and A per photo. Apply that to the rendered map so replaced regions carry the photo's own aerial perspective. Use height-dependent density, `β(h) = β0·exp(−h/H)`, integrated analytically along the ray.

### C7. Labels and typography

- Engine labels are HTML `div`s at 12 px semibold with a drop shadow and a 28 px gradient leader, above or below the anchor by v (`PhotoWorkspace` labels map).
- Declutter uses normalised boxes that ignore text length. Labels can overlap the frame edge and each other when names are long. There is no size or weight hierarchy by prominence or distance.
- **Fix:** port `baseline-ui/peaks.ts placeLabels`, which measures widths, stacks multiple levels and clamps to the frame. Add rank-based size (13/12/11 px) and weight. Add a distance line ("3 245 m · 12 km") at reduced opacity, as now, and a light backdrop blur only under stacked leaders.

### C8. Trails (`buildTrails` ~l.366)

- `LineSegments2`, 2.2 px, SAC colours, densified at 40 m.
- **Lifted `3 m + 0.0015·d`** above the DEM (18 m at 10 km) to avoid z-fighting, so trails float above thin ridges and show through them.
- There is no casing and no dashed styling for occluded segments.
- **Fix:**
  - Place trails at the DEM height and depth-test them in a separate pass against the geometry buffer, with a range-relative tolerance: `visible if r_trail < r_geo·(1 + 0.004) + 3 m`.
  - Draw occluded segments dashed at 35%.
  - Add a dark 1 px casing.

### C9. Antialiasing and depth

- `antialias: true` applies to the default framebuffer, which only draws a full-screen quad, so it is useless there. `layerRT` uses 4× MSAA HalfFloat, which is good.
- The geometry and silhouette targets have no AA, which is fine for data but not when reused for ridges (C3).
- `logarithmicDepthBuffer: true` in three and a manual `gl_FragDepth` log in deck **disable early-Z** on every terrain fragment. With 3–4 M vertices and heavy overdraw, that costs fill rate.
- **Fix:** use three r186 reversed-Z (`reversedDepthBuffer: true` with a float depth attachment), which supports near 1 m to far 400 km without writing `gl_FragDepth`. In deck, use a float depth texture with reversed-Z projection.

### C10. Photo projection ("In map")

- Shadow-map test `r < seen·1.015 + 15 m` against the 1024-px nearest geometry buffer, plus incidence weighting and a people mask (`materials.ts` l.178–201).
- The low resolution and hard test give **stair-stepped occlusion edges and leaks along ridges**.
- **Fixes:**
  - A higher-resolution R32F range target (2048 on the long side), rendered once per pose.
  - PCF-style 3×3 comparison for soft edges.
  - A sky mask (not only people) so sky pixels are never smeared onto distant terrain.
- The deck photo texture has **no mipmaps** (`terrain-layer.ts` `makeTexture(device, photo, false)`), so it aliases when minified.

### C11. Tone and colour

- There is no tone mapping, and exposure and white balance are never matched between photo and render.
- The photo texture is sRGB → linear. Fine.
- Photos are served at 2048 max (`ingest.mjs MAX_PX`), so exports are limited to 2048 px even though the originals are 12 MP.

---

## D. Bugs, correctness risks and dead code

Ranked by impact.

1. **Eye-height policy differs across stacks**: the engine's 30 m snap (~l.326) vs `max(GPS, DEM+1.6)` in `pipeline-node.ts:43`, `baseline.ts:133`, `pipeline.worker.ts:218` and `annotate-lib.ts:74` vs DEM+2 in `deck.tsx:144`. Combined with **AWS Terrarium being 40–85 m low at the Niederhorn sites**, this is the root cause of the three baseline rejections (A3).
   - **Fix:** one `resolveEye(meta, dem)` in `lib/geo` used everywhere. Solve eye height (and optionally a ≤ hAccuracy horizontal offset) as extra LM parameters with priors σ_h ≈ 10 m and σ_xy = hAccuracy, observable from near-field skyline curvature.
2. **The baseline and deck use AWS Terrarium, not Mapterhorn**, contrary to the project decision (memory: "Mapterhorn DEM approved"). The GT tooling (`annotate-lib.ts`) and its "(DEM)" notch control points are therefore defined on the biased DEM, so the GT is DEM-circular. **Fix:** move `geo/terrain.ts` to Mapterhorn 512 with `TILE_SIZE` taken from the image, and regenerate the GT.
3. **`align.ts projectUV` has no z ≤ 0 guard** (l.358). LM in `solvePins` can converge to mirrored or behind-camera solutions: `eval-app` IMG_7063 gives Δroll 169° and residual ∞. The weak roll and vfov priors (0.5/deg, l.404) make it worse. **Fix:** replace `solvePins` with `geo/control-points.ts solveFromControlPoints`, which has the behind-camera penalty and level points, adapted to `Pose`.
4. **`engine.controlPins` drops `level` and `lat/lon` points** (~l.783). The engine eval therefore uses fewer constraints than the GT tooling, e.g. IMG_6971 gets 2 of 4 pins.
5. **Wedge loading** (engine init ~l.311, `terrain.ts inWedge`):
   - `computeHorizon` still renders 360°, so directions outside the wedge see missing terrain.
   - `buildPeaks` drops out-of-wedge peaks (`localMax` returns −∞) and **never rebuilds them after `loadPending`**.
   - `horizonDirs` is not recomputed after pending tiles load.
   - Refine after a manual drag of more than 32° lands on missing terrain.
6. **The geometry buffer is read back synchronously on every pose change**, and React re-renders every frame (B2, B4). This is a UX risk on DPR 2 or integrated GPUs.
7. **`GPSImgDirectionRef` is ignored** (`geo/camera.ts:102`, `ingest.mjs:203`).
8. **Worker state race** (`pipeline.worker.ts:50, 283–285`): `sky` and `current.horizon` are global. An `align` sent after a photo switch can pair photo B's skyline with photo A's horizon before the new run finishes. Replies are id-filtered, but the computation is not.
9. **Hard-coded 256 tile size** in `geo/terrain.ts:8` and `deck/terrain-data.ts:55` is a latent corruption risk (B3).
10. **`sampleGrid` edge clamp** (`terrain.ts:126`): adjacent tiles disagree by up to half a pixel at borders. Skirts hide the cracks, but normals and shading show seams.
11. **The Refine path relearns the colour model from the current pose** (`engine.autoAlign(false)` passes `this.pose` as prior into `fitSkyModel(scanLabels(..., skylineRows(prior)))`). That is the feedback loop the code comment warns about.
12. **Inconsistent acceptance thresholds**: engine confidence > 0.2 vs baseline ≥ 0.5, both uncalibrated.
13. **deck photo texture has no mipmaps**, and the deck path lacks sRGB handling (C1, C10).
14. `preserveDrawingBuffer: true` is left on permanently (engine ctor l.222).
15. **The eval report is stale.** `out/eval/report.md` (22:21) shows every photo as "GT missing", but `data/ground-truth.json` (22:26) now has IMG_6958. `control-points.json` has 8 photos but `ground-truth.json` only 1.

**Dead or unused code:**

- `geodesy.ts bearingDeg`
- `engine.photoElement`
- `engine.hasForeground` (written, never read)
- `segment.ts` deeplab/"combined" models
- The TanStack boilerplate in the README after l.52

**Duplicates to consolidate:**

- Terrarium decode ×3
- Imagery URL builders ×2
- `pool` ×2
- hypso, coolRamp, shade and haze GLSL ×2 (three and deck)
- LM ×3 (`align.ts`, `geo/lm.ts`, `baseline-ui/control-points.ts`)
- boxBlur ×3
- Label declutter ×4
- Visibility tests ×4
- `localMax` ×3
- `REFRACTION_K` and `EARTH_R` ×2
- The `PhotoMeta` type name ×2 with different shapes (`lib/photos.ts` vs `lib/geo/photo-meta.ts`)

---

## E. Evaluation

**What exists:**

- `scripts/eval.ts` (baseline only):
  - Prior, solved and final errors in yaw, pitch, roll and f.
  - **Skyline px distance** between cameras, projected on the DEM horizon at 1600 px.
  - Solver diagnostics: confidence, inliers, coverage, ambiguity, relief. Stage timings.
  - Overlays in `out/eval/*.jpg`.
- `scripts/eval-app.mjs` (engine, Playwright): control-point GT solved in-engine; prior, auto and GT residual px @1600; Δyaw, Δpitch, Δroll.
- `baseline-solve-synth.ts`: synthetic recovery with occluders.
- `annotate-selftest.ts`: exactness of the control-point solver.
- `baseline-skyline.ts`: visual only.
- `shot.mjs`: screenshots.

**Current numbers (my runs):**

- Engine auto-align: **6/7 within 1° yaw; median 7.7 px @1600** against control-point GT. The GT solve itself leaves 0.7–13.7 px residual, and is ∞ on IMG_7063.
- Baseline: all 5 accepted solves within 0.5° yaw of the GT. IMG_6958 against `ground-truth.json` shows yaw +0.30°, pitch +0.04° and roll −0.08° error.
- Rejected: IMG_7059, 7063 and 7068 (eye/DEM, A3) and IMG_7155 (confidence 0.11, Δyaw 16°, unverified).
- The prior's yaw error has a median of about 4.75° and a range of 0.7–9.1°.

**Gaps, ranked:**

1. **Tiny, DEM-circular GT.** There are 13 photos in two regions. Only 1 photo has a stored GT pose. Several control points are "(DEM)" features on the biased AWS DEM.
   - Label GT on Mapterhorn.
   - Use peaks and lat/lon features, not DEM notches, where possible.
   - Target 50+ photos, including snow, overcast, trees and sunset.
2. **No photo-space metric.** All skyline metrics compare two *DEM projections*.
   - Add a hand-traced photo skyline (polyline per photo; `baseline-skyline` overlays are a starting point).
   - Report (a) the detector's row error and (b) the rendered-skyline-to-photo-skyline chamfer px. The SoTA doc recommends row error over IoU.
3. **No confidence calibration.** Plot confidence against error to get a reliability curve for both solvers, and choose thresholds from it.
4. **No single harness across pipelines.** `eval.ts` covers the baseline and `eval-app.mjs` covers the engine. They use different DEMs and GT paths. Unify them on one GT file and one metric set, and emit a combined table.
5. **No rendering QA.** Nothing measures ridge-to-photo-edge alignment of overlays, sky-edge leakage in Blend (fraction of map pixels inside the photo sky mask), or perceptual diffs from `shot.mjs` screenshots.
6. **No latency budget or regression gate.** There are no CI or unit tests beyond the self-test, and `report.md` goes stale silently.

---

## Top fixes by area

| # | Area | Fix | Where |
|---|---|---|---|
| 1 | A | Unify eye policy; add eye height (plus optional xy) as solver unknowns with GPS priors; move the baseline to Mapterhorn | new `lib/geo/eye.ts`; `geo/solve.ts`; `geo/terrain.ts` |
| 2 | A | Replace `solvePins` with `solveFromControlPoints` (behind-camera guard, level points); honour all point types in `controlPins` | `align.ts`, `engine.ts` |
| 3 | A | Tighten gravity priors (σ roll/pitch ≈ 0.7°) in engine autoAlign; replace coordinate descent with LM on a smoothed chamfer (distance transform of the edge/skyline map); add inner-silhouette chamfer as a data term | `align.ts` |
| 4 | A | Sky detection robust to snow and cloud: a learned sky segmenter (SegFormer-B0 sky class, ONNX/WebGPU) fused with `skyline.ts` Viterbi; mask non-person occluders | `geo/skyline.ts`, `segment.ts` |
| 5 | B | Async or on-demand readbacks; single-render GPU horizon; throttle React label updates to rAF-idle; shared index buffers; move decode and meshing to a worker (transfer typed arrays) | `engine.ts`, `terrain.ts` |
| 6 | B | Faster baseline horizon (tangent-plane stepping, numeric tile keys), or reuse the GPU horizon | `geo/horizon.ts`, `geo/terrain.ts` |
| 7 | C | Photo sky mask plus guided-filter edges in Blend and In-map; occluder mask | `engine.ts` compositeFrag, `materials.ts` |
| 8 | C | Photo-fitted aerial perspective and colour transfer for Blend | `materials.ts haze`, composite |
| 9 | C | Screen-res AA silhouettes via MRT or geometry lines; contour casing and labels; seamless normals; sun from EXIF time; sRGB-correct ramps; reversed-Z | `materials.ts`, `engine.ts`, `terrain.ts` |
| 10 | C | Labels: measured-width multi-level placement and rank typography; trails depth-tested with casing and dashed occlusion | `engine.peakLabels`, `PhotoWorkspace`, `buildTrails` |
| 11 | E | Mapterhorn-based GT for all photos, a photo-skyline GT, a calibration curve and one unified eval harness with a regression gate | `scripts/eval*.ts`, `data/` |
