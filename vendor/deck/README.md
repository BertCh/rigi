# Vendored deck.gl (luma.gl 10 build)

No published deck.gl release targets luma.gl 10 yet, so `@deck.gl/core` and `@deck.gl/layers`
are installed from these tarballs (`package.json`: `file:vendor/deck/<name>.tgz`).

**Swap to npm when deck publishes on luma 10**: point both deps at the published version,
delete this directory, and re-run `npm install`. Also revisit `.npmrc` (`legacy-peer-deps`) and
`package.json` `overrides`, which only exist to work around luma `10.0.0-alpha.2`'s broken
manifests (yarn `patch:` protocol on `@math.gl/core`, `~9.4` peer ranges).

## Source

- Repo: https://github.com/visgl/deck.gl, PR #10752 (branch `codex/bump-luma-10-alpha-1`)
- Commit: `0d8b1664723dec15315dd31686078b1b3b142b79`
  ("fix(mesh-layers): normalize signed Arrow mesh indices for GPU buffers", 2026-09-26)
- Version string inside the packages: `9.4.0-beta.4`. (The `gitHead` field in the packed
  package.json, `13ace64…`, is a stale value carried in deck's repo, not the build commit.)
- Built against `@luma.gl/*@10.0.0-alpha.2`, `@math.gl/*@5.0.0-alpha.9`, `@loaders.gl/*@5.0.0-alpha.7`.

## Contents

Only `dist/` (full build, used by the WebGPU lab `scripts/deck-webgpu/vite.webgpu.config.ts`),
`dist.webgl-only/` (the `visgl:webgl-only` export condition the app's `vite.config.ts` selects),
`package.json` and `README.md`. `src/` and all `*.map` files were stripped (and the
`//# sourceMappingURL=` comments removed) to keep the tarballs small (~0.5 MB + ~0.26 MB).

## Rebuild

```sh
git clone https://github.com/visgl/deck.gl deck-src && cd deck-src
git fetch origin pull/10752/head && git checkout 0d8b1664723dec15315dd31686078b1b3b142b79
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
