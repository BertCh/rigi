<!-- Rigi -->
<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: Copyright (c) Rigi contributors -->

# Step ⑧ dem-source: "Sharper tiles keep summits sharp" (2026-10-02)

Step lead: Opus pod, coordinator mt-image-17. Node `dem-source` in `src/lib/gipfelbuch/graph.ts:306`. Rules: scratchpad `STEP-RULES.md` (cook mode: no browser runs; rendering and decode changes are browser-unverified).

## Scope and ownership

- **Node modules:** `src/lib/dem/sources.ts`, `src/lib/dem/index.ts`.
- **Also taken by this step:** the DEM files that no node lists. These are the source-format layer: `dem/decode.ts`, `dem/image.ts`, `dem/decode.worker.ts`, `dem/tiles.ts`, `dem/grid.ts`.
- **Left to terrain-sampler:** `dem/load.ts` and `dem/height-from-tile.ts`. Changes to them are proposed below.
- **Left to Pod D:** GPU ingest (`src/lib/gpu/ingest/**`, island I1). That work is reviewed here, not edited.

## Current state

| Piece | Where | What it does |
|---|---|---|
| Registry | `dem/sources.ts` | Two sources. `MAPTERHORN` is 512 px lossless WebP Terrarium, z ≤ 17, with six distance bands from z15 (≤ 1 km) to z9 (≤ 150 km). `TERRARIUM_AWS` is 256 px PNG, z ≤ 15, three bands, and is used only by `/baseline` and research scripts. URL override: `VITE_MAPTERHORN_URL` / `MAPTERHORN_URL`. |
| Browser policy | `dem/load.ts:72-123` | One Mapterhorn policy goes through the shared tile cache (`src/lib/cache`: 64 MB memory tier, 300 MB Cache API/IDB, 24 concurrent fetches, 30 s stall timeout, 404/204 negative cache). A missing tile falls back to its nearest ancestor. Known-missing ancestors are skipped. There is one immediate retry. |
| Decode | `dem/image.ts` → `dem/decode.ts:17` | `createImageBitmap` (no colour conversion, no premultiply) → 2D canvas `getImageData` → `decodeTerrarium`. Values in (−12 km, 0) clamp to 0 because AWS bathymetry is treated as the sea surface. Runs in a worker pool on the page. |
| GPU ingest (I1) | `gpu/ingest/terrarium-tile.ts`, `deck-webgpu/terrain-gpu-decode.ts` | `terrainGpuDecode` is on by default (WebGPU). The WGSL decode is the CPU twin bit for bit, including the sea clamp. If a tile has invalid pixels (`stats.invalid > 0`, `terrain-gpu-decode.ts:152`), it falls back to the CPU fill. |
| Node | `scripts/lib/node-io.ts:34` | Disk cache in `.cache/dem-<name>`. Napi-canvas decode. No ancestor fallback, because `TerrainSampler.sampleAt` falls back by level. |
| Python | `tools/matcher/dem.py:27,83`, `tools/nearfield/eyes/eyes_dem.py:73,77` | Both honour `MAPTERHORN_URL`. Their own decode has no sea clamp, which makes no difference over land at or above sea level. |
| Datum | `tiles3d/geoid.ts`, `export/camera.ts:198` | DEM heights are MSL, and the ENU frame uses them as is. Ellipsoidal tilesets and exports apply EGM2008 N (47–55 m in CH). |

## Findings (ranked)

### P1

1. **Canvas anti-fingerprinting corrupts DEM heights silently** (`dem/image.ts`, before this pass).
   - Brave farbling, Safari Advanced Fingerprinting Protection and Firefox resistFingerprinting perturb or blank `getImageData`.
   - A ±1 in R is a ±256 m spike. A blank (white) canvas decodes to 32 767 m, and `validateTile` then fills it to no data.
   - `load.ts:149` runs `validateTile` with jump = ∞, so the terrain and the deck CPU paths never repair spikes. Only the horizon-fast workers repair.
   - There was no detection and no warning.
   - **Fixed in this pass (U2: c9f7c38, then 87cfc06).** A synchronous probe runs once per realm, on the first `bitmapHeights` call: a 512 px known image goes through `putImageData` and `getImageData`. If the readback is noised, every CPU decode gets the 256 m seam repair and the realm logs one warning. Exact canvases are unchanged bit for bit.
2. **Gipfelbuch claim wording** (`graph.ts:315`). It says "on the test photos". The 25 vs 14 figure is the whole 100-photo wild set: 50 dev plus the test half, spent on 2026-09-26. Both arms were judged on Mapterhorn overlays (`bench-wild.md:159-161`). See "Gipfelbuch corrections".

### P2

