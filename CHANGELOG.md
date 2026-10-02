# Rigi CHANGELOG

Entries are factual and ordered newest first. There are no tagged releases yet; everything is under Unreleased until the first tag.

## Unreleased

- **`/baseline` Auto-align without a compass, gravity or focal length** now uses the unknown-pose cascade options (direct 360° solve, 360° refine init, wide pitch without gravity) and the 0.75 bar on whichever stage answers (`src/baseline-ui/align-options.ts`). Before, it ran a ±25° solve and a ±30° refine at the 0.5 bar around a made-up north heading, the recorded "no heading: 7 false accepts" trap; on a synthetic panorama the old path accepted two poses 140° off. Photos with all three sensors are unchanged (same options, no extra bar); a photo missing any sensor gets a level prior, so its pitch search is widened too. UI wiring browser-unverified.
- **Share-link beta scaffolding (`?share=on`, off by default until the N2 licence review clears):** `/s/$code` opens a bundled demo photo read-only at an accepted or confirmed pose (`src/lib/share`: versioned URL-safe codes, decode never throws; uploads and candidate poses cannot be shared). "Copy share link" sits in the workspace header; shared views carry a display-only watermark on the stage and in PNG exports, never write the viewer's saved pose and skip auto-align. Design: `reports/share-beta-design-2026-10-02.md`. Browser-unverified.
- **Attribution on every surface (N2):** `src/lib/licences/MapAttribution.tsx` renders the attribution table as a compact linked credit (landing live roll map); the landing footer and TopoBoard credits come from the table; 3D-tiles providers are in the table. "Save image" in the workspace now writes the annotated PNG with the credit footer (filename `<id>.annotated.png`). PNG exports append the 3D tiles' credit while Step Inside draws them and are refused while Google 3D Tiles are on screen (display only). Browser-unverified.
- **Upload location coaching (R7):** `/upload` shows one card with the Position / Heading / Tilt the file carried and the steps that record the rest (iOS settings path on iPhone and iPad), replacing the separate GPS, heading and gravity warnings (`src/lib/upload/coach.ts`). Browser-unverified.
- **Step Inside robustness:** a built scene and the step camera's Back to photo button stay on screen when a near-field health probe fails (busy or stopped service); with `?tiles3dObjects=on` a pose change during the object prior no longer caches a scene built from two poses; SHARP (research-only weights) is offered only in dev builds (`?nearfield=sharp` lifts in production, with a console warning); the panel's low-trust band is the export header's constant; the splat sort drops non-finite positions and PLY decoding turns a NaN/infinite quaternion into the identity; step camera keys ignore contenteditable targets. First specs for the controller, `useStepInside` and `StepInsidePanel`.
- `computeHorizon` (the CPU f64 horizon in `src/lib/geo/horizon.ts`: the scripts' reference march and the engines' fallback) is about 2.4x faster (5.1 s to 2.1 s per eye in node on IMG_6958 / IMG_7155) with bit-identical output: the great-circle trig is hoisted per distance and per azimuth, and `TerrainSampler.sample` does one tile lookup when all four bilinear taps fall in one tile. `mosaicsFromSampler` reads the sampler's public `tileSet`.
- **Lens nods to the compute graph:** `src/brand/LensGlyph.tsx` (circle plus ridgeline, `currentColor`); `/dev/graph` gets a "compute graph, observed" eyebrow, a "Clear ether." empty state and a collapsed per-node "Provenance, as recorded" panel (`src/components/dev/GraphProvenance.tsx`, from `GraphInspection` only); the landing "Local computation" copy now reads "through luma.gl's compute graph. Bring your own lens."; the horizon-graph infobox heading is "Graph readout"; new example `examples/gpgpu/photo-graph` ("Through the lens", four compute nodes shown as stage bands, local photo input). Register: `reports/lens-nods-2026-10-02.md`. Browser-unverified.
- Accept-rule evidence tooling: `src/lib/accept/bounds.ts` (exact one-sided Clopper-Pearson bounds, risk-coverage curves, a fixed-grid Learn-then-Test threshold, `acceptsNeeded` for sizing a sealed set) and `scripts/accept/risk-coverage.ts`, which reports the cascade and fused gates on the wild dev half only (planning evidence, not results). No app behaviour change.
- Auto-align no longer persists its result (a saved pose reloads as accepted, and a low-confidence auto-align is not verified); second-opinion verdicts `kept` and `timeout` now append "not verified: …" to the alignment note (`notVerifiedReason`); the `upgrade` chains in `PhotoWorkspace` no longer leave unhandled rejections. Browser-unverified.
- **Lens nods to luma.gl's Arisia program** (the upstream codename of the `GPUCommandGraph` / gpgpu work): `src/brand/LensGlyph.tsx` (circle plus ridgeline, `currentColor`); `/dev/graph` gets an "Arisia (luma.gl) · compute graph, observed" eyebrow, a "Clear ether." empty state and a collapsed per-node "Provenance, as recorded" panel (`src/components/dev/GraphProvenance.tsx`, from `GraphInspection` only: kind, condition, invocation bound, p50 timings); the landing "Local computation" copy no longer calls `arisia.gl` a compute layer, and the footer names luma.gl `GPUCommandGraph`; the horizon-graph infobox heading is "Graph readout"; new example `examples/gpgpu/photo-graph` ("Through the lens": luminance, blur, gradient and per-column skyline nodes shown as stage bands, plus a local "Bring your own lens" photo input). Register: `reports/lens-nods-2026-10-02.md`. Browser-unverified.
- `src/lib/geocam/integrity/skyline-parallax.ts`: skyline-parallax wrong-eye test (Huber fit of eye-shaped 1/d residual against the DEM horizon); killed on dev by its frozen criterion and removed again per the cleanup rule (recover with `git show 31752b8:<path>`), see `tools/research/geo/skypar/REPORT.txt`.
- **Concord C4 hooks (`?concord=occl,labels,drape`, off by default, unconsumed):** `src/lib/concord/occl/hooks.ts` derives hidden-label ids and a drape mask from the DSM occluder pass; `runConcordDisplay` reports them and calls the optional `Renderer.setOccludedLabels` / `setDrapeMask` (no engine implements them yet).
- Step Inside: `?nearfield=complete` (behaves like `on`) adds the P0 completion heuristics in `src/lib/nearfield/complete/`: near-camera ground wrongly classed Object is reclassified to Terrain (slab diagnosis), the client depth-lift snaps mixed-depth edge ramps and softens the Object rim, and any splat completion adds must be `generated` (asserted; never in exports, the measure grid or the readout). The behind-layer fill is not built. Default path unchanged.
- Step Inside T2 nDSM evidence: with `?tiles3dObjects=on` (default off) the near-field controller loads the swissSURFACE3D minus swissALTI3D nDSM around the eye, samples it at each cell's DEM hit (`nearfield/object-evidence.ts`) and passes it to the object prior, so huts and trees at 100-300 m can become Object splats; no coverage or any error falls back to no prior. New fast CI row `nearfield-service` (service unit tests, SKIPs without the matcher venv). Browser-unverified.
- WebGPU imagery overflow is near-first: on devices capped at `maxTextureArrayLayers` (256) a resident far tile now yields its layer to a nearer wanted one (`planImageryOverflow`, `metrics().imagery.evictions`), instead of whichever tiles arrived first keeping imagery. Browser-unverified.
- **WebGL blank first draw: the redraw waits for the link.** A draw whose program is still linking (KHR_parallel_shader_compile) is skipped silently by luma, so the first terrain pass of a fresh page can read back empty. `redrawIfBlank` now awaits `waitForPrograms` before redrawing, and the first geometry refresh redraws a blank buffer the same way (deck engine only; browser-unverified).
- Near field (S1 prep, opt-in): cliff-lip anchoring (`nearfield/cliff-lip.ts`, `AnchorOpts.cliffLip`, flag `anchorCliff`, off by default) drops DEM range discontinuities and the lip face from the anchor fit; `nearfield/anchor-parity.ts` compares the DEM grids two engines feed the anchor; segmenter licence shortlist in `research_notes/segmenter-shortlist-2026-10-02/`.
- **`?colorTarget=rg11b10` is now downgraded to rgba16float with a console warning** (rg11b10ufloat has no destination alpha: the photo overlay turns opaque and the world sky, blended under with `one-minus-dst-alpha`, is never drawn). `?colorTarget=rg11b10-unsafe` forces the old behaviour for experiments.

### Lean pass: no back-compat (2026-10-02)

Rigi is unreleased, so compatibility bridges, aliases, old-format readers and finished A/B arms are gone. Rendering changes are browser-unverified.
- **Flags:** `?gpu=off` is the only GPU switch. The finished GPU A/B flags (`gpuHorizon`, `mosaicGpu`, `horizonPrecision`, `lookgpu`, `skyGpuPrep`, `unknownGpu`, `statsFold`, `statsSubgroups`, `terrainGpuCull`, `terrainGpuDecode`, `alignPrecision`, `hazeBandGpu`, `hazeArgminGpu`) are collapsed into their defaults. Also removed: the `?backend=` alias, the `?renderer=three` warning, the retired-flag table, `?cammodes`, `?tiles3dGeoid` and `?cogReader` (with the loaders.gl COG reader and the `@loaders.gl/geotiff` dependency). `?colorTarget=rg11b10` stays.
- **Engine:** `?terrain=tiles` and the per-tile terrain path (WebGL `TerrainTileLayer`, WebGPU `TerrainCore`) are deleted, so batched terrain is the only path; the layer checks and labs use a synthetic tile (`deck/synthetic-tile.ts`). Removed: `RIGI_DECK_BUILD=webgl-only`, the deck spike, and the engine A/B options `geometryDiet`, `reliefHeights`, `silhouetteGpu`, `lookBridge`, `hazeBridge`, `gpuDrape`, `syncStats`, align `refine: "cpu"` and roll `gpuRange`. `Renderer.kind` and `retraceHorizon` are removed, and the pose-render hooks are required. Three-era uniform writers are removed and `gpu/core/device.ts` is folded into `gpu/device.ts`. Kept on purpose: `settleFusion`, `DirectHost` and the bound-screened align refine tier.
- **Saved data:** local storage uses `rigi.*` keys, `rigi-uploads` and `rigi-tiles-v1`. Old saved poses, styles, uploads and tile caches are no longer read. The pose JSON schema is `rigi/pose` and the XMP namespace is `rigi:` (`https://rigi.app/ns/pose/1.0/`). Removed: `local-roll-<n>` roll ids, the stored-region `partial` flag, old matcher `/health` queue shapes, and picker logs without version 1 or with renderer `three`.
- **Scripts and CI:** the render lock is JS-only (no Python memory guard, no legacy `out/.render-lock`; slots are `render-lock-N`). Browser harnesses default to `APP_URL` (`scripts/lib/harness.mjs`, :3100). `vite.gpu.config.ts`, `vite.webgpu.config.ts`, the precision-gate and decode drivers, and about 30 finished parity, A/B and orphan probe scripts are deleted. The sky prep-gate check is a Vitest spec. `tsc` skips the gitignored `out/` directory.

### Research phase 1 (2026-10-02, Pod C)

