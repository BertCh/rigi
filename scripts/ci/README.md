# Regression gate (roadmap N1)

One runner for every check the repo already had. It works with any number of concurrent sessions on
the tree and never changes app behaviour.

```sh
node scripts/ci/run.mjs fast                  # ~30 s: tsc, biome ratchet, ~34 node/tsx unit checks (36 fast ids, 4 full)
node scripts/ci/run.mjs full                  # + browser: style-baseline, deck smoke, eval-app, eval-app-deck (~minutes)
node scripts/ci/run.mjs full --only deck-smoke,style-baseline
node scripts/ci/run.mjs fast --skip concord-occl --jobs 8
node scripts/ci/run.mjs --list                # every check id, tier, command and untracked inputs
node scripts/ci/install-hook.mjs              # OPTIONAL pre-push hook (fast tier); not installed by default
```

The runner exits 1 if any check is `FAIL` and 0 otherwise. Each run prints a table of check, tier,
status, time and note. Logs go to `out/ci/logs/<id>.log` and a JSON summary to `out/ci/last-run.json`.

| status | meaning | fails the gate |
|---|---|---|
| PASS | exit 0, gate satisfied | no |
| FAIL | new failure (or a known one under `--strict`) | **yes** |
| KNOWN | fails, but matches the baseline in `known-failures.json` | no |
| FIXED | listed as known but passes now. Delete it from the baseline | no |
| SKIP | a gitignored input it needs (`data/`, `public/photos/`, `out/…`) is missing, e.g. in CI | no |

## Checks

