# Real-time Rigi: what it would take (2026-10-02)

Question: now that the pipeline runs in the browser on the luma compute graph, could it run in real time? Here that means a live camera or video stream: pose every frame, the peak/terrain overlay on the feed, and optionally Step Inside splats, at 15–30 fps.

Answer: it splits into three problems with very different distances to go.

| Part | Today | Real-time verdict |
|---|---|---|
| Rendering (deck.gl WebGPU, photo view) | 59–60 fps on photo drag at DPR 2 (`reports/archive/deck-default.md`) | Already real time. A video texture and a live-source API are missing, plus a few per-pose costs. |
| Pose tracking (skyline → pose) | Per still photo: sky segmentation 77–89 ms + autoAlign 37–40 ms + readbacks ≈ 7–8 fps at best; the full matcher is seconds | Feasible at 15–30 fps with a new tracker: sensor prior + a GPU skyline residual against the resident 360° horizon. The full matcher becomes an async re-localiser. |
| Step Inside depth (MoGe-2 ViT-S) | ≈ 0.47 s forward + ≥ 0.15 s CPU ≈ 2 fps | About 10 fps is reachable with surgery (fewer tokens, fused heads, GPU-only lift). 20–30 fps needs temporal reuse or a smaller or video-native depth model. |

Sources: four read-only audits (pose pipeline, Step Inside, nn/gpu-core runtime, render/live input). Measurements are node Dawn on an M3 Pro shared with other sessions, so they are noisy. These are not browser numbers. Nothing here is browser-verified.

## 1. Measured numbers

### Depth forward (MoGe-2, q8, 1024×683 output; median of 7 warm runs, Dawn)

| Tokens | Input | Encoder | Neck | One head | Full run (q8) | Full run (q8lite) |
|---|---|---|---|---|---|---|
| 128 | 196×126 | 15 | 14 | 14 | – | 56 |
| 256 | 280×182 | 21 | 25 | 25 | 130 | 97 |
| 512 | 392×252 | 30 | 47 | 51 | 224 | 163 |
| 768 | 476×322 | 47 | 70 | 70 | 323 | – |
| 1200 | 588×392 | 68 | 104 | 98 | 469 | 350 |

- At 1200 tokens the neck plus the three heads take about 86% of the forward. Each head is a full conv stack up to 16× the token grid.
- Cost scales with tokens. The output size barely matters.
- CPU stages after the forward, per build:
  - `buildSplatLod` 133 ms
  - `normalsFromDepth` 46 ms (q8lite only)
  - `fitAnchor` 35 ms
  - `splitPixels` 28 ms
  - CPU lift 30 ms
  - `packSplatTexture` 8 ms
  - DEM sampling, estimated at 30–200 ms

### Runtime (src/lib/nn, src/lib/gpu/core)

- f32 GEMM reaches about 0.9–1.1 TFLOP/s and flash attention 0.9–1.4 TFLOP/s. Convs reach 250–330 GFLOP/s.
- The fixed cost of a tiny forward plus its readback is 0.59 ms median.
- The CPU cost per node is about 17 µs: every call re-records, hashes and encodes. That is about 10 ms of CPU for a 600-node net.
- f16 is storage only and the arithmetic is f32. f16 `topk` is 4× slower than f32, which is a regression to look at.

### Pose stages (recorded in reports/; most predate the graph-only switch, so they are stale)

| Stage | Cost | Class |
|---|---|---|
| DEM tiles, mosaics, GPU pages, 360° horizon | Seconds once; upload 7–10 ms when cached | Once per location (re-march after moves over about 50–100 m) |
| Sky segmentation (U²-Net-P on nn) | 77–89 ms in the worker at 1024 px | Per frame today |
| autoAlign (grid + certified descent) | 37–40 ms median | Per frame today |
| Unknown-pose grid | ≤ 11 ms grid, ≤ 8 ms coarse solve | Re-localisation |
| ALIKED + LightGlue | 0.1–0.26 s extract, 0.15–0.6 s per pair | Re-localisation |
| Full matcher + accept rule | App alignment 3.1 s median, 9.3 s p90 | Re-localisation |