- FUND E5 ray-cast oracle, `src/lib/raycast/` (not wired, no flag): a per-pixel max-mip heightfield ray caster with curvature + refraction per ray on the horizon-fast mosaics, an f64 CPU reference and a WGSL twin on `gpu/core` (range, ENU xyz, sky per pixel; horizon per azimuth). On dev eyes it matches the horizon-fast march to 0.19 px p95 and renders 1024x768 at 150 km in ~19 ms median on Dawn (PASS; `tools/research/fund/e5_raycast/`, `research_notes/raycast-oracle-2026-10-02/`). Browser-unverified.
- FUND E4 step 1 (dense feature-metric refinement, research only, `tools/research/fund/e4_featuremetric/`) killed on dev; E0r (unclipped-skyline rotation observability) and the skyline-parallax eye test killed on dev; C4 label/drape hooks landed unconsumed (see above). Details: `reports/negative-results.md`.

### Step review (2026-10-02, step pods)

- Upload EXIF guards (`src/lib/upload/exif.ts`): GPS at (0, 0) or out of range, a zeroed or garbled Apple gravity vector, an out-of-range 35 mm focal and a pre-1980 GPS date stamp now read as unknown, not as trusted placeholders. Headings wrap to [0, 360). Square images let gravity choose the holding. `scripts/ingest.mjs` shares the MakerNote, gravity and time code with uploads. In-range values are unchanged.
- Pose exports say how the pose is known (`src/lib/export`): an `estimate` block in `summit-lens/pose` v1 (`null` when unknown), `slens:Pose*` XMP tags, a 'Pose not verified' export note, the fail-closed `readPoseJson`, and `isPose`. The workspace passes the provenance since b8a6e96.
- Per-step review of the Gipfelbuch graph (16 steps): plan docs and the cross-step index in `reports/steps-2026-10-02/`.

### Tap-a-peak pins (2026-10-02, step pod)

- **Tap-a-peak pins (`src/lib/pins/`):** read-only diagnostics (rotation-free pair-angle check that flags a wrong peak name before any solve and isolates one bad pin among three, JᵀJ σ per freed parameter, Baarda redundancy numbers, leave-one-out, `pairFitDeg` for ranking the peak menu) and a seeded pin solve behind `?pinSolve=seeded` (default `plain`): TRIAD / lens-from-pair seed and a 5–120° lens bound, kept only when it fits the taps better than `align.ts solvePins`, which is unchanged (eval GT untouched). Browser-unverified.

### Code health, Pod A (2026-10-02, N7)

- fixes for CR-12 (sky device loss → WASM), CR-14 (imagery bitmap LRU, both engines), CR-40 (DeckHost one draw per frame), CR-45 (terrain slot allocator at the layer cap), CR-52 (ownerless render locks reclaimed, memory wait bounded), CR-W6 (TopoBoard keeps dragged cards across resize; `unpack --keep-prior` null pose), and four new review findings: CR-70 sky idle release on the request queue, CR-71 IDB open timeout closing a live connection, CR-72 render lock reclaiming a live owner when `ps` fails, CR-73 roll import leaving photos "saving" after a failed save. `buildTrailSegments` wrote the densify step index as the trail class (recolour threw). About 350 new Vitest specs (deck/deck-webgpu, gpu CPU-side, upload, sky, cache, geocam map, unknown-pose core, nearfield cameras); dead `SHARED_MODULES` / `IMAGERY_LAYER_SIZE` exports removed. Runtime fixes are browser-unverified.

### Unit test system (2026-10-01)

- **Vitest.** `npm test` runs the unit suite: `*.spec.ts` under node and `*.spec.tsx` (React components) under happy-dom, configured in `vitest.config.ts` without the app's Vite plugins. `npm run test:watch`, `npm run test:coverage` (v8, `out/coverage`, ratchet thresholds). Conventions and helpers in `src/test/README.md` (`src/test/helpers.ts`, `src/test/dom.ts`, `src/test/setup.ts`).
- **Specs across `src/lib` and `src/components`**: geodesy and math, geo/camera/pose/refine, DEM/terrain/horizon/sky, looks/styles/theme/brand, flags/export/upload/cache, concordance/geocam, nearfield/tiles3d/roll, terroir/ontology/Gipfelbuch, the CPU side of GPU and deck code, and plain-React components. Pure CPU, deterministic, no GPU, network or gitignored data.
- **Size and coverage (2026-10-02):** 250 spec files, about 3,260 tests, 12 s for the whole suite. v8 line coverage is 50.5% of `src/lib` + `src/brand`, up from 0. The pure-CPU core (geo, refine, pose6dof, dem, export, horizon-fast, linalg, camera, concord) is above 85%, with its own floor in the thresholds. GPU, deck and nearfield code is covered on its CPU side only.
- **Bugs pinned with `it.fails` (not fixed; fixing one turns its spec red until `.fails` is removed):**
  - `isRampName` in `style/ramps.ts` uses `in`, so inherited keys such as `"toString"` count as ramp names.
  - The union-variant lookup in `style/schema.ts` (`mergeNode`, `pruneNode`) uses `in`, so `{ mode: "constructor" }` is taken as a variant.
  - `declutterNames` in `terroir/labels/names.ts` never increments `used[tag]`, so the per-tag caps are never enforced.
  - `angDiff` in `roll/align/viewpoint.ts` returns −180 for a half turn, although its documented range is (−180, 180].
- **New fast check `unit`** in the regression gate. `scripts/ci/__tests__/checks.spec.ts` tests the registry and fails on an unregistered check script; 18 existing node check scripts that had no row are now registered (`bridge-compute`, `layer-*`, `align-refine-guard`, `nebelmeer`, `precipitation`, `picker-candidates`, `roll-propagate`).

### R5 propagation hardening (2026-10-02)

- `src/lib/roll/propagate/store.ts`: `acceptSuggestion` now refuses (returns false, writes nothing) when the target already has a saved, ground-truth or solved pose, so the guard no longer lives only in the Accept button. `revertAccepted` clears the solved slot only for the accepted record. New `invariants.spec.ts`; `PREREG_DRAFT.txt` gains sections 8-14 (N3 held-out set, frozen constants with sha1, Wilson precision bound), still a draft needing owner sign-off.

### v3 pre-registration tooling (2026-10-02, R6)

- **`STAGE1_MANIFEST` switch** for the stage-1 runner with the v3 seal (`stage1/manifest_guard.py`: refused unless `V3_ALLOW=1` and the manifest sha1 and photo-listing digest match `data_v3/FROZEN.sha1`), **arm code stamps** (`tools/bench/final/stamps.py`, shared with `final.py`; run_v2 records carry `armStamp`), the v2 finalisation as pure functions (`v2/finalize_v2.py`) with a worker-free `V2_SUGGEST_ONLY` replay of cached dev records (`v2/dryrun_suggest_only.py`), and a node-only worker/engine surface spec. Python unit tests run through `tools/matcher/__tests__/python-unit.spec.ts`. Dev and synthetic evidence only; the real dry run is a batch item.
### Unknown-pose accept stability (2026-10-02, pod B g2)

- **`ambiguous` ignores chaotic refine-only seeds.** In the unknown-focal cascade a non-best seed whose accept came only from `refinePose` after a solve stage under `SEED_REFINE_MIN_SOLVE_CONFIDENCE` (0.25) no longer vetoes the best seed (`isAmbiguousFocal`, `integration/unknown-pose-core.ts`); that accept flipped with 1e-4 px of skyline-row noise (`research_notes/wave5/skyline-gpu-flip.md`). `seeds[].solveConfidence` added; `solveUnknownPose` takes a test-only `mapSkyline` seam. GT-12 CPU: 60/60 decisions unchanged. Opt-in `?focalSeedGate=on` (default off until the batch unknown-pose A/B: it only removes vetoes, the wild set is unmeasured). Evidence script `scripts/gpu/focal-seed-noise.ts`.

### Luma-native GPU pass (2026-10-02, session 07)

- **Vendored luma `10.0.0-alpha.2-rigi.4` and deck `9.4.0-rigi.2`.** luma adds #3345 (compatibility devices get the adapter's real limits) and four local APIs: `CommandEncoder.clearBuffer`, `Device.submit(cb?, additionalCommandBuffers?)`, `Buffer.mapAndReadAsync(…, {waitForSubmittedWork})`, MSAA `RenderBundleEncoder`. deck adds #10779, #10778, #10782, #10753, #10776. The app now uses those APIs instead of the raw `clearBuffer`, the private submit finaliser, raw `mapAsync` and the native bundle encoder.
- **Public luma API instead of raw WebGPU:** sky prep upload, mipmaps (`generateTextureMipmaps`), frame waiters (`createFence`), the compute sidecar (`webgpuAdapter.create` with `optionalFeatures` / `requiredLimits`). Kernels share the device `PipelineFactory`. New storage binding guards (zero size, offset alignment).
- **Uniforms through luma's `ShaderBlockWriter`** (`gpu/core/uniform-block.ts` `defineUniformBlock`): geo-query, silhouette, terrain-cull, 13 look / precision structs and 8 align / solve / horizon structs, each proven byte-identical (fast checks `gpu-uniform-block`, `-a`, `-look`).
- **Geometry target unpacked on the GPU** (copy/select-only WGSL): range-only reads are 4 MB instead of 16 MB plus a CPU loop (fast check `geo-unpack`).
- `look/textures.ts` on core kernels and graphs (group `look-tex`), async compile for page-side graphs, LookBridge pipeline prewarm.
- Splat sort: the in-house radix is gone (luma `GPUSort` only); `?splatSortGpgpu` is retired. Plain `.splat` files load through loaders.gl `SPLATLoader`.
- WebGL fallback: silhouette mask and roll-map range on luma `Model`s; geometry and layer readbacks on `texture.readBuffer` + `Buffer.readAsync`.
- Matcher: the T6 GPU skyline grid is on by default (`T6_GPU_GRID=0` opts out).
- `heightFromTile` moved to `src/lib/dem/`; the legacy three `Terrain` lives next to `/lab/generate`.
- CI: `gpu-raw-lint` ratchet on raw WebGPU / private luma / raw GL use (705 → 339 escapes in this pass).
- All browser-unverified (cook mode). Report: `reports/gpu-luma-native-2026-10-01.md`.

### Cartography consolidation (2026-10-02)