| id | tier | what it guards | command |
|---|---|---|---|
| tsc | fast | types across `src/`, `scripts/`, `tools/` (this includes `src/lib/renderer.check.ts`: the deck engines satisfy `Renderer`) | `tsc --noEmit --pretty false` |
| biome | fast | lint + format + import order, as a per-file ratchet | `biome check --reporter=json <files>` |
| style-check | fast | CLASSIC style = today's constants, ramps, presets, `?style=` | `scripts/style-check.ts` |
| labels | fast | peak labels: classic byte-identical, no overlaps | `src/lib/look/__tests__/labels.check.ts` |
| haze-fit | fast | `fitHaze` recovers J, A, β | `src/lib/look/__tests__/haze-fit.test.ts` |
| haze-tail | fast | the GPU haze fit's CPU tail (`hazeFitTail`) equals `fitHaze` bit for bit on 16 synthetic scenes; `pathFrom` = `atmPath`, `robustSkyExact` = `robustSky`; one-ULP teeth (no GPU) | `src/lib/gpu/look/haze-tail.check.ts` |
| bridge-fusion | fast | WAG W1.2 settle fusion: mask texture pool and prepared-masks adoption rules (no GPU) | `src/lib/deck-webgpu/compute-bridge-fusion.check.ts` |
| annotate-selftest | fast | `solveFromControlPoints` (output `FAIL` counts, since it always exits 0) | `scripts/annotate-selftest.ts` |
| eye-check | fast | pose6dof eye refinement, analytic ridge | `src/lib/pose6dof/eye.check.ts` |
| pose6dof | fast | pose6dof solvers + real control points (`--quick`) | `scripts/test-pose6dof.ts` (needs `data/`) |
| refine-test | fast | refine Jacobians, FFT, synthetic recovery | `scripts/refine-test.ts` |
| ingest | fast | GPU Terrarium decode arithmetic: f32 twin bit-equal to `decodeTerrarium` over all 2^24 RGB, f32-exact partials, ingest layout math; the tile kernel (flag `terrainGpuDecode`: decode + 2× downsample + stats) twin bit-equal to `decodeTerrarium` + `downsampleHeights2` + `heightStats`, its out-of-range count equal to `validateTile`'s fills. The browser byte/height gate is `scripts/gpu/terrarium-ingest-check.mjs` (not in the registry) | `src/lib/gpu/ingest/ingest.check.ts` |
| cpu-heights | fast | Lazy CPU heights view (WAG W2.4, `dem/cpu-heights.ts`): `getCpuHeights` materialises once; `heightStats` equals the batch-grid and colour-ramp scans it replaces; batch grid from stats equals from heights; lazy `TerrainSet` queries equal eager ones; downsample plumbing equals the old loop | `src/lib/dem/cpu-heights.check.ts` |
| height-gather | fast | GPU height gathers (WAG W2.4, `deck-webgpu/height-gather.ts`, flag `terrainGpuDecode`): `gridCorners` + `blendCorners` equal `sampleGrid`; plan, emulated kernel and finish equal `TerrainSet.heightAt` bit for bit on eager, lazy and non-resident tiles; a bad nonce, a failed run or a changed slot falls back to `heightAt`; `replayHeights` over `buildTrailSegments` and `localMaxOf` equals the direct calls | `src/lib/deck-webgpu/height-gather.check.ts` |
| kernel-binding-use | fast | every `defineKernel` spec (src/lib/gpu, src/lib/deck-webgpu): spec.layout agrees with the WGSL `@group(0) @binding` declarations and every declared binding is referenced from the entry point or a helper it calls (a phony `_ = name;` counts), since luma's 'auto' layout drops unused bindings and Dawn rejects the bind group (4d92d3f). Kernels built inside functions and raw `createComputePipeline` callers are not covered | `scripts/gpu/kernel-layout-check.mjs` |
| terrain-cull | fast | batched-terrain GPU cull (WAG W1.5): the f32 twin of the WGSL frustum test keeps every sphere the CPU `sphereInView` keeps (random + on-plane ± ε spheres), compaction order = `visibleRows`' groups, WGSL binding layouts. The browser pixel gate is `scripts/deck-webgpu/terrain-indirect-check.mjs` (not in the registry) | `src/lib/deck-webgpu/layers/terrain-cull-math.check.ts` |
| export | fast | export/interchange (XMP, GeoJSON, KML, COLMAP…) | `scripts/test-export.ts` (needs `public/photos/`) |
| splat-loaders / -ext | fast | splat loaders: `.splat-v1` round trip, PLY; SPZ (v2/v3/v4) and KSPLAT (levels 0/1) through `@loaders.gl/splats` on hand-built fixtures | `src/lib/nearfield/splat-loaders*.check.ts` |
| nearfield-core / -export / -generate / -spot / -eyes / -propagate, splat-sort | fast | Step Inside core; generated splats never exported; propagation parity with Python; depth sort | `src/lib/nearfield/**`, `tools/nearfield/propagate/propagate.check.ts`, `scripts/nearfield/splat-sort-test.ts` |
| tiles3d | fast | 3D Tiles source-agnostic layer (datum, tile selection) | `src/lib/tiles3d/tiles3d.check.ts` |
| photoprep | fast | GPU photo prep path (`4 100000` args) | `src/lib/gpu/photoprep/photoprep.check.ts` |
| photoprep-resident | fast | Photo prep residency: lazy CPU read, memo, pins, LRU, device mismatch (fake device) | `src/lib/gpu/photoprep/resident.check.ts` |
| align-cert | fast | Certified-f32 align refine in emulation: AlignResult bit-identical to autoAlign, runtime checks catch a broken bound | `src/lib/gpu/align/cert.check.ts` |
| gpu-clear-lint | fast | ComputeGraph clear lint: the partial/atomic rule and the GPU-condition rule (same gate, command rewrite, unaudited nodes, whole clears) | `src/lib/gpu/core/clear-lint.check.ts` |
| gpu-inspect | fast | graph inspection (`gpu/core/inspect.ts`, `inspector.ts`): stats / preflight / inspector-sample summary, observation through the upstream `GPUCommandGraphInspector`, `getGpuGraphProfile`, device-loss cleanup (fake device, no GPU) | `src/lib/gpu/core/inspect.check.ts` |
| app-graph | fast | app graph manifest ↔ code: every `cachedGraph` group in `src/lib/gpu/**` and `src/lib/deck-webgpu/**` is declared in `gpu/app-graph/manifest.ts` and vice versa; island ids, unique ids, paths | `src/lib/gpu/app-graph/app-graph.check.ts` |
| app-graph-table | fast | `research_notes/whole-app-graph-2026-10-01/islands.generated.md` matches the manifest (regenerate with `--write`) | `scripts/gpu/app-graph-table.ts --check` |
| ieee-probe | fast | shared certified-f32 arithmetic (`gpu/precision`): df32 ops within budget, strict-IEEE probe verifier accepts the emulated machine and rejects broken ones | `src/lib/gpu/precision/ieee-probe.check.ts` |
| horizon-cert | fast | certified-f32 horizon stages on the f32 emulation: 0 false certifications, finished output bit-identical to the f64 path, probe verifier; DEM cases when `out/gpu/horizon-cert/real-cases.json` exists (`scripts/gpu/horizon-cert-cases.ts`) | `src/lib/gpu/horizon/certified.check.ts` |
| examples | fast | `examples/` type check (`scripts/examples.mjs check`) | `node scripts/examples.mjs check` |
| ontology | fast | ontology layer: provenance axes, crosswalks | `src/lib/ontology/ontology.check.ts` (needs `public/photos/`) |
| atlas | fast | `/atlas` graph data | `src/lib/atlas/atlas.check.ts` |
| terroir-labels / -viz / -roll / -pack | fast | terroir cartography: labels, viz, roll, packs | `src/lib/terroir/*/*.check.ts`, `scripts/terroir/pack.check.ts` |
| geocam-map / -priors / -lakes / -integrity | fast | geometry-first pose modules (flags off by default) | `src/lib/geocam/*/*.check.ts` |
| concord-core / -priors / -cues / -app / -occl | fast | concordance modules kept after the 2026-09-30 cleanup (synthetic, offline). The joint, warp and re-match checks went with their code (a1845f5) | `src/lib/concord/*/*.check.ts` |
| cog-reader | fast | the loaders.gl COG reader (`cogReader=loaders`) vs the own one on real swissSURFACE3D / swissALTI3D COGs under the Swiss dev photos: headers equal, windows bit-identical, `loadNearDsm` grids identical without a byte budget; request / byte counts per reader. Needs `.cache/swiss-cog/` (filled by one networked run, then offline); SKIPs without it | `src/lib/concord/occl/cog-reader.check.ts` |
| cache-range | fast | tile cache HTTP byte ranges: one entry per url + range, memory repeats, shared in-flight requests, 200-ignoring servers sliced (mocked server) | `src/lib/cache/range.check.ts` |
| style-baseline | full | **classic pixel identity + geometry hash** on the WebGL deck route (`?renderer=deck`, SwiftShader). No `?style`/`?concord` flag is set, so this row is also the **concord-off parity** gate. **Needs a deck reference** (see below); SKIPs until one exists | `scripts/style-baseline.mjs check --url …` |
| deck-smoke | full | `?renderer=deck` (WebGL, reference) vs `?renderer=webgpu` parity: \|Δyaw\| ≤ 0.5°, label overlap ≥ 0.6 | `scripts/deck-engine-smoke.mjs --url … --out out/ci/… --renderer webgpu` |
| settle-submits | full | WAG W1.2 settle fusion (`?renderer=webgpu` pinned): masks + band stats byte-identical with `settleFusion` off / on; submits per settle and settle-to-labels latency reported, not gated | `scripts/deck-webgpu/settle-submits.mjs IMG_7086 --url … --renderer webgpu` |
| graph-plumbing-ab | full | WAG graph plumbing (`--renderer webgpu` pinned): silhouette-gpu, geo-query-gpu and splat-sort on core ComputeGraphs vs a replica of their former raw dispatches; read-backs and order buffers byte-identical, timing reported, not gated | `scripts/gpu/graph-plumbing-ab.mjs --url … --renderer webgpu` |
| eval-app | full | app auto-alignment vs control points on the default engine (`--renderer webgpu`). Gate: `N/M within 1° yaw` ≥ `evalAppWebgpu.minWithin1deg`; advisory until that baseline exists | `scripts/eval-app.mjs --renderer webgpu` (`APP_URL=…`) |
| eval-app-deck | full | the same accuracy run on the WebGL deck fallback (`--renderer deck`) | `scripts/eval-app.mjs --renderer deck` |

