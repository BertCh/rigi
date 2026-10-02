<!-- Rigi -->
<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: Copyright (c) Rigi contributors -->

# Step ⑨ terrain-sampler ("Ground height") and the terrain-snapping hub, 2026-10-02

Step lead: Opus (coordinator mt-image-17, step-pod rules). Nodes: `terrain-sampler` and the `terrain-snapping` hub in `src/lib/gipfelbuch/graph.ts`. `src/lib/geo/terrain.ts` belongs to the dem-horizon pod, and `src/lib/geo/pipeline.ts` to the baseline-pipeline and eye-rule pods. Changes to those files are proposals in this document (§5). This pod edited only `src/lib/dem/height-from-tile.ts`, `src/lib/nearfield/generate/three-terrain-mesh.ts`, the two engines' lake-floor call, and new specs.

## 1. Current state: who answers "how high is the ground here?"

There is no single function. Seven CPU samplers and one GPU gather all use pixel-centred bilinear interpolation, but they differ in how they handle tile edges, missing tiles and no-data.

| Sampler | Where | Tiles from | Tile edge | Missing tile | No-data (−32768) |
|---|---|---|---|---|---|
| `TerrainSampler.sample` / `sampleAt` / `ground` | `geo/terrain.ts:39-73` | Caller's loader. The unknown-pose worker uses `fetchDemTileCached` (`dem/load.ts:51`), which has no ancestor fallback and does not run `validateTile`. | Blends across the seam. | `NaN`, after which `sampleAt` tries the next coarser **level**. | Blended in as a real height. |
| `TerrainSet.heightAt` / `locate` / `localMax` (deck render, peaks, trails) | `deck/terrain-data.ts:148` | `loadDemTile`: ancestor crop plus the `validateTile` fill. | Clamped to the tile, so it jumps at a seam (see the spec). | Uses the finest **loaded** tile, which can be z17. | Filled. |
| `heightFromTile` (head-start eye for the horizon worker) | `dem/height-from-tile.ts` | `loadDemTile`, z14 | Clamped (`sampleGrid`) | Ancestor | Filled |
| `HeightGather.heightsAt` (WebGPU, `terrainGpuDecode`) | `deck-webgpu/height-gather.ts` | The atlas layer | Same result as `TerrainSet.heightAt`, bit for bit (`blendCorners`; spec `height-gather.spec.ts`) | Falls back to `heightAt` | Filled |
| `TileStore.heightAt` (horizon-fast; scripts only) | `horizon-fast/mosaic.ts:246` | `TileStore` | Blends across the seam. | Nearest-**ancestor** pixel, with no blend inside the ancestor. | It returns a `NO_DATA` blend instead of `NaN` where no ancestor exists. |
| `mosaicHeight` (ridgelines worker, eye experiments) | `horizon-fast/mosaic.ts:764` | Mosaic | Mosaic-wide | `NaN` outside the mosaic | `NaN` (`MIN_VALID`) |
| `FastSampler` (geocam scripts) | `scripts/geocam/lib.ts:196` | Same tiles as `TerrainSampler` | Same | Same | Same. It is a copy of `TerrainSampler` with a one-tile memo per zoom. |
| uv `sampleGrid` (near-field three terrain) | `nearfield/generate/three-terrain-mesh.ts:33` | Its own tiles | Clamped | — | Filled |

The eye rule (DEM plus standing height) is also written out five times:

- `deck/scene.ts:59`. With no GPS altitude it uses +1.8 m.
- `geo/pipeline.ts:49`. With no GPS altitude it uses **+1.6 m**.
- `gpu/eye/suggest.ts:96`, `roll/mosaic/ridgelines.worker.ts:108` and `concord/occl/ndsm.ts:486`, each an inline copy of the engine rule.

## 2. Findings (ranked)

**P1: unknown-pose cannot start outside Mapterhorn's z13–17 regional coverage.**