- **One cartographic palette.** `src/lib/style/palette.ts` names the map colours that were copied across modules (contour brown, cover inks, warm/Berann/dark ink, paper, classic sky and haze, the Alpine tint) with their provenance. Presets, `terroir/classes.ts CONTOUR_INK`, `terroir/hatch-lk.ts HATCH_LK_INK`, `CLASSIC`, the world-sky constants, the `patterson` ramp and the flow streak colour read it. The LOOK_ALPINE tint is generated for GLSL and WGSL from `ALPINE_TINT`. Pixel-neutral: resolved presets and deck terrain styles are identical, and the shader text is identical up to float spelling.
- **Preset registry.** `PRESET_INFO` holds each preset's label, aliases and the layers it switches to (`PRESET_IDS`, `PRESET_LABELS`, `PRESET_OVERLAY_LAYER` and `PRESET_MAP_LAYERS` are derived from it). Terroir and Field sketch share one layer set, and the Swiss-look presets share one contour definition. `?style=landeskarte` (and a stored "landeskarte") selects the Landeskarte preset, whose id stays `swiss`.
- **Landeskarte fixes** (swiss-cartography-review D1, D2, D7): Swiss contours sit on a thin dark-brown casing instead of Classic's navy one (Landeskarte, Field sketch), the bands layer uses the `swiss` ramp, and place names can use the swisstopo typography through the new `style.terroir.names.typography` ("terroir" | "swisstopo", switch in the Terroir panel; Landeskarte = swisstopo). Browser-unverified.
- Labels: one SVG halo-width rule (`svgHaloWidth`) for peak labels and place names; the terroir overlays reuse `LABEL_FONT_FAMILY`; the swisstopo font stack drops Manrope.
- Report: `reports/cartography-consolidation-2026-10-02.md`.
- 3D Tiles T2 (pure, flag `?tiles3dObjects=off` default): `nearfield/object-prior.ts` promotes Far/Terrain split cells to Object from nDSM + swisstopo tile evidence (display-only sources throw); optional `objectPrior` input on `buildNearFieldScene`; `googleTilesPublicUseAllowed` gates Google tiles in public builds until the official logo ships.

### Consolidation pass (2026-10-02)

- Docs: `reports/status.md` and `reports/roadmap.md` rewritten short and current (open work only; retired row ids point at `bab0f28`); every report indexed in `reports/README.md`; code-review backlog now 53 fixed, 3 partial, 3 obsolete, 16 open.
- Fixes from the code-review backlog: roll import saves/resets safely and decodes with bounded concurrency (CR-03/19/20/53); no pose save on a session-only eye move (CR-08); IndexedDB late-open close (CR-32); near-field inpaint goes through the near-field client (CR-47); render lock records the holder's start time and `run.mjs --update-baseline` refuses after a FAIL (CR-52); unobservable parameters get infinite variance and integrity fails closed (CR-49); masked rows no longer leak through the cluster whitener (CR-17); robust covariance uses the accepted pose's weights (CR-36); the eye refine carries the above-ground prior (CR-15); per-kind RANSAC stop ratio (CR-50); dev export guard (CR-W5).
- `tools/matcher/requirements.txt` and `tools/nearfield/requirements.txt` (CR-26).
- Concordance C2: under `?concord=eye` the per-lens focal table now reaches the app prior (`getPhoto`); photo metadata keeps EXIF `model`/`lensModel` (uploads now, bundled photos after the next ingest).
- Cleanup: one source for `DEG`, `wrap180`, `clamp`/`smoothstep`/`fract`/`mix`, Web-Mercator (`src/lib/mercator.ts`), `srgbToLinear` and 3×3 helpers; dead exports, the `PhotoEngine` alias, the dead three.js picker branch and stale three.js comments removed.
- Near-field service (`tools/nearfield/service`): unit tests for the CR-05 caps (`tests/test_caps.py`); fixes: non-integer or negative `Content-Length` is a 400 (was a 500), non-finite numeric fields (`nan`, `inf`) are rejected, a hard pixel cap (`NEARFIELD_MAX_PIXELS`, 100 MP) on image and mask decode, 500 responses no longer echo exception text, a full cache disk no longer discards a computed result, and error replies sent before the body is read close the keep-alive connection.

### luma compute follow-ups (2026-10-01, WAG-next)

- **Sky worker graph lifetime.** The GPU prep and refine graphs are released after 30 s without a request, and a prep that disables itself frees its graphs at once (the device stays; later requests rebuild the same graphs).
- **Worker flags.** Worker realms (eye search, unknown-pose, horizon, align, baseline, ridgelines) now honour explicit page flags (`?skylineGpu`, `?gpu=off`, `?horizonPrecision`, `?gpuHorizon`, `?mosaicGpu`, `?unknownGpu`, `?alignPrecision`, `?skyGpuPrep`), forwarded through `realmGpuOptions().flags`. Default URLs are unchanged.
- **Matcher pose views** keep the draped imagery resident for 2 min (`ImageryArray.hold`), so spaced pose views no longer re-upload it.
- **Lake floor** DEM-median level samples read heights through the GPU height gather on WebGPU (CPU fallback unchanged, bit-identical in the check).
- **Height atlases** (`bterrain-h256` / `h512`) compact on idle, moving leased and owned layers together; on 256-layer devices the nearest tiles win layers when the wanted set overflows.
- **Dawn evidence for the two `GPUProgram` lowerings**: `scripts/gpu/haze-argmin-dawn.ts` (both indirect-gate branches) and `scripts/gpu/stats-fold-dawn.ts` (workgroup-row SpMV on a default and a core device, layout-failure marker); fixtures moved to `haze-argmin.fixtures.ts` / `color-stats-fold.fixtures.ts`. No further stages qualify for a lowering.
- New fast checks: `sky-graph-idle`, `realm-flags`, `imagery-release`, `height-atlas-dawn`, `haze-argmin-dawn`, `stats-fold-dawn`.

### Wave 5, wave 2 (2026-10-02)

- **Default look = Landeskarte.** The `swiss` preset, shown as "Landeskarte", becomes the Swiss signature:
  - Imhof relief, brown Swiss contours with heavier 100 m index lines thinned by range, and ink ridges.
  - `terroir.hatchStyle = "landeskarte"` and the `SWISSTOPO_LABELS` typography. It needs no cover pack.
  - A fresh store now starts on it. Classic stays selectable and byte-identical, and choosing it is persisted.
  - Revert the "style: default look = Landeskarte" commit alone to restore Classic as the default.
- **GPU mosaic mips.** The horizon march's max-mip pyramid is built by a ComputeGraph kernel inside the uploaded mosaic page, so the CPU pyramid is no longer built or uploaded. Flag `mosaicGpu`, default on: byte-identical on Dawn (168 mip levels, march profiles, unknown-pose rows on 3 GT photos). `?gpu=off` keeps the CPU path.
- **Render bundles.** Bundles are wired into the GPU-culled batched-terrain draws (geometry 1x, colour 4x and the interactive 1x) behind `?renderBundles=on`, default off. Hits and re-records are counted in the engine stats.
- **Colour target.** Opt-in `?colorTarget=rg11b10` puts the 4x MSAA colour target on `rg11b10ufloat`, which uses half the bytes. It has no alpha, so it is only correct where the colour pass covers every pixel (world view with sky). Notes in `research_notes/wave5/vram-targets.md`.
- **GPU skyline flip.** Root cause found: the GPU cost images match the CPU to 1.5e-5 px. The flip comes from `refinePose` on a wrong-focal third seed, which is chaotic at the 1e-5 px level. `skylineGpu` stays off. Notes in `research_notes/wave5/skyline-gpu-flip.md`.
- **Workspace chrome.** Workspace panels, controls and Step Inside chrome move to Brezine tokens. Card rings and shadows are gone, and orange (ember) marks selection and active state only.
- **Lint.** Biome warnings and infos are at zero outside the Gipfelbuch files.
- **New fast checks:** `mosaic-mips`, `color-target-dawn`.
### Gipfelbuch live plates and photo stories (2026-10-02, session 32)

Commit 3587c56. Browser-unverified.

- **Live plates** (`viz/live.tsx`): the landing page's real-image views as notebook figures: overlay reveal, before/after compare, live 3D drape, Step Inside (splats and 3D tiles), panorama, topo board and the how-it-works scene. Each sits on a dark plate with a hand-lettered title, a caption with numbers from the data, hand notes with leaders, and the terrain carried past the frame in contour brown. Preview at `/dev/gipfelbuch-live`.
- **Photo story** (`viz/PhotoStory.tsx`): the alignment story written by hand on a real photo: the phone's guess (struck through in red), the measured skyline, the correction arc and the snapped peak names. It follows the page's photo picker.
- **All 19 sheets** carry at least one of these. The photo story is the hero on rigi and camera-prior.
- **Review fixes:** heroes that follow the picker or say which photo they're fixed to; the tap demo-10 bake rebuilt (peaks paired by name); one visible-peak count (260); median compass error unified at 9.6°; the baseline timings; stale figure references and undefined tokens; the Gipfelbuch print style no longer hides every `<nav>` on the page.

### Gipfelbuch hand pass (2026-10-01, night)

Spec: `reports/gipfelbuch-hand-sketch-2026-10-01.md`. Research: `reports/gipfelbuch-hand-sketch-research/` (sketch style, Swiss cartography and swisstopo, an audit of what was lost). Browser-unverified.

- **Written by hand.** The Gipfelbuch is now an informal field notebook:
  - body in Playpen Sans, titles in Caveat 700 lettering, labels in Patrick Hand SC block capitals, figures in Shantell Sans (all self-hosted, OFL);
  - print remains only for code and equations.
- **Figure labels.** `PrintLabel`/`PrintNote` are now `HandLabel`/`HandNote`.
- **Measured lines.** They are drawn as one pen pass within 0.5 px of the data.
- **Swiss field-sketch kit.** New `notebook/carto.tsx` (Kroki title, north arrow, hand scale bar, trig and spot heights in italics, rock hachure, Kroki hatch, trail lines, blazes, grade boxes, peak leaders, station rays, contour scribbles, profile sketches). New `notebook/marks.tsx` (hand underline, circle, strike and highlight for prose; watercolour washes; a pencil construction layer).
- **Shell.**
  - Each sheet opens with a summit-register entry and carries one sheet stamp.
  - Prev/next are hand-drawn Wegweiser.
  - The index is a hand table of contents and a hand-ruled Blattübersicht.
  - Map furniture (scale bar, LV95 corners, contours, spot heights) is drawn by hand.
- **Pages.** All 19 are sketched, with hand notes, struck first guesses with red corrections, and circled numbers keyed to figures.
- **Page lint.** It now requires at least 6 hand notes per page and bans raw SVG `<text>`.
- **Also in the commit.** The Gipfelbuch alignment story (one prior → solved value shared by Compare, Stages, the new `StoryMap` and the geo bleed), and Imhof colouring on the sheet map and DEM patch (wave 5 D2).

### Wave 5: Swiss signature on the luma frontier, wave 1 (2026-10-02)

Plan: `reports/wave5-plan-2026-10-02.md`. 14 streams, each implemented and independently reviewed. All browser-unverified; the batch-ledger rows say what the consolidated pass must look at.

