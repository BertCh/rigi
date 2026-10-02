# Code review, 2026-09-30

*A whole-repo review: nine read-only reviewers, one per area, each re-reading the code behind its findings before reporting. Lines refer to `HEAD` at 0544df0 unless the row says WIP. This is the code-health backlog: when you fix an item, set its **State** to `fixed <commit>`, and don't delete the row. The plan item is [roadmap.md](roadmap.md) N7.*

Baseline at review time: `tsc` clean. `node scripts/ci/run.mjs fast` passes 26 of 27 checks; the biome ratchet fails, but only on uncommitted files (`scripts/dev.mjs`, `scripts/demo/*`, `scripts/peakfix/*`, `src/lib/peakfix/*`, `src/components/site/LiveRollMap.tsx`). No critical bugs were found. The deck/deck-webgpu sub-reviewers' findings (CR-13, CR-14, CR-40–CR-46) were not re-checked line by line.

*Update (2026-10-01): rows re-checked against `git log` after the three.js `PhotoEngine` was removed (583e2b7). Rows that pointed at `src/lib/engine.ts` (three.js) are marked obsolete; the CR-54–CR-68 fixes are cited by commit. CR-69's `relief-graph.ts` is `src/lib/gpu/look/relief-graph.ts`.*

## Fix first

| ID | Sev | Where | Problem → failure | Fix | State |
|---|---|---|---|---|---|
| CR-01 | high | `scripts/gpu/with-render-lock.mjs:22` | No `--` in the command → `indexOf` is −1, the wrapper re-runs itself inside its own lock and the whole queue hangs. **Reproduced** | Exit with usage when `--` is missing | fixed 9388eef |
| CR-02 | high | `with-render-lock.mjs:93-106` | SIGTERM/SIGINT deletes the lock but leaves the child (`tm_locks.py` → the job) running, so the next job starts alongside it (two GPU jobs). **Reproduced** | Spawn detached, kill the process group, release only on the child's exit | fixed (wave5/D4a: detached process group, signals forwarded, lock freed on child exit; `scripts/gpu/with-render-lock.check.ts`) |
| CR-03 | high | `src/lib/roll/roll.ts:204-210`, `routes/roll.import.tsx:140,229-272` | `clusterPhotos` union-find has no path compression (~n³: 2000 photos = 7.4 s) and import re-runs it about six times per file → a 1000-photo drop freezes the tab | Path compression / union by rank; recompute only when a draft becomes ready | fixed 9b2a4e9 (union-find; import re-runs still open) |
| CR-04 | med | `components/PhotoWorkspace.tsx:1112`, `export/camera.ts:195` | `geoidUndulation` is never passed to ExportMenu → ECEF in COLMAP/pose JSON and XMP `AltitudeEllipsoid` are ~47–55 m low in the Alps | Default to `tiles3d/geoid.ts` `geoidUndulation(lat, lon)` | fixed (wave5/D4a: engine exports default N to `tiles3d/geoid.ts` at the frame origin; `src/lib/export/geoid-default.check.ts`) |
| CR-05 | med | `tools/nearfield/service/app.py:332-374`, `tools/nearfield/propagate/service.py:139` | `Access-Control-Allow-Origin: *`, no auth or Origin check; any web page can POST 16 × 8192 px multiview jobs (OOM) and read results | Origin allowlist (as the matcher has), cap body size and threads | fixed 9388eef (nearfield service; propagate/service.py does not exist) |
| CR-06 | med | `tools/matcher/server/app.py:846-860, 1259-1285` | Body parsed as JSON whatever the Content-Type → a no-preflight `text/plain` POST from any site can make it fetch internal URLs (`photoUrl`) or read local images (`photoPath`); no Host check (DNS rebinding) | Require `application/json`, check `Host`, restrict `photoPath` | fixed (wave5/D4a: Host allowlist, Origin check, Content-Type must be JSON/multipart, `photoPath` confined to repo root + `MATCHER_PHOTO_ROOTS`) |
| CR-07 | med | `src/lib/terrain-mesh.ts:196-206`, `dem/load.ts:123-137` | The 3D mesh path never calls `validateTile`, so no-data stays at −32768 (32 km pits, flattened colour ramp via `engine.ts:801`) while horizon-fast repairs the same tile | Run `validateTile` in `buildTile` / `loadDemTile` | fixed 9b2a4e9 |