- `loadScene` takes the camera's ground height from `terrain.sample(lon, lat, dem.levels[0].z)` (`geo/pipeline.ts:43`). That is z15 only, with no level fallback, so the result is `NaN` and the function throws "No DEM data at this location".
- The unknown-pose worker's loader returns `undefined` on a 404 and has no ancestor fallback.
- Measured on Mapterhorn with HEAD requests on 2026-10-02:

  | Place | z12 | z13 | z14 | z15 |
  |---|---|---|---|---|
  | Everest | 200 | 404 | 404 | 404 |
  | Kilimanjaro | 200 | 404 | 404 | 404 |
  | Aconcagua | 200 | 404 | 404 | 404 |
  | Denali | 200 | 200 | 404 | 404 |
  | Wasatch (IMG_3304) | — | 200 | 200 | 200 |

- The horizon itself would have worked, because `sampleAt` falls back level by level. Only the ground lookup fails.
- Fix (proposal §5.1): `terrain.ground(lon, lat)`. It is bit-identical wherever a z15 tile exists, because `ground` = `sampleAt(…, 0)` = level 0 first.

**P2: the worker samplers and the render sampler see different tiles.**

- `fetchDemTileCached` and `fetchDemTile` (`dem/load.ts:39-63`) do not run `validateTile`'s no-data fill, while `loadDemTile` does (`demRasterFromBytes`, `load.ts:149`). So a no-data pit is real ground to `TerrainSampler` and filled ground to `TerrainSet`.
- An offline scan of the local `.cache/dem-mapterhorn` tiles under the 19 bench photos found **0** tiles with no-data, so this is latent.
- The Gipfelbuch page says "The 3D terrain loads the same tiles with the same fallback, so both see the same ground". That holds for the page's streams, not for the unknown-pose and baseline workers.
- Fixing it changes heights on the solve path, so it needs an opt-in flag or proof that it is bit-identical where there is no no-data (§5.2).

**P2: the lake floor's rule (b) treated GPS altitude as the DEM.**

- Both engines pass `dem = heightAt ?? photo.alt ?? 0` as `demAtFix` (`init()`: `deck-webgpu/engine.ts` ~l.1324 and the `lakeFloor(` call ~l.1355; `deck/engine.ts` ~l.922 and ~l.948).
- With no DEM at the fix, rule (b) ("DEM at the fix ≤ 3 m below the lake") ran on the GPS altitude.
- **Fixed** in this pod. Both engines now pass the DEM height only, and `NaN` disables rule (b) as documented in `LakeFloorOpts`. The flag `geoLakeFloor` is off by default, so there is no default change.

**P2: a sampler discontinuity at tile seams (documented, not fixed).**

- `TerrainSet.heightAt`, `heightFromTile` and the GPU gather clamp to their own tile, so within half a pixel of a seam they jump by up to one pixel step.
- `TerrainSampler` and `TileStore` blend across the seam.
- The new spec `samplers-agree.spec.ts` pins both behaviours and bounds the disagreement at half the seam step: about 0.2 m at z17 and about 13 m of distance on a z11 tile.
- MapLibre handles seams with a backfilled 2 px border (`dem_data.ts`). That matters for hillshade and slope, not for point heights. Not worth a change (§3).

**P3: camera ground differs by zoom across the four ground-height sources.**

- The sources: z14 head start, z15 in `loadScene`, the finest tile for render (to z17), and the GPU gather (finest).
- Offline diagnostic on the 19 bench locations with local cache tiles (`scratchpad/ts/ground-zooms.mts`; a diagnostic, not a result):
  - |z15 − z14| ≤ 0.46 m, and ≤ 0.12 m apart from one photo.
  - |finest − z15| ≤ 0.15 m.
- That sits well below the "decimetre" sensitivity only where the cliff-lip pairs bite (`nearfield/cliff-lip.ts:13`).
- The 0.2 m eye-rule split between +1.6 and +1.8 m with no GPS altitude (`pipeline.ts:49` vs `scene.ts:59`) is as large as the zoom effect. It is a proposal for the eye-rule pod (§5.3).

