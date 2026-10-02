# Render bundles on luma 10 (wave 5, B2 spike)

Status: helper and Dawn test landed, NOT wired. Everything here is browser-unverified; the
only GPU evidence is node over Dawn (`webgpu@0.3.0`).

Files: `src/lib/deck-webgpu/render-bundle.ts` (helper), `scripts/gpu/render-bundle-dawn.ts`
(test: `DAWN_DIR=... npx tsx scripts/gpu/render-bundle-dawn.ts`, exit 2 without Dawn).

## What works in luma (@luma.gl/core 10.0.0-alpha.2-rigi.3)

- `device.createRenderBundleEncoder(props)` returns a `RenderBundleEncoder extends RenderPass`;
  `encoder.finish()` returns a `RenderBundle`; `renderPass.executeBundles([bundle])` replays it.
- A luma `Model.draw(encoder)` records into the encoder unchanged: it sets the pipeline, bind
  groups (via the shared bind-group factory), vertex/index buffers and the (indexed, instanced or
  indirect) draw. Pixels are bit-identical to drawing the same Model directly into the pass (test
  "direct-vs-bundle", 1x and 4x).
- `Model._syncAttachmentFormats` reads the encoder's `colorAttachmentFormats` /
  `depthStencilAttachmentFormat`, so a Model drawn into an encoder gets the same pipeline variant
  as in a pass with that signature; no extra work.
- `drawIndirect` / `drawIndexedIndirect` are implemented on the encoder, so the GPU-culled terrain
  path (`batched-terrain.ts drawCulled`) can be recorded.

## Traps found

1. **sampleCount is 1 only in luma.** `validateRenderBundleEncoderProps` throws
   `RenderBundleEncoder currently only supports sampleCount 1`. The colour pass is 4x MSAA, which is
   where the draw cost is. Workaround in the helper: for sampleCount > 1 create the native
   `GPURenderBundleEncoder` (sampleCount 4) ourselves and pass it as `props.handle` (the WebGPU
   encoder honours a supplied handle), leaving luma's own sampleCount at 1. The Model's pipeline
   multisample count comes from `parameters.sampleCount`, as in `passModelProps`. Test "msaa4x"
   passes with exact pixels (MSAA target + resolve). It leans on luma internals, so it needs a
   re-check on every luma bump; the upstream fix is one line (drop the validation, pass
   `sampleCount` in `getRenderBundleEncoderDescriptor`, which already forwards it).
2. **A bundle only executes in a pass with the identical attachment signature**: colour formats,
   depth format, sample count, depth/stencil read-only. Colour pass MSAA 4x and the interactive 1x
   drag mode (`ColorTargets.setReduced`) are two signatures, and also two Models per key
   (`ModelCache`, `setColorSamples`). Keep two bundles: `RenderBundleSet` keys variants by signature.
3. **Bind groups are baked.** Identity changes of any bound texture/view/buffer need a re-record:
   atlas growth into a new texture (`texture-array-atlas`), relief field swap, imagery array swap,
   uniform buffer reallocation. Test "stale-keys-trap" asserts the failure mode: swapping a bound
   buffer WITHOUT changing the keys silently replays the old buffer. The keys are the caller's
   contract; `modelBundleKeys(model)` supplies model + pipeline + vertexArray + all bindings.
4. **Buffer contents are not baked** (the uniform-write rule): `Buffer.write`/`queue.writeBuffer`
   before the submit that executes the bundle is seen by it (test "uniform-rule": same bundle,
   records stays 1, output equals a direct draw with the new value). Instance buffers, the
   indirect args buffer and compute-written storage are therefore fine as long as their identity
   and size are stable; a buffer that is destroyed and recreated (grow) is a key change.
5. **`Model.draw` pushes shaderInputs only at record time.** `draw()` calls `updateShaderInputs()`
   inside, which is skipped when we just `executeBundles`. Per-frame uniforms driven through
   `model.shaderInputs.setProps` must be flushed explicitly each frame with
   `model.updateShaderInputs()` (writes immediately on WebGPU when given no encoder) before the
   pass. NOT covered by the test (it writes raw buffers); verify when wiring. Also
   `updateShaderInputs` re-`setBindings` the module bindings; textures coming through shader inputs
   are covered by the keys only if they appear in `model.bindings`.
6. **Draws that return false** (pipeline compiling, bindings loading) would be baked as missing.
   The helper does not cache an incomplete recording (`DrawBundle.stats.incomplete`; test
   "incomplete") and returns null so the caller draws directly that frame.
7. **No pass state in a bundle.** `setParameters` (viewport, scissor, blend constant, stencil
   reference) throws on the encoder; set those on the pass outside. Per the WebGPU spec
   `executeBundles` resets pipeline/bind groups/vertex+index buffers afterwards (luma's pass wrapper
   notes this), but not viewport/scissor. Layers drawn after a bundle must set their own pipeline;
   luma Models always do.
