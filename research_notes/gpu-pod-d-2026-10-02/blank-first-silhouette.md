<!-- Rigi -->
<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: Copyright (c) Rigi contributors -->

# Blank first silhouette draw: diagnosis (2026-10-02, Pod D `sil-blank`)

Roadmap G1 open item. From code only, no browser. "CONFIRMED" = read in the vendored source or repo code; "HYPOTHESIS" = needs the browser batch.

## Symptom (from the wave-3/4 passes)

On a fresh page the first autoAlign's top finalist scored sil 0 and every later call its real score (deck, wc_0005 0 vs 0.3315, wc_0009 0 vs 0.1973; horizon and terrain hashes equal). Workaround 86e2faa: `redrawIfBlank` (`src/lib/deck/silhouette-mask.ts:124`) redraws a blank finalist once; `silTiming.redraws` > 0 on 2 of 3314 timings. The observation was on the deck (WebGL) engine only; no webgpu instance of it is on record.

## Root cause on WebGL (deck): CONFIRMED mechanism, HYPOTHESIS that it is the only trigger

1. `drawLayersOffscreen` (`src/lib/deck/offscreen-layers.ts` ~line 95-125, `drawLayer` at the end) clears the target in `beginRenderPass`, then calls `layer.draw()`; it ignores whether any model drew. `TerrainPassRenderer.render` (`src/lib/deck/geometry-pass.ts:78`) and `GpuGeometrySource.drawPass/render` (`:~690`) do not look either, then `finish` reads the (cleared) target. So a skipped draw reads back as a legitimate all-sky range.
2. luma `Model.draw` (`node_modules/@luma.gl/engine/dist/model/model.js:417`) returns false, silently, when `_drawBlockedReason` is set, a binding `isReady` is false, or the pipeline errored; its callers here ignore the return value.
3. On WebGL, `WEBGLRenderPass.draw` (`node_modules/@luma.gl/webgl/dist/adapter/resources/webgl-render-pass.js:165`) returns false with only a `log.info(2)` when `pipeline.linkStatus !== 'success'`. `WEBGLSharedRenderPipeline` (`webgl-shared-render-pipeline.js:13,33-50`) starts `linkStatus = 'pending'` and, when the device has `compilation-status-async-webgl` (KHR_parallel_shader_compile), only becomes `success` after `_waitForLinkComplete`. So a draw issued before the link completes is dropped and the cleared target is read back.
4. The repo already knows this: `pendingPrograms` (`src/lib/deck/device-lost.ts:117`) docs "a draw with a pending program is silently skipped", and `settleAfterRestore` (`src/lib/deck/engine.ts:~820`) waits for links and re-reads, but only after a context restore. First use on a fresh page has the same exposure and no such guard.
5. Why it is rare (2 of 3314) and "first": programs are created when a layer first draws in a pass variant (the geometry pass changes shader/formats, so a pipeline variant is created on its first draw: `_syncAttachmentFormats` -> `_updatePipeline`); by the time autoAlign's seed search has run (seconds) the link has normally finished. The first re-rank on a fresh page that gets there sooner draws into a pending program. After an idle release (SIL_IDLE_MS, `engine.ts` `releaseSilhouetteSourcesWhenIdle`) only the 384 px targets are disposed; the shared programs stay cached while the layers' Models live, so idle release alone should not re-trigger it (HYPOTHESIS: not verified).
6. `redrawIfBlank` as landed redraws immediately. If the link is still pending at that moment the redraw is blank too and the finalist scores 0. That is a gap in the workaround (CONFIRMED from code; whether it happened is unmeasured).

## Does the first geometry-buffer refresh share the cause? Yes on WebGL (CONFIRMED mechanism)

`refreshGeometry` (`src/lib/deck/engine.ts:~2028`) calls the same `GpuGeometrySource.render` and then `geoBufGen = gen; fitHaze(); updateLook(); ...` with whatever came back. A blank first buffer therefore feeds the haze fit, labels, relief and the drape range. `settleAfterRestore`'s comment describes exactly this ("both the geometry buffer (generation semantics) and the compositor ... would keep that empty result"). Not measured on a fresh page.

## WebGPU: NOT shown, ranked hypotheses

- luma WebGPU creates pipelines synchronously at draw (`Model._updatePipeline`, `createRenderPipeline`); WebGPU queues work against a pending pipeline instead of dropping the draw, so the link-pending mechanism does not apply. `engine.ts:1200` notes layer models cannot use `beginAsyncCompilation`.
- Remaining candidates: `Model.draw` false from `_areBindingsLoading` (a texture binding with `isReady` false, e.g. height/imagery textures not yet uploaded) in `layers/batched-terrain.ts:1046` (return value ignored; only the bundled path at `:1087` tracks completeness); tiles not streamed in yet (an honest all-sky read, not a skipped draw). `layers/**` is off limits to this unit, so any fix there is a proposal, not landed.

Ranking: (1) WebGL program still linking, confirmed mechanism. (2) WebGPU binding not ready (speculative, no observation). (3) a real all-sky finalist: ruled out for finalists (skyline matches) but possible at the first refresh before terrain tiles arrive.

## Change landed (WebGL only, guarded, browser-unverified)

- `waitForPrograms(device, maxMs=5000)` in `src/lib/deck/device-lost.ts` (polls `pendingPrograms`; resolves at once when none).
- `redrawIfBlank(src, pose, beforeRedraw?)` awaits `beforeRedraw` between the blank read and the redraw. The deck engine passes `settlePrograms` at both re-rank call sites (CPU path and GPU-mask fallback path).
- `refreshGeometry` (deck) calls `redrawIfBlank` after its render, so a blank first geometry buffer is drawn again after the link. A real all-sky pose costs one extra render.
- The WebGPU engine is unchanged (no pending-link concept there, and its layers are off limits).
- Specs: `src/lib/deck/__tests__/blank-first-draw.spec.ts`.

## What the browser batch needs to confirm

1. Fresh page, `/photo/wc_0005?renderer=deck`, then `?renderer=webgpu`; autoAlign 3x; compare the first call's `silhouette` sils with calls 2-3; `silTiming.redraws` should be 0 on webgpu and should now be 0 or never followed by a 0 score on deck. Repeat on wc_0009.
2. Direct evidence for the cause: with `localStorage.debug`/luma `log.level = 2`, look for "draw() aborted - waiting for shader linking" in the console on the first geometry pass of a fresh deck page; or log `pendingPrograms(device)` right before the first `GpuGeometrySource.render`. Absent => hypothesis 1 is wrong for this trigger.
3. Count `redrawIfBlank` returning true in `refreshGeometry` on fresh loads (add a temporary counter); non-zero confirms the shared first-refresh cause.
4. Idle release: autoAlign, wait 3 s, autoAlign again; `redraws` should stay 0 (tests the "shared programs survive release" hypothesis).
5. WebGPU: wrap `Model.draw` in `batched-terrain.ts` to log false returns during the first geometry pass. If any occur, write the fix in the layer (proposal; owner session 07).
