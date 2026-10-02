# Vendored deck.gl (luma.gl 10 build), `9.4.0-rigi.1`

No published deck.gl release targets luma.gl 10 yet, so `@deck.gl/core` and `@deck.gl/layers`
are installed from these tarballs (`package.json`: `file:vendor/deck/<name>.tgz`).

**Swap to npm when deck publishes on luma 10**: point both deps at the published version,
delete this directory, and re-run `npm install`. The old `package.json` override
`"@deck.gl/core": "$@deck.gl/core"` is gone with rigi.1: the layers manifest peers `@deck.gl/core` at
the exact version `9.4.0-rigi.1`, which is what the core tarball is, and the install prints no peer
warning. (It only existed because `@deck.gl/layers@9.4.0-beta.4` peered `@deck.gl/core@~9.4.0`, which a
prerelease does not satisfy.) If a published deck brings that peer mismatch back, restore it. luma itself is vendored too
(see `vendor/luma/README.md`), with fixed manifests, so there is no `.npmrc` and no luma override;
the one remaining override, `@math.gl/types`, is explained there.

## Version

`9.4.0-rigi.1` (was `9.4.0-beta.4`). The version is changed in the packed manifests and in the two
places where core embeds it (`dist/lib/init.js` and `dist/index.cjs`, and the same two files in
`dist.webgl-only/`), so `deck.VERSION` and the init log line report `9.4.0-rigi.1`. The deck repo
itself was not modified for this: the rewrite happens in the slim step below. The old `gitHead`,
`scripts` and `devDependencies` fields are dropped from the packed manifests.

## Source

Built from a local merge of deck PR #10752 into current deck master, plus luma.gl's deck WebGPU
fixes and deck PR #10780:

