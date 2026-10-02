# deck.gl #10753 audit: unaligned 8/16-bit vertex data on WebGPU

Wave 5, stream D4a, 2026-10-02. Static audit only (grep and reading); nothing was run in a browser.

## The issue

deck #10753 (with #10776): on WebGPU a vertex attribute or index buffer whose byte length or stride is not a
multiple of 4 breaks the upload, and 8/16-bit formats with 3 components (`unorm8x3`, `uint16x3`, ...) do not
exist in WebGPU at all (only x2 and x4 exist). deck's stock attribute layers feed such data (for example
`unorm8` colours with size 3, `uint8` picking colours, 16-bit indices of odd length). It only matters when a
deck attribute layer or a hand-built `Geometry` runs on a WebGPU device.

## What runs on WebGPU in this repo

`src/lib/deck-webgpu` is a hand-written engine (`WebGpuEngine`): every layer builds its own luma `Model`
with an explicit `bufferLayout`. No stock `@deck.gl/layers` layer is imported under `src/lib/deck-webgpu`,
and no `AttributeManager` or `addAttributes` call exists there. The stock layers (ScatterplotLayer,
PathLayer, TextLayer, BitmapLayer, LineLayer, PolygonLayer in `lib/deck/world-view.ts`,
`lib/roll/map/roll-map.ts`, `lib/terroir/roll/roll-map-extras.ts`) are part of the WebGL2 `DeckEngine` and
roll map (the latter guards WebGL-only paths with `device.type`), so #10753 does not apply to them today.

## Findings

Vertex formats declared in `deck-webgpu` (grep of `format:` in every `bufferLayout`): all are `float32`,
`float32x2/x3/x4` or `uint32` (batched-terrain instance row). No 8/16-bit vertex format exists. Hit list:
`terrain.ts`, `layers/{multi-drape,tiles3d,trail,glow,batched-terrain}.ts`, `spike.ts`.

Index buffers uploaded on the WebGPU path:

| Where | Type | Alignment |
|---|---|---|
| `deck-webgpu/layers/tiles3d.ts:650-660` | Uint16 or Uint32 | Uint16 already padded to an even count (the draw count is kept separately), so a 4-byte multiple. Already handled. |
| `lib/terrain.ts` `tileIndex` (used by the terrain meshes) | Uint16 when vCount <= 65535 | count = 6 seg^2 + 48 (n-1): always even, so 4-byte aligned. |
| `lib/roll/mosaic/panorama.ts:74` | Uint16, nx*ny*6 | always even. |

Uint8/Uint16 typed arrays elsewhere in `deck-webgpu` are textures (`writeData` with rgba8 / r8 data, whose
row pitch is handled by the texture upload path), readbacks (`engine.ts`, `compute-bridge.ts`) or uniform
words (`silhouette-gpu.ts`), none are vertex attributes. `lib/nearfield` `source: Uint16Array` is CPU
provenance data and is not uploaded as an attribute.

## Not on WebGPU, but would hit if it ever moved there

- `lib/tiles3d/deck-layer.ts:338-346` (the WebGL2 tiles layer): `Geometry.indices` is `geo.index.array` as
  Uint16 with no padding. Fine on WebGL2. The WebGPU twin is `deck-webgpu/layers/tiles3d.ts`, which pads.
  If this layer were ever pointed at a WebGPU device, an odd index count would need the same pad.
- `lib/deck/trail-layer.ts` `classes: Uint8Array` is CPU-side and expanded to float32x3 colours before upload.
- `lib/deck/index-width.ts` narrows to Uint16 for WebGL; its doc already says it is WebGL-only.
- Stock deck layers: any future use on the WebGPU device (the roll map, text labels) must go through the
  vendored deck 9.4.0-rigi.1 and re-check #10753/#10776 first; the unorm8 size-3 colour attributes are the
  known trigger.

## Verdict

No real hit in our own layers: no code change needed. Every WebGPU vertex attribute is 32-bit and the only
16-bit index buffers are already even-length. Re-run this grep (`unorm8|uint8|uint16|snorm|x3` in
`bufferLayout`/`format:`, and `Uint16Array` near `createBuffer`) whenever a stock deck layer is moved onto
the WebGPU device or a new `deck-webgpu` layer takes an index buffer.