## 2. Why "on luma" is necessary but not sufficient

The move to the graph removed the Python services and put everything on one GPU device. That is the precondition. The stack was built for one-shot, reproducible inference, and that design works against a frame loop in five places:

1. **Recording per call.** `forward(fn)` re-runs the closure, then re-records, fuses and hashes the graph before a cache hit (`src/lib/nn/gpu/runtime.ts` ~L306–577). `ComputeGraph.run` creates a fresh encoder every time (`src/lib/gpu/core/graph.ts` ~L1047). There is no record-once / replay path, and new input/output buffers churn bind groups.
2. **Serial, awaited readbacks.** One `enqueue` promise chain (`runtime.ts` L214) means frame N+1 cannot encode while frame N maps. The pose path awaits `photoPrep.cpu()` (`deck-webgpu/engine.ts` ~3325), and the sky refine reads back. ALIKED needs at least 4 forwards and about 6 reads. LightGlue reads back after every layer for its early exit.
3. **Exactness over latency.** The certified-f32 / soft-f64 / bit-identical-to-CPU paths (`gpu/align/cert-*`, `gpu/photoprep`) exist for the frozen accept rule (`matcher/rule.ts`). A tracker needs a plain fast path.
4. **Shared queue.** `adoptRenderDevice` puts inference and deck.gl on one queue. A 100–450 ms forward submitted at once delays the next draw. Nothing splits a forward across frames, and nn runs on the main thread.
5. **CPU tails.** Step Inside spends at least 150 ms on the CPU after the forward (LOD, anchor, split, pack). Photo prep goes through a canvas `getImageData` (`align.ts:74`).

## 3. What exists vs. what is missing for a live mode

Exists:
- 60 fps photo-view rendering.
- GPU splat sort on WebGPU.
- A frame scheduler with input-time MSAA drop (`engine.ts` `noteInput`).
- `copyExternalImageToTexture` for stills.
- Warm-start pieces:
  - `refinePose` `localOnly` (`refine/index.ts:92`, CPU f64, 6 parameters)
  - `autoAlign` window mode
  - `gpu/eye` sector re-march
  - `matcher/rotation.ts` relative rotation
- GPU timestamp profiling (`__RIGI_GPU_PROFILE__`, `/dev/graph`).

Missing:
- **Input.** Zero hits for `getUserMedia`, `VideoFrame`, `requestVideoFrameCallback`, `deviceorientation` or geolocation in `src/`. There is no compass, declination or gravity handling.
- **Renderer API.** `photoElement` is typed `HTMLImageElement` (`renderer.ts:55`). The photo texture is rebuilt with mips whenever the image changes. There is no `setLiveSource` and no moving-eye setter (the eye and `EnuFrame` are fixed from `PhotoMeta`).
- **Tracker.** There is no temporal pose state, no motion prior, no smoothing, and no INIT/TRACK/LOST logic.
- **Per-pose costs.**
  - Labels lag the pose by at least one geometry readback.
  - `PhotoWorkspace` re-runs `peakLabels` plus React label layout on every render.
  - `fitHaze` runs on every pose change.
  - Photo-derived masks (sky, foreground, haze, edges) are computed once per photo.
- **Device adaptivity.** There is no dynamic resolution, fps governor or thermal back-off, and there are no mobile (iOS Safari WebGPU) frame times.
- **Validation.** The accept rule was frozen on stills. A tracker needs its own preregistered gate before any frame is called "accepted". Until then it is a suggestion, as propagation is.

## 4. Plan

Ordered so that each phase is useful on its own.

### RT-0: Measure (small)
- Add op-name labels to the timestamp nodes (`runtime.ts`, where `addKernel` ids are assigned).
- Write a node/Dawn bench for sky → photo prep → autoAlign on one frame, in the current graph-only code.
- Gate: per-stage ms on the current code; this replaces the stale numbers above.

