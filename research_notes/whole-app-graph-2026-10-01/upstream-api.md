# luma gpgpu graph and program API: precise reference and gap analysis against core/graph.ts

Sources:
- Vendored `node_modules/@luma.gl/gpgpu` 10.0.0-alpha.2-rigi.1 (`dist/gpu-core/*.d.ts`).
- luma master 7d1d11e9 (`up/luma.gl/modules/gpgpu/{src,test}`, `docs/api-reference/experimental/gpu-core/*`).
- PR #3328.

I diffed the exported names of every file below between the vendored d.ts and master src. They are identical, except that the vendored compiler also exports `compileGPUCommandGraphAsync`. So everything here applies to both.

Line refs: `G/` = `up/luma.gl/modules/gpgpu/src/gpu-core/`, `T/` = `up/luma.gl/modules/gpgpu/test/gpu-core/`.

Companion note: `notes/splats-3328.md` (splats composition + #3328 detail, written by a sub-agent).

## 0. Headline corrections to the earlier sweep

1. **The following are NOT public.** They are absent from `@luma.gl/gpgpu/gpu-core/index` in both alpha.2 and master. The package.json `exports` map has no deep paths, so `@luma.gl/gpgpu/dist/...` imports are blocked under `moduleResolution: bundler`. Their only tests import `../../src/gpu-core/gpu-scalar` directly (`T/gpu-scalar.spec.ts`, `T/gpu-value-arena.spec.ts`).
   - `GPUScalar`, `createGPUScalar`
   - `GPUValueArena`, `getGPUValueArena`, `inspectGPUValueArena`
   - `GPUScalarCompute`, `GPUScalarLiteral`, `GPUScalarDispatchGate`
   - `getGPUScalarWGSLLoad` / `Store`, `getGPUValueArenaWGSLBinding`

   **The only public route to an arena-backed scalar** is `GPUProgram.scalar()` → `GPUProgramCompiler.compile()` → `compilation.scalars.get(id)`. That value is typed `GPUScalar`, so you can use its `.arena.buffer`, `.wordOffset` and `.view`, but you cannot import the class.
2. **There are no clear or readback node types.** The node set is exactly `'compute' | 'render' | 'copy'` (`G/gpu-command-graph-types.ts:627/641/657`). Upstream does clears and readback copies as `addCopyPass` callbacks. `GPUReadbackRing` sits outside the graph.
3. **GPU conditions apply to compute nodes only, and only via indirect dispatch.**
   - Render and copy nodes take CPU conditions only (type-level, and enforced at `G/gpu-command-graph.ts:1017`).
   - WebGPU has no indirect copy, and MAP_READ buffers cannot be STORAGE. So **no readback size can be GPU-decided**. This is the key constraint behind sketch (a).
4. **`GPUProgram` values are scalar/vector only, in `float32 | uint32 | sint32`.** There are no texture values, no f64, and no per-encoding parameter inputs: literals are baked at compile time.

## 1. GPUCommandGraph: the full node set and resources

### Construction and resources (`dist/gpu-core/gpu-command-graph.d.ts`)

```ts
new GPUCommandGraph<P = void>(device: Device /* WebGPU only, throws otherwise */,
                              props?: {id?: string; autotuner?: GPUCommandGraphAutotuner})
importBuffer(d: {id; byteLength; usage: number}, defaultBuffer?: Buffer | DynamicBuffer): GraphBufferHandle
createTransientBuffer(d: GraphBufferDescriptor): GraphBufferHandle
createDataView<T>(buf, {format: T; length; byteOffset?; byteStride?; rowByteLength?}): GraphDataView<T>
importGPUData<T>(id, data: GPUData<T>): GraphDataView<T>
importGPUVector<T>(id, vector: GPUVectorLike<T>): GraphVectorView<T>   // fixed-width only; chunks preserved
importTexture<F>(d: GraphTextureDescriptor<F>, defaultTexture?: Texture | DynamicTexture): GraphTextureHandle<F>
importFrameTexture<F>(d): GraphTextureHandle<F>      // must be supplied every encode with strictly increasing frameId
importExternalTexture(d: {id; width; height}): GraphExternalTextureHandle   // sampled-only, per frame
createTransientTexture<F>(d): GraphTextureHandle<F>
createTextureView<F>(tex, {dimension?; aspect?; baseMipLevel?; mipLevelCount?; baseArrayLayer?; arrayLayerCount?}): GraphTextureView<F>
add(node: GPUNode<P>)          // GPUCommandNode | {getCommandNodes(graph)} | {getNodes()} | GPUNode[]
addComputePass(node: Omit<GPUCommandGraphComputeNode<P>,'type'>)
addRenderPass(node: Omit<GPUCommandGraphRenderNode<P>,'type'>)
addCopyPass(node: Omit<GPUCommandGraphCopyNode<P>,'type'>)
compile(): CompiledGPUCommandGraph<P>            // freezes the graph; at most once
compileAsync(): Promise<CompiledGPUCommandGraph<P>>  // starts every node's compileAsync before awaiting any
```

`GraphTextureDescriptor` fields: `{id, format, width, height, usage, dimension?='2d', depth?=1, mipLevels?=1, samples?=1}`.

Usages:
- `GraphBufferUsage = 'storage-read'|'storage-write'|'storage-read-write'|'uniform'|'copy-source'|'copy-destination'|'indirect'|'vertex'|'index'`
- `GraphTextureUsage = 'sampled'|'storage-read'|'storage-write'|'storage-read-write'|'render-attachment'|'copy-source'|'copy-destination'`
- `'indirect'`, `'vertex'` and `'index'` count as reads for hazards (`G/gpu-command-graph-compiler.ts:552`).
- The graph validates that the physical usage flags cover each declared use.

### Node base (applies to all three node types)

```ts
{ id: string;
  resources?: GraphResourceUse[];   // {buffer: Handle|DataView, usage} | {texture: Handle|View, usage} | {externalTexture, usage:'sampled'}
  dependsOn?: string[];             // explicit edges on top of the inferred RAW/WAR/WAW
  workload?: {operation?; variant?; commandCount?; maximumWorkgroupCount?; maximumInvocationCount?; readByteLength?; writeByteLength?};
  publication?: {id; completeness: 'partial'|'complete'};   // cannot be combined with condition
  condition?: … }
```

The three node types:
- **compute**: `{type:'compute'; compile(ctx:{device}) => {encode(ctx & {computePass}), destroy?}; compileAsync?}`. Condition: CPU or GPU.
- **render**: `{type:'render'; attachments?: {colorAttachments: GraphTextureView[]; resolveTargets?: (GraphTextureView|null)[]; depthStencilAttachment?: GraphTextureView}; compile => {getRenderPassProps?(ctx) => RenderPassProps; encode(ctx & {renderPass}); destroy?}}`.
  - Condition: CPU only.
  - Graph attachments and a caller framebuffer returned from `getRenderPassProps` are mutually exclusive. Caller framebuffer textures are invisible to hazard inference.
- **copy**: `{type:'copy'; compile => {encode(ctx)}}`. Records straight into the command encoder. Condition: CPU only. These nodes are not GPU-timestamped.

Encode context:
```ts
{commandEncoder, parameters: P,
 getBuffer(h|view): Buffer,
 getTexture(h|view): Texture,
 getTextureView(h|view): TextureView,
 getExternalTexture(h): ExternalTexture}
```

Helper constructors (public): `createGPUComputeCommandNode` / `createGPURenderCommandNode` / `createGPUCopyCommandNode`, and `addGPUCommandNode(s)`.

### Conditions

- **CPU**: `{id, source:'cpu', evaluate:(p)=>boolean}`.
  - Evaluated per encode, before a pass opens.
  - A skipped node keeps its schedule slot, so lifetimes and aliasing are static.
  - Stats report `outcome:'skipped'`.
- **GPU**: `{id, source:'gpu', mode:'indirect', buffer: GraphBufferHandle, byteOffset?=0}`, with `byteOffset % 4 == 0` and `byteOffset + 12 ≤ byteLength`.
  - Compute nodes only.
  - The graph auto-adds `{buffer, usage:'indirect'}` to `resources` (`G/gpu-command-graph.ts:1040-1050`).
  - At encode, the compute pass handed to the node is a Proxy (`G/gpu-command-graph.ts:503-545`):
    - **exactly one `dispatch()`** is allowed; it is rewritten to `dispatchIndirect(buffer, byteOffset)`;
    - calling `dispatchIndirect` yourself throws;
    - zero dispatches or two dispatches throw.
  - Stats report `outcome:'gpu-resolved'`.
  - The indirect x is arbitrary GPU data, so this is **GPU-sized dispatch, not just a 0/1 gate**.
  - Test: `T/gpu-command-graph-passes.node.spec.ts` "redirects one GPU-conditional compute dispatch to its indirect command" and "rejects ambiguous conditional contracts".
- Our `core/kernel.ts encodeDispatch` calls `pass.setPipeline` → `setBindings` → `dispatch(x,y,z)`. That is compatible with the Proxy: x only has to pass our `checkWorkgroups`.

### Transients and aliasing (`G/gpu-command-graph-compiler.ts:780-812`)

**Buffers:**
- Each lifetime is the [first, last] scheduled node index that declares the handle.
- Allocation is greedy: the heap returns the smallest free allocation whose `lastUse < firstUse`. Its byteLength becomes the max of the two, and the usage flags are OR'd together.
- **Transients are never zeroed**, and that includes the value arena.
- Unused transients are not allocated.

**Textures:**
- Reused only when the descriptor is compatible (same extent and format; usage is OR'd). Mip, layer and aspect ranges are tracked for hazards.

**Imports:**
- Two distinct active handles that resolve to one physical resource are rejected when either one is written. This holds for defaults, overrides, DynamicBuffer re-backing, and core Buffer wrappers sharing a handle (`T/gpu-command-graph-alias.node.spec.ts`, 17 tests).
- Read-only sharing is allowed.

### Compiled graph

```ts
compiled.encode(enc, {parameters, coalesceComputePasses?=true, buffers?, textures?, frameTextures?: Record<id,{texture, frameId}>, externalTextures?}): GPUCommandGraphEncoding
compiled.stats          // nodeOrder, logical/physical transient buffer+texture bytes, reusePercentage, …
compiled.preflight      // per-node workload + condition metadata, totals, largestBuffer, fitsDeviceLimits
compiled.capabilities   // timestampQueries, subgroups, subgroupId, softwareAdapter, limits
compiled.getExecutionPlan(budget: {maximumInvocationCount; maximumNodeCount?; maximumCommandCount?; maximumReadByteLength?; maximumWriteByteLength?}, {latencyPriority?, publicationPolicy?})
compiled.createExecution(budget, opts).encodeNext(enc, options) // resumable, bounded steps across frames
compiled.destroy()
encoding.stats / encoding.canReadGPUTimings / await encoding.readTimings()  // after submit; copy nodes CPU-only
```

- Consecutive compute nodes share one physical compute pass. The pass is closed before copy and render nodes.
- Per-node timestamps are taken only when the command encoder was created with `timeProfilingQuerySet`.
- `GPUCommandGraphExecutionBudgetController` (`G/gpu-command-graph-budget-controller.ts`) adapts the budget from measured steps.

### Inspector (`GPUCommandGraphInspector`, `T/...inspector.node.spec.ts`, 8 tests)

```ts
new GPUCommandGraphInspector({maxSamples?, getNodeGroup?})
const obs = inspector.observeGraph(compiled);   // {encode, recordGPUTimings(enc), recordCounters(rec), detach}
obs.encode(enc, opts); submit; await obs.recordGPUTimings(encoding);
inspector.getSnapshot()  // per graph: stats, capabilities, preflight, cpu/gpu {latest,p50,p95}, counters, per-node
```

There are also lower-level `registerGraph` / `recordEncoding` / `recordCounters` / `recordGPUTimings` / `clear()`.

### Maturity

- **Docs**: `docs/api-reference/experimental/gpu-core/` (gpu-command-graph.md, concepts.md, gpu-transient-lifetimes.md, webgpu-runtime-control.md, recipes.md). The module README says these subpaths are "explicitly experimental … no semver promise".
- **Tests**: `T/gpu-command-graph.spec.ts` (1894 lines, browser WebGPU), plus textures (1266), passes, planning, alias, history, inspector, autotuner and async specs.
- The graph core is the best-tested part of gpgpu.

## 2. GPUProgram / GPUProgramCompiler

### API

```ts
new GPUProgram({id?})
  .scalar<T extends 'float32'|'uint32'|'sint32'>(id, format): GPUProgramScalar<T>
  .vector<T>(id, format, length, {external?, chunkLengths?}): GPUProgramVector<T>
  .add(op: GPUOperationLike)   // semantic GPUOperation | primitive {getCommandNodes(graph)} | {getNodes()} | arrays
composite(ops, {id?}) → GPUCompositeOperation (type 'composite'; lowered by flattening)
semantic ops (public): GPUProgramScalarLiteral({output, value}), GPUProgramScalarOperation / scalarArithmetic / scalarCompare
  ('copy'|'add'|'subtract'|'multiply'|'divide'|'sqrt'|'min'|'max' ; 'equal'|'not-equal'|'less-than'|…; compare output uint32),
  GPUProgramVectorMADD({input, scale, addend, output}), GPUProgramDotProduct({left, right, output}), GPUProgramSpMV({matrix: GPUProgramCSRMatrix, vector, output, strategy?}),
  createGPUConjugateGradientProgram(...)
control flow: new GPUConditionalOperation({id?, predicate: {id, source:'gpu', value: GPUProgramScalar<'uint32'>, expression?}, body, lowering?: 'auto'|'unroll'|'dynamic-gpu'})
              new GPULoopOperation({id?, body, predicate?, maximumIterations, minimumIterations?=0, lowering?})
new GPUProgramCompiler<P>(device)   // capabilities = {backend:'webgpu', gpuConditionals:true, nativeLoops:false, childGraphs:false}
  .lowerings: GPUOperationLoweringRegistry<P>  // .register<Op>(type, (op, ctx) => void)
  .compile(program, {vectors?: Record<id, GPUVectorInput>}): GPUProgramCompilation<P>
     = {program, graph /* UNCOMPILED GPUCommandLoweringGraph — add nodes, then graph.compile() */,
        scalars: Map<id, GPUScalar>, vectors: Map<id, GraphVectorView>, validation, lowering}
validateGPUProgram(program, bindings?): {valid, issues: {level, code, message, operationId?, valueId?}[]}
inspectGPUProgramCompilation(c): GPUProgramCompilationSummary
```

### Lowering registry context

```ts
{graph, capabilities, lower(op), lowerConditional(pred, op), resolveScalar(s), resolveVector(v), recordDecision({operationId, operationType, lowering, reason})}
```

`compile()` throws when validation fails.

### Lowering report

`{operations: GPUOperationTree[], nodes: {nodeId, nodeType, operationPath}[], decisions: {operationId, operationType, lowering, reason}[]}`.

Decision strings: `webgpu-scalar-literal`, `webgpu-scalar-kernel`, `webgpu-vector-madd`, `webgpu-hierarchical-dot`, `webgpu-spmv:<id>`, `gpu-indirect-gate`, `bounded-unroll`, `gpu-gated-bounded-sequence`, `flatten`, `explicit-command-nodes`.

### Conditionals and loops (`G/gpu-program-compiler.ts:270-300, 395-437`)

- A conditional pushes its predicate. Every compute node lowered underneath gets:
  - a 1-thread `GPUScalarDispatchGate` update node that writes `[active ? x : 0, y, z]` into a 12-byte transient (`STORAGE|INDIRECT|COPY_SRC`);
  - `condition = gate.condition` on the node itself.
- Nested predicates are combined with a `GPUPredicateConjunction` node (`predicate-and-N` scalar).
- **Constraint**: a node under a predicate must carry exact dispatch geometry.
  - It is set via `setGPUComputeDispatchWorkgroups(node, [x,y,z])`, which is internal (`G/gpu-command-dispatch-metadata.ts`). It is just a duck-typed `dispatchWorkgroups` property on the node object.
  - Arbitrary primitives (ours) under a predicate throw "must declare exact dispatch geometry" unless they set that property.
  - Render and copy nodes cannot be gated.
- A loop with a predicate and `lowering !== 'unroll'` becomes a **bounded sequence**:
  - `maximumIterations` copies, the first `minimumIterations` ungated, the rest gated;
  - node ids get `-iteration-N` suffixes.
  - There is no native loop: the cost is O(maxIter) encoded dispatches, and false iterations become zero-size indirect dispatches.

### Maturity

- **Tests are thin:**
  - `T/gpu-program-compiler.node.spec.ts`: 3 NullDevice tests (nested predicates, unique unrolled ids, empty vector);
  - `T/gpu-program-vectors.spec.ts`: browser; predicate 0/1 across chunk boundaries, and in-place MADD;
  - `gpu-solver-numerical.spec.ts` covers CG.
- **Docs drift**: `gpu-control-flow-operation.md` and `gpu-operation-lowering.md` say dynamic lowering is "not faked in this PR", but the compiler now implements it.

### Canonical pattern (`T/gpu-program-vectors.spec.ts:33-77`)

1. `compile(program, {vectors})`.
2. `compilation.scalars.get('total')!.view` gives a GraphDataView on the arena.
3. `compilation.graph.importBuffer(readback)` and `addCopyPass` to copy the scalar out.
4. `compilation.graph.compile().encode(enc, {parameters: undefined})`.

## 3. GPUScalar and GPUValueArena (internal; reachable through a compilation)

**GPUScalar** (`G/gpu-scalar.ts`):
- `{id, format, arena, slot}` plus getters `byteOffset`, `wordOffset` (`byteOffset >>> 2`) and `view: GraphDataView<T>`.
- WGSL binding: `@group(g) @binding(b) var<storage, read_write> gpuValues: array<u32>;`
- Loads and stores use `bitcast<f32|i32>(gpuValues[word])`.

**GPUValueArena** (`G/gpu-value-arena.ts`):
- One per graph (WeakMap keyed by the graph).
- 16 KiB transient buffer (`STORAGE|COPY_SRC|COPY_DST`) = 4096 slots.
- Monotonic 4-byte slots with no recycling. `allocate` throws on a duplicate id or when capacity is exceeded.
- Hazards are buffer-granular, so **every arena user serialises on one buffer**: any scalar write orders against every scalar read, which can over-constrain scheduling.
- It is a transient: it is uninitialised each encoding, though it lives the whole graph so it does not alias.
- The `GPUProgramDotProduct` test re-encodes twice to check that ops overwrite rather than accumulate.

**GPUScalarCompute** emits 1-thread kernels. **GPUScalarDispatchGate**:
- `(graph, {id, active: GPUScalar<'uint32'>, workgroups:[x,y,z]})`
- `.getUpdateCommandNodes(graph, id?)`
- `.condition`
- `.dispatchBuffer`
- `x` is fixed at construction, so this is a 0/x gate only.

**Docs**: gpu-scalar.md, gpu-value-arena.md, gpu-value-arena-finalization.md, gpu-scalar-operation.md. **Tests**: export-only (two trivial specs) plus indirect coverage via program tests.

## 4. GPUTextureHistory and the autotuner

### GPUTextureHistory (public)

```ts
new GPUTextureHistory<F>(device, {id?, format, width, height, usage, dimension?, depth?, mipLevels?, samples?})
.previousTexture / .currentTexture
.getBindings(prevId, curId): Record<string, Texture>   // feed encode({textures})
.advance()   // call only after encode succeeded
.reset()     // role order only; does NOT clear contents
.destroy()
```

Usage pattern (`T/gpu-command-graph-history.spec.ts:20-140`):
- Import two textures under distinct ids with the same descriptor.
- A compute node samples `previous` and does `storage-write` to `current`.
- Per frame: `encode(enc, {parameters, textures: history.getBindings('previous','current')})`, then `advance()`.
- Passing the same texture for both roles throws, and roles do not advance on a failed encode.

Tests: 9 node + 1 browser.

### GPUCommandGraphAutotuner (public)

```ts
new GPUCommandGraphAutotuner({adapter: getGPUCommandGraphAdapterIdentity(device), profile?, minimumSampleCount?=1, explorationEnabled?=true})
.selectKernel({operation, candidates: {id, supported?}[], workloadSize}) → {variant, reason: 'exploration'|'calibrated'|'fallback', …}
.observeKernel({operation, variant, workloadSize, durationMilliseconds})
.observeTimingReport(timingReport, compiled.preflight)   // uses nodes' workload.operation + workload.variant
.exportProfile() / .reset()
```

- Pass it in through `new GPUCommandGraph(device, {autotuner})`; primitives read `graph.autotuner`.
- It never compiles, submits, or persists anything itself.
- Tests: 3 (explore→select, support + persistence, consuming graph timings).

## 5. Splats: compute + render in one graph (detail in notes/splats-3328.md)

`modules/splats` (private workspace, experimental, ~70 tests):
- Builds one `GPUCommandGraph` from imported buffers.
- Node order: `addComputePass` init / projection, then `add(new GPUSort)`, then `addRenderPass`.
- `DrawCommandBuffer` (`G/draw-command-buffer.ts`, `STORAGE|INDIRECT|COPY_*`) is written by compute nodes (`storage-write` / `storage-read-write` on the instanceCount word).
- The render node declares `{usage:'indirect'}` and encodes `setPipeline(model.pipeline)`, `setVertexArray`, `setBindings`, `drawCommands.draw(renderPass, i)` → `renderPass.drawIndirect`. **It bypasses `Model.draw`.**
- The render node uses neither graph `attachments` nor `frameTextures`, so it renders into the default framebuffer.
- Interaction mode (`gpu-splat-graph-interaction.ts`) splits the frame:
  - `predraw(enc)` encodes the compute part of the graph;
  - the draw happens inside the host's own pass.
- **This is the pattern for deck.gl**: run the graph's compute nodes before deck's render pass, then draw inside the layer's `draw()`.
- deck.gl itself has no GPUCommandGraph usage.

A deck Model can only be a render-node participant when the graph owns the pass:
- use `attachments` or `frameTextures` for the canvas texture;
- `importFrameTexture({id, format, width, height, usage})` plus `encode({frameTextures: {id: {texture, frameId}}})`.

## 6. PR #3328 (Model drawIndirect)

Status: OPEN, unreviewed, not in the vendored engine.

API:
- `ModelProps.indirectBuffer?: Buffer|null`, `indirectOffset?` (multiple of 4).
- `model.setIndirectBuffer(buf|null, offset=0)`.
- `model.writeIndirectDrawRecord(buf, offset=0, commandEncoder?)`: writes everything except instanceCount.
- `draw()` then calls `drawIndexedIndirect` or `drawIndirect`. A CPU `instanceCount === 0` no longer skips the draw.
- Records: 16 B `[vertexCount, instanceCount, firstVertex, firstInstance]` or 20 B indexed. Usage: `INDIRECT` plus `STORAGE` or `COPY_DST`.
- WebGPU only; it asserts on WebGL.

Composing it with the graph:
1. A compute node writes the instanceCount word (`storage-read-write`).
2. The render node declares `{buffer: h, usage: 'indirect'}`.
3. Inside `encode`: `model.setIndirectBuffer(getBuffer(h), off); model.draw(renderPass)`.

Hazard order is automatic, since indirect counts as a read. Render nodes cannot be GPU-conditioned, so "skip" means `instanceCount = 0`.

## 7. Gap analysis vs src/lib/gpu/core/graph.ts (ComputeGraph)

### What we re-implement that upstream already has

| ours | upstream | verdict |
|---|---|---|
| `run({timings})` QuerySet + `readTimings` + `recordGpuTime` | `GPUCommandGraphInspector.observeGraph` (p50/p95, counters, per-node groups) | Could feed core/profile from `inspector.getSnapshot()`. Keep the query-set creation, since upstream needs `timeProfilingQuerySet` on the encoder too. |
| `core/readback` grow-on-demand slots + `readNode` staging | `GPUReadbackRing` (fixed-size slots) + `addCopyPass` | Upstream has no read node, and its ring is fixed-size. Keep ours (see the "upstream lacks" table). |
| `compileAsync` dedupe/retry/device-loss | `compileAsync` (once; graph frozen even on reject) | Ours adds idempotence, retry and `untilLost`. Keep the thin wrapper. |
| `clearNode` (copy pass + `clear`) | none; `addCopyPass` | Upstream has no node type for this. Keep. |
| `stats` passthrough | `compiled.stats` + **`preflight`** + execution plans | We ignore `preflight`, `workload`, budgets and `publication`. Expose `workload` on `KernelNode` to get preflight and `fitsDeviceLimits` for free. |
| CPU `condition` | CPU + GPU indirect | Our `KernelCondition` = `Extract<…,{source:'cpu'}>` **blocks GPU conditions** (G3). |
| only compute kernels; textures rejected in `addKernel` | full texture model (import/transient/view/frame/external, render attachments, MSAA resolve) | **Our wrapper**, not upstream, is the texture/render gap. There is no `addRenderPass`/`addCopyPass` passthrough, only `g.graph.*`. |

### What we need that upstream lacks

| need | upstream status |
|---|---|
| **Texture-valued program values** | `GPUProgram` has only `scalar`/`vector` in f32/u32/i32. Textures exist only at the command-graph level, so texture work must be custom primitives (`{getCommandNodes}`) and cannot sit under a runtime predicate unless the node carries `dispatchWorkgroups`. |
| **Clear lint** (partial/atomic writes to transients must be preceded by a clear) | None. Upstream validates hazards and import aliasing only. Arena and transients are uninitialised; correctness relies on each op fully writing. Ours is still needed and would be a good upstream PR ("transient initialisation contract"). |
| **`readNode`** (transient → readback in-graph, keeping its lifetime alive) | None. The documented pattern is `addCopyPass` into an imported buffer, plus `GPUReadbackRing` outside the graph (fixed-size slots). |
| **`cachedGraph`** (shape-keyed LRU, destroy under lease, device-loss purge) | None. `GPUIncrementalExecution` is batch-revision caching that **submits itself**; it conflicts with our queue/lease. Compiled graphs are fixed-capacity, so per-shape caching stays ours. |
| **f64 / emulation** | None. Formats are f32/u32/i32; no double-float ops. Solve's CPU fold and haze's f64 middle stage stay CPU unless we write emulation kernels (sketch b). |
| **Per-run parameter → GPUScalar** | None. `GPUProgramScalarLiteral` bakes `value` at compile, and there is no uniform-backed scalar. The adaptive `head` (haze) cannot be a program input. |
| **Public GPUScalar / arena / gate** | Internal. We have to mint our own control buffers + indirect conditions (sketches) or go through `GPUProgramCompiler`. |
| **GPU-conditioned copy/render** | Not possible (WebGPU has no indirect copy; render is CPU-only by contract). |
| **GPU-sized readback** | Not possible (WebGPU). |
| Mixing our `ComputeGraph` with a `GPUProgramCompilation` | `compile()` creates its own `GPUCommandLoweringGraph`, while our ComputeGraph constructs its own graph. **We need a `ComputeGraph` ctor option to adopt an existing graph** (G4), or register our kernels as lowerings on a `GPUProgramCompiler` subclass. |
| Clear-lint coverage of raw nodes | Our `addComputePass` passthrough skips the audit (G5). GPU-gated nodes added raw are invisible to the lint. |

**Wrapper changes suggested:**
- (G3) Widen `KernelNode.condition` to the full `GPUCommandGraphNodeCondition<P>`, and set `dispatchWorkgroups` on the node object so `GPUProgram` predicates can gate our kernels.
- (G4) `new ComputeGraph(device, id, {graph?})`.
- (G5) Audit the resources of raw `addComputePass` nodes.
- Add `workload` to `KernelNode`.
- Add `addRenderPass` / `addCopyPass` / `importFrameTexture` / `transientTexture` passthroughs.
- Allow texture bindings in `addKernel` (`GraphTextureUse`, `getTextureView`).

## 8. Migration sketches (scratchpad/proto, typecheck-only)

Setup:
- `proto/tsconfig.json` mirrors the repo's strict tsconfig, with `#/*` paths to the repo src and the repo `vite/client` types.
- `proto/node_modules` is a symlink to the repo node_modules.
- Command: `npx tsc -p tsconfig.json --noEmit`.
- **Result: both files typecheck with 0 errors**, including the transitively checked repo files.
- A deliberate negative test file failed as expected, which confirms the files really are checked.
- **The WGSL is NOT validated** (no naga or tint available) and nothing ran on a GPU.

### (a) proto/haze-tail.ts: the haze head-overflow tail

New nodes after `gather`:
- `hz-ctl` (1 thread) reads `starts[LISTS]` and a uniform `{head, cap}`. It writes `ctl = [total, overflow, ⌈min(total−head,cap)/64⌉, 1, 1]` into a `STORAGE|INDIRECT` transient.
- `tail-pack` is added through the raw `addComputePass` with `condition: {source:'gpu', mode:'indirect', buffer: ctl, byteOffset: 8}`. It is a GPU-sized dispatch that packs list slots `[head, head+n)` into a `tail` window.
- The read node adds `ctl` and the window.
- CPU: `afterRead()` returns `{total, packed, residual}`. The exact second `readBack` happens only when `total > head + cap`.

`programOverflowDemo()` typechecks the same predicate via `GPUProgram` + `scalarCompare` + `GPUConditionalOperation` and pulls `arena.buffer` / `wordOffset` from `compilation.scalars`. It shows the limits: `head` is a compile-time literal, and our kernels need `dispatchWorkgroups` to sit under a predicate.

**Verdict: don't ship (a) as written.**
- Copy sizes are CPU-fixed, so the window costs `2·cap·4` bytes every run whether the gate fires or not. It is equivalent to `head += cap`, and the gate saves only one small dispatch.
- No GPU condition or GPUScalar can remove this round trip in WebGPU.

**What does remove it: "copy capacity, map exact".**
1. In the same submit, copy the lists' full capacity (`3N` slots, ≤ 24·N bytes) into a second staging slot.
2. Map the small header slot first.
3. Then `mapAsync(READ, 0, total·4)` on the list slot. No new GPU work is needed; the buffer is already idle.

This needs `core/readback` to support a deferred, partial-range map of a second slot. The trade-off is copy bandwidth, roughly 26 MB at N≈1.1 M: near-free on unified memory, ~2 ms over PCIe.

### (b) proto/solve-fold.ts: the solve `foldBlocks` CPU fold

`K_FOLD_EXACT` keeps the f32 fast path. When the f32 margin test is inconclusive, it decides `v > g + 2ε` **exactly** on the GPU:
- 2ε (f64) is split on the CPU into `e0+e1+e2` f32 (`packFoldUniform`). It returns null when the split is inexact; the old path is kept for that case.
- The kernel runs a Shewchuk grow-expansion (TwoSum) over `[v, −g, −e0, −e1, −e2]`. The sign of the top component is the exact sign.
- Only true ties against the CPU's *rounded* fl64 threshold (`|·| ≤ 2^-50·(|g|+2ε)`) and FTZ-risk rows (`|g| < 1e-30`) keep flag 2 and today's blocks-variant + `foldBlocks` fallback.

`exactGraphFor()` is today's `graphFor(fold=true)` with the exact kernel: one submit, 16 B/row read. `decodeRows()` mirrors `coarseGraphOnce`.

No GPU condition is needed: the exact path runs per block inside the same thread. `gatedRefold()` shows the GPU-indirect-gated variant (atomicOr `anyClose` → `ctl-update` writes `[any ? ⌈nYaw/64⌉ : 0,1,1]` → gated `fold-exact`, after a clear node so the clear lint passes). It typechecks, but it adds 2 nodes for no gain.

**Risk**: TwoSum needs strict IEEE f32 with no reassociation. WGSL guarantees correctly rounded `+`/`−`, but backends with fast-math, or with subnormal flush, could break it.
- Add a per-device selftest (the core selftest pattern) before enabling it.
- Bit-compare against `foldBlocks` in the solve bench (`forceCpuFold` exists).
