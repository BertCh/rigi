# Vendored luma.gl (`10.0.0-alpha.2-rigi.6`)

The app needs luma.gl fixes that are not in a published alpha yet (`WebGPUAdapter.attach()`, the
device lifecycle fixes, the engine pipeline variant cache, indirect draws and a compute pipeline
cache fix, compat-mode adapter limits, a few small compute-API additions, WebGL multisample resolve,
read-into-target and readback usage hints, the FFT fixes) and the unpublished splat stack
(`@luma.gl/splats`, progressive RAD selection, #3340). The published `10.0.0-alpha.2` manifests are also
broken for npm (yarn `patch:` protocol on `@math.gl/core`, `~9.4.0-alpha.1` peer ranges). So nine
`@luma.gl/*` packages are installed from these tarballs (`package.json`: `file:vendor/luma/<name>.tgz`):
core, effects, engine, gpgpu, shadertools, webgl, webgpu, and since rigi.6 `splats` (Step Inside's
WebGPU splat renderer, `src/lib/deck-webgpu/layers/splats-luma.ts`) and `experimental` (only because
`@luma.gl/splats` imports `@luma.gl/experimental/gpu-tables`; the app imports nothing from it).

The version is `10.0.0-alpha.2-rigi.6`, so npm reinstalls over a cached `10.0.0-alpha.2` and
`^10.0.0-alpha.2` ranges (deck's) still match. Bump the `rigi.N` suffix on every rebuild.
(Re-packing a tarball under the same name also needs its `integrity` in `package-lock.json` updated,
or npm keeps the cached copy.)

**Swap to npm when luma publishes these fixes** (all of #3313, #3302, #3287, #3328, #3333, #3334,
#3330, #3345, #3340, #3338, #3332, #3326, #3331, #3286, #3288, #3351, #3346, #3132, #3337 and the
PipelineFactory compute-hash fix; #3312, #3335 and #3348 are already in luma master; the nine local
`rigi/compute-api` commits below would be lost and their app users need a replacement):
point the nine deps at the published version, delete this directory and re-run `npm install`. If
the published manifests still carry `patch:` deps or `~9.4` peers, the old workaround (`.npmrc`
`legacy-peer-deps=true` plus `overrides` for every `@luma.gl/*` and `@math.gl/core`) comes back.
`@luma.gl/splats` and `@luma.gl/experimental` are `private` upstream (never published so far).

## Source

- Repo: https://github.com/visgl/luma.gl
- **rigi.6** (2026-10-02). Build commit: `bdbc371f8fa92a2580f6b4337a34c744ac63a437` (branch
  `arch/rigi-vendor-6`, an unofficial build; bundle `~/mt-image-archive/2026-10-02-rigi6/luma-rigi-vendor-6.bundle`).
  It is the rigi.5 build commit `a6af71e5` (below) plus, in this order (first-parent):
  - `1b7f466a9`: merge of #3313's moved head `44d990fd329e63be97da336aae879042d4da6906` (one new test-only
    commit over `3826c414`, "avoid async error scopes in canvas teardown regression"). Clean;
  - `bd82e8c98`: #3345 was squash-rebased upstream onto master as `1c70b5e9d5e2de2a81410ac88978702920320488`;
    rigi.6 applies the delta between the merged old head `4cbc25d4` and the new head to `device.ts`,
    `webgpu-adapter.ts` and the two adapter specs (patch `luma-3345-head-delta-bd82e8c9.patch`).
    **Behaviour change:** `featureLevel: 'compatibility'` requests the default limits again; `'best-available'`
    requests the adapter's limits only when it cannot upgrade to core. Rigi uses `'core'` everywhere;
  - `5295eed49`: merge of #3340 head `8104ac7635b0d82c5e3cd785d45fb9686a2360ac` (progressive RAD selection
    and shared-pass rendering in `modules/splats`). Clean. Revertible: `patches/luma-3340.patch`;
  - `f36acbfb1`: #3338 head `78c018a52f21b352e51482dd030ae606bebc566a` (GPU table binders skip empty batches,
    `VertexArray.setBuffer(…, byteOffset)`, `Model.setAttributes(buffers, {byteOffsets})`). One conflict,
    `docs/whats-new.md` (not shipped): both sides kept;
  - `c43cf6f0a` #3332 `a9f2c02f14a6038bf7eae04e5f48bb4d1f3a56c7` (reject unaligned GPU table storage
    offsets), `c888c1fc2` #3326 `06468290e68a1e5cbbfe1e03ff527f8dc3a27c5b` (fused GPUDataFrame filters),
    `31bb61afc` #3331 `c759b7a095eee5d665e30292dba567d9380ac1f9` (GPUData buffer references across split
    batch groups), `2e8d82c47` #3286 `335b3398e8cb5abda2f71205cc304fb2b8edb9dd` (validate shader hook
    injection targets): clean;
  - `cbee8625a`: #3288 head `3051228eb81811c2fd511f74183fd5d5d03d4efe` (default shader assemblers resolved
    lazily, the deck shim removed). One conflict in `modules/engine/test/lib/model.node.spec.ts` (not
    shipped): union of the imports, both new tests kept;
  - `2a103db67` #3351 `663cfa58c53c14f132f3fbc0cc8216db4039833a` (`withGLParameters` restores state when
    the callback throws, by default), `36c249110` #3346 `680dc60271ed43300997934979ec98497c59d4b6` (WebGL
    texture uploads always set `UNPACK_FLIP_Y_WEBGL` / `UNPACK_PREMULTIPLY_ALPHA_WEBGL` explicitly),
    `8eb03c8f6` #3132 `abfe5c44018a87b38ee331208f621ec43f4c58a5` (segmented `GPUDataEvaluator`),
    `c8399922f` #3337 `c6f9bc88441e6f409fb1031697c9c3e4b8496299` (arrow record-batch packing; its gpgpu part
    ships): clean;
  - two more local commits on `rigi/compute-api` (patches in `patches/`), not upstream, not proposed upstream:
    8. `007951ae8` `GPU_FFT1D_MAX_LENGTH` = 65 536 (was the shared 2048; `GPUFFT2D` / `GPUConvolution` keep
       2048 through `GPU_FFT_MAX_LENGTH`). The passes are global-memory radix-2 (no workgroup storage), so
       only the shared constant bounded the length; the chunked path's block scratch, capped at 4096 complex
       rows, now holds `max(4096, length)` rows within the binding / buffer limits (it would otherwise hold
       zero transforms of 8192). `getGPUFFTLengthReason(…, maxLength?)`. Node spec
       `gpgpu/test/gpu-core/gpu-fft1d.node.spec.ts`. Patch `luma-fft1d-65536-007951ae.patch`. For Rigi
       coordinator E (long horizon / refine transforms);
    9. `bdbc371f8` loop-free FFT bit reversal: `reverseLowBits` is `reverseBits(value) >> (32u - bitCount)`
       instead of a data-dependent loop, which returned wrong indices on this Mac (Apple / Metal) for lengths
       16 … 2048, so every GPUFFT1D / GPUFFT2D / GPUConvolution result there was silently wrong (found by
       coordinator E, `patches/E/fftprobe.evidence.ts` in that wave's scratchpad). Node spec
       `gpgpu/test/gpu-core/gpu-fft-utils.node.spec.ts` (source shape + CPU twin over 1–16 bits). Patch
       `luma-fft-bitreverse-bdbc371f.patch`.
  Dropped after a trial merge: #3147 (merged clean, reverted: a URL `?debug` turns on luma debug for every
  device and debug device-creation failures `alert()`; Rigi reads URL flags only in `src/lib/flags`) and
  #3140 (stale 2026-09-08 base: it would revert master's `getWebGPUAdapterInfo` guard and the
  `typeof navigator` check, and flips the default `powerPreference`). Not taken: #3169 (deck GPUVector
  layer family, `deck-gpu-layers` is not vendored), #3168 / #3141 / #2716 / #2638 / #3084 (old or draft,
  arrow / docs), #3349 / #3317 (examples, docs). Vendored PR heads re-checked with `gh` on 2026-10-02;
  none is merged.
  Evidence (node): luma `vitest --project node` over core, engine, shadertools, gpgpu, webgl, webgpu,
  splats, test-utils and experimental/gpu-tables: 208 files, 1734 tests passed, 9 skipped (before the
  bit-reversal commit; its spec and the FFT specs pass after it). Dawn in node (webgpu@0.3.0, this Mac):
  `GPUFFT1D` forward vs a float64 CPU FFT, relative error 1.9e-7 / 4.5e-7 / 3.3e-7 at 2048 / 8192 / 65 536
  (batch 2), inverse round trip ≤ 1.3e-6; before commit 9 the same harness gave relative error ≈ 1 at all
  three lengths. Browser specs (`*.spec.ts` without `.node`) were not run (cook mode).