Full-tier checks run one at a time through `node scripts/gpu/with-render-lock.mjs -- …`. That wrapper
waits for the machine-wide render lock and for memory headroom, and the wait counts against the check's
timeout. The runner starts its own `vite dev --port 3130 --strictPort`, which gets its own dep cache
`node_modules/.vite-3130` (see `vite.config.ts`), and stops it at the end. If something already answers
on that port, the runner reuses it. `--url http://localhost:3100` uses an existing server instead.

Left out on purpose:
- `scripts/gpu/*` benches and parity checks: they need a GPU and dumped fixtures, and they are research
  checks, not a gate.
- `scripts/nearfield/*.mjs` browser labs: long, and they need the near-field service on :8767.
- `tools/nearfield/service/selftest.py`: needs the Python env.
- `occl.check.ts --live`: network.

Any of these can be added to `checks.mjs` as another entry.

## Known-failures baseline (`known-failures.json`)

The gate compares each run against this baseline. It does not demand zero: pre-existing failures that
belong to other owners are recorded here, and only new ones fail. Fix the cause, then delete the entry.
Don't add an entry just to get your own change through.

Baseline as of 2026-09-29, taken while the shared tree was being edited concurrently:

| check | known failure | where |
|---|---|---|
| style-check | `TypeError: ctx.save is not a function` at `src/lib/look/labels/canvas.ts:95` (`drawPeakLabels` is called from `scripts/style-check.ts:1126` with a stub ctx). Fails locally and in CI | look/labels + style owners |
| tsc (CI only) | `src/lib/roll/roll.ts` imports `../../../data/ground-truth.json`, and `data/` is gitignored, so a fresh clone can't typecheck (or build) that module. Tolerated only when `CI=1` (`tsc.ciAllowed`). Locally tsc is clean | roll owner. Move the GT JSON into a tracked path, or load it at runtime |
| biome | 79 errors in 64 files (54 of them `organizeImports`, then `noAssignInExpressions`, format…). `biome.errors` stores a per-file count, and the gate fails only when a file has **more** errors than its baseline or a new file has any | everyone. `npx biome check --write <file>` on files you own |
| pose6dof, export | SKIP in CI: they read gitignored `data/` and `public/photos/`. They run locally | n/a |
| style-baseline, deck-smoke, eval-app | Not run in CI: they need the photos, DEM tiles over the network, and the stored ~10 MB pixel baseline | n/a |