- Repo: https://github.com/visgl/deck.gl
- Build commit: `4a2223f3c993bc1c41114d33d130b05769d84672` (branch `rigi1`, an unofficial local build,
  not an upstream release or commit). It is the merge of PR #10780 on top of the WebGPU cherry-pick,
  on top of the merge of PR #10752 into deck master:
  - `35854250bd3e54fe6926769191639848890b0397`: deck master ("feat(pydeck): chart gallery examples,
    ES module custom libraries, community-layer docs (#10665)", 2026-10-01), the base;
  - `7adb4da65e260ab6392b4521424c97e55eff4242`: merge of PR #10752 into the base, whose second
    parent is `0d8b1664723dec15315dd31686078b1b3b142b79` (PR #10752 head, branch
    `codex/bump-luma-10-alpha-1`, "fix(mesh-layers): normalize signed Arrow mesh indices for GPU
    buffers", 2026-09-26, still an open draft);
  - `659f722db1392984bdb94606f3ba3c0ae11d2f56`: the cherry-pick of `f1bc66cede34768f6c10fa15681119bc669a2efb`
    (the 5 WebGPU hunks, below);
  - `4a2223f3c993bc1c41114d33d130b05769d84672`: merge of PR #10780 (head
    `5b51fb265b7c6d5afded3f2931e5b886992038bc`, two commits: `f5e2b6b83dda4af3fde44798effab201e3a097d6`
    "fix(layers): pad SDF glyphs by the distance field radius" and `5b51fb265` "fix(layers): cap SDF
    glyph padding to the atlas width").
- Conflict resolution: the only conflict (merging #10752) was `test/modules/extensions/path.spec.ts`
  (not shipped). It is resolved exactly as in rigi.0: `git show 620e849c75c5ed1527455245f0b93b4161f3f204:test/modules/extensions/path.spec.ts`
  (the earlier merge of #10752 into master `ce0808d0`), which keeps master's `pathStylePipelineShaders`
  import and #10752's `@math.gl/core/vec3` subpath import. The cherry-pick and the #10780 merge
  were clean.
- `f1bc66ce` applies only the **WebGPU src hunks** of luma.gl's
  `.yarn/patches/@deck.gl-core-npm-9.4.0-707f3fb147.patch` at luma `7d1d11e91d8c0936b1bf32a302dc760c04e7a0ae` (#3325),
  patch lines 404-506, to `modules/core/src/` (the patch is unchanged at luma master
  `7289d961a9cec6fb10bdfcf4afc5286cb30376e3`):
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
- #10780 (`modules/layers/src/text-layer/font-atlas-manager.ts`): an SDF glyph is padded by the
  distance-field radius, `max(buffer, min(ceil(radius * (1 - cutoff)), floor(maxCanvasWidth / 2 - fontSize)))`,
  instead of the fixed `buffer` (default 4). With the defaults (`radius` 12, `cutoff` 0.25) the field
  needs 9 px, so outlines (`outlineWidth`) were clipped at the glyph frame. Rigi's roll map place names
  (`src/lib/terroir/roll/roll-map-extras.ts`, `fontSettings: {sdf: true}`, `outlineWidth: 3`) use
  this. It is backend-agnostic. Shipped files that differ from rigi.0: `dist/text-layer/font-atlas-manager.{js,d.ts}`,
  `dist.webgl-only/text-layer/font-atlas-manager.js` and the two `index.cjs` bundles of layers.
- What changed in core/layers src versus rigi.0 (base `ce0808d0` to `35854250`): nothing. `git diff ce0808d01 35854250b -- modules/core modules/layers modules/extensions`
  is empty (the master commits in between touch maplibre and pydeck/jupyter only), so the core
  `dist/` and `dist.webgl-only/` files are byte-identical to rigi.0's except for the version string.
- Gate: `git grep -nE "import \{[^}]*\b(vec[234]|mat[34])\b[^}]*\} from '@math.gl/core'" modules/`
  returns nothing.
- deck 9.4.0 final (tag `v9.4.0` = `5eded84b438eef83387dc6579c51670389053602`, 2026-09-05, branch `9.4-release`)
  is not used: it is built on luma.gl 9.4 and cannot run on luma 10. `git log ce0808d01..v9.4.0 -- modules/core/src modules/layers/src`
  is empty, and our base is a strict superset of it in those directories (it additionally has #10657, #10713,
  #10731, #10738). The only things 9.4.0 final has that we lack are version bumps, docs, a
  `peerDependencies` change and the luma 9.4 bump, so there is nothing to take from it.
- Built against `@luma.gl/*@10.0.0-alpha.2` (Rigi installs `10.0.0-alpha.2-rigi.3`), `@math.gl/*@5.0.0-alpha.9`,
  `@loaders.gl/*@5.0.0-alpha.7` (the deck repo lockfile).

## Manifest ranges

Kept from the deck repo and checked with `semver.satisfies`:

- `@luma.gl/*`: `^10.0.0-alpha.2` (core's dependencies) and `~10.0.0-alpha.2` (layers' peers).
  `10.0.0-alpha.2-rigi.3` (and `-rigi.2`) satisfy both: they are prereleases of `10.0.0` on the same
  `[10,0,0]` tuple that sort after `alpha.2`.
- `@math.gl/*`: `^5.0.0-alpha.9`; `5.0.0-alpha.9` and `5.0.0-alpha.10` both satisfy it.
- `@loaders.gl/*`: `^5.0.0-alpha.7`.
- `@deck.gl/core` in layers' `peerDependencies`: exactly `9.4.0-rigi.1`.

## Licence

MIT, Copyright Vis.gl contributors: see `LICENSE` in this directory (verbatim from upstream deck.gl).

## Checksums (SHA-256)

```
63941e5d612297d8d555515f07f8fd074ae920e941c14b066bad2d0d70bec9d6  vendor/deck/deck.gl-core-9.4.0-rigi.1.tgz
4bd142dbccc674611ad7a49b973b079b1767676efe3b6504871ef61c0477373c  vendor/deck/deck.gl-layers-9.4.0-rigi.1.tgz
```

## Contents

Only `dist/` (full build, used by the WebGPU lab `scripts/deck-webgpu/vite.webgpu.config.ts`),
`dist.webgl-only/` (the `visgl:webgl-only` export condition the app's `vite.config.ts` selects),
`package.json` and `README.md`. `src/` and all `*.map` files were stripped (and the
`//# sourceMappingURL=` comments removed) to keep the tarballs small (core 516450 B + layers 264533 B,
previously 516613 B + 264014 B).

## Rebuild

```sh
git clone https://github.com/visgl/deck.gl deck-src && cd deck-src
git fetch origin master pull/10752/head:pr-10752 pull/10780/head:pr-10780
git checkout -b rigi1 35854250bd3e54fe6926769191639848890b0397
git merge --no-edit pr-10752          # 0d8b1664...; CONFLICT test/modules/extensions/path.spec.ts only
git show 620e849c75c5ed1527455245f0b93b4161f3f204:test/modules/extensions/path.spec.ts > test/modules/extensions/path.spec.ts
git add test/modules/extensions/path.spec.ts && git commit --no-edit
# the 5 WebGPU hunks (needs the old rigi.0 commit in the clone, or apply luma's patch lines 404-472 and
# 487-506 with the paths prefixed by modules/core/):
git cherry-pick f1bc66cede34768f6c10fa15681119bc669a2efb
git merge --no-edit pr-10780          # 5b51fb26...; clean
git rev-parse HEAD                    # 4a2223f3c993bc1c41114d33d130b05769d84672
git grep -nE "import \{[^}]*\b(vec[234]|mat[34])\b[^}]*\} from '@math.gl/core'" modules/   # must be empty
npx yarn@1.22.19 install --ignore-scripts --frozen-lockfile
npx yarn@1.22.19 build                # must include the dist.webgl-only build
mkdir -p /tmp/deck-tgz
for m in core layers; do
  (cd modules/$m && npm pack --ignore-scripts --pack-destination /tmp/deck-tgz)
done
# slim and rewrite: drop src/ and source maps, set the version, fix manifests, then repack
for m in core layers; do
  mkdir -p /tmp/deck-slim/$m && tar xzf /tmp/deck-tgz/deck.gl-$m-9.4.0-beta.4.tgz -C /tmp/deck-slim/$m
  (cd /tmp/deck-slim/$m/package && rm -rf src && find . -name '*.map' -delete \
    && grep -rl 'sourceMappingURL=' dist dist.webgl-only | xargs sed -i '' -E '/^\/\/# sourceMappingURL=.*$/d' \
    && grep -rl '9\.4\.0-beta\.4' dist dist.webgl-only | xargs sed -i '' 's/9\.4\.0-beta\.4/9.4.0-rigi.1/g' \
    && node -e '
const fs = require("fs");
const p = JSON.parse(fs.readFileSync("package.json"));
p.version = "9.4.0-rigi.1";
delete p.devDependencies; delete p.scripts; delete p.gitHead;
for (const k of ["dependencies", "peerDependencies"]) {
  if (p[k] && p[k]["@deck.gl/core"]) p[k]["@deck.gl/core"] = "9.4.0-rigi.1";
}
fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n");' \
    && npm pack --ignore-scripts --pack-destination <repo>/vendor/deck)
done
# in <repo>: point package.json at deck.gl-{core,layers}-9.4.0-rigi.1.tgz, delete the two old tarballs, then
npm install
git diff package-lock.json            # new file: names/versions and integrity hashes
```

(`sed -i ''` is the BSD/macOS form; use `sed -i` on GNU. `<repo>` is the Rigi checkout.)
