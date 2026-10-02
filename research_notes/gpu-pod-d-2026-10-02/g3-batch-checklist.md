<!-- Rigi -->
<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: Copyright (c) Rigi contributors -->

# G3 batch-pass checklist: `?renderBundles=on` and `?colorTarget=rg11b10`

Date 2026-10-02. Review is read-only plus a guard; nothing here ran in a browser. Dawn-in-node is the only GPU evidence (`render-bundle-dawn`, `color-target-dawn`, and a one-off check of the sky blend below). Run in one consolidated pass through `node scripts/gpu/with-render-lock.mjs -- <cmd>`.

## What the review found

### rg11b10ufloat is broken in every view today (guard landed)
rg11b10ufloat has no alpha: reads return alpha 1 and writes drop it. Consumers of the colour target's alpha:

| consumer | what it needs | with rg11b10 |
|---|---|---|
| `layers/composite.ts` (photo view overlay, `layerTex: ctx.color.color`) | alpha = coverage, mix photo under premultiplied colour | alpha always 1: overlay opaque, photo hidden |
| `layers/atm-sky.ts skyParameters` (world view sky, blended UNDER) | dst alpha of the target (`one-minus-dst-alpha`) | factor 0: sky never drawn. Dawn: rgba16float gives the sky colour, rg11b10ufloat gives 0 |
| `engine.ts readLayer` / compute-bridge stats (`bandInputs` divides by alpha) | alpha as sky/no-surface mask | mask lost, sky counted as terrain |
| `engine.ts poseViewRgba` (matcher pose view, sky colour #b9cde0 where alpha 0) | alpha 0 over sky | sky rendered black |
| `present.ts` | none (outputs alpha 1 over black) | fine |
| Offscreen readback | decode | `rg11b10ToRgbaFloat` (alpha forced 1), fine on its own |

The old comment in `targets.ts` ("correct for the world view with sky") was wrong: the sky itself needs dst alpha. The format is chosen once per device and pipelines bake it, so a per-view choice would mean rebuilding every colour pipeline on a view switch. Smallest correct guard: `?colorTarget=rg11b10` is downgraded to rgba16float with a console warning (`resolveColorTargetFormat`, spec in `deck-webgpu/__tests__/targets.spec.ts`); `?colorTarget=rg11b10-unsafe` honours it for experiments. The default is unchanged.

### renderBundles invalidation: looks correct
Traced against `render-bundle.ts` and `layers/batched-terrain.ts drawCulledBundled`:

| event | why the bundle re-records |
|---|---|
| height array / imagery atlas grow or compaction (new `Texture`) | `modelBundleKeys` lists `model.bindings` by identity; draw() re-reads `store.small/big.texture` and `imagery.texture/textureSmall` each frame |
| ImageryArray texture change | same (`imagery.texture` getter) |
| 4x vs 1x (`setColorSamples`, `setReduced`) | different RenderBundleSet variant (`s4` vs `s1` in the target key) and a different Model in ModelCache (`model` and `pipeline` keys) |
| colour format | in the target key and baked in the pipeline; global per device so it never changes mid-session |
| model / pipeline epoch (`modelEpoch`, ModelCache invalidate) | `model`, `model.pipeline`, `model.vertexArray` keys |
| uniform buffer replacement | managed uniform buffers live in `model.bindings` |
| cull buffers (`d.index/args/inst[s]`, counts, slots) | in keys |
| device loss | the engine is rebuilt; `destroy()` destroys the sets |

Not baked and correctly not keyed: uniform/storage/vertex CONTENTS (queue writes before submit), indirect args content (written by the cull compute).

Findings (not bugs):
- `keys` includes `ctx.target.width/height`, which a bundle does not bake. The on-screen pass and a differently sized offscreen colour pass (stats render, pose view, export) share one variant and force a re-record whenever they alternate. Perf only; proposal in `scratchpad/podD-proposals/g3-bundles.md` (layers/** is off-limits).
- `modelBundleKeys` is read before recording and `Model.draw` may swap the pipeline during the first record: costs one extra re-record, then stable.
- Uniforms are flushed with immediate `queue.writeBuffer`, same as the direct path, so two passes in one submit that reuse a Model see the last value in both. Identical hazard direct vs bundled, not new.
- CPU-culled frames never use bundles (`bundles.<kind>.direct` counts them). The bundle only helps the GPU-cull path.
- WebGL engine (`src/lib/deck`): no reference to `renderBundles` or `colorTarget` (grep). `?renderer=deck` ignores both. The panel lists both flags; they are inert there.

## Pass setup
Photo ids: use dev photos from `public/photos/photos.json` (`<id>` below), plus the Niederhorn demo set. Always pin the renderer. Record `chrome://gpu`/adapter and the date; use `RENDER_LOCK_EXCLUSIVE=1` on the timing steps only.

Variants (A is the reference):

| id | URL |
|---|---|
| A | `/photo/<id>?renderer=webgpu` |
| B | `/photo/<id>?renderer=webgpu&renderBundles=on` |
| C | `/photo/<id>?renderer=webgpu&colorTarget=rg11b10` (expect the downgrade warning; must equal A) |
| D | `/photo/<id>?renderer=webgpu&colorTarget=rg11b10-unsafe` (experiment) |
| E | `/photo/<id>?renderer=webgpu&renderBundles=on&colorTarget=rg11b10-unsafe` |
| F, G | `/photo/<id>?renderer=deck` and `/photo/<id>?renderer=deck&renderBundles=on&colorTarget=rg11b10` (both must equal F; no console errors) |

## renderBundles checks (B vs A)
1. Pixels: `scripts/style-baseline.mjs` / `deck-smoke` run on the deck route only, so use the WebGPU harness: `node scripts/eval-app.mjs --renderer webgpu` once per variant and diff the 8-bit screenshots. Keep: byte-identical, or max channel delta <= 1 on <0.01% of pixels (bundle replay is deterministic against the direct path; `render-bundle-dawn` shows equal output in node). Any structural diff (missing tiles, stale heights) is a revert.
2. Counters: `metrics().terrain.bundles.color` and `.geometry` (`records`, `hits`, `incomplete`, `direct`, `last`). After a settled frame: `hits` rises per frame, `records` flat, `incomplete` 0. `direct` counts only CPU-cull frames.
3. Timing: add `&gpuFrameTimings=on` to A and B (needs timestamp-query; the engine warns once if missing). Compare median CPU frame time (`stats.cpuMs.color`) and GPU pass time over 300 frames of an orbit. Keep as default only if CPU time drops >= 15% on the median with GPU time not worse by >3%, on at least two different adapters. A GPU-time regression above 5% is a revert.
4. Interactive 1x to 4x: drag the photo/world camera (reduced mode, 1x) and release (4x settle), 20 cycles. `records` must grow by at most 2 per variant in total (one per 1x and 4x variant), no flicker on the settle frame, no validation errors (attachment sample count mismatch would show as a Dawn/Chrome error in the console).
5. Pan with atlas growth/compaction: start at a low zoom, pan across new terrain until `metrics().imagery`/height pool `grows` and (on idle) `compactions` increment under bundles. Each grow must show `records` +1 on the next frame and the tiles must keep the right heights and drape (no stale layer index, no black/old tiles). Repeat on a 256-layer core-limits device mode (imagery overflow/eviction landed in 5dbe0b7, so look for `evictions` too).
6. Matcher / offscreen: run a matcher pose view (`renderOffscreen`, 256 px stats render) while the on-screen view is bundled. Check `records` does not climb every frame (the width/height key thrash, see Findings); if it does, apply proposal 1.
7. Device loss: `device.destroy()` from the console (or the engine's loss hook) with the flag on, confirm the engine recovers or falls back with no uncaught error.
8. VRAM: `node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/vram-attribution.mjs` for A and B. Bundles must not add more than a few KB.

Flip default `renderBundles` to `on` only when 1 to 5 and 7 pass on two adapters and 3 meets the threshold. Otherwise leave off (it is cheap to keep: opt-in, GPU-cull path only). Revert (delete the wiring) if 1, 4 or 5 fail and the cause is not a one-line key.

## colorTarget checks
The default flip is not planned: with the review above, rg11b10 needs the sky drawn without dst alpha and the photo overlay to stop reading alpha. Do the pass only to decide whether that work is worth it.
1. C equals A pixelwise and the console shows the "ignored: rg11b10ufloat has no alpha" warning once.
2. D, photo view: expect the overlay opaque (photo hidden) as predicted. Screenshot for the record; this confirms the guard is warranted.
3. D, world view (switch to the world view in the UI, flat and atmosphere sky): expect black sky. Screenshot.
4. D, matcher pose view and stats render: expect no sky mask (all alpha 1).
5. VRAM A vs D at 1920x1080 and a 2 DPR canvas: `colorPassBytes` predicts 8 B/px x 5 for rgba16float vs 4 B/px x 5 (41.5 MB vs 20.7 MB at 2.07 MP, 1x DPR; 166 vs 83 MB at 2 DPR). Compare with `vram-attribution.mjs`.
6. E (both flags): no validation errors (rg11b10 format with 4x MSAA and bundle target key).
7. Compile gate: `DAWN_DIR=/tmp/dawn npx tsx scripts/gpu/wgsl-compile-all.ts` (the rg11b10 variants now use `rg11b10-unsafe`) and `node scripts/ci/run.mjs fast --only color-target-dawn,render-bundle-dawn`.

Keep/revert for the flag: keep rg11b10-unsafe as an experiment while no decision is made. If the VRAM saving at the target resolution is below ~40 MB on typical sessions, or the fix needs a second code path in atm-sky/composite/poseView, retire the format (remove the flag value, `OPTIONAL_FEATURES` entry and the readback decode). Never make it the default while any view reads alpha.
