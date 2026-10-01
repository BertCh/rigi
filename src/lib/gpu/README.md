# src/lib/gpu — WebGPU compute

The compute kernels in this directory run on a luma.gl 10 (`10.0.0-alpha.2`) WebGPU device. Today that device is a
separate "compute sidecar". When the renderer itself runs on WebGPU (the deck-webgpu port,
`src/lib/deck-webgpu/**`) and hands its device over with `adoptRenderDevice`, the kernels run on the
render device instead, so they share one queue and can read render targets without a copy.
Background: `research_notes/gpu_compute_plan_2026-09.md` (the sidecar and the first workstreams) and
`research_notes/gpu_next_2026-09-30.md` (the shared core layer and the move toward luma/deck "next").
Forward plan: `reports/whole-app-graph-plan.md` (WAG). It covers every island, readback and device crossing in the app, and the phases toward one manifest-described set of graphs fed by `gpu/ingest`.

## Layers

- **`core/`**: the shared foundation. It holds the device registry, the buffer pool and leases, the
  readback slots, kernel definitions and dispatch, submit, timestamp profiling, and `ComputeGraph`
  (a wrapper over `GPUCommandGraph`). Exact signatures and the migration rules are in
  `core/README.md`. Self-test: `node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/core-selftest.mjs`.
- **`core/luma.ts` is the luma shim.** It is the only module that imports `@luma.gl/gpgpu/gpu-core`,
  the experimental, WebGPU-only subpath that has no semver promise. Everything else imports
  `GPUCommandGraph`, `GPUReduction`, `GPUSort`, `GPUHistogram`, `GPUScan`, `GPUFFT1D`,
  `GraphDataView` and the rest from there. A luma 10 bump should touch this file plus the
  workarounds its header lists. The app moved to luma `10.0.0-alpha.2` on 2026-09-30 (098d9f2),
  with deck.gl vendored from PR #10752 (`vendor/deck/README.md`); the alpha's broken manifests are
  worked around with `package.json` overrides and `.npmrc` `legacy-peer-deps`.
- **Command graphs.** `GPUCommandGraph` is the default path for sky refine (41b79fd) and the solve
  coarse grid (227d79a). Horizon (b115334), haze (c1b7544) and relief / guided filter / band stats
  (0feeb38) are on graphs too, but opt-in (`graph: true`).
