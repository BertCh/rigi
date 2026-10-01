# visgl frontier sweep: luma, deck, loaders, math (2026-10-01, late)

*Archived 2026-10-01: its ranked plan was carried into [../whole-app-graph-plan.md](../whole-app-graph-plan.md) (WAG phases), and most items have landed; see the roadmap's WAG rows.*

This sweep follows `luma-deck-upstream-2026-10-01.md`. The goal is to express the whole app as a luma GPU graph, fed by loaders.gl, using the bleeding edge of the visgl stack.

**Method:**
- Blobless clones of all branches.
- Every branch with commits since 09-10, and every open PR updated since 09-12.
- `git merge-tree` against our vendored bases:
  - luma `rigi-vendor` 5e1b72ed
  - deck ce0808d0 + #10752 0d8b1664
- Four parallel review agents. Notes are in a local scratch directory (not published).

*Update (2026-10-01, later): item 1 is vendored as rigi.2 (c5b2aa1) and drives the GPU terrain cull's indirect draws (6d6160a); item 2's inspector and `/dev/graph` landed (927cb01); item 8 landed as the opt-in `?cogReader=loaders` (9d8a307); item 9's splat loaders landed (c388c48, 9d8a307), so `src/` now imports loaders.gl (`nearfield/splat-loaders*.ts`, `concord/occl/cog-loaders.ts`). The upstream asks stay local by the user's choice. Current state: the WAG rows in [roadmap.md](../roadmap.md).*

## Headline

1. **No new prereleases.**

   | Package | npm `beta` |
   |---|---|
   | luma | 10.0.0-alpha.2 |
   | deck | 9.4.0-beta.4 |
   | loaders | 5.0.0-alpha.7 |
   | math | 5.0.0-alpha.9 |

   luma master is still at 7d1d11e9. deck master is +1 (0ff7c3bf, a maplibre CJS change), which is irrelevant to us. Deck #10752 (luma 10 bump) is still a draft at 0d8b1664. It is the only deck branch that targets luma 10.
2. **The gpgpu "compiler" stack is already in our build.**
   - It is the `jarnevon/*` branches, about 25 of them dated 09-11.
   - Those branches are closed. Their content was squashed into master as #3233, #3237 and #3250, and then into alpha.2, so it is in rigi.1.
   - `@luma.gl/gpgpu` already exports `GPUProgram`, `GPUProgramCompiler`, `GPUConditionalOperation`, `GPULoopOperation`, `GPUIncrementalExecution`, `GPUCommandGraphAutotuner` and `GPUCommandGraphInspector`.
   - **Correction (API audit, same day):** `GPUScalar`, `GPUValueArena` and the dispatch gate are *internal*. They can only be reached through a `GPUProgramCompiler` compilation.
   - GPU conditions work on compute nodes only. The graph has no clear or read nodes.
   - See [whole-app-graph-plan.md](../whole-app-graph-plan.md) §1 and `research_notes/whole-app-graph-2026-10-01/upstream-api.md`.
   - The next level for us is *using* these. There is nothing new to vendor for them.
3. **Exactly one upstream change is worth vendoring now: luma #3328, `Model` drawIndirect.**
   - It lets a draw take a GPU-resident instance count.
   - It applies cleanly onto rigi-vendor.
   - It is the missing link between a GPU cull/compact node and a draw in the same graph.
4. **loaders.gl has no path that uploads to the GPU.** Every loader returns CPU typed arrays or Arrow. If we want "loaders feeding the graph", we write a thin adapter from a loader result to a luma `Buffer`/`Texture`. Today `src/` imports loaders.gl nowhere; it is only a peer of deck.

## Recommended architecture

Keep the upstream `GPUCommandGraph` as the single execution graph. Our `ComputeGraph` (`src/lib/gpu/core/graph.ts`) already wraps it. On top of it, add a thin semantic layer modelled on `GPUProgram`:
- Each Rigi stage (sky, horizon, solve, haze, look) becomes a registered lowering.
- Small results become `GPUScalar`s, with GPU indirect gates instead of CPU readbacks.
- Look passes and splat/terrain/trail draws join the same graph as render nodes. Their instance counts come from #3328 indirect draws.
- Loaders feed the graph through a `loader result → luma resource` adapter.

When upstream lacks something (texture-valued program values, our clear lint and read nodes), we add it to `GPUProgramCompiler` instead of forking a compiler. Posting upstream still needs the user's direct OK.

## Ranked plan

