# luma.gl frontier, 2026-10-01 (late)

This report follows [archive/visgl-frontier-2026-10-01.md](archive/visgl-frontier-2026-10-01.md), which covered luma master `7d1d11e9`. It covers what changed after that: luma master `7289d961` (2026-10-01 20:14Z), the open PRs and branches, the v10 roadmap signals, and the deck PRs that target luma 10. Each finding is mapped onto Rigi. The roadmap rows are **LF1–LF8** in [roadmap.md](roadmap.md).

**Method:**
- A blobless clone of luma.gl with all branches.
- Our `rigi-vendor` branch, from the bundle `~/mt-image-archive/2026-10-01-luma-deck-upstream/luma-rigi-branches.bundle`.
- `git merge-tree` of master against that branch.
- `gh` for PRs, issues and discussions.
- A grep of our `src/` for every `@luma.gl/*` import, private-API use and upstream workaround.

*Outcome (2026-10-01, same night): LF1 was vendored by a peer (344c095, rigi.3); LF2–LF5 landed opt-in (19d914a, 70b616b, 6108c72, 034856d, 349d194, 9b94e52) plus the GPUSort splat sort default (3eeccc6); LF6 negative (d61131b); LF7/LF8 done (e625c33). States are in the roadmap LF rows.*

**Standing rule (user, 2026-10-01):** we open no PRs, issues or comments on visgl. Everything below is adopted locally, through vendored `rigi.N` builds and our own code.

## Headline

1. **No new npm prerelease.** luma `beta` is still `10.0.0-alpha.2` and `latest` is `9.4.2`. Master is 11 commits ahead of our base, all dated 2026-10-01 (61 files under `modules/`, +6.5k lines). Only two of those commits touch `core`/`webgpu`/`gpgpu` source: #3312 and #3335.
2. **Our vendored PR stack is shrinking.**
   - #3312 (`requiredLimits`) is merged as `f17d6fee`. It is typed by `DeviceLimits` keys, which our limits already use.
   - #3335 (WebGPU `Buffer` byteOffset on init) is merged. It covers only the buffer hunk of #3287.
   - #3313 (`attach()`), #3302 (pipeline variant cache), #3287 (conformance and lifecycle) and #3328 (drawIndirect) are still open.
   - Master **still has no equivalent of our compute-hash fix**: `pipeline-factory.ts:369` hashes neither `entryPoint` nor `constants`. No upstream PR exists for it, and by the user's rule none will be opened.
