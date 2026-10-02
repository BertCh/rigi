# Survey A: luma.gl master compute and graph demos, and what Rigi should take from them

Date: 2026-10-02. Read-only survey. luma master export is at a `git archive` of luma `origin/master` 931ec1c53 (2026-10-02); Rigi vendors `10.0.0-alpha.2-rigi.6`.

**API availability.** Every gpu-core, gpu-graph, gpu-data and gpu-parse symbol these demos import is exported by rigi.6 exactly as it is on master. I diffed the identifier sets of each sub-module's `index.ts` against `node_modules/@luma.gl/gpgpu/dist/*/index.d.ts` and found no symbol that exists only on master. The specific APIs below (`createExecution`, `GPUCommandGraphExecutionBudgetController`, `GPUCommandGraphAutotuner`, `recordCounters`, `DrawCommandBuffer`, `DispatchCommandBuffer`, `Device.writeBufferViaCommandEncoder`) are all present in rigi.6. **No lesson needs a vendor bump.**

Prior work I checked first, so this survey does not repeat it:
- `reports/luma-frontier-2026-10-01-late.md` (LF5: GPUSort adopted; GPUFFT1D and virtual geometry negative)
- `reports/gpu-luma-native-2026-10-01.md`
- `reports/whole-app-graph-plan.md` (W0.1 GPU conditions, W0.2 inspector, W1.5 indirect)
- `reports/realtime-investigation-2026-10-02.md` (RT-1)
- `src/lib/gpu/core/README.md`
- `src/lib/nn/README.md` (GPUMatMul rejected, luma-ops table)

---

## Ranked lessons

### 1. Time-sliced graph execution for long nn forwards on the shared render device

- **Upstream.** `CompiledGPUCommandGraph.createExecution(budget, {latencyPriority, publicationPolicy})` is at `modules/gpgpu/src/gpu-core/gpu-command-graph.ts:1468`, with the planner at `:335-400`.
  - It returns a resumable execution. Each call to `encodeNext(encoder, {parameters})` encodes one step whose summed `workload` stays inside `{maximumInvocationCount, maximumCommandCount, maximumReadByteLength, maximumWriteByteLength}`.
  - `GPUCommandGraphExecutionBudgetController` (`gpu-command-graph-budget-controller.ts:57`, `observeStep` at `:120`) learns the budget from measured queue-completion time per latency class (`interactive` / `normal` / `background`).
  - Worked use: `examples/experimental/gpu-trace-viewer/app.ts:6829-6865` (`executeGPUCommandGraphInFrames`: encode a step, submit, then await rAF plus queue completion, then `observeStep`). Four controllers are set up at `:709-725`, with the budget at `:261-266`.
- **Rigi today.**
  - nn rule "one forward = one submission" (`src/lib/nn/gpu/runtime.ts:595-600`: `graph.run(undefined, {buffers, textures})` inside the `enqueue` chain at `:214`).
  - `adoptRenderDevice` puts nn on deck's queue.
  - The realtime report measures the MoGe-2 forward at about 470 ms and sky segmentation at 77-89 ms. Its point 4 says "Nothing splits a forward across frames". RT-1.5 asks for exactly this.
  - nn kernel nodes carry no `workload` (`runtime.ts` around `:570`, `g.addKernel({id, spec, bindings, workgroups})`). Without one, the planner counts every node as zero cost and makes a single step.
- **Adopt.**
  - (a) In `runtime.ts`'s lowering, annotate each nn kernel node with `workload: {operation: "nn.<op>", variant, commandCount: 1, maximumInvocationCount: wgX*wgY*wgZ*wgSize, read/writeByteLength}`. `KernelNode.workload` already passes through `src/lib/gpu/core/graph.ts`.
  - (b) Add `ComputeGraph.runSliced(parameters, {budget, controller?, latencyPriority, isCurrent})` in `graph.ts`. It would:
    - hold `graph:<id>` for the whole run;
    - encode each step on a fresh encoder and use core `submit()`;
    - wait on `device.createFence()` plus rAF. Do not use the raw `handle.queue.onSubmittedWorkDone` that the demo uses, because it would trip `gpu-raw-lint`;
    - stage reads only on the last step.
  - (c) Add an `nn.forward(fn, {slice: "interactive" | "background"})` option. Step Inside depth (`src/lib/nearfield/local/depth-net.ts`) and sky segmentation use `background` when the render device is adopted.