- **Kernel modules** (`horizon/`, `align/`, `look/`, `eye/`, `skyglobal/`, `solve/`, `sky/`): each defines
  its WGSL with `core/kernel` `defineKernel` and runs it as a core `ComputeGraph` (`core/graph`,
  usually a shape-keyed `cachedGraph` in the module's `graph.ts` / `*-graph.ts`): intermediates and
  outputs are graph transients read through read nodes, inputs are pooled uploads under the
  module's lease. **The graph is the only GPU path** (2026-10-01): the pooled single-dispatch /
  `dispatchAll` paths and every `{ graph: false }` / `gpuGraph` switch are gone. Each module's GPU
  path is the graph, and its fallback is the CPU twin. Pooled machinery stays where the graphs use
  it: input slots, leases, readback slots, and the buffers a later readback needs outside the
  encoding (skyglobal's candidate list, haze's lists, solve's resident `hz`).
- **`splat-sort/`**: the GPU back-to-front sort of the Step Inside splats on the render device
  (stable radix, order buffer written in place, no readback); see its README for the key identity
  with the worker's counting sort.
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
3. Build the passes as a core `ComputeGraph` (`cachedGraph(device, "<module>", shapeKey, build)`):
   scratch and outputs are `transientBuffer`s read through a `readNode`; inputs are
   `importBuffer`s bound per run from pooled uploads (`pooledStorage`, `pooledUniform`, `acquire`,
   keyed `"<module>/<slot>"`). Wrap the upload → run → read sequence in `withLease("<module>", …)`.
   Transients are never zeroed and alias each other: declare atomic / partial writes
   (`writes: { out: "atomic" | "partial" }`) and put a `clearNode` before them (compile() lints
   it). Do not add a second, pooled dispatch path next to the graph: the CPU twin is the fallback.
4. Use `graph.run()` (one submit, read nodes resolved), or `encodeReads()` + core `submit()` when
   the encoder is shared. Never `device.submit(enc.finish())`.
5. Branch on `hasFeature(device, "subgroups" | "shader-f16")`: an adopted render device may not have
   the sidecar's features. Keep a plain path, and check that it matches (see `look/color-stats.ts`
   and `skyglobal` REDUCE_SG).
6. luma primitives (`GPUReduction` / `GPUSort` / `GPUScan` / `GPUHistogram`) are graph nodes too,
   with per-node timings. Worked examples: `horizon/graph.ts` (one kernel), `look/relief-graph.ts`
   (a chain with clears and a CPU condition), `look/textures.ts` (texture inputs).
7. Add a bench (`bench.ts` in the module plus `scripts/gpu/<name>-bench.mjs`) that compares against
   the CPU twin and writes small JSON under `out/gpu/**`. Add a row to the table below.
8. Declare the module in the app graph manifest (`app-graph/manifest.ts`: island I0–I12, its
   `cachedGraph` groups, resources, cadence, realm, readbacks), then regenerate the island table
   (`npx tsx scripts/gpu/app-graph-table.ts --write`). The fast-tier checks `app-graph` and
   `app-graph-table` fail on an undeclared group or a stale table. `/dev/graph` shows the page's
   live graphs (transient bytes, aliasing savings, preflight fit, timings) next to the manifest.

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
- **three.js on WebGPU.** The `src/lib/three-webgpu/` spike (three 0.186 `WebGPURenderer` in "sidecar"
  mode on `getComputeDevice().handle`) was deleted with the three.js PhotoEngine on 2026-10-01; the
  WebGPU renderer is deck.gl (`src/lib/deck-webgpu`). It is in git history before that date.

## Kernels

| Dir | Kernel (pass labels) | Default in the app | CPU twin |
|---|---|---|---|
| `horizon/` | batched horizon ray-march over ring mosaics (`horizon-march`). `scene-profile.ts`: 360° unknown-pose horizon, with an opt-in 2-scene cache (`keep`) | on in the horizon-fast-app worker (`?gpuHorizon=off`). Unknown-pose opt-in (`?unknownGpu=on`) | `horizon-fast/march.ts` |
| `align/` | autoAlign coarse pose-grid scoring (`align-pose-grid`), and certified score bounds for the coordinate-descent refine (`align-pose-bound`, `pose-bound.ts`), both on `align/graph.ts`: one graph run per round bounds every speculated neighbour of every live hypothesis, the CPU skips only neighbours the bound proves it would reject and decides every move on exact scores, so the result is identical by construction (proof in `align.ts` `Descent`; `scripts/gpu/align-refine-ab.mjs`). The bound's premise (the device's f32 accuracy) is verified at run time: skips that lean on the error allowance, the device's first 64 skips and 1 in 128 after are re-scored on the CPU; a violation turns the GPU refine off for that device and the call re-runs the CPU refine. Pooled inputs; the edge planes are uploaded once per edge set. The silhouette re-rank stays on the CPU | on (`alignGpuOptions.refine = "cpu"` or `autoAlignAsync(…, { refine: "cpu" })` = CPU refine) | `align.ts` |
| `look/` | relief field, haze fit (radix select, compact readback), guided filter, colour stats, each on its `*-graph.ts` (opt-in subgroup path `{subgroups: true}` with a layout check and plain fallback; default plain) (`look-*`). `relief-heights.ts`: the relief height raster gathered in WGSL from the batched terrain's resident DEM tiles (deck-webgpu bridge, CPU raster fallback). `textures.ts`: texture-input masks / stats / haze prep as `ComputeGraph`s, for the WebGPU renderer | on (`?lookgpu=0`). Texture path not wired yet | `look/**` |
| `eye/` | batched horizon provider for the pose6dof eye search (uses `horizon/`; no kernel of its own). Async kernel warm-up | suggestion only (`?eyesearch=1`) | `pose6dof/eye.ts` per-eye path |
| `skyglobal/` | matcher T6 stage-1 skyline grid (`skyglobal-cells` / `-reduce` / `-cands`). A GPU bound pass (`skyglobal/graph.ts`), then the CPU re-scores the candidates exactly; subgroup REDUCE; count-first readback | service only, behind `T6_GPU_GRID=1` | `tools/matcher/stage1/skyglobal.py` (`skyglobal/cpu.ts` is a TS port. Its polish differs from numpy on 3/50 photos due to libm last-bit differences, so only the grid may replace numpy) |
| `solve/` | solvePose coarse yaw × pitch grid (`solve-coarse`). The GPU (`solve/graph.ts`: COARSE + a GPU row fold, resident horizon profile) gives certified row bounds, then the CPU re-scores the rows that bounded selection cannot settle, so the result is identical by construction. A row threshold too close to call in f32 re-runs COARSE and folds the blocks in f64 on the CPU | **on** in the unknown-pose worker (`?gpu=off` = CPU); 60/60 identical in the worker A/B | `geo/solve.ts` `planCoarse` / `coarseCost` (re-exported by `solve/cpu.ts`; one copy of the cost since 2026-09-30) |
| `sky/` | sky-mask guided-filter refine (`sky-refine`, `sky/refine-graph.ts`), GPU twin of `sky/refine` `refineToWorking` + `toBytes`; plus the opt-in input prep (`sky-prep-*`: ImageBitmap → RGBA words, `rgbLo`, ORT's normalised input, bit-identical to `sky/core.ts` through an exact u32 soft-float of its f64 chain, verified per device at runtime; `sky/prep*.ts`). Runs in the sky worker on the device ORT also uses (`sky/model.ts` `shareOrtDevice`), reading the model's output buffer directly and reading back only the byte mask | **on** in the sky worker (page `gpuEnabled()` sent as `gpu`) | `sky/refine.ts` (f64 sums vs f32: ≤ 1.2e-5, ≤ 9 mask bytes of 786k differ by 1; `scripts/gpu/sky-bench.mjs`) |
