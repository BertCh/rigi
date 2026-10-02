# src/lib/gpu/core: shared WebGPU compute foundation

This directory is the shared layer that every kernel in `src/lib/gpu/**` builds on. It uses luma 10.0.0-alpha.2's (vendored `10.0.0-alpha.2-rigi.6`) stable `@luma.gl/core` API plus the experimental `@luma.gl/gpgpu/gpu-core`, and it is meant to move to luma/deck "next" (WebGPU everywhere) with as little churn as possible. The house rules from `../README.md` all still apply:
- Every kernel keeps a CPU twin, and the CPU twin is the reference.
- `getComputeDevice()` resolving `null` means the caller takes the CPU path.
- `?gpu=off` turns everything off.
- A pure plumbing migration must give **bit-identical** GPU outputs.

Self-test: `node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/core-selftest.mjs`. It needs a dev server on this tree (`APP_URL`, default `http://localhost:3110`) and writes `out/gpu/core/selftest.json`.

Luma-native ratchet: `scripts/ci/gpu-raw-lint.mjs` (fast-tier check `gpu-raw-lint`) counts raw WebGPU (`navigator.gpu`, `requestAdapter`/`requestDevice`), native handle use (`.handle.queue`, `mapAsync`, `onSubmittedWorkDone`, `getCurrentTexture`), casts to private luma members and raw `gl.` calls per file in `src/lib/**`, and fails when a file's count goes up over `scripts/ci/gpu-raw-baseline.json`. New GPU code goes through luma (`Device`, `Buffer`, `CommandEncoder`, `device.submit`, `createFence`, `Texture.copyExternalImage`). A real must-stay (a gap in luma, a dev tool) is added with `node scripts/ci/gpu-raw-lint.mjs --write` plus a `why` note in the baseline; after removing an escape, run `--write` to lower the baseline.

| File | What it gives you |
|---|---|
| `luma.ts` | The **only** importer of `@luma.gl/gpgpu/gpu-core` (and of `gpu-vector-search`: `GPUKMeans`, `GPUSimilaritySearch`), with luma 10 migration notes. Wave H (2026-10-02) also re-exports `GPUGridAggregation`, `GPUGridBinning`, `GPUGridIndex(Query)`, `GPUBVH(Query)`, `GPUPointSpatialFilter`, `GPUBatchSort`, `GPUSegmentedSort`, `GPUMatVec`, `GraphVectorView`; wave F adds `GPUGather`, `GPUGroupAggregation`, `GPUFiniteDifference2D` (and uses `GPUCompaction`, `GPUConvolution`, `GPUHistogram`, `GPUSort` in look / photoprep / deck-webgpu). Import `GPUCommandGraph`, `GPUReduction`, `GPUSort`, `GPUHistogram`, `GPUScan`, `GPUFFT1D`, `GPUReadbackRing`, `GraphDataView` and the rest from here, never from the package |
| `device.ts` | The per-realm device registry: `getComputeDevice`, `adoptRenderDevice`, `resetComputeDevice`, `hasFeature`. The sidecar requests the adapter's maximum limits |
| `pool.ts` | A persistent grow-only buffer pool (per device), `withLease` for serialising async callers, and `clear` / `range` |
| `readback.ts` | Ring readback: staged copies into reusable MAP_READ slots on the caller's encoder, one map per read |
| `kernel.ts` | `defineKernel` (layout derived from the WGSL, or hand-written and validated against it) / `kernel` / `kernelAsync` / `encodeDispatch` / `encodeDispatchIndirect`, dispatching through the engine `Kernel.dispatch(pass, {bindings, x, y, z})` with the binding guards. A superset of `look/kernel.ts` |
| `queue.ts` | `submit(device, enc)`: finishes and submits the encoder, then runs the pool hook. Opt-in error checks (`__RIGI_GPU_CHECKS__`) |
| `binding-guard.ts` | Pure storage-binding checks (zero size, offset alignment) called by `encodeDispatch` |
| `profile.ts` | Opt-in GPU timestamp profiling (`globalThis.__RIGI_GPU_PROFILE__ = true`) and `getGpuProfile()`, including the GPU workers' reports |
| `realm.ts` | The page → worker protocol for the profiling / error-check switches, and the worker → page profile report. Import-light (no luma runtime) |
| `abort.ts` | `isAbortError`, `abortable`: cancellation helpers (see Cancellation below). No luma runtime |
| `lifecycle.ts` | `untilLost`, `onLost` and the activity counters behind the idle release. No luma runtime |
| `graph.ts` | `ComputeGraph`, a thin wrapper over `GPUCommandGraph` for multi-pass pipelines with GPU-resident intermediates. Since WAG W0.1 it also passes through upstream's GPU indirect conditions (compute nodes only, with a GPU-condition clear lint), render and copy nodes (audited like kernels), transient / frame textures and texture bindings in kernels, `workload` + `preflight`, and adopts an external `GPUCommandGraph` (`{ graph }`); `listCachedGraphs` enumerates the cache. `GPUCommandGraphInspector` is wired through `inspect.ts` (W0.2, see Inspection below). The clear lint, `readNode` and `cachedGraph` have no upstream equivalent. Audit: `research_notes/whole-app-graph-2026-10-01/upstream-api.md` |
| `inspector.ts` | One upstream `GPUCommandGraphInspector` per device (WAG W0.2), created on first observation and dropped with the device; `observeCompiledGraph`, `inspectorSnapshots` |
| `inspect.ts` | `inspectGraphs({ device?, observe? })`: every cached graph (and every graph observed outside the cache) with compile stats (transient bytes, aliasing savings), the upstream preflight (`fitsDeviceLimits`, workload bounds) and the inspector's per-node CPU encode / GPU p50 / p95. Backs `/dev/graph` |
| `selftest.ts` | `coreSelftest()` for the browser, which exercises all of the above against CPU results |

## API (exact signatures)

