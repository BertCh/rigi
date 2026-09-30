# src/lib/gpu/core: shared WebGPU compute foundation

This directory is the shared layer that every kernel in `src/lib/gpu/**` builds on. It uses luma 9.4.2's stable `@luma.gl/core` API plus the experimental `@luma.gl/gpgpu/gpu-core`, and it is meant to move to luma/deck "next" (WebGPU everywhere) with as little churn as possible. The house rules from `../README.md` all still apply:
- Every kernel keeps a CPU twin, and the CPU twin is the reference.
- `getComputeDevice()` resolving `null` means the caller takes the CPU path.
- `?gpu=off` turns everything off.
- A pure plumbing migration must give **bit-identical** GPU outputs.

Self-test: `node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/core-selftest.mjs`. It needs a dev server on this tree (`APP_URL`, default `http://localhost:3110`) and writes `out/gpu/core/selftest.json`.

| File | What it gives you |
|---|---|
| `luma.ts` | The **only** importer of `@luma.gl/gpgpu/gpu-core`, with luma 10 migration notes. Import `GPUCommandGraph`, `GPUReduction`, `GPUSort`, `GPUHistogram`, `GPUScan`, `GPUFFT1D`, `GPUReadbackRing`, `GraphDataView` and the rest from here, never from the package |
| `device.ts` | The per-realm device registry: `getComputeDevice`, `adoptRenderDevice`, `resetComputeDevice`, `hasFeature`. The sidecar requests the adapter's maximum limits |
| `pool.ts` | A persistent grow-only buffer pool (per device), `withLease` for serialising async callers, and `clear` / `range` |
| `readback.ts` | Ring readback: staged copies into reusable MAP_READ slots on the caller's encoder, one map per read |
| `kernel.ts` | `defineKernel` / `kernel` / `kernelAsync` / `dispatch`, with bindings set per pass. A superset of `look/kernel.ts` |
| `queue.ts` | `submit(device, enc)`: finishes and submits the encoder, then runs the pool and profiler hooks |
| `profile.ts` | Opt-in GPU timestamp profiling (`globalThis.__RIGI_GPU_PROFILE__ = true`) and `getGpuProfile()` |
| `graph.ts` | `ComputeGraph`, a thin wrapper over `GPUCommandGraph` for multi-pass pipelines with GPU-resident intermediates |
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
export function withLease<T>(key: string, fn: () => Promise<T> | T): Promise<T>; // FIFO mutex per key; "a" covers "a/…" slots
export function releasePool(device: Device, prefix?: string): void;
export function poolStats(device: Device): { slots: number; bytes: number };

// readback.ts
export type ReadRange = { buffer: Buffer; offset?: number; size: number };  // offset % 4 == 0
export type StagedRead = { read: () => Promise<ArrayBuffer[]>; cancel: () => void };
export function stageReads(device: Device, enc: CommandEncoder, ranges: ReadRange[]): StagedRead;
export function readBack(device: Device, build: (enc: CommandEncoder) => unknown, ranges?: ReadRange[],
  opts?: { id?: string }): Promise<ArrayBuffer[]>;                   // ranges ?? (ReadRange[] returned by build)
export function readbackStats(device: Device): { slots: number; busy: number; bytes: number };

// queue.ts (also re-exported from kernel.ts)
export function submit(device: Device, enc: CommandEncoder): void;

// kernel.ts
export type BindKind = "uniform" | "storage" | "read-only-storage";
export type KernelSpec = { id: string; source: string; layout: [string, BindKind][]; entryPoint: string;
  constants?: Record<string, number>; group: string; label: string };
export type Kernel = { pipeline: ComputePipeline; names: string[]; spec: KernelSpec };
export type KernelOptions = { entryPoint?: string; constants?: Record<string, number>; group?: string; label?: string };
export function defineKernel(id: string, source: string, layout: [string, BindKind][], opts?: KernelOptions): KernelSpec;
export const definedKernels: (group?: string) => KernelSpec[];
export function kernel(device: Device, spec: KernelSpec): Kernel;                 // sync, cached per (device, spec)
export function kernelAsync(device: Device, spec: KernelSpec): Promise<Kernel>;   // createComputePipelineAsync, same cache
export function warmKernels(device: Device, group?: string): number;              // failures; never throws
export function warmKernelsAsync(device: Device, group?: string): Promise<number>;
export function encodeDispatch(pass: ComputePass, k: Kernel, bindings: Bindings, x: number, y?: number, z?: number): void;
export function dispatch(enc: CommandEncoder, k: Kernel, bindings: Bindings, x: number, y?: number, z?: number,
  label?: string): void;                                              // one pass; label for profile (default spec.label)