**P3: perf of the CPU fallback samplers.**

- `TerrainSampler.pixel` builds a template-string key for every corner, which is four `Map` lookups per sample (`terrain.ts:76-81`).
- A one-tile memo per zoom, as `FastSampler` already does, is bit-identical and was 1.25–1.9× faster on 917 k horizon-pattern samples on a loaded machine. Node, synthetic tiles, `scratchpad/ts/memo.mts`; bit-identical 917280/917280.
- It only matters for the CPU fallback `computeHorizon`, `viewPeaks` and scripts, since the hot horizon is horizon-fast or the GPU.
- Proposal §5.4. `FastSampler` can be deleted afterwards.

**P3: other code smells.**

- `mosaicsFromSampler` reads `TerrainSampler`'s private `tiles` through a cast (`horizon-fast/march.ts:495`). The public `tileSet` getter exists.
- `TileStore.heightAt` returns a `NO_DATA` blend, not `NaN`, outside coverage. Only scripts call it.

**P3: duplicated samplers.**

- `heightFromTile`'s private `sampleTileGrid` and the near-field uv `sampleGrid` were copies of `dem/grid.ts sampleGrid`. Both now call it, bit for bit (specs below).

**P3: claim drift (Gipfelbuch).** See §6.

## 3. Research summary

