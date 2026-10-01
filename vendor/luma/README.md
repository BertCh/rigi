# Vendored luma.gl (`10.0.0-alpha.2-rigi.1`)

The app needs luma.gl fixes that are not in a published alpha yet (`WebGPUAdapter.attach()`,
`requiredLimits`, the device lifecycle fixes and a compute pipeline cache fix). The published
`10.0.0-alpha.2` manifests are also broken for npm (yarn `patch:` protocol on `@math.gl/core`,
`~9.4.0-alpha.1` peer ranges). So seven `@luma.gl/*` packages are installed from these tarballs
(`package.json`: `file:vendor/luma/<name>.tgz`): core, effects, engine, gpgpu, shadertools, webgl,
webgpu.

The version is `10.0.0-alpha.2-rigi.1`, so npm reinstalls over a cached `10.0.0-alpha.2` and
`^10.0.0-alpha.2` ranges (deck's) still match. Bump the `rigi.N` suffix on every rebuild.

**Swap to npm when luma publishes these fixes** (all of #3312, #3313, #3302 and #3287, and the
PipelineFactory hash fix): point the seven deps at the published version, delete this directory
and re-run `npm install`. If the published manifests still carry `patch:` deps or `~9.4` peers,
the old workaround (`.npmrc` `legacy-peer-deps=true` plus `overrides` for every `@luma.gl/*` and
`@math.gl/core`) comes back.

## Source

- Repo: https://github.com/visgl/luma.gl
- Build commit: `5e1b72ed20b3fd8e1fa94d1a60c713661d0642a6` (local branch `rigi-vendor`, not on
  GitHub; archived in `~/mt-image-archive/2026-10-01-luma-deck-upstream/luma-rigi-branches.bundle`).
  It is luma master `7d1d11e91d8c0936b1bf32a302dc760c04e7a0ae` ("Add height fog, rain, and snow with
  a riverfront example (#3325)", 2026-09-30) with these PRs merged in order:
  - #3312 head `3981234311d5077b062a7a48436b41caf7d4b707`: `requiredLimits` in `DeviceProps`;
  - #3313 head `cc9e4b2ca6d26fa0460843a267727c5f2a4e4eda`: `WebGPUAdapter.attach()` for
    app-created GPUDevices (the only conflict was `webgpu-device-lifecycle.node.spec.ts`, a test;
    both sides kept);
  - #3302 head `ae2d87624a09bc1b4c542bd124d4f55963e9526a`: engine pipeline variant cache;
  - #3287 head `d79856a51461b859e1e7835f829981e58c893cd4`: Device conformance suite and resource
    lifecycle fixes;
  - then `5e1b72ed` itself: `PipelineFactory._hashComputePipeline` also hashes `entryPoint` and
    key-sorted override `constants` (upstream as branch `rigi/pipeline-factory-compute-hash`,
    `c80b7ce6`). Without it, two compute specs differing only in entry point or constants share
    one cached `ComputePipeline`.
- **Behaviour change:** `WebGPUDevice.destroy()` destroys the `GPUDevice` only when the luma device
  owns it (`props._ownsHandle`). `luma.createDevice()` sets it; `webgpuAdapter.attach(handle, props)`
  leaves it `false` unless you pass `_ownsHandle: true`. An attached device that the app hands
  over must pass `_ownsHandle: true`, or `destroy()` leaks the GPUDevice.
- Packed manifests are rewritten (the equivalent of upstream branch `rigi/packaging-manifests`,
  `f1992fd3`, but pinned): `version` is `10.0.0-alpha.2-rigi.1`; every `@luma.gl/*` dependency and
  peer is the exact rigi version; `@math.gl/core` `patch:...` becomes plain `5.0.0-alpha.9`;
  `scripts`, `devDependencies` and `gitHead` are dropped. The yarn patch on `@math.gl/core` only
  adds `vec*`/`mat4` namespace exports that the built luma `dist/` does not import.
- With those manifests the app needs no `.npmrc` and only one override,
  `"@deck.gl/core": "$@deck.gl/core"`, because `@deck.gl/layers@9.4.0-beta.4` peers
  `@deck.gl/core@~9.4.0`, which the prerelease `9.4.0-beta.4` does not satisfy.
- Gate: `npm ls @luma.gl/core @luma.gl/webgpu @math.gl/core` shows one copy of each, and
  `npm install` prints no peer warnings.

## Contents

Only `dist/`, `package.json` and `README.md`.
`src/` and all `*.map` files were stripped (and the `//# sourceMappingURL=` comments removed).
Sizes: core 161017 B, effects 158759 B, engine 223877 B, gpgpu 1060573 B, shadertools 355781 B,
webgl 217049 B, webgpu 83612 B.

## Rebuild

```sh
git clone https://github.com/visgl/luma.gl luma-build && cd luma-build
git fetch ~/mt-image-archive/2026-10-01-luma-deck-upstream/luma-rigi-branches.bundle \
  'refs/heads/*:refs/heads/*'
git checkout rigi-vendor            # 5e1b72ed; or redo the merges listed above on 7d1d11e9
corepack yarn install && corepack yarn build
V=10.0.0-alpha.2-rigi.1             # bump rigi.N
for m in core effects engine gpgpu shadertools webgl webgpu; do
  (cd modules/$m && npm pack --ignore-scripts --pack-destination /tmp/luma-tgz)
done
# slim + rewrite the manifest, then repack
for m in core effects engine gpgpu shadertools webgl webgpu; do
  mkdir -p /tmp/luma-slim/$m && tar xzf /tmp/luma-tgz/luma.gl-$m-10.0.0-alpha.2.tgz -C /tmp/luma-slim/$m
  (cd /tmp/luma-slim/$m/package && rm -rf src && find . -name '*.map' -delete \
    && grep -rl 'sourceMappingURL=' . | xargs sed -i '' -E '/^\/\/# sourceMappingURL=.*$/d' \
    && node -e '
      const fs = require("fs"), V = process.argv[1], p = JSON.parse(fs.readFileSync("package.json"));
      p.version = V;
      for (const k of ["dependencies", "peerDependencies"]) for (const [n, r] of Object.entries(p[k] || {}))
        if (n.startsWith("@luma.gl/")) p[k][n] = V;
        else if (r.startsWith("patch:")) p[k][n] = /npm%3A([^#]+)#/.exec(r)[1];
      delete p.devDependencies; delete p.scripts; delete p.gitHead;
      if (Array.isArray(p.files)) p.files = p.files.filter((f) => f !== "src");
      fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n");' $V \
    && npm pack --ignore-scripts --pack-destination <repo>/vendor/luma)
done
cd <repo>   # update the seven file: paths in package.json if the version changed
rm -rf node_modules/@luma.gl && npm install
npm ls @luma.gl/core @luma.gl/webgpu @math.gl/core   # one copy each, no warnings
```

(`sed -i ''` is the BSD/macOS form; use `sed -i` on GNU.)
