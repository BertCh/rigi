# concord

Whole-image concordance (plan: `reports/concordance-research.md`). Flags: `?concord=eye,occl,labels,drape`
(`flags.ts`, all off by default; `labels` and `drape` act only together with `occl`).

| dir | what | status |
|---|---|---|
| `core` | `CameraX` (pinhole + optional k1), distance bands, residual-field types (frozen WP-A API) | used by cues and the GEO evals |
| `cues` | interior occluding contours, edge distance transform, waterlines | offline (GA1/GA5 evals, `scripts/concord/eval.ts`) |
| `priors` | per-LensModel focal table, altitude-contour eye prior, near-DEM ground | focal table positive on holdout (n = 2); `?concord=eye` applies it to the photo's vfov prior (`src/lib/photos.ts getPhoto`). Altitude rule negative |
| `occl` | swissSURFACE3D/swissALTI3D COG reader, nDSM occluder grid, C4 hooks | `?concord=occl` dims overlays in both deck composites |
| `app` | `runConcordDisplay`, `useConcordDisplay`, fail-closed `isLowConfidence` | wired in PhotoWorkspace |

Results and open items: `reports/concordance-research.md` §7. Accuracy claims wait on the blind interior pins (`tools/concord/pins/PROTOCOL.txt`).

## C4 label and drape hooks (`occl/hooks.ts`)

Derived from the occluder range grid `runConcordDisplay` already computes (one DSM fetch, one pass):

- `occludedLabels(labels, grid, { k = 6 })` returns the ids of peak labels whose anchor has an occluder in
  front of the target (`occludedBy`: r > o*1.05 + 3 m) in at least k of its 3x3 grid cells. Sky, no-data and
  out-of-grid cells never count (precision over recall).
- `drapeMaskFromOccluder(grid, geom, { dilate = true })` returns an FgMask (row 0 = top, 255 = the photo pixel
  shows a DSM object in front of the terrain) with a one-cell 4-neighbour dilation.

`display.ts` returns them as `report.occl.labelsHidden` / `report.occl.drapeMask` and calls the host's optional
`setOccludedLabels(ids | null)` / `setDrapeMask(mask | null)` (declared on `Renderer`). At LOW confidence, with
no surface model, or when nothing is found, they are cleared with `null`.

Consumer wiring still owed (not done here, peer-owned code): the label renderers (`look/labels`) hide or dim
the ids; the deck / deck-webgpu drape layers skip masked photo pixels; PhotoWorkspace passes the peak anchors
(`labels` argument of `runConcordDisplay`: photo uv, range in m) so the label hook has input.