```ts
// device.ts
export const COMPUTE_FEATURES: readonly ["timestamp-query", "float32-filterable", "subgroups", "shader-f16"];
export type ComputeFeature = (typeof COMPUTE_FEATURES)[number];
export const RAISED_LIMITS: readonly [ /* maxStorageBufferBindingSize, maxBufferSize, maxComputeWorkgroupStorageSize,
  maxComputeInvocationsPerWorkgroup, maxComputeWorkgroupSize{X,Y,Z}, maxStorageBuffersPerShaderStage */ ];
export const gpuEnabled: () => boolean;
export function getComputeDevice(): Promise<Device | null>;          // adopted render device if alive, else the sidecar; null = CPU
export function adoptRenderDevice(device: Device | null | undefined): void; // WebGPU only; WebGL/null ignored; loss un-adopts
export const adoptedRenderDevice: () => Device | null;
export function resetComputeDevice(opts?: { destroy?: boolean }): void;
export function releaseWhenIdle(ms: number | null): void;            // destroy the sidecar after ms without GPU use
export function hasFeature(device: Device | null | undefined, feature: ComputeFeature): boolean;

// pool.ts
export const capacityFor: (bytes: number) => number;                 // next pow2, min 256
export function acquire(device: Device, key: string, byteLength: number, usage: number): Buffer;
export function pooledStorage(device: Device, key: string, data: ArrayBufferView | number,
  opts?: { usage?: number; zero?: boolean }): Buffer;                // STORAGE|COPY_DST|COPY_SRC; number => zeroed (zero defaults to true)
export function pooledUniform(device: Device, key: string, words: ArrayBuffer | ArrayBufferView): Buffer; // padded to 16 B
export const range: (buffer: Buffer, bytes: number, offset?: number) => { buffer: Buffer; offset: number; size: number };
export function clear(enc: CommandEncoder, buffer: Buffer, offset?: number, size?: number): void; // encoder clearBuffer
export const isPooled: (buffer: Buffer) => boolean;
export function withLease<T>(key: string, fn: () => Promise<T> | T, opts?: { signal?: AbortSignal }): Promise<T>; // FIFO mutex per key; "a" covers "a/…" slots
export function releasePool(device: Device, prefix?: string): void;
export function poolStats(device: Device): { slots: number; bytes: number };

// readback.ts
export type ReadRange = { buffer: Buffer; offset?: number; size: number };  // offset % 4 == 0
export type StagedRead = { read: () => Promise<ArrayBuffer[]>; cancel: () => void };  // a throwing core submit() cancels
export function stageReads(device: Device, enc: CommandEncoder, ranges: ReadRange[]): StagedRead;
// W0.5: deferred partial-range map. One `capacity` copy; read() maps [0, headerBytes) first, then only
// [0, total(header)) (total an integer in [0, capacity], else read() rejects). Correctness only: unmeasured.
export type PartialReadRange = { buffer: Buffer; offset?: number; capacity: number; headerBytes: number;
  total: (header: ArrayBuffer) => number };
export type StagedPartialRead = { read: () => Promise<{ header: ArrayBuffer; data: ArrayBuffer; total: number }>;
  cancel: () => void };
export function stagePartialRead(device: Device, enc: CommandEncoder, range: PartialReadRange): StagedPartialRead;
export function readBack(device: Device, build: (enc: CommandEncoder) => unknown, ranges?: ReadRange[],
  opts?: { id?: string; signal?: AbortSignal }): Promise<ArrayBuffer[]>;                   // ranges ?? (ReadRange[] returned by build)
export function readbackStats(device: Device): { slots: number; busy: number; bytes: number };

// queue.ts (submit is also re-exported from kernel.ts)
export function submit(device: Device, enc: CommandEncoder): void;  // throws GpuDeviceLostError on a lost device
export function cancelIfSubmitFails(enc: CommandEncoder, cancel: () => void): void; // stageReads registers here
export const submitted: (enc: CommandEncoder) => Promise<void>;     // rejects GpuValidationError if a checked submit failed
export const errorChecks: () => boolean;                            // globalThis.__RIGI_GPU_CHECKS__ === true
export class GpuValidationError extends Error { readonly kind: "validation" | "out-of-memory" }

// abort.ts (no luma runtime; re-exported by lifecycle.ts)
export function isAbortError(e: unknown): boolean;                       // a cancel (name "AbortError"), not a GPU failure
export function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T>; // rejects with signal.reason at once; p runs on
// lifecycle.ts
export class GpuDeviceLostError extends Error {}
export function untilLost<T>(device: Device, p: Promise<T>): Promise<T>;       // rejects as soon as device is lost
export function onLost(device: Device, fn: () => void): void;              // once; in a microtask if already lost
export const touch: () => void; export const busy: () => void; export const done: () => void; // realm activity
export const idleFor: () => number;                                  // ms since last use; 0 while work is in flight

// realm.ts
export type RealmGpuOptions = { profile?: true; checks?: true };
export function realmGpuOptions(): RealmGpuOptions | undefined;      // page: undefined when all off
export function applyRealmGpuOptions(o: RealmGpuOptions | undefined): void; // worker
export { takeGpuProfile, mergeGpuProfile } from "./profile";

// kernel.ts
export type BindKind = "uniform" | "storage" | "read-only-storage" | "texture"; // texture: 2-D unfilterable-float (graphs: a GraphTexture)
export type KernelSpec = { id: string; source: string; layout: [string, BindKind][]; entryPoint: string;
  constants?: Record<string, number>; group: string; label: string };
export type Kernel = { pipeline: ComputePipeline; names: string[]; spec: KernelSpec };
export type KernelOptions = { entryPoint?: string; constants?: Record<string, number>; group?: string; label?: string };
export function defineKernel(id: string, source: string, opts?: KernelOptions): KernelSpec;               // layout derived from the WGSL
export function defineKernel(id: string, source: string, layout: [string, BindKind][] | undefined, opts?: KernelOptions): KernelSpec; // dev/tests: layout must equal the derived one
export function deriveLayout(source: string): [string, BindKind][];  // luma getShaderLayoutFromWGSL, group 0, bindings 0..n-1
export const definedKernels: (group?: string) => KernelSpec[];
export function kernel(device: Device, spec: KernelSpec): Kernel;                 // sync, cached per (device, spec)
export function kernelAsync(device: Device, spec: KernelSpec): Promise<Kernel>;   // Device.createComputePipelineAsync, same cache
export function warmKernels(device: Device, group?: string): number;              // failures; never throws
export function warmKernelsAsync(device: Device, group?: string): Promise<number>;
export function encodeDispatch(pass: ComputePass, k: Kernel, bindings: Bindings, x: number, y?: number, z?: number): void;
export function storage(device: Device, data: ArrayBufferView | number): Buffer;  // fresh (look semantics)
export function uniform(device: Device, words: ArrayBuffer): Buffer;              // fresh, padded to 16 B
export function stage(device: Device, enc: CommandEncoder, src: Buffer, bytes: number):
  { read: () => Promise<ArrayBuffer>; cancel: () => void };           // ring slot, exactly `bytes`
export function release(...bufs: (Buffer | null | undefined)[]): void;           // skips pooled buffers

// profile.ts
export type GpuProfile = Record<string, { gpuMs: number; count: number }>;
export const profiling: (device: Device) => boolean;
export function recordGpuTime(label: string, ms: number): void;
export function getGpuProfile(): Promise<GpuProfile>;
export function resetGpuProfile(): void;
export const profileRequested: () => boolean;
export function takeGpuProfile(): Promise<GpuProfile> | undefined;   // worker: totals, then cleared; undefined when off
export function mergeGpuProfile(realm: string, p: GpuProfile | undefined): void; // page: adds `${realm}:${label}`

// graph.ts
export type GraphBinding = GraphBufferHandle | GraphDataView;
export type Workgroups = [number, number?, number?];
export type KernelNode<P> = { id: string; spec: KernelSpec; bindings: Record<string, GraphBinding>;
  workgroups: Workgroups | ((parameters: P) => Workgroups); dependsOn?: string[] };
export type GraphOp<P> = GPUNode<P>;   // luma 10 (#3258): graph.add(op) replaces op.addToGraph(graph)
export class ComputeGraph<P = void> {
  readonly device: Device; readonly id: string; readonly graph: GPUCommandGraph<P>;
  constructor(device: Device, id: string);
  importBuffer(id: string, byteLength: number, buffer?: GraphImportedBuffer, usage?: number): GraphBufferHandle;
  transientBuffer(id: string, byteLength: number, usage?: number): GraphBufferHandle;
  view<T extends GPUScalarFormat>(buffer: GraphBufferHandle, format: T, length: number, byteOffset?: number): GraphDataView<T>;
  importTexture(descriptor: GraphTextureDescriptor, texture?: GraphImportedTexture): GraphTextureHandle;
  addKernel(node: KernelNode<P>): this;
  addComputePass(node: Omit<GPUCommandGraphComputeNode<P>, "type">): this;
  add(op: GraphOp<P>, opts?: { uses?: GraphBufferHandle[] }): this;  // GPUReduction, GPUSort, …; audited (W0.1)
  declareNode(id: string, audit: { uses?; writes?; cleared?; condition? }): this; // raw g.graph.* / adopted nodes
  compile(): this;
  encode(enc: CommandEncoder, parameters: P, buffers?: Record<string, GraphImportedBuffer>,
    textures?: Record<string, GraphImportedTexture>): GPUCommandGraphEncoding;
  run(parameters: P, opts?: { buffers?: Record<string, GraphImportedBuffer>; textures?: Record<string, GraphImportedTexture>;
    read?: ReadRange[]; timings?: boolean; signal?: AbortSignal }):
    Promise<{ data: ArrayBuffer[]; timings?: GPUCommandGraphTimingReport }>;
  destroy(): void;
  // additive (worker-realm graph migration, 2026-09-30):
  clearNode(id: string, target: GraphRange<P>, opts?: { dependsOn?: string[] }): this;  // encoder clearBuffer
  readNode(id: string, targets: GraphRange<P>[], opts?: { dependsOn?: string[] }): this; // → one readback slot
  encodeReads(enc, parameters, buffers?, textures?): { encoding: GPUCommandGraphEncoding; reads: GraphReads };
  compileAsync(): Promise<this>;  lease<T>(fn): Promise<T>;  readonly isCompiled: boolean;  readonly stats;
  own(resources: Iterable<{ destroy(): void }>): this;  // builder-made buffers / textures, destroyed with the graph (cachedGraph eviction, device loss)
  // KernelNode.bindings also take a GraphRange (per-run { offset, size }: capacity-keyed graphs bind
  // exactly the bytes a call uses)
  // run() also resolves `reads: Record<readNodeId, ArrayBuffer[]>` and, in a finally, cancels every
  // staged slot not read (a throwing stage/submit, a checked submit's validation error, a failed read).
  // KernelNode.writes?: Record<binding, "full" | "partial" | "atomic"> (cleared?: string[] = "partial"):
  // runNow(parameters, opts?) (WAG geoquery-pool, 2026-10-01): run() without the lease, for graphs with
  // no transients; compile / encode / stage / submit happen synchronously in the call (throws on a
  // graph with transients), so imports written with queue.writeBuffer right before it are this run's
  // and a concurrent call's writes land after its submit. Timed only when no other timed run is in flight.
  // compile() lints the scheduled order and throws when such a transient has no clear node before it
  // (or is used before its clear). stats: compiled stats + nodeCount. GraphReads.pending: unread slots.
  // additive (WAG W0.1, 2026-10-01; graphs not using these encode exactly as before):
  constructor(device: Device, id: string, opts?: { graph?: GPUCommandGraph<P> }); // adopt (same device)
  importFrameTexture(descriptor: GraphTextureDescriptor): GraphTextureHandle;   // run({ frameTextures })
  transientTexture(descriptor: GraphTextureDescriptor): GraphTextureHandle;     // never cleared, aliased
  textureView(texture: GraphTextureHandle, props?: GraphTextureViewProps): GraphTextureView;
  addComputePass(node: Omit<GPUCommandGraphComputeNode<P>, "type"> & RawNodeAudit): this; // now audited
  addCopyPass(node: Omit<GPUCommandGraphCopyNode<P>, "type"> & RawNodeAudit): this;
  addRenderPass(node: Omit<GPUCommandGraphRenderNode<P>, "type"> & RawNodeAudit): this;
  readonly preflight: GPUCommandGraphPreflightReport | undefined;  fitsDeviceLimits(): boolean | undefined;
  encode(enc, parameters, buffers?, textures?, extras?: GraphEncodeExtras<P>); // also encodeReads; run({ frameTextures })
  // KernelNode.condition: CPU { source: "cpu", evaluate } or GPU { source: "gpu", mode: "indirect", buffer,
  // byteOffset? } (dispatch → dispatchIndirect; see the GPU-condition lint below). KernelNode.workload →
  // upstream preflight. KernelNode.bindings: a "texture" layout entry takes a GraphTexture (sampled).
  // Fixed `workgroups` also set the node's upstream `dispatchWorkgroups` (for program-compiler predicates).
}
export type GraphTexture = GraphTextureHandle | GraphTextureView;
export type KernelCondition<P> = GPUCommandGraphNodeCondition<P>;   // was CPU-only
export type RawNodeAudit = { cleared?: (GraphBufferHandle | GraphDataView)[] }; // partial / atomic writes
export type GraphEncodeExtras<P> = Pick<GPUCommandGraphEncodeOptions<P>, "frameTextures" | "externalTextures" | "coalesceComputePasses">;
export type GraphRange<P> = GraphBufferHandle | GraphDataView
  | { buffer: GraphBufferHandle; offset?: number; size: number | ((p: P) => number) };
export function cachedGraph<P, X>(device: Device, group: string, key: string,
  build: (g: ComputeGraph<P>) => X, max?: number /* 4 */,
  create?: (id: string) => ComputeGraph<P> /* e.g. adopting a GPUProgramCompiler's graph */): { graph: ComputeGraph<P>; extra: X; hit?: boolean }; // LRU per group
export function cachedGraphFrom<P, X>(device: Device, group: string, key: string,
  make: (id: string) => { graph: ComputeGraph<P>; extra: X }, max?: number): { graph: ComputeGraph<P>; extra: X; hit?: boolean };
export function cachedGraphCount(device: Device, group?: string): number;
export function releaseCachedGraphs(device: Device, group?: string): Promise<void>;
export function listCachedGraphs(device?: Device, group?: string): CachedGraphInfo[]; // LRU order, read-only
export type CachedGraphInfo = { device; group; key; id; graph: ComputeGraph<unknown>; compiled: boolean; stats };
// ComputeGraph (W0.2): get capabilities(); inspect(): GPUCommandGraphInspectorObservation<P> | undefined

// inspect.ts / inspector.ts / profile.ts (W0.2)
export function inspectGraphs(opts?: { device?: Device; observe?: boolean /* true */ }): GraphInspection[];
export function summarizeGraph(input: { device; id; group?; key?; cached; compiled; stats?; preflight?; snapshot? }): GraphInspection; // pure
export function observeCompiledGraph<P>(compiled: CompiledGPUCommandGraph<P>): GPUCommandGraphInspectorObservation<P>;
export function inspectorSnapshots(device?: Device): { device: Device; snapshot: GPUCommandGraphInspectorSnapshot }[];
export function getGpuGraphProfile(): Promise<GpuGraphProfileEntry[]>; // per observed graph, from the snapshots
```