## Medium

| ID | Where | Problem → failure | State |
|---|---|---|---|
| CR-08 | `PhotoWorkspace.tsx:301-315, 853-866` | Bundled photos: the eye move isn't saved, but the next drag/pin/align saves the pose fitted to the moved eye; after reload the overlay is off | open |
| CR-09 | `components/nearfield/useStepInside.ts:220-233`, `nearfield/controller.ts:310-356` | `enter()` checks the accepted pose only before `await build()`; auto-align during the 10–60 s build makes Step Inside anchor to an unverified pose | fixed a584a62 |
| CR-10 | `nearfield/controller.ts:304,312,314` | Three early returns skip `set()`, so the phase stays "loading" and the button stays disabled | fixed a584a62 |
| CR-11 | `look/haze-controller.ts:71` | Haze-fit cache key omits the fg mask; when segmentation lands after the first fit, people pixels bias β/J0 until the pose moves | fixed fec0515 |
| CR-12 | `sky/sky.worker.ts:89-103`, `sky/index.ts:80-85,113` | A failed model load is cached as `null` and a worker error nulls the worker for good → classical segmentation on the main thread until reload. A GPU device loss leaves the ORT session on the dead device | fixed fec0515 (device-loss part open) |
| CR-13 | `deck-webgpu/engine.ts:2811-2830`; `deck/composite.ts:666-854` | Export renders 4× MSAA rgba16f at full photo size (1.4–2.9 GB) → device loss on integrated GPUs. On the WebGL path one failed export sets `msaa = null` for the session | open |
| CR-14 | `deck/engine.ts:1529-1570` | Imagery bitmap cache never evicts; memory grows while panning in imagery style | open |
| CR-15 | `pose6dof/eye.ts:461, 513-544` | The "soft" above-ground prior is only in `posPrior`, not the LM objective, so it acts as accept/reject. `eye.check.ts` test 5 passes because the LM result is rejected | open |
| CR-16 | `geocam/integrity/separation.ts:331` | A non-converged subset re-solve keeps `ok: true` → the photo can pass integrity (header says it must fail) | fixed a584a62 |
| CR-17 | `geocam/integrity/separation.ts:164-168` | Masking after the cluster whitener leaks masked rows into the left/right subsets → separation understated | open |
| CR-18 | `horizon-fast/march.ts:232,357`, `visibility.ts:176` | Peaks 50–150 m away have `q ≤ 0`, so `classifyPeak` reads the previous peak's occluder angle | fixed 9b2a4e9 |
| CR-19 | `routes/roll.import.tsx:214-227, 282-346` | Clear doesn't cancel queued decodes (they write into the new batch → re-adds rejected as duplicates); `saveAll` has no try/catch (stuck on "saving") | open |
| CR-20 | `roll/map/roll-map.ts` `loadPhotos` (committed ~:269-299) | Decodes every photo at once with `Promise.all` (GBs for 200 photos); bitmaps past `MAX_PHOTOS` never released | open |
| CR-21 | `src/lib/photos.ts:71-77` | `loadRegion` doesn't check `r.ok` and caches the rejected promise → one transient error breaks the region for the session | fixed 9b2a4e9 |
| CR-22 | `geo/peaks.ts:106` | One NaN sample makes `best` NaN in `localMax` | fixed 9b2a4e9 |
| CR-23 | `cache/tile-cache.ts:151-157, 325-336` | Each tab overwrites the shared index; orphaned bodies are never evicted, so the store grows past its 300 MB cap | open |
| CR-24 | `engine.ts:1473-1491, 2351-2371` | Frustum gizmo isn't hidden in the normal/silhouette passes → stale ink creases after a world-mode visit (three.js) | obsolete: three.js `engine.ts` removed (583e2b7) |
| CR-25 | `scripts/ci/run.mjs:97, 252-309` | Ctrl-C leaves detached checks running (and holding the render lock); concurrent `full` runs share :3130 and one kills the other's server | fixed 9388eef |
| CR-26 | `roll/roll.ts:8`, `vite.config.ts:17-27`; repo | A fresh clone can't build: gitignored `data/ground-truth.json` and `public/photos/photos.json` are imported. No `requirements*.txt` for the Python services | open |
| CR-27 | `gpu/look/hooks.ts:93` | `warmKernelsAsync(device)` without a group compiles every kernel, including subgroup kernels on devices without `subgroups` | open |