### RT-1: Runtime for frame loops (medium; benefits everything)
1. **Persistent forward.** Record a closure once per (caller key, shape). Bind persistent input/output buffers (`importBuffer` exists) and replay with only the input upload. This removes about 17 µs per node of CPU and the bind-group churn.
2. **Pipelined readbacks.** Allow N slots in flight and drop the global `enqueue` serialisation for independent forwards. The pose result is read one frame late; nothing in the render path awaits a map.
3. **Fusion.** Elementwise chains, layernorm + residual, and bias + gelu.
4. **f16 arithmetic and subgroup GEMM** (`shader-f16`, subgroups, vec4 loads, 8×8 tiles per thread). Expected 2–3× on GEMM and attention; this is an estimate. Fix the f16 `topk` regression.
5. **Time-sliced or worker inference.** Split long forwards across submits, or give nn a worker device, so a forward never starves a deck.gl frame.

### RT-2: Live viewfinder with a pose tracker (large; the product feature)
- **Input.** `src/lib/live/`:
  - a `getUserMedia` pump with `requestVideoFrameCallback`;
  - `deviceorientation` / `AbsoluteOrientationSensor` with a declination correction;
  - geolocation;
  - flags declared in `src/lib/flags`.
- **Renderer.** `setLiveSource(video | VideoFrame)` on both engines:
  - Allocate the texture once and copy each frame with no mips. A WebGL `texSubImage2D` twin.
  - Skip the photo-derived masks, or run them at a low rate.
  - Add a moving-eye setter with the existing 300 ms wedge debounce.
- **Tracker `src/lib/track/`** (INIT → TRACK → LOST):
  - **INIT** runs the existing autoAlign or unknown-pose search on a keyframe.
  - **TRACK**, per frame:
    1. Gyro-predicted rotation as the prior, with gravity constraining pitch and roll.
    2. A cheap skyline from GPU edge columns on the resident video planes (`gpu/skyline`), not the U²-Net.
    3. A GPU residual of that skyline against the resident 360° horizon, plus a 6-parameter robust solve. The model is `refine/model.ts` + `robust.ts`, warm-started and non-certified.
    4. Smoothing.
  - The heavy sky model runs every N frames to correct drift.
  - **Re-localisation.** The full matcher runs asynchronously on keyframes off the main thread, with a staleness check.
- **Labels.** Pose-delta thresholds; projected labels from the resident horizon instead of waiting for a geometry readback; throttled React updates; `fitHaze` off in live mode.
- **Governor.** DPR and fps caps, plus a thermal back-off on the frame-time trend.
- **Validation.** A preregistered tracker gate on recorded clips (drift in degrees over time against a re-solved keyframe). Live output stays a suggestion until that gate passes.
- Expected: 15–30 fps tracking on desktop WebGPU (estimate). The budget is dominated by the residual reduction and the small solve. Mobile is unknown.

### RT-3: Live Step Inside (large; fixed camera first)
1. **One shared head stack** (`depth-net.ts` `convStack`): points and mask only, fused with the resize. The heads are the largest cost; estimated 150–200 ms saved at 1200 tokens.
2. **Live tier.** 256–512 tokens, heads stopped at 8× instead of 16×, q8lite weights, normals computed in the lift kernel instead of on the CPU.
3. **GPU-only compose and lift.**
   - `lift-gpu.ts` writes the splat texture directly: no record readback, no CPU compaction, no pack, no `buildSplatLod`.
   - Reuse the focal/shift solve and the anchor curve; refit rarely.
4. **Temporal reuse.** Depth every 3–5 frames, splats warped by the pose delta in between, the colour texture refreshed from video every frame.
5. **Research.** A smaller or video-native depth model (Video Depth Anything-Small, or a MoGe-2 student / half-width ViT). It needs an outdoor quality gate, because small CNNs are known to be weak there (`reports/step-inside-download.md`).