| # | Item | Source | Verdict | Notes |
|---|---|---|---|---|
| 1 | Model drawIndirect | luma #3328 (10-01, open) | **ADOPT-NOW: vendor as rigi.2** | Replaces CPU instance counts at `deck-webgpu/layers/splats.ts:765`, `trail.ts:328` and `batched-terrain.ts:731`. Opt-in, +136 lines in `model.ts`. API may change before merge. WebGL asserts. |
| 2 | GPUCommandGraphInspector + preflight (`fitsDeviceLimits`, workload bounds) | already in rigi.1 | **ADOPT-NOW** | Whole-app graph introspection. Extends `graph.ts` stats and `profile.ts`. Low risk. |
| 3 | GPU-side node conditions (`condition:{source:'gpu',mode:'indirect'}`; compute nodes only) | rigi.1 | PROTOTYPE | Our `KernelNode.condition` type blocks them today (WAG W0.1). Sketches show a GPU condition alone does *not* remove the haze overflow round trip: the copy size is still CPU-fixed, so it needs "copy capacity, map exact" (W0.5). The solve fold needs an exact TwoSum compare plus a per-device probe. |
| 4 | Render and copy nodes in the same graph | rigi.1 | PROTOTYPE | Our wrapper only exposes `addComputePass` (`graph.ts:362`). Look pipeline first, with aliased transients. Deck still owns the frame. |
| 5 | GPUScalar / GPUValueArena for small results | rigi.1 (internal, only via `GPUProgramCompiler`) | WATCH | Not exported. Program literals are baked at compile time, so there are no per-run inputs. An upstream ask (WAG-4). |
| 6 | GPUProgram with Rigi lowerings | rigi.1 | PROTOTYPE | Gives an operation tree and lowering report for the whole app. Limits: 1-D vectors and scalars only, no textures, and loops are unrolled up to `maximumIterations`. |
| 7 | Deck `_onFrameTimings` (per-pass GPU timestamps) | deck #10778 (10-01) | PROTOTYPE | Clean onto our deck base, and additive. Needs the `timestamp-query` feature on the render device. |
| 8 | GeoTIFF raster loader (numeric bands + geodetic metadata) | loaders #4088 (merged 09-30, unreleased) | PROTOTYPE | Could replace the hand-rolled range reads in `concord/occl/swiss-cog.ts:98-115`, with a float raster going to an `r32float` texture. COG range/overview support is unproven. |
| 9 | Splat loaders (SPZ/RAD/ksplat) + `deck-layers/splat/splat-engine.ts` | loaders master | PROTOTYPE | Adds import formats beside `nearfield/client.ts:97`. The engine is a reference for the sort. luma `modules/splats` (#2966, merged) already mixes compute and render nodes in one graph and is the reference pattern. |
| 10 | Shader hook validation / lazy assemblers | luma #3286, #3288 | WATCH | Before the next luma re-vendor, run our `inject:` sites (`terrain-layer.ts`, `world-view.ts`) and the `getDefaultShaderAssembler` callers (`splats.check.ts:276`, `tiles3d.check.ts:70`, `ridges.check.ts:509`). |
| 11 | WebGPU TerrainExtension fitting | deck #10751 | WATCH | Clean on master. Our terrain is custom, so this is only relevant if stock layers move onto deck's TerrainPass. |
| 12 | 3D Tiles parallel refinement / `@loaders.gl/tiles` traversal | loaders #4089 (draft) | WATCH | Candidate to replace `tiles3d/tiles.ts` traversal once merged. The geoid/frame handling stays ours. |
| 13 | proj4 vertical geoid grids | math.gl #164 (merged), #165 (open), unpublished | WATCH | No accuracy gain over `tiles3d/geoid.ts` (≤0.16 m). Usable as a test oracle. CPU only. luma `gpu-project` has no datum or height stages yet. |
| 14 | Luma look PRs (#3322 styled-paths, #3324 flow, #3321 glow, #3320 hatch, #3318 sketch, #3323 scene buffers) | luma 09-30 | WATCH | Example-heavy, and each conflicts 5–13 files with master. Use as references for looks, not as cherry-picks. |
| 15 | GPUVector-first layer family | luma #3169 | WATCH | The direction for the deck v10 layer core. +4.5k lines and conflicting. |

**IGNORE (with the reason):**
- deck #10779, #10776 and #10753: we build `Model`s directly, not through deck attributes.
- deck #10740–45 (alt-proj), #10749, #10750, #10669 and the globe series: we don't use those views.
- deck path-dash refactors: we have our own `trail-layer`.
- luma #3326 and #3132 dataframe work.
- loaders: terrain tessellator (CPU meshes), bundleless workers, Zarr, jsquash.
- math.gl #141.

## Cleanup found in passing

`@math.gl/polygon` and `@math.gl/web-mercator` have no imports in `src/`. Drop them after confirming deck/luma don't need them as peers.

## Branch inventory (dates of last commit)

- **luma:**
  - The jarnevon stack (09-11, closed; contents in master).
  - The codex look branches (09-30): styled-paths, sketch-strokes, scene-buffers, point-glow, pattern-fill, flow-advection, deck-city-water.
  - `10.0-release`: only the alpha.1 bump.
  - `codex/mathgl5-gpu-project-crs`: docs only.
- **deck:**
  - `codex/webgpu-terrain-heightmap` (09-30).
  - The `codex/path-style-dash-*` series (09-30).
  - The `x/alt-proj-*` series (09-28).
  - The `claude/*-GveWO` globe series (09-25..30).
  - `codex/bump-luma-10-alpha-1` (09-26).
- **loaders:**
  - `codex/tile3d-parallel-refinement` (10-01).
  - Assorted arcgis and geoarrow branches.
  - `5.0-release` at alpha.7.
- **math:**
  - `codex/proj4-vertical-geotiff` (09-30).
  - `5.0-release` at alpha.8. npm has alpha.9.
