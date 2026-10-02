# Vendored deck.gl (luma.gl 10 build), `9.4.0-rigi.3`

No published deck.gl release targets luma.gl 10 yet, so `@deck.gl/core` and `@deck.gl/layers`
are installed from these tarballs (`package.json`: `file:vendor/deck/<name>.tgz`).

**Swap to npm when deck publishes on luma 10**: point both deps at the published version,
delete this directory, and re-run `npm install`. The old `package.json` override
`"@deck.gl/core": "$@deck.gl/core"` is gone with rigi.1: the layers manifest peers `@deck.gl/core` at
the exact version `9.4.0-rigi.3`, which is what the core tarball is, and the install prints no peer
warning. (It only existed because `@deck.gl/layers@9.4.0-beta.4` peered `@deck.gl/core@~9.4.0`, which a
prerelease does not satisfy.) If a published deck brings that peer mismatch back, restore it. luma itself is vendored too
(see `vendor/luma/README.md`), with fixed manifests, so there is no `.npmrc` and no luma override;
the one remaining override, `@math.gl/types`, is explained there.

## Version

`9.4.0-rigi.3` (rigi.2 and rigi.1 before; `9.4.0-beta.4` is the repo's own version string). The version is changed in the packed manifests and in the two
places where core embeds it (`dist/lib/init.js` and `dist/index.cjs`, and the same two files in
`dist.webgl-only/`), so `deck.VERSION` and the init log line report `9.4.0-rigi.3`. The deck repo
itself was not modified for this: the rewrite happens in the slim step below. The old `gitHead`,
`scripts` and `devDependencies` fields are dropped from the packed manifests.

## Source

**rigi.3 (2026-10-02, luma rigi.6 wave).** Build commit `78469b7dda30d747c35aca18d241eb7f1c393ad6` (branch
`rigi3`, unofficial local build; bundle `~/mt-image-archive/2026-10-02-rigi6/deck-rigi3.bundle`): the rigi.2
build commit `0c7f7cdd` plus `--no-ff` merges of
- #10751 head `98dbf01f7` (`98dbf01f…`, "TerrainExtension: add WebGPU height-map fitting") as `8c1634dc1`. One
  conflict, `docs/whats-new.md` (not shipped): both sides kept. It also touches core (`deck.ts`,
  `layer-manager.ts`, `layer.ts`, `pick-layers-pass.ts`, shaderlib) and the layers' WGSL
  (`deckgl_filter_position` hooks in arc, bitmap, column, icon, line, path, point-cloud, scatterplot,
  solid-polygon, multi-icon, text-background), so core and layers changed;
- #10783 head `71ffa8543` ("let TerrainExtension layers follow external terrain") as `78469b7dd`. Real
  conflicts with #10751 in `extensions/src/terrain/{height-map-builder,shader-module,terrain-effect}.ts`:
  resolved as the union (#10783's bounds padding before #10751's WebGPU height range, local renamed
  `heightPadding`; both new TerrainModuleProps fields; both setup lines). Unresolved semantic gap: the WGSL
  terrain module (#10751) has no `USE_HEIGHT_MAP_METERS` branch and encodes heights as RGBA8 float bytes,
  so #10783's external terrain (meters in the red channel) works on WebGL only.
`@deck.gl/extensions` is NOT vendored: nothing in the app imports TerrainExtension (see the coordinator
README of this wave for why no layer was wired). The other vendored PR heads (#10780, #10779, #10778,
#10782, #10753, #10776, #10751, #10783) had not moved on 2026-10-02 and are all open; #10752's head moved the
same day to `43a38d6b9b5988c7a84407d5951fdb9a16671f48` (2026-10-02T17:31Z, "Merge master into alpha dependency
upgrade": it merges deck master `d1b0ae43` into the PR branch; its own six commits, up to `0d8b1664`, are
unchanged, and the `modules/` differences from the old head are master commits already in our base `35854250`;
the PR is open, no longer a draft, and now titled "chore: Bump luma.gl, math.gl, and loaders.gl prereleases to
5.0.0-alpha"; rigi.3 still carries `0d8b1664`, not re-vendored). `node scripts/upstream/luma-watch.mjs` reports
the live head of every vendored deck PR. Deck master is `d1b0ae43` (docs only since the base). Not taken: #10627 (worker SplatLayer: an example under
`examples/experimental/gaussian-splats`, not a module); #10682 (device reuse on an external `gl`: Rigi
never passes `gl`); globe / custom projection / maplibre / pydeck / website PRs (#10670, #10697, #10698,
#10737, #10740–#10745, #10749, #10750, #10669 …): no Rigi use. Built with `npx yarn@1.22.19 build`
(92 s), slimmed and re-versioned exactly as below with `9.4.0-rigi.3`.

### rigi.2

**Re-checked 2026-10-02 (luma rigi.5 bump): no change, no rebuild.** The heads of #10752 (`0d8b1664`), #10780
(`5b51fb26`), #10779 (`d86a3ab9`), #10778 (`2dad1145`), #10782 (`a6cfed18`), #10753 (`3a946828`) and #10776
(`0a86e725`) have not moved (`gh api repos/visgl/deck.gl/pulls/<n> --jq .head.sha`) and all are still open.
deck master moved from the base `35854250` to `d1b0ae43` by one commit, "docs(pydeck): add multi-view and
SplitterWidget examples and docs (#10655)", which touches nothing under `modules/core` or `modules/layers`
(`gh api repos/visgl/deck.gl/compare/35854250...d1b0ae43`). The rigi.2 tarballs run unchanged on luma
`10.0.0-alpha.2-rigi.5` (its additions are new optional props/arguments; the deck manifest ranges below match).

Built from a local merge of deck PR #10752 into current deck master, plus luma.gl's deck WebGPU
fixes and deck PR #10780 (rigi.1), plus the five PRs below (rigi.2):

- Repo: https://github.com/visgl/deck.gl
- Build commit (rigi.2): `0c7f7cddb8d6bc7151823107a52f34c3e0bec5cc` (branch `rigi2`, an unofficial local
  build, not an upstream release or commit; bundle `deck-rigi2.bundle`). It is the rigi.1 build commit
  `4a2223f3c993bc1c41114d33d130b05769d84672` (branch `rigi1`) plus `--no-ff` merges, in this order, of
  (heads fetched with `git fetch origin pull/<n>/head`):
  - #10779 head `d86a3ab929594ad6545cc250cef02f8073e3741a` (`c0ea1e225`): "Add optional version-based
    invalidation for BinaryAttribute". Clean;
  - #10778 head `2dad114589f73303e0fa4414743b9729d9932944` (`401178951`): "Add experimental `_onFrameTimings`
    prop" (`frame-timer.ts`, `layers-pass.ts`, `deck.ts`). One conflict, `docs/whats-new.md` (not shipped):
    both sides kept;
  - #10782 head `a6cfed18762545b15ace332418752f0c1ef40559` (`13f30b1de`), a DRAFT: "honor Deck GPU debug option
    during device initialization" (`debug: props.debug` forwarded to `webgl2Adapter.attach` and
    `_createDevice`, `deviceProps.debug` still wins). Conflicts in `docs/api-reference/core/deck.md`,
    `modules/core/src/lib/deck.ts` (comment only) and `test/modules/core/lib/deck.spec.ts` (imports):
    resolved by keeping master's wording and the union of imports;
  - #10753 head `3a946828a368b7e3610dbaf943faa6e04b4bb8fb` (`4291bff5e`): "pad unaligned 8/16-bit attributes on
    WebGPU upload" (`attribute/gl-utils.ts`, `data-column.ts`). Clean. An external luma `Buffer` that
    needs padding throws a descriptive error (deck cannot repack it on the CPU);
  - #10776 head `0a86e725bbb6f2a86bee76b0cc8d6ddf4c706745` (`0c7f7cddb`): "match WebGL external float64 buffers
    on WebGPU" (`gl-utils.ts` `ZERO_LOW_BUFFER_NAME`/`mergeZeroLowBufferLayouts`, `data-column.ts`,
    `attribute-manager.ts`, `gpu-transition.ts`). Conflicts in `attribute-manager.ts`, `data-column.ts`,
    `gl-utils.ts` were import lists only (union kept). No PR was dropped.

  Behaviour notes (rigi.2): `Deck` gains the experimental `_onFrameTimings` prop and `deck.debug` /
  `deviceProps.debug` reach the device at init (#10782: with `debug: true` the optional `@luma.gl/webgl/debug`
  import is what actually loads the tools; since rigi.3 Rigi sets it under `?deckDebug=on`). On WebGPU, 8/16-bit vertex attributes are
  padded to 32-bit-aligned formats on upload, and an external luma `Buffer` that would need such padding
  throws instead of rendering garbage (#10753); external float64 buffers (`isDoublePrecisionBuffer`) are read
  as high parts with a shared zero low buffer (#10776); `BinaryAttribute` accepts an optional `version` for
  invalidation (#10779). Since rigi.3 Rigi wires `_onFrameTimings` (under `?gpuFrameTimings=on`, `src/lib/deck-webgpu/frame-timings.ts`) and `debug` (`?deckDebug=on`) on both engines' Deck; it has no in-place-rewritten deck binary attribute for `version` (#10779) to serve, and the #10753 / #10776 paths stay unused.

  All five PRs are still open upstream (#10782 is a draft). rigi.1 is composed as follows:
  - Build commit (rigi.1): `4a2223f3c993bc1c41114d33d130b05769d84672` (branch `rigi1`). It is the merge of PR #10780 on top of the WebGPU cherry-pick,
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
- Built against `@luma.gl/*@10.0.0-alpha.2` from the deck lockfile (Rigi installs `10.0.0-alpha.2-rigi.5`; the build does not use the rigi luma, same as rigi.1), `@math.gl/*@5.0.0-alpha.9`,
  `@loaders.gl/*@5.0.0-alpha.7` (the deck repo lockfile).

## Manifest ranges

Kept from the deck repo and checked with `semver.satisfies`:

- `@luma.gl/*`: `^10.0.0-alpha.2` (core's dependencies) and `~10.0.0-alpha.2` (layers' peers).
  `10.0.0-alpha.2-rigi.6` (and `-rigi.5`, `-rigi.4`, `-rigi.3`, `-rigi.2`) satisfy both: they are prereleases of `10.0.0` on the same
  `[10,0,0]` tuple that sort after `alpha.2`.
- `@math.gl/*`: `^5.0.0-alpha.9`; `5.0.0-alpha.9` and `5.0.0-alpha.10` both satisfy it.
- `@loaders.gl/*`: `^5.0.0-alpha.7`.
- `@deck.gl/core` in layers' `peerDependencies`: exactly `9.4.0-rigi.3`.

## Licence

MIT, Copyright Vis.gl contributors: see `LICENSE` in this directory (verbatim from upstream deck.gl).

## Checksums (SHA-256)

```
b6a8c84398793b39433bff585475d3bf29de3f31ee77e6b96fe4804c20a79f25  vendor/deck/deck.gl-core-9.4.0-rigi.3.tgz
5aa63a8150456bdbfc3325f07579b95d5dd6fde8608bdfa8fe32e2ee301027a7  vendor/deck/deck.gl-layers-9.4.0-rigi.3.tgz
```

## Contents

Only `dist/` (full build, used by the WebGPU lab `scripts/deck-webgpu/vite.webgpu.config.ts`),
`dist.webgl-only/` (the `visgl:webgl-only` export condition the app's `vite.config.ts` selects),
`package.json` and `README.md`. `src/` and all `*.map` files were stripped (and the
`//# sourceMappingURL=` comments removed) to keep the tarballs small (rigi.3: core 537420 B + layers 264820 B; rigi.2 had 536539 B + 264533 B,
rigi.1 had 516450 B + 264533 B).

## Rebuild

```sh
git clone https://github.com/visgl/deck.gl deck-src && cd deck-src
git fetch origin master pull/10752/head:pr-10752 pull/10780/head:pr-10780
# fastest for rigi.3: git fetch <archive>/2026-10-02-rigi6/deck-rigi3.bundle rigi3 (78469b7d); rigi.3 = rigi.2 + merge pr10751, pr10783 (see Source).
# fastest for rigi.2: git fetch <archive>/deck-rigi2.bundle rigi2 and check it out (0c7f7cdd); from scratch, build rigi1 as below, then
# git checkout -b rigi2 && for n in 10779 10778 10782 10753 10776; do git fetch origin pull/$n/head:pr$n; git merge --no-ff --no-edit pr$n; done
# (conflicts: docs/whats-new.md both sides; deck.md, deck.ts comment and deck.spec.ts imports take master's wording + union of imports;
#  attribute-manager.ts/data-column.ts/gl-utils.ts import lists take the union)
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
B=<scratch dir>; mkdir -p $B/deck-tgz
for m in core layers; do
  (cd modules/$m && npm pack --ignore-scripts --pack-destination $B/deck-tgz)
done
# slim and rewrite: drop src/ and source maps, set the version, fix manifests, then repack
for m in core layers; do
  mkdir -p $B/deck-slim/$m && tar xzf $B/deck-tgz/deck.gl-$m-9.4.0-beta.4.tgz -C $B/deck-slim/$m
  (cd $B/deck-slim/$m/package && rm -rf src && find . -name '*.map' -delete \
    && grep -rl 'sourceMappingURL=' dist dist.webgl-only | xargs sed -i '' -E '/^\/\/# sourceMappingURL=.*$/d' \
    && grep -rl '9\.4\.0-beta\.4' dist dist.webgl-only | xargs sed -i '' 's/9\.4\.0-beta\.4/9.4.0-rigi.3/g' \
    && node -e '
const fs = require("fs");
const p = JSON.parse(fs.readFileSync("package.json"));
p.version = "9.4.0-rigi.3";
delete p.devDependencies; delete p.scripts; delete p.gitHead;
for (const k of ["dependencies", "peerDependencies"]) {
  if (p[k] && p[k]["@deck.gl/core"]) p[k]["@deck.gl/core"] = "9.4.0-rigi.3";
}
fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n");' \
    && npm pack --ignore-scripts --pack-destination <repo>/vendor/deck)
done
# in <repo>: point package.json at deck.gl-{core,layers}-9.4.0-rigi.3.tgz, delete the two old tarballs, then
npm install
git diff package-lock.json            # new file: names/versions and integrity hashes
```

(`sed -i ''` is the BSD/macOS form; use `sed -i` on GNU. `<repo>` is the Rigi checkout.)