- Expected:
  - About 10 fps depth at 256 tokens with q8lite (97 ms measured today; low-token quality untested).
  - With head fusion and f16, roughly 512 tokens at about 100 ms (estimate).
  - 20–30 fps only with temporal reuse or a new model.
- A fixed camera (tripod, webcam) removes per-frame pose from this path entirely. It is the easiest first demo.

## 5. Recommendation

Do RT-0, then RT-1 items 1–2, then RT-2. A live peak and terrain overlay is the feature that reads as "real time", and the renderer already holds 60 fps. RT-1 makes every later step cheaper and also speeds up the existing still-photo flow. Treat live Step Inside as a later, fixed-camera experiment at about 10 fps. Do not plan around 30 fps depth with MoGe-2 ViT-S.

## Unverified / open

- No browser numbers at all; everything above comes from Dawn in node or from older reports.
- Low-token depth quality, the f16/fusion speed-ups, and the tracker fps are estimates.
- No mobile measurements exist.
- Pose-stage timings predate the graph-only (10-01) and WebGPU-default switches.

## 6. Implementation (2026-10-02, same day): landed, browser-unverified

Seven parallel units built RT-0 through RT-3 on master (a899fd9 … 1b86c69). Nothing has run in a browser yet. All numbers are node Dawn on a shared M3 Pro.

| Phase | What landed | Measured |
|---|---|---|
| RT-0 | GPU profile node ids carry op names and `nn.scope` paths; `scripts/nn/frame-loop.bench.ts`, `scripts/nn/kernels.bench.ts` | n/a |
| RT-1 runtime | `nn.compile` persistent forward (record once, persistent buffers, `runOwned`); immediate enqueue + `nn.readLater`; elementwise / layerNorm+residual fusion; bind-group memo per graph node; check row `nn-compile` | 400-node chain 11–12 → ~7 ms; 32 pipelined compiled runs ~0.5 ms/frame vs 1.3–1.7 awaited |
| RT-1 kernels | vec4 8×4 register-blocked GEMM with shape-selected tiles; baked conv params + 4-pixel gather; 256-thread attention; f16 top-k via GPUSort; opt-in f16 math (`kernel-caps.ts`) | linear 1591 → 2322 GF/s; conv 16→16 3×3 8.6 → 3.2 ms; f16 top-k 9.8 → 3.75 ms; attention flat |
| RT-2 render | `setLiveSource` / `setLiveMode` / `setPixelRatioCap` on both engines; video texture allocated once, no mips; screen-scope frames when only the video changes; live mode skips haze/band fits and masks, MSAA off, labels reuse the last verdicts and are throttled to ~15 Hz; placeholder photo (`src: ""`) | not measured (browser) |
| RT-2 input + UI | `/live` (`src/routes/live.tsx`, `src/components/live`): camera pump (`requestVideoFrameCallback`), device orientation → `Pose` with screen rotation and iOS permission, compact WMM declination (~1° in the Alps, up to ~3° elsewhere), geolocation with a 100 m move detector, frame governor, `?liveSource=<clip>` replay with a `.sensors.json` sidecar. Flags `live`, `liveFps`, `liveVfov`, `liveSource`, `liveDeclination` | n/a |
| RT-2 tracker | `src/lib/track`: GPU column skyline scan (CPU twin), robust Gauss-Newton yaw/pitch/roll, per-axis sensor-bias Kalman, INIT/TRACK/LOST with async relocalise, `prepareTrackerHorizon(eye)` from the shared DEM cache; every pose `suggestion: true`; check row `track-synthetic`; gate draft `reports/tracker-gate-draft.md` | synthetic skylines: 0.20–0.47° median vs ~10° raw sensor; first track 0.2 s; kidnap recovery 0.67 s; GPU scan ~0.8 ms |
| RT-3 depth | Batched heads (group-3, bit-identical), `headStopLevel`, `normals: false`, `DEPTH_LIVE_PRESETS` (`live` 384 tokens, `liveFast` 256), `runCompiled`; `reports/depth-live-2026-10-02.md` | liveFast `runCompiled` ~45–50 ms vs `run` ~56 ms; quality at 256 tokens: 12% depth median, 26% focal median (fix the focal from the camera) |
| RT-3 splats | `src/lib/nearfield/live`: one graph per depth frame, no readback (compose, anchor curve, in-kernel normals, lift, GPU compaction, writes the WebGPU splat buffer); depth-every-N schedule; per-frame colour refresh from the video; `WebGpuEngine.setNearFieldLive`; wired into `/live` behind `?liveStep=on` (WebGPU only) | parity vs the still path on 5 photos: identical counts, p99 position 6e-6 of range; depth-run graph ≈1–4 ms |

