# src/lib/gpu — WebGPU compute sidecar

The renderers (three.js, deck.gl) stay on WebGL2. The compute kernels in this directory run on a
separate luma.gl 9.4 WebGPU device (`device.ts`). The plan and the reasons behind it are in
`research_notes/gpu_compute_plan_2026-09.md`.

Rules:
- **Every kernel has a CPU twin, and the CPU twin is the reference.** Callers use
  `getComputeDevice()`; `null` means take the CPU path. There is no silent behaviour change: a GPU
  path ships only after a parity check against the CPU.
- **Use only stable luma APIs**: `@luma.gl/core` (`device.createComputePipeline`,
  `beginComputePass`, buffers, `readAsync`) and `@luma.gl/engine` `Computation`.
  `@luma.gl/gpgpu/gpu-core` is experimental (no semver), so use it only behind a local wrapper.
- **WGSL lives next to its kernel** as a `.wgsl.ts` string export. Keep a `@workgroup_size` comment
  explaining the choice.
- **Keep readbacks small.** Reduce on the GPU and read back winners and scalars, not full images,
  whenever the caller allows it.
- **Kill switch:** `?gpu=off`, `localStorage["rigi.gpu"]="off"`, or `globalThis.__RIGI_GPU__="off"`.
- **Test with headless Chromium**, which has WebGPU on this Mac with the repo's usual flags
  (`--use-angle=metal --ignore-gpu-blocklist --enable-gpu`). Features include
  `timestamp-query`, `subgroups`, `shader-f16` and `float32-filterable`.

| Dir | Kernel | CPU twin |
|---|---|---|
| `horizon/` | batched horizon ray-march over ring mosaics | `horizon-fast/march.ts` |
| `align/` | autoAlign coarse pose-grid scoring (the silhouette re-rank stays on the CPU: only 3–10 ms of its time is scoring) | `align.ts` |
| `look/` | relief field, haze fit, guided filter, colour stats | `look/**` |
| `eye/` | batched horizon provider for the pose6dof eye search (no kernel of its own; uses `horizon/`) | `pose6dof/eye.ts` per-eye path |
| `skyglobal/` | matcher T6 stage-1 skyline grid (a GPU bound pass, then the CPU re-scores the candidates exactly, so it is identical to numpy by construction). Library only, not wired into the service | `tools/matcher/stage1/skyglobal.py` (`skyglobal/cpu.ts` is a TS port. Its polish differs from numpy on 3/50 photos due to libm last-bit differences, so only the grid may replace numpy) |