## Composing with luma operators (contributors and GraphDataViews)

This is the preferred way to use a luma operator: put it in the same `ComputeGraph` as the Rigi kernels, with
no glue buffers. Proven in `scripts/gpu/core-interop-dawn.ts` (Rigi kernel, gpgpu `GPUElementwise`, gpu-raster
`GPURasterThreshold`, gpgpu `GPUReduction`, readback; exact against a CPU reference).

```ts
const g = new ComputeGraph(device, "id");
const a = g.importView("a", rigiBuffer, "float32", n);   // a Rigi / pooled Buffer as a GraphDataView, no copy
const t = g.transientView("t", "float32", n);            // graph scratch as a view (luma createTransientView)
g.addKernel({ id: "k", spec: K, bindings: { out: t }, workgroups: [n / 64] }); // views bind as their exact range
g.add(new KernelOp({ id: "k2", spec: K2, bindings: { ... }, workgroups: [...] })); // same kernel as a contributor
g.add(new GPUElementwise({ ... }));                      // any op with getCommandNodes(graph)
g.add(new GPURasterThreshold({ ... }));                  // any gpu-raster op: addToGraph(graph)
g.compile();
const { data } = await g.run(p, { read: [viewRange(outView, outBuffer)] }); // a view back to a Rigi byte range
```

