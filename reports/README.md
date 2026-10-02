# Docs index

Start with [status.md](status.md), then [roadmap.md](roadmap.md). Dead ends are in [negative-results.md](negative-results.md). Consolidated 2026-10-02: superseded plans and session reports were deleted (read them with `git show 9e011141:<path>`) or moved to [archive/](archive/README.md).

## Living docs (keep current)

| Doc | Covers |
|---|---|
| [status.md](status.md) | Where each thread stands, evaluation budget, decisions waiting |
| [roadmap.md](roadmap.md) | Position, rules, open work (Now / Next / Later / Parked) |
| [negative-results.md](negative-results.md) | Every experiment that didn't pan out, one line each, with its source |
| [batch-ledger.md](batch-ledger.md) | One row per browser-unverified commit for the batch browser pass (keep / revert / doc-only) |
| [code-review-2026-09-30.md](code-review-2026-09-30.md) | Code-health backlog: open CR rows with file:line; closed rows one line each |
| [licences.md](licences.md) | Licence register for data, tiles, APIs, models and fonts; owner decisions. Summarised in `NOTICE.md` |
| [cleanup-2026-10-01.md](cleanup-2026-10-01.md) | Removals register (09-30 → 10-02) and the kept-on-purpose list; read before any dead-code pass |

## Topic docs

| Topic | Doc | Notes |
|---|---|---|
| Registration | [terrain-matching-research.md](terrain-matching-research.md) | Synthesis and strategy of the TM studies; records in `tools/research/tm/*/REPORT.*` |
| | [fundamentals-plan.md](fundamentals-plan.md) | E0–E5 first-principles experiments: frozen kill criteria and verdicts (E5 passed, the rest killed) |
| | [geometry-first-pose.md](geometry-first-pose.md) | `src/lib/geocam`: GA1 solver kept, GA2–GA5 and SKYPAR killed; GA5 as veto candidate |
| | [stage1.md](stage1.md), [fusion.md](fusion.md) | T6 two-stage search and its frozen rule (now `src/lib/matcher/t6.ts`); skyline + match fusion and the a-priori HIGH rule |
| | [bench-wild.md](bench-wild.md), [bench-ablation.md](bench-ablation.md) | Wild benchmark and verification protocol (use the Mapterhorn update); heading/gravity ablation (unknown-pose design basis) |
| | [matching-v2.md](matching-v2.md) | Eye fallback, calibration priors, LoMa: not shipped |
| | [v3-prereg.md](v3-prereg.md) | Draft prereg for `data_v3` (roadmap R6) |
| | [Mountain photo georeferencing SoTA.md](<Mountain photo georeferencing SoTA.md>) | Skyline/DEM pose literature (2026-09-24); sources in `research_notes/Mountain photo georeferencing SoTA/` |
| Concordance | [concordance-research.md](concordance-research.md) | Whole-image concordance: findings, what's built in `src/lib/concord`, next steps |
| Step Inside | [step-inside-design.md](step-inside-design.md) → [step-inside-results.md](step-inside-results.md) | Design of record (in-browser pipeline), then build verdict; experiment records in `tools/nearfield/*/` |
| | [step-inside-download.md](step-inside-download.md) | int8 depth weights (70 → 36 MB), prefetch, terrain preview |
| | [step-inside-google-3d-tiles.md](step-inside-google-3d-tiles.md) | 3D Tiles: licence per use case, swisstopo path, as built on loaders.gl |
| Live camera | [realtime-investigation-2026-10-02.md](realtime-investigation-2026-10-02.md), [depth-live-2026-10-02.md](depth-live-2026-10-02.md), [tracker-gate-draft.md](tracker-gate-draft.md) | What live tracking costs, plan RT-0..3 and what landed (§6, `/live`); live depth tiers; draft tracker gate (not signed off) |
| GPU / renderer | [gpu-renderer.md](gpu-renderer.md) | **Start here:** where things stand, decisions P1–P4, all open GPU/renderer items, outcomes of the 10-01/02 waves |
| | [webgpu-default.md](webgpu-default.md) | Decision record: WebGPU deck default, WebGL2 deck fallback, what `?renderer=auto` probes |
| | [upstream-packets-2026-10-02/](upstream-packets-2026-10-02/README.md) | Local luma patch packets (nothing posted) |
| | [luma-demo-survey-2026-10-02/](luma-demo-survey-2026-10-02/README.md) | Survey of luma master demos and math.gl/loaders.gl APIs vs Rigi: ranked lessons |
| | [lens-nods-2026-10-02.md](lens-nods-2026-10-02.md) | luma's Arisia program and the naming rule (nod, never call out) |
| | [consolidation-review-2026-10-02.md](consolidation-review-2026-10-02.md) | What else to consolidate after the luma graph / math.gl / browser-only moves |
| Gipfelbuch | [gipfelbuch.md](gipfelbuch.md) | The one design and state doc: sheets, user rulings, canon, open fixes, decisions |
| Cartography | [swiss-cartography-review.md](swiss-cartography-review.md) | Cartography hub: canon rules C1–C24, reference plates in `swiss-cartography/img/`, Landeskarte scorecard, defects, palette system |
| | [terroir-cartography.md](terroir-cartography.md) | Terroir pack (land cover, names, glaciers) and layers |
| | [swiss-map-typography.md](swiss-map-typography.md) | Swiss map typography source; notes in `research_notes/swiss-map-typography/` |
| Product | [share-beta-design-2026-10-02.md](share-beta-design-2026-10-02.md) | Share-link beta spec (flag `share`), owner decisions |
| | [extension-opportunities.md](extension-opportunities.md) | Domain expansion review (advisory; roadmap is the plan of record) |
| Types | [ontology.md](ontology.md) (generated) · [ontology-design.md](ontology-design.md) · [type-system-review-2026-10-01.md](type-system-review-2026-10-01.md) | Rigi ontology (regenerate with `npx tsx scripts/ontology/doc.ts`; CI `ontology`), its design, and the type-system review's open items |

