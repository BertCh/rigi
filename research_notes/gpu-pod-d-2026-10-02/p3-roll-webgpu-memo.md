<!-- Rigi -->
<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: Copyright (c) Rigi contributors -->

# Decision memo: should `/roll` move to WebGPU? (status.md decision 8, whole-app-graph-plan P3 / island I12)

Date 2026-10-02. Read-only analysis; nothing here was run in a browser. Nothing is measured unless a row says so.

## Recommendation (3 lines)
- **Option B: do the compute part first, defer the render port.** Put `RangeGpu` (and the roll-side GPU look hooks) on a device-agnostic path, and let the panorama strip's ridge trace stay on the worker graph it already uses. Keep the WebGL `/roll` map and `PanoGL` shipping as-is until a browser pass can judge the drape.
- The WebGPU drape core (`layers/multi-drape.ts`) already exists and is checked against a CPU copy of the GLSL; the remaining cost is host wiring and a visual A/B, so a later full port (C) is M, not L, and is a straight consequence of P3's "WebGL is fallback-only".
- Answer to P3's second half: keep WebGL as the CPU-crossing fallback (as recommended), which means `/roll` WebGL code stays alive after any port. A port therefore adds a second path and does not remove one.

## Current state (file:line, as of master 6a6cf0c)
`/roll` is its own deck.gl-on-WebGL2 stack and ignores `?renderer=` (`deck-webgpu/layers/multi-drape.ts:8-9`; `reports/webgpu-default.md:50` "Stays on WebGL: `/roll`"). Four surfaces:

| Surface | Code | GPU API |
|---|---|---|
| 3D roll map (terrain + multi-photo drape, up to 208 photos) | `roll/map/roll-map.ts:256` `new Deck({...})` with no `deviceProps`, so deck's default WebGL2 device; `multi-drape-layer.ts` (843 lines, GLSL `#version 300 es` at `:167`, `:193`) | luma `Model` + deck layers on WebGL2 |
| Drape atlas | `drape-atlas.ts` (302): photo atlases, r32float range atlas, r8 people mask; `:22-24` sizes chosen for "WebGL2's 16 units"; `:214` `generateMipmapsWebGL()` branch | luma textures (device generic, one WebGL branch) |
| Coarse range cull | `range-gpu.ts` (290): two luma `Model`s, max-pool draw then `tex.readBuffer` + `buf.readAsync` (`:256`, `:266`); `ok` is false unless `device.type === "webgl"` (`:121-125`); used from `roll-map.ts:626` | luma, WebGL only |
| Clear-air dehaze for drapes | `drape-clear.ts` (435), GPU path behind `lookGpuOn()` (`:36`, `:336`) | luma `gpu/look` hooks |
| Panorama strip | `mosaic/panoGL.ts` (247): **raw** `canvas.getContext("webgl2")` (`:74`), hand-written shaders/VAOs/`drawElements` (`:221`); error string "Panorama needs WebGL2" in `PanoramaStrip.tsx:654` | raw WebGL2, no luma |
| Panorama terrain / ridgelines | `mosaic/ridgelines.worker.ts` calls `gpu/horizon` (`:21-22`), GPU trace "default on" with CPU fallback (`:47-49`); `viewpointTerrain.ts` memoises | worker's own compute device via `gpu/core/realm` |
| Mini-map | `RollMiniMap.tsx` | 2D canvas / OSM tiles, no GPU |

Important correction to the framing: **`mosaicGpu` (default on, `flags/index.ts:69`) is not a roll flag.** It builds the horizon max-mip pyramid in `gpu/horizon/mosaic-mips.ts`, used by the horizon workers, and by `/roll` only indirectly through the ridgelines worker. The roll page's only direct GPU compute is `RangeGpu` (on the page's WebGL2 device, drawing and reading back via render passes, not a compute graph) and the `drape-clear` hooks. So the roll *compute* is already half-graph (worker) and half-render-pass (page). The `RollMapEngine` also forces CPU-backed mosaics (`roll-map.ts:1031-1035`, `cpuBitmaps: true`) because a GPU-backed bitmap's texture-array upload is a main-thread readback on WebGL2; on WebGPU that restriction disappears, which is a real, unmeasured upside.

Recent roll GPU history: eb149b5 (silhouette mask and range-gpu onto luma Models, std140 blocks, luma `readBuffer`) removed most raw GL from the map side, so the map is now "luma everywhere except one WebGL-only guard"; `panoGL.ts` is the only raw GL left in `src/lib/roll`. Ownership: `src/lib/roll/map/**` has a peer editing it now, so any map-side step needs coordination first.

Terrain data: `roll-terrain.ts:136` builds its own meshes and `buildBatchGrid` from `dem.heights`; it relies on the shared DEM decode (WAG W2.1/W2.4 `DemStore`, `getCpuHeights`). Roll is a listed consumer of the decode-once work, independent of the render backend.