3. **No backoff on 429/5xx** (`load.ts:75-92`).
   - A non-2xx that is not 404/204 retries at once, then falls back to the ancestor.
   - The cache does not remember 5xx results, so the next request for the same tile hits the server again.
   - There is no `Retry-After` handling, and the hosted endpoint publishes no rate policy (`licences.md` item 4).
   - **Proposed to terrain-sampler:** retry once after 250–1000 ms with jitter, honour `Retry-After` up to 5 s, and keep the ancestor fallback.
4. **The session `missing` set is unbounded and never cleared** (`load.ts:72`). It is harmless at current scale, since the pyramid is nested and each uncovered region costs one probe per level. A self-host that 404s while it is still syncing would poison the session. Proposal: clear the set on `configureTileCache` and `clearTileCache`.
5. **The manifest says `ingest-terrarium` is "not wired"** (`gpu/app-graph/manifest.ts:234`). Its helpers (`addHeightsToTexture`, `terrariumInputDescriptor`, `upload.ts`) are imported by the wired `terrarium-tile.ts`. Only the one-shot `decodeTerrariumTileGpu` API is harness-only, used by `selftest.ts`. This is doc drift, for Pod D.
6. **The ~4× upload bytes of `terrainGpuDecode` are still open** (`negative-results.md:129`). This is Pod D's area and is not re-measured here.

### P3

7. **The sea clamp also flattens land below sea level** (`decode.ts:22`, WGSL twin `terrarium-tile.ts:87`). Examples are the Dead Sea at −430 m, the Caspian shore at −28 m and Dutch polders. Mapterhorn carries no bathymetry: there were no negative values in the 54 decoded tiles sampled below. A clamp per source needs the GLSL/WGSL twin and spec changes, and it matters only outside the Alps. Later.
8. **`tilesAround` does not wrap the antimeridian or clamp y at the poles** (`tiles.ts:51`). Wrapping x would move tiles 360° in consumers that place them from x, which is worse than the 404s they get today. Clamping y is safe but has no user. Left as is.
9. **Self-host URL template** (`sources.ts`): `.replace` filled only the first `{z}`/`{x}`/`{y}`. **Fixed in this pass (U1).**
10. **Terrarium decode copies:** `scripts/terroir/lib/dem.ts:73` and the two Python decoders. They are research and offline tools, so a shared module is not worth a cross-language dependency. Noted only.

### Reviewed, not a bug

- **GPU decode exactness:** the input is `rgba8unorm`, read with `textureLoad` plus `round(clamp·255)`. The proof is `terrarium-f32.ts`: every partial sum is exact in f32. Invalid pixels route to the CPU fill.
- **Mapterhorn quantization:** heights are rounded to `min(1, 2^(19−z)/256)` m (Mapterhorn `pipelines/utils.py`, `get_rounded_elevation_data`). This was measured on 54 cached tiles, z9–z17: whole metres at z ≤ 11, 0.5 m at z12, down to 1/64 m at z17. That is at most 0.5 m of error, under 0.001° at 40 km.
- **Vertical datum:**
  - Mapterhorn reprojects only horizontally, so each source keeps its native heights: swissALTI3D in LN02, Copernicus GLO-30 in EGM2008. Both are "above sea level" to metre level, while the ellipsoid is about 50 m away.
  - The app treats DEM heights as MSL and converts at the ellipsoidal edges (`tiles3d/geoid.ts`, export).
  - EXIF altitude is documented as MSL (`geo/photo-meta.ts:29`, "EGM2008 on iOS"). Android reports it above the ellipsoid. That belongs to the eye-rule step, which should treat EXIF altitude as an uncertain-datum prior.
- **Zoom bands:** every band edge sits at about 0.1° per DEM post (z15 at 1 km is 1.6 m per pixel, z11 at 15 km is 26 m per pixel). Finer near-field DEM was already tested and killed (FUND E3, `negative-results.md:59`). The node-only check below confirms the bands are adequate.

## Research summary

Source: a Sonnet research sweep; the URLs are its sources.

- **Mapterhorn v0.0.13** (2026-09-11):
  - Lossless WebP. Sources are blended with a Gaussian ramp along their boundaries. There is no vertical-datum harmonisation.
  - CH: swissALTI3D 0.5 m, plus Zürich 0.25 m. FR: LiDAR HD 0.5 m / RGE ALTI 1 m. IT: TINITALY 10 m, plus regional 2–2.5 m. AT, DE: 1 m. Copernicus GLO-30 elsewhere.
  - No usage policy is published. Links: github.com/mapterhorn/mapterhorn (`pipelines/utils.py`, `aggregation_reproject.py`), mapterhorn.com/data-access, download.mapterhorn.com/attribution.json.
  - `reports/licences.md` says "151 sources" for v0.0.13. The research read 580 entries in the live `attribution.json`; this is not reconciled.