## Frozen records (never edit)

| Doc | What |
|---|---|
| [test-prereg.md](test-prereg.md), [test-results.md](test-results.md), [test-addendum.md](test-addendum.md) | Preregistered held-out test on 50 frozen wild photos. test-results' `test-prereg-addenda.md` means test-addendum.md |
| [pipeline-ab.md](pipeline-ab.md) | App pipeline variants A/B; the code it ran is removed |
| [leaderboard.md](leaderboard.md) (+ `.json`) | All methods on the 12-photo GT (2026-09-25; `node scripts/leaderboard.mjs`). Not comparable with eval-app |
| [archive/](archive/README.md) | Superseded docs still cited from code or results |

## Module docs (next to the code)

| Doc | Covers |
|---|---|
| `../src/lib/geo/README.md` | CPU georeferencing baseline: prior, horizon, skyline, `solvePose` |
| `../src/lib/pose6dof/README.md`, `../src/lib/picker/README.md` | GCP solver, RANSAC ports and eye refinement; top-3 picker / tap-a-peak |
| `../src/lib/concord/README.md`, `../src/lib/roll/propagate/README.md` | Concordance modules; pose propagation in `/roll` |
| `../src/lib/upload/README.md`, `../src/lib/export/README.md` | Upload track; export/interchange formats |
| `../src/lib/sky/README.md`, `../src/lib/tiles3d/README.md` | Sky segmentation; 3D Tiles |
| `../src/lib/nn/README.md` | The in-browser neural-net runtime on luma (WebGPU graph, CPU fallback, int8 weights) |
| `../src/lib/gpu/README.md` → `gpu/core`, `solve`, `horizon`, `precision`, `skyline`, `splat-sort` | WebGPU compute: rules, `ComputeGraph`, kernels |
| `../src/lib/deck-webgpu/README.md` | WebGPU deck renderer (the default engine) and its gotchas |
| `../src/components/gipfelbuch/README.md` | Gipfelbuch components: how to write a sheet |
| `../src/lib/ontology/README.md`, `../src/test/README.md` | Ontology layer; unit-test conventions |
| `../vendor/luma/README.md`, `../vendor/deck/README.md` | Vendored builds: PR heads, local patches, rebuild |
| `../scripts/ci/README.md`, `../scripts/models/README.md`, `../scripts/terroir/README.md` | Regression gate; model producers and manifest; terroir packs |
| `../examples/README.md` | Standalone luma.gl / deck.gl examples |
| `../tools/research/tm/README.md`, `../tools/matcher/v2/{loma,calib}/REPORT.md`, `../tools/bench/data_v3/README.md` | Study records; the frozen `data_v3` set |

## Research notes (`../research_notes/`)

| Note | Use |
|---|---|
| `tm_literature_2026-09.md` | Terrain-matching literature and the outcome of its ranked experiments |
| `step_inside_models_2026-09.md` | Licence ledger for depth, multiview, world-model and splat models |
| `completion_integration_2026-09.md`, `object_completion_models_2026-09.md`, `human_completion_models_2026-09.md`, `frontend_completion_models_2026-10.md` | Completion spec and model surveys (the 10-02 frontend note supersedes the earlier picks) |
| `segmenter-shortlist-2026-10-02/` | Permissive segmenters for Step Inside v1.1 (roadmap S1) |
| `gpu_compute_plan_2026-09.md`, `luma-frontier-2026-10-01/` | Historical GPU plan and the virtual-geometry note (negative-results sources) |
| `whole-app-graph-2026-10-01/` | WAG evidence: baseline, browser-pass results, dataflow map, `islands.generated.md` (generated, CI `app-graph`) |
| `wave5/`, `gpu-pod-d-2026-10-02/` | Evidence behind open items in gpu-renderer.md (skyline flip, render bundles, VRAM targets, deck #10753 audit, blank silhouette, batch checklist) |
| `rendering_aesthetics_sota.md`, `geospatial-rendering-aesthetics/`, `swiss-map-typography/` | Render-polish backlog and source notes behind the cartography docs |
| `Mountain photo georeferencing SoTA/` | Source notes behind the SoTA report |