3. **A rigi.3 rebase is cheap.** `merge-tree` shows 4 conflicts, all mechanical: #3312 doc text, `device.ts` and `webgpu-adapter.ts` limits code, and the `webgpu-buffer.ts` byteOffset hunk. Everything else auto-merges. I did not build it.
4. **The "unhinged" part: Ib Green merged a complete stylized-rendering kit in one afternoon** (#3310–#3325). It provides:
   - sketch edges;
   - hatch and dot fills;
   - pencil, glow and dash strokes;
   - additive glow points;
   - animated river water with temporal SSR;
   - scene-buffer post-processing for deck;
   - GPU flow particles;
   - fog and weather (already ported as U1/U4).

   It lines up almost one-to-one with our terroir look, the Gipfelbuch NPR programme ([gipfelbuch-design-book.md](gipfelbuch-design-book.md)) and the U1–U4 ports.
5. **We already ship a large gpgpu catalogue we don't use.** The vendored alpha.2 already contains `GPUFFT1D`/`GPUFFT2D`, `GPUSort`/`GPUBatchSort`, `GPUScene`, `GPUVirtualGeometrySelection`, `GPUKMeans`/vector search and `GPUReadbackRing` (`node_modules/@luma.gl/gpgpu/dist/gpu-core/`). Upstream's `whats-new.md` marks all of them experimental. None of them is wired into Rigi beyond the imports in `gpu/core/luma.ts`.
6. **akre54 has about 14 hardening PRs in flight.** They are small, frequent and WebGPU-correctness heavy (#3330, #3333, #3334, #3345 and others). They are the main source of fixes for our WebGPU-default engine.

## What merged on master after our base

| PR | Kind | Lands in | Public API | Rigi counterpart |
|---|---|---|---|---|
| #3312 | core/webgpu | `core/adapter/device.ts`, `webgpu-adapter.ts` | `DeviceProps.requiredLimits` | `deck-webgpu/device.ts:143`, `gpu/core/device.ts`: vendored, now upstream |
| #3335 | webgpu fix | `webgpu-buffer.ts` | none | Part of the vendored #3287 |
| #3318 | look | `engine/geometry/edge-geometry.ts`, `shadertools/.../sketch-stroke` | `makeEdgeGeometry`, `sketchStroke` | `deck-webgpu/layers/ridges.ts` (our ink creases and skyline come from the DEM, not mesh edges) |
| #3320 | look | `shadertools/.../pattern-fill` | `patternFill` (hatch and dot) | None yet. Gipfelbuch design book (rock hatching), terroir |
| #3321 | look | `shadertools/.../point-glow` | `pointGlow` | None (summit markers, night look) |
| #3322 | look | `engine/geometry/stroke-geometry.ts`, `shadertools/.../path-dash` | `makeStrokeGeometry`, `pathDash` | U2 took dash coverage only (`deck/trail-layer.ts:204`, `deck-webgpu/layers/trail.ts:171`) |
| #3323 | effect | `effects/.../selection-outline.ts`; `ShaderPassEffect` in the private `deck-gpu-layers` | `selectionOutline` | `deck/composite.ts`, `deck-webgpu/layers/composite.ts` |
| #3311 | look/effect | `shadertools/.../water-material/river-water-*`, `effects/.../screen-space-reflections`, `ssr-camera-temporal` | `riverWaterMaterial`, `SSR_QUALITY_PRESETS`, `ssrCameraTemporal` | `look/water/water.ts` (U4 left out waves and refraction) |
| #3324 | gpgpu/look | `modules/experimental/src/simulation/flow-particle-*`, `flow-field-atlas` | experimental flow-particle simulation | None |
| #3310 | example | `examples/deck/city-scene`, plus a WebGPU picking fix in the example | none | Our deck-webgpu views have no picking |

**Not on npm:** `deck-gpu-layers` (`@deck.gl-community/gpu-layers`) is `private: true`. Its layers (`SketchEdgeLayer`, `GlowPointLayer`, `WaterSurfaceLayer`, `FlowParticleLayer`, `SceneBufferEffect`, `ShaderPassEffect`) are reference code only. If we copy them, they keep their MIT notice and get a `NOTICE.md` entry, like the heightFog and precipitation ports. The shader modules and geometry helpers in `shadertools`, `engine` and `effects` are public, and a rigi.3 vendor would carry them. I did not check whether each new module ships both GLSL and WGSL. Check that per module before adopting it, because rule 4 requires both engines.

## Open PRs and branches that matter to us

| PR | State | What it does | Relevance |
|---|---|---|---|
| #3313 `WebGPUAdapter.attach()` | open, active | App-owned `GPUDevice` | Vendored. The head dropped `_ownsHandle`, and `gpu/core/luma.ts:35-52` already handles that forward-compatibly |
| #3302 pipeline variant cache | open | Per-attachment-format pipelines, and a fix for a `PipelineFactory` reference leak | Vendored |
| #3287 conformance and lifecycle | open, split into #3333/#3334/#3335 | Cross-adapter Device suite | Vendored. Re-vendor from the split parts once they settle |
| #3328 Model drawIndirect | open | `setIndirectBuffer` | Vendored (rigi.2), and it drives `batched-terrain.ts` with `terrain-cull.ts` |
| #3330 | open | WebGPU readback stages only the requested range | Could shrink `gpu/core/readback.ts` (we keep our own MAP_READ ring because `readAsync` stages per call, `luma.ts:30`) |
| #3333 | open | WebGL indexed draws honour `firstIndex` (**behaviour change**) | Our WebGL fallback. Vendor only with a deck-smoke run on `?renderer=deck` |
| #3334 | open | WebGL runs queued copies before immediate passes | WebGL fallback correctness |
| #3345 | open | WebGPU compat devices request adapter limits; cube `textureBindingViewDimension` | Only if we ever accept compat-mode devices. Our probe requires core limits |
| #3286, #3288 | open | Shader hook validation; lazy default shader assemblers | Before vendoring, run our `inject:` sites (`terrain-layer.ts`, `world-view.ts`) and the `getDefaultShaderAssembler` callers |
| #3340 splats | open, +2.4k lines | `GPUPagedSplatRenderer` with progressive RAD selection and a borrowed-pass `draw()`; pairs with deck #10627 (worker SplatLayer) | Step Inside: `deck-webgpu/layers/splats.ts`, `gpu/splat-sort/` |
| #3326, #3331, #3332, #3337, #3338 | open | `GPUDataFrame` fused filters, Arrow `packBatches`, GPU table fixes | Arrow/GPUVector line (LF8) |
| #3169, #3168, #3132 | stale | GPUVector-first layer family; compiled path accessors | deck v10 layer core, WATCH |
| issue #3329 | proposal | Typed shader-module exclusions and dependency-conflict semantics | Our shader module graph in `look/glsl/*`. WATCH |

The branches not covered by an open PR hold nothing new:
- `10.0-release` contains only the alpha.1 bump.
- `9.4-release` holds cherry-picks (#3335).
- `codex/remove-shader-assembler-singletons` is the older form of #3288.
- `codex/arisia-ploor-inspector` is empty.
- The ~25 `jarnevon/*` branches are merged, so they are already in our build.
- Our local fork branches (`rigi/*`: compute hash, `clearBuffer`, `firstInstance`, readback no-wait, WGSL logical ops, packaging manifests) stay local.

## v10 roadmap signals

- **Tracker #2550, "luma.gl v10":**
  - Its theme is deck.gl on WebGPU, with a target of Q3 2026. That target has passed, and there is still no alpha.3.
  - It is organised as Arrow/GPUVector tranches T0–T9. T1 (GPUVector ABI, #3170) is merged. T2–T4 are open or stale POCs. T5–T9 have not started: streaming residency, GeoArrow, Parquet page GPU decode, compatibility.
  - It splits ownership explicitly: loaders.gl owns bytes → Arrow, luma owns Arrow → GPUVectors, deck owns GPUVectors → pixels.
- **`docs/whats-new.md`:** `@luma.gl/arrow` is "currently private". All of gpu-core is marked experimental: command graphs and `compileAsync`, incremental execution, the inspector, `GPUScene`, virtual geometry selection ("Virtual Geometry Canyon"), sort, FFT2D, Parquet streams, vector search. Our graph-only GPU path therefore rests on an experimental API. We accepted that when we took luma 10. A rigi.N bump is the moment to re-run `graph-plumbing-ab`.
- **No new RFCs.** Discussions have been silent since 2024.
- **deck #10752 is still the only deck PR on luma 10.** It is a draft, idle since 09-26, and its merge state is now DIRTY against deck master. The vendored deck stays as it is. A re-vendor carries the #10740–45 grep gate from the earlier report. Deck PRs to watch:
  - #10627: worker SplatLayer.
  - #10778: `_onFrameTimings`.
  - #10782: GPU debug at device init.
  - #10751, #10783: TerrainExtension on WebGPU.

## Rigi mapping: local workarounds a rigi.3 could retire

| Workaround | Where | Upstream that retires it |
|---|---|---|
| Own MAP_READ readback ring | `gpu/core/readback.ts`, `luma.ts:30` | #3330, in part. `GPUReadbackRing` is in our build but has no grow-on-demand |
| `Model.draw()` drops `firstInstance`/`baseVertex` | `deck-webgpu/README.md` issue 7 | #3333 may cover it. Re-check on rigi.3 |
| Uniform writes via `queue.writeBuffer` (last value wins within one submit) | README issue 10 | Not addressed upstream |
| No `&&`/`||` in the WGSL preprocessor | README issue 11, `compositeDefines()` | Local branch only |
| Private `_finalizeDefaultCommandEncoderForSubmit`, `_gpuTimeMs` | `gpu/core/queue.ts:159,179,219` | None. Re-check every vendor bump |
| Private device-loss fields (`_resolveContextLost`, `_sharedRenderPipelineCache`, …) | `deck/device-lost.ts:81-128` | #3287 lifecycle work may change these. Re-check |
| Hand-applied dispatch-workgroups validation | `gpu/core/graph.ts:475` | Setter still not exported |

## Verdicts

| # | Item | Verdict |
|---|---|---|
| LF1 | rigi.3 re-vendor: master `7289d961` + #3313 + #3302 + #3287 + #3328 + compute-hash fix; drop our #3312 merge; take master's byteOffset hunk; optionally #3330 and #3334 | **ADOPT NOW** |
| LF2 | Swiss-map NPR kit from the public modules: `patternFill` hatching (rock, scree, terroir), `sketchStroke` on our ridge lines, `makeStrokeGeometry` pencil and glow trails, `pointGlow` summit markers, `selectionOutline` | **PROTOTYPE** after LF1, opt-in looks |
| LF3 | River water with waves and SSR temporal | WATCH; world view only, low priority |
| LF4 | GPU flow particles (experimental): föhn, wind or cloud drift over the DEM in the world view | PROTOTYPE, fun, world view only |
| LF5 | Unused gpgpu already in the build: `GPUFFT1D` for the refine yaw correlation (`refine/fft.ts`, f64 CPU), `GPUVirtualGeometrySelection`/`GPUScene` for terrain LOD (vs `batched-terrain.ts` + `terrain-cull.ts`), `GPUBatchSort` (vs `gpu/splat-sort`) | BENCH first; adopt on a measured win or parity (user rule: prefer working GPU paths) |
| LF6 | #3340 paged progressive splats + deck #10627 | WATCH until merged, then bench against `splats.ts` |
| LF7 | Re-audit local workarounds and private-API uses on rigi.3 (table above) | With LF1 |
| LF8 | Arrow/GPUVector T0–T9, `GPUDataFrame` (#3326), shader-assembler PRs (#3286, #3288, issue #3329), deck #10752 | WATCH |

**IGNORE:**
- #3345 compat mode: our probe rejects compat devices.
- #3339, #3317, #3341: docs and workspace.
- #3344: 9.3 backport.
- The stale Ib Green device-init PRs #3139–#3147.
