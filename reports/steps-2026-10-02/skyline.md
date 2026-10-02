<!-- Rigi -->
<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: Copyright (c) Rigi contributors -->

# Step ③ skyline: review, research, plan (2026-10-02)

Step lead: Opus pod under coordinator mt-image-17. Gipfelbuch node `skyline` (`src/lib/gipfelbuch/graph.ts:66`). Base: master `b5c7a3b`.

## 1. Current state, end to end

There are three skyline paths. Only one of them feeds the pose solve.

| Path | Code | Who uses it | Status |
|---|---|---|---|
| **Classical detector** `detectSkyline` / `detectSkylineAsync` | `src/lib/geo/skyline.ts` (features → heuristic prior → sky-colour fit → Viterbi → refit → `finishSkyline` weights) | Unknown-pose solve (`integration/unknown-pose-core.ts:148`), eye search samples (`gpu/eye/samples.ts`), `/baseline` worker (`baseline-ui/pipeline.worker.ts:203`), the sky worker's classical fallback (`sky/core.ts:427`), and many research scripts | live; this is the skyline the solver uses |
| GPU cost images for it | `src/lib/gpu/skyline/` (flag `skylineGpu`, off) | `detectSkylineAsync` when the flag is on | off: 1 of 77 unknown-pose accepts flipped. The cause is a chaotic wrong-focal seed, not the GPU maths (roadmap G2, owned by pod B) |
| **Learned sky mask** `segmentSky` | `src/lib/sky/**` (U²-Net-P ONNX in a worker, ORT WebGPU/WASM, GPU prep + guided-filter refine, island I6) | Looks only: haze and keep-sky through `setSkyMask` (`components/PhotoWorkspace.tsx:311`, `deck-webgpu/lab-engine.ts:283`), and the roll-spot sky exclusion (`nearfield/roll/roll-spot.ts:250`) | live, display-only |
| Mask → skyline `skylineFromSky` / `skylineFromSkyDP`, plus `refine/skyline-clean.ts` (`rejectSpikes`, `fuseSkylines`) | `src/lib/sky/skyline.ts`, `src/lib/refine/skyline-clean.ts`, `refine/index.ts:128` (`crossCheck`) | Scripts only: `scripts/eval.ts`, `sky-eval.ts`, `refine-eval.ts`, `geocam/skypar-eval.ts`. **No product caller passes `crossCheck`.** | research path |

Per-column confidence: the solver uses `weight` as a real weight, not just a threshold. `geo/solve.ts:172` keeps columns with weight above 0.05, the coarse score sums by weight (`:361-366`), and LM weights by √w (`:470`). In practice weights are mostly 0 or ≥ 0.1, because `minWeight` cuts everything below 0.1, so they act closer to a mask.

Timing (node, warm, M3 Pro under load from other sessions, 19 bundled photos, at 800 px unless noted; `scratchpad/sky/prof.mts`):

| Stage | Before | After this pass |
|---|---|---|
| `detectSkyline` total | 130.6 ms | **115.4 ms** |
| `detectSkyline` total at 640 px | 84.1 ms | 77.7 ms |
| `computeFeatures` | 46.1 ms | 35.8 ms |
| `fitSkyModel` (seed) | 22.2 ms | 22.2 ms |
| `modelSky` | 10.6 ms | 10.6 ms |
| `viterbi` | 9.1 ms | 9.1 ms |

The detector makes two fit + `modelSky` + Viterbi rounds. The Gipfelbuch figure of "about 120 ms" holds.

The sky worker's 67 ms is already closed: it is ORT's GPU work landing in the refine readback (`reports/negative-results.md:125`). This review confirms no CPU work hides there:
- the reply buffer is a fresh slice that is transferred, not copied;
- `skylineFromSky` and `toBytes` do not run in the GPU path.

The remaining levers are model-side (`modelLongSide` 384 instead of 512, an fp16 model that needs `shader-f16`) or page-side overlap.

