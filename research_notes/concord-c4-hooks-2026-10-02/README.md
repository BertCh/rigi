# Concord C4: label and drape hooks (2026-10-02)

Engineering, not an experiment: no protocol or kill criterion; no dev numbers were computed.

## What landed
- `src/lib/concord/occl/hooks.ts`: `occludedLabels`, `drapeMaskFromOccluder`, `OccluderGrid` (see `src/lib/concord/README.md`).
- Flags `labels` and `drape` on `?concord` (typed table in `src/lib/flags`, `concord/flags.ts`); default off, need `occl`.
- `app/display.ts`: hooks come from the same occluder pass; report fields `occl.labelsHidden`, `occl.drapeMask`; optional host calls `setOccludedLabels` / `setDrapeMask` (optional members on `Renderer`, no engine implements them). New optional `labels` argument on `runConcordDisplay` (PhotoWorkspace does not pass it yet). `useConcordDisplay` also clears the two setters on pose change.
- Specs: `occl/__tests__/hooks.spec.ts`, `app/__tests__/display.spec.ts` (flags-off parity, LOW clears, k-of-9, sky, dilation).

## Owed (consumer wiring)
Label renderers (hide/dim ids), drape layers in deck and deck-webgpu (skip masked pixels), PhotoWorkspace passing peak anchors. Deviation from the brief: `drapeMaskFromOccluder` takes terrain range and sky from the geometry argument; `OccluderGrid.terrain` is carried for consumers but the mask uses `g`.

## Batch pass should check
`/` workspace with `?concord=occl,labels,drape`, both renderers: no visual change (hooks unconsumed); `window.__concord.occl.labelsHidden/drapeMask` appear on a Swiss photo; `?concord=occl` alone unchanged.

Ledger row (reports/batch-ledger.md is untracked in the live tree, so it was not edited in the worktree):
`| podC (c4) | <sha> (concord/occl/hooks.ts, app/display.ts, renderer.ts) | C4 label/drape hooks, unconsumed | route / with ?concord=occl,labels,drape, ?renderer=webgpu and deck: no visual change; report.occl.labelsHidden/drapeMask present; ?concord=occl alone unchanged | low |`