To update the baseline, run `node scripts/ci/run.mjs full --biome all --update-baseline`. It rewrites
`biome.errors` (only with `--biome all`) and, for each eval-app row that ran, `evalAppWebgpu` / `evalAppDeck`:
`minWithin1deg` becomes the observed count minus one (noise margin), `lastObserved` records the run, and
other hand-written fields (`note`) are kept. Review the diff before keeping it: a bad run lowers the
minimum. To record only the deck baseline, add `evalAppDeck` by hand (observed − 1) rather than
rerunning `--update-baseline` over everything. The `checks` and `tsc` entries are edited by hand.

`eval-app-deck` (eval-app with `--renderer deck`, the default renderer) runs in the full tier and
gates like `eval-app` against `evalAppDeck`. Without an `evalAppDeck` entry it would be advisory: every
failure, including a crash, a timeout or an engine mismatch, reports KNOWN and does not fail the gate.

`eval-app` metrics are noisy from run to run (background second opinion, tile timing), so
`minWithin1deg` is set a little below the observed count. See `evalAppDeck` in the JSON for the last
observed value.

### three.js renderer removed (2026-10-01)

The three.js PhotoEngine (`?renderer=three`) is gone, and the rows that pinned it were retargeted:

- `eval-app` now pins `--renderer webgpu` (the app default) against a new `evalAppWebgpu` key. The old
  `evalApp` minimum (a three.js number) was deleted, so the row is advisory until a webgpu run records
  `evalAppWebgpu` (`--update-baseline`, or by hand: observed − 1).
