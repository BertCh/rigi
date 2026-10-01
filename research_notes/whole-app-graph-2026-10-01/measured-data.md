# Rigi GPU command-graph plan: existing measurement data

Compiled 2026-10-01, read-only. Everything is Chrome / Apple GPU (Metal), headless Chromium unless noted.
M = measured (file cited), E = estimated or inferred by me. Dates are the file/commit date.
Staleness warning: most out/gpu benches ran 2026-09-30, BEFORE the graph became the only/default GPU path
(haze/relief/guided/band stats e407c14, horizon 00c027e, align e4fb573/e97879d, skyglobal cc818b0 on 2026-10-01).
Only a local gate-data archive (not published; 2026-10-01, HEAD 320b87d) post-dates some of them.
No browser run has happened since the user put testing on hold, so every 10-01 commit with "browser gates pending"
(silhouette GPU re-rank, geometry diet, relief bridge, band-stats fenced readback, photoprep GPU, sky prep) has NO timing.

## 1. Per-stage table

Sources abbreviated: P = out/gpu/core/profile.json (2026-09-30, timestamp-query kernel ms); LB = out/gpu/followups/integ/look-bench.json
(09-30); G = a local gate-data archive, not published (10-01); TB = out/gpu/core/textures-bench-profile.json (09-30).