- **Benefit.** deck frames keep running during a 0.1-0.5 s forward, which is the precondition for the RT-1 real-time work. No change to numerics: the same nodes run in the same order, only the submit boundaries move.
- **Effort.** M.
- **Risks.**
  - The forward's wall time goes up by a few frames.
  - Transients persist across steps inside the compiled graph, which is correct, but the graph lease is held for frames. Another forward of the same cached graph waits, which is acceptable.
  - Timestamp profiling takes one sample per step.
  - Needs a node/Dawn check: sliced output must be bit-identical to the single-submit output.

### 2. Inspector counters, plus sampled GPU counts that never stall a frame

- **Upstream.**
  - `GPUCommandGraphInspectorObservation.recordCounters(Record<string, number>)` and `GPUCommandGraphInspector.recordCounters(graphId, …)` are at `gpu-command-graph-inspector.ts:71-72` and `:325`. Snapshots then carry `counters[]` with latest, p50 and p95 values.
  - The shared panel renders them (`examples/gpu-command-graph-inspector-panel.ts`, the "Sampled counter" table).
  - The demos feed counters from GPU-written counts read back only every 30 frames, with at most one read in flight:
    - `gpu-scene-graph/app.ts:153-158` and `gpu-trace-scene/app.ts:190-203` use `readbackRing.tryAcquire()` and skip the read when the ring is busy;
    - `deck/gpu-culled-trace/gpu-trace-culling-effect.ts:174` and `:305-337` (`statsReadPending` guard) read `DrawCommandBuffer.getInstanceCountByteOffset`;
    - `gpu-trace-viewer/app.ts:6579` publishes workload counters.
- **Rigi today.**
  - W0.2 wired the inspector (`src/lib/gpu/core/inspector.ts`, `inspect.ts`, `/dev/graph` at `src/routes/dev.graph.tsx`), with p50/p95, reuse percentage and preflight. That part is **already adopted**.
  - Nothing calls `recordCounters`, and `GraphInspection` has no counters field.
  - `terrain-cull.ts:21` says "No count is read back", even though its args buffers are already `COPY_SRC` (`:75-76`).
- **Adopt.**
  - Add `ComputeGraph.recordCounters(counters)`. It forwards to `this.observation` (`graph.ts:427`), and is a no-op when the graph is not observed.
  - Add `counters` to `summarizeGraph` / `GraphInspection` (`inspect.ts`) and show a counters table in `dev.graph.tsx`.
  - Feed counters only while observed or profiling:
    - terrain-cull visible instances per slot, read every 30th prepare through `stageReads` with a one-in-flight flag;
    - haze-band compaction count and roll `neighbours.ts` `pairCount` (both already read);
    - nn `stats.graphHits` / `graphs` / `liveBytes` (`runtime.ts:205`);
    - splat count.
- **Benefit.** Debuggability: you can see on `/dev/graph` whether GPU culling or compaction does anything, with no per-frame stall.
- **Effort.** S. **Risk.** Low (dev-only, off by default). Add a case to `inspect.check.ts`.

### 3. Encoder-ordered parameter uploads (`writeBufferViaCommandEncoder` as a graph copy node)

- **Upstream.**
  - `Device.writeBufferViaCommandEncoder(encoder, buffer, data, offset)` is at `modules/core/src/adapter/device.ts:855`. On WebGPU (`modules/webgpu/src/adapter/webgpu-device.ts:292`) it records a staging-buffer copy on the encoder, freed after submit.
  - The gpu-dataframe compiler makes per-run parameters a graph copy node: `modules/experimental/src/gpu-dataframe/gpu-query-compiler.ts:651-667`, `addGPUQueryControlUpload`, `encode: ({commandEncoder, getBuffer, parameters}) => device.writeBufferViaCommandEncoder(...)`.
  - The effect is that several encodings of one compiled graph in one encoder each see their own parameters. `queue.writeBuffer` would instead land before the whole submit, with the last value winning.
  - luma's own `uniform-store.ts:228` uses it.
