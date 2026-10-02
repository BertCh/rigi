# The "new deck computation graph": what it is, and what a photo-based visualization can show

Researched 2026-10-02 (read-only; gh CLI + local clones `~/Documents/GitHub/vis.gl-upstream/{deck.gl,luma.gl}` after `git fetch`).
Upstream heads at research time: deck.gl master `d1b0ae43f` (2026-10-01), luma.gl master `7289d961a` (2026-10-01).

## 1. Headline finding (corrects the premise)

There is no deck.gl "compute graph" in the sense of `GPUCommandGraph`. Deck uses a different, smaller layer of `@luma.gl/gpgpu`:

- **deck.gl (upstream and the vendored rigi.2 tarball):** the only gpgpu consumer in `modules/` is `modules/core/src/lib/attribute/attribute-buffer-groups.ts`. It imports `GPUDataEvaluator`, `interleave` (and `backendRegistry`, `cleanEvaluateSync`) from `@luma.gl/gpgpu` and `interleave` from `@luma.gl/gpgpu/webgpu`. This is the lazy **evaluator / Operation** API: build a small expression tree (`GPUDataEvaluator` leaves, `interleave(...)` node), call `cleanEvaluateSync(device, packed)`, get one packed vertex buffer. Merged as **deck #10518** "feat(core): interleave attribute buffer group on GPU" (Pessimistress, merged 2026-08-04, merge commit `2d096cce`, +130/-50, 7 files; "Add `@luma.gl/gpgpu` dependency; WebGPU only; no longer requires CPU buffer presence"). It runs only when an attribute declares `settings.bufferGroup` on a WebGPU device (`hasGroups()`).
- `grep GPUCommandGraph|GPUProgram|ComputeGraph|Kernel` over deck master `modules/`: **zero hits**. Code search for "Arisia"/"GPUCommandGraph" in visgl/deck.gl: zero hits. Deck's own `package.json` lists `@luma.gl/gpgpu: ^10.0.0-alpha.2` as a core dependency (verified in the rigi.2 core tarball manifest; `dist/lib/attribute/attribute-buffer-groups.js` is the only dist file that mentions gpgpu).
- **Rigi does not use that path.** `bufferGroup` is not set anywhere in `src/`. Rigi's graphs are its own `ComputeGraph` (`src/lib/gpu/core/graph.ts`) over luma's `GPUCommandGraph`, sharing the page's WebGPU render device (`adoptRenderDevice`). So "deck computation graph" in Rigi = deck.gl-on-WebGPU (`src/lib/deck-webgpu`) rendering buffers that Rigi's own luma command graphs write. The conceptual home of "Arisia" is luma, not deck.

Naming traps for anyone searching:
- `modules/gpgpu/src/gpu-graph/` in luma is **graph theory** (BFS, PageRank, force layout, Louvain), unrelated to command graphs. The command graph lives in `modules/gpgpu/src/gpu-core/gpu-command-graph*.ts`.
- luma has two execution vocabularies: the evaluator/Operation tree (`GPUDataEvaluator`, `interleave`, `fround`, `gather`, `swizzle`, `extent`, ...) that deck uses, and the `GPUCommandGraph` + `GPUProgram` semantic/lowering layer that Arisia names (roadmaps `dev-docs/roadmaps/arisia-*.md`, last touched 2026-09-17, `e9c8072d8` / `3e943e032`).

## 2. Deck PRs asked about (all verified with `gh pr view -R visgl/deck.gl`)