- `ComputeGraph.add(op)` takes producers (`getCommandNodes`), groups (`getNodes`), raw command nodes, arrays, `KernelOp`
  and `addToGraph(graph)` ops. For the last, the graph's `add*` mutators are shadowed while `addToGraph` runs, so every
  node the op adds goes through the audited path: the clear lint sees it, and a raster op's transients are covered.
  Ops compare `view.buffer.graph !== graph`, so their views must come from THIS graph (`view`, `importView`, `transientView`).
- `KernelOp` (`new KernelOp(kernelNode)`) is a `GPUCommandNodeProducer`: a defineKernel kernel can be added to any
  luma op tree or a plain `GPUCommandGraph` (`graph.add(op)`) next to luma ops.
- `importView(id, buffer, format, length, byteOffset?)` imports a Rigi buffer (pool lease, `storage()`, any luma Buffer);
  pass `buffers: { [id]: buffer }` to `run()` to rebind it (a grown pooled slot). `viewRange(view, buffer)` is the
  `{ buffer, offset, size }` of a view inside the Buffer behind its import handle (`run({ read })`, `stageReads`, direct
  `encodeDispatch` bindings). `getViewBinding` / `createGPUComputeCommandNode` / `createTransientView` are re-exported
  from `luma.ts` for hand-written contributors.
- Writing a new Rigi contributor: a class with `getCommandNodes(graph)`, taking `GraphDataView`s, scratch from
  `createTransientView(graph, ...)`, nodes from `createGPUComputeCommandNode({ resources, compile })` (or a `KernelOp`).
  Declare every buffer use in `resources`, since the lint and the scheduler read only that.

## Packing uniforms: `uniform-block.ts`

New kernels declare their uniform struct once with `defineUniformBlock` instead of hand-writing `Float32Array` / `Uint32Array` / `Int32Array` words. It wraps luma's `makeShaderBlockLayout` + `ShaderBlockWriter` with the `wgsl-uniform` layout (WGSL uniform address-space alignment: `vec3` aligned to 16 B and followed by a scalar in its 4th word, `vec2` to 8, `mat4x4` as four 16 B columns).