| Stage | GPU ms | CPU-twin ms | Readback (count, bytes, ms) | VRAM | Image / size | Source, date, M/E |
|---|---|---|---|---|---|---|
| Sky model (ORT webgpu, shared device) | infer 16-21 warm (47 first run) | ORT before sharing: 80-92 (infer) | model output stays gpu-buffer | n/a | 1024x768 -> 512x384 net input | out/gpu/followups/sky-device/sky-bench-after.json, 09-30, M |
| Sky refine (guided filter, 7 passes) in isolation | 3.4-3.8 per call (graph; miss 4.3-5.7) | CPU refine 93-120 | 1 read, 786 KB mask bytes, ~0.5 ms download | scratch 51.4 -> 25.2 MB (1024x768); 12 Mpx 167.8 -> 98.3 MB | 1024x768, up to 4608x3456 | out/gpu/followups/sky-graph/sky-graph-bench.json + commit 41b79fd, 09-30, M |
| Sky refine inside the worker, end to end | "refine" stage median 66-68 (infer 16-18, load 2-3, total 87-93) | before: total 189-225 (infer 80-92, refine 100-110) | same | same | 1024x768 | sky-bench-after.json, 09-30, M. NOTE 67 ms vs 3.5 ms isolated is unexplained (queue wait behind ORT? upscale/toBytes?) = GAP |
| Sky input prep on GPU (opt-in) | not timed | not timed | none | n/a | | commits e0017bc, b1b4d9d, 10-01, bit-identical only; no ms |
| photoprep buildEdgeMap / fitPriorSky | ~9.6 / ~5.5 | ~70 / ~64 (node) | one readback each | n/a | | commit a555a8f, 10-01, M (node CPU, browser GPU) |
| SkyGlobal T6 grid (service, wc_0001 / wc_0002) | warm 10.3 / 10.0 (kernel 7.7 / 6.5, upload 1.6 / 2.1, rescore 1.1 / 1.4); cold 24 / 17 | TS port grid 1418 / 905 (+polish 173 / 269); numpy 5429 / 6339 | 1 read, 27 KB (was 273 KB) | not measured | 1.48M / 0.59M cells | out/gpu/skyglobal/bench.json; P: cells kernel 6.69 ms/dispatch, reduce 0.15, cands 0.09; 09-30, M |
| SkyGlobal in live service, 4 photos | grid 5-23 ms vs 3568-8087 off (median 6860 -> 11); whole sky stage 16.8 s -> 10.1 s median | - | - | - | wc_0001/2/4/28 | out/gpu/skyglobal/live/compare.json, 09-30, M |
| Eye search (batched horizon, IMG_7018, 27 eyes, 5 batches) | 194 total, horizon 93 | 2616 (horizon 2517) | one read per batch | mosaic 163.6 MB | 800x600 sky work | out/gpu/followups/readback/eye-bench.json, 09-30, M |
| Horizon march, 343-eye batch | 342-492 (1.0-1.4 ms/eye; kernel ~17-25 ms per chunk, 15 chunks) | ~23-25 s extrapolated (47-74x) | 1 read per chunk; raw mapAsync saved 90 ms (436-774 -> 332-690) | mosaic 114-116 MB uploaded | 5 rings 1024-3328 px | G horizon-bench.json (10-01) and commit 6ff1797 (09-30), M |
| Horizon march single app call | warm 3.2-5.8; cold 37-52 (upload 14-15) | 43-64 | 1 | mosaic 114 MB | 7200 dirs | G horizon-bench.json, 10-01, M |
| Unknown-pose 360 scene horizon (7200 dirs) | uncached 87-119 (upload/mosaic-bound; mosaic page 9-13); cached 7-10; kernel 12.2 ms/call | 220-280 | 1 | 100-107 tiles, ~115 MB | | out/gpu/unknown/bench.json + P unknown row, 09-30, M. Graph variant measured slightly slower (3.6 -> 4.4 ms single eye), commit 227d79a |
| Solve coarse grid (yaw x pitch) | warm 1.2-2 ms; kernel 0.5-1.2; known 1.8, nogravity 1.7, noheading 4.6, none 8.4 (G) ; cold 6-10 | grid CPU: known 57-118, nogravity 287-607, noheading 461-939, none 2381-4566 | 8-16 KB (known/nogravity), 40-115 KB (360), 16 B/row fold | resident hz buffer | 15k-1.08M cells | G solve-bench.json 10-01; out/gpu/core/solve-bench.json 09-30; src/lib/gpu/solve/README.md, M |
| Solve in real worker (60 requests, 12 photos x 5 conds) | total median per cond: full 686, nogravity 173, noheading 342, none 397, none+nofocal 964 | CPU: 842, 450, 800, 2384, 11817 | - | - | | out/gpu/unknown/ablation*.json computed by me from 12 photos/cond, 09-30, M. README: summed solve 187 s -> 25 s |
| Fused horizon -> solve (8cac20b) | no timing | - | horizon still read back for LM/refine/eps | | | commit 8cac20b, 10-01, NOT measured |
| Align pose grid (2525 cells, 384x288 edge) | warm 2.0 (kernel 0.64, wall 2.3); cold 6.5 | 37.7-50.2 | 1 | edge planes uploaded once per edge set | 512x384 | out/gpu/core/align/w2-align-parity-deck.json + P align row, 09-30, M |
| Align search (grid + 5 hyps) | 51.6-60.3 | 84-104 | 1 grid read, 115-154 CPU rescored | | | same file, 09-30, M |
| Align engine autoAlign (deck) incl. silhouette re-rank | 80.4 (on) | 119.4 (off) ; silhouette re-rank 34-37 either way (5 renders) | re-rank read 442 KB/pose (WebGL), 1.77 MB/pose (WebGPU) | | | same file, 09-30, M |
| Align refine with GPU certified bounds | per-photo median sum 1354 -> 839 ms over 19 photos x 7 priors; main thread 1354 -> 464; CPU scorePose calls -79% | | one bound batch readback per descent round | | | commit e97879d, 10-01 (browser A/B run in v1, v2 pending), M for v1 |
| Silhouette re-rank on GPU (mask bits) | no timing | 34-37 | 18 KB/pose, all poses in 1 read | | 384x288 | commit 202f767, 10-01, gates pending |
| Haze fit (graph, e2e) | 12.2 (dispatch 12.3); kernel sum ~2.5 ms per call | 58-66 | 2 submits; list read 484 KB -> 210-236 KB adaptive; full 3.07 MB | 27.5 -> 21.6 MB (pooled 14.9 + transient 6.8) | 512x384 geo, 1024x768 photo | G ab.json/haze-graph-bench.json 10-01; LB 09-30; commit c1b7544, M |
| Haze CPU tail inside the 12 ms | cpuBins 3-4.5, cpuRefine 1.6-3.6, cpuPrep 1.1-1.4, gpuPrep 5 (4.1-4.2 prep e2e), gpuGrid 0.8-1.2 | | | | | LB haze.gpuSteps, 09-30, M |
| Haze scan micro (A: e6215e0) | hz-scan 0.515 -> 0.045; offsets 0.220 -> 0.020; compaction 0.370 -> 0.190; e2e 12.0 -> 11.7 | | | | | gate/summary.tsv, 10-01, M |
| Relief field | wall 18.5-19.9 (kernel 4.67: shadow 3.06, svf 1.33; includes ~15 ms CPU height raster) | 61.8-64.4 | 1 | | 1024 px, 128-167 tiles | LB + P, 09-30, M. Render-device bridge (b6aa6c3, 9924faa) untimed |
| Guided filter | 2.1-2.3 (kernel 0.81) | 12.6-13 | 1 | | 512x384 x2 masks | LB + P, 09-30, M |
| Band stats (colour stats) | 1.0 (kernel 0.14, subgroups; plain 0.9) | 4.1-4.8 | 1 small | | 256x192 | LB + P, 09-30, M |
| Masks (tex path, from render targets) | tex 2.2-2.6 (+ read 2.8); array path 11.2-11.3; graph kernel 0.94/call | | none in tex path | n/a | 512x384 | TB, 09-30, M. Bridge commit ba24382: masks 9.3 -> 1.9, stats 25-29 -> 8-9, hazePrep 7 -> 1.6 (4 photos) |
| Band stats tex / haze prep tex | 0.7 / 1.8 (array 1.5 / 6.3) | | none | | | TB, 09-30, M |
| Splat sort (radix, render device) | NOT MEASURED | worker counting sort (no ms) | none | ~22 MB per 1M splats (5 u32 arrays + histogram) | | src/lib/gpu/splat-sort/README.md, E (design figure) |
| Peak-label occlusion / skyline / point queries (geometry diet) | NOT MEASURED | prior: full 1024px readback per settle ~12 MB | now 4 B/peak, 4 B/column | | | commit 47e03f5, 10-01, no ms |
| Deck frame, pipelined (60 pose changes, 1 sync) | WebGPU 5.9-6.8; WebGL 5.4-7.2 | | | | 1080x810 | src/lib/deck-webgpu/README.md "Measured" (bench.mjs), 09-30, M |
| Deck frame, pan waited to completion | WebGPU 12.5-14.7; WebGL 8.8-10.5 (WebGPU CPU 0.2-0.4) | | | | | same, M |
| Deck colour pass per drag frame | 6.5 / 8.0 / 8.9 ms (MSAA off while interacting); was 76-114 with 4x MSAA | | | | DPR2 | reports/deck-default.md, 09-30, M (WebGL deck) |
| Deck GPU memory | photo view WebGPU 350-398 MiB vs WebGL 175-188; world 777-825 vs 675-688 | | | ~2x in photo view | | deck-webgpu README, M |
| Imagery pages | | | world re-entry uploads 835-929 MB -> 133/151/101 MB | pages ~96 MB, retain 300 MB | | commit 51acd70 / deck-default.md, M |
| Terrain geometry upload | 78-83 (uploadMs) for 365-368 tiles, 5.65-5.75M tris | | | geometry target 1024x768, colour 1280x768 | | out/deck-webgpu/battery-deck.txt etc., 09-30, M |

