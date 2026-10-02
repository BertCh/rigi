# Step ⑪ dem-horizon: review, research, plan (2026-10-02)

Owner: Opus step lead (coordinator mt-image-17 step pods). Node `dem-horizon` in `src/lib/gipfelbuch/graph.ts:97`
("Far ridges are the fingerprint."). Modules on the node: `src/lib/geo/horizon.ts`, `src/lib/geo/terrain.ts`
(shared with `terrain-sampler`; this step edits it, terrain-sampler proposes). No other node lists
`src/lib/horizon-fast/**`, `src/lib/gpu/horizon/**` or `src/lib/integration/horizon-fast-app*.ts`, so this
step reviewed them as the rest of the horizon (GPU island I3).

All numbers below are dev diagnostics on the 12 hand-registered photos or synthetic data, never results.

## 1. Current state (end to end)

| Stage | Where | What it does |
|---|---|---|
| Tiles → sampler | `src/lib/geo/terrain.ts:24` `TerrainSampler`, `:93` `loadTerrain` | Terrarium/Mapterhorn tiles at 3 zooms (z13 ≤4 km, z11 ≤40 km, z10 ≤150 km, `src/lib/dem/sources.ts:15`), bilinear, NaN for missing tiles, coarser-level fallback |
| CPU f64 reference march | `src/lib/geo/horizon.ts:40` `computeHorizon` | 7,200 azimuths × ~1,270 distances (20 m → 150 km, step max(10 m, 0.4 % d)), t = atan2(h − h₀ − d²/2R′, d), R′ = R/(1 − k), k = 0.13 (`src/lib/geodesy.ts:20`); ridge crests where terrain re-emerges ≥ 8 % farther. Used by scripts (eval/baseline/bakes), the engines' fallback (`src/lib/deck/cpu-geometry.ts`) and `sceneHorizon`'s fallback (`src/lib/geo/pipeline.ts:69`) |
| CPU fast twin | `src/lib/horizon-fast/march.ts` `computeHorizonFast`, `mosaic.ts` | per-ring Float32 Mercator mosaics, piecewise great circle, step max(3.5e-4·d, min(cell/2, 1 %·d), 0.25 m), conservative max-mip block skipping (Tevs et al. 2008). `sceneHorizon` (unknown-pose, /baseline) uses it via `computeHorizonFastCompat` |
| GPU march (I3) | `src/lib/gpu/horizon/{index,graph,horizon.wgsl}.ts` | WGSL twin of `marchRay`, one invocation per (eye, azimuth), ComputeGraph per chunk; mips on the GPU (`mosaic-mips.ts`, flag `mosaicGpu`, on) |
| Certified f32 stages | `src/lib/gpu/horizon/certified*.ts`, `dirs-cpu.ts` | tan → degrees (D7) and ENU / 8192-column resample (D8) in double-f32 with tracked bounds; uncertified outputs recomputed by the f64 code (tie path). Flag `horizonPrecision=certified-f32` (default) |
| App worker | `src/lib/integration/horizon-fast-app{,.worker}.ts` | page fetches tiles, one-shot worker builds LITE_RINGS mosaics for the yaw wedge (or 360°), marches on the GPU (`gpuHorizon`, on) or CPU, returns ENU unit directions; cap **120 km** (`horizon-fast-app.ts:176`) |
| Unknown-pose | `src/lib/gpu/horizon/scene-profile.ts` | 360° profile at 150 km fused with the coarse GPU solve (`unknownGpu`) |

Gates today: `src/lib/geo/__tests__/{horizon,terrain}.spec.ts`, `src/lib/horizon-fast/__tests__/{march,mosaic}.spec.ts`,
`src/lib/gpu/horizon/__tests__/*` (115 specs pass), fast CI rows `horizon-cert`, `mosaic-mips`, `unit`.

## 2. Findings (ranked)

