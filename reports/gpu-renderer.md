# GPU and renderer: decisions and open items

*2026-10-02. The one place for still-open GPU / renderer / luma-deck plan items and the decisions behind them. Current-state references are the module READMEs: [`src/lib/gpu/README.md`](../src/lib/gpu/README.md) and [`gpu/core`](../src/lib/gpu/core/README.md), [`src/lib/deck-webgpu/README.md`](../src/lib/deck-webgpu/README.md), [`src/lib/nn/README.md`](../src/lib/nn/README.md), [`vendor/luma`](../vendor/luma/README.md), [`vendor/deck`](../vendor/deck/README.md). The renderer flip is recorded in [webgpu-default.md](webgpu-default.md). Dead ends are in [negative-results.md](negative-results.md#gpu-and-performance); what landed, per commit, is in `CHANGELOG.md` and [batch-ledger.md](batch-ledger.md). Almost everything below landed on fast gates only and is **browser-unverified**.*

## Where things stand

- **Renderer:** deck.gl on WebGPU by default, WebGL2 deck as fallback ([webgpu-default.md](webgpu-default.md)); three.js removed (dd05828). Vendored luma `10.0.0-alpha.2-rigi.6` (nine packages incl. `@luma.gl/splats`, `@luma.gl/experimental`) and deck `9.4.0-rigi.3` (be26c0c).
- **Compute:** `ComputeGraph` over luma's `GPUCommandGraph` is the only GPU path (042ea54); under WebGPU the render device computes. Rigi kernels, luma gpgpu operators and `gpu-raster` ops share one graph (`ComputeGraph.add`, 812f12f, 9f07221). App islands are declared in `src/lib/gpu/app-graph/manifest.ts`; the generated table is [`islands.generated.md`](../research_notes/whole-app-graph-2026-10-01/islands.generated.md) (CI check `app-graph`).
- **ML:** no ML runtime ships. Sky U²-Net-P, people masks (DeepLab-v3, selfie-multiclass), ALIKED + LightGlue and MoGe-2 depth run on `src/lib/nn` (WebGPU graph, CPU fallback). `onnxruntime-web` is a devDependency only (parity oracle, Landeskarte bake).
- **No backend:** the matcher, Step Inside depth and roll pose propagation run in the browser (8bb109d0).
- **Roll map on WebGPU** (0fbcab2a): `src/lib/roll/map/backend*.ts` picks the backend with `resolveRenderer()`. WebGPU backend = a `DirectHost` + lazily created deck overlay for extras, `PinCore` pins (`deck-webgpu/layers/pins*.ts`), range hand-off through a storage buffer + `copyBufferToTexture` (`range-webgpu.ts`, byte-checked against the CPU path), device loss falls back to WebGL2. Step Inside reuses the roll's baked terrain seed for far/context tiles (`src/lib/deck/seeded-tiles.ts`).

## Decisions

| # | Decision | State |
|---|---|---|
| P1 | Precision policy for f64 CPU stages | **(b) certified f32 per stage** (GPU f32 with an exact certificate, CPU f64 on ties), each stage gated on quality. Default on for horizon and align since 3225064. The bit-identity precision gate was unusable (f64 differs run to run, see negative results); the gate drivers were removed in ea01ffa4 |
| P2 | Photo rasterisation parity (5+ canvas rasterisations; Skia `drawImage` defines the bits) | **Open, deferred.** Keep canvas; `align.ts` keeps its canvas downscale for photoprep's bit-exact contract |
| P3 | WebGL fallback stance | **Fallback only** (user, 2026-10-02): no graph on WebGL, CPU-crossing; no perf work on it (no wasm SIMD for nn CPU). `/roll` was ported to WebGPU anyway, keeping its WebGL path |
| P4 | Vendor open luma/deck PRs before they merge | **Yes**, as revertible `rigi.N` layers (`vendor/*/README.md` list every PR head and local patch) |
| U | Posting upstream (visgl PRs, issues, comments) | **No, unless the user says so directly** (2026-10-01, repeated 10-02). Local packets are ready in [upstream-packets-2026-10-02/](upstream-packets-2026-10-02/README.md) |
| L | luma's "Arisia" codename (the `GPUCommandGraph` / gpgpu program) | Nod, never call out: see [lens-nods-2026-10-02.md](lens-nods-2026-10-02.md) |
| D | Third-party compute dependencies (audit 2026-10-02) | Kept: `libheif-js` (no GPU HEVC path), `exifr` (not compute), dev-only `d3-contour`, `@napi-rs/canvas`. Removed: `onnxruntime-web` (prod), `@mediapipe/tasks-vision`. Rejected after prototypes: `@loaders.gl/geotiff`, `@math.gl/geoid`, `@math.gl/sun`, `@math.gl/proj4` client default (numbers in negative results), luma `GPUMatMul` for nn (325 vs 1469 GFLOP/s at 1024³) |
| V | Opt-in looks (Nebelmeer, trails, weather, water, wind, NPR kit, hatch) | Display-only: never an input to pose, confidence, benchmark, readout or export; GLSL + WGSL twins; ported upstream maths keeps the vis.gl MIT notice (`NOTICE.md`). Wind on WebGL uses the CPU twin (~1.6 ms per tick at 16k particles) |
| — | WAG premises that did not hold | DemStore (decode once per realm), horizon march on the page device, GPU band-stats fold, haze head-overflow work: all measured and not built (negative results) |

## Open items

| Item | State / next step | Evidence |
|---|---|---|
| **Batch browser pass** over every browser-unverified GPU/renderer row (rigi.5/rigi.6 waves, gpgpu adoption, nn runtime, roll map WebGPU, Step Inside on luma splats, lean-pass engine cleanup) | Unowned; one pass per renderer through the render lock | [batch-ledger.md](batch-ledger.md) |
| Roll map WebGPU parity | No browser check exists: add `roll-map-parity` (WebGL vs WebGPU frames with tolerance, pin pick ids, `rangeMapFor` agreement, forced device loss, one live device on the landing) | `src/lib/roll/map/backend.ts` |
| `skylineGpu` default | **On** since f720c646 (node A/B: GT-12 + wild dev, 0 decisions changed). The IMG_6958 flip was chaotic `refinePose` sensitivity on a wrong-focal seed, not GPU error; `?focalSeedGate=on` (off) removes refine-only vetoes and still needs the wild dev A/B. Confirm both in the browser batch | [skyline-gpu-flip.md](../research_notes/wave5/skyline-gpu-flip.md) |
| `renderBundles` | Opt-in; pixels identical on Dawn; default only if the batch pass measures a CPU gain | [render-bundles.md](../research_notes/wave5/render-bundles.md), [g3-batch-checklist.md](../research_notes/gpu-pod-d-2026-10-02/g3-batch-checklist.md) |
| `colorTarget=rg11b10` | Unusable (no alpha); falls back to rgba16float. f16 VRAM savings would need a different target split | [vram-targets.md](../research_notes/wave5/vram-targets.md) |
| Blank first silhouette draw (deck/WebGL) | Mechanism found in code; `redrawIfBlank` workaround in place; confirm in the browser | [blank-first-silhouette.md](../research_notes/gpu-pod-d-2026-10-02/blank-first-silhouette.md) |
| Step Inside on WebGPU end to end | Splats on luma's splat stack (`splatRenderer=luma` default) with photo sky and 3D tiles never run in a browser; add a splat smear check for the luma path | `src/lib/deck-webgpu/README.md` |
| Terrain atlas bytes / ready time | Re-measure after leased GPU decode (last numbers predate it) | `src/lib/deck-webgpu/README.md` |
| Retire the WebGL deck layers? | Decision for later, gated on Safari/Firefox shipping WebGPU with `float32-filterable` | — |
| Horizon certified-f32 stages B+C | Slower than f64 in the worker (4.0–8.7 vs 2.0–2.2 ms; the spot-check emulation dominates); a fused A→B→C graph is not built | `src/lib/gpu/horizon/README.md` |
| Stock deck layers on the WebGPU device | The roll map's extras overlay now puts stock deck layers on WebGPU: re-run the deck #10753 / #10776 alignment audit (rigi.3 vendors both) | [deck-10753-audit.md](../research_notes/wave5/deck-10753-audit.md) |
| Imagery atlas overflow | Overflow tiles draw without imagery (`deck-webgpu/imagery.ts`, `stats.overflow`); eviction not built | — |
| WebGPU gaps | Full-res export tiling; no mid-session WebGL switch after repeated device loss; only Chrome/Metal tested | [webgpu-default.md](webgpu-default.md) |
| `gpu-raw-lint` ratchet | 127 escapes in 9 allowlisted files (mostly raw `gl.` on the WebGL fallback); `panoGL.ts` is now on luma (51d0f2d) | `scripts/ci/gpu-raw-lint.mjs` |
| Hand-packed uniforms | Remain in the files that own the inputs (horizon march / skyglobal `ub`, photoprep dims, colour-stats words, haze, relief) | `src/lib/gpu/core/README.md` |
| Opt-in look tuning | Tuned on one photo (IMG_7086) as stills; waves speckled, wind sparse, never watched animated; lake waves need `terrain.albedo { mode: 'alpine', water: true }`, which neither the toggle nor Field sketch switches on | — |
| Upstream watch | Re-run `node scripts/upstream/luma-watch.mjs` before any vendor bump; it tracks the vendored luma and deck PR heads. Triggers: luma alpha.3 on npm, a vendored PR head moving, deck #10752 activity. Spikes only: deck #10751 / #10783 (TerrainExtension on WebGPU) | `scripts/upstream/luma-watch.mjs` |
| Next vendor rebuild | Not urgent: luma #3313 and #3351 merged upstream (drop those merges); deck #10752 head moved to `43a38d6b` (rigi.3 carries `0d8b1664`, docs/scripts only) and luma #3346 moved (rigi.6 carries `680dc602`). The #10751 WGSL terrain module lacks `USE_HEIGHT_MAP_METERS`, so #10783 external terrain is WebGL-only; nothing in the app uses TerrainExtension | `vendor/*/README.md` |
| loaders.gl `GeoTIFFRasterLoader` (#4088) | Revisit when loaders.gl 5.0.0-alpha.8 ships (needs a per-tile byte budget) | — |
| Ploor-style "why" view on `/dev/graph` | Needs luma lowering decisions stored on `GraphInspection` (`gpu/core/inspect.ts`) | [lens-nods-2026-10-02.md](lens-nods-2026-10-02.md) |

## Landed (outcome only)

- **2026-09-30 / 10-01:** deck default (3b121ae), WebGPU default (b520b1d), three.js removed (583e2b7, dd05828); graph-only GPU path (042ea54).
- **luma/deck upstream alignment (U1–U4, WPs A–I, 2026-10-01):** haze scans on `GPUScan`, CPU graph conditions, engine `Kernel`, kernel-layout check, Nebelmeer (heightFog), trail pathDash, precipitation, lake water. Record: [archive/luma-deck-upstream-2026-10-01.md](archive/luma-deck-upstream-2026-10-01.md).
- **Whole-app graph (WAG) waves 0–4 (2026-10-01):** manifest + `/dev/graph` inspector, certified-f32 horizon/align, GPU terrain cull + Terrarium decode, VRAM 371 → 241 MiB, nine GPU defaults kept after the waves 3–4 browser pass ([results](../research_notes/whole-app-graph-2026-10-01/consolidated-pass-results.md), [baseline](../research_notes/whole-app-graph-2026-10-01/baseline-2026-10-01.md)). WAG-next (10-02): sky-worker graph release, no imagery re-upload between matcher views (a15eeca), near-first terrain + atlas compaction (e499995), `GPUProgram` lowerings verified on Dawn (a921f82), page flags forwarded to workers (5bb8d0a).
- **luma frontier LF1–LF8 (2026-10-01):** opt-in looks on both engines (Swiss NPR kit, lake waves, wind particles), `GPUSort` splat sort; `GPUFFT1D` (then capped at 2048) and paged splats were negative at the time.
- **luma-native pass (2026-10-01):** `defineUniformBlock` on luma `ShaderBlockWriter`, GPU geometry unpack (16 → 4 MB reads), raw-escape ratchet 705 → 339, rigi.4 / deck rigi.2 (843dfc0).
- **Wave 5 (2026-10-02):** Landeskarte default look (9b2a6e8, revertable alone), Imhof relief, hatch v2, WGSL compile gate, subgroup haze scans, batched peak-snap gathers, render-bundle helper (opt-in) (f2dfb49, 6c02f47).
- **rigi.5 / rigi.6 waves (2026-10-02):** WebGL MSAA resolve + read-into-target in luma, raw escapes 339 → 127, gpgpu primitives across look, haze, photoprep, sky, skyline, roll (coverage, spatial, palette); Step Inside splats on luma's splat stack (30bb006a, `splatRenderer=luma`, `rigi` fallback); refine yaw on one 8192-point `GPUFFT1D` (d1be4be).
- **Dependency audit implementation (2026-10-02):** nn runtime replaces ORT and MediaPipe (sky ~150 ms on WebGPU vs 3–5 s ORT wasm), nn composes with luma ops (`forwardInto`, `fromView`), gpu-raster dilation in haze prep; upstream packets a–h (44e4947).
