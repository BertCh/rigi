# Code review backlog (from 2026-09-30)

*Whole-repo review on 2026-09-30 (nine read-only reviewers, HEAD 0544df0), follow-ups on 2026-10-01 (CR-54–CR-69) and 2026-10-02 (CR-70–CR-73). The code-health backlog behind roadmap N7. When you fix a row, move it to "Closed" with its commit. Browser-unverified fixes are listed in [batch-ledger.md](batch-ledger.md).*

**Summary (2026-10-02, re-checked against the code):** 79 rows: 68 fixed, 1 partly fixed (CR-26), 4 obsolete, 1 decided (CR-W4), **5 open**. Open rows need a browser/GPU run (CR-13, CR-41, CR-46, CR-W2) or a refactor across both engines (CR-67).

## Open

| ID | Sev | Where | Problem → failure |
|---|---|---|---|
| CR-13 | med | `deck-webgpu/engine.ts` `exportImage`; `deck/composite.ts` | Export renders 4× MSAA rgba16f at full photo size (1.4–2.9 GB) → device loss on integrated GPUs. On WebGL one failed export sets `msaa = null` for the session |
| CR-41 | low | `deck-webgpu/layers/geometry-source.ts`; `deck/engine.ts` `autoAlign` | A superseded render can be marked fresh; `autoAlign` and `silhouetteScore` share `silSources[0]`. (The supersede check in `geometry-source.ts` may cover the first half: re-check) |
| CR-46 | low | `deck-webgpu/imagery.ts`, `layers/composite.ts`, `hosts/*` `setPhotoAspect` | Pending-upload leak, borrowed/owned photo texture handling, uncleared targets after an aspect change |
| CR-67 | low | both engines | `silhouetteScoresGpu`, `drawOnly`/`readDrawn` + 4-field pose compare, `occlusionFresh` duplicated across deck and deck-webgpu |
| CR-W2 | low | `components/site/LiveRollMap.tsx` `onStatus` | `setAutoRotate` on every non-terrain status re-enables rotation after the user grabs the map |
| CR-26 (part) | low | `vite.config.ts` (`public/photos/photos.json`), `data/ground-truth.json` | Fresh-clone build with gitignored data: `roll.ts` now builds with an empty table; the photos.json plugin path is unverified on a clean clone. Stub data is an owner decision. (Requirements half: `tools/matcher/requirements.txt` c7d5c94; the nearfield one went with the service, 8bb109d0) |

Nits not tracked: unwrapped yaw out of `align.ts`; per-frame allocations in `haze-fit.ts`; clockwise wedge rings in `roll/export.ts`; "Summit Lens" in `upload.tsx`; `atm-sky.ts` `#rgba` parsing; `biome.json` schema version; `run.mjs --jobs abc`.

## Closed

Obsolete or decided:
- CR-24, CR-29, CR-35 three.js `engine.ts` issues: obsolete (engine removed, 583e2b7).
- CR-48 SHARP splats exportable with a note: obsolete (SHARP dropped, d8e99834); the SHARP note branch in `export/splat.ts` is now dead code.
- CR-W4 first committed photo set (`public/demo/`): decided, tracked (79a3a7d publication review).
- CR-W1 landing map poster faded before terrain: fixed (`LiveRollMap` shows the canvas only once the stage leaves `terrain`).

