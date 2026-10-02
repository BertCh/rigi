# src/lib/nn: neural nets as WGSL kernels on the luma compute graph

A small tensor runtime for in-browser model forward passes (ALIKED, LightGlue, the monocular depth
net, …). No ONNX: a model is TypeScript against the `Nn` interface (`types.ts`), and the same code
runs on two backends:

| backend | where | how |
|---|---|---|
| GPU (`gpu/`) | WebGPU device (the render device, or the core sidecar) | ops record kernel nodes; `forward()` lowers them onto **one** `ComputeGraph` (`src/lib/gpu/core`) and submits once |
| CPU (`cpu.ts`) | everywhere | eager Float32Array loops; the reference for parity, and the no-WebGPU fallback (slow) |

```ts
import { createNn } from "#/lib/nn";
const nn = await createNn();                   // GPU on WebGPU, else CPU ({ backend: "cpu" | "gpu" })
const w = await nn.loadWeights("aliked-n16.1a2b3c4d.safetensors"); // public/models, fp16 kept on GPU
const x = nn.fromArray(pixels, [1, 3, H, W]);  // or nn.fromTexture?.(texture, { shape, mean, std })
const { scores, desc } = await nn.forward(() => {
  const y = nn.relu(nn.conv2d(x, w.get("block1.conv1.weight"), null, { padding: 1 }));
  …
  return { scores: …, desc: … };               // tensors reachable from the result are the outputs
});
const s = await nn.read(scores);               // readback through the core ring
nn.dispose([scores, desc, x]);
```

App consumers do not call `createNn` themselves: `getNn(consumer, device?)` (`registry.ts`) returns the GPU runtime per (compute device, consumer), or null without a live WebGPU device, with its own graph group `nn/<consumer>`; an entry is dropped on device loss.

## Rules for model code

- **One forward = one submission.** Put the whole network (and its pre/post-processing) inside one
  `forward(fn)`. Everything not returned is graph scratch (aliased transients) and is invalid after
  the forward. Split into several forwards only where the CPU must decide something (e.g. a
  data-dependent keypoint count).
- `fn` is synchronous; `read()` inside it throws. Ops outside `forward` also work (recorded and
  flushed at the next `read`/`forward`), but every result of them is kept.
- Graphs are cached by structure (op sequence + shapes + parameters), so a repeated forward at the
  same input size only re-encodes. Keep shapes stable (pad to a multiple, fixed keypoint counts)
  for cache hits; each new shape compiles a new graph.
- PyTorch conventions throughout (NCHW, `[B, H, N, D]` attention, `[out, in]` linear weights,
  `F.pad` order, torchvision `deform_conv2d` offset layout, `align_corners` defaults). Index tensors
  are f32 holding integers. Activations are f32; f16 weights stay f16 on `shader-f16` devices.
- A unary activation right after `conv2d` / `convTranspose2d` / `deformConv2d` / `linear` / `matmul`
  is fused into that kernel's store automatically (when nothing else reads the pre-activation).
- Fold BatchNorm into the preceding conv in the producer script; `batchNorm` exists but costs
  elementwise passes.
- Elementwise chains fuse into one kernel (bias + gelu, `a * gamma + r`, trees of unary / binary / where
  over same-shape operands that feed nothing else), and a layerNorm over an elementwise expression
  (the residual add) becomes one kernel that still writes the sum when something else reads it
  (`gpu/fusion.ts`, planning is pure CPU and specced in `__tests__/gpu-fusion.spec.ts`). Kernels are
  limited to 8 storage bindings, so wide expressions split.
- Missing an op? Add it to `types.ts` + `base.ts` (shape logic) + `cpu.ts` + `gpu/`, with a
  `scripts/nn/parity.check.ts` case. Keep signatures stable; other units build on them.

## Frame loops: `compile`, `scope`, `readLater`

`forward(fn)` re-runs `fn`, re-records, plans fusion and hashes the graph on every call. For a loop that
runs the same net per frame, record once:

```ts
const net = await nn.compile("pose/encoder", [[1, 3, 224, 224]], ([img]) =>
  nn.scope("encoder", () => ({ heat: head(backbone(img)) })));   // fn runs once per (key, shapes)
const out = await net.run([frameFloats]);     // Float32Array in (queue write), { heat: Float32Array } out
await net.submit([frameFloats]);              // GPU consumers: net.outputs.heat is a persistent tensor (GpuNn)
net.dispose();                                // awaits are the caller's: no run may be in flight
```

- Inputs are persistent buffers written in place (a `Float32Array`), or a ready f32 tensor that is
  rebound for that run (its nodes build a new bind group). Outputs are persistent buffers: the next
  run overwrites them, `run()` copies them into its staging slot in the same submission. Weights and
  constants `fn` captures stay alive; keep them until `dispose()`.
- The graph is owned (not in the `cachedGraph` LRU) and run with `runOwned`: compile, encode and submit
  are synchronous in the call, so `run` N+1 is on the GPU queue before run N's readback maps. Do not
  `await` between frames; consume each promise a frame later (`Promise.all` of 32 runs of a 100-node
  chain: 0.45 ms/frame against 1.4 ms awaited one by one on Dawn, noisy shared machine).