- **Alternatives:** none beats Mapterhorn in the Alps.
  - swissALTI3D, TINITALY, BEV and the German state DEMs are already inside it.
  - Copernicus, AW3D30 and NASADEM are coarser.
  - Mapbox Terrain-DEM (SDK-only), MapTiler (paid), Cesium World Terrain (no offline use without a licence) and Esri are restricted.
  - FABDEM stays banned (NC).
- **Datums:**
  - EGM2008 N is about 50 m in CH (45–55 m).
  - LN02 differs from LHN95 by up to 0.4 m.
  - iOS `CLLocation.altitude` is MSL (EGM2008). Android `getAltitude` is ellipsoidal (`AltitudeConverter` since API 34).
- **Literature:** Baboud et al. 2011 credit their accuracy to a high-resolution DEM but give no ablation. GeoPose3K and LandscapeAR report no DEM-resolution ablation either. The in-repo Terrarium → Mapterhorn swap (14 → 25 correct) is the only DEM-resolution evidence we have.
- **Client-side:** pmtiles JS (range reads of one archive) or an OPFS cache would make the app fully offline-capable. Either is a new npm dependency, so it is a user decision. The current Cache API tier (300 MB) already serves revisits offline. The ancestor fallback then degrades to cached coarser tiles.

## Plan (units)

| Unit | What | Size / risk | Gate | When |
|---|---|---|---|---|
| U1 | `tileUrlFromTemplate` (replaces every placeholder), spec; verified height facts in the `sources.ts` doc | S / none: the default URL is unchanged | `vitest src/lib/dem`, tsc | **now** |
| U2 | Canvas readback probe (`dem/image.ts`). On a noised canvas: warning plus 256 m seam repair in `bitmapHeights`/`blobHeights`. Exact canvas: bit-identical | S / low: only noised realms change | specs with stubbed canvas; browser batch: Chrome probe = exact, Brave (standard shields) = noised | **done** (browser-unverified) |
| U3 | Node band-sensitivity script `scripts/dem/band-sensitivity.ts`: base vs one zoom finer vs Terrarium horizons at the demo and GT viewpoints | S / none (research) | runs in node | **done** |
| U10 | Node DEM loader (`scripts/lib/node-io.ts:43`): no retry, so one S3 socket reset kills a whole run (seen once this pass) | XS | — | later (scripts owner) |
| U11 | Repair only small components in the noised path (farbling gives isolated pixels): `validateTile` would need a max-component-size option | S | decode spec | later, if the browser batch finds Brave/Safari noised |
| U4 | `load.ts` backoff on 429/5xx with `Retry-After`; `missing` cleared with the tile cache | S / low | load.spec cases | terrain-sampler pod (proposal above) |
| U5 | Manifest status of `ingest-terrarium` → "helpers wired, one-shot API harness-only" | XS | app-graph check | Pod D |
| U6 | Source-aware sea clamp (no clamp for Mapterhorn), CPU + WGSL twin + specs | M / low outside the Alps | ingest.check + decode spec | later |
| U7 | Mapterhorn seam audit: z12 heights across the CH/FR, CH/IT and CH/AT borders, to look for datum steps between sources | S / none (research, node) | script output | later |
| U8 | Offline: pmtiles archive / OPFS tier for field use | M / needs a dependency | — | **user decision** |
| U9 | Mapterhorn at production traffic: ask the maintainers or self-host (CH z13–17 is 615 GB) | — | — | **user decision** (already `licences.md` item 4) |

## Gipfelbuch corrections (for the Gipfelbuch owner; graph.ts and the pages are not edited here)

- **`graph.ts:315` summary.** Current: "…On the test photos, 25 solved correctly on Mapterhorn against 14 on Terrarium." Proposed:
  > Mapterhorn (512 px lossless WebP tiles to zoom 17; swissALTI3D at 0.5 m in Switzerland, Copernicus 30 m where no national survey exists) is the default. AWS Terrarium (256 px, zoom 15, ~30 m) smooths summits and is kept for comparison. On the 100-photo wild benchmark, the same cascade solved 25 correctly on Mapterhorn against 14 on Terrarium.
- **`graph.ts:316` modules.** Add `src/lib/dem/decode.ts` and `src/lib/dem/image.ts`. They are the source-format layer, and no node lists them today.
- **`pages/dem-source.tsx:1042`.** "On 100 test photos, drawing on the wrong map moved the horizon by 1 to 27% of image height" should read "On the 100-photo benchmark, drawing near-field skylines on the wrong map moved them by 1 to 27% of image height (median about 1.3% on the spot-checked photos)" (`bench-wild.md:22`).

## Measured this pass