Fixed:
- CR-01 render lock: missing `--` re-ran the wrapper inside its own lock: fixed 9388eef
- CR-02 render lock: SIGTERM left the child job running: fixed a2bfb76
- CR-03 `clusterPhotos` union-find ~n³; import re-ran it per file: fixed 9b2a4e9 + 32c8b66
- CR-04 exports omitted the geoid (ECEF/XMP ~50 m low): fixed a2bfb76
- CR-05 near-field service open CORS (service since removed, 8bb109d0): fixed 9388eef
- CR-06 matcher server request forgery (service since removed, 8bb109d0): fixed a2bfb76
- CR-07 3D mesh path skipped `validateTile` (no-data pits): fixed 9b2a4e9
- CR-08 bundled-photo eye move saved a mismatched pose: fixed 46a1821 (browser-unverified)
- CR-09 Step Inside could anchor to a pose auto-align changed mid-build: fixed a584a62
- CR-10 controller early returns left the phase "loading": fixed a584a62
- CR-11 haze-fit cache key omitted the fg mask: fixed fec0515
- CR-12 sky worker cached a failed load; device loss: fixed fec0515 + e50a464 (browser-unverified)
- CR-14 imagery bitmap cache never evicted: fixed 983d3a9 (browser-unverified)
- CR-15 above-ground prior not in the LM objective: fixed 627d3dd
- CR-16 non-converged integrity re-solve kept `ok: true`: fixed a584a62
- CR-17 integrity masking after the whitener: fixed f56d391
- CR-18 near peaks read the previous occluder angle: fixed 9b2a4e9
- CR-19 roll import Clear/saveAll races: fixed 32c8b66 (browser-unverified)
- CR-20 roll map decoded every photo at once: fixed 32c8b66
- CR-21 `loadRegion` cached a rejected promise: fixed 9b2a4e9
- CR-22 NaN in `localMax`: fixed 9b2a4e9
- CR-23 tile-cache index overwritten across tabs: fixed 78ff061
- CR-25 Ctrl-C left CI checks running; shared port: fixed 9388eef
- CR-27 warm-up compiled subgroup kernels without the feature: fixed (on master)
- CR-28 `parseMetres("4,478")`: fixed 9b2a4e9
- CR-30 `fetchTile` escaped the retry: fixed 9b2a4e9
- CR-31 worker pool had no error/timeout: fixed 9b2a4e9
- CR-32 late IndexedDB opens leaked: fixed a584a62 + 46a1821
- CR-33 concurrent uploads lost region ids: fixed a584a62
- CR-34 overpass abort listener leak: fixed 9b2a4e9
- CR-36 refine covariance mixed two poses: fixed f56d391
- CR-37 look-tex kernels redefined: fixed 96a6a6f
- CR-38 rejected `compileAsync` never cleared: fixed fec0515
- CR-39 unleased pool growth: fixed f1b6168
- CR-40 WebGPU host drew per input event: fixed 6378d85 (browser-unverified)
- CR-42 fence re-poll after context loss: fixed fec0515
- CR-43 unguarded `geoSrc.pose` after restore: fixed 46a1821
- CR-44 `nextFrame` waiters after destroy: fixed fec0515
- CR-45 texture-array slot dropped without release: fixed bc98f0e (browser-unverified)
- CR-47 duplicate inpaint client paths: fixed 46a1821
- CR-49 `invSym` σ = 0 for unobservable parameters: fixed f56d391
- CR-50 RANSAC adaptive stop ratio: fixed 627d3dd
- CR-51 confidence `{level:"high"}` not LOW: fixed a584a62
- CR-52 render lock PID reuse, ownerless lock, memory wait: fixed 46a1821 + 55d26ef
- CR-53 unclosed bitmap, pin-save races, double hashing: fixed fec0515 + 32c8b66
- CR-W3 demo manifest 3 MB: fixed 4616e41
- CR-W5 `/dev/export-roll` shipped in prod: fixed 46a1821
- CR-W6 TopoBoard/Compare drag and resize issues: fixed 55d26ef + 298c7cd
- CR-54 `silMask` not reset on context restore: fixed 9e1a637
- CR-55 splat `onLost` retained old clouds: fixed b41658f
- CR-56 stale cascade pose after run/detect: fixed b41658f
- CR-57 WebGPU boot leak on throw: fixed bb0f9a8
- CR-58 concurrent autoAlign sky copies: fixed a6ac3a7
- CR-59 terroir on WebGPU dropped shading: fixed 366ab83
- CR-60 WebGL trail dash: fixed c72fea1
- CR-61 harnesses measured WebGL under auto: fixed b41658f
- CR-62 failed fused march re-ran on GPU: fixed b41658f
- CR-63 haze fallback ignored `?lookgpu=0`: fixed 6c5e872
- CR-64 +Inf splat depth: fixed b41658f
- CR-65 weather layer unwired (WebGL): fixed c72fea1
- CR-66 hand-built silhouette pipeline: fixed bffe801
- CR-68 test-only `faultDeflate` in prod: fixed ac07d45
- CR-69 relief/silhouette dispose leaks: fixed eb149b5
- CR-70 sky idle release outside the queue: fixed 5c47766 (browser-unverified)
- CR-71 IDB open timer closed live connections: fixed 24b3e88 (browser-unverified)
- CR-72 render lock reclaimed on unknown start time: fixed 86b8193
- CR-73 roll import stuck on "saving": fixed 44a2af5 (browser-unverified)

## Checked and correct

COLMAP world-to-camera and quaternions; KML lon,lat order and MSL altitude; XMP escaping and GPS rounding; the zip writer; EXIF orientation and GPS refs; ECEF/ENU and Bowring; camera basis and roll sign; the refine Jacobian (re-derived) and the pose6dof Jacobian (finite differences, 1.2e-7); P3P/DLT; FFT; ONNX NCHW input and session reuse; GPU struct packing and uniform layouts in both GLSL and WGSL; 256-byte readback padding and y-flips; dispatch rounding and barrier placement; the "generated splats never exported" invariant; licences on the default near-field path; `torch.load(weights_only=True)`; no committed secrets (`.env.local` is ignored). `VITE_GOOGLE_TILES_KEY` ships in the client bundle by design: restrict it by HTTP referrer.

## Patterns worth remembering

- **Cancellation is the most common gap:** aborts not passed down, `dispose` without a cancelled check, async compiles that can't be retried, work that keeps running after Clear.
- **Rare-path leaks:** unclosed ImageBitmaps, never-evicting caches.
- **Drift-prone duplication:** LM loops with different damping, guided filters, sRGB tables, harmonize WGSL copies, angle helpers copied across `pose6dof`/`geocam`/`concord` (see [consolidation-review-2026-10-02.md](consolidation-review-2026-10-02.md) P4).