## 2. Findings (ranked)

**P1**
1. **`segmentSky` can hang forever.** `sky/index.ts` settled pending requests only on a reply or on `worker.onerror`. A stuck ORT run, a GPU-process crash with no error event, or a `messageerror` left `segmentSky` unresolved, although its README says it "always resolves". The roll-spot `Promise.all` hung with it. Fixed this pass (unit W, below).
2. **The Gipfelbuch claim does not match the code.**
   - The node says "A learned sky mask is a second source, kept secondary". In product it is not a source for the solve at all: it is display-only. The cross-check (`crossCheck` → `fuseSkylines` + `rejectSpikes`) runs only in research scripts.
   - The node says "Narrow spikes are removed". In product that is `finishSkyline`'s run-length and trend filter (`geo/skyline.ts:626-674`). `rejectSpikes` never runs in product.
   - The page's module list also misses `src/lib/sky/index.ts`, where the mask lives. See §6.
3. **A non-device-loss inference failure degrades silently** (`sky.worker.ts:278-282`). A persistent ORT WebGPU failure sends every photo to the classical fallback, with no counter and no WASM retry. On the first device-loss photo the code also takes the classical fallback for that photo instead of retrying on WASM. Proposed as unit W2 for later. It touches the recovery state machine (`session-recovery.ts`).

**P2**

4. **Idle release missed ORT's own device.** The idle graph release freed graphs on `lastDevice` only. Refine graphs built on `model.ortDevice` (`sky.worker.ts:296-303`) were never freed. Fixed in unit W.
5. **The GPU prep guard verifies per device, not per shape** (`sky/prep.ts:172`). A shape first seen after the first 3 photos is never compared with the CPU chain. In addition, a transient verification error disables the prep for the worker's life (`prep.ts:175-184`).
   - **Proposed fix:** verify the first photo of each new shape, and count errors toward the error cap instead of disabling at once.
   - **Owner:** this file is in pod D's `gpu/**` neighbourhood but lives in `src/lib/sky`, so this step will take it later.
6. **Missing specs.**
   - **Covered this pass:** `finishSkyline` clean-up, `detectSkylineWith` / `detectSkylineAsync`, and the pending-request watchdog.
   - **Still open:** the page-side `send` / `needPixels` retry / `inflight` dedupe in `sky/index.ts`; the worker's `handle` flow (needs a `handle(deps)` extraction); and the pure `axisTable` / `lutTable` in `gpu/sky/refine.ts` (pod D area).
7. **Duplicated Viterbi.** The truncated-L1 distance transform and traceback in `geo/skyline.ts:viterbi` and `sky/skyline.ts:skylineFromSkyDP` are about 45 identical lines. They could be extracted into a shared module bit-identically. The two edge features differ in their constants (k = 3 vs 2), so leave those apart.
8. **The weight threshold is spelled three ways:**
   - `solve.ts:172` uses `> 0.05`;
   - `gpu/eye/samples.ts:28` uses `> 0`;
   - `skyline-clean.ts` uses `> 0.05`.

   This is a no-op today, because `detectSkyline` emits weights of 0 or ≥ 0.1. A shared `USABLE_WEIGHT` constant would document it.

**P3**

9. **`minWeight ≤ 0` would let NaN rows into `finishSkyline`'s trend medians.** No caller passes it. I removed a guard I had drafted, because no spec could show an effect: NaN in `sort` only disables the trend filter.
10. **README drift in `src/lib/sky/README.md`.**
    - The "Measured" table (refine 150–450 ms) is superseded by the GPU-refine section below it.
    - `ms.infer` / `ms.refine` in the GPU path are really "submit" and "GPU drain + refine".
    - Step 2 says "WebGPU when `navigator.gpu` exists", but `model.ts:92-125` also requires a hardware adapter.

    Doc-only, later.
