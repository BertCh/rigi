# gpu/splat-sort: GPU back-to-front sort for Step Inside splats

`GpuSplatSorter` (index.ts) sorts the near-field Gaussian splats by view depth on the render device
and writes the order buffer that `deck-webgpu/layers/splats.ts` indexes by `instance_index`. It
replaces the worker round trip (`nearfield/splat-sort.ts`, a 16-bit counting sort, order transferred
back after each sort) for the WebGPU renderer. This is the DEFAULT sort of the WebGPU deck renderer (`SplatsOptions.sortBackend: "gpu"`); the worker
(`sortBackend: "worker"`, not a flag) is what the WebGL deck layer uses and the automatic fallback
described below.

## Pipeline (one submit, one compute pass, no readback)

`depth` (f32 view depth per splat from the splat storage buffer, min/max by integer atomics on the
bit patterns) → `keys` (17-bit key) → two stable radix passes of 9 bits, each `tile` (rank inside a
256-element tile + per-tile digit histogram) → `scanDigit` (exclusive scan of each digit over
tiles) → `scanTotals` (scan of the 512 digit totals) → `scatter`. Pass 0 reads the identity order
into a temp buffer, pass 1 writes the order buffer. `submit` runs on the sorter's own encoder; the
queue runs it before the frame encoder that is still recording the draw, so the frame already uses
the new order (the worker path draws the previous order and redraws when the new one lands).
`cpu.ts` is the CPU twin of every kernel; `splat-sort.wgsl.ts` the WGSL.

The ten dispatches are kernel nodes of one core `ComputeGraph` (`cachedGraph` group `splat-sort`,
keyed by the buffer sizes, registered in `gpu/app-graph/manifest.ts`, so `/dev/graph` lists it):
a clear node of the min/max words, then depth → keys → two radix passes, with the bindings of the
former `dispatchAll` call for call. Every buffer is an import bound per encode, so sorters of one
size share one compiled graph, and the graph coalesces the nodes into one compute pass. `sort()`
encodes and submits synchronously on the sorter's own encoder (no lease and no `run()`: the submit
must precede the frame submit), so a cache eviction, queued under the graph's lease, never lands in
the middle of a sort; an evicted graph is rebuilt and compiled at the next sort from the per-device
pipeline cache. With `__RIGI_GPU_PROFILE__` the GPU time is reported per node as
`splat-sort|<key>/<node>` (it was one `splatsort` pass).

## luma GPUSort variant (flag `splatSortGpgpu`, default on)

With the flag on, the four tile / scan-digit / scan-totals / scatter nodes per pass are replaced by one
luma gpgpu `GPUSort` (stable radix, `keyBits: 17`) after the same depth and keys kernels: keys are the
sort keys, an identity buffer (the `tmp` buffer, written once at construction) is the payload, and the
payload output is the order buffer; `rank` takes the unused sorted-key output and `hist` / `base` shrink
to 16 bytes. The order is element for element the same as the in-house passes (both are stable, so ties
keep ascending index; checked against `cpu.ts radixOrderTiled` by `scripts/gpu/splat-sort-gpgpu-dawn.ts`).
If the GPUSort graph fails to build or compile, the sorter logs a warning and rebuilds with the in-house
passes. `?splatSortGpgpu=off` selects the in-house passes. Numbers: `scripts/gpu/splat-sort-gpgpu-dawn.ts`
(Dawn in node) and `scripts/gpu/splat-sort-bench.mjs --query "?splatSortGpgpu=off"` (Chrome).
GPUBitonic (`algorithm: "bitonic"`) was 5 to 8 times slower at 100k to 1M splats and is not used.

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

## Fallback to the worker (deck-webgpu/layers/splats.ts, fallback.ts)

Per cloud, a one-way state machine (`SortBackendState`, node-tested) switches the layer to the
worker sorter on ANY of: an incapable device (`gpuSplatSortSupported`), a pipeline compile failure
(the graph's `compileAsync` rejects), a validation / out-of-memory error on the first two sorts (core
`submitted(enc)` when `__RIGI_GPU_CHECKS__` is on, else a push/popErrorScope pair around the
submit), a throwing `sort()`, or device loss (`gpu/core/lifecycle` `onLost`). It warns once and sets
`stats.sortBackend = "worker"` and `stats.sortFallbackReason`. Until the pipelines have compiled
the draw uses the identity order; an invalid submit writes nothing, and on fallback the order buffer
is reset to identity unless a GPU sort was already confirmed valid (then the last valid order is
kept) until the worker's first result lands and redraws. A garbage order buffer is never drawn.

## Accepted difference

The 1-bin key difference from the worker (0.13% of keys in the f32 twin, never more than one bin)
is accepted for a draw-order sort: it only reorders splats whose depths are within 1/65535 of the
depth span, the effect is visual only, and the result is deterministic per frame for a given
camera and device.

## Limits

Buffers: five `count`-sized u32 arrays + `512 * ceil(count/256)` u32 of histogram (about 22 MB per
million splats). Dispatches are 1-D: up to 65535 tiles (16.7 M splats). The tile rank loop is
O(256) per thread. `gpuSplatSortSupported(device)` gates on WebGPU and the storage limits.
