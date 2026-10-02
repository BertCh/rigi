# Step Inside: a smaller, earlier depth-model download (2026-10-02)

Before this change Step Inside downloaded the MoGe-2 ViT-S weights only when the button was pressed. That was 70.2 MB of fp16, and nothing showed until it finished. Compute was never the bottleneck. On Dawn (M3 Pro), a 1024×683 photo at 1200 tokens takes about 1.0 s cold and about 0.46 s warm, and the ViT encoder is only about 70 ms of that. The neck and the three conv heads at high resolution take the rest.

## What changed

1. **int8 download, expanded on the GPU (`src/lib/nn/quant.ts`, `gpu/k-quant.ts`).**
   - New file format: a safetensors file whose `__metadata__.quant` lists tensors stored as `<name>.qweight` (U8: int8, or int4 nibbles) plus `<name>.qscale` (F16, one scale per row or per group).
   - `weightsFromBytes` expands each tensor once at load with one compute-graph node: `pack2x16float` to f16 on shader-f16 devices, f32 otherwise. Expanded weights get exactly sized buffers, and the packed bytes are freed after submission.
   - The CPU backend expands in JS, which is also the reference implementation.
   - Model code, kernels and GPU memory are the same as with fp16; only the download shrinks. fp16 files load as before.
   - Producer: `scripts/models/quantize.ts --preset moge2-q8 | moge2-q8lite`.
2. **Weights by flag.** `?nearfieldWeights=q8|q8lite|fp16` (default `q8`). The file table is `MOGE2_WEIGHTS` in `src/lib/nearfield/local/depth-net.ts`.
3. **Normals without the normal head (q8lite).** `normalsFromDepth` in `compose.ts` back-projects the metric depth and crosses the tangents. Each tangent takes the side with the smaller depth step, so occlusion edges keep their own slope.
4. **Prefetch.** About 2.5 s after a pose is accepted, `useStepInside` calls `NearFieldController.prefetch()`, which fetches the weights into Cache Storage. That costs no device memory. It is skipped under Save-Data and on 2G/3G (`src/lib/nearfield/prefetch.ts`). A Step Inside press during the prefetch joins the same download, and every waiting caller gets progress text.
5. **Terrain preview.** If the photo's depth is not ready, Step Inside enters at once on a scene built from the DEM range alone (`src/lib/nearfield/preview.ts`). That means the terrain drape plus a movable step camera, with no splats. The panel shows "Terrain preview — downloading model …". The depth scene replaces the preview in place when it is ready. The preview is never cached per pose and never exported or measured.
6. **Fix:** `parseSafetensors` called `.slice` on a node `Buffer`, which returns a view, so every F16 tensor viewed the whole file. Callers that wrapped the Buffer in `new Uint8Array(...)` were unaffected. It now copies.

## Sizes and parity

All variants were compared with fp16 on 24 photos: 12 demo photos and 12 from `public/photos`. The command is `DAWN_DIR=/tmp/dawn npx tsx scripts/nearfield/depth-weights-eval.ts --dir <pre-decoded photos>`. Depth error is |d / d_fp16 − 1| on pixels valid in both. "Aligned" divides out the median ratio, because the DEM anchor fits the scale anyway.

| weights | download | depth med (worst photo) | aligned med / p90 (worst p90) | focal (worst) | mask IoU min | normals vs fp16 head | forward vs fp16 |
|---|---|---|---|---|---|---|---|
| fp16 | 70.2 MB | n/a | n/a | n/a | n/a | n/a | 1.00 |
| **q8 (default)** | **36.1 MB** | 1.2% (3.5%) | 0.6% / 2.0% (3.1%) | 0.3% (1.5%) | 0.997 | 0.4° | ≈1.0 |
| q8lite | 33.0 MB | 1.2% (3.5%) | 0.6% / 2.0% (3.1%) | 0.3% (1.5%) | 0.997 | 21° (depth-derived) | ≈0.76 |
| int4 ViT linears + int8 rest | 23.6 MB | 16% (36%) | 7.3% / 28% (96%) | 6% (17%) | 0.64 | | |
| int4 ViT MLPs only + int8 rest | 26.7 MB | 16% (40%) | 5.0% / 19% (51%) | 4.7% (9.8%) | 0.67 | | |

- int4 here means round to nearest, groups of 32, with a per-group clip search. It breaks this network, and is recorded in `negative-results.md`. A calibrated int4 scheme (GPTQ/AWQ-style, with activation statistics) is the only int4 route left and was not tried.
- Normals derived from depth differ from the head by about 20° median. Step sizes of 2, 4 and 8 pixels give 21°, 20° and 20°, and fp16-derived and q8-derived normals give the same figure, so the gap is the method, not the quantization. The head's normals are learned and smoother. q8 keeps the head so splat orientation is unchanged; q8lite trades that for 3 MB and about a quarter of the forward time.
- Compression does not help on its own: gzip -9 of the fp16 file is 64.9 MB, and byte-shuffle plus gzip is 60.4 MB.
- Other depth models offer no shortcut. Every strong small model (Depth Anything V2/3 Small, Distill-Any-Depth-S, MoGe-2-S) uses the same DINOv2-S backbone, about 43 MB in fp16. Small CNNs (MiDaS-small, FastDepth-style) are much weaker on outdoor photos taken in the wild.

## Checks

- `scripts/nn/parity.check.ts` (`nn-parity`): dequant int8/int4 on GPU vs CPU, including odd sizes and use inside a forward (101/101 on Dawn).
- `src/lib/nearfield/local/depth-net.check.ts`: fp16 against the PyTorch reference, unchanged.
- Specs: `src/lib/nn/__tests__/quant.spec.ts`, `src/lib/nearfield/local/__tests__/{normals,client}.spec.ts`, `src/lib/nearfield/__tests__/{prefetch,preview}.spec.ts`.
- Browser-unverified: the in-app download, prefetch timing, the preview UX and visual parity of q8 splats. These are listed for the next batch pass.

## Follow-ups

- If the q8 visuals hold in the batch pass, the fp16 file is only a parity reference. It can stay in `public/models` for `?nearfieldWeights=fp16` and the checks, or be served from elsewhere.
- ViTPose-B for people completion (`?peopleBody=on`) now has an int8 download: `scripts/models/quantize.ts --preset vitpose-q8` gives `vitpose-b-q8.cd86f1f4.safetensors`, 87.1 MB against 172 MB (the 48 ViT linears are int8 with one scale per row; patch conv, head conv, norms, biases and pos embed stay fp16, 2.0 MB). Measured over Dawn with `scripts/body/vitpose-weights-eval.ts` on 26 person crops from 19 photos (demo and `public/photos`, hand-picked boxes, 442 keypoints), q8 against fp16 in the 192 x 256 input frame: position error median 0.08 px, p90 0.26 px, max 78.8 px (one low-confidence left ankle; 1.85 px max among keypoints with an fp16 peak >= 0.3, where median is 0.06 and p90 0.17); heatmap peak change median 0.002, max 0.015; the argmax cell moved for 4.1% of keypoints (2.1% of confident ones). That meets the gate (median < 0.5 px, p90 < 1.5 px), so `?peopleBodyWeights=q8|fp16` (default `q8`, `VITPOSE_WEIGHTS` in `src/lib/body/vitpose.ts`) selects the file. `body-vitpose` still checks the fp16 file against PyTorch. Browser-unverified: the in-app download and people-completion visuals.