export type DispatchCall = { k: Kernel; bindings: Bindings; x: number; y?: number; z?: number };
export function dispatchAll(enc: CommandEncoder, calls: DispatchCall[], label?: string): void; // one pass, in order
export function storage(device: Device, data: ArrayBufferView | number): Buffer;  // fresh (look semantics)
export function uniform(device: Device, words: ArrayBuffer): Buffer;              // fresh, padded to 16 B
export function stage(device: Device, enc: CommandEncoder, src: Buffer, bytes: number):
  { read: () => Promise<ArrayBuffer>; cancel: () => void };           // ring slot, exactly `bytes`
export function release(...bufs: (Buffer | null | undefined)[]): void;           // skips pooled buffers

// profile.ts
export type GpuProfile = Record<string, { gpuMs: number; count: number }>;
export const profiling: (device: Device) => boolean;
export function passProps(device: Device, label: string): ComputePassProps;      // {} when off
export function recordGpuTime(label: string, ms: number): void;
export function getGpuProfile(): Promise<GpuProfile>;
export function resetGpuProfile(): void;

// graph.ts
export type GraphBinding = GraphBufferHandle | GraphDataView;
export type Workgroups = [number, number?, number?];
export type KernelNode<P> = { id: string; spec: KernelSpec; bindings: Record<string, GraphBinding>;
  workgroups: Workgroups | ((parameters: P) => Workgroups); dependsOn?: string[] };
export type GraphOp<P> = { addToGraph: (graph: GPUCommandGraph<P>) => void };
export class ComputeGraph<P = void> {
  readonly device: Device; readonly id: string; readonly graph: GPUCommandGraph<P>;
  constructor(device: Device, id: string);
  importBuffer(id: string, byteLength: number, buffer?: GraphImportedBuffer, usage?: number): GraphBufferHandle;
  transientBuffer(id: string, byteLength: number, usage?: number): GraphBufferHandle;
  view<T extends GPUScalarFormat>(buffer: GraphBufferHandle, format: T, length: number, byteOffset?: number): GraphDataView<T>;
  importTexture(descriptor: GraphTextureDescriptor, texture?: GraphImportedTexture): GraphTextureHandle;
  addKernel(node: KernelNode<P>): this;
  addComputePass(node: Omit<GPUCommandGraphComputeNode<P>, "type">): this;
  add(op: GraphOp<P>): this;                                          // GPUReduction, GPUSort, GPUHistogram, …
  compile(): this;
  encode(enc: CommandEncoder, parameters: P, buffers?: Record<string, GraphImportedBuffer>,
    textures?: Record<string, GraphImportedTexture>): GPUCommandGraphEncoding;
  run(parameters: P, opts?: { buffers?: Record<string, GraphImportedBuffer>; textures?: Record<string, GraphImportedTexture>;
    read?: ReadRange[]; timings?: boolean }):
    Promise<{ data: ArrayBuffer[]; timings?: GPUCommandGraphTimingReport }>;
  destroy(): void;
}
```

## Rules for migrating a kernel

1. **Device.** Import `getComputeDevice` from `#/lib/gpu/core/device` (`src/lib/gpu/device.ts` will re-export it). Branch on `hasFeature(device, …)` before using `subgroups` or `shader-f16`: an adopted render device may not have them.
2. **Pipelines.** Use `defineKernel(id, WGSL, layout, { group, label })` at module level, and fetch the pipeline with `kernel(device, spec)`. Warm up with `warmKernelsAsync(device, group)`.
3. **Dispatch.** Use `dispatch(enc, k, bindings, x, y, z)`. It sets the bindings on the pass, so it no longer writes `pipeline.setBindings` state that other callers share. Use `dispatchAll` for several dispatches in one pass.
4. **Buffers.** For steady-state calls, use `pooledStorage` / `pooledUniform` / `acquire` with keys `"<owner>/<slot>"`, and wrap the whole acquire → encode → submit → read sequence in `withLease("<owner>", …)` whenever calls can overlap (async callers, workers sharing a module). Two traps can break bit-identity:
   - **Capacity > request.** A pooled buffer has a power-of-two capacity. If the WGSL uses `arrayLength()`, bind `range(buf, bytes)`.
   - **Stale contents.** A pooled buffer keeps the previous call's bytes. If a kernel relied on `storage(device, n)` being zeroed (for example with atomics or partial writes), use `pooledStorage(device, key, n)` (which zeroes by default) or `clear(enc, buf)`. Only pass `{ zero: false }` for outputs the kernel fully overwrites.