11. **Manifest drift.** In `gpu/app-graph/manifest.ts:521`, the `sky-model` entry's `paths` omit `model.ts`, `session-recovery.ts` and `graph-idle.ts`, and `readbacks: []` ignores `inf.download()`. Proposed to pod D. This step did not edit the manifest.
12. **`gpu/skyline` allocates 8 storage buffers and a uniform buffer per call**, with no pool. The flag is off, so this is low priority and sits in pod D's area.
13. **The comment drift fixed this pass:** the sky model basis is quadratic in x and cubic in y, not "quadratic in x, y".

## 3. Research summary

Internal records. Do not redo these negatives without a new reason:
- **CPU ONNX sky mask + `solvePose`:** false accept on IMG_7053 at −5.61°. The full U²-Net (176 MB) is no better (`negative-results.md:16`, `leaderboard.md:57`).
- **Skyline as a global candidate generator or eye locator:** killed (`negative-results.md:39,46`).
- **X4 branch-and-bound skyline search:** killed (`:52`).
- **VSWEEP:** killed (`:21`).
- **SKYPAR skyline-parallax wrong-eye test:** killed 2026-10-02 (`:101`).
- **Joint whole-frame solve:** killed (`:86`).
- **The sky worker's 67 ms:** closed (`:125`).
- **Rejected sky models (non-commercial or too heavy):** SegFormer, MaskFormer, UperNet, Mask2Former, OneFormer and EoMT (`sky/README.md` model table).

External scan, 2023–2026 (web; licence reads come from model cards and need checking before any adoption):
- **No sky segmenter newer than U²-Net-P beats it** at under 30 M parameters with clean weights and training data. SkyWater-Seg (SegFormer-B2) carries the ADE20K and SegFormer non-commercial risk, so avoid it.
- **Skyline and horizon detection for mountain localisation has not moved since about 2021.** The lineage is Saurer, Baatz, GeoPose3K, CH1/CH2 and the Ghosh/Emami line. Nothing beats "sky mask or colour model plus a Viterbi pass on the topmost crossing", which is what Rigi does. `reports/terrain-matching-research.md:30` agrees.
- **Cloud, snow and haze at the ridge:** no small permissive model solves it. The routes are a DEM prior, depth, or a prompted edge refiner.
- **Commercial-safe candidates for later experiments:**
  - SAM 2.x tiny or MobileSAM as a ridge-band edge refiner (Apache-2.0). This is already in `terrain-matching-research.md:264,284`.
  - Depth Anything V2/V3 **Small** (Apache-2.0 on Small only; Base and above are non-commercial) as a sky-plus-depth cross-check against trees and chalets that the mask calls skyline.