- **Rigi today.**
  - `terrain-cull.ts:276-313` keeps a per-encoder **ring** of `{params, args, inst[4]}` plus a graveyard, so that several prepasses recorded before one submit do not overwrite each other's uniforms (comment at `:23-26`). `prepare()` writes params through `e.params.write(...)` at `:325`.
  - The core README's `runNow` note (rule: write imports with `queue.writeBuffer` in the same synchronous block) exists for the same hazard.
  - Rigi does not call `writeBufferViaCommandEncoder` anywhere.
- **Adopt.**
  - Add `ComputeGraph.paramNode(id, target, (p) => ArrayBufferView)`. It is a `addCopyPass` that uses `writeBufferViaCommandEncoder` and is audited as a full write.
  - In terrain-cull, upload `packCullParams` in-encoder. Because WebGPU executes one encoder's commands in order, the cull for pass N+1 runs after render pass N has consumed `inst`/`args`, so the ring can shrink to a single entry. Keep "a new entry when the encoder changes" only if two encoders can be in flight with interleaved submits.
- **Benefit.**
  - Deletes the ring and graveyard (about 50 lines).
  - Saves up to `ring × 4 × cap × 4 B` of instance buffers.
  - Removes a class of "params written for the wrong pass" bugs.
  - Gives `cachedGraph` users a safe multi-encode path.
- **Effort.** S-M.
- **Risks.**
  - One small staging buffer is created per write (`createBuffer` with data). That is fine for two prepasses per frame, but not something to do per nn node.
  - WebGPU only, which matches the cull path.
  - Ship browser-unverified. Check `bridge-fusion` and the terrain A/B in the next batch.

### 4. Per-adapter autotuning of equivalent kernels (nn luma-op thresholds, GPUScan strategy)

- **Upstream.**
  - `GPUCommandGraphAutotuner` (`gpu-command-graph-autotuner.ts`):
    - `selectKernel({operation, candidates, workloadSize})` at `:143`;
    - `observeTimingReport(timingReport, preflight)` at `:250`, which learns from nodes whose `workload` has `operation` + `variant`;
    - `exportProfile()` at `:273`, giving a JSON profile that the app persists;
    - `getGPUCommandGraphAdapterIdentity(device)` at `:348`, the key.
  - The autotuner is passed as `new GPUCommandGraph(device, {id, autotuner})` (`gpu-command-graph.ts:649`). `GPUScan` then picks between subgroups and portable per adapter (`gpu-scan.ts:700-722`).
  - Worked use: `gpu-trace-viewer/app.ts:783-786` (load the profile), `:6610-6627` (observe after a deferred timing read, then store).
- **Rigi today.**
  - The nn↔luma crossovers are constants measured on one M3 Pro over Dawn: `LUMA_REDUCE_MIN = 1 << 18` and `LUMA_TOPK_MIN = 1 << 16` (`src/lib/nn/gpu/luma-ops.ts:96,98`), plus the GEMM vs direct-conv choice in `k-gemm.ts`.
  - `ComputeGraph` builds `new GPUCommandGraph<P>(device, {id})` with no autotuner (`graph.ts:445`), so the haze and photoprep scans get the capability default.
- **Adopt.**
  - Add `opts.autotuner` to `ComputeGraph` (one per device, in `device.ts`).
  - In `luma-ops.ts`, replace the constants with `selectKernel({operation: "nn.reduce" | "nn.topk", candidates: [{id: "nn"}, {id: "luma"}], workloadSize})`, falling back to the constants when there is no profile. Tag the nodes' `workload.variant`.
  - Feed `observeTimingReport` only from profiled runs (`__RIGI_GPU_PROFILE__`).
  - Persist the profile in localStorage keyed by `adapter.key`.
  - Under webdriver or harnesses, construct the autotuner with `explorationEnabled: false` and no profile, so benches stay deterministic.
- **Benefit.** Performance on GPUs other than the M3, without hand benches. Small code change.
- **Effort.** M.
- **Risks.**
  - Exploration runs the slower variant once per workload bucket.
  - The variant decides the reduction order, so nn outputs can differ in the last bits between machines or sessions. That is within the user's "well working, not bit-exact" tolerance, but it must stay off for frozen-rule benchmark runs.