## Low

| ID | Where | Problem | State |
|---|---|---|---|
| CR-28 | `geo/peaks.ts:39` | `parseMetres("4,478")` = 4.478 | fixed 9b2a4e9 |
| CR-29 | `engine.ts:1796, 1839-1844, 2549-2576` | World-mode group, trail material and several render targets aren't disposed | obsolete: three.js `engine.ts` removed (583e2b7) |
| CR-30 | `dem/load.ts` `fetchTile` | `return res.arrayBuffer()` without `await` escapes the retry, so one dropped body fails `Terrain.load` | fixed 9b2a4e9 |
| CR-31 | `worker-pool.ts:43-51` | No `onmessageerror` or timeout; a job can hang forever | fixed 9b2a4e9 |
| CR-32 | `cache/store.ts:133-139`, `upload/store.ts:37` | Late IndexedDB opens leak; no `onversionchange` | fixed a584a62 (upload/store; cache/store open) |
| CR-33 | `upload/region.ts:376-386` | `attachPhotoToRegion` writes from memory, so concurrent uploads lose ids; `refreshLocalRegion` drops trails | fixed a584a62 |
| CR-34 | `overpass.ts:36-43,73`, `integration/unknown-pose.ts:202-205` | Abort listener leak; abort doesn't stop the worker's 360° search | fixed 9b2a4e9 (overpass half) |
| CR-35 | `engine.ts:2491-2503` | `exportImage` has no try/finally (renderer left at export size on OOM) | obsolete: three.js `engine.ts` removed (583e2b7) |
| CR-36 | `refine/robust.ts:394-456, 802-809` | Covariance mixes the IRLS weights of one pose with the Jacobian of the next | open |
| CR-37 | `gpu/look/textures.ts` | ~20 kernels redefined under "look-tex" → double compile, synchronous on the render thread; subgroup −1 partials wrap to 4.29e9 (`:1125`) | open |
| CR-38 | `gpu/core/graph.ts:398-401` | A rejected `compileAsync` is never cleared, so the graph can't be retried | fixed fec0515 |
| CR-39 | `gpu/core/pool.ts:58-61, 225-233` | Unleased growth can destroy a buffer another caller holds (only `sky/bench-graph.ts:186` is unleased) | open |
| CR-40 | `deck-webgpu/hosts/deck.ts:169-181` | `requestRender` draws synchronously per input event | open |
| CR-41 | `deck-webgpu/layers/geometry-source.ts:339-356`; `deck/engine.ts` `autoAlign` | A superseded render can be marked fresh; `autoAlign` and `silhouetteScore` share `silSources[0]` | open |
| CR-42 | `deck/geometry-pass.ts:187-204` | A fence after context loss re-polls at 1 ms forever | fixed fec0515 |
| CR-43 | `deck/engine.ts:1741-1743` | `this.geoSrc.pose` read unguarded after a context restore | open |
| CR-44 | `deck-webgpu/hosts/direct.ts:117-122`, `hosts/deck.ts:229-234` | `nextFrame` waiters never settle after destroy | fixed fec0515 |
| CR-45 | `deck/batched-terrain-layer.ts:265, 516-521` | At the texture-array layer cap, a slot is dropped without releasing its row, forcing full re-uploads | open |
| CR-46 | `deck-webgpu/imagery.ts`, `layers/composite.ts:979,1223`, `hosts/*` `setPhotoAspect` | Pending-upload leak, borrowed/owned photo texture handling, uncleared targets after an aspect change | open |
| CR-47 | `nearfield/generate/inpaint-client.ts:114-196`; `routes/lab.generate.tsx:207-213` | Duplicate client paths with weaker abort handling; lab leaks a PhotoEngine on re-run | open (lab PhotoEngine half obsolete: lab uses DeckEngine since 583e2b7) |
| CR-48 | `export/splat.ts:368-370` | SHARP (research licence) splats can be exported with a note, not blocked | open |
| CR-49 | `linalg/index.ts:131-144` | `invSym` reports σ = 0 for unobservable parameters (fails open in integrity) | open |
| CR-50 | `pose6dof/solve.ts:588-592` | RANSAC adaptive stop uses an inlier ratio over all correspondence kinds → may stop early (read, not reproduced) | open |
| CR-51 | `concord/app/confidence.ts:18-19` | `{level:"high"}` with no `accepted`/`confidence` isn't LOW, and the test passes `{}` instead | fixed a584a62 |
| CR-52 | `with-render-lock.mjs:28-76`, `tm_locks.py:19-26`, `run.mjs:460-466` | PID reuse; ownerless lock never cleared; memory wait holds the lock indefinitely; `--update-baseline` after a FAIL lowers the gate | open |
| CR-53 | `roll/panoGL.ts:150-160`; `upload.tsx` ~:142-200; `roll/import/index.ts:85-88` | Unclosed bitmap; racing pin-click saves; every file hashed twice | fixed fec0515 (panoGL bitmap; upload/import parts open) |

