# deck.gl as the default renderer: remaining fixes

*2026-09-30. This covers the fixes that follow 63efa35, 1917e48, 4445e0e and b5674d5 on the way to flipping `renderer` to `deck` (`src/lib/flags/index.ts`). The flag itself is not flipped here.*

## Method

- **Builds:** frozen snapshots made with `git archive`, each served on its own port:
  - base = b5674d5 (:3191)
  - after = base plus these fixes (:3192)
  - old = 4445e0e, the tree before vertex log depth (:3193)
- **Browser:** headless Chromium with ANGLE Metal on an M3 Pro, 1400×900.
  - Perf runs at DPR 2 (the deck-perf bench, plus GL-error and imagery counters).
  - Pixel runs at DPR 1.
- Every job ran under `with-render-lock.mjs`.
- **`?lookgpu=off` in every run:** at HEAD, the GPU look pass `look-band-stats-sg` fails WGSL parsing ("value nan cannot be represented as 'f32'", from f1b6168). luma's error overlay then covers the sidebar, and clicks fail. That code belongs to the GPU-compute session and is not fixed here.

## Results

| fix | commit | before → after |
|---|---|---|
| imagery pages kept across world exits | 51acd70 | world re-entry uploads 929 / 862 / 835 MB → 133 / 151 / 76 MB. Long tasks 614 ms → 136–156 ms, the same as a first entry (canvas resize). 247–327 tiles are found retained. After exit, the photo view holds 3 pages (302 MB) |
| flight frames swap only the gizmo | 0e206b1 | no layer rebuild per flight frame. Fly-in fps is unchanged (39→40, 38→38) because it is GPU-bound |
| no `frontFace` in TERRAIN_PARAMETERS | a19179f | 257 → 0 `GL_INVALID_ENUM: glFrontFace` per visit (photo, Blend and world) |
| Blend lens re-render | — | with imagery loaded: 0 uploads and 0.5 draws per frame. The earlier 270–610 MB windows were imagery streaming in, re-uploaded by MapPool growth; pages remove the re-uploads |
| stale log-depth comments | b46f617 | comment-only |

### Imagery pages

`batched-terrain-layer.ts` now manages imagery like this:

- **Pages:** imagery lives in fixed ~96 MB rgba8 2d-array pages, and each page holds one image size.
- **Retention:** tiles that leave `props.imagery` stay uploaded, least recently used first out, up to `imageryBudget.retainBytes` (300 MB). Pages that hold only retained tiles are then dropped until they fit.
- **Upload pacing:** the world canvas uploads at most 32 MB per frame.
- **Lifetime:** the store dies with the layer, which covers engine dispose and context loss.
- **Counters:** `globalThis.__rigiTerrainMaps`.

World orbit issues 11–12 draws per frame instead of 9–10, because draws are now per page. Orbit fps is unchanged within noise.

## Correctness

- **DPR 1, base vs after, IMG_6958 / 7086 / 7155:** overlay, overlay after settle, export, Blend and Blend after settle are all **hash-identical**. World views are identical, apart from one pixel off by 3/255 on 6958.
- **Near-ground views, old (4445e0e) vs after (4445e0e + b5674d5 + fixes):**
  - Views checked: Step Inside splats on IMG_7086 and IMG_7018 (photo, orbit, fly, top-down), In map (fly, top-down, pan, zoom, tilt, orbit, photo), and `?tiles3d=swisstopo` with Step Inside (turn 0 / ±60°).
  - None of them shows near-plane clipping or terrain punching through splats or tiles.
  - Tiles views differ on ≤ 0.21% of pixels by > 8/255. `sampleSame` holds, so the tiles never reach the offscreen passes.
  - Some old step views show coarser imagery than after: tiles had not arrived yet in old.
  - `TERRAIN_DEPTH` stays `"vertex"`.
