# src/lib/gpu/skyline: GPU cost images for the photo skyline detector

`geo/skyline.ts` `detectSkyline` (about 0.2 s at 800 px) has no exact GPU twin: the Viterbi passes are sequential over x and the sky-model fit is an f64 IRLS. This directory moves only the per-pixel stages to the compute device and keeps the rest on the CPU:

| Stage | Where |
|---|---|
| unpack, box blurs, gradient, texture, vertical colour step (`edge`, `step`), heuristic sky prior | GPU feature graph (`skyline-feat-WxH`), read back as f32 |
| sky-model fit (`fitSkyModel`), Viterbi, sub-pixel row, weights, continuity | CPU (`geo/skyline.ts`, unchanged) |
| `modelSky` probability image, once per fit (seed + one refit) | GPU model graph (`skyline-model-WxH`), read back |

`detectSkylineAsync` (`geo/skyline.ts`) takes this path when `?skylineGpu=on` and `?gpu` is on and a compute device exists, and returns the CPU `detectSkyline` result otherwise or on any GPU error. `detectSkylineWith(img, opts, stages)` is the shared orchestration; the CPU `detectSkyline` is unchanged in behaviour. Callers that are already async use `detectSkylineAsync` (`integration/unknown-pose-core.ts`, `gpu/eye/samples.ts`); `sky/core.ts classicalSky` is synchronous and stays on the CPU.

`?skylineGpu` is off by default. Evidence (Dawn, node; `scripts/gpu/skyline-dawn.ts`, `scripts/gpu/unknown-gpu-node.ts --skyline-gpu on|off`): see the commit message of the flag flip decision in the batch ledger; in short, feature images agree to about 2e-7 (edge up to 7e-2 at the `dl > 0` polarity discontinuity), rows to 5e-5 px, and one unknown-pose accept decision of 77 flipped. Root cause (research_notes/wave5/skyline-gpu-flip.md): not a precision bug in the GPU stages. The flip is in the cascade's wrong-focal third seed, whose `refinePose` is chaotic at the 1e-5 px level; the same flip happens on the CPU with 1e-4 px noise on the rows. Stays off.

In workers (eye search, unknown-pose) `?skylineGpu=on` and `?gpu=off` arrive through `realmGpuOptions().flags` (`gpu/core/realm.ts`, `FORWARDED_FLAGS`); a worker has no page URL, so before that it always read the defaults.
Check: `npx tsx src/lib/gpu/skyline/skyline.check.ts` (CPU-only: the stage split equals `detectSkyline`).
