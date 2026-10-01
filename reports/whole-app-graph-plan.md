# Whole-app graph (WAG): plan

*Revised the same day after an adversarial review against the code. The corrections are folded in: W1.2, W1.3, W1.4, W1.5, W1.7 and W2.1 changed; claims are now verified with file:line. Some islands are thin in the crossing table: relief bridge, tiles3d, Step Inside splats.*

2026-10-01. Goal (the user's): express the whole app as a luma.gl GPU command graph that loaders.gl-style ingest feeds, on the bleeding edge of luma, deck and loaders.

This plan builds on [visgl-frontier-2026-10-01.md](visgl-frontier-2026-10-01.md), the upstream sweep. The evidence is in `research_notes/whole-app-graph-2026-10-01/`:

| Note | Contents |
|---|---|
| `dataflow-map.md` | Every stage, readback, upload, CPU decision and device crossing, with file:line |
| `measured-data.md` | Existing timings, a top-10 of costs, and the measurement gaps with commands |
| `upstream-api.md` | Exact luma gpgpu graph/program API and a gap analysis against `gpu/core/graph.ts` |
| `splats-3328.md` | luma splats compute+render graph and PR #3328 drawIndirect |
| `data-sources.md` | Every external source, duplicate decodes, hands-on loaders.gl results, ingest adapter design |
| `proto/` | Two typecheck-only migration sketches: haze tail and solve fold |

## 1. What "whole app as one graph" can and cannot mean

**"Whole app as one graph" cannot mean one literal graph.**
- A `/photo` load runs on 3–5 GPU devices that share no buffers:
  - the page render device, which compute adopts;
  - devices in the horizon-fast, unknown-pose, eye and sky/ORT workers.
- Separate GL contexts run MediaPipe and `/roll`.
- WebGPU objects cannot cross realms.
- ORT and MediaPipe own their own dispatch.

**It can mean four things:**
1. **One graph per island**, each compiled once per shape, with one submit and at most one small readback. There are 13 islands, I0–I12; see `dataflow-map.md` §5.
2. **Islands on the page device fuse** into one encoder per cadence: per photo, per settled pose, per frame.
3. **Every island is described in one manifest**, which the upstream inspector can see. That gives the "whole app" view in code and in a dev page.
4. **Ingest feeds resident GPU resources once per realm**, not 5+ times.

**Upstream reality** (corrects parts of the frontier sweep; see `upstream-api.md` §0):
- `GPUCommandGraph` has exactly three node kinds: compute, render and copy.
  - Transient aliasing, texture resources and preflight are mature and well tested.
- GPU-side conditions (`{source:'gpu', mode:'indirect'}`):
  - work on compute nodes only;
  - can size the dispatch from GPU data, not just skip it.
- Render and copy nodes take CPU conditions only.
- WebGPU cannot size a copy or readback from GPU data.
- `GPUProgram` / `GPUProgramCompiler`:
  - values are f32/u32/i32 scalars and vectors only;
  - there are no textures and no per-run inputs; literals are baked at compile time;
  - the program tests are thin.
- `GPUScalar`, `GPUValueArena` and the dispatch gate are not exported.
- There are no clear or read nodes upstream. Our clear lint, `readNode` and `cachedGraph` stay ours.
- luma `modules/splats` (private, experimental) is the working pattern for compute → `GPUSort` → indirect render in one graph.
  - It draws by hand with `drawIndirect`, not through `Model.draw`.
  - PR #3328 adds `Model.setIndirectBuffer`. It is open and unreviewed, and absent from our vendored engine.

## 2. Where the time and memory go

Numbers are from `measured-data.md`. Almost all of them predate the 10-01 graph-only switch and the WebGPU-default flip, so they need re-measuring (§6).
- **The big multipliers are already banked.**
  - Horizon batch: 24 s → ~0.4 s.
  - Skyglobal grid: 6.9 s → 11 ms.
  - Solve coarse: up to ~4.6 s → ≤8 ms.
- **What remains is glue.**

| Cost | Measured | What a graph does about it |
|---|---|---|
| Sky worker refine stage | 67 ms in the worker against 3.5 ms in isolation | **Probably not recoverable.** The first `refineSkyGpu` takes 72–75 ms and an immediate second call takes 4 ms (`sky-bench.json` parity block), so it most likely absorbs ORT's queued inference. Profile before acting |
| Unknown-pose horizon upload | 87–119 ms uncached against 7–10 ms cached; 115 MB mosaic in its own device | Read the page's resident heights (I1 → I3) |
| Align descent | 839 ms summed over 19 photos × 7 priors; main thread 464 ms | Rounds on the GPU via indirect dispatch; certified compare on the GPU |
| Haze fit | 12.2 ms, of which ~2.5 ms is kernels; two submits plus an f64 CPU tail | Capacity copy plus exact map; tail on the GPU only under a precision policy |
| Photo-view VRAM | 350–398 MiB on WebGPU against 175–188 MiB on WebGL | Transient aliasing across geometry, MSAA and look targets (sky refine already went −51%) |
| Silhouette re-rank | ~18 KB readback per pose plus a CPU score | Already GPU mask + CPU scorer (202f767). The f64 raster-order sum cannot be reproduced on the GPU (`silhouette-mask.ts:13-17`), so a GPU score is a P1 question |
| Eye search | 194 ms over 5 batches; 93 ms of it kernels | Fuse horizon → residual; LM stays on the CPU |
| Photoprep → align | ≈3.5 MB read back (`photoprep/index.ts:439`), then uploaded once per photo by align (`uploadOnce`, `pose-grid.ts:179`); ≈1.4 MB per refit | Hand the resident buffers to align, and make the CPU copy lazy. CPU readers of `edge.coarse`/`fg` remain (`align.ts:306`, `skyglobal/cpu.ts:388`, `silhouette-mask.ts:141`, `deck-webgpu/engine.ts:2973`) |
| Full geometry readback | 12.6 MB whenever haze needs the CPU range array | Gather on the GPU (sky-band select) |
| DEM | ~200 tiles and ~35 MB per photo. Bytes are mostly shared through `cachedFetch` (the eye worker uses raw `fetch`, `gpu/eye/index.ts:74`), but they are **decoded 5+ times** (page, horizon-fast, unknown-pose, eye, near-dem, roll, ridgelines) | Decode once per realm; Terrarium decode on the GPU |

## 3. Target architecture

```
I0 ingest (workers: fetch + codec only, transfer typed arrays / ImageBitmaps)
   │  gpu/ingest: uploadRaster | uploadBitmap | uploadAttributes → resident Resource refs
   ▼
I1 terrain residency  ── TextureArrayAtlas (heights r32f, imagery rgba8-srgb), terrarium-decode node
   │                    lazy CPU view getCpuHeights(tile) for the CPU twins and Node scripts
   ├──► I3 horizon (page device, reads I1)       [precision policy P1]
I2 photo prep (one photo texture → ladder)  [parity policy P2]
   ├──► I4 align (planes resident; GPU-driven rounds + certified compare)
I7 frame ─► I8 queries ─► I9 look   (one encoder per settled pose; small reads only: labels, stats)
I11 splats: sort → drawIndirect (#3328)     I10 labels: CPU/DOM by design
External islands, by design: I5 unknown-pose worker (f64 LM), I6 ORT sky, MediaPipe, I12 roll (WebGL2 until ported)
```

**Layers:**
1. **Execution.** Use upstream `GPUCommandGraph`, through our `ComputeGraph` wrapper. Widen the wrapper rather than replace it.
2. **Semantics.** Add an app graph manifest, `src/lib/gpu/app-graph/`: islands, resources, cadences, owners and readbacks, registered by each module.
   - Use `GPUProgram` lowerings only where values are scalars or vectors.
   - Texture stages remain custom `getCommandNodes` primitives.
3. **Introspection.** Run `GPUCommandGraphInspector` plus preflight (`fitsDeviceLimits`, workload) over every registered graph, behind a `/dev/graph` page and `core/profile.ts`.
4. **Ingest.** Add `gpu/ingest` adapters and loaders.gl `Loader`-contract parsers: `GeoTIFFSourceLoader`, our own `SplatV1Loader`, and SPZ/KSPLAT through `@loaders.gl/splats`.

**House rules that stay:**
- The CPU twin is the reference.
- `?gpu=off` keeps working.
- Plumbing changes are bit-identical.
- WebGL stays a CPU-crossing fallback; the single-graph design is WebGPU only.
- f64 exactness is a policy choice (§5), not something a fusion can silently change.

## 4. Phases

Every item is built in a sandbox and lands on the fast gates (tsc, biome, node checks, kernel-layout) per [dev over test]. Browser and GPU gates run in a batch per phase when testing un-holds. "BIT" means byte-equal against the current GPU path and its CPU twin.

### WAG-0: foundations (no behaviour change)

| # | Item | Gate |
|---|---|---|
| W0.1 | **Wrapper widening** in `gpu/core/graph.ts`. G3: `KernelNode.condition` accepts GPU indirect conditions (CPU-only today, `graph.ts:107-111`). A GPU-skipped node leaves aliased garbage in its outputs, so the lint must force a clear or dependent gating on them. G4: `new ComputeGraph(device, id, {graph})` adopts an external or compiler-made graph. G5: raw `addComputePass` nodes get the clear-lint audit. Add `workload` on `KernelNode` (preflight), passthroughs for `addRenderPass`, `addCopyPass`, `transientTexture` and `importFrameTexture` (`importTexture` exists, `:221`), and texture bindings in `addKernel` (rejected today, `:232`) | selftest, BIT on all benches |
| W0.2 | **Inspector and preflight** over every `cachedGraph`. Feed `core/profile.ts` from `inspector.getSnapshot()`. Add a `/dev/graph` page listing graphs, nodes, transient bytes and aliasing savings | Low risk; dev-only route |
| W0.3 | **App graph manifest**: each module registers its island, resources, cadence and readbacks. Generate the island table in this doc and the atlas from it | Node check: manifest ↔ `cachedGraph` ids |
| W0.4 | **Vendor luma rigi.2** = rigi.1 + #3328 (`Model.setIndirectBuffer`). It applies cleanly on `rigi-vendor` 5e1b72ed. Same recipe as J1 (`vendor/luma`, new version string, reinstall). Keep it as a **revertible patch layer**: the API was already reshaped once and may churn. `setIndirectBuffer` asserts on WebGL, so every call site needs a `device.type` guard and must keep its CPU-count path (WebGL fallback, `?gpu=off`) | selftest, layout 59/59, deck-webgpu PNGs byte-identical (proves only no regression), **plus** a new indirect-draw check (a GPU-written count matches a direct draw) |
| W0.5 | **Readback partial map**: `core/readback` supports a deferred partial-range map, so the small header is mapped first and then `[0,total)` only | readback selftest (correctness only). Any latency claim needs a timed bench |
| W0.6 | **Re-baseline measurements** using the post-default commands listed in `measured-data.md` §5. This includes the WebGPU photo-open → overlay time, which was never gated. Add the missing probes: sky worker profile report, splat-sort bench, VRAM probe, long-task observer | Data only |

### WAG-1: same-device fusions (no precision change, BIT)

Order: W0.6 re-baseline first. W1.4 and W1.7 rest on unconfirmed costs, so measure them before building.


| # | Item | Expected |
|---|---|---|
| W1.1 | Photoprep planes stay resident and align imports them (R1/R2). The CPU copy becomes a lazy read. **First list the CPU consumers** (claim 1 row in §2) and move or keep each one. Verification moves out-of-band | Removes the once-per-photo re-upload; the 3.5 MB read becomes lazy, not gone |
| W1.2 | **Fewer settle submits**: put the masks and band-stats kernels in the query geometry's encoder. The query render is its own 1024 px pass, debounced 90 ms with `GeometryGenerations`/renderSeq pairing (`geometry-source.ts:65,497`). It is **not** the visible frame's pass, so keep it separate. Occlusion keeps its dependent CPU step (`resolveOcclusion` → gather, f64 label projection). The stats stall depends on haze's CPU range (P1) | Fewer submits per settle. Not one submit |
| W1.3 | ~~Silhouette score kernel~~. Already a GPU mask plus a CPU f64 scorer (202f767). A GPU score breaks bit identity, so it moves under P1 | — |
| W1.4 | Haze head overflow. A GPU condition alone cannot remove it (`proto/haze-tail.ts.txt`), and a full-capacity copy every run (up to N·8 B) is likely a net loss, because the adaptive head rarely overflows (`haze-graph.ts:41-45`). **Measure the overflow rate first.** Act only if overflows are common | Probably leave as is |
| W1.5 | `drawIndirect` with GPU-written counts. **Batched-terrain first**: `visibleRows` (`batched-terrain.ts:660`, draw at `:734`) is the only real per-frame CPU culling. GPU frustum cull → compact → indirect count. Splats (`splats.ts:768`) draw a constant `cloud.count` and already cull in the vertex shader; a cull-compact pass is only a perf option there. Trails (`trail.ts:331`) have a data-time count, so nothing is gained | Removes CPU culling for terrain |
| W1.6 | VRAM: graph-managed transients and aliasing for geometry, MSAA and look targets | Target ≤250 MiB in the photo view (estimated) |
| W1.7 | Sky worker: profile the 67 ms first. The evidence points to ORT inference landing in the first refine call, which no residency change recovers. Hand over a texture instead of a u8 post only if the profile shows readback cost | Likely ~0 |

### WAG-2: ingest (loaders feeding the graph)

| # | Item | Gate |
|---|---|---|
| W2.1 | **DemStore, decode once per realm**: one `cachedFetch` → decode path shared by terrain, near-dem, roll and ridgelines; the eye worker moves off its raw `fetch`. SharedArrayBuffer is **not available**, because the app is not cross-origin isolated (`sky/sky.worker.ts:66`) and COOP/COEP would risk cross-origin tiles, Google 3D Tiles and ORT CDN loads. Workers get transferred copies of decoded tiles instead | Node BIT on heights; **decode count per photo** (not fetch count) |
| W2.2 | **`gpu/ingest` adapters** (`uploadRaster`, `uploadBitmap`, `uploadAttributes` → `Resource` refs → `importTexture`/`importBuffer`), plus a **`TextureArrayAtlas`** unifying `HeightPool` and `ImageryArray`. It grows with `copyTextureToTexture` and uses a uv-window ancestor fallback instead of the CPU `ancestorCrop` | BIT render, deck-webgpu PNGs |
| W2.3 | **GPU Terrarium decode node**: `ImageBitmap` (no colour conversion) → `copyExternalImage` → kernel → `r32float`. f32-exact arithmetic. BIT also requires `createImageBitmap` + `copyExternalImage` bytes to equal the canvas `getImageData` bytes (colour conversion, premultiply), which needs a test first. `validateTile` stays on the CPU until the wild-set test shows the GPU path never needs it | Byte-compare of input RGBA, then a `.check.ts` height bit compare on the wild set |
| W2.4 | Lazy `getCpuHeights(tile)` view for the CPU consumers: `heightAt`, raycast, line of sight, CPU twins, near-dem, roll. Hot callers move to batched GPU gathers (the `geo-query-gpu` pattern) | CPU twins unchanged |
| W2.5 | `GeoTIFFSourceLoader` (published in alpha.7; tested on real swissALTI3D: 2 range requests, 524 KB, Float32 windows) behind the `swiss-cog.ts` API, with `cachedFetch` Range support. Do **not** wait for #4088, which parses whole files only | `?concord=occl` outputs identical |
| W2.6 | Splats: a `SplatV1Loader` (plus PLY) on the loaders.gl Loader contract; SPZ and KSPLAT import through `@loaders.gl/splats` alpha.7 (Arrow output → our pack) | Round trip `.splat-v1` byte-identical |

### WAG-3: device consolidation (needs the precision decision P1)

| # | Item | Blocker |
|---|---|---|
| W3.1 | Horizon on the page device over the resident I1 heights. Retires the horizon-fast worker device, its mosaics and its duplicate DEM decode | f64 atan/ENU (D7/D8) → P1 |
| W3.2 | Eye search on the page device, fused horizon → residual | P1; LM stays on the CPU |
| W3.3 | Align rounds as a GPU-driven fixed-round loop with indirect dispatch; the exact f64 re-score becomes a certified f32 compare plus a CPU tie path (the solve-fold pattern, `proto/solve-fold.ts.txt`) | P1; a per-device strict-IEEE probe; **wild-set gate under the 0-false-accept rule** (identical accept/reject decisions) |
| — | Stays separate by design: I5 unknown-pose worker (f64 LM/refine, policy), I6 ORT, MediaPipe, I12 roll until a WebGPU port | — |

### WAG-4: semantics and upstream

- `GPUProgram` lowerings for the scalar and vector stages (band-stats fold, haze grid argmin), once a per-run-input story exists.
- Upstream candidates. **Post only with the user's direct OK.** Peers' relays don't count; see [luma-alignment-coordination].
  - a transient initialisation contract (our clear lint)
  - a graph read node
  - uniform-backed (per-run) program scalars
  - exporting `GPUScalar`/arena
  - texture-valued program values
  - the PipelineFactory compute-hash fix (still local-only)
  - review feedback on #3328

## 5. Decisions for the user

**State 2026-10-01:** P1 answered (b), certified f32 per stage, each stage keeping its own EVAL/wild-set gate under the 0-false-accept rule; this unblocks WAG-3. P4 answered: vendor #3328 now as rigi.2. Both answers were relayed by session mt-image-1e, which asked the user directly. P2 and P3 are still open.

| # | Decision | Options | Recommendation |
|---|---|---|---|
| P1 | **Precision policy** for f64 CPU stages: horizon atan/ENU, align re-score, haze tail, band-stats fold, label projection | (a) keep exact f64, so each stays a graph break; (b) **certified f32**: GPU f32 with an exact certificate, and CPU f64 only on ties or uncertain cases (what solve already does); (c) re-baseline the CPU twins to f32 | (b) per stage, starting with horizon. Each stage still needs an EVAL/wild-set gate under the 0-false-accept rule |
| P2 | **Photo rasterisation parity**. The photo is rasterised 5+ times through 2D canvas, and Skia's `drawImage` defines the bits | Keep canvas, or use a GPU downscale ladder and re-baseline the CPU twins on GPU pixels | Defer until WAG-1 lands; it touches every accuracy path |
| P3 | **WebGL fallback stance** | Keep it as a CPU-crossing fallback (no graph), or invest in WebGL graph parity | Keep it as a fallback; the graph work is WebGPU only |
| P4 | **Vendor #3328 before it merges** (rigi.2) | Vendor now, or wait for upstream review | Vendor now; this is consistent with "implement everything even if not formally published" |

## 6. Measurement plan

Run in one batched wave per phase. Take the render lock per step, and make only timed steps exclusive. Commands are in `measured-data.md` §5. The first wave (W0.6) gives the post-default baseline: horizon, eye, look, solve, skyglobal, sky-graph, align, WebGPU app-load and the deck-webgpu bench. Every WAG item reports Δms, Δreadback bytes, ΔVRAM and BIT status against that baseline.