### P1
- **F1 App worker lifecycle (horizon-fast-app.ts).** `fail()` did not terminate the worker (60–116 MB of
  mosaics alive until `dispose()`); an already-aborted `signal` never fired its listener; one waiter per
  eye meant a duplicate `dirs(eyeH)` hung, and `dirs()` after the worker finished never resolved. The deck
  engines mask this with a 10 s timeout. → unit U2.
- **F2 CPU reference march is slow (5.1 s per eye in node).** It is the reference for every script and the
  engines' fallback. Per sample it ran `destination()` (8 trig) and four string-keyed tile lookups. → U1
  (landed, 2.4×, bit-identical).

### P2
- **F3 Range cap vs high eyes.** The app caps at 120 km, the reference at 150 km. Dev diagnostic
  (`computeHorizon` at 150 km vs 120 km, step 0.25°): Niederhorn photos (eye ≈ 1,930 m) have the skyline
  beyond 120 km in 3–5 % of azimuths with up to 0.15–0.19° (≈ 4–5 px) between the two caps; Klingenstock
  (IMG_7155, 1,918 m) 12 % with up to 0.28°; Stoos village 0.2–0.3 % (≤ 0.007°); lake-shore eyes 0 %. La Palma (eye 2,408 m) has the sea horizon at ≈ 188 km
  (√(2R′h)), so 93 % of azimuths sit at the cap and the 120 km cap lowers the modelled sea horizon by
  ≈ 0.15° vs the true dip (150 km: 0.037°). **Inside the frames** (`scripts/horizon-far-field.ts`, long-side
  FOV at the GT yaw, step 0.1°): the three Niederhorn → Justistal/NE views (IMG_7059/7063/7068) have
  13–22 % of the in-frame skyline beyond 120 km and move by up to 0.15–0.21° (≈ 4–5 px) between the
  caps; La Palma 72 % / 0.11°; IMG_7131 1.4 % / 0.008°; the other 9 photos 0 %. For comparison the
  refraction band k = 0.07…0.20 moves the in-frame skyline by ≤ 0.048° on every photo. So the range cap
  is the largest far-field model error we found, about 4× refraction. (IMG_7063/7068 are rejected by the
  simple solver in the node eval, which already marches to 150 km, so the cap does not explain that; the
  app's 120 km wedge on them is untested. The 150 km reference is itself truncated for these eyes: the
  far terrain keeps rising past it in some azimuths.) Any change moves the solve → opt-in flag + dev gate (plan U6).
- **F4 GPU/CPU segmenting duplicated.** `gpu/horizon/index.ts:271` `segments()` is a copy of
  `march.ts` `makeCtx` breakpoints; `(1 − k)/(2R)` duplicated (`index.ts:511`, `march.ts:182`). They match
  today; one shared function + a spec removes the drift risk. → U3.
- **F5 Pure-CPU parts of I3 without Vitest specs:** march parameter packing and `segments()`
  (`index.ts`), `opt-in.ts` / `unknown-opt-in.ts` resolution, `scene-profile.ts` `tileSetKey` + LRU,
  `mipDims` vs `buildMosaic`'s `min(8, log2 T)` levels (equal only for T ≥ 256). → U3.
- **F6 Precision wording.** `opt-in.ts:25` "Both give the same bits" and the flag text read as an
  unconditional guarantee; the README (`:202`) says identity rests on probe + certificate + random spot
  checks (`spotCheckA/C` use `Math.random`). Soften to "bit-identical by certificate, spot-checked". → U3.