- `Runtime.enqueue` starts a step at once when nothing is queued, so `forward`, `read` and eager
  uploads also skip a microtask hop when idle. The queue still orders every step.
- Bind groups of a graph node are reused while its buffers are unchanged (`encodeDispatchMemo` in
  `gpu/core/kernel.ts`, all ComputeGraph users), which removed most of the per-node encode cost.
- `nn.scope("encoder.block3", () => ...)` stamps the path on the nodes; node ids read
  `encoder.block3/n12:ew-bin-add...`, so `getGpuProfile()` (`__RIGI_GPU_PROFILE__ = true`) and the
  /dev/graph inspector map to layers.
- `nn.readLater(t, into?)` starts a copy now and resolves later; several can be in flight (the readback
  ring grows on demand). On the CPU backend `compile().run` is eager `forward` + `read`.
- `scripts/nn/frame-loop.bench.ts` measures per-call overhead, pipelining and the MoGe depth net warm.
  `MogeDepthNet.runCompiled` is the depth net on this path.

## Sharing a ComputeGraph with luma operators (GpuNn)

`forward()` builds its own cached graph. To put a network in the SAME graph as photoprep / gpu-raster / gpgpu
nodes (one submission, no copy), use the view interop (`scripts/nn/interop.check.ts`):

```ts
const x = nn.fromView(g, edgeView, [1, 1, H, W]);        // a GraphDataView<"float32"> of g as a tensor
const y = nn.forwardInto(g, () => nn.relu(nn.conv2d(x, w))); // records into g, nothing compiled or run
const yView = nn.toView(g, y);                            // output as a view: feed GPUReduction etc.
g.compile(); await g.run(p, { read: [viewRange(yView, nn.bufferOf(y))] });
```

`fromView` tensors only work inside `forwardInto` of their graph; outputs are valid after `g.run`.
(`fromBuffer` / `bufferOf` share plain buffers across separate submissions.)

## Luma operators (`gpu/luma-ops.ts`)

Some nn ops run on luma gpgpu operators, as nodes of the same forward graph (`Node.luma`, a contributor whose
views alias the nn storages). Chosen with `scripts/nn/luma-ops-bench.ts` (Dawn, M3 Pro, f32, ms per op, nn vs
luma): `gpu.lumaOps.enabled = false` forces every nn kernel for A/B.

| nn op | luma operator | numbers | decision |
|---|---|---|---|
| `transpose` / `permute` of a plain 2-D f32 matrix | `GPUTranspose` | 2048²: 0.56 vs 0.27; 1369x768: 0.20 vs 0.10 | adopted (1.4 to 2x) |
| `add sub mul maximum minimum`, same shape, f32 | `GPUElementwise` | 4M: 0.43 vs 0.40; 64k: 0.10 vs 0.05 | adopted (equal or better); broadcast, scalar, div, pow, compare, where stay nn |
| `sum mean max min` of ONE row of >= 2^18 | `GPUReduction` | 1M: 0.62 vs 0.22; 4M: 4.8 vs 0.5 | adopted from 2^18 (below: nn, one workgroup is enough); per-axis reductions stay nn |
| `topk` of one row of >= 2^16 | key transform, `GPUSort`, decode | 786k (k 4096): 10.3 vs 2.9; 64k: 2.4 vs 2.0 | adopted from 2^16; batched rows and short rows stay bitonic |
| `matmul` / `linear` | `GPUMatMul` (16x16 tiles) | 1024³: 1.46 vs 6.6 (1469 vs 325 GFLOP/s) | rejected, nn GEMM is 4.5 to 5.5x faster; f32 only, no f16 weights, no epilogue |
| `rfft2` / `irfft2` (new, additive) | `GPUFFT2D` | 1x256x256: 0.87 / 0.94 ms; 1x512x512: 1.9 ms | new; H, W powers of two 2..2048 |
| attention, conv, norms, gridSample | none | | luma has no equivalent (`GPUConvolution` is one plane with a kernel, not NCHW) |

Parity: the same op against the CPU reference in `parity.check.ts` (`transpose-luma`, `topk-ties-luma`,
`reduce-huge`, the existing binary cases); rfft2 / irfft2 against an f64 DFT in `fft.check.ts`.
Topk ties and signed zeros keep the old order (stable sort, `-0` folded into `+0`). Complex tensors are
`[..., 2]` (re, im), like `torch.view_as_real`; the CPU backend has no rfft2 yet (`fft-reference.ts` is the spec).

## Weights

safetensors under `public/models/` (hash-named, a row in `scripts/models/manifest.json`), dumped from
the PyTorch `state_dict` in fp16 by a producer under `scripts/models/`. `loadWeights` uses
`src/lib/models` `fetchModel` (Cache Storage, progress); `setModelFetcher` overrides it in tests.

## Quantized weights (`quant.ts`)

A file can store large tensors as int8 / int4 with per-group f16 scales (`__metadata__.quant` lists
`{ bits, group, shape }` per name; data in `<name>.qweight` U8 + `<name>.qscale` F16). `loadWeights` /
`weightsFromBytes` handle them in one of two ways:

- **Resident int8 (opt-in, `new GpuNn(device, { quantResident: true })`; off by default because the MoGe-2 forward measured ~12% slower over Dawn, 274 vs 307 ms median, noisy)**: an int8 tensor of rank >= 2 whose row length and group are
  multiples of 4 stays packed on the GPU as dtype `"q8"` (~1 B/param + the f16 scales; MoGe-2 q8: 36 MB
  instead of 70 MB). The buffer is self-describing (`packResident`: header words cols / group / scale
  offset / groups per row, the int8 words, then the f16 scales), so kernel meta and bindings do not change.
  `nnKernel` gives a q8 input `ld_<n>(i)`, `ldrc_<n>(row, col)` and `ld4rc_<n>` (four values from one word),
  and the weight loads of linear / matmul-B (vec4 and scalar), implicit-GEMM conv2d / convTranspose2d /
  deformConv2d and the direct conv dequantize in-kernel. A q8 tensor can only feed those weight slots
  (or be `reshape`d keeping the leading dim); any other op, `read` included, throws, so small vectors
  (norm weights, biases, LayerScale) should stay fp16 in the file (the quantize producer's `keep` rule).
  Measured over Dawn, MoGe-2 q8 at 1200 tokens: forward about +6% vs expanded (noisy), outputs differ by
  f16-rounding level (depth max 4.6e-4).
- **Expanded**: int4, ineligible tensors, the default (`quantResident` off) and the CPU
  backend expand once: GPU in one graph node per weight (`gpu/k-quant.ts`, f16 via `pack2x16float` on
  shader-f16 devices, else f32, exactly sized buffers), CPU in JS (`dequantize`, the reference). The
  result is an ordinary f16 / f32 weight.

Producer: `scripts/models/quantize.ts`; parity: the `dequant` and `q8 resident` rows of
`scripts/nn/parity.check.ts`; `scripts/nn/bench-q8.ts` (MoGe-2 forward, weight bytes, output diff) and
`scripts/nn/bench.ts --q8 | --q8-expand` (GFLOP/s).

## Kernels (`gpu/`)

| file | ops |
|---|---|
| `wgsl.ts` | kernel template: `M` parameter words, f32/f16 inputs read through `ld_<name>()`, f32 outputs; memoised specs (group `nn`) |
| `runtime.ts` | lazy tensors, recordings, epilogue fusion, dead-code elimination, lowering to a cached `ComputeGraph`, free-list buffer pool, the ordered submit chain |
| `k-gemm.ts` | register-blocked vec4 GEMM (tile shape chosen per shape by `gemm-select.ts`) with pluggable loaders: matmul / linear, implicit-GEMM conv2d, convTranspose2d, deformable conv v2; direct conv for depthwise / small Cout |
| `kernel-caps.ts` | device capabilities and tuning switches the generators read (f16 math opt-in, `legacy: true` forces the old kernels for A/B) |
| `k-attention.ts` | flash attention (online softmax, K/V tiles in workgroup memory, vec4 rows), optional additive mask |
| `k-reduce.ts` | softmax / logSoftmax, layerNorm, groupNorm, l2Normalize, sum / mean / max / min / argmax |
| `k-spatial.ts` | max / avg pool, interpolate (nearest, bilinear, bicubic), gridSample, NMS max-pool, pad, gather, rotary, fromTexture |
| `k-elementwise.ts` | unary, broadcasting binary / where (as fusable `EwDesc`s), strided copies (permute, slice, expand, concat) |
| `k-fused.ts`, `fusion.ts` | layerNorm over an elementwise expression (+ residual sum); the CPU planner that fuses elementwise chains and layerNorm + residual |
| `k-topk.ts` | bitonic topk with in-workgroup stages |
| `k-quant.ts` | load-time int8 / int4 → f16 / f32 weight expansion |

## Checks

- `npx vitest run src/lib/nn`: CPU reference against hand-computed values, GPU planning logic.
- `DAWN_DIR=/tmp/dawn npx tsx scripts/nn/parity.check.ts` (fast row `nn-parity`): every GPU op vs
  the CPU reference over Dawn in node, max abs / rel error per case; SKIP without `DAWN_DIR`.
- `DAWN_DIR=/tmp/dawn npx tsx scripts/nn/compile.check.ts` (fast row `nn-compile`): persistent forward vs CPU, pipelined runs, rebinding, scope labels.
- `DAWN_DIR=/tmp/dawn npx tsx scripts/nn/frame-loop.bench.ts [--only tiny,chain,pipeline,depth]`: frame-loop CPU overhead and the depth net warm run.
- `DAWN_DIR=/tmp/dawn npx tsx scripts/nn/bench.ts [--f16]`: GFLOP/s of linear, conv, attention.
- `DAWN_DIR=/tmp/dawn npx tsx scripts/nn/wgsl-lint.ts`: compile messages of every nn kernel.

Not built yet: non-power-of-two FFT sizes (LaMa at odd sizes needs padding or a mixed-radix FFT), split-K / flash-decoding for very small batches.