| PR | State | Author | Head branch | What | Relation to a compute graph |
|---|---|---|---|---|---|
| #10752 | open (WIP), 2026-09-25 | ibgreen | `codex/bump-luma-10-alpha-1` (head `0d8b16647`) | Bump luma `10.0.0-alpha.2`, math.gl `5.0.0-alpha.9`, loaders.gl `5.0.0-alpha.7`; 65 files, +1065/-961; migrates math/winding/culling/tile-source/WMS, MVT/Terrain output shapes, SimpleMesh signed indices | The enabler: makes deck build on luma 10 whose `gpgpu` exports the graph module. No graph code itself |
| #10780 | open, 2026-10-01 | akre54 | `akre54/text-sdf-outline-padding` | Pad SDF glyphs by distance-field radius (closes #9032), 4 files | Unrelated to compute (text rendering fix) |
| #10779 | open, 2026-10-01 | akre54 | `akre54/binary-attribute-versioning` | `BinaryAttribute.version` + `dataRange {startRow,endRow}`; `Layer#_diffProps` detects in-place version bumps; partial row upload | **Most relevant.** The PR text: "If a buffer is rewritten in place (for example by compute output), deck has no signal". This is the missing edge between a compute node that writes a storage buffer and a deck layer that draws it. 7 files, +588/-15 |
| #10778 | open, 2026-10-01 | akre54 | `akre54/deck-gpu-frame-timings` | Experimental `Deck` prop `_onFrameTimings` (`FrameTimings`); `FrameTimer` with pooled timestamp `QuerySet`s, one begin/end pair per render pass; `LayersPass` requests timestamps; closes #10777; adds `gpu-hardware` vitest project | Per-pass GPU timing for the render half of a graph; mirrors luma inspector's per-node GPU p50/p95. 12 files, +1269/-55. Rigi already has its own equivalent: `src/lib/deck-webgpu/frame-timings.ts` (`?gpuFrameTimings=on`) shown on `/dev/graph` |
| #10782 | open **draft**, 2026-10-01 | charlieforward9 | `codex/tile3d-gpu-debug-fix` | Forward `Deck` `debug` to device creation / WebGL attach; `deviceProps.debug` still wins | Plumbing only (part of a renderer stack #10782 -> #10784, tile3d perf) |
| #10753 | open, 2026-09-28 | akre54 | `akre54/webgpu-pad-size3-attributes` | WebGPU lacks 8/16-bit x3 vertex formats and needs 4-byte strides: pad on upload (`needsWebGPUPadding()`, `getUploadAccessor()`); external `Buffer` needing padding throws | Constraint on compute -> draw handoff: a compute-written buffer must already be in a WebGPU-legal vertex layout. 10 files |
| #10776 | open, 2026-10-01 | akre54 | `akre54/validate-fp64-external-buffer-upstream` | External `Buffer` on a `float64` attribute supplies the high part only; one shared zero low buffer (`ZERO_LOW_BUFFER_NAME`); `isDoublePrecisionBuffer` for interleaved transition output | Same handoff: fp64 (split hi/lo) positions produced by compute must be declared as such. 14 files, +1103/-22 |

All of #10779 #10778 #10782 #10753 #10776 are merged into the vendored `9.4.0-rigi.2` (build commit `0c7f7cddb`, branch `rigi2`; rigi.1 = `4a2223f3`, which merged #10752 and #10780). "Rigi does not use these paths yet (adoption is a follow-up)" (vendor/deck/README.md).

## 3. Other deck PRs/branches that touch the compute side