```ts
const PRM = defineUniformBlock({ n: "u32", nonce: "u32", w: "i32", h: "i32" }); // WGSL struct order
pooledUniform(device, `${slot}/prm`, PRM.pack({ n, nonce, w, h })); // ArrayBuffer, PRM.byteLength rounded up to 16
```

Types are luma shader types (`f32`, `u32`, `i32`, `vec2<f32>`, `vec3<f32>`, `vec4<u32>`, `mat4x4<f32>`, ...); vec / mat values are flat number arrays; unlisted fields are zero. Field order and types must mirror the WGSL `struct`. Byte equality with the old hand packing is proved per batch (CI fast tier): `uniform-block.check.ts` (`gpu-uniform-block`: geo-query, silhouette, terrain-cull incl. `packCullParams`); `uniform-block-a.check.ts` (`gpu-uniform-block-a`: align cert / pose-bound / pose-grid, solve fold, horizon certified / ridges / mosaic mip, packers in `gpu/{align,solve,horizon}/uniforms.ts`); `uniform-block-look.check.ts` (`gpu-uniform-block-look`: `look/uniform-blocks.ts`, `HEIGHTS_PARAMS` / `TILE_ROW` in `look/relief-heights.ts`, `PROBE_UNIFORM` in `precision/ieee-probe.ts`). Owner-file packers (solve `packCoarse` via `COARSE_U`, photoprep `photoPrepDims`, color-stats `statsParamWords`, haze `prepUploads` / `gridUploads` / `bandWords`, `reliefWords`) use blocks too; `core/__tests__/uniform-block-owners.spec.ts` keeps the old packers as references and compares bytes. `uniform-block-b.check.ts` (`gpu-uniform-block-b`: horizon march `MARCH_U`, skyglobal `SKYGLOBAL_U`, skyline `SKYLINE_P`, sky prep / refine `SKY_PREP_P` / `SKY_REFINE_P`, splat-sort `SPLAT_SORT_PARAMS`, each in its module's `uniforms.ts`). Not on blocks: params that are runtime-sized arrays or storage buffers (use `pooledStorage`), `selftest.ts` and bench harnesses (raw on purpose), and deck render-layer per-draw buffers (`tiles3d` `TileData`, `multi-drape` tile info: contiguous all-f32 with change detection on the float array).

## Rules for migrating a kernel

1. **Device.** Import `getComputeDevice` from `#/lib/gpu/device`. Branch on `hasFeature(device, …)` before using `subgroups` or `shader-f16`: an adopted render device may not have them.
2. **Pipelines.** Use `defineKernel(id, WGSL, layout, { group, label })` at module level, and fetch the pipeline with `kernel(device, spec)`. Warm up with `warmKernelsAsync(device, group)`.
3. **Dispatch.** Run kernels as `ComputeGraph` nodes. `encodeDispatch(pass, k, bindings, x, y, z)` sets the bindings on the pass (never on shared pipeline state) and refuses, by throwing, a dispatch over `maxComputeWorkgroupsPerDimension`, a zero-size storage binding (luma #3338: it invalidates the whole submit) and a storage binding offset that is not a multiple of `minStorageBufferOffsetAlignment` (luma #3332); the two binding rules live in `binding-guard.ts` (pure, fast-tier check `gpu-binding-guard`). The standalone `dispatch` / `dispatchAll` were deleted from `kernel.ts` (no app callers); `test-dispatch.ts` keeps them for `selftest.ts` and `scripts/gpu/*-page.ts` only.
4. **Buffers.** For steady-state calls, use `pooledStorage` / `pooledUniform` / `acquire` with keys `"<owner>/<slot>"`, and wrap the whole acquire → encode → submit → read sequence in `withLease("<owner>", …)` whenever calls can overlap (async callers, workers sharing a module). Two traps can break bit-identity:
   - **Capacity > request.** A pooled buffer has a power-of-two capacity. If the WGSL uses `arrayLength()`, bind `range(buf, bytes)`.
   - **Stale contents.** A pooled buffer keeps the previous call's bytes. If a kernel relied on `storage(device, n)` being zeroed (for example with atomics or partial writes), use `pooledStorage(device, key, n)` (which zeroes by default) or `clear(enc, buf)`. Only pass `{ zero: false }` for outputs the kernel fully overwrites.
5. **Submit.** Use `submit(device, enc)`, not `device.submit(enc.finish())`. It destroys grown-out pool buffers and collects profiling. `submitWithDefault(device, extra)` batches the device's default encoder and compute encoders in one `queue.submit` through luma's public `device.submit(undefined, extras)` (rigi.4), inside the same optional error scopes.
6. **Readback.** Use `stage(device, enc, src, bytes)` (one range) or `stageReads(device, enc, ranges)` (several), then call `.read()` after `submit`. Use `readBack(device, build, ranges)` when it can own the encoder. Never call `readAsync` on a non-MAP_READ buffer: luma allocates a temporary buffer and encoder every time.
7. **Release.** `release(...)` destroys fresh buffers and skips pooled ones, so a mixed list is safe.

### Page-side graphs: no first-use compile hitch

A kernel's WGSL compile is what hitches the main thread; a graph's `compile()` is cheap once its kernels' pipelines are in the per-device kernel cache (`kernel()` and `kernelAsync()` share it). So on the page:

1. **Async entry point** (a `Promise`-returning function): `await graph.compileAsync()` after `cachedGraph(...)`, inside the same pass lease, then `graph.run(...)` (`look/textures.ts` masks / stats / haze, `ingest/terrarium-tile.ts` `terrariumTileStatsGpu`).
2. **Synchronous entry point** that records into a caller's encoder (`encodeMasksTex`, `encodeBandStatsTex`): never `compile()`. If the graph is not compiled, start `compileAsync()` and throw; the caller's catch takes its non-fused path for that frame and the next frame finds the graph compiled.
3. **Synchronous entry point that must produce this tick** (`TerrariumLayerWriter.write`, `FlowCore.ensure`): prewarm the kernels at construction (`warmKernelsAsync(device, group)` / `kernelAsync`) and keep the synchronous `compile()`. It finds the cached pipelines when the warm-up has finished and only compiles them itself when it has not. Async callers of the same object await its `ready` promise first, before they read any state they will encode with (a grown atlas replaces its texture while they wait).
4. A graph of copy passes only (`atlas-resize|…`) has no pipeline: its `compile()` stays synchronous.

`compile()` throws while a `compileAsync()` of the same graph is in flight, so a path that may meet one (rule 2) must not call it.

Constant buffers a builder creates (`look/textures.ts` footprints, parameter words) go to `graph.own(array)`: `cachedGraph` evicts with `graph.destroy()`, which destroys them too.

### `look/kernel.ts`

`look/kernel.ts` keeps only `defineKernel` (group `"look"`, label `look-<id>`), `warmKernelsAsync` and the pool / readback re-exports the look graphs use. Its pooled-dispatch helpers (`kernel`, `dispatch`, `dispatchAll`, `stage`, `storage`, …) went with the pooled look paths on 2026-10-01: every look kernel runs as a `ComputeGraph` node. `stage` / `stageReads` stay in core; `dispatch` / `dispatchAll` are test-only (`test-dispatch.ts`).

## Design notes

- **Cancellation.** `withLease`, `ComputeGraph.run` / `runNow` and `readBack` take an optional `AbortSignal`. An aborted lease waiter still takes its turn in the FIFO chain but never runs `fn`, and its caller rejects with `signal.reason` at once instead of when the lease would have come. `run` checks the signal before encoding, again right before `submit` (nothing is submitted, `finish()` returns the staged slots), and races the readback against it. Once work is submitted it cannot be recalled: the caller rejects early, and the staged slot goes back to the ring only when its map settles (the existing `read()` finally path), so a slot is never reused while a map is in flight. Callers catch with `isAbortError(e)` and must not fall back to the CPU or log an error on a cancel. Signals only exist in the realm that owns them: work in a worker is cancelled by terminating the worker.
- **Device limits.** luma's featureLevel `"max"` raises limits but also requests every feature, so `device.ts` (`createSidecar`) calls `webgpuAdapter.create` (re-exported by `luma.ts`) with `featureLevel: "core"`, `COMPUTE_FEATURES` as `optionalFeatures` and `RAISED_LIMITS` at the adapter maximum as `requiredLimits` (luma #3312); the maxima are read from a peek adapter, the only raw WebGPU left. A luma-created device owns its GPUDevice, so `destroy()` releases it. `attachWebGPUDevice` remains for the node/Dawn scripts and checks that bring their own GPUDevice. If that request fails, it retries with default limits. On this Mac (Apple, Metal) the sidecar now gets `maxStorageBufferBindingSize` / `maxBufferSize` of 4 GiB−4, and `maxComputeWorkgroupStorageSize` of 32 KiB.
- **Adopted device.** `getComputeDevice()` returns the adopted render device instead of the sidecar. Pipelines, pools and readback slots are all per device (WeakMaps), so both devices can be live at once. Never mix buffers between devices.
- **Pool retirement.** When a slot grows, the old buffer is destroyed once the lease covering that key ends. For unleased slots it happens at the next core `submit()`. Unleased callers must therefore encode and submit without awaiting in between.
- **Why readback does not use `GPUReadbackRing`.** Its slots have one fixed byte length and `acquire()` waits when every slot is busy. Our readback sizes vary per call (and per photo), so `readback.ts` implements the same ticket pattern (reserve, copy on the caller's encoder, submit, map, return the slot) with grow-on-demand slots. Up to 4 idle slots are kept per device. The ring is still re-exported from `luma.ts` for fixed-size streaming readbacks. Slots are read with luma's `Buffer.mapAndReadAsync(cb, offset, length, { waitForSubmittedWork: false })` (rigi.4; the default `true` awaits `queue.onSubmittedWorkDone()`, so a read would also wait for work submitted after its encoder): the MAP_READ slot is mapped in place, offset 0 and a 4-byte-multiple length, the callback slices out copies and luma unmaps after it. Behaviour notes: with `debug` on, luma wraps each read in a validation error scope that stays open across the await (attribution only); a throwing callback would leave the slot mapped, ours only slices. Re-audited on rigi.3 (LF7): #3330 makes `Buffer.readAsync` stage only the requested range, but it still allocates a temporary buffer, waits on `onSubmittedWorkDone` and submits its own encoder per call, and the ring's tickets read through it, so nothing here retires.
- **Async pipelines.** luma 10 has `Device.createComputePipelineAsync` (visgl/luma.gl#3204; `GPUDevice.createComputePipelineAsync`, layout `auto`, same descriptor as the sync path). `kernelAsync` uses it; in luma 9.4 it called the raw GPUDevice method and passed the `handle` into `device.createComputePipeline`. The self-test checks that the sync and async pipelines give bit-identical output.
- **Profiling.** There is no per-pass timestamp path any more (`passProps` was deleted with `dispatch`). Graph runs use the encoder's `timeProfilingQuerySet` and report under `<graphId>/<nodeId>`. Chromium quantises timestamps (about 65 µs steps on this Mac), so a single small pass can read as 0 ms: sum over many calls.
- **Worker profiling.** Kernels in the GPU workers run in their own realm. The worker clients put `realmGpuOptions()` on a message they already send (`spans` for horizon-fast-app, `prepare` / `solve` for unknown-pose, the eye search request); it is `undefined` unless the page profiles or checks, so nothing changes by default. The worker calls `applyRealmGpuOptions`, and attaches `takeGpuProfile()` to its result (`dirs`, the solve response, `done` / `error`); the client merges it as `horizon-worker:…`, `unknown-pose-worker:…`, `eye-worker:…`. `scripts/gpu/with-gpu-profile.mjs` therefore reports worker kernels too, with per-realm sums under `realms`. A worker terminated before it answered is missed.
- **Worker flags.** A worker has no page URL, so `getFlag` there reads the defaults. `realmGpuOptions()` also carries `flags`: the page's explicitly set flags from `FORWARDED_FLAGS` (`gpu`, `skylineGpu`, `focalSeedGate`), stringified; `applyRealmGpuOptions` turns them into `setFlagOverride`s in the worker (unknown keys ignored). Unset flags are not sent, so default messages are unchanged. Explicit protocol fields (`gpu: "off"` for the eye worker, `the GPU mip build` for horizon-fast-app) are applied after and win. Add a flag to `FORWARDED_FLAGS` when worker-reachable code starts reading it; `core/realm-flags.check.ts` covers the round trip.
- **Error checks.** WebGPU validation and OOM errors are asynchronous, so without checks a broken kernel resolves whatever its output buffer held. With `globalThis.__RIGI_GPU_CHECKS__ = true` (forwarded to the workers like profiling), `submit()` wraps `finish()` + `queue.submit()` in `validation` and `out-of-memory` error scopes. Encoder errors (invalid pipeline, bind group, destroyed or failed buffers used by a pass) surface at `finish()`, so one scope covers every dispatch on the encoder. Every staged read of that encoder (`readBack`, `stage`, `stageReads`, `ComputeGraph.run`) then rejects with `GpuValidationError`, and callers take their CPU path. Outputs that stay on the GPU can await `submitted(enc)`. Errors raised outside the encoder (e.g. `createBuffer` OOM) still reach the buffer's first use. Cost: see the self-test's `error-checks-cost`. It stays opt-in until the cost is confirmed in the app benches.
- **Device loss.** `submit()` throws `GpuDeviceLostError` on a lost device. Staged reads, timestamp reads, `readTimings` and async pipeline builds race the device's `lost` promise, so work in flight rejects promptly (and releases its lease) instead of waiting on a map that may never settle. Pools, readback slots, kernel caches and profiler query sets drop themselves on loss (`onLost`, which also runs hooks registered after the loss, so state recreated on a stale device reference is dropped too). When `submit()` throws, it cancels the reads staged on that encoder, so their slots and the realm's in-flight count are returned even if the caller does not `cancel()`. `getComputeDevice()` never returns a lost device: it notices `isLost` synchronously (luma sets it in `destroy()`) and creates a new sidecar, up to 3 losses per realm; after that the realm stays on the CPU. Resets and idle releases are not counted as losses.
- **Idle release.** `releaseWhenIdle(ms)` destroys the realm's sidecar after `ms` without `getComputeDevice()` / `submit()`, never while a lease is held or a readback is in flight. It forgets only the sidecar; an adopted render device stays adopted. The unknown-pose worker uses 30 s (it lives as long as the photo, but uses the GPU in bursts). The one-shot workers (horizon-fast-app, eye) are terminated after their job, which frees their device anyway.
- **Devices per realm (typical `/photo` load).** On the page, the adopted WebGPU render device (or a sidecar under the WebGL fallback), one in the horizon-fast-app worker (created on the `spans` message so creation overlaps the tile work; terminated after the march), and one in the unknown-pose worker (created on `prepare` to warm the solve kernel while the scene loads; terminated after the second opinion, or released after 30 s idle when it is kept for an unknown-pose photo). The eye worker (`?eyesearch`) adds one while a search runs. The sky worker's nn-runtime model runs on the worker's registry device. Nothing creates a device on import.
- **Graph.** `ComputeGraph.run` holds a lease on `graph:<id>`, because transients and timestamp slots are shared between runs. `runNow` skips it for transient-free graphs whose callers write their (pooled) imports in the same synchronous block as the call (deck-webgpu/geo-query-gpu.ts). A `GraphDataView` is bound with its exact byte range, and its `byteOffset` must be a multiple of 256 (the storage-binding offset alignment). `run({ read })` reads imported buffers; a `readNode` copies transients (or imports) into a readback slot at its point in the graph.
- **Graph transients are never zeroed, and they alias.** A transient gets the physical buffer of another transient whose lifetime ended earlier (and the previous run's bytes). Anything read-modify-written (atomics, accumulators, partial writes that are later read) needs a `clearNode` before it; declare those bindings in `KernelNode.cleared` and `addKernel` refuses a transient without one. Independent nodes may interleave, so pass `dependsOn` when an ordering matters (the selftest does, to force aliasing).
- **GPU-conditioned nodes (W0.1).** A GPU indirect condition turns the kernel's one dispatch into `dispatchIndirect(buffer, byteOffset)`; x = 0 skips it and any other x shortens or lengthens it, so its outputs are only partly written. `compile()` therefore treats every transient a GPU-conditioned node writes as written partially when a later node, up to the next whole clear of it, may use it without the same gate: a node not gated by the same indirect command (same buffer and byteOffset), any node after the command buffer is written again (including a clear of it, or the gated writer itself writing it), or a node the lint cannot see. That transient then needs a **whole-buffer** `clearNode` (a handle, or a fixed range / view from offset 0 covering it; parameter-sized ranges never count) before the conditioned node, or `compile()` throws. Readers gated by the same command before any rewrite need no clear (they run with the same x); this assumes they read only what the writer wrote for that x. The lint sees `addKernel`, `clearNode`, `readNode`, `addComputePass` / `addCopyPass` / `addRenderPass` and `add(op)` nodes (flattened like upstream `add`, audited from each command node's declared resources, plus `opts.uses`). Raw `g.graph.*` nodes and nodes already in an adopted graph are invisible unless declared with `declareNode(id, { uses, writes, cleared, condition })`: when a GPU gate exists, an undeclared node after a gated writer counts as an ungated user, and an undeclared GPU-conditioned node (found in `preflight`) is refused. Pure logic in `clear-lint.ts`, node check `clear-lint.check.ts` (CI fast tier `gpu-clear-lint`). Read nodes and copy / render nodes cannot be GPU-gated (WebGPU has no indirect copy), so reading such an output back always needs the clear. CPU conditions are not linted (unchanged). Imports and textures are outside the clear lint. Raw `addComputePass` / `addCopyPass` / `addRenderPass` nodes are audited from their declared buffer resources (writes = `storage-write`, `storage-read-write`, `copy-destination`; `cleared` = partial / atomic writes); `add(op)` nodes are not.
- **Inspection (W0.2).** Off by default: a graph is observed on its device's `GPUCommandGraphInspector` only once `ComputeGraph.inspect()` is called (by `inspectGraphs()`, i.e. `/dev/graph`) or when it encodes while `__RIGI_GPU_PROFILE__` is on. An observed graph encodes through the observation handle (the same `CompiledGPUCommandGraph.encode`, then the CPU encode times are recorded), so the commands are unchanged; a timed run hands its one `readTimings()` to the handle instead of reading twice. `destroy()` detaches. Graphs of the same id on one device replace each other's registration (upstream semantics). Worker realms keep their own inspectors; nothing is sent to the page (the app graph manifest, `src/lib/gpu/app-graph`, declares them). Node check `inspect.check.ts` (fast tier `gpu-inspect`).
- **Shape-keyed cache.** `cachedGraph(device, group, key, build)` keeps 4 compiled graphs per group (LRU; an evicted graph is destroyed under its lease). Call it inside the group's own lease and queue the graph's lease synchronously after it. Callers that encode chunks themselves (`encodeReads` + core `submit`) hold `graph.lease()` for the whole sequence.

## Self-test result (2026-09-30, Apple GPU, headless Chromium)

18/18 checks pass in about 1.2 s (2026-09-30 core fix round; the 13 below plus realm-profile, error-checks, error-checks-cost, idle-release incl. an adopted device surviving it, device-loss incl. late onLost hooks and a stale-device submit that leaks no slot):
- device, features and limits
- `gpu=off`
- pool
- lease
- readback: slot reuse, unaligned sizes
- kernel with per-pass bindings: 3 binding sets in one encoder, plus `dispatchAll`
- sync vs async pipeline: bit-identical
- pooled vs fresh buffers: bit-identical, including growth
- graph (custom WGSL fill → `GPUReduction` extent): exactly equal to the CPU min/max, with per-node timings
- profile
- adoptRenderDevice: adopt, run a kernel, destroy, fall back to the sidecar
- graph-clear-alias (2026-09-30 migration): two transients forced to alias (1 physical for 2 logical); with a clear node the atomic histogram is exact on two runs with different data and sizes, without one it inherits the other transient's / the previous run's bytes; readNode on transients, including a parameter-sized range; the `cleared` check refuses an uncleared atomic transient
- graph-compile-async: `compileAsync` (createComputePipelineAsync) bit-identical to a sync-compiled graph; concurrent calls share one compilation
- graph-cache: hit returns the same graph, LRU eviction destroys (under the lease), runs of cached graphs exact
- graph-read-leak: a checked submit's validation error after a read node, and a graph kernel node over maxComputeWorkgroupsPerDimension (encodeDispatch's guard applies to graph nodes) thrown mid-encode, both reject run() and leave no readback slot busy; encodeReads' `pending` counts unread slots

WAG W0.1 / W0.5 (2026-10-01, Apple GPU, headless Chromium, scripts/gpu/core-selftest.mjs): 29/29 checks pass in about 1.3 s. New checks:
- graph-cache-list: `listCachedGraphs` returns the two `selftest-cache` entries in LRU order, ids `group|key`, compiled, also in the device-less listing
- graph-gpu-condition: a fill gated by a GPU indirect command; an ungated read node or kernel reading its transient is refused at compile; with a clear node, x = full gives the fill and x = 0 zeros; a reader gated by the same command needs no clear and gives fill + 1 (x = 0 leaves its import untouched); preflight counts 2 conditional nodes
- graph-adopt-preflight: `new ComputeGraph(device, id, { graph })` adopts the GPUCommandGraph; `workload` reaches `preflight` (`fitsDeviceLimits` true); runs exact
- graph-raw-audit: a raw `addComputePass` declaring `cleared` without a clear node is refused; with one it compiles
- graph-texture: a "texture" kernel binding reads, texel-exact, an imported texture, a transient texture filled by `addCopyPass`, a transient render target cleared by `addRenderPass` (graph attachments), and an `importFrameTexture` supplied per run (frameId 1, 2)
- graph-inspect (W0.2; 2026-10-01, Apple GPU, headless Chromium: 30/30 pass in about 1.2 s with it): `inspectGraphs` lists both `selftest-cache` graphs with stats and preflight; the observed run is bit-identical to the unobserved one and records one encode; with `timestamp-query`, a profiled run's node times reach `getGpuGraphProfile()`
- readback-partial: `stagePartialRead` maps the header then only [0, total) for totals 4, 152 and 4096 B, exact; a total past the capacity rejects; no slot left busy

The node check `clear-lint.check.ts` (`npx tsx src/lib/gpu/core/clear-lint.check.ts`, CI fast tier `gpu-clear-lint`) covers the lint rules (27 cases, including command rewrites, unaudited nodes and whole vs partial clears) without a GPU.

The sky refine (`sky/refine-graph.ts`, now the only GPU refine) is ported onto these primitives (2026-10-01, N5). Its local `AuditedGraph`, `lintClears` and `ShapeCache` are gone; old name to core:
- `AuditedGraph.clearNode(id, buf, dependsOn)` is `clearNode(id, buf, { dependsOn })`.
- `readNode(id, bufs, ranges(p))` with a `ReadSink` in the parameters is `readNode(id, [{ buffer, size: (p) => … }])`, with results in `run().reads[id]`. A size of 0 skips a range: the refine sizes its float-mask range `p.floats ? N * 4 : 0`. `KernelNode.condition` gates kernels only, not read nodes.
- `writes` / `lintClears` is `KernelNode.writes` plus the compile-time lint. Every refine kernel writes "full", so the refine needs no clear node.
- `ShapeCache.get(device, key, build) → { value, hit }` is `cachedGraph(device, "sky-refine", key, build, 2) → { graph, extra, hit }`. Clearing it is `releaseCachedGraphs(device, "sky-refine")`. On device loss, the cached graphs are now destroyed rather than forgotten.
- `(g as unknown as { compiled }).compiled.stats` is `g.stats`.
- The nn model's output GPUBuffer is still wrapped per run (`device.createBuffer({ handle })`, not owned) and bound through `run({ buffers: { gp } })`.

Gate (at the port; the pooled path was removed on 2026-10-01 and the bench now compares with the CPU refine): `scripts/gpu/sky-graph-bench.mjs` gave 0 differing bytes and 0 differing float bits against the pooled path at every size (up to 4608×3456 = 15.9 Mpx), along the hit/miss/evict sequence and on both uploaded-floats branches. Hit pattern, VRAM stats and the over-limit refusal match the pre-port run.
