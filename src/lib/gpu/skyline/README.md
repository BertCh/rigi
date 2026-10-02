# src/lib/gpu/skyline: GPU cost images for the photo skyline detector

`geo/skyline.ts` `detectSkyline` (about 0.2 s at 800 px) has no exact GPU twin: the Viterbi passes are sequential over x and the sky-model fit is an f64 IRLS. This directory moves only the per-pixel stages to the compute device and keeps the rest on the CPU:

| Stage | Where |
|---|---|
| unpack, box blurs (luma `GPUConvolution` window sums + a clamp-to-edge FIX kernel each), gradient, texture, vertical colour step (`edge`, `step`), heuristic sky prior | GPU feature graph (`skyline-feat-WxH`), read back as f32 |
| sky-model fit (`fitSkyModel`), Viterbi, sub-pixel row, weights, continuity | CPU (`geo/skyline.ts`, unchanged) |
| `modelSky` probability image, once per fit (seed + one refit) | GPU model graph (`skyline-model-WxH`), read back |

`detectSkylineAsync` (`geo/skyline.ts`) takes this path when `?skylineGpu=on` and `?gpu` is on and a compute device exists, and returns the CPU `detectSkyline` result otherwise or on any GPU error. `detectSkylineWith(img, opts, stages)` is the shared orchestration; the CPU `detectSkyline` is unchanged in behaviour. Callers that are already async use `detectSkylineAsync` (`integration/unknown-pose-core.ts`, `gpu/eye/samples.ts`); `sky/core.ts classicalSky` is synchronous and stays on the CPU.

`?skylineGpu` is off by default. Evidence (Dawn, node; `scripts/gpu/skyline-dawn.ts`, `scripts/gpu/unknown-gpu-node.ts --skyline-gpu on|off`): see the commit message of the flag flip decision in the batch ledger; in short, feature images agree to about 2e-7 (edge up to 7e-2 at the `dl > 0` polarity discontinuity), rows to 5e-5 px (box blurs now on `GPUConvolution`, 2026-10-02; `scripts/gpu/skyline-conv-dawn.ts` on synthetic images: rgb 2.4e-7, tex 6e-8, edge 2.4e-7 away from the polarity flip (1.2e-2 at it), step 1e-7, prior 3.3e-6, rows 7.6e-6 px, finiteness differences 0; the old shader gave the same orders), and one unknown-pose accept decision of 77 flipped. Root cause (research_notes/wave5/skyline-gpu-flip.md): not a precision bug in the GPU stages. The flip is in the cascade's wrong-focal third seed, whose `refinePose` is chaotic at the 1e-5 px level; the same flip happens on the CPU with 1e-4 px noise on the rows. Stays off. The cascade fix (2026-10-02): a refine-only accept of a non-best focal seed with solve confidence under `SEED_REFINE_MIN_SOLVE_CONFIDENCE` no longer trips `ambiguous` (`isAmbiguousFocal`, `integration/unknown-pose-core.ts`), with `?focalSeedGate=on` (default off), so this flip no longer depends on row noise; both defaults stay off until the browser A/B is re-run.

In workers (eye search, unknown-pose) `?skylineGpu=on` and `?gpu=off` arrive through `realmGpuOptions().flags` (`gpu/core/realm.ts`, `FORWARDED_FLAGS`); a worker has no page URL, so before that it always read the defaults.
Box blurs: the five CPU `boxBlur`/`boxBlurH` clamp-to-edge means are `GPUConvolution` (direct, zero boundary, all-ones kernel views of one 8-float `ones` transient written by the unpack kernel) plus `blurfix-*` kernels (`skylineBlurFixSource`): out = (sum + max(0, r - i) first + max(0, i + r - (len - 1)) last) / (2r + 1). An x blur is one convolution over w × (planes · h); a y blur is one per plane through `byteOffset` views.
Dawn check: `DAWN_DIR=... npx tsx scripts/gpu/skyline-conv-dawn.ts` (features and detector rows vs the CPU twin on synthetic images, odd sizes and sizes under 2r+1).
Check: `npx tsx src/lib/gpu/skyline/skyline.check.ts` (CPU-only: the stage split equals `detectSkyline`).
