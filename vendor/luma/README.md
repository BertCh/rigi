# Vendored luma.gl (`10.0.0-alpha.2-rigi.4`)

The app needs luma.gl fixes that are not in a published alpha yet (`WebGPUAdapter.attach()`, the
device lifecycle fixes, the engine pipeline variant cache, indirect draws and a compute pipeline
cache fix, compat-mode adapter limits, and a few small compute-API additions). The published `10.0.0-alpha.2` manifests are also broken for npm (yarn `patch:`
protocol on `@math.gl/core`, `~9.4.0-alpha.1` peer ranges). So seven `@luma.gl/*` packages are
installed from these tarballs (`package.json`: `file:vendor/luma/<name>.tgz`): core, effects,
engine, gpgpu, shadertools, webgl, webgpu.

The version is `10.0.0-alpha.2-rigi.4`, so npm reinstalls over a cached `10.0.0-alpha.2` and
`^10.0.0-alpha.2` ranges (deck's) still match. Bump the `rigi.N` suffix on every rebuild.

**Swap to npm when luma publishes these fixes** (all of #3313, #3302, #3287, #3328, #3333, #3334,
#3330 and #3345, and the PipelineFactory compute-hash fix; #3312 and #3335 are already in luma master):
point the seven deps at the published version, delete this directory and re-run `npm install`. If
the published manifests still carry `patch:` deps or `~9.4` peers, the old workaround (`.npmrc`
`legacy-peer-deps=true` plus `overrides` for every `@luma.gl/*` and `@math.gl/core`) comes back.

## Source

- Repo: https://github.com/visgl/luma.gl
- Base: luma master `7289d961a9cec6fb10bdfcf4afc5286cb30376e3` ("docs: organize deck visual effects
  examples (#3341)", 2026-10-01). It already contains #3312 (`requiredLimits`, `f17d6fee`) and #3335
  (WebGPU buffer `byteOffset` init).
- Build commit: `4cf1099c620c351846325c01e5cf304d27169bca` (an unofficial build, branch
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
  `f1992fd3`, but pinned): `version` is `10.0.0-alpha.2-rigi.4`; every `@luma.gl/*` dependency and
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

## Checksums (SHA-256)

```
a6a89518c64d9f59ee29124c60ad80218c11c26c99add1871a6ee32275e8273e  vendor/luma/luma.gl-core-10.0.0-alpha.2-rigi.4.tgz
d2c0e2875efe7bec47043e545d688c99646fd9de972eb9af84799d2d0196d24d  vendor/luma/luma.gl-effects-10.0.0-alpha.2-rigi.4.tgz
1dbe68c8e73579408ad729ce7cd16041e05f842f0ee1a8aa5099de2218dd1e3a  vendor/luma/luma.gl-engine-10.0.0-alpha.2-rigi.4.tgz
5e2995cde62c2ff56c8e478b4b9badc6bb84d9f7a3f24d26cdb7b955ceff6dfb  vendor/luma/luma.gl-gpgpu-10.0.0-alpha.2-rigi.4.tgz
55a50a18aa3e62d38bf39928d91e918821fa3c39824b4621b7706b059caecdd6  vendor/luma/luma.gl-shadertools-10.0.0-alpha.2-rigi.4.tgz
8795e79f5ca892794031ef98bb0dd52fdf0c107203c499bbef3ad14f7dd0ed4f  vendor/luma/luma.gl-webgl-10.0.0-alpha.2-rigi.4.tgz
a02b44994509ace8cfb5d8614f31ec79d9580295ac8dddb3a9b4dfc6d60f42fe  vendor/luma/luma.gl-webgpu-10.0.0-alpha.2-rigi.4.tgz
```

## Contents

Only `dist/`, `package.json` and `README.md`.
`src/` and all `*.map` files were stripped (and the `//# sourceMappingURL=` comments removed).
Sizes: core 161736 B, effects 168140 B, engine 234554 B, gpgpu 1060572 B, shadertools 370494 B, webgl 217677 B, webgpu 84951 B.

## Rebuild

```sh
git clone https://github.com/visgl/luma.gl luma-build && cd luma-build
git checkout 7289d961a9cec6fb10bdfcf4afc5286cb30376e3
# fastest: git fetch <archive>/luma-rigi-vendor-4.bundle arch/rigi-vendor-4 and check it out (4cf1099c);
# from scratch: merge --no-ff, in order, the heads of PRs #3313, #3302, #3287 and #3328 (git fetch origin pull/<n>/head),
git cherry-pick -x c80b7ce6d0a3c05d7f4541ceff15228139a9b216   # compute hash (vendor/luma/patches/luma-compute-hash-c80b7ce6.patch)
# then merge --no-ff the heads of #3333, #3334 and #3330 (= b1d1256a, rigi.3), then #3345,
# then the four rigi/compute-api commits (git am vendor/luma/patches/luma-{clear-buffer,device-submit,map-read-no-wait,render-bundle-msaa}-*.patch)
# (the repo's pre-commit hook needs yarn on PATH or git commit -n / git am --no-verify)
corepack yarn install && corepack yarn build
V=10.0.0-alpha.2-rigi.4             # bump rigi.N
M=5.0.0-alpha.10                    # published @math.gl pin
B=<scratch dir>; mkdir -p $B/luma-tgz $B/luma-slim   # pack/slim scratch space (outside /tmp on this machine)
for m in core effects engine gpgpu shadertools webgl webgpu; do
  (cd modules/$m && npm pack --ignore-scripts --pack-destination $B/luma-tgz)
done
# slim + rewrite the manifest, then repack
for m in core effects engine gpgpu shadertools webgl webgpu; do
  mkdir -p $B/luma-slim/$m && tar xzf $B/luma-tgz/luma.gl-$m-10.0.0-alpha.2.tgz -C $B/luma-slim/$m
  (cd $B/luma-slim/$m/package && rm -rf src && find . -name '*.map' -delete \
    && { grep -rl 'sourceMappingURL=' . | xargs sed -i '' -E '/^\/\/# sourceMappingURL=.*$/d' || true; } \
    && node -e '
      const fs = require("fs"), V = process.argv[1], M = process.argv[2], p = JSON.parse(fs.readFileSync("package.json"));
      p.version = V;
      for (const k of ["dependencies", "peerDependencies"]) for (const n of Object.keys(p[k] || {}))
        if (n.startsWith("@luma.gl/")) p[k][n] = V;
        else if (n.startsWith("@math.gl/")) p[k][n] = M;
      delete p.devDependencies; delete p.scripts; delete p.gitHead;
      if (Array.isArray(p.files)) p.files = p.files.filter((f) => f !== "src");
      fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n");' $V $M \
    && npm pack --ignore-scripts --pack-destination <repo>/vendor/luma)
done
cd <repo>   # update the seven file: paths in package.json if the version changed
rm -rf node_modules/@luma.gl && npm install
npm ls @luma.gl/core @luma.gl/webgpu @math.gl/core   # one copy each, no warnings
```

(`sed -i ''` is the BSD/macOS form; use `sed -i` on GNU.)
