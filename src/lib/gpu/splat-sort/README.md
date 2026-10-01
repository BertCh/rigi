# gpu/splat-sort: GPU back-to-front sort for Step Inside splats

`GpuSplatSorter` (index.ts) sorts the near-field Gaussian splats by view depth on the render device
and writes the order buffer that `deck-webgpu/layers/splats.ts` indexes by `instance_index`. It
replaces the worker round trip (`nearfield/splat-sort.ts`, a 16-bit counting sort, order transferred
back after each sort) for the WebGPU renderer. The worker stays the default and the fallback (WebGL
deck renderer, no GPU, an incapable device): select with `SplatsOptions.sortBackend: "gpu"`
(`splats.setOptions` before `setCloud`), not a flag.

## Pipeline (one submit, one compute pass, no readback)

`depth` (f32 view depth per splat from the splat storage buffer, min/max by integer atomics on the
bit patterns) → `keys` (17-bit key) → two stable radix passes of 9 bits, each `tile` (rank inside a
256-element tile + per-tile digit histogram) → `scanDigit` (exclusive scan of each digit over
tiles) → `scanTotals` (scan of the 512 digit totals) → `scatter`. Pass 0 reads the identity order
into a temp buffer, pass 1 writes the order buffer. `submit` runs on the sorter's own encoder; the
queue runs it before the frame encoder that is still recording the draw, so the frame already uses
the new order (the worker path draws the previous order and redraws when the new one lands).
`cpu.ts` is the CPU twin of every kernel; `splat-sort.wgsl.ts` the WGSL.

## Identity with the worker's order

The worker keys: `dist = -(a x + b y + c z + d)` (kept when `dist > 0`), range `[minD, maxD]` over the
kept splats, `key = min(65535, trunc((maxD - dist) * (65535 / span)))`, `0` if span is 0; a counting
sort over the keys that scatters in ascending index, so **ties keep ascending index** (stable).

* **The sort is identical.** A stable LSD radix sort by (low 9 bits, then high 9 bits) yields
  ascending key with ties in ascending original index, exactly the counting sort's order. Stability
  is structural, not incidental: a position is `digitBase + tileOffset + rank`, i.e. the number of
  elements with a smaller digit, plus same-digit elements in earlier tiles, plus same-digit elements
  earlier in the tile (the rank is a loop over the lower threads, no atomics, no race). Verified in
  node on masses of equal keys: `npx tsx scripts/gpu/splat-sort-check.ts` (the tiled radix equals
  `sortSplatsByDepth` element for element on 220 cases, ~200k adjacent equal-key pairs).
* **Dropped splats** (the worker excludes `dist <= 0`) get key 65536 and sort last in ascending
  index. The order buffer always holds all `count` splats and the layer draws `count` instances;
  the vertex shader's `clip.w < nearW` cull discards the tail. `stats.drawn` is therefore `count`.
* **The keys are NOT proven bit-identical.** WGSL has no f64. The worker does the dot product and
  the key arithmetic in f64 (rounding only the stored depth to f32); the GPU does it in f32, and
  WGSL may fuse multiply-adds. So a key can differ by 1 bin at a bin edge, and a splat within an ulp
  of the camera plane can be kept or dropped differently. Measured with the f32 twin (`cpu.ts`, no
  FMA): 0.13% of splats get a different key, max |dkey| = 1; the resulting order is still back to
  front within 3 key bins. Such splats have depths within one 1/65535 of the depth span of each
  other, which is visually harmless for alpha blending, but the order is not guaranteed byte-equal
  to the worker's. Where the keys agree, the order is identical, ties included. The span (`maxD - minD`)
  is taken over f32 depths on the GPU and over f64 dists in the worker, a second tiny source of the
  same 1-bin differences.
* Requires `near >= 0` (the depth atomics order positive floats by bit pattern); `near` is 0.

## Limits

Buffers: five `count`-sized u32 arrays + `512 * ceil(count/256)` u32 of histogram (about 22 MB per
million splats). Dispatches are 1-D: up to 65535 tiles (16.7 M splats). The tile rank loop is
O(256) per thread. `gpuSplatSortSupported(device)` gates on WebGPU and the storage limits.
