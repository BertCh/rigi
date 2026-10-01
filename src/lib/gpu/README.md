# src/lib/gpu — WebGPU compute

The compute kernels in this directory run on a luma.gl 9.4 WebGPU device. Today that device is a
separate "compute sidecar". When the renderer itself runs on WebGPU (the deck-webgpu port,
`src/lib/deck-webgpu/**`) and hands its device over with `adoptRenderDevice`, the kernels run on the
render device instead, so they share one queue and can read render targets without a copy.
Background: `research_notes/gpu_compute_plan_2026-09.md` (the sidecar and the first workstreams) and
`research_notes/gpu_next_2026-09-30.md` (the shared core layer and the move toward luma/deck "next").

## Layers

- **`core/`**: the shared foundation. It holds the device registry, the buffer pool and leases, the
  readback slots, kernel definitions and dispatch, submit, timestamp profiling, and `ComputeGraph`
  (a wrapper over `GPUCommandGraph`). Exact signatures and the migration rules are in
  `core/README.md`. Self-test: `node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/core-selftest.mjs`.
- **`core/luma.ts` is the luma shim.** It is the only module that imports `@luma.gl/gpgpu/gpu-core`,
  the experimental, WebGPU-only subpath that has no semver promise. Everything else imports
  `GPUCommandGraph`, `GPUReduction`, `GPUSort`, `GPUHistogram`, `GPUScan`, `GPUFFT1D`,
  `GraphDataView` and the rest from there. A luma 10 bump should touch this file plus the
  workarounds its header lists. We stay on luma 9.4.2 for now: deck 10 is not published, and
  10.0.0-alpha.2 has broken packaging.
- **Kernel modules** (`horizon/`, `align/`, `look/`, `eye/`, `skyglobal/`, `solve/`, `sky/`): each defines
  its WGSL with `core/kernel` `defineKernel`, pools its buffers under its own lease, submits through
  `core/queue` and reads back through `core/readback`.
- **`device.ts`** re-exports `core/device`. This is the stable import path that callers outside
  `src/lib/gpu` use (the app workers, the look controller, deck-webgpu).

## Rules

- **Every kernel has a CPU twin, and the CPU twin is the reference.** Callers use
  `getComputeDevice()`: `null` means take the CPU path. A GPU path ships only after a parity check
  against the CPU. A pure plumbing change must keep GPU outputs **bit-identical**; check it with the
  module's bench, comparing before and after.
- **Kill switch:** `?gpu=off` (src/lib/flags). In a harness, set
  `globalThis.__RIGI_FLAGS__ = { ...globalThis.__RIGI_FLAGS__, gpu: "off" }` (read live, per realm,
  and also inside workers), or run the script through `scripts/gpu/with-gpu-off.mjs`. With the switch
  on, `getComputeDevice()` returns null even when a render device has been adopted.
- **Stable luma APIs only**, except through `core/luma.ts`. Raw WebGPU calls (`clearBuffer`,
  `createComputePipelineAsync`, `setBindings` duck-typing, the adapter-limit patch) live only in
  `core/**`. The `core/luma.ts` header lists each one for the luma 10 bump.
- **Keep readbacks small.** Reduce on the GPU and read back winners and scalars (skyglobal reads
  ~28 KB instead of 273 KB, and haze reads ~480 KB instead of ~3 MB).
- **Test with headless Chromium** under the render lock, one job at a time:
  `node scripts/gpu/with-render-lock.mjs -- …`. It needs a dev server on this tree:
  `npx vite dev --config scripts/gpu/vite.gpu.config.ts --port <free>`, then set `APP_URL`. On
  this Mac, WebGPU has `timestamp-query`, `subgroups`, `shader-f16` and `float32-filterable`.
  Vite gotcha: on a cold dependency cache, the first import of `@luma.gl/gpgpu/gpu-core` makes Vite
  re-optimise its dependencies. Chunks from before and after then load in the same page, you get
  two copies of `@luma.gl/core` ("luma.gl has already been initialized"), and `instanceof` fails in
  `PipelineFactory`. Re-run the command, or pre-bundle the subpath (`optimizeDeps.include`).

## Writing a new kernel

1. Put the WGSL in a `<name>.wgsl.ts` next to the kernel, with a `@workgroup_size` comment that
   explains the choice. Do not use `arrayLength()` on pooled buffers unless you bind them through
   `range(buf, bytes)`.
2. `const K = defineKernel(id, WGSL, layout, { group: "<module>", label: "<module>-<pass>" })` at
   module level. The label is what `core/profile` reports. Warm up with
   `warmKernelsAsync(device, "<module>")`.
3. Use pooled buffers (`pooledStorage`, `pooledUniform`, `acquire`) keyed `"<module>/<slot>"`, and
   wrap the whole acquire → encode → `submit` → read sequence in `withLease("<module>", …)`. A
   pooled buffer keeps the previous call's bytes, so zero it (`pooledStorage` with a size, or
   `clear`) wherever the kernel relied on a fresh, zeroed buffer.
4. Encode with `dispatch` / `dispatchAll`, which set bindings per pass. Submit with core `submit()`,
   never `device.submit(enc.finish())`. Stage reads on the same encoder (`stage` / `stageReads`).
5. Branch on `hasFeature(device, "subgroups" | "shader-f16")`: an adopted render device may not have
   the sidecar's features. Keep a plain path, and check that it matches (see `look/color-stats.ts`
   and `skyglobal` REDUCE_SG).
6. For multi-pass pipelines whose intermediates stay on the GPU, use `core/graph` `ComputeGraph`
   (transient buffers, `GPUReduction` / `GPUSort` / `GPUScan` / `GPUHistogram` nodes, per-node
   timings). `look/textures.ts` is the worked example.
