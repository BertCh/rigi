# src/lib/gpu/skyline: GPU cost images for the photo skyline detector

`detectSkylineGpu` runs the whole of `geo/skyline.ts` `detectSkyline` as ONE `ComputeGraph` per (w, h, gradient, refinePasses) (`detect-WxH-pN`, group `skyline`), one submit and one readback (2026-10-02, review P2.16):

| Stage | Kernels |
|---|---|
| features and heuristic prior | unpack, box blurs (luma `GPUConvolution` + clamp-to-edge FIX), gradient, texture, edge / step, prior (as before, now graph transients) |
| sky-model fit, seed (weight prior · (1 - y/h)^6) and each refit (sky above the boundary), 4 IRLS iterations each | `fit-*` accumulate (64 samples per workgroup, fixed-order tree, 62 partial sums per workgroup, no float atomics) then `fit-solve-*` (one workgroup: fixed-order sum, ridge, Gaussian elimination, sigma, valid / stopped flags in a 32-word model buffer) |
| model image | `model-g` reads the model buffer; invalid model: the fallback plane (prior for the seed, the previous sky for a refit) |
| Viterbi | `unary` (a column per thread), `dp` (one 256-thread workgroup, ping-pong columns, window ±ceil(jumpCap/jumpCost), final argmin and backtrack) |
| finish | `column` (sub-pixel row + raw weight per column, NaN as bits), `pack` (sky plane as bytes) |

Only rows + weight (2·w floats) and, with `returnSky`, the packed sky bytes come back; the continuity / trend tail (`finishSkylineColumns`) runs on the CPU. `refinePasses` other than 0, 1, 2 returns null (CPU). `twin.ts` holds pure CPU twins of the unary and DP kernels (spec: equal to `viterbi`). The older hybrid (feature graph with readbacks, CPU fits and Viterbi) survives as `openSkylineGpu` + `detectSkylineWith` for the Dawn scripts, which time it against the whole-graph path.

`detectSkylineAsync` (`geo/skyline.ts`) takes this path when `?skylineGpu=on` and `?gpu` is on and a compute device exists, and returns the CPU `detectSkyline` result otherwise or on any GPU error. The CPU `detectSkyline` is the reference (its finish is split into `skylineColumnPart` + `finishSkylineColumns`, behaviour unchanged). Callers that are already async use `detectSkylineAsync` (`integration/unknown-pose-core.ts`, `gpu/eye/samples.ts`); `sky/core.ts classicalSky` is synchronous and stays on the CPU.

`?skylineGpu` is off by default (`src/lib/flags`). Why it stays off: the GPU stages are not at fault. The one unknown-pose accept decision that flipped (1 of 77) comes from the cascade's wrong-focal third seed, whose `refinePose` is chaotic at the 1e-5 px level; the same flip happens on the CPU with 1e-4 px noise on the rows (`research_notes/wave5/skyline-gpu-flip.md`). The cascade fix is `?focalSeedGate=on` (default off; `isAmbiguousFocal`, `integration/unknown-pose-core.ts`). Both defaults stay off until the browser A/B is re-run.

Tolerance against the CPU twin on synthetic images (`scripts/gpu/skyline-conv-dawn.ts`, Dawn, 2026-10-02): rgb 2.4e-7, tex 6e-8, edge 2.4e-7 away from the `dl > 0` polarity flip (1.2e-2 at it), step 1e-7, prior 3.3e-6, rows 7.6e-6 px, 0 finiteness differences.

In workers (eye search, unknown-pose) `?skylineGpu=on` and `?gpu=off` arrive through `realmGpuOptions().flags` (`gpu/core/realm.ts`, `FORWARDED_FLAGS`); a worker has no page URL, so before that it always read the defaults.
Box blurs: the five CPU `boxBlur`/`boxBlurH` clamp-to-edge means are `GPUConvolution` (direct, zero boundary, all-ones kernel views of one 8-float `ones` transient written by the unpack kernel) plus `blurfix-*` kernels (`skylineBlurFixSource`): out = (sum + max(0, r - i) first + max(0, i + r - (len - 1)) last) / (2r + 1). An x blur is one convolution over w × (planes · h); a y blur is one per plane through `byteOffset` views.
Dawn check: `DAWN_DIR=... npx tsx scripts/gpu/skyline-conv-dawn.ts` (features and detector rows vs the CPU twin on synthetic images, odd sizes and sizes under 2r+1).
Check: `npx tsx src/lib/gpu/skyline/skyline.check.ts` (CPU-only: the stage split equals `detectSkyline`).
Sobel option (2026-10-02, raster-edges): `detectSkylineGpu(img, opts, "sobel")` swaps the hand `grad` kernel for a luminance kernel plus luma `GPURasterGradientMagnitude` (Sobel, scale 1/4, `raster-edges.ts` adapter), so the local-texture feature uses a [1 2 1]-smoothed central difference with clamped borders. It is opt-in and has no flag: on the 12 demo photos at 800 px (`scripts/gpu/skyline-raster-dawn.ts`) the median row shift is 0 px but the tails are large (p99 up to 7 px, max 34 px) and up to 34 columns per photo change between finite and non-finite, so the default stays the hand kernel (rows within 1e-3 px of the CPU). `GPURasterContours` / the other raster ops were evaluated for `geo/skyline.ts` and ridgelines and do not fit (see the unit report); the CPU `detectSkyline` stays the WebGL2 path and reference.