- **Mapterhorn** ([data access](https://mapterhorn.com/data-access/), [pipeline README](https://raw.githubusercontent.com/mapterhorn/mapterhorn/main/pipelines/README.md)):
  - 512 px Terrarium WebP.
  - The planet archive covers z0–12 and regional archives cover z13–17, which matches the 404 table in §2.
  - Overviews are 2×2 averages, which is consistent with area (pixel-centre) registration and therefore with our `−0.5` convention.
  - Not verified: per-tile overlap pixels and the vertical datum. docs.mapterhorn.com did not resolve. The next step is to read `pipelines/` in the repo.
- **MapLibre** `DEMData` ([dem_data.ts](https://raw.githubusercontent.com/maplibre/maplibre-gl-js/main/src/data/dem_data.ts)): plain bilinear, with a 2 px border backfilled from neighbouring tiles for seams.
- **CesiumJS** `HeightmapTerrainData.interpolateHeight` ([source](https://raw.githubusercontent.com/CesiumGS/cesium/main/packages/engine/Source/Core/HeightmapTerrainData.js)): interpolates on the mesh triangle (a SW–NE split) so that sampling equals the rendered mesh.
- **deck.gl TerrainLayer**: martini or delatin mesh, `meshMaxError` 4 m.
- **Bicubic vs bilinear** (e.g. [MDPI RS 16(5):819](https://www.mdpi.com/2072-4292/16/5/819)): RMSE 1.2 vs 1.6 m on a 30 m DEM, with gains growing with pixel size.
  - For Rigi the horizon is a maximum along a ray, and bicubic overshoot can invent crests.
  - VSWEEP showed that pitch is already at the ground-truth floor (`negative-results.md:21`).
  - Error budget: DEM source (Terrarium vs Mapterhorn, up to ~100 m; `bench-ablation.md:311-316`) ≫ zoom choice (1–17 px; `concordance-research.md:56,91`) ≫ interpolation (≲ 1 m).
  - **No bicubic work is planned.** It would also have to break the CPU/GPU bit-identity of `blendCorners`.
- **Our own record:**
  - Bilinear was never measured against an alternative.
  - CR-07 fixed no-data pits in meshes (9b2a4e9).
  - `terrainGpuDecode` gathers landed (`negative-results.md:129`).
  - GA4 lake waterline eye height was killed. The lake floor bound stayed, behind the off flag.
  - Not to redo: GA4, and the Terrarium-era `demGround` in the ground truth, which is stale by up to 81 m (`concordance-research.md:525`; the scan above shows the same 50–85 m gap on IMG_7053…7155).

## 4. Plan of units

| # | Unit | Size | Risk | Gate | When |
|---|---|---|---|---|---|
| U1 | `heightFromTile` through `sampleGrid`, plus a spec (bit-identical to the old copy) | S | none | vitest, tsc | **now** |
| U2 | Conformance spec across `TerrainSampler`, `TerrainSet`, `TileStore` and `sampleGrid`: interior agreement, seam, missing tile, no-data | S | none (spec only) | vitest | **now** |
| U3 | Lake floor: pass the DEM at the fix only, in both engines | XS | none by default (off flag) | tsc, ledger row | **now** |
| U4 | Near-field uv `sampleGrid` delegates to `dem/grid.ts` (bit-identical, with a spec) | XS | none | vitest | **now** |
| P1 | `loadScene` ground from `terrain.ground()` | XS | bit-identical where z15 exists | spec with a missing level-0 tile | baseline-pipeline pod (§5.1) |
| P2 | One tile policy for workers: `fetchDemTileCached` with the `validateTile` fill (jump = ∞) and ancestor fallback | M | heights change on no-data tiles only | flag or a byte-equality scan, precision gate | later, needs a gate (§5.2) |
| P3 | A single `eyeAltitude` in a pure module (`dem/` or `geo/eye.ts`); the five copies import it; decide 1.6 vs 1.8 m | S | 0.2 m eye change in the CPU pipeline when there is no GPS altitude | the user decides the constant | eye-rule pod and the user (§5.3) |
| P4 | `TerrainSampler.pixel` one-tile memo (bit-identical); delete `FastSampler`; `mosaicsFromSampler` uses `tileSet` | S | none | the spec in this pod, plus a bit-identity spec | dem-horizon pod (§5.4) |
| P5 | Verify Mapterhorn registration and datum from the pipeline code; state the error budget on the page | S | doc | — | later |

## 5. Proposals for files this pod does not own

1. **`src/lib/geo/pipeline.ts:43`** (baseline-pipeline). Replace `terrain.sample(lon, lat, dem.levels[0].z)` with `terrain.ground(lon, lat)`.
   - Spec: a `loadScene` with a loader that returns `undefined` for level-0 tiles and real tiles for level 1 gives a finite ground equal to the level-1 sample. Today it throws.
   - Bit-identical whenever the level-0 tile covers the fix, because `ground` → `sampleAt(…, 0)` → `levels[0]` first.
   - The unknown-pose and baseline workers then work outside regional coverage, at z12 accuracy for the camera ground.
2. **`src/lib/dem/load.ts:39-63`** (this pod, but the behaviour belongs to the solve path). Give `fetchDemTileCached` the same `validateTile(h, size, ∞)` fill as `demRasterFromBytes`.
   - Behind a flag (`demWorkerFill`), or proven bit-identical by a scan over the cached tiles for all 19 bench locations; the scan above found 0 no-data tiles.
   - The ancestor fallback for the worker is optional: `TerrainSampler`'s level fallback already covers it, except at z15/z14 holes inside z13 coverage.
3. **Eye rule** (eye-rule pod; `deck/scene.ts`, `geo/pipeline.ts`). Export one `eyeAltitude(alt, dem)` from a dependency-free module (`gpu/eye/suggest.ts` inlines it "so the worker does not pull in three.js"). Make `loadScene`, `suggest.ts`, the ridgelines worker and `ndsm.ts` call it.
   - **User decision:** the no-GPS-altitude case is +1.8 m in the engines and +1.6 m in the CPU pipeline. Either unify on 1.8 m (the render), or on 1.6 m (the pipeline, the ground truth's `eyeSource: "dem+1.6"`, `EYE_ABOVE_GROUND`).
4. **`src/lib/geo/terrain.ts:76-81`** (dem-horizon). Add a one-tile memo per zoom in `pixel()`, caching only hits so a tile added later to a shared map is still seen. That is `FastSampler`'s code, measured bit-identical over 917 280 samples. Then delete `scripts/geocam/lib.ts FastSampler` and switch `horizon-fast/march.ts:495` to `sampler.tileSet`.

## 6. Gipfelbuch corrections (graph.ts and pages are peer-owned; text only)

- **terrain-sampler summary**: "Tiles around the GPS fix load at several zooms (z15 near the camera to z9 at 150 km); heights are blended bilinearly from the four nearest pixel centres, falling back to coarser zooms where a tile is missing. The horizon, peak visibility and the solvers ask it; the 3D view asks its own twin over the streamed tiles (TerrainSet.heightAt, or the GPU height gather)."
- **terrain-sampler modules**: add `src/lib/dem/grid.ts` (the shared `sampleGrid`) and `src/lib/deck/terrain-data.ts` (`TerrainSet.heightAt`, which the render, peaks and trails use).
- **terrain-sampler page** (`src/lib/gipfelbuch/pages/terrain-sampler.tsx` ~l.1570, "Same tiles as the 3D view"): replace with "The 3D view streams the same Mapterhorn tiles with the same ancestor fallback, but samples the finest tile it has (up to z17) and fills no-data pits; the solver's workers sample by distance band. On the bench locations the two camera grounds differ by under half a metre."
- The **"Where a tile does not exist"** step describes `loadDemTile` (the page), not the worker loader, which leaves a hole and lets the next level answer.
- **terrain-snapping summary**: "…the eye sits at least standing height above ground (and, with `?geoLakeFloor=on`, not below a still lake)…". The lake floor is off by default (`flags/index.ts:189`).

## 7. Landed

- `6076dcb` U1 + U4: `heightFromTile` and the near-field uv sampler call the shared `sampleGrid` (bit-identical; specs pin it against the removed copies).
- `b568ed0` U2: conformance spec for the CPU height samplers (interior agreement, seam clamp vs blend, missing-tile fallback). `loadScene` without the finest level pins the P1 throw.
- `30f95bf` U3: the engines' lake floor gets the DEM at the fix (NaN when there is none), not the GPS-altitude stand-in; flag `geoLakeFloor` stays off. This is browser-unverified and has a ledger row. On rebase, master's db5b4d5 had already split out `demHere`, so the hunk reduces to the `lakeFloor` argument.
- `68e2c99` this plan.

Gates before landing (worktree, rebased on master): `npx vitest run src/lib/dem src/lib/nearfield src/lib/geocam` 636/636; `npx tsc --noEmit -p .` clean; biome clean on the 8 changed source files; `spdx` and `kernel-binding-use` PASS. The `unit` row failed only on peer and environment specs: `src/lib/upload` (Vite denies the libheif import through the symlinked `node_modules`) and the `tools/matcher` Python suites (their coloured output does not match the `OK` regex).

## 8. Next steps

- **One ground zoom per question.** Eye-rule landed d5cccc1 (`src/lib/geo/eye-rule.ts`, one eye rule), but its plan (`reports/steps-2026-10-02/eye-rule.md` finding 4, unit U5) notes that each consumer reads the ground at the fix from a different DEM zoom: z14 `heightFromTile` (fast horizon), z15 `terrain.sample` at `levels[0]` (baseline and unknown-pose workers), z16 NearDem (Step Inside), z17 `TerrainSet.heightAt` or the GPU gather (engines, roll). That is a sampler concern. The plan: measure the ground-at-fix spread across z14–z17 and the gather for the 12 demo and dev photos (node over the tile cache; report only). Then, if the spread exceeds the eye tolerance, give the sampler one `groundAtFix(lat, lon)` that every consumer calls (finest available zoom, with ancestor fallback). Gate: bit-identity where the zoom already matches, and the precision gate for the solve-path consumers (behind a flag).
- P1 (baseline-pipeline pod) and P4 (dem-horizon pod) are still proposals (§5.1, §5.4). P2 waits for a flag or a byte-equality scan. P3 is mostly done by d5cccc1; the 1.6 vs 1.8 m constant is still the user's call.
- P5: verify Mapterhorn registration and datum from its pipeline code.