5. **Submit.** Use `submit(device, enc)`, not `device.submit(enc.finish())`. It destroys grown-out pool buffers and collects profiling.
6. **Readback.** Use `stage(device, enc, src, bytes)` (one range) or `stageReads(device, enc, ranges)` (several), then call `.read()` after `submit`. Use `readBack(device, build, ranges)` when it can own the encoder. Never call `readAsync` on a non-MAP_READ buffer: luma allocates a temporary buffer and encoder every time.
7. **Release.** `release(...)` destroys fresh buffers and skips pooled ones, so a mixed list is safe.

### `look/kernel.ts` expressed 1:1 on core

```ts
import * as core from "#/lib/gpu/core/kernel";
export type { BindKind, Kernel, KernelSpec } from "#/lib/gpu/core/kernel";
export const defineKernel = (id: string, source: string, layout: [string, core.BindKind][]) =>
	core.defineKernel(id, source, layout, { group: "look", label: `look-${id}` });
export const kernel = core.kernel;                     // cache keyed by spec object instead of id: same thing for module-level specs
export const warmKernels = (device: Device) => core.warmKernels(device, "look");
export const { storage, uniform, dispatch, stage, release } = core; // dispatch: bindings now per pass
```
Numerics do not change. The WGSL, the shader module, the explicit shader layout and the `{}` pass props are all the same. `stage().read()` still resolves exactly `bytes` bytes, now through a reused ring slot instead of a fresh MAP_READ buffer.

## Design notes

- **Device limits.** In luma 9.4 the only way to raise adapter limits is `featureLevel: "max"`, and that also requests every feature. `device.ts` therefore wraps `webgpuAdapter` (via `Object.create`) so that the adapter's `requestDevice` asks for `RAISED_LIMITS` at the adapter maximum. If that request fails, it retries with default limits. On this Mac (Apple, Metal) the sidecar now gets `maxStorageBufferBindingSize` / `maxBufferSize` of 4 GiB−4, and `maxComputeWorkgroupStorageSize` of 32 KiB.
- **Adopted device.** `getComputeDevice()` returns the adopted render device instead of the sidecar. Pipelines, pools and readback slots are all per device (WeakMaps), so both devices can be live at once. Never mix buffers between devices.
- **Pool retirement.** When a slot grows, the old buffer is destroyed once the lease covering that key ends. For unleased slots it happens at the next core `submit()`. Unleased callers must therefore encode and submit without awaiting in between.
- **Why readback does not use `GPUReadbackRing`.** Its slots have one fixed byte length and `acquire()` waits when every slot is busy. Our readback sizes vary per call (and per photo), so `readback.ts` implements the same ticket pattern (reserve, copy on the caller's encoder, submit, map, return the slot) with grow-on-demand slots. Up to 4 idle slots are kept per device. The ring is still re-exported from `luma.ts` for fixed-size streaming readbacks.
- **Async pipelines.** luma 9.4 has no async pipeline creation. `kernelAsync` calls the raw `GPUDevice.createComputePipelineAsync` on the luma shader's module (layout `auto`) and passes the resulting `handle` into `device.createComputePipeline`. The self-test checks that the sync and async pipelines give bit-identical output.
- **Profiling.** Each profiled pass gets its own pooled 2-slot `timestamp` QuerySet. The durations are read after `submit()`. Graph runs use the encoder's `timeProfilingQuerySet` and report under `<graphId>/<nodeId>`. Chromium quantises timestamps (about 65 µs steps on this Mac), so a single small pass can read as 0 ms: sum over many calls.
- **Graph.** `ComputeGraph.run` holds a lease on `graph:<id>`, because transients and timestamp slots are shared between runs. A `GraphDataView` is bound with its exact byte range, and its `byteOffset` must be a multiple of 256 (the storage-binding offset alignment). Only imported buffers can be read back.

## Self-test result (2026-09-30, Apple GPU, headless Chromium)

13/13 checks pass in about 90 ms:
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
