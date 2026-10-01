# Vendored deck.gl (luma.gl 10 build)

No published deck.gl release targets luma.gl 10 yet, so `@deck.gl/core` and `@deck.gl/layers`
are installed from these tarballs (`package.json`: `file:vendor/deck/<name>.tgz`).

**Swap to npm when deck publishes on luma 10**: point both deps at the published version,
delete this directory, and re-run `npm install`. Also revisit `.npmrc` (`legacy-peer-deps`) and
`package.json` `overrides`, which only exist to work around luma `10.0.0-alpha.2`'s broken
manifests (yarn `patch:` protocol on `@math.gl/core`, `~9.4` peer ranges).

## Source

Built from a local merge of deck PR #10752 into deck master, plus luma.gl's deck WebGPU fixes:

- Repo: https://github.com/visgl/deck.gl
- Build commit: `f1bc66cede34768f6c10fa15681119bc669a2efb` (local, not on GitHub). It sits on top of the
  merge commit `620e849c75c5ed1527455245f0b93b4161f3f204`, whose parents are:
  - `0d8b1664723dec15315dd31686078b1b3b142b79`: PR #10752 head (branch `codex/bump-luma-10-alpha-1`,
    "fix(mesh-layers): normalize signed Arrow mesh indices for GPU buffers", 2026-09-26);
  - `ce0808d019833027b9651634cc4233547f9980ea`: deck master ("fix(maplibre): keep picking in sync with
    the terrain elevation (#10756)", 2026-09-30).
- Merge: the only conflict was `test/modules/extensions/path.spec.ts` (not shipped). It keeps master's
  `pathStylePipelineShaders` import and #10752's `@math.gl/core/vec3` subpath import. The
  master commits that touch the shipped `core`/`layers` src are #10713 (revert of the GlobeView pole
  rotation), #10731 (a controller with no view state is disabled instead of throwing) and #10738
  (transition edge cases).
- `f1bc66ce` applies only the **WebGPU src hunks** of luma.gl's
  `.yarn/patches/@deck.gl-core-npm-9.4.0-707f3fb147.patch` at luma `7d1d11e9` (#3325), patch lines
  404-506, to `modules/core/src/`:
  - `passes/layers-pass.ts` `getGLViewport`: top-left `y` on WebGPU;
  - `passes/pick-layers-pass.ts`: `scissorY` flipped to a top-left origin on WebGPU;
  - `lib/deck-picker.ts` `readBuffer`: `y` flipped on WebGPU, and rows reversed so the picking
    decoders see bottom-to-top rows on both backends;
  - `lib/deck-renderer.ts`: `depthStencilAttachment: 'depth24plus'` on `deck-renderbuffer-0` (the
    PostProcessEffect scene input). This one is not WebGPU-gated;
  - `shaderlib/project/project.wgsl.ts` `project_get_orientation_matrix`: the `select()` argument
    order bug (NaN for a vertical up vector) replaced by an `if`.
  The math.gl import hunks of that patch were skipped, because #10752 already has the subpath imports.
  The WebGPU-gated hunks constant-fold away in `dist.webgl-only`.
- Gate: `git grep -nE "import \{[^}]*\b(vec[234]|mat[34])\b[^}]*\} from '@math.gl/core'" modules/`
  returns nothing.
- Version string inside the packages: `9.4.0-beta.4`. (The `gitHead` field in the packed
  package.json, `13ace64…`, is a stale value carried in deck's repo, not the build commit.)
- Built against `@luma.gl/*@10.0.0-alpha.2`, `@math.gl/*@5.0.0-alpha.9`, `@loaders.gl/*@5.0.0-alpha.7`.

## Contents

Only `dist/` (full build, used by the WebGPU lab `scripts/deck-webgpu/vite.webgpu.config.ts`),
`dist.webgl-only/` (the `visgl:webgl-only` export condition the app's `vite.config.ts` selects),
`package.json` and `README.md`. `src/` and all `*.map` files were stripped (and the
`//# sourceMappingURL=` comments removed) to keep the tarballs small (core 516613 B + layers 264014 B, previously 515786 B + 263794 B).

## Rebuild

```sh
git clone https://github.com/visgl/deck.gl deck-src && cd deck-src
git fetch origin master pull/10752/head && git checkout -b vendor 0d8b1664723dec15315dd31686078b1b3b142b79
git merge ce0808d019833027b9651634cc4233547f9980ea   # resolve path.spec.ts as described above
# luma's deck patch: keep only the 5 WebGPU src hunks (lines 404-472 and 487-506) and prefix the
# paths with modules/core/, then `git apply` it
npx yarn@1.22.19 install
npx yarn@1.22.19 build              # must include the dist.webgl-only build
for m in core layers; do
  (cd modules/$m && npm pack --ignore-scripts --pack-destination /tmp/deck-tgz)
done
# slim: drop src/ and source maps, then repack
for m in core layers; do
  mkdir -p /tmp/deck-slim/$m && tar xzf /tmp/deck-tgz/deck.gl-$m-9.4.0-beta.4.tgz -C /tmp/deck-slim/$m
  (cd /tmp/deck-slim/$m/package && rm -rf src && find . -name '*.map' -delete \
    && grep -rl 'sourceMappingURL=' dist dist.webgl-only | xargs sed -i '' -E '/^\/\/# sourceMappingURL=.*$/d' \
    && npm pack --ignore-scripts --pack-destination <repo>/vendor/deck)
done
cd <repo> && npm install     # refreshes the lockfile integrity hashes
```

(`sed -i ''` is the BSD/macOS form; use `sed -i` on GNU.)
