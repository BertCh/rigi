# luma.gl frontier, 2026-10-01 (late): research, implementation and evidence

This is the record of one evening of work:
- A survey of luma.gl after master `7d1d11e9`: releases, master commits, open PRs, branches, the v10 roadmap and the deck PRs that target luma 10.
- Roadmap rows **LF1–LF8** derived from that survey ([roadmap.md](roadmap.md)).
- Their implementation, verification and integration into the app.

It follows [archive/visgl-frontier-2026-10-01.md](archive/visgl-frontier-2026-10-01.md).

**Standing rule (user, 2026-10-01):** we open no PRs, issues or comments on visgl. Everything here is adopted locally, through vendored `rigi.N` builds and our own code.

## Contents

- **Summary**
- **Part 1, upstream research:** headline, what merged, open PRs and branches, v10 signals, workarounds, verdicts.
- **Part 2, what we built:** a per-row outcome, the user-facing looks, the GPU sort.
- **Part 3, evidence:** measurements, the browser pass, the bugs found.
- **Part 4, design decisions:** why each choice was made, and the alternatives rejected.
- **Part 5, open items.**
- **Part 6, method and process:** how the work was split and landed.

## Summary

| Row | Item | Outcome | Commits |
|---|---|---|---|
| LF1 | Vendor luma rigi.3 | **Landed** by a peer session: master `7289d961` + #3313 #3302 #3287 #3328 #3333 #3334 #3330 + compute-hash fix; deck 9.4.0-rigi.1 | 344c095, fa8bb05 |
| LF2 | Swiss-map NPR kit (hatching, sketch lines, pencil/glow trails, summit glow) | **Landed**, opt-in, both engines. `selectionOutline` not adopted | 19d914a (peer), 70b616b, 6108c72, 034856d |
| LF3 | Lake waves (+ SSR) | **Landed** waves, both engines, world view only. SSR not adopted | 349d194 |
| LF4 | GPU flow particles (wind) | **Landed**, both engines (WebGPU graph; WebGL CPU twin) | 9b94e52, 1f6868e |
| LF5 | Unused gpgpu primitives | **`GPUSort` adopted as the default splat sort**. `GPUFFT1D` and virtual geometry: negative | 3eeccc6 |
| LF6 | Paged progressive splats (#3340) | **Not applicable** (negative result) | d61131b |
| LF7 | Re-audit local workarounds on rigi.3 | **Done**: nothing retires | e625c33 |
| LF8 | Watch list | **Tooling landed**: `scripts/upstream/luma-watch.mjs` | e625c33 |
| (integration) | Panel controls, Field sketch preset, browser pass, fixes and tuning, docs | **Landed** | 648cda7, 6ec3980, c586866, efc056e, 4bb0ee3 (peer), 67472f0, ff3cffb |

The bottom line:
- Every new look is **off by default**.
- With every look off, the app renders **pixel-identically** to before the series: 12 captures, 0 differing pixels, both engines.
- One GPU default changed. The splat sort now uses luma `GPUSort`: identical order, about 1.5–2× less GPU time.
- The fast tier passes on a clean clone of `ff3cffb`: 65 pass, 0 fail, 4 skipped for gitignored inputs.

# Part 1: upstream research

*Written before the implementation. Statements of the form "not built" or "open" describe the state at that time. Part 2 has the outcomes. Correction: the rigi.3 rebase that §Headline 3 calls cheap was built and landed by a peer as 344c095. It also carries #3333, #3334 and #3330.*

**Method:**
- A blobless clone of luma.gl with all branches.
- Our `rigi-vendor` branch, from `~/mt-image-archive/2026-10-01-luma-deck-upstream/luma-rigi-branches.bundle`.
- `git merge-tree` of master against that branch.
- `gh` for PRs, issues and discussions.
- A grep of our `src/` for every `@luma.gl/*` import, private-API use and upstream workaround.

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

# Part 2: what we built

## The looks (all opt-in, default off, both engines)

| Look | Style field | Engines | luma source | Our files | Panel |
|---|---|---|---|---|---|
| Cover pattern fills (scree dots, rock and glacier hatching by land-cover class; needs a terroir pack) | `terroir.cover.pattern` | both | `patternFill` #3320 (ported) | `src/lib/terroir/pattern.ts` (peer, 19d914a) | TerroirPanel |
| Slope/aspect rock hatching and scree dots, no pack needed | `terroir.hatch` | both: WebGL define `TERROIR_HATCH`, WebGPU feature `terHatch` (hillshade) | reuses the `pattern.ts` kernel | `src/lib/terroir/hatch.ts`, `glsl/terrain.ts`, `wgsl/terrain.ts` | TerroirPanel toggle |
| Pencil wobble on ridge, skyline and crease lines | `composite.sketch` (0..1) | both | `sketchStroke` #3318 (noise and terms ported to screen space) | `src/lib/look/sketch-ridges.ts`, `deck/composite-shader.ts`, `deck-webgpu/layers/ridges.ts` | "Pencil wobble" slider in Ink lines (shown when ink ridges are on) |
| Pencil and glow trail strokes | `trails.stroke: 'solid'\|'pencil'\|'glow'` | both | #3322 stroke shading (ported) | `src/lib/look/trail-stroke.ts`, `deck/trail-layer.ts`, `deck-webgpu/layers/trail.ts` | Solid / Pencil / Glow in Trail style |
| Glowing summit markers (photo view; never exports or the world view) | `labels.glow` (`LabelGlow \| null`; a partial override turns it on over `GLOW_DEFAULT`) | both | public `pointGlow` #3321 (imported) | `src/lib/look/labels/glow.ts`, `deck-webgpu/layers/glow.ts`, `deck/glow-layer.ts`; `Renderer.setGlowMarkers` | Toggle plus radius, intensity, tint |
| Animated lake waves (world view only) | `world.water: 'flat'\|'waves'` | both (`LOOK_WATER_WAVES`) | `riverWaterMaterial` #3311 wave normal (ported) | `src/lib/look/water/waves.ts`, `water.ts`, README | "Lake waves (alpine water colouring)" |
| Wind-drift particles over the DEM (world view) | `world.wind { on, direction, speed, density }`; `direction` = bearing the wind blows **from** | WebGPU: one-node `ComputeGraph` advection. WebGL: CPU twin | experimental `FlowParticleSimulation` #3324 (advection ported; field is ours) | `src/lib/look/flow/field.ts`, `sim.ts`, `deck-webgpu/layers/flow.ts`, `deck/flow-layer.ts` | Toggle plus direction, speed, density |
| **Field sketch** preset | preset `field-sketch` | both | — | `src/lib/style/presets.ts` (Terroir + `terroir.hatch` + `composite.sketch` 0.6 + pencil trails; hillshade map/world layers) | Preset list |

How each look behaves:
- **Wind field:** a 128×128 grid over ±15 km. The wind is deflected along the surface by `v = w − (w·g)g/(1+|g|²)` (g = DEM gradient), so it flows around and over ridges. It holds up to 16384 particles, drawn as instanced depth-tested streaks. The tick runs at about 30 Hz.
- **Waves:** a six-wave table shared by GLSL and WGSL. The lake normal is tilted; the clock comes from a uniform (WGSL `terrainWater`, GLSL `waterWaves`). The waves fade out by about 10 km from the camera.
- **Animation under harnesses:** waves and wind don't tick under webdriver or reduced motion. Wind then shows a fixed four-run warm-up state, and the waves clock is pinned at 12.5 s, so harness frames are deterministic.

## GPU: `GPUSort` for the splat sort (LF5)

- **What changed:** `src/lib/gpu/splat-sort/index.ts` keeps our depth and key kernels. luma `GPUSort` (radix, `keyBits: 17`) replaces our tile/scan/scatter passes inside the graph.
- **Flag:** `splatSortGpgpu`, default **on**. `?splatSortGpgpu=off` selects the old passes, as does a `GPUSort` build or compile failure.
- **Benches:** `scripts/gpu/splat-sort-gpgpu-dawn.ts`, `scripts/gpu/fft-gpgpu-dawn.ts`. Both run in node over Dawn and need `DAWN_DIR` with `webgpu@0.3.0`.

## Tooling (LF7, LF8)

- **Audit:** nothing retires (table in Part 3). The ledgers in `src/lib/gpu/core/luma.ts`, `queue.ts`, `graph.ts`, `gpu/core/README.md` and the `deck-webgpu/README.md` upstream list are updated.
- **`node scripts/upstream/luma-watch.mjs [--json]`:** read-only `gh` and npm calls, always exits 0. It prints:
  - the npm dist-tags of `@luma.gl/core` and `@deck.gl/core`;
  - luma master against the base in `vendor/luma/README.md`;
  - each vendored PR's state and head against the recorded head;
  - the watch list: luma #3340 #3326 #3286 #3288, issue #3329, deck #10752 #10627 #10778 #10782 #10751 #10783.

  It is not a CI check, because it needs the network. AGENTS.md documents it.

## CI checks added (fast tier)

| Check | File |
|---|---|
| `terroir-hatch` | `src/lib/terroir/hatch.check.ts`: define and feature gating, GLSL/WGSL constant parity; after c586866, also hatch without a cover pack |
| `strokes` | `src/lib/look/__tests__/strokes.check.ts` |
| `water-waves` | `src/lib/look/water/__tests__/waves.test.ts`: define scoping, reference tilt, webdriver gating, both shader languages |
| `flow` | `src/lib/look/flow/__tests__/flow.check.ts`: field math, advection twin, WGSL layout, `FlowSim` (off is inert, warm-up equals the WebGPU runs, a 16k tick under 6 ms) |
| (extended) `labels` | 12 glow cases, including that an empty override leaves CLASSIC byte-identical |
| (extended) `trail.check.ts`, `ridges.check.ts` | Pencil/glow variants; the ridges GPU check against the CPU reference with sketch 0 |

# Part 3: evidence

## Looks-off identity (c586866 browser pass)

- **Setup:** base 2a03b95 (before the series) against HEAD 4bb0ee3, and again against HEAD plus the fix commit. Real GPU, 1120×700, both engines pinned.
- **Views:** IMG_7086 and IMG_7018, each in overlay-contours, blend-relief (hillshade) and world-satellite.
- **Result:** all **12 captures had 0 differing pixels** (max Δ 0, mean 0). Repeated runs gave identical bytes, so renders are deterministic.
- **Not covered:** default identity for the other photos, the replace view and exports. These hold by construction (no define, no extra uniform block or layer when off), and the shader-text snaps in the checks back that up.

## Look screenshots

Contact sheets for IMG_7086 on both engines are in the session scratchpad (`int-verify/contact-final-A.png`, `-B.png`). They were not copied into the repo. What they show:
- **Glow:** readable, not blown out; the engines agree.
- **Hatch:** fall-line strokes on cliffs, no moiré; the engines agree.
- **Sketch:** light, visible wobble; the engines agree.
- **Waves:** read as sparkling glints, somewhat speckled.
- **Wind:** white streaks, a little sparse.
- **Trail strokes:** they change the photo overlay only. The world view showed 0 differing pixels.

## Bugs found and fixed

1. **`terroir.hatch` without a land-cover pack broke WebGPU terrain.** The WGSL referenced `ter_pal`, which exists only when the cover pack is loaded, so the terrain shader failed to compile. Fix (c586866): cover and snow functions are emitted only when cover or snow is on, and `hatch.check.ts` asserts it. The sandbox gates had missed it because they never compiled the full WGSL program on a GPU.
2. **Glow + strokes + water + wind conflicts on landing.** They were add/add conflicts in `style/types.ts`, `scripts/ci/checks.mjs` and both engine files. Resolved by keeping both sides, then re-running tsc and the affected checks.
3. **A type error briefly on master (67472f0):** `Toggle` has no `title` prop. It was fixed one commit later (ff3cffb). The cause was a gate script that read `tail`'s exit status instead of `tsc`'s.

## Splat sort (`GPUSort`)

| Splats | In-house GPU ms | GPUSort GPU ms | Dawn wall ms (in-house → GPUSort) | Chrome wall ms (off → on) |
|---|---|---|---|---|
| 100k | 1.05 | 0.55 | 1.8–1.9 → 1.7 | 2.2 → 1.2 |
| 500k | 1.8–4.5 | 0.85–1.7 | 2.8–5.7 → 2.0–3.1 | 5.5 → 2.9 |
| 1M | 3.3–4.2 | 1.7–3.2 | 4.7–8.5 → 3.3–5.5 | 5.1 → 3.0 |
| 2M | 5.7–6.0 | 3.0–6.0 | 8.0–10.2 → 5.1–9.1 | 8.2 → 5.5 |

- **Environment:** medians on this macOS 14 GPU, shared with other sessions, so the numbers are noisy.
- **Order on Dawn:** identical element for element to the CPU twin `radixOrderTiled` at 100k–2M splats.
- **Order in Chrome WebGPU:** on and off give identical order hashes at 50k, 300k and 1M splats, with a third of the depths quantised to force ties. Both match `radixOrderTiled`.
- **Bitonic:** also order-correct, but 5–8× slower.
- **Cold compile:** about 120–160 ms, once and asynchronous.

## Negative results

- **`GPUFFT1D` for the refine yaw correlation:**
  - It is capped at 2048 points; the yaw grid is 8192.
  - The FFT work in one `globalInit` is **5.8 ms** on the CPU in f64. Seven rffts take 1.7 ms at 8192 and 0.36 ms at 2048.
  - A 7×2048 GPU batch with readback takes 0.55–1.2 ms, which is slower.
  - luma's own impulse oracle failed on Dawn 0.3.
  - A CPU f32 simulation kept the argmax in 200 of 200 trials, but that is moot.
- **`GPUVirtualGeometrySelection` / `GPUScene` for terrain LOD:**
  - Selection needs a complete static hierarchy, while our tile stream is sparse and streamed.
  - Residency feedback would need the readback the primitive avoids.
  - At 350–390 tiles the cull gains nothing.
  - Note: `research_notes/luma-frontier-2026-10-01/virtual-geometry-vs-terrain-cull.md`.
- **#3340 paged progressive splats:**
  - It lives in `@luma.gl/splats`, which we don't vendor.
  - Step Inside clouds are flat single-shot lifts of about 39k splats (200k–1M only in stress runs), fully resident and already sorted on the GPU.
  - First-frame latency comes from the lift service.
  - `splats.ts` already draws into the host pass, which is the borrowed-pass pattern.
  - deck #10627 duplicates our worker sort.

All three are in [negative-results.md](negative-results.md).

## Wind on WebGL: the CPU cost

- The first CPU twin allocated per sample and took about **156 ms** per tick at 16k particles.
- Rewritten allocation-free with identical results, 8 substeps took about 12 ms.
- A single coarse midpoint substep covering the same simulated time takes about **1.6 ms**: 1.5–1.8 ms measured, with the check bound at < 6 ms. Its error is under 1/50 of a grid cell per tick (≤ 0.27 s at about 10 m/s).

## Workaround audit on rigi.3 (LF7)

| Workaround | Verdict | Reason |
|---|---|---|
| Own MAP_READ readback ring (`gpu/core/readback.ts`) | Stays | #3330 stages only the requested range, but `Buffer.readAsync` on a non-MAP_READ buffer still creates a temporary buffer, waits on `onSubmittedWorkDone` and submits per call. `GPUReadbackRing` has fixed slots and reads through `readAsync` |
| #7 `Model.draw` drops `firstInstance`/`baseVertex` | Stays | #3333 forwards only `firstVertex`/`firstIndex` |
| #8 mipmaps submit their own passes | Stays | `generateMipmapsWebGPU` still calls `device.submit()` |
| #9 float-filterable reflection | Stays | Reflection still derives `'float'`; our `sampleType` override remains |
| #10 uniforms via `queue.writeBuffer` | Stays | Unchanged |
| #11 no `&&`/`\|\|` in the WGSL preprocessor | Stays | `!defined()` and literals were added; `&&`, `\|\|` and `==` still throw |
| #12 uniform layout validation | Stays | Checks names and order only |
| `_finalizeDefaultCommandEncoderForSubmit`, `_gpuTimeMs` (`queue.ts`) | Stays | Same semantics; transient uploads are freed by our `commandBuffer.destroy()` |
| Device-loss private fields (`deck/device-lost.ts`) | Stays | All still exist; #3287 didn't change them |
| Hand-applied dispatch validation (`graph.ts:475`) | Stays | The setter is still not exported |

# Part 4: design decisions

1. **Port versus import.**
   - We import public modules when they fit our pipelines (`pointGlow`).
   - We port the maths when the module's shape doesn't fit. `riverWaterMaterial` is a full material with its own uniforms and lights, so only the wave normal was ported. `sketchStroke` expects stroke geometry while our ridge lines are found per pixel, so its noise and terms became screen-space. The #3322 strokes didn't fit our instanced trail quads, so only the shading was ported. The flow sim is in the unpublished `@luma.gl/experimental`.
   - Ports keep the vis.gl MIT notice, and `NOTICE.md` lists them (4bb0ee3 completed the headers).
2. **`deck-gpu-layers` is reference only.** That package is `private: true` upstream, so none of its layers was copied wholesale.
3. **The sketch option sits on `composite`, not `ridges`.** It applies to both classic ridges and ink silhouettes. The WGSL `pad0` slot became `sketch`, so the struct size is unchanged.
4. **Rock hatching comes in two drivers.**
   - The peer's version is cover-class-driven: it needs a pack and knows rock from scree from glacier.
   - Ours is slope/aspect-driven: no pack, fall-line strokes quantised to 16 aspects from 38°, dots at 24–38°. A cover grid refines it when present.
   - Both share one kernel, `PATTERN_KERNEL_*`.
5. **`selectionOutline` was not adopted.** It outlines a mask region. A peak in Rigi is a point, and the geometry buffer has no per-peak id, so a mask would mean segmenting the mountain, which is a feature in its own right. See `src/lib/deck-webgpu/README.md`.
6. **SSR was not adopted.** `ssrCameraTemporal` is only the temporal filter of an SSR pass and is WebGPU-only. It needs depth, normal, history and previous-frame textures, and the world view has none of them. See `src/lib/look/water/README.md`.
7. **Wind on WebGL uses the CPU twin, not a float-texture ping-pong.** At 16k particles one coarse substep is about 1.6 ms, and it reuses the tested twin. AGENTS.md routes GPU work through the graph, but WebGL2 has no compute device, so this is the WebGL fallback for a GPU path. The file comment in `look/flow/sim.ts` says so.
8. **One GPU default changed.** The user's rule is to prefer working GPU-graph paths. `GPUSort` was order-identical and faster, so it became the default with an off switch. FFT and virtual geometry failed on measurement, so they were not adopted.
9. **Looks never touch accuracy.** They are display-only: no pose, confidence, benchmark, readout or export input. Glow is photo-view only and never in exports. Waves and wind are world view only.

# Part 5: open items

- **Tuning:** the looks are tuned on one photo (IMG_7086) as still frames. The waves still look a little speckled, and the wind streaks are sparse. The animated waves and wind have not been watched live.
- **Lake waves need the alpine water colouring** (`terrain.albedo { mode: 'alpine', water: true }`). The panel label says so, but neither the toggle nor Field sketch switches it on.
- **Panel:** nobody has looked at the new controls or at Field sketch in a browser.
- **Glow engine check:** the glow agent's engine probe reported `deck` for both its runs. The later browser pass (pinned engines, 0-px A/B, matching shots) covers this.
- **`GPUSort` beyond this machine:** order identity is checked on Dawn and Chrome on this machine only. Timings on other GPUs are unmeasured. The full-tier `graph-plumbing-ab`, which uses the sorter, was not re-run.
- **Full tier not run:** `style-baseline`, `deck-smoke` and `eval-app` were not run after the series.
- **Re-sweep upstream** when `luma-watch.mjs` shows alpha.3, a moved vendored PR head, or deck #10752 activity. Candidates then:
  - #3340 (only for hierarchical or streamed splat scenes);
  - Arrow/GPUVector T2+;
  - #3286/#3288 (re-run our `inject:` sites first).

# Part 6: method and process

- **Research:** three parallel read-only agents covered the master delta, PRs and branches, and our usage map. The prior sweep was the baseline.
- **Implementation:**
  - Eleven Sonnet agents worked, each in its own `git clone --shared` sandbox under the session scratchpad, with `node_modules` symlinked.
  - A shared brief set the rules: opt-in, both engines, licensing, gates, at most one browser run under the render lock, and a patch exported for the coordinator.
  - Two tasks turned out to be duplicates: a peer landed rigi.3 (LF1) and the cover pattern fills while the agents ran. The hatch agent was redirected to the delta.
- **Landing:** the shared tree had seven live peer sessions with staged renames and dirty files, so patches were committed through a **temporary index**: `read-tree HEAD`, `apply --cached`, `commit-tree`, `update-ref`. A commit therefore never picked up a peer's staged or dirty changes. The real index and the working tree were then brought along only for the touched paths. Two details:
  - Where a file was dirty and the hunk didn't apply, a three-way `git merge-file` merged it into the working tree. Otherwise a peer's next commit of that file would silently drop ours. This happened for CHANGELOG.md, and its conflict was resolved by keeping both sections.
  - Agent sandboxes that fell behind master were rebased before landing (glow, strokes, flow, wind-gl, verify), with add/add conflicts resolved and tsc re-run.
- **Lessons:**
  - Sonnet agents did not reliably run `format-patch`, so check the exported files exist.
  - `cmd | tail; echo $?` reports `tail`'s status; capture the output to a file and check the real exit code.
  - Sandbox gates (tsc plus snippet compiles) miss full-program WGSL compile errors. A pinned-engine browser pass caught the hatch bug.
