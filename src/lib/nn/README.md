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
- Missing an op? Add it to `types.ts` + `base.ts` (shape logic) + `cpu.ts` + `gpu/`, with a
  `scripts/nn/parity.check.ts` case. Keep signatures stable; other units build on them.

## Weights

safetensors under `public/models/` (hash-named, a row in `scripts/models/manifest.json`), dumped from
the PyTorch `state_dict` in fp16 by a producer under `scripts/models/`. `loadWeights` uses
`src/lib/models` `fetchModel` (Cache Storage, progress); `setModelFetcher` overrides it in tests.

## Kernels (`gpu/`)

| file | ops |
|---|---|
| `wgsl.ts` | kernel template: `M` parameter words, f32/f16 inputs read through `ld_<name>()`, f32 outputs; memoised specs (group `nn`) |
| `runtime.ts` | lazy tensors, recordings, epilogue fusion, dead-code elimination, lowering to a cached `ComputeGraph`, free-list buffer pool, the ordered submit chain |
| `k-gemm.ts` | 64×64-tile GEMM with pluggable loaders: matmul / linear, implicit-GEMM conv2d, convTranspose2d, deformable conv v2; direct conv for depthwise / small Cout |
| `k-attention.ts` | flash attention (online softmax, K/V tiles in workgroup memory, vec4 rows), optional additive mask |
| `k-reduce.ts` | softmax / logSoftmax, layerNorm, groupNorm, l2Normalize, sum / mean / max / min / argmax |
| `k-spatial.ts` | max / avg pool, interpolate (nearest, bilinear, bicubic), gridSample, NMS max-pool, pad, gather, rotary, fromTexture |
| `k-elementwise.ts` | unary, broadcasting binary / where, strided copies (permute, slice, expand, concat) |
| `k-topk.ts` | bitonic topk with in-workgroup stages |

## Checks

- `npx vitest run src/lib/nn`: CPU reference against hand-computed values, GPU planning logic.
- `DAWN_DIR=/tmp/dawn npx tsx scripts/nn/parity.check.ts` (fast row `nn-parity`): every GPU op vs
  the CPU reference over Dawn in node, max abs / rel error per case; SKIP without `DAWN_DIR`.
- `DAWN_DIR=/tmp/dawn npx tsx scripts/nn/bench.ts [--f16]`: GFLOP/s of linear, conv, attention.
- `DAWN_DIR=/tmp/dawn npx tsx scripts/nn/wgsl-lint.ts`: compile messages of every nn kernel.

Not built yet: FFT ops (LaMa's FFC), split-K / flash-decoding for very small batches.