Nits not tracked here: unwrapped yaw out of `align.ts`, per-frame allocations in `renderWorld`/`haze-fit.ts:226`, clockwise wedge rings in `roll/export.ts:44-54`, "Summit Lens" in `upload.tsx:45`, `atm-sky.ts:327` `#rgba` parsing, stale code comments (`gpu/solve/index.ts:14`, `deck/batched-terrain-layer.ts` header says opt-in), `biome.json` schema 2.2.4 vs 2.4.5, `run.mjs --jobs abc`.

## Uncommitted work at review time (landing, demo roll, peakfix)

| ID | Where | Problem | State |
|---|---|---|---|
| CR-W1 | `components/site/LiveRollMap.tsx:65-72` | Poster fades on the first `photos` status, before the terrain arrives | open |
| CR-W2 | `LiveRollMap.tsx:71`, `roll-map.ts:538-547` | `setAutoRotate` on every status re-enables rotation after the user grabs the map and stacks `start` listeners | open |
| CR-W3 | `public/demo/manifest.json` | 3 MB (2.98 MB trails) fetched by `/` for ~11 KB of data → split the region out | open |
| CR-W4 | `public/demo/` | 11 MB of photos plus exact GPS and timestamps, the first committed photo set: decide deliberately | open |
| CR-W5 | `routes/dev.export-roll.tsx:27-33,72` | Ships in prod; effect runs before the DEV guard; object URL not revoked | open |
| CR-W6 | `site/TopoBoard.tsx:71-86`, `site/Compare.tsx:30-38`, `scripts/demo/unpack.mjs:103` | Dragged cards reset on mobile resize; no `onPointerCancel`; `--keep-prior` crashes on a null pose | open |

Suggested commit split for that work: dev launcher; three.js near-eye cut; RollCard; roll-map options; demo plumbing; landing + library; peakfix (separately, after lint).

## Follow-up review, 2026-10-01 (the 43 commits d84cf69..25d0e24)

