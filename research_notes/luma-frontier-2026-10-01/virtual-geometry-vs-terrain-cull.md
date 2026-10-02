# GPUVirtualGeometrySelection / GPUScene against the batched-terrain cull (LF5 feasibility)

Date 2026-10-01. Feasibility only; nothing implemented. Sources: luma master docs
`docs/api-reference/experimental/gpu-core/gpu-virtual-geometry-selection.md` and `gpu-scene.md`, the
"Virtual Geometry Canyon" example (`examples/experimental/virtual-geometry-canyon`), the vendored
`@luma.gl/gpgpu` build (rigi.3 ships `gpu-virtual-geometry-selection.js`, `gpu-scene.js`,
`draw-command-buffer.js`).

## What ours does today

`src/lib/deck-webgpu/layers/terrain-cull.ts` (flag `terrainGpuCull`, on): a two-node ComputeGraph per
pass. `cull` is one invocation per RESIDENT tile (a conservative f32 sphere-in-frustum test), `compact`
is one workgroup that counts visible tiles per seg, builds the indexed indirect records and stably
compacts the visible table rows into each seg's instance buffer. LOD is NOT chosen here: the resident
tile set (about 350 to 390 tiles) and each tile's zoom/seg are chosen on the CPU by the tile stream
(deck TileLayer selection plus `terrain-stream.ts`), and the cull only removes tiles outside the frustum.
Heights come from a GPU atlas (W2.3), so tile fetch/decode is a separate pipeline from the draw list.

## What the upstream primitives are

`GPUVirtualGeometrySelection`: input is a caller-owned cluster HIERARCHY in breadth-level order
(`sphereBounds` f32x4, `geometricErrors` f32, `children` u32x2 first-child/count, `clusterIds` u32,
CPU `levelOffsets`). Per frame it runs one traversal pass per level: frustum cull by bounding sphere,
refine a node when `geometricError * pixelProjectionScale / max(dist - radius, 1e-6)` exceeds
`maximumScreenSpaceError`, children activate only when the parent refines (no parent/child overlap),
then stable scan compaction writes `output` (cluster ids, source-node order), `count` (clamped),
`totalCount`, `overflow`. `count` can be bound to `DrawCommandBuffer.getInstanceCountData(i)` so the
draw is indirect with no readback. Vertex/index storage, materials and pipelines stay with the caller.
The Canyon example builds a 4x4 root grid, depth 6 quadtree-like hierarchy of 16x16-segment clusters on
the CPU, uploads it once, and draws the selected ids as instances of one indexed mesh.

`GPUScene`: a flat 128-byte-per-record GPU database (id, flags, group, geometry, command slot, AABB,
transform) with transactional CPU-authored `mutate()`/`compact()` through queue writes, meant to feed
visibility, picking and draw generation. It is a storage contract, not a hierarchy.

## Can it replace or augment our cull?

Map of concepts: our tile = their cluster; our seg (grid resolution) = a cluster's mesh; our quadtree of
Terrarium zooms = their hierarchy. So the fit is natural, and it would move LOD selection (today CPU,
in the tile stream) onto the GPU, which our `cull` does not do. It does not reduce what `cull` already
does well: at about 350 to 390 resident tiles the current cull is not a cost (measured: no CPU saving,
no loss), so the gain is not speed at this tile count but that LOD becomes a per-frame, screen-space
decision with no CPU tile-set round trip and no pop at tile boundaries.

Augment, not replace, is the realistic path:

1. Keep `terrain-cull.ts` as the draw-list builder (it already handles per-seg instance buffers,
   several passes per frame, the indirect records and the encoder ring).
2. Add a selection stage in front of it that outputs the set of tile ids at the chosen LOD; `cull`
   then runs over that set instead of every resident tile.

What it would take:

- A terrain hierarchy in breadth-level order. Our Terrarium tiles ARE a quadtree, but ours is sparse
  and streamed: nodes appear when fetched. The primitive wants a complete, static hierarchy
  (`levelOffsets` CPU metadata, child ranges contiguous in the next level). We would need either a
  fixed-depth full tree over the area of interest (Canyon: 4x4 roots, depth 6; at Alpine extents that
  is far more nodes than we ever hold resident) or rebuilding/re-uploading the hierarchy as tiles
  stream, which moves the CPU cost rather than removing it.
- Residency feedback. Selection can pick a tile that is not decoded yet. Our stream needs the opposite
  channel (which ids did selection want?) which means a GPU-to-CPU readback of the selected ids, the
  thing the primitive is designed to avoid. A fallback to the parent when the child is missing would
  have to be encoded in the hierarchy state (an `available` bit folded into the error column or the
  child count), updated by queue writes per tile arrival.
- Geometric error per tile in world metres plus our big-coordinate handling (G, base-grid offset, 1e-7
  rad cell). The primitive is f32 in world space; our tile bounds are in the Mercator/lon frame and are
  already carefully conditioned for the cull (`terrain-cull-math.ts`). Re-expressing them in its frame
  is the main numeric risk.
- Several passes per frame (geometry and colour, off-frame renders) each with its own view: the
  selection's four view buffers can change between encodings without recompiling, so this is fine,
  but each pass needs its own count/output (or one selection reused where cameras match).
- Skirts and neighbour seams: our seg per tile and skirt (m) assume neighbours differ by known zoom;
  per-frame LOD changes alter neighbour relations on the GPU, so crack handling needs a design.
- The indirect side is already ours (`drawIndexedIndirect` via Model.setIndirectBuffer); the
  `DrawCommandBuffer` instance-count binding would replace our hand-written args only if we adopt the
  primitive's output format. Not required.

GPUScene: no fit. Our terrain tiles are not mutated individually, there is no picking path that needs
stable object ids on the GPU, and splats/labels/overlays have their own packed buffers. It would only
matter if we later unify terrain, 3D tiles (`src/lib/tiles3d`) and object layers under one GPU draw
generator, which is a larger refactor than LF5.

## Verdict

Feasible in principle; worthwhile only as an experiment, not a replacement. Blockers are structural
(complete static hierarchy versus our streamed sparse quadtree; residency feedback needs the readback
the primitive avoids), not API gaps. The cull itself gains nothing at current tile counts. If pursued:
prototype on a fixed-depth hierarchy over the demo area behind a new off-by-default flag, compare the
selected set with the CPU tile selection (identical set at a fixed view is the gate), and treat any
change of which tiles draw as a render change needing the terrain parity checks (`w4-terrain-parity.mjs`).
Not adopted; no code written.