- **rigi.5** (2026-10-02). Build commit: `a6af71e567d618b5d4b5524b637982838ba09236` (branch
  `arch/rigi-vendor-5`, an unofficial build; bundle `~/mt-image-archive/2026-10-02-rigi5/luma-rigi-vendor-5.bundle`).
  It is the rigi.4 build commit `4cf1099c` (below) plus, in this order:
  - `8d4f03523`: merge of luma master `16445518e07481991d171d55e96c4ddd5a6d25c6` ("fix(webgpu): declare
    texture view dimension in compat mode (#3348)", 2026-10-02; also #3347, examples docs only). #3348
    sets `textureBindingViewDimension` on WebGPU textures, so compat-mode devices bind cube maps as cube
    views; it is the cube-map half of what we carry from #3345. One add/add conflict in the test
    `modules/webgpu/test/webgpu/adapter/webgpu-compatibility-device.spec.ts` (#3345 and #3348 both
    create it): both tests kept. `modules/` src merged clean;
  - `8cd55ede6`: merge of #3313's moved head `3826c4141d6a19a4e504505837155788423b2c49` (one new commit on
    top of `2ed6834d`, "fix(webgpu): make attached device teardown idempotent": `WebGPUDevice.destroy()`
    returns early on a second call). Clean;
  - three local commits on `rigi/compute-api` (one commit each, spec next to the existing ones; patches
    in `patches/`), not upstream, not proposed upstream:
    5. `2010d9f08` WebGL `getWebGLUsage`: a `Buffer.MAP_READ` buffer (pixel pack / readback) gets the
       `GL.STREAM_READ` usage hint (was `STATIC_DRAW`; Rigi's pre-luma readback code used `STREAM_READ`
       because of a Chrome + ANGLE slow path). Exported `@internal` for its node spec
       `modules/webgl/test/adapter/resources/webgl-buffer-usage.node.spec.ts`. Patch `luma-stream-read-2010d9f0.patch`.
    6. `96133134c` `Buffer.readAsync(byteOffset?, byteLength?, options?: BufferReadOptions)` with
       `type BufferReadOptions = BufferMapReadOptions & {target?: ArrayBufferView<ArrayBuffer>}`: the bytes
       are copied into `target` (from its `byteOffset`) and the result is a `Uint8Array` over exactly those
       bytes of `target` (no new array). WebGL `getBufferSubData` writes straight into it; WebGPU copies the
       mapped range into it (target checked before mapping, so a too-small target throws `RangeError`
       without leaving the buffer mapped) and `readAsync` now forwards `waitForSubmittedWork`; null device
       and `DynamicBuffer` likewise. Exported helper `getBufferReadTarget`. Anyone subclassing `Buffer`
       outside luma should accept the third argument. Specs: `core/test/adapter/resources/buffer.spec.ts`
       (all devices), `test-utils/test/null-device/null-buffer-read-target.spec.ts` (node). Patch
       `luma-read-into-target-96133134.patch`.
    7. `a6af71e56` WebGL multisampled textures and render pass resolve: a `WEBGLTexture` with
       `samples > 1` (2d, 1 mip level, no data/handle, else it throws) is a multisample renderbuffer
       (`renderbufferStorageMultisample`), attachable to framebuffers (`framebufferRenderbuffer`), never
       sampled/written/read (as on WebGPU); a framebuffer with a multisampled attachment always checks
       completeness and throws when incomplete (after restoring the previous binding).
       `RenderPassProps.resolveTargets` (was "WebGPU only") works on WebGL: `WEBGLRenderPass.end()` blits
       colour attachment `i` into `resolveTargets[i]` (`GL.NEAREST`, full size, scissor test and rasterizer
       discard disabled inside the pass's pushed state). New `RenderPassProps.depthStencilResolveTarget`,
       WebGL only (WebGPU throws when set), resolves depth/stencil the same way. With `discard: true` the
       multisample attachments are invalidated after the resolve (cf. WebGPU storeOp 'discard').
       Resolve framebuffers are cached per target view on the source framebuffer. Specs:
       `webgl/test/adapter/helpers/webgl-resolve.node.spec.ts` (node, recorded GL calls) and a browser leg
       in `webgl/test/adapter/resources/webgl-render-pass.spec.ts`. Patch `luma-webgl-msaa-resolve-a6af71e5.patch`.
  Watched, not vendored in rigi.5: #3340 (vendored since rigi.6).
  Every other vendored PR head was re-checked with `gh` on 2026-10-02 and had not moved; none is merged.
- **rigi.4** base: luma master `7289d961a9cec6fb10bdfcf4afc5286cb30376e3` ("docs: organize deck visual effects
  examples (#3341)", 2026-10-01). It already contains #3312 (`requiredLimits`, `f17d6fee`) and #3335
  (WebGPU buffer `byteOffset` init).
- rigi.4 build commit: `4cf1099c620c351846325c01e5cf304d27169bca` (an unofficial build, branch
  `arch/rigi-vendor-4`, not an upstream release or commit). It is the rigi.3 build commit
  `b1d1256a576bff25362df5873e82e239dba75851` (branch `arch/rigi-vendor-3`) plus the merge of #3345 and
  four local commits (below). The rigi.3 part is, on the base, merged `--no-ff` in this order
  (fetch with `git fetch https://github.com/visgl/luma.gl pull/<n>/head`):
  - #3313 head `2ed6834d64bd8b010f2c0eb1f97be556f95e7f3a`: `WebGPUAdapter.attach()` for
    app-created GPUDevices; the application keeps ownership of an attached device and canvas;
  - #3302 head `b97c129f853ca8d89adade85f06da41e16a08331`: engine pipeline variant cache (LRU
    eviction, balanced references);
  - #3287 head `dcecaedc0a70706987488db041093e0ae8bb277a`: Device conformance suite, idempotent
    resource destroy, `Texture.setSampler()` releases the old sampler;
  - #3328 head `30f08edae5a86ed013bcbe97bcfe837348c138fc`: `Model.setIndirectBuffer` /
    `writeIndirectDrawRecord`, WebGPU `drawIndirect` / `drawIndexedIndirect` (WebGL asserts).
    Revertible: `vendor/luma/patches/luma-3328.patch` is the diff of that merge against its parent.
    Check: `scripts/gpu/indirect-draw-check.mjs`;
  - cherry-pick `-x` of `c80b7ce6d0a3c05d7f4541ceff15228139a9b216` (upstream-less branch
    `rigi/pipeline-factory-compute-hash`): `PipelineFactory._hashComputePipeline` also hashes
    `entryPoint` and key-sorted override `constants`. Without it, two compute specs differing only in
    entry point or constants share one cached `ComputePipeline`. Patch:
    `vendor/luma/patches/luma-compute-hash-c80b7ce6.patch`;
  - #3333 head `12e45c34e9740e7f65979413f27130c139ae6382`: WebGL/WebGPU draw-call semantics parity
    (WebGL `firstIndex`, attribute-less draws, WebGPU stencil aspect, `instanceCount ?? 1`);
  - #3334 head `f208a8da6a1c872db9d5095a6c4026007d369fe4`: WebGL queued copies run before immediate
    render passes and buffer writes;
  - #3330 head `f7ae62b82f45e6e0387fffbf7d4b1d6bc5006c5f`: WebGPU buffer readback stages only the
    requested range.
  rigi.4 adds, on top of `b1d1256a`:
  - merge `2d327bfb13ba98024e532175ee0b8d7512b3d111` of #3345 head `4cbc25d4eae1d071e1fe9d6b998b915b38f4cf41`
    ("Fix WebGPU compatibility devices for storage-heavy and cube-map examples": compat-mode devices
    request the adapter's real limits). Clean merge. Revertible: `vendor/luma/patches/luma-3345.patch`;
  - local branch `rigi/compute-api` (also `arch/rigi-vendor-4`), one commit each, each with a spec next to
    the existing ones (the specs run on the browser/headless tier; the null-device legs were run in node).
    Not upstream, not proposed upstream. Patches: `vendor/luma/patches/luma-*.patch`.
    1. `1998d244f` `CommandEncoder.clearBuffer(buffer: Buffer, byteOffset?: number, byteLength?: number): void`
       (abstract on `CommandEncoder`; WebGPU records native `clearBuffer`, multiples of 4 required;
       WebGL queues a zero `buffer.write` run in command order; `NullCommandEncoder` too). Nothing
       equivalent existed in rigi.3. Anyone subclassing `CommandEncoder` outside luma must implement it.
       Patch `luma-clear-buffer-1998d244.patch`.
    2. `2f870ee8f` `Device.submit(commandBuffer?: CommandBuffer, additionalCommandBuffers?: readonly CommandBuffer[]): void`.
       With `commandBuffer` omitted the default encoder is finished and goes first (as before), then the
       additional buffers follow in array order, all in ONE `queue.submit` on WebGPU (in order, flushed
       one after another on WebGL). Every submitted buffer is destroyed, and their transient upload
       buffers are released after `onSubmittedWorkDone`. Replaces Rigi's use of
       `_finalizeDefaultCommandEncoderForSubmit` and raw `queue.submit` in `src/lib/gpu/core/queue.ts`,
       except the per-extra error-scope wrapping, which stays app-side (`submit()` keeps luma's single
       validation scope around the whole submit). Patch `luma-device-submit-2f870ee8.patch`.
    3. `5727c7ca5` `Buffer.mapAndReadAsync<T>(onMapped, byteOffset?, byteLength?, options?: BufferMapReadOptions)`
       with `type BufferMapReadOptions = {waitForSubmittedWork?: boolean}` (default `true` = old
       behaviour). `false` skips the `queue.onSubmittedWorkDone()` wait and maps at once; WebGL and the
       null device ignore it; `DynamicBuffer.mapAndReadAsync` forwards it. Meant for `MAP_READ` readback
       ring slots (`src/lib/gpu/core/readback.ts`). For a non-`MAP_READ` buffer the staging copy is
       still submitted first, so ordering stays correct. Patch `luma-map-read-no-wait-5727c7ca.patch`.
    4. `4cf1099c6` `RenderBundleEncoderProps.sampleCount` accepts any positive integer (was: only 1 or
       it threw "currently only supports sampleCount 1"). The native encoder descriptor already
       forwarded it; the bundle only executes in passes with the same attachment formats and sample
       count. Pipelines must use the matching multisample count (Model `parameters.sampleCount`). Replaces
       the native-handle workaround in `src/lib/deck-webgpu/render-bundle.ts`. Patch
       `luma-render-bundle-msaa-4cf1099c.patch`.
  #3333 and #3334 must travel with #3287: the squashed #3287 moved those fixes out, so rigi.3 without
  them would regress against rigi.2.
- **Behaviour changes (rigi.6):** see #3345 above; `withGLParameters` always restores on exceptions
  (#3351: `nocatch: true` is now the opt-out); WebGL texture uploads reset `UNPACK_PREMULTIPLY_ALPHA_WEBGL`
  to `false` unless `premultipliedAlpha` is passed (#3346: an ambient value no longer leaks in); engine
  `Model`s resolve their default WGSL/GLSL assembler lazily and the deck shim is gone (#3288; Rigi's
  deck-webgpu Models pass `RIGI_WGSL_ASSEMBLER` explicitly; deck's own shaders are what the browser batch
  must look at); shader hooks with unknown injection targets now throw (#3286).
- **Behaviour changes (rigi.5):** WebGL readback buffers (`MAP_READ`) are created `STREAM_READ`; a second
  `destroy()` of a WebGPU device is a no-op (#3313); compat-mode WebGPU textures declare their binding view
  dimension (#3348); a WebGL framebuffer with multisampled attachments throws when incomplete.
- **Behaviour change (#3345):** on a compatibility-mode WebGPU device the adapter's real limits are
  requested instead of the defaults; nothing changes on full-feature devices.
- **Behaviour change (#3313):** `DeviceProps._ownsHandle` no longer exists. `luma.createDevice()`
  creates the `GPUDevice` and the luma device owns it (`destroy()` destroys it). `webgpuAdapter.attach(handle,
  props)` always leaves ownership with the app: `destroy()` removes luma's listeners and leaves the
  `GPUDevice` alive, whatever `props` say, and an attached canvas context restores the configuration
  it found. An app that hands a device over must destroy the `GPUDevice` itself:
  `src/lib/gpu/core/luma.ts` (`attachWebGPUDevice(handle, props, ownsHandle)`) wraps `device.destroy`
  to do that. Also, a lost attached device is dropped from luma's wrapper cache and cannot be
  re-attached. In rigi.2 attached devices were not owned unless `_ownsHandle: true` was passed, so
  nothing in the app changes.
- Other behaviour notes: WebGL resources no longer null their `handle` after destroy (#3287);
  `DeviceProps.requiredLimits` is typed `Partial<Record<keyof DeviceLimits, number>>` (#3312 as
  merged).
- Packed manifests are rewritten (the equivalent of upstream branch `rigi/packaging-manifests`,
  `f1992fd3`, but pinned): `version` is `10.0.0-alpha.2-rigi.6`; `private` is dropped (splats,
  experimental); in `@luma.gl/experimental` the `@loaders.gl/core` / `@loaders.gl/sql` dependencies
  become optional peers (they serve `gpu-sql` / `geospatial`, not `gpu-tables`), so the install adds no
  loaders.gl packages; `@math.gl/crs` / `@math.gl/proj4` stay optional peers pinned to `5.0.0-alpha.10`
  (if coordinator H adds `@math.gl/proj4`, it must be `5.0.0-alpha.10` or npm warns); `dist.min.js` is
  dropped from experimental; every `@luma.gl/*` dependency and
  peer is the exact rigi version; `@math.gl/core` (`patch:...` in the source) and `@math.gl/types` are
  pinned to the published `5.0.0-alpha.10` (API-identical to alpha.9 for what luma imports; the yarn
  patch only adds `vec*`/`mat4` namespace exports that the built `dist/` does not import);
  `scripts`, `devDependencies` and `gitHead` are dropped.
- math.gl: the app depends on `@math.gl/core` `5.0.0-alpha.10` directly; `@math.gl/polygon` and
  `@math.gl/web-mercator` are no longer direct deps (unused in the app; deck pulls them, and they
  resolve to alpha.10). `@loaders.gl/schema-utils` pins `@math.gl/types` to exactly `5.0.0-alpha.9`,
  so `overrides` also pins `@math.gl/types` to `5.0.0-alpha.10` (a types-only package) to keep one copy.
- With those manifests the app needs no `.npmrc` and only one override, `"@math.gl/types":
  "5.0.0-alpha.10"`. (The `@deck.gl/core` override went away with the deck `9.4.0-rigi.1` tarballs,
  whose layers manifest peers the exact core version; see `vendor/deck/README.md`.)
- Gate: `npm ls @luma.gl/core @luma.gl/webgpu @math.gl/core` shows one copy of each, and
  `npm install` prints no peer warnings.

## Licence

MIT, Copyright (c) vis.gl contributors: see `LICENSE` in this directory (verbatim from upstream luma.gl).
`@luma.gl/splats` (`dist/gpu-paged-splat-shaders.js`, `dist/splat-rad-hierarchy.js`) adapts Spark's RAD
opacity / support behaviour from https://github.com/sparkjsdev/spark, MIT, Copyright © 2025 World Labs
Technologies, Inc.; the notice is kept in those files (and in `NOTICE.md`).

## Checksums (SHA-256)

```
41bfdda0842d5054ebd61b04c047357faa40f4124ca7f97ea0102f44f1cde12d  vendor/luma/luma.gl-core-10.0.0-alpha.2-rigi.6.tgz
3d6c9753f1e0aa9d30720d19b1b02a397891ca84c2a276d94748395d9cd614ae  vendor/luma/luma.gl-effects-10.0.0-alpha.2-rigi.6.tgz
1ee602f3e56e77e80fcfa44f79e2cf677ce8da042ce3040fa2c3cb55b3f2d9e4  vendor/luma/luma.gl-engine-10.0.0-alpha.2-rigi.6.tgz
31fd26700cf02c7a82ddeee85fc8296b00fc70a5a1b008597a16a86ed6d9d563  vendor/luma/luma.gl-experimental-10.0.0-alpha.2-rigi.6.tgz
a97ae3fc5768bd33b9f8d0176b4f2033d6bacfa7159b0462704105173128b261  vendor/luma/luma.gl-gpgpu-10.0.0-alpha.2-rigi.6.tgz
2c94e964d3e675b9192d5c06d3054ebb2e8708c45c91cec7c944c64117b4fb57  vendor/luma/luma.gl-shadertools-10.0.0-alpha.2-rigi.6.tgz
90cdb030a36252d5291c7bceb5e17ea22bb19957f85bb3c9e387eda36a12e859  vendor/luma/luma.gl-splats-10.0.0-alpha.2-rigi.6.tgz
6f53555b5d4a072cd2325776140bc35482320def67a8a4090f8acc6e6171c11f  vendor/luma/luma.gl-webgl-10.0.0-alpha.2-rigi.6.tgz
1692ce8e390a0ddbd0eb2bba983f6a543afbeda89291f4ceaf038fe18b7fc8fe  vendor/luma/luma.gl-webgpu-10.0.0-alpha.2-rigi.6.tgz
```

## Contents

Only `dist/`, `package.json` and `README.md`.
`src/` and all `*.map` files were stripped (and the `//# sourceMappingURL=` comments removed).
Sizes: core 162680 B, effects 168133 B, engine 235399 B, experimental 1119675 B, gpgpu 1065799 B, shadertools 371454 B, splats 191041 B, webgl 222776 B, webgpu 85351 B.

## Rebuild

```sh
git clone https://github.com/visgl/luma.gl luma-build && cd luma-build
git checkout 7289d961a9cec6fb10bdfcf4afc5286cb30376e3
# fastest: git fetch <archive>/2026-10-02-rigi6/luma-rigi-vendor-6.bundle arch/rigi-vendor-6 and check it out (bdbc371f);
# rigi.6 from rigi.5 (a6af71e5): git merge --no-ff 44d990fd (#3313), git apply -3 patches/luma-3345-head-delta-*.patch
#   and commit, then git merge --no-ff the heads of #3340 #3338 #3332 #3326 #3331 #3286 #3288 #3351 #3346 #3132 #3337
#   (conflicts: docs/whats-new.md both sides; model.node.spec.ts union of imports + both tests), then
#   git am patches/luma-fft1d-65536-*.patch patches/luma-fft-bitreverse-*.patch;
# rigi.5 from rigi.4 (4cf1099c): git merge --no-ff 16445518 (keep both tests in the add/add conflict of
#   webgpu-compatibility-device.spec.ts), git merge --no-ff 3826c414 (#3313 head), then
#   git am vendor/luma/patches/luma-{stream-read,read-into-target,webgl-msaa-resolve}-*.patch;
# from scratch: merge --no-ff, in order, the heads of PRs #3313, #3302, #3287 and #3328 (git fetch origin pull/<n>/head),
git cherry-pick -x c80b7ce6d0a3c05d7f4541ceff15228139a9b216   # compute hash (vendor/luma/patches/luma-compute-hash-c80b7ce6.patch)
# then merge --no-ff the heads of #3333, #3334 and #3330 (= b1d1256a, rigi.3), then #3345,
# then the four rigi/compute-api commits (git am vendor/luma/patches/luma-{clear-buffer,device-submit,map-read-no-wait,render-bundle-msaa}-*.patch)
# (the repo's pre-commit hook needs yarn on PATH or git commit -n / git am --no-verify)
corepack yarn install && corepack yarn build
V=10.0.0-alpha.2-rigi.6             # bump rigi.N
M=5.0.0-alpha.10                    # published @math.gl pin
B=<scratch dir>; mkdir -p $B/luma-tgz $B/luma-slim   # pack/slim scratch space (outside /tmp on this machine)
for m in core effects engine experimental gpgpu shadertools splats webgl webgpu; do
  (cd modules/$m && npm pack --ignore-scripts --pack-destination $B/luma-tgz)
done
# slim + rewrite the manifest, then repack
for m in core effects engine experimental gpgpu shadertools splats webgl webgpu; do
  mkdir -p $B/luma-slim/$m && tar xzf $B/luma-tgz/luma.gl-$m-10.0.0-alpha.2.tgz -C $B/luma-slim/$m
  (cd $B/luma-slim/$m/package && rm -rf src dist.min.js && find . -name '*.map' -delete \
    && { grep -rl 'sourceMappingURL=' . | xargs sed -i '' -E '/^\/\/# sourceMappingURL=.*$/d' || true; } \
    && node -e '
      const fs = require("fs"), V = process.argv[1], M = process.argv[2], p = JSON.parse(fs.readFileSync("package.json"));
      p.version = V; delete p.private;
      if (p.name === "@luma.gl/experimental") for (const n of ["@loaders.gl/core", "@loaders.gl/sql"]) {
        p.peerDependencies[n] = p.dependencies[n]; delete p.dependencies[n]; p.peerDependenciesMeta[n] = {optional: true}; }
      for (const k of ["dependencies", "peerDependencies"]) for (const n of Object.keys(p[k] || {}))
        if (n.startsWith("@luma.gl/")) p[k][n] = V;
        else if (n.startsWith("@math.gl/")) p[k][n] = M;
      delete p.devDependencies; delete p.scripts; delete p.gitHead;
      if (Array.isArray(p.files)) p.files = p.files.filter((f) => f !== "src" && f !== "dist.min.js");
      fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n");' $V $M \
    && npm pack --ignore-scripts --pack-destination <repo>/vendor/luma)
done
cd <repo>   # update the nine file: paths in package.json if the version changed
rm -rf node_modules/@luma.gl && npm install
npm ls @luma.gl/core @luma.gl/webgpu @luma.gl/splats @math.gl/core   # one copy each, no warnings
```

(`sed -i ''` is the BSD/macOS form; use `sed -i` on GNU.)