8. Bundles cannot call `executeBundles`, occlusion queries or timestamp writes; GPU pass
   timestamps (`passTimestamps`) stay on the pass, which is unaffected.
9. The reversed-Z depth/compare state lives in the pipeline, so bundles inherit it; nothing to do.

## Expected gains (NOT measured)

Bundles remove CPU encode cost only (JS validation, bind-group lookup, pipeline/vertex-buffer
rebinding per draw); GPU time is the same. `batched-terrain` already reports `stats.cpuMs` per
kind. The candidates, in order of value:

- GPU-culled terrain in the colour pass: `drawCulled` issues `d.slots` `drawIndexedIndirect`s,
  each with its own instance buffer, from stable buffers (args/inst/index) whose contents the cull
  prepass rewrites every frame. After the first frame, a replay is one `executeBundles` with
  zero Model work. Largest win, and the cleanest case: identities are stable between frames.
- Geometry pass terrain (1x, same structure), same recording.
- Static decoration layers (ridges, trails, drapes) when their buffers do not change.
- CPU-culled terrain path: instance buffers change with the visible set, so mostly not cacheable
  (re-record on a tile-set change) unless the buffer identity and draw args are stable.

Per-frame JS frame time during pan/zoom is the target (the "drag" budget). Expect single-digit
percent of frame CPU on desktop, more on mobile/low-end CPUs and in drag mode with many draws; do
not claim it before the batch measurement.

## Wiring plan (for a later wave; nothing is touched now)

1. Flag `bundles` (off by default; `src/lib/flags`, byte-identical off). Only the colour and
   geometry terrain draws first.
2. In `BatchedTerrainCore`, own one `RenderBundleSet` per kind. The record callback is
   `recordModels(encoder, [model])` with the Model state set up exactly as `draw()` does today
   (bindings, index buffer, index count, instance buffer, indirect args). `drawCulled` becomes: set
   per-slot attributes + indirect offset, `model.draw(encoder)`, in a loop inside the record
   callback.
3. Each frame in `draw(ctx)`: do the cheap per-frame state (shaderInputs, `model.updateShaderInputs()`,
   culled-draw bookkeeping), compute the key list = `[...modelBundleKeys(model), d.args, d.index,
   d.indexCount, d.slots, ...d.inst, atlas/relief/imagery identities, plugin binding identities]`,
   then `bundleSet.execute(ctx.renderPass, target, keys)`; fall back to the direct draw when it
   returns false.
4. Variant target = `{ colorFormats: PASS_ATTACHMENTS.color.colorAttachmentFormats, depthFormat:
   REVERSED_Z.format, sampleCount: color.samples }` for the colour pass; geometry uses its two
   formats and sample count 1. `runColorPass` already knows `samples`; pass it through `PassTarget`.
5. Invalidate with `bundleSet.invalidateAll()` on device loss, `ModelCache` invalidation
   (`modelEpoch` bump), look/style changes that rebuild the pipeline, and engine resize (target
   formats unchanged, but be safe). Destroy with the layer core.
6. Verify in the batch pass: pixel-identical colour/geometry targets with the flag on vs off across
   photos (`deck-smoke`, `style-baseline`), 4x and drag 1x, a tile-load that grows the atlas
   mid-session, and a style switch. Measure `cpuMs` and total frame CPU on and off, with
   `RENDER_LOCK_EXCLUSIVE=1`. Re-check the trap-1 workaround against the vendored luma.
7. Kill criterion: if the replay shows no measurable CPU gain over the existing GPU-culled path
   (already a handful of indirect draws per pass), drop the wiring and keep the helper unused.

## Evidence

Dawn test results (this session, node over Dawn, webgpu@0.3.0): direct-vs-bundle, uniform-rule,
stale-keys-trap and invalidation pass at 1x and 4x with 0 differing bytes; the variants and
incomplete checks pass. Not run: any browser, any timing.

## Wired (B2w, browser-unverified)

Flag `renderBundles` (onOff, default off). `BatchedTerrainCore.drawCulledBundled` replays the GPU-culled
draws (geometry 1x and colour 4x / interactive 1x as two variants of one `RenderBundleSet` per kind).
The CPU-cull path is not bundled (instance buffers change with the visible set; counted as `direct`).
Keys: model, pipeline, vertexArray, every model binding (incl. the managed uniform buffers, heights,
base grid, tile table, imagery, plugin textures), cull index/args/inst buffers, indexCount, slots and
target size. `model.updateShaderInputs()` runs every frame before executing (Dawn cases
"shader-inputs flush/unflushed/reflush"). Diagnostics: `terrain.stats.bundles.{geometry,color}`
= `{hits, records, incomplete, direct, last}` (visible in engine diagnostics). Batch pass: expect
`records` to stay flat while panning, jump on tile/atlas growth, style change, resize, 1x/4x switch.
With the flag off the code path is the previous one (`drawCulled` now shares `encodeCulled`).