- **Imhof relief.** New `terrain.relief.mode = "imhof"`: the swiss relief plus multi-scale normal generalisation blended by range, aspect-swung light, Imhof warm/cool colour, elevation tint and aerial perspective (fields `swing`, `tint`, `aerial`). WGSL and GLSL; opt-in.
- **Terroir hatch v2.** New `style.terroir.hatchStyle` (`classic` | `landeskarte`). `landeskarte` draws rock hachures that are denser and darker on the shadow side, tapered and hash-thinned, plus scree stipple and blue glacier lines. Spacing is in ground metres, with two octaves blended by screen footprint so the lines do not swim. Off by default.
- **swisstopo labels.** `SWISSTOPO_NAME_TYPO` / `SWISSTOPO_LABELS` preset constants (`src/lib/terroir/labels/swisstopo.ts`), not yet wired into a preset.
- **Colour grammar.** Roll viewpoints use a six-colour colour-blind-safe Brezine palette (min CIEDE2000 7 under protanopia, deuteranopia and tritanopia; `palette-cvd` check). Orange is reserved for selection.
- **One chrome.** Landing, upload, library and roll lose their card outlines, gradient surfaces and decorative shadows. Dead lagoon/shadcn tokens are removed. `SiteNav` takes `variant="paper"`. The upload page says Rigi, not Summit Lens.
- **Self-hosted fonts.** Fira Sans for UI and labels, Source Serif 4 for display and IBM Plex Mono for code, all from `public/fonts`. The Google Fonts link, Manrope and Fraunces are gone; label layout and canvas export use Fira Sans.
- **WGSL compile gate.** `scripts/gpu/wgsl-compile-all.ts` (check `wgsl-compile`) compiles 242 variants on Dawn through luma: terrain style × look × terroir (presets, one-hot, pairwise, plugin chains), the composite defines, every layer program and every `defineKernel` kernel. It fails on any validation or pipeline-creation error. It would have caught c586866.
- **Subgroups.** The haze radix-select scan has a subgroup variant (`HZ_SCAN_SG`), bit-identical to the shared-memory scan, used when the device has subgroups.
- **Peak snaps.** On WebGPU, pin peak snaps use the batched GPU height gather before the CPU `localMax`. The CPU path stays the reference and the fallback.
- **GPU skyline.** The detector's per-pixel feature, prior and sky-model images run on the GPU (`src/lib/gpu/skyline`, `detectSkylineAsync`) behind `?skylineGpu`, default off. On Dawn, rows are within 5e-5 px of the CPU on GT-12 and 17 wild dev photos, but 1 of 77 unknown-pose accept decisions flipped.
- **Render bundles.** `src/lib/deck-webgpu/render-bundle.ts` (1x and 4x variants, invalidation keys), with a Dawn pixel test and a wiring plan in `research_notes/wave5/render-bundles.md`. Not wired.
- **Node precision gate.** `scripts/gpu/precision-gate-node.ts` runs the certified-f32 vs f64 gate on the dev split over Dawn (base/cand/base2). Built, not yet run.
- **Publication.**
  - `vite build` leaves out `/dev/*` and `/lab/*` (`RIGI_ROUTES=all` keeps them).
  - The onnxruntime LICENSE and ThirdPartyNotices and the libheif LGPL text are served at `/licenses/`.
  - There is a Google Maps logo slot for tiles3d.
  - NOTICE and licences are refreshed, and `tools/matcher/README.md` lists the Python requirements.
- **Fixes.**
  - CR-02: the render-lock wrapper kills the job's process group and frees the slot only after the job exits.
  - CR-04: exports default the geoid undulation to EGM2008, so ECEF and ellipsoidal altitudes were 47-55 m low and are now correct.
  - CR-06: the matcher checks Host, Origin and Content-Type, and confines photo paths.
  - deck #10753 audit: no padding is needed.
- **Stage 1.** The matcher's stage-1 render workers are re-based on the deck/WebGPU service worker, so three.js is gone from that path (`stage1-worker-snapshot` check).
- **New fast checks:** `wgsl-compile`, `imhof`, `palette-cvd`, `haze-scan-sg`, `skyline-stages`, `render-lock-signals`, `export-geoid-default`, `stage1-worker-snapshot`, `render-bundle-dawn`. The Dawn checks print SKIP without `DAWN_DIR`.

### Examples: Landeskarte Abendlicht (2026-10-01)

- New flagship example `examples/deck/landeskarte`: the Niederhorn above Lake Thun as a Swiss Landeskarte sheet (Imhof multidirectional relief, own hypsometric palette, three-ink contours, rock and scree, LV95 ticks, scale bar from camera resolution, legend of drawn symbols only) that lifts into the summit panorama and ends exactly on the solved frame of photo demo-01.
- A time ruler (05:00 to 20:00 CEST, the 20-minute summit stay magnified) moves the real sun of 7 Sep 2026 (NOAA/Meeus with an independent check); cast shadows and sky-view come from a 16-azimuth GPU horizon map built with luma.gl's `GPUCommandGraph` on WebGPU and from a CPU twin in a worker on WebGL2. A GPU skyline ring decides which peaks are labelled.
- Stations show each photo's solved pose as geometry (wedges, Feldbuch rays, Wegweiser plate). An optional layer draws the photo skylines found by U2-Net-P (baked offline, geometry only) against the DEM horizon.
- 12 tsx CPU checks (`node examples/deck/landeskarte/scripts/run-checks.mjs`). Built by a multi-agent swarm from `reports/summit-example-spec.md` (WIP, browser smoke pending a consolidated pass).

### Gipfelbuch: Swiss notebook and explainer fidelity restored (2026-10-01)

- **Concept sheets.** The notebook is back in the shell:
  - the sheet's contour lines sit behind the title;
  - the measured field notes sit under the Ledger;
  - the soft grid is the sheet ground again;
  - the foot has a "Where it sits" section with the notebook trail and the Leads to / Referenced by links.
  
  A sheet whose page opens with its own real-photo hero shows that hero instead of the shell Tafel (`PAGE_HERO`).
- **Index.** The field notebook (Feldbuch) follows the Blattübersicht again.
- **Geo bleed.** `RealPhoto bleed` carries a photo's measured terrain, compass ruler and out-of-frame summits past its frame, as on the Tafel. Heroes can sit on a `Figure plate`.
- **Kit.**
  - Measured lines and dots are drawn exact: `data` on the pen primitives, and `PlotSeries`.
  - Peak labels no longer overprint.
  - Shared helpers: `PrintLabel`, `PrintNote`, `HandRange` and `CrispLine`.
  - Galleries can tag result or failure, and Callouts take their tone's tint.
  - Removed the unused `Multiples`, `StationTable`, `PencilFilter` and tape CSS.
- **Pages.** Pages were restored figure by figure against the committed explainers. All changes are browser-unverified. Record: `reports/gipfelbuch-restore-2026-10-01.md`. Spec: `reports/gipfelbuch-best-of-both.md`.

### Testing policy: batched browser checks (2026-10-01)

- `AGENTS.md`, `CONTRIBUTING.md` and `reports/status.md` now say that changes land on the fast tier and hand checks in `vite dev`. Browser, GPU and bench checks run in one consolidated pass per wave of work rather than per change, and changes stay marked browser-unverified until then. In a pass, the render lock is taken per step, and only timing steps are exclusive.

### Gipfelbuch: a softer sheet (2026-10-01)

- The Gipfelbuch drops its paper texture and notebook props, at the user's request. The ground is a flat warm white (`--gb-paper` and `SWISS.paper`, W 96% + YY 4%, previously the 10% cream with a grain tile), and panels are lighter (paper 91% + LG 9%).
- The graph-paper grid stays, at about half its strength (`--nb-grid` 6%, index ruling 8%).
- Removed: the red double margin rule on notebook entries, the tape strips and seeded tilt on `PastedPrint` (prints now sit square on a thin white mat; `seed` is optional), the pencil graticule ticks in `SheetFrame`, and the wavy underline on concept terms (now a faint solid line).
- The rules are in the Gipfelbuch README ("Soft sheet"), with revision notes in `reports/gipfelbuch-swiss-aesthetic.md`, `reports/gipfelbuch-field-notebook-design.md` and `reports/gipfelbuch-design-book.md`.

### luma.gl frontier looks and GPU sort (LF2–LF8, 2026-10-01)

All looks are opt-in, default off and byte-identical when off; browser-verified only where noted. Source: `reports/luma-frontier-2026-10-01-late.md`.

- `style.terroir.hatch`: slope-driven Swiss rock hatching along the fall line (from 38°) and scree dots (24–38°), no pack needed; reuses the `pattern.ts` patternFill kernel; WebGL define `TERROIR_HATCH`, WebGPU feature `terHatch` (70b616b). Not browser-run. Check `terroir-hatch`.
- `style.composite.sketch` (0..1): sketch wobble on ridge, skyline and crease lines; `style.trails.stroke: 'solid'|'pencil'|'glow'` (6108c72). WebGPU checks run; WebGL snippet compile only. Check `strokes`.
- `style.labels.glow`: glowing summit markers with luma `pointGlow`, photo view only, not in exports; `Renderer.setGlowMarkers` (034856d). One browser run per engine. `selectionOutline` was evaluated and not adopted (no per-peak mask; see `src/lib/deck-webgpu/README.md`).
- `style.world.water: 'flat'|'waves'`: animated lake waves in the world view on both engines (luma `riverWaterMaterial` wave normals); still under webdriver; SSR skipped (`src/lib/look/water/README.md`) (349d194). Check `water-waves`.
- `style.world.wind { on, direction, speed, density }`: wind-drift particles over the DEM in the world view on both engines. WebGPU advects through `ComputeGraph` (9b94e52); WebGL (`deck/flow-layer.ts`) advects on the CPU twin (`look/flow/sim.ts`, ~1.6 ms per tick at 16k particles) because WebGL2 has no compute (1f6868e). Check `flow`.
- Splat sort (WebGPU): luma gpgpu `GPUSort` radix replaces the in-house radix passes (order identical on Dawn at 100k–2M splats; about 1.5–2× less GPU time); `?splatSortGpgpu=off` restores the old passes (3eeccc6). Dawn benches `scripts/gpu/splat-sort-gpgpu-dawn.ts`, `scripts/gpu/fft-gpgpu-dawn.ts`.
- Style panel: controls for every look above (pencil wobble, trail stroke, summit glow, a Water and wind card), and a new **Field sketch** look preset: Terroir with slope hatching, pencil-wobbled ink lines and pencil trails (648cda7, 6ec3980).
- Browser pass (c586866): with every look off, base 2a03b95 vs HEAD rendered 0 differing pixels on both engines (IMG_7086, IMG_7018; overlay, relief, world). Fixed `terroir.hatch` without a cover pack failing to compile on WebGPU; calmer pencil/glow trails; lake waves made visible at lake range. `splatSortGpgpu` on/off give identical order in Chrome WebGPU (50k–1M, with ties).
- `scripts/upstream/luma-watch.mjs [--json]`: upstream drift report (npm tags, luma master vs the vendor base, vendored PR heads, watch list). Luma workaround re-audit on rigi.3: none retire (e625c33).

### Terroir pattern fills (2026-10-01)