## 2. End-to-end

| What | Value | Source, date |
|---|---|---|
| Photo open -> data-ready, deck WebGL, IMG_6958/7086/7155 | 3326/3404/3502 ms (baseline 3304/3557/3762); three 3235/3325/3345 | reports/deck-default.md, 09-30, M |
| First terrain frame, WebGL deck | 2534/2952/3098 ms (2.6-3.3 s); WebGPU engine 2.4-2.5 s | deck-default.md; deck-webgpu README, 09-30, M |
| Production data-ready on deck | ~0.35-0.45 s later than three (2 loads only) | deck-default.md, E-ish |
| Median t-ready / t-final (19 photos, three, pre-GPU) | 3.7 s / 4.0 s, max t-final 27.5 s (matcher path) | reports/pipeline-ab.md, 09-29, M |
| Early direct-host (WebGPU) lab battery IMG_7086 | loadMs 2189, first terrain set 1750, frame 16.1 median (screenOnly 15.1) vs deck host 10.8 (0.9). SUPERSEDED by the README table above | out/deck-webgpu/battery-*.txt, 09-30 10:27, M but obsolete |
| Unknown-pose solve total (worker, includes DEM load + horizon) | GPU grid default: 686 ms (full), 173, 342, 397, 964 median; CPU 842/450/800/2384/11817. DEM tile cache read-only worker: scene 1921 -> 1170 ms | out/gpu/unknown/ablation*.json (computed), commit 78ff061, 09-30, M |
| Unknown-pose first load cost | loadMs 233-540 (tiles 100-107, 15 MB), scene 775-880 (sceneMs 835-8681 in solve-bench for the 7131 case) | out/gpu/followups/dem-cache/*.json, solve-bench, 09-30, M |
| autoAlign warm | 76-111 ms per photo (three or deck); GPU grid/search 80 vs 119 | deck-default.md; w2-align-parity, 09-30, M |
| WebGPU vs WebGL frame, drag fps | WebGL deck: photo drag 59.4 fps, world orbit 59.4-59.7 (antialias off at DPR 2), fly-in 59.5; WebGPU orbit 60 fps, no frame > 16.8 ms | deck-default.md, deck-webgpu README, 09-30, M |
| Export | 76-131 ms (WebGL deck), WebGPU diff only (0.27-0.95/255) | deck-default.md, M |
| WebGPU load under auto | 6/7 photos OK, 2 timeouts under contention (no ms) | reports/webgpu-default.md, 10-01 |

NO photo-open -> first-overlay number exists for the WebGPU default under the full app, the current flip (b520b1d) was done without a browser gate.

## 3. Known stalls

| Stall | Size | Status | Source |
|---|---|---|---|
| Horizon readback needed by the CPU (LM, refinePose, exact rescores, certified eps, f64 atan->deg) | 28.8 KB profile per call; not fused for bit identity | open | commit 8cac20b, solve README |
| Haze: GPU prep -> read lists -> CPU f64 middle stage -> second submit for the grid -> CPU argmin | cpu steps ~5-9 of 12 ms | open (bit-identical constraint) | LB gpuSteps |
| Skyglobal: GPU bound -> 27 KB read -> CPU exact rescore | rescore 1.1-1.6 ms + upload 1.6-2.1 of ~10 | open | skyglobal/bench.json |
| Solve: GPU row bounds -> CPU rescoring of undecided rows | 8-115 KB read, ~0.5 ms select | open | solve README |
| Align refine: GPU bound batch per descent round, CPU decides every move | main thread 464 ms summed/19 photos | open | commit e97879d |
| Sky: ORT infer -> refine -> byte-mask readback 786 KB -> CPU -> (masks re-uploaded as texture) | refine stage 67 ms in worker unexplained | open | sky-bench-after.json |
| Sky/ORT, horizon-fast, unknown-pose, page each own a GPU device | 3 devices created on /photo (page, unknown-pose worker, horizon-fast-app) + sky worker; buffers cannot cross devices/realms | structural | out/gpu/followups/core-verify/devices-profiled3.json (09-30) |
| Mosaic upload per scene | 114-164 MB, upload 12-19 ms; uncached unknown horizon 87-119 vs 7-10 cached | open | horizon-bench, unknown/bench.json |
| Deck band-stats sync stall (WebGL) | median ~6 ms, p90 12-37 ms per settle | fixed async (0e6b079, 10-01, untested) | commit |
| Three-engine geometry readback (obsolete) | GPU-busy 121-147 ms per 5 reads -> 21-29 async; 3 MB readback 99 -> 53 ms median | engine removed | commit 4ea09e8, out/gpu/w3 |
| Pre-diet geometry readback per settle (WebGPU 1024px rgba32f) | ~12 MB | replaced by GPU queries, untimed | deck-webgpu README, 47e03f5 |
| Main-thread long tasks (WebGL deck) | world re-entry 614 ms -> 136-156 ms; /photo load had 5 long tasks, max 275 ms (three, 09-30); terrain mesh 540 ms main thread -> workers (~200 ms leaves), DEM decode ~120 ms -> workers; tile cache gets 312 requests -> 0 | partly fixed | commits 51acd70, 881a6f2, e5fc006, d7c3d59, bench-before.json |
| luma mapAndReadAsync waits onSubmittedWorkDone (c waited c+1) | -90 ms on horizon batch | fixed with raw mapAsync | commit 6ff1797 |
| Pan frame to completion 12.5-14.7 ms WebGPU vs 8.8-10.5 WebGL | completion-latency floor | open | deck-webgpu README |
| Timestamp profiling disables pass coalescing; Chromium quantizes timestamps to ~65 us | measurement caveat | | core README |

## 4. Top-10 costs a GPU-resident graph could cut (ranked by estimated saving; all savings are E unless marked)

1. Sky refine stage inside the worker, 67 ms vs 3.5 ms in isolation (M for both numbers). If the ~60 ms is queue wait / readback of the mask and re-upload, a graph that keeps ORT output, refine and mask texture on the render device with no readback removes it. Largest single recoverable number, but the cause is unknown: profile first.
2. Unknown-pose horizon upload, uncached 87-119 ms vs cached 7-10 ms (M): 115 MB mosaic re-uploaded in a worker device. Reading DEM tiles from the render device's resident tile textures (relief-heights already does this on the render device) would cut ~80-100 ms per photo.
3. autoAlign descent, 839 ms summed / 19 photos x 7 priors even after bounds (M), 464 ms main-thread; per-round GPU->CPU decision. GPU-side decision loop (certified bound plus on-GPU exact compare) with indirect dispatch could cut round trips; ~20-40 ms per photo (E).
4. Haze fit, 12.2 ms of which kernels ~2.5 (M). Two submits and CPU f64 tail 5-9 ms; GPU-side tail would save ~8-9 ms per look change but bit-identity forbids f64 on GPU, so likely only the bins/prep part (~3-4 ms, E).
5. Photo-view GPU memory, 350-398 MiB vs 175-188 (M). Graph transient aliasing already halved sky scratch (51 -> 25 MB, M); applying it to geometry/MSAA/colour targets could save 100+ MiB (E).
6. Silhouette re-rank + geometry, 34-37 ms (M, pre-GPU re-rank); 442 KB-1.77 MB/pose readback (now 18 KB, untimed). Verify; saving ~20 ms/autoAlign (E).
7. Eye search, 194 ms (5 batches, 93 ms kernel, 101 ms rest, M). Fusing horizon->LM residual on GPU would remove 5 round trips; ~50-90 ms (E), but LM stays on CPU for bit identity.
8. Horizon -> solve chain: horizon readback, f64 atan conversion, rescore. Measured solve wall 1.2-3 ms vs kernel 0.5-1.2 (M), so only ~1-2 ms per call, but eliminates the 28.8 KB horizon readback and sync; fused chain (8cac20b) unmeasured.
9. Band stats / masks / haze-prep render-target to CPU round trip: bridge already took masks 9.3 -> 1.9, stats 25-29 -> 8-9 ms (M). Remaining: stats read back to feed composite uniforms (~1 ms + p90 12-37 ms stall in the old path). A GPU-side uniform write removes it (E ~5-10 ms per settle).
10. Interactive frame, pan to completion 12.5-14.7 ms vs 5.9-6.8 pipelined (M). One graph with geometry, colour, composite in a single submit and no mid-frame fences could close part of the gap; unknown (E 2-5 ms).

Not worth chasing (measured small): skyglobal rescore/upload (~3 ms of 10), solve wall, guided filter (2 ms), band-stats kernels (0.14 ms), masks tex 2 ms.

## 5. Measurement GAPS and the existing command that would fill each
All run as `node scripts/gpu/with-render-lock.mjs -- <cmd>` against a dev server on this tree (`npx vite dev --config scripts/gpu/vite.gpu.config.ts --port <free>`, set APP_URL). The user has testing on hold, so these are for later.

| Gap | Command |
|---|---|
| Per-stage GPU ms in the sky worker (README: the sky worker does not report) and the 67 ms unexplained refine | `PROFILE_OUT=out/gpu/core/profile/sky.json node scripts/gpu/with-gpu-profile.mjs scripts/gpu/sky-bench.mjs` (sky worker reporting needs a small code addition, GAP in code) |
| Post-graph-default numbers for horizon / eye / look / solve / skyglobal / align / sky (all 09-30 values are pre-default) | `scripts/gpu/horizon-bench.mjs`, `eye-bench.mjs` (MODES=gpuBatch,cpuBatch), `look-bench.mjs`, `look-graph-bench.mjs`, `solve-bench.mjs`, `skyglobal-bench.mjs`, `sky-graph-bench.mjs`, `w2-align-parity.mjs`, each via with-gpu-profile.mjs for kernel ms |
| Fused horizon->solve (8cac20b) timing | `ABL_FUSED=1 node scripts/gpu/unknown-horizon.mjs ablation` vs `ABL_FUSED=0` (also `ABL_GRAPH=0` for the pooled horizon) |
| autoAlign refine v2 and silhouette GPU re-rank timings and identity | `node scripts/gpu/align-refine-ab.mjs --check-bounds --perturb N` ; `node scripts/gpu/silhouette-ab.mjs --engine webgpu-app --reps N` |
| Geometry diet / GPU label occlusion timing and bytes | `npx tsx scripts/gpu/geo-query-check.ts` (logic only, no ms); ms need `node scripts/deck-webgpu/bench.mjs --photos IMG_7086,IMG_6958,IMG_7018 --out <dir>` with geometryDiet on/off (option needed) |
| Relief bridge, haze bridge, masks bridge in-engine latency | `node scripts/deck-webgpu/bridge-check.mjs IMG_7086 [--host deck|direct]` (writes out/deck-webgpu/bridge-check-<id>.json) |
| Photo open -> first overlay on WebGPU (flip had no browser gate) | `node scripts/deck-webgpu/app-load.mjs --renderer webgpu` and `--renderer auto`, then `--renderer deck` for the baseline (ready ms for the 19 photos); `scripts/deck-engine-smoke.mjs --renderer webgpu` |
| Deck frame/fps WebGPU vs WebGL, memory, post-10-01 | `node scripts/deck-webgpu/bench.mjs --photos IMG_7086,IMG_6958,IMG_7018 --out <dir>` |
| Interactive mode (1x colour pass while dragging) on WebGPU | same `bench.mjs` (README says "unmeasured") |
| Band-stats main-thread stall, async vs sync | `node scripts/gpu/bandstats-probe.mjs --stall N --out out/bs.json` |
| Haze/relief/masks texture-path timings after the bridge | `node scripts/gpu/textures-bench.mjs --photos IMG_7086,IMG_6958` |
| Splat sort GPU ms | no bench exists; `npx tsx scripts/gpu/splat-sort-check.ts` checks identity only. Needs a new bench (needs :8767 near-field scene for end to end) |
| Skyglobal VRAM, eye VRAM, solve VRAM, look relief/guided VRAM | benches report VRAM only for sky-graph-bench and haze-graph-bench; no existing command, would need the `vram` probe added |
| Sky prep GPU timings | `npx tsx scripts/gpu/sky-prep-check.ts` (identity only); ms need sky-bench with the opt-in flag |
| Main-thread long tasks on the WebGPU app path | `scripts/deck-webgpu/app-load.mjs` (no long-task probe) or `scripts/reveal-bench.mjs` for rAF intervals; a PerformanceObserver('longtask') hook would need adding |
| Multi-device cost (3-4 devices on /photo) | `out/gpu/followups/core/device-count.mjs` exists (devices-*.json 09-30); rerun after 10-01 changes |
| Cross-photo / cold start total including sky model preload (6.0-6.7 s preload, M) | `scripts/gpu/sky-bench.mjs` (preload.ms in e2e) |