| Item | State | Substance |
|---|---|---|
| #10518 `x/gpu-interleave` | merged 2026-08-04 (`2d096cce`) | The one real gpgpu adoption: interleave attribute buffer groups on the GPU (evaluator tree) |
| #10576 / branch `x/fp64-gpu` | open, 2026-08-24 (Pessimistress) | "perform fp64 split operation on gpu": `GPUDataEvaluator.fromArray`, `fround`, `interleave` (webgl + webgpu backends); auto-routes CPU vs GPU at `DEFAULT_GPU_THRESHOLD = 100_000` numbers; adds `test/bench/double-precision.bench.js`; luma beta.2. 16 files |
| #9919 `codex/add-memory-prop-to-layerprops` | open since 2025-12-16 (ibgreen) | `memory: 'gpu-only'` drops CPU attribute arrays after upload; disables CPU-bound transitions/bounds. Pairs with GPU-resident compute output |
| #10279 / `ib/gpu-timer` | open (ibgreen-openai) | Earlier GPU timer using the luma `QuerySet` API: screen-pass-only start/end timestamp then async readback. Superseded in spirit by #10778 |
| #10361 `gpu-completion-callback` | open (akre54) | `Deck#hasActiveTransitions()` for view, layer-prop and attribute transitions (frame-capture completeness) |
| #10738 | merged 2026-09-29 (`b57521a1`) | Attribute transition fixes (enter-from-zero, GeoJson transition forwarding). Deck's attribute transitions are still the old interpolation path, not graph-driven |
| `ib/wgpu-device-enablers`, `ib/webgpu-plumbing`, `ib/wgpu-scatterplot`, `ib/webgpu-column-layer`, `ib/webgpu/polygon-layer`, `ib/webgpu-scenegraph-layer`, `codex/webgpu-layer-stack`, `codex/webgpu-mvt-*`, `codex/webgpu-terrain-heightmap` (head `98dbf01f7`, 2026-09-30) | various | The WebGPU render-layer ports. Not compute, but they are the "draw" nodes that a compute graph feeds. Terrain heightmap on WebGPU is the closest to Rigi's DEM use |
| `codex/rfc-poc-hdr-postprocess-buffers` (`c80e8fb17`, 2026-08-07) | RFC/POC | float16 postprocess buffers |
| `x/alt-proj-*` | branches | Custom projections; `x/alt-proj-aggregation-plumbing` removes an aggregation-specific packed position method (2026-09-28) |
| `dev-docs/roadmaps/gpu-table-roadmap.md` | old (v8-era) | `GPUTable -> GPUTable` transforms, aggregation as table transforms, interleave P0: the conceptual ancestor of #10518 |