7. Add a bench (`bench.ts` in the module plus `scripts/gpu/<name>-bench.mjs`) that compares against
   the CPU twin and writes small JSON under `out/gpu/**`. Add a row to the table below.

## The WebGPU renderer hand-off

- **Adopting the device.** The deck-webgpu renderer calls `adoptRenderDevice(device)` from
  `#/lib/gpu/device` once its device exists (`adoptForCompute` in `src/lib/deck-webgpu/device.ts`).
  From then on, `getComputeDevice()` returns that device while it is alive. WebGL devices and `null`
  are ignored. When the adopted device is lost, compute falls back to the sidecar.
- **Per-device state.** Pipelines, pools and readback slots are per device, so the sidecar and the
  render device can both be live. Never mix buffers or textures between devices.
- **Texture inputs.** `look/textures.ts` runs `masksTex`, `bandStatsTex` and `hazePrepTex` directly on
  render-target textures (geometry range `r32float` / `rgba32float`, photo `rgba8unorm`, masks
  `r8unorm`). Its outputs stay on the GPU; `masksTex` returns an `rgba8unorm` texture to sample.
  - **When to call them.** Only when `await getComputeDevice() === yourDevice`; otherwise use the
    array path.
  - **Parity.** They are bit-identical to the array path (`scripts/gpu/textures-bench.mjs`).
  - **Status.** Nothing in the app calls them yet.
  - **Contract.** The API note at the top of `look/textures.ts` covers input liveness, `flipY` and
    how long outputs stay valid.
- **Profiling.** Set `globalThis.__RIGI_GPU_PROFILE__ = true`, then call
  `getGpuProfile()` (`core/profile`) to get GPU ms per pass label. The horizon-fast-app,
  unknown-pose and eye workers get the switch in their messages (`core/realm.ts`) and send their
  totals back, merged as `<realm>-worker:<label>`; the sky worker does not report yet. To profile a
  whole bench, run it through `scripts/gpu/with-gpu-profile.mjs` with `PROFILE_OUT=…` (per-realm
  totals under `realms`).
- **Error checks.** `globalThis.__RIGI_GPU_CHECKS__ = true` wraps every core `submit()` in
  validation / out-of-memory error scopes (forwarded to the same workers). A failed submit rejects
  the encoder's staged reads with `GpuValidationError` and the caller takes its CPU path. Opt-in.
- **three.js on WebGPU.** `src/lib/three-webgpu/` is a spike (not wired): three 0.186's
  `WebGPURenderer` with the terrain material in TSL renders on `getComputeDevice().handle`
  ("sidecar" mode), so the render and compute share one device with the 4 GiB limits. Details and
  traps in its README.

## Kernels

| Dir | Kernel (pass labels) | Default in the app | CPU twin |
|---|---|---|---|
| `horizon/` | batched horizon ray-march over ring mosaics (`horizon-march`). `scene-profile.ts`: 360° unknown-pose horizon, with an opt-in 2-scene cache (`keep`) | on in the horizon-fast-app worker (`?gpuHorizon=off`). Unknown-pose opt-in (`?unknownGpu=on`) | `horizon-fast/march.ts` |
| `align/` | autoAlign coarse pose-grid scoring (`align-pose-grid`). Pooled buffers; the edge planes are uploaded once per edge set. The silhouette re-rank stays on the CPU | on | `align.ts` |
| `look/` | relief field, haze fit (radix select, compact readback), guided filter, colour stats (opt-in subgroup path `{subgroups: true}` with a layout check and plain fallback; default plain) (`look-*`). `textures.ts`: texture-input masks / stats / haze prep as `ComputeGraph`s, for the WebGPU renderer | on (`?lookgpu=0`). Texture path not wired yet | `look/**` |
| `eye/` | batched horizon provider for the pose6dof eye search (uses `horizon/`; no kernel of its own). Async kernel warm-up | suggestion only (`?eyesearch=1`) | `pose6dof/eye.ts` per-eye path |
| `skyglobal/` | matcher T6 stage-1 skyline grid (`skyglobal-cells` / `-reduce` / `-cands`). A GPU bound pass (core ComputeGraph by default, `skyglobal/graph.ts`; pooled path via `{ graph: false }`), then the CPU re-scores the candidates exactly; subgroup REDUCE; count-first readback | service only, behind `T6_GPU_GRID=1` | `tools/matcher/stage1/skyglobal.py` (`skyglobal/cpu.ts` is a TS port. Its polish differs from numpy on 3/50 photos due to libm last-bit differences, so only the grid may replace numpy) |
| `solve/` | solvePose coarse yaw × pitch grid (`solve-coarse`). The GPU gives certified row bounds, then the CPU re-scores the rows that bounded selection cannot settle, so the result is identical by construction | **on** in the unknown-pose worker (`?gpu=off` = CPU); 60/60 identical in the worker A/B | `geo/solve.ts` `planCoarse` / `coarseCost` (re-exported by `solve/cpu.ts`; one copy of the cost since 2026-09-30) |
| `sky/` | sky-mask guided-filter refine (`sky-refine`), GPU twin of `sky/refine` `refineToWorking` + `toBytes`. Runs in the sky worker on the device ORT also uses (`sky/model.ts` `shareOrtDevice`), reading the model's output buffer directly and reading back only the byte mask | **on** in the sky worker (page `gpuEnabled()` sent as `gpu`) | `sky/refine.ts` (f64 sums vs f32: ≤ 1.2e-5, ≤ 9 mask bytes of 786k differ by 1; `scripts/gpu/sky-bench.mjs`) |
