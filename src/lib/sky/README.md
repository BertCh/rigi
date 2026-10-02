# src/lib/sky: browser sky segmentation

```ts
import { segmentSky, skylineFromSky } from "#/lib/sky";

const mask = await segmentSky(img); // { width, height, data: P(sky)*255, row 0 = top }
const sky = skylineFromSky(mask); // { width, height, rows, weight }: same shape as SkylineObservation
```

- `segmentSky(img, { longSide = 1024, refine = true })` accepts an `HTMLImageElement`, `ImageBitmap` or `ImageData`. The output long side is at least 512. The function always resolves: if the model or the worker fails, it uses the classical fallback. A worker that stops replying (no reply for 180 s before its first reply, 60 s after, while requests are pending; `pending.ts`) is dropped like a crashed one, so a hung ORT run can't hang the caller. Optional extras: `backend: "webgpu" | "wasm"`, `modelLongSide`, `forceFallback`. The result also reports `source` (`model` or `fallback`), `backend` and `ms`. `preloadSkyModel()` starts the worker and the download early.
- `skylineFromSky(mask)` finds, for each column, the topmost sky→non-sky 0.5 crossing, interpolated to sub-pixel precision. Non-sky runs thinner than about 1.5% of the height (cables, wires) are scanned through. `weight` = sharpness × clean sky above × clean ground below, multiplied by 0.7 when the sky doesn't reach the top of the frame (a window, branches). The value is NaN where no sky was found or the weight is below 0.05. Row coordinates match `detectSkyline`: pixel i spans [i, i+1).
- Scope: the mask separates sky (clouds included) from everything else. Hazy blue distant ridges count as non-sky. People are not special-cased, so remove them with MediaPipe.

## Pipeline