Deck aggregation (`aggregation-layers`, Aggregator since #9100, 2024) is its own GPU path; it was not rebuilt on the command graph. No deck branch or PR combines aggregation or attribute transitions with `GPUCommandGraph`.

## 4. The luma side that Arisia names (context deck will eventually meet)

Branches in visgl/luma.gl: `codex/arisia-ploor-inspector` (head `5f988dcdd`, 2026-09-16, "benchmark projection scaling..." #3283; its distinct docs are `docs/api-reference/experimental/gpu-core/gpu-operation-lowering.md` and `gpu-program-lowering.md`), `codex/gpu-command-graph-design` (`5b054ac7c`, 2026-08-15, "named graph node resources" #3085), `codex/luvs-command-graph-aliasing` (`d79461089`, 2026-08-21, graph vector similarity search #3123), `ib/gpgpu-arrow`, `ib/gpgpu-type-inference` ("Evaluators focus on GPUData, not GPUVector" #2667).

Graph concepts (`modules/gpgpu/src/gpu-core/gpu-command-graph*.ts`):
- `GPUCommandGraph<P>` has exactly three node types: **compute**, **render**, **copy** (`gpu-command-graph-types.ts`). Dependencies are inferred from declared buffer uses. `GPUCommandGraphCompiler` schedules into topological "ready waves", aliases **transient** buffers/textures, and can coalesce compute passes.
- **Conditions** on a node: CPU `evaluate`, or GPU `{source:'gpu', mode:'indirect'}` (dispatch sized or skipped from GPU data; compute nodes only).
- `GPUCommandGraphInspector` observes each encoding: per-graph stats, per-node CPU encode and GPU p50/p95 samples (timestamp queries), counters, `preflight` (`fitsDeviceLimits`, workload bounds). Snapshot types: `GPUCommandGraphInspectorSnapshot / GraphSnapshot / NodeSnapshot / DurationSnapshot`.
- `GPUProgram` + `GPUProgramCompiler` + lowering registry: semantic ops (SpMV, conjugate gradient, dot, reduction) are lowered by a backend compiler; `compilation.lowering.decisions` records *why* a realization was chosen, so an inspector can show not just which nodes were emitted.
- Arisia roadmaps (all in `dev-docs/roadmaps/`): `arisia-kernel-migration` (core primitives compile WGSL with the engine `Kernel`; every dispatch supplies complete bindings; baseline `GPU_KERNEL_BASELINE` benchmark), `arisia-execution-lifecycle` (FFT2D joins the graph contract: `getCommandNodes(graph)`, graph-owned scratch), `arisia-fragmentation` (**fragmentation**: chunked vectors/matrices; range lookup O(log C + K), topo scheduling O(E + C log C), sparse routing dispatches R x N x V -> N x (R + V); 8,192 -> 768 commands in the structural test), `arisia-solver-consolidation`.
- `modules/gpgpu/src/gpu-core/gpu-readback-ring.ts` (readback ring, which Rigi's `readback.ts` mirrors) and `gpu-scalar-dispatch-gate.ts` (the "gate").

No source or doc text in luma explains the Lensman reference; "Arisia" appears only as roadmap filenames and the branch name.

## 5. What Rigi already has (all read)

- `vendor/deck/README.md`: rigi.2 composition above; deck is installed from tarballs; swap to npm when deck publishes on luma 10.
- `vendor/luma/README.md`: luma `10.0.0-alpha.2-rigi.4` (+#3345 compute API); gpgpu tarball sha `5e2995cd...`, 1,060,572 B.
- `src/lib/gpu/core/README.md`: `ComputeGraph` (thin wrapper), `cachedGraph` LRU per group, `kernel/defineKernel/kernelAsync`, `pool.ts` (persistent buffer pool, leases), `readback.ts` (ring: `stageReads`, `stagePartialRead`), `program.ts` (`compileProgramGraph`, `GraphOperation` of type `rigi-graph`), `inspector.ts`, `inspect.ts` (`inspectGraphs`), `profile.ts` (`__RIGI_GPU_PROFILE__`, `getGpuGraphProfile`), clear-lint for transients, GPU indirect conditions, render/copy nodes, transient + frame textures.
- `reports/whole-app-graph-plan.md` (WAG, 2026-10-01): 13 islands I0-I12 (ingest, terrain residency, photo prep, horizon, align, unknown-pose worker, ORT sky, frame, queries, look, labels, splats, roll), phases WAG-0..4, rules: CPU twin is the reference, `?gpu=off`, plumbing is bit-identical. Key line: "Whole app as one graph cannot mean one literal graph" (3-5 devices that share no buffers; four honest meanings). Decision 2026-10-01: nothing is posted upstream. `drawIndirect` with GPU-written counts (luma #3328, `Model.setIndirectBuffer`) is the render-side node, batched-terrain first.
- `src/routes/dev.graph.tsx` ("Compute graphs", dev only): per device, a table per graph (group, key, island, nodes, transient bytes, aliasing saved, preflight, encodes, cpu encode, gpu p50/p95), an islands table from `src/lib/gpu/app-graph/manifest.ts` (`ISLANDS`, `GPU_MODULES`, `Cadence`, `Realm`; worker realms shown as "remote"), plus a "Render pass GPU times" panel (`?gpuFrameTimings=on`). Colours already use `--rigi-glow`, `--rigi-ink`, `--rigi-paper`, `--rigi-trap`.
- `examples/gpgpu/horizon-graph`: one `GPUCommandGraph<{decodeHeights:boolean}>` with `decode-terrarium` (CPU `condition` skips it after the first encode), `march-horizon` (one invocation per azimuth bin, default 2048, 1,454 samples per ray, refraction k=0.13), `tangent-extent-*` (`GPUReduction` extent, hierarchical passes). `GPUCommandGraphInspector.observeGraph` + `timeProfilingQuerySet` give per-node GPU ms (decode ~1 ms, march 1-1.9 ms, reduction <0.03 ms; total 1.7-2.8 ms vs CPU twin 60-65 ms). Two `Model`s read `horizonTangents`/`horizonDistances` straight from the graph's storage buffers: no CPU round trip. f32 CPU twin matches to 9.3e-6 deg (3.4 milli-arcsec) at 2048 bins.

## 6. What a viewer could SEE (visual vocabulary, mapped to photos)

| Concept | Where it lives | Photographic reading |
|---|---|---|
| **Node: compute** (`decode-terrarium`, `march-horizon`) | `addComputePass`/`defineKernel` | A step the photo goes through. Each azimuth bin of the panorama is literally one GPU invocation: the 2048 bins are columns across the image, so a node is a pass across the frame |
| **Node: render** | `addRenderPass`, deck layers | The pass that develops the picture: terrain/sky/overlay drawn from buffers |
| **Node: copy / readback** | `addCopyPass`, `readback.ts` ring | The "exposure leaving the camera": the few bytes allowed back to the CPU (labels, stats, ~18 KB per pose). A readback is a keyhole; show it as a narrow aperture |
| **Edge = declared buffer use** | dependency inference | A line from the node that writes a buffer to those that read it (`heights` -> `march` -> `tangents` -> `extent` and the Model) |
| **Waves** (topological ready waves) | compiler schedule | Nodes that can run together sit in one column; the order a photo "develops" |
| **Transient buffers and aliasing** | compiler, `aliasing saved`, `transient` bytes | Two intermediates sharing one allocation: draw as double exposure on one plate (photo-view VRAM 350-398 MiB -> target 250 MiB estimated) |
| **Conditions** | CPU `condition`; GPU indirect | A shutter: decode is skipped after the first encode; an indirect condition sizes the dispatch from GPU data. Show a skipped node as a closed iris |
| **Dispatch** (workgroups) | `workload`, `dispatchWorkgroups` | Tiles of the photo covered by workgroups; terrain `visibleRows` cull -> indirect draw count |
| **Fragments/chunks** (Arisia "fragmentation") | `GraphVectorView`, chunked `GPUVector` | A vector split across several buffers; a strip of film cut into frames. Rigi analog: terrain tiles (451 distinct DEM tiles, ~200 per photo) |
| **Fusion into one submit** | `encode`, `coalesceComputePasses`, one encoder per settle | Several lens elements, one barrel |
| **Preflight** | `fitsDeviceLimits`, workload bounds | A focus check before the shot: does the graph fit the device |
| **Timing** | inspector p50/p95; frame timings #10778 | Exposure time per node; per-render-pass GPU ms |
| **CPU twin / BIT parity** | house rule | The reference print beside the GPU print: overlay the f32 CPU horizon (60-65 ms) and GPU horizon (1.7-2.8 ms), difference 9.3e-6 deg |
| **Islands / realms** | manifest | Separate cameras: page device vs worker devices that share no buffers (I5 unknown-pose, I6 ORT, MediaPipe, roll) |
| **Version bump on an in-place buffer** (#10779) | deck `BinaryAttribute.version` | The moment compute output is "developed" into the next draw; a counter on the edge between graph and layer |
| **Lowering decisions** | `compilation.lowering.decisions` | Annotation on a node saying why it was realized this way |

## 7. Practical notes for the plan

1. Say "luma command graph feeding deck" in copy; do not claim deck itself runs a compute graph (only the optional interleave evaluator does).
2. Everything needed to draw the picture already exists as data: `inspectGraphs()` (nodes, stats, preflight, samples), the manifest (islands, realms, cadences), the horizon example. A visualization is a rendering of that data plus a photo, not new GPU plumbing.
3. Graphs exist only after the app ran in the tab (`/dev/graph` needs client navigation from `/photo`); worker graphs are "remote" from the manifest alone. A static baked demo (like `how-it-works-scene`) is the safe route for public pages.
4. Adopting #10779 (`version` on `BinaryAttribute`) is the natural Rigi follow-up if graph-written buffers should be handed to deck layers as attributes; today Rigi's WebGPU engine binds storage buffers directly.
5. Policy reminders from AGENTS.md/memory: browser-unverified landing, no network-graph look (Gipfelbuch notebook style), no outlines around cards, nothing posted upstream.

## 8. Sources

gh: `gh pr view {10752,10780,10779,10778,10782,10753,10776,10518,10576,10279,9919,10361,10738} -R visgl/deck.gl`; `gh search prs/code` (graph terms: zero deck hits). Local: deck `git show origin/master:modules/core/src/lib/attribute/attribute-buffer-groups.ts`, `git diff origin/master...origin/x/fp64-gpu`; luma `modules/gpgpu/src/{index.ts,operation/gpu-data-evaluator.ts,gpu-core/gpu-command-graph*.ts}`, `dev-docs/roadmaps/arisia-*.md`, branches listed in section 4. Rigi files listed in section 5. GitHub API rate limit was hit once mid-research (resets hourly); remaining lookups used local clones.