- `deck-smoke`'s reference arm is the WebGL deck instead of three.js, compared with WebGPU.
- `style-baseline` runs `?renderer=deck`. **Its reference must be recaptured on deck before the classic
  pixel check means anything again.** The three.js-era baseline stays in `out/lead/style-baseline`
  (untouched); the harness now defaults to `out/lead/style-baseline-deck`, which starts empty, so the row
  SKIPs until someone captures it once, deliberately, on a tree whose classic look is known good:

  ```sh
  node scripts/gpu/with-render-lock.mjs -- node scripts/style-baseline.mjs capture --url http://localhost:3100
  ```

  `check` refuses a `baseline.json` that does not say `"renderer": "deck"`.

## Biome scope

- `--biome all` checks every tracked file plus untracked files that aren't gitignored. This is the default under `CI=1` and in the workflow.
- `--biome changed` checks only files that differ from `merge-base(HEAD, upstream or origin/master)`, plus untracked files. This is the local default and what the hook uses.

Both scopes skip gitignored trees such as `tools/research/tm/.pylib*`. Plain `npx biome check .` does
not skip them, because `biome.json` has `vcs.enabled: false`.

## CI

`.github/workflows/ci.yml` runs `node scripts/ci/run.mjs fast --biome all` on push and PR, with
Node 22 (the repo pins nothing; `@types/node` is ^22) and `npm ci`. Playwright browsers are not
downloaded. The logs are uploaded as the `ci-logs` artifact.

To simulate a fresh checkout locally, copy `git ls-files -co --exclude-standard` into a scratch dir,
symlink `node_modules`, and run `CI=1 node scripts/ci/run.mjs fast` there.

## Pre-push hook (optional)

`node scripts/ci/install-hook.mjs` writes `.git/hooks/pre-push`, which runs
`node scripts/ci/run.mjs fast --biome changed`. It won't overwrite another hook unless you pass
`--force`, `--uninstall` removes it, and `git push --no-verify` skips it once. Nothing installs the hook
automatically.

## First runs (2026-09-29)

These runs were on the shared working tree while other contributors had uncommitted edits in `src/`.

- **fast (local)**: 21 pass, 1 KNOWN (style-check), 1 FAIL (biome). The biome failure is new unformatted
  or unsorted-import code in files being edited concurrently (`src/lib/licences/attribution.ts`,
  `src/lib/dem/sources.ts`, `src/lib/deck/terrain-data.ts`, …). The gate caught it as designed, and it was
  left alone. About 27 s.
- **fast (fresh-checkout simulation, `CI=1`)**: tsc KNOWN (the gitignored `data/ground-truth.json`
  import), pose6dof and export SKIP, biome FAIL on the same in-flight files, everything else PASS.
- **full**:
  - deck-smoke: PASS.
  - eval-app: PASS, 12/14 within 1° yaw, median 6.5 px. This matches `reports/status.md`. The first
    attempt crashed inside Playwright's launch, which is why eval-app now retries once.
  - style-baseline: **FAIL**, 0/16 images identical, geometry hash identical. Diffs are 0.5–3.8% of
    pixels, along the draped map/overlay lines. The harness warned that `src/` changed during the run.
    At the time, the three.js engine, `terrain.ts`, `dem/sources.ts`, `deck/*` and `export/engine-export.ts`
    had uncommitted edits from concurrent work. It is not yet known whether this is a real classic-view
    regression from that work or remote-tile drift. Re-run `node scripts/ci/run.mjs full --only
    style-baseline` on a quiet tree and look at `out/lead/style-baseline/diff/`. It is deliberately
    **not** recorded as a known failure.
- **fast, re-run about 20 min later**: 20 pass, 1 KNOWN, 2 FAIL. Both failures come from new in-flight work
  by concurrent edits. tsc: `scripts/licences-check.ts:155-156` TS2352 (`OsmElement[]` cast to `{id:number}[]`).
  biome: format/import order in `src/lib/tiles3d/*`, `src/lib/concord/flags.ts`,
  `src/lib/deck/{engine,composite-shader}.ts`, `scripts/tiles3d/step-tiles-check.mjs` and
  `scripts/licences-check.ts`. The new peer checks (`scripts/licences-check.ts`,
  `scripts/tiles3d/step-tiles-check.mjs`) should be added to `checks.mjs` once their owners call them stable.