## What a port involves
| Part | Work | Size |
|---|---|---|
| Device: deck `deviceProps: {type: "webgpu"}` for the roll `Deck`, or sharing one realm device with the page engine | `deck-webgpu/device.ts` and `hosts/deck.ts` are the only deck touch points; roll has its own `Deck`, so it needs its own host or a shared canvas-less device. Sharing the *device* (not the canvas) with the photo workspace is the VRAM and graph win; `/roll` and the photo page are different routes, so in practice a single device per realm only matters across route navigation (device pool) | S to M |
| Terrain layer under the drape | `layers/batched-terrain.ts`, `terrain.ts`, `terrain-styles.ts` exist for the photo view; roll needs multi-focus tiles (`roll-terrain.ts`) feeding a core that today expects the photo engine's terrain set | M |
| Drape core | `layers/multi-drape.ts` (986 lines) is written: TOP_K competition, 2x2 PCF vote, people cut-out, outline. README row (`:409`): median 1.2e-4 vs a CPU copy of the GLSL, "only if /roll moves", clear air path "unmeasured on GPU". Output composites in linear light, so partial alpha differs slightly from the WebGL canvas | S (wiring) plus a visual A/B (not run) |
| Drape atlas | Device generic already; drop the `webgl` mipmap branch, re-derive the atlas side/count limits (WebGPU has far more than 16 samplers but per-stage sampled-texture limits still apply) | S |
| `RangeGpu` | `range-gpu.ts` is WebGL-guarded; WGSL twin of the max-pool, or fold into a compute pass on the shared device (`height-gather`-style) | M |
| Panorama strip | Rewrite `panoGL.ts` as luma `Model` + WGSL, or accept it staying a raw WebGL2 canvas (it is its own canvas, independent of the map's device). Strip is textured meshes with premultiplied blending: simple pipeline | S to M |
| Readbacks | Only `RangeGpu` (coarse range grid, small) plus the hover/pick path (not audited); WebGPU readback ring (`deck-webgpu/readback.ts`) already exists | S |
| Parity gates | None exist for `/roll`; needs a roll-specific drape A/B (`style-baseline` for roll, or eval-app roll route) and a perf check at 40+ photos | M (batch pass) |

Overall: full render + compute port is roughly M-L, but most of the L is already paid (drape core, atlas, WGSL helpers). The unpaid part is wiring, the second host, the A/B gate and keeping the WebGL path alive.

## What it buys vs risk
**Buys:**
- One device model across the app and the graph islands: I12 moves from "external island by design" into the manifest; `RangeGpu` and `drape-clear` become graph nodes.
- No more WebGL-only workarounds: CPU-backed mosaics (`roll-map.ts:1031`), `cpuBitmaps`, the 16-sampler atlas sizing.
- Likely perf headroom for the known limit "per-frame cost grows with overlapping photos (40 photos about 4 fps orbiting in headless)" (memory `camera-roll-feature`). Unmeasured: WebGPU render bundles and indirect draws could help, but the drape fragment shader cost (the TOP_K loop) is the same ALU work.
- Matches the user's stated preferences (GPU first; flip working GPU paths to default; "kicking the tires on the new gpu graph").

**Costs and risks:**
- Photo-view GPU memory is about 2x WebGL's (`webgpu-default.md`); the roll drape holds up to ~208 photo atlases of up to 64 MB each, so VRAM could be the binding constraint. Unmeasured.
- Safari and Firefox: WebGPU not shipping on the supported OS versions (macOS 14), and `float32-filterable` is required; the WebGL roll must stay as the fallback, so the code base carries two drape implementations. P3's "keep WebGL as a CPU-crossing fallback" means a port is additive.
- No parity gate exists for the roll drape; the drape was tuned by eye (the "drape acne" min-dilation history). A port can change the look (linear compositing) without anyone being told by a check.
- Cook-mode rule: browser verification only in a batch pass, and the roll map files are owned by a peer.
- Ahead of this, the photo engine has not completed its own browser pass (roadmap G1 open items), so stacking a second renderer migration on it multiplies unverified surface.

## Options
- **A. Keep `/roll` on WebGL as-is.** Cost zero. Leaves I12 external, leaves two decodes, and `layers/multi-drape.ts` unused (986 lines of dormant code). Reasonable if the batch pass is still pending for the photo engine.
- **B. Compute first (recommended).** (1) Make `RangeGpu` device-agnostic with a WGSL twin (M, behind a roll-local flag, WebGL path default). (2) Move `panoGL.ts` onto luma only if the strip needs a shared device (S-M; otherwise leave). (3) Route roll's DEM through `DemStore` (already planned W2.1/W2.4). Gives graph islands and removes the WebGL-only guard without touching the look. Render stays WebGL until C.
- **C. Full port behind `?rollRenderer=webgpu`, default stays WebGL.** B plus the host, terrain wiring and drape wiring. Flip the default only after a roll A/B and a 40-photo perf/VRAM pass. Consistent with "flip working paths", but not before the gate.

## Prerequisites and gates
1. The batch browser pass for the photo-engine WebGPU default (roadmap G1) has run and is clean; otherwise a roll regression cannot be bisected.
2. A roll-route parity gate: drape A/B at fixed photos (mean/p95 colour difference, outline present, people cut-out), plus fps and VRAM at 10/40/200 photos on both engines. None exists today.
3. Coordinate with the peer that owns `src/lib/roll/map/**` before any map-side edit (host switch, `RangeGpu`, atlas).
4. WebGL fallback kept and exercised: `?rollRenderer=webgl` (name tentative; the flag must be declared in `src/lib/flags`) and an automatic fallback when `navigator.gpu` or `float32-filterable` is missing.
5. Decision for the user: accept the linear-light compositing change in the drape (identical at full opacity, small shifts at partial alpha), or require sRGB-byte parity.

## Measured vs not
- Measured: nothing in this memo. The one number quoted for the WebGPU core (median 1.2e-4 vs a CPU copy of the GLSL) comes from `deck-webgpu/README.md:409`, and the 4 fps at 40 photos is from the 2026-09-26 session notes in headless swiftshader.
- Not measured: WebGPU roll fps, VRAM at 208 photos, drape look parity, the clear-air path on GPU, `RangeGpu` on WebGPU, pick/hover readbacks.
- Not audited: `roll-map.ts` pick path, `RollMap.tsx` canvas lifecycle, and which of the "Stays on WebGL" `/roll` pieces also touch `deck/world-view.ts` (also peer-owned).