- New style field `terroir.cover.pattern` (default off, on in the Terroir preset; needs `cover.on` and a pack): scree is drawn as dot stipple (6 m cells), rock as hatching whose line width grows in shade, glacier as sparse crevasse hatching in the ice ink, all anchored in world metres. Port of luma.gl `patternFill` (#3320, master `7289d961`) in `src/lib/terroir/pattern.ts` (GLSL, WGSL and a CPU mirror); its box-filtered stripes and dot fade keep the mean coverage at distance, replacing the aliasing 3 m scree hash speckle when on. New define `TERROIR_PATTERN` (WebGL splice) and feature `terPattern` (deck-webgpu). With the field off the generated GLSL / WGSL is byte-identical (`scripts/terroir/*identity-snap.ts` diffs empty). Browser-unverified. Check: `terroir-pattern` (fast tier).

### Per-render-pass GPU frame timings (WebGPU engine, opt-in)
- New flag `?gpuFrameTimings=on` (default off): the geometry and colour passes (and the screen pass on the direct host) write begin / end timestamps into a ring of 4 pooled query sets; `WebGpuEngine.onFrameTimings(cb)` delivers `{frame, passes: [{name, gpuMs}], totalGpuMs}` per timed frame, `frameTimingsMean` the 60-frame rolling mean, and `/dev/graph` shows the means. Done in Rigi rather than by vendoring deck.gl PR #10778 because deck's timer sees only deck's own layers pass, while Rigi's geometry and colour passes run from an effect's preRender. Needs `timestamp-query`; drops a frame when all sets await readback, caps 32 passes per frame, disables itself with one warning on a readback error. Off: no query sets, unchanged pass descriptors. Pure logic in `deck-webgpu/frame-timings-core.ts` with the fast-tier check `frame-timings`. Browser-unverified. The deck host's own canvas pass is not timed; `timestamp-query` is still requested whenever the adapter has it (compute profiling shares it).

### Vendored luma.gl rigi.3 and deck.gl rigi.1 (2026-10-01)
- luma.gl bumped to `10.0.0-alpha.2-rigi.3`: luma master `7289d961` plus #3313 (`attach()`, now with application-owned devices and canvases), #3302, #3287, #3328, a PipelineFactory compute-hash commit (`c80b7ce6`), #3333, #3334 and #3330 (details, checksums and rebuild recipe in `vendor/luma/README.md`; compute-hash patch in `vendor/luma/patches/`). `DeviceProps._ownsHandle` is gone (attached devices are never destroyed by luma; `attachWebGPUDevice` already destroys the `GPUDevice` itself), the engine comment that still named it is fixed.
- `@math.gl/core` and the packed luma manifests move to the published `5.0.0-alpha.10`; `@math.gl/polygon` and `@math.gl/web-mercator` are no longer direct dependencies (deck pulls them), and `overrides` pins the types-only `@math.gl/types` to `5.0.0-alpha.10` so one copy is installed. Browser-unverified until the render-lock gates run.
- deck.gl re-vendored as `9.4.0-rigi.1`: deck master `35854250` + #10752 (luma 10 bump) + luma.gl's deck WebGPU hunks (unchanged) + #10780 (SDF glyphs padded by the distance-field radius, so outlined TextLayer labels in the roll map are no longer clipped). Core `dist/` is byte-identical to the previous build apart from the version string; deck 9.4.0 final (on luma 9.4) adds nothing to core/layers over this base. The `@deck.gl/core` override is gone (layers peers the exact core version). Details in `vendor/deck/README.md`.

### Gipfelbuch: Swiss field-notebook design system (2026-10-01)

- Research and plan: `reports/gipfelbuch-field-notebook-design.md`. It covers alpine field books and Gipfelbücher, sketch and handwriting rendering, Swiss typographic design and LK cartography, and ends with a gap audit and five work packages.
- Type programme. The closed scale is 11/13/16/20/24/40/56 (`swiss/type.ts`).
  - Fraunces is used only for the H1; section heads are Fira semibold.
  - Stats use Fira 300 with tabular lining figures.
  - The new `--gb-secondary` (Brezine BG) replaces BL for secondary text, which fixed contrast below WCAG AA.
  - Added `.gb-table`, `.gb-grid` (4/8/12 columns), `.gb-derived` (italic for estimated values) and a forced-colors fallback.
- Hand faces. Notes are set in Caveat (alternating glyphs) and small figure labels in Shantell Sans; Architects Daughter remains as a fallback. Digits inside hand text are set in print.
- Ink kit:
  - furniture strokes are tapered pen outlines with an ink blob at the start (after perfect-freehand, in-house, no dependency);
  - stipple draws scree stones that grow toward the foot;
  - data lines stay exact.
- Furniture and shell:
  - Standortfeld header, Stand/Ausgabe imprint and signpost distances on concept pages;
  - SAC route-topo `Steps` with belay circles, pitch column and a certainty line style (solid = measured, dashed = approximate, dotted = open);
  - a trig-point mark on stats;
  - `Figure` gains `source`/`reading`/`number` props, and tape is off by default;
  - LK-grammar marks and a register line in `swiss/Marks.tsx` and `swiss/Register.tsx`.
- Pages: a mechanical sweep across all 19 pages raised the text contrast floor to 65 %, removed half-pixel sizes and rounded pills, and took Fraunces off non-H1 elements. `gipfelbuch.check.ts` now lints pages so these rules cannot regress.

### Gipfelbuch: one sketched field-book look across every page (2026-10-01)

- Every Gipfelbuch visualization is now hand-sketched in the Swiss sheet inks: the index, all 19 concept pages, the shared `viz/` kit and the `swiss/` sheet furniture. Clean vector strokes became seeded two-pass pen strokes, flat fills became hachure (stipple for uncertain areas), outlined boxes, rings and rounded cards were removed, and markers are pen circles and hand dots. Photos and DEM rasters are never filtered.
- Sketch toolkit in `src/components/gipfelbuch/notebook/` (no new dependency; approach after rough.js, MIT):
  - `sketchify.ts`: `sketchPolyline` (jitter bounded by a tolerance, 0.9 px default, so data lines stay on their measured pixels; tested), `sketchify(d)` for any SVG path, `sketchRect`, `hachureFill`, `stippleFill`, and canvas helpers.
  - `Ink.tsx` React wrappers: `SketchPath`, `SketchPolyline`, `SketchRect`, `Hachure`, `Stipple`, `HandDot`, `PenRule`, `SketchDefs`.
  - Native range inputs are styled as a pen track with an ink thumb.
  - The rules are in the Gipfelbuch README ("Field notebook and sketch rules").
- Concept pages: the force-graph "Connections" became a hand-drawn notebook trail (the concept's notebook page, with incoming and outgoing notes), and a "Feldbuch" field-notes strip under the lede shows that concept's measured values for the selected demo photo. The selected photo is shared across the index and all pages (`useNotebookPhoto`, registered storage key `rigi.gipfelbuch.photo`).
- Handwriting face is Architects Daughter (Kalam fallback), used only for annotations, captions and margin notes. Headings, body text and numbers stay in print.
- Research: `reports/gipfelbuch-swiss-sketch-research.md`, `reports/gipfelbuch-sketch-rendering.md`, `reports/gipfelbuch-sketch-inventory.md`. `scripts/gipfelbuch/shot.mjs` screenshots a page (with `<details>` opened) for review.

### Gipfelbuch: the core map becomes a field notebook (2026-10-01)

- On `/gipfelbuch`, the hand-laid node-link CoreMap is replaced by `NotebookMap` (`src/components/gipfelbuch/notebook/`). It has three numbered notebook entries (viewport inference, terrain snapping, what the pose is for) with 16 numbered steps, and every curated concept appears once. Cross-lane data-flow edges become margin notes ("← the predicted horizon from (11) DEM Horizon").
- The notebook follows one demo photo through the pipeline, and a strip of the 12 thumbnails (or the tally plot) switches photos. Every value is read from `public/demo/gipfelbuch/*.json`: sensor prior vs solved yaw (struck through), median skyline miss before and after the solve, the accept verdict, tiles, ground and eye height, horizon ridge distance, peak counts and the roll span.
- Figures: the photo's skyline band with the traced, prior and solved skylines; the hillshade with the solved view cone and compass heading; a hachured terrain section along the view axis with the sight line to the skyline ridge; and the 12-photo compass-correction plot with tally marks.
- Style: graph paper, a red margin rule, Caveat (Google Fonts, OFL) for annotations only, and seeded hand-drawn strokes (`notebook/sketch.ts`, no new dependency). Data lines are drawn exactly; only the furniture (arrows, circles, dimension ticks, hachures, tape) wobbles. Strokes draw on when an entry scrolls into view, except under reduced motion or automation.
- The entries carry the `#group-<id>` anchors that concept-page breadcrumbs link to (previously missing). New fast check `gipfelbuch-notebook`. Research: `reports/gipfelbuch-notebook-research.md`.

### Landing: terrain continues past the photos (2026-10-01)

- The hero (demo-09) and the "01 · Single photo" frame (demo-01) are set in the roll panorama's look. Ridgelines traced from the photo's eye (`traceViewpoint`) are projected through its solved camera, so each ridge leaves the frame where it does in the photo. They carry on past the edges, with a compass ruler above and peak names past the frame (md and up), fading out at the outer edges.
- 04 3D and 05 Step inside: the sides are line art redrawn every frame through the live camera, so they turn with the orbit and the sway (`src/components/site/LiveLines.tsx`, codec and camera helpers in `lineArt.ts`, bakes from `scripts/demo/bake-live-lines.ts`). Step inside uses IMG_7086's eye ridgelines (`step-lines.bin`, 36 kB, 24 kB gzipped). Before the engine is ready they are drawn at the photo's rest pose. 3D uses Mapterhorn contours, every 40 m within 5 km and 200 m out to 11 km, faded with camera distance (`live3d-lines.bin`, 78 kB, 67 kB gzipped). They redraw only when the camera moves, are capped at 30 fps, stop offscreen and are off below md; drawing takes about 0.3–0.4 ms of main-thread time per frame.
- 03 Map: the board's sides carry the map on as a plan, Mapterhorn contours (20 m, index 100 m) in the same ink at the board's own z14 scale and centre (`scripts/demo/bake-surround-map.ts`; shipped as a 254 kB grey coverage WebP used as a luminance mask over a paper fill, hidden where `mask-mode: luminance` is unsupported). It moves with the board's pan (`TopoBoard` `onPan`); the fade stays put, so a pan never brings lines up under the heading.
- The 02 · Panorama strip's viewpoint terrain is baked (`scripts/demo/bake-pano-terrain.ts` → `public/demo/pano/`, 172 kB, 123 kB gzipped; codec in `src/lib/roll/mosaic/terrainCodec.ts`). `viewpointTerrain` tries a registered lookup (`setBakedTerrain`, set by `loadDemoRoll`) before tracing, so the demo strip's ridgelines are ready in ~10 ms instead of ~1.8 s; a missing or mismatched bake falls back to the live trace.
- The how-it-works scene gets the same treatment around its photo band (bake `how`), fading in only once the pose has snapped: before that the terrain line is still wrong, and the surround would give the answer away. Dragging the terrain off dims it.
- Everything is baked by `scripts/demo/bake-surround.ts`: a transparent WebP per frame in `public/demo/surround/` (50, 88 and 51 kB) and a small JSON in `src/components/site/surround/` that the route imports, so there is no fetch, worker or GPU work at runtime. `Surround` (`src/components/site/Surround.tsx`) places it around any photo without changing the photo's size. The strokes are paper on transparency (dark theme only, like the rest of the landing page).

### Gipfelbuch: rename from atlas, math kit, content review (2026-10-01)

- The explainer pages `/atlas` are now the Gipfelbuch (`/gipfelbuch`, `/gipfelbuch/$concept`), named after the summit logbook. Paths moved to `src/lib/gipfelbuch`, `src/components/gipfelbuch`, `scripts/gipfelbuch` and `public/demo/gipfelbuch`; identifiers are `Gipfelbuch*`; the fast check id is `gipfelbuch`. No `/atlas` redirect.
- `viz/math.tsx`: `Eq`, `Sym`, `Frac`, `Op` set short equations whose symbols carry the colour of the overlay they measure (underlined in the photo colour on the paper theme).
- All 19 pages reviewed against the code and the literature (`reports/gipfelbuch-review-2026-10-01/`). Corrected claims include: the compass-prior width (15° solver prior, not 7.1°), medians that included rejected solves, the curvature drop (171 m net of refraction, 196 m geometric at 50 km), the wild-set skyline result (60 accepted, 39 correct) shown beside the curated one, terrain hiding most summits (924 of 1181 on demo-10), the default DEM (Mapterhorn) and stale three.js numbers. New real-data figures: solver cost against yaw, a hidden summit and its sight line, a peak at phone vs solved yaw, the Step Inside split; new baked data from `scripts/gipfelbuch/data-{peak,pose-solve}.ts` and an extended `data-step-inside.ts`.

### Light mode foundation (2026-10-01)

- `?theme=auto|light|dark` (flag `theme`, applies live) and a saved choice (`localStorage` `rigi.theme`) set `<html data-theme>`. A pre-paint script (`src/lib/flags/theme-boot.ts`, first in `<head>`) resolves: flag, saved choice, `navigator.webdriver` (dark, so harnesses stay dark unless they pass `?theme=light`), OS `prefers-color-scheme`, dark. `src/lib/theme` has `resolveTheme`/`applyTheme`/`useTheme`/`ThemeSync`; `ThemeToggle` (`src/components/site/`) cycles Auto, Light, Dark.
- `src/styles.css`: Brezine swatches as `--khipu-*`; `:root[data-theme="light"]` re-inks the `--rigi-*` roles and swaps `--color-white`/`--color-black`, which flips every `white/NN` and `black/NN` utility. `data-theme="dark"` marks an always-dark island. New `light:` variant for off-palette colours; `brandVar(role, alpha?)` and `BRAND_LIGHT` in `src/brand/khipu.ts`. Dark rendering is unchanged except the range-slider thumb glow now follows `--rigi-glow`. Pages are not yet converted; the toggle is not yet mounted.

### Gipfelbuch: Swiss map-sheet aesthetic (2026-10-01)

- `/gipfelbuch` is restyled as a Swiss topographic sheet. Pages sit on warm paper inked in the Landeskarte separations: rock black, contour brown, water blue and route red, all Brezine chart swatches. Each concept page is a numbered "Blatt NN / 19" inside a neatline with graticule ticks and LV95 corners. Its header carries real Niederhorn contours, and its footer has a Zeichenerklärung legend, a scale bar and an imprint. Status shows as SAC waymark blazes, and prev/next links are yellow Wegweiser signposts. Peak labels on photos follow the Heim/Imfeld panorama style.
- The index opens with a title cartouche and a sheet map of Niederhorn and Thunersee: swisstopo relief shading, 20 m Mapterhorn contours, swissNAMES3D peaks and the 12 demo viewpoints as sight rays. `scripts/gipfelbuch/data-sheet.ts` bakes it into `public/demo/gipfelbuch/sheet/` (about 320 KB).
- The theme is a scoped class (`GB_THEME`, `src/components/gipfelbuch/swiss/`). It remaps Tailwind's white and black and the `--rigi-*` tokens, so the landing page, library and workspace keep the dark theme. Fonts added: Fira Sans, Fira Sans Condensed, IBM Plex Mono, and the Fraunces italic and 600 weight. The group and status colours are re-tuned for paper. Preview the kit at `/dev/gipfelbuch-sheet` (dev only).

### Roll panorama resizes vertically (2026-10-01)

- On `/roll/$id` the panorama has a grip along its bottom edge: drag it (or focus it and press ↑/↓) to set its height between 160 and 1200 px; double-click returns to the default. The height is remembered per browser (`localStorage` `mt-image:roll:pano-height`). `PanoramaStrip` takes it as an opt-in `resizable` prop, so the landing-page demo keeps its fitted height.
- Selecting a photo in the roll panorama no longer scrolls the page down to its grid tile; picks from the map still bring the tile into view.

### WAG wave 4: more of the app on the luma graph, more GPU defaults (2026-10-01)

Built without browser runs (user's call: no render-lock waits); evidence is node checks, several on luma.gl's WebGPU device over Dawn in node. Every item below is **browser-unverified** until the consolidated pass (`research_notes/whole-app-graph-2026-10-01/consolidated-pass-wave4.md`); a regression there reverts that default.
- **First real luma `GPUProgram` users.** The haze grid arg-min (`haze-argmin.ts`, group `look-haze-argmin`): scalar ops for the tolerance, a `GPUConditionalOperation` gating the past-the-cap selection by GPU indirect dispatch, our kernels lowered into the program's graph; reads 2 KiB instead of 22 KiB (`?hazeArgminGpu=off`). The band-stats fold (`?statsFold=gpu|f64`): BAND_STATS → `GPUProgramSpMV` → BAND_FINALIZE in f32 on one graph, 256 B read back instead of 6.6 KB; f32 vs f64 stays under 1 LSB in emulation. New `gpu/core/program.ts` (`compileProgramGraph`, `GraphOperation`), `cachedGraphFrom`, and `cachedGraph(…, create)` for graphs that adopt a program compiler's graph. Band-stats subgroup reduction on by default where available (`?statsSubgroups=off`).
- **GPU airlight band** for the haze fit on the WebGPU texture path, default on (`?hazeBandGpu=off`): one submit, no range / P(sky) planes read back (graph break D16 removed); spot-checked per call, CPU band on a fault.
- **Sky GPU prep on by default** (`?skyGpuPrep`, replaces `DEFAULT_GPU_PREP`), now on a core ComputeGraph; fixes an upload-texture usage bug that made every browser prep fall back to the CPU. Earlier browser A/B (pre-port): 69/69 masks identical, segmentSky 88.1 → 77.6 ms median.
- **`unknownGpu` on by default**: the unknown-pose 360° horizon on the GPU march. Node gate on Dawn (`scripts/gpu/unknown-gpu-node.ts`, the worker's own code now in `src/lib/integration/unknown-pose-core.ts`): 0 new false or unverified accepts on GT-12 × 5 conditions and the 17 wild dev photos without heading; one knife-edge true accept lost (IMG_6971 noheading, which a ±3e-4° horizon jitter of the CPU path also loses).
- **Terrain loading no longer hangs**: tile fetches time out after 30 s (ancestor fallback), a tile that keeps failing is given up after 3 tries and drawn with a stand-in, and `DeckEngine.loadFullTerrain` reports success only once complete; the render worker / harness turn a failed full-terrain load into an error, never a row on the initial terrain.
- **Silhouette re-rank redraws a blank finalist** before scoring, on both engines: the main source of f64-vs-f64 differences between precision-gate runs.
- **Precision gate redesigned**: base, cand and a second base run on the same page per photo, judged on quality (accepts vs 304 blind-verified poses plus the GT-12 arm); identity is reported, not gated. New fast checks `terrain-stall`, `silhouette-mask`, `precision-gate-score`.
- **WebGPU terrain VRAM / uploads**: GPU-decoded tiles decode straight into a height-atlas layer they lease (one upload for layer + stats, no re-upload after a pan; ≤ 48 spare leases). Draped imagery gets a 256² tier for 256 px sources, compacts on idle via a graph copy node and releases 10 s after the look stops draping.
- New fast checks: `haze-band`, `haze-argmin`, `stats-fold`. Method: luma.gl's WebGPU device runs in node over Dawn (`webgpu` package), so real ComputeGraph code can be gated without a browser or the render lock.

### GPU graph paths on by default; WAG wave 3 (2026-10-01)

- **Defaults flipped** (each flag still turns the path off): certified-f32 horizon and align (`horizonPrecision`, `alignPrecision` = `certified-f32`), `terrainGpuCull` = on, `terrainGpuDecode` = on. WebGL and `?gpu=off` keep the CPU paths.
- Precision gate (`scripts/gpu/precision-gate.mjs`, 50 dev photos): INCONCLUSIVE by its bit-identity rule because the f64 baseline itself is not reproducible run to run (f64 vs f64 differs on 7/8 deck and 21/22 webgpu differing photos). GT-12 eval 12/12 identical in both modes; webgpu accepts 32 = 32; the deck "new accepts" are baseline noise (wc_0055) and a `loadFullTerrain` timeout on the initial terrain (wc_0052). Judged on quality, no difference, so certified-f32 became the default.
- WebGpuEngine gains `loadFullTerrain`, `loadSatellite` and `renderPoseView` (same contract as DeckEngine). The matcher render worker and the precision gate run full terrain and the fused render arm on `MATCHER_RENDERER=webgpu`. Against deck: masks identical (IoU 1), horizon Δ0 over 1800 directions, autoAlign Δyaw/Δpitch 0, geometry p95 ≤ 2 cm. The matcher satellite drape uses ~250 MiB more VRAM on WebGPU. Parity harness in `deck-webgpu`.
- Batched DEM height gathers from the resident height atlas: camera height, trails and peak snapping read heights on the GPU under `terrainGpuDecode`, bit-exact against `heightAt` (858 + 311 + 99 peaks and all trail vertices, 0 differences). Main-thread tile decodes at load 165–206 → 0. New core binding kind `texture-array`.
- geo-query-gpu on persistent pool slots via the new `ComputeGraph.runNow` (unleased run for transient-free graphs): 0.39 → 0.34 ms (verdicts + skyline) and 0.285 → 0.25 ms (gather) per call, byte-identical.
- Browser batch on e496c73: full tier 59 pass (graph-plumbing-ab only timed out in the lock queue; timeout raised to 3600 s), deck-smoke Δ0.00° WebGL vs WebGPU, eval-app 12/14 on both renderers, settle-submits confirms geo-query 2 → 1 submit per settle.

### Publication readiness (2026-10-01)

- A fresh clone builds and type-checks without the gitignored data: `photos.json` falls back to an empty list, and `data/ground-truth.json` loads through an optional `import.meta.glob`. CI gains a `vite build` step, `permissions: contents: read` and a `master`-only push trigger; the tsc `ciAllowed` and Biome error baselines are now empty.
- The Niederhorn demo set in `public/demo` (photos, thumbs, shots, step, atlas renders) is tracked, so the landing page works on a clone; it stays © Robert Christie, all rights reserved (NOTICE.md).
- Licences: upstream LICENSE files for the vendored luma.gl and deck.gl tarballs, plus their SHA-256 sums and rebuild recipe; Draco decoder (Apache-2.0) licence and source; NOTICE rows for the example thumbnails, the terroir cover and the EGM2008 geoid. `package.json` has licence, repository and engines metadata; `.gitattributes` and `.editorconfig` added.
- Docs: README quick start and requirements; internal coordination wording, session ids and machine-local paths removed from code comments, READMEs, reports and tool outputs; market/competitive notes and raw prototype dumps removed from `reports/` and `research_notes/`. User-Agent strings name the repository instead of a personal address (`RIGI_CONTACT` adds one); research scripts default to the system temp directory.
- The `/lab/deck-webgpu`, `/lab/deck-splats` and `/dev/how-scene` routes are dev-only, like the other dev and lab routes. Examples import `examples/gpu-args.mjs` instead of a repo script.

### WAG next wave: graph plumbing, precision gate, lazy CPU heights, haze tail (2026-10-01)

- silhouette-gpu, geo-query-gpu and the WebGPU splat sort run as core ComputeGraphs (`cachedGraph` groups `silhouette-mask`, `geo-query`, `splat-sort`) and appear in `/dev/graph`; outputs byte-identical (full-tier check `graph-plumbing-ab`). `GeoQueryGpu.verdictsAndSkyline()` replaces `verdicts()` + `skylineRows()`: one submit and one read per settle instead of two. Splat-sort profiling is reported per node. The manifest now marks terrain-gpu-cull opt-in, matching its flag.
- Precision gate for the opt-in certified-f32 stages: `scripts/gpu/precision-gate.mjs` (frozen dev split, f64 vs certified-f32, 0-false-accept rule). The matcher render worker takes `MATCHER_RENDERER`, `MATCHER_HORIZON_PRECISION`, `MATCHER_ALIGN_PRECISION` and records `pageFlags` and the precision path; `eval-app` gets `--horizon-precision`, `--align-precision`, `--json`. Only a 2-photo smoke has run (PASS).
- Certified-f32 horizon: per-(adapter, shader) spot-check ledger (first 3 calls check 64 outputs, then 8 per call with 1 in 32 at 64; a mismatch disables the key). Certified-f32 align: forced exact re-decisions are scored while the next submit runs; results identical, browser wall-clock gain not measured. Both stay opt-in.
- Haze fit CPU tail: bit-identical shortcuts (hoisted exponentials, a per-pass memo of revisited descent points, typed-array airlight sorts): −0.6–2.9 ms per fit in the WebGPU engine on 4 photos. New fast check `haze-tail`; `compute-bridge.check` reports `fit.stagesMs`.
- `getCpuHeights(tile)` (`src/lib/dem/cpu-heights.ts`) is the accessor for streamed DEM tile heights; default path bit-identical (fast check `cpu-heights`). New flag `terrainGpuDecode` (off): on WebGPU, DEM tiles decode on the GPU straight into the height atlas with CPU heights on demand; frames byte-identical but no gain yet (see negative results). `atlas-frames-check.mjs --query` runs a flag A/B on one tree.

### Photo-view VRAM on WebGPU: 371 → 241 MiB (WAG W1.6; 2026-10-01)

- Attribution first: `scripts/gpu/vram-attribution.mjs` (dev only, render lock) wraps `GPUDevice.createTexture` / `createBuffer` in an init script and lists every live allocation by label and creating call site next to luma's totals. At 4d92d3f the photo view (IMG_7086) held 106 MiB of terrain height arrays, an 85 MiB imagery array with no imagery in it, a 47 MiB base-grid buffer, 40 MiB of MSAA colour targets, 2 × 21 MiB of 1024 px geometry targets (view + query source), 15 MiB of idle 384 px silhouette sources and a 16 MiB photo texture.
- `ImageryArray` creates its texture array on the first tile with imagery (−85 MiB in the photo view; world mode and the imagery drape allocate it as before). Once created it is never freed (nor shrunk) until the engine is disposed.
- Batched terrain: the base-grid storage buffer is packed per tile (`deck-webgpu/base-slots.ts`; offset in the tile table's `t2.w`) instead of a fixed G = 64 slot per row (−32 MiB with the headroom below). A re-pack grows the buffer once the live slots pass 85 % of it, so swaps of tiles of different sizes near full don't re-pack again and again; tiles out of height layers or rows are dropped before the slots are placed. Fast-tier check `base-slots`.
- WebGpuEngine drops the silhouette re-rank's 384 px sources 2 s after the last `autoAlign` / `silhouetteScore` (−15 MiB); the next re-rank re-creates them, with the same result (browser check `scripts/deck-webgpu/sil-release-check.mjs`). The first `autoAlign` after more than 2 s idle therefore includes creating the sources (up to five sets of 384 px targets), which shows in `silTiming.ms`.
- luma "GPU Memory" (`scripts/gpu/vram-probe.mjs`, 3 photos): WebGPU 371.0 / 358.6 / 370.0 → 240.7 / 230.1 / 242.1 MiB (238.3 / 227.9 / 239.7 before the re-pack headroom); WebGL deck unchanged at 189.3 / 177.5 / 190.2. Frames byte-identical (`atlas-frames-check.mjs` vs 8be09fb: 21 poses over 3 photos incl. streaming pans and the world imagery drape; IMG_3304 world needed a re-run, as the first, cold-cache base run captured it with 301 of 356 imagery layers loaded); photo-view frame time and pan frame gaps unchanged within run-to-run noise.
### Certified-f32 align refine, opt-in (WAG W3.3; 2026-10-01)

- `?alignPrecision=certified-f32` (or `autoAlignAsync(…, { alignPrecision: "certified-f32" })`; default `f64`): autoAlign's coordinate descent as a GPU-driven loop (`src/lib/gpu/align/cert-*.ts`, `cert.wgsl.ts`): 48 rounds per submit, DECIDE → EVAL (f32, indirect) → EVAL2 (double-f32 re-check, indirect). A move is decided on the GPU only when certified intervals of the f64 score (written error bound in `cert.wgsl.ts`) separate; otherwise the CPU decides on exact f64 scores, and past 32 such decisions the call runs the f64 path.
- The result equals the f64 path's as long as every certified decision is correct. That rests on the bound and on the device meeting its arithmetic premise: the shared strict-IEEE probe (`src/lib/gpu/precision`) plus the same probe compiled inside EVAL2's own shader module, both read through a granular verdict (align takes no square roots; flushed subnormals are charged as slack). Per-call runtime checks sample it: random intervals re-scored exactly, every EVAL2 accept and every near-margin decision plus a random sample re-decided on exact scores. A failure runs the f64 path, and a broken bound turns the certified path off for the device. The CPU's replay of the move log reproduces the poses but does not detect a wrong decision.
- Node check `align-cert` (fast tier): bit-identical AlignResults on synthetic and real edge maps, also on a flush-to-zero machine, with ±3-ULP divisions, and with every comparison forced through EVAL2 or the CPU; faults are caught. Browser bench `scripts/gpu/align-f32-bench.mjs` (Apple GPU, headless Chromium, 19 dev photos × 5 priors): 0 differences from the f64 path and from `autoAlign`; 105,024 decisions, 19.5% decided in double-f32, 5 on the CPU; 4.8 submits per autoAlign; the mandatory exact re-decisions (~133 per autoAlign) make it slower than f64 (median autoAlign 37.2 → 40.1 ms; faster on 5 of 19 photos). The wild-set gate has not been run.

### Whole-app graph foundations, fusions and fixes (WAG; 2026-10-01)

- `gpu/core` `ComputeGraph` (06f7c27): GPU indirect conditions on kernel nodes, with a clear lint for skipped nodes (aliased outputs need a whole clear or same-gate readers; rewriting the indirect command breaks "same gate"; undeclared nodes count as users); adopting an external `GPUCommandGraph`; `add()` / raw / copy / render nodes audited (`declareNode` for raw `g.graph` nodes); `workload` + `preflight` / `fitsDeviceLimits`; texture passthroughs and texture bindings in `addKernel`; `listCachedGraphs`. Readback `stagePartialRead` (capacity copy, header map, then `[0,total)`). Existing graphs encode unchanged. Fast-tier check `gpu-clear-lint`.
- `gpu/ingest` (4d18dec): upload adapters and a Terrarium rgba8 → f32 heights kernel, f32-exact (0 heights and 0 RGBA bytes differ from the canvas/CPU decode on 1,155 cached tiles). No callers yet besides the atlas adapters.
- Photo prep planes stay resident on the WebGPU device and align's pose grid / pose bound bind them (00e1cca); the CPU `EdgeMap` is read lazily (idle prefetch after load) and only verified planes are ever bound. Upload per grid 2.53 → 0.95 MB; outputs bit-identical. Fast-tier check `photoprep-resident`.
- Settle fusion (ccc5722): the masks pass rides the query-geometry render's submit and band stats the stats render's (`queue.submit([render, work])` via the new `gpu/core` `submitWithDefault`, which calls luma default-encoder internals: recheck on the next luma bump). Non-frame submits per settle 9 → 7, masks and stats byte-identical, settle → labels latency unchanged. Engine option `settleFusion` (default on; `false` restores the old path). Checks `bridge-fusion` (fast), `settle-submits` (full, WebGPU).
- `SplatV1Loader` / `SplatPlyLoader` on the loaders.gl Loader contract (c388c48), fast-tier check `splat-loaders`.
- Fix (4d92d3f): `splatsort-scan-totals` declared a params binding its WGSL never read, so the `auto` layout dropped it and Dawn rejected the bind group: the default GPU splat sort always fell back to the worker. It runs on the GPU again (1M splats 3.1 ms). The kernel-layout check now runs in CI with a binding-use lint (`kernel-binding-use`, 58e2888).
- Post-default re-baseline and probes (819155d): `research_notes/whole-app-graph-2026-10-01/baseline-2026-10-01.md`; `scripts/gpu/{sky-worker-profile,splat-sort-bench,vram-probe,longtask-probe,haze-overflow-probe}.mjs`.
- `biome.json` migrated to the locked Biome CLI 2.4.5 (566e4e7).

### TextureArrayAtlas for the WebGPU terrain heights and imagery (WAG W2.2; 2026-10-01)

- `deck-webgpu/texture-array-atlas.ts`: one growable 2D-array texture with a layer free list under the batched terrain's r32float height arrays (was `HeightPool`) and `ImageryArray`. Layers are written through the `gpu/ingest` adapters (`uploadRaster` / `uploadBitmap` with `into`); a grow copies every mip of the old layers with `copyTextureToTexture`. The height arrays used to be re-created empty and re-uploaded from the CPU on a grow: on a pan that grows the 256² array (measured on IMG_7086, IMG_6958, IMG_3304) that removes 279–342 height uploads (70–86 MiB) and cuts the growing sync from 38–40 ms to 15 ms of main-thread time. Photo load is unchanged (every tile is fresh then). Default on, WebGPU only; WebGL is unchanged.
- Frames are byte-identical before and after (geometry, normal and colour targets, 21 poses over 3 photos including pans across the grow and the imagery drape): `scripts/deck-webgpu/atlas-frames-check.mjs`. Fast-tier check `atlas-layout` (`atlas-layout.check.ts`). Cost probe: `scripts/deck-webgpu/atlas-cost.mjs`.
- Not done: the uv-window ancestor fallback. `atlas-layout.ts` `ancestorWindow` gives the window and is checked against `dem/grid.ts` `ancestorCrop` bit for bit, but the CPU height consumers still need the cropped arrays (WAG W2.4), and a shader bilinear over the ancestor would not render the same bits as `ancestorCrop` + `downsample2` + bilinear. `ancestorCrop` costs 0 ms on the two Swiss photos and 55 ms per load / 82–95 ms per pan sequence on IMG_3304 (56–83 fallback tiles).

### Certified-f32 horizon stages, opt-in (WAG W3.1 precision half, P1; 2026-10-01)

- `?horizonPrecision=certified-f32` (default `f64`, needs the GPU march): the skyline's tan → degrees step (D7) and the worker's WGS84 ENU + 8192-column resample (D8) run on the GPU in double-f32 with a tracked error bound. Each output is certified only when every value within the bound rounds to the same f32; the rest are recomputed by the f64 code, so outputs are bit-identical to the f64 path. Function option `precision` on `computeHorizonGpu` and `skylineDirs`. Error analysis: `src/lib/gpu/horizon/README.md`.
- The worker's f64 direction stage moved verbatim to `gpu/horizon/dirs-cpu.ts` (bit-identical; checked against the old code).
- `src/lib/gpu/precision`: shared double-f32 arithmetic (TS emulation + `DF32_WGSL`) and `probeStrictIeee(device)`, the per-device strict-IEEE probe that gates every certified-f32 stage.
- Fast-tier checks `horizon-cert` (0 false certifications on synthetic and, when generated, DEM cases) and `ieee-probe`; browser bench `scripts/gpu/horizon-cert-bench.mjs`.
### Batched terrain: GPU cull and indirect draws (WAG W1.5; 2026-10-01)

- WebGPU: the batched terrain's per-frame frustum cull moved to a two-node `ComputeGraph` (`deck-webgpu/layers/terrain-cull.ts`): a conservative f32 sphere test, then a stable compaction into per-resolution instance buffers and indexed indirect records, drawn with `Model.setIndirectBuffer` (luma #3328, vendored rigi.2). No count is read back. Frames are byte-identical to the CPU cull (3 photos × 10 poses incl. the world view, geometry + normal + colour targets); the CPU cost per pass is about the same (~17–19 µs vs ~16–21 µs at ~350–390 tiles), so this is not a CPU saving at today's tile counts.
- Flag `terrainGpuCull` (default off, since it saves no CPU time at today's tile counts; WebGL, `?gpu=off` and `terrainGpuCull=off` keep the CPU cull). New optional layer hook `GpuLayerCore.prepass(ctx)`, called by `hosts/passes.ts` before the geometry / colour pass on the same encoder.
- Checks: fast tier `terrain-cull` (`layers/terrain-cull-math.check.ts`); browser gate `scripts/deck-webgpu/terrain-indirect-check.mjs` (render lock, `?renderer=webgpu`).

### Graph inspection and app graph manifest (WAG W0.2, W0.3; 2026-10-01)

- `gpu/core/inspect.ts` + `inspector.ts`: luma's `GPUCommandGraphInspector` (one per device) and the upstream preflight over every `cachedGraph`; `getGpuGraphProfile()` in `core/profile.ts` reports per-graph and per-node CPU encode / GPU p50 / p95, transient bytes, aliasing savings and the preflight fit. Opt-in (profiling on, or `/dev/graph` open); unobserved graphs encode as before.
- `/dev/graph` (dev only): the page's live compute graphs per device, joined with the manifest; worker-realm modules are listed as remote.
- `src/lib/gpu/app-graph/manifest.ts`: islands I0–I12 and the GPU modules (groups, resources, cadence, realm, readbacks), `registerIsland` for dynamic entries. Fast-tier checks `gpu-inspect`, `app-graph` (manifest ↔ `cachedGraph` groups) and `app-graph-table` (`research_notes/whole-app-graph-2026-10-01/islands.generated.md`, from `scripts/gpu/app-graph-table.ts`).

### loaders.gl data paths (WAG W2.5, W2.6; 2026-10-01)

- `?cogReader=loaders|own` (default `own`): swisstopo COG reads for `?concord=occl` through `@loaders.gl/geotiff` `GeoTIFFSourceLoader` behind the existing `swiss-cog.ts` API, falling back to the own reader when a file cannot be opened. Windows are bit-identical to the own reader on the Swiss dev photos' swissSURFACE3D / swissALTI3D COGs (CI `cog-reader`); under the 4.5 MB byte budget the readers keep different tile sets (64 KiB header blocks), so the default stays `own`.
- `cachedFetch` / `cachedFetchRange`: HTTP byte ranges through the tile cache, keyed by url + range (a server that ignores Range is sliced).
- SPZ (v2, v3, v4) and KSPLAT splats import through `@loaders.gl/splats` (`src/lib/nearfield/splat-loaders-ext.ts`), sniffed by `selectSplatLoader` and parsed with the new async `parseSplat`; `splat-loaders.ts` imports the package only on use (CI `splat-loaders-ext`).

### Type system (2026-10-01)

Review and open items: `reports/type-system-review-2026-10-01.md`.
- `src/lib/ontology/domain.ts` (generated from the concept catalogue): one type per concept (`Photo`, `Orientation`, `Horizon`, `Skyline`, `PoseEstimate`, `PeakLabel`, …) bound to its canonical realization; CI `ontology` fails when it is stale.
- One canonical `Vec3`, `Mat3`, `LatLon`, `SWNE`, `Size` and the new `ByteMask` replace 30+ local copies; `CascadeStage` and `HeightFn` are declared once.
- Same-name exports renamed: `ExifPhotoMeta`, `SkylineSolveResult` / `GcpSolveResult`, `RefineConfidence`, `PeakLabelPx` / `BaselinePeakLabel`, `GeoJsonPeak` / `RidgelinePeakInput`, `FitParams` / `GcpParams`, `CompositeLookStyle`. Catalogued types must have unique names (CI `ontology`).
- Storage keys are built with `storageKey()` everywhere (CI fails on a spelled-out registered key); `?style=` is read through `lib/flags`; the autoAlign and matcher-v0.1 bars go through `levelOf`.
- `Renderer`: members both engines implement are required; the unimplemented `nearFieldSampleAt` is removed. 35 exports with no importer are module-local.

### Cleanup pass (2026-10-01)

Inventory of removed, retained and refactored code: `reports/cleanup-2026-10-01.md`.
- Removed `src/lib/tiles3d/three-tiles.ts` (the three.js 3D Tiles adapter, no caller), the stale `three/webgpu` and `three/tsl` `optimizeDeps` entries, and the regenerable per-photo intermediates of the killed FUND E0–E3 studies and the near-field spike/smear runs (reports, protocols, results and scripts kept; recover with `git show 84edf95^:<path>`).
- Research harnesses under `tools/` no longer import the main tree by absolute path.
- Fast tier green again on a clean clone: formatting drift fixed, atlas pages and `reports/ontology.md` no longer cite the deleted `src/lib/engine.ts`, and the `export` check declares its gitignored photo input so a fresh checkout skips it instead of failing.
- Docs: present-tense references to the removed three.js renderer, `src/lib/render` and the removed concord checks fixed; CI check table regenerated; superseded banners on `reports/deck-default.md` and `reports/matcher-service.md`.

### luma.gl 10 and WebGPU by default (2026-09-28 to 2026-10-01)

Rendering
- WebGPU is the default renderer: `?renderer=auto` (the default) runs deck.gl on WebGPU (`WebGpuEngine`, `src/lib/deck-webgpu`) where the browser passes the probe, and deck.gl on WebGL2 (`DeckEngine`, `src/lib/deck`) otherwise. `?renderer=webgpu|deck` pins an engine, `?webgpu=off` forces the fallback. Decision record and open regression list: `reports/webgpu-default.md`.
- The three.js `PhotoEngine` and `?renderer=three` are removed. three.js remains for Step Inside splats, the 3D Tiles adapters and the P3 RGB-D cache.
- A mid-session WebGPU device loss that cannot rebuild switches `/photo` to the WebGL deck engine; `auto` routes terroir-styled views (land cover, contours) through WGSL on WebGPU.
- deck-webgpu: geometry diet; GPU label occlusion, skyline and point queries instead of a full 1024 px readback per settle; cached peak-label occlusion verdicts; no-MSAA colour pass while interacting with 4x MSAA on settle; idle prewarm of the interactive pipelines; trail dash; GPU splat sort with a worker fallback.
- Offscreen pose renders for the matcher and `lab.generate` run on the deck engines; every harness that pinned three is retargeted to deck/WebGPU.

GPU compute
- Compute runs on luma's `GPUCommandGraph` through the `ComputeGraph` in `src/lib/gpu/core`, and the graph is the only GPU path: horizon, eye search, solve, look passes (relief, haze, guided filter, band stats), sky refine, align pose grid and bounds, skyglobal grid, silhouette masks, GPU splat sort and ridgeline tracing. The pooled dispatch paths are removed.
- Pipelines are built through luma's engine `Kernel`/`Kernel.createAsync`; haze scan and offset steps use luma `GPUScan`.
- Under WebGPU the render device is also the compute device (`adoptRenderDevice`); look passes run on render targets with no CPU round trip. Auto-align refine pre-screens with certified score bounds and re-ranks silhouettes on the GPU.

Vendored dependencies
- luma.gl `10.0.0-alpha.2-rigi.1` (built from luma master `7d1d11e9` plus #3312, #3313, #3302, #3287 and a PipelineFactory compute-hash fix) and a deck.gl `9.4.0-beta.4` build (deck PR #10752 on master plus luma's WebGPU deck fixes) are installed from `vendor/`. Rebuild steps: `vendor/luma/README.md`, `vendor/deck/README.md`.
- luma.gl bumped to `10.0.0-alpha.2-rigi.2` (rigi.1 plus luma PR #3328, `Model.setIndirectBuffer`; patch in `vendor/luma/patches/luma-3328.patch`); `scripts/gpu/indirect-draw-check.mjs` checks a GPU-written indirect draw against a direct draw. Added `@loaders.gl/geotiff` and `@loaders.gl/splats` `^5.0.0-alpha.7` (not imported yet).
- Adopted luma `requiredLimits` (#3312) and `WebGPUAdapter.attach()` (#3313) for app-created devices.

Look and cartography
- Terroir cartography: land-cover shading and contours, legend, place card and roll hooks.
- Height-fog ("Nebelmeer") and precipitation looks ported from luma.gl #3325 (MIT, vis.gl contributors); see `NOTICE.md`.

Tooling
- `scripts/ci/run.mjs` regression gate (fast and full tiers) with a per-file Biome ratchet; render lock is a FIFO queue; CI child cleanup and its own dev port.
- Repository conventions follow luma.gl: `LICENSE` (MIT), `NOTICE.md`, `AGENTS.md`, `CONTRIBUTING.md` (with AI-assisted contributions), `CODE_OF_CONDUCT.md`, `.github` templates, SPDX headers, `examples/`.

Fixes
- Review fixes CR-54 to CR-68 (WebGL context restore, device free on boot failure, private sky copy before the grid await, silhouette-mask kernel on `gpu/core`, `faultDeflate` hook gated to dev); retryable `compileAsync`; DEM no-data fill and fetch retry; Step Inside pose re-check; upload region races.

### Earlier

- 2026-09-28: initial commit: Rigi app, pose pipeline, matcher, benchmark and research tooling, reports.
