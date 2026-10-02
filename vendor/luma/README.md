# Vendored luma.gl (`10.0.0-alpha.2-rigi.3`)

The app needs luma.gl fixes that are not in a published alpha yet (`WebGPUAdapter.attach()`, the
device lifecycle fixes, the engine pipeline variant cache, indirect draws and a compute pipeline
cache fix). The published `10.0.0-alpha.2` manifests are also broken for npm (yarn `patch:`
protocol on `@math.gl/core`, `~9.4.0-alpha.1` peer ranges). So seven `@luma.gl/*` packages are
installed from these tarballs (`package.json`: `file:vendor/luma/<name>.tgz`): core, effects,
engine, gpgpu, shadertools, webgl, webgpu.

The version is `10.0.0-alpha.2-rigi.3`, so npm reinstalls over a cached `10.0.0-alpha.2` and
`^10.0.0-alpha.2` ranges (deck's) still match. Bump the `rigi.N` suffix on every rebuild.

**Swap to npm when luma publishes these fixes** (all of #3313, #3302, #3287, #3328, #3333, #3334
and #3330, and the PipelineFactory compute-hash fix; #3312 and #3335 are already in luma master):
point the seven deps at the published version, delete this directory and re-run `npm install`. If
the published manifests still carry `patch:` deps or `~9.4` peers, the old workaround (`.npmrc`
`legacy-peer-deps=true` plus `overrides` for every `@luma.gl/*` and `@math.gl/core`) comes back.

## Source

- Repo: https://github.com/visgl/luma.gl
- Base: luma master `7289d961a9cec6fb10bdfcf4afc5286cb30376e3` ("docs: organize deck visual effects
  examples (#3341)", 2026-10-01). It already contains #3312 (`requiredLimits`, `f17d6fee`) and #3335
  (WebGPU buffer `byteOffset` init).
- Build commit: `b1d1256a576bff25362df5873e82e239dba75851` (an unofficial build, branch
  `arch/rigi-vendor-3`, not an upstream release or commit). On the base, merged `--no-ff` in this order
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
  #3333 and #3334 must travel with #3287: the squashed #3287 moved those fixes out, so rigi.3 without
  them would regress against rigi.2.
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
  `f1992fd3`, but pinned): `version` is `10.0.0-alpha.2-rigi.3`; every `@luma.gl/*` dependency and
  peer is the exact rigi version; `@math.gl/core` (`patch:...` in the source) and `@math.gl/types` are
  pinned to the published `5.0.0-alpha.10` (API-identical to alpha.9 for what luma imports; the yarn
  patch only adds `vec*`/`mat4` namespace exports that the built `dist/` does not import);
  `scripts`, `devDependencies` and `gitHead` are dropped.
- math.gl: the app depends on `@math.gl/core` `5.0.0-alpha.10` directly; `@math.gl/polygon` and
  `@math.gl/web-mercator` are no longer direct deps (unused in the app; deck pulls them, and they
  resolve to alpha.10). `@loaders.gl/schema-utils` pins `@math.gl/types` to exactly `5.0.0-alpha.9`,
  so `overrides` also pins `@math.gl/types` to `5.0.0-alpha.10` (a types-only package) to keep one copy.
- With those manifests the app needs no `.npmrc` and only these overrides:
  `"@deck.gl/core": "$@deck.gl/core"` (`@deck.gl/layers@9.4.0-beta.4` peers `@deck.gl/core@~9.4.0`,
  which the prerelease `9.4.0-beta.4` does not satisfy) and `"@math.gl/types": "5.0.0-alpha.10"`.
- Gate: `npm ls @luma.gl/core @luma.gl/webgpu @math.gl/core` shows one copy of each, and
  `npm install` prints no peer warnings.

## Licence

MIT, Copyright (c) vis.gl contributors: see `LICENSE` in this directory (verbatim from upstream luma.gl).

## Checksums (SHA-256)

```
8f986b14dbd5bbb31bbc6db9d4088b72cfcdddb4f56c7aa84c65d69c70041394  vendor/luma/luma.gl-core-10.0.0-alpha.2-rigi.3.tgz
382f7030b15ea3ccc495c2dea6312a68d5ba832b68449c08f14e4119052b726c  vendor/luma/luma.gl-effects-10.0.0-alpha.2-rigi.3.tgz
ab319a02430ede6f90844416e52866d62ca4032efedddff0a154f1a4d42fe929  vendor/luma/luma.gl-engine-10.0.0-alpha.2-rigi.3.tgz
42fbb6c2325a9d794941ede1a4419e77895160323dca07070c03763c306eac63  vendor/luma/luma.gl-gpgpu-10.0.0-alpha.2-rigi.3.tgz
002c295d241f8714638dd1600baee3f1dc03e98037dbc2e82e1e2f6830c1f20c  vendor/luma/luma.gl-shadertools-10.0.0-alpha.2-rigi.3.tgz
189e4092c6b04b44816d5e777885ebd2be0bb18dd1f25c1494172d76b4148df1  vendor/luma/luma.gl-webgl-10.0.0-alpha.2-rigi.3.tgz
5fd36932e99aeee8de44d0d5b5685bbed6eeab7633e51bd3a9fc3ddbf7639fe5  vendor/luma/luma.gl-webgpu-10.0.0-alpha.2-rigi.3.tgz
```

## Contents

Only `dist/`, `package.json` and `README.md`.
`src/` and all `*.map` files were stripped (and the `//# sourceMappingURL=` comments removed).
Sizes: core 161144 B, effects 168140 B, engine 234524 B, gpgpu 1060572 B, shadertools 370494 B, webgl 217341 B, webgpu 84232 B.

## Rebuild

```sh
git clone https://github.com/visgl/luma.gl luma-build && cd luma-build
git checkout 7289d961a9cec6fb10bdfcf4afc5286cb30376e3
# merge --no-ff, in order, the heads of PRs #3313, #3302, #3287 and #3328 (git fetch origin pull/<n>/head),
git cherry-pick -x c80b7ce6d0a3c05d7f4541ceff15228139a9b216   # compute hash (vendor/luma/patches/luma-compute-hash-c80b7ce6.patch)
# then merge --no-ff the heads of #3333, #3334 and #3330
corepack yarn install && corepack yarn build
V=10.0.0-alpha.2-rigi.3             # bump rigi.N
M=5.0.0-alpha.10                    # published @math.gl pin
for m in core effects engine gpgpu shadertools webgl webgpu; do
  (cd modules/$m && npm pack --ignore-scripts --pack-destination /tmp/luma-tgz)
done
# slim + rewrite the manifest, then repack
for m in core effects engine gpgpu shadertools webgl webgpu; do
  mkdir -p /tmp/luma-slim/$m && tar xzf /tmp/luma-tgz/luma.gl-$m-10.0.0-alpha.2.tgz -C /tmp/luma-slim/$m
  (cd /tmp/luma-slim/$m/package && rm -rf src && find . -name '*.map' -delete \
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