Sources: [SkyWater-Seg](https://huggingface.co/Realcat/skywater_seg), [DA3](https://huggingface.co/depth-anything/DA3-BASE/blob/main/README.md), [DA2-Small ONNX](https://huggingface.co/inference4j/depth-anything-v2-small), [MobileSAM](https://arxiv.org/abs/2306.14289v2), [SAM 2 ONNX](https://huggingface.co/SharpAI/sam2-hiera-base-plus-onnx), [GeoPose3K](https://www.fit.vut.cz/research/publication-file/11463/geoPose3K_submission.pdf), [shallow-learning skyline extractor](https://arxiv.org/pdf/2107.10997), [SCANet cloud segmentation](https://arxiv.org/abs/2504.14178v1). Also `research_notes/segmenter-shortlist-2026-10-02/NOTE.md`.

## 4. Plan of units

| Unit | What | Size | Risk | Gate | When |
|---|---|---|---|---|---|
| **P** | Row-major `computeFeatures` loops (bit-identical); specs for clean-up, stage split, async flag; comment fix | S | none (fingerprint 38/38) | specs, fingerprint on 19 photos × 2 sizes, fast tier | **now (landed)** |
| **W** | `segmentSky` stall watchdog, `onmessageerror`, post-throw cleanup, prep-state reset on a new worker; idle release on ORT's own device; guarded `inf.release()` | S | low, browser-unverified | `pending.spec.ts`, sky specs, tsc, ledger row | **now (landed)** |
| W2 | Inference failure → drop the WebGPU session after 2 consecutive non-loss failures and retry the photo on WASM | S–M | medium (recovery state machine) | spec on `session-recovery`; browser batch | next |
| W3 | GPU prep guard per shape; transient error ≠ disable | S | low | `prep-gpu.spec.ts` | next |
| V | Extract the shared truncated-L1 DP from `viterbi` / `skylineFromSkyDP` | S | low if bit-identical | fingerprint + `sky-eval` rows unchanged | later |
| C | Multi-signal per-column confidence (Viterbi cost margin, refit stability, guided-filter delta), evaluated offline on dev only: does it predict DEM residual and the IMG_7053 false accept? Opt-in flag only if a pre-registered gate passes | M | research | frozen protocol first | later |
| D | README and manifest drift (§2 items 10 and 11) | XS | none | — | later (manifest → pod D) |

Needs the user:
- Any new model in a product path, such as an ONNX export of MobileSAM or SAM 2 tiny, or Depth Anything Small, plus a download into `public/models`. Disk is also at 98 %.
- Whether the learned mask should ever feed the solve again. It is off since the IMG_7053 false accept. A new attempt would need a pre-registered gate on the dev split.

## 5. Landed

| sha | Unit | Notes |
|---|---|---|
| 26f1480 | P | Bit-identical on 19 photos at 640 and 800 px; 800 px median 130.6 → 115.4 ms |
| bda693e | W | browser-unverified; one adversarial review round fixed: a stale `wk` after a drop, late events from a replaced worker, unknown-id replies counting as progress, cold allowance 120 → 180 s, suspended-page re-arm |

Batch-ledger row for bda693e. `reports/batch-ledger.md` held a peer's uncommitted edit at landing time, so the row lives here until the coordinator copies it:

| step skyline (mt-image-17 pod) | bda693e | sky/index.ts: segmentSky stall watchdog (sky/pending.ts: no worker reply for 180 s cold / 60 s warm while requests pend → drop the worker like onerror; all pending fall back inline), onmessageerror, late events from a replaced worker ignored, a post that throws or targets a replaced worker rejects and closes its bitmap, prep verification state reset on a new worker; sky.worker.ts: idle release also frees refine graphs on ORT's own device, inf.release() in finally guarded | `/photo/demo-09?renderer=webgpu&style=<a look that uses the sky mask>` and `?renderer=deck`: sky mask arrives as before (console `[sky]` lines unchanged, no "worker error"); `/roll` with a few photos: roll-spot finishes; idle 30 s then a new photo: still segments; `?gpu=off`: CPU path unchanged | low (no change on the success path; a worker that is merely slow beyond 180 s on first load now falls back to the classical mask) |

Negative this pass: the `minWeight ≤ 0` NaN guard (§2 item 9). It has no observable effect, so it was dropped rather than shipped untested.

## 6. Gipfelbuch corrections (graph.ts is not edited by this pod)

Proposed `summary` for node `skyline`:

> A fitted sky-colour model and a best-path trace find the skyline column by column, with a weight per column that the pose solve uses (about 120 ms at 800 px). Short runs and spikes that stick up above the local trend lose their weight. A learned sky mask (U²-Net-P, in a worker on the GPU) drives the looks; it stays out of the solve after it caused a false accept.

Proposed `modules`: keep the three, and add `src/lib/sky/index.ts`, where the mask's entry point is. Note in the page that `refine/skyline-clean.ts` and `sky/skyline.ts` are the research cross-check path, run by `scripts/refine-eval.ts` and `scripts/sky-eval.ts`.

Proposed `reports`: add `src/lib/sky/README.md` (model choice, licence, measurements) next to `leaderboard.md` and `negative-results.md`.