These are DEM-only sensitivities, not accuracy results. Source: `tools/research/dem-bands/RESULT.txt`, from `npx tsx scripts/dem/band-sensitivity.ts [--positions gt]`. Eye = ground + 1.6 m; horizon step 0.05°, 7200 azimuths per viewpoint. The GT positions are used for location only and are printed at 0.1°. No pose was read and no sealed data was used.

| Pool | Arm | median | p95 | p95, < 2 km | max |
|---|---|---|---|---|---|
| CH, 4 GT viewpoints (lake level to 2.4 km) | one zoom finer − base | 0.006° | 0.05° | 0.11° | 0.27° |
| CH, 4 GT viewpoints | Terrarium − Mapterhorn | 0.15° | 3.7° | 7.9° | 9.0° |
| other, 6 GT viewpoints (US, CA, La Palma) | one zoom finer − base | 0.004° | 0.09° | 0.16° | 1.5° |
| other, 6 GT viewpoints | Terrarium − Mapterhorn | 0.08° | 9.5° | 12.1° | 23.7° |
| demo, 1 viewpoint (Niederhorn summit) | one zoom finer − base | 0.014° | 0.15° | 0.32° | 0.94° |
| demo, 1 viewpoint | Terrarium − Mapterhorn | 7.7° | 27° | 25° | 29° |

- **The bands in `MAPTERHORN.levels` are adequate.** One zoom finer everywhere moves the CH skyline by a p95 of 0.05°. That is below the GT noise (0.2–0.4°) and about one photo pixel, and it agrees with FUND E3. No change is proposed.
- **Terrarium is wrong mostly in the near field.** Beyond 15 km it agrees with Mapterhorn (CH p95 0.15°). Under 2 km it is off by degrees.
- **At the Niederhorn summit**, Terrarium's ground is 48 m low. Even with the Mapterhorn eye, the skyline is still about 9° off under 2 km. This fits the 14 → 25 cascade gain and the Gipfelbuch claim, though this run does not prove that link.
- **Quantization:** Mapterhorn rounds heights to `min(1, 2^(19−z)/256)` m. This was checked in the pipeline code and on 54 decoded cached tiles (see "Reviewed, not a bug").

## Landed

| sha | What |
|---|---|
| 74db489 | U1: `tileUrlFromTemplate`, which fills every `{z}`/`{x}`/`{y}` of a self-host template, with a spec; the verified rounding and vertical-reference facts in the `MAPTERHORN` doc |
| c9f7c38 | U2: canvas readback probe and the 256 m seam repair on noised canvases, with specs (browser-unverified, ledger row) |
| 87cfc06 | U2 iteration 2, after an adversarial Sonnet review. The probe is now synchronous, so it runs on the first `bitmapHeights` call and the GPU ingest's lazy CPU heights (`terrarium-tile.ts:455`) no longer depend on call order. It probes a full 512 px tile instead of 64 px, against sparse noise. A wrong-size readback throws instead of decoding garbage. Specs updated (browser-unverified, ledger row). |
| (this commit) | U3: `scripts/dem/band-sensitivity.ts` with `tools/research/dem-bands/RESULT.txt`, and this plan |

**Iterations.**

1. Review and research, then U1 and U2.
2. An adversarial review of U2 found one medium issue (the GPU-ingest order dependence) and two low ones (probe size, empty readback). All three are fixed in 87cfc06.
3. U3 first ran at n = 1: all 12 demo photos sit within 200 m of each other. It was extended to the GT positions.

The reviewer's remaining low items are deliberately left alone: one warning per worker realm (4–6 lines), and `validateTile` able to shift an enclosed real butte with 216–296 m walls in noised realms only (see U11).

**Negative / no-change results.**

- Finer bands buy nothing; see "Measured this pass".
- No alternative DEM source beats Mapterhorn in the Alps under a commercial-OK licence.
- Wrapping `tilesAround` at the antimeridian would be harmful.

## Open decisions for the user

1. **Mapterhorn at production traffic:** ask the maintainers, or self-host (`licences.md` item 4; CH z13–17 is 615 GB). This stays open.
2. **Offline field use:** a pmtiles reader or an OPFS tile tier would be a new npm dependency. Today the 300 MB Cache API tier plus the ancestor fallback already serve revisits offline.

## Next (top 3)

1. Terrain-sampler pod: U4, backoff on 429/5xx with `Retry-After`, and clear `missing` along with the tile cache (`load.ts:72-92`).
2. Browser batch: check the U2 probe in Chrome (expect exact), Brave with standard Shields, and a Safari private window.
3. The Gipfelbuch owner applies the corrections above. N5, re-annotating GT on Mapterhorn, stays the biggest DEM-related accuracy confound (`roadmap.md:30`).