| # | Where | Issue | State |
|---|---|---|---|
| CR-54 | `deck/engine.ts:682-730` `onContextRestored`, `deck/silhouette-gl.ts` | `silMask` not reset on context restore → every re-rank runs on dead GL handles, reads zeros and falls back to the CPU (correct, slow, GL spam). Fix: `silMask?.destroy(); silMask = null` | fixed 9e1a637 |
| CR-55 | `deck-webgpu/layers/splats.ts:585` | `onLost` per `setCloud` (never removed) retained each old cloud | fixed b41658f |
| CR-56 | `baseline-ui/pipeline.worker.ts:203-231`, `usePipeline.ts` | Align now awaits `cascadeAsync`; `run`/`detectSkyline` didn't invalidate it → stale pose lands | fixed b41658f |
| CR-57 | `deck-webgpu/engine.ts:711-790` `boot` | A throw between `createHost()` and `this.host = host` leaks the device + built cores (the init fallback to WebGL leaves a live WebGPU device) | fixed bb0f9a8 |
| CR-58 | `gpu/align/index.ts:213,223,258-261` | The private sky copy (`own`) is taken after `await scorePoseGridGpu`, not after `fitPriorSky` → concurrent autoAligns on one EdgeMap can score against each other's sky fit | fixed a6ac3a7 |
| CR-59 | `renderer-select.ts:25-33,108` | "terroir → WebGL deck" is resolved only at mount; switching to a terroir style on WebGPU silently drops the shading | fixed 366ab83 (WGSL terroir port; 2f9ffd5 was the interim WebGL route) |
| CR-60 | `deck/engine.ts:1545,2911` | WebGL `TrailLayer` never gets `dash` (1152622 wired only WebGPU) | fixed c72fea1 |
| CR-61 | `scripts/eval-app.mjs`, `scripts/leaderboard.mjs` | Unset `--renderer` (= auto) launched Chromium without GPU_ARGS → measured WebGL | fixed b41658f |
| CR-62 | `integration/unknown-pose.worker.ts:166-176` | Failed fused march re-ran the same GPU march before the CPU | fixed b41658f |
| CR-63 | `look/haze-controller.ts:104-134` | Failed/stale bridged fit falls back to `hazeFitAsync` (GPU) even with `?lookgpu=0` | fixed 6c5e872 |
| CR-64 | `gpu/splat-sort/splat-sort.wgsl.ts:64-69` (+ cpu twin) | +Inf depth → `maxD = Inf`, every key NaN | fixed b41658f |
| CR-65 | `deck/weather-layer.ts`; `style.weather` | Dead in HEAD: no importer, no engine reads the field (5c02363 says wiring "follows") | fixed c72fea1 (deck WebGL world view reads `style.world.weather`) |
| CR-66 | `deck-webgpu/silhouette-gpu.ts:110-150` | Hand-built pipeline with a fake empty-layout KernelSpec: sync compile on the render thread, invisible to kernel-layout-check | fixed bffe801 |
| CR-67 | both engines | `silhouetteScoresGpu`, `drawOnly`/`readDrawn` + 4-field pose compare, `occlusionFresh` duplicated across deck/deck-webgpu | open |
| CR-68 | `gpu/align/index.ts:93,98,271`; `gpu/align/graph.ts:34`; `pose-bound.ts:100-107` | Test-only `faultDeflate` global ships in prod; `STORAGE` redefined; `PoseBoundRaw.n` unread | fixed ac07d45 (faultDeflate DEV-gated, STORAGE deduped; `PoseBoundRaw.n` not rechecked) |
| CR-69 | `relief-graph.ts:80-90`; `SilhouetteMaskGL.compile()`; `look/relief/field.ts:369-381` | Dead `_degenerate` param; link failure leaks shaders/program/VAO; `resident` replaced without dispose (device-loss rebuild only) | open |

## Checked and correct

COLMAP world-to-camera and quaternions; KML lon,lat order and MSL altitude; XMP escaping and GPS rounding; the zip writer; EXIF orientation and GPS refs; ECEF/ENU and Bowring; camera basis and roll sign; the refine Jacobian (re-derived) and the pose6dof Jacobian (finite differences, 1.2e-7); P3P/DLT; FFT; ONNX NCHW input and session reuse; GPU struct packing and uniform layouts in both GLSL and WGSL; 256-byte readback padding and y-flips; dispatch rounding and barrier placement; the "generated splats never exported" invariant; licences on the default near-field path; `torch.load(weights_only=True)`; no committed secrets (`.env.local` is ignored). `VITE_GOOGLE_TILES_KEY` ships in the client bundle by design: restrict it by HTTP referrer.

## Patterns

- **Cancellation is the most common gap:** aborts not passed down, `dispose` without a cancelled check, async compiles that can't be retried, work that keeps running after Clear.
- **Rare-path leaks:** world-mode three objects, unclosed ImageBitmaps, never-evicting caches.
- **Drift-prone duplication:** four LM loops with three damping schemes; three guided filters; four sRGB→linear tables; the harmonize WGSL in three copies; `horizonEl`, `azEl`, `focalPx1600` and angle wrappers copied across `pose6dof`/`geocam`/`concord`. `deck-webgpu/layers/multi-drape.ts` (~1.8k lines) has no importer, by design for now.
- **Repo weight:** ~20 MB of research output is tracked, including `DONE` markers, `.err` logs and JSON dumps over 1 MB (`fund/e0_observability/features.json`, `fund/e1_acontrario/hyp_scores*.json`, `nearfield/spike/results_raw.json`).