Open:
- The browser batch pass for all of the above (checklists are in the commit messages and unit reports).
- Tracker validation on recorded clips: sign-off on `reports/tracker-gate-draft.md`, then record clips.
- The tracker's real sky-model drift hook.
- Passing the WebGPU device to the tracker, so `/live` uses the GPU scanner instead of the OffscreenCanvas reader.
- The WebGL2 live Step Inside bridge.
- Indirect splat draw from the count buffer.
- A subgroup GEMM.
- Full WMM2025 coefficients.
- Mobile measurements.

### Follow-ups (2026-10-02, landed 856838a … c763027, browser-unverified)

| Item | What landed | Measured (Dawn, shared GPU) |
|---|---|---|
| Declination | Full WMM2025 (degree 12), generated from NOAA's coefficient file (`scripts/live/wmm-gen.ts`) | All 12 official test rows match: declination ≤ 0.01°, field ≤ 0.2 nT |
| Tracker in `/live` | GPU column scanner on the WebGPU render device; horizon loads during the camera prompt and again after a 100 m move (`horizon-warm.ts`); the real sky segmenter as a 2 s heavy skyline that corrects the cheap scan's bias (`?liveSky=auto\|on\|off`) | Synthetic haze (cheap scan biased 5 px): 1.64° median without the heavy skyline, 0.33° with it |
| Live splat draw | Count-aware GPU counting sort with indirect dispatch, then `drawIndirect` of the kept splats only; the still path is unchanged | 400k capacity, 50k live: sort + draw 3.10 → 0.58 ms; 200k live: 4.48 → 1.92 ms |
| Live Step Inside | Known camera focal (shift-only solve); depth runs stamped with their pose; refit after a > 25 m move or a > 30° turn; WebGL2 via the sidecar device and a ≤ 2 Hz readback | liveFast 3D position error 15.1% (net focal) → 12.3% (known focal) |
| Moving eye | `/live` rebuilds the engine at a new eye (> 100 m, accuracy ≤ 150 m, 10 s debounce) on a second canvas and swaps without a gap; the replay sidecar takes an `eyes` track | n/a |
| nn speed | Replicate pad and residual add fused into conv; vec4 conv weights; f16 products with f32 accumulation **on by default** on `shader-f16` devices (all nn models; opt out with `setKernelCaps({ f16Math: false })`); fusion binding budget taken from the device limits; `scripts/nn/depth-profile.ts` | Depth liveFast 54 → 46 ms, live 78 → 62 ms, 1200 tokens 212 → 170 ms; f16 depth error vs f32: 0.03% median |

Not done, with reasons:
- **Subgroup GEMM:** the profile shows convs dominate (about 60%), and the tiles are already near their limit on Apple GPUs.
- **Grouped conv:** it is already a single dispatch, and FLOP-bound.

Still open:
- The browser and phone pass (see the batch-ledger rows tagged `mt-image-f4`).
- Sign-off on the tracker gate.
- The `copy` nodes, about 3–4% of the depth net.
- Mobile numbers.