### P3
- **F7 Doc drift.** `horizon-fast-app.ts:5-7,20` said the old GPU render horizon was the fallback (the
  engines fall back to the CPU profile horizon) and called it a CPU skyline (GPU by default) → fixed in U2.
  `horizon.wgsl.ts:6` cites a non-existent `packParams`. Manifest rows `horizon-march` omit
  `horizon.wgsl.ts`/`uniforms.ts`, `horizon-cert` omits `dirs-cpu.ts` (manifest is pod D's area: proposal only).
  GPU-vs-CPU benign differences (skip floor `max(dt+1e-3, dt·(1+2.4e-7))` vs `d+1e-3`; uncompensated `d`
  in the loop test) are not in the README's differences list.
- **F8 NO_DATA bilinear bleed.** A tap blending a NO_DATA (−32768) neighbour with weight < ~8 % stays
  above `MIN_VALID` (−1000) and is accepted as a too-low height (`march.ts` bilinear, same in WGSL). It
  can only lower terrain at coverage edges; CPU and GPU agree, so no change (a fix would break GPU/CPU
  parity for no measured gain).
- **F9 Reference vs fast twin semantics.** `computeHorizon` treats NO_DATA pixels as −32768 m (only NaN is
  skipped), the fast twin drops them. Only differs on rays with no valid terrain at all. No change.
- **F10 Dead exports:** `computeHorizonAuto`, `spotKeyA`, `spotKeyBC`, `K_CERT_A/B/C`, `MOSAIC_MIP`
  exported without outside importers (keep or un-export in a GPU pass; pod D's area).
- **F11 `marchLocked` allocates 7,200 empty ridge arrays per eye**; `uploadMosaics` builds mips even for
  `ridges.ts` and `mipSkip: false`. Startup-only cost; later.

Checked and fine: curvature/refraction (one model everywhere: drop d²/(2R′), ENU lift k·d²/2R in
`geodesy.ts:95`); arc-vs-chord and sphere-vs-ellipsoid errors (≤ 0.001°); mip skip bound is conservative
(near distance for a ≥ 0, far for a < 0; 2×2 cells for the bilinear footprint); the certified tie path
covers every uncertified output and every failure (no device, probe fail, GPU error) returns the f64 path.

## 3. Research summary

Our record (never redo): DemStore decode-once (negative, `reports/negative-results.md:121`), page-device
horizon march (negative, `:122`), coarse-first alignment (display-only, `:112`), bit-identity precision gate
(unusable, `:130`), SKYPAR wrong-eye test (killed, `:102`), branch-and-bound skyline search (`:52`). GPU
horizon p99 ≤ 2e-4° vs CPU, 6–25 ms per eye (`research_notes/gpu_compute_plan_2026-09.md:35`). No record
of k ever being varied or fitted.

External: max-mipmaps (Tevs, Ihrke, Seidel, I3D 2008) is what the march already does. Stewart 1998
(all-points horizons) targets shading every DEM sample, the wrong shape for few eyes × 7,200 rays.
Photo-to-terrain alignment (Baboud et al. 2011; Baatz et al. 2012; Saurer et al. 2016, IJCV "Image based
geo-localization in the Alps") all render DEM silhouettes with a fixed standard refraction. Refraction:
k = 0.13 is the geodetic standard; near the ground k swings from −4 to +16 on sunny days (Hirt et al.
2010, JGR), and long alpine sight lines over valleys sit roughly at 0.1–0.25 with inversions higher.

Magnitudes (Δangle ≈ d·Δk/2R): k ± 0.1 gives 0.011° / 0.022° / 0.034° at 50 / 100 / 150 km (≈ 0.3–0.8 px
at 0.04°/px); k ± 0.3 (inversion) 0.03–0.10° (0.8–2.5 px). Sphere vs ellipsoid ≈ 0.001° at 150 km. A 30 m
DEM bias is 0.034° at 50 km. So the dominant far-field errors are range truncation (F3) and DEM ridge
error, then refraction under inversions; the geometry is not the bottleneck.

Sources: Tevs et al. 2008 https://pure.mpg.de/pubman/item/item_1325622_5/component/file_3590464/i3d08.pdf ;
Stewart 1998 https://www.dgp.toronto.edu/public_user/jstewart/papers/tvcg97.html ; Baboud et al. 2011
https://resources.mpi-inf.mpg.de/photo-to-terrain ; Baatz et al. 2012
https://mlanthology.org/eccv/2012/baatz2012eccv-large ; Hirt et al. 2010
https://forschungsportal.hcu-hamburg.de/en/publications/monitoring-of-the-refraction-coefficient-in-the-lower-atmosphere--4/

## 4. Plan

| Unit | What | Size / risk | Gate | When |
|---|---|---|---|---|
| U1 | `computeHorizon` hoisted trig + one-tile bilinear in `TerrainSampler.sample`; `mosaicsFromSampler` uses `tileSet` | S / none (bit-identical) | sha256 of elevation, distance, ridges on 2 photos; bit-identity spec; tile-edge spec | now |
| U2 | app worker lifecycle fixes + specs + header doc | S / low (rendering path, browser-unverified) | vitest integration, tsc | now |
| U3 | shared `marchSegments` (CPU + GPU), specs for packing/opt-in/scene LRU/mipDims, precision wording, README differences, `packParams` comment | M / low (GPU host code; segment output identical) | spec equality of segments, vitest gpu/horizon, `horizon-cert`, `mosaic-mips` rows | now |
| U4 | k sensitivity band: horizon at k = 0.07 / 0.20 per eye as a diagnostic (`scripts/`), and a far-ridge spread for the verifier | M / none if diagnostic only | dev numbers only | later |
| U5 | per-photo k as a bounded nuisance parameter after the solve (flag `horizonK=fit`, off) | M / medium (solve path) | wild dev-set accept rule, 0 new false accepts | later, needs a gate owner |
| U6 | eye-adaptive range: maxDistance from the eye's geometric horizon (e.g. min(250 km, √(2R′(h₀ − h_min)) + margin)), flag `horizonRange=auto`, off; first check which F3 azimuths are inside the frames | M / medium (tiles + memory + solve) | dev eval accept/false-accept; tile and memory budget | later |
| U7 | dead-export trim + manifest paths for I3 | S / none | tsc, app-graph check | with pod D |

Needs the user: whether U5/U6 are worth a wild-set gate run (both change the solve, both are opt-in until
then); whether the app's 120 km cap (memory: ~60 MB wedge) may grow for high eyes.

## 5. Gipfelbuch corrections (graph.ts is not ours to edit)

- `summary` (graph.ts:107): "Rays in 7,200 directions find the highest ridge in each (about 3.5 s, off the
  main thread)." In the app the march runs on the GPU in a worker (tens of ms per eye, out to 120 km in the
  yaw wedge; 150 km for the 360° unknown-pose profile), with certified-f32 post stages. The CPU f64 twin
  takes about 2 s per eye after U1. Suggested: "Rays in 7,200 directions find the highest ridge in each, on
  the GPU in a worker (tens of milliseconds), with a CPU twin that gives the same profile. Every skyline
  match fits against this curve."
- `modules` should also list `src/lib/horizon-fast/march.ts`, `src/lib/gpu/horizon/index.ts` and
  `src/lib/integration/horizon-fast-app.ts`, which are what the app runs.
- `src/lib/gipfelbuch/pages/dem-horizon.tsx:840,1832`: "out to 150 km" is the reference march; the app's
  aligned view uses 120 km.

## 6. Proposals received (terrain-sampler pod, §5.4 of its plan)

- `mosaicsFromSampler` via `tileSet`: **done** in d6a83a7.
- One-tile memo per zoom in `TerrainSampler.pixel()` (and deleting `scripts/geocam/lib.ts FastSampler`):
  **declined for terrain.ts.** d6a83a7 already cuts the four lookups per sample to one when the taps share
  a tile; a memo on top measured ≈ 5 % more on the 2-photo bench, and a hit-only memo still returns a
  stale array if a shared map ever replaces a tile under the same id. `FastSampler` lives in the geocam
  scripts (not this step); with d6a83a7 it can switch to `TerrainSampler` if its owner wants.

## 7. Landed / negative / next

Landed (master):
- **d6a83a7** U1 `geo/horizon`: `computeHorizon` 5.1 s → 2.1–2.3 s per eye in node (IMG_6958, IMG_7155),
  sha256 of elevation + distance + ridges identical; bit-identity spec (mutation-tested: a `/ DEG` →
  `* 180/π` change turns it red); tile-edge/corner/missing-neighbour sampler spec.
- **6ba4b45** U2 `horizon-fast-app` worker lifecycle (F1) + 5 specs + header fix (F7). Browser-unverified.
- **0ca2aed** U3 one `marchSegments` / `marchInv2R` for the CPU and GPU march (F4) with equality specs
  over 4 latitudes × 2 eps × 3 ring layouts; `opt-in.spec.ts` (full flag table, F5); `mipDims` vs
  `buildMips` for T = 256/512/1024 (F5); README "GPU march vs CPU march: benign differences" (F7);
  `horizon.wgsl.ts` header fixed. Browser-unverified (host code; segment output identical).
- **5d19fd7** U4 `scripts/horizon-far-field.ts` (F3 numbers above).
- **(this commit)** iteration 2 after an independent adversarial review (no P0–P2 found in the four
  commits): the worker client stops posting tiles and `build` once the worker is gone (spec);
  `opt-in.ts` precision wording says certified outputs carry the f64 stage's bits only where the
  certificate holds, and that the march itself is not bit for bit; the far-field script's azimuth wrap
  handles any yaw; this plan doc.

Negative / not done: the per-zoom sampler memo (≈ 5 %, staleness risk); a `levelFor` precompute in
`computeHorizon` (no measurable gain, dropped); `scene-profile.ts` LRU spec (needs a device or an
export; left); `unknown-opt-in.ts` spec (one line, covered by the table).

Ledger rows (browser-unverified commits; `reports/batch-ledger.md` was held by a peer's uncommitted
edit when these landed, so the rows are here for the coordinator to copy):

| Session | Commit / files | What changed | What the batch pass should check | Risk |
|---|---|---|---|---|
| step dem-horizon (U2) | 6ba4b45 (`src/lib/integration/horizon-fast-app.ts`) | worker terminates on failure / pre-aborted signal, per-eye waiter lists, `dirs()` after finish rejects; no posts after termination (iteration 2) | `/photo/demo-09?renderer=webgpu` and `?renderer=deck`: auto-align traces the horizon (`horizonSource: "fast"` in metrics), no console errors; leave mid-load and come back; `?gpuHorizon=off` | low |
| step dem-horizon (U3) | 0ca2aed (`src/lib/gpu/horizon/index.ts`, `src/lib/horizon-fast/march.ts`) | GPU march takes its segments from the shared `marchSegments` (same values) | `/photo/demo-09?renderer=webgpu`: skyline overlay and auto-align yaw unchanged; `scripts/gpu/horizon-bench.mjs` parity in the batch | low |

Next (top 3):
1. **U6 eye-adaptive horizon range** behind `horizonRange=auto` (off): the in-frame cap error (≤ 0.21°,
   ≈ 5 px on three Niederhorn photos, 0.11° on La Palma) is the largest far-field model error found,
   about 4× the refraction band. Needs a tile/memory budget and a dev-gate owner (user decision).
2. **U4b refraction band as a verifier signal**: per-eye k = 0.07 / 0.20 profiles are cheap on the GPU;
   expose the far-ridge spread as an uncertainty, not a correction. Per-photo k fitting (U5) only after.
3. **U7** dead exports in `gpu/horizon` (`computeHorizonAuto`, `spotKeyA/BC`, `K_CERT_*`, `MOSAIC_MIP`)
   and the manifest `paths` for I3, together with pod D.