### 5. `DrawCommandBuffer` / `DispatchCommandBuffer` instead of hand-laid indirect records

- **Upstream.**
  - `modules/gpgpu/src/gpu-core/draw-command-buffer.ts:75` (`getInstanceCountByteOffset` `:154`, `getInstanceCountData` `:159`, `draw(renderPass, i)` `:209`, `type: 'draw-indexed'`).
  - `dispatch-command-buffer.ts:36` (`getCommandData` `:106`).
  - Used across the frustum-culling, scene-graph and trace demos (for example `gpu-frustum-culling/app.ts:301`, `deck/gpu-culled-trace/gpu-trace-culling-effect.ts:105`).
- **Rigi today.** `terrain-cull.ts` packs `RECORD_WORDS` records by hand (`:71`, `:110`, `:171-172`, `:247`, `:310`). Align (`src/lib/gpu/align/cert-gpu.ts:370`) and haze-argmin (`src/lib/gpu/look/haze-argmin.ts:300`) write their own indirect dispatch words.
- **Adopt.** Use one `DrawCommandBuffer({type: "draw-indexed", commands})` per entry. The compaction count binds to `getInstanceCountData(k)`, and the `args` buffer and offset arithmetic go away. Optionally use `DispatchCommandBuffer` for the GPU-conditioned dispatch words.
- **Benefit.** Small code deletion, self-documenting offsets. **Effort.** S. **Risks.** Low. Check that `Model.setIndirectBuffer` (#3328) accepts `drawCommands.buffer` with per-command offsets, which it should.

### 6. Frame-loop readback that drops when busy (`tryAcquire`) instead of queueing

- **Upstream.** `GPUReadbackRing.tryAcquire()` returns null when every slot is busy, and the caller skips that sample (`gpu-frustum-culling/app.ts:252`, `gpu-graph-explorer/app.ts:498`).
- **Rigi today.**
  - `readback.ts` grows slots on demand and never refuses. That is the right call for one-shot photo work (README `:284`).
  - The nn runtime serialises every read behind one promise chain (`runtime.ts:214`, `read()` `:289`). The realtime report's RT-1.2 already plans "N slots in flight".
- **Adopt.** When RT-1 starts, add `tryStageReads(device, enc, ranges, {maxBusy})` to `readback.ts`, returning null at the cap, for frame-loop callers such as the tracker residual and the lesson 2 counters. **Effort.** S. **Risk.** Low. (Mostly confirms the existing plan.)

### 7. Compile once, encode every frame with rebinding (persistent forward)

Every scene demo compiles at setup and calls `compiled.encode(device.commandEncoder, {parameters, buffers})` per frame:
- `gpu-scene-graph/app.ts:143`
- `gpu-trace-scene`
- `deck/gpu-culled-trace/gpu-trace-culling-effect.ts:171`, inside a deck `Effect.preRender`

This is RT-1.1 (record once, replay) from the realtime report, so I add nothing new. Rigi's `cachedGraph` plus `encode` already allow it, and the missing part is nn's per-call closure re-record (`runtime.ts` around `:306-577`). Listed as corroboration only.

### 8. (Low) Chunked logical vectors for buffers above the binding limit

`gpu-trace-viewer/app.ts:6900-7000` (`GraphVectorView` over per-chunk `createDataView`s) and `GPUChunkedIndexedScatter` (`:3935`) keep data above `maxStorageBufferBindingSize` in independently allocated chunks.

Rigi raises the sidecar limits to the adapter maximum, but the **adopted render device** keeps deck's limits. The sky refine refuses large inputs instead (core README `:337`, "over-limit refusal"). Only worth doing if over-limit refusals show up on non-Mac GPUs. **Effort.** M. **Risk.** Medium.

### 9. (Low) `GPUBatchSort` for batched nn topk rows

`examples/experimental/gpu-sort/src/app.ts:141-158` sorts many segments in one op. nn keeps bitonic for "batched rows and short rows" (`src/lib/nn/README.md`, luma-ops table). Bench first with `scripts/nn/luma-ops-bench.ts`. Adopt only if batched rows of 2^16 or more appear in real models (ALIKED keypoint topk is one row). **Effort.** S. **Risk.** Low.

---

## Already adopted, rejected or not applicable (one line each)

- **Graph inspector, preflight, per-node CPU/GPU p50/p95, reuse percentage:** already adopted (W0.2: `core/inspector.ts`, `inspect.ts`, `/dev/graph`). Only counters are missing (lesson 2).
- **GPU indirect conditions (`source: 'gpu', mode: 'indirect'`):** already adopted (`align/cert-gpu.ts:370`, `look/haze-argmin.ts:300`), with a stronger clear lint than upstream.
- **GPUCompaction with an indirect instance count, and `Model.setIndirectBuffer`:** already adopted (`deck-webgpu/layers/terrain-cull.ts`, W1.5).
- **`GPUVisibilityWorkflow`:** not needed. It is mask intersection plus GPUCompaction to one output. Rigi compacts per draw slot, which this does not do; the drop-in part is lesson 5.
- **GPUSort, GPUSegmentedSort:** already adopted (splat sort, nn topk ≥ 2^16, `roll/spatial/sort.ts`).
- **GPUReduction, GPUHistogram, GPUScan, GPUGroupAggregation, GPUGridAggregation, GPUElementwise, GPUTranspose, GPUFFT2D:** already adopted (look, photoprep, ingest, roll coverage, nn luma-ops).
- **`coalesceComputePasses`:** already adopted (upstream default true, passed through `graph.ts:183`; timestamp profiling keeps nodes separate).
- **Encoder timestamps through `recordGPUTimings`:** already adopted (`graph.ts:1121-1131`).
- **Render and compute in one graph per frame (`addRenderPass` + `executeBundles`):** already supported (W0.1 render nodes, `deck-webgpu/render-bundle.ts`).
- **GPUScene, GPUSceneDrawGeneration, GPUSceneResourceGroups, virtual geometry (gpu-scene-graph, gpu-trace-scene, gpu-frustum-culling):** rejected (negative-results: a sparse streamed tile set, 350-390 tiles, no gain).
- **GPUIndexPickingTarget (frustum-culling, graph-explorer):** not needed. Terrain picks go through the geometry target (`deck-webgpu/geo-query-gpu.ts`), and labels are DOM.
- **GPUTextSelection and GPU-culled text (deck/gpu-culled-trace):** not applicable. Labels are CPU/DOM by design (WAG I10), and `@luma.gl/text` is not vendored.
- **gpu-graph algorithms (force layout, PageRank, BFS, components; gpu-graph-explorer, both variants):** no Rigi workload. The Gipfelbuch concept graph is 19 hand-drawn nodes.
- **gpu-parse (Parquet, Snappy, LZ4; gpu-parquet-constellation):** not applicable. The COG tiles are deflate (`concord/occl/swiss-cog.ts`), which has a serial Huffman stage that GPULZ cannot take, and terrarium decode is already on the GPU.
- **GPUIncrementalExecution (gpu-data-analysis `streaming-analytics.ts`):** weak fit. The roll coverage grid (≤ 256 photos, `roll/coverage/grid.ts`) is cheap to recompute, and the per-tile stats are already per tile.
- **GPUDataFrame, gpu-sql, GPUBatchHashIndex, joins (gpu-data-analysis):** no tabular workload in Rigi.
- **GPUDataEvaluator expression API (v10/gpgpu):** skip. It is the older lazy elementwise API with a WebGL2 path; the graph path is better, and the user wants no WebGL performance work.
- **gpt-2:**
  - What the demo does: each dispatch is its own `device.submit` (`app.ts:2705-2713`). Its kernels are an 8×8 scalar matmul with no tiling (`:4148-4180`) and a three-pass attention that recomputes QK three times (`:4195-4250`). It has no KV cache and calls `readAsync` per debug stat.
  - Rigi's nn (64×64 GEMM, flash attention, one submission, f16 weights, int8 dequant) is already well ahead, so there is nothing to adopt.
  - The only idea is its activation-strip visualiser (`appendBufferStats`) as a possible `/dev` tensor viewer for debugging depth-net layers. It is low priority.
- **fluid-foundry (MLS-MPM, `modules/experimental/src/rendering/mls-mpm-fluid-simulation.ts:375-431`):**
  - What the demo does: CFL substeps under a per-encode budget, recorded into the caller's encoder, with exact fixed-point integer atomics for the particle-to-grid scatter.
  - Rigi's atomics are integer counts only, so nothing to adopt now. The pattern is worth remembering if a float scatter-add, such as splat density, ever needs deterministic results.
- **Adapter identity and `capabilities.softwareAdapter`:** a minor idea. `renderer-select.ts` could refuse WebGPU on software adapters. Not in this survey's scope.

---

## Per-demo notes

| Demo | Patterns shown | Rigi status |
|---|---|---|
| `v10/gpgpu` | `GPUDataEvaluator` lazy expressions (acorn-parsed), `segmentedMap`, Arrow inputs; WebGPU and WebGL2 | Not used. The graph path supersedes it |
| `experimental/gpu-sort` | `GPUSort` / `GPUBatchSort` with `algorithm: auto/bitonic/radix`, direction, Arrow batches; graph stats (`reusePercentage`, compile time) | GPUSort and GPUSegmentedSort adopted; GPUBatchSort is lesson 9 |
| `experimental/gpu-data-analysis` | `GPUDataFrame` queries compiled once with per-run parameters through an in-encoder upload node (lesson 3); `GPUIncrementalExecution` partials and merge; hash index and join; CPU vs GPU benchmark | Lesson 3 adopts the parameter-node idea; the rest is not applicable |
| `experimental/gpu-frustum-culling` | `GPUVisibilityWorkflow` → `DrawCommandBuffer` instance count → render-bundle `drawIndirect` inside a graph `addRenderPass`; `GPUIndexPickingTarget` and `GPUReadbackRing.tryAcquire` picking | Cull and indirect adopted (terrain-cull); lessons 5 and 6 |
| `experimental/gpu-graph-explorer` | gpu-graph library; sampled force layout with no scratch, no float atomics and no readback (`graph-scale-layout.ts`); analysis stages spread one per frame (`app.ts:464-470`); picking ring | Manual frame-spreading is the do-it-yourself form of lesson 1 |
| `experimental/gpu-trace-scene` | `GPUTraceScene`, inspector + panel, readback ring, render bundle in the graph | Inspector adopted; lesson 2 |
| `experimental/gpu-trace-viewer` (13.6k lines) | Execution budgets and controllers (lesson 1), autotuner with a persisted profile (lesson 4), `DispatchCommandBuffer`-driven indirect compute (`addTraceIndirectComputePass` `:7093-7130`, GPU conditions plus workload annotations), chunked vectors (lesson 8), progressive publications, inspector counters (lesson 2), deferred GPU-timing reads, 8 MiB upload slices that yield every 16 MiB | Lessons 1, 2, 4, 5, 8 |
| `experimental/gpu-scene-graph` | `GPUScene` + `GPUSceneDrawGeneration` + `GPUVisibilityWorkflow`; GPU pick request and result buffers written per frame; sampled group counts every 30 frames | GPUScene rejected; the sampling pattern is lesson 2 |
| `experimental/gpu-parquet-constellation` | gpu-parse plan on the CPU → upload encoded pages → decode graph (Snappy / LZ4 on the GPU) → render | Not applicable |
| `experimental/gpt-2` | Naive transformer kernels through `Computation`, one submit per op, readback per stat, activation visualiser | nn far ahead; visualiser idea only |
| `experimental/fluid-foundry` | MLS-MPM substeps into the caller's encoder, fixed-point atomics, bloom composite | Pattern noted; not applicable |
| `deck/gpu-culled-trace` | deck `Effect.preRender` encodes one compute graph into `device.commandEncoder` that drives `drawIndirect` in two deck layers (blocks + GPU-selected glyphs); stats read every 30 frames with one in flight | Rigi does the same through `GpuLayerCore.prepass` (terrain-cull); lessons 2 and 5 |
| `deck/gpu-graph-explorer` | The experimental graph explorer inside ArrowDeck | Not applicable |
| `gpu-command-graph-inspector-panel.ts` | DOM renderer for `GPUCommandGraphInspectorSnapshot`: encodings, CPU and GPU p50/p95, timing-read failures, logical vs scratch bytes, reuse %, preflight invocations and reads/writes, **sampled counters**, per-node rows | `/dev/graph` covers everything except counters and `timingReadFailureCount` (lesson 2) |