1. The main thread rasterises the photo at the working size (long side 1024) and posts it to a module worker (`sky.worker.ts`).
2. The worker lazily loads the weights `public/models/skyseg-u2netp-nn.884ee489.safetensors` (`MODEL_FILE` in `model.ts`; fp16 safetensors with the exported graph as a program, made by `scripts/models/u2netp.py` from the ONNX below, fetched through `src/lib/models`) and runs U²-Net-P on `src/lib/nn` (`u2netp.ts`): WGSL kernels on one core ComputeGraph per forward when the page allows the GPU and the worker's compute device is WebGPU, otherwise the nn CPU reference backend (plain JS, about 150 M MAC/s: a 160x128 forward takes ~8 s in node, so the CPU backend takes a 192 px long side and the worker stays off the main thread; `forceFallback` and the classical segmenter are the quick alternative). The input is ImageNet-normalised RGB, with long side 512 on WebGPU and 192 on the CPU backend, rounded to multiples of 32. The output is sigmoid P(sky). onnxruntime-web is no longer used by the sky path.
3. Refinement uses a fast colour guided filter (He, Sun & Tang; He & Sun 2015). The a and b coefficients are solved at model resolution (r=3, eps=2e-3) with the downsampled photo as guide, upsampled bilinearly, and applied to the full-resolution photo. The filtered value is used only in a band around the model's 0.5 contour or where the model is unsure. Everywhere else the upsampled model output is kept, so snow and cloud texture far from the ridge can't leak into the mask.
4. GPU (default when the page's `gpuEnabled()` allows it; the page sends the answer as `gpu` in the worker messages, so `?gpu=off` turns it off). The worker's luma compute device runs the model (`createSkyModel({ device })`), the GPU prep and the refine, so all three share ONE `GPUDevice`. The prep's normalised input buffer is read in place by the model graph (`GpuNn.fromBuffer`), the model's output stays on the GPU (`GpuNn.bufferOf`), and `src/lib/gpu/sky/refine.ts` (the GPU twin of `refineToWorking` + `toBytes`) reads that buffer and reads back only the byte mask. A cached model is only reused on the device it was created on. The CPU refine is the reference and the fallback when there is no WebGPU, with `?gpu=off`, and on any GPU error. The response reports `refineOn` (`gpu`/`cpu`) and `backend` (`webgpu`/`cpu`, the nn backend).

   **GPU prep (default on: on; `segmentSky(img, { gpuPrep: false })` or `?gpu=off` opts out).** Instead of `getImageData` + CPU resample/normalise, the page sends the working-size photo as an `ImageBitmap` (`premultiplyAlpha`/`colorSpaceConversion` `'none'`, transferred); the worker uploads it and `src/lib/gpu/sky/prep.ts` writes the RGBA words, `rgbLo` and ORT's normalised input buffer (`ort.Tensor.fromGpuBuffer`, needs ORT on the shared device) with WGSL; `refineSkyGpu` imports `rgba` and `guideLo` as GPU buffers, so none of it visits the CPU. The results are bit-identical to the CPU chain, which is f64 stored through f32, so the kernels carry an exact u32 soft-float (`prep.wgsl.ts`; node twin `prep-ref.ts`; checks `scripts/gpu/sky-prep-check.ts` and, on real WGSL in Dawn, `scripts/gpu/sky-prep-dawn.ts`). Runtime guard (`sky/prep.ts`): the first 3 photos per device ride along with the CPU pixels and the GPU buffers are compared in full with the CPU chain; a mismatch disables the GPU prep for that device. Upsampling shapes, a missing shared device, GPU errors and `needPixels` replies all fall back to the CPU prep. The reply reports `prepOn`. Browser A/B (`scripts/gpu/sky-prep-ab.mjs`, headless Chrome on Metal, 2026-10-01): 69/69 photos (19 bundled, 50 wild dev) took the GPU prep with masks byte-identical to the CPU prep; median `segmentSky` 88.1 → 77.6 ms. The kernels then moved onto a core ComputeGraph (cachedGraph group `sky-prep`); that port is checked bit-identical on Dawn in node (`sky-prep-dawn.ts --graph`, 183 cases: 45 synthetic + 69 photos at two sizes, `isOpaque` included) but not yet re-run in the browser. The first browser run found every prep failing validation (the upload texture lacked `COPY_SRC`/`COPY_DST`), which the guard had caught (all photos fell back to the CPU prep). **Graph lifetime:** the prep and refine graphs are cached per shape; the worker releases both (`releasePrepGraphs`, `releaseSkyGraphs`) after 30 s without a request (`graph-idle.ts`, never while one is in flight; the device stays, ORT shares it), and a prep that disables itself releases its graphs at once. A later request rebuilds the same graphs (`sky-prep-dawn.ts --graph --release`, `graph-idle.check.ts`).
5. Fallback: `detectSkyline` from `geo/skyline.ts` (colour/texture sky model + Viterbi) at about 640 px wide. It gives a soft step at its boundary, plus its sky probability where it found no boundary. The same guided filter then refines it.

## Model choice

| candidate | licence | verdict |
|---|---|---|
| **U²-Net-P sky model** from [xiongzhu666/Sky-Segmentation-and-Post-processing](https://github.com/xiongzhu666/Sky-Segmentation-and-Post-processing) (`skysegsmall_sim-opt-fp16.*`, ncnn) | **MIT** ([LICENSE](https://github.com/xiongzhu666/Sky-Segmentation-and-Post-processing/blob/main/LICENSE)) | **chosen**. 1.1 M params, 4.5 MB fp32 ONNX |
| U²-Net full sky model `skyseg.onnx`, same repo ([HF mirror JianyuanWang/skyseg](https://huggingface.co/JianyuanWang/skyseg), MIT) | MIT | tested: 176 MB fp32, 44 MB int8 (per-channel weight-only DQ). Its masks are nearly identical (<0.5% of pixels differ), accuracy on our photos is the same, and it runs 3–4× slower. Not shipped |
| SegFormer ADE20k (nvidia/*) | NVIDIA Source Code Licence, non-commercial | rejected |
| MaskFormer ADE20k (onnx-community/maskformer-*) | CC-BY-NC 4.0 (MaskFormer) | rejected |
| UperNet-ConvNeXt, Mask2Former, OneFormer, EoMT | MIT or Apache, but 60 M+ params and hundreds of GFLOPs | too heavy for about 1 s in-browser |

The dataset the sky model was trained on isn't documented. The weights are released under MIT by their author.

**Conversion.** `src/lib/sky/tools/ncnn2onnx.py` rebuilds the graph from the ncnn param/bin (Conv+ReLU, MaxPool, bilinear Resize to the skip tensor's shape, Concat, Add) with dynamic H/W, keeping only the fused output. MaxPool uses `ceil_mode=0` because WebGPU lacks ceil mode, and the result is identical for inputs that are multiples of 32. The output hash is reproducible: sha256 `873ea284…c94a`.

## Measured (M3 Pro, machine under heavy load from other jobs)

The first table predates the GPU refine (2026-09-30) and the nn port (2026-10-02, browser-unverified), and its timings are the ONNX Runtime ones; with the GPU refine the worker's model + refine was about 89 ms, below. `ms.refine` includes the drain of the model's GPU work in the refine's single readback (`reports/negative-results.md`, the 67 ms row).

| path | model | refine + rest | total |
|---|---|---|---|
| Chromium, WebGPU (512 input) | 100–240 ms | 150–450 ms | **0.3–0.7 s** |
| Chromium, WASM, 1 thread (384 input) | 1.1–1.35 s | 80–200 ms | **1.2–1.5 s** |
| node, onnxruntime-web WASM, 4 threads (384) | ~0.45 s | ~0.1 s | ~0.55 s |
| classical fallback (browser) | – | – | ~0.6 s |

GPU refine on the shared device (2026-09-30, M3 Pro, headless Chromium with Metal, 6 photos at 1024×768, `scripts/gpu/sky-bench.mjs`):
- **Worker model + refine: about 200 ms before, about 89 ms after** (`infer` 87–99 ms and `refine` 93–121 ms before; 15–21 ms and 67–69 ms after). The model's GPU work now finishes inside the refine's single readback, so ORT no longer waits on its own download. The GPU refine itself takes about 4 ms. With `?gpu=off` the timings are the old ones.
- **Parity with the CPU refine on the same P(sky):** float max |Δ| 3e-6 to 1.2e-5, p99 ≤ 1.2e-6. Mask bytes differ on 0–9 of 786k pixels, by 1 each. The CPU sums in f64 and the GPU in f32; the LUT guide, the band test and `toBytes` are exact. Both the ORT buffer and uploaded floats give identical bytes. The classical fallback (640→1024) differs on 42 bytes, by 1 each. The downsample branch (640→512) differs on none.

The first call also pays the worker start, the 2.3 MB weights and the kernel compiles (the ONNX Runtime wasm, 28 MB, is gone).

## Evaluation

`npx tsx scripts/sky-eval.ts [--out DIR]` runs every photo in `public/photos` in node. It writes overlays, masks and `report.md`, and compares against the DEM skyline projected at the `data/ground-truth.json` poses. `node scripts/sky-browser.mjs [--no-webgpu|--fallback]` runs the real worker in headless Chromium against the dev server on :3100.

Results with 12 GT photos (2026-09-24). Each value is the median over photos of the per-photo median |Δrow| in px at 1024 wide, measured on columns where the DEM skyline is in frame:

| | model (refined) | model (unrefined) | fallback | detectSkyline |
|---|---|---|---|---|
| quality=good (7) | **2.18** | 2.10 | 3.48 | 2.97 |
| quality=good, bias removed | **1.63** | 1.57 | 2.35 | 2.06 |
| all (12) | 4.44 | 4.09 | 5.14 | 4.21 |
| all, bias removed | **2.26** | 2.27 | 3.23 | 2.75 |

Coverage is 0.93–1.0 of columns for the model, against 0.52–1.0 for `detectSkyline`. The "all" set includes selfies where a person hides much of the ridge (IMG_7059, 7063, 7068). DEM smoothing and trees add a few px of noise, so refining barely changes these medians. What it does improve is visible in the masks: crest detail and edges that follow the photo.

## Known failure modes

- Anything in front of the sky is non-sky: people, trees on the crest, lamp posts and chalets. It gets reported as the skyline, so consumers must mask people and reject outliers.
- Cables crossing just above a ridge (IMG_7086) can pull the boundary onto the wire for a few columns. Thin wires in open sky are skipped.
- On snow peaks under bright cloud (IMG_7086), the soft mask is fuzzy for a few px and the 0.5 crossing can wobble by 1–3 px.
- The classical fallback misses sky framed by windows (IMG_7108) and is weaker on hazy ranges.


## U²-Net-P on src/lib/nn (2026-10-02)

`u2netp.ts` interprets the exported ONNX data-flow graph (119 conv with dilation 1/2/4/8, 112 relu, 33 max-pool 2x2, 38 bilinear resize to a partner's size, 89 concat, 11 residual add, 1 sigmoid; BatchNorm had already been folded by the ncnn export) on the nn op API, so the same code runs on the WebGPU backend and the CPU reference. Parity against onnxruntime-web (node, wasm CPU EP; `src/lib/sky/__tests__/u2netp-parity.check.ts`, CI row `u2netp-parity`), fp16 weights against the fp32 graph, three demo photos: final mask max |Δ| 1.7e-3 and mean 2.4e-4 at 160x128 (both nn backends identical to 3 digits), 6.5e-4 to 1.7e-3 max and <= 6e-6 mean at 512 px on WebGPU; per stage (11 RSU outputs, 6 side maps) max |Δ| <= 2.8e-3 of the stage's peak. The GPU prep -> model -> refine chain on one Dawn device matches the CPU chain (mask max |Δ| 0 for the same input, refined bytes 0 off). Timings (node, Metal via Dawn, indicative): 512x384 forward ~150 ms warm against ~3.2 to 5.4 s for ORT wasm 1 thread; the CPU backend is the slow path.
